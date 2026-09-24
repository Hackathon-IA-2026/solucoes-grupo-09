"""Recency weighting, as arithmetic — no booster, no database.

`training/hyperparameters.py`'s ``recency_half_life_days`` and
`training/hurdle.py::_recency_weights` are the whole of the change: a training
row's weight is exponential in its age against its own block's most recent
date, mean-normalised, and ``None`` — not a weight of 1.0 everywhere — when a
configuration does not ask for it, because an unweighted `lgb.Dataset` and a
weighted one at all-ones are not guaranteed to fit identically.

**No published configuration asks for it.** v2 carried a 180-day half-life
until the gate_early F6 ablation measured it refusing the lane on
`p50_unbiasedness_in_band`; the mechanism is kept and tested here against an
explicit `WEIGHTED` configuration, so a future half-life has a property to be
held to rather than a function nobody exercises.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import cast

import numpy as np
import pytest

from wattsteer_ml.evaluation.matrix import RowKey
from wattsteer_ml.training.design import FeatureBlock
from wattsteer_ml.training.hurdle import _recency_weights
from wattsteer_ml.training.hyperparameters import (
    MODEL_CONFIG_V1,
    MODEL_CONFIG_V2,
    ModelConfig,
)

#: A configuration that *does* weight, since no published one does any more.
WEIGHTED = ModelConfig(
    version="test_weighted",
    num_boost_round=1,
    learning_rate=0.1,
    num_leaves=3,
    min_data_in_leaf=1,
    feature_fraction=1.0,
    bagging_fraction=1.0,
    bagging_freq=1,
    early_stopping_rounds=0,
    seed=1,
    recency_half_life_days=180,
)


@dataclass(frozen=True)
class _FakeBlock:
    """Everything `_recency_weights` reads off a `FeatureBlock`, and nothing else.

    Stands in for one rather than building a real matrix and contract: the
    function reads only ``.keys`` and ``len()``, and a fixture that builds the
    rest just to satisfy the type checker would test that scaffolding instead
    of the arithmetic. Cast to :class:`FeatureBlock` at the call site, not
    here — the cast is the test's business, not the fixture's.
    """

    keys: tuple[RowKey, ...]

    def __len__(self) -> int:
        return len(self.keys)


def _block(ages_days: list[int]) -> FeatureBlock:
    """One row per age in ``ages_days``, counting back from a fixed "today"."""
    today = date(2026, 9, 1)
    fake = _FakeBlock(
        keys=tuple(
            RowKey(target_date=today - timedelta(days=age), local_hour=0, subsystem="NE")
            for age in ages_days
        )
    )
    return cast(FeatureBlock, fake)


def test_no_published_configuration_takes_a_weight() -> None:
    """``None`` is the signal, not an array of ones — see the module's own note.

    Both published configurations fit unweighted. v2's 180-day half-life was
    removed after the ablation, and this is the assertion that would fail if it
    came back without the fold evidence that would justify it.
    """
    for config in (MODEL_CONFIG_V1, MODEL_CONFIG_V2):
        assert _recency_weights(config, _block([0, 30, 90, 365])) is None


def test_an_empty_block_takes_no_weight() -> None:
    assert _recency_weights(WEIGHTED, _block([])) is None


def test_the_most_recent_row_is_never_downweighted_relative_to_itself() -> None:
    """Age is read off this block's own last date, not a date passed in."""
    weights = _recency_weights(WEIGHTED, _block([0, 180, 360]))
    assert weights is not None
    # Row 0 is the block's most recent date, so it is the largest of the three.
    assert weights[0] == max(weights)


def test_weight_halves_every_half_life() -> None:
    config = ModelConfig(
        version="test",
        num_boost_round=1,
        learning_rate=0.1,
        num_leaves=3,
        min_data_in_leaf=1,
        feature_fraction=1.0,
        bagging_fraction=1.0,
        bagging_freq=1,
        early_stopping_rounds=0,
        seed=1,
        recency_half_life_days=100,
    )
    weights = _recency_weights(config, _block([0, 100, 200]))
    assert weights is not None
    # Before normalisation the ratios are exactly 1 : 0.5 : 0.25; normalising
    # by the mean preserves every ratio between rows.
    assert weights[0] / weights[1] == pytest.approx(2.0)
    assert weights[1] / weights[2] == pytest.approx(2.0)


def test_the_weights_are_mean_normalised() -> None:
    weights = _recency_weights(WEIGHTED, _block([0, 45, 90, 180, 365]))
    assert weights is not None
    assert float(np.mean(weights)) == pytest.approx(1.0)


def test_a_single_row_block_normalises_to_one() -> None:
    weights = _recency_weights(WEIGHTED, _block([0]))
    assert weights is not None
    assert weights[0] == pytest.approx(1.0)
