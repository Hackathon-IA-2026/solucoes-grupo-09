"""The artifact: one frozen bundle, one card, and a load that refuses partials.

`docs/specs/forecaster.md`, "The artifact": the bundle is "one joblib of a
frozen dataclass, so a partial load fails loudly", and the card is "everything
needed to reproduce, audit or refuse the artifact". The two are written side by
side into the lane directory :mod:`wattsteer_ml.artifacts` already defines, under
the same ``artifact_id`` stem — the card is written **regardless** of any later
gate decision, so a refused candidate stays inspectable.

**Why "fails loudly" needs code and not just a dataclass.** A frozen dataclass
makes a partial *construction* impossible, but a bundle arrives from disk
through ``joblib.load``, which reconstructs an object without running
``__init__``: an older or truncated pickle can produce an instance that is
missing an attribute entirely. So :func:`load_artifact` re-validates the loaded
object field by field. The failure mode it exists to prevent is precise — a
bundle missing, say, the conditional-mean booster would otherwise compose a
mixture out of five estimators and serve an expectation drawn from the median,
which is exactly the systematic understatement `mixture.py` was written to
prevent, arriving by a different door.

**The card's feature hash is checked against the bundle's own contract.** They
are two copies of one fact — the card's copy is what the hot-swap gate compares
against the live ``feature_rows`` definition, the bundle's copy is what the
design matrix is actually encoded under — and an artifact whose two copies
disagree cannot be served under either, so it does not load at all.

**Calibration is one required field, added by forecaster ticket 05.** The
bundle carries a :class:`~wattsteer_ml.training.calibration.Calibration` — the
isotonic map and its clip bounds, the reliability curve measured on pooled
out-of-fold predictions, and the derived ``risk_bins`` — and it is required
rather than optional for the same reason the six estimators are: an optional
field is a field a serving path can forget to check. A bundle written before 05
does not load, which is the correct outcome for an artifact that predates its
own calibration, and it is *why* the field was added required rather than with a
default.

**The conformal correction is one required field, added by forecaster ticket
06.** The bundle carries a
:class:`~wattsteer_ml.training.conformal.ConformalCorrection` — ``δ_lo``,
``δ_hi``, the window they were ranked over and the order statistic they are —
and it is required for the same reason the calibration is. A band served without
it is three booster outputs with no coverage statement behind them, and the
product prints the P10 as a floor in prose. A bundle written before 06 does not
load. The card gains the Quantiles group at the same time: a card with no
``delta_lo`` in it is a card that has not made a coverage statement, and that
absence was stated rather than defaulted right up until this ticket filled it.

**The PIT residual matrix is one required field, added by forecaster ticket
07.** The bundle carries a :class:`~wattsteer_ml.training.ensemble.PitMatrix` —
``U``, one row per complete calibration day and one column per subsystem-hour,
plus the window and the seed behind it — and it is required for the third time
for the same reason. Every figure above hour grain is a quantile of 500
whole-row draws of it, and a bundle without one can serve twenty-four hourly
bands and no day total at all; ``docs/specs/replay.md`` forbids reconstructing
that day total by summing the hourly band, so "absent" here means the day-grain
row simply cannot be produced. A bundle written before 07 does not load. The
card gains an Ensemble group at the same time, and the group is where the
matrix's per-column Kolmogorov–Smirnov distance is published: a ``U`` that is
not uniform means the marginals are miscalibrated and every day-grain number
drawn from it is meaningless.
"""

from __future__ import annotations

import json
import math
import platform
from collections.abc import Mapping
from dataclasses import dataclass, fields
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path
from typing import Any

import joblib
from lightgbm import Booster

from wattsteer_ml.artifacts import ARTIFACT_SUFFIX, CARD_SUFFIX
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import Fold, FoldBlocks
from wattsteer_ml.lanes import Lane, format_instant, is_artifact_id
from wattsteer_ml.training.calibration import Calibration, IsotonicCalibrator
from wattsteer_ml.training.conformal import ConformalCorrection, CoverageReport
from wattsteer_ml.training.contract import FeatureContract
from wattsteer_ml.training.ensemble import DayGrainCoverage, PitMatrix
from wattsteer_ml.training.hyperparameters import ESTIMATOR_FAMILY, ModelConfig

