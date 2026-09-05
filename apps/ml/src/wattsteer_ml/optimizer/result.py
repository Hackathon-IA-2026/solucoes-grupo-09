"""One scenario in, one `OptimizationResult` out — inside one request.

This is the whole of what `docs/specs/flex-optimizer.md`'s synchronous endpoint
does once the bytes have been read and refused: resolve the profile, build the
fleet, solve once, score three times, and assemble the published contract. It is
a module rather than a handler body so that every one of those steps is callable
from a test without a socket, and so that the HTTP layer above it contains
nothing but the status mapping.

**The planning envelope is P50 and the promise is the P10 edge**, per the spec's
decided posture. :func:`optimization_result` — everything the endpoint reaches —
takes no basis argument at all, and no request field can select one: the basis is
a property of the product and not of a call.

**Where the internal parameter is, then.** :func:`build_plan` takes an
``envelope``, and it takes it as a :class:`~.basis.PlanningEnvelope` rather than
as a name, so the `E[Y]` arm is reachable only by importing
:mod:`wattsteer_ml.optimizer.basis` and calling a constructor in Python.
``None`` means :data:`PLANNING_BASIS`, which is what the endpoint gets and the
only thing it can get. The arm itself is run by `forecaster.md`'s fold
evaluation, which scores both arms through the one simulator and publishes both
arms' `recovered_floor_mwh`; it is made *possible* here and made unreachable
from the public surface here.

**Where the profile comes from is a seam, and it is filled.** The forecaster
that persists an hour-wise P10/P50/P90 band per (`Subsystem`, `valid_time`) is
Forecaster 14; :mod:`wattsteer_ml.forecast_reads` reads it back at a pinned
`ForecastOrigin` and is the resolver a deployment with a database runs with.
:data:`no_forecast_yet` remains, and remains correct, for an instance with no
database: every request is then a `FORECAST_UNAVAILABLE` — a 404, which is
exactly the row the refusal table publishes for "the scenario was fine and we
have nothing to plan against". The alternative, a fixture band served as though
it were a forecast, would put invented numbers behind a percentage on a screen,
which is the one thing this project has ruled out everywhere else.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal, Protocol

from .. import __version__
from ..constants import BRL_PER_MWH, SUBSYSTEM_THRESHOLD_MW
from ..scenario_validation import forecast_unavailable
from .basis import PlanningBasis, PlanningEnvelope
from .horizon import local_day
from .milp import DispatchPlan, HourlyDispatch, solve
from .scenario_fleet import fleet_from_scenario
from .simulator import ExecutedHour, ScoredRealisation, score_band

#: The build a plan was produced under, travelling on the response as a header
#: rather than as a field — the published contract is closed, and this is a
#: property of the deploy rather than of the plan.
#:
#: It is the service version because the formulation ships with the service: a
#: change to the model is a change to this package, and the gateway's cache key
#: carries the same string so a deploy that changes the formulation cannot serve
#: yesterday's plan under today's code. `WATTSTEER_OPTIMIZER_BUILD` on the
#: gateway is the same value, and `optimize.test.ts` asserts the two agree.
OPTIMIZER_BUILD = __version__

#: The realisation the MILP is built against on every public path. Not a
#: parameter of the request, and deliberately not reachable from one: it is the
#: default :func:`build_plan` uses when no caller hands it an envelope, and
#: :func:`optimization_result` has no way to hand it one.
PLANNING_BASIS: Literal["p50"] = "p50"

#: The rule the simulator implements, carried on the result as *data* rather
#: than as documentation: a screen that states "the assets absorb what is
#: actually curtailed, never more" should be reading it, not repeating it.
EXECUTION_RULE: Literal["follow_curtailment"] = "follow_curtailment"


@dataclass(frozen=True)
class PlanningProfile:
    """The forecast band a plan is built and scored against, already resolved.

    The three envelopes are hour-wise quantiles and are used for *scoring*, not
    for planning — one plan is built, against :attr:`p50`, and executed three
    times. ``forecast_origin`` and ``vintage_fidelity`` travel because a number
    on a screen is traceable to a run or it is not traceable at all.
    """

    forecast_origin: datetime
    vintage_fidelity: Literal["point_in_time", "revision_optimistic"]
    p10_mwh: tuple[float, ...]
    p50_mwh: tuple[float, ...]
    p90_mwh: tuple[float, ...]
    #: `E[Y]`, hour by hour, a **sibling** of the three quantiles and never one
    #: of them: an expectation adds across hours and a quantile envelope does
    #: not. Read from the same publication as the band — `Forecaster 14`
    #: persists it as ``expected_mwh`` on ``curtailment_forecast_hour`` — so
    #: that the two planning arms differ in the envelope and in nothing else,
    #: not even in which read produced them. Required rather than defaulted: a
    #: profile that cannot say what the expectation was cannot build the arm,
    #: and an empty tuple standing in for it would build a blind plan silently.
    expected_mwh: tuple[float, ...]
    #: The `CurtailmentHour` grain in force. Never applied to the denominator;
    #: it gates whether the avoidability ratio is defined at all.
    threshold_mw: float = SUBSYSTEM_THRESHOLD_MW

    def envelope(self, basis: PlanningBasis = PLANNING_BASIS) -> PlanningEnvelope:
        """The named profile the builder plans against. The one place they map.

        Both arms come out of this method, which is why "the arms differ in
        exactly one input" is checkable rather than asserted: the fleet, the
        horizon, the model and the KPI definitions are downstream of a call that
        differs only here.
        """
        if basis == "expected":
            return PlanningEnvelope.expectation(self.expected_mwh)
        return PlanningEnvelope.p50(self.p50_mwh)


class ProfileSource(Protocol):
    """Where a curtailment band comes from. One method, so ticket 07 is a swap."""

    def __call__(
        self,
        *,
        subsystem: str,
        target_date: date,
        forecast_origin: str | None,
    ) -> PlanningProfile: ...


def no_forecast_yet(
    *, subsystem: str, target_date: date, forecast_origin: str | None
) -> PlanningProfile:
    """The resolver for an instance with no database to read a profile from.

    Raises rather than inventing. `FORECAST_UNAVAILABLE` is the refusal table's
    one non-422 row precisely because it is not a statement about the scenario:
    the fleet is real and the day is planable, and there is simply nothing to
    plan against yet.
    """
    raise forecast_unavailable(subsystem, target_date.isoformat(), forecast_origin)


def scored_payload(realisation: ScoredRealisation) -> dict[str, Any]:
    """One realisation's four scalars, in the published `ScoredRealisation`."""
    return {
        "baseline_mwh": realisation.baseline_mwh,
        "remaining_mwh": realisation.remaining_mwh,
        "recovered_mwh": realisation.recovered_mwh,
        "avoidability": realisation.avoidability,
    }


