"""Two arms, both floors, and the stamp that says what they are floors of.

`docs/specs/forecaster.md` scores a second planning arm against `E[Y]` through
the optimizer's simulator and publishes both arms' `recovered_floor_mwh`.
`test_planning_basis_parameter.py` asserts the *seam* flex-optimizer 09 opened —
that the builder takes an envelope and that no request can reach it. This file
asserts the thing that seam was opened for: that fold evaluation actually runs
both arms on the same days, from the same served artifact, against the same
published reference fleet; that both come out of the one simulator; and that the
two numbers are published side by side with the shipped posture stated in prose
rather than implied by which of them came first.

**Why the arm exists, in the fixture below.** ``E[Y] > P50`` exactly when
``p < 0.5``, so the expectation is non-zero in precisely the hours where the P50
plan goes blind. :data:`BLIND_HOURS` is where the whole argument lives, and
:func:`test_the_expectation_arm_acts_where_the_median_plan_cannot` is the
acceptance test the ticket asks for.

**The bands are composed, never invented.** Every fixture day here goes through
:func:`~wattsteer_ml.training.hurdle.compose_estimates` and so through the one
mixture inversion, which is what puts the zeroes where the composition puts them
rather than where a test author would have. They are still *fabricated* — this
repository has no database-backed Python suite and these probabilities were
chosen — which is exactly why every block written here is stamped
``arm_source: fixture`` and says so in capitals.

**The connection is a stand-in**, as in `test_p50_collapse_report.py`: what is
asserted about the read is which axes are written, which values are bound and
what a stored row becomes. No test here pretends to have checked the SQL against
a migrated schema.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from collections.abc import Sequence
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Self

import pytest

from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import REFERENCE_FLEET, SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.evaluation.collapse_report import (
    FIXTURE_SOURCE,
    HOLDOUT_HOURS_SOURCE,
    HOLDOUT_ORIGIN_KIND,
    UNMEASURED_SOURCE,
)
from wattsteer_ml.evaluation.planning_arms import (
    ARM_HOURS_SQL,
    ARMS,
    MEASUREMENT_BASIS,
    PLANNING_ARMS_BLOCK_KEY,
    PUBLISHED_FLEET,
    SHIPPED_BASIS,
    ArmDay,
    ArmProvenance,
    PlanningArmError,
    PlanningArmReport,
    ReferenceFleetStamp,
    UnmeasuredPlanningArms,
    days_of,
    measure_planning_arms,
    plan_for,
    read_arm_hours,
    record_planning_arms,
    score_arm,
    score_planning_arms,
)
from wattsteer_ml.evaluation.vintage import FoldSegment
from wattsteer_ml.lanes import Lane
from wattsteer_ml.optimizer import simulator as simulator_module
from wattsteer_ml.publication import BACKFILLED_HOLDOUT_ORIGIN_KIND
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.hurdle import HourEstimates, HourForecast, compose_estimates

HOURS_PER_DAY = 24
THRESHOLD_MW = 5.0
AS_OF = datetime(2026, 8, 29, 4, 0, tzinfo=UTC)
PUBLISHED_AT = datetime(2026, 4, 1, 9, 0, tzinfo=UTC)
RUN_LABEL = "fold-evaluation-2026-08-29"
ARTIFACT_ID = "2026-08-29T04:00:00Z"
LANE = Lane(
    feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=THRESHOLD_MW
)

FLAT_MU_SUB = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(HOURS_PER_DAY)) for _ in SUBSYSTEM_CODES)
)

#: The magnitude every hour of the fixture is estimated at. One number, so the
#: only thing that varies across the day is ``p`` — which is the variable the
#: whole argument is about.
MAGNITUDE_MWH = 20.0

#: Six hours the classifier is nearly certain about and eighteen it is not.
#: ``p = 0.95`` puts a non-zero number in all three quantiles; ``p = 0.20``
#: leaves P10 and P50 at exactly zero and the expectation at ``p·μ = 4 MWh``.
#: The day's whole expectation is well inside the reference battery's headroom,
#: so what the second arm does in a blind hour is decided by the envelope rather
#: than by an energy limit.
CERTAIN_P = 0.95
UNCERTAIN_P = 0.20
BUSY_HOURS: tuple[int, ...] = (10, 11, 12, 13, 14, 15)
BLIND_HOURS: tuple[int, ...] = tuple(
    hour for hour in range(HOURS_PER_DAY) if hour not in BUSY_HOURS
)
PROBABILITIES: tuple[float, ...] = tuple(
    CERTAIN_P if hour in BUSY_HOURS else UNCERTAIN_P for hour in range(HOURS_PER_DAY)
)

DAY_ONE = date(2025, 4, 1)
DAY_TWO = date(2025, 4, 2)


def composed(
    probabilities: Sequence[float] = PROBABILITIES,
    *,
    day: date = DAY_ONE,
    subsystem: Subsystem = "NE",
) -> tuple[HourForecast, ...]:
    """One day of hours, through the service's one composition."""
    keys = [
        RowKey(target_date=day, local_hour=hour, subsystem=subsystem)
        for hour in range(len(probabilities))
    ]
    return compose_estimates(
        keys,
        [
            HourEstimates(
                occurrence_probability=p,
                q10=MAGNITUDE_MWH,
                q50=MAGNITUDE_MWH,
                q90=MAGNITUDE_MWH,
                positive_mean_mwh=MAGNITUDE_MWH,
            )
            for p in probabilities
        ],
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=THRESHOLD_MW,
    )


