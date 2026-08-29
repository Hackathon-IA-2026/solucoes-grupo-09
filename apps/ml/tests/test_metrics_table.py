"""The metrics table: the arithmetic, and the averages it refuses.

Every assertion here is about the *machinery* — the pinball definition, PR-AUC's
floor, and above all the reductions this table will not perform. None is about
accuracy, and none could be: the hours are constructed
(:func:`hours`), and a metrics table's job is to be a faithful instrument rather
than a flattering one.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import date, timedelta

import pytest

from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import FoldSegment, MixedFidelityError, RowKey
from wattsteer_ml.evaluation.metrics import (
    FIXED_OPERATING_POINT,
    MetricsError,
    MetricsRow,
    MetricsTable,
    OperatingPoint,
    RevisionPremium,
    best_operating_point,
    first_revision_premium,
    interval_width_mean_mwh,
    pinball,
    pinball_component,
    pr_auc,
    prevalence,
    qloss_mwh,
)
from wattsteer_ml.mixture import SERVED_QUANTILES
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.conformal import ScoredHour
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

THRESHOLD_MW = 5.0
HOURS_PER_DAY = 24

#: ``μ_sub`` as zeros. The tests here are about the metrics, and a non-zero
#: sub-threshold mean would move the expectation without moving one quantile.
FLAT_MU_SUB = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(HOURS_PER_DAY)) for _ in SUBSYSTEM_CODES)
)

FIXTURE_HASH = "sha256:" + "a" * 64


def segment(
    fold_id: str = "F1",
    *,
    first: date = date(2025, 4, 1),
    days: int = 2,
    fidelity: VintageFidelity = "point_in_time",
    is_split: bool = False,
) -> FoldSegment:
    return FoldSegment(
        fold_id=fold_id,
        row_id=f"{fold_id}@{fidelity}" if is_split else fold_id,
        fidelity=fidelity,
        test_start=first,
        test_end=first + timedelta(days=days - 1),
        is_split=is_split,
        fold_hash=FIXTURE_HASH,
    )


def hours(
    observations: Sequence[tuple[float, float, float, float, float]],
    *,
    first: date = date(2025, 4, 1),
) -> tuple[ScoredHour, ...]:
    """Scored hours from ``(p, q10, q50, q90, observed)`` tuples.

    Composed through :func:`~wattsteer_ml.training.hurdle.compose_estimates`, so
    the bands these metrics are computed over are the bands the product builds
    and not three floats a test invented.
    """
    keys: list[RowKey] = []
    day = first
    while len(keys) < len(observations):
        for hour in range(HOURS_PER_DAY):
            for code in SUBSYSTEM_CODES:
                if len(keys) < len(observations):
                    keys.append(RowKey(target_date=day, local_hour=hour, subsystem=code))
        day += timedelta(days=1)
    composed = compose_estimates(
        keys,
        [
            HourEstimates(
                occurrence_probability=p,
                q10=q10,
                q50=q50,
                q90=q90,
                positive_mean_mwh=q50,
            )
            for p, q10, q50, q90, _ in observations
        ],
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=THRESHOLD_MW,
    )
    return tuple(
        ScoredHour(key=hour.key, forecast=hour.forecast, observed_mwh=observed)
        for hour, (_, _, _, _, observed) in zip(composed, observations, strict=True)
    )


def row(
    scored: Sequence[ScoredHour],
    *,
    run: str = "A-full",
    rung: str = "lightgbm",
    rung_number: int = 4,
    on: FoldSegment | None = None,
) -> MetricsRow:
    return MetricsRow.of(
        scored,
        run=run,
        rung=rung,
        rung_number=rung_number,
        segment=on if on is not None else segment(),
    )


# --- the arithmetic ----------------------------------------------------------


@pytest.mark.parametrize(
    ("alpha", "observed", "predicted", "expected"),
    [
        (0.10, 10.0, 4.0, 0.6),
        (0.10, 4.0, 10.0, 5.4),
        (0.90, 10.0, 4.0, 5.4),
        (0.90, 4.0, 10.0, 0.6),
        (0.50, 7.0, 7.0, 0.0),
    ],
)
def test_pinball_is_the_specs_two_branches(
    alpha: float, observed: float, predicted: float, expected: float
) -> None:
    """``ρ_α(u) = u·α if u ≥ 0 else u·(α − 1)``, both branches non-negative."""
    assert pinball(alpha, observed, predicted) == pytest.approx(expected)


def test_qloss_is_the_mean_of_its_three_published_components() -> None:
    """The gate is exactly the average of the three columns beside it.

    A reader who adds up the components must land on ``qloss_mwh``; if they do
    not, one of the four numbers is describing a different population.
    """
    scored = hours([(0.8, 2.0, 9.0, 30.0, 12.0), (0.2, 1.0, 4.0, 20.0, 0.0)])
    components = [pinball_component(scored, alpha) for alpha in SERVED_QUANTILES]
    assert qloss_mwh(scored) == pytest.approx(sum(components) / 3.0)


def test_qloss_cannot_be_gamed_by_widening_the_band() -> None:
    """Pinball loss is proper: moving a quantile away from the truth costs.

    The property that makes ``qloss_mwh`` the gate rather than coverage. A
    candidate that widens its interval to cover everything scores *worse* here,
    which is precisely what a coverage-based gate would reward.
    """
    truthful = hours([(1.0, 8.0, 10.0, 12.0, 10.0)] * 8)
    widened = hours([(1.0, 6.0, 10.0, 40.0, 10.0)] * 8)
    assert qloss_mwh(widened) > qloss_mwh(truthful)


def test_pr_auc_sits_at_its_floor_for_a_model_that_cannot_rank() -> None:
    """A constant score scores its own prevalence, which is PR-AUC's floor.

    The reason prevalence is a column: a PR-AUC of 0.3 is excellent at 5%
    prevalence and worthless at 30%, and the number alone cannot say which.
    """
    quiet = [(0.4, 0.0, 0.0, 0.0, 0.0)] * 30
    loud = [(0.4, 0.0, 0.0, 0.0, 40.0)] * 10
    scored = hours([*quiet, *loud])
    assert prevalence(scored) == pytest.approx(0.25)
    assert pr_auc(scored) == pytest.approx(prevalence(scored))


def test_pr_auc_is_perfect_for_a_ranking_that_separates_the_classes() -> None:
    scored = hours(
        [*[(0.9, 0.0, 0.0, 0.0, 40.0)] * 10, *[(0.1, 0.0, 0.0, 0.0, 0.0)] * 30]
    )
    assert pr_auc(scored) == pytest.approx(1.0)


def test_pr_auc_is_absent_rather_than_zero_when_a_class_is_missing() -> None:
    """No score, not a bad score. A 0.0 would read as a failure that never ran."""
    assert pr_auc(hours([(0.4, 0.0, 0.0, 0.0, 0.0)] * 8)) is None


def test_the_operating_point_the_table_fixes_is_stated_on_the_row() -> None:
    """F1 at the calibrated 0.5, and the best F1 beside it, never above it.

    The best threshold is reported and never used, and the way this table keeps
    that honest is that both points carry their own threshold as a field.
    """
    scored = hours(
        [*[(0.7, 0.0, 0.0, 0.0, 40.0)] * 10, *[(0.6, 0.0, 0.0, 0.0, 0.0)] * 20]
    )
    fixed = OperatingPoint.of(scored, threshold=FIXED_OPERATING_POINT)
    best = best_operating_point(scored)
    assert fixed.threshold == FIXED_OPERATING_POINT
    assert best.f1 >= fixed.f1
    assert best.threshold > fixed.threshold


def test_interval_width_is_measured_over_every_settled_hour() -> None:
    """Sharpness, including the quiet hours a model could widen for free."""
    scored = hours([(1.0, 8.0, 10.0, 12.0, 10.0), (1.0, 6.0, 10.0, 14.0, 10.0)])
    assert interval_width_mean_mwh(scored) == pytest.approx(6.0)


# --- the refusals ------------------------------------------------------------


def test_a_row_refuses_an_hour_from_outside_its_segment() -> None:
    """The check that makes a split fold's two rows mean what they say."""
    scored = hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4, first=date(2025, 5, 1))
    with pytest.raises(MixedFidelityError, match="outside"):
        row(scored, on=segment(first=date(2025, 4, 1), days=2))


