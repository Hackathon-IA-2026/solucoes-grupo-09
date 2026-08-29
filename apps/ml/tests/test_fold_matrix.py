"""Every run is scored on identical rows, and the check is a hash, not a count.

`docs/specs/forecaster.md`: the calendar is fixed once and shared "so that
A-full, A-common, B-common and the archive-weather arm are all scored on
identical test rows".

The test that matters most is
:func:`test_two_runs_with_the_same_row_count_and_different_rows_are_caught`.
Everything else here would also be satisfied by comparing lengths, and comparing
lengths is exactly the check that lets one missing hour and one extra day cancel
out into a full set of plausible, incomparable numbers.

**What this file does not assert, and why.** It never runs the four arms against
the database. The end-to-end row-identity assertion needs the feature function
to exist for both feature sets: `feature_rows(...)` is in the migration tree,
but only set A's weather block is populated and `dessem_augmented_v1` has no
columns of its own yet. :meth:`RowKey.from_feature_row` — the adapter that
assertion will use — is tested here against the row shape
`apps/api/drizzle/0016_the_feature_gate.sql` declares, which is real. The
assertion itself is left undone rather than written against a fabricated row
set, because a row-identity test that passes against invented rows asserts
nothing at all and reads as though it asserts everything.
"""

from __future__ import annotations

import dataclasses
from datetime import UTC, date, datetime, timedelta

import pytest

from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation.folds import FOLD_CALENDAR_RULES, materialize_fold_calendar
from wattsteer_ml.evaluation.matrix import (
    HOURS_PER_DAY,
    MATRIX_RUN_BY_NAME,
    MATRIX_RUNS,
    RowIdentityError,
    RowKey,
    ScoredFold,
    assert_identical_test_rows,
    expected_test_rows,
    row_set_digest,
)

TODAY = date(2026, 8, 29)


# --- the matrix ---------------------------------------------------------------


def test_the_matrix_is_the_four_arms_the_spec_names() -> None:
    assert [run.name for run in MATRIX_RUNS] == [
        "A-full",
        "A-common",
        "B-common",
        "A-full-archive",
    ]
    assert MATRIX_RUN_BY_NAME["B-common"].feature_set == "dessem_augmented_v1"
    assert MATRIX_RUN_BY_NAME["A-full-archive"].weather_arm == "archive"
    assert {run.weather_arm for run in MATRIX_RUNS} == {"lead_matched", "archive"}


def test_a_common_window_is_shared_so_the_handicap_is_not_charged_to_dessem() -> None:
    """A-common exists precisely to absorb the short-window disadvantage."""
    assert (
        MATRIX_RUN_BY_NAME["A-common"].window_start
        == MATRIX_RUN_BY_NAME["B-common"].window_start
        == date(2025, 5, 23)
    )
    assert MATRIX_RUN_BY_NAME["A-common"].feature_set == (
        MATRIX_RUN_BY_NAME["A-full"].feature_set
    )


def test_a_run_carries_no_view_of_what_it_is_scored_on() -> None:
    """No field for a fold, a test period or a date range — only a window."""
    fields = {field.name for field in dataclasses.fields(MATRIX_RUNS[0])}
    assert fields == {"name", "feature_set", "window_start", "weather_arm", "isolates"}


def test_the_dessem_verdict_rests_on_two_test_quarters() -> None:
    built = materialize_fold_calendar(TODAY)
    graded = {run.name: run.decision_grade_folds(built) for run in MATRIX_RUNS}
    assert graded["A-full"] == ("F1", "F2", "F3", "F4", "F5", "F6")
    assert graded["A-common"] == ("F5", "F6")
    assert graded["B-common"] == ("F5", "F6")
    assert FOLD_CALENDAR_RULES.min_base_fit_days == 180


# --- the rows the calendar names ---------------------------------------------


def test_a_test_period_holds_four_subsystems_by_twenty_four_hours_by_day() -> None:
    rows = expected_test_rows(date(2026, 7, 1), date(2026, 7, 3))
    assert len(rows) == 3 * HOURS_PER_DAY * len(SUBSYSTEM_CODES)
    assert len(set(rows)) == len(rows)
    assert rows[0] == RowKey(date(2026, 7, 1), 0, "N")


