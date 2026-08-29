"""The MILP: §2 of `docs/research/optimizer-formulation.md`, built and solved.

Given an hourly curtailment profile for one `Subsystem` and a fleet of
batteries, this produces a 24-hour dispatch schedule — charge, discharge and
state of charge per local hour — that a real inverter could execute.

**What is here and what is not.** (B1)–(B8) and (C1)–(C5), with the four
implementer choices the spec fixes: the binaries (B7)–(B8) ship; the
Chen–Baldick tightening (B3a)/(B3b) is not implemented; there is no terminal
state-of-charge constraint; and the horizon is a local civil day. The shiftable
load's (D1)–(D5) lives in :mod:`.shiftable` and enters here as a second term in
the coupling sum (C1) and nothing else — which is the property that makes `EV`,
`DataCentre`, `Electrolyzer` and `HVAC` a variant and a constraint block later
rather than a reformulation. Wiring `offered_mwh` to a real `Forecast` is ticket
07; here it is a caller-supplied profile.

**Every failure mode this file has is silent**, which is why it is written the
way it is. Each of the four below leaves the model feasible, the status
``OPTIMAL`` and the headline *better*:

1. Dropping (B7)–(B8) "because round-trip losses make simultaneous charge and
   discharge unprofitable". That is a price-dependent property and curtailment
   is exactly the regime where the price condition fails. Measured on the
   reference profile the LP claims 15.3 MWh — 16 % — more than the battery can
   physically hold, by *venting*: pairing charge with discharge to burn stored
   energy and free headroom, in five of six curtailment hours.
2. Counting the charge alone as absorbed instead of the net increase in
   flexible demand (C1)/(C4). Same overstatement, reached from the other side.
3. Writing (C4) unconditionally — ``absorb[t] ≤ Δ[t]`` with ``absorb[t] ≥ 0``
   at every hour — which silently implies ``Δ[t] ≥ 0`` everywhere, i.e. the
   battery can *never* net-discharge. The research hit this while building the
   benchmark and it returned a plausible dispatch. The sign split of (C2)/(C5)
   is a **build-time** branch on the parameter ``curt[t]`` and introduces no
   binaries.
4. Solving it on CP-SAT. See `backend.py`.

:class:`ModelOptions` keeps variants 1 and 2 *buildable*, and they are reachable
only from a keyword argument no production path passes. They exist because the
regression tests that prove them wrong have to be able to construct them, and a
test that can only describe a bug in prose is a test that stops failing when
someone reintroduces it.

**The objective is denominated in MWh-equivalents and never in money.** R$
enters exactly once, after the solve, as a labelled display multiplier — so
`objective` here is a debugging figure and never a KPI. The KPIs come from the
simulator (ticket 02) re-deriving them from physics.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from ..config import settings
from .backend import Versions, create_solver, resolve_backend, versions
from .errors import OptimizerBugError, SolverNotOptimalError
from .fleet import HOURS_PER_DAY, Battery, ShiftableLoad
from .horizon import PERIOD_HOURS, Horizon
from .shiftable import (
    Compensation,
    LoadBlock,
    LoadDispatch,
    build_loads,
    extract_loads,
)

#: ``c_curt``. One, by construction: the objective is in MWh-equivalents, so a
#: recovered MWh is worth exactly one unit and nothing has to be priced.
CURTAILMENT_WEIGHT = 1.0

#: Below this the offered profile counts as *no* curtailment for the purpose of
#: the (C2)/(C5) sign split. It is a float-noise guard on a build-time branch,
#: not a threshold anyone configures — `threshold_mw` is a labelling parameter
#: and deliberately never enters this model.
_ZERO_MW = 1e-9

#: Solver noise. A backend may report 1e-13 MW where it means zero, and a
#: simultaneity check that believed it would fail the wrong test.
_TOLERANCE_MW = 1e-6


@dataclass(frozen=True)
class ModelOptions:
    """Switches for the two known-wrong variants. Both default to correct.

    Nothing on a production path constructs this. The venting regression and
    the netting regression do, so that "the binaries are load-bearing" and
    "absorption is net" are claims the suite can falsify rather than comments.
    """

    #: (B7)–(B8). ``False`` drops them, which is the LP relaxation.
    mutual_exclusion: bool = True
    #: (C4). ``False`` counts the charge alone, ignoring the discharge.
    net_discharge_into_absorption: bool = True


SHIPPED = ModelOptions()


class UniqueNames:
    """Names every MILP variable, and refuses to name one twice.

    CBC aborts the whole Python process on a duplicate — which is why it is not
    a permitted backend — and SCIP does not, but a duplicate makes every model
    dump unreadable and the check is free. It is a class rather than a closure
    so the guard itself can be tested, instead of only the conditions under
    which the builder happens not to trip it.
    """

    def __init__(self) -> None:
        self.seen: set[str] = set()

    def __call__(self, kind: str, *parts: str) -> str:
        name = f"{kind}[{'|'.join(parts)}]"
        if name in self.seen:
            raise OptimizerBugError(f"duplicate MILP variable name {name!r}.")
        self.seen.add(name)
        return name


@dataclass(frozen=True)
class BatteryDispatch:
    """One battery's scheduled day, extracted into plain floats."""

    key: str
    label: str
    charge_mw: tuple[float, ...]
    discharge_mw: tuple[float, ...]
    #: State of charge at the *end* of each hour, MWh.
    state_of_charge_mwh: tuple[float, ...]

    @property
    def throughput_mwh(self) -> float:
        """``Σ_t (ch + dis)·Δt`` — what the penalty is levied on."""
        total = sum(self.charge_mw) + sum(self.discharge_mw)
        return total * PERIOD_HOURS

    @property
    def simultaneous_hours(self) -> tuple[int, ...]:
        """Hours where the schedule charges and discharges at once.

        Always empty under the shipped model — (B7)–(B8) make it impossible.
        Non-empty in the LP relaxation, which is the point of the regression.
        """
        return tuple(
            hour
            for hour, (charge, discharge) in enumerate(
                zip(self.charge_mw, self.discharge_mw, strict=True)
            )
            if charge > _TOLERANCE_MW and discharge > _TOLERANCE_MW
        )


