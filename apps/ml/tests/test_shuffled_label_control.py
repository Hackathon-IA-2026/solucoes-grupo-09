"""Permute the labels, run the whole pipeline, and watch the skill disappear.

`docs/specs/forecaster.md` seam 6, and the spec's own load-bearing artifact:
*the property that a pipeline trained on permuted labels must score at chance is
what makes every other number in the model card believable.*
:mod:`wattsteer_ml.evaluation.shuffled_label` is the control; this file is the
control run, and the evidence that it can fail.

**Four of these tests are the detector detecting**, because a control that
cannot produce an embarrassing number is not a control:

- :func:`test_the_honest_run_does_not_pass_the_control` points the same judge at
  the *unpermuted* run and asserts it is refused. If this ever passes, the
  fixture has stopped carrying signal and every green tick below is vacuous.
- :func:`test_a_label_leaked_into_a_feature_column_fails_the_control` stages the
  leak seam 6 exists for — a label-derived column left in the feature table,
  which is what "a feature computed after the gate" looks like from here — and
  asserts both metrics fire.
- :func:`test_a_permutation_that_respects_the_cell_is_not_this_control` stages a
  *weak permutation*, which is the way this control most plausibly rots: confine
  the shuffle to ``(subsystem, local_hour)`` — the rule the diagnosis layer's
  shuffled-feature control is obliged to follow — and the fixture's whole signal
  survives it. The control fails it, and the measured numbers are recorded so
  the inversion between the two layers is a reading rather than an argument.
- :func:`test_the_failure_names_the_fold_the_rung_and_the_metric` reads the
  message, because "a leak is localised rather than merely announced" is a
  property of the string.

**What the fixture can and cannot say.** The rows are
`feature_row_fixtures.py` plus `ladder_fixtures.py` and nothing here is a claim
about the Brazilian grid. But seam 6 needs one thing from its lane that most
tests in this suite do not: **the honest run has to have skill**, or the
shuffled run scoring at chance proves nothing at all. This lane has it — PR-AUC
0.298 against a prevalence of 0.116, because the fixture's label is a function
of subsystem and hour and both are in the contract — and
:func:`test_the_honest_run_does_not_pass_the_control` is what keeps that true.
That test exists because of the lesson recorded at the top of
`test_shuffled_feature_control.py`: its first draft passed on one seed and
failed on four, on a fixture whose signal had been conditioned away, and nobody
noticed until the second seed ran.

**Cost.** One shuffled ladder run over the shared fold is about a second, so the
whole default gate here is a handful of seconds on a reduced fold set — F1, the
conftest fold, seven test days. The full calendar — six folds over two and a
half years of rows — is
:func:`test_the_control_holds_on_every_fold_of_the_calendar`, behind the
existing ``WATTSTEER_SCALE_TESTS`` gating that `bun run ml:test:scale` sets.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any

import numpy as np
import pytest

from conftest import FIXTURE_BACKGROUND_ROWS_PER_CELL, FUNCTION_DEFINITION
from ladder_fixtures import rows_with_same_hour_features
from wattsteer_ml.evaluation import (
    Fold,
    FoldBlocks,
    FoldSegment,
    materialize_fold_calendar,
    stamp_fidelity,
)
from wattsteer_ml.evaluation.ladder import ForestRung, Rung, default_ladder, run_ladder
from wattsteer_ml.evaluation.shuffled_label import (
    LABEL_COLUMNS,
    QLOSS_FLOOR,
    SERVED_RUNG,
    TOTAL_COLUMN,
    ChanceError,
    ShuffledLabelControl,
    ShuffledLabelError,
    chance_interval,
    chance_readings,
    permute_labels_within_fold,
    run_shuffled_label_control,
)
from wattsteer_ml.training import OutOfFoldPool

#: A forest small enough to fit in a test suite, as `test_baseline_ladder.py`
#: uses it. It shrinks a rung the control records and does not judge; nothing
#: about the served rung's path changes.
TEST_FOREST = ForestRung(trees=25, min_samples_leaf=25)

#: The permutation seeds the default gate runs. Three, and not one, for the
#: reason `test_shuffled_feature_control.py` records at the top of its file: a
#: control that holds under one shuffle nobody checked a second of is a
#: coincidence with a green tick on it. They are 1, 2, 3 rather than a
#: hand-picked set — a seed chosen because it passed would be the test shaped to
#: avoid its own answer.
PERMUTATION_SEEDS = (1, 2, 3)

#: Where the staged leak is planted. A column that does not exist in the
#: migration tree, so nothing else in the suite reads it; the contract is
#: derived from the base-fit rows, so adding it puts a label-derived feature in
#: front of every fitted rung — the shape of a feature computed after the gate.
LEAKED_COLUMN = "dessem_curtailment_forecast_mwh"


@pytest.fixture(scope="module")
def ladder_rows(blocks: FoldBlocks) -> list[dict[str, Any]]:
    """The shared fold's rows, carrying rung 1's two columns."""
    return rows_with_same_hour_features(first=blocks.base_fit_start, last=blocks.test_end)


@pytest.fixture(scope="module")
def segments(fold: Fold) -> tuple[FoldSegment, ...]:
    """One segment: the fold sits entirely after this fixture's go-live."""
    return stamp_fidelity(fold, None)


