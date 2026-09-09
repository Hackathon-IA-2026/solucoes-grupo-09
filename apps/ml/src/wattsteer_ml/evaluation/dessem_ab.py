"""The DESSEM A/B, priced in MWh of promised floor rather than in pinball loss.

`docs/specs/forecaster.md`, "The DESSEM A/B — the trade, framed for one sitting":

    **The unit of comparison is not pinball loss.** ``Δ qloss_mwh`` is the
    gate's metric and it is the wrong currency for a product decision, because
    the other side of the trade is eleven hours of operator notice and nobody
    can convert hours into pinball loss. … **Ship DESSEM iff** B-common's
    ``recovered_floor_mwh`` advantage over A-common, on F5–F6, is positive under
    the same paired block bootstrap the hot-swap gate uses (P ≥ 0.9), **and**
    the product accepts a 19:00 BRT publication for the DESSEM-conditioned view.

Three runs on one calendar, two contrasts, one currency.

| Run | Feature set | Window | Isolates |
|---|---|---|---|
| ``A-full`` | ``dessem_free_v1`` | 2024-04-01 → | the product's actual set-A model |
| ``A-common`` | ``dessem_free_v1`` | 2025-05-23 → | the short-window handicap |
| ``B-common`` | ``dessem_augmented_v1`` | 2025-05-23 → | **DESSEM's contribution** |

## Two contrasts, because one of them is not about DESSEM at all

A six-month base fit cannot contain a full annual cycle, so ``B-common`` is
evaluated at a structural disadvantage, and the spec is explicit that **the
disadvantage must not be attributed to DESSEM's features**. ``A-common`` exists
to absorb it. So this module publishes two differences and never one:
:data:`DESSEM_CONTRAST` is ``B-common − A-common``, which is the ruling's, and
:data:`HISTORY_CONTRAST` is ``A-full − A-common``, which prices the history
separately. :class:`Contrast` has no third member and
:func:`~wattsteer_ml.evaluation.dessem_ab.DessemDeltaReport.verdict` will not
take one, because a contrast against a run of a different window *and* a
different feature set is the confusion the second contrast exists to prevent.

## The currency, and why it is not expressed twice

``recovered_floor_mwh`` is
:attr:`~wattsteer_ml.optimizer.simulator.ScoredBand.recovered_floor_mwh` —
**the simulator's**, read rather than recomputed. The plan behind it is
:func:`~wattsteer_ml.evaluation.planning_arms.score_arm` on
:data:`~wattsteer_ml.evaluation.planning_arms.SHIPPED_BASIS` against
:data:`~wattsteer_ml.evaluation.planning_arms.PUBLISHED_FLEET`, which is the
same plan `replay/floor_guardrail.py` builds for the hot-swap veto and the same
one ticket 011's second arm is scored on. There is no floor arithmetic in this
file at all.

The guardrail's own figure is carried beside the MWh, unchanged:
:func:`~wattsteer_ml.replay.floor_guardrail.floor_coverage` per subsystem, on
the same days, from the same hours. A floor that grew in MWh while the share of
days it actually held fell is a thing a reader has to be able to see, and the
two numbers are two questions about one promise rather than two promises.

## The one figure a reader will misread, and the identity that stops them

The floor is the **P10** envelope, and ``Q_Y(q) = 0`` for every ``q ≤ 1 − p``.
So the composed P10 is zero exactly where ``0.10 ≤ 1 − p`` — that is, wherever
``p ≤ 0.90`` — and an arm whose classifier is more confident recovers floor in
hours where a less confident one is structurally blind, with no change in the
magnitude head whatever. ``Δ recovered_floor_mwh`` therefore moves through the
mixture's breakpoint as well as through the model, and
:class:`~wattsteer_ml.evaluation.threshold_sweep.MixtureRegime` — ticket 17's,
imported rather than restated for a third time, because it computes the
breakpoint from the composition's own comparison rather than from the spec's
prose and the two differ in floating point — is published per arm so
``share_p10_forced_zero`` travels with every floor.

## The verdict, and the half of it that is not here

:class:`ShipVerdict` evaluates exactly one thing: whether the advantage is
positive under **the gate's own resampler**
(:func:`~wattsteer_ml.evaluation.gate.resample_day_blocks`, at the gate's
:data:`~wattsteer_ml.evaluation.gate.BOOTSTRAP_DRAWS`, its
:data:`~wattsteer_ml.evaluation.gate.BOOTSTRAP_SEED` and its
:data:`~wattsteer_ml.evaluation.gate.PROMOTION_PROBABILITY`). The ruling's
second conjunct — that the product accepts the later publication — is a human's,
and there is no field here that could hold it: :attr:`ShipVerdict.evidence_bar_met`
is a statement about the evidence, exactly as
:attr:`~wattsteer_ml.evaluation.threshold_sweep.PrevalenceVerdict.forces_a_move`
is, and nothing in this module writes to the promotion log.

## What the shapes here make unrepresentable

- **A verdict on folds that cannot carry one.** :attr:`SegmentRow.decision_grade`
  is :meth:`~wattsteer_ml.evaluation.matrix.MatrixRun.decision_grade_folds`
  evaluated for *all three* runs against the calendar's own
  :attr:`~wattsteer_ml.evaluation.folds.FoldCalendarRules.min_base_fit_days`. No
  fold id is written in this file, so a calendar materialised a quarter later
  grades the new fold on its own arithmetic and the A/B is re-runnable without a
  code change — which is what the spec means by keeping the features as a
  monitored candidate.
- **A comparison across rows.** :func:`SegmentRow.of` runs
  :func:`~wattsteer_ml.evaluation.matrix.assert_identical_test_rows` over all
  three arms and :func:`~wattsteer_ml.evaluation.gate.assert_paired_hours` over
  each pair, so three arms scored on different rows, or against different
  labels, are refused by digest rather than passed by count.
- **A second bootstrap.** :class:`FloorBootstrap` holds a
  :class:`~wattsteer_ml.evaluation.gate.DayBlockResample` and reads
  :attr:`~wattsteer_ml.evaluation.gate.DayBlockResample.left_higher` from it,
  because more floor is better and less loss is better and those are two
  readings of one resample. The resampling itself is the gate's.
- **A figure that has lost its vintage.** Rows carry a
  :class:`~wattsteer_ml.evaluation.vintage.FoldSegment`,
  :func:`~wattsteer_ml.evaluation.vintage.assert_no_averaged_rows` runs on
  construction, and a verdict pooled over two fidelities raises rather than
  averaging the caveat away.
- **A fixture read as evidence.** :class:`DessemProvenance` is constructible
  only through :meth:`DessemProvenance.measured` or
  :meth:`DessemProvenance.fixture` — one more block taking
  :class:`~wattsteer_ml.evaluation.collapse_report.CollapseProvenance`'s
  discipline, in that idiom and not a new one, with the shared source constants
  imported rather than respelt. A floor advantage of 38 MWh is a plausible
  decimal that reads exactly like a statement about what DESSEM is worth.

## Can the three runs actually be run?

Yes — and this is the question ticket 16 answered the other way, so it is
answered here explicitly rather than assumed. ``B-common``'s features are the
twenty-two ``dessem_*`` columns of ``feature_dessem_block``
(`apps/api/drizzle/0025_dessem_and_the_feature_set.sql`), fed by
`apps/api/src/ingest/dessem-job.ts` from ONS's ``balanco_dessem_detalhe`` from
its coverage start of 2025-05-23 — which is exactly ``A-common``'s and
``B-common``'s window start. There is no missing data source here and therefore
no named unmeasured reason of ticket 16's kind: :data:`NOT_RUN_YET` says the A/B
has not been run, not that it cannot be. Ticket 16's own block has since split
along the same line — its A/B still cannot be run, for want of a feature *shape*
rather than an ingestion, while the correlation beside it borrows the
distinction this constant drew.

What the arms need beyond this module is what the sweep's arms need — a
database, the fold calendar and LightGBM — which is why :data:`DessemScorer` is
a parameter and not an import.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Literal

from wattsteer_ml.admissibility import (
    EARLY_GATE,
    WITHHELD_REASONS,
    WithheldAttribute,
    vector_for,
)
from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.caveated import CaveatedFigure
from wattsteer_ml.constants import SUBSYSTEM_THRESHOLD_MW
from wattsteer_ml.declined import DeclinedFigure
from wattsteer_ml.evaluation.collapse_report import FIXTURE_SOURCE, UNMEASURED_SOURCE
from wattsteer_ml.evaluation.folds import FoldCalendar
from wattsteer_ml.evaluation.gate import (
    BOOTSTRAP_DRAWS,
    BOOTSTRAP_SEED,
    PROMOTION_PROBABILITY,
    DayBlock,
    DayBlockResample,
    assert_paired_hours,
    resample_day_blocks,
)
from wattsteer_ml.evaluation.matrix import (
    MATRIX_RUN_BY_NAME,
    MatrixRun,
    ScoredFold,
    assert_identical_test_rows,
    row_set_digest,
)
from wattsteer_ml.evaluation.metrics import qloss_mwh
from wattsteer_ml.evaluation.planning_arms import (
    PUBLISHED_FLEET,
    SHIPPED_BASIS,
    days_of,
    score_arm,
)
from wattsteer_ml.evaluation.threshold_sweep import (
    FOLD_EVALUATION_SOURCE,
    MixtureRegime,
)
from wattsteer_ml.evaluation.vintage import (
    FoldSegment,
    assert_no_averaged_rows,
    pooled_fidelity,
)
from wattsteer_ml.lanes import Lane
from wattsteer_ml.replay.floor_guardrail import FloorCoverage, floor_coverage
from wattsteer_ml.training.bundle import read_card, write_card
from wattsteer_ml.training.conformal import ScoredHour

#: The card block, spelt as `docs/specs/forecaster.md`'s Experiments group spells
#: it — ``lead_time_penalty`` block, ``dessem_delta`` block, ``threshold_sweep``
#: block. A reader grepping the spec finds the key.
DESSEM_DELTA_BLOCK_KEY = "dessem_delta"

#: How often it is produced. The spec's fallback sentence is that below the bar
#: the ``dessem_*`` features stay "a monitored candidate that is re-run each
#: quarter as the window lengthens", and a quarter is exactly when the calendar
#: freezes a fold and opens the next.
CADENCE = "quarterly"

#: The gate the A/B is run at, and the only one ``dessem_augmented_v1`` exists
#: at: ``feature_dessem_block`` raises for that set at any other profile rather
#: than returning a column of NULLs for it.
AB_GATE_PROFILE = "gate_late"

#: The three runs, **taken from the matrix rather than respelt**. The matrix is
#: the authority on each one's feature set, window start and weather arm, and a
#: second statement of A-common's window start is the one edit that would make
#: the fairness rule quietly false.
AB_RUN_NAMES: tuple[str, ...] = ("A-full", "A-common", "B-common")
AB_RUNS: tuple[MatrixRun, ...] = tuple(MATRIX_RUN_BY_NAME[name] for name in AB_RUN_NAMES)

#: The augmented run, and the two free-feature runs it is read against.
DESSEM_RUN = "B-common"
COMMON_CONTROL_RUN = "A-common"
FULL_HISTORY_RUN = "A-full"

#: The two lanes the three runs write into. Two, not three: a lane is
#: ``(feature_set, gate_profile, threshold_mw)`` and a window is not part of it,
#: so ``A-full`` and ``A-common`` share the free lane. Derived from the runs, so
#: a lane list cannot name a lane no arm was run in.
AB_LANES: tuple[Lane, ...] = tuple(
    dict.fromkeys(
        Lane(
            feature_set=run.feature_set,
            gate_profile=AB_GATE_PROFILE,
            threshold_mw=float(SUBSYSTEM_THRESHOLD_MW),
        )
        for run in AB_RUNS
    )
)

#: The two differences the block publishes. There is no third, and a contrast
#: that is not one of these two is not expressible.
ContrastName = Literal["dessem_contribution", "history_price"]

#: The ruling's contrast: DESSEM's contribution, against the run that shares its
#: window.
DESSEM_CONTRAST: ContrastName = "dessem_contribution"

#: And the one that keeps the short-window handicap off DESSEM's account.
HISTORY_CONTRAST: ContrastName = "history_price"


class DessemAbError(ValueError):
    """The arms cannot support the comparison that was asked for."""


@dataclass(frozen=True)
class Contrast:
    """One difference of two runs, and what it is a difference *of*.

    ``treatment − control``. Subtraction has to pick an order and this one picks
    the order the question is asked in, exactly as
    :attr:`~wattsteer_ml.evaluation.planning_arms.ArmComparison.delta_recovered_floor_mwh`
    does one figure over.
    """

    name: ContrastName
    treatment: str
    control: str
    isolates: str

    def __post_init__(self) -> None:
        if self.treatment == self.control:
            raise DessemAbError(
                f"{self.name} contrasts {self.treatment} with itself; a difference "
                "of a run and itself is zero by construction and prices nothing"
            )
        for run in (self.treatment, self.control):
            if run not in AB_RUN_NAMES:
                raise DessemAbError(
                    f"{run!r} is not one of the A/B's runs {list(AB_RUN_NAMES)}"
                )

    def as_dict(self) -> dict[str, Any]:
        return {
            "contrast": self.name,
            "treatment": self.treatment,
            "control": self.control,
            "isolates": self.isolates,
        }


#: Both contrasts, in the order the block lists them. The first is the ruling's.
CONTRASTS: tuple[Contrast, ...] = (
    Contrast(
        name=DESSEM_CONTRAST,
        treatment=DESSEM_RUN,
        control=COMMON_CONTROL_RUN,
        isolates=(
            "DESSEM's contribution. Both runs open on the same day, so the "
            "six-month base fit's structural disadvantage is absorbed by the "
            "control rather than charged to DESSEM's features. This is the "
            "contrast the ruling is taken on"
        ),
    ),
    Contrast(
        name=HISTORY_CONTRAST,
        treatment=FULL_HISTORY_RUN,
        control=COMMON_CONTROL_RUN,
        isolates=(
            "the price of the training history, on its own. Same feature set, "
            "same gate, same rows; twenty-nine months of window against fifteen. "
            "It is published so that a reader who sees the DESSEM contrast come "
            "in small can see how much of the short window's handicap it was "
            "measured against"
        ),
    ),
)

CONTRAST_BY_NAME: dict[ContrastName, Contrast] = {
    contrast.name: contrast for contrast in CONTRASTS
}

#: :attr:`UnmeasuredDessemDelta.reason` — and deliberately **not** ticket 16's
#: shape. The lead-time A/B has no data source for its control arm and says so;
#: this one has one for every arm, so the only honest absence is "not run yet".
NOT_RUN_YET = DeclinedFigure(
    "The three runs have not been scored. This is not a floor advantage of zero "
    "and not a finding that DESSEM's features are worth nothing: the arms exist "
    "and their data exists — the twenty-two dessem_* columns are populated by "
    "feature_dessem_block from ONS's balanco_dessem_detalhe, ingested from its "
    "coverage start of 2025-05-23, which is B-common's window start — so this "
    "comparison is unmade rather than made and found uninteresting. What it "
    "needs is a fold sweep against a migrated database, not a data source.",
    figure="the DESSEM A/B's three arms, and the floor advantage between them",
    kind="unrun",
    surface="the model card's `dessem_delta` block, `reason`",
)


def structurally_withheld() -> tuple[WithheldAttribute, ...]:
    """The attributes ``B-common`` gains and the morning view can never have.

    The other side of the trade, as a census rather than as a sentence. Read
    from :func:`~wattsteer_ml.admissibility.vector_for`, which reads
    ``available_at_gate_early`` off the generated model-input artifact — so no
    feature name is written here, and the day a column joins or leaves the
    DESSEM block this answers differently without an edit.

    ``structural`` and not ``publication_lag``: DESSEM for day D is not
    published until the evening of D−1 at all, so no publication schedule could
    put these columns in front of the 09:00 gate. That is what makes the eleven
    hours a real cost rather than an ingestion backlog, and it is
    :mod:`~wattsteer_ml.admissibility`'s distinction, imported.
    """
    vector = vector_for(
        feature_set=MATRIX_RUN_BY_NAME[DESSEM_RUN].feature_set,
        gate_profile=EARLY_GATE,
    )
    return tuple(item for item in vector.withheld if item.reason == "structural")


@dataclass(frozen=True)
class DayTotal:
    """One run's floor on one target day, and the days it is a total over.

    The target day is the grain the gate's bootstrap resamples at and the
    subsystem-day is the grain a plan is built at:
    :meth:`~wattsteer_ml.evaluation.planning_arms.ArmDay.of` refuses a
    ``(day, subsystem)`` short of twenty-four hours rather than zero-filling it,
    so a day's :attr:`subsystem_days` are the complete ones it had.
    """

    target_date: date
    recovered_floor_mwh: float
    subsystem_days: int


@dataclass(frozen=True)
class RunFloor:
    """One run's floor over one fold segment, with what it must be read beside.

    Built only through :meth:`of`, which is where the plans are solved. Every
    figure on it is read off an existing definition — the simulator's floor,
    :func:`~wattsteer_ml.evaluation.metrics.qloss_mwh`,
    :func:`~wattsteer_ml.replay.floor_guardrail.floor_coverage`,
    :class:`~wattsteer_ml.evaluation.threshold_sweep.MixtureRegime` — so a
    number here and a number of the same name elsewhere are one arithmetic.
    """

    run: str
    days: int
    days_excluded_incomplete: int
    #: ``Σ_days`` the simulator's P10-simulated recovery. **The unit of
    #: comparison**, and the number the product promises.
    recovered_floor_mwh: float
    #: ``Σ_days Σ_t P10[t]`` — the envelope the floor was recovered out of.
    floor_baseline_mwh: float
    #: The gate's currency, carried and never contrasted here. The spec is
    #: explicit that it is the wrong currency for this decision; it is on the
    #: block so a reader can see the two answers are not the same answer.
    qloss_mwh: float
    #: Where the composition's breakpoint sat for this arm. ``share_p10_forced_zero``
    #: is the share of hours whose floor was zero because ``0.10 ≤ 1 − p``, and
    #: it moves ``recovered_floor_mwh`` with no change in the magnitude head.
    regime: MixtureRegime
    #: The guardrail's share of days the promise actually held, per subsystem.
    #: ``None`` when the segment had no complete subsystem-day.
    coverage: FloorCoverage | None
    #: Per target day, in date order. What the paired day blocks are built from.
    by_day: tuple[DayTotal, ...]

    @property
    def target_days(self) -> int:
        """Distinct target dates with at least one complete subsystem-day."""
        return len(self.by_day)

    @classmethod
    def of(
        cls, hours: Sequence[ScoredHour], *, run: str, segment: FoldSegment
    ) -> RunFloor | None:
        """One arm's floor, or ``None`` when the segment held no complete day.

        ``None`` rather than a floor of zero, for the reason
        :func:`~wattsteer_ml.evaluation.planning_arms.score_planning_arms`
        returns one: a floor of 0.0 MWh says the fleet recovers nothing, and no
        complete day says nothing whatever.
        """
        if not hours:
            raise DessemAbError(
                f"{run} was scored on no hour of {segment.row_id}; an arm with "
                "none is absent, not a row of zeros"
            )
        days, excluded = days_of(hours, fidelity=segment.fidelity)
        if not days:
            return None
        totals: dict[date, tuple[float, int]] = {}
        floor_total = 0.0
        baseline = 0.0
        for day in days:
            recovered = score_arm(day, SHIPPED_BASIS).recovered_floor_mwh
            floor_total += recovered
            baseline += sum(day.profile.p10_mwh)
            running, units = totals.get(day.target_date, (0.0, 0))
            totals[day.target_date] = (running + recovered, units + 1)
        return cls(
            run=run,
            days=len(days),
            days_excluded_incomplete=excluded,
            recovered_floor_mwh=floor_total,
            floor_baseline_mwh=baseline,
            qloss_mwh=qloss_mwh(hours),
            regime=MixtureRegime.of(hours),
            coverage=floor_coverage(
                hours, row_id=segment.row_id, fidelity=segment.fidelity
            ),
            by_day=tuple(
                DayTotal(
                    target_date=day,
                    recovered_floor_mwh=totals[day][0],
                    subsystem_days=totals[day][1],
                )
                for day in sorted(totals)
            ),
        )

    def as_card_entry(self) -> dict[str, Any]:
        run = MATRIX_RUN_BY_NAME[self.run]
        return {
            "run": self.run,
            "feature_set": run.feature_set,
            "window_start": run.window_start.isoformat(),
            "isolates": run.isolates,
            "days": self.days,
            "target_days": self.target_days,
            "days_excluded_incomplete": self.days_excluded_incomplete,
            "recovered_floor_mwh": self.recovered_floor_mwh,
            "floor_baseline_mwh": self.floor_baseline_mwh,
            "qloss_mwh": self.qloss_mwh,
            "mixture_regime": self.regime.as_card_entry(),
            "floor_coverage": None if self.coverage is None else self.coverage.as_dict(),
        }


#: One fold segment's three arms, keyed by run name.
AbArms = Mapping[str, Sequence[ScoredHour]]


@dataclass(frozen=True)
class SegmentRow:
    """One fold segment: three arms on identical rows, and whether it may decide.

    :attr:`decision_grade` is not a field a caller sets. It is
    :meth:`~wattsteer_ml.evaluation.matrix.MatrixRun.decision_grade_folds`
    evaluated against the calendar for **all three** runs, so a fold in which
    any arm's base fit is short of the calendar's
    ``min_base_fit_days`` is reported and excluded rather than quietly counted.
    """

    segment: FoldSegment
    decision_grade: bool
    #: Base-fit days this fold buys each run, from the run's own window start.
    #: The arithmetic behind :attr:`decision_grade`, published so a reader does
    #: not have to trust the boolean.
    base_fit_days: Mapping[str, int]
    min_base_fit_days: int
    floors: tuple[RunFloor, ...]
    #: One row-identity claim per arm. Never supplied by a caller.
    scored: tuple[ScoredFold, ...]

    def __post_init__(self) -> None:
        names = tuple(entry.run for entry in self.floors)
        if names != AB_RUN_NAMES:
            raise DessemAbError(
                f"{self.segment.row_id} carries arms {list(names)}; the A/B is "
                f"exactly {list(AB_RUN_NAMES)} in that order, and a fold missing "
                "one is a fold whose comparison was not made"
            )
        assert_identical_test_rows(list(self.scored))

    def floor(self, run: str) -> RunFloor:
        for entry in self.floors:
            if entry.run == run:
                return entry
        raise DessemAbError(f"{run!r} is not an arm of this comparison")

    def delta(self, contrast: ContrastName) -> float:
        """``treatment − control``, in MWh of promised floor."""
        one = CONTRAST_BY_NAME[contrast]
        return (
            self.floor(one.treatment).recovered_floor_mwh
            - self.floor(one.control).recovered_floor_mwh
        )

    def blocks(self, contrast: ContrastName) -> tuple[DayBlock, ...]:
        """The paired day blocks of one contrast, in the gate's own type.

        The two arms were scored on one row set — asserted on construction — so
        their days pair by construction; this refuses anyway, because a pairing
        that is true by argument and false in fact is invisible in two totals
        that both look fine.
        """
        one = CONTRAST_BY_NAME[contrast]
        treatment = self.floor(one.treatment).by_day
        control = self.floor(one.control).by_day
        if [day.target_date for day in treatment] != [day.target_date for day in control]:
            raise DessemAbError(
                f"{self.segment.row_id}: {one.treatment} and {one.control} have "
                "complete days on different dates, so their floors are sums over "
                "different populations"
            )
        blocks: list[DayBlock] = []
        for left, right in zip(treatment, control, strict=True):
            if left.subsystem_days != right.subsystem_days:
                raise DessemAbError(
                    f"{self.segment.row_id} {left.target_date.isoformat()}: "
                    f"{one.treatment} has {left.subsystem_days} complete "
                    f"subsystem-days and {one.control} has "
                    f"{right.subsystem_days}; the two arms are one row set, and a "
                    "day complete for one of them is complete for both"
                )
            blocks.append(
                DayBlock(
                    day=left.target_date,
                    left=left.recovered_floor_mwh,
                    right=right.recovered_floor_mwh,
                    units=left.subsystem_days,
                )
            )
        return tuple(blocks)

    @classmethod
    def of(
        cls, arms: AbArms, *, segment: FoldSegment, calendar: FoldCalendar
    ) -> SegmentRow:
        """**The comparison.** Three arms over one fold segment, on identical rows.

        Row identity is asserted twice and for two different failures: by digest
        across all three arms
        (:func:`~wattsteer_ml.evaluation.matrix.assert_identical_test_rows`,
        which is a statement about the *set*), and pairwise in order against the
        labels (:func:`~wattsteer_ml.evaluation.gate.assert_paired_hours`, which
        is what the bootstrap needs and what catches two arms scored against two
        vintages of one day).
        """
        missing = [name for name in AB_RUN_NAMES if name not in arms]
        extra = sorted(set(arms) - set(AB_RUN_NAMES))
        if missing or extra:
            raise DessemAbError(
                f"the A/B is exactly {list(AB_RUN_NAMES)}; this one is missing "
                f"{missing} and adds {extra}. Two arms are not the evidence the "
                "spec asks for: A-common is what keeps the short-window handicap "
                "off DESSEM's account"
            )
        ordered = {
            name: sorted(arms[name], key=lambda hour: hour.key) for name in AB_RUN_NAMES
        }
        scored = tuple(
            ScoredFold(
                run=name,
                fold_id=segment.fold_id,
                fold_hash=segment.fold_hash,
                row_digest=row_set_digest(hour.key for hour in ordered[name]),
                row_count=len(ordered[name]),
            )
            for name in AB_RUN_NAMES
        )
        assert_identical_test_rows(list(scored))
        baseline = ordered[AB_RUN_NAMES[0]]
        for name in AB_RUN_NAMES[1:]:
            assert_paired_hours(baseline, ordered[name])
        fold = calendar.fold(segment.fold_id)
        minimum = calendar.rules.min_base_fit_days
        base_fit = {run.name: fold.base_fit_days_for(run.window_start) for run in AB_RUNS}
        floors = []
        for name in AB_RUN_NAMES:
            entry = RunFloor.of(ordered[name], run=name, segment=segment)
            if entry is None:
                raise DessemAbError(
                    f"{name} has no complete subsystem-day on {segment.row_id}, "
                    "and neither will its siblings — the three arms are one row "
                    "set. A segment with no complete day is left out of the "
                    "report rather than reported as three floors of zero"
                )
            floors.append(entry)
        return cls(
            segment=segment,
            decision_grade=all(value >= minimum for value in base_fit.values()),
            base_fit_days=base_fit,
            min_base_fit_days=minimum,
            floors=tuple(floors),
            scored=scored,
        )

    def card_entry(self) -> dict[str, Any]:
        return {
            "row_id": self.segment.row_id,
            "fold_id": self.segment.fold_id,
            "vintage_fidelity": self.segment.fidelity,
            "segment_hash": self.segment.segment_hash,
            "fold_hash": self.segment.fold_hash,
            "test_start": self.segment.test_start.isoformat(),
            "test_end": self.segment.test_end.isoformat(),
            "row_digest": self.scored[0].row_digest,
            "rows": self.scored[0].row_count,
            "decision_grade": self.decision_grade,
            "min_base_fit_days": self.min_base_fit_days,
            "base_fit_days": dict(self.base_fit_days),
            "runs": {entry.run: entry.as_card_entry() for entry in self.floors},
            "contrasts": {
                contrast.name: {
                    "delta_recovered_floor_mwh": self.delta(contrast.name),
                    "decision_grade": self.decision_grade,
                }
                for contrast in CONTRASTS
            },
        }


@dataclass(frozen=True)
class FloorBootstrap:
    """One contrast's advantage, under the gate's own resampler.

    :attr:`probability` reads
    :attr:`~wattsteer_ml.evaluation.gate.DayBlockResample.left_higher` where the
    gate reads ``left_lower``, and that is the only difference between the two
    statistics: a smaller ``qloss_mwh`` is better and a larger floor is better,
    and both are readings of one resample of one set of whole days.
    """

    contrast: ContrastName
    blocks: tuple[DayBlock, ...]
    resample: DayBlockResample
    bar: float = PROMOTION_PROBABILITY

    @property
    def probability(self) -> float:
        """``P(treatment floor > control floor)`` per complete subsystem-day."""
        return self.resample.left_higher / self.resample.draws

    @property
    def clears_the_bar(self) -> bool:
        return self.probability >= self.bar

    @property
    def treatment_floor_per_day_mwh(self) -> float:
        return self.resample.left_per_unit

    @property
    def control_floor_per_day_mwh(self) -> float:
        return self.resample.right_per_unit

    @classmethod
    def of(
        cls,
        blocks: Sequence[DayBlock],
        *,
        contrast: ContrastName,
        draws: int = BOOTSTRAP_DRAWS,
        seed: int = BOOTSTRAP_SEED,
    ) -> FloorBootstrap:
        return cls(
            contrast=contrast,
            blocks=tuple(blocks),
            resample=resample_day_blocks(blocks, draws=draws, seed=seed),
        )

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "probability_treatment_better": self.probability,
            "promotion_probability": self.bar,
            "clears_the_bar": self.clears_the_bar,
            "ties": self.resample.ties,
            "draws": self.resample.draws,
            "seed": self.resample.seed,
            "target_days": self.resample.days,
            "subsystem_days": self.resample.units,
            "treatment_floor_mwh_per_subsystem_day": self.treatment_floor_per_day_mwh,
            "control_floor_mwh_per_subsystem_day": self.control_floor_per_day_mwh,
        }


@dataclass(frozen=True)
class ShipVerdict:
    """The evidence half of the ruling, and nothing that could take the other.

    :attr:`evidence_bar_met` is a statement about the bootstrap, exactly as
    :attr:`~wattsteer_ml.evaluation.threshold_sweep.PrevalenceVerdict.forces_a_move`
    is a statement about a prevalence: it is what makes the product's decision
    *due*, and there is nothing in this module that could take it. The spec's
    second conjunct — that the product accepts a 19:00 BRT publication for the
    DESSEM-conditioned view — has no field here on purpose.
    """

    contrast: ContrastName
    fidelity: VintageFidelity
    decision_grade_rows: tuple[str, ...]
    delta_recovered_floor_mwh: float
    bootstrap: FloorBootstrap

    @property
    def target_days(self) -> int:
        """The sample size, in target days. Printed beside the probability."""
        return self.bootstrap.resample.days

    @property
    def evidence_bar_met(self) -> bool:
        return self.bootstrap.clears_the_bar

    @property
    def statement(self) -> str:
        one = CONTRAST_BY_NAME[self.contrast]
        head = (
            f"{one.treatment} − {one.control} = "
            f"{self.delta_recovered_floor_mwh:+.1f} MWh of promised floor over "
            f"{self.target_days} target days on "
            f"{', '.join(self.decision_grade_rows)}, "
            f"P(treatment better) = {self.bootstrap.probability:.3f} under the "
            f"hot-swap gate's paired block bootstrap "
            f"({self.bootstrap.resample.draws} draws, seed "
            f"{self.bootstrap.resample.seed})."
        )
        if self.evidence_bar_met:
            return (
                f"{head} MET: the advantage clears {self.bootstrap.bar}. The "
                "ruling's other conjunct is the product's — it must accept the "
                "D-1 19:00 BRT publication for the DESSEM-conditioned view — and "
                "this block cannot record that. Nothing here promotes anything."
            )
        return (
            f"{head} NOT MET: the advantage does not clear {self.bootstrap.bar}, "
            f"so the dessem_* features stay a monitored candidate and this A/B is "
            f"re-run each quarter ({CADENCE}) as the window lengthens. Below the "
            "bar the served evening view is the free-feature run."
        )

    @classmethod
    def of(
        cls, rows: Sequence[SegmentRow], *, contrast: ContrastName
    ) -> ShipVerdict | None:
        """The verdict over the decision-grade rows, or ``None`` if there are none.

        ``None`` rather than a verdict over everything: the spec's fold
        arithmetic is what restricts the answer to two test quarters, and a
        verdict taken over a fold whose base fit is 133 days would be the
        restriction quietly lifted.

        A verdict pooled over two vintage fidelities raises
        :class:`~wattsteer_ml.evaluation.vintage.MixedFidelityError` rather than
        averaging, for the reason nothing else in this package pools either.
        """
        grade = [row for row in rows if row.decision_grade]
        if not grade:
            return None
        fidelity = pooled_fidelity([row.segment for row in grade])
        blocks = [block for row in grade for block in row.blocks(contrast)]
        return cls(
            contrast=contrast,
            fidelity=fidelity,
            decision_grade_rows=tuple(row.segment.row_id for row in grade),
            delta_recovered_floor_mwh=sum(row.delta(contrast) for row in grade),
            bootstrap=FloorBootstrap.of(blocks, contrast=contrast),
        )

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "decision_grade_rows": list(self.decision_grade_rows),
            "vintage_fidelity": self.fidelity,
            "target_days": self.target_days,
            "delta_recovered_floor_mwh": self.delta_recovered_floor_mwh,
            "evidence_bar_met": self.evidence_bar_met,
            "bootstrap": self.bootstrap.as_card_entry(),
            "statement": self.statement,
        }


@dataclass(frozen=True)
class DessemProvenance:
    """What the floors are floors *of*. Travels with them, never optional.

    One more block carrying one, and the failure is the one every other block
    that carries a stamp names: a floor advantage of 38 MWh is computable from
    any three fabricated arms and reads exactly like a statement about what an
    evening publication would buy the Brazilian grid.
    """

    dessem_source: str
    at: datetime | None

    @property
    def is_measurement(self) -> bool:
        return self.dessem_source == FOLD_EVALUATION_SOURCE

    @classmethod
    def measured(cls, *, at: datetime) -> DessemProvenance:
        """The stamp for arms scored by three real fold evaluations."""
        return cls(dessem_source=FOLD_EVALUATION_SOURCE, at=at)

    @classmethod
    def fixture(cls) -> DessemProvenance:
        """The stamp for arms built on fabricated hours. Named, never defaulted."""
        return cls(dessem_source=FIXTURE_SOURCE, at=None)

    def card_fields(self) -> dict[str, Any]:
        return {
            "measured": self.is_measurement,
            "dessem_source": self.dessem_source,
            "cadence": CADENCE,
            "gate_profile": AB_GATE_PROFILE,
            "at": None if self.at is None else self.at.isoformat(),
        }


@dataclass(frozen=True)
class DessemDeltaReport:
    """The three runs' floors per fold segment, and the two contrasts over them.

    :meth:`card_block` is the whole published surface. There is no field on it
    that names a winner and no path from it to ``promotions.jsonl``.
    """

    provenance: DessemProvenance
    rows: tuple[SegmentRow, ...]
    #: The calendar the folds were graded against, hashed. A block whose hash
    #: predates the current calendar is visibly stale rather than silently
    #: refreshed, which is what :data:`CADENCE` requires.
    fold_calendar_rules_hash: str
    min_base_fit_days: int

    def __post_init__(self) -> None:
        if not self.rows:
            raise DessemAbError(
                "a DESSEM A/B with no fold segment; an absent A/B is "
                "UnmeasuredDessemDelta, which carries a reason instead of no rows"
            )
        seen = [row.segment.row_id for row in self.rows]
        if len(set(seen)) != len(seen):
            raise DessemAbError(
                f"a fold segment is reported twice: {sorted(seen)!r}; one segment "
                "has one row, and a duplicate is a day scored twice"
            )
        assert_no_averaged_rows([row.segment for row in self.rows])

    @classmethod
    def of(
        cls,
        arms_by_segment: Iterable[tuple[FoldSegment, AbArms]],
        *,
        calendar: FoldCalendar,
        provenance: DessemProvenance,
    ) -> DessemDeltaReport:
        return cls(
            provenance=provenance,
            rows=tuple(
                SegmentRow.of(arms, segment=segment, calendar=calendar)
                for segment, arms in arms_by_segment
            ),
            fold_calendar_rules_hash=calendar.rules.rules_hash,
            min_base_fit_days=calendar.rules.min_base_fit_days,
        )

    @property
    def decision_grade_rows(self) -> tuple[SegmentRow, ...]:
        return tuple(row for row in self.rows if row.decision_grade)

    @property
    def fidelities(self) -> tuple[VintageFidelity, ...]:
        seen: list[VintageFidelity] = []
        for row in self.rows:
            if row.segment.fidelity not in seen:
                seen.append(row.segment.fidelity)
        return tuple(seen)

    def verdict(self, contrast: ContrastName) -> ShipVerdict | None:
        """One contrast's verdict over the decision-grade folds, or ``None``."""
        if contrast not in CONTRAST_BY_NAME:
            raise DessemAbError(
                f"{contrast!r} is not one of the A/B's contrasts "
                f"{sorted(CONTRAST_BY_NAME)}"
            )
        return ShipVerdict.of(self.rows, contrast=contrast)

    def card_block(self) -> dict[str, Any]:
        """The block, under :data:`DESSEM_DELTA_BLOCK_KEY`.

        ``decides``, ``reads``, ``mixture_caveat``, ``sample_size`` and
        ``operator_notice`` are prose and always present, the discipline the
        three blocks beside this one apply: a reader who reaches the figures has
        already read what they do not license.
        """
        census = structurally_withheld()
        block: dict[str, Any] = {
            **self.provenance.card_fields(),
            "decides": _DECIDES_NOTHING,
            "reads": _READS if self.provenance.is_measurement else _NOT_A_READING,
            "mixture_caveat": _MIXTURE_CAVEAT,
            "sample_size": _SAMPLE_SIZE,
            "operator_notice": _OPERATOR_NOTICE,
            "runs": [
                {
                    "run": run.name,
                    "feature_set": run.feature_set,
                    "window_start": run.window_start.isoformat(),
                    "weather_arm": run.weather_arm,
                    "gate_profile": run.gate_profile,
                    "isolates": run.isolates,
                }
                for run in AB_RUNS
            ],
            "lanes": [lane.directory_name for lane in AB_LANES],
            "planning_basis": SHIPPED_BASIS,
            "reference_fleet": PUBLISHED_FLEET.card_fields(),
            "fold_calendar_rules_hash": self.fold_calendar_rules_hash,
            "min_base_fit_days": self.min_base_fit_days,
            "structural_withholding": {
                "reason": "structural",
                "explanation": WITHHELD_REASONS["structural"],
                "count": len(census),
                "columns": sorted(item.column_name for item in census),
            },
            "vintage_fidelities": list(self.fidelities),
            "folds": [row.card_entry() for row in self.rows],
            "contrasts": {},
        }
        for contrast in CONTRASTS:
            verdict = self.verdict(contrast.name)
            block["contrasts"][contrast.name] = {
                **contrast.as_dict(),
                "delta_recovered_floor_mwh_by_fold": {
                    row.segment.row_id: row.delta(contrast.name) for row in self.rows
                },
                "verdict": None if verdict is None else verdict.as_card_entry(),
                "no_verdict_reason": None if verdict is not None else _NO_DECIDING_FOLD,
            }
        return {DESSEM_DELTA_BLOCK_KEY: block}


