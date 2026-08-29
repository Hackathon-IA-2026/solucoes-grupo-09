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
from dataclasses import dataclass
from typing import Any

#: The version this service trains under today. Bumping it is a retrain trigger.
MODEL_CONFIG_VERSION = "lgbm_conservative_v1"

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
    """One published configuration, shared by all six boosters.

    The six estimators differ in their *objective* and in the rows they see,
    not in their capacity: one conservative shape, so a fold's six fits are
    comparable with each other and with the next week's six.
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
    #: from its role, so the six fits are not six copies of one bagging draw.
    seed: int

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

    def params(
        self, *, objective: str, role: str, alpha: float | None = None
    ) -> dict[str, Any]:
        """LightGBM parameters for one of the six roles.

        ``role`` only perturbs the seed. It is in the signature rather than
        derived from ``objective`` because two of the six share an objective —
        the conditional-mean booster and the share regressor are both ``l2`` —
        and giving them the same bagging draw would make their errors correlated
        for no reason anyone chose.
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
        }


def _role_offset(role: str) -> int:
    """A stable per-role seed offset. Stable across processes, so not ``hash``."""
    return sum(byte * (index + 1) for index, byte in enumerate(role.encode())) % 1_000


#: The v1 configuration, exactly as `docs/specs/forecaster.md` publishes it:
#: "≤ 800 trees, `learning_rate` 0.05, `num_leaves` 63, `min_data_in_leaf` 100,
#: early stopping on the calibration window's pinball loss". The two fractions
#: are not in the spec's sentence; they are set below 1 so the six fits are not
#: deterministic copies of one another's greedy split search, and they are part
#: of the version rather than of a caller.
MODEL_CONFIG_V1 = ModelConfig(
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
)

#: Every configuration this build can reproduce, by version. A card naming one
#: that is not here is refused rather than retrained under the current default.
MODEL_CONFIGS: Mapping[str, ModelConfig] = {MODEL_CONFIG_V1.version: MODEL_CONFIG_V1}


def model_config(version: str) -> ModelConfig:
    """The published configuration under ``version``, or a loud failure."""
    try:
        return MODEL_CONFIGS[version]
    except KeyError:
        known = ", ".join(sorted(MODEL_CONFIGS))
        raise UnknownModelConfigError(
            f"no published model configuration named {version!r}; this build has {known}"
        ) from None
