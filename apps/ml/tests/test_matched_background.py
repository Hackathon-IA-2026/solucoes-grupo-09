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

import ast
from datetime import date, timedelta
from pathlib import Path

import joblib
import numpy as np
import pytest

from attribution_fixtures import block_of, cell_keys
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.diagnosis.publish import background_seed
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.training import FeatureBlock
from wattsteer_ml.training.background import (
    ARTIFACT_SOURCE,
    BACKGROUND_ROWS_PER_CELL,
    BACKGROUND_SEED,
    BASE_FIT_SOURCE,
    BackgroundCell,
    BackgroundError,
    CellKey,
    MatchedBackground,
    MissingBackgroundCellError,
    draw_artifact_background,
    draw_matched_background,
)

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


# --- forecaster 30: the sample the artifact carries ---------------------------


def test_the_same_seed_and_the_same_block_reproduce_the_same_sample() -> None:
    """Determinism, asserted on the bytes and not on a summary.

    This is the property that makes freezing the sample worth doing: an auditor
    holding the artifact's seed and the base-fit block can redraw ``B(s, h)``
    and get *this* sample back. Compared cell by cell on ``tobytes()`` — a
    float64 matrix compared with a tolerance would pass for a sample that is
    merely close, which is not what reproducible means — and the different-seed
    case is asserted beside it, so a comparison that cannot fail is not
    mistaken for one that did not.
    """
    block = _base_fit_block()
    once = draw_artifact_background(block, seed=7, rows_per_cell=ROWS_PER_CELL)
    again = draw_artifact_background(block, seed=7, rows_per_cell=ROWS_PER_CELL)
    other = draw_artifact_background(block, seed=8, rows_per_cell=ROWS_PER_CELL)

    assert once.cells.keys() == again.cells.keys()
    assert len(once.cells) == len(SUBSYSTEM_CODES) * HOURS_PER_DAY
    for cell_key, cell in once.cells.items():
        assert cell.keys == again.cells[cell_key].keys
        assert cell.matrix.tobytes() == again.cells[cell_key].matrix.tobytes()
    # Not vacuous: a different seed draws different rows in at least one cell.
    assert any(
        cell.keys != other.cells[cell_key].keys for cell_key, cell in once.cells.items()
    )


def test_the_artifact_draw_and_the_publish_draw_differ_only_by_the_label() -> None:
    """One sampler, two labels — so the label is a provenance and not a method.

    ``background_source`` distinguishes *where the sample is stored*, not how it
    was drawn: the training run draws from the base-fit block and so does the
    publish-time fallback. Asserting the two are bit-identical at one seed is
    what keeps that claim honest, and it is also what lets a reader verify a
    stored ``artifact`` sample against a redraw of the same window.
    """
    block = _base_fit_block()
    frozen = draw_artifact_background(block, seed=3, rows_per_cell=ROWS_PER_CELL)
    redrawn = draw_matched_background(block, seed=3, rows_per_cell=ROWS_PER_CELL)

    assert frozen.source == ARTIFACT_SOURCE
    assert redrawn.source == BASE_FIT_SOURCE
    assert frozen.seed == redrawn.seed == 3
    for cell_key, cell in frozen.cells.items():
        assert cell.keys == redrawn.cells[cell_key].keys
        assert cell.matrix.tobytes() == redrawn.cells[cell_key].matrix.tobytes()


def test_the_stamped_seed_is_the_default_and_is_not_an_artifact_ids_hash() -> None:
    """``BACKGROUND_SEED`` is stamped, not reconstructed.

    Forecaster 30's fourth argument: the publish-time fallback *derives* a seed
    from the ``artifact_id`` in order to have the property a stamped seed simply
    has. The frozen sample has the property.
    """
    block = _base_fit_block()
    drawn = draw_artifact_background(block, rows_per_cell=ROWS_PER_CELL)
    assert drawn.seed == BACKGROUND_SEED
    assert background_seed("2026-08-29T04:00:00Z") != BACKGROUND_SEED


def test_the_samples_size_is_measured_off_the_arrays_it_will_pickle() -> None:
    """The card's number is a measurement, and the arithmetic is its check.

    ``matrix_bytes`` sums ``nbytes`` over the cells that are about to be written
    into the joblib. The product below is what an estimate *would* say; they
    agree here, and the point of measuring is that the measurement is still
    right when they stop agreeing — a widened contract moves ``k``.
    """
    block = _base_fit_block()
    background = draw_artifact_background(block, seed=5, rows_per_cell=ROWS_PER_CELL)
    cells = len(SUBSYSTEM_CODES) * HOURS_PER_DAY
    assert background.matrix_bytes == cells * ROWS_PER_CELL * len(FEATURE_NAMES) * 8
    assert background.matrix_bytes == sum(
        cell.matrix.nbytes for cell in background.cells.values()
    )