def dispatch_payload(
    hours: Sequence[HourlyDispatch] | Sequence[ExecutedHour],
) -> list[dict[str, float]]:
    """A dispatch series, hour by hour, in the contract's `DispatchHour` shape.

    Called with a plan's hours it is the **scheduled** dispatch on the planning
    envelope; called with a scored realisation's hours it is what the execution
    rule actually did. Replay publishes both, as ``dispatch`` and ``executed``,
    and they are two series precisely because drawing one is what makes
    "planned against P50" get read as "assumed P50 came true". One function for
    both, because a screen that overlaid two differently-shaped series would be
    comparing them wrongly.
    """
    return [
        {
            "hour_local": hour.hour_local,
            "offered_mwh": hour.offered_mwh,
            "battery_charge_mw": hour.battery_charge_mw,
            "battery_discharge_mw": hour.battery_discharge_mw,
            "state_of_charge_mwh": hour.state_of_charge_mwh,
            "load_shift_up_mw": hour.load_shift_up_mw,
            "load_shift_down_mw": hour.load_shift_down_mw,
            "absorbed_mwh": hour.absorbed_mwh,
        }
        for hour in hours
    ]


def solver_receipt(plan: DispatchPlan) -> dict[str, Any]:
    """The receipt: what solved it, how long it took, and under which library.

    The versions are read from the running process rather than hard-coded, so
    the Apache-2.0 claim about SCIP stays checkable from a response body.
    ``objective`` carries the throughput penalty, is not a physical quantity and
    is never rendered — it is here so a number can be argued about, not shown.
    """
    report = plan.solver
    receipt: dict[str, Any] = {
        "backend": report.backend,
        "status": report.status,
        "wall_time_ms": report.wall_time_ms,
        "objective": report.objective,
        "ortools_version": report.ortools_version,
    }
    if report.scip_version is not None:
        receipt["scip_version"] = report.scip_version
    return receipt


