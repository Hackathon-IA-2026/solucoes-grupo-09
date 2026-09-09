"""Floor coverage as a comparative guardrail on the weekly hot swap.

`docs/specs/replay.md`, "Floor coverage, and the map's open gate item" — the
threshold two specs deferred to this one, decided there and enforced here:

    Floor coverage is a **comparative guardrail** in the weekly hot-swap: a
    candidate artifact is vetoed if its floor coverage on the shared newest
    fold, computed against the published reference fleet, is more than **5
    percentage points** below the incumbent's. It is a veto and never the
    decision, so a wrong constant blocks a swap rather than choosing one. No
    absolute floor is set, because an hour-wise P10 envelope has no day-level
    nominal level to compare against — the joint probability that all 24 hours
    land at or above their own P10 is not 90 %, is not computed, and is not
    claimed.

**There is one constant in this module and it is a slack, not a bar.**
:data:`FLOOR_COVERAGE_SLACK` is the spec's five percentage points, and it is
only ever subtracted from a *measured* incumbent coverage. Nothing here compares
a coverage against a literal, so there is no value of this constant that could
promote a candidate the bootstrap refused — the worst a wrong one can do is
block a swap, which is where `docs/specs/forecaster.md` puts every guardrail on
purpose.

## Why the metric is computed here rather than read off a Backtest

`docs/domain-model.md` gives ``Backtest`` to the aggregate of many ``Replay``s,
and a Replay reads *published* forecast rows. A candidate at the gate has
published nothing: there is no row to replay, and there will not be one until
after the swap this guardrail is deciding about. So the two coverages are
computed from the two artifacts' **composed hours on the deciding fold
segment** — the very sequences the paired bootstrap is run over, which
:func:`~wattsteer_ml.evaluation.gate.paired_block_bootstrap` has already
refused unless they carry identical keys in identical order.

That is the same construction as the forecaster's ``Δ recovered_floor_mwh``
(:mod:`wattsteer_ml.evaluation.planning_arms`) and it is deliberately *not* the
Backtest's number. :class:`FloorCoverageProvenance` stamps which one it is, for
the reason `background_source`, `correction_regime`, `collapse_source`,
`arm_source` and `lead_time_source` exist: "floor coverage 0.83" is a plausible
decimal that reads exactly like a statement about how often WattSteer's promise
to the Brazilian grid held, and a fold-evaluation figure is not that statement.

## What is imported and never written twice

- **The floor.** :func:`~wattsteer_ml.replay.scoring.floor_was_met` — the one
  comparison :attr:`~wattsteer_ml.replay.scoring.ReplayScores.floor_met`
  publishes, so a Backtest's ``floor_coverage`` and this one count the same
  event. There is no second expression of it here.
- **The execution rule.** :func:`~wattsteer_ml.optimizer.simulator.score_band`
  and :func:`~wattsteer_ml.optimizer.simulator.simulate`, the optimizer's, as
  ``test/one-execution-rule.test.ts`` requires.
- **The plan.** :func:`~wattsteer_ml.evaluation.planning_arms.plan_for` on
  :data:`~wattsteer_ml.evaluation.planning_arms.SHIPPED_BASIS`, so the plan
  behind a coverage figure is built against the P50 the product actually serves
  and on the fleet the product actually publishes.
- **The fleet.** :data:`~wattsteer_ml.evaluation.planning_arms.PUBLISHED_FLEET`,
  which is ``packages/core``'s single ``REFERENCE_FLEET``. `replay.md` story 35
  wants it stamped on every aggregate, and it is stamped on the veto.
- **The day.** :meth:`~wattsteer_ml.evaluation.planning_arms.ArmDay.of`, which
  refuses a ``(day, subsystem)`` short of twenty-four hours rather than
  zero-filling it. A zero-filled hour is a forecast of "no curtailment" nobody
  made, and a floor quoted against one is quoted against an invention.

## What it costs

One MILP per complete ``(subsystem, day)`` per artifact, so a quarter-long
deciding segment over four subsystems is on the order of 700 solves at the
3 ms ``test_replay_cost.py`` measures — a couple of seconds inside a weekly job
that already trains a model. It runs as check 6, *after* the bootstrap has
promoted, so a candidate the gate was going to refuse anyway never pays for it.

## What the shapes here make unrepresentable

- **An absolute bar.** :class:`FloorCoverageVeto` holds no ceiling and no floor.
  The only comparison in this module is
  ``candidate ≥ incumbent − FLOOR_COVERAGE_SLACK``, and there is no branch that
  reaches a verdict without an incumbent's measured coverage on the other side
  of it.
- **A promotion this guardrail caused.** Every :class:`Guardrail` it produces
  can be ``"passed"``, ``"vetoed"`` or ``"not_applicable"``, and
  :func:`~wattsteer_ml.evaluation.gate.decide` consults them only in check 6 —
  after the bootstrap has already cleared
  :data:`~wattsteer_ml.evaluation.gate.PROMOTION_PROBABILITY`. A higher floor
  coverage is therefore not expressible as a reason to swap: there is no field
  for it and no code path that reads one.
- **A cold start that passed quietly.** With no incumbent there is no
  comparison, and the verdict is ``"not_applicable"`` rather than ``"passed"``.
  Those are different sentences on a card, and the second one would claim a
  candidate had cleared a bar nobody held it to.
- **A coverage pooled across subsystems.** One
  :class:`SubsystemFloorCoverage` per subsystem and no field that adds two
  together, for the reason
  :class:`~wattsteer_ml.replay.backtest.SubsystemCoverage` has none: a share
  over two subsystems averages two different fleets' worth of curtailment.
- **Two coverages measured on different days.** :func:`compare_floor_coverage`
  refuses two populations whose ``(subsystem, target_date)`` sets differ, which
  is the same pairing rule the bootstrap applies to the same two sequences.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal, Protocol

from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.declined import DeclinedFigure
from wattsteer_ml.evaluation.collapse_report import FIXTURE_SOURCE, UNMEASURED_SOURCE
from wattsteer_ml.evaluation.matrix import HOURS_PER_DAY
from wattsteer_ml.evaluation.planning_arms import (
    PUBLISHED_FLEET,
    SHIPPED_BASIS,
    ArmDay,
    ArmHour,
    plan_for,
)
from wattsteer_ml.lanes import Lane
from wattsteer_ml.optimizer.simulator import score_band, simulate
from wattsteer_ml.replay.scoring import floor_was_met

#: The spec's five percentage points — `docs/specs/replay.md`, "Floor coverage,
#: and the map's open gate item", and `replay.md`'s own note that it is
#: judgement rather than a measurement. **A slack subtracted from a measured
#: incumbent, never a bar**: it appears in exactly one comparison in this
#: repository and that comparison has the incumbent's coverage on the other
#: side, so no value of it can promote anything.
FLOOR_COVERAGE_SLACK = 0.05

#: :attr:`FloorCoverageProvenance.floor_coverage_source` when the two coverages
#: were computed from artifacts' composed hours on a fold segment — which is the
#: only thing a candidate at the gate has. **Not a Backtest**: a Backtest is
#: many ``Replay``s of published rows (`docs/domain-model.md`), and a candidate
#: has published none.
FOLD_EVALUATION_SOURCE = "fold_evaluation"

#: What a guardrail can conclude. ``not_applicable`` is the third state the
#: hot-swap gate needed to acquire for this guardrail: a cold start has no
#: incumbent to be five points below, and recording that as ``passed`` would
#: claim the candidate had cleared a comparison nobody made.
Verdict = Literal["passed", "vetoed", "not_applicable"]


#: What the card says when this lane has promoted nothing. Its own sentence,
#: because "there was no comparison" is the one reading `docs/specs/replay.md`
#: insists must not be written down as "the candidate cleared the bar".
COLD_START_DETAIL = DeclinedFigure(
    "there is no incumbent to be below — this lane has promoted nothing, and a "
    "rung-1 baseline plans no fleet and therefore holds no floor. The guardrail "
    "is recorded as not applicable rather than satisfied",
    figure="the floor-coverage guardrail's comparison against an incumbent",
    kind="unrunnable",
    surface="the gate decision's `floor_coverage` block, `detail`",
)


#: When the deciding segment has no complete subsystem-day on **either** side.
#: Anonymous until forecaster 27: it was a sentence returned from a private
#: helper, which no rule could find and no reviewer could grep for.
#:
#: ``unrunnable``, with :data:`COLD_START_DETAIL` and for the same reason: the
#: two coverages are shares over one row set, so a segment with no complete day
#: has none for anybody. Re-running the guardrail over the same segment produces
#: the same absence, which is what makes it "cannot" rather than "not yet".
NEITHER_SIDE_HAS_A_COMPLETE_DAY = DeclinedFigure(
    "neither side has a complete subsystem-day on the deciding fold, so there "
    "is no floor coverage to compare; both sides are scored on one row set, so "
    "the absence is symmetric",
    figure="both artifacts' floor coverage on the deciding fold, and the comparison",
    kind="unrunnable",
    surface="the gate decision's `floor_coverage` block, `detail`",
)

#: When the candidate has no complete subsystem-day. Distinct from the sentence
#: above because it is reached from the other branch, and the reader of a
#: refused card is entitled to know which of the two states produced it.
CANDIDATE_HAS_NO_COMPLETE_DAY = DeclinedFigure(
    "the candidate has no complete subsystem-day on the deciding fold, and "
    "neither has the incumbent: they are scored on one row set",
    figure="the candidate's floor coverage on the deciding fold",
    kind="unrunnable",
    surface="the gate decision's `floor_coverage` block, `detail`",
)

#: Per subsystem: the incumbent has no complete day here, so there is no floor
#: to be five points below. ``not_applicable`` rather than ``passed``, which is
#: the distinction :data:`Verdict` acquired for exactly this reason.
INCUMBENT_SUBSYSTEM_HAS_NO_FLOOR = DeclinedFigure(
    "the incumbent has no complete day in this subsystem, so there is no floor "
    "coverage to fall below",
    figure="the incumbent's floor coverage in one subsystem of the deciding fold",
    kind="unrunnable",
    surface="the gate decision's `floor_coverage` block, `by_subsystem[].detail`",
)

#: And the mirror, which **vetoes**: a subsystem the incumbent has and the
#: candidate does not. The absence is the candidate's coverage; the veto is what
#: is done about it, because "not shown" and "shown to be fine" are different
#: sentences. Composed into the detail rather than replacing it — the two
#: incumbent figures stay on the sentence, and this census carries no number.
CANDIDATE_SUBSYSTEM_NOT_MEASURED = DeclinedFigure(
    "the candidate has no complete day in this subsystem, so a guardrail "
    "cannot pass on a measurement that was not taken",
    figure="the candidate's floor coverage in one subsystem of the deciding fold",
    kind="unrunnable",
    surface="the gate decision's `floor_coverage` block, `by_subsystem[].detail`",
)


class FloorCoverageError(ValueError):
    """Two coverages that are not a comparison, or a day that is not a day."""


@dataclass(frozen=True)
class SubsystemFloorCoverage:
    """Floor coverage at its stated grain: fold, **subsystem**, fidelity.

    The fold and the fidelity hang off the :class:`FloorCoverage` this belongs
    to; the subsystem is here, and there is no field that pools two of these.
    """

    subsystem: Subsystem
    days: int
    days_floor_met: int

    def __post_init__(self) -> None:
        if self.days <= 0:
            raise FloorCoverageError(
                f"{self.subsystem} appears with {self.days} days; a subsystem "
                "with no complete day is absent from the comparison, not a zero"
            )
        if not 0 <= self.days_floor_met <= self.days:
            raise FloorCoverageError(
                f"{self.subsystem} met the floor on {self.days_floor_met} of "
                f"{self.days} days, which is not a share"
            )

    @property
    def coverage(self) -> float:
        """The share of days whose observed recovery cleared the D−1 promise."""
        return self.days_floor_met / self.days

    def as_dict(self) -> dict[str, Any]:
        return {
            "subsystem": self.subsystem,
            "days": self.days,
            "days_floor_met": self.days_floor_met,
            "floor_coverage": self.coverage,
        }


@dataclass(frozen=True)
class FloorCoverage:
    """One artifact's floor coverage on one fold segment, per subsystem.

    Built only by :func:`floor_coverage`, which is where the plan is solved and
    the simulator is called. ``None`` is returned there rather than an instance
    with no subsystems: a comparison over no complete day is an absence, and the
    absence is what :func:`compare_floor_coverage` reports as
    ``not_applicable``.
    """

    #: The deciding fold segment's ``row_id`` — ``F6``, or ``F6@point_in_time``.
    row_id: str
    fidelity: VintageFidelity
    by_subsystem: tuple[SubsystemFloorCoverage, ...]
    #: ``(subsystem, target_date)`` pairs short of twenty-four settled hours.
    #: Counted rather than dropped silently, and identical on both sides of a
    #: paired comparison because both sides are scored on one row set.
    days_excluded_incomplete: int

    def __post_init__(self) -> None:
        if not self.by_subsystem:
            raise FloorCoverageError(
                f"{self.row_id} carries no subsystem with a complete day; that is "
                "an absent measurement, not a coverage of zero"
            )
        seen = [entry.subsystem for entry in self.by_subsystem]
        if len(set(seen)) != len(seen):
            raise FloorCoverageError(f"{self.row_id} names a subsystem twice: {seen}")

    @property
    def days(self) -> int:
        return sum(entry.days for entry in self.by_subsystem)

    def coverage_of(self, subsystem: Subsystem) -> SubsystemFloorCoverage | None:
        for entry in self.by_subsystem:
            if entry.subsystem == subsystem:
                return entry
        return None

    def as_dict(self) -> dict[str, Any]:
        return {
            "row_id": self.row_id,
            "vintage_fidelity": self.fidelity,
            "days": self.days,
            "days_excluded_incomplete": self.days_excluded_incomplete,
            "by_subsystem": [entry.as_dict() for entry in self.by_subsystem],
        }


@dataclass(frozen=True)
class FloorCoverageProvenance:
    """What the two coverages are coverages *of*. Travels with them, never optional.

    Constructible only through :meth:`measured` or :meth:`fixture`, so
    :data:`FOLD_EVALUATION_SOURCE` cannot be set by a caller that scored
    nothing — the discipline `diagnosis/background.py`,
    `training/conformal.py`, :mod:`~wattsteer_ml.evaluation.collapse_report`,
    :mod:`~wattsteer_ml.evaluation.planning_arms` and
    :mod:`~wattsteer_ml.evaluation.lead_time` all apply to their own published
    figures, and for the same reason.
    """

    floor_coverage_source: str
    lane: Lane
    #: ``packages/core``'s published ``REFERENCE_FLEET``, hashed. Both sides of
    #: the comparison are planned against it or neither number means what it
    #: says (`docs/specs/replay.md` story 35).
    reference_fleet_hash: str
    #: The basis both plans were built on. The product's, imported.
    planning_basis: str
    #: When the comparison was made. ``None`` for a fixture, which was made
    #: against nothing.
    at: datetime | None

    @property
    def is_measurement(self) -> bool:
        """Whether these coverages are evidence about two artifacts. One predicate."""
        return self.floor_coverage_source == FOLD_EVALUATION_SOURCE

    @classmethod
    def measured(cls, *, lane: Lane, at: datetime) -> FloorCoverageProvenance:
        """The stamp for coverages computed from two artifacts' composed hours."""
        return cls(
            floor_coverage_source=FOLD_EVALUATION_SOURCE,
            lane=lane,
            reference_fleet_hash=PUBLISHED_FLEET.fleet_hash,
            planning_basis=SHIPPED_BASIS,
            at=at,
        )

    @classmethod
    def fixture(cls, *, lane: Lane) -> FloorCoverageProvenance:
        """The stamp for coverages built on fabricated bands.

        Named rather than defaulted, because the default is the value that would
        do damage.
        """
        return cls(
            floor_coverage_source=FIXTURE_SOURCE,
            lane=lane,
            reference_fleet_hash=PUBLISHED_FLEET.fleet_hash,
            planning_basis=SHIPPED_BASIS,
            at=None,
        )

    @classmethod
    def unmeasured(cls, *, lane: Lane) -> FloorCoverageProvenance:
        """The stamp on a veto that had nothing to compare — a cold start.

        Its own value rather than :data:`FIXTURE_SOURCE`: "nobody has been
        promoted in this lane yet" and "these bands were made up" are different
        sentences, and a reader of a first artifact's card has to be able to
        tell which one they are looking at.
        """
        return cls(
            floor_coverage_source=UNMEASURED_SOURCE,
            lane=lane,
            reference_fleet_hash=PUBLISHED_FLEET.fleet_hash,
            planning_basis=SHIPPED_BASIS,
            at=None,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "measured": self.is_measurement,
            "floor_coverage_source": self.floor_coverage_source,
            "lane": self.lane.directory_name,
            "reference_fleet_hash": self.reference_fleet_hash,
            "planning_basis": self.planning_basis,
            "at": None if self.at is None else self.at.isoformat(),
        }


