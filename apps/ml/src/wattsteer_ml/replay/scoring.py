"""One replay's arithmetic: plan on what was said at the gate, score what happened.

`docs/specs/replay.md`, "The arithmetic — exactly", is the authority and this
module is its four steps:

1. ``plan = optimize(curt = f50, S)`` — one MILP, **the live builder**
   (:func:`wattsteer_ml.optimizer.result.build_plan`), on the P50 of the pinned
   D−1 vintage. Not P10, not a revised forecast, and not the actuals.
2. Four realisations scored by **one function**, the optimizer's
   :func:`~wattsteer_ml.optimizer.simulator.simulate`, imported and never
   reimplemented — ``r ∈ {f10, f50, f90, a}`` where ``a`` is the observed
   ``constrained_off_mwh`` read ``AsOf(now)``.
3. The headline, on the observed realisation. ``Σ_t a[t]`` is the denominator,
   always.
4. The promise, checked: ``recovered_floor_mwh = Σ_t absorb_p10[t]`` is what was
   promised at D−1, and ``floor_met`` is whether the day cleared it.

**A replay never runs a model.** Nothing here loads an artifact, builds a
feature row or calls a forecast: :class:`PinnedForecast` is a lookup of rows
replay 01 persisted, handed in. So changing the fleet re-plans and never
re-forecasts, which is the property that makes a replay a replay, and
``test_replay_one_day.py`` asserts the import graph rather than trusting the
sentence.

## Why the numbers cannot be computed without the integrity check

Every defect in a replay produces a *better* number, so the shape here is that
a self-flattering replay is unrepresentable rather than discouraged.
:class:`ReplayScores` is the only object the contract is assembled from, and its
``__post_init__`` refuses to exist unless all of the following hold — which
means a hand-built one is checked exactly as hard as one :func:`score_replay`
produced:

- the day is a **replayable** :class:`~wattsteer_ml.replay.calendar.ReplayDay`,
  so a refused day has no number rather than a caveated one;
- :func:`~wattsteer_ml.replay.calendar.assert_held_out` passes against the card
  of the artifact **named on the pinned row**, so an in-sample replay raises
  :class:`~wattsteer_ml.evaluation.holdout.HoldoutLeakError` where a badge would
  otherwise have been rendered;
- the plan being scored was built on the pinned P50 — ``plan.offered_mwh`` is
  compared against ``forecast.p50_mwh`` — so a plan built on the observed day
  cannot be presented as what WattSteer would have said;
- every column of ``scored`` was simulated against the realisation it is named
  for, so the "observed" column is the observed day and nothing else;
- the day, the forecast and the observed profile are the same (subsystem, date).

The two directions of forecast error are not symmetric and neither of them is
implemented here: they are properties of the imported rule. When the forecast
over-estimates, ``executed_charge ≤ r[t]`` clips and the shortfall is real and
reported; when it under-estimates, ``absorb[t]`` stays bounded by the
**scheduled** ``Δ[t]``, the excess flows into ``remaining_mwh``, and the day
earns a *lower* avoidability rather than a smaller actual. Absorbing up to
``min(headroom, a[t])`` would be an intraday re-optimisation against information
the plan did not have; it is hindsight, and the one place it is permitted is
:func:`_hindsight_plan`, whose output can only leave this module as
``upper_bound``.

**The floor is simulated against P10**, which the conformal ``δ_lo`` correction
reaches in full at every ``p`` — so ``recovered_floor_mwh``, the figure the
product quotes in prose, is the sound half of the band. Ticket 21's caveat
belongs to P90, which is drawn and never quoted.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal

from wattsteer_ml.evaluation.vintage import earliest_valid_instant
from wattsteer_ml.mixture import QuantileBand
from wattsteer_ml.optimizer import (
    TOLERANCE_MWH,
    DispatchPlan,
    OptimizerBugError,
    PlanningProfile,
    ScoredBand,
    ScoredRealisation,
    build_plan,
    score_band,
    simulate,
)
from wattsteer_ml.replay.calendar import (
    HOURS_PER_DAY,
    PROVENANCE_BY_ORIGIN_KIND,
    ReplayDay,
    assert_held_out,
)
from wattsteer_ml.replay.cards import ArtifactWindows

#: Which realisation the top-level scalars were evaluated on. `replay.md`'s
#: contract carries it beside ``planning_basis`` because the same field names in
#: an `OptimizationResult` are evaluated on the planning envelope: same names,
#: different realisation, and without this field the two results are a trap.
SCORED_ON: Literal["observed"] = "observed"

#: The label the upper bound is rendered under, in the spec's own words: "the
#: best any plan could have done knowing the answer".
PERFECT_FORESIGHT: Literal["perfect_foresight"] = "perfect_foresight"


class ReplayPostureError(ValueError):
    """A replay that would have graded its own homework, refused.

    Distinct from :class:`~wattsteer_ml.evaluation.holdout.HoldoutLeakError`,
    which is the *model's* information set. This is the arithmetic's posture:
    the plan was built on something other than the pinned P50, a column was
    scored against a realisation it is not named for, or two halves of a replay
    describe different days. Every one of those produces a better number than
    the honest one, and none of them is a bad request — they are WattSteer
    wiring itself up wrongly, so they raise rather than refuse.
    """


@dataclass(frozen=True)
class PinnedOrigin:
    """The `ForecastOrigin` a replay is pinned to. Echoed, never re-derived.

    ``origin_kind`` is the discriminator that keeps a record and a
    reconstruction apart, and it travels here for the same reason it travels on
    the row: a ``backfilled_holdout`` ``published_at`` is a *counterfactual*
    publication instant, and a surface that dropped the kind would render a
    reconstruction as a record.
    """

    producer: str
    run_label: str
    published_at: datetime
    origin_kind: str
    gate_profile: str

    def as_payload(self) -> dict[str, object]:
        return {
            "producer": self.producer,
            "run_label": self.run_label,
            "published_at": self.published_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "origin_kind": self.origin_kind,
            "gate_profile": self.gate_profile,
        }


@dataclass(frozen=True)
class ForecastHour:
    """One hour of the pinned band, in the shape the contract publishes.

    A band plus two siblings, never a flattened five-tuple: ``expected_mwh`` is
    an expectation and lives *beside* the quantiles rather than inside them.
    """

    constrained_off_mwh: QuantileBand
    expected_mwh: float
    occurrence_probability: float

    def as_payload(self) -> dict[str, object]:
        return {
            "constrained_off_mwh": {
                "p10": self.constrained_off_mwh.p10,
                "p50": self.constrained_off_mwh.p50,
                "p90": self.constrained_off_mwh.p90,
            },
            "expected_mwh": self.expected_mwh,
            "occurrence_probability": self.occurrence_probability,
        }


@dataclass(frozen=True)
class PinnedForecast:
    """What WattSteer said at the gate — twenty-four rows and a companion row.

    Read, never computed. The hour rows are `Forecast` rows resolved through
    ``AsOf(published_at)``; :attr:`day_total`, :attr:`peak_power` and
    :attr:`day_occurrence_probability` are the day-grain figures the path
    ensemble produced, carried because ``replay.md`` forbids reconstructing a
    day band by summing the hourly one — quantiles do not add.

    :meth:`__post_init__` refuses a forecast published *after* the day it
    forecasts. That is not a shape check: a "D−1 forecast" whose publication
    instant falls inside the day it plans is hindsight wearing a forecast's
    clothes, and the whole replay rests on the plan having been built from
    information available at the gate.
    """

    subsystem: str
    target_date: date
    threshold_mw: float
    origin: PinnedOrigin
    hours: tuple[ForecastHour, ...]
    day_total: QuantileBand
    peak_power: QuantileBand
    day_occurrence_probability: float

    def __post_init__(self) -> None:
        if len(self.hours) != HOURS_PER_DAY:
            raise ReplayPostureError(
                f"{self.subsystem} {self.target_date.isoformat()}: a pinned "
                f"forecast is {HOURS_PER_DAY} hours and this one is "
                f"{len(self.hours)}; the denominator of every figure on this "
                "screen is the whole local day"
            )
        if not 0.0 <= self.day_occurrence_probability <= 1.0:
            raise ReplayPostureError(
                f"{self.day_occurrence_probability!r} is not a probability"
            )
        gate = self.origin.published_at
        if gate >= earliest_valid_instant(self.target_date):
            raise ReplayPostureError(
                f"{self.subsystem} {self.target_date.isoformat()}: the pinned "
                f"origin was published {gate.isoformat()}, which is not before "
                "the day it forecasts — a plan built from it would have used "
                "information the gate did not have"
            )

    @property
    def p10_mwh(self) -> tuple[float, ...]:
        return tuple(hour.constrained_off_mwh.p10 for hour in self.hours)

    @property
    def p50_mwh(self) -> tuple[float, ...]:
        """The planning envelope, and the only realisation a plan is built on."""
        return tuple(hour.constrained_off_mwh.p50 for hour in self.hours)

    @property
    def p90_mwh(self) -> tuple[float, ...]:
        return tuple(hour.constrained_off_mwh.p90 for hour in self.hours)

    def as_payload(self) -> dict[str, object]:
        return {
            "hours": [hour.as_payload() for hour in self.hours],
            # From the path ensemble. **Not** a componentwise sum of the band
            # above, which is the prototype defect `replay.md` requires out.
            "day_total": {
                "p10": self.day_total.p10,
                "p50": self.day_total.p50,
                "p90": self.day_total.p90,
            },
            "peak_power": {
                "p10": self.peak_power.p10,
                "p50": self.peak_power.p50,
                "p90": self.peak_power.p90,
            },
            "day_occurrence_probability": self.day_occurrence_probability,
        }


@dataclass(frozen=True)
class ObservedDay:
    """The day that happened: ``a[t]``, settled, read ``AsOf(now)``.

    All twenty-four hours or none. A day short an hour would produce a
    denominator that is a different quantity wearing the same name, which is
    why the calendar refuses it with ``REPLAY_OBSERVATION_INCOMPLETE`` long
    before anything here is asked to score it.
    """

    subsystem: str
    target_date: date
    hours: tuple[float, ...]

    def __post_init__(self) -> None:
        if len(self.hours) != HOURS_PER_DAY:
            raise ReplayPostureError(
                f"{self.subsystem} {self.target_date.isoformat()}: the observed "
                f"day is {len(self.hours)} hours of {HOURS_PER_DAY}"
            )
        if any(value < -TOLERANCE_MWH for value in self.hours):
            raise ReplayPostureError(
                f"{self.subsystem} {self.target_date.isoformat()}: an observed "
                "hour carries negative curtailment"
            )

    @property
    def total_mwh(self) -> float:
        """``Σ_t a[t]`` — the denominator of the headline, always."""
        return sum(self.hours)

    @property
    def peak_mw(self) -> float:
        """A day's largest hourly MWh is numerically its peak MW at hour grain."""
        return max(self.hours, default=0.0)

    def as_payload(self) -> dict[str, object]:
        return {
            "total_mwh": self.total_mwh,
            "peak_mw": self.peak_mw,
            "hours": list(self.hours),
        }