#: Hours in the local target day. `μ_sub` is 4 subsystems × this many hours.
HOURS_PER_DAY = 24

#: The six estimators, in the order the card lists them. Named here so the
#: loader's completeness check and the card's inventory cannot drift apart.
ESTIMATOR_FIELDS: tuple[str, ...] = (
    "occurrence",
    "magnitude_p10",
    "magnitude_p50",
    "magnitude_p90",
    "magnitude_mean",
    "wind_share",
)


class BundleError(ValueError):
    """A bundle that cannot be served as written."""


class PartialBundleError(BundleError):
    """A loaded bundle is missing a part of the mixture.

    Its own class because it is the failure the spec names: five estimators
    compose a *different* model, not a degraded one, and the caller that catches
    this must refuse rather than fall back.
    """


class ContractMismatchError(BundleError):
    """The card and the bundle disagree about the feature contract."""


@dataclass(frozen=True)
class SubThresholdMeans:
    """``μ_sub(subsystem, local_hour)`` — the 96 numbers, as a table.

    A fitted constant and not zero: `docs/specs/forecaster.md` puts the bias of
    dropping it at up to 24 × 5 = 120 MWh against day totals of a few hundred.
    Every cell is filled at construction — see :func:`fit_sub_threshold_means` —
    because a serving path that has to handle a missing cell is a serving path
    with an imputation rule in it.
    """

    #: One row per subsystem in :data:`SUBSYSTEM_CODES` order, 24 hours each.
    values: tuple[tuple[float, ...], ...]

    def __post_init__(self) -> None:
        if len(self.values) != len(SUBSYSTEM_CODES):
            raise BundleError(
                f"μ_sub needs one row per subsystem {SUBSYSTEM_CODES!r}, got "
                f"{len(self.values)}"
            )
        for code, row in zip(SUBSYSTEM_CODES, self.values, strict=True):
            if len(row) != HOURS_PER_DAY:
                raise BundleError(
                    f"μ_sub[{code}] covers {len(row)} hours, not {HOURS_PER_DAY}"
                )
            for hour, value in enumerate(row):
                if math.isnan(value) or math.isinf(value) or value < 0.0:
                    raise BundleError(
                        f"μ_sub[{code}][{hour}] is {value!r}; a mean over "
                        "sub-threshold MWh is finite and non-negative"
                    )

    def mean_for(self, subsystem: Subsystem, local_hour: int) -> float:
        """The cell for one served hour. Total, by construction."""
        if not 0 <= local_hour < HOURS_PER_DAY:
            raise BundleError(f"local hour {local_hour!r} is outside the target day")
        try:
            index = SUBSYSTEM_CODES.index(subsystem)
        except ValueError:
            raise BundleError(f"{subsystem!r} is not a subsystem") from None
        return self.values[index][local_hour]

    def as_card_table(self) -> dict[str, list[float]]:
        return {
            code: list(row)
            for code, row in zip(SUBSYSTEM_CODES, self.values, strict=True)
        }


