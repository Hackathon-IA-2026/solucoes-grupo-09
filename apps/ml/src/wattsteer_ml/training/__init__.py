"""Training — the hurdle's six estimators, the bundle they live in, and the card.

`docs/specs/forecaster.md`, "The hurdle, composed", is the spec. What this
package owns is everything between a feature row and an artifact on the volume:

- :mod:`~wattsteer_ml.training.hyperparameters` — the published configuration,
  addressed by ``model_config_version`` and never searched.
- :mod:`~wattsteer_ml.training.contract` — the ordered feature names and the
  ``feature_rows`` definition, hashed together into ``feature_hash``.
- :mod:`~wattsteer_ml.training.design` — rows to a matrix, with nothing imputed.
- :mod:`~wattsteer_ml.training.calibration` — the isotonic map fitted on the
  calibration window, the reliability curve measured on pooled out-of-fold
  predictions, and the risk-class edges derived from it.
- :mod:`~wattsteer_ml.training.bundle` — the frozen bundle, the card, and a load
  that refuses a partial mixture.
- :mod:`~wattsteer_ml.training.hurdle` — the fit, and the composition, which is
  :func:`wattsteer_ml.mixture.compose` and nothing else.

What it deliberately does **not** own: the mixture arithmetic (ticket 01), the
fold calendar (ticket 03), and the lane layout and promotion log (ticket 02).
Each of those is imported here and none is restated.
"""

from wattsteer_ml.training.bundle import (
    ESTIMATOR_FIELDS,
    BundleError,
    ContractMismatchError,
    HurdleBundle,
    LoadedArtifact,
    ModelCard,
    PartialBundleError,
    SubThresholdMeans,
    TrainingCounts,
    environment_versions,
    load_artifact,
    new_artifact_id,
    save_artifact,
)
from wattsteer_ml.training.calibration import (
    MAX_RISK_BIN_GAP,
    MIN_BIN_HOURS,
    RELIABILITY_BINS,
    RISK_CLASSES,
    RISK_EDGE_STEP,
    BinMerge,
    Calibration,
    CalibrationError,
    IsotonicCalibrator,
    OutOfFoldPool,
    OutOfFoldPrediction,
    ReliabilityBin,
    ReliabilityCurve,
    RiskBinCheck,
    RiskBinDecision,
    RiskBins,
    RiskBinsUndeterminedError,
    RiskClass,
    calibrate,
    derive_risk_bins,
    outside_calibration_window,
    wilson_half_width,
)
from wattsteer_ml.training.contract import (
    FUNCTION_DEFINITION_SQL,
    LABEL_PREFIX,
    STAMP_COLUMNS,
    Dtype,
    FeatureColumn,
    FeatureContract,
    FeatureContractError,
    feature_column_names,
    read_feature_function_definition,
)
from wattsteer_ml.training.design import (
    DesignError,
    FeatureBlock,
    RowStamp,
)
from wattsteer_ml.training.hurdle import (
    HourForecast,
    TrainedFold,
    TrainingError,
    fit_sub_threshold_means,
    forecast_rows,
    train_fold,
)
from wattsteer_ml.training.hyperparameters import (
    ESTIMATOR_FAMILY,
    MODEL_CONFIG_V1,
    MODEL_CONFIG_VERSION,
    MODEL_CONFIGS,
    ModelConfig,
    UnknownModelConfigError,
    model_config,
)

__all__ = [
    "ESTIMATOR_FAMILY",
    "ESTIMATOR_FIELDS",
    "FUNCTION_DEFINITION_SQL",
    "LABEL_PREFIX",
    "MAX_RISK_BIN_GAP",
    "MIN_BIN_HOURS",
    "MODEL_CONFIGS",
    "MODEL_CONFIG_V1",
    "MODEL_CONFIG_VERSION",
    "RELIABILITY_BINS",
    "RISK_CLASSES",
    "RISK_EDGE_STEP",
    "STAMP_COLUMNS",
    "BinMerge",
    "BundleError",
    "Calibration",
    "CalibrationError",
    "ContractMismatchError",
    "DesignError",
    "Dtype",
    "FeatureBlock",
    "FeatureColumn",
    "FeatureContract",
    "FeatureContractError",
    "HourForecast",
    "HurdleBundle",
    "IsotonicCalibrator",
    "LoadedArtifact",
    "ModelCard",
    "ModelConfig",
    "OutOfFoldPool",
    "OutOfFoldPrediction",
    "PartialBundleError",
    "ReliabilityBin",
    "ReliabilityCurve",
    "RiskBinCheck",
    "RiskBinDecision",
    "RiskBins",
    "RiskBinsUndeterminedError",
    "RiskClass",
    "RowStamp",
    "SubThresholdMeans",
    "TrainedFold",
    "TrainingCounts",
    "TrainingError",
    "UnknownModelConfigError",
    "calibrate",
    "derive_risk_bins",
    "environment_versions",
    "feature_column_names",
    "fit_sub_threshold_means",
    "forecast_rows",
    "load_artifact",
    "model_config",
    "new_artifact_id",
    "outside_calibration_window",
    "read_feature_function_definition",
    "save_artifact",
    "train_fold",
    "wilson_half_width",
]