@dataclass(frozen=True)
class UnmeasuredDessemDelta:
    """No floors, and the sentence saying why — the shape of an unrun A/B.

    A card with no ``dessem_delta`` block and a card saying "the three runs have
    not been scored" look identical to anybody grepping for the figure, and only
    one of them is true. It has no field that could be mistaken for a floor.
    """

    lane: Lane
    at: datetime
    reason: str
    dessem_source: str = UNMEASURED_SOURCE

    @property
    def is_measurement(self) -> bool:
        return False

    def card_block(self) -> dict[str, Any]:
        return {
            DESSEM_DELTA_BLOCK_KEY: {
                "measured": False,
                "dessem_source": self.dessem_source,
                "cadence": CADENCE,
                "gate_profile": AB_GATE_PROFILE,
                "lane": self.lane.directory_name,
                "lanes": [lane.directory_name for lane in AB_LANES],
                "runs": [run.name for run in AB_RUNS],
                "at": self.at.isoformat(),
                "reason": self.reason,
                "decides": _DECIDES_NOTHING,
                "reads": _NOTHING_YET,
                "sample_size": _SAMPLE_SIZE,
            }
        }


def unmeasured_until_run(*, lane: Lane, at: datetime) -> UnmeasuredDessemDelta:
    """The A/B that has not been run, in one sentence that is always the same.

    A named constructor rather than a caller-supplied string, so two cards in
    this state are comparable as two states rather than as two phrasings — the
    discipline :mod:`~wattsteer_ml.evaluation.lead_time`'s
    ``unmeasured_for_want_of_archive_features`` applies to the state *it* names.
    **The two states are different**: that one says an arm has no expressible
    shape, this one says a sweep has not been run.
    """
    return UnmeasuredDessemDelta(lane=lane, at=at, reason=NOT_RUN_YET)