def fixture_day(
    *,
    day: date = DAY_ONE,
    subsystem: Subsystem = "NE",
    fidelity: VintageFidelity = "revision_optimistic",
) -> ArmDay:
    built = ArmDay.of(composed(day=day, subsystem=subsystem), fidelity=fidelity)
    assert built is not None
    return built


def stored(
    probabilities: Sequence[float] = PROBABILITIES,
    *,
    day: date = DAY_ONE,
    subsystem: Subsystem = "NE",
    run_label: str = RUN_LABEL,
    hours: int = HOURS_PER_DAY,
) -> list[dict[str, Any]]:
    """The same composed day, as ``canonical_forecast_hour`` hands it back.

    Composed rather than invented, so the rows carry the composition's own
    zeroes and the read-back path can be compared against it rather than against
    numbers a test made up.
    """
    return [
        {
            "subsystem": hour.key.subsystem,
            "target_date": hour.key.target_date,
            "local_hour": hour.key.local_hour,
            "occurrence_probability": hour.forecast.occurrence_probability,
            "p10_mwh": hour.forecast.band.p10,
            "p50_mwh": hour.forecast.band.p50,
            "p90_mwh": hour.forecast.band.p90,
            "expected_mwh": hour.forecast.expected_mwh,
            "published_at": PUBLISHED_AT,
            "run_label": run_label,
            "feature_set": LANE.feature_set,
            "gate_profile": LANE.gate_profile,
            "threshold_mw": THRESHOLD_MW,
        }
        for hour in composed(probabilities, day=day, subsystem=subsystem)[:hours]
    ]


def segment(
    fold_id: str = "F5",
    *,
    first: date = DAY_ONE,
    last: date = DAY_TWO,
    fidelity: VintageFidelity = "revision_optimistic",
    is_split: bool = False,
) -> FoldSegment:
    row_id = f"{fold_id}@{fidelity}" if is_split else fold_id
    return FoldSegment(
        fold_id=fold_id,
        row_id=row_id,
        fidelity=fidelity,
        test_start=first,
        test_end=last,
        is_split=is_split,
        fold_hash=f"sha256:{fold_id}",
    )


class FakeTransaction:
    def __init__(self, connection: FakeConnection) -> None:
        self._connection = connection

    async def __aenter__(self) -> Self:
        self._connection.calls.append(("begin", ()))
        return self

    async def __aexit__(self, *_: object) -> bool:
        self._connection.calls.append(("commit", ()))
        return False