def test_the_rows_are_the_calendar_crossed_with_the_two_closed_enums() -> None:
    """Day by hour by subsystem, in the product's display order within an hour.

    The emission order is not asserted to match the query's — that sorts
    subsystems by the Postgres enum's ordinal — because row identity is a
    statement about a set. :func:`row_set_digest` sorts, and
    :func:`test_the_digest_is_over_the_set_and_not_over_the_order` is where that
    is pinned.
    """
    rows = expected_test_rows(date(2026, 7, 1), date(2026, 7, 2))
    assert [row.subsystem for row in rows[: len(SUBSYSTEM_CODES)]] == list(
        SUBSYSTEM_CODES
    )
    assert [row.local_hour for row in rows[:: len(SUBSYSTEM_CODES)]] == [
        *range(HOURS_PER_DAY),
        *range(HOURS_PER_DAY),
    ]


def test_every_fold_of_the_calendar_names_its_own_rows() -> None:
    for fold in materialize_fold_calendar(TODAY):
        rows = expected_test_rows(fold.test_start, fold.test_end)
        assert len(rows) == fold.test_days * HOURS_PER_DAY * len(SUBSYSTEM_CODES)


def test_a_row_outside_the_local_day_cannot_be_constructed() -> None:
    with pytest.raises(ValueError, match="outside the 24-hour target day"):
        RowKey(date(2026, 7, 1), HOURS_PER_DAY, "N")


def test_the_national_aggregate_is_not_a_subsystem() -> None:
    with pytest.raises(ValueError, match="not one of the four subsystems"):
        RowKey(date(2026, 7, 1), 0, "SIN")  # type: ignore[arg-type]


# --- identity by hash ---------------------------------------------------------


def test_the_digest_is_over_the_set_and_not_over_the_order() -> None:
    rows = expected_test_rows(date(2026, 7, 1), date(2026, 7, 2))
    assert row_set_digest(rows) == row_set_digest(tuple(reversed(rows)))


def test_a_duplicated_row_is_refused_rather_than_collapsed() -> None:
    rows = expected_test_rows(date(2026, 7, 1), date(2026, 7, 1))
    with pytest.raises(RowIdentityError, match="twice"):
        row_set_digest((*rows, rows[0]))


def test_every_run_scored_on_the_calendars_rows_agrees() -> None:
    fold = materialize_fold_calendar(TODAY).fold("F5")
    rows = expected_test_rows(fold.test_start, fold.test_end)
    scored = [ScoredFold.of(run.name, fold, rows) for run in MATRIX_RUNS]
    digest = assert_identical_test_rows(scored)
    assert digest == row_set_digest(rows)
    assert {entry.row_count for entry in scored} == {len(rows)}


def test_two_runs_with_the_same_row_count_and_different_rows_are_caught() -> None:
    """The whole point. One missing hour and one extra day cancel in a count."""
    fold = materialize_fold_calendar(TODAY).fold("F5")
    rows = expected_test_rows(fold.test_start, fold.test_end)
    swapped = (
        *rows[:-1],
        RowKey(fold.test_end + timedelta(days=1), 0, "N"),
    )
    assert len(swapped) == len(rows)
    with pytest.raises(RowIdentityError, match="Equal counts"):
        assert_identical_test_rows(
            [
                ScoredFold.of("A-full", fold, rows),
                ScoredFold.of("B-common", fold, swapped),
            ]
        )


def test_two_runs_that_materialised_the_live_edge_on_different_days_are_caught() -> None:
    """A recomputed calendar is a different calendar, and it says so."""
    today = materialize_fold_calendar(TODAY).fold("F6")
    tomorrow = materialize_fold_calendar(TODAY + timedelta(days=1)).fold("F6")
    rows = expected_test_rows(today.test_start, today.test_end)
    with pytest.raises(RowIdentityError, match="not recomputed per run"):
        assert_identical_test_rows(
            [
                ScoredFold.of("A-full", today, rows),
                ScoredFold.of("B-common", tomorrow, rows),
            ]
        )


