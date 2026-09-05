"""The 1 / 5 / 10 MW threshold sweep — published rather than acted on.

`docs/specs/forecaster.md`, "The threshold sweep":

    The feature function takes ``threshold_mw`` as an argument, so the sweep
    costs three fold-sweeps and no rebuild. It is run once, on
    ``dessem_free_v1`` at ``gate_late``, at **1 / 5 / 10 MW**, and reports per
    threshold: ``prevalence``, positives per local hour, ``pr_auc``,
    ``qloss_mwh``, ``coverage_p10`` and the optimizer-facing
    ``share_p50_zero``. … **5 MW remains the default and only moves by an
    explicit decision.**

**This module produces evidence and cannot act on it.** That is the whole
design, and it is enforced in three ways rather than asserted in prose:

- There is no field, property or card key here that names a threshold as
  preferred. :class:`ThresholdSweepReport` has rows and no ordering; the only
  threshold it privileges is :data:`DEFAULT_THRESHOLD_MW`, which is
  :data:`~wattsteer_ml.constants.SUBSYSTEM_THRESHOLD_MW` imported rather than
  respelt, so the default moves by editing the published constant and not by
  anything a sweep computes.
- There is **no path from here to the promotion log.** Nothing in this file
  imports :func:`wattsteer_ml.promotions.append` or
  :func:`~wattsteer_ml.evaluation.gate.record_decision`; the one thing it writes
  is a card block. :func:`assert_no_sweep_lane_promoted` is the invariant in the
  other direction, runnable against a real volume: a lane that exists only
  because of the sweep may accumulate refusals, and may not accumulate a
  ``promote``.
- The 1 MW and 10 MW lanes are lanes in their own right and are absent from
  :data:`~wattsteer_ml.evaluation.serving_lanes.SERVING_LANES`, which is
  imported here rather than restated so the two lists cannot drift apart.

## Two of the six figures are artifacts of the mixture, and the block says so

This is the part a sweep gets wrong by default. Because ``Q_Y(q) = 0`` for every
``q ≤ 1 − p``, the composed P50 is zero exactly where ``0.50 ≤ 1 − p`` and the
composed P10 exactly where ``0.10 ≤ 1 − p``. Lowering the threshold raises the
prevalence, which raises ``p``, which moves hours across that breakpoint — and
``share_p50_zero`` falls **with no change in model quality whatsoever**. A sweep
that published the three shares side by side, under a heading about thresholds,
would be reporting the mixture's inversion as a finding about 1 MW.

So :class:`MixtureRegime` recomputes the breakpoint from ``p``, using the
composition's own comparison ``q ≤ 1 − p`` and the served quantiles, and
:meth:`SweepFigures.of` **refuses** when the restatement and
:class:`~wattsteer_ml.evaluation.collapse.CollapseBlock`'s band-derived share
disagree. :mod:`~wattsteer_ml.evaluation.collapse` warns against holding a
second opinion about where the composition puts its breakpoint; this module
holds one deliberately and checks it against the first, because an identity that
is verified is the clearest possible way to say "this figure is not what it
looks like".

``coverage_p10`` carries the same hazard from the other side: it is measured
over **curtailed hours**, and which hours those are is precisely what the
threshold changes. Three coverage figures over three different populations are
not a trend, so :attr:`MixtureRegime.curtailed_hours` — the denominator — is
published beside it, and :data:`COMPARABILITY` says in one line, per figure,
whether it survives a change of threshold at all.

``qloss_mwh`` is the one figure that does. Its target is the observed MWh, which
does not move with ``τ``; the band moves, and that is what is being measured.

**Not answered here.** The sweep publishes ``coverage_p10`` and not
``coverage_p90``, and no figure about how much of ``δ_hi`` reaches the composed
P90. That question is
:class:`~wattsteer_ml.training.conformal.CoverageReport`'s and is open; a sweep
arm's version of it would be three readings of an unresolved thing.

## What the shapes here make unrepresentable

- **A sweep that is not a comparison.** :func:`sweep_rows` builds one
  :class:`~wattsteer_ml.evaluation.matrix.ScoredFold` per arm and runs
  :func:`~wattsteer_ml.evaluation.matrix.assert_identical_test_rows` over them,
  so three arms scored on different rows are refused by digest rather than
  passed by count. The threshold enters ``feature_rows(...)`` as a label
  boundary and a stamp — the spine is a cross join that never reads it — so
  identical rows is a property of the construction, and this is what keeps it
  one.
- **An arm at the wrong threshold.** Every hour carries its own
  ``threshold_mw`` through
  :attr:`~wattsteer_ml.mixture.ComposedForecast.threshold_mw`, and
  :meth:`SweepFigures.of` refuses a set holding two of them or one that
  disagrees with the arm it was filed under.
- **A partial sweep.** :func:`sweep_rows` requires exactly
  :data:`SWEPT_THRESHOLDS`. Two arms are not the evidence the spec asks for, and
  a sweep with 5 MW missing would be a comparison of the alternatives to a
  default nobody measured.
- **A figure that has lost its vintage.** Rows carry a
  :class:`~wattsteer_ml.evaluation.vintage.FoldSegment` and
  :func:`~wattsteer_ml.evaluation.vintage.assert_no_averaged_rows` runs on
  construction, for the reason
  :mod:`~wattsteer_ml.evaluation.metrics` states.
- **A fixture read as evidence.** :class:`SweepProvenance` is constructible only
  through :meth:`SweepProvenance.measured` or :meth:`SweepProvenance.fixture`,
  the fourth block in this package to take
  :class:`~wattsteer_ml.evaluation.collapse_report.CollapseProvenance`'s
  discipline. A prevalence of 0.11 computed over invented labels is a plausible
  decimal that reads exactly like the Brazilian grid's base rate.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_THRESHOLD_MW
from wattsteer_ml.evaluation.collapse import CollapseBlock
from wattsteer_ml.evaluation.collapse_report import FIXTURE_SOURCE, UNMEASURED_SOURCE
from wattsteer_ml.evaluation.matrix import (
    HOURS_PER_DAY,
    ScoredFold,
    assert_identical_test_rows,
    row_set_digest,
)
from wattsteer_ml.evaluation.metrics import pr_auc, prevalence, qloss_mwh
from wattsteer_ml.evaluation.serving_lanes import SERVED_FEATURE_SET, SERVING_LANES
from wattsteer_ml.evaluation.vintage import FoldSegment, assert_no_averaged_rows
from wattsteer_ml.lanes import Lane
from wattsteer_ml.mixture import SERVED_QUANTILES
from wattsteer_ml.promotions import PromotionLog
from wattsteer_ml.training.bundle import read_card, write_card
from wattsteer_ml.training.conformal import CoverageReport, ScoredHour

#: The card block, under the name `docs/specs/forecaster.md`'s Experiments group
#: gives it. A reader of the card finds it without knowing what a fold segment
#: or an arm is.
THRESHOLD_SWEEP_BLOCK_KEY = "threshold_sweep"

#: The default, and the only threshold that is ever promoted for serving.
#: `docs/domain-model.md` §8.3's committed value, imported from
#: :mod:`wattsteer_ml.constants` rather than respelt: if the default moves it
#: moves there, by the explicit decision the spec requires, and this module
#: follows it rather than being a second place it could be set.
DEFAULT_THRESHOLD_MW: float = float(SUBSYSTEM_THRESHOLD_MW)

#: The three arms, in MW. 1 MW is inside the rounding noise of a subsystem sum
#: and 10 MW discards dispatchable events (`docs/specs/forecaster.md`); both are
#: swept so the reasoning has numbers under it, and neither is served.
SWEPT_THRESHOLDS: tuple[float, ...] = (1.0, DEFAULT_THRESHOLD_MW, 10.0)

#: The sweep runs on the free feature set at the late gate — the spec's profile,
#: and the served lane's, so the 5 MW arm *is* the evening view rather than a
#: measurement beside it.
SWEEP_FEATURE_SET = SERVED_FEATURE_SET
SWEEP_GATE_PROFILE = "gate_late"

#: The prevalence below which the classifier has too little positive class to
#: learn a usable ranking and the risk classes collapse into one.
PREVALENCE_FLOOR = 0.03

#: And the prevalence above which the threshold has stopped selecting anything
#: and ``has_curtailment`` no longer names an event.
PREVALENCE_CEILING = 0.40

#: Which of the two move-forcing conditions a threshold's prevalence meets.
MoveCondition = Literal["below_floor", "above_ceiling"]

#: The hours behind a sweep arm came out of a fold evaluation — a real trained
#: run over real rows. The sweep's arms cannot come from
#: ``canonical_forecast_hour`` the way
#: :mod:`~wattsteer_ml.evaluation.collapse_report`'s do: only the served lane
#: persists bands, and two of the three arms are lanes nothing serves.
FOLD_EVALUATION_SOURCE = "fold_evaluation"

#: Per figure, in one line: whether it survives a change of threshold. Published
#: in the block, because three numbers under one heading are read as a trend by
#: anybody who is not holding the mixture in their head.
COMPARABILITY: dict[str, str] = {
    "prevalence": (
        "definitional — the prevalence is what the threshold sets, and it is the "
        "quantity the two move-forcing conditions are evaluated against. It is "
        "not a measurement of the model."
    ),
    "positives_per_local_hour": (
        "definitional, and the reason the pooled prevalence is not the whole "
        "answer: a positive class concentrated in the solar hours is denser "
        "where a classifier has to rank than the pooled figure suggests."
    ),
    "pr_auc": (
        "not comparable across thresholds without its floor. PR-AUC's baseline "
        "is the prevalence, and the prevalence is exactly what the sweep moves; "
        "each arm's own prevalence is published beside it and the two are read "
        "together or not at all."
    ),
    "qloss_mwh": (
        "comparable. Its target is the observed MWh, which does not move with "
        "the threshold — only the composed band does, which is the thing being "
        "measured. It is the one figure here that may be read across the arms "
        "as a difference in quality."
    ),
    "coverage_p10": (
        "not comparable across thresholds. It is measured over curtailed hours, "
        "and which hours those are is precisely what the threshold changes, so "
        "three arms are three populations. curtailed_hours is the denominator "
        "and travels with it."
    ),
    "share_p50_zero": (
        "not comparable across thresholds, and not a model-quality figure at "
        "all. Q_Y(q) = 0 for q <= 1 - p, so it is share_p50_forced_zero "
        "restated: lowering the threshold raises p, which moves hours across "
        "the mixture's breakpoint and lowers this share with no change in the "
        "model. The identity is checked, not asserted."
    ),
}


#: One fold segment's three arms, keyed by the threshold each was scored at.
SweepArms = Mapping[float, Sequence[ScoredHour]]


class ThresholdSweepError(ValueError):
    """The arms cannot support the sweep that was asked for.

    Also raised by :func:`assert_no_sweep_lane_promoted`, which is the same
    statement about a volume rather than about a set of hours: a sweep arm that
    has been promoted is a sweep that was acted on.
    """


def sweep_lane(threshold_mw: float) -> Lane:
    """The lane one arm of the sweep writes into.

    The artifact's identity is the triple (feature set, gate profile,
    threshold), so each arm has a directory of its own and "newest" between two
    arms means nothing. The 5 MW lane produced here is the served evening lane,
    by construction rather than by coincidence — the feature set and the gate
    profile come from :mod:`~wattsteer_ml.evaluation.serving_lanes`.
    """
    return Lane(
        feature_set=SWEEP_FEATURE_SET,
        gate_profile=SWEEP_GATE_PROFILE,
        threshold_mw=threshold_mw,
    )


#: The three lanes, in :data:`SWEPT_THRESHOLDS`' order. Exactly one of them is a
#: serving lane, and :func:`assert_no_sweep_lane_promoted` is what keeps that
#: true on a volume rather than only in this tuple.
SWEEP_LANES: tuple[Lane, ...] = tuple(
    sweep_lane(threshold) for threshold in SWEPT_THRESHOLDS
)


def assert_no_sweep_lane_promoted(log: PromotionLog) -> None:
    """No arm that exists only for the sweep has ever been promoted.

    The structural half of "only the 5 MW lane is promoted for serving", checked
    against the append-only log rather than against a convention. A sweep arm
    may hold ``refuse`` lines — a refused candidate is evidence and the log is
    where evidence goes — and a ``promote`` line in one means an artifact
    trained at 1 MW or 10 MW is what
    :func:`wattsteer_ml.artifacts.current` would resolve for that lane. Nothing
    reads those lanes today; this is what makes that a property rather than an
    accident of which lanes :data:`SERVING_LANES` happens to list.
    """
    for lane in SWEEP_LANES:
        if lane in SERVING_LANES:
            continue
        promoted = log.promoted(lane)
        if promoted is not None:
            raise ThresholdSweepError(
                f"{lane} holds a promote line naming {promoted}. It is a sweep "
                f"arm and not a served lane: only the {DEFAULT_THRESHOLD_MW} MW "
                "lane is promoted for serving, and the sweep is published rather "
                "than acted on. Rolling this back is an append, not a delete."
            )


@dataclass(frozen=True)
class PositivesByLocalHour:
    """The positive class's diurnal profile — twenty-four counts and their rows.

    The spec asks for "positives per local hour" and this is why: a positive
    class that is 11% of the day but 40% of the solar hours is a very different
    ranking problem from one spread flat, and the pooled prevalence the
    move-forcing conditions read cannot see the difference. The denominators
    travel because a count without them is not a rate.
    """

    counts: tuple[int, ...]
    rows: tuple[int, ...]

    def __post_init__(self) -> None:
        if len(self.counts) != HOURS_PER_DAY or len(self.rows) != HOURS_PER_DAY:
            raise ThresholdSweepError(
                f"a local-hour profile has {HOURS_PER_DAY} entries; this one has "
                f"{len(self.counts)} counts over {len(self.rows)} denominators"
            )

    @property
    def shares(self) -> tuple[float | None, ...]:
        """Prevalence within each local hour. ``None`` where nothing was scored."""
        return tuple(
            None if denominator == 0 else count / denominator
            for count, denominator in zip(self.counts, self.rows, strict=True)
        )

    @property
    def local_hours_with_no_positive(self) -> int:
        """Hours of the day the classifier has never seen a positive in."""
        return sum(1 for count in self.counts if count == 0)

    @classmethod
    def of(cls, hours: Sequence[ScoredHour]) -> PositivesByLocalHour:
        counts = [0] * HOURS_PER_DAY
        rows = [0] * HOURS_PER_DAY
        for hour in hours:
            rows[hour.key.local_hour] += 1
            if hour.is_positive:
                counts[hour.key.local_hour] += 1
        return cls(counts=tuple(counts), rows=tuple(rows))

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "counts": list(self.counts),
            "rows": list(self.rows),
            "shares": list(self.shares),
            "local_hours_with_no_positive": self.local_hours_with_no_positive,
        }


@dataclass(frozen=True)
class MixtureRegime:
    """Where the composition's breakpoint sits, so two figures become readable.

    Computed from ``p``, using the comparison
    :meth:`~wattsteer_ml.mixture.HurdleMixture.quantile` itself makes —
    ``q <= 1 - p`` against the served quantiles — and not from the prose's
    ``p <= 0.50``. The two are the same statement in real arithmetic and not in
    floating point, and a restatement that is meant to be checked against the
    band has to be the band's own arithmetic or the check means nothing.
    """

    hours: int
    #: Hours the composition forces to a zero P50, as a share. The identity
    #: ``share_p50_zero`` is: not a property of the model.
    share_p50_forced_zero: float
    #: The same at ``q = 0.10``. Necessarily at least as large — a lower
    #: quantile is forced to zero on a superset of the hours.
    share_p10_forced_zero: float
    #: ``coverage_p10``'s denominator: the curtailed hours of this arm. Moves
    #: with the threshold by definition, which is what makes three coverages
    #: three populations.
    curtailed_hours: int

    @classmethod
    def of(cls, hours: Sequence[ScoredHour]) -> MixtureRegime:
        lower, median, _ = SERVED_QUANTILES
        forced_p50 = sum(
            1 for hour in hours if median <= 1.0 - hour.forecast.occurrence_probability
        )
        forced_p10 = sum(
            1 for hour in hours if lower <= 1.0 - hour.forecast.occurrence_probability
        )
        return cls(
            hours=len(hours),
            share_p50_forced_zero=forced_p50 / len(hours),
            share_p10_forced_zero=forced_p10 / len(hours),
            curtailed_hours=sum(1 for hour in hours if hour.is_positive),
        )

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "hours": self.hours,
            "share_p50_forced_zero": self.share_p50_forced_zero,
            "share_p10_forced_zero": self.share_p10_forced_zero,
            "curtailed_hours": self.curtailed_hours,
        }


@dataclass(frozen=True)
class PrevalenceVerdict:
    """The two move-forcing conditions, evaluated rather than left to a reader.

    `docs/specs/forecaster.md` names both and their constants, and the whole
    point of the block is that a person reading the card is not handed a
    prevalence and a paragraph and asked to do the comparison themselves. Both
    conditions are reported whether or not they fire, because "0.11 is not below
    0.03" is a finding and an absent key is not.

    :attr:`forces_a_move` is a statement about the evidence and not a decision:
    the spec's sentence is that 5 MW "only moves by an explicit decision", so a
    ``True`` here is what makes that decision *due*, and there is nothing in this
    module that could take it.
    """

    threshold_mw: float
    prevalence: float
    floor: float = PREVALENCE_FLOOR
    ceiling: float = PREVALENCE_CEILING

    def __post_init__(self) -> None:
        if not 0.0 <= self.prevalence <= 1.0:
            raise ThresholdSweepError(
                f"{self.prevalence!r} is not a prevalence; a verdict on one that "
                "is out of range is a fault to stop on"
            )

    @property
    def below_floor(self) -> bool:
        return self.prevalence < self.floor

    @property
    def above_ceiling(self) -> bool:
        return self.prevalence > self.ceiling

    @property
    def condition(self) -> MoveCondition | None:
        if self.below_floor:
            return "below_floor"
        if self.above_ceiling:
            return "above_ceiling"
        return None

    @property
    def forces_a_move(self) -> bool:
        return self.condition is not None

    @property
    def statement(self) -> str:
        """The verdict as a sentence, in the spec's own terms."""
        if self.below_floor:
            return (
                f"MET: prevalence {self.prevalence:.4f} is below {self.floor}, so "
                "the positive class is too rare for the classifier to learn a "
                "usable ranking and the risk classes collapse into one. This "
                "forces an explicit decision about the threshold."
            )
        if self.above_ceiling:
            return (
                f"MET: prevalence {self.prevalence:.4f} is above {self.ceiling}, so "
                "the threshold has stopped selecting anything and has_curtailment "
                "no longer names an event. This forces an explicit decision about "
                "the threshold."
            )
        return (
            f"NOT MET: prevalence {self.prevalence:.4f} sits inside "
            f"[{self.floor}, {self.ceiling}], so neither move-forcing condition "
            f"holds and {DEFAULT_THRESHOLD_MW} MW stands on the domain model's "
            "reasoning."
        )

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "prevalence": self.prevalence,
            "below_floor": {"threshold": self.floor, "met": self.below_floor},
            "above_ceiling": {"threshold": self.ceiling, "met": self.above_ceiling},
            "forces_a_move": self.forces_a_move,
            "statement": self.statement,
        }