def record_dessem_delta(
    report: DessemDeltaReport | UnmeasuredDessemDelta,
    *,
    root: Path,
    artifact_id: str,
    lane: Lane,
) -> Path:
    """Write the block onto one lane's card. **The only thing this module writes.**

    An edit of a card already on the volume, through the one reader and the one
    writer :func:`~wattsteer_ml.evaluation.gate.record_decision`,
    :func:`~wattsteer_ml.evaluation.planning_arms.record_planning_arms` and
    :func:`~wattsteer_ml.evaluation.threshold_sweep.record_threshold_sweep` use,
    so the blocks cannot disagree about what a card is.

    The whole comparison goes onto both lanes' cards rather than each lane
    carrying its own arm, because the comparison is the deliverable: a reader
    holding the served evening lane's card is exactly the reader who needs to
    know what the augmented lane would have added. ``lane`` must be one of
    :data:`AB_LANES` — a ``dessem_delta`` block on the morning lane's card would
    describe a comparison that lane structurally cannot be part of.

    Nothing here appends to ``promotions.jsonl``, and there is no argument that
    could make it.
    """
    if lane not in AB_LANES:
        raise DessemAbError(
            f"{lane} is not one of the A/B's lanes "
            f"{[one.directory_name for one in AB_LANES]}; the comparison is run "
            f"at {AB_GATE_PROFILE}, which is the only gate dessem_augmented_v1 "
            "exists at"
        )
    path = root / lane.directory_name / f"{artifact_id}{CARD_SUFFIX}"
    card = read_card(path)
    write_card(path, {**card, **report.card_block()})
    return path


