"""The matched background, asserted on the sampler.

`docs/specs/diagnosis.md` seam 5, in the form the spec corrected it to. An
earlier draft asserted that ``φ`` for ``subsystem`` and for
``calendar_local_hour`` is numerically zero on every instance; that test could
not be written, because the game is group-first — those two are *members*, the
players are the eight groups, and seam 3 forbids any code path from producing a
member-level ``φ`` to assert on.

So the property is stated where it actually lives: **every background row drawn
for a target shares that target's subsystem and its local hour**. That is
strictly the stronger statement anyway. It catches a leak on the row that
leaked, rather than inferring one from an attribution that came out near zero
for some other reason — and a sampler that leaks across cells makes every
"typical" on the screen wrong while every number still looks plausible.

The tests below assert it three times over, once per place the construction
enforces it: the partition that precedes the draw, the cell that cannot hold a
foreign row, and the lookup that is addressed by the target's own key.
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pytest

from attribution_fixtures import block_of, cell_keys
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.diagnosis.background import (
    BACKGROUND_ROWS_PER_CELL,
    BASE_FIT_SOURCE,
    BackgroundCell,
    BackgroundError,
    CellKey,
    MatchedBackground,
    MissingBackgroundCellError,
    draw_matched_background,
)
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.training import FeatureBlock

FEATURE_NAMES = ("alpha", "beta", "gamma")
DAYS = 40
ROWS_PER_CELL = 16


def _base_fit_block(*, days: int = DAYS, seed: int = 11) -> FeatureBlock:
    """A block spanning every cell — four subsystems, 24 hours, ``days`` days.

    The values carry the row's own cell in them, so a leaked row is visible in
    the matrix and not only in the keys: column 0 is the subsystem's index and
    column 1 is the local hour.
    """
    generator = np.random.default_rng(seed)
    keys: list[RowKey] = []
    rows: list[list[float]] = []
    for offset in range(days):
        target_date = date(2025, 1, 1) + timedelta(days=offset)
        for hour in range(HOURS_PER_DAY):
            for index, subsystem in enumerate(SUBSYSTEM_CODES):
                keys.append(
                    RowKey(
                        target_date=target_date,
                        local_hour=hour,
                        subsystem=subsystem,
                    )
                )
                rows.append([float(index), float(hour), float(generator.normal())])
    return block_of(FEATURE_NAMES, keys, np.asarray(rows, dtype=np.float64))


def test_every_drawn_row_shares_its_targets_subsystem_and_local_hour() -> None:
    """Seam 5 itself. The one property the whole module is shaped around.

    Asserted on both halves of a row: the key it was filed under and the values
    the model would read. A sampler that leaked would fail this on the row that
    leaked.
    """
    background = draw_matched_background(
        _base_fit_block(), seed=99, rows_per_cell=ROWS_PER_CELL
    )
    assert len(background.cells) == len(SUBSYSTEM_CODES) * HOURS_PER_DAY
    for cell_key, cell in background.cells.items():
        for key in cell.keys:
            assert key.subsystem == cell_key.subsystem
            assert key.local_hour == cell_key.local_hour
        subsystem_index = float(SUBSYSTEM_CODES.index(cell_key.subsystem))
        assert np.all(cell.matrix[:, 0] == subsystem_index)
        assert np.all(cell.matrix[:, 1] == float(cell_key.local_hour))


def test_a_cell_cannot_be_constructed_holding_a_row_from_another_cell() -> None:
    """The matching is a property of the type, not a check somebody remembers.

    An unmatched cell does not exist as a value, so nothing downstream has to
    re-check one — which is what makes the enforcement survive an optimisation
    that removes a check.
    """
    keys = cell_keys(2, subsystem="NE", local_hour=14)
    foreign = RowKey(target_date=date(2025, 5, 5), local_hour=3, subsystem="NE")
    with pytest.raises(BackgroundError, match="shares its target's subsystem"):
        BackgroundCell(
            subsystem="NE",
            local_hour=14,
            keys=(keys[0], foreign),
            matrix=np.zeros((2, 3), dtype=np.float64),
        )
    other_subsystem = RowKey(date(2025, 5, 5), 14, "S")
    with pytest.raises(BackgroundError, match="shares its target's subsystem"):
        BackgroundCell(
            subsystem="NE",
            local_hour=14,
            keys=(keys[0], other_subsystem),
            matrix=np.zeros((2, 3), dtype=np.float64),
        )


def test_the_draw_comes_from_the_cells_own_rows_and_nowhere_else() -> None:
    """Partition, then sample. There is no pooled row set to sample from."""
    block = _base_fit_block()
    background = draw_matched_background(block, seed=5, rows_per_cell=ROWS_PER_CELL)
    available: dict[CellKey, set[RowKey]] = {}
    for key in block.keys:
        available.setdefault(CellKey.of(key), set()).add(key)
    for cell_key, cell in background.cells.items():
        assert set(cell.keys) <= available[cell_key]
        assert len(set(cell.keys)) == len(cell.keys), "drawn without replacement"


def test_the_lookup_is_addressed_by_the_targets_own_key() -> None:
    """`cell_for` takes the row, so a call site cannot pair the wrong hour."""
    background = draw_matched_background(
        _base_fit_block(), seed=3, rows_per_cell=ROWS_PER_CELL
    )
    target = RowKey(target_date=date(2026, 7, 7), local_hour=19, subsystem="S")
    cell = background.cell_for(target)
    assert cell.holds(target)
    assert cell.subsystem == "S"
    assert cell.local_hour == 19
    assert cell is background.cell("S", 19)


def test_a_cell_that_was_never_drawn_is_a_failure_and_never_a_fallback() -> None:
    """Falling back to a neighbouring hour would redefine "typical" in silence."""
    block = _base_fit_block()
    kept = [
        index
        for index, key in enumerate(block.keys)
        if not (key.subsystem == "N" and key.local_hour == 5)
    ]
    trimmed = block.select(
        np.asarray(
            [index in set(kept) for index in range(len(block.keys))], dtype=np.bool_
        )
    )
    background = draw_matched_background(trimmed, seed=3, rows_per_cell=ROWS_PER_CELL)
    with pytest.raises(MissingBackgroundCellError):
        background.cell("N", 5)
    with pytest.raises(MissingBackgroundCellError):
        background.cell_for(RowKey(date(2026, 1, 1), 5, "N"))


def test_the_same_seed_draws_the_same_sample_and_a_different_one_does_not() -> None:
    """A stamped seed is what makes the attribution reproducible from the artifact."""
    block = _base_fit_block()
    once = draw_matched_background(block, seed=1234, rows_per_cell=ROWS_PER_CELL)
    again = draw_matched_background(block, seed=1234, rows_per_cell=ROWS_PER_CELL)
    other = draw_matched_background(block, seed=1235, rows_per_cell=ROWS_PER_CELL)
    for cell_key, cell in once.cells.items():
        assert cell.keys == again.cells[cell_key].keys
    assert any(
        cell.keys != other.cells[cell_key].keys for cell_key, cell in once.cells.items()
    )


def test_a_cells_draw_does_not_depend_on_the_order_the_block_arrived_in() -> None:
    """Each cell is seeded from the stamped seed and its own coordinates.

    So a block that arrived in a different row order — the query's order is not
    something this service reproduces — produces the same background.
    """
    block = _base_fit_block()
    order = np.random.default_rng(4).permutation(len(block.keys))
    shuffled = FeatureBlock(
        contract=block.contract,
        keys=tuple(block.keys[index] for index in order),
        matrix=block.matrix[order],
        total_mwh=block.total_mwh[order],
        wind_mwh=block.wind_mwh[order],
        has_curtailment=block.has_curtailment[order],
        threshold_mw=block.threshold_mw,
    )
    straight = draw_matched_background(block, seed=8, rows_per_cell=ROWS_PER_CELL)
    mixed = draw_matched_background(shuffled, seed=8, rows_per_cell=ROWS_PER_CELL)
    for cell_key, cell in straight.cells.items():
        assert set(cell.keys) == set(mixed.cells[cell_key].keys)


def test_a_cell_with_fewer_rows_than_the_sample_is_refused() -> None:
    """A short cell is a thinner "typical" than every other hour's."""
    block = _base_fit_block(days=4)
    with pytest.raises(BackgroundError, match="rows in the block and the sample"):
        draw_matched_background(block, seed=2, rows_per_cell=ROWS_PER_CELL)