class FakeConnection:
    """Records what was executed and hands back the rows it was primed with."""

    def __init__(self, batches: Sequence[list[dict[str, Any]]]) -> None:
        self._batches = list(batches)
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)

    async def execute(self, query: str, *args: Any) -> None:
        self.calls.append(("execute", (query, *args)))

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.calls.append(("fetch", (query, *args)))
        return self._batches.pop(0) if self._batches else []


def measure(
    batches: Sequence[list[dict[str, Any]]], *, segments: Sequence[FoldSegment]
) -> tuple[FakeConnection, PlanningArmReport | UnmeasuredPlanningArms]:
    connection = FakeConnection(batches)
    report = asyncio.run(
        measure_planning_arms(connection, segments=list(segments), lane=LANE, as_of=AS_OF)
    )
    return connection, report


# --- the fixture is the argument ----------------------------------------------


def test_the_expectation_is_non_zero_exactly_where_the_median_is_not() -> None:
    """``E[Y] > P50`` when ``p < 0.5``, out of the one composition.

    Asserted before anything is planned, because if it were not true of the
    fixture the two arms below would be comparing nothing.
    """
    day = fixture_day()
    assert day.blind_hours == BLIND_HOURS
    assert day.hours_the_expectation_offers == BLIND_HOURS
    for hour in BLIND_HOURS:
        assert day.profile.p50_mwh[hour] == 0.0
        assert day.profile.p10_mwh[hour] == 0.0
        assert day.profile.expected_mwh[hour] > 0.0
    for hour in BUSY_HOURS:
        assert day.profile.p50_mwh[hour] > 0.0


# --- the acceptance test ------------------------------------------------------


def test_the_expectation_arm_acts_where_the_median_plan_cannot() -> None:
    """**The ticket's assertion.** One arm has something to act on; one has not.

    In every hour the median calls quiet the P50 arm's schedule is empty — not
    by policy but because (C2)/(C5) leave it nothing to gain there — while the
    expectation arm's is not. That is the whole reason the second arm is scored:
    the expectation is non-zero in precisely the hours where the P50 plan goes
    blind, and the execution rule means the cost of being wrong about them is
    asymmetric.

    "Non-zero" is asserted as ``Δ[t]`` — the net increase in flexible demand the
    schedule asks for in that hour — and not as one asset's column: which asset
    of the published fleet supplies it is the model's business, and on this
    fixture some blind hours are supplied by the flexible load rather than by
    the battery. The P50 side is asserted on the asset column as well, because
    there the claim is that *nothing at all* is scheduled.
    """
    day = fixture_day()
    shipped = plan_for(day, SHIPPED_BASIS)
    measured = plan_for(day, MEASUREMENT_BASIS)
    assert shipped.planning_basis == "p50"
    assert measured.planning_basis == "expected"
    for hour in BLIND_HOURS:
        assert shipped.offered_mwh[hour] == 0.0
        assert shipped.hours[hour].absorbed_mwh == pytest.approx(0.0, abs=1e-9)
        assert shipped.batteries[0].charge_mw[hour] == pytest.approx(0.0, abs=1e-9)
        assert measured.offered_mwh[hour] > 0.0
        assert measured.hours[hour].absorbed_mwh > 0.0
        assert measured.net_flexible_demand_mwh[hour] > 0.0


def test_the_two_arms_differ_in_the_envelope_and_in_nothing_else() -> None:
    """Otherwise a difference in the floors is attributable to the wrong thing."""
    day = fixture_day()
    shipped = plan_for(day, SHIPPED_BASIS)
    measured = plan_for(day, MEASUREMENT_BASIS)
    assert shipped.horizon == measured.horizon
    assert shipped.assets == measured.assets
    assert shipped.loads == measured.loads
    assert shipped.deg_penalty_rho == measured.deg_penalty_rho
    assert shipped.throughput_penalties == measured.throughput_penalties
    assert shipped.offered_mwh != measured.offered_mwh


# --- one simulator, two arms --------------------------------------------------


