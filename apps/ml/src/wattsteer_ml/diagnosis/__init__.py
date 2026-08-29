"""Diagnosis — why the forecaster said what it said.

`docs/specs/diagnosis.md` is the spec. The vocabulary the Explain screen ranks
lives here: eight driver groups, as data, hashed onto the model card; the
matched background that gives "typical" a definition; the exact cooperative game
over those eight players; and the attribution of one hour's composed expected
`constrained_off_mwh` to them.

The one sentence that orders the modules: **composition happens before
attribution, never after**. `composed_target` evaluates the forecaster's own
composition, `attribution` attributes that one scalar, and `shapley` is a game
over players that has never heard of a feature.
"""

from wattsteer_ml.diagnosis.attribution import (
    ATTRIBUTION_TARGET_HOUR,
    EXPLAINS_CODE,
    LOCAL_ACCURACY_TOLERANCE,
    AttributionError,
    ComposedExpectation,
    Direction,
    EmptyPlayerError,
    GroupContribution,
    HourAttribution,
    LocalAccuracyError,
    attribute_hour,
    group_columns,
)
from wattsteer_ml.diagnosis.background import (
    ARTIFACT_SOURCE,
    BACKGROUND_ROWS_PER_CELL,
    BASE_FIT_SOURCE,
    BackgroundCell,
    BackgroundError,
    CellKey,
    MatchedBackground,
    MissingBackgroundCellError,
    draw_matched_background,
)
from wattsteer_ml.diagnosis.composed_target import bundle_expectation
from wattsteer_ml.diagnosis.driver_groups import (
    DRIVER_GROUP_CODES,
    DRIVER_GROUP_MAP,
    DriverGroup,
    DriverGroupMap,
    DriverGroupMapError,
    GroupCode,
    IdeaDriver,
    UngroupedFeatureError,
    UnitCode,
    assert_total_partition,
    load_driver_group_map,
    load_ordered_features,
)

__all__ = [
    "ARTIFACT_SOURCE",
    "ATTRIBUTION_TARGET_HOUR",
    "BACKGROUND_ROWS_PER_CELL",
    "BASE_FIT_SOURCE",
    "DRIVER_GROUP_CODES",
    "DRIVER_GROUP_MAP",
    "EXPLAINS_CODE",
    "LOCAL_ACCURACY_TOLERANCE",
    "AttributionError",
    "BackgroundCell",
    "BackgroundError",
    "CellKey",
    "ComposedExpectation",
    "Direction",
    "DriverGroup",
    "DriverGroupMap",
    "DriverGroupMapError",
    "EmptyPlayerError",
    "GroupCode",
    "GroupContribution",
    "HourAttribution",
    "IdeaDriver",
    "LocalAccuracyError",
    "MatchedBackground",
    "MissingBackgroundCellError",
    "UngroupedFeatureError",
    "UnitCode",
    "assert_total_partition",
    "attribute_hour",
    "bundle_expectation",
    "draw_matched_background",
    "group_columns",
    "load_driver_group_map",
    "load_ordered_features",
]