@dataclass(frozen=True)
class HourlyDispatch:
    """The fleet's scheduled hour, in the result contract's shape."""

    hour_local: int
    offered_mwh: float
    battery_charge_mw: float
    battery_discharge_mw: float
    state_of_charge_mwh: float
    absorbed_mwh: float
    #: ``Δ[t]`` (C1) — the net increase in flexible demand. Carried because
    #: three of this model's invariants are statements about it, and a number
    #: no test can read is a number no test can defend.
    net_flexible_demand_mwh: float
    #: ``Σ_a up[a,t]`` and ``Σ_a Σ_t' do[a,t',t]`` — the load half of (C1), in
    #: the shape the published result contract already carries. Defaulted so
    #: that a fleet with no load reads as the zeros it is.
    load_shift_up_mw: float = 0.0
    load_shift_down_mw: float = 0.0


@dataclass(frozen=True)
class SolverReport:
    """Enough to trace a number on a screen back to the run that produced it."""

    backend: str
    status: str
    wall_time_ms: float
    #: The objective value. Carries the throughput penalty, is not a physical
    #: quantity, and is returned for debugging only. Never rendered.
    objective: float
    ortools_version: str
    backend_version: str
    scip_version: str | None
    #: Model size. A loose guard against an accidental O(T²) builder, and the
    #: first thing worth looking at if the endpoint is ever slow: model
    #: construction, not `Solve()`, dominates the request.
    variables: int
    constraints: int