def carry_forward(previous: Mapping[str, Any]) -> dict[str, Any] | None:
    """The block a previous card carried, for a retrain that must not re-run it.

    The A/B is quarterly and a weekly artifact still has to publish it or the
    figure disappears from the card the moment a model is swapped. A copy and
    deliberately not a refresh: the block names the fold calendar's rules hash it
    was run against, so a reader can see that it predates the current calendar
    rather than being silently recomputed by a retrain that never re-ran it.
    """
    block = previous.get(DESSEM_DELTA_BLOCK_KEY)
    if block is None:
        return None
    if not isinstance(block, dict):
        raise DessemAbError(
            f"{DESSEM_DELTA_BLOCK_KEY!r} on the previous card is a "
            f"{type(block).__name__}, not a block"
        )
    return {DESSEM_DELTA_BLOCK_KEY: dict(block)}


#: One arm's scoring call: the settled hours one run produced on one segment.
DessemScorer = Callable[[MatrixRun, FoldSegment], Sequence[ScoredHour]]


def run_dessem_ab(
    score: DessemScorer,
    *,
    segments: Sequence[FoldSegment],
    calendar: FoldCalendar,
    provenance: DessemProvenance,
) -> DessemDeltaReport:
    """Score every run on every segment, in one loop, and publish the result.

    ``score`` is the whole of one run's fold evaluation — fit the base learners
    on this run's window, calibrate, conformalise, compose, return the segment's
    settled hours. It is a parameter rather than an import because that needs a
    database, a fold calendar and LightGBM, and none of those belong to the
    question this module answers, which is *what the three arms may and may not
    be read as saying*.

    One loop with the runs inside it, so no arm can be scored on a segment
    another arm was not — the shape
    :func:`~wattsteer_ml.evaluation.threshold_sweep.run_threshold_sweep` and
    :func:`~wattsteer_ml.evaluation.planning_arms.score_planning_arms` use for
    the same reason.
    """
    if not segments:
        raise DessemAbError(
            "no fold segment to score; the segments come from the shared calendar "
            "and an empty list is a caller mistake, not an empty table"
        )
    return DessemDeltaReport.of(
        (
            (segment, {run.name: score(run, segment) for run in AB_RUNS})
            for segment in segments
        ),
        calendar=calendar,
        provenance=provenance,
    )


