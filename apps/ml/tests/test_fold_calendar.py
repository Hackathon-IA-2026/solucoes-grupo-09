"""The calendar is the spec's table, it cannot be reordered, and it grows itself.

`docs/specs/forecaster.md`, "The fold-evaluation protocol". Two kinds of test
live here and they fail for different reasons:

- the ones that **pin** — the version, the rules hash, the six folds against the
  spec's own table. They exist so that a change to the calendar cannot be
  silent, and a diff that moves one shows up on the same line as the edit.
- the ones that assert a **property of the construction** — that a shuffled
  tuple is refused, that a hand-edited fold is refused, that the base fit and
  the calibration window are disjoint for every window in the matrix. Those hold
  for calendars nobody has written yet.

The test that matters most is
:func:`test_a_calendar_whose_folds_were_edited_is_refused`. It is the reason
:class:`FoldCalendar` re-derives rather than trusts: a run that quietly widened
its own test fold produces a full set of plausible metrics and nothing else in
the pipeline can tell.
"""

from __future__ import annotations

import dataclasses
from datetime import date, timedelta
from pathlib import Path

import pytest
import yaml

from wattsteer_ml.evaluation.folds import (
    FOLD_CALENDAR_PATH,
    FOLD_CALENDAR_RULES,
    Fold,
    FoldBlocks,
    FoldCalendar,
    FoldCalendarError,
    FoldOrderError,
    FoldWindowError,
    assert_folds_in_order,
    load_fold_calendar_rules,
    materialize_fold_calendar,
)

#: A day on which all six of the spec's folds exist and F6 is still growing.
TODAY = date(2026, 8, 29)

#: The calendar's identity, pinned. Editing `fold_calendar.yaml`'s rules changes
#: this, and with it every fold hash and every cached fold result. Reformatting
#: the file or rewording a comment does not — the hash is over the rules, not
#: the bytes.
EXPECTED_RULES_HASH = (
    "sha256:c8d615f68184e0907a352316336c0512bf21e8eb5ae3ff08912687500812e214"
)

#: `docs/specs/forecaster.md`'s table, transcribed by hand. Two independent
#: transcriptions — this one and `fold_calendar.yaml`'s `pinned_folds` — because
#: a single one shared with the code under test would only assert that the file
#: equals itself.
#:
#: The three calibration windows corrected against the spec's prose rule are
#: F3, F4 and F6; see the YAML's header for the arithmetic. They are written out
#: here too, so the correction is asserted rather than assumed.
SPEC_TABLE: tuple[tuple[str, date, date, int, date, date, date], ...] = (
    (
        "F1",
        date(2025, 4, 1),
        date(2025, 6, 30),
        91,
        date(2025, 3, 31),
        date(2025, 1, 1),
        date(2025, 3, 31),
    ),
    (
        "F2",
        date(2025, 7, 1),
        date(2025, 9, 30),
        92,
        date(2025, 6, 30),
        date(2025, 4, 2),
        date(2025, 6, 30),
    ),
    (
        "F3",
        date(2025, 10, 1),
        date(2025, 12, 31),
        92,
        date(2025, 9, 30),
        date(2025, 7, 3),
        date(2025, 9, 30),
    ),
    (
        "F4",
        date(2026, 1, 1),
        date(2026, 3, 31),
        90,
        date(2025, 12, 31),
        date(2025, 10, 3),
        date(2025, 12, 31),
    ),
    (
        "F5",
        date(2026, 4, 1),
        date(2026, 6, 30),
        91,
        date(2026, 3, 31),
        date(2026, 1, 1),
        date(2026, 3, 31),
    ),
    (
        "F6",
        date(2026, 7, 1),
        date(2026, 9, 30),
        92,
        date(2026, 6, 30),
        date(2026, 4, 2),
        date(2026, 6, 30),
    ),
)

#: The two windows the DESSEM A/B compares. A-full's and the common one.
FULL_WINDOW = date(2024, 4, 1)
COMMON_WINDOW = date(2025, 5, 23)


def calendar(as_of: date = TODAY) -> FoldCalendar:
    return materialize_fold_calendar(as_of)


def write_rules(tmp_path: Path, **overrides: object) -> Path:
    """The shipped YAML with some keys replaced, for the tamper tests."""
    document = yaml.safe_load(FOLD_CALENDAR_PATH.read_text(encoding="utf-8"))
    document.update(overrides)
    path = tmp_path / "fold_calendar.yaml"
    path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
    return path


# --- the calendar is data, and it is the spec's data --------------------------