@dataclass(frozen=True)
class HurdleBundle:
    """The six estimators, ``μ_sub``, and everything needed to encode a row.

    Six and not two: the occurrence classifier, three pinball boosters, the
    conditional-mean booster and the share regressor. The last two exist for
    reasons the spec states rather than for symmetry — reusing ``q̂_pos^0.50`` as
    the expectation understates it systematically on a right-skewed magnitude,
    and the share model is what makes a technology split a point split of a
    figure rather than a second band.
    """

    lane: Lane
    contract: FeatureContract
    model_config_version: str
    #: ``curtailment_threshold_mw``, echoed from the rows the fits saw. Equal to
    #: :attr:`Lane.threshold_mw` and stored anyway: this is the copy that
    #: travels into :func:`wattsteer_ml.mixture.compose`, and the composition
    #: takes ``threshold_mw`` as an argument precisely so it can never be
    #: inferred from somewhere else.
    threshold_mw: float
    occurrence: Booster
    magnitude_p10: Booster
    magnitude_p50: Booster
    magnitude_p90: Booster
    magnitude_mean: Booster
    wind_share: Booster
    sub_threshold_means: SubThresholdMeans
    #: The isotonic map, the reliability curve it is checked by, and the
    #: published ``risk_bins``. Required: ``p`` reaches
    #: :func:`wattsteer_ml.mixture.compose` through
    #: :attr:`Calibration.isotonic` and through no other route, so a bundle
    #: without one has no probability to compose with.
    calibration: Calibration
    #: ``δ_lo`` and ``δ_hi``, fitted on the same calibration window against the
    #: *composed* band. Required: they are what turns the P10 from the name of a
    #: booster's output into a measured floor, and
    #: :func:`~wattsteer_ml.training.hurdle.forecast_rows` applies them to
    #: ``Q_pos`` before the one composition — never after it.
    conformal: ConformalCorrection
    #: ``U`` — the randomised PIT of the composed, corrected band over the same
    #: calibration window, one row per complete day. Required: every figure
    #: above hour grain is a quantile of 500 whole-row draws of it, and the one
    #: alternative — summing the hourly band — is what both
    #: `docs/specs/forecaster.md` and `docs/specs/replay.md` forbid.
    pit: PitMatrix
    #: ``lightgbm`` — the allow-list the hot-swap gate's second check enforces.
    estimator_family: str = ESTIMATOR_FAMILY

    def __post_init__(self) -> None:
        if self.threshold_mw != self.lane.threshold_mw:
            raise BundleError(
                f"the bundle's threshold {self.threshold_mw} is not its lane's "
                f"{self.lane.threshold_mw}; a magnitude and the threshold that "
                "produced it travel together"
            )
        if self.estimator_family != ESTIMATOR_FAMILY:
            raise BundleError(
                f"estimator_family {self.estimator_family!r} is outside the "
                f"gate's allow-list {{{ESTIMATOR_FAMILY!r}}}"
            )
        threshold_mwh = self.threshold_mw * 1.0
        for code in SUBSYSTEM_CODES:
            for hour in range(HOURS_PER_DAY):
                mean = self.sub_threshold_means.mean_for(code, hour)
                if mean > threshold_mwh:
                    raise BundleError(
                        f"μ_sub[{code}][{hour}] is {mean}, above τ = "
                        f"{threshold_mwh}; it is a mean over rows at or below "
                        "the threshold and cannot exceed it"
                    )

    @property
    def feature_hash(self) -> str:
        return self.contract.feature_hash

    def estimators(self) -> dict[str, Booster]:
        """The six, by name — the inventory the card and the loader both use."""
        return {name: getattr(self, name) for name in ESTIMATOR_FIELDS}


@dataclass(frozen=True)
class TrainingCounts:
    """What the fits actually saw. The card's Data group, as measured."""

    base_fit_rows: int
    base_fit_labelled_rows: int
    base_fit_positive_rows: int
    base_fit_sub_threshold_rows: int
    calibration_rows: int
    calibration_labelled_rows: int
    calibration_positive_rows: int
    test_rows: int
    #: ``vintage_fidelity`` counted, never averaged
    #: (`wattsteer_ml.evaluation.vintage`): a fold that mixes the two values is
    #: reported as two numbers, because their mean describes no fold.
    vintage_fidelity: Mapping[str, int]

    def as_card_fields(self) -> dict[str, Any]:
        return {
            "base_fit_rows": self.base_fit_rows,
            "base_fit_labelled_rows": self.base_fit_labelled_rows,
            "base_fit_positive_rows": self.base_fit_positive_rows,
            "base_fit_sub_threshold_rows": self.base_fit_sub_threshold_rows,
            "calibration_rows": self.calibration_rows,
            "calibration_labelled_rows": self.calibration_labelled_rows,
            "calibration_positive_rows": self.calibration_positive_rows,
            "test_rows": self.test_rows,
            "vintage_fidelity": dict(sorted(self.vintage_fidelity.items())),
        }


