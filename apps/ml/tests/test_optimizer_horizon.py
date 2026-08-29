"""The horizon is a local civil day, derived from the zone and asserted to be 24."""

from __future__ import annotations

from datetime import UTC, date
from zoneinfo import ZoneInfo

import pytest

from wattsteer_ml.optimizer import GRID_ZONE, HORIZON_HOURS, OptimizerBugError, local_day


def test_the_horizon_is_exactly_twenty_four_hours() -> None:
    horizon = local_day(date(2026, 8, 29))
    assert len(horizon) == HORIZON_HOURS
    assert list(horizon.hours) == list(range(24))


def test_the_hours_are_derived_from_the_zone_and_not_a_fixed_offset() -> None:
    """`America/Sao_Paulo` is UTC−3 across the data window, but not by decree.

    The horizon starts at local midnight, which is 03:00Z — a fact about the
    zone database on this date, which is why it is read from there.
    """
    horizon = local_day(date(2026, 8, 29))
    first = horizon.starts_at[0]
    assert first.tzinfo is UTC
    assert first.hour == 3
    assert first.astimezone(GRID_ZONE).hour == 0
    assert horizon.zone_key == "America/Sao_Paulo"


def test_consecutive_hours_are_one_hour_apart_in_utc() -> None:
    horizon = local_day(date(2026, 1, 15))
    gaps = {
        (b - a).total_seconds()
        for a, b in zip(horizon.starts_at, horizon.starts_at[1:], strict=False)
    }
    assert gaps == {3600.0}


def test_storage_stays_utc_while_indexing_is_local() -> None:
    """Local hour `t` names a UTC instant; nothing is stored in local time."""
    horizon = local_day(date(2026, 8, 29))
    local_hours = [moment.astimezone(GRID_ZONE).hour for moment in horizon.starts_at]
    assert local_hours == list(range(24))


def test_a_day_that_is_not_twenty_four_hours_long_stops_the_solve() -> None:
    """A DST transition inside the horizon is out of range for this product.

    Absorbing it silently would shorten the day and shift every hour index
    after the transition, which is the kind of error that produces a plausible
    plan for the wrong hours. `America/Sao_Paulo` last did this in 2018, before
    the data window opens, so the assertion is exercised on a date outside it.
    """
    with pytest.raises(OptimizerBugError, match="not 24 whole hours"):
        local_day(date(2018, 11, 4))


def test_a_zone_with_a_transition_is_refused_rather_than_reinterpreted() -> None:
    with pytest.raises(OptimizerBugError):
        local_day(date(2026, 3, 29), ZoneInfo("Europe/Lisbon"))
