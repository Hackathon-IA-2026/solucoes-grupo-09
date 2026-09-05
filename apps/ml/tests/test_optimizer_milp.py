"""The MILP, against the research's own measured numbers.

Every failure mode in this formulation is silent: the model stays feasible, the
status says `OPTIMAL`, and the headline is *better*. So these tests assert
numbers `docs/research/optimizer-formulation.md` measured and properties the
formulation guarantees — never that a function exists.

**The reference case** is IDEA.md §27, reproduced in the research's §4.2 sweep
and in the spec's Testing Decisions: ``curt = [0]×10, 20, 70, 110, 90, 30, 10,
[0]×8``, one 100 MW / 250 MWh battery, ``ηc = ηd = 0.959``, 20 % initial state
of charge, 5–95 % bounds. It is the regression anchor for the whole engine, and
its efficiencies are written out rather than derived from a round-trip figure
because that is how the research parameterised the run these numbers come from.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import replace
from datetime import date

import pytest

from wattsteer_ml.constants import REFERENCE_FLEET
from wattsteer_ml.optimizer import (
    SHIPPED,
    Battery,
    DispatchPlan,
    ModelOptions,
    OptimizerBugError,
    PlanningEnvelope,
    available_between,
    local_day,
    reference_battery,
    solve,
)
from wattsteer_ml.optimizer.milp import UniqueNames

#: IDEA.md §27, the profile every measured number below was taken on.
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

#: The research's measured value at ``ρ = 0``, MWh of curtailment remaining.
RESEARCH_REMAINING_MWH = 95.3806

#: The LP relaxation's objective at ``ρ = 0`` — better than physics allows.
RESEARCH_LP_OBJECTIVE = 80.0932

#: A sustained event: eight hours at 200 MW, far more than the fleet can hold.
SUSTAINED_PROFILE: tuple[float, ...] = (*(0.0,) * 8, *(200.0,) * 8, *(0.0,) * 8)

HORIZON = local_day(date(2026, 8, 29))

LP = ModelOptions(mutual_exclusion=False)
CHARGE_ONLY = ModelOptions(net_discharge_into_absorption=False)


def reference_case() -> Battery:
    return Battery(
        key="battery",
        label="Battery",
        max_power_mw=100.0,
        energy_capacity_mwh=250.0,
        charge_efficiency=0.959,
        discharge_efficiency=0.959,
        initial_state_of_charge=0.20,
    )


def plan(
    profile: Sequence[float] = REFERENCE_PROFILE,
    *,
    battery: Battery | None = None,
    rho: float = 1.5,
    options: ModelOptions = SHIPPED,
    backend: str | None = None,
) -> DispatchPlan:
    if backend is None:
        backend = "SCIP" if options.mutual_exclusion else "GLOP"
    return solve(
        envelope=PlanningEnvelope.p50(profile),
        batteries=[battery if battery is not None else reference_case()],
        horizon=HORIZON,
        backend=backend,
        deg_penalty_rho=rho,
        options=options,
    )


def net_absorbable_mwh(result: DispatchPlan) -> float:
    """``Σ_{t : curt[t] > 0} Δ[t]`` — net intake in the hours absorption counts.

    The absorbed quantity has to be the *net* increase in flexible demand,
    which is what the grid actually sees. Counting the charge alone lets the
    model charge in a curtailment hour while discharging in another to stay in
    range, and report absorbing more than the fleet can hold.
    """
    return sum(hour.net_flexible_demand_mwh for hour in result.hours if hour.offered_mwh)


def physically_holdable_mwh(result: DispatchPlan) -> float:
    """Headroom to the SOC ceiling, plus whatever was given back for free.

    Energy discharged in an hour where nothing is being absorbed re-opens
    headroom at the round-trip efficiency; energy discharged *while* absorbing
    would be venting, which (B7)–(B8) forbid.
    """
    total = 0.0
    for battery, dispatch in zip(result.assets, result.batteries, strict=True):
        given_back = sum(
            dispatch.discharge_mw[hour.hour_local]
            for hour in result.hours
            if not hour.offered_mwh
        )
        total += (
            battery.soc_ceiling_mwh - battery.initial_soc_mwh
        ) / battery.charge_efficiency + given_back / battery.round_trip_efficiency
    return total


# --- Seam 1: the research's own measurements ---------------------------------


def test_the_reference_case_reproduces_the_researchs_measured_number() -> None:
    """95.4 MWh remaining at ``ρ = 0``. The anchor for the whole engine."""
    result = plan(rho=0.0)
    assert result.solver.status == "OPTIMAL"
    assert result.solver.backend == "SCIP"
    assert result.baseline_curtailment_mwh == pytest.approx(330.0)
    assert result.remaining_curtailment_mwh == pytest.approx(
        RESEARCH_REMAINING_MWH, abs=1e-3
    )
    # At ρ = 0 the objective *is* the remaining curtailment: nothing else is
    # priced, which is what makes the research's table comparable to this.
    assert result.solver.objective == pytest.approx(RESEARCH_REMAINING_MWH, abs=1e-3)


def test_the_throughput_penalty_breaks_ties_and_never_buys_off_a_real_mwh() -> None:
    """At the shipped ρ = 1.5 the same case is within 0.1 MWh of 95.4."""
    shipped = plan(rho=1.5)
    assert shipped.remaining_curtailment_mwh == pytest.approx(
        RESEARCH_REMAINING_MWH, abs=0.1
    )
    # The objective is *not* that number, and this is why it is never a KPI:
    # it carries the penalty and is not a physical quantity.
    assert shipped.solver.objective > shipped.remaining_curtailment_mwh


def test_the_venting_regression_fails_if_anyone_relaxes_the_binaries_away() -> None:
    """The LP claims ~15 MWh more than the battery can physically hold.

    It gets there by *venting*: pairing charge with discharge to burn stored
    energy and free headroom, in five of the six curtailment hours. The energy
    it vents goes nowhere the objective can see, so the venting is free — and
    the overstatement is 16 % of the product's central claim, in the direction
    that flatters it.
    """
    relaxed = plan(rho=0.0, options=LP)
    strict = plan(rho=0.0)
    assert relaxed.solver.objective == pytest.approx(RESEARCH_LP_OBJECTIVE, abs=1e-3)
    gap = strict.solver.objective - relaxed.solver.objective
    assert gap == pytest.approx(15.29, abs=0.05)
    assert relaxed.batteries[0].simultaneous_hours == (10, 11, 13, 14, 15)
    assert strict.batteries[0].simultaneous_hours == ()


def test_the_lp_cross_check_at_the_shipped_weights() -> None:
    """A non-zero gap here means the weights drifted into the venting regime.

    ``δ_b`` is defined relative to that threshold rather than as a flat
    constant precisely so this stays true at every efficiency the UI permits.
    """
    relaxed = plan(rho=1.5, options=LP)
    strict = plan(rho=1.5)
    assert relaxed.solver.objective == pytest.approx(strict.solver.objective, abs=1e-6)
    assert relaxed.batteries[0].simultaneous_hours == ()


def test_the_shipped_penalty_sits_above_the_venting_threshold() -> None:
    """``δ_b > k_b/(2 + k_b)`` is what the cross-check above rests on."""
    for rte in (0.50, 0.75, 0.92, 0.99):
        battery = Battery.from_round_trip(
            key="b",
            label="B",
            max_power_mw=100.0,
            energy_capacity_mwh=250.0,
            round_trip_efficiency=rte,
            initial_state_of_charge=0.2,
        )
        k = (1 - battery.round_trip_efficiency) / battery.round_trip_efficiency
        threshold = k / (2 + k)
        assert battery.throughput_penalty(1.5) == pytest.approx(1.5 * threshold)
        assert battery.throughput_penalty(1.5) > threshold


def test_the_penalty_invariant_is_asserted_at_build_time_as_a_wattsteer_bug() -> None:
    """``δ_b · (1 + RTE_b) < 1``: the penalty cannot outweigh a recovered MWh.

    A `500`, not a `422` — the caller supplied an efficiency, and ``ρ`` is ours.
    """
    with pytest.raises(OptimizerBugError, match="buy off a recovered MWh"):
        plan(rho=40.0)


def test_solving_on_highs_reaches_the_same_number() -> None:
    """The fallback backend is a fallback, not a different answer."""
    assert plan(backend="HIGHS").remaining_curtailment_mwh == pytest.approx(
        plan(backend="SCIP").remaining_curtailment_mwh, abs=1e-6
    )


# --- The sign split ----------------------------------------------------------


def test_the_sign_split_lets_the_battery_net_discharge() -> None:
    """The bug the research hit: feasible, plausible, and never discharging.

    Writing (C4) unconditionally — ``absorb[t] ≤ Δ[t]`` with ``absorb[t] ≥ 0``
    at every hour — silently implies ``Δ[t] ≥ 0`` everywhere. On this profile,
    whose curtailment ends at hour 15 while the day runs to 23, the optimal
    plan *must* net-discharge to open headroom before the event.
    """
    result = plan(rho=1.5)
    deltas = result.net_flexible_demand_mwh
    assert min(deltas) < -1.0, "the battery never net-discharges"
    # And the consequence: without discharging first it could only take the
    # headroom it started with, (S̄ − S⁰)/ηc = 195.5 MWh.
    battery = result.assets[0]
    without_discharging = (
        battery.soc_ceiling_mwh - battery.initial_soc_mwh
    ) / battery.charge_efficiency
    assert result.absorbed_mwh > without_discharging + 1.0


def test_the_no_import_rules_hold_in_every_hour() -> None:
    """(C2) and (C5): "absorbing curtailment" is never "buying grid energy"."""
    result = plan(rho=1.5)
    for hour in result.hours:
        assert hour.net_flexible_demand_mwh <= hour.offered_mwh + 1e-6
        if not hour.offered_mwh:
            assert hour.net_flexible_demand_mwh <= 1e-6
        assert 0.0 <= hour.absorbed_mwh <= hour.offered_mwh + 1e-6


# --- The netting -------------------------------------------------------------


@pytest.mark.parametrize("profile", [REFERENCE_PROFILE, SUSTAINED_PROFILE])
def test_absorbed_energy_never_exceeds_what_the_fleet_can_hold(
    profile: tuple[float, ...],
) -> None:
    result = plan(profile, rho=1.5)
    assert result.absorbed_mwh <= net_absorbable_mwh(result) + 1e-6
    assert result.absorbed_mwh <= physically_holdable_mwh(result) + 1e-6


@pytest.mark.parametrize("profile", [REFERENCE_PROFILE, SUSTAINED_PROFILE])
def test_the_charge_only_objective_violates_both_of_those(
    profile: tuple[float, ...],
) -> None:
    """IDEA.md §28's under-specified objective, built so it can be falsified.

    Counting the charge alone frees the model to discharge inside a curtailment
    hour purely to reopen headroom, and then to report the whole charge as
    absorbed. On the sustained profile it claims more than twice what the
    battery can hold.
    """
    wrong = plan(profile, rho=1.5, options=CHARGE_ONLY)
    assert wrong.absorbed_mwh > net_absorbable_mwh(wrong) + 1.0
    assert wrong.absorbed_mwh > physically_holdable_mwh(wrong) + 1.0
    assert wrong.absorbed_mwh > plan(profile, rho=1.5).absorbed_mwh + 1.0


# --- Availability ------------------------------------------------------------


def test_an_asset_outside_its_window_has_every_variable_fixed_to_zero() -> None:
    """And its state of charge simply persists — (B1) with ch = dis = 0."""
    contracted = available_between(reference_case(), 11, 18)
    result = plan(battery=contracted, rho=1.5)
    dispatch = result.batteries[0]
    for hour in range(24):
        if 11 <= hour < 18:
            continue
        assert dispatch.charge_mw[hour] == pytest.approx(0.0, abs=1e-9)
        assert dispatch.discharge_mw[hour] == pytest.approx(0.0, abs=1e-9)
    # Hours 0–10 are outside the window, so the state of charge has not moved
    # from S⁰ by the time the window opens.
    assert dispatch.state_of_charge_mwh[10] == pytest.approx(
        contracted.initial_soc_mwh, abs=1e-6
    )
    # And it holds whatever it ends the window with, all the way to midnight.
    assert dispatch.state_of_charge_mwh[23] == pytest.approx(
        dispatch.state_of_charge_mwh[17], abs=1e-6
    )


def test_a_window_that_misses_the_event_recovers_nothing() -> None:
    result = plan(battery=available_between(reference_case(), 0, 4), rho=1.5)
    assert result.absorbed_mwh == pytest.approx(0.0, abs=1e-6)
    assert result.remaining_curtailment_mwh == pytest.approx(330.0, abs=1e-6)


def test_a_window_outside_the_horizon_is_a_wattsteer_bug() -> None:
    with pytest.raises(OptimizerBugError):
        available_between(reference_case(), 20, 30)


# --- Feasibility, the invariant that makes INFEASIBLE a 500 ------------------


@pytest.mark.parametrize(
    "profile",
    [
        (0.0,) * 24,
        REFERENCE_PROFILE,
        SUSTAINED_PROFILE,
        tuple(float(hour) for hour in range(24)),
    ],
)
@pytest.mark.parametrize("initial", [0.05, 0.2, 0.95])
def test_every_valid_scenario_solves_to_optimal(
    profile: tuple[float, ...], initial: float
) -> None:
    """The do-nothing dispatch satisfies every constraint, so this cannot fail.

    Which is what justifies treating `INFEASIBLE` as a `500`: if the solver
    ever says otherwise, validation let something through.
    """
    battery = replace(reference_case(), initial_state_of_charge=initial)
    assert plan(profile, battery=battery).solver.status == "OPTIMAL"


def test_a_day_with_nothing_to_absorb_yields_the_do_nothing_dispatch() -> None:
    result = plan((0.0,) * 24, rho=1.5)
    assert result.absorbed_mwh == pytest.approx(0.0, abs=1e-9)
    assert result.baseline_curtailment_mwh == 0.0
    assert all(hour.net_flexible_demand_mwh <= 1e-6 for hour in result.hours)


def test_a_scenario_with_no_assets_is_the_baseline_itself() -> None:
    """ "Baseline" means no action at all, which here *is* the profile."""
    empty = solve(
        envelope=PlanningEnvelope.p50(REFERENCE_PROFILE),
        batteries=[],
        horizon=HORIZON,
        backend="SCIP",
        deg_penalty_rho=1.5,
    )
    assert empty.absorbed_mwh == pytest.approx(0.0, abs=1e-9)
    assert empty.remaining_curtailment_mwh == pytest.approx(330.0)
    assert empty.stored_at_horizon_end_mwh == 0.0


# --- The physics of the extracted plan ---------------------------------------


def test_the_state_of_charge_balance_holds_asymmetrically() -> None:
    """(B1): ``×ηc`` on the way in and ``÷ηd`` on the way out.

    IDEA.md's single `efficiency` term is the correction this asserts.
    """
    result = plan(rho=1.5)
    battery, dispatch = result.assets[0], result.batteries[0]
    previous = battery.initial_soc_mwh
    for hour in range(24):
        expected = (
            previous
            + battery.charge_efficiency * dispatch.charge_mw[hour]
            - dispatch.discharge_mw[hour] / battery.discharge_efficiency
        )
        assert dispatch.state_of_charge_mwh[hour] == pytest.approx(expected, abs=1e-6)
        assert battery.soc_floor_mwh - 1e-6 <= expected <= battery.soc_ceiling_mwh + 1e-6
        previous = dispatch.state_of_charge_mwh[hour]


def test_a_single_round_trip_number_splits_into_the_pair_the_model_needs() -> None:
    """0.92 becomes 0.959, and `apps/web`'s `optimize.ts` splits the same way."""
    battery = reference_battery()
    assert battery.charge_efficiency == pytest.approx(0.9592, abs=5e-5)
    assert battery.charge_efficiency == battery.discharge_efficiency
    assert battery.round_trip_efficiency == pytest.approx(0.92)