@dataclass(frozen=True)
class ModelCard:
    """The document beside the bundle. Written whatever the gate later decides.

    The groups written here — Identity, Lane, Contract, Data, Calibration,
    Quantiles, Ensemble, plus the Environment block — are fields. The Metrics, Experiments
    and Decision groups accrete in forecaster tickets 09 and 13 and are absent
    here rather than present and empty, so a reader can tell "not measured yet"
    from "measured as nothing".

    **Quantiles is two halves with two different statuses.** ``δ_lo`` and
    ``δ_hi`` are always there, because a bundle cannot exist without them. The
    coverage block is ``None`` when the fold's test period held no curtailed
    hour to score — absent, and absent for a stated reason, rather than a row of
    zeros that would read as total failure.
    """

    artifact_id: str
    created_at: datetime
    lane: Lane
    contract: FeatureContract
    config: ModelConfig
    fold: Fold
    blocks: FoldBlocks
    counts: TrainingCounts
    sub_threshold_means: SubThresholdMeans
    calibration: Calibration
    conformal: ConformalCorrection
    #: ``U`` and what it measures about itself — the per-column KS distance, the
    #: days it kept and the days it dropped for holding an unsettled hour.
    pit: PitMatrix
    #: ``day_total_coverage`` and ``peak_coverage`` on this fold's test period.
    #: ``None`` when the test period held no complete settled day — absent for a
    #: stated reason, like the coverage block above it.
    day_grain: DayGrainCoverage | None = None
    #: Empirical coverage of this fold's test period, marginally and per
    #: subsystem and per local hour. ``None`` when the test period held no
    #: curtailed hour — see the class docstring. **Reported, never corrected**:
    #: nothing in :class:`~wattsteer_ml.training.conformal.ConformalCorrection`
    #: reads this field, and nothing can, because the correction is fitted
    #: before the test period is scored.
    coverage: CoverageReport | None = None
    #: The feature dictionary's version. `docs/specs/feature-engineering.md`
    #: owns it and its issue set has not published one yet, so this is ``None``
    #: until it does — recorded as an explicit null rather than defaulted to a
    #: string nobody minted, because a card that claims a version the dictionary
    #: never issued is worse than one that says the version is unknown.
    feature_set_version: str | None = None
    git_sha_ml: str | None = None
    git_sha_api: str | None = None

    def __post_init__(self) -> None:
        if not is_artifact_id(self.artifact_id):
            raise BundleError(
                f"{self.artifact_id!r} is not an artifact id; the stem of the "
                "bundle and of its card is an ISO-8601 UTC instant"
            )

    def to_dict(self) -> dict[str, Any]:
        """The card as it is written to ``*.card.json``."""
        return {
            "identity": {
                "artifact_id": self.artifact_id,
                "created_at": format_instant(self.created_at),
                "estimator_family": ESTIMATOR_FAMILY,
                "model_config_version": self.config.version,
                "git_sha_ml": self.git_sha_ml,
                "git_sha_api": self.git_sha_api,
            },
            "lane": {
                "feature_set": self.lane.feature_set,
                "feature_set_version": self.feature_set_version,
                "gate_profile": self.lane.gate_profile,
                "threshold_mw": self.lane.threshold_mw,
                "subsystems": list(SUBSYSTEM_CODES),
                "directory": self.lane.directory_name,
            },
            "contract": self.contract.card_fields(),
            "fold": {
                "fold_id": self.fold.id,
                "fold_hash": self.fold.fold_hash,
                "rules_digest": self.fold.rules_digest,
            },
            "data": {
                "training_window": _window(
                    self.blocks.train_start, self.blocks.train_end
                ),
                "base_fit_window": _window(
                    self.blocks.base_fit_start, self.blocks.base_fit_end
                ),
                "calibration_window": _window(
                    self.blocks.calibration_start, self.blocks.calibration_end
                ),
                "test_window": _window(self.blocks.test_start, self.blocks.test_end),
                **self.counts.as_card_fields(),
            },
            "model_config": self.config.card_fields(),
            "calibration": dict(self.calibration.card_fields()),
            "quantiles": {
                **self.conformal.card_fields(),
                **(
                    self.coverage.card_fields()
                    if self.coverage is not None
                    else {
                        "coverage": None,
                        "coverage_absent_reason": (
                            "this fold's test period held no curtailed hour, so "
                            "there is no interval whose coverage could fail"
                        ),
                    }
                ),
            },
            "ensemble": {
                **self.pit.card_fields(),
                **(
                    self.day_grain.card_fields()
                    if self.day_grain is not None
                    else {
                        "day_grain_coverage": None,
                        "day_grain_absent_reason": (
                            "this fold's test period held no day whose "
                            "twenty-four hours are all settled, so there is no "
                            "observed day total for a day band to be scored "
                            "against"
                        ),
                    }
                ),
            },
            "sub_threshold_means": self.sub_threshold_means.as_card_table(),
            "environment": environment_versions(),
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=False) + "\n"


