"""The simulator — the spec's Seam 2, property-based where the spec says so.

Two kinds of test live here. The **properties** are generated: random plans
against random realisations, because the claims worth defending are claims about
every plan and not about the one in a fixture. The **numbers** are anchored: the
MILP's own absorbed quantity, re-derived from physics by a different piece of
code, agreeing to 1e-6. That agreement is the engine's actual proof — the
formulation's failure modes all leave the model feasible, `OPTIMAL` and
*better*, so a KPI read off the objective would confirm a bug rather than catch
one.

The generated plans respect charge/discharge mutual exclusion. That is not a
convenience: (B7)–(B8) make simultaneity impossible in every plan this system
can produce, and a generator that violated it would be asserting monotonicity
about schedules no builder emits.
"""

from __future__ import annotations

# `random` is seeded and deterministic here: a property test that draws
# different plans on every run is a test that fails for one session and passes
# for the next, and the seeds below are what make a failure reproducible.
# `S311` is about cryptography and has no bearing on either.
import random
from datetime import date

import pytest

from wattsteer_ml.optimizer import (
    Battery,
    BatteryDispatch,
    DispatchPlan,
    OptimizerBugError,
    PlanningEnvelope,
    Schedule,
    local_day,
    reference_battery,
    score_band,
    simulate,
    solve,
)
from wattsteer_ml.optimizer.horizon import HORIZON_HOURS

#: IDEA.md §27 — the profile every measured number in the engine is taken on.
REFERENCE_PROFILE: tuple[float, ...] = (
    *(0.0,) * 10,
    20.0,
    70.0,
    110.0,
    90.0,
    30.0,
    10.0,
    *(0.0,) * 8,
)

#: The subsystem-grain `CurtailmentHour` threshold, in MW.
THRESHOLD_MW = 5.0

HORIZON = local_day(date(2026, 8, 29))

ALL_ZERO: tuple[float, ...] = (0.0,) * HORIZON_HOURS


def reference_plan(profile: tuple[float, ...] = REFERENCE_PROFILE) -> DispatchPlan:
    return solve(
        envelope=PlanningEnvelope.p50(profile),
        batteries=[reference_battery()],
        horizon=HORIZON,
    )


def random_schedule(rng: random.Random, batteries: int = 1) -> Schedule:
    """A physically-shaped plan: bounded, and never charging while discharging.

    Deliberately *not* a solver output — the point of a property test is to
    cover plans the optimizer would never choose, including plans that ask for
    far more than the day can supply, which is exactly the regime the execution
    rule exists for.
    """
    assets: list[Battery] = []
    dispatch: list[BatteryDispatch] = []
    for index in range(batteries):
        battery = Battery.from_round_trip(
            key=f"b{index}",
            label=f"Battery {index}",
            max_power_mw=rng.uniform(10.0, 200.0),
            energy_capacity_mwh=rng.uniform(20.0, 600.0),
            round_trip_efficiency=rng.uniform(0.7, 0.98),
            initial_state_of_charge=rng.uniform(0.05, 0.95),
        )
        charge: list[float] = []
        discharge: list[float] = []
        for _ in range(HORIZON_HOURS):
            power = rng.uniform(0.0, battery.max_power_mw)
            if rng.random() < 0.5:
                charge.append(power)
                discharge.append(0.0)
            else:
                charge.append(0.0)
                discharge.append(power)
        assets.append(battery)
        dispatch.append(
            BatteryDispatch(
                key=battery.key,
                label=battery.label,
                charge_mw=tuple(charge),
                discharge_mw=tuple(discharge),
                # Never read by the simulator: the whole point is that the
                # trajectory is recomputed from the executed dispatch. Filled
                # with a deliberately absurd value so a simulator that started
                # carrying the planned SOC would fail loudly here.
                state_of_charge_mwh=(-1e9,) * HORIZON_HOURS,
            )
        )
    return Schedule(
        assets=tuple(assets),
        dispatch=tuple(dispatch),
        load_shift_up_mw=ALL_ZERO,
        load_shift_down_mw=ALL_ZERO,
    )