@dataclass(frozen=True)
class SweepFigures:
    """The six figures the spec names, for one arm over one fold segment.

    Every one of them is read off an existing definition —
    :mod:`~wattsteer_ml.evaluation.metrics`,
    :class:`~wattsteer_ml.training.conformal.CoverageReport`,
    :class:`~wattsteer_ml.evaluation.collapse.CollapseBlock` — so a sweep number
    and a metrics-table number of the same name are the same arithmetic. The
    only counting this class does of its own is
    :class:`PositivesByLocalHour`, which nothing else publishes.

    ``pr_auc``, ``coverage_p10`` and ``share_p50_zero`` are ``None`` when the
    arm gave them nothing to measure, never a zero: a PR-AUC over one class is
    no score, a coverage over no curtailed hour is no measurement, and a
    collapse share with no complete subsystem-day is absent rather than nil.
    The 1 MW and 10 MW arms are exactly where those cases become likely, which
    is why they are typed rather than defaulted.
    """

    threshold_mw: float
    rows: int
    prevalence: float
    positives: int
    positives_by_local_hour: PositivesByLocalHour
    pr_auc: float | None
    qloss_mwh: float
    coverage_p10: float | None
    share_p50_zero: float | None
    regime: MixtureRegime

    @property
    def is_default(self) -> bool:
        return self.threshold_mw == DEFAULT_THRESHOLD_MW

    @property
    def verdict(self) -> PrevalenceVerdict:
        return PrevalenceVerdict(
            threshold_mw=self.threshold_mw, prevalence=self.prevalence
        )

    @classmethod
    def of(cls, hours: Sequence[ScoredHour], *, threshold_mw: float) -> SweepFigures:
        """Compute one arm's figures, and check the mixture identity.

        The refusal at the end is the module's own honesty check. If the share
        of hours whose composed P50 is zero ever disagrees with the share the
        composition's breakpoint forces to zero, then either a band was built by
        something other than :func:`~wattsteer_ml.mixture.compose` or the
        restatement here is wrong — and in both cases the block's central
        caveat, that ``share_p50_zero`` is the breakpoint under another name,
        has stopped being true.
        """
        if not hours:
            raise ThresholdSweepError(
                f"{threshold_mw} MW: no settled hour was scored; an arm with none "
                "is reported as absent, not as a row of zeros"
            )
        stamped = {hour.forecast.threshold_mw for hour in hours}
        if stamped != {threshold_mw}:
            raise ThresholdSweepError(
                f"an arm filed at {threshold_mw} MW is composed of hours stamped "
                f"{sorted(stamped)!r}; a magnitude carries the threshold that "
                "produced it, and an arm assembled from two of them is not an arm"
            )
        positives = [hour for hour in hours if hour.is_positive]
        collapse = CollapseBlock.of(hours)
        regime = MixtureRegime.of(hours)
        share_p50_zero = (
            None if collapse is None else collapse.pooled.share_of_hours_with_p50_zero
        )
        if share_p50_zero is not None and share_p50_zero != regime.share_p50_forced_zero:
            raise ThresholdSweepError(
                f"{threshold_mw} MW: share_p50_zero is {share_p50_zero!r} and the "
                f"mixture forces {regime.share_p50_forced_zero!r} of these hours "
                "to a zero P50. Those are the same quantity — Q_Y(q) = 0 for "
                "q <= 1 - p — and this block publishes the second so a reader "
                "cannot take the first for a statement about the model. If they "
                "disagree, one of the two is not the composition."
            )
        return cls(
            threshold_mw=threshold_mw,
            rows=len(hours),
            prevalence=prevalence(hours),
            positives=len(positives),
            positives_by_local_hour=PositivesByLocalHour.of(hours),
            pr_auc=pr_auc(hours),
            qloss_mwh=qloss_mwh(hours),
            coverage_p10=(
                None
                if not positives
                else CoverageReport.of(hours, fold_id=f"thr{threshold_mw}").coverage_p10
            ),
            share_p50_zero=share_p50_zero,
            regime=regime,
        )

    def as_card_entry(self) -> dict[str, Any]:
        """The six figures, the regime that explains two of them, the verdict."""
        return {
            "threshold_mw": self.threshold_mw,
            "lane": sweep_lane(self.threshold_mw).directory_name,
            "is_default": self.is_default,
            "rows": self.rows,
            "prevalence": self.prevalence,
            "positives": self.positives,
            "positives_per_local_hour": self.positives_by_local_hour.as_card_entry(),
            "pr_auc": self.pr_auc,
            "qloss_mwh": self.qloss_mwh,
            "coverage_p10": self.coverage_p10,
            "share_p50_zero": self.share_p50_zero,
            "mixture_regime": self.regime.as_card_entry(),
            "prevalence_conditions": self.verdict.as_card_entry(),
        }