def test_the_background_refuses_cells_of_uneven_size() -> None:
    """Uneven cells weight some hours' typical more than others."""
    wide = BackgroundCell(
        subsystem="NE",
        local_hour=14,
        keys=cell_keys(4),
        matrix=np.zeros((4, 3), dtype=np.float64),
    )
    narrow = BackgroundCell(
        subsystem="NE",
        local_hour=15,
        keys=cell_keys(2, local_hour=15),
        matrix=np.zeros((2, 3), dtype=np.float64),
    )
    with pytest.raises(BackgroundError, match="uneven background"):
        MatchedBackground(
            feature_names=FEATURE_NAMES,
            rows_per_cell=4,
            seed=1,
            source=BASE_FIT_SOURCE,
            cells={wide.cell_key: wide, narrow.cell_key: narrow},
        )


def test_the_sample_size_the_spec_names_is_the_default() -> None:
    """128 rows per cell, 96 cells — the shape the artifact bundle ships."""
    assert BACKGROUND_ROWS_PER_CELL == 128
    assert BACKGROUND_ROWS_PER_CELL * len(SUBSYSTEM_CODES) * HOURS_PER_DAY == 12_288


def test_the_sample_carries_its_own_provenance() -> None:
    """The seed and the source travel with the sample, onto the card."""
    background = draw_matched_background(
        _base_fit_block(), seed=42, rows_per_cell=ROWS_PER_CELL
    )
    assert background.card_fields() == {
        "background_rows_per_cell": str(ROWS_PER_CELL),
        "background_seed": "42",
        "background_source": BASE_FIT_SOURCE,
        "background_cells": str(len(SUBSYSTEM_CODES) * HOURS_PER_DAY),
    }
