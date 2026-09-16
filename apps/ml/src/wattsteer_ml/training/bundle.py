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

**The matched background is one required field, added by forecaster ticket
30.** The bundle carries a
:class:`~wattsteer_ml.training.background.MatchedBackground` — ``B(s, h)``, 128
rows per ``(subsystem, local_hour)`` cell drawn once from this artifact's own
base-fit block with the seed the run stamped — and it is required for the
fourth time, with an argument that is not the previous three's. The other three
are pieces the model needs in order to *say* anything. This one is the other
half of a comparison: ``v(S) = (1/|B|) · Σ_b g(x[S] ⊕ b[S̄])``, and until this
ticket ``g`` was frozen in the artifact while ``B`` was redrawn at publication
from a database read. The two halves of one published number had two
provenances, and the read was not point-in-time — a backfill or a vintage
correction moved "typical" under an artifact that had not changed, and the
contract hash catches a column change, never a value change. A bundle written
before 30 does not load. The card gains a Background group at the same time,
carrying the four facts
:meth:`~wattsteer_ml.training.background.MatchedBackground.card_fields`
publishes and the sample's **measured** size, which is the largest single thing
in the artifact.
"""

from __future__ import annotations

import json
import math
import os
import platform
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass, fields
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path
from typing import Any

import joblib
from lightgbm import Booster

from wattsteer_ml.admissibility import lane_vector
from wattsteer_ml.artifacts import ARTIFACT_SUFFIX, CARD_SUFFIX

# Re-exported explicitly (`X as X`, which is what `no_implicit_reexport` asks
# for) rather than merely imported: the card's Decision group, the key inside it
# that marks an artifact invalid, and the reader of that key live in
# `wattsteer_ml.artifacts` — the module that owns the volume and the card's
# filename, and the one module the gate, this loader and `/v1/meta` can all
# import without a cycle. They are re-exported here because every caller in the
# repository already spells them in this namespace, and moving the definition
# should not move the import.
from wattsteer_ml.artifacts import CONTRACT_FAULT_KEY as CONTRACT_FAULT_KEY
from wattsteer_ml.artifacts import GATE_BLOCK_KEY as GATE_BLOCK_KEY
from wattsteer_ml.artifacts import contract_fault as contract_fault
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.declined import DeclinedFigure
from wattsteer_ml.driver_groups import CARD_DRIVERS_GROUP
from wattsteer_ml.evaluation import Fold, FoldBlocks
from wattsteer_ml.lanes import Lane, format_instant, is_artifact_id
from wattsteer_ml.training.background import MatchedBackground
from wattsteer_ml.training.calibration import Calibration, IsotonicCalibrator
from wattsteer_ml.training.conformal import ConformalCorrection, CoverageReport
from wattsteer_ml.training.contract import FeatureContract
from wattsteer_ml.training.ensemble import DayGrainCoverage, PitMatrix
from wattsteer_ml.training.headline_check import HeadlineFeatureCheck
from wattsteer_ml.training.hyperparameters import ESTIMATOR_FAMILY, ModelConfig

#: Hours in the local target day. `μ_sub` is 4 subsystems × this many hours.
HOURS_PER_DAY = 24

#: How :func:`save_artifact` compresses the bundle. ``zlib`` at level 3, and
#: both halves of that are measured rather than chosen.
#:
#: **Why the artifact is compressed at all.** Forecaster 30 froze ``B(s, h)``
#: into the bundle and the sample is the largest thing in it by an order of
#: magnitude: at the spec's 128 rows per cell, 96 cells and ``k = 100``, the
#: float64 payload is 9,830,400 bytes against 805,883 for everything else. The
#: sample is *not* the thing to shrink — 128 rows per cell is what
#: `docs/specs/diagnosis.md` asks for, float64 is what the boosters were fitted
#: in, and every column of every row is read (the eight driver groups are a
#: total partition of the contract, so at the empty coalition the whole row is
#: the background's). The *container* is. Compression changes no value the
#: attribution reads, and forecaster 32 measured what it buys on a real
#: 181-day base-fit window read out of the live database: a bundle carrying the
#: real 128-row sample is **11,224,847 bytes** written raw and **2,217,719
#: bytes** written this way — 80.2% less — for **+7.8 ms** on a
#: :func:`load_artifact` that took 50.6 ms.
#:
#: **Why zlib and why 3.** ``zlib`` ships with CPython, so this adds no
#: dependency to a service whose artifact format is a deployment contract;
#: ``lz4``, which joblib prefers when it is installed, is not installed and
#: buying it with a dependency was not worth the difference. Level 9 writes
#: 2,082,816 bytes — 6% smaller — and takes 3.7× as long to dump, which a
#: weekly retrain would not notice and a reader of this constant would have to
#: justify; level 3 is the knee.
#:
#: **It is lossless, and that is asserted rather than assumed.** joblib's
#: codecs are byte-exact, so a cell's ``matrix.tobytes()`` and its ``float64``
#: dtype survive the round trip unchanged —
#: ``test_the_written_artifact_is_compressed_and_the_sample_survives_it`` holds
#: the written-and-reloaded sample against the drawn one cell by cell with no
#: tolerance, beside the two tests that already prove a reloaded bundle
#: predicts identically and carries the same sample bit for bit.
BUNDLE_COMPRESSION: tuple[str, int] = ("zlib", 3)

#: The estimators, in the order the card lists them. Named here so the loader's
#: completeness check and the card's inventory cannot drift apart.
ESTIMATOR_FIELDS: tuple[str, ...] = (
    "occurrence",
    "magnitude_p02",
    "magnitude_p10",
    "magnitude_p50",
    "magnitude_p90",
    "magnitude_mean",
    "wind_share",
)


#: Why ``quantiles.coverage`` is ``null`` on a card whose fold had no curtailed
#: hour to cover. It was an inline sentence in :meth:`ModelCard.to_dict` — a
#: reason with no name, which no rule and no grep could find — and forecaster 27
#: named it. ``unrunnable`` and not ``unrun``: a fold is a fixed window of rows,
#: so a rerun of *this* fold cannot produce a curtailed hour that is not in it.
#: The precedent is :data:`~wattsteer_ml.replay.floor_guardrail.COLD_START_DETAIL`,
#: which forecaster 25 read a structural absence that way for the same reason.
NO_CURTAILED_HOUR_TO_COVER = DeclinedFigure(
    "this fold's test period held no curtailed hour, so there is no interval "
    "whose coverage could fail",
    figure=(
        "this fold's interval coverage — the share of curtailed hours inside "
        "the P10-P90 band"
    ),
    kind="unrunnable",
    surface="the artifact card's `quantiles` group, `coverage_absent_reason`",
)

#: And why ``ensemble.day_grain_coverage`` is ``null``. The same shape and the
#: same kind, on the other of the two anonymous sentences: the population is
#: complete settled days, and a fold holding none of them holds none of them.
NO_SETTLED_DAY_TO_SCORE = DeclinedFigure(
    "this fold's test period held no day whose twenty-four hours are all "
    "settled, so there is no observed day total for a day band to be scored "
    "against",
    figure=(
        "this fold's day-grain coverage — the share of complete settled days "
        "inside the day band"
    ),
    kind="unrunnable",
    surface="the artifact card's `ensemble` group, `day_grain_absent_reason`",
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
    #: ``q̂_pos^0.02``. The knot that makes the composed P10 an interpolated
    #: quantile rather than the flat below the first one — see `FITTED_ALPHAS`.
    magnitude_p02: Booster
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
    #: ``B(s, h)`` — 128 rows per ``(subsystem, local_hour)`` cell, drawn once
    #: from this artifact's own base-fit block with the seed the run stamped.
    #: Required, and required for the fourth time for a reason of the same
    #: shape: an attribution is a comparison, ``g`` is frozen here and the rows
    #: it is compared *against* were not, so a stored explanation used to be
    #: reproducible from the artifact plus a database read — two provenances
    #: for the two halves of one number. A bundle written before forecaster 30
    #: does not load.
    background: MatchedBackground
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
        if self.background.feature_names != self.contract.feature_names:
            raise BundleError(
                "the frozen background is encoded under a different feature list "
                "than the bundle's contract; a 'typical' row whose columns are "
                "not the target's columns attributes the wrong feature to the "
                "wrong group and says nothing about it"
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
    #: The frozen sample, as the bundle carries it. The card reports four facts
    #: about it and its measured size; the rows themselves stay in the joblib.
    background: MatchedBackground
    #: The three fields `docs/specs/diagnosis.md` asks the forecaster's card
    #: for: the partition's version and hash, and the per-group verdict on each
    #: declared headline feature. Required and undefaulted, for the reason
    #: :attr:`background` is — a card that cannot say which driver-group
    #: partition produced the artifact is a card whose stored attributions are
    #: not comparable with anybody's, and there is no honest default for it.
    headline_check: HeadlineFeatureCheck
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
                # What this lane's gate profile lets it see, and what it
                # withholds. On the same document as
                # `contract.unpopulated_features`, and that is the point: at
                # `gate_early` those two lists overlap, and only this one says
                # which of the NULLs are the gate's and will never be filled.
                "experiment": lane_vector(self.lane).card_fields(),
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
                        "coverage_absent_reason": NO_CURTAILED_HOUR_TO_COVER,
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
                        "day_grain_absent_reason": NO_SETTLED_DAY_TO_SCORE,
                    }
                ),
            },
            "background": {
                **self.background.card_fields(),
                # Measured off the arrays that are about to be pickled, not
                # computed from the shape they were asked for. It is the
                # largest thing in the bundle — 12,288 rows at full size
                # against six boosters — and forecaster 30's last box asks for
                # a number rather than an estimate of one.
                "background_matrix_bytes": str(self.background.matrix_bytes),
            },
            # `driver_group_version`, `driver_group_hash` and the
            # `headline_feature_check` block — forecaster 31, and the second of
            # the two additions `docs/specs/diagnosis.md` asks the artifact for.
            # A group of its own, and its keys are prefixed inside it, because
            # the card is assembled by `**` merges and `merge_disjointly` now
            # raises on a collision.
            CARD_DRIVERS_GROUP: self.headline_check.card_fields(),
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

    **Neither file is ever seen half-written.** Each is composed under a
    temporary name in the destination directory and moved into place with
    :func:`os.replace`, which is atomic within a filesystem. Ordering alone was
    not enough for the case forecaster 15 has to survive: a retrain killed —
    OOM, redeploy, ``SIGKILL`` — part-way through ``joblib.dump`` used to leave a
    truncated ``.joblib`` under a real artifact id, which
    :mod:`wattsteer_ml.artifacts` lists as an artifact and a later
    :func:`~wattsteer_ml.evaluation.gate.rollback` would accept as a rollback
    target on the strength of the file existing. A partial write now leaves a
    ``.tmp`` file that no artifact-id rule matches, and the next run overwrites
    it.

    **The bundle is written compressed** — :data:`BUNDLE_COMPRESSION`, which
    carries the measurements. Losslessly: the frozen background's rows come back
    byte for byte and still ``float64``, which is the only way this was allowed
    to be a size decision rather than a statistical one. A truncated file is
    still a loud failure, from the codec instead of the unpickler.
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
    _atomically(
        bundle_path,
        lambda path: joblib.dump(bundle, path, compress=BUNDLE_COMPRESSION),
    )
    _atomically(card_path, lambda path: path.write_text(card.to_json(), encoding="utf-8"))
    return bundle_path, card_path


def read_card(path: Path) -> dict[str, Any]:
    """One card, parsed, or a refusal naming the file.

    The one reader, so that the loader and the hot-swap gate — which appends its
    Decision group to a card already on the volume — cannot disagree about what
    a card is. A card that is not a JSON object is not a partially valid card.
    """
    if not path.is_file():
        raise BundleError(
            f"no model card at {path}; the card is written regardless of the "
            "gate's decision, so its absence means the write did not complete"
        )
    parsed = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise BundleError(f"{path} does not hold a model card")
    card: dict[str, Any] = parsed
    return card


def write_card(path: Path, card: Mapping[str, Any]) -> None:
    """Rewrite a card in place, in the spelling :meth:`ModelCard.to_json` uses.

    The gate's Decision group arrives after the card has been written — training
    writes the card, the gate then decides about it — so the card is edited
    rather than composed a second time. Same indent, same key order, same
    trailing newline, so a rewritten card diffs against its predecessor by the
    group that was added and nothing else.
    """
    body = json.dumps(dict(card), indent=2, sort_keys=False) + "\n"
    _atomically(path, lambda target: target.write_text(body, encoding="utf-8"))


def _atomically(path: Path, write: Callable[[Path], Any]) -> None:
    """Compose the file beside its destination, then move it into place.

    The temporary name carries the destination's own stem so an interrupted run
    is traceable to the artifact it was writing, and a suffix no artifact id can
    have, so :mod:`wattsteer_ml.artifacts` never lists it. Same directory, so
    the :func:`os.replace` is a rename within one filesystem rather than a copy
    across two — which is the only form of it that is atomic.
    """
    handle, name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    os.close(handle)
    temporary = Path(name)
    try:
        write(temporary)
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


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
    card = read_card(card_path)
    fault = contract_fault(card)
    if fault is not None:
        raise ContractMismatchError(
            f"{artifact_id} is marked invalid on its own card and will not load: {fault}"
        )
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
    _validated_background(loaded.background)
    return loaded


def _validated_background(background: object) -> None:
    """``B(s, h)``, after the same ``__init__``-less load.

    The field is required and undefaulted, so a bundle written before
    forecaster 30 comes back with the attribute *missing* and is caught by the
    ``None`` sweep above — which is the intended outcome and not a regression:
    the alternative is an artifact that loads, serves, and quietly redraws its
    own "typical" from a window the feature function may have moved under.

    What this adds on top is the shape. A background that came back as
    something else, or with a cell truncated, would not stop the bundle
    serving forecasts — the estimators are untouched — and the failure would
    surface as eight plausible bars measured against fewer rows than the card
    says. So ``__post_init__``'s checks are re-run over the loaded value, where
    an uneven cell is a refusal.
    """
    if not isinstance(background, MatchedBackground):
        raise PartialBundleError(
            f"the bundle's matched background is a {type(background).__name__}, "
            "not a MatchedBackground; without it 'typical' has no definition "
            "that survives outside the database"
        )
    background.__post_init__()


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
