"""The execution rule, and every KPI derived from it. There is one of these.

`docs/specs/flex-optimizer.md` calls the sentence below "the single most
important line" in the whole engine: *the simulator that scores a live plan and
the one that scores a replayed plan are the same function, imported, not
reimplemented.* A backtest number and a forecast number are comparable because
of that and because of nothing else — so this module is imported by the live
path, by Replay and by the backtest, and `apps/ml/tests/test_one_simulator.py`
walks the repository and fails if a second implementation of the rule appears
anywhere in it, in either language.

**The rule.** The plan is a schedule of *intended* dispatch. On the day, an
asset charges the scheduled amount or the amount actually being curtailed,
whichever is smaller, and discharges the scheduled amount or what its state of
charge actually permits, whichever is smaller::

    executed_charge     = min(plan.ch[t], headroom(soc), realisation[t])
    executed_discharge  = min(plan.dis[t], available(soc))
    Δ[t]                = executed_charge − executed_discharge
                          + plan.up[t] − plan.down[t]
    absorb[t]           = max(0, min(Δ[t], realisation[t]))
    soc                += ηc·executed_charge − executed_discharge/ηd

**Why the rule is what makes planning on P50 coherent.** The optimizer plans
against P50 and the product promises the P10 edge. That is only honest if
over-planning cannot overstate recovery, and the rule is what guarantees it: a
plan built for a big day, executed against a small one, charges only what
arrived. Executed against an all-zero realisation it absorbs exactly zero and
imports exactly nothing — asserted, because it is the negative case the entire
uncertainty posture rests on.

**What is recomputed here rather than carried.** The state of charge. A
simulator that clipped absorption but carried the *planned* trajectory would
report a battery filling up on energy it never received: the headline would fall
and the chart would not, and only the chart would be wrong. Both the charge and
the discharge legs are therefore clipped against a state of charge this module
integrates from the executed dispatch, which is also what keeps the trajectory
inside ``[S̲, S̄]`` on a realisation the plan was never built for.

**The planning basis is the caller's, not this module's.** Nothing here knows
whether the plan it is handed was built against P50, against P10, or against
``E[Y]``. `forecaster.md` scores a second planning arm against ``E[Y]`` through
this function *unchanged*, and Replay scores the observed day as a fourth
realisation through the same call. Those are three callers of one function, and
a `planning_basis` parameter here would be the first step towards their being
three functions.

**The objective value is never a KPI.** It carries the throughput penalty, is
not a physical quantity, and lives on :class:`~.milp.SolverReport` for
debugging. Every number below is re-derived from physics against a named
realisation, and the two agreeing is the engine's actual proof.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .errors import OptimizerBugError
from .fleet import Battery
from .horizon import PERIOD_HOURS
from .milp import BatteryDispatch, DispatchPlan

#: Float noise. Absorbed-vs-offered and the state-of-charge bounds are asserted
#: rather than trusted, and a backend reporting 1e-13 MWh where it means zero
#: must not fail an assertion about physics.
TOLERANCE_MWH = 1e-9


@dataclass(frozen=True)
class Schedule:
    """Intended dispatch, stripped of the realisation it was planned against.

    The seam between the builder and this module. :meth:`from_plan` is the only
    thing that knows a :class:`~.milp.DispatchPlan` exists, so a plan arriving
    from Replay's pinned vintage, from the backtest, or from a fixture is
    executed by the same code as a plan that has just come off the solver.

    ``load_shift_up_mw`` and ``load_shift_down_mw`` are the shiftable load's
    (D1)–(D4) block, aggregated over the loads. They were *fields and not a
    future edit* because the execution rule's ``Δ[t]`` already had both terms in
    it, and that is exactly what it bought: when ticket 05 added the second
    variant, the rule below did not move and neither did a KPI. What changed is
    the one line in :meth:`from_plan` that reads the numbers off the plan
    instead of writing zeros, which is the seam's job. A plan built from a
    battery-only fleet still carries zeros, because that is what its hours say.

    The load has no state of charge and nothing to clip it against: the rule
    executes a shift as planned. That is not an omission — a lossless shift that
    is compensated inside its own window has no realisation-dependent leg, and
    the day it acquires one (`shift_efficiency`, a curtailed process) is the day
    it earns a clip of its own.
    """

    assets: tuple[Battery, ...]
    dispatch: tuple[BatteryDispatch, ...]
    load_shift_up_mw: tuple[float, ...]
    load_shift_down_mw: tuple[float, ...]

    @classmethod
    def from_plan(cls, plan: DispatchPlan) -> Schedule:
        return cls(
            assets=plan.assets,
            dispatch=plan.batteries,
            load_shift_up_mw=tuple(hour.load_shift_up_mw for hour in plan.hours),
            load_shift_down_mw=tuple(hour.load_shift_down_mw for hour in plan.hours),
        )

    def __len__(self) -> int:
        return len(self.load_shift_up_mw)


@dataclass(frozen=True)
class ExecutedHour:
    """What the fleet actually did in one hour of one realisation."""

    hour_local: int
    #: ``curt[t]`` on the realisation being scored, MWh.
    offered_mwh: float
    battery_charge_mw: float
    battery_discharge_mw: float
    #: Recomputed from the executed dispatch, never carried from the plan.
    state_of_charge_mwh: float
    load_shift_up_mw: float
    load_shift_down_mw: float
    absorbed_mwh: float
    #: ``Δ[t]`` — the net increase in flexible demand. Negative in an hour the
    #: fleet net-discharges, which is legitimate and absorbs nothing.
    net_flexible_demand_mwh: float


@dataclass(frozen=True)
class ScoredRealisation:
    """The KPI definitions. They live here and nowhere else.

    ``baseline_mwh`` is the sum of the realisation being scored, unfiltered.
    ``threshold_mw`` is deliberately **not** applied to it: the threshold is a
    property of the `CurtailmentHour` label, not of what a battery can absorb,
    and filtering the denominator by it would make the Avoidability Score move
    when someone tunes an episode-detection parameter. What the threshold does
    instead is gate whether the *ratio is defined at all* — see
    :attr:`avoidability`.

    "Avoided energy", "recovered energy" and "absorbed energy" are one quantity
    with one name; :attr:`recovered_mwh` is it, and nothing here publishes a
    second spelling of the same number.
    """

    threshold_mw: float
    hours: tuple[ExecutedHour, ...]
    #: Per battery, the executed state of charge at the end of each hour.
    state_of_charge_mwh: tuple[tuple[float, ...], ...]
    #: ``Σ_b`` the final state of charge. Reported because "recovered" is not
    #: "delivered": some of the absorbed energy is still inside the fleet when
    #: the horizon ends, and there is no terminal state-of-charge constraint to
    #: hide that behind.
    stored_at_horizon_end_mwh: float
    #: The other half of the same honesty: ``Σ (1−ηc)·ch + (1/ηd −1)·dis``, the
    #: energy that entered or left the assets and did not survive the trip. A
    #: shifted load conserves its energy by construction and contributes none.
    round_trip_loss_mwh: float

    @property
    def baseline_mwh(self) -> float:
        """No action at all, which on this problem *is* the realisation."""
        return sum(hour.offered_mwh for hour in self.hours)

    @property
    def recovered_mwh(self) -> float:
        return sum(hour.absorbed_mwh for hour in self.hours)

    @property
    def remaining_mwh(self) -> float:
        return self.baseline_mwh - self.recovered_mwh

    @property
    def has_curtailment_hour(self) -> bool:
        """Does this realisation contain a `CurtailmentHour` at all?

        At the grain in force — one hour at or above ``threshold_mw``. Evaluated
        per realisation, so a `None` avoidability at P10 beside a real number at
        P50 is legitimate rather than a bug: on the low edge of the band there
        may be nothing to avoid.
        """
        return any(hour.offered_mwh >= self.threshold_mw for hour in self.hours)

    @property
    def avoidability(self) -> float | None:
        """``recovered / baseline``, or `None` when the ratio is undefined.

        `None`, never `0`: a zero reads as "nothing could be avoided" rather
        than "there was nothing to avoid". Near-zero is `None` too, because a
        day with 0.3 MWh of curtailment fully absorbed would otherwise render a
        triumphant 100 % off noise — which is what the threshold gate is for.
        """
        if not self.has_curtailment_hour:
            return None
        baseline = self.baseline_mwh
        if baseline <= 0.0:
            return None
        return self.recovered_mwh / baseline


@dataclass(frozen=True)
class ScoredBand:
    """One plan, the three envelopes, and the number the product quotes.

    The three are *scoring*, not planning: the plan was built once, against
    whichever basis the caller chose, and is executed three times by the same
    function. :attr:`recovered_floor_mwh` is defined here so that "the floor"
    has exactly one definition — it is the P10-simulated recovery and it is not
    computed a second way anywhere.
    """

    p10: ScoredRealisation
    p50: ScoredRealisation
    p90: ScoredRealisation

    @property
    def recovered_floor_mwh(self) -> float:
        """The number the product quotes in prose. An hour-wise statement.

        The plan is feasible against the hour-wise P10 envelope; the joint
        probability that all 24 hours land at or above their own P10 is not
        90 %, is not computed here, and is not claimed anywhere.
        """
        return self.p10.recovered_mwh


def simulate(
    plan: DispatchPlan | Schedule,
    realisation_mwh: Sequence[float],
    *,
    threshold_mw: float,
) -> ScoredRealisation:
    """Execute ``plan`` against ``realisation_mwh`` and score what happened.

    The realisation is a *named* one — P10, P50, P90, ``E[Y]``, or the observed
    day Replay scores against — and this function neither knows nor cares which.

    Raises :class:`~.errors.OptimizerBugError` on a length mismatch or a
    negative realisation: both are WattSteer supplying the wrong array, never a
    caller supplying a bad scenario, and a silently reindexed day would move
    every number on the screen by one hour.
    """
    schedule = plan if isinstance(plan, Schedule) else Schedule.from_plan(plan)
    offered = tuple(float(value) for value in realisation_mwh)
    _check_shapes(schedule, offered)

    soc = [battery.initial_soc_mwh for battery in schedule.assets]
    trajectory: list[list[float]] = [[] for _ in schedule.assets]
    hours: list[ExecutedHour] = []
    loss = 0.0

    for hour, available_mwh in enumerate(offered):
        charged, discharged, hour_loss = _execute_batteries(
            schedule, hour, available_mwh, soc, trajectory
        )
        loss += hour_loss
        shift_up = schedule.load_shift_up_mw[hour]
        shift_down = schedule.load_shift_down_mw[hour]
        # (C1). Δ[t] is the *net* increase in flexible demand, which is what
        # stops a discharge in an oversupply hour being counted as absorption.
        delta_mwh = (charged - discharged + shift_up - shift_down) * PERIOD_HOURS
        # (C2)–(C4). Nothing is imported: absorption is bounded by what was
        # actually curtailed, and by zero from below.
        absorbed = max(0.0, min(delta_mwh, available_mwh))
        hours.append(
            ExecutedHour(
                hour_local=hour,
                offered_mwh=available_mwh,
                battery_charge_mw=charged,
                battery_discharge_mw=discharged,
                state_of_charge_mwh=sum(soc),
                load_shift_up_mw=shift_up,
                load_shift_down_mw=shift_down,
                absorbed_mwh=absorbed,
                net_flexible_demand_mwh=delta_mwh,
            )
        )

    scored = ScoredRealisation(
        threshold_mw=threshold_mw,
        hours=tuple(hours),
        state_of_charge_mwh=tuple(tuple(row) for row in trajectory),
        stored_at_horizon_end_mwh=sum(soc),
        round_trip_loss_mwh=loss,
    )
    _check_invariants(schedule, scored)
    return scored


def score_band(
    plan: DispatchPlan | Schedule,
    *,
    p10_mwh: Sequence[float],
    p50_mwh: Sequence[float],
    p90_mwh: Sequence[float],
    threshold_mw: float,
) -> ScoredBand:
    """Execute one plan against the three envelopes, through one function."""
    return ScoredBand(
        p10=simulate(plan, p10_mwh, threshold_mw=threshold_mw),
        p50=simulate(plan, p50_mwh, threshold_mw=threshold_mw),
        p90=simulate(plan, p90_mwh, threshold_mw=threshold_mw),
    )


def _execute_batteries(
    schedule: Schedule,
    hour: int,
    available_mwh: float,
    soc: list[float],
    trajectory: list[list[float]],
) -> tuple[float, float, float]:
    """One hour of the rule, per battery, mutating ``soc`` in place.

    The realisation caps the *fleet's* charge, so with more than one battery the
    scheduled charges are scaled by one common factor before each is clipped
    against its own headroom. One factor rather than a first-come allocation:
    which battery gets the scarce curtailment is not a physical fact, and an
    order-dependent answer would make the KPI depend on the order assets were
    typed into a URL. Headroom that scaling leaves unused is not reallocated —
    a second pass would be a fairness policy nobody asked for, and it would cost
    the monotonicity property the floor promise rests on.
    """
    scheduled = tuple(battery.charge_mw[hour] for battery in schedule.dispatch)
    wanted = sum(scheduled)
    scale = 1.0 if wanted <= available_mwh else available_mwh / wanted
    charged = 0.0
    discharged = 0.0
    loss = 0.0
    for index, (battery, dispatch) in enumerate(
        zip(schedule.assets, schedule.dispatch, strict=True)
    ):
        # ...or the amount actually being curtailed, whichever is smaller.
        headroom_mwh = max(0.0, battery.soc_ceiling_mwh - soc[index])
        charge = min(
            scheduled[index] * scale,
            headroom_mwh / (battery.charge_efficiency * PERIOD_HOURS),
        )
        # ...or what its state of charge actually permits, whichever is smaller.
        stored_mwh = max(0.0, soc[index] - battery.soc_floor_mwh)
        discharge = min(
            dispatch.discharge_mw[hour],
            stored_mwh * battery.discharge_efficiency / PERIOD_HOURS,
        )
        soc[index] += (
            battery.charge_efficiency * charge * PERIOD_HOURS
            - discharge * PERIOD_HOURS / battery.discharge_efficiency
        )
        trajectory[index].append(soc[index])
        charged += charge
        discharged += discharge
        # Metered at the asset boundary: what went in and did not stay, plus
        # what had to leave the store for a delivered MWh to arrive.
        loss += (1.0 - battery.charge_efficiency) * charge * PERIOD_HOURS
        loss += (1.0 / battery.discharge_efficiency - 1.0) * discharge * PERIOD_HOURS
    return charged, discharged, loss


def _check_shapes(schedule: Schedule, offered: tuple[float, ...]) -> None:
    if len(offered) != len(schedule):
        raise OptimizerBugError(
            f"the realisation has {len(offered)} hours and the plan has {len(schedule)}."
        )
    if any(value < -TOLERANCE_MWH for value in offered):
        raise OptimizerBugError("a realisation cannot carry negative curtailment.")
    for battery, dispatch in zip(schedule.assets, schedule.dispatch, strict=True):
        if battery.key != dispatch.key:
            raise OptimizerBugError(
                f"asset {battery.key!r} is paired with dispatch "
                f"{dispatch.key!r}; the plan's assets and dispatch disagree."
            )


def _check_invariants(schedule: Schedule, scored: ScoredRealisation) -> None:
    """The three properties the KPIs are only meaningful under.

    Asserted rather than trusted, because a future change to the rule that
    broke one of them would produce a *better* headline and no error.
    """
    for hour in scored.hours:
        if hour.absorbed_mwh < -TOLERANCE_MWH:
            raise OptimizerBugError(f"hour {hour.hour_local} absorbed a negative MWh.")
        if hour.absorbed_mwh > hour.offered_mwh + TOLERANCE_MWH:
            raise OptimizerBugError(
                f"hour {hour.hour_local} absorbed {hour.absorbed_mwh:.6g} MWh of "
                f"{hour.offered_mwh:.6g} MWh offered — the fleet imported."
            )
    for battery, row in zip(schedule.assets, scored.state_of_charge_mwh, strict=True):
        for index, value in enumerate(row):
            if not (
                battery.soc_floor_mwh - TOLERANCE_MWH
                <= value
                <= battery.soc_ceiling_mwh + TOLERANCE_MWH
            ):
                raise OptimizerBugError(
                    f"battery {battery.key!r} left its bounds at hour {index}: "
                    f"{value:.6g} MWh is outside "
                    f"[{battery.soc_floor_mwh:.6g}, {battery.soc_ceiling_mwh:.6g}]."
                )
    ratio = scored.avoidability
    if ratio is not None and not -TOLERANCE_MWH <= ratio <= 1.0 + TOLERANCE_MWH:
        raise OptimizerBugError(f"avoidability {ratio:.6g} is not in [0, 1].")


__all__ = [
    "TOLERANCE_MWH",
    "ExecutedHour",
    "Schedule",
    "ScoredBand",
    "ScoredRealisation",
    "score_band",
    "simulate",
]
