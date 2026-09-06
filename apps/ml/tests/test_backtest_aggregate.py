"""The Backtest, over days the replay path scored — and the caveat it cannot lose.

Replay ticket 08. `docs/specs/replay.md`'s seam 9 in the aggregate's half: **a
Backtest never averages across `VintageFidelity` values — asserted structurally,
by making the aggregation function take fidelity as a group key rather than
filtering on it. A fold straddling go-live emits two rows.**

Structurally is the word that decides what the tests here are. Asserting that
one call returned two rows would leave the property one refactor from gone, so
three of these read the *source* of
:mod:`wattsteer_ml.replay.backtest`: that it takes no fidelity to filter on,
that it names no fidelity value anywhere in its code, and that every figure it
publishes comes from :func:`~wattsteer_ml.replay.scoring.score_replay` rather
than from a second scoring implementation on the aggregate's side of the seam.

The days themselves are real replays: :func:`~wattsteer_ml.replay.calendar.resolve_day`
decides each one's fidelity from the go-live instant, exactly as the calendar
route does, and :func:`~wattsteer_ml.replay.scoring.score_replay` scores it
against the published ``REFERENCE_FLEET``. Nothing here hand-builds a
:class:`~wattsteer_ml.replay.scoring.ReplayScores`, because a hand-built one
would let the aggregate be tested against numbers no replay produces.
"""

from __future__ import annotations

import ast
import inspect
from datetime import UTC, date, datetime, timedelta
from typing import Any, get_args

import pytest

from wattsteer_ml.canonical import VintageFidelity, VintageSource
from wattsteer_ml.evaluation.folds import FOLD_CALENDAR_RULES, materialize_fold_calendar
from wattsteer_ml.evaluation.vintage import (
    FoldSegment,
    MixedFidelityError,
    stamp_calendar,
)
from wattsteer_ml.lanes import Lane
from wattsteer_ml.mixture import QuantileBand
from wattsteer_ml.replay import backtest as backtest_module
from wattsteer_ml.replay.backtest import (
    Backtest,
    BacktestDay,
    BacktestError,
    BacktestMetrics,
    BacktestRow,
    Distribution,
    SubsystemCoverage,
    aggregate_backtest,
    segment_for,
)
from wattsteer_ml.replay.calendar import HOURS_PER_DAY, DayEvidence, resolve_day
from wattsteer_ml.replay.cards import ArtifactWindows
from wattsteer_ml.replay.inputs import read_replay_inputs
from wattsteer_ml.replay.scoring import (
    ForecastHour,
    ObservedDay,
    PinnedForecast,
    PinnedOrigin,
    ReplayScores,
    score_replay,
)
from wattsteer_ml.replay.shortlist import reference_fleet_hash, reference_fleet_scenario

SUBSYSTEM = "NE"
THRESHOLD_MW = 5.0
LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
PRODUCER = "wattsteer"
BACKFILLED = "backfilled_holdout"

#: The window the aggregate is computed over: F1 through F6, the last of them
#: truncated at the newest settled target date.
LATEST = date(2026, 8, 31)
AS_OF = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)

#: Ingestion go-live, mid-F3. Chosen so that one fold of the calendar straddles
#: it, which is the case the two rules exist for. No date in `backtest.py`
#: knows this instant; it arrives as a `VintageSource`, the way the real one
#: arrives from `canonical_read_go_live`.
GO_LIVE = datetime(2025, 11, 16, 3, 0, tzinfo=UTC)
SOURCES = (
    VintageSource(
        read="constrained_off",
        vintage_fidelity="point_in_time",
        go_live_at=GO_LIVE,
    ),
)

#: One card, whose two windows close before every day these tests replay, so
#: every one of them is held out and none of them is a leak.
WINDOWS = ArtifactWindows(
    artifact_id="F3__2025-10-01T03:10:00Z",
    fold_id="F3",
    lane=LANE.directory_name,
    train_start=date(2024, 4, 1),
    train_end=date(2025, 9, 30),
    calibration_start=date(2025, 7, 3),
    calibration_end=date(2025, 9, 30),
)

#: Three curtailed hours in an otherwise quiet day, the shape `replay.md`'s
#: worked example uses.
CURTAILED_HOURS = (10, 11, 12)