def test_the_published_reference_fleet_is_what_the_optimizer_plans_with() -> None:
    """One fleet, published once. There is no fourth one defined here."""
    battery = reference_battery()
    published = REFERENCE_FLEET.battery
    assert battery.max_power_mw == published.max_power_mw
    assert battery.energy_capacity_mwh == published.energy_capacity_mwh
    assert battery.initial_state_of_charge == published.initial_state_of_charge
    result = plan(battery=battery, rho=1.5)
    assert result.solver.status == "OPTIMAL"
    # 300 MWh at 92 % holds more of the event than the 250 MWh research case,
    # and still not all of it: hour 12 offers 110 MW against a 100 MW inverter.
    assert result.absorbed_mwh > plan(rho=1.5).absorbed_mwh
    assert result.absorbed_mwh < result.baseline_curtailment_mwh


def test_there_is_no_terminal_state_of_charge_constraint() -> None:
    """The consequence is reported instead of constrained away."""
    result = plan(rho=1.5)
    assert result.stored_at_horizon_end_mwh > result.assets[0].initial_soc_mwh


# --- Operational rules from the research -------------------------------------


def test_the_name_guard_refuses_to_name_a_variable_twice() -> None:
    """A duplicate aborts the whole process under CBC. The check is free."""
    names = UniqueNames()
    assert names("ch", "battery", "t00") == "ch[battery|t00]"
    assert names("ch", "battery", "t01") == "ch[battery|t01]"
    with pytest.raises(OptimizerBugError, match="duplicate MILP variable name"):
        names("ch", "battery", "t00")


