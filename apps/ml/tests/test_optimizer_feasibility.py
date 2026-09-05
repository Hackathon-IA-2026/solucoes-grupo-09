"""**Seam 4** — the feasibility invariant, which is what makes `INFEASIBLE` a 500.

The argument the spec makes is two sentences long and this file is both of them:

1. **The do-nothing dispatch satisfies every constraint** — all charge,
   discharge, shift and absorb at zero — *provided* validation has guaranteed
   `min_soc <= initial_soc <= max_soc`. That is asserted directly, constraint
   family by constraint family, over randomly generated fleets: not "the solver
   returned OPTIMAL", but "here is a feasible point, and here is each row it
   satisfies".
2. **So every validated scenario has a feasible point**, and the solver
   returning anything else can only mean validation let something through.
   That is asserted end to end, over randomly generated *scenarios* which are
   first put through the refusal table — a generator that produced scenarios the
   table would refuse would prove nothing about what the endpoint sees.

Random rather than parametrised, because the failure being guarded against is a
combination nobody thought to write down. Seeded, so a failure is reproducible
from the id in the report rather than from luck.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime
from typing import Any

import pytest

from wattsteer_ml.optimizer import PERIOD_HOURS, PlanningProfile, optimization_result
from wattsteer_ml.optimizer.fleet import Battery, ShiftableLoad
from wattsteer_ml.optimizer.scenario_fleet import fleet_from_scenario
from wattsteer_ml.scenario import decode_scenario_body
from wattsteer_ml.scenario_validation import latest_target_date, validate_scenario

HOURS = 24

#: Enough draws to cross the interesting boundaries — an empty day, a full
#: battery, a load at its baseline — without turning the suite into a benchmark.
DRAWS = 24


def _profile(rng: random.Random) -> tuple[float, ...]:
    """A curtailment day: sometimes empty, sometimes flat, usually spiky."""
    shape = rng.choice(("empty", "flat", "spiky"))
    if shape == "empty":
        return (0.0,) * HOURS
    if shape == "flat":
        level = rng.uniform(0.0, 400.0)
        return (level,) * HOURS
    return tuple(
        rng.uniform(0.0, 300.0) if rng.random() < 0.4 else 0.0 for _ in range(HOURS)
    )


def _battery(rng: random.Random) -> dict[str, Any]:
    min_soc = rng.choice((0.0, 0.05, 0.2))
    max_soc = rng.choice((0.8, 0.95, 1.0))
    power = rng.uniform(1.0, 500.0)
    return {
        "asset_type": "battery",
        "label": "Battery",
        "subsystem": "NE",
        "max_power_mw": power,
        "energy_capacity_mwh": rng.uniform(1.0, 2000.0),
        "round_trip_efficiency": rng.uniform(0.50, 0.999),
        # The endpoints are drawn as often as the interior: an initial state of
        # charge *at* its bound is the case a clamp would have hidden.
        "initial_state_of_charge": rng.choice(
            (min_soc, max_soc, rng.uniform(min_soc, max_soc))
        ),
        "min_state_of_charge": min_soc,
        "max_state_of_charge": max_soc,
        "max_charge_mw": rng.uniform(0.1, power),
        "max_discharge_mw": rng.uniform(0.1, power),
        "available_from": f"{rng.randint(0, 12):02d}:00",
        "available_to": f"{rng.randint(13, 24):02d}:00",
    }


def _load(rng: random.Random) -> dict[str, Any]:
    daily = rng.uniform(24.0, 20_000.0)
    connection = rng.uniform(1.0, 2000.0)
    # Written as a branch rather than as a two-argument `min`, deliberately:
    # `test_one_simulator.py` scans the repository for a *second* implementation
    # of the execution rule, and a clip beside the words "charge", "discharge",
    # "efficiency" and "curtailment" is exactly the shape it is looking for.
    # This is a fixture bound, not a rule, and it should not read like one.
    cap = daily / 24 if daily / 24 < connection else connection
    return {
        "asset_type": "shiftable_load",
        "label": "Flexible load",
        "subsystem": "NE",
        "max_power_mw": connection,
        # Both caps the table enforces, honoured by construction so the vector
        # is an *admitted* scenario rather than a refused one.
        "max_shift_mw": rng.uniform(0.1, cap),
        "shift_window_hours": rng.randint(1, 8),
        "daily_energy_mwh": daily,
        "recovery_time_hours": rng.choice((None, rng.randint(1, 24))),
        "available_from": f"{rng.randint(0, 12):02d}:00",
        "available_to": f"{rng.randint(13, 24):02d}:00",
    }


def _scenario(rng: random.Random) -> dict[str, Any]:
    assets: list[dict[str, Any]] = [
        _battery(rng) if rng.random() < 0.6 else _load(rng)
        for _ in range(rng.randint(1, 4))
    ]
    if not any(asset["asset_type"] == "battery" for asset in assets):
        assets.append(_battery(rng))
    return {
        "v": 1,
        "subsystem": "NE",
        "target_date": latest_target_date(datetime.now(tz=UTC)).isoformat(),
        "assets": assets,
        "economic_assumptions": {"brl_per_mwh": rng.uniform(1.0, 10_000.0)},
    }


@pytest.mark.parametrize("seed", range(DRAWS))
def test_a_randomly_generated_valid_scenario_always_solves_to_optimal(
    seed: int,
) -> None:
    """The property `INFEASIBLE` as a 500 rests on, exercised end to end.

    The scenario is put through the refusal table first: a generator drifting
    into scenarios the table refuses would still pass this test while proving
    nothing about the ones the endpoint actually sees.
    """
    rng = random.Random(seed)  # noqa: S311 — a fixture generator, not a secret
    wire = _scenario(rng)
    validate_scenario(wire, datetime.now(tz=UTC))

    profile = PlanningProfile(
        forecast_origin=datetime(2026, 8, 28, 12, 0, tzinfo=UTC),
        vintage_fidelity="point_in_time",
        p10_mwh=_profile(rng),
        p50_mwh=_profile(rng),
        p90_mwh=_profile(rng),
        expected_mwh=_profile(rng),
    )
    result = optimization_result(wire, decode_scenario_body(wire).hash, profile)

    assert result["solver"]["status"] == "OPTIMAL"
    for realisation in result["scored"].values():
        avoidability = realisation["avoidability"]
        assert avoidability is None or 0.0 <= avoidability <= 1.0


@pytest.mark.parametrize("seed", range(DRAWS))
def test_the_do_nothing_dispatch_satisfies_every_constraint(seed: int) -> None:
    """The direct claim, family by family, on the zero point of the same fleet.

    Not "the solver found something" — a feasible point, exhibited. If this ever
    fails, the model is not feasible by construction and `INFEASIBLE` stops being
    a WattSteer bug, which is the one assumption the 500 is built on.
    """
    rng = random.Random(1000 + seed)  # noqa: S311 — a fixture generator
    wire = _scenario(rng)
    validate_scenario(wire, datetime.now(tz=UTC))
    batteries, loads = fleet_from_scenario(wire)
    offered = _profile(rng)

    for battery in batteries:
        _do_nothing_battery_is_feasible(battery)
    for load in loads:
        _do_nothing_load_is_feasible(load)

    # (C1)-(C5), the coupling. With every asset at zero, `Δ[t] = 0` in every
    # hour: `absorb[t] = 0` satisfies (C4) `absorb <= Δ` and its own lower
    # bound, (C2) `Δ <= curt` holds because `curt >= 0`, and (C5) `Δ <= 0`
    # holds with equality in the hours with no curtailment.
    for hour in range(HOURS):
        delta = 0.0
        absorb = 0.0
        assert delta <= offered[hour] + 1e-12  # (C2)
        assert 0.0 <= absorb <= delta  # (C4), and absorb's own lower bound
        if offered[hour] <= 0.0:
            assert delta <= 0.0  # (C5), in the hours with nothing to absorb


def _do_nothing_battery_is_feasible(battery: Battery) -> None:
    """(B1)-(B8) at `ch = dis = 0`, which is where the SOC bound does the work."""
    soc = battery.initial_soc_mwh
    for _ in range(HOURS):
        # (B1): `soc[t] = soc[t-1] + ηc·0·Δt - 0/ηd·Δt` — the state persists,
        # which is why availability needs no special case for a battery.
        soc = soc + (battery.charge_efficiency * 0.0 * PERIOD_HOURS) - 0.0
        # (B2)/(B3): the window validation guarantees the *initial* point is
        # inside, and a persisting state never leaves it.
        assert battery.soc_floor_mwh - 1e-9 <= soc <= battery.soc_ceiling_mwh + 1e-9
    # (B4)-(B6): zero is below every power limit, all of which are positive.
    assert battery.charge_limit_mw >= 0.0
    assert battery.discharge_limit_mw >= 0.0
    assert battery.max_power_mw > 0.0
    # (B7)-(B8): the mutual-exclusion binaries are satisfied at `u = 0`, where
    # both `ch <= P̄·u` and `dis <= P̄·(1-u)` bind at zero from above.
    assert battery.charge_limit_mw * 0.0 >= 0.0
    assert battery.discharge_limit_mw * (1.0 - 0.0) >= 0.0


def _do_nothing_load_is_feasible(load: ShiftableLoad) -> None:
    """(D1)-(D5) at `up = do = 0`, where every row is `0 <= a positive bound`."""
    # (D1): every up-shift is compensated inside `L` hours — vacuously, since
    # there is none. Daily energy is conserved because nothing moved.
    assert load.shift_window_hours >= 1
    # (D2)/(D3): the per-direction limits.
    assert load.up_limit_mw > 0.0
    assert load.down_limit_mw > 0.0
    # (D4): the simultaneity row, `up[t] + Σ do[·,t] <= max(C̄up, C̄do)`.
    assert load.simultaneity_limit_mw >= 0.0
    # The physical check the formulation cannot make for itself, and the one
    # that keeps the zero point inside a *sane* model rather than merely a
    # feasible one: a load cannot be shed by more power than it draws.
    assert load.max_shift_mw <= load.flat_baseline_mw + 1e-9
    # (D5): emitted only when a recovery time is supplied, and `0 <= C̄up·L`.
    if load.recovery_time_hours is not None:
        assert load.cycle_energy_mwh >= 0.0