def profile(values: tuple[float, ...]) -> tuple[float, ...]:
    hours = [0.0] * HOURS_PER_DAY
    for hour, value in zip(CURTAILED_HOURS, values, strict=True):
        hours[hour] = value
    return tuple(hours)


def pinned(target_date: date, p50: tuple[float, ...]) -> PinnedForecast:
    p10 = tuple(value * 0.5 for value in p50)
    p90 = tuple(value * 1.5 for value in p50)
    return PinnedForecast(
        subsystem=SUBSYSTEM,
        target_date=target_date,
        threshold_mw=THRESHOLD_MW,
        origin=PinnedOrigin(
            producer=PRODUCER,
            run_label=WINDOWS.artifact_id,
            published_at=datetime.combine(
                target_date - timedelta(days=1), datetime.min.time(), tzinfo=UTC
            )
            + timedelta(hours=22),
            origin_kind=BACKFILLED,
            gate_profile=LANE.gate_profile,
        ),
        hours=tuple(
            ForecastHour(
                constrained_off_mwh=QuantileBand(p10=low, p50=mid, p90=high),
                expected_mwh=mid,
                occurrence_probability=1.0 if mid > 0 else 0.1,
            )
            for low, mid, high in zip(p10, p50, p90, strict=True)
        ),
        # The path ensemble's joint day total, never a sum of quantiles.
        day_total=QuantileBand(p10=sum(p10) * 0.8, p50=sum(p50), p90=sum(p90) * 0.9),
        peak_power=QuantileBand(p10=max(p10), p50=max(p50), p90=max(p90)),
        day_occurrence_probability=0.9,
    )


def replayed(
    target_date: date,
    *,
    p50: tuple[float, ...] = (40.0, 100.0, 60.0),
    observed: tuple[float, ...] = (20.0, 160.0, 60.0),
    sources: tuple[VintageSource, ...] = SOURCES,
) -> ReplayScores:
    """One day, through the calendar's predicate and the endpoint's scorer."""
    day = resolve_day(
        DayEvidence(
            target_date=target_date,
            origin_kind=BACKFILLED,
            artifact_id=WINDOWS.artifact_id,
            observed_hours=HOURS_PER_DAY,
            candidate_lanes=(LANE.directory_name,),
        ),
        subsystem=SUBSYSTEM,
        lane=LANE.directory_name,
        rules=FOLD_CALENDAR_RULES,
        latest=LATEST,
        windows=WINDOWS,
        sources=sources,
    )
    return score_replay(
        reference_fleet_scenario(SUBSYSTEM, target_date),
        day=day,
        windows=WINDOWS,
        forecast=pinned(target_date, profile(p50)),
        observed=ObservedDay(
            subsystem=SUBSYSTEM,
            target_date=target_date,
            hours=profile(observed),
            data_version="1",
        ),
    )


def days(*dates: date, **kwargs: Any) -> tuple[BacktestDay, ...]:
    return tuple(
        BacktestDay(subsystem=SUBSYSTEM, scores=replayed(one, **kwargs)) for one in dates
    )


def segments(go_live: datetime | None = GO_LIVE) -> tuple[FoldSegment, ...]:
    """The calendar's rows: one per fold, two for the one that straddles."""
    return stamp_calendar(
        materialize_fold_calendar(LATEST + timedelta(days=1), FOLD_CALENDAR_RULES),
        go_live,
    )


def aggregate(
    population: tuple[BacktestDay, ...],
    *,
    rows: tuple[FoldSegment, ...] | None = None,
) -> Backtest:
    return aggregate_backtest(
        population,
        segments=rows if rows is not None else segments(),
        lane=LANE.directory_name,
        as_of=AS_OF,
        window_start=FOLD_CALENDAR_RULES.window_start,
        window_end=LATEST,
    )


#: Two days each side of go-live, inside F3, plus two inside F4.
BEFORE_GO_LIVE = (date(2025, 10, 20), date(2025, 11, 4))
AFTER_GO_LIVE = (date(2025, 11, 20), date(2025, 12, 9))
IN_F4 = (date(2026, 1, 15), date(2026, 2, 10))


# --- the two rules ------------------------------------------------------------