#: The sentence on every block this module writes, the unmeasured one included.
_DECIDES_NOTHING = (
    "This block is evidence and not a decision. It holds no promotion, appends "
    "nothing to promotions.jsonl and is read by neither the hot-swap gate nor "
    "serving nor the optimizer. The spec's ruling has two conjuncts and only "
    "one of them is measurable here: the floor advantage under the gate's "
    "paired block bootstrap. The other — that the product accepts a D-1 19:00 "
    "BRT publication for the DESSEM-conditioned view — is a human's, and there "
    "is no field for it. Below the bar the dessem_* features stay a monitored "
    "candidate and this comparison is re-run each quarter."
)

#: What ``reads`` says when the arms came from three real fold evaluations.
_READS = (
    "recovered_floor_mwh is the optimizer simulator's P10-simulated recovery of "
    "one plan per complete subsystem-day, built on the shipped planning basis "
    "against the published REFERENCE_FLEET stamped above, summed over the "
    "segment. The three arms are scored on identical test rows of one shared "
    "calendar — asserted by digest per fold and pairwise against the labels, "
    "never by count — and differ only in the training window and the feature "
    "set. Read the two contrasts together: history_price is how much of the "
    "answer is the window rather than DESSEM."
)

#: And when they did not. Blunt, and in the field a reader reaches first.
_NOT_A_READING = CaveatedFigure(
    "THESE FLOORS ARE NOT A MEASUREMENT OF THE GRID. The hours the three arms "
    "were scored over were fabricated, so every MWh here is a solver's "
    "arithmetic over invented curtailment. Only a block whose dessem_source is "
    f"{FOLD_EVALUATION_SOURCE!r} says anything about what an evening "
    "publication would buy, and no DESSEM decision may be taken on this one.",
    figure=(
        "recovered_floor_mwh for all three DESSEM A/B arms, and the two "
        "contrasts between them"
    ),
    misreading=(
        "that an evening DESSEM-conditioned publication would buy the "
        "reference fleet this much floor"
    ),
    surface="the model card's `dessem_delta` block, `reads`",
)

