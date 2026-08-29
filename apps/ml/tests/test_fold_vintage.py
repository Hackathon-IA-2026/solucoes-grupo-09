"""A straddling fold yields two rows, and nothing here will average them.

`docs/specs/forecaster.md`, "The revision-optimistic label across the go-live
boundary". The tests are arranged around the one sentence that matters — "it is
never averaged, because averaging is precisely how a caveat disappears" — so
most of them assert a refusal rather than a value.

Every test supplies its own ``go_live_at``. There is no constant to import and
this file does not invent one: whether ingestion go-live coincides with F6's
start is an open question between `docs/specs/replay.md` and
`docs/specs/forecaster.md`, and both readings are covered below rather than
decided.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from wattsteer_ml.evaluation.folds import Fold, materialize_fold_calendar
from wattsteer_ml.evaluation.vintage import (
    FoldSegment,
    MixedFidelityError,
    assert_no_averaged_rows,
    earliest_valid_instant,
    first_point_in_time_date,
    pooled_fidelity,
    stamp_calendar,
    stamp_fidelity,
)

TODAY = date(2026, 8, 29)

#: The reading `docs/specs/replay.md` assumes: go-live at the start of F6.
GO_LIVE_AT_F6_START = datetime(2026, 7, 1, 3, tzinfo=UTC)  # 00:00 BRT

#: The reading `docs/specs/forecaster.md` explicitly handles: go-live part-way
#: through the live-edge fold.
GO_LIVE_MID_F6 = datetime(2026, 8, 1, 3, tzinfo=UTC)


def fold(fold_id: str, as_of: date = TODAY) -> Fold:
    return materialize_fold_calendar(as_of).fold(fold_id)


# --- the boundary -------------------------------------------------------------


def test_a_target_date_begins_at_local_midnight_not_utc_midnight() -> None:
    assert earliest_valid_instant(date(2026, 7, 1)) == datetime(2026, 7, 1, 3, tzinfo=UTC)


def test_go_live_at_local_midnight_makes_that_very_day_point_in_time() -> None:
    assert first_point_in_time_date(GO_LIVE_AT_F6_START) == date(2026, 7, 1)


def test_go_live_part_way_through_a_day_makes_that_whole_day_optimistic() -> None:
    """The day's earlier hours predate go-live, so the day is the weakest link."""
    mid_morning = datetime(2026, 7, 1, 13, tzinfo=UTC)
    assert first_point_in_time_date(mid_morning) == date(2026, 7, 2)


def test_a_source_that_ingested_nothing_has_no_point_in_time_date() -> None:
    assert first_point_in_time_date(None) is None


# --- one fold, one row --------------------------------------------------------


def test_a_fold_ending_before_go_live_is_revision_optimistic_in_full() -> None:
    (row,) = stamp_fidelity(fold("F3"), GO_LIVE_AT_F6_START)
    assert row.row_id == "F3"
    assert row.fidelity == "revision_optimistic"
    assert row.is_split is False
    assert row.test_days == 92


def test_a_fold_starting_at_go_live_is_point_in_time_in_full() -> None:
    (row,) = stamp_fidelity(fold("F6"), GO_LIVE_AT_F6_START)
    assert row.row_id == "F6"
    assert row.fidelity == "point_in_time"
    assert row.is_split is False


def test_with_no_go_live_every_fold_is_revision_optimistic() -> None:
    rows = stamp_calendar(materialize_fold_calendar(TODAY), None)
    assert len(rows) == 6
    assert {row.fidelity for row in rows} == {"revision_optimistic"}


# --- a straddling fold, two rows ---------------------------------------------


def test_a_straddling_fold_yields_two_rows_and_no_averaged_one() -> None:
    straddled = fold("F6")
    rows = stamp_fidelity(straddled, GO_LIVE_MID_F6)
    assert len(rows) == 2
    early, late = rows
    assert (early.row_id, early.fidelity) == (
        "F6@revision_optimistic",
        "revision_optimistic",
    )
    assert (late.row_id, late.fidelity) == ("F6@point_in_time", "point_in_time")
    assert early.test_start == straddled.test_start
    assert early.test_end == date(2026, 7, 31)
    assert late.test_start == date(2026, 8, 1)
    assert late.test_end == straddled.test_end
    assert early.test_days + late.test_days == straddled.test_days
    assert all(row.is_split for row in rows)
    assert straddled.id not in {row.row_id for row in rows}


def test_the_two_halves_of_a_split_fold_have_different_hashes() -> None:
    early, late = stamp_fidelity(fold("F6"), GO_LIVE_MID_F6)
    assert early.segment_hash != late.segment_hash
    assert early.fold_hash == late.fold_hash == fold("F6").fold_hash