@dataclass(frozen=True)
class LoadedArtifact:
    """A bundle and its card, checked against each other."""

    artifact_id: str
    bundle: HurdleBundle
    #: The card as written. Parsed no further than the contract check needs:
    #: the card is an audit document, and the reader that wants the metrics
    #: block is the hot-swap gate, which arrives with forecaster ticket 13.
    card: Mapping[str, Any]


def environment_versions() -> dict[str, str]:
    """Python and the fitting libraries, as installed. The card's last group."""
    versions = {"python": platform.python_version()}
    for package in ("lightgbm", "numpy", "joblib", "scipy"):
        try:
            versions[package] = metadata.version(package)
        except metadata.PackageNotFoundError:  # pragma: no cover — installed by uv
            versions[package] = "not-installed"
    return versions


def new_artifact_id(moment: datetime | None = None) -> str:
    """The stem for a bundle written now. ISO-8601 UTC, seconds, ``Z``."""
    return format_instant(moment if moment is not None else datetime.now(UTC))


def save_artifact(
    bundle: HurdleBundle, card: ModelCard, *, root: Path
) -> tuple[Path, Path]:
    """Write the bundle and its card into the lane directory under ``root``.

    Both, or neither that anything will serve: the bundle is written first and
    the card second, so a crash between the two leaves an artifact whose card is
    missing — which :func:`load_artifact` refuses — rather than a card promising
    a bundle that is not there, which the promotion log would believe.
    """
    if card.lane != bundle.lane:
        raise ContractMismatchError(
            f"the card names lane {card.lane} and the bundle {bundle.lane}"
        )
    if card.contract.feature_hash != bundle.contract.feature_hash:
        raise ContractMismatchError(
            f"the card's feature hash {card.contract.feature_hash} is not the "
            f"bundle's {bundle.contract.feature_hash}"
        )
    directory = root / bundle.lane.directory_name
    directory.mkdir(parents=True, exist_ok=True)
    bundle_path = directory / f"{card.artifact_id}{ARTIFACT_SUFFIX}"
    card_path = directory / f"{card.artifact_id}{CARD_SUFFIX}"
    joblib.dump(bundle, bundle_path)
    card_path.write_text(card.to_json(), encoding="utf-8")
    return bundle_path, card_path


def load_artifact(*, root: Path, lane: Lane, artifact_id: str) -> LoadedArtifact:
    """Load a bundle and its card, or refuse — never a partial mixture."""
    directory = root / lane.directory_name
    bundle_path = directory / f"{artifact_id}{ARTIFACT_SUFFIX}"
    card_path = directory / f"{artifact_id}{CARD_SUFFIX}"
    if not bundle_path.is_file():
        raise BundleError(f"no bundle at {bundle_path}")
    if not card_path.is_file():
        raise BundleError(
            f"{artifact_id} has a bundle and no card at {card_path}; the card is "
            "written regardless of the gate's decision, so its absence means the "
            "write did not complete"
        )
    bundle = _validated(joblib.load(bundle_path))
    card = json.loads(card_path.read_text(encoding="utf-8"))
    if not isinstance(card, dict):
        raise BundleError(f"{card_path} does not hold a model card")
    card_hash = card.get("contract", {}).get("feature_hash")
    if card_hash != bundle.contract.feature_hash:
        raise ContractMismatchError(
            f"{artifact_id}: the card's feature_hash {card_hash!r} disagrees with "
            f"the bundle's stored feature list, which hashes to "
            f"{bundle.contract.feature_hash!r}"
        )
    if bundle.lane != lane:
        raise ContractMismatchError(
            f"{artifact_id} sits in {lane.directory_name} but is bound to "
            f"{bundle.lane.directory_name}"
        )
    return LoadedArtifact(artifact_id=artifact_id, bundle=bundle, card=card)