@dataclass(frozen=True)
class SubsystemVeto:
    """One subsystem's verdict, with both coverages and the slack on it.

    The constant travels with the answer, as every
    :class:`~wattsteer_ml.evaluation.gate.Guardrail` in this repository does: a
    reader of a refused card should not have to go and find the number the
    refusal turned on.
    """

    subsystem: Subsystem
    verdict: Verdict
    detail: str
    candidate: float | None = None
    incumbent: float | None = None

    @property
    def vetoes(self) -> bool:
        return self.verdict == "vetoed"

    @property
    def shortfall(self) -> float | None:
        """``incumbent − candidate``, in share, or ``None`` when unmeasured."""
        if self.candidate is None or self.incumbent is None:
            return None
        return self.incumbent - self.candidate

    def as_dict(self) -> dict[str, Any]:
        return {
            "subsystem": self.subsystem,
            "verdict": self.verdict,
            "detail": self.detail,
            "candidate_floor_coverage": self.candidate,
            "incumbent_floor_coverage": self.incumbent,
            "shortfall": self.shortfall,
            "slack": FLOOR_COVERAGE_SLACK,
        }


@dataclass(frozen=True)
class FloorCoverageVeto:
    """The guardrail's whole answer: both coverages, per subsystem, and a verdict.

    Written into the gate decision's evidence and therefore onto the promotion
    log line and the artifact card, which is where `docs/specs/replay.md` story
    35's "stamped on every aggregate" lands for this figure: the fold, the
    fidelity, the fleet and both coverages are all on it.
    """

    verdict: Verdict
    detail: str
    provenance: FloorCoverageProvenance
    #: ``None`` on a cold start, and when no ``(subsystem, day)`` of the
    #: deciding segment was complete.
    candidate: FloorCoverage | None
    #: ``None`` whenever there is no incumbent to be below.
    incumbent: FloorCoverage | None
    by_subsystem: tuple[SubsystemVeto, ...] = ()

    def __post_init__(self) -> None:
        if self.verdict == "vetoed" and not any(
            entry.vetoes for entry in self.by_subsystem
        ):
            raise FloorCoverageError(
                "a floor-coverage veto that names no subsystem it fired on is a "
                "refusal nobody can act on"
            )
        if self.verdict != "not_applicable" and (
            self.candidate is None or self.incumbent is None
        ):
            raise FloorCoverageError(
                "a floor-coverage verdict other than not_applicable needs both "
                "coverages; a comparison with one side missing is not one"
            )

    @property
    def vetoes(self) -> bool:
        """The one predicate the gate reads. ``not_applicable`` never vetoes."""
        return self.verdict == "vetoed"

    def as_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "detail": self.detail,
            "slack": FLOOR_COVERAGE_SLACK,
            "provenance": self.provenance.as_dict(),
            "candidate": None if self.candidate is None else self.candidate.as_dict(),
            "incumbent": None if self.incumbent is None else self.incumbent.as_dict(),
            "by_subsystem": [entry.as_dict() for entry in self.by_subsystem],
        }