def test_a_fold_straddling_go_live_is_two_rows_and_never_one() -> None:
    """The first rule, on the fold the go-live instant cuts in half.

    F3's test period opens before ingestion go-live and closes after it, so the
    quarter is reported as `F3@revision_optimistic` and `F3@point_in_time` —
    two rows carrying two caveats, rather than one row carrying a mean of them.
    """
    result = aggregate(days(*BEFORE_GO_LIVE, *AFTER_GO_LIVE))

    f3 = result.rows_of("F3")
    assert len(f3) == 2, "the straddling fold was reported as one row"
    assert {row.vintage_fidelity for row in f3} == {
        "revision_optimistic",
        "point_in_time",
    }
    assert {row.days_replayed for row in f3} == {2}
    assert result.row("F3@revision_optimistic").segment.test_end == date(2025, 11, 15)
    assert result.row("F3@point_in_time").segment.test_start == date(2025, 11, 16)


def test_both_halves_are_reported_even_when_only_one_of_them_replayed() -> None:
    """A half with no days is an absence with a caveat, not a missing row.

    Dropping it would leave `F3@revision_optimistic` alone in the table, which
    reads as an unsplit fold — and an unsplit F3 is a fold whose point-in-time
    days were averaged into its revision-optimistic ones.
    """
    result = aggregate(days(*BEFORE_GO_LIVE))

    f3 = result.rows_of("F3")
    assert len(f3) == 2
    empty = result.row("F3@point_in_time")
    assert empty.days_replayed == 0
    # Absent, and never a row of zeros: "no days were replayed here" and "the
    # fleet recovered nothing here" are opposite readings.
    assert empty.metrics is None
    assert empty.by_subsystem == ()


def test_a_day_cannot_join_a_row_whose_fidelity_is_not_its_own() -> None:
    """The second rule, at the one place a day could cross the boundary.

    The days below are `point_in_time` — their own dates follow go-live — and
    the segments offered come from a calendar stamped with *no* go-live, so
    every one of them is `revision_optimistic`. That disagreement means the two
    labels were computed against different go-lives, and putting the day in the
    row anyway is exactly how a caveat is laundered.
    """
    population = days(*AFTER_GO_LIVE)
    assert {day.vintage_fidelity for day in population} == {"point_in_time"}

    with pytest.raises(MixedFidelityError, match="disagree about the vintage"):
        aggregate(population, rows=segments(go_live=None))

    # And the same refusal at the grouping function itself, so it is a property
    # of the key rather than of the caller that happened to build it.
    with pytest.raises(MixedFidelityError):
        segment_for(population[0], segments(go_live=None))


def test_every_day_lands_in_a_row_carrying_its_own_fidelity() -> None:
    """What the group key buys, stated as the invariant it produces."""
    population = days(*BEFORE_GO_LIVE, *AFTER_GO_LIVE, *IN_F4)
    result = aggregate(population)

    for row in result.rows:
        assert row.vintage_fidelity in get_args(VintageFidelity)
    for day in population:
        row = result.row(segment_for(day, segments()).row_id)
        assert row.vintage_fidelity == day.vintage_fidelity


# --- structural: fidelity is a group key, not a filter ------------------------


def test_the_aggregation_function_takes_fidelity_as_a_group_key() -> None:
    """The ticket's own wording, asserted on the signature.

    ``segments`` is a sequence of :class:`FoldSegment`, and a segment *is* a
    (fold, fidelity) pair — so grouping by it stamps every row. There is no
    parameter to pass a fidelity to, which is what makes filtering on one
    unreachable rather than discouraged.
    """
    signature = inspect.signature(aggregate_backtest)
    assert "segments" in signature.parameters
    assert signature.parameters["segments"].annotation == "Sequence[FoldSegment]", (
        "the group key must be the segment, which carries the fidelity"
    )
    for name in signature.parameters:
        assert "fidelity" not in name, (
            f"{name} would let a caller filter the aggregate by fidelity, and a "
            "filtered aggregate is one whose other fidelity vanished silently"
        )


def test_no_code_path_in_the_aggregate_names_a_fidelity_value() -> None:
    """The stronger half: the module cannot branch on a caveat it never spells.

    Every ``VintageFidelity`` value in `backtest.py` is in a docstring or a
    comment. Nothing executable compares against one, so there is no
    ``if fidelity == "point_in_time"`` to grow a filter out of — the only
    comparison of two fidelities in the module is day-against-key, in
    :func:`segment_for`, and it *raises*.
    """
    tree = ast.parse(inspect.getsource(backtest_module))
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef)
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
    }
    literals = [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]
    assert not set(literals) & set(get_args(VintageFidelity)), (
        "the aggregate names a fidelity value in code; fidelity reaches it on "
        "the group key and nowhere else"
    )


