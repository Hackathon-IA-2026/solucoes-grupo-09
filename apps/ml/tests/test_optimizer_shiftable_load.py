"""The second asset: a shiftable load that always gives the energy back.

Zerrahn & Schill's (D1)–(D5), against the properties the formulation exists to
guarantee — never against the shape of a function. Two of these properties are
the entire reason the *double-indexed* form was chosen over the single-indexed
one, and both of them are invisible in a total:

* daily energy is conserved **by construction**, with no daily-energy row in the
  model at all, and
* a down-shift never lands more than ``L`` hours from the up-shift it
  compensates — the **undue recovery** the single-index model permits while its
  daily total still balances perfectly.

The third property under test is not about the load at all. It is that adding a
second `FlexibilityAsset` variant moved nothing else: not the common fields, not
the transport, not the result shape, not the simulator, not the KPI definitions.
That is worth verifying now, with two variants, rather than asserting it later
with five.

The reference case is IDEA.md §27's profile again, with `packages/core`'s
published `REFERENCE_FLEET` — one 100 MW / 300 MWh battery and one 70 MW load
with 50 MW shiftable over ``L = 3``. There is no second fleet defined here.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date

import pytest

from wattsteer_ml.constants import REFERENCE_FLEET
from wattsteer_ml.optimizer import (
    Battery,
    DispatchPlan,
    OptimizerBugError,
    Schedule,
    ShiftableLoad,
    available_between,
    local_day,
    reference_battery,
    reference_load,
    simulate,
    solve,
)
from wattsteer_ml.optimizer.horizon import HORIZON_HOURS

#: IDEA.md §27, the profile the whole engine is anchored on.
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

#: Twelve hours of curtailment followed by twelve of none. Every hour a load
#: could give energy back in is *outside* the event, which is what makes the
#: shift window the binding constraint rather than the power limit.
BLOCK_PROFILE: tuple[float, ...] = (*(100.0,) * 12, *(0.0,) * 12)

HORIZON = local_day(date(2026, 8, 29))

#: Float noise, and the tolerance the ticket names for energy conservation.
EXACT = 1e-9


def plan(
    profile: tuple[float, ...] = REFERENCE_PROFILE,
    *,
    batteries: tuple[Battery, ...] = (),
    loads: tuple[ShiftableLoad, ...] = (),
    rho: float = 1.5,
) -> DispatchPlan:
    return solve(
        offered_mwh=profile,
        batteries=batteries,
        loads=loads,
        horizon=HORIZON,
        deg_penalty_rho=rho,
    )


def with_load(
    *,
    key: str = "load",
    max_shift_mw: float | None = None,
    shift_window_hours: int | None = None,
    daily_energy_mwh: float | None = None,
    recovery_time_hours: int | None = None,
) -> ShiftableLoad:
    """The published load, with one field moved. Never a second fleet."""
    published = reference_load()
    return replace(
        published,
        key=key,
        max_shift_mw=(published.max_shift_mw if max_shift_mw is None else max_shift_mw),
        shift_window_hours=(
            published.shift_window_hours
            if shift_window_hours is None
            else shift_window_hours
        ),
        daily_energy_mwh=(
            published.daily_energy_mwh if daily_energy_mwh is None else daily_energy_mwh
        ),
        recovery_time_hours=recovery_time_hours,
    )


# --- Seam 1: the load joins the fleet, through (C1) and nothing else ---------


def test_a_battery_and_load_fleet_solves_and_the_load_appears_in_the_net_demand() -> None:
    """The first acceptance box: `OPTIMAL`, and the load is *in* ``Δ[t]``."""
    result = plan(batteries=(reference_battery(),), loads=(reference_load(),))
    assert result.solver.status == "OPTIMAL"
    assert result.load_dispatch[0].shifted_mwh > 0.0
    for hour in result.hours:
        expected = (
            hour.battery_charge_mw
            - hour.battery_discharge_mw
            + hour.load_shift_up_mw
            - hour.load_shift_down_mw
        )
        assert hour.net_flexible_demand_mwh == pytest.approx(expected, abs=EXACT)
    # An hour the load lifts on its own is an hour Δ[t] is positive without the
    # battery having done anything, which is the term being present rather than
    # merely declared.
    lifted = [
        hour
        for hour in result.hours
        if hour.load_shift_up_mw > 0.0 and hour.battery_charge_mw == 0.0
    ]
    assert lifted, "the load never moved demand on its own."
    assert all(hour.net_flexible_demand_mwh > 0.0 for hour in lifted)


def test_the_load_recovers_energy_the_battery_alone_leaves_behind() -> None:
    """330 MWh of curtailment, and the pair take all of it. The battery cannot.

    The battery is capped by its inverter — hour 12 offers 110 MW against 100 MW
    — and by its own state, and leaves ~49 MWh on the table. The load has no
    store to fill: it moves demand, gives it back inside three hours, and closes
    the gap.
    """
    alone = plan(batteries=(reference_battery(),))
    together = plan(batteries=(reference_battery(),), loads=(reference_load(),))
    assert alone.absorbed_mwh < together.absorbed_mwh
    assert together.absorbed_mwh == pytest.approx(together.baseline_curtailment_mwh)
    assert together.remaining_curtailment_mwh == pytest.approx(0.0, abs=1e-6)


def test_a_load_on_its_own_is_a_fleet() -> None:
    """No battery anywhere in the model, and the day still improves."""
    result = plan(loads=(reference_load(),))
    assert result.solver.status == "OPTIMAL"
    assert result.absorbed_mwh > 0.0
    assert result.batteries == ()
    assert result.stored_at_horizon_end_mwh == 0.0


def test_the_model_is_the_size_the_research_measured() -> None:
    """One battery, one load, ``T = 24``: the research's §5 row, row for row.

    282 variables and 198 constraints there; 300 and 198 here. The eighteen are
    ticket 01's decision to give ``absorb[t]`` an index in every hour and pin the
    ones with nothing to absorb to ``[0, 0]``, where the research defined the
    variable only where ``curt[t] > 0`` — six hours on this profile. The
    constraint count matching exactly is the part that says the (D) block is the
    published one and not a variation on it.
    """
    result = plan(batteries=(reference_battery(),), loads=(reference_load(),))
    pinned = sum(1 for hour in REFERENCE_PROFILE if hour == 0.0)
    assert result.solver.variables == 282 + pinned
    assert result.solver.constraints == 198


# --- Seam 2: the Zerrahn & Schill properties --------------------------------


def test_daily_energy_is_conserved_to_1e_9() -> None:
    """(D1), summed. There is no daily-energy row in the model to do this.

    ``Σ_t up[a,t] = Σ_t' down[a,t']`` falls out of one equality per up-shift
    hour, because every ``do[a,t,t']`` this builder creates has both indices
    inside the horizon. A spec that added the equality anyway would be asserting
    something the model already guarantees, and would make an infeasible model
    far harder to diagnose.
    """
    for profile in (REFERENCE_PROFILE, BLOCK_PROFILE):
        result = plan(
            profile, batteries=(reference_battery(),), loads=(reference_load(),)
        )
        for dispatch in result.load_dispatch:
            assert dispatch.shifted_mwh == pytest.approx(dispatch.returned_mwh, abs=EXACT)
            assert dispatch.shifted_mwh > 0.0
        hourly_up = sum(hour.load_shift_up_mw for hour in result.hours)
        hourly_down = sum(hour.load_shift_down_mw for hour in result.hours)
        assert hourly_up == pytest.approx(hourly_down, abs=EXACT)


def test_no_down_shift_lands_further_than_the_window_from_its_up_shift() -> None:
    """The double index, read back off the solve.

    Every compensation is tagged with the up-shift it pays for, so "within ``L``
    hours" is a property of the plan and not of a total. The second assertion is
    what stops this being vacuous: the window is *reached*, so a formulation
    that quietly widened it would have somewhere to go.
    """
    load = reference_load()
    result = plan(loads=(load,))
    compensations = result.load_dispatch[0].compensations
    assert compensations
    assert all(pair.distance_hours <= load.shift_window_hours for pair in compensations)
    assert max(pair.distance_hours for pair in compensations) == load.shift_window_hours


def test_the_window_binds_where_the_single_index_form_would_permit_undue_recovery() -> (
    None
):
    """Twelve hours of curtailment, and only ``L`` hours' worth is absorbable.

    Every hour this load could give energy back in lies after the event, so the
    only up-shifts that pay are the last ``L`` of it — and the plan recovers
    exactly ``L · C̄up``, for ``L`` = 1, 2, 3 and 6. The single-index model
    balances the same daily energy while letting a down-shift land arbitrarily
    far from the up-shift it compensates: it would shift all twelve hours and
    claim 600 MWh, which is Zerrahn & Schill's *"serious overestimation of
    longer-term load shifts"* and the reason the double index is not decoration.
    """
    undue_recovery_mwh = 12 * reference_load().max_shift_mw
    for window_hours in (1, 2, 3, 6):
        load = with_load(shift_window_hours=window_hours)
        result = plan(BLOCK_PROFILE, loads=(load,))
        assert result.absorbed_mwh == pytest.approx(
            window_hours * load.max_shift_mw, abs=1e-6
        )
        assert result.absorbed_mwh < undue_recovery_mwh


def test_no_hour_sheds_more_than_the_flat_baseline() -> None:
    """A load cannot be shed by more power than the process actually draws."""
    load = reference_load()
    result = plan(batteries=(reference_battery(),), loads=(load,))
    assert load.flat_baseline_mw == pytest.approx(load.daily_energy_mwh / 24)
    for hour in result.hours:
        assert hour.load_shift_down_mw <= load.flat_baseline_mw + EXACT


def test_the_published_fleet_sits_below_the_baseline_cap_with_room() -> None:
    """71 % of the cap, and both languages assert that margin.

    The prototype's default — 70 MW of shift against 1,200 MWh/day — is a
    `SHIFT_EXCEEDS_BASELINE` refusal, and both single-field repairs sit on the
    validity boundary (98.8 % and exactly 100 %). A constant this many numbers
    are compared against must not be one rounding away from a 422.
    """
    load = reference_load()
    published = REFERENCE_FLEET.shiftable_load
    assert load.max_shift_mw == published.max_shift_mw
    assert load.daily_energy_mwh == published.daily_energy_mwh
    assert load.shift_window_hours == published.shift_window_hours
    assert load.max_shift_mw / load.flat_baseline_mw == pytest.approx(0.7059, abs=5e-5)


def test_a_load_that_sheds_harder_than_it_runs_is_a_wattsteer_bug() -> None:
    """Validation's rule, re-asserted where the model would otherwise be feasible.

    The prototype's fixture builds a perfectly solvable model whose plan sheds a
    process by more power than it draws. It is a `422` at the gateway; here it is
    a WattSteer bug, because the ml service trusts nothing it did not validate
    itself and this one fails *silently* and flatteringly.
    """
    with pytest.raises(OptimizerBugError, match="flat baseline"):
        plan(loads=(with_load(max_shift_mw=70.0, daily_energy_mwh=1200.0),))
    with pytest.raises(OptimizerBugError, match="connection limit"):
        plan(loads=(with_load(max_shift_mw=80.0, daily_energy_mwh=100_000.0),))


# --- Seam 3: (D5), off by default -------------------------------------------


def test_a_load_without_a_recovery_time_has_no_d5_rows_in_the_model() -> None:
    """Off by default, and *absent* rather than trivially satisfied.

    (D5) is one row per hour. A model that emitted them with a vacuous bound
    would pass every behavioural test here and would still be a model with a
    recovery time in it.
    """
    without = plan(loads=(reference_load(),))
    with_recovery = plan(loads=(with_load(recovery_time_hours=6),))
    assert with_recovery.solver.constraints - without.solver.constraints == (
        HORIZON_HOURS
    )
    assert with_recovery.solver.variables == without.solver.variables


def test_a_recovery_time_binds_and_costs_the_day_energy() -> None:
    """A freezer that cannot cycle every three hours recovers strictly less.

    ``Σ_t'=t..t+R−1 up[t'] ≤ C̄up·L``: over any six hours the load may shift no
    more than one DSM cycle's worth, 150 MWh. The plan runs *into* that bound —
    a constraint that never binds would be evidence of nothing.
    """
    load = with_load(recovery_time_hours=6)
    free = plan(loads=(reference_load(),))
    limited = plan(loads=(load,))
    assert limited.solver.status == "OPTIMAL"
    assert limited.absorbed_mwh < free.absorbed_mwh
    up = limited.load_dispatch[0].shift_up_mw
    windows = [sum(up[start : start + 6]) for start in range(HORIZON_HOURS)]
    assert max(windows) == pytest.approx(load.cycle_energy_mwh, abs=1e-6)
    assert all(total <= load.cycle_energy_mwh + EXACT for total in windows)


def test_a_recovery_time_of_zero_is_not_a_recovery_time() -> None:
    """`null` means no (D5) block; zero means a load that can never shift."""
    with pytest.raises(OptimizerBugError, match="recovery time"):
        plan(loads=(with_load(recovery_time_hours=0),))


# --- Seam 4: the common fields, and everything that did not move -------------


def test_the_dispatch_carries_the_shift_per_hour() -> None:
    """The result contract's ``load_shift_up_mw`` / ``load_shift_down_mw``."""
    result = plan(batteries=(reference_battery(),), loads=(reference_load(),))
    assert len(result.hours) == HORIZON_HOURS
    dispatch = result.load_dispatch[0]
    for hour in result.hours:
        assert hour.load_shift_up_mw == pytest.approx(
            dispatch.shift_up_mw[hour.hour_local]
        )
        assert hour.load_shift_down_mw == pytest.approx(
            dispatch.shift_down_mw[hour.hour_local]
        )
    assert any(hour.load_shift_up_mw > 0.0 for hour in result.hours)
    assert any(hour.load_shift_down_mw > 0.0 for hour in result.hours)