def brl_per_mwh(wire: dict[str, Any]) -> float:
    """The display multiplier, which never enters the model.

    R$ appears exactly once, after the solve, on ``avoided_energy_mwh``. A user
    who changes it and watches the *dispatch* move would be right to distrust
    everything else on the screen, so it is read here and nowhere earlier.
    """
    assumptions = wire.get("economic_assumptions")
    if isinstance(assumptions, dict):
        rate = assumptions.get("brl_per_mwh")
        if isinstance(rate, int | float) and not isinstance(rate, bool):
            return float(rate)
    return float(BRL_PER_MWH)


def build_plan(
    wire: dict[str, Any],
    profile: PlanningProfile,
    envelope: PlanningEnvelope | None = None,
) -> DispatchPlan:
    """One MILP, built on a named planning envelope. The only call to `solve` here.

    ``envelope`` is the internal parameter of ticket 09 and the whole of it.
    ``None`` — which is what every public path passes, because
    :func:`optimization_result` has no argument to forward — means
    :data:`PLANNING_BASIS`, the P50 the product ships. `forecaster.md`'s
    measurement arm passes ``profile.envelope("expected")``, in Python, having
    imported it.

    It is typed as a :class:`~.basis.PlanningEnvelope` and not as a name so that
    the parameter cannot become a field by accident: ``wire`` is a
    ``dict[str, Any]``, every value out of it is ``Any``, and a string basis
    would have been one assignment away from being selectable by a request
    without mypy objecting. There is no string to assign.

    `SetNumThreads(1)` and `SetTimeLimit` are set inside :func:`~.milp.solve`,
    per solve: per-request CPU stays bounded under concurrency, and at these
    sizes parallel branch-and-bound buys nothing.
    """
    batteries, loads = fleet_from_scenario(wire)
    return solve(
        envelope=profile.envelope() if envelope is None else envelope,
        batteries=batteries,
        loads=loads,
        horizon=local_day(date.fromisoformat(str(wire["target_date"]))),
    )


def optimization_result(
    wire: dict[str, Any], scenario_hash: str, profile: PlanningProfile
) -> dict[str, Any]:
    """The published `OptimizationResult` for one validated scenario.

    Every KPI on it comes from the simulator, never from the objective value:
    the plan comes from the MILP, the numbers come from re-derived physics, and
    the two agreeing is a test rather than an assumption.
    """
    plan = build_plan(wire, profile)
    band = score_band(
        plan,
        p10_mwh=profile.p10_mwh,
        p50_mwh=profile.p50_mwh,
        p90_mwh=profile.p90_mwh,
        threshold_mw=profile.threshold_mw,
    )
    # The domain-model scalars are evaluated on the **planning envelope**, which
    # is P50 — the one realisation where the schedule and its execution
    # coincide. A Replay evaluates the same field names on the observed
    # realisation, which is why its contract names the realisation on the object
    # and this one names the basis instead.
    planned = band.p50
    return {
        "scenario_hash": scenario_hash,
        "forecast_origin": profile.forecast_origin.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "vintage_fidelity": profile.vintage_fidelity,
        "threshold_mw": profile.threshold_mw,
        # Read off the plan, so the field names the envelope the schedule was
        # actually built on rather than repeating a constant beside it. Always
        # `PLANNING_BASIS` here, and not by convention: this function takes no
        # envelope and therefore has none to pass on.
        "planning_basis": plan.planning_basis,
        "execution_rule": EXECUTION_RULE,
        "baseline_curtailment_mwh": planned.baseline_mwh,
        "optimized_curtailment_mwh": planned.remaining_mwh,
        # "Avoided", "recovered" and "absorbed" are one quantity with one name:
        # this is `scored.p50.recovered_mwh`, read rather than recomputed.
        "avoided_energy_mwh": planned.recovered_mwh,
        "avoidability": planned.avoidability,
        # Defined in exactly one place — the simulator's `ScoredBand` — so the
        # floor and the P10 column cannot drift apart.
        "recovered_floor_mwh": band.recovered_floor_mwh,
        "scored": {
            "p10": scored_payload(band.p10),
            "p50": scored_payload(band.p50),
            "p90": scored_payload(band.p90),
        },
        "dispatch": dispatch_payload(plan.hours),
        # Because "recovered" is not "delivered": some of the absorbed energy is
        # still inside the fleet when the horizon ends, and some of it did not
        # survive the round trip.
        "stored_at_horizon_end_mwh": planned.stored_at_horizon_end_mwh,
        "round_trip_loss_mwh": planned.round_trip_loss_mwh,
        "economic_scenario": {
            "brl_per_mwh": brl_per_mwh(wire),
            "brl": planned.recovered_mwh * brl_per_mwh(wire),
        },
        "solver": solver_receipt(plan),
    }