def test_both_arms_are_scored_by_the_imported_simulator() -> None:
    """Ticket 02's function, imported — and the floor is read, never recomputed.

    ``recovered_floor_mwh`` has one definition, on the simulator's `ScoredBand`,
    and this module sums that definition over days rather than holding a second
    one. There is no execution rule in `planning_arms.py`, and
    `test/one-execution-rule.test.ts` is the repository-wide edge that keeps it so.
    """
    from wattsteer_ml.evaluation import planning_arms

    assert vars(planning_arms)["score_band"] is simulator_module.score_band
    day = fixture_day()
    for basis in ARMS:
        scored = score_arm(day, basis)
        assert scored.recovered_floor_mwh == scored.p10.recovered_mwh


def test_both_arms_are_scored_against_p10_p50_and_p90() -> None:
    """One plan, three envelopes, per the optimizer spec — for each arm."""
    day = fixture_day()
    comparison = score_planning_arms([day])
    assert comparison is not None
    for basis in ARMS:
        arm = comparison.arm(basis)
        assert arm.recovered_p90_mwh >= arm.recovered_p50_mwh >= 0.0
        assert arm.recovered_floor_mwh >= 0.0
        assert arm.days == 1


# --- the same days, the same artifact, the same fleet -------------------------


def test_the_arms_are_built_on_the_same_days_and_the_same_fleet() -> None:
    """Both arms come out of one loop over one list of days.

    "The same days, the same served artifact, the same fixed published reference
    fleet" is a property of :func:`score_planning_arms`'s loop rather than of a
    convention two callers have to keep, and the day count on each arm is what
    makes it checkable from the outside.
    """
    days = [fixture_day(day=DAY_ONE), fixture_day(day=DAY_TWO)]
    comparison = score_planning_arms(days)
    assert comparison is not None
    assert comparison.days == 2
    assert {arm.days for arm in comparison.arms} == {2}
    assert comparison.subsystems == ("NE",)
    assert comparison.blind_hours == 2 * len(BLIND_HOURS)
    assert comparison.blind_hours_the_expectation_offers == 2 * len(BLIND_HOURS)
    assert tuple(arm.basis for arm in comparison.arms) == ARMS


def test_the_reference_fleet_is_stamped_so_the_floors_are_reproducible() -> None:
    """A floor is a statement about a fleet; the fleet travels with the number.

    The stamp is over the *numbers* rather than the label, so an edit to
    ``REFERENCE_FLEET`` changes the hash and a card written before it stops
    matching one written after.
    """
    stamp = PUBLISHED_FLEET
    assert stamp == ReferenceFleetStamp.published()
    assert stamp.battery_max_power_mw == float(REFERENCE_FLEET.battery.max_power_mw)
    assert stamp.load_max_shift_mw == float(REFERENCE_FLEET.shiftable_load.max_shift_mw)
    fields = stamp.card_fields()
    assert fields["fleet_hash"].startswith("sha256:")
    assert fields["battery"]["energy_capacity_mwh"] == 300.0
    edited = dataclasses.replace(stamp, battery_energy_capacity_mwh=301.0)
    assert edited.fleet_hash != stamp.fleet_hash


def test_the_stamped_fleet_is_the_fleet_the_arms_actually_planned() -> None:
    """The stamp and the assets come from one place, so they cannot disagree."""
    batteries, loads = PUBLISHED_FLEET.assets()
    plan = plan_for(fixture_day(), SHIPPED_BASIS)
    assert plan.assets == batteries
    assert plan.loads == loads


# --- both floors, side by side, and the posture stated ------------------------


def test_both_arms_floors_are_published_side_by_side_per_fold() -> None:
    """Two entries of identical shape, keyed by basis, under one fold row.

    Identical shapes are the point: a block that gave one arm more fields than
    the other would be presenting that one as the reading and the other as a
    footnote, and the ticket says neither is the shipped posture *by virtue of
    being in this block*.
    """
    report = fixture_report()
    block = report.card_block()[PLANNING_ARMS_BLOCK_KEY]
    assert len(block["folds"]) == 1
    arms = block["folds"][0]["arms"]
    assert set(arms) == set(ARMS)
    assert set(arms["p50"]) == set(arms["expected"])
    for basis in ARMS:
        assert arms[basis]["planning_basis"] == basis
        assert "recovered_floor_mwh" in arms[basis]
    assert block["folds"][0]["row_id"] == "F5"
    assert block["folds"][0]["vintage_fidelity"] == "revision_optimistic"