def test_a_battery_only_plan_is_exactly_what_it_was_before_the_variant() -> None:
    """The regression the whole "one more term" claim rests on.

    A fleet with no load builds the same model it built when no load existed:
    same size, same dispatch, and every hour's shift reading as the zero it is.
    """
    result = plan(batteries=(reference_battery(),))
    assert result.loads == ()
    assert result.load_dispatch == ()
    assert result.shifted_mwh == 0.0
    assert all(hour.load_shift_up_mw == 0.0 for hour in result.hours)
    assert all(hour.load_shift_down_mw == 0.0 for hour in result.hours)
    explicit = plan(batteries=(reference_battery(),), loads=())
    assert explicit.absorbed_mwh == pytest.approx(result.absorbed_mwh)
    assert explicit.solver.variables == result.solver.variables
    assert explicit.solver.constraints == result.solver.constraints


def test_the_simulator_scores_the_load_through_the_same_function_unchanged() -> None:
    """The one implementation of the execution rule, not a second one.

    ``Δ[t]`` already had both shift terms in it before the load existed, so what
    ticket 05 added was the seam reading them off the plan — the rule itself, and
    every KPI derived from it, is the code ticket 02 shipped.
    """
    result = plan(batteries=(reference_battery(),), loads=(reference_load(),))
    schedule = Schedule.from_plan(result)
    assert schedule.load_shift_up_mw == tuple(
        hour.load_shift_up_mw for hour in result.hours
    )
    assert schedule.load_shift_down_mw == tuple(
        hour.load_shift_down_mw for hour in result.hours
    )
    scored = simulate(result, REFERENCE_PROFILE, threshold_mw=5.0)
    # The one realisation on which the plan's own scalars and the simulator's
    # coincide: the profile it was planned against.
    assert scored.recovered_mwh == pytest.approx(result.absorbed_mwh, abs=1e-6)
    for planned, executed in zip(result.hours, scored.hours, strict=True):
        assert executed.load_shift_up_mw == pytest.approx(planned.load_shift_up_mw)
        assert executed.load_shift_down_mw == pytest.approx(planned.load_shift_down_mw)


