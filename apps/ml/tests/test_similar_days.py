"""The analogue: how a day is reduced, and what must never be reported as one."""

from __future__ import annotations

from datetime import date

import pytest

from wattsteer_ml.similar_days import (
    FEATURES,
    OUTCOME,
    DayVector,
    SimilarDaysError,
    day_vectors,
    nearest,
)


def hour(day: date, *, residual: float, wind: float, solar: float,
         surplus: float, utilisation: float, outcome: float | None) -> dict[str, object]:
    return {
        "target_date": day,
        "dessem_residual_load_mwh": residual,
        "dessem_wind_mwh": wind,
        "dessem_solar_mwh": solar,
        "dessem_vre_surplus_mwh": surplus,
        "dessem_export_utilisation": utilisation,
        OUTCOME: outcome,
    }


def day(value: date, *, residual: float, outcome: float | None = 0.0) -> DayVector:
    return DayVector(
        target_date=value,
        values=(residual, 0.0, 0.0, 0.0, 0.0, residual),
        outcome_mwh=outcome,
        hours=24,
    )


def test_every_feature_is_known_at_the_gate() -> None:
    # The property that makes the search a question about tomorrow rather than
    # a lookup of days that turned out alike: nothing settled is in the vector.
    assert all(column.startswith("dessem_") for column, _ in FEATURES)


def test_a_day_is_the_sum_of_its_hours_and_the_trough_is_the_minimum() -> None:
    rows = [
        hour(date(2026, 5, 1), residual=10, wind=1, solar=2, surplus=3,
             utilisation=0.5, outcome=4),
        hour(date(2026, 5, 1), residual=30, wind=1, solar=2, surplus=3,
             utilisation=0.7, outcome=6),
    ]
    [vector] = day_vectors(rows)
    assert vector.values[0] == 40.0  # residual, summed
    assert vector.values[4] == pytest.approx(0.6)  # utilisation, meaned
    assert vector.values[5] == 10.0  # residual, the trough
    assert vector.outcome_mwh == 10.0
    assert vector.hours == 2


def test_a_day_missing_one_coordinate_is_dropped_rather_than_imputed() -> None:
    # A zero here would move the day in the space by an amount nobody chose,
    # and the whole claim is that the neighbour is *like* the target.
    rows = [
        hour(date(2026, 5, 1), residual=10, wind=1, solar=2, surplus=3,
             utilisation=0.5, outcome=4),
    ]
    rows[0]["dessem_vre_surplus_mwh"] = None
    assert day_vectors(rows) == []


def test_an_unsettled_day_has_no_outcome_and_is_not_a_neighbour() -> None:
    rows = [
        hour(date(2026, 9, 19), residual=10, wind=1, solar=2, surplus=3,
             utilisation=0.5, outcome=None),
    ]
    [vector] = day_vectors(rows)
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
    pool = [target, day(date(2026, 5, 1), residual=10, outcome=5),
            day(date(2026, 5, 3), residual=140, outcome=40)]
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