@dataclass(frozen=True)
class DispatchPlan:
    """A schedule of *intended* dispatch on the planning envelope.

    Not a set of KPIs. What the fleet actually does on the day follows the
    execution rule — an asset charges the scheduled amount or the amount
    actually being curtailed, whichever is smaller, and discharges the
    scheduled amount or what its state of charge permits, whichever is smaller
    — and that rule lives in the simulator (ticket 02), which is the only thing
    allowed to produce a KPI. The scalars below are properties *of this
    schedule against the profile it was planned on*, which is the one
    realisation where the two coincide.
    """

    horizon: Horizon
    #: The batteries, paired index-for-index with :attr:`batteries`. Named
    #: ``assets`` since ticket 01 and left alone: the simulator's `Schedule`
    #: pairs against it, and the loads have their own pair below because a
    #: shiftable load has no state of charge for the execution rule to clip.
    assets: tuple[Battery, ...]
    hours: tuple[HourlyDispatch, ...]
    batteries: tuple[BatteryDispatch, ...]
    solver: SolverReport
    #: ``ρ`` and ``δ_b``, recorded so a plan can be read without re-deriving
    #: the weights that produced it.
    deg_penalty_rho: float
    throughput_penalties: tuple[float, ...]
    #: The shiftable loads, paired index-for-index with their dispatch. Empty
    #: for a battery-only fleet, which is every plan ticket 01 could build.
    loads: tuple[ShiftableLoad, ...] = ()
    load_dispatch: tuple[LoadDispatch, ...] = ()

    @property
    def offered_mwh(self) -> tuple[float, ...]:
        return tuple(hour.offered_mwh for hour in self.hours)

    @property
    def net_flexible_demand_mwh(self) -> tuple[float, ...]:
        """``Δ[t]`` across the horizon."""
        return tuple(hour.net_flexible_demand_mwh for hour in self.hours)

    @property
    def baseline_curtailment_mwh(self) -> float:
        """No action at all, which on this problem *is* the offered profile."""
        return sum(self.offered_mwh)

    @property
    def absorbed_mwh(self) -> float:
        return sum(hour.absorbed_mwh for hour in self.hours)

    @property
    def remaining_curtailment_mwh(self) -> float:
        return self.baseline_curtailment_mwh - self.absorbed_mwh

    @property
    def stored_at_horizon_end_mwh(self) -> float:
        """Because "recovered" is not "delivered": some of it is still inside.

        There is no terminal state-of-charge constraint — requiring the battery
        to return to its initial state would penalise absorption on the day
        being planned in order to serve a day the horizon does not cover — so
        the consequence is reported instead of constrained away.
        """
        return sum(battery.state_of_charge_mwh[-1] for battery in self.batteries)

    @property
    def shifted_mwh(self) -> float:
        """``Σ_a Σ_t up[a,t]·Δt`` — the energy the loads moved.

        Its counterpart is not reported beside it because there is nothing to
        compare: (D1) makes ``Σ down`` equal to this by construction, and a
        second field carrying the same number would invite a reader to believe
        the two were independently measured.
        """
        return sum(load.shifted_mwh for load in self.load_dispatch) * PERIOD_HOURS


def solve(
    *,
    offered_mwh: Sequence[float],
    batteries: Sequence[Battery],
    horizon: Horizon,
    loads: Sequence[ShiftableLoad] = (),
    backend: str | None = None,
    deg_penalty_rho: float | None = None,
    time_limit_ms: int | None = None,
    options: ModelOptions = SHIPPED,
) -> DispatchPlan:
    """Build and solve the model, returning plain Python objects.

    ``offered_mwh`` is ``curt[t]``, the curtailment available to absorb in each
    local hour. Its length must equal the horizon's — the horizon is derived
    from the IANA zone and asserted to be 24, and a profile of a different
    length would silently reindex the day.

    The `MPSolver` is local to this call and every value is copied out before it
    goes out of scope: ``MPVariable::solution_value()`` segfaults once its
    solver has been garbage-collected, so no helper here returns a variable
    handle and nothing does lazily.
    """
    rho = settings.deg_penalty_rho if deg_penalty_rho is None else deg_penalty_rho
    integral = options.mutual_exclusion
    chosen = resolve_backend(
        backend if backend is not None else settings.milp_backend, integral=integral
    )
    profile = tuple(float(value) for value in offered_mwh)
    fleet = tuple(batteries)
    flexible = tuple(loads)
    _check_shapes(profile, fleet, flexible, horizon)
    penalties = tuple(_throughput_penalty(battery, rho) for battery in fleet)

    solver = create_solver(chosen)
    # Per-request CPU stays bounded under concurrency, and at these sizes
    # parallel branch-and-bound buys nothing.
    solver.SetNumThreads(1)
    solver.SetTimeLimit(
        settings.milp_time_limit_ms if time_limit_ms is None else time_limit_ms
    )

    named = UniqueNames()

    charge: list[list[Any]] = []
    discharge: list[list[Any]] = []
    state = _build_batteries(solver, named, fleet, horizon, options, charge, discharge)
    # (D1)–(D5). The block is self-contained; what reaches the coupling sum is
    # one expression per hour, which is the whole of a variant's contact with
    # the rest of the model.
    blocks = build_loads(solver, named, flexible, horizon)
    absorb = _build_coupling(
        solver, named, profile, horizon, charge, discharge, blocks, options
    )
    _build_objective(solver, profile, absorb, charge, discharge, penalties)
    if len(named.seen) != solver.NumVariables():
        # Every variable went through `named`, so the counts agreeing is what
        # makes "no duplicate names" a statement about the whole model rather
        # than about the paths that happened to be exercised.
        raise OptimizerBugError(
            f"the model has {solver.NumVariables()} variables but "
            f"{len(named.seen)} distinct names."
        )

    status = solver.Solve()
    report = _report(solver, chosen, status)
    if report.status != "OPTIMAL":
        raise SolverNotOptimalError(report.status, chosen)

    return _extract(
        horizon=horizon,
        fleet=fleet,
        flexible=flexible,
        blocks=blocks,
        profile=profile,
        charge=charge,
        discharge=discharge,
        state=state,
        absorb=absorb,
        report=report,
        rho=rho,
        penalties=penalties,
    )