def test_a_sample_survives_the_joblib_with_its_cells_still_sealed(
    tmp_path: Path,
) -> None:
    """``joblib.dump`` cannot pickle a ``mappingproxy``, and the type keeps one.

    So the round trip is asserted rather than assumed, through ``joblib``
    because that is the file the bundle is: the sample has to come back with
    the same rows *and* with the mapping still unwritable, because the seal is
    what stops a consumer adding a cell to a background after it was drawn.
    """
    background = draw_artifact_background(
        _base_fit_block(), seed=9, rows_per_cell=ROWS_PER_CELL
    )
    path = tmp_path / "background.joblib"
    joblib.dump(background, path)
    restored = joblib.load(path)

    assert restored.source == ARTIFACT_SOURCE
    assert restored.seed == 9
    assert restored.cells.keys() == background.cells.keys()
    for cell_key, cell in background.cells.items():
        assert cell.matrix.tobytes() == restored.cells[cell_key].matrix.tobytes()
    with pytest.raises(TypeError):
        restored.cells[CellKey(subsystem="NE", local_hour=0)] = next(
            iter(background.cells.values())
        )


# --- and nothing else in the package may claim to be the artifact's sample ----

#: The source tree the AST walk below reads. Production modules only.
PACKAGE = Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml"

#: Every module allowed to name ``ARTIFACT_SOURCE`` or the function that stamps
#: it: the definition, the one caller, and the package's re-export.
ARTIFACT_SAMPLE_PRODUCERS = frozenset(
    {
        "training/background.py",
        "training/hurdle.py",
        "training/__init__.py",
    }
)


def test_no_path_in_the_package_can_stamp_a_live_read_as_the_artifacts_sample() -> None:
    """The valve, asserted structurally — an AST walk over production source.

    ``ARTIFACT_SOURCE`` means "this sample is in the joblib and a reader can
    reproduce it from the artifact alone". A publish path that stamped it onto a
    sample it had just drawn from the database would make that claim false on
    rows nobody can check: an attribution has no ground truth, so eight
    plausible bars would render and nothing on the screen, in the table or in
    the payload would say the comparison was against a window that has since
    moved.

    So the stamp is not a keyword argument on the sampler. It comes from
    :func:`draw_artifact_background` and from nowhere else, and this test says
    which modules may name either. Same move as `docs/specs/diagnosis.md` seam
    3's grep against member-level ``φ``.
    """
    forbidden = {"ARTIFACT_SOURCE", "draw_artifact_background"}
    modules = sorted(PACKAGE.rglob("*.py"))
    assert len(modules) > 50, "the walk found no package to check"

    offenders: dict[str, set[str]] = {}
    producers_seen: set[str] = set()
    constructors: set[str] = set()
    for module in modules:
        relative = module.relative_to(PACKAGE).as_posix()
        named: set[str] = set()
        for node in ast.walk(ast.parse(module.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Name) and node.id in forbidden:
                named.add(node.id)
            elif isinstance(node, ast.Attribute) and node.attr in forbidden:
                named.add(node.attr)
            elif isinstance(node, ast.ImportFrom):
                named |= {alias.name for alias in node.names if alias.name in forbidden}
            elif (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "MatchedBackground"
            ):
                constructors.add(relative)
        if not named:
            continue
        if relative in ARTIFACT_SAMPLE_PRODUCERS:
            producers_seen.add(relative)
        else:
            offenders[relative] = named

    assert not offenders, (
        f"{sorted(offenders)} name the artifact's own sample source; a sample "
        "drawn from a live read and stamped `artifact` is a reproducibility "
        "claim nothing downstream can check"
    )
    # Not vacuous: the modules that are *supposed* to name it were all found, so
    # a rename that made the walk match nothing fails here.
    assert producers_seen == ARTIFACT_SAMPLE_PRODUCERS
    # And the constructor is only reached where the sampler lives, so `source=`
    # cannot be spelled with a literal somewhere else instead.
    assert constructors == {"training/background.py"}


def test_the_publish_module_does_not_name_the_artifacts_sample_source() -> None:
    """The same statement about the one module that would be tempted.

    Stated separately from the walk above because this is the module with a live
    read in it, and a future edit that added a production module to
    ``ARTIFACT_SAMPLE_PRODUCERS`` to make the walk pass would still have to
    delete this test by name.
    """
    source = (PACKAGE / "diagnosis" / "publish.py").read_text(encoding="utf-8")
    assert "draw_matched_background" in source
    assert "ARTIFACT_SOURCE" not in source
    assert "draw_artifact_background" not in source