def test_a_plan_with_a_load_executed_against_a_day_that_never_came() -> None:
    """Absorbs exactly zero, imports exactly nothing. The negative case."""
    result = plan(batteries=(reference_battery(),), loads=(reference_load(),))
    scored = simulate(result, (0.0,) * HORIZON_HOURS, threshold_mw=5.0)
    assert scored.recovered_mwh == 0.0
    assert scored.avoidability is None


def test_a_shifted_load_contributes_nothing_to_the_round_trip_loss() -> None:
    """v1's load is lossless: what it moves, it gives back in full.

    Shift losses are Zerrahn & Schill's eq. 7′ and are not implemented — adding
    ``shift_efficiency`` later is a coefficient on the left of (D1) and nothing
    else, and this is the assertion that would then have to change.
    """
    scored = simulate(
        plan(loads=(reference_load(),)), REFERENCE_PROFILE, threshold_mw=5.0
    )
    assert scored.round_trip_loss_mwh == 0.0
    assert scored.stored_at_horizon_end_mwh == 0.0
    assert scored.recovered_mwh > 0.0


def test_an_availability_window_pins_every_shift_outside_it_to_zero() -> None:
    """A common field, one helper, both variants. Availability is not per-type."""
    load = available_between(reference_load(), 12, 20)
    result = plan(loads=(load,))
    assert result.solver.status == "OPTIMAL"
    dispatch = result.load_dispatch[0]
    for hour in range(HORIZON_HOURS):
        if 12 <= hour < 20:
            continue
        assert dispatch.shift_up_mw[hour] == pytest.approx(0.0, abs=EXACT)
        assert dispatch.shift_down_mw[hour] == pytest.approx(0.0, abs=EXACT)
    assert all(12 <= pair.up_hour < 20 for pair in dispatch.compensations)
    assert all(12 <= pair.down_hour < 20 for pair in dispatch.compensations)
    assert dispatch.shifted_mwh > 0.0


def test_a_window_outside_the_horizon_is_a_wattsteer_bug_for_a_load_too() -> None:
    with pytest.raises(OptimizerBugError, match="availability"):
        available_between(reference_load(), 20, 30)


def test_two_loads_and_a_battery_share_one_key_space() -> None:
    """A key names an asset's MILP variables, whichever variant it is."""
    result = plan(
        batteries=(reference_battery("b1"),),
        loads=(with_load(key="l1"), with_load(key="l2")),
    )
    assert result.solver.status == "OPTIMAL"
    assert len(result.load_dispatch) == 2
    assert result.shifted_mwh > 0.0
    with pytest.raises(OptimizerBugError, match="unique"):
        plan(
            batteries=(reference_battery("shared"),),
            loads=(with_load(key="shared"),),
        )