def test_two_runs_scored_on_different_folds_are_not_a_comparison() -> None:
    built = materialize_fold_calendar(TODAY)
    fifth, sixth = built.fold("F5"), built.fold("F6")
    with pytest.raises(RowIdentityError, match="not the same comparison"):
        assert_identical_test_rows(
            [
                ScoredFold.of(
                    "A-full", fifth, expected_test_rows(fifth.test_start, fifth.test_end)
                ),
                ScoredFold.of(
                    "B-common",
                    sixth,
                    expected_test_rows(sixth.test_start, sixth.test_end),
                ),
            ]
        )


def test_one_run_is_not_a_comparison() -> None:
    fold = materialize_fold_calendar(TODAY).fold("F5")
    rows = expected_test_rows(fold.test_start, fold.test_end)
    with pytest.raises(RowIdentityError, match="at least two runs"):
        assert_identical_test_rows([ScoredFold.of("A-full", fold, rows)])


def test_a_run_cannot_supply_its_own_row_digest() -> None:
    """`ScoredFold.of` computes it, so the claim and the rows cannot disagree."""
    fold = materialize_fold_calendar(TODAY).fold("F5")
    rows = expected_test_rows(fold.test_start, fold.test_end)
    scored = ScoredFold.of("A-full", fold, rows)
    assert scored.row_digest == row_set_digest(rows)
    assert scored.fold_hash == fold.fold_hash


# --- the adapter onto the feature function's rows -----------------------------


def test_a_feature_row_is_keyed_by_its_local_hour_and_not_its_utc_hour() -> None:
    """`valid_time` is UTC; Brasília is three hours behind, all year in range."""
    key = RowKey.from_feature_row(
        {
            "subsystem": "NE",
            "target_date": date(2026, 7, 1),
            "valid_time": datetime(2026, 7, 1, 17, tzinfo=UTC),
            "y_constrained_off_total_mwh": 12.5,
        }
    )
    assert key == RowKey(date(2026, 7, 1), 14, "NE")


def test_the_first_and_last_rows_of_a_target_day_round_trip() -> None:
    day = date(2026, 7, 1)
    first = RowKey.from_feature_row(
        {
            "subsystem": "S",
            "target_date": day,
            "valid_time": datetime(2026, 7, 1, 3, tzinfo=UTC),
        }
    )
    last = RowKey.from_feature_row(
        {
            "subsystem": "S",
            "target_date": day,
            "valid_time": datetime(2026, 7, 2, 2, tzinfo=UTC),
        }
    )
    assert (first.local_hour, last.local_hour) == (0, 23)


def test_a_naive_valid_time_is_refused() -> None:
    with pytest.raises(RowIdentityError, match="aware instant"):
        RowKey.from_feature_row(
            {
                "subsystem": "N",
                "target_date": date(2026, 7, 1),
                "valid_time": datetime(2026, 7, 1, 3),
            }
        )


def test_a_row_missing_an_identity_column_says_which_one() -> None:
    with pytest.raises(RowIdentityError, match="'valid_time'"):
        RowKey.from_feature_row({"subsystem": "N", "target_date": date(2026, 7, 1)})


def test_a_target_date_written_as_an_instant_is_refused() -> None:
    with pytest.raises(RowIdentityError, match="civil date"):
        RowKey.from_feature_row(
            {
                "subsystem": "N",
                "target_date": datetime(2026, 7, 1, tzinfo=UTC),
                "valid_time": datetime(2026, 7, 1, 3, tzinfo=UTC),
            }
        )


def test_a_valid_time_that_is_not_a_whole_local_hour_is_refused() -> None:
    with pytest.raises(RowIdentityError, match="whole local hour"):
        RowKey.from_feature_row(
            {
                "subsystem": "N",
                "target_date": date(2026, 7, 1),
                "valid_time": datetime(2026, 7, 1, 3, 30, tzinfo=UTC),
            }
        )