def test_the_rules_version_and_hash_are_pinned() -> None:
    assert FOLD_CALENDAR_RULES.version == 1
    assert FOLD_CALENDAR_RULES.rules_hash == EXPECTED_RULES_HASH
    assert FOLD_CALENDAR_RULES.card_fields() == {
        "fold_calendar_version": "1",
        "fold_calendar_hash": EXPECTED_RULES_HASH,
    }


def test_the_hash_is_over_the_rules_and_not_over_the_file() -> None:
    """A reworded comment must not invalidate every cached fold result."""
    assert FOLD_CALENDAR_RULES.rule_lines == (
        "version\t1",
        "window_start\t2024-04-01",
        "first_test_start\t2025-04-01",
        "quarter_months\t3",
        "calibration_days\t90",
        "min_base_fit_days\t180",
    )


def test_the_six_folds_are_the_spec_table() -> None:
    folds = calendar().folds
    assert len(folds) == len(SPEC_TABLE)
    for fold, row in zip(folds, SPEC_TABLE, strict=True):
        fold_id, test_start, quarter_end, quarter_days, train_end, cal_from, cal_to = row
        assert (fold.id, fold.test_start, fold.quarter_end) == (
            fold_id,
            test_start,
            quarter_end,
        )
        assert fold.quarter_days == quarter_days
        assert fold.train_end == train_end
        assert (fold.calibration_start, fold.calibration_end) == (cal_from, cal_to)


@pytest.mark.parametrize("as_of", [TODAY, date(2026, 11, 3), date(2027, 5, 20)])
def test_every_calibration_window_is_the_most_recent_ninety_days(as_of: date) -> None:
    """The rule the spec states three times, on folds the table does not list."""
    for fold in calendar(as_of):
        assert fold.calibration_days == 90
        assert fold.calibration_end == fold.train_end
        assert fold.calibration_start == fold.train_end - timedelta(days=89)


def test_the_first_fold_starts_twelve_months_after_the_window_opens() -> None:
    first = calendar().folds[0]
    assert FOLD_CALENDAR_RULES.window_start == date(2024, 4, 1)
    assert first.test_start == date(2025, 4, 1)
    assert (first.test_start - FOLD_CALENDAR_RULES.window_start).days == 365


# --- the three blocks, produced together and disjoint -------------------------


@pytest.mark.parametrize("window_start", [FULL_WINDOW, COMMON_WINDOW])
def test_the_three_blocks_are_produced_together_and_the_first_two_are_disjoint(
    window_start: date,
) -> None:
    for fold in calendar():
        if fold.base_fit_days_for(window_start) == 0:
            continue
        blocks = fold.blocks_for(window_start)
        assert blocks.base_fit_start == window_start
        assert blocks.base_fit_end < blocks.calibration_start
        assert blocks.base_fit_end == blocks.calibration_start - timedelta(days=1)
        assert blocks.calibration_days == 90
        assert (blocks.test_start, blocks.test_end) == (fold.test_start, fold.test_end)


def test_the_latest_train_date_precedes_the_earliest_test_date_in_every_fold() -> None:
    """`max(train target_date) < min(test target_date)`, per fold.

    The training block's last day is the last calibration day, because the
    calibration window is carved out of the training block rather than shared
    with it — so this is the assertion the protocol names, on the value that
    actually bounds training.
    """
    for fold in calendar():
        blocks = fold.blocks_for(FULL_WINDOW)
        assert blocks.train_end < blocks.test_start
        assert blocks.train_end == fold.train_end


def test_a_block_triple_that_overlaps_cannot_be_constructed() -> None:
    with pytest.raises(FoldCalendarError, match="disjoint"):
        FoldBlocks(
            base_fit_start=date(2024, 4, 1),
            # One day too far: the base fit now reaches into the calibration window.
            base_fit_end=date(2025, 1, 1),
            calibration_start=date(2025, 1, 1),
            calibration_end=date(2025, 3, 31),
            test_start=date(2025, 4, 1),
            test_end=date(2025, 6, 30),
        )


def test_a_block_triple_whose_training_reaches_into_the_test_period_is_refused() -> None:
    with pytest.raises(FoldCalendarError, match="must end before the test period"):
        FoldBlocks(
            base_fit_start=date(2024, 4, 1),
            base_fit_end=date(2024, 12, 31),
            calibration_start=date(2025, 1, 1),
            calibration_end=date(2025, 4, 1),
            test_start=date(2025, 4, 1),
            test_end=date(2025, 6, 30),
        )


def test_a_window_that_leaves_no_base_fit_block_says_so_rather_than_returning_none() -> (
    None
):
    first = calendar().folds[0]
    assert first.base_fit_days_for(COMMON_WINDOW) == 0
    with pytest.raises(FoldWindowError, match="leaves no base-fit block"):
        first.blocks_for(COMMON_WINDOW)