@dataclass(frozen=True)
class PerfectForesight:
    """The upper bound, fenced: three numbers and no dispatch.

    `replay.md` requires perfect foresight to live under ``upper_bound``, never
    in ``avoided_energy_mwh`` and never in ``scored``. The fence is this type's
    *shape*: :func:`_hindsight_plan` is the only thing that ever holds the plan
    solved against the observed day, and what it returns is these three scalars.
    Nothing downstream can populate a headline field from a plan it cannot
    reach, which is a stronger statement than a test asserting that it does not.
    """

    recovered_mwh: float
    avoidability: float | None
    #: What better forecasting was worth on this day: perfect foresight minus
    #: what the plan actually achieved. The only honest use of a hindsight
    #: number.
    forecast_value_gap_mwh: float

    def as_payload(self) -> dict[str, object]:
        return {
            "label": PERFECT_FORESIGHT,
            "recovered_mwh": self.recovered_mwh,
            "avoidability": self.avoidability,
            "forecast_value_gap_mwh": self.forecast_value_gap_mwh,
        }


@dataclass(frozen=True)
class ReplayScores:
    """One replay's numbers, and the posture they are only meaningful under.

    Constructed by :func:`score_replay`; every invariant is re-checked here
    rather than there, so the object cannot be assembled by hand into a shape
    the function would have refused to produce. See the module docstring for
    the list — the short version is that the plan is the one built at the gate,
    each column is the realisation it is named for, and the artifact that
    produced the forecast had not seen the day.
    """

    day: ReplayDay
    windows: ArtifactWindows
    forecast: PinnedForecast
    observed: ObservedDay
    #: The plan, on the pinned P50. `planning_basis = "p50"`.
    plan: DispatchPlan
    #: The three envelopes, through the one function.
    band: ScoredBand
    #: The fourth realisation — the day that happened, and the headline.
    observed_scoring: ScoredRealisation
    upper_bound: PerfectForesight

    def __post_init__(self) -> None:
        self._check_the_day_is_replayable()
        self._check_the_halves_describe_one_day()
        self._check_the_plan_was_built_at_the_gate()
        self._check_each_column_is_its_own_realisation()

    # --- the integrity precondition ----------------------------------------

    def _check_the_day_is_replayable(self) -> None:
        """A refused day has no number, and an in-sample one raises.

        ``assert_held_out`` is run against the card of the artifact **named on
        the pinned row**, so a replay cannot be waved through by a card
        belonging to some other artifact. `replay.md`: "a `500`, not a badge".
        """
        held_out_by = self.day.held_out_by
        if self.day.refusal is not None or held_out_by is None:
            raise ReplayPostureError(
                f"{self.day.target_date.isoformat()} is not replayable, so it "
                "has no plan and no recovery number; an observed-only view is "
                "what is offered for it"
            )
        if self.windows.artifact_id != held_out_by.artifact_id:
            raise ReplayPostureError(
                f"the held-out assertion would run against card "
                f"{self.windows.artifact_id} while the day resolves artifact "
                f"{held_out_by.artifact_id}; a claim checked against the wrong "
                "artifact is not checked"
            )
        if self.forecast.origin.run_label != held_out_by.artifact_id:
            raise ReplayPostureError(
                f"the pinned rows name run {self.forecast.origin.run_label} and "
                f"the day resolves artifact {held_out_by.artifact_id}; the "
                "forecast being scored is not the one whose integrity was "
                "asserted"
            )
        provenance = PROVENANCE_BY_ORIGIN_KIND.get(self.forecast.origin.origin_kind)
        if provenance != self.day.provenance:
            raise ReplayPostureError(
                f"the pinned rows are {self.forecast.origin.origin_kind!r} and "
                f"the day is published as {self.day.provenance!r}; a "
                "reconstruction rendered as a record is the one class of error "
                "origin_kind exists to make impossible"
            )
        assert_held_out(
            self.day.target_date, self.windows, subsystem=self.forecast.subsystem
        )

    def _check_the_halves_describe_one_day(self) -> None:
        """One (subsystem, date), in all three places it is written down."""
        for label, subsystem, target_date in (
            ("the forecast", self.forecast.subsystem, self.forecast.target_date),
            ("the observed day", self.observed.subsystem, self.observed.target_date),
        ):
            if target_date != self.day.target_date:
                raise ReplayPostureError(
                    f"{label} is {target_date.isoformat()} and the replayed day "
                    f"is {self.day.target_date.isoformat()}; a plan scored "
                    "against another day's actuals is not a replay"
                )
            if subsystem != self.forecast.subsystem:
                raise ReplayPostureError(
                    f"{label} is {subsystem} and the forecast is "
                    f"{self.forecast.subsystem}; one subsystem per scenario"
                )

    # --- the posture -------------------------------------------------------

    def _check_the_plan_was_built_at_the_gate(self) -> None:
        """``planning_basis = "p50"``, asserted against the plan's own envelope.

        The plan carries the profile it was solved on, so "this was built on the
        pinned P50" is checkable rather than conventional. It is the check that
        makes planning on the actuals — the single most flattering thing a
        replay could do — a raise instead of a silently better percentage.
        """
        if not _same_profile(self.plan.offered_mwh, self.forecast.p50_mwh):
            raise ReplayPostureError(
                f"{self.day.target_date.isoformat()}: the plan being scored was "
                "built on a profile that is not the pinned P50. A replay plans "
                "on what WattSteer said at the gate; planning on anything else "
                "— the revised forecast, or the day itself — grades the "
                "product's homework with the answers in hand"
            )

    def _check_each_column_is_its_own_realisation(self) -> None:
        """Every ``scored`` column was simulated against the array it names."""
        for name, scoring, realisation in (
            ("p10", self.band.p10, self.forecast.p10_mwh),
            ("p50", self.band.p50, self.forecast.p50_mwh),
            ("p90", self.band.p90, self.forecast.p90_mwh),
            (SCORED_ON, self.observed_scoring, self.observed.hours),
        ):
            offered = tuple(hour.offered_mwh for hour in scoring.hours)
            if not _same_profile(offered, realisation):
                raise ReplayPostureError(
                    f"the {name!r} column was scored against a realisation that "
                    f"is not {name!r}; the four realisations are one plan "
                    "executed four times and the names are what make them "
                    "readable"
                )

    # --- the promise, checked ----------------------------------------------

    @property
    def threshold_mw(self) -> float:
        return self.forecast.threshold_mw

    @property
    def recovered_floor_mwh(self) -> float:
        """What was promised at D−1 — ``Σ_t absorb_p10[t]``, read not recomputed.

        Defined in exactly one place, the simulator's
        :class:`~wattsteer_ml.optimizer.simulator.ScoredBand`, so the floor and
        the P10 column of ``scored`` cannot drift apart.
        """
        return self.band.recovered_floor_mwh

    @property
    def floor_met(self) -> bool:
        """Whether the day that happened cleared the promise made at D−1.

        Not a theorem: the simulator's monotonicity gives
        ``recovered(plan, r) ≥ recovered(plan, f10)`` only where ``r ≥ f10``
        pointwise, and an observed day is not obliged to dominate the P10
        envelope in every hour. It is an empirical claim the product checks,
        which is why floor **coverage** over many days is the metric.
        """
        return self.observed_scoring.recovered_mwh >= self.recovered_floor_mwh

    @property
    def floor_margin_mwh(self) -> float:
        return self.observed_scoring.recovered_mwh - self.recovered_floor_mwh