def random_realisation(rng: random.Random, scale: float = 150.0) -> tuple[float, ...]:
    return tuple(
        0.0 if rng.random() < 0.4 else rng.uniform(0.0, scale)
        for _ in range(HORIZON_HOURS)
    )


class TestTheExecutionRule:
    def test_a_plan_on_p50_absorbs_nothing_on_a_day_that_never_came(self) -> None:
        """The negative case the whole uncertainty posture rests on.

        Plan against P50, let the day come in at zero: the fleet absorbs exactly
        zero and imports exactly nothing. This is what makes planning
        optimistically while promising the P10 edge coherent — over-planning
        cannot overstate recovery, because the plan is *intent* and the rule is
        what happens.
        """
        scored = simulate(reference_plan(), ALL_ZERO, threshold_mw=THRESHOLD_MW)

        assert scored.recovered_mwh == 0.0
        assert scored.baseline_mwh == 0.0
        assert scored.avoidability is None
        for hour in scored.hours:
            assert hour.battery_charge_mw == 0.0
            assert hour.absorbed_mwh == 0.0
            # Nothing imported: the fleet's net demand never rises above the
            # nothing that was offered.
            assert hour.net_flexible_demand_mwh <= 0.0

    def test_the_state_of_charge_is_recomputed_not_carried(self) -> None:
        """The prototype's bug, asserted against here.

        On a realisation below the planning basis, a simulator that clipped
        absorption but carried the planned trajectory reports a battery filling
        up on energy it never received.
        """
        battery = reference_battery()
        plan = reference_plan()
        planned_peak = max(plan.hours, key=lambda hour: hour.state_of_charge_mwh)

        scored = simulate(plan, ALL_ZERO, threshold_mw=THRESHOLD_MW)
        executed_peak = max(hour.state_of_charge_mwh for hour in scored.hours)

        assert planned_peak.state_of_charge_mwh > battery.initial_soc_mwh
        # Nothing was curtailed, so the only thing the battery can do is empty.
        assert executed_peak <= battery.initial_soc_mwh + 1e-9

    def test_discharge_is_clipped_to_what_the_store_actually_holds(self) -> None:
        """A plan that discharges energy it never received cannot do so."""
        battery = Battery.from_round_trip(
            key="b",
            label="B",
            max_power_mw=100.0,
            energy_capacity_mwh=100.0,
            round_trip_efficiency=0.92,
            initial_state_of_charge=0.10,
        )
        schedule = Schedule(
            assets=(battery,),
            dispatch=(
                BatteryDispatch(
                    key="b",
                    label="B",
                    charge_mw=ALL_ZERO,
                    discharge_mw=(100.0,) * HORIZON_HOURS,
                    state_of_charge_mwh=(-1e9,) * HORIZON_HOURS,
                ),
            ),
            load_shift_up_mw=ALL_ZERO,
            load_shift_down_mw=ALL_ZERO,
        )

        scored = simulate(schedule, ALL_ZERO, threshold_mw=THRESHOLD_MW)

        delivered = sum(hour.battery_discharge_mw for hour in scored.hours)
        # 10 MWh stored, 5 MWh floor, ηd ≈ 0.959: the store, not the schedule,
        # is what bounds it.
        assert delivered == pytest.approx(5.0 * battery.discharge_efficiency)
        assert scored.state_of_charge_mwh[0][-1] == pytest.approx(battery.soc_floor_mwh)

    def test_a_realisation_of_a_different_length_is_a_bug_not_a_reindex(self) -> None:
        with pytest.raises(OptimizerBugError, match="hours"):
            simulate(reference_plan(), (0.0,) * 12, threshold_mw=THRESHOLD_MW)

    def test_a_negative_realisation_is_refused(self) -> None:
        with pytest.raises(OptimizerBugError, match="negative"):
            simulate(
                reference_plan(),
                (-1.0, *(0.0,) * (HORIZON_HOURS - 1)),
                threshold_mw=THRESHOLD_MW,
            )


