"""The analogue: how a day is reduced, and what must never be reported as one."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from wattsteer_ml.similar_days import (
    FEATURES,
    MIN_HALF_HOURS,
    DayVector,
    SimilarDaysError,
    nearest,
    pool_vectors,
)


def programme_row(
    value: date,
    *,
    demand: float = 1000.0,
    wind: float = 200.0,
    solar: float = 100.0,
    mmgd: float = 50.0,
    residual_mean: float | None = None,
    residual_min: float | None = None,
    half_hours: int = MIN_HALF_HOURS,
) -> dict[str, object]:
    """One grouped row, in the shape `POOL_SQL` returns."""
    base = demand - wind - solar - mmgd
    return {
        "target_date": value,
        "demand_mw": demand,
        "wind_generation_mw": wind,
        "solar_generation_mw": solar,
        "mmgd_generation_mw": mmgd,
        "residual_load_mean_mw": base if residual_mean is None else residual_mean,
        "residual_load_min_mw": base if residual_min is None else residual_min,
        "half_hours": half_hours,
    }


def day(value: date, *, residual: float, outcome: float | None = 0.0) -> DayVector:
    return DayVector(
        target_date=value,
        values=(0.0, 0.0, 0.0, 0.0, residual, residual),
        outcome_mwh=outcome,
        hours=24,
    )


def test_every_feature_is_known_at_the_gate() -> None:
    # The property that makes the search a question about tomorrow rather than
    # a lookup of days that turned out alike: nothing settled is in the vector.
    # Every column below is one the day-ahead programme publishes on D−1.
    assert [column for column, _ in FEATURES] == [
        "demand_mw",
        "wind_generation_mw",
        "solar_generation_mw",
        "mmgd_generation_mw",
        "residual_load_mw",
        "residual_load_mw",
    ]
    assert not any("constrained_off" in column for column, _ in FEATURES)


def test_every_coordinate_is_a_mean_or_a_minimum_never_a_sum() -> None:
    # The balance publishes instantaneous MW at a half-hourly grain. Adding MW
    # across half hours is neither a power nor an energy; a mean of powers is a
    # power and a minimum of powers is a power.
    assert {how for _, how in FEATURES} == {"mean", "min"}


def test_a_day_carries_the_programme_s_means_and_its_trough() -> None:
    rows = [
        programme_row(
            date(2026, 5, 1), demand=1000, wind=200, solar=100, mmgd=50, residual_min=410
        )
    ]
    [vector] = pool_vectors(rows, {date(2026, 5, 1): 1234.0})
    assert vector.values[0] == 1000.0
    assert vector.values[4] == 650.0  # 1000 − 200 − 100 − 50
    assert vector.values[5] == 410.0  # the trough, which the day's mean hides
    assert vector.outcome_mwh == 1234.0
    assert vector.hours == 24


def test_a_half_published_day_is_dropped_rather_than_averaged() -> None:
    # A mean over four half hours describes the hours ONS happened to publish
    # and would be read as describing the day.
    rows = [programme_row(date(2026, 5, 1), half_hours=4)]
    assert pool_vectors(rows, {}) == []


def test_a_day_with_no_curtailment_row_is_not_offered_with_an_invented_zero() -> None:
    """ONS publishes no row for a day that curtailed nothing.

    So "not settled yet" and "settled at zero" arrive identically here, and this
    module refuses to guess between them: the day keeps `outcome_mwh = None` and
    is never offered as a neighbour. Offering it with an outcome of 0 MWh would
    be asserting a measurement nobody made.
    """
    [vector] = pool_vectors([programme_row(date(2026, 9, 19))], {})
    assert vector.outcome_mwh is None
    # Tomorrow cannot be its own evidence.
    assert nearest(vector, [vector]) == []


def test_the_nearest_day_is_the_one_that_looked_most_alike() -> None:
    target = day(date(2026, 9, 19), residual=100, outcome=None)
    pool = [
        day(date(2026, 5, 1), residual=10, outcome=5),
        day(date(2026, 5, 2), residual=98, outcome=900),
        day(date(2026, 5, 3), residual=140, outcome=40),
    ]
    [first, second] = nearest(target, pool, k=2)
    assert first.target_date == date(2026, 5, 2)
    assert first.outcome_mwh == 900
    assert second.target_date == date(2026, 5, 3)
    assert first.distance < second.distance


def test_a_day_is_never_its_own_analogue() -> None:
    # True at distance zero and useless. The pool comes from a range the caller
    # chose, so the target can be in it — and removing it must leave enough days
    # behind to still define a scale, which is why there are three here.
    target = day(date(2026, 5, 2), residual=98, outcome=900)
    pool = [
        target,
        day(date(2026, 5, 1), residual=10, outcome=5),
        day(date(2026, 5, 3), residual=140, outcome=40),
    ]
    dates = [neighbour.target_date for neighbour in nearest(target, pool, k=5)]
    assert date(2026, 5, 2) not in dates
    assert dates == [date(2026, 5, 3), date(2026, 5, 1)]


def test_an_unsettled_pool_day_is_not_offered_as_evidence() -> None:
    target = day(date(2026, 9, 19), residual=100, outcome=None)
    pool = [day(date(2026, 9, 18), residual=100, outcome=None)]
    assert nearest(target, pool) == []


def test_a_pool_with_no_variance_reports_nothing_rather_than_a_coin_toss() -> None:
    # Every day identical on every coordinate: there is no "most similar", and
    # an arbitrary date at distance zero would read as a finding.
    target = day(date(2026, 9, 19), residual=50, outcome=None)
    pool = [day(date(2026, 5, d), residual=50, outcome=float(d)) for d in (1, 2, 3)]
    assert nearest(target, pool) == []


def test_ties_break_on_the_date_so_the_answer_is_stable() -> None:
    target = day(date(2026, 9, 19), residual=100, outcome=None)
    pool = [
        day(date(2026, 5, 9), residual=110, outcome=1),
        day(date(2026, 5, 2), residual=90, outcome=2),
        day(date(2026, 5, 5), residual=200, outcome=3),
    ]
    [first] = nearest(target, pool, k=1)
    # Both are 10 away. The earlier date wins, every time, whatever order the
    # pool arrived in.
    assert first.target_date == date(2026, 5, 2)


def test_k_below_one_is_refused_rather_than_answered_with_nothing() -> None:
    with pytest.raises(SimilarDaysError):
        nearest(day(date(2026, 9, 19), residual=1, outcome=None), [], k=0)


def test_fewer_days_than_asked_for_returns_what_there_is() -> None:
    target = day(date(2026, 9, 19), residual=100, outcome=None)
    pool = [day(date(2026, 5, d), residual=10.0 * d, outcome=float(d)) for d in (1, 2)]
    assert len(nearest(target, pool, k=9)) == 2


def test_one_settled_day_is_not_an_analogue_because_there_is_no_scale() -> None:
    """A distance needs a scale and a scale needs a spread.

    One day has none, so every coordinate is dropped and nothing is reported.
    That is stricter than "return the only candidate" on purpose: the claim this
    read makes is *how alike* two days are, and with one day in the pool there
    is nothing to measure alikeness against. The absence is said in words by the
    route rather than filled with the only date available.
    """
    target = day(date(2026, 9, 19), residual=100, outcome=None)
    assert nearest(target, [day(date(2026, 5, 1), residual=10, outcome=5)], k=9) == []


def test_the_route_reads_inside_a_transaction() -> None:
    """The axes are transaction-local, and the route was not in one.

    `apply_axes` writes every axis with `set_config(..., true)`. On an
    autocommit connection each statement is its own transaction, so the setting
    is discarded before the next statement runs and the canonical view raises
    `canonical read attempted with no as_of`. Production answered exactly that,
    and nothing in this file could have: every other test here is over pure
    functions, and the defect lives in how they are called.

    So this is a source-level guard, in the style the gateway's suite uses for
    the same class of rule: the two reads and the `apply_axes` that arms them
    must sit inside one `conn.transaction()`.
    """
    source = (
        Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml" / "app.py"
    ).read_text(encoding="utf-8")
    route = source[source.index("async def similar_days_route") :]
    route = route[: route.index("\n@app.")]

    opened = route.index("async with conn.transaction():")
    assert opened < route.index("await apply_axes(")
    assert opened < route.index("POOL_SQL")
    assert opened < route.index("OUTCOME_SQL")