def test_every_metric_is_produced_by_the_one_replay_path() -> None:
    """The aggregate imports the replay path; it does not re-derive it.

    Read off the source, because "we reuse the replay" is a property of the
    file: an aggregate that grew its own loop over hours would still return
    floats, and the drift would only show up as a Backtest number that no
    replay of the same day reproduces.
    """
    tree = ast.parse(inspect.getsource(backtest_module))
    imported = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    }
    assert {"score_replay", "read_replay_inputs"} <= imported
    assert vars(backtest_module)["score_replay"] is score_replay
    assert vars(backtest_module)["read_replay_inputs"] is read_replay_inputs
    defined = {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    }
    assert not defined & {
        "score_replay",
        "simulate",
        "score_band",
        "build_plan",
        "_score",
    }, "a second scoring implementation on the aggregate's side of the seam"


def test_the_reference_fleet_is_stamped_on_every_aggregate() -> None:
    """`replay.md` story 35: one published constant, in one place, on the answer."""
    result = aggregate(days(*IN_F4))
    assert result.reference_fleet_hash == reference_fleet_hash()
    assert result.as_payload(AS_OF)["reference_fleet_hash"] == reference_fleet_hash()


# --- the table, at its stated grains ------------------------------------------


def test_a_backtest_number_is_the_replay_numbers_it_aggregates() -> None:
    """Totals and coverage read off the same `ReplayScores` the screen renders."""
    population = days(*IN_F4)
    result = aggregate(population)
    row = result.row("F4")

    assert row.metrics is not None
    assert row.days_replayed == len(population)
    assert row.metrics.total_recovered_mwh == pytest.approx(
        sum(day.scores.observed_scoring.recovered_mwh for day in population)
    )
    assert row.metrics.mean_forecast_value_gap_mwh == pytest.approx(
        sum(day.scores.upper_bound.forecast_value_gap_mwh for day in population)
        / len(population)
    )
    coverage = row.by_subsystem[0]
    assert coverage.subsystem == SUBSYSTEM
    assert coverage.days_floor_met == sum(1 for day in population if day.floor_met)
    assert coverage.floor_coverage == coverage.days_floor_met / coverage.days_replayed


def test_floor_coverage_is_reported_per_subsystem_and_not_pooled() -> None:
    """Its stated grain is fold, **subsystem**, fidelity.

    A share pooled over two subsystems averages two different fleets' worth of
    curtailment, and the gate that reads it compares like with like. So the
    figure exists on the subsystem row and on no other object here.
    """
    result = aggregate(days(*IN_F4))
    row = result.row("F4")
    assert [entry.subsystem for entry in row.by_subsystem] == [SUBSYSTEM]
    assert not hasattr(row, "floor_coverage")
    assert row.metrics is not None
    assert not hasattr(row.metrics, "floor_coverage")
    assert "floor_coverage" not in row.as_payload()


def test_avoidability_is_a_distribution_and_never_one_number() -> None:
    """Mean with p25 and p75, per `replay.md`'s table."""
    population = days(date(2026, 1, 5)) + days(
        date(2026, 2, 5), observed=(60.0, 400.0, 200.0)
    )
    row = aggregate(population).row("F4")

    assert row.metrics is not None
    spread = row.metrics.avoidability
    assert spread is not None
    ratios = sorted(
        day.avoidability for day in population if day.avoidability is not None
    )
    assert spread.mean == pytest.approx(sum(ratios) / len(ratios))
    assert spread.p25 < spread.p75, "two days at different ratios collapsed to one"
    assert set(spread.as_payload()) == {"mean", "p25", "p75"}


def test_a_day_with_nothing_to_avoid_is_not_a_zero_in_the_distribution() -> None:
    """`avoidability` is `None` there, and `None` is not a data point.

    Counting it as zero would pull the mean towards a ratio no day scored, on
    days whose only property is that there was nothing to recover.
    """
    quiet = days(date(2026, 3, 2), p50=(1.0, 2.0, 1.0), observed=(1.0, 2.0, 1.0))
    assert quiet[0].avoidability is None

    row = aggregate(days(date(2026, 1, 5)) + quiet).row("F4")
    assert row.metrics is not None
    assert row.metrics.days_replayed == 2
    assert row.metrics.days_with_avoidability == 1
    spread = row.metrics.avoidability
    assert spread is not None
    assert spread.mean == pytest.approx(days(date(2026, 1, 5))[0].avoidability)