@pytest.fixture(scope="module")
def rungs(pool: OutOfFoldPool) -> tuple[Rung, ...]:
    """The five published rungs, with the forest shrunk for the suite's sake."""
    published = default_ladder(
        function_definition=FUNCTION_DEFINITION,
        pool=pool,
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
    )
    return tuple(TEST_FOREST if rung.number == 3 else rung for rung in published)


def _control(
    rows: Sequence[Mapping[str, Any]],
    *,
    fold: Fold,
    blocks: FoldBlocks,
    segments: Sequence[FoldSegment],
    rungs: Sequence[Rung],
    permutation_seed: int,
) -> ShuffledLabelControl:
    return run_shuffled_label_control(
        rows,
        fold=fold,
        blocks=blocks,
        segments=segments,
        rungs=rungs,
        function_definition=FUNCTION_DEFINITION,
        permutation_seed=permutation_seed,
    )


def _record(record_property: Any, control: ShuffledLabelControl) -> None:
    """Leave every number behind, whichever way the verdict went."""
    recorded = control.recorded()
    record_property("shuffled_label_permutation_seed", recorded["permutation_seed"])
    record_property("shuffled_label_holds", recorded["holds"])
    for reading in recorded["readings"]:
        for name, value in reading.items():
            if name != "rung":
                record_property(f"shuffled_label_{reading['rung']}_{name}", value)


# --- seam 6 itself -----------------------------------------------------------


@pytest.mark.parametrize("permutation_seed", PERMUTATION_SEEDS)
def test_the_pipeline_scores_at_chance_on_permuted_labels(
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    segments: tuple[FoldSegment, ...],
    rungs: tuple[Rung, ...],
    permutation_seed: int,
    record_property: Any,
) -> None:
    """Seam 6. The whole ladder, on labels permuted within the fold's date range.

    Three seeds, and the assertion is the control's own — so the failure a
    future leak produces is the one this module was written to write, naming the
    fold, the rung and the metric.
    """
    control = _control(
        ladder_rows,
        fold=fold,
        blocks=blocks,
        segments=segments,
        rungs=rungs,
        permutation_seed=permutation_seed,
    )
    _record(record_property, control)

    control.assert_at_chance()
    assert control.holds
    served = control.reading(rung=SERVED_RUNG)
    assert served.pr_auc is not None
    assert served.pr_auc_chance is not None
    assert served.pr_auc <= served.pr_auc_chance[1]
    assert served.qloss_ratio >= QLOSS_FLOOR


