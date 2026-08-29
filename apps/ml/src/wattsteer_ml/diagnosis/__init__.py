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

The second sentence orders the aggregation: **the day is summed from the hours,
and nothing else is.** `day_attribution` adds no game and solves none — it sums
24 hourly attributions exactly, because expectations add and quantiles do not,
and it publishes what that sum hides.
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
    HourResample,
    LocalAccuracyError,
    attribute_hour,
    group_columns,
    resample_hour,
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
from wattsteer_ml.diagnosis.day_attribution import (
    ATTRIBUTION_TARGET_DAY,
    BOTH_DIRECTIONS_THRESHOLD,
    DISAGREEMENT_EPSILON,
    NOTABLE_ROW_CAP,
    NOTABLE_SHARE_FLOOR,
    STDERR_RESAMPLES,
    DayAttribution,
    DayAttributionError,
    DayGroupContribution,
    IncompleteDayError,
    attribute_day,
    day_rows,
)
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
    "ATTRIBUTION_TARGET_DAY",
    "ATTRIBUTION_TARGET_HOUR",
    "BACKGROUND_ROWS_PER_CELL",
    "BASE_FIT_SOURCE",
    "BOTH_DIRECTIONS_THRESHOLD",
    "DISAGREEMENT_EPSILON",
    "DRIVER_GROUP_CODES",
    "DRIVER_GROUP_MAP",
    "EXPLAINS_CODE",
    "LOCAL_ACCURACY_TOLERANCE",
    "NOTABLE_ROW_CAP",
    "NOTABLE_SHARE_FLOOR",
    "STDERR_RESAMPLES",
    "AttributionError",
    "BackgroundCell",
    "BackgroundError",
    "CellKey",
    "ComposedExpectation",
    "DayAttribution",
    "DayAttributionError",
    "DayGroupContribution",
    "Direction",
    "DriverGroup",
    "DriverGroupMap",
    "DriverGroupMapError",
    "EmptyPlayerError",
    "GroupCode",
    "GroupContribution",
    "HourAttribution",
    "HourResample",
    "IdeaDriver",
    "IncompleteDayError",
    "LocalAccuracyError",
    "MatchedBackground",
    "MissingBackgroundCellError",
    "UngroupedFeatureError",
    "UnitCode",
    "assert_total_partition",
    "attribute_day",
    "attribute_hour",
    "bundle_expectation",
    "day_rows",
    "draw_matched_background",
    "group_columns",
    "load_driver_group_map",
    "load_ordered_features",
    "resample_hour",
]