@dataclass(frozen=True)
class SweepRow:
    """One arm, one fold segment: the figures and the rows they were over."""

    segment: FoldSegment
    figures: SweepFigures
    #: The digest of the rows this arm was scored on, as a claim that can be
    #: checked against its two siblings. Never supplied by a caller.
    scored: ScoredFold

    def __post_init__(self) -> None:
        if self.scored.fold_id != self.segment.fold_id:
            raise ThresholdSweepError(
                f"a row filed under {self.segment.row_id} carries rows scored on "
                f"{self.scored.fold_id}"
            )

    @property
    def threshold_mw(self) -> float:
        return self.figures.threshold_mw


def sweep_rows(arms: SweepArms, *, segment: FoldSegment) -> tuple[SweepRow, ...]:
    """**The comparison.** Three arms over one fold segment, on identical rows.

    Args:
        arms: one sequence of scored hours per swept threshold. Exactly
            :data:`SWEPT_THRESHOLDS`, because two arms are not the evidence the
            spec asks for and a sweep missing 5 MW would compare the
            alternatives against a default nobody measured.
        segment: the fold segment all three were scored on.

    The row identity is asserted through
    :func:`~wattsteer_ml.evaluation.matrix.assert_identical_test_rows` — the
    same function the A/B matrix uses, over the same
    :class:`~wattsteer_ml.evaluation.matrix.ScoredFold`. Two arms with the same
    number of rows can hold different rows, and one missing hour and one extra
    day cancel in a count.

    The rows are **not** checked against
    :func:`~wattsteer_ml.evaluation.matrix.expected_test_rows`, and that is
    deliberate: an arm is scored on the segment's *settled* hours, and an
    unlabelled hour is ONS not having published rather than a row the threshold
    removed. Whether an hour is settled does not depend on ``τ``, so the three
    arms share a row set that is a subset of the calendar's, and the assertion
    that matters is that they share it.
    """
    missing = sorted(set(SWEPT_THRESHOLDS) - set(arms))
    extra = sorted(set(arms) - set(SWEPT_THRESHOLDS))
    if missing or extra:
        raise ThresholdSweepError(
            f"a sweep is exactly {list(SWEPT_THRESHOLDS)} MW; this one is missing "
            f"{missing} and adds {extra}. Three fold sweeps and no rebuild is the "
            "whole cost, so a partial one is a choice rather than a saving"
        )
    rows = tuple(
        SweepRow(
            segment=segment,
            figures=SweepFigures.of(arms[threshold], threshold_mw=threshold),
            scored=_scored_fold(threshold, arms[threshold], segment=segment),
        )
        for threshold in SWEPT_THRESHOLDS
    )
    assert_identical_test_rows([row.scored for row in rows])
    return rows


