"""The design matrix: a NULL stays a NULL, and the threshold comes off the row.

The two rules `docs/specs/forecaster.md` states about the served path — "no
imputation is performed at any point" and a magnitude that travels with the
threshold that produced it — are properties of this encoding, so they are
asserted here rather than assumed downstream.
"""

from __future__ import annotations

import inspect
import math
from datetime import date

import numpy as np
import pytest

from conftest import FUNCTION_DEFINITION
from feature_row_fixtures import THRESHOLD_MW, feature_rows
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.training import design as design_module
from wattsteer_ml.training.contract import FeatureContract
from wattsteer_ml.training.design import DesignError, FeatureBlock, RowStamp

ROWS = feature_rows(first=date(2025, 1, 1), last=date(2025, 1, 3))
CONTRACT = FeatureContract.of(ROWS, function_definition=FUNCTION_DEFINITION)


def block_of(rows: list[dict[str, object]]) -> FeatureBlock:
    return FeatureBlock.of(rows, CONTRACT, threshold_mw=THRESHOLD_MW)


def test_a_null_feature_is_nan_and_stays_nan() -> None:
    """The one signal the gate encodes, preserved.

    "A lag that does not clear `actuals_cutoff` is NULL precisely because it was
    not knowable." A median fill would replace that with a plausible number and
    nothing downstream could tell the difference again.
    """
    column = CONTRACT.feature_names.index("weather_temperature_2m")
    rows = [dict(ROWS[0], weather_temperature_2m=None), ROWS[1]]
    matrix = block_of(rows).matrix
    assert math.isnan(matrix[0, column])
    assert not math.isnan(matrix[1, column]) or ROWS[1]["weather_temperature_2m"] is None


def test_no_fill_value_exists_in_the_module() -> None:
    """Asserted against the source, because a convention decays one call at a time.

    The mirror of `test_features.py`'s boundary check: the rule is not "we did
    not impute today", it is "there is nowhere here that could".
    """
    source = inspect.getsource(design_module)
    for forbidden in ("fillna", "nan_to_num", "SimpleImputer", "np.nanmean("):
        assert forbidden not in source


def test_the_positive_mask_is_the_databases_own_decision() -> None:
    """`y_has_curtailment`, read — never `total > τ` recomputed on this side.

    A second place the threshold is applied is a second threshold, and
    `docs/domain-model.md` §8.3 is precise that a magnitude and its threshold
    travel together.
    """
    block = block_of(ROWS)
    from_column = np.array(
        [row["y_has_curtailment"] is True for row in ROWS], dtype=np.bool_
    )
    assert np.array_equal(block.positive, from_column)
    source = inspect.getsource(design_module)
    assert "> threshold" not in source and "> self.threshold_mw" not in source


def test_an_unlabelled_row_is_not_a_zero() -> None:
    """The label block returned nothing, which is not the same as "no curtailment"."""
    rows = [dict(ROWS[0], y_constrained_off_total_mwh=None, y_has_curtailment=None)]
    block = block_of(rows)
    assert math.isnan(block.total_mwh[0])
    assert not block.labelled[0]
    assert not block.positive[0]


def test_the_subsystem_is_encoded_by_its_level_and_nothing_else() -> None:
    block = block_of(ROWS)
    column = block.matrix[:, CONTRACT.feature_names.index("subsystem")]
    assert sorted(set(column.tolist())) == [
        float(index) for index in range(len(SUBSYSTEM_CODES))
    ]


def test_an_unknown_level_is_an_error_not_a_new_category() -> None:
    """`SIN` is not a subsystem, and a fifth code would silently re-encode the four."""
    with pytest.raises(DesignError):
        block_of([dict(ROWS[0], subsystem="SIN")])


def test_selecting_carries_the_contract_and_the_keys() -> None:
    block = block_of(ROWS)
    positives = block.select(block.positive)
    assert len(positives) == int(block.positive.sum())
    assert positives.contract is block.contract
    assert len(positives.keys) == positives.matrix.shape[0]


def test_rows_from_two_lanes_cannot_be_stamped_as_one() -> None:
    """Two lanes' rows in one list would train a model whose card names one."""
    with pytest.raises(DesignError):
        RowStamp.of([ROWS[0], dict(ROWS[1], threshold_mw=10.0)])


def test_the_stamp_reads_the_threshold_off_the_rows() -> None:
    """Never from `constants`: the threshold sweep retrains whole lanes at others."""
    stamp = RowStamp.of(ROWS)
    assert stamp.threshold_mw == THRESHOLD_MW
    assert stamp.lane.threshold_mw == THRESHOLD_MW
    assert stamp.lane.gate_profile == "gate_late"
    source = inspect.getsource(design_module)
    assert "SUBSYSTEM_THRESHOLD_MW" not in source


def test_a_row_the_contract_has_never_seen_is_refused() -> None:
    trimmed = [{k: v for k, v in ROWS[0].items() if k != "solar_zenith_cos"}]
    with pytest.raises(Exception, match="contract"):
        block_of(trimmed)