class TestTheKpis:
    def test_the_plan_and_the_simulator_agree_on_the_planning_basis(self) -> None:
        """`simulate(optimize(r, S), r).recovered_mwh` == the MILP's own figure.

        Two independent derivations of the same physical quantity: the solver's
        `absorb` variables, and this module integrating the execution rule. They
        agree to 1e-6 or one of them is wrong, and the objective value — which
        carries the throughput penalty — could never have told us which.
        """
        for profile in (
            REFERENCE_PROFILE,
            (*(0.0,) * 8, *(200.0,) * 8, *(0.0,) * 8),
            (*(30.0,) * 24,),
            ALL_ZERO,
        ):
            plan = reference_plan(profile)
            scored = simulate(plan, profile, threshold_mw=THRESHOLD_MW)
            assert scored.recovered_mwh == pytest.approx(plan.absorbed_mwh, abs=1e-6)
            assert scored.baseline_mwh == pytest.approx(
                plan.baseline_curtailment_mwh, abs=1e-6
            )
            assert scored.remaining_mwh == pytest.approx(
                plan.remaining_curtailment_mwh, abs=1e-6
            )

    def test_the_baseline_is_not_filtered_by_the_threshold(self) -> None:
        """Sub-threshold hours count in the denominator; only the gate uses it.

        Otherwise the Avoidability Score would move when someone tuned an
        episode-detection parameter, which is a labelling decision and not a
        statement about what a battery can absorb.
        """
        profile = (*(0.0,) * 10, 2.0, 3.0, 100.0, *(0.0,) * 11)
        scored = simulate(reference_plan(profile), profile, threshold_mw=THRESHOLD_MW)
        assert scored.baseline_mwh == pytest.approx(105.0)

    def test_avoidability_is_none_and_never_zero_below_the_threshold(self) -> None:
        """A day of noise has an undefined ratio, not a triumphant one."""
        noise = (*(0.0,) * 12, 0.3, *(0.0,) * 11)
        scored = simulate(reference_plan(noise), noise, threshold_mw=THRESHOLD_MW)

        assert scored.baseline_mwh > 0.0
        assert scored.avoidability is None
        assert scored.has_curtailment_hour is False

    def test_the_gate_is_per_realisation(self) -> None:
        """`null` at P10 beside a real number at P50 is legitimate."""
        p50 = REFERENCE_PROFILE
        p10 = tuple(0.0 for _ in REFERENCE_PROFILE)
        p90 = tuple(value * 2.0 for value in REFERENCE_PROFILE)
        band = score_band(
            reference_plan(p50),
            p10_mwh=p10,
            p50_mwh=p50,
            p90_mwh=p90,
            threshold_mw=THRESHOLD_MW,
        )

        assert band.p10.avoidability is None
        assert band.p50.avoidability is not None
        assert band.p90.avoidability is not None
        # A fixed fleet covers less of a bigger event.
        assert band.p90.avoidability < band.p50.avoidability

    def test_the_floor_has_exactly_one_definition(self) -> None:
        band = score_band(
            reference_plan(),
            p10_mwh=tuple(v * 0.5 for v in REFERENCE_PROFILE),
            p50_mwh=REFERENCE_PROFILE,
            p90_mwh=tuple(v * 1.5 for v in REFERENCE_PROFILE),
            threshold_mw=THRESHOLD_MW,
        )
        assert band.recovered_floor_mwh == band.p10.recovered_mwh

    def test_recovered_is_not_delivered(self) -> None:
        """The two figures that stop the absorbed number being flattering."""
        plan = reference_plan()
        scored = simulate(plan, REFERENCE_PROFILE, threshold_mw=THRESHOLD_MW)

        assert scored.stored_at_horizon_end_mwh > 0.0
        assert scored.round_trip_loss_mwh > 0.0
        # Energy in = energy still stored + energy lost + energy delivered.
        battery = plan.assets[0]
        delivered = sum(hour.battery_discharge_mw for hour in scored.hours)
        closing = (
            battery.initial_soc_mwh
            + scored.recovered_mwh
            - scored.round_trip_loss_mwh
            - delivered
        )
        assert closing == pytest.approx(scored.stored_at_horizon_end_mwh, abs=1e-6)