class ObservedHour(ArmHour, Protocol):
    """An :class:`~wattsteer_ml.evaluation.planning_arms.ArmHour` and its label.

    Structural: :class:`~wattsteer_ml.training.conformal.ScoredHour` satisfies
    it, which is what lets the guardrail be computed from the very sequences the
    paired bootstrap is run over rather than from a second read.
    """

    @property
    def observed_mwh(self) -> float: ...


def floor_coverage(
    hours: Sequence[ObservedHour],
    *,
    row_id: str,
    fidelity: VintageFidelity,
) -> FloorCoverage | None:
    """One artifact's floor coverage on one fold segment. ``None`` when absent.

    One plan per complete ``(subsystem, day)``, built on the shipped basis
    against the published reference fleet, executed against the hour-wise P10
    envelope for the promise and against the settled day for what happened.
    ``floor_met`` is :func:`~wattsteer_ml.replay.scoring.floor_was_met` — the
    Backtest's own comparison, imported — so a share counted here counts the
    same event as a share counted there.

    ``None`` rather than an empty coverage when no day is complete: a segment
    with nothing to score has not shown a coverage of zero, and the caller
    reports that as ``not_applicable``.
    """
    grouped: dict[tuple[date, Subsystem], list[ObservedHour]] = {}
    for hour in hours:
        grouped.setdefault((hour.key.target_date, hour.key.subsystem), []).append(hour)

    met: dict[Subsystem, list[bool]] = {}
    excluded = 0
    for key in sorted(grouped):
        ordered = sorted(grouped[key], key=lambda hour: hour.key.local_hour)
        day = ArmDay.of(ordered, fidelity=fidelity)
        if day is None:
            excluded += 1
            continue
        met.setdefault(key[1], []).append(_floor_met_on(day, ordered))
    if not met:
        return None
    return FloorCoverage(
        row_id=row_id,
        fidelity=fidelity,
        by_subsystem=tuple(
            SubsystemFloorCoverage(
                subsystem=code,
                days=len(met[code]),
                days_floor_met=sum(1 for value in met[code] if value),
            )
            for code in SUBSYSTEM_CODES
            if code in met
        ),
        days_excluded_incomplete=excluded,
    )