#: The caveat that keeps the headline figure from being read as model quality.
_MIXTURE_CAVEAT = CaveatedFigure(
    "The floor is the P10 envelope, and Q_Y(q) = 0 for every q <= 1 - p. So the "
    "composed P10 is zero exactly where 0.10 <= 1 - p — wherever p <= 0.90 — "
    "and an arm whose classifier is more confident recovers floor in hours "
    "where a less confident one is structurally blind, with no change in the "
    "magnitude head at all. Every arm therefore publishes "
    "mixture_regime.share_p10_forced_zero beside its floor, computed from p "
    "through the composition's own comparison rather than from the prose's "
    "p <= 0.90, because the two are the same statement in real arithmetic and "
    "not in floating point. A delta read without it is a delta read as though "
    "it were all magnitude.",
    figure="the floor advantage between two DESSEM A/B arms, in MWh",
    misreading="that the arm with the larger floor has the better magnitude head",
    surface=(
        "the model card's `dessem_delta` block, `mixture_caveat`, beside "
        "every arm's `mixture_regime.share_p10_forced_zero`"
    ),
)

#: The sample size, stated rather than footnoted — the spec is explicit that
#: this is the single largest reason the answer might be wrong.
_SAMPLE_SIZE = (
    "The verdict rests on the decision-grade folds only, which is two test "
    "quarters and roughly 150 target days, and that is the honest sample size. "
    "It is stated here rather than footnoted because it is the single largest "
    "reason the answer might be wrong, and because nothing can be done about "
    "it: dessem_augmented_v1's history begins 2025-05-23 and a run is "
    "decision-grade in a fold only once its base fit reaches min_base_fit_days. "
    "target_days is printed on every verdict for the same reason."
)