# --- never shuffled -----------------------------------------------------------


def test_reversed_folds_are_reported_as_reordered() -> None:
    folds = calendar().folds
    with pytest.raises(FoldOrderError, match="reordered"):
        assert_folds_in_order(tuple(reversed(folds)))


def test_a_missing_middle_fold_is_reported_even_though_the_order_is_still_ascending() -> (
    None
):
    folds = calendar().folds
    without_f3 = folds[:2] + folds[3:]
    with pytest.raises(FoldOrderError, match="reordered"):
        assert_folds_in_order(without_f3)


def test_folds_from_two_different_rule_sets_are_not_one_calendar(tmp_path: Path) -> None:
    other = load_fold_calendar_rules(write_rules(tmp_path, min_base_fit_days=200))
    mine = calendar().folds
    theirs = materialize_fold_calendar(TODAY, other).folds
    with pytest.raises(FoldOrderError, match="more than one set of calendar rules"):
        assert_folds_in_order((mine[0], theirs[1]))


def test_a_calendar_cannot_be_built_from_shuffled_folds() -> None:
    built = calendar()
    with pytest.raises(FoldOrderError):
        FoldCalendar(
            rules=built.rules, as_of=built.as_of, folds=tuple(reversed(built.folds))
        )


def test_a_calendar_whose_folds_were_edited_is_refused() -> None:
    """A run that widened its own test fold produces plausible metrics."""
    built = calendar()
    widened = dataclasses.replace(
        built.folds[-1], test_end=built.folds[-1].test_end + timedelta(days=1)
    )
    with pytest.raises(FoldCalendarError, match="not recomputed per run"):
        FoldCalendar(
            rules=built.rules, as_of=built.as_of, folds=(*built.folds[:-1], widened)
        )


def test_a_renumbered_fold_cannot_be_constructed() -> None:
    fold = calendar().folds[0]
    with pytest.raises(FoldCalendarError, match="should be called"):
        dataclasses.replace(fold, index=2)


def test_a_fold_whose_train_end_does_not_abut_its_test_period_cannot_be_constructed() -> (
    None
):
    fold = calendar().folds[0]
    with pytest.raises(FoldCalendarError, match="day before the test period"):
        dataclasses.replace(fold, train_end=fold.train_end - timedelta(days=1))


# --- the live edge grows, freezes, and opens the next fold --------------------


def test_the_live_edge_grows_by_a_day_a_day() -> None:
    for as_of, expected_days in ((date(2026, 7, 2), 1), (date(2026, 8, 29), 59)):
        live = materialize_fold_calendar(as_of).live_edge
        assert live is not None
        assert live.id == "F6"
        assert live.test_days == expected_days
        assert live.test_end == as_of - timedelta(days=1)


def test_the_live_edge_freezes_at_a_full_quarter_and_the_next_fold_opens_by_itself() -> (
    None
):
    """The whole of acceptance box six, in one sequence and with no YAML edit."""
    day_it_freezes = materialize_fold_calendar(date(2026, 10, 1))
    assert len(day_it_freezes) == 6
    frozen = day_it_freezes.fold("F6")
    assert frozen.test_end == date(2026, 9, 30) == frozen.quarter_end
    assert frozen.test_days == 92
    assert not frozen.is_live_edge
    assert day_it_freezes.live_edge is None

    day_after = materialize_fold_calendar(date(2026, 10, 2))
    assert len(day_after) == 7
    assert day_after.fold("F6") == frozen
    seventh = day_after.fold("F7")
    assert seventh.test_start == date(2026, 10, 1)
    assert seventh.quarter_end == date(2026, 12, 31)
    assert seventh.train_end == date(2026, 9, 30)
    assert seventh.calibration_start == date(2026, 7, 3)
    assert seventh.is_live_edge
    assert day_after.live_edge == seventh


def test_a_frozen_fold_has_the_same_hash_on_every_day_and_the_live_edge_does_not() -> (
    None
):
    """Exactly the cached results a day of new rows invalidates, and no others."""
    today = calendar()
    tomorrow = calendar(TODAY + timedelta(days=1))
    for frozen in today.frozen_folds:
        assert frozen.fold_hash == tomorrow.fold(frozen.id).fold_hash
    assert today.fold("F6").fold_hash != tomorrow.fold("F6").fold_hash


