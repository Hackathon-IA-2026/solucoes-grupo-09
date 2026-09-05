"""Two planning arms, one simulator, and both floors published side by side.

`docs/specs/forecaster.md`, "And the alternative is measured at the same time,
rather than argued about later": fold evaluation builds a plan against P50 *and*
a plan against `E[Y]`, runs both through the optimizer's simulator on the same
days with the same reference fleet, and publishes both arms'
`recovered_floor_mwh`. `docs/specs/flex-optimizer.md`, "The `E[Y]` arm is
carried alongside", is the other half of the same decision and names this module
as the consumer of the internal parameter flex-optimizer 09 opened.

**v1 still serves the P50 plan.** The arm is measurement, not a posture change,
and nothing here can move the posture: :data:`SHIPPED_BASIS` is
:data:`~wattsteer_ml.optimizer.result.PLANNING_BASIS`, imported rather than
respelt, and the card block says in prose which arm the product serves. What the
block does *not* do is present one arm as the headline and the other as a
footnote — the two entries under ``arms`` have identical shapes — because the
whole point of the exercise is that if `docs/specs/forecaster.md`'s collapse
figure comes in large, the replacement arrives already evidenced instead of
starting a fresh argument.

## Why the arm exists, as arithmetic

The execution rule makes over-planning nearly free — an asset takes the
scheduled amount or the amount actually being curtailed, whichever is smaller —
while a plan that is blind in an hour cannot act in it at all. So P50 sits on
the cautious side of an asymmetry it was not chosen for, and ``E[Y] > P50``
exactly when ``p < 0.5``: the expectation is non-zero in precisely the hours
where the P50 plan goes blind. :attr:`ArmDay.blind_hours` counts those hours and
:attr:`ArmDay.hours_the_expectation_offers` counts the ones the second arm can
act in, so the reason the arm exists travels with its numbers as a figure rather
than as a comment about them.

## What is imported and never written twice

- **The execution rule.** :func:`~wattsteer_ml.optimizer.simulator.score_band`,
  the same function the live path and Replay call. There is no rule in this
  file, and `apps/ml/tests/test_one_simulator.py` is the edge that keeps it so.
- **The envelope map.**
  :meth:`~wattsteer_ml.optimizer.result.PlanningProfile.envelope` is the one
  place a basis becomes a profile, which is what makes "the arms differ in
  exactly one input" checkable rather than asserted: same fleet, same horizon,
  same model, same KPI definitions, one different envelope.
- **The fleet.** :func:`~wattsteer_ml.optimizer.fleet.reference_battery` and
  :func:`~wattsteer_ml.optimizer.fleet.reference_load`, which are
  `packages/core`'s published ``REFERENCE_FLEET``. Both arms plan the same fleet
  because a floor is a statement about a fleet, and the fleet is *stamped* on
  the comparison — :class:`ReferenceFleetStamp` — so the two numbers are
  reproducible rather than merely reported.

## ``arm_source``, and the discipline it inherits

`diagnosis/background.py` stamps ``background_source``, `training/conformal.py`
stamps ``correction_regime`` and
:mod:`~wattsteer_ml.evaluation.collapse_report` stamps ``collapse_source``. This
module is the fourth, and the failure it prevents is the same one: two floors in
MWh are computable from *any* pair of bands, including the fabricated ones this
repository's fixtures are full of, and a fixture-derived
``recovered_floor_mwh`` is a plausible decimal that reads exactly like a
statement about what a battery on the Brazilian grid would have recovered.

:class:`ArmProvenance` is therefore constructible only through
:meth:`ArmProvenance.measured` or :meth:`ArmProvenance.fixture`, and the three
source constants are imported from
:mod:`~wattsteer_ml.evaluation.collapse_report` rather than respelt here — a
duplicated contract constant is a thing that drifts, and these two blocks are
read together.

## What this module does not do

It does not decide. There is no threshold here, no verdict and no "the
expectation arm wins" boolean: the ticket says the two numbers are published
together so that a posture decision has evidence, and the decision belongs to
the specs.

It never pools across fold segments either, for the reason
:mod:`~wattsteer_ml.evaluation.metrics` and
:mod:`~wattsteer_ml.evaluation.collapse_report` do not:
:func:`~wattsteer_ml.evaluation.vintage.assert_no_averaged_rows` runs on
construction, and a `revision_optimistic` quarter's MWh added to a
`point_in_time` one is a number whose caveat cannot be recovered.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Protocol

import asyncpg

from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.canonical_reads import ReadAxes, apply_axes
from wattsteer_ml.constants import REFERENCE_FLEET, SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation.collapse_report import (
    FIXTURE_SOURCE,
    HOLDOUT_HOURS_SOURCE,
    HOLDOUT_ORIGIN_KIND,
    UNMEASURED_SOURCE,
)
from wattsteer_ml.evaluation.matrix import HOURS_PER_DAY, RowKey
from wattsteer_ml.evaluation.vintage import FoldSegment, assert_no_averaged_rows
from wattsteer_ml.lanes import Lane
from wattsteer_ml.mixture import QuantileBand
from wattsteer_ml.optimizer.basis import PlanningBasis, PlanningEnvelope
from wattsteer_ml.optimizer.fleet import (
    Battery,
    ShiftableLoad,
    reference_battery,
    reference_load,
)
from wattsteer_ml.optimizer.horizon import HORIZON_HOURS, local_day
from wattsteer_ml.optimizer.milp import DispatchPlan, solve
from wattsteer_ml.optimizer.result import PLANNING_BASIS, PlanningProfile
from wattsteer_ml.optimizer.simulator import ScoredBand, score_band
from wattsteer_ml.training.bundle import read_card, write_card

#: The card block ticket 011 publishes. Named for the comparison rather than for
#: the harness that produced it, exactly as
#: :data:`~wattsteer_ml.evaluation.collapse_report.COLLAPSE_BLOCK_KEY` is: the
#: optimizer work reads this without knowing what a rung or a fold calendar is.
PLANNING_ARMS_BLOCK_KEY = "planning_arm_comparison"

#: The basis v1 serves. Imported from :mod:`wattsteer_ml.optimizer.result` and
#: not respelt: if the product's posture ever moves, it moves in one place and
#: this block follows it rather than contradicting it.
SHIPPED_BASIS: PlanningBasis = PLANNING_BASIS

#: The basis that is measured and not served. Reachable only by importing
#: :mod:`wattsteer_ml.optimizer.basis` in Python — which is what this module
#: does, and what no request can do.
MEASUREMENT_BASIS: PlanningBasis = "expected"

#: The two arms, in the order the card lists them. A tuple rather than a set, so
#: the block's key order is stable across runs and two cards diff cleanly.
ARMS: tuple[PlanningBasis, ...] = (SHIPPED_BASIS, MEASUREMENT_BASIS)

#: One fold segment's held-out bands **and their expectations**, for one lane.
#:
#: The same population
#: :data:`~wattsteer_ml.evaluation.collapse_report.HOLDOUT_HOURS_SQL` reads —
#: ``origin_kind`` is a constant in this text for the same reason — with
#: ``expected_mwh`` and ``published_at`` selected beside the three quantiles.
#:
#: ``expected_mwh`` is selected unconditionally and there is no argument, column
#: or predicate here that can choose between it and a quantile:
#: `forecaster.md` requires the two arms to be built from the same served
#: artifact, and an arm read by a different query would differ from its twin in
#: two things instead of one. It is the same discipline
#: :data:`wattsteer_ml.forecast_reads.PLANNING_PROFILE_SQL` states on the live
#: side, applied to the held-out days.
ARM_HOURS_SQL = """
select
  subsystem::text as subsystem,
  target_date,
  local_hour,
  occurrence_probability,
  p10_mwh,
  p50_mwh,
  p90_mwh,
  expected_mwh,
  published_at,
  run_label,
  feature_set,
  gate_profile::text as gate_profile,
  threshold_mw
