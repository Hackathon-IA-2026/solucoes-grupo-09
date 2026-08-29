"""Whether a P50-planned day has an hour to act in — the number ticket 011 is owed.

The first test here is the one that matters most, and it is deliberately an
assertion about *arithmetic* rather than a measurement: the optimizer called the
P10 collapse a falsifiable prediction, and it is not falsifiable — ``Q_Y(q) = 0``
for every ``q ≤ 1 − p``, so P10 is zero exactly when ``p ≤ 0.90`` and P50 exactly
when ``p ≤ 0.50``. Everything else here is about the counting rule: over days,
never over hours, with an incomplete day excluded and counted.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta

import pytest

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.evaluation.collapse import (
    POOLED_LABEL,
    CollapseBlock,
    CollapseError,
    HoursPerDay,
    P50Collapse,
)
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.hurdle import HourEstimates, HourForecast, compose_estimates

HOURS_PER_DAY = 24
THRESHOLD_MW = 5.0

FLAT_MU_SUB = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(HOURS_PER_DAY)) for _ in SUBSYSTEM_CODES)
)


def served(
    probabilities: Sequence[float],
    *,
    day: date = date(2025, 4, 1),
    subsystem: Subsystem = "NE",
    magnitude: float = 40.0,
) -> tuple[HourForecast, ...]:
    """One day of composed hours for one subsystem, at the given ``p`` per hour."""
    keys = [
        RowKey(target_date=day, local_hour=hour, subsystem=subsystem)
        for hour in range(len(probabilities))
    ]
    return compose_estimates(
        keys,
        [
            HourEstimates(
                occurrence_probability=p,
                q10=magnitude,
                q50=magnitude,
                q90=magnitude,
                positive_mean_mwh=magnitude,
            )
            for p in probabilities
        ],
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=THRESHOLD_MW,
    )


def test_p10_is_zero_exactly_below_0_90_and_p50_exactly_below_0_50() -> None:
    """Asserted as arithmetic, not measured as an empirical claim.

    `flex-optimizer.md` rejected planning on P10 on this ground and called it a
    falsifiable prediction. It is not falsifiable: it falls out of the mixture
    inversion, and the same inversion runs one notch weaker against the P50
    posture the optimizer did choose.

    The inequality is asserted as the composition spells it — ``α ≤ 1 − p`` —
    and not as the prose's ``p ≤ 0.90``. Those two are the same statement in
    real arithmetic and not in floating point: ``1 − 0.9`` is
    ``0.09999999999999998``, so at exactly ``p = 0.9`` the composed P10 is
    non-zero. That is a property of binary floats and not a modelling decision,
    and a test written against the prose would be asserting that IEEE 754 is
    something other than what it is.
    """
    probabilities = [round(step / 100.0, 2) for step in range(101)]
    forecasts = [
        forecast
        for offset in range(0, len(probabilities), HOURS_PER_DAY)
        for forecast in served(
            probabilities[offset : offset + HOURS_PER_DAY],
            day=date(2025, 4, 1) + timedelta(days=offset // HOURS_PER_DAY),
        )
    ]
    assert len(forecasts) == len(probabilities)
    for forecast in forecasts:
        p = forecast.forecast.occurrence_probability
        band = forecast.forecast.band
        assert (band.p10 == 0.0) is (1.0 - p >= 0.10)
        assert (band.p50 == 0.0) is (1.0 - p >= 0.50)
        assert (band.p90 == 0.0) is (1.0 - p >= 0.90)
    quiet = [one for one in forecasts if one.forecast.occurrence_probability <= 0.4]
    assert quiet and all(one.forecast.band.p50 == 0.0 for one in quiet)
    loud = [one for one in forecasts if one.forecast.occurrence_probability >= 0.95]
    assert loud and all(one.forecast.band.p10 > 0.0 for one in loud)


def test_the_deliverable_is_counted_over_days_and_not_over_hours() -> None:
    """One actionable hour is enough for a day not to have collapsed.

    An hour-wise share would have called this day 96% blind; the optimizer's
    question is whether there is anything to plan *at all* on the day, and the
    answer here is yes.
    """
    barely = served([0.9] + [0.1] * 23)
    blind = served([0.1] * 24, day=date(2025, 4, 2))
    block = P50Collapse.of([*barely, *blind], label=POOLED_LABEL)
    assert block is not None
    assert block.days == 2
    assert block.share_of_days_with_no_non_zero_p50_hour == pytest.approx(0.5)
    assert block.share_of_hours_with_p50_zero == pytest.approx(47 / 48)


def test_a_day_with_no_full_band_is_excluded_and_counted_separately() -> None:
    """Never silently read as a collapse — that would score the ingest."""
    whole = served([0.1] * 24)
    partial = served([0.9] * 6, day=date(2025, 4, 2))
    block = P50Collapse.of([*whole, *partial], label=POOLED_LABEL)
    assert block is not None
    assert block.days == 1
    assert block.days_excluded_incomplete == 1
    assert block.share_of_days_with_no_non_zero_p50_hour == pytest.approx(1.0)


def test_hours_per_day_carries_three_numbers_and_not_a_mean_alone() -> None:
    """Twelve days of four and twelve of none has the same mean as all twos."""
    lumpy = HoursPerDay.of([4] * 12 + [0] * 12)
    even = HoursPerDay.of([2] * 24)
    assert lumpy.mean == pytest.approx(even.mean)
    assert (lumpy.p25, lumpy.p75) != (even.p25, even.p75)


def test_the_two_hours_per_day_figures_count_the_thresholds_they_are_named_for() -> None:
    hours = served([0.95] * 4 + [0.6] * 6 + [0.1] * 14)
    block = P50Collapse.of(hours, label=POOLED_LABEL)
    assert block is not None
    assert block.hours_per_day_p_ge_50.mean == pytest.approx(10.0)
    assert block.hours_per_day_p_ge_90.mean == pytest.approx(4.0)


def test_the_block_publishes_the_pooled_figure_and_the_four_subsystems() -> None:
    """A pooled 0.5 could be 0.05 in NE and 0.95 in S, and those are different
    instructions to the optimizer."""
    loud = served([0.95] * 24, subsystem="NE")
    quiet = served([0.05] * 24, subsystem="S")
    block = CollapseBlock.of([*loud, *quiet])
    assert block is not None
    assert block.pooled.label == POOLED_LABEL
    by_label = {cell.label: cell for cell in block.by_subsystem}
    assert by_label["NE"].share_of_days_with_no_non_zero_p50_hour == 0.0
    assert by_label["S"].share_of_days_with_no_non_zero_p50_hour == 1.0
    assert "S" in by_label and "N" not in by_label


def test_nothing_measured_is_reported_as_absent_rather_than_as_zero() -> None:
    """A zero share of collapsed days and no days at all are opposite readings."""
    assert P50Collapse.of([], label=POOLED_LABEL) is None
    assert CollapseBlock.of([]) is None
    assert P50Collapse.of(served([0.5] * 6), label=POOLED_LABEL) is None
    with pytest.raises(CollapseError, match="no complete day"):
        HoursPerDay.of([])


def test_the_published_block_names_its_counting_rule() -> None:
    """The optimizer reads this without knowing the harness exists."""
    hours = [
        forecast
        for offset in range(3)
        for forecast in served([0.2] * 24, day=date(2025, 4, 1) + timedelta(days=offset))
    ]
    block = CollapseBlock.of(hours)
    assert block is not None
    published = block.as_card_entry()
    assert published["p50_collapse"]["share_of_days_with_no_non_zero_p50_hour"] == 1.0
    assert set(published["p50_collapse"]["hours_per_day_p_ge_50"]) == {
        "mean",
        "p25",
        "p75",
    }
    assert "days_excluded_incomplete" in published["p50_collapse_note"]