def test_every_variable_in_a_built_model_went_through_that_guard() -> None:
    """Distinct names and variables agreeing is what makes it whole-model."""
    result = plan(rho=1.5)
    # 24 each of charge, discharge, state of charge, mode and absorb.
    assert result.solver.variables == 24 * 5
    assert result.solver.constraints > 0


def test_a_fleet_with_two_batteries_of_the_same_key_is_refused() -> None:
    duplicated = [reference_case(), reference_case()]
    with pytest.raises(OptimizerBugError, match="unique"):
        solve(
            envelope=PlanningEnvelope.p50(REFERENCE_PROFILE),
            batteries=duplicated,
            horizon=HORIZON,
            backend="SCIP",
        )


def test_two_distinctly_keyed_batteries_build_and_solve() -> None:
    second = replace(reference_case(), key="battery-2", label="Battery 2")
    result = plan(battery=None, rho=1.5)
    pair = solve(
        envelope=PlanningEnvelope.p50(REFERENCE_PROFILE),
        batteries=[reference_case(), second],
        horizon=HORIZON,
        backend="SCIP",
        deg_penalty_rho=1.5,
    )
    assert pair.solver.status == "OPTIMAL"
    assert len(pair.batteries) == 2
    assert pair.absorbed_mwh > result.absorbed_mwh


def test_the_solution_survives_the_solver_going_out_of_scope() -> None:
    """`solution_value()` segfaults once its `MPSolver` is collected.

    Nothing here returns a variable handle, so a plan read after a garbage
    collection is still a plan and not a crash.
    """
    import gc

    result = plan(rho=1.5)
    gc.collect()
    assert result.batteries[0].charge_mw[13] > 0.0
    assert result.solver.wall_time_ms >= 0.0


def test_a_profile_of_the_wrong_length_is_refused() -> None:
    with pytest.raises(OptimizerBugError, match="hours"):
        solve(
            envelope=PlanningEnvelope.p50([0.0] * 23),
            batteries=[reference_case()],
            horizon=HORIZON,
        )


def test_the_reference_case_solves_well_inside_the_ci_guard() -> None:
    """Two orders of magnitude loose: it defends against an O(T²) builder.

    Model construction, not `Solve()`, dominates the request — so this times
    the whole call, not the solver.
    """
    started = time.perf_counter()
    plan(rho=1.5)
    assert (time.perf_counter() - started) * 1000.0 < 500.0