def test_a_row_over_no_settled_hour_is_refused_rather_than_zeroed() -> None:
    with pytest.raises(MetricsError, match="no settled hour"):
        row([])


def test_the_table_refuses_a_fold_reported_both_whole_and_split() -> None:
    """One of those two numbers averaged across ingestion go-live."""
    whole = row(hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4))
    half = MetricsRow.of(
        hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4),
        run="A-full",
        rung="lightgbm",
        rung_number=4,
        segment=segment(fidelity="revision_optimistic", is_split=True),
    )
    with pytest.raises(MixedFidelityError, match="whole fold"):
        MetricsTable(rows=(whole, half))


def test_the_table_refuses_the_same_rung_reported_twice_for_one_segment() -> None:
    one = row(hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4))
    with pytest.raises(MetricsError, match="twice"):
        MetricsTable(rows=(one, one))


def test_a_pooled_qloss_refuses_to_average_across_vintages() -> None:
    """`revision_optimistic` and `point_in_time` are two rows, never one number.

    Averaging is precisely how a caveat disappears, and the pooled number would
    be revision-optimistic with no way to say how much of it was.
    """
    early = MetricsRow.of(
        hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4, first=date(2025, 4, 1)),
        run="A-full",
        rung="lightgbm",
        rung_number=4,
        segment=segment("F1", first=date(2025, 4, 1), fidelity="revision_optimistic"),
    )
    late = MetricsRow.of(
        hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4, first=date(2025, 7, 1)),
        run="A-full",
        rung="lightgbm",
        rung_number=4,
        segment=segment("F2", first=date(2025, 7, 1), fidelity="point_in_time"),
    )
    table = MetricsTable(rows=(early, late))
    assert early.fidelity == "revision_optimistic"
    assert late.fidelity == "point_in_time"
    with pytest.raises(MixedFidelityError, match="do not share a vintage"):
        table.pooled_qloss(run="A-full", rung="lightgbm")