def _check_shapes(
    profile: tuple[float, ...],
    fleet: tuple[Battery, ...],
    flexible: tuple[ShiftableLoad, ...],
    horizon: Horizon,
) -> None:
    if len(profile) != len(horizon):
        raise OptimizerBugError(
            f"the offered profile has {len(profile)} hours and the horizon has "
            f"{len(horizon)}."
        )
    if any(value < -_ZERO_MW for value in profile):
        raise OptimizerBugError(
            "curtailment offered to the optimizer cannot be negative."
        )
    keys = [battery.key for battery in fleet] + [load.key for load in flexible]
    if len(set(keys)) != len(keys):
        raise OptimizerBugError(f"asset keys must be unique across the fleet: {keys}.")
    for load in flexible:
        if load.shift_window_hours < 1 or load.shift_window_hours >= len(horizon):
            raise OptimizerBugError(
                f"load {load.key!r}: a shift window of {load.shift_window_hours} h "
                f"is not inside a {len(horizon)}-period horizon."
            )
        if load.max_shift_mw > load.max_power_mw + _ZERO_MW:
            raise OptimizerBugError(
                f"load {load.key!r}: max_shift_mw {load.max_shift_mw:.6g} is above "
                f"the connection limit {load.max_power_mw:.6g}."
            )
        # The one physical check (D1)–(D4) cannot make for itself. It is
        # validation's rule — `SHIFT_EXCEEDS_BASELINE` — re-asserted at the
        # model boundary, because the ml service trusts nothing it did not
        # validate itself, and because the consequence of letting it through is
        # a *feasible* plan that sheds a process harder than it runs.
        if load.max_shift_mw > load.flat_baseline_mw + _ZERO_MW:
            raise OptimizerBugError(
                f"load {load.key!r}: max_shift_mw {load.max_shift_mw:.6g} is above "
                f"the flat baseline {load.flat_baseline_mw:.6g} "
                f"(daily_energy_mwh / {HOURS_PER_DAY}) — validation let it through."
            )
        recovery = load.recovery_time_hours
        if recovery is not None and recovery < 1:
            raise OptimizerBugError(
                f"load {load.key!r}: a recovery time of {recovery} h is not a "
                "recovery time. Absent means no (D5) block; zero means nothing."
            )


def _throughput_penalty(battery: Battery, rho: float) -> float:
    """``δ_b``, with the invariant that keeps it a tie-breaker.

    Absorbing one MWh costs at most ``δ·(1 + RTE)`` in throughput penalty, so
    ``δ_b·(1 + RTE_b) < 1`` is what stops the penalty buying off a real MWh.
    It fails as a WattSteer bug and not a bad request: the caller supplied an
    efficiency, and ``ρ`` is ours.
    """
    delta = battery.throughput_penalty(rho)
    if delta * (1.0 + battery.round_trip_efficiency) >= 1.0:
        raise OptimizerBugError(
            f"battery {battery.key!r}: the throughput penalty δ={delta:.6g} at "
            f"ρ={rho:.6g} could buy off a recovered MWh "
            f"(δ·(1+RTE)={delta * (1.0 + battery.round_trip_efficiency):.6g} ≥ 1)."
        )
    return delta