def _validated(loaded: object) -> HurdleBundle:
    """Every field present and of the right kind, after an ``__init__``-less load."""
    if not isinstance(loaded, HurdleBundle):
        raise PartialBundleError(
            f"the bundle holds a {type(loaded).__name__}, not a HurdleBundle"
        )
    missing = [
        field.name
        for field in fields(loaded)
        if getattr(loaded, field.name, None) is None
    ]
    if missing:
        raise PartialBundleError(
            f"the bundle is missing {', '.join(sorted(missing))}; five estimators "
            "compose a different model, not a degraded one"
        )
    for name, estimator in loaded.estimators().items():
        if not isinstance(estimator, Booster):
            raise PartialBundleError(
                f"{name} is a {type(estimator).__name__}, not a LightGBM Booster"
            )
    _validated_calibration(loaded.calibration)
    _validated_conformal(loaded.conformal)
    _validated_pit(loaded.pit)
    return loaded


def _validated_pit(pit: object) -> None:
    """``U``, after the same ``__init__``-less load.

    A bundle whose matrix came back as something else could still serve
    twenty-four hourly bands, which is what makes this worth checking rather
    than discovering: the failure would surface as a day total that some caller
    reconstructed by summing them, and the whole of forecaster ticket 07 is that
    such a number is wrong by roughly ``√24``. The re-validation runs
    ``__post_init__``'s checks over the loaded values, so a truncated row or a
    PIT outside ``[0, 1]`` fails here rather than inside a draw.
    """
    if not isinstance(pit, PitMatrix):
        raise PartialBundleError(
            f"the bundle's PIT matrix is a {type(pit).__name__}, not a PitMatrix; "
            "without it there is no day total that is not a sum of quantiles"
        )
    pit.__post_init__()


def _validated_conformal(conformal: object) -> None:
    """The two deltas, after the same ``__init__``-less load.

    A bundle whose correction came back as something else would serve the raw
    booster quantiles under a card that publishes a ``δ_lo``, which is the one
    failure this ticket exists to prevent: a P10 printed as a floor with no
    coverage statement behind it. The re-validation runs
    ``__post_init__``'s checks over the loaded values rather than trusting the
    pickle's shape, so a truncated ``rank`` or a window that ran backwards fails
    here rather than on a screen.
    """
    if not isinstance(conformal, ConformalCorrection):
        raise PartialBundleError(
            f"the bundle's conformal correction is a {type(conformal).__name__}, "
            "not a ConformalCorrection; a band with no measured correction is "
            "three booster outputs and a promise"
        )
    conformal.__post_init__()


def _validated_calibration(calibration: object) -> None:
    """The calibration, part by part, after the same ``__init__``-less load.

    Checked as closely as the estimators are, and for the same failure: a bundle
    whose isotonic map came back as ``None`` would serve ``p_raw`` under a card
    that claims a calibrated probability, which is a worse outcome than not
    serving — the number would be wrong in the one place the product renders a
    percentage and names a risk class from it.
    """
    if not isinstance(calibration, Calibration):
        raise PartialBundleError(
            f"the bundle's calibration is a {type(calibration).__name__}, not a "
            "Calibration"
        )
    for name in ("isotonic", "reliability", "risk_bins"):
        if getattr(calibration, name, None) is None:
            raise PartialBundleError(
                f"the bundle's calibration is missing {name}; a calibrated "
                "probability with no measured curve behind it and no published "
                "edges is a claim nobody checked"
            )
    if not isinstance(calibration.isotonic, IsotonicCalibrator):
        raise PartialBundleError(
            f"the calibrator is a {type(calibration.isotonic).__name__}, not an "
            "IsotonicCalibrator"
        )


def _window(start: Any, end: Any) -> dict[str, str]:
    return {"start": start.isoformat(), "end": end.isoformat()}