@dataclass(frozen=True)
class SweepProvenance:
    """What the sweep's figures are figures *of*. Never optional.

    The fourth block in this package to carry one, and for the reason the other
    three state: a prevalence, a PR-AUC and a coverage are computable from any
    set of hours, including the fabricated ones this repository's fixtures are
    full of, and 0.11 reads exactly like the Brazilian grid's base rate.
    """

    sweep_source: str
    at: datetime | None
    #: The lanes the three arms wrote into. Derived, so a stamp cannot name a
    #: lane set the sweep did not run.
    lanes: tuple[Lane, ...] = SWEEP_LANES

    @property
    def is_measurement(self) -> bool:
        return self.sweep_source == FOLD_EVALUATION_SOURCE

    @classmethod
    def measured(cls, *, at: datetime) -> SweepProvenance:
        """The stamp for arms scored by a real fold evaluation."""
        return cls(sweep_source=FOLD_EVALUATION_SOURCE, at=at)

    @classmethod
    def fixture(cls) -> SweepProvenance:
        """The stamp for arms built on fabricated hours. Named, never defaulted."""
        return cls(sweep_source=FIXTURE_SOURCE, at=None)

    def card_fields(self) -> dict[str, Any]:
        return {
            "measured": self.is_measurement,
            "sweep_source": self.sweep_source,
            "feature_set": SWEEP_FEATURE_SET,
            "gate_profile": SWEEP_GATE_PROFILE,
            "default_threshold_mw": DEFAULT_THRESHOLD_MW,
            "swept_thresholds_mw": list(SWEPT_THRESHOLDS),
            "lanes": [lane.directory_name for lane in self.lanes],
            "serving_lanes": [lane.directory_name for lane in SERVING_LANES],
            "at": None if self.at is None else self.at.isoformat(),
        }