class TestTheProperties:
    """Seam 2. Random plans, random realisations, 200 draws of each claim."""

    DRAWS = 200

    def test_monotonicity_the_floor_is_a_floor_over_the_band(self) -> None:
        """`r ≥ P10` pointwise ⇒ `recovered(plan, r) ≥ recovered(plan, P10)`.

        Without this the P10 figure is a hope rather than a floor: the product
        would be quoting a number a bigger day could come in under.
        """
        rng = random.Random(20260829)  # noqa: S311
        for _ in range(self.DRAWS):
            schedule = random_schedule(rng, batteries=rng.choice((1, 1, 2, 3)))
            low = random_realisation(rng)
            high = tuple(value + rng.uniform(0.0, 80.0) for value in low)

            floor = simulate(schedule, low, threshold_mw=THRESHOLD_MW)
            above = simulate(schedule, high, threshold_mw=THRESHOLD_MW)

            assert above.recovered_mwh >= floor.recovered_mwh - 1e-9

    def test_the_state_of_charge_never_leaves_its_bounds(self) -> None:
        rng = random.Random(11)  # noqa: S311
        for _ in range(self.DRAWS):
            schedule = random_schedule(rng, batteries=rng.choice((1, 2)))
            scored = simulate(
                schedule, random_realisation(rng), threshold_mw=THRESHOLD_MW
            )
            for battery, row in zip(
                schedule.assets, scored.state_of_charge_mwh, strict=True
            ):
                for value in row:
                    assert battery.soc_floor_mwh - 1e-9 <= value
                    assert value <= battery.soc_ceiling_mwh + 1e-9

    def test_absorbed_never_exceeds_offered_and_the_ratio_stays_in_range(
        self,
    ) -> None:
        rng = random.Random(2718)  # noqa: S311
        for _ in range(self.DRAWS):
            schedule = random_schedule(rng, batteries=rng.choice((1, 2)))
            realisation = random_realisation(rng)
            scored = simulate(schedule, realisation, threshold_mw=THRESHOLD_MW)

            for hour, offered in zip(scored.hours, realisation, strict=True):
                assert 0.0 <= hour.absorbed_mwh <= offered + 1e-9
            ratio = scored.avoidability
            assert ratio is None or 0.0 <= ratio <= 1.0

    def test_the_fleet_never_imports(self) -> None:
        """`Δ[t] ≤ curt[t]`, and `Δ[t] ≤ 0` where nothing was curtailed."""
        rng = random.Random(31415)  # noqa: S311
        for _ in range(self.DRAWS):
            schedule = random_schedule(rng, batteries=rng.choice((1, 2)))
            realisation = random_realisation(rng)
            scored = simulate(schedule, realisation, threshold_mw=THRESHOLD_MW)

            for hour, offered in zip(scored.hours, realisation, strict=True):
                assert hour.net_flexible_demand_mwh <= offered + 1e-9
                if offered == 0.0:
                    assert hour.net_flexible_demand_mwh <= 1e-9

    def test_an_all_zero_day_absorbs_nothing_whatever_the_plan(self) -> None:
        rng = random.Random(4)  # noqa: S311
        for _ in range(self.DRAWS):
            schedule = random_schedule(rng, batteries=rng.choice((1, 2, 3)))
            scored = simulate(schedule, ALL_ZERO, threshold_mw=THRESHOLD_MW)
            assert scored.recovered_mwh == 0.0
            assert all(hour.battery_charge_mw == 0.0 for hour in scored.hours)