def test_the_control_ran_the_calibrated_and_conformalised_path(
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    segments: tuple[FoldSegment, ...],
    rungs: tuple[Rung, ...],
) -> None:
    """The ticket's first box, as an assertion rather than a claim about a call site.

    The row the control judged is the one the metrics table published, and that
    row says whether ``p`` reached the composition through an isotonic map and
    ``Q_pos`` through ``δ_lo``/``δ_hi``. A future "faster" control that swapped
    rung 4 for something cheaper would fail here rather than pass quietly.
    """
    control = _control(
        ladder_rows,
        fold=fold,
        blocks=blocks,
        segments=segments,
        rungs=rungs,
        permutation_seed=PERMUTATION_SEEDS[0],
    )
    served = control.reading(rung=SERVED_RUNG)
    assert served.calibrated
    assert served.conformalised
    # Every rung of the ladder was run and recorded, not just the judged one.
    assert {one.rung for one in control.readings} == {rung.name for rung in rungs}


def test_the_prevalence_rung_scores_exactly_at_chance(
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    segments: tuple[FoldSegment, ...],
    rungs: tuple[Rung, ...],
) -> None:
    """Rung 0 predicts one number for every hour, so its PR-AUC *is* prevalence.

    Not a tautology worth skipping: it is the one reading in the table whose
    value is known in closed form, so it is where a broken
    :func:`~wattsteer_ml.evaluation.metrics.pr_auc` — a tie handled as an
    ordering, say — would show up as an excess that no model produced.
    """
    control = _control(
        ladder_rows,
        fold=fold,
        blocks=blocks,
        segments=segments,
        rungs=rungs,
        permutation_seed=PERMUTATION_SEEDS[0],
    )
    baseline = control.reading(rung="prevalence")
    assert baseline.pr_auc == pytest.approx(baseline.prevalence)
    assert baseline.qloss_ratio == pytest.approx(1.0)
    assert not baseline.off_chance()


# --- the detector detecting --------------------------------------------------


def test_the_honest_run_does_not_pass_the_control(
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    segments: tuple[FoldSegment, ...],
    rungs: tuple[Rung, ...],
    record_property: Any,
) -> None:
    """The same judge, pointed at the run whose labels were never touched.

    **This is the test that keeps every other one in this file honest.** A
    fixture whose label the pipeline cannot learn would give a shuffled run at
    chance and an honest run at chance, and seam 6 would be a green tick over
    nothing — which is exactly the trap
    `test_shuffled_feature_control.py` fell into and recorded. So the honest
    run's excess over the chance interval is asserted, and recorded, here.
    """
    table = run_ladder(
        ladder_rows,
        fold=fold,
        blocks=blocks,
        segments=segments,
        run="honest",
        rungs=rungs,
        function_definition=FUNCTION_DEFINITION,
        day_grain=False,
    )
    honest = ShuffledLabelControl(
        permutation_seed=0, chance_seed=1, readings=chance_readings(table, seed=1)
    )
    _record(record_property, honest)

    served = honest.reading(rung=SERVED_RUNG)
    assert served.pr_auc is not None
    assert served.pr_auc_chance is not None
    assert served.pr_auc > served.pr_auc_chance[1]
    assert served.off_chance() == ("pr_auc",)
    assert not honest.holds
    with pytest.raises(ChanceError):
        honest.assert_at_chance()


def _leaked(
    rows: Sequence[Mapping[str, Any]],
    *,
    fold: Fold,
    blocks: FoldBlocks,
    segments: Sequence[FoldSegment],
    rungs: Sequence[Rung],
    permutation_seed: int,
) -> ShuffledLabelControl:
    """The control, run on a fold whose feature table holds the answer.

    The leaked column is computed **after** the permutation, from whatever label
    the row now carries, which is what makes it a leak rather than a stale
    column: a feature computed after the gate reads the label the row *has*. A
    copy taken before the shuffle would follow the old label, the permutation
    would break the association exactly as it is supposed to, and the staged
    leak would stage nothing.
    """
    permuted = permute_labels_within_fold(rows, seed=permutation_seed)
    table = run_ladder(
        [{**row, LEAKED_COLUMN: row[TOTAL_COLUMN]} for row in permuted],
        fold=fold,
        blocks=blocks,
        segments=segments,
        run="leaked",
        rungs=rungs,
        function_definition=FUNCTION_DEFINITION,
        day_grain=False,
    )
    return ShuffledLabelControl(
        permutation_seed=permutation_seed,
        chance_seed=1,
        readings=chance_readings(table, seed=1),
    )