def test_the_card_states_that_v1_serves_the_p50_plan() -> None:
    """In prose and as a field, because the block is read without this module."""
    block = fixture_report().card_block()[PLANNING_ARMS_BLOCK_KEY]
    assert block["shipped_basis"] == "p50"
    assert SHIPPED_BASIS == "p50"
    assert "v1 serves the P50 plan" in block["serves"]
    assert "planning_basis=p50" in block["serves"]


def test_the_unmeasured_block_still_says_which_arm_is_served() -> None:
    """A reader who finds no figures still has to know what is in production."""
    absent = UnmeasuredPlanningArms(
        lane=LANE, as_of=AS_OF, reason="no rows in this environment"
    )
    block = absent.card_block()[PLANNING_ARMS_BLOCK_KEY]
    assert "v1 serves the P50 plan" in block["serves"]
    assert block["shipped_basis"] == "p50"


def test_the_delta_is_a_difference_and_not_a_verdict() -> None:
    """Subtraction, in the order the question is asked, and nothing else.

    No threshold, no boolean, no ``arm_wins``: this module produces evidence and
    the specs decide the posture.
    """
    report = fixture_report()
    entry = report.card_block()[PLANNING_ARMS_BLOCK_KEY]["folds"][0]
    arms = entry["arms"]
    assert entry["delta_recovered_floor_mwh"] == pytest.approx(
        arms["expected"]["recovered_floor_mwh"] - arms["p50"]["recovered_floor_mwh"]
    )
    assert not [key for key in entry if "wins" in key or "verdict" in key]


# --- provenance: a fixture floor is not a measurement --------------------------


def test_a_fixture_stamped_block_cannot_be_read_as_evidence() -> None:
    """Ticket 10's discipline, on the figure beside ticket 10's figure.

    Two floors in MWh are computable from any pair of bands. The stamp is what
    stops a solver's arithmetic over invented curtailment being read as what a
    fleet on the Brazilian grid would have recovered.
    """
    block = fixture_report().card_block()[PLANNING_ARMS_BLOCK_KEY]
    assert block["measured"] is False
    assert block["arm_source"] == FIXTURE_SOURCE
    assert "NOT A MEASUREMENT OF THE GRID" in block["reads"]
    assert HOLDOUT_HOURS_SOURCE in block["reads"]


def test_the_measured_stamp_needs_a_run_and_an_instant() -> None:
    """``measured`` and ``fixture`` are the two constructors, and they differ.

    ``arm_source`` cannot be set to the holdout source by a caller that did not
    read a row: reaching it means calling :meth:`ArmProvenance.measured`, which
    demands the ``run_label`` the rows carried and the instant they were
    resolved at.
    """
    measured = ArmProvenance.measured(lane=LANE, as_of=AS_OF, run_label=RUN_LABEL)
    assert measured.is_measurement is True
    assert measured.card_fields()["run_label"] == RUN_LABEL
    assert measured.card_fields()["as_of"] == AS_OF.isoformat()
    invented = ArmProvenance.fixture(lane=LANE)
    assert invented.is_measurement is False
    assert invented.as_of is None
    assert invented.run_label is None


def test_every_block_carries_the_fleet_and_the_lane() -> None:
    """Reproducible means: which lane's bands, which fleet, resolved when."""
    fields = ArmProvenance.measured(
        lane=LANE, as_of=AS_OF, run_label=RUN_LABEL
    ).card_fields()
    assert fields["lane"] == LANE.directory_name
    assert fields["feature_set"] == LANE.feature_set
    assert fields["threshold_mw"] == THRESHOLD_MW
    assert fields["origin_kind"] == HOLDOUT_ORIGIN_KIND
    assert fields["reference_fleet"]["fleet_hash"] == PUBLISHED_FLEET.fleet_hash