def test_a_pooled_qloss_is_hour_weighted_within_one_vintage() -> None:
    """Fold-weighting would silently reweight the live edge as it filled up."""
    wide = MetricsRow.of(
        hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 8, first=date(2025, 4, 1)),
        run="A-full",
        rung="lightgbm",
        rung_number=4,
        segment=segment("F1", first=date(2025, 4, 1)),
    )
    narrow = MetricsRow.of(
        hours([(0.9, 0.0, 6.0, 9.0, 7.0)] * 4, first=date(2025, 7, 1)),
        run="A-full",
        rung="lightgbm",
        rung_number=4,
        segment=segment("F2", first=date(2025, 7, 1)),
    )
    table = MetricsTable(rows=(wide, narrow))
    expected = (wide.qloss_mwh * 8 + narrow.qloss_mwh * 4) / 12
    assert table.pooled_qloss(run="A-full", rung="lightgbm") == pytest.approx(expected)
    assert table.pooled_fidelity(run="A-full", rung="lightgbm") == "point_in_time"


def test_a_ladder_delta_refuses_two_rungs_scored_on_different_segments() -> None:
    """Two rungs reporting one fold id under two calendars are not a delta.

    The segment hash is what notices — a live edge materialised on two different
    days carries the same fold id and different rows, and equal row counts would
    not have made them the same rows.
    """
    scored = hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4)
    served = row(scored)
    baseline = MetricsRow.of(
        hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4, first=date(2025, 7, 1)),
        run="A-full",
        rung="same_hour_7d",
        rung_number=1,
        segment=segment("F1", first=date(2025, 7, 1)),
    )
    table = MetricsTable(rows=(served, baseline))
    with pytest.raises(MetricsError, match="not the same rows"):
        table.delta_against(run="A-full", rung="lightgbm", baseline="same_hour_7d")


def test_a_ladder_delta_is_negative_when_the_rung_beat_the_baseline() -> None:
    truthful = hours([(1.0, 8.0, 10.0, 12.0, 10.0)] * 8)
    blunt = hours([(1.0, 0.0, 30.0, 60.0, 10.0)] * 8)
    table = MetricsTable(
        rows=(
            row(truthful),
            row(blunt, rung="prevalence", rung_number=0),
        )
    )
    deltas = table.delta_against(run="A-full", rung="lightgbm", baseline="prevalence")
    assert deltas["F1"] < 0.0


# --- the revision premium ----------------------------------------------------