def test_a_straddled_calendar_reports_one_more_row_than_it_has_folds() -> None:
    built = materialize_fold_calendar(TODAY)
    rows = stamp_calendar(built, GO_LIVE_MID_F6)
    assert len(rows) == len(built) + 1
    assert [row.row_id for row in rows] == [
        "F1",
        "F2",
        "F3",
        "F4",
        "F5",
        "F6@revision_optimistic",
        "F6@point_in_time",
    ]


def test_go_live_on_a_folds_last_day_still_splits_it() -> None:
    """The narrowest straddle there is: one point-in-time day."""
    straddled = fold("F5")
    rows = stamp_fidelity(straddled, datetime(2026, 6, 30, 3, tzinfo=UTC))
    assert len(rows) == 2
    assert rows[1].test_days == 1
    assert rows[0].test_days == straddled.test_days - 1


def test_go_live_the_day_after_a_fold_ends_does_not_split_it() -> None:
    ending = fold("F5")
    (row,) = stamp_fidelity(ending, datetime(2026, 7, 1, 3, tzinfo=UTC))
    assert row.fidelity == "revision_optimistic"
    assert row.test_end == ending.test_end == date(2026, 6, 30)


# --- the refusals -------------------------------------------------------------


def test_pooling_across_a_fidelity_boundary_is_refused() -> None:
    rows = stamp_calendar(materialize_fold_calendar(TODAY), GO_LIVE_MID_F6)
    with pytest.raises(MixedFidelityError, match="averaging is precisely how"):
        pooled_fidelity(rows)


def test_pooling_within_one_fidelity_states_it() -> None:
    rows = stamp_calendar(materialize_fold_calendar(TODAY), GO_LIVE_MID_F6)
    optimistic = [row for row in rows if row.fidelity == "revision_optimistic"]
    assert pooled_fidelity(optimistic) == "revision_optimistic"


def test_an_empty_pool_has_no_fidelity_to_state() -> None:
    with pytest.raises(MixedFidelityError, match="empty pool"):
        pooled_fidelity([])


def test_a_fold_reported_both_whole_and_split_is_caught() -> None:
    straddled = fold("F6")
    early, _late = stamp_fidelity(straddled, GO_LIVE_MID_F6)
    (whole,) = stamp_fidelity(straddled, GO_LIVE_AT_F6_START)
    with pytest.raises(MixedFidelityError, match="one of those two numbers averaged"):
        assert_no_averaged_rows((early, whole))


def test_an_orphaned_half_of_a_split_fold_is_caught() -> None:
    early, _late = stamp_fidelity(fold("F6"), GO_LIVE_MID_F6)
    with pytest.raises(MixedFidelityError, match="other half is missing"):
        assert_no_averaged_rows([early])


def test_two_rows_of_the_same_fidelity_are_not_a_go_live_split() -> None:
    early, late = stamp_fidelity(fold("F6"), GO_LIVE_MID_F6)
    forged = FoldSegment(
        fold_id=late.fold_id,
        row_id="F6@revision_optimistic",
        fidelity="revision_optimistic",
        test_start=late.test_start,
        test_end=late.test_end,
        is_split=True,
        fold_hash=late.fold_hash,
    )
    with pytest.raises(MixedFidelityError, match="only split this protocol defines"):
        assert_no_averaged_rows([early, forged])


def test_the_rows_a_straddled_calendar_reports_pass_the_check() -> None:
    assert_no_averaged_rows(
        stamp_calendar(materialize_fold_calendar(TODAY), GO_LIVE_MID_F6)
    )
    assert_no_averaged_rows(
        stamp_calendar(materialize_fold_calendar(TODAY), GO_LIVE_AT_F6_START)
    )
    assert_no_averaged_rows(stamp_calendar(materialize_fold_calendar(TODAY), None))


def test_a_row_id_that_does_not_name_its_segment_cannot_be_constructed() -> None:
    with pytest.raises(ValueError, match="does not name this segment"):
        FoldSegment(
            fold_id="F6",
            row_id="F6",
            fidelity="point_in_time",
            test_start=date(2026, 8, 1),
            test_end=date(2026, 8, 28),
            is_split=True,
            fold_hash="sha256:whatever",
        )


def test_a_segment_with_an_empty_test_period_cannot_be_constructed() -> None:
    with pytest.raises(ValueError, match="empty test period"):
        FoldSegment(
            fold_id="F6",
            row_id="F6",
            fidelity="point_in_time",
            test_start=date(2026, 8, 28),
            test_end=date(2026, 8, 28) - timedelta(days=1),
            is_split=False,
            fold_hash="sha256:whatever",
        )