def test_a_label_leaked_into_a_feature_column_fails_the_control(
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    segments: tuple[FoldSegment, ...],
    rungs: tuple[Rung, ...],
    record_property: Any,
) -> None:
    """The leak seam 6 exists for, staged, and both metrics fire.

    This is the run that shows the control is capable of producing the
    embarrassing number. The labels are permuted exactly as the passing runs
    permute them; the only difference is one feature column that knows the
    answer, which is the whole class of bug seam 6 is a detector for — and it
    does not need to be told the column's name.
    """
    control = _leaked(
        ladder_rows,
        fold=fold,
        blocks=blocks,
        segments=segments,
        rungs=rungs,
        permutation_seed=PERMUTATION_SEEDS[0],
    )
    _record(record_property, control)

    served = control.reading(rung=SERVED_RUNG)
    assert served.off_chance() == ("pr_auc", "qloss_mwh")
    assert served.qloss_ratio < QLOSS_FLOOR
    assert not control.holds


def _permute_within_cell(
    rows: Sequence[Mapping[str, Any]], *, seed: int
) -> list[dict[str, Any]]:
    """The label block permuted **inside** ``(subsystem, local_hour)``.

    The rule the diagnosis layer's shuffled-feature control is obliged to
    follow, applied here — where it is wrong. This fixture's label is a function
    of the subsystem and the hour, so a permutation that respects both leaves
    the signal exactly where it was.
    """
    cells: dict[tuple[str, int], list[int]] = {}
    for index, row in enumerate(rows):
        if row[TOTAL_COLUMN] is None:
            continue
        cells.setdefault((row["subsystem"], row["calendar_local_hour"]), []).append(index)
    generator = np.random.default_rng(seed)
    donors: dict[int, int] = {}
    for cell in sorted(cells):
        members = cells[cell]
        for position, moved in enumerate(generator.permutation(len(members))):
            donors[members[position]] = members[int(moved)]
    permuted: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        one = dict(row)
        donor = donors.get(index)
        if donor is not None:
            for name in LABEL_COLUMNS:
                one[name] = rows[donor][name]
        permuted.append(one)
    return permuted


def test_a_permutation_that_respects_the_cell_is_not_this_control(
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    segments: tuple[FoldSegment, ...],
    rungs: tuple[Rung, ...],
    record_property: Any,
) -> None:
    """A weak permutation, and the control refusing it. The inversion, measured.

    The diagnosis layer's shuffled-feature control **must** keep its permutation
    inside ``(subsystem, calendar_local_hour)``, and its file records what
    happens when it does not. Seam 6 is the other way round, and this is why:
    the cell is where this lane's signal lives, so a permutation that respects
    it destroys nothing, the pipeline keeps most of its skill, and a control
    built on that rule would pass on a harness that leaks.

    Nothing here is a claim about which rule is right in general. What it fixes
    is that the two layers' rules are opposite *and that this file knows it*.
    """
    table = run_ladder(
        _permute_within_cell(ladder_rows, seed=7),
        fold=fold,
        blocks=blocks,
        segments=segments,
        run="within-cell",
        rungs=rungs,
        function_definition=FUNCTION_DEFINITION,
        day_grain=False,
    )
    weak = ShuffledLabelControl(
        permutation_seed=7, chance_seed=1, readings=chance_readings(table, seed=1)
    )
    _record(record_property, weak)

    served = weak.reading(rung=SERVED_RUNG)
    assert served.pr_auc is not None
    assert served.pr_auc_chance is not None
    assert served.pr_auc > served.pr_auc_chance[1]
    assert not weak.holds