# --- the population, the axes and the bound values ----------------------------


def test_the_query_reads_the_held_out_population_and_the_expectation() -> None:
    """One view, one population, and `E[Y]` beside the band rather than instead.

    The expectation is selected unconditionally: an arm read by a different
    query than its twin would differ from it in two things, and the comparison
    would stop meaning anything. Nothing in the statement can select a basis.
    """
    assert HOLDOUT_ORIGIN_KIND == BACKFILLED_HOLDOUT_ORIGIN_KIND
    assert f"origin_kind = '{HOLDOUT_ORIGIN_KIND}'" in ARM_HOURS_SQL
    assert "from canonical_forecast_hour" in ARM_HOURS_SQL
    assert "expected_mwh" in ARM_HOURS_SQL
    assert "'served'" not in ARM_HOURS_SQL
    for word in ("planning_basis", "basis", "$6"):
        assert word not in ARM_HOURS_SQL


def test_the_vintage_axis_is_written_before_the_bands_are_read() -> None:
    """A backtest run appends a vintage; the read is reproducible or it is not."""
    connection = FakeConnection([stored()])
    hours, run_label = asyncio.run(
        read_arm_hours(connection, segment=segment(), lane=LANE, as_of=AS_OF)
    )
    assert run_label == RUN_LABEL
    assert len(hours) == HOURS_PER_DAY
    assert [call[0] for call in connection.calls] == [
        "begin",
        "execute",
        "fetch",
        "commit",
    ]
    axes = connection.calls[1][1]
    assert "set_config" in axes[0]
    assert axes[1] == AS_OF.isoformat()
    query, *values = connection.calls[2][1]
    assert values == [
        DAY_ONE,
        DAY_TWO,
        LANE.feature_set,
        LANE.gate_profile,
        THRESHOLD_MW,
    ]
    assert HOLDOUT_ORIGIN_KIND in query


def test_a_stored_day_builds_the_same_arms_the_composition_would() -> None:
    """The read-back path holds no second opinion about where the zeroes are."""
    connection = FakeConnection([stored()])
    hours, _ = asyncio.run(
        read_arm_hours(connection, segment=segment(), lane=LANE, as_of=AS_OF)
    )
    days, excluded = days_of(hours, fidelity="point_in_time")
    assert excluded == 0
    assert len(days) == 1
    assert days[0].profile.p50_mwh == fixture_day().profile.p50_mwh
    assert days[0].profile.expected_mwh == fixture_day().profile.expected_mwh
    assert days[0].blind_hours == BLIND_HOURS
    assert days[0].profile.forecast_origin == PUBLISHED_AT
    assert days[0].profile.vintage_fidelity == "point_in_time"


def test_two_backtest_runs_in_one_segment_are_refused_rather_than_pooled() -> None:
    """Two artifacts' bands are two populations wearing one run's name."""
    rows = stored(day=DAY_ONE) + stored(day=DAY_TWO, run_label="a-second-run")
    with pytest.raises(PlanningArmError, match="more than one backtest run"):
        measure([rows], segments=[segment()])


def test_the_measured_report_names_the_run_its_rows_carried() -> None:
    _, report = measure([stored()], segments=[segment()])
    assert isinstance(report, PlanningArmReport)
    block = report.card_block()[PLANNING_ARMS_BLOCK_KEY]
    assert block["measured"] is True
    assert block["arm_source"] == HOLDOUT_HOURS_SOURCE
    assert block["run_label"] == RUN_LABEL
    assert "recovered_floor_mwh is the P10-simulated recovery" in block["reads"]


# --- every shape of absence stays an absence ----------------------------------


def test_no_held_out_band_is_unmeasured_and_never_two_floors_of_zero() -> None:
    """The environment this ticket was implemented in, and its honest output."""
    _, report = measure([[]], segments=[segment()])
    assert isinstance(report, UnmeasuredPlanningArms)
    assert report.is_measurement is False
    block = report.card_block()[PLANNING_ARMS_BLOCK_KEY]
    assert block["arm_source"] == UNMEASURED_SOURCE
    assert "not a floor of zero" in block["reads"]
    assert "folds" not in block
    assert not [key for key in block if key.endswith("_mwh")]