from canonical_forecast_hour
where target_date between $1::date and $2::date
  and origin_kind = 'backfilled_holdout'::forecast_origin_kind
  and feature_set = $3
  and gate_profile = $4::forecast_gate_profile
  and threshold_mw = $5::double precision
order by target_date, subsystem, local_hour
"""


class PlanningArmError(ValueError):
    """The days cannot support the comparison that was asked for."""


class ArmBand(Protocol):
    """One published hour, narrowed to what an arm is built and scored from.

    The band, the expectation and ``p``, and deliberately nothing else.
    :class:`~wattsteer_ml.mixture.ComposedForecast` satisfies it structurally, so
    a freshly composed fold-evaluation hour is scorable; so does
    :class:`StoredBand`, assembled from a persisted ``canonical_forecast_hour``
    row. ``p`` is here because :attr:`ArmDay.blind_hours` is a statement about
    the classifier's operating region and the block would be unreadable without
    it.
    """

    @property
    def band(self) -> QuantileBand: ...

    @property
    def expected_mwh(self) -> float: ...

    @property
    def occurrence_probability(self) -> float: ...

    @property
    def threshold_mw(self) -> float: ...


class ArmHour(Protocol):
    """One subsystem-hour: who it is about, and what was published for it."""

    @property
    def key(self) -> RowKey: ...

    @property
    def forecast(self) -> ArmBand: ...


@dataclass(frozen=True)
class StoredBand:
    """The four published numbers of one row, with the band's order re-asserted.

    :class:`~wattsteer_ml.mixture.QuantileBand` rather than three floats, so the
    ordering the database's ``band_monotone`` check enforces is re-asserted on
    this side rather than assumed to have survived the crossing.
    """

    band: QuantileBand
    expected_mwh: float
    occurrence_probability: float
    threshold_mw: float

    def __post_init__(self) -> None:
        if not 0.0 <= self.occurrence_probability <= 1.0:
            raise PlanningArmError(
                f"{self.occurrence_probability!r} is not a probability; a stored "
                "row that is out of range is a fault to stop on, not a day to "
                "build a plan against"
            )
        if self.expected_mwh < 0.0:
            raise PlanningArmError(
                f"{self.expected_mwh!r} is not an expected MWh; a negative "
                "expectation would be planned against as though it were "
                "curtailment"
            )


@dataclass(frozen=True)
class ArmHourRow:
    """A stored row as an hour two arms can be built from. No arithmetic here."""

    key: RowKey
    forecast: StoredBand
    #: ``published_at`` — which publication these two arms were read from. It
    #: reaches the plan as
    #: :attr:`~wattsteer_ml.optimizer.result.PlanningProfile.forecast_origin`,
    #: so a floor is traceable to a run or it is not traceable at all.
    published_at: datetime


@dataclass(frozen=True)
class ReferenceFleetStamp:
    """The fleet both arms planned, as data, so the floors are reproducible.

    `packages/core`'s published ``REFERENCE_FLEET``, read here rather than
    described: a floor is a statement about a fleet, and two floors compared
    against each other are only comparable because it is the *same* fleet. The
    hash is over the numbers rather than over the label, so a silent edit to the
    constant changes it and a card written before that edit stops matching one
    written after.
    """

    battery_label: str
    battery_max_power_mw: float
    battery_energy_capacity_mwh: float
    battery_round_trip: float
    battery_initial_state: float
    load_label: str
    load_max_power_mw: float
    load_max_shift_mw: float
    load_shift_window_hours: int
    load_daily_energy_mwh: float

    @classmethod
    def published(cls) -> ReferenceFleetStamp:
        """The one fleet. There is no second constructor and no argument."""
        battery = REFERENCE_FLEET.battery
        load = REFERENCE_FLEET.shiftable_load
        return cls(
            battery_label=battery.label,
            battery_max_power_mw=float(battery.max_power_mw),
            battery_energy_capacity_mwh=float(battery.energy_capacity_mwh),
            battery_round_trip=float(battery.round_trip_efficiency),
            battery_initial_state=float(battery.initial_state_of_charge),
            load_label=load.label,
            load_max_power_mw=float(load.max_power_mw),
            load_max_shift_mw=float(load.max_shift_mw),
            load_shift_window_hours=int(load.shift_window_hours),
            load_daily_energy_mwh=float(load.daily_energy_mwh),
        )

    @property
    def fleet_hash(self) -> str:
        """This fleet's identity, in
        :attr:`~wattsteer_ml.evaluation.vintage.FoldSegment.segment_hash`'s
        spelling."""
        payload = "\t".join(
            (
                self.battery_label,
                f"{self.battery_max_power_mw:.6f}",
                f"{self.battery_energy_capacity_mwh:.6f}",
                f"{self.battery_round_trip:.6f}",
                f"{self.battery_initial_state:.6f}",
                self.load_label,
                f"{self.load_max_power_mw:.6f}",
                f"{self.load_max_shift_mw:.6f}",
                str(self.load_shift_window_hours),
                f"{self.load_daily_energy_mwh:.6f}",
            )
        )
        return f"sha256:{hashlib.sha256(payload.encode()).hexdigest()}"

    def assets(self) -> tuple[tuple[Battery, ...], tuple[ShiftableLoad, ...]]:
        """The same fleet as the model sees it, built through the one factory."""
        return (reference_battery(),), (reference_load(),)

    def card_fields(self) -> dict[str, Any]:
        return {
            "fleet_hash": self.fleet_hash,
            "battery": {
                "label": self.battery_label,
                "max_power_mw": self.battery_max_power_mw,
                "energy_capacity_mwh": self.battery_energy_capacity_mwh,
                "round_trip_efficiency": self.battery_round_trip,
                "initial_state_of_charge": self.battery_initial_state,
            },
            "shiftable_load": {
                "label": self.load_label,
                "max_power_mw": self.load_max_power_mw,
                "max_shift_mw": self.load_max_shift_mw,
                "shift_window_hours": self.load_shift_window_hours,
                "daily_energy_mwh": self.load_daily_energy_mwh,
            },
        }


#: The published fleet, resolved once. Both arms of every comparison plan it.
PUBLISHED_FLEET = ReferenceFleetStamp.published()


@dataclass(frozen=True)
class ArmDay:
    """One complete subsystem-day, as the two arms are built from it.

    A plan is built for one subsystem over one local day, so that is the unit
    both arms are built on and the unit an incomplete day is excluded at. The
    profile is a real :class:`~wattsteer_ml.optimizer.result.PlanningProfile`
    rather than four tuples, so the basis-to-envelope map is
    :meth:`~wattsteer_ml.optimizer.result.PlanningProfile.envelope` — the one
    the live path uses — and not a second one written here.
    """

    target_date: date
    subsystem: Subsystem
    profile: PlanningProfile
    #: ``p(x)`` per local hour. Carried, not used to build anything: the arms
    #: are built off the envelopes, and re-deriving a zero from ``p`` would be a
    #: second opinion about where the composition puts its breakpoint.
    occurrence_probability: tuple[float, ...]

    def __post_init__(self) -> None:
        lengths = {
            len(self.profile.p10_mwh),
            len(self.profile.p50_mwh),
            len(self.profile.p90_mwh),
            len(self.profile.expected_mwh),
            len(self.occurrence_probability),
        }
        if lengths != {HORIZON_HOURS}:
            raise PlanningArmError(
                f"{self.subsystem} {self.target_date.isoformat()}: a planning arm "
                f"is built over {HORIZON_HOURS} local hours and this day has "
                f"{sorted(lengths)}; a short horizon would reindex the day rather "
                "than shorten it"
            )

    @property
    def blind_hours(self) -> tuple[int, ...]:
        """The hours the median calls quiet — where the P50 plan cannot act.

        Read off the *band*, which is where
        :meth:`wattsteer_ml.mixture.HurdleMixture.quantile` writes its zero, and
        never re-derived from ``p``. The published names say ``p < 0.5``; the
        composition's breakpoint is ``q ≤ 1 − p``, one tick away from it, and
        the band is the side of that tick a plan is actually built on.
        """
        return tuple(
            hour for hour, value in enumerate(self.profile.p50_mwh) if value == 0.0
        )

    @property
    def hours_the_expectation_offers(self) -> tuple[int, ...]:
        """Blind hours in which the second arm has something to act on.

        `flex-optimizer.md`'s structural consequence, counted per day: the
        `E[Y]` arm carries one extra constraint per hour the median calls quiet,
        and this is the subset of those hours where the difference is a
        difference in the *plan* rather than only in the model's shape.
        """
        return tuple(
            hour for hour in self.blind_hours if self.profile.expected_mwh[hour] > 0.0
        )

    @classmethod
    def of(cls, hours: Sequence[ArmHour], *, fidelity: VintageFidelity) -> ArmDay | None:
        """One day's hours as an :class:`ArmDay`, or ``None`` if it is not one.

        ``None`` for an incomplete day rather than a short horizon: a
        ``(day, subsystem)`` served fewer than twenty-four hours is not a day a
        plan was ever built for, and zero-filling the gap would invent a
        forecast of "no curtailment" and quote a floor computed against it.
        """
        if len(hours) != HOURS_PER_DAY:
            return None
        ordered = sorted(hours, key=lambda hour: hour.key.local_hour)
        if [hour.key.local_hour for hour in ordered] != list(range(HOURS_PER_DAY)):
            return None
        keys = {(hour.key.target_date, hour.key.subsystem) for hour in ordered}
        if len(keys) != 1:
            raise PlanningArmError(
                f"a day assembled from more than one subsystem-day: {sorted(keys)!r}"
            )
        thresholds = {hour.forecast.threshold_mw for hour in ordered}
        if len(thresholds) != 1:
            raise PlanningArmError(
                f"{sorted(keys)[0]!r}: the day carries thresholds "
                f"{sorted(thresholds)!r}; a band is comparable with another band "
                "of the same grain and with no other"
            )
        target_date, subsystem = keys.pop()
        return cls(
            target_date=target_date,
            subsystem=subsystem,
            profile=PlanningProfile(
                forecast_origin=_origin_of(ordered),
                vintage_fidelity=fidelity,
                p10_mwh=tuple(hour.forecast.band.p10 for hour in ordered),
                p50_mwh=tuple(hour.forecast.band.p50 for hour in ordered),
                p90_mwh=tuple(hour.forecast.band.p90 for hour in ordered),
                expected_mwh=tuple(hour.forecast.expected_mwh for hour in ordered),
                threshold_mw=thresholds.pop(),
            ),
            occurrence_probability=tuple(
                hour.forecast.occurrence_probability for hour in ordered
            ),
        )


def days_of(
    hours: Iterable[ArmHour], *, fidelity: VintageFidelity
) -> tuple[tuple[ArmDay, ...], int]:
    """Group served hours into complete subsystem-days, and count the rest.

    The second element is the number of ``(day, subsystem)`` pairs served fewer
    than twenty-four hours. Reported rather than dropped silently, which is the
    rule :class:`~wattsteer_ml.evaluation.collapse.P50Collapse` applies to the
    same population one figure over.
    """
    grouped: dict[tuple[date, Subsystem], list[ArmHour]] = {}
    for hour in hours:
        grouped.setdefault((hour.key.target_date, hour.key.subsystem), []).append(hour)
    days: list[ArmDay] = []
    excluded = 0
    for key in sorted(grouped, key=lambda pair: (pair[0], pair[1])):
        day = ArmDay.of(grouped[key], fidelity=fidelity)
        if day is None:
            excluded += 1
        else:
            days.append(day)
    return tuple(days), excluded


@dataclass(frozen=True)
class ArmFloor:
    """One arm's numbers over one fold segment. Both arms have this shape.

    Identical fields for both bases, and no field naming the other arm: a
    comparison whose two halves had different shapes would be presenting one of
    them as the reference, and the ticket is explicit that neither arm is
    published as the shipped posture.

    ``recovered_floor_mwh`` is
    :attr:`~wattsteer_ml.optimizer.simulator.ScoredBand.recovered_floor_mwh`
    summed over the segment's complete days, and it is the *only* definition of
    the floor in this repository — the simulator's, read rather than recomputed.
    The three ``recovered_*`` figures are one plan executed against the three
    envelopes the optimizer spec names, because a plan is built once and scored
    three times.
    """

    basis: PlanningBasis
    days: int
    #: ``Σ_days`` the P10-simulated recovery. **The number the product quotes.**
    recovered_floor_mwh: float
    recovered_p50_mwh: float
    recovered_p90_mwh: float
    #: ``Σ_t curt[t]`` over the envelope this arm planned against — what the arm
    #: could see, before any question of what it could take.
    planned_offer_mwh: float
    #: Hours whose planning envelope is non-zero: the hours this arm can act in.
    hours_with_an_offer: int

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "planning_basis": self.basis,
            "days": self.days,
            "recovered_floor_mwh": self.recovered_floor_mwh,
            "recovered_p50_mwh": self.recovered_p50_mwh,
            "recovered_p90_mwh": self.recovered_p90_mwh,
            "planned_offer_mwh": self.planned_offer_mwh,
            "hours_with_an_offer": self.hours_with_an_offer,
        }


@dataclass(frozen=True)
class ArmComparison:
    """Both arms over one fold segment, and the arithmetic that motivates them.

    Built through :func:`score_planning_arms`, which is the only place a plan is
    solved. ``None`` is returned there rather than a comparison of zeros when
    the segment held no complete day: two floors of 0.0 MWh say the fleet
    recovers nothing, and no day at all says nothing whatever.
    """

    #: One entry per member of :data:`ARMS`, in that order.
    arms: tuple[ArmFloor, ...]
    days: int
    days_excluded_incomplete: int
    subsystems: tuple[Subsystem, ...]
    #: Hours the median calls quiet, over the segment's complete days.
    blind_hours: int
    #: Of those, the hours in which `E[Y]` is non-zero — where the second arm
    #: has something to act on and the first has nothing. `flex-optimizer.md`
    #: measured the same quantity as one extra constraint per blind hour.
    blind_hours_the_expectation_offers: int
    #: ``Σ_days Σ_t P10[t]`` — the realisation the floor is measured against,
    #: shared by both arms because both are scored on the same three envelopes.
    floor_baseline_mwh: float

    def __post_init__(self) -> None:
        if self.days <= 0:
            raise PlanningArmError(
                "a comparison over no complete subsystem-day; a segment with none "
                "is reported as absent, not as two floors of zero"
            )
        bases = tuple(arm.basis for arm in self.arms)
        if bases != ARMS:
            raise PlanningArmError(
                f"a comparison of {bases!r}; it is exactly the two arms {ARMS!r}, "
                "in that order, and a third is a change to "
                "docs/specs/forecaster.md rather than to this list"
            )
        if any(arm.days != self.days for arm in self.arms):
            raise PlanningArmError(
                "the two arms were scored over different numbers of days; they are "
                "built on the same days from the same artifact or they are not a "
                "comparison"
            )

    def arm(self, basis: PlanningBasis) -> ArmFloor:
        """One arm by name. Both are reached the same way, on purpose."""
        for candidate in self.arms:
            if candidate.basis == basis:
                return candidate
        raise PlanningArmError(f"{basis!r} is not an arm of this comparison")

    @property
    def delta_recovered_floor_mwh(self) -> float:
        """``E[Y]`` minus P50, in MWh of floor. A difference, not a verdict.

        Subtraction has to pick an order, and this one picks the order the
        question is asked in — "what would the second arm have added" — and
        stops there. There is no threshold here and no boolean saying whether
        the difference is large: `docs/specs/forecaster.md` and
        `docs/specs/flex-optimizer.md` decide the posture, and a field called
        ``arm_wins`` is exactly the tuning surface this module must not offer.
        """
        return (
            self.arm(MEASUREMENT_BASIS).recovered_floor_mwh
            - self.arm(SHIPPED_BASIS).recovered_floor_mwh
        )

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "days": self.days,
            "days_excluded_incomplete": self.days_excluded_incomplete,
            "subsystems": list(self.subsystems),
            "blind_hours": self.blind_hours,
            "blind_hours_the_expectation_offers": (
                self.blind_hours_the_expectation_offers
            ),
            "floor_baseline_mwh": self.floor_baseline_mwh,
            "delta_recovered_floor_mwh": self.delta_recovered_floor_mwh,
            "arms": {arm.basis: arm.as_card_entry() for arm in self.arms},
        }


def plan_for(day: ArmDay, basis: PlanningBasis) -> DispatchPlan:
    """One arm's schedule for one day, on the published reference fleet.

    The envelope comes from
    :meth:`~wattsteer_ml.optimizer.result.PlanningProfile.envelope`, so the two
    arms differ in that one object and in nothing else — same fleet, same
    horizon, same weights, same model — and
    :attr:`~wattsteer_ml.optimizer.milp.DispatchPlan.planning_basis` is read off
    the input rather than stamped on by this function.
    """
    batteries, loads = PUBLISHED_FLEET.assets()
    return solve(
        envelope=day.profile.envelope(basis),
        batteries=batteries,
        loads=loads,
        horizon=local_day(day.target_date),
    )


def score_arm(day: ArmDay, basis: PlanningBasis) -> ScoredBand:
    """Build one arm for one day and execute it against the three envelopes.

    :func:`~wattsteer_ml.optimizer.simulator.score_band` is the optimizer's,
    imported. Both arms are scored against P10, P50 and P90 the way
    `docs/specs/flex-optimizer.md` specifies, and the floor stays an hour-wise
    statement: the P10 envelope is not a member of the path ensemble and is not
    a realisable day.
    """
    profile = day.profile
    return score_band(
        plan_for(day, basis),
        p10_mwh=profile.p10_mwh,
        p50_mwh=profile.p50_mwh,
        p90_mwh=profile.p90_mwh,
        threshold_mw=profile.threshold_mw,
    )


def score_planning_arms(
    days: Sequence[ArmDay], *, days_excluded_incomplete: int = 0
) -> ArmComparison | None:
    """**The measurement.** Both arms over the same days, both floors published.

    One loop over the days with both arms inside it, so neither arm can be built
    over a day the other was not: "the same days, the same served artifact, the
    same fixed published reference fleet" is a property of this loop rather than
    of a convention two callers have to keep.

    ``None`` when there is no complete day — an absent comparison, which is not
    a comparison of zeros.
    """
    if not days:
        return None
    running: dict[PlanningBasis, _ArmTotals] = {basis: _ArmTotals() for basis in ARMS}
    floor_baseline = 0.0
    blind = 0
    offered_in_blind = 0
    for day in days:
        floor_baseline += sum(day.profile.p10_mwh)
        blind += len(day.blind_hours)
        offered_in_blind += len(day.hours_the_expectation_offers)
        for basis in ARMS:
            running[basis].add(score_arm(day, basis), day.profile.envelope(basis))
    return ArmComparison(
        arms=tuple(running[basis].floor(basis, days=len(days)) for basis in ARMS),
        days=len(days),
        days_excluded_incomplete=days_excluded_incomplete,
        subsystems=tuple(
            code for code in SUBSYSTEM_CODES if code in {day.subsystem for day in days}
        ),
        blind_hours=blind,
        blind_hours_the_expectation_offers=offered_in_blind,
        floor_baseline_mwh=floor_baseline,
    )


@dataclass
class _ArmTotals:
    """One arm's running sums across a segment's days. Addition, and nothing else.

    Mutable and private: it exists so the day loop stays one loop over two arms
    rather than two loops that could drift onto two sets of days, and it holds
    no definition of its own — every figure it accumulates is read off the
    simulator's :class:`~wattsteer_ml.optimizer.simulator.ScoredBand` or off the
    envelope the arm was handed.
    """

    recovered_floor_mwh: float = 0.0
    recovered_p50_mwh: float = 0.0
    recovered_p90_mwh: float = 0.0
    planned_offer_mwh: float = 0.0
    hours_with_an_offer: int = 0

    def add(self, scored: ScoredBand, envelope: PlanningEnvelope) -> None:
        self.recovered_floor_mwh += scored.recovered_floor_mwh
        self.recovered_p50_mwh += scored.p50.recovered_mwh
        self.recovered_p90_mwh += scored.p90.recovered_mwh
        self.planned_offer_mwh += sum(envelope.offered_mwh)
        self.hours_with_an_offer += sum(
            1 for value in envelope.offered_mwh if value > 0.0
        )

    def floor(self, basis: PlanningBasis, *, days: int) -> ArmFloor:
        return ArmFloor(
            basis=basis,
            days=days,
            recovered_floor_mwh=self.recovered_floor_mwh,
            recovered_p50_mwh=self.recovered_p50_mwh,
            recovered_p90_mwh=self.recovered_p90_mwh,
            planned_offer_mwh=self.planned_offer_mwh,
            hours_with_an_offer=self.hours_with_an_offer,
        )


@dataclass(frozen=True)
class ArmProvenance:
    """What the two floors are floors *of*. Travels with them, never optional.

    Constructed through :meth:`measured` or :meth:`fixture` rather than by
    field, so ``arm_source`` cannot be set to
    :data:`~wattsteer_ml.evaluation.collapse_report.HOLDOUT_HOURS_SOURCE` by a
    caller that did not read a row. It is
    :class:`~wattsteer_ml.evaluation.collapse_report.CollapseProvenance`'s
    discipline applied to the figure beside it, and the two blocks share their
    source constants for the same reason.
    """

    arm_source: str
    lane: Lane
    #: ``canonical_as_of()`` the rows were resolved at. ``None`` for fixtures,
    #: which were resolved against nothing.
    as_of: datetime | None
    #: ``run_label`` as the stored rows carry it. ``None`` when the days did not
    #: come from a row.
    run_label: str | None
    #: The fleet both arms planned. Not a parameter: there is one published
    #: fleet and a comparison against a second one would not be comparable with
    #: any other number this project publishes.
    fleet: ReferenceFleetStamp = PUBLISHED_FLEET

    @property
    def is_measurement(self) -> bool:
        """Whether these floors are evidence about the grid. One predicate."""
        return self.arm_source == HOLDOUT_HOURS_SOURCE

    @classmethod
    def measured(cls, *, lane: Lane, as_of: datetime, run_label: str) -> ArmProvenance:
        """The stamp for arms built on bands read from Postgres."""
        return cls(
            arm_source=HOLDOUT_HOURS_SOURCE,
            lane=lane,
            as_of=as_of,
            run_label=run_label,
        )

    @classmethod
    def fixture(cls, *, lane: Lane) -> ArmProvenance:
        """The stamp for arms built on fabricated bands.

        Named rather than left to a default, because the default is the value
        that would do damage. Every test in this repository builds this one.
        """
        return cls(arm_source=FIXTURE_SOURCE, lane=lane, as_of=None, run_label=None)

    def card_fields(self) -> dict[str, Any]:
        return {
            "measured": self.is_measurement,
            "arm_source": self.arm_source,
            "origin_kind": HOLDOUT_ORIGIN_KIND,
            "shipped_basis": SHIPPED_BASIS,
            "lane": self.lane.directory_name,
            "feature_set": self.lane.feature_set,
            "gate_profile": self.lane.gate_profile,
            "threshold_mw": self.lane.threshold_mw,
            "run_label": self.run_label,
            "as_of": None if self.as_of is None else self.as_of.isoformat(),
            "reference_fleet": self.fleet.card_fields(),
        }


@dataclass(frozen=True)
class ArmSegmentRow:
    """One fold segment's comparison, stamped with the vintage behind it.

    The segment rather than a fold id, for the reason
    :class:`~wattsteer_ml.evaluation.metrics.MetricsRow` carries one: a figure
    that has lost its `VintageFidelity` is a figure whose caveat cannot be
    recovered, and a difference between two arms carries a decision.
    """

    segment: FoldSegment
    comparison: ArmComparison

    def card_entry(self) -> dict[str, Any]:
        return {
            "row_id": self.segment.row_id,
            "fold_id": self.segment.fold_id,
            "vintage_fidelity": self.segment.fidelity,
            "segment_hash": self.segment.segment_hash,
            "test_start": self.segment.test_start.isoformat(),
            "test_end": self.segment.test_end.isoformat(),
            **self.comparison.as_card_entry(),
        }


@dataclass(frozen=True)
class PlanningArmReport:
    """Both arms' floors per fold segment, and what produced them.

    Never pooled across segments, and never published without
    :attr:`provenance`. :meth:`card_block` is the whole published surface.
    """

    provenance: ArmProvenance
    rows: tuple[ArmSegmentRow, ...]

    def __post_init__(self) -> None:
        if not self.rows:
            raise PlanningArmError(
                "a planning-arm report with no fold segment; an absent comparison "
                "is UnmeasuredPlanningArms, which carries a reason instead of no "
                "rows"
            )
        seen = [row.segment.row_id for row in self.rows]
        if len(set(seen)) != len(seen):
            raise PlanningArmError(
                f"a fold segment is reported twice: {sorted(seen)!r}; one segment "
                "has one row, and a duplicate is a day scored twice"
            )
        assert_no_averaged_rows([row.segment for row in self.rows])

    @classmethod
    def of(
        cls,
        comparisons: Iterable[tuple[FoldSegment, ArmComparison]],
        *,
        provenance: ArmProvenance,
    ) -> PlanningArmReport:
        return cls(
            provenance=provenance,
            rows=tuple(
                ArmSegmentRow(segment=segment, comparison=comparison)
                for segment, comparison in comparisons
            ),
        )

    @property
    def lane(self) -> Lane:
        """Read off the provenance, so a report cannot name a second lane."""
        return self.provenance.lane

    @property
    def fidelities(self) -> tuple[VintageFidelity, ...]:
        """The vintages the reported segments carry, in the order they appear."""
        seen: list[VintageFidelity] = []
        for row in self.rows:
            if row.segment.fidelity not in seen:
                seen.append(row.segment.fidelity)
        return tuple(seen)

    def card_block(self) -> dict[str, Any]:
        """The block, under :data:`PLANNING_ARMS_BLOCK_KEY`.

        ``serves`` and ``reads`` are prose on purpose and both are always
        present: the optimizer work reads this block without reading this
        module, and the two things it must not do are take a fixture-stamped MWh
        for something a fleet would have recovered, and read the second arm's
        floor as a change of posture that has already happened.
        """
        block: dict[str, Any] = {
            **self.provenance.card_fields(),
            "serves": _V1_SERVES_P50,
            "reads": _READS if self.provenance.is_measurement else _NOT_A_READING,
            "vintage_fidelities": list(self.fidelities),
            "folds": [row.card_entry() for row in self.rows],
        }
        if "point_in_time" not in self.fidelities:
            block["vintage_caveat"] = _REVISION_OPTIMISTIC_ONLY
        return {PLANNING_ARMS_BLOCK_KEY: block}


@dataclass(frozen=True)
class UnmeasuredPlanningArms:
    """No floors, and the sentence saying why — the shape of an absent number.

    Returned by :func:`measure_planning_arms` when the query found no held-out
    band. Two floors of zero would say the fleet recovers nothing under either
    arm, and two equal floors would say the arms are indistinguishable; both are
    readings of an empty table, and neither is a thing anybody may plan against.
    So this value has no field that could be mistaken for a floor.
    """

    lane: Lane
    as_of: datetime
    reason: str
    arm_source: str = UNMEASURED_SOURCE

    @property
    def is_measurement(self) -> bool:
        return False

    def card_block(self) -> dict[str, Any]:
        return {
            PLANNING_ARMS_BLOCK_KEY: {
                "measured": False,
                "arm_source": self.arm_source,
                "origin_kind": HOLDOUT_ORIGIN_KIND,
                "shipped_basis": SHIPPED_BASIS,
                "lane": self.lane.directory_name,
                "as_of": self.as_of.isoformat(),
                "reason": self.reason,
                "serves": _V1_SERVES_P50,
                "reads": _NOTHING_YET,
            }
        }


def record_planning_arms(
    report: PlanningArmReport | UnmeasuredPlanningArms, *, root: Path, artifact_id: str
) -> Path:
    """Write the block onto a card, under :data:`PLANNING_ARMS_BLOCK_KEY`.

    An edit of a card already on the volume, through the one reader and the one
    writer :func:`~wattsteer_ml.evaluation.gate.record_decision` and
    :func:`~wattsteer_ml.evaluation.collapse_report.record_collapse_report` use,
    so the three groups cannot disagree about what a card is.

    **An** :class:`UnmeasuredPlanningArms` **is written too**, for the reason
    its sibling is: a card with no arm block and a card saying "this could not
    be measured yet" look identical to anybody grepping for the figure, and only
    one of them is true of an environment with no backfilled holdout rows.
    """
    path = root / report.lane.directory_name / f"{artifact_id}{CARD_SUFFIX}"
    card = read_card(path)
    write_card(path, {**card, **report.card_block()})
    return path


async def read_arm_hours(
    conn: asyncpg.Connection[Any],
    *,
    segment: FoldSegment,
    lane: Lane,
    as_of: datetime,
) -> tuple[tuple[ArmHourRow, ...], str | None]:
    """One segment's held-out bands *and* expectations, and the run behind them.

    Opens its own transaction so the read axes cannot outlive it, exactly as
    :func:`~wattsteer_ml.evaluation.collapse_report.read_holdout_hours` and
    :func:`wattsteer_ml.forecast_reads.read_planning_profile` do.

    Two runs' rows in one segment is a refusal: their bands come from two
    artifacts, and two arms built across both would not be one comparison.
    """
    async with conn.transaction():
        await apply_axes(conn, ReadAxes(as_of=as_of))
        records = await conn.fetch(
            ARM_HOURS_SQL,
            segment.test_start,
            segment.test_end,
            lane.feature_set,
            lane.gate_profile,
            lane.threshold_mw,
        )
    rows = [dict(record) for record in records]
    labels = sorted({str(row["run_label"]) for row in rows})
    if len(labels) > 1:
        raise PlanningArmError(
            f"{segment.row_id}: held-out bands from more than one backtest run "
            f"({labels!r}); two artifacts' bands are two populations, and one "
            "comparison over both compares neither"
        )
    hours = tuple(_arm_hour(row) for row in rows)
    return hours, labels[0] if labels else None


async def measure_planning_arms(
    conn: asyncpg.Connection[Any],
    *,
    segments: Sequence[FoldSegment],
    lane: Lane,
    as_of: datetime,
) -> PlanningArmReport | UnmeasuredPlanningArms:
    """**The deliverable.** Both arms' floors over the held-out days, or a refusal.

    Args:
        segments: the fold segments to score, from
            :func:`~wattsteer_ml.evaluation.vintage.stamp_calendar`. A split
            fold arrives as two segments and is reported as two rows; passing
            one half of one is refused on construction.
        lane: which artifact's bands. Not derived from the rows, for the reason
            :func:`~wattsteer_ml.evaluation.collapse_report.measure_p50_collapse`
            states: a query that took whatever lane the table happened to hold
            would silently change population.
        as_of: ``canonical_as_of()``. On the card, because a backtest run
            appends a newer vintage rather than overwriting, so the comparison
            is reproducible only against the instant it names.

    Returns:
        A :class:`PlanningArmReport` when at least one segment yielded a
        complete subsystem-day, and :class:`UnmeasuredPlanningArms` when none
        did — which is not an error. It is the true answer, and it is a value
        rather than an exception because a card has to be able to carry it.
    """
    if not segments:
        raise PlanningArmError(
            "no fold segment to score; the segments come from the shared calendar "
            "and an empty list is a caller mistake, not an empty table"
        )
    scored: list[tuple[FoldSegment, ArmComparison]] = []
    labels: set[str] = set()
    for segment in segments:
        hours, run_label = await read_arm_hours(
            conn, segment=segment, lane=lane, as_of=as_of
        )
        days, excluded = days_of(hours, fidelity=segment.fidelity)
        comparison = score_planning_arms(days, days_excluded_incomplete=excluded)
        if comparison is None or run_label is None:
            continue
        labels.add(run_label)
        scored.append((segment, comparison))
    if not scored:
        return UnmeasuredPlanningArms(
            lane=lane,
            as_of=as_of,
            reason=(
                f"no {HOLDOUT_ORIGIN_KIND} forecast row for lane "
                f"{lane.directory_name} covers a complete subsystem-day in any of "
                f"the {len(segments)} fold segments asked for, so there is no day "
                "to build either arm on"
            ),
        )
    if len(labels) > 1:
        raise PlanningArmError(
            f"the segments were written by more than one backtest run "
            f"({sorted(labels)!r}); floors pooled over two runs name neither"
        )
    return PlanningArmReport.of(
        scored,
        provenance=ArmProvenance.measured(lane=lane, as_of=as_of, run_label=labels.pop()),
    )


def _origin_of(hours: Sequence[ArmHour]) -> datetime:
    """The publication both arms were read from, or the epoch for a fixture.

    A stored row carries ``published_at``; a freshly composed one does not,
    because a fold evaluation that has not persisted its hours yet has no
    publication to name. Stamping ``now()`` on that case would put a wall-clock
    instant on a figure that has nothing to do with when it was computed, so the
    epoch is used and the block's ``arm_source`` is what says which case it is.
    """
    stamps = {hour.published_at for hour in hours if isinstance(hour, ArmHourRow)}
    if len(stamps) == 1:
        return stamps.pop().astimezone(UTC)
    return datetime.fromtimestamp(0, tz=UTC)


def _arm_hour(row: dict[str, Any]) -> ArmHourRow:
    """One stored row as an hour an arm is built from. No arithmetic at all."""
    subsystem: Subsystem = row["subsystem"]
    return ArmHourRow(
        key=RowKey(
            target_date=row["target_date"],
            local_hour=int(row["local_hour"]),
            subsystem=subsystem,
        ),
        forecast=StoredBand(
            band=QuantileBand(
                p10=float(row["p10_mwh"]),
                p50=float(row["p50_mwh"]),
                p90=float(row["p90_mwh"]),
            ),
            expected_mwh=float(row["expected_mwh"]),
            occurrence_probability=float(row["occurrence_probability"]),
            threshold_mw=float(row["threshold_mw"]),
        ),
        published_at=row["published_at"],
    )


#: The sentence the ticket requires on the card, in every block this module
#: writes — the unmeasured one included, because a reader who finds no figures
#: still has to know which arm is in production.
_V1_SERVES_P50 = (
    "v1 serves the P50 plan and promises the P10 edge. Both arms are published "
    "here side by side and neither is the shipped posture by virtue of being in "
    "this block: the expectation arm is a measurement, has no request field, no "
    "query parameter and no scenario key, and /v1/optimize always answers "
    "planning_basis=p50."
)

#: What the block's ``reads`` field says when the bands came out of Postgres.
_READS = (
    "recovered_floor_mwh is the P10-simulated recovery of one plan, summed over "
    "the segment's complete subsystem-days, for each of two planning arms built "
    "on the same days from the same served artifact with the same published "
    "REFERENCE_FLEET. Both were executed by the optimizer's one simulator "
    "against the same P10/P50/P90 envelopes. The floor is an hour-wise "
    "statement: the P10 envelope is not a member of the path ensemble and is "
    "not a realisable day."
)

#: And what it says when they did not. Deliberately blunt, and deliberately in
#: the same field, so a reader who reaches the numbers has already read this.
_NOT_A_READING = (
    "THESE FLOORS ARE NOT A MEASUREMENT OF THE GRID. The bands both arms were "
    "built on were fabricated, so every MWh here is a solver's arithmetic over "
    "invented curtailment. Only a block whose arm_source is "
    f"{HOLDOUT_HOURS_SOURCE!r} says anything about what a fleet on the "
    "Brazilian system would have recovered, and no posture decision may be "
    "taken on this one."
)

#: On a block whose every segment predates ingestion go-live.
_REVISION_OPTIMISTIC_ONLY = (
    "Every fold segment here is revision_optimistic: no reported segment's test "
    "period begins after ingestion go-live. Both arms were built against bands "
    "whose labels have since been revised, and the difference between two arms "
    "is more sensitive to the classifier's operating region than either arm is "
    "on its own, so this block may not carry the posture decision until a "
    "point_in_time segment exists."
)

#: And when there were no bands at all.
_NOTHING_YET = (
    "The measurement ran and found nothing to build an arm on. This is not a "
    "floor of zero and not a tie between the arms: no held-out band exists for "
    "this lane yet, so the comparison is unmade rather than made and found "
    "uninteresting."
)


__all__ = [
    "ARMS",
    "ARM_HOURS_SQL",
    "MEASUREMENT_BASIS",
    "PLANNING_ARMS_BLOCK_KEY",
    "PUBLISHED_FLEET",
    "SHIPPED_BASIS",
    "ArmBand",
    "ArmComparison",
    "ArmDay",
    "ArmFloor",
    "ArmHour",
    "ArmHourRow",
    "ArmProvenance",
    "ArmSegmentRow",
    "PlanningArmError",
    "PlanningArmReport",
    "ReferenceFleetStamp",
    "StoredBand",
    "UnmeasuredPlanningArms",
    "days_of",
    "measure_planning_arms",
    "plan_for",
    "read_arm_hours",
    "record_planning_arms",
    "score_arm",
    "score_planning_arms",
]