def test_the_failure_names_the_fold_the_rung_and_the_metric(
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    segments: tuple[FoldSegment, ...],
    rungs: tuple[Rung, ...],
) -> None:
    """A leak localised rather than merely announced is a property of the string.

    Asserted on the message a real staged leak produces, not on a hand-built
    value, because the failure a reader will meet is the one the run writes.
    """
    control = _leaked(
        ladder_rows,
        fold=fold,
        blocks=blocks,
        segments=segments,
        rungs=rungs,
        permutation_seed=PERMUTATION_SEEDS[0],
    )
    with pytest.raises(ChanceError) as raised:
        control.assert_at_chance()
    message = str(raised.value)
    assert fold.id in message
    assert SERVED_RUNG in message
    assert "pr_auc" in message
    assert "qloss_mwh" in message
    assert f"permutation seed {PERMUTATION_SEEDS[0]}" in message


# --- the permutation ---------------------------------------------------------


def test_the_permutation_moves_the_label_block_and_nothing_else(
    ladder_rows: list[dict[str, Any]],
) -> None:
    """Three readings in one, and each is a reason the control means anything.

    The features come back bit-identical, so a shuffled run and an honest run
    differ in their labels and in nothing else. The label multiset is the one
    the fold held, so every permuted row carries a label some hour actually had
    — a per-column shuffle would break the wind/solar/total identity and the
    magnitude boosters would then be fitted on hours that never existed. And the
    settled rows are the settled rows, which is what lets the two runs be scored
    on the same hours.
    """
    permuted = permute_labels_within_fold(ladder_rows, seed=5)
    assert len(permuted) == len(ladder_rows)

    features = [name for name in ladder_rows[0] if name not in LABEL_COLUMNS]
    assert [{name: row[name] for name in features} for row in permuted] == [
        {name: row[name] for name in features} for row in ladder_rows
    ]

    def block(rows: Sequence[Mapping[str, Any]]) -> list[tuple[Any, ...]]:
        return sorted(
            (tuple(row[name] for name in LABEL_COLUMNS) for row in rows),
            key=repr,
        )

    assert block(permuted) == block(ladder_rows)
    assert [row[TOTAL_COLUMN] is None for row in permuted] == [
        row[TOTAL_COLUMN] is None for row in ladder_rows
    ]
    assert any(
        one[TOTAL_COLUMN] != other[TOTAL_COLUMN]
        for one, other in zip(permuted, ladder_rows, strict=True)
    )
    # The joint label survived: the split still sums to the total, and the two
    # derived columns still agree with it.
    for row in permuted:
        total = row[TOTAL_COLUMN]
        if total is None:
            assert all(row[name] is None for name in LABEL_COLUMNS)
            continue
        assert row["y_constrained_off_wind_mwh"] + row[
            "y_constrained_off_solar_mwh"
        ] == pytest.approx(total)
        assert row["y_has_curtailment"] == (row["y_magnitude_mwh"] is not None)


def test_a_label_column_the_permutation_was_not_told_about_is_refused(
    ladder_rows: list[dict[str, Any]],
) -> None:
    """A label left behind by the permutation is the leak, so the shuffle refuses.

    The realistic failure: `feature_row` grows a ``y_`` column, nobody adds it to
    :data:`LABEL_COLUMNS`, and the control goes on passing while the pipeline
    learns from a label it was handed intact.
    """
    with pytest.raises(ShuffledLabelError, match="LABEL_COLUMNS"):
        permute_labels_within_fold(
            [{**row, "y_constrained_off_hydro_mwh": 1.0} for row in ladder_rows],
            seed=5,
        )


def test_a_fold_with_no_settled_labels_is_refused() -> None:
    """A permutation of fewer than two labels is not a permutation."""
    with pytest.raises(ShuffledLabelError, match="not a permutation"):
        permute_labels_within_fold([{TOTAL_COLUMN: None}], seed=5)


def test_the_permutation_is_the_seeds_and_reproducible(
    ladder_rows: list[dict[str, Any]],
) -> None:
    """Two seeds disagree, one seed twice does not. The control records the seed."""
    first = permute_labels_within_fold(ladder_rows, seed=5)
    again = permute_labels_within_fold(ladder_rows, seed=5)
    other = permute_labels_within_fold(ladder_rows, seed=6)
    assert [row[TOTAL_COLUMN] for row in first] == [row[TOTAL_COLUMN] for row in again]
    assert [row[TOTAL_COLUMN] for row in first] != [row[TOTAL_COLUMN] for row in other]