def test_a_partial_day_is_excluded_and_counted_rather_than_planned() -> None:
    """Six served hours is not a day a plan was ever built for.

    Zero-filling the gap would invent a forecast of "no curtailment" for the
    missing hours and quote a floor computed against it.
    """
    connection = FakeConnection([stored(hours=6)])
    hours, _ = asyncio.run(
        read_arm_hours(connection, segment=segment(), lane=LANE, as_of=AS_OF)
    )
    days, excluded = days_of(hours, fidelity="revision_optimistic")
    assert days == ()
    assert excluded == 1
    assert score_planning_arms(days, days_excluded_incomplete=excluded) is None


def test_an_empty_segment_list_is_a_caller_mistake_and_not_an_empty_table() -> None:
    with pytest.raises(PlanningArmError, match="no fold segment"):
        measure([], segments=[])


def test_a_day_of_two_grains_is_refused() -> None:
    """A band is comparable with another band of the same ``threshold_mw`` only."""
    rows = stored()
    rows[3] = {**rows[3], "threshold_mw": 10.0}
    connection = FakeConnection([rows])
    hours, _ = asyncio.run(
        read_arm_hours(connection, segment=segment(), lane=LANE, as_of=AS_OF)
    )
    with pytest.raises(PlanningArmError, match="thresholds"):
        days_of(hours, fidelity="revision_optimistic")


# --- never averaged across vintages -------------------------------------------


def test_one_half_of_a_split_fold_cannot_be_published_alone() -> None:
    """The caveat disappears by averaging, so the shapes refuse to average."""
    comparison = score_planning_arms([fixture_day()])
    assert comparison is not None
    with pytest.raises(Exception, match="split fold"):
        PlanningArmReport.of(
            [(segment("F6", is_split=True), comparison)],
            provenance=ArmProvenance.fixture(lane=LANE),
        )


def test_a_segment_reported_twice_is_a_day_scored_twice() -> None:
    comparison = score_planning_arms([fixture_day()])
    assert comparison is not None
    with pytest.raises(PlanningArmError, match="reported twice"):
        PlanningArmReport.of(
            [(segment(), comparison), (segment(), comparison)],
            provenance=ArmProvenance.fixture(lane=LANE),
        )


def test_a_revision_optimistic_only_report_carries_its_caveat() -> None:
    block = fixture_report().card_block()[PLANNING_ARMS_BLOCK_KEY]
    assert block["vintage_fidelities"] == ["revision_optimistic"]
    assert "revision_optimistic" in block["vintage_caveat"]


# --- the card ------------------------------------------------------------------


def test_the_block_is_written_onto_an_existing_card(tmp_path: Path) -> None:
    """An edit of a card already on the volume, through the one writer."""
    lane_root = tmp_path / LANE.directory_name
    lane_root.mkdir(parents=True)
    card_path = lane_root / f"{ARTIFACT_ID}{CARD_SUFFIX}"
    card_path.write_text(json.dumps({"artifact_id": ARTIFACT_ID}), encoding="utf-8")
    written = record_planning_arms(
        fixture_report(), root=tmp_path, artifact_id=ARTIFACT_ID
    )
    card = json.loads(written.read_text(encoding="utf-8"))
    assert card["artifact_id"] == ARTIFACT_ID
    assert PLANNING_ARMS_BLOCK_KEY in card
    assert card[PLANNING_ARMS_BLOCK_KEY]["measured"] is False


def fixture_report() -> PlanningArmReport:
    """One segment's comparison over one fabricated day, stamped as fabricated."""
    comparison = score_planning_arms([fixture_day()])
    assert comparison is not None
    return PlanningArmReport.of(
        [(segment(), comparison)], provenance=ArmProvenance.fixture(lane=LANE)
    )