def _build_batteries(
    solver: Any,
    named: Any,
    fleet: tuple[Battery, ...],
    horizon: Horizon,
    options: ModelOptions,
    charge: list[list[Any]],
    discharge: list[list[Any]],
) -> list[list[Any]]:
    """(B1)–(B8), per battery per period."""
    state: list[list[Any]] = []
    for battery in fleet:
        tag = battery.key
        ch_row: list[Any] = []
        dis_row: list[Any] = []
        soc_row: list[Any] = []
        for hour in horizon.hours:
            when = f"t{hour:02d}"
            # Outside the availability window every decision variable for the
            # asset is fixed to zero. (B1) then reads soc[t] = soc[t−1], so the
            # state of charge persists with no special case.
            open_now = battery.availability.covers(hour)
            ch_max = battery.charge_limit_mw if open_now else 0.0  # (B4)
            dis_max = battery.discharge_limit_mw if open_now else 0.0  # (B5)
            charge_var = solver.NumVar(0.0, ch_max, named("ch", tag, when))
            discharge_var = solver.NumVar(0.0, dis_max, named("dis", tag, when))
            # (B3): the bounds are the constraint. The Chen–Baldick tightening
            # (B3a)/(B3b) is deliberately not implemented — it buys nothing at
            # 3 ms, and this is where a future session growing the horizon looks
            # first.
            soc_var = solver.NumVar(
                battery.soc_floor_mwh,
                battery.soc_ceiling_mwh,
                named("soc", tag, when),
            )
            previous = soc_row[-1] if soc_row else None
            balance = (
                soc_var
                - battery.charge_efficiency * charge_var * PERIOD_HOURS
                + discharge_var * PERIOD_HOURS / battery.discharge_efficiency
            )
            if previous is None:
                # (B2): soc[b,0] is measured from S⁰_b, a parameter.
                solver.Add(balance == battery.initial_soc_mwh)
            else:
                solver.Add(balance - previous == 0.0)  # (B1)
            if open_now:
                solver.Add(charge_var + discharge_var <= battery.max_power_mw)  # (B6)
                if options.mutual_exclusion:
                    # (B7)–(B8), the single-binary mutual exclusion. One binary
                    # per battery per period, and the load-bearing decision of
                    # the whole engine: without it the model vents.
                    mode = solver.BoolVar(named("u", tag, when))
                    solver.Add(discharge_var <= dis_max * mode)
                    solver.Add(charge_var <= ch_max * (1 - mode))
            ch_row.append(charge_var)
            dis_row.append(discharge_var)
            soc_row.append(soc_var)
        charge.append(ch_row)
        discharge.append(dis_row)
        state.append(soc_row)
    return state


def _build_coupling(
    solver: Any,
    named: Any,
    profile: tuple[float, ...],
    horizon: Horizon,
    charge: list[list[Any]],
    discharge: list[list[Any]],
    blocks: tuple[LoadBlock, ...],
    options: ModelOptions,
) -> list[Any]:
    """(C1)–(C5), with the sign split branching on the *parameter* ``curt[t]``."""
    absorb: list[Any] = []
    for hour in horizon.hours:
        offered = profile[hour]
        charged = solver.Sum([row[hour] for row in charge])
        # (C1). ``Σ_b (ch − dis) + Σ_a (up − Σ_t' do)``: the load's whole
        # contribution to the rest of the model is this one extra term, and
        # every constraint below is written exactly as it was without it.
        delta = charged - solver.Sum([row[hour] for row in discharge])
        for block in blocks:
            delta = delta + block.net_shift(solver, hour)
        # (C3). Where nothing is offered the bounds are [0, 0], so the variable
        # exists at every index and is pinned rather than special-cased.
        absorbed = solver.NumVar(0.0, max(offered, 0.0), named("absorb", f"t{hour:02d}"))
        if offered > _ZERO_MW:
            solver.Add(delta <= offered)  # (C2) — no importing from the grid
            # (C4). Netting the discharge is what stops the model charging at
            # full power in every curtailment hour while discharging to stay in
            # range, and reporting more absorbed than the fleet can hold.
            solver.Add(
                absorbed <= (delta if options.net_discharge_into_absorption else charged)
            )
        else:
            # (C5). Emitted *instead of* (C4) — never alongside it, which is
            # what would imply Δ[t] ≥ 0 everywhere and forbid net-discharging.
            solver.Add(delta <= 0.0)
        absorb.append(absorbed)
    return absorb