def test_a_cache_key_carries_the_fold_hash_so_a_changed_calendar_cannot_hit(
    tmp_path: Path,
) -> None:
    mine = calendar().fold("F1")
    other = load_fold_calendar_rules(write_rules(tmp_path, window_start=date(2024, 3, 1)))
    theirs = materialize_fold_calendar(TODAY, other).fold("F1")
    assert mine.test_start == theirs.test_start  # the fold itself did not move
    assert mine.fold_hash != theirs.fold_hash  # the calendar it belongs to did
    assert mine.cache_key("A-full") != theirs.cache_key("A-full")
    assert mine.fold_hash in mine.cache_key("A-full")


def test_a_calendar_cannot_be_materialised_before_its_first_fold_opens() -> None:
    with pytest.raises(FoldCalendarError, match="nothing is testable"):
        materialize_fold_calendar(date(2025, 4, 1))


def test_the_first_fold_exists_the_day_after_it_opens() -> None:
    built = materialize_fold_calendar(date(2025, 4, 2))
    assert [fold.id for fold in built] == ["F1"]
    assert built.folds[0].test_days == 1


# --- decision-grade folds, the DESSEM A/B's arithmetic ------------------------


def test_the_common_window_is_decision_grade_in_exactly_two_folds() -> None:
    """`docs/specs/forecaster.md`: "which qualifies **F5 and F6** only"."""
    minimum = FOLD_CALENDAR_RULES.min_base_fit_days
    graded = [
        fold.id for fold in calendar() if fold.is_decision_grade(COMMON_WINDOW, minimum)
    ]
    assert graded == ["F5", "F6"]


def test_the_full_window_is_decision_grade_everywhere() -> None:
    minimum = FOLD_CALENDAR_RULES.min_base_fit_days
    assert all(fold.is_decision_grade(FULL_WINDOW, minimum) for fold in calendar())


def test_the_spec_states_the_common_window_qualifies_from_2026_02_17() -> None:
    """ "`2025-05-23 + 270 days = 2026-02-17 <= train_end`", checked directly."""
    minimum = FOLD_CALENDAR_RULES.min_base_fit_days
    for fold in calendar():
        qualifies = fold.train_end >= COMMON_WINDOW + timedelta(days=270)
        assert fold.is_decision_grade(COMMON_WINDOW, minimum) is qualifies


# --- the file on disk ---------------------------------------------------------


def test_a_pinned_row_that_disagrees_with_the_rules_fails_the_load(
    tmp_path: Path,
) -> None:
    document = yaml.safe_load(FOLD_CALENDAR_PATH.read_text(encoding="utf-8"))
    document["pinned_folds"][2]["calibration_start"] = date(2025, 7, 2)
    path = tmp_path / "fold_calendar.yaml"
    path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
    with pytest.raises(FoldCalendarError, match="does not match the calendar rules"):
        load_fold_calendar_rules(path)


def test_changing_the_calibration_length_moves_every_pinned_row(
    tmp_path: Path,
) -> None:
    """The spec's table and `calibration_days` cannot disagree quietly."""
    with pytest.raises(FoldCalendarError, match="does not match the calendar rules"):
        load_fold_calendar_rules(write_rules(tmp_path, calibration_days=91))


def test_a_fold_boundary_written_as_an_instant_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "fold_calendar.yaml"
    path.write_text(
        FOLD_CALENDAR_PATH.read_text(encoding="utf-8").replace(
            "window_start: 2024-04-01", "window_start: 2024-04-01T00:00:00Z"
        ),
        encoding="utf-8",
    )
    with pytest.raises(FoldCalendarError, match="dates, not timestamps"):
        load_fold_calendar_rules(path)


def test_a_quarter_length_that_does_not_divide_the_year_is_refused(
    tmp_path: Path,
) -> None:
    with pytest.raises(FoldCalendarError, match="must divide the year"):
        load_fold_calendar_rules(write_rules(tmp_path, quarter_months=5))


def test_rules_whose_first_fold_predates_the_window_are_refused(
    tmp_path: Path,
) -> None:
    with pytest.raises(FoldCalendarError, match="before the window opens"):
        load_fold_calendar_rules(write_rules(tmp_path, window_start=date(2025, 2, 1)))


def test_an_unknown_fold_id_names_the_ones_that_exist() -> None:
    with pytest.raises(FoldCalendarError, match=r"\['F1'"):
        calendar().fold("F9")


def test_a_cache_key_needs_a_run_name() -> None:
    with pytest.raises(FoldCalendarError, match="non-empty text"):
        calendar().folds[0].cache_key("")


def test_folds_stringify_as_their_test_period() -> None:
    assert str(calendar().folds[0]) == "F1 2025-04-01→2025-06-30"
    assert isinstance(calendar().folds[0], Fold)