def test_the_revision_premium_is_the_difference_between_two_label_vintages() -> None:
    """Positive means the honest scoring is worse — the size of the caveat."""
    as_ingested = row(hours([(0.8, 2.0, 9.0, 30.0, 20.0)] * 8))
    latest = row(hours([(0.8, 2.0, 9.0, 30.0, 10.0)] * 8))
    premium = RevisionPremium.of(as_ingested=as_ingested, latest_vintage=latest)
    assert premium.revision_premium_qloss == pytest.approx(
        as_ingested.qloss_mwh - latest.qloss_mwh
    )
    assert premium.revision_premium_qloss > 0.0
    assert premium.as_card_entry()["revision_premium_fold"] == "F1"


def test_the_revision_premium_refuses_two_different_folds() -> None:
    left = row(hours([(0.8, 2.0, 9.0, 30.0, 20.0)] * 8))
    right = MetricsRow.of(
        hours([(0.8, 2.0, 9.0, 30.0, 10.0)] * 8, first=date(2025, 7, 1)),
        run="A-full",
        rung="lightgbm",
        rung_number=4,
        segment=segment("F2", first=date(2025, 7, 1)),
    )
    with pytest.raises(MetricsError, match="differ in row_id"):
        RevisionPremium.of(as_ingested=left, latest_vintage=right)


def test_the_revision_premium_refuses_two_different_row_counts() -> None:
    """A premium over two row sets measures the rows, not the vintages."""
    left = row(hours([(0.8, 2.0, 9.0, 30.0, 20.0)] * 8))
    right = row(hours([(0.8, 2.0, 9.0, 30.0, 10.0)] * 6))
    with pytest.raises(MetricsError, match="two different row sets"):
        RevisionPremium.of(as_ingested=left, latest_vintage=right)


def test_the_premium_is_published_for_the_first_fold_in_both_vintages() -> None:
    """First by test-period start, not by the order the tables were built."""
    late = segment("F2", first=date(2025, 7, 1))
    early = segment("F1", first=date(2025, 4, 1))
    as_ingested = MetricsTable(
        rows=(
            MetricsRow.of(
                hours([(0.8, 2.0, 9.0, 30.0, 20.0)] * 8, first=date(2025, 7, 1)),
                run="A-full",
                rung="lightgbm",
                rung_number=4,
                segment=late,
            ),
            MetricsRow.of(
                hours([(0.8, 2.0, 9.0, 30.0, 20.0)] * 8, first=date(2025, 4, 1)),
                run="A-full",
                rung="lightgbm",
                rung_number=4,
                segment=early,
            ),
        )
    )
    latest = MetricsTable(
        rows=(
            MetricsRow.of(
                hours([(0.8, 2.0, 9.0, 30.0, 10.0)] * 8, first=date(2025, 4, 1)),
                run="A-full",
                rung="lightgbm",
                rung_number=4,
                segment=early,
            ),
        )
    )
    premium = first_revision_premium(as_ingested=as_ingested, latest_vintage=latest)
    assert premium is not None
    assert premium.fold_id == "F1"


def test_no_premium_is_invented_when_no_fold_exists_in_both_vintages() -> None:
    """Reported as absence, and never as a zero premium."""
    one = MetricsTable(rows=(row(hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4)),))
    other = MetricsTable(
        rows=(
            MetricsRow.of(
                hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4, first=date(2025, 7, 1)),
                run="A-full",
                rung="lightgbm",
                rung_number=4,
                segment=segment("F2", first=date(2025, 7, 1)),
            ),
        )
    )
    assert first_revision_premium(as_ingested=one, latest_vintage=other) is None


# --- the published row -------------------------------------------------------


def test_every_published_row_names_the_vintage_of_the_rows_behind_it() -> None:
    """`vintage_fidelity` is never averaged, so it is never absent either."""
    published = row(hours([(0.5, 0.0, 6.0, 9.0, 7.0)] * 4)).as_card_entry()
    assert published["vintage_fidelity"] == "point_in_time"
    assert published["row_id"] == "F1"
    assert math.isfinite(published["qloss_mwh"])
    for column in ("prevalence", "brier", "pinball_10", "pinball_50", "pinball_90"):
        assert math.isfinite(published[column])
    assert "f1@0.5" in published
    assert "threshold@best" in published
    assert "share_p50_zero" in published