#: The other side of the trade, which this module cannot price and does not try.
_OPERATOR_NOTICE = (
    "The cost side of this trade is operator notice, and it is not in MWh. It "
    "is the interval between the two gates — gate_at fixes gate_early at D-1 "
    "09:00 BRT and gate_late at D-1 19:00 BRT — and nothing here converts hours "
    "into floor. That is why the comparison is priced in MWh of promised floor "
    "rather than in pinball loss: a human can weigh MWh of recovered floor "
    "against hours of notice, and the structural_withholding census above says "
    "exactly what the morning view gives up. Note that the recommendation is to "
    "serve both artifacts, in which case the notice is not spent at all and "
    "this is a question about the evening view alone."
)

#: When no fold could carry a verdict.
_NO_DECIDING_FOLD = (
    "No reported fold is decision-grade for all three runs, so no verdict was "
    "taken. This is not a floor advantage of zero: the folds here are reported "
    "because a fold whose base fit is short of min_base_fit_days is still "
    "evidence, and it is excluded from the verdict rather than from the block."
)

#: And when there were no arms at all.
_NOTHING_YET = (
    "The A/B has not been run. This is not a floor advantage of zero and not a "
    "tie between the arms: the three runs have not been scored, so the "
    "comparison is unmade rather than made and found uninteresting."
)


__all__ = [
    "AB_GATE_PROFILE",
    "AB_LANES",
    "AB_RUNS",
    "AB_RUN_NAMES",
    "CADENCE",
    "COMMON_CONTROL_RUN",
    "CONTRASTS",
    "CONTRAST_BY_NAME",
    "DESSEM_CONTRAST",
    "DESSEM_DELTA_BLOCK_KEY",
    "DESSEM_RUN",
    "FULL_HISTORY_RUN",
    "HISTORY_CONTRAST",
    "NOT_RUN_YET",
    "AbArms",
    "Contrast",
    "ContrastName",
    "DayTotal",
    "DessemAbError",
    "DessemDeltaReport",
    "DessemProvenance",
    "DessemScorer",
    "FloorBootstrap",
    "RunFloor",
    "SegmentRow",
    "ShipVerdict",
    "UnmeasuredDessemDelta",
    "carry_forward",
    "record_dessem_delta",
    "run_dessem_ab",
    "structurally_withheld",
    "unmeasured_until_run",
]