# --- the chance interval -----------------------------------------------------


def test_the_chance_interval_brackets_prevalence() -> None:
    """It is centred on chance, which for average precision is just above prevalence.

    The number a PR-AUC "at chance" is compared against is not zero and not 0.5:
    a random ranking scores the base rate. The interval has to contain it, or
    the control would fail every honest shuffled run on arithmetic alone.
    """
    lower, upper = chance_interval(rows=661, positives=73, seed=7)
    prevalence = 73 / 661
    assert lower < prevalence < upper
    assert 0.0 < lower < upper < 1.0


def test_the_chance_interval_widens_as_the_positives_thin_out() -> None:
    """Fewer positives, a noisier ranking metric, a wider interval.

    The reason the interval is computed per row rather than fixed once: a fold
    segment with 30 curtailed hours cannot be held to the same line as one with
    300, and a single constant would be either flaky on the first or blind on
    the second.
    """
    thin = chance_interval(rows=2_000, positives=20, seed=7)
    thick = chance_interval(rows=2_000, positives=400, seed=7)
    assert (thin[1] - thin[0]) > (thick[1] - thick[0])


def test_the_chance_interval_refuses_one_class() -> None:
    """Average precision over one class is no score, so it has no interval either."""
    with pytest.raises(ShuffledLabelError, match="not a score"):
        chance_interval(rows=100, positives=0, seed=7)
    with pytest.raises(ShuffledLabelError, match="not a score"):
        chance_interval(rows=100, positives=100, seed=7)


# --- the full calendar, on the schedule --------------------------------------


#: The full run's window: the calendar's own ``window_start`` through the end of
#: F6's quarter. Two and a half years of fixture rows, which is the reason this
#: run is gated and the F1 run is not.
SCALE_WINDOW_START = date(2024, 4, 1)
SCALE_AS_OF = date(2026, 10, 1)


@pytest.mark.skipif(
    not os.environ.get("WATTSTEER_SCALE_TESTS"),
    reason=(
        "Seam 6 over the whole fold calendar: six folds, five rungs each, on two "
        "and a half years of rows. The default gate above runs the same control "
        "on the reduced fold set the ticket asks for — F1, seven test days — and "
        "exercises every line of the detector. Run this with "
        "WATTSTEER_SCALE_TESTS=1, or `bun run ml:test:scale`."
    ),
)
@pytest.mark.parametrize("permutation_seed", [1, 2])
def test_the_control_holds_on_every_fold_of_the_calendar(
    pool: OutOfFoldPool, permutation_seed: int, record_property: Any
) -> None:
    """The full run: every fold of the shared calendar, permuted within its own range.

    "Within each fold's date range, not global" is what this run is for. Each
    fold is permuted separately, so a label never crosses a fold boundary and a
    seasonal signal cannot be mistaken for the absence of one — which a single
    permutation over the whole window would introduce and then read as a pass.
    """
    calendar = materialize_fold_calendar(SCALE_AS_OF)
    published = default_ladder(
        function_definition=FUNCTION_DEFINITION,
        pool=pool,
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
    )
    rungs = tuple(TEST_FOREST if rung.number == 3 else rung for rung in published)
    for fold in calendar.folds:
        blocks = fold.blocks_for(SCALE_WINDOW_START)
        control = run_shuffled_label_control(
            rows_with_same_hour_features(
                first=blocks.base_fit_start, last=blocks.test_end
            ),
            fold=fold,
            blocks=blocks,
            segments=stamp_fidelity(fold, None),
            rungs=rungs,
            function_definition=FUNCTION_DEFINITION,
            permutation_seed=permutation_seed,
        )
        for reading in control.recorded()["readings"]:
            record_property(
                f"shuffled_label_{fold.id}_{reading['rung']}_pr_auc_excess",
                reading["pr_auc_excess"],
            )
            record_property(
                f"shuffled_label_{fold.id}_{reading['rung']}_qloss_ratio",
                reading["qloss_ratio"],
            )
        control.assert_at_chance()