def _build_objective(
    solver: Any,
    profile: tuple[float, ...],
    absorb: list[Any],
    charge: list[list[Any]],
    discharge: list[list[Any]],
    penalties: tuple[float, ...],
) -> None:
    """``min Σ_t (curt[t] − absorb[t]) + Σ_b Σ_t δ_b (ch + dis) Δt``.

    ``c_energy`` is dropped outright rather than deferred: (C2)/(C5) already
    forbid buying grid energy, so a price on it would price a quantity the
    constraints force to zero.
    """
    objective = solver.Objective()
    for absorbed in absorb:
        objective.SetCoefficient(absorbed, -CURTAILMENT_WEIGHT)
    for delta, ch_row, dis_row in zip(penalties, charge, discharge, strict=True):
        for variable in (*ch_row, *dis_row):
            objective.SetCoefficient(variable, delta * PERIOD_HOURS)
    # The Σ_t curt[t] half of the first term is a constant. Carrying it as an
    # offset makes `solver.objective` read as remaining curtailment plus the
    # penalty, which is the figure the research's tables report.
    objective.SetOffset(CURTAILMENT_WEIGHT * sum(profile))
    objective.SetMinimization()


_STATUSES = {
    0: "OPTIMAL",
    1: "FEASIBLE",
    2: "INFEASIBLE",
    3: "UNBOUNDED",
    4: "ABNORMAL",
    5: "MODEL_INVALID",
    6: "NOT_SOLVED",
}


def _report(solver: Any, backend: str, status: int) -> SolverReport:
    found = versions(solver)
    return SolverReport(
        backend=backend,
        status=_STATUSES.get(int(status), f"UNKNOWN_{status}"),
        wall_time_ms=float(solver.WallTime()),
        objective=float(solver.Objective().Value()) if status in (0, 1) else float("nan"),
        ortools_version=found.ortools,
        backend_version=found.backend,
        scip_version=found.scip,
        variables=int(solver.NumVariables()),
        constraints=int(solver.NumConstraints()),
    )


def _extract(
    *,
    horizon: Horizon,
    fleet: tuple[Battery, ...],
    flexible: tuple[ShiftableLoad, ...],
    blocks: tuple[LoadBlock, ...],
    profile: tuple[float, ...],
    charge: list[list[Any]],
    discharge: list[list[Any]],
    state: list[list[Any]],
    absorb: list[Any],
    report: SolverReport,
    rho: float,
    penalties: tuple[float, ...],
) -> DispatchPlan:
    """Copy every solution value out while the solver is still alive."""
    dispatches = tuple(
        BatteryDispatch(
            key=battery.key,
            label=battery.label,
            charge_mw=tuple(float(v.solution_value()) for v in charge[index]),
            discharge_mw=tuple(float(v.solution_value()) for v in discharge[index]),
            state_of_charge_mwh=tuple(float(v.solution_value()) for v in state[index]),
        )
        for index, battery in enumerate(fleet)
    )
    shifted = extract_loads(blocks, horizon)
    hours = []
    for hour in horizon.hours:
        charged = sum(d.charge_mw[hour] for d in dispatches)
        discharged = sum(d.discharge_mw[hour] for d in dispatches)
        shift_up = sum(load.shift_up_mw[hour] for load in shifted)
        shift_down = sum(load.shift_down_mw[hour] for load in shifted)
        hours.append(
            HourlyDispatch(
                hour_local=hour,
                offered_mwh=profile[hour],
                battery_charge_mw=charged,
                battery_discharge_mw=discharged,
                state_of_charge_mwh=sum(d.state_of_charge_mwh[hour] for d in dispatches),
                absorbed_mwh=float(absorb[hour].solution_value()),
                net_flexible_demand_mwh=(charged - discharged + shift_up - shift_down)
                * PERIOD_HOURS,
                load_shift_up_mw=shift_up,
                load_shift_down_mw=shift_down,
            )
        )
    return DispatchPlan(
        horizon=horizon,
        assets=fleet,
        hours=tuple(hours),
        batteries=dispatches,
        solver=report,
        deg_penalty_rho=rho,
        throughput_penalties=penalties,
        loads=flexible,
        load_dispatch=shifted,
    )


__all__ = [
    "CURTAILMENT_WEIGHT",
    "SHIPPED",
    "BatteryDispatch",
    "Compensation",
    "DispatchPlan",
    "HourlyDispatch",
    "LoadDispatch",
    "ModelOptions",
    "SolverReport",
    "Versions",
    "solve",
]
