"""Diagnosis — why the forecaster said what it said.

`docs/specs/diagnosis.md` is the spec. The vocabulary the Explain screen ranks
lives here: eight driver groups, as data, hashed onto the model card.
"""

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
    "DRIVER_GROUP_CODES",
    "DRIVER_GROUP_MAP",
    "DriverGroup",
    "DriverGroupMap",
    "DriverGroupMapError",
    "GroupCode",
    "IdeaDriver",
    "UngroupedFeatureError",
    "UnitCode",
    "assert_total_partition",
    "load_driver_group_map",
    "load_ordered_features",
]