@dataclass(frozen=True)
class ThresholdSweepReport:
    """Three arms per fold segment, published, with nothing that selects one.

    :meth:`card_block` is the whole published surface. There is no ordering
    here, no delta and no winner: the spec's sentence is that the sweep produces
    evidence and 5 MW moves only by an explicit decision, so a field that ranked
    the arms would be the decision arriving through the back door.
    """

    provenance: SweepProvenance
    rows: tuple[SweepRow, ...]

    def __post_init__(self) -> None:
        if not self.rows:
            raise ThresholdSweepError(
                "a sweep report with no fold; an absent sweep is "
                "UnmeasuredThresholdSweep, which carries a reason instead of no rows"
            )
        by_segment: dict[str, list[SweepRow]] = {}
        for row in self.rows:
            by_segment.setdefault(row.segment.row_id, []).append(row)
        segments: list[FoldSegment] = []
        for row_id, group in by_segment.items():
            thresholds = sorted(row.threshold_mw for row in group)
            if thresholds != sorted(SWEPT_THRESHOLDS):
                raise ThresholdSweepError(
                    f"{row_id} is reported at {thresholds} MW; a fold carries "
                    f"exactly the three arms {list(SWEPT_THRESHOLDS)} MW, and a "
                    "fold missing one is a fold whose comparison was not made"
                )
            assert_identical_test_rows([row.scored for row in group])
            segments.append(group[0].segment)
        assert_no_averaged_rows(segments)

    @classmethod
    def of(
        cls,
        arms_by_segment: Iterable[tuple[FoldSegment, SweepArms]],
        *,
        provenance: SweepProvenance,
    ) -> ThresholdSweepReport:
        return cls(
            provenance=provenance,
            rows=tuple(
                row
                for segment, arms in arms_by_segment
                for row in sweep_rows(arms, segment=segment)
            ),
        )

    @property
    def fidelities(self) -> tuple[VintageFidelity, ...]:
        seen: list[VintageFidelity] = []
        for row in self.rows:
            if row.segment.fidelity not in seen:
                seen.append(row.segment.fidelity)
        return tuple(seen)

    def card_block(self) -> dict[str, Any]:
        """The block, under :data:`THRESHOLD_SWEEP_BLOCK_KEY`.

        ``decides`` and ``reads`` are prose and always present, the discipline
        :mod:`~wattsteer_ml.evaluation.planning_arms` applies to the block beside
        this one: a reader who reaches the figures has already read what they do
        not license.
        """
        folds: dict[str, dict[str, Any]] = {}
        for row in self.rows:
            entry = folds.setdefault(
                row.segment.row_id,
                {
                    "row_id": row.segment.row_id,
                    "fold_id": row.segment.fold_id,
                    "vintage_fidelity": row.segment.fidelity,
                    "segment_hash": row.segment.segment_hash,
                    "test_start": row.segment.test_start.isoformat(),
                    "test_end": row.segment.test_end.isoformat(),
                    "row_digest": row.scored.row_digest,
                    "rows": row.scored.row_count,
                    "thresholds": {},
                },
            )
            entry["thresholds"][str(row.threshold_mw)] = row.figures.as_card_entry()
        block: dict[str, Any] = {
            **self.provenance.card_fields(),
            "decides": _DECIDES_NOTHING,
            "reads": _READS if self.provenance.is_measurement else _NOT_A_READING,
            "mixture_caveat": _MIXTURE_CAVEAT,
            "comparability": dict(COMPARABILITY),
            "vintage_fidelities": list(self.fidelities),
            "folds": list(folds.values()),
        }
        return {THRESHOLD_SWEEP_BLOCK_KEY: block}