def _floor_met_on(day: ArmDay, ordered: Sequence[ObservedHour]) -> bool:
    """Did this subsystem-day clear the floor its own plan promised at D−1.

    One plan, two realisations of it, and no arithmetic of this module's own:
    the promise is the simulator's ``recovered_floor_mwh`` and what happened is
    the simulator's ``recovered_mwh`` on the settled day, which is the fourth
    realisation `docs/specs/replay.md` insists goes through the same function as
    the other three.
    """
    if len(ordered) != HOURS_PER_DAY:  # pragma: no cover — ArmDay.of refuses first
        raise FloorCoverageError(
            f"{day.subsystem} {day.target_date.isoformat()} reached the floor "
            f"scoring with {len(ordered)} hours"
        )
    profile = day.profile
    plan = plan_for(day, SHIPPED_BASIS)
    band = score_band(
        plan,
        p10_mwh=profile.p10_mwh,
        p50_mwh=profile.p50_mwh,
        p90_mwh=profile.p90_mwh,
        threshold_mw=profile.threshold_mw,
    )
    observed = simulate(
        plan,
        tuple(hour.observed_mwh for hour in ordered),
        threshold_mw=profile.threshold_mw,
    )
    return floor_was_met(band=band, observed=observed)


def compare_floor_coverage(
    *,
    candidate: FloorCoverage | None,
    incumbent: FloorCoverage | None,
    provenance: FloorCoverageProvenance,
) -> FloorCoverageVeto:
    """The veto. ``candidate ≥ incumbent − 5 points``, per subsystem, or refuse.

    The **only** comparison this module makes, and both sides of it are measured
    figures. Three outcomes and the first two are not failures:

    - ``not_applicable`` when either side is absent. A cold start has no
      incumbent (`docs/specs/forecaster.md` measures a first artifact against
      rung 1, which has no floor coverage because a baseline plans nothing), and
      a deciding segment with no complete day has no coverage on *either* side —
      the two populations are one row set, so an absence is symmetric and says
      nothing about the candidate.
    - ``passed`` when every subsystem is within the slack.
    - ``vetoed`` when any subsystem is more than the slack below. Per subsystem
      and never pooled, because a share over two subsystems averages two
      different fleets' worth of curtailment — the rule
      :class:`~wattsteer_ml.replay.backtest.SubsystemCoverage` already holds.

    A subsystem the incumbent has and the candidate does not is a veto rather
    than a pass: the candidate has not shown it holds the floor there, and "not
    shown" and "shown to be fine" are different sentences — the gate's own rule
    for an unmeasurable guardrail.
    """
    if candidate is None or incumbent is None:
        return FloorCoverageVeto(
            verdict="not_applicable",
            detail=_absence_detail(candidate=candidate, incumbent=incumbent),
            provenance=provenance,
            candidate=candidate,
            incumbent=incumbent,
        )
    if candidate.fidelity != incumbent.fidelity or candidate.row_id != incumbent.row_id:
        raise FloorCoverageError(
            f"the candidate's coverage is {candidate.row_id} at "
            f"{candidate.fidelity} and the incumbent's is {incumbent.row_id} at "
            f"{incumbent.fidelity}; floor coverage is compared on the shared "
            "newest fold at one fidelity or it is not compared"
        )
    entries = tuple(
        _subsystem_veto(candidate=candidate, incumbent=incumbent, subsystem=code)
        for code in SUBSYSTEM_CODES
        if candidate.coverage_of(code) is not None
        or incumbent.coverage_of(code) is not None
    )
    fired = [entry for entry in entries if entry.vetoes]
    return FloorCoverageVeto(
        verdict="vetoed" if fired else "passed",
        detail=(
            "; ".join(f"{entry.subsystem}: {entry.detail}" for entry in fired)
            if fired
            else (
                f"every subsystem is within {FLOOR_COVERAGE_SLACK:.0%} of the "
                f"incumbent's floor coverage on {candidate.row_id} over "
                f"{candidate.days} complete subsystem-days"
            )
        ),
        provenance=provenance,
        candidate=candidate,
        incumbent=incumbent,
        by_subsystem=entries,
    )


