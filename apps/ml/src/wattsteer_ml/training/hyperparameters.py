"""The published model configuration, named by a version and never searched.

`docs/specs/forecaster.md`, "The baseline ladder":

> **Hyperparameters are fixed, published, and not searched during a retrain.** A
> search inside the weekly retrain makes the artifact irreproducible and the
> gate's comparison meaningless — the candidate would differ from the incumbent
> in both data and configuration. Tuning is a separate offline pass whose output
> is a new ``model_config_version``; bumping it is a retrain trigger and the new
> config must clear the same gate.

So the configuration is data in this module rather than keyword arguments at a
call site, it is addressed by :data:`MODEL_CONFIGS` under a version string, and
that string is stamped on the card. There is no function here that takes a
search space, and :mod:`tests.test_model_config` asserts against the training
package's own source text that none of the search APIs is imported — a rule
nobody checks is a rule that survives exactly one urgent Friday.

**Determinism is part of the configuration, not of the caller.** ``seed``,
``deterministic``, ``force_row_wise`` and ``num_threads = 1`` are set here and
travel with the version, because "same inputs and same seed reproduce identical
predictions" is a property of the artifact and a hot-swap concern, and a
reproducibility that depends on how many cores the retrain host happened to
have is not one.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

#: The version this service trains under today. Bumping it is a retrain trigger.
MODEL_CONFIG_VERSION = "lgbm_conservative_v2"

#: ``estimator_family`` — the hot-swap gate's allow-list has one member, and
#: this is where a bundle's claim to it is written. The transformer benchmark
#: (`docs/specs/forecaster.md` §"The transformer benchmark") is refused by the
#: gate on exactly this field, so it is a stamped fact rather than an inference
#: from the object graph.
ESTIMATOR_FAMILY = "lightgbm"


class UnknownModelConfigError(KeyError):
    """A ``model_config_version`` this build has never published.

    Its own class because "the card names a configuration we do not have" is a
    reproducibility failure, not a missing dictionary key: the artifact cannot
    be retrained into, and the reader should say so rather than fall back to
    whatever the current version happens to be.
    """


@dataclass(frozen=True)
class ModelConfig:
    """One published configuration, shared by all eight boosters by default.

    Through v1 the eight estimators differed in their *objective* and in the
    rows they see, not in their capacity — one conservative shape, so a fold's
    eight fits were comparable with each other and with the next week's eight.
    v2 keeps that for six of them and breaks it, deliberately, for the two
    lowest quantile boosters: ``role_overrides`` is where the measurement that
    justifies the exception lives, and everywhere else this dataclass still
    describes one shape shared by every role.
    """

    version: str
    #: ``≤ 800 trees`` in the spec. An upper bound, not a target: early stopping
    #: on the calibration window decides where the fit actually stops.
    num_boost_round: int
    learning_rate: float
    num_leaves: int
    min_data_in_leaf: int
    feature_fraction: float
    bagging_fraction: float
    bagging_freq: int
    #: Early stopping watches the **calibration** window, per the spec's own
    #: sentence. The calibration rows are never fit on — they choose a tree
    #: count and nothing else — and the base learners are not refit afterwards,
    #: which is the invariant :class:`~wattsteer_ml.evaluation.FoldBlocks`
    #: exists to hold. ``0`` disables the monitor entirely.
    early_stopping_rounds: int
    #: One seed for the whole bundle. Each booster derives its own from it and
    #: from its role, so the seven fits are not seven copies of one bagging draw.
    seed: int
    #: Per-role parameter overrides, applied over the shared shape above.
    #: Empty for v1, by design: v1's docstring claim that the estimators
    #: "differ in objective and in the rows they see, not in capacity" is true
    #: exactly because nothing is here. v2 uses this for the two lowest
    #: quantile boosters — see :data:`MODEL_CONFIG_V2` for the measurement that
    #: justifies breaking that claim for them and no one else.
    role_overrides: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    #: Halves a training row's weight every this many days of age, in the
    #: **training** dataset only — never in the calibration monitor and never
    #: in conformal ranking, which are answering different questions (where to
    #: stop; what the residuals actually were) that recency has no business
    #: reweighting. ``None`` reproduces v1 exactly: every row weighted 1.
    recency_half_life_days: int | None = None

    def __post_init__(self) -> None:
        if not self.version:
            raise ValueError("a model configuration must be named")
        for name in ("num_boost_round", "num_leaves", "min_data_in_leaf"):
            value = getattr(self, name)
            if value < 1:
                raise ValueError(f"{name} must be at least 1, got {value!r}")
        if not 0.0 < self.learning_rate <= 1.0:
            raise ValueError(f"learning_rate must be in (0, 1], got {self.learning_rate}")
        for name in ("feature_fraction", "bagging_fraction"):
            value = getattr(self, name)
            if not 0.0 < value <= 1.0:
                raise ValueError(f"{name} must be in (0, 1], got {value!r}")
        if self.early_stopping_rounds < 0:
            raise ValueError(
                f"early_stopping_rounds cannot be negative, got "
                f"{self.early_stopping_rounds!r}"
            )
        if self.recency_half_life_days is not None and self.recency_half_life_days < 1:
            raise ValueError(
                "recency_half_life_days must be at least 1 day, got "
                f"{self.recency_half_life_days!r}"
            )

    def params(
        self, *, objective: str, role: str, alpha: float | None = None
    ) -> dict[str, Any]:
        """LightGBM parameters for one of the seven roles.

        ``role`` only perturbs the seed. It is in the signature rather than
        derived from ``objective`` because two of the seven share an objective —
        the conditional-mean booster and the share regressor are both ``l2`` —
        and giving them the same bagging draw would make their errors correlated
        for no reason anyone chose.

        ``role_overrides`` is applied **after** the shared shape, keyed on the
        same ``role`` string — ``_fit_quantile`` builds it as
        ``f"magnitude_q{alpha:.2f}"``, so ``"magnitude_q0.02"`` is a role like
        any other rather than a special case here.
        """
        params: dict[str, Any] = {
            "objective": objective,
            "learning_rate": self.learning_rate,
            "num_leaves": self.num_leaves,
            "min_data_in_leaf": self.min_data_in_leaf,
            "feature_fraction": self.feature_fraction,
            "bagging_fraction": self.bagging_fraction,
            "bagging_freq": self.bagging_freq,
            "seed": self.seed + _role_offset(role),
            "deterministic": True,
            "force_row_wise": True,
            "num_threads": 1,
            "verbosity": -1,
            # NULL is a signal here, not an absence to be filled: a lag that did
            # not clear the gate is NULL *because it was not knowable*. LightGBM
            # routes missing values down their own branch, and this switch is
            # what stops it inventing a zero instead.
            "use_missing": True,
            "zero_as_missing": False,
        }
        if alpha is not None:
            params["alpha"] = alpha
        params.update(self.role_overrides.get(role, {}))
        return params

    def card_fields(self) -> dict[str, Any]:
        """The configuration as the card records it — every number, no summary."""
        return {
            "model_config_version": self.version,
            "estimator_family": ESTIMATOR_FAMILY,
            "num_boost_round": self.num_boost_round,
            "learning_rate": self.learning_rate,
            "num_leaves": self.num_leaves,
            "min_data_in_leaf": self.min_data_in_leaf,
            "feature_fraction": self.feature_fraction,
            "bagging_fraction": self.bagging_fraction,
            "bagging_freq": self.bagging_freq,
            "early_stopping_rounds": self.early_stopping_rounds,
            "seed": self.seed,
            # Recorded as plain dicts, never the ``Mapping`` type itself — a
            # card is JSON, and a role that overrides nothing is absent from
            # this rather than present with an empty dict, so a reader scanning
            # the card sees exactly which roles this version treats differently.
            "role_overrides": {
                role: dict(overrides) for role, overrides in self.role_overrides.items()
            },
            "recency_half_life_days": self.recency_half_life_days,
        }


def _role_offset(role: str) -> int:
    """A stable per-role seed offset. Stable across processes, so not ``hash``."""
    return sum(byte * (index + 1) for index, byte in enumerate(role.encode())) % 1_000


#: The v1 configuration, exactly as `docs/specs/forecaster.md` published it:
#: "≤ 800 trees, `learning_rate` 0.05, `num_leaves` 63, `min_data_in_leaf` 100,
#: early stopping on the calibration window's pinball loss". The two fractions
#: are not in the spec's sentence; they are set below 1 so the seven fits are
#: not deterministic copies of one another's greedy split search, and they are
#: part of the version rather than of a caller.
#:
#: **Kept, not retired.** `UnknownModelConfigError` exists so a card naming a
#: configuration this build cannot reproduce is refused rather than silently
#: retrained under whatever is current; keeping v1 in `MODEL_CONFIGS` is what
#: makes that guarantee mean something for an artifact already on the volume.
MODEL_CONFIG_V1 = ModelConfig(
    version="lgbm_conservative_v1",
    num_boost_round=800,
    learning_rate=0.05,
    num_leaves=63,
    min_data_in_leaf=100,
    feature_fraction=0.9,
    bagging_fraction=0.9,
    bagging_freq=1,
    early_stopping_rounds=50,
    seed=20_260_828,
)

#: **v2 — the current default.** Same shared shape as v1, with one change the
#: live P10 diagnostic (`p10_calibration_run.py`, 2026-09-23) measured a need
#: for: **the lowest quantile booster is regularised on its own.**
#: ``raw_q02_coverage`` read 0.000 in every probability bin on both refused
#: lanes against a 0.02 target — a 2% pinball target estimated from ~2
#: effective observations per leaf at v1's ``min_data_in_leaf = 100``, with 63
#: leaves of capacity and a 49:1 gradient asymmetry pushing the fit down. Fewer
#: leaves, more data per leaf and an L2 penalty, on ``magnitude_q0.02`` only —
#: every other role keeps v1's numbers exactly, via `ModelConfig.role_overrides`.
#:
#: **Recency weighting was measured and dropped.** An earlier draft of this
#: configuration carried ``recency_half_life_days=180``, on the argument that it
#: would address the month-to-month swing in ``delta_lo_oracle``. A five-arm
#: ablation on gate_early F6 (2026-09-23) measured it doing something else: it
#: moved `p50_unbiasedness_in_band` from 0.5127 to 0.5618, outside [0.45, 0.55],
#: and refused the lane. Removing it restored 0.5030 and contributed only 4% of
#: the `p10_calibration_excess` repair, which the q02 regularisation and the
#: per-subsystem ``delta_lo`` do. `_recency_weights` is kept, and ``None`` here
#: reproduces v1's unweighted fit exactly; the knob is not the finding, the
#: 180-day half-life on this pool is.
MODEL_CONFIG_V2 = ModelConfig(
    version=MODEL_CONFIG_VERSION,
    num_boost_round=800,
    learning_rate=0.05,
    num_leaves=63,
    min_data_in_leaf=100,
    feature_fraction=0.9,
    bagging_fraction=0.9,
    bagging_freq=1,
    early_stopping_rounds=50,
    seed=20_260_828,
    role_overrides={
        "magnitude_q0.02": {
            "num_leaves": 15,
            "min_data_in_leaf": 300,
            "lambda_l2": 10.0,
        },
    },
)

#: Every configuration this build can reproduce, by version. A card naming one
#: that is not here is refused rather than retrained under the current default.
MODEL_CONFIGS: Mapping[str, ModelConfig] = {
    MODEL_CONFIG_V1.version: MODEL_CONFIG_V1,
    MODEL_CONFIG_V2.version: MODEL_CONFIG_V2,
}


def model_config(version: str) -> ModelConfig:
    """The published configuration under ``version``, or a loud failure."""
    try:
        return MODEL_CONFIGS[version]
    except KeyError:
        known = ", ".join(sorted(MODEL_CONFIGS))
        raise UnknownModelConfigError(
            f"no published model configuration named {version!r}; this build has {known}"
        ) from None