@dataclass(frozen=True)
class UnmeasuredThresholdSweep:
    """No arms, and the sentence saying why — the shape of an absent sweep.

    A card with no sweep block and a card saying "this has not been swept" look
    identical to anybody grepping for the figure, and only one of them is true
    of a lane whose three arms have not been run. It has no field that could be
    mistaken for a prevalence.
    """

    at: datetime
    reason: str
    sweep_source: str = UNMEASURED_SOURCE

    @property
    def is_measurement(self) -> bool:
        return False

    def card_block(self) -> dict[str, Any]:
        return {
            THRESHOLD_SWEEP_BLOCK_KEY: {
                "measured": False,
                "sweep_source": self.sweep_source,
                "feature_set": SWEEP_FEATURE_SET,
                "gate_profile": SWEEP_GATE_PROFILE,
                "default_threshold_mw": DEFAULT_THRESHOLD_MW,
                "swept_thresholds_mw": list(SWEPT_THRESHOLDS),
                "lanes": [lane.directory_name for lane in SWEEP_LANES],
                "serving_lanes": [lane.directory_name for lane in SERVING_LANES],
                "at": self.at.isoformat(),
                "reason": self.reason,
                "decides": _DECIDES_NOTHING,
                "reads": _NOTHING_YET,
            }
        }