def plan_at_the_gate(wire: dict[str, Any], forecast: PinnedForecast) -> DispatchPlan:
    """One MILP, the live builder, on the pinned P50. The only plan on screen.

    :func:`~wattsteer_ml.optimizer.result.build_plan` is imported rather than
    re-expressed for the same reason the simulator is: a replayed plan and a
    live plan are the same object because they came out of the same builder.
    There is no quantile argument here and no request field can select one.
    """
    return build_plan(wire, _planning_profile(forecast, forecast.p50_mwh))


def score_replay(
    wire: dict[str, Any],
    *,
    day: ReplayDay,
    windows: ArtifactWindows,
    forecast: PinnedForecast,
    observed: ObservedDay,
) -> ReplayScores:
    """One plan, four realisations, one function — and the fenced upper bound.

    Raises :class:`~wattsteer_ml.evaluation.holdout.HoldoutLeakError` if the
    artifact that produced the pinned rows had seen the day, and
    :class:`ReplayPostureError` for every other way a replay could flatter
    itself. Both before any number is published and neither catchable into a
    badge.
    """
    plan = plan_at_the_gate(wire, forecast)
    threshold_mw = forecast.threshold_mw
    band = score_band(
        plan,
        p10_mwh=forecast.p10_mwh,
        p50_mwh=forecast.p50_mwh,
        p90_mwh=forecast.p90_mwh,
        threshold_mw=threshold_mw,
    )
    # The fourth realisation, through the same function as the other three.
    observed_scoring = simulate(plan, observed.hours, threshold_mw=threshold_mw)
    return ReplayScores(
        day=day,
        windows=windows,
        forecast=forecast,
        observed=observed,
        plan=plan,
        band=band,
        observed_scoring=observed_scoring,
        upper_bound=_hindsight_plan(wire, forecast, observed, achieved=observed_scoring),
    )