def test_days_forecast_underestimated_counts_the_days_that_came_in_bigger() -> None:
    """``Σf50 < Σa``, with the share beside the count so neither name misleads."""
    bigger = days(date(2026, 1, 5), observed=(80.0, 400.0, 200.0))
    smaller = days(date(2026, 2, 5), observed=(10.0, 20.0, 10.0))
    assert bigger[0].forecast_underestimated
    assert not smaller[0].forecast_underestimated

    row = aggregate(bigger + smaller).row("F4")
    assert row.metrics is not None
    assert row.metrics.days_forecast_underestimated == 1
    assert row.metrics.forecast_underestimated_share == pytest.approx(0.5)


def test_the_revision_premium_is_null_until_it_is_measured() -> None:
    """Never a zero standing in for an unmeasured caveat."""
    row = aggregate(days(*IN_F4)).row("F4")
    assert row.revision_premium is None
    assert row.as_payload()["revision_premium_recovered_mwh"] is None


# --- no headline --------------------------------------------------------------


def test_no_annual_or_cross_fidelity_headline_is_offered_anywhere() -> None:
    """`replay.md` puts a single headline over mixed fidelities out of scope.

    So the aggregate publishes rows and provenance, and nothing that reduces two
    rows to one number: no total, no mean, no coverage at the top level, and no
    field on :class:`Backtest` a client could read one off.
    """
    result = aggregate(days(*BEFORE_GO_LIVE, *AFTER_GO_LIVE, *IN_F4))
    payload = result.as_payload(AS_OF)

    assert set(payload) == {
        "state",
        "computation_id",
        "computed_at",
        "as_of",
        "lane",
        "reference_fleet_hash",
        "optimizer_build",
        "window",
        "rows",
    }
    for name in (
        "total_recovered_mwh",
        "floor_coverage",
        "mean_avoidability",
        "avoidability",
        "days_replayed",
        "mean_forecast_value_gap_mwh",
    ):
        assert name not in payload, f"{name} at the top level is a headline"
        assert not hasattr(result, name)
    # Every row that carries a figure says which caveat it is under.
    rows = payload["rows"]
    assert isinstance(rows, list)
    for row in rows:
        assert row["vintage_fidelity"] in get_args(VintageFidelity)


# --- absence, and the shapes that refuse -------------------------------------


def test_metrics_over_no_days_are_unmeasured_rather_than_zero() -> None:
    with pytest.raises(BacktestError, match="no days"):
        BacktestMetrics.over([])
    with pytest.raises(BacktestError, match="unmeasured"):
        Distribution.of([])
    with pytest.raises(BacktestError, match="absent, not a zero row"):
        SubsystemCoverage(subsystem=SUBSYSTEM, days_replayed=0, days_floor_met=0)


def test_a_row_whose_parts_disagree_cannot_be_built() -> None:
    """The counts on a row are one fact, and the object refuses to hold two."""
    segment = segments()[0]
    with pytest.raises(BacktestError, match="different things"):
        BacktestRow(segment=segment, days_replayed=3, by_subsystem=(), metrics=None)
    with pytest.raises(BacktestError, match="account for"):
        BacktestRow(
            segment=segment,
            days_replayed=0,
            by_subsystem=(
                SubsystemCoverage(subsystem=SUBSYSTEM, days_replayed=1, days_floor_met=1),
            ),
            metrics=None,
        )


def test_a_replayable_day_outside_the_calendar_is_refused_not_dropped() -> None:
    """An aggregate that silently dropped a day would report a window it missed."""
    population = days(*IN_F4)
    with pytest.raises(BacktestError, match="falls in no fold"):
        aggregate(
            population,
            rows=tuple(segment for segment in segments() if segment.fold_id != "F4"),
        )


def test_an_aggregate_needs_the_calendar_it_aggregates_over() -> None:
    with pytest.raises(BacktestError, match="no fold segments"):
        aggregate(days(*IN_F4), rows=())