def record_threshold_sweep(
    report: ThresholdSweepReport | UnmeasuredThresholdSweep,
    *,
    root: Path,
    artifact_id: str,
    lane: Lane,
) -> Path:
    """Write the block onto one arm's card. **The only thing this module writes.**

    The whole sweep goes onto every arm's card rather than each arm carrying
    only its own row, because the comparison is the deliverable and a reader
    holding the served lane's card is the reader who needs it. ``lane`` must be
    one of :data:`SWEEP_LANES`: a sweep block on some other lane's card would be
    three figures about a threshold that lane was not trained at.

    Nothing here appends to ``promotions.jsonl``, and there is no argument that
    could make it. The block is evidence; the decision is a human's.
    """
    if lane not in SWEEP_LANES:
        raise ThresholdSweepError(
            f"{lane} is not one of the sweep's arms "
            f"{[one.directory_name for one in SWEEP_LANES]}; a sweep block on its "
            "card would describe thresholds it was never trained at"
        )
    path = root / lane.directory_name / f"{artifact_id}{CARD_SUFFIX}"
    card = read_card(path)
    write_card(path, {**card, **report.card_block()})
    return path


#: One arm's scoring call: the hours a fold segment produced at one threshold.
SweepScorer = Callable[[float, FoldSegment], Sequence[ScoredHour]]