def _absence_detail(
    *, candidate: FloorCoverage | None, incumbent: FloorCoverage | None
) -> str:
    if incumbent is None and candidate is None:
        return NEITHER_SIDE_HAS_A_COMPLETE_DAY
    if incumbent is None:
        return COLD_START_DETAIL
    return CANDIDATE_HAS_NO_COMPLETE_DAY


def _subsystem_veto(
    *, candidate: FloorCoverage, incumbent: FloorCoverage, subsystem: Subsystem
) -> SubsystemVeto:
    theirs = incumbent.coverage_of(subsystem)
    ours = candidate.coverage_of(subsystem)
    if theirs is None:
        return SubsystemVeto(
            subsystem=subsystem,
            verdict="not_applicable",
            detail=INCUMBENT_SUBSYSTEM_HAS_NO_FLOOR,
            candidate=None if ours is None else ours.coverage,
        )
    if ours is None:
        return SubsystemVeto(
            subsystem=subsystem,
            verdict="vetoed",
            detail=(
                f"the incumbent covers {theirs.coverage:.1%} of {theirs.days} "
                f"days here and {CANDIDATE_SUBSYSTEM_NOT_MEASURED}"
            ),
            incumbent=theirs.coverage,
        )
    floor = theirs.coverage - FLOOR_COVERAGE_SLACK
    below = ours.coverage < floor
    return SubsystemVeto(
        subsystem=subsystem,
        verdict="vetoed" if below else "passed",
        detail=(
            f"{ours.coverage:.1%} of {ours.days} days against the incumbent's "
            f"{theirs.coverage:.1%}, slack {FLOOR_COVERAGE_SLACK:.0%}"
        ),
        candidate=ours.coverage,
        incumbent=theirs.coverage,
    )