def _planning_profile(
    forecast: PinnedForecast, envelope: Sequence[float]
) -> PlanningProfile:
    """A :class:`PlanningProfile` for the builder, with ``p50`` named explicitly.

    ``envelope`` is a parameter of this private helper and of nothing public:
    :func:`plan_at_the_gate` passes the pinned P50 and :func:`_hindsight_plan`
    passes the observed day, and those are the only two callers there will ever
    be — a third would be a planning basis nobody decided on.
    """
    return PlanningProfile(
        forecast_origin=forecast.origin.published_at,
        # Never read by the builder, and the pessimistic of the two on purpose:
        # a field that must name a value and is never consulted should not name
        # the flattering one. The fidelity a replay *publishes* is the day's,
        # derived by the calendar from the reads' own go-live.
        vintage_fidelity="revision_optimistic",
        p10_mwh=forecast.p10_mwh,
        p50_mwh=tuple(float(value) for value in envelope),
        p90_mwh=forecast.p90_mwh,
        threshold_mw=forecast.threshold_mw,
    )


def _hindsight_plan(
    wire: dict[str, Any],
    forecast: PinnedForecast,
    observed: ObservedDay,
    *,
    achieved: ScoredRealisation,
) -> PerfectForesight:
    """The one place the day itself is allowed to be planned against.

    ``plan_pf = optimize(curt = a, S)``, scored on ``a``: the best any plan
    could have done knowing the answer. It is a *bound*, never a claim about
    WattSteer, and the fence is that the plan never leaves this function — what
    comes back is :class:`PerfectForesight`'s three scalars.

    ``scored_pf.recovered_mwh ≥ recovered_mwh`` is asserted here rather than
    downstream because this is where the tolerance is computable. The executed
    dispatch of the P50 plan is itself a feasible schedule of the
    perfect-foresight problem, so the two can differ only by the objective's
    throughput tie-breaker — ``Σ_b δ_b · throughput_b`` — and a violation
    larger than that means the plan and the simulator disagree, which is the one
    bug this architecture is arranged to surface.
    """
    plan = build_plan(wire, _planning_profile(forecast, observed.hours))
    scored = simulate(plan, observed.hours, threshold_mw=forecast.threshold_mw)
    tie_breaker = TOLERANCE_MWH + sum(
        penalty * dispatch.throughput_mwh
        for penalty, dispatch in zip(
            plan.throughput_penalties, plan.batteries, strict=True
        )
    )
    if scored.recovered_mwh < achieved.recovered_mwh - tie_breaker:
        raise OptimizerBugError(
            f"perfect foresight recovered {scored.recovered_mwh:.6g} MWh and the "
            f"P50 plan recovered {achieved.recovered_mwh:.6g} MWh on the same "
            "day: an upper bound that is not one means the MILP and the "
            "simulator disagree"
        )
    return PerfectForesight(
        recovered_mwh=scored.recovered_mwh,
        avoidability=scored.avoidability,
        forecast_value_gap_mwh=scored.recovered_mwh - achieved.recovered_mwh,
    )


def _same_profile(left: Sequence[float], right: Sequence[float]) -> bool:
    return len(left) == len(right) and all(
        abs(one - other) <= TOLERANCE_MWH for one, other in zip(left, right, strict=True)
    )


__all__ = [
    "PERFECT_FORESIGHT",
    "SCORED_ON",
    "ForecastHour",
    "ObservedDay",
    "PerfectForesight",
    "PinnedForecast",
    "PinnedOrigin",
    "ReplayPostureError",
    "ReplayScores",
    "plan_at_the_gate",
    "score_replay",
]