def run_threshold_sweep(
    score: SweepScorer,
    *,
    segments: Sequence[FoldSegment],
    provenance: SweepProvenance,
) -> ThresholdSweepReport:
    """Score every arm on every segment, in one loop, and publish the result.

    ``score`` is the whole of one arm's fold run — train at this threshold,
    compose, return the segment's settled hours. It is a parameter rather than
    an import because that needs a database, a fold calendar and LightGBM, and
    none of those belong to the question this module answers, which is *what
    the three arms may and may not be read as saying*.

    One loop with the thresholds inside it, so no arm can be scored on a segment
    another arm was not — the same shape
    :func:`~wattsteer_ml.evaluation.planning_arms.score_planning_arms` uses for
    the same reason.
    """
    if not segments:
        raise ThresholdSweepError(
            "no fold segment to sweep; the segments come from the shared calendar "
            "and an empty list is a caller mistake, not an empty table"
        )
    return ThresholdSweepReport.of(
        (
            (
                segment,
                {threshold: score(threshold, segment) for threshold in SWEPT_THRESHOLDS},
            )
            for segment in segments
        ),
        provenance=provenance,
    )


def _scored_fold(
    threshold_mw: float, hours: Sequence[ScoredHour], *, segment: FoldSegment
) -> ScoredFold:
    """One arm's row-identity claim, computed here and never supplied.

    The run name is the arm's lane suffix, so a
    :class:`~wattsteer_ml.evaluation.matrix.RowIdentityError` names the arm a
    reader can go and look at rather than an index.
    """
    return ScoredFold(
        run=f"thr{_threshold_label(threshold_mw)}",
        fold_id=segment.fold_id,
        fold_hash=segment.fold_hash,
        row_digest=row_set_digest(hour.key for hour in hours),
        row_count=len(hours),
    )


def _threshold_label(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else repr(value)


#: The sentence the ticket requires on every block this module writes, the
#: unmeasured one included.
_DECIDES_NOTHING = (
    f"{DEFAULT_THRESHOLD_MW} MW is the default and moves only by an explicit "
    "decision. This block is evidence and not that decision: it holds no "
    "ordering, no delta and no preferred arm, and nothing in it is read by the "
    "hot-swap gate, by serving or by the optimizer. Each threshold writes its "
    "own artifact lane and only the default lane is promoted for serving — a "
    "promote line in either of the other two is refused by "
    "assert_no_sweep_lane_promoted."
)

#: What the block's ``reads`` field says when the arms came from a real run.
_READS = (
    "Three fold sweeps over identical folds and identical rows, differing only "
    "in the threshold passed to feature_rows(...). Row identity is asserted by "
    "digest per fold segment, never by count. Read the comparability field "
    "before reading any figure across the three arms: only qloss_mwh survives a "
    "change of threshold."
)

#: And what it says when they did not.
_NOT_A_READING = (
    "THESE FIGURES ARE NOT A MEASUREMENT OF THE GRID. The hours the three arms "
    "were scored over were fabricated, so every prevalence, PR-AUC and coverage "
    "here is arithmetic over invented labels. Only a block whose sweep_source is "
    f"{FOLD_EVALUATION_SOURCE!r} says anything about the Brazilian system, and "
    "no threshold decision may be taken on this one."
)

#: The caveat that keeps two of the six figures from being read as findings.
_MIXTURE_CAVEAT = (
    "Two of the six figures move with the threshold for reasons that have "
    "nothing to do with model quality. Q_Y(q) = 0 for every q <= 1 - p, so the "
    "composed P50 is zero exactly where 0.50 <= 1 - p and the composed P10 "
    "exactly where 0.10 <= 1 - p. Lowering the threshold raises the prevalence, "
    "which raises p, which moves hours across that breakpoint: share_p50_zero "
    "falls with no change in the model, and it is published beside "
    "mixture_regime.share_p50_forced_zero, which is the same quantity computed "
    "from p. The two are checked to be equal. coverage_p10 carries the hazard "
    "from the other side — it is measured over curtailed hours, and which hours "
    "those are is what the threshold changes, so its denominator "
    "(mixture_regime.curtailed_hours) travels with it."
)

#: And when there were no arms at all.
_NOTHING_YET = (
    "The sweep has not been run. This is not a prevalence of zero and not a "
    "finding that the thresholds are indistinguishable: the three arms do not "
    "exist yet, so the comparison is unmade rather than made and found "
    "uninteresting."
)


__all__ = [
    "COMPARABILITY",
    "DEFAULT_THRESHOLD_MW",
    "FOLD_EVALUATION_SOURCE",
    "PREVALENCE_CEILING",
    "PREVALENCE_FLOOR",
    "SWEEP_FEATURE_SET",
    "SWEEP_GATE_PROFILE",
    "SWEEP_LANES",
    "SWEPT_THRESHOLDS",
    "THRESHOLD_SWEEP_BLOCK_KEY",
    "MixtureRegime",
    "MoveCondition",
    "PositivesByLocalHour",
    "PrevalenceVerdict",
    "SweepArms",
    "SweepFigures",
    "SweepProvenance",
    "SweepRow",
    "SweepScorer",
    "ThresholdSweepError",
    "ThresholdSweepReport",
    "UnmeasuredThresholdSweep",
    "assert_no_sweep_lane_promoted",
    "record_threshold_sweep",
    "run_threshold_sweep",
    "sweep_lane",
    "sweep_rows",
]