def floor_coverage_guardrail(
    *,
    candidate_hours: Sequence[ObservedHour],
    incumbent_hours: Sequence[ObservedHour] | None,
    row_id: str,
    fidelity: VintageFidelity,
    lane: Lane,
    at: datetime,
) -> FloorCoverageVeto:
    """Both coverages and the verdict, from the two artifacts' composed hours.

    ``incumbent_hours`` is ``None`` on a cold start — the comparator is rung 1,
    a baseline that plans no fleet — and the verdict is then
    ``not_applicable``. This is the function
    :func:`~wattsteer_ml.evaluation.gate.decide` calls, and it is the only
    caller that may stamp
    :meth:`FloorCoverageProvenance.measured`, because it is the only one holding
    two artifacts' hours.
    """
    if incumbent_hours is None:
        return FloorCoverageVeto(
            verdict="not_applicable",
            detail=COLD_START_DETAIL,
            provenance=FloorCoverageProvenance.unmeasured(lane=lane),
            candidate=None,
            incumbent=None,
        )
    _assert_one_population(candidate_hours, incumbent_hours)
    return compare_floor_coverage(
        candidate=floor_coverage(candidate_hours, row_id=row_id, fidelity=fidelity),
        incumbent=floor_coverage(incumbent_hours, row_id=row_id, fidelity=fidelity),
        provenance=FloorCoverageProvenance.measured(lane=lane, at=at),
    )


def _assert_one_population(
    candidate: Sequence[ObservedHour], incumbent: Sequence[ObservedHour]
) -> None:
    """The two coverages are of the same days or they are not a comparison.

    Keys **and** labels, the pairing rule
    :func:`~wattsteer_ml.evaluation.gate.paired_block_bootstrap` applies to
    these same two sequences. Restated here rather than assumed, because a
    coverage is a share over days and two shares over two populations look
    exactly like a regression.
    """
    ours = _population(candidate)
    theirs = _population(incumbent)
    if ours.keys() != theirs.keys():
        raise FloorCoverageError(
            "the two artifacts were scored on different subsystem-hours, so their "
            "floor coverages are shares over different populations"
        )
    disagreed = sorted(key for key, value in ours.items() if value != theirs[key])
    if disagreed:
        raise FloorCoverageError(
            f"{len(disagreed)} hours carry different observed MWh in the two "
            f"sequences, starting at {disagreed[0]}; two coverages measured "
            "against two labels are not a comparison"
        )


def _population(hours: Sequence[ObservedHour]) -> Mapping[str, float]:
    return {hour.key.line: hour.observed_mwh for hour in hours}
