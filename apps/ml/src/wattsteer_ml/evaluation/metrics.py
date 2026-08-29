"""One populated metrics row per rung, per run and per fold segment.

`docs/specs/forecaster.md`, "The metric the gate uses" and "The full metrics
table". This module is the table, and :data:`MetricsRow.qloss_mwh` is the one
number the hot-swap gate reads.

**Why `qloss_mwh` and not any of the others.** It scores the *composed*
prediction, so a candidate that improves the classifier while degrading the
magnitude model cannot pass it — PR-AUC and Brier stage one alone, MAE-on-
positives stages two alone, and either would wave that candidate through. It is
a proper scoring rule for the thing shipped, so it cannot be gamed by widening
or narrowing the band. It is denominated in MWh. And it needs no operating
point, which is exactly the degree of freedom a gate must not have: ``recall``
is trivially maximised by a model that predicts curtailment always, so it stays
in the table with a guardrail and is never the gate.

**Everything here is computed from :class:`ScoredHour`, and from nothing else.**
One composed band, one label, one key. The same unit
:mod:`wattsteer_ml.training.conformal` ranks its residuals over, so the
coverage in a row and the ``δ`` behind it are measurements of the same hours
rather than of two populations that happen to share a name. No metric in this
file reads a model, a feature vector or a database.

**What the shapes here make unrepresentable:**

- **A number that has lost its vintage.** :class:`MetricsRow` carries a
  :class:`~wattsteer_ml.evaluation.vintage.FoldSegment`, not a fold id, so every
  metric in the table names the vintage of the rows it was computed over. There
  is no constructor that takes a bare string.
- **An average across vintages.** :class:`MetricsTable` runs
  :func:`~wattsteer_ml.evaluation.vintage.assert_no_averaged_rows` on the
  segments it holds, and :meth:`MetricsTable.pooled_qloss` reduces through
  :func:`~wattsteer_ml.evaluation.vintage.pooled_fidelity`, which raises on a
  mixed pool rather than picking a label. A `revision_optimistic` quarter and a
  `point_in_time` one cannot be averaged into one `qloss_mwh` by any operation
  offered here.
- **A ladder comparison across folds.** :meth:`MetricsTable.delta_against`
  compares rungs within one segment and refuses to subtract two rows whose
  segment hashes differ. Two rungs scored on different rows are not a delta.
- **A revision premium assembled out of two different things.**
  :meth:`RevisionPremium.of` refuses unless the two rows agree on run, rung and
  fold and disagree on nothing but the vintage they were scored against.

**Populations, stated once, because three of these figures have more than one
defensible denominator.**

- ``qloss_mwh``, its three components, ``brier``, ``pr_auc``, ``prevalence``,
  the two operating points, ``interval_width_mean_mwh`` and ``crossing_rate``
  are over **every settled hour** of the segment.
- ``mae_positives_mwh`` and ``smape_positives`` are over **curtailed hours**,
  and they score ``Ê[Y | Y > τ, x]`` — the conditional-mean estimator itself,
  not the composed expectation, because "magnitude, conditional" is a statement
  about stage two.
- ``coverage_p10``, ``coverage_p90`` and ``p50_unbiasedness`` are over
  **curtailed hours**, which is
  :class:`~wattsteer_ml.training.conformal.CoverageReport`'s decision and not a
  second one made here: over every hour the lower statement is trivially true,
  because the composed P10 is zero wherever ``p ≤ 0.90``.
- ``ece``, ``mce`` and ``top_bin_gap`` come from
  :class:`~wattsteer_ml.training.calibration.ReliabilityCurve` binned over the
  segment's own out-of-fold hours, so the merge rule that produces them is the
  one the model card publishes and not a reimplementation.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation.collapse import CollapseBlock
from wattsteer_ml.evaluation.vintage import (
    FoldSegment,
    MixedFidelityError,
    assert_no_averaged_rows,
    pooled_fidelity,
)
from wattsteer_ml.mixture import SERVED_QUANTILES, crossing_rate
from wattsteer_ml.training.calibration import (
    CalibrationError,
    OutOfFoldPool,
    OutOfFoldPrediction,
    ReliabilityCurve,
)
from wattsteer_ml.training.conformal import (
    ConformalCorrection,
    CoverageReport,
    ScoredHour,
)
from wattsteer_ml.training.ensemble import DayGrainCoverage

#: The operating point the table's F1, precision and recall are fixed at. Fixed,
#: and stated on the row, because a threshold chosen per candidate is a threshold
#: chosen to make the gate pass.
FIXED_OPERATING_POINT = 0.50


class MetricsError(ValueError):
    """The scored hours cannot support the row that was asked for."""


def pinball(alpha: float, observed: float, predicted: float) -> float:
    """``ρ_α(y − q)`` — ``u·α`` when the label is at or above the quantile.

    The spec's definition, transcribed:
    ``ρ_α(u) = u·α if u ≥ 0 else u·(α − 1)``. Both branches are non-negative.
    """
    residual = observed - predicted
    return residual * alpha if residual >= 0.0 else residual * (alpha - 1.0)


def pinball_component(hours: Sequence[ScoredHour], alpha: float) -> float:
    """One of the three published components: mean ``ρ_α`` over the hours.

    ``alpha`` must be one of the served quantiles, because the composed band
    holds those three and no others; asking for a fourth would mean re-inverting
    the mixture here, and there is one inversion in this service.
    """
    if alpha not in SERVED_QUANTILES:
        raise MetricsError(
            f"{alpha!r} is not one of the served quantiles {SERVED_QUANTILES!r}; "
            "the table's components are the band the product ships"
        )
    if not hours:
        raise MetricsError("a pinball component over no hour")
    return sum(
        pinball(alpha, hour.observed_mwh, _served(hour, alpha)) for hour in hours
    ) / len(hours)


def qloss_mwh(hours: Sequence[ScoredHour]) -> float:
    """**The gate.** Mean pinball loss of the composed band over the three served
    quantiles.

    ``qloss_mwh = (1/3) · Σ_α mean_t ρ_α(y_t − Q_Y(α | x_t))``. Lower is better,
    and the units are MWh, which is what lets a human sanity-check the number
    the gate turned on.
    """
    return sum(pinball_component(hours, alpha) for alpha in SERVED_QUANTILES) / len(
        SERVED_QUANTILES
    )


def prevalence(hours: Sequence[ScoredHour]) -> float:
    """The base rate of curtailed hours. PR-AUC's floor, and rung 0's ``p``."""
    if not hours:
        raise MetricsError("prevalence over no hour")
    return sum(1 for hour in hours if hour.is_positive) / len(hours)


def brier(hours: Sequence[ScoredHour]) -> float:
    """Mean squared error of the calibrated probability against the outcome."""
    if not hours:
        raise MetricsError("a Brier score over no hour")
    return sum(
        (hour.forecast.occurrence_probability - (1.0 if hour.is_positive else 0.0)) ** 2
        for hour in hours
    ) / len(hours)


def pr_auc(hours: Sequence[ScoredHour]) -> float | None:
    """Average precision — the step-wise area under the precision-recall curve.

    ``None`` when the hours are all positive or all negative: a ranking metric
    over one class is not a poor score, it is no score, and a 0.0 in that slot
    would read as a failure the data never gave the model a chance at.

    Ties are consumed as a group, so a model that assigns one probability to
    many hours is not credited with an ordering it did not produce.
    """
    ranked = sorted(
        ((hour.forecast.occurrence_probability, hour.is_positive) for hour in hours),
        key=lambda pair: -pair[0],
    )
    positives = sum(1 for _, observed in ranked if observed)
    if not positives or positives == len(ranked):
        return None
    true_positive = 0
    seen = 0
    previous_recall = 0.0
    area = 0.0
    index = 0
    while index < len(ranked):
        score = ranked[index][0]
        while index < len(ranked) and ranked[index][0] == score:
            true_positive += 1 if ranked[index][1] else 0
            seen += 1
            index += 1
        recall = true_positive / positives
        area += (recall - previous_recall) * (true_positive / seen)
        previous_recall = recall
    return area


@dataclass(frozen=True)
class OperatingPoint:
    """Precision, recall and F1 at a stated threshold on ``p``.

    The threshold is a field rather than a convention, because the table
    publishes two of these — one fixed at :data:`FIXED_OPERATING_POINT` and one
    at the best F1 — and only the first is a number the gate may read.
    """

    threshold: float
    precision: float
    recall: float
    f1: float

    @classmethod
    def of(cls, hours: Sequence[ScoredHour], *, threshold: float) -> OperatingPoint:
        """Count the confusion matrix at ``p ≥ threshold``.

        A precision with no predicted positive is ``0.0`` and not undefined: the
        model predicted nothing, which is a measurable behaviour rather than an
        absent measurement.
        """
        if not hours:
            raise MetricsError("an operating point over no hour")
        true_positive = 0
        false_positive = 0
        false_negative = 0
        for hour in hours:
            predicted = hour.forecast.occurrence_probability >= threshold
            if predicted and hour.is_positive:
                true_positive += 1
            elif predicted:
                false_positive += 1
            elif hour.is_positive:
                false_negative += 1
        precision = _ratio(true_positive, true_positive + false_positive)
        recall = _ratio(true_positive, true_positive + false_negative)
        denominator = precision + recall
        return cls(
            threshold=threshold,
            precision=precision,
            recall=recall,
            f1=0.0 if denominator == 0.0 else 2.0 * precision * recall / denominator,
        )

    def as_card_entry(self, suffix: str) -> dict[str, float]:
        return {
            f"precision@{suffix}": self.precision,
            f"recall@{suffix}": self.recall,
            f"f1@{suffix}": self.f1,
            f"threshold@{suffix}": self.threshold,
        }


def best_operating_point(hours: Sequence[ScoredHour]) -> OperatingPoint:
    """The threshold maximising F1. **Reported, and never used by the gate.**

    It is in the table because a reader comparing this project against a paper
    will look for it, and it is not the gate because a threshold chosen after
    seeing the labels is a free parameter pointed straight at the decision.

    Ties go to the lower threshold, so the choice is a function of the hours and
    not of the order they arrived in.
    """
    candidates = sorted({hour.forecast.occurrence_probability for hour in hours})
    if not candidates:
        raise MetricsError("a best operating point over no hour")
    best = OperatingPoint.of(hours, threshold=candidates[0])
    for threshold in candidates[1:]:
        point = OperatingPoint.of(hours, threshold=threshold)
        if point.f1 > best.f1:
            best = point
    return best


def mae_positives_mwh(hours: Sequence[ScoredHour]) -> float | None:
    """Mean absolute error of ``Ê[Y | Y > τ, x]`` over curtailed hours.

    Stage two's own estimator, scored on stage two's own population. ``None``
    when the segment holds no curtailed hour — there is nothing conditional to
    be right or wrong about, and a 0.0 would read as perfect.
    """
    positives = [hour for hour in hours if hour.is_positive]
    if not positives:
        return None
    return sum(
        abs(hour.observed_mwh - hour.forecast.mixture.positive_mean_mwh)
        for hour in positives
    ) / len(positives)


def smape_positives(hours: Sequence[ScoredHour]) -> float | None:
    """Symmetric MAPE over curtailed hours, in ``[0, 2]``.

    ``2·|y − ŷ| / (|y| + |ŷ|)``, the unhalved convention, so a reader can
    recover the halved one by dividing. An hour where both are zero contributes
    zero rather than a division: agreeing exactly is not an error of unknown
    size. It cannot arise on this population — every label here is above ``τ`` —
    and is handled anyway rather than left to raise on a fold nobody predicted.
    """
    positives = [hour for hour in hours if hour.is_positive]
    if not positives:
        return None
    total = 0.0
    for hour in positives:
        predicted = hour.forecast.mixture.positive_mean_mwh
        denominator = abs(hour.observed_mwh) + abs(predicted)
        if denominator > 0.0:
            total += 2.0 * abs(hour.observed_mwh - predicted) / denominator
    return total / len(positives)


def interval_width_mean_mwh(hours: Sequence[ScoredHour]) -> float:
    """Mean ``P90 − P10``. Sharpness — a wide interval covers by cheating.

    Over every settled hour and not only the curtailed ones, because the width
    of the band in a quiet hour is part of what the product shows and a
    measurement restricted to positives would let a model widen the quiet hours
    for free.
    """
    if not hours:
        raise MetricsError("an interval width over no hour")
    widths = [hour.forecast.band.p90 - hour.forecast.band.p10 for hour in hours]
    return sum(widths) / len(widths)


@dataclass(frozen=True)
class SubsystemOccurrence:
    """``pr_auc`` at the grain the spec asks for, with its own floor beside it.

    The floor travels because PR-AUC is not comparable across populations
    without it, and the four subsystems have wildly different prevalences: an
    NE number and an S number are not two readings of one scale.
    """

    subsystem: Subsystem
    rows: int
    prevalence: float
    pr_auc: float | None

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "subsystem": self.subsystem,
            "rows": self.rows,
            "prevalence": self.prevalence,
            "pr_auc": self.pr_auc,
        }


@dataclass(frozen=True)
class MetricsRow:
    """One rung, one run, one fold segment — the whole table, in one value.

    Built through :meth:`of`. The three optional blocks —
    :attr:`coverage`, :attr:`day_grain` and :attr:`collapse` — are ``None``
    when the segment gave them nothing to measure, never a row of zeros, for the
    reason the classes they come from each state: an absent measurement and a
    failed one are opposite readings of the same slot.
    """

    run: str
    #: The rung's published name, e.g. ``same_hour_7d``.
    rung: str
    #: 0…4. The ladder's order is part of the row so a table can be sorted
    #: without a second lookup of what "logistic" ranks against.
    rung_number: int
    #: Whether this rung's feature vector was median-imputed with ``_is_null``
    #: indicators. **The table marks them**: a ladder that quietly gave the weak
    #: rungs a different vector would be measuring the imputation.
    imputed: bool
    #: Whether ``p`` reached the composition through an isotonic map.
    calibrated: bool
    #: Whether ``Q_pos`` reached the composition through ``δ_lo``/``δ_hi``.
    conformalised: bool
    segment: FoldSegment
    rows: int
    prevalence: float
    pr_auc: float | None
    by_subsystem: tuple[SubsystemOccurrence, ...]
    brier: float
    ece: float | None
    mce: float | None
    top_bin_gap: float | None
    at_fixed: OperatingPoint
    at_best: OperatingPoint
    mae_positives_mwh: float | None
    smape_positives: float | None
    pinball_10: float
    pinball_50: float
    pinball_90: float
    #: **The gate.**
    qloss_mwh: float
    interval_width_mean_mwh: float
    #: Over every settled hour. :attr:`CoverageReport.crossing_rate` is the same
    #: quantity over the curtailed subset; the two are different populations and
    #: are not interchangeable.
    crossing_rate: float
    coverage: CoverageReport | None
    delta_lo: float | None
    delta_hi: float | None
    day_grain: DayGrainCoverage | None
    collapse: CollapseBlock | None

    def __post_init__(self) -> None:
        if self.rows <= 0:
            raise MetricsError(
                f"{self.run}/{self.rung}/{self.segment.row_id}: a metrics row over "
                "no settled hour is not a measurement"
            )
        if not 0 <= self.rung_number <= 4:
            raise MetricsError(f"{self.rung_number!r} is not a rung of the ladder")

    @property
    def fidelity(self) -> VintageFidelity:
        """The vintage of the rows behind every number in this row.

        `docs/specs/forecaster.md`: never averaged across values. It is read off
        the segment rather than stored, so a row cannot claim a fidelity its
        segment does not have.
        """
        return self.segment.fidelity

    @property
    def row_id(self) -> str:
        """``F5``, or ``F6@point_in_time`` for one half of a split fold."""
        return self.segment.row_id

    @property
    def share_p50_zero(self) -> float | None:
        """``share_p50_zero`` — the metrics table's name for the ticket-011 share."""
        return (
            None
            if self.collapse is None
            else self.collapse.pooled.share_of_hours_with_p50_zero
        )

    @classmethod
    def of(
        cls,
        hours: Sequence[ScoredHour],
        *,
        run: str,
        rung: str,
        rung_number: int,
        segment: FoldSegment,
        imputed: bool = False,
        calibrated: bool = False,
        conformalised: bool = False,
        correction: ConformalCorrection | None = None,
        day_grain: DayGrainCoverage | None = None,
    ) -> MetricsRow:
        """Compute every column from the segment's settled hours.

        Args:
            hours: every **settled** hour of the segment's test period, composed
                by this rung. Unlabelled hours are absent rather than filtered
                here, so no metric in this file has a rule about a missing label
                to get wrong.
            correction: the conformal pair, if the rung had one. ``δ_lo`` and
                ``δ_hi`` are published as themselves, because a ``δ_lo`` that
                grows across folds is the drift signal.
            day_grain: the ensemble's own calibration over this segment, if the
                rung produced a day band.
        """
        if not hours:
            raise MetricsError(
                f"{run}/{rung}/{segment.row_id}: no settled hour was scored; a "
                "segment with none is reported as absent, not as a row of zeros"
            )
        _assert_inside(hours, segment)
        positives = [hour for hour in hours if hour.is_positive]
        return cls(
            run=run,
            rung=rung,
            rung_number=rung_number,
            imputed=imputed,
            calibrated=calibrated,
            conformalised=conformalised,
            segment=segment,
            rows=len(hours),
            prevalence=prevalence(hours),
            pr_auc=pr_auc(hours),
            by_subsystem=_by_subsystem(hours),
            brier=brier(hours),
            ece=_reliability(hours, segment, "ece"),
            mce=_reliability(hours, segment, "mce"),
            top_bin_gap=_reliability(hours, segment, "top_bin_gap"),
            at_fixed=OperatingPoint.of(hours, threshold=FIXED_OPERATING_POINT),
            at_best=best_operating_point(hours),
            mae_positives_mwh=mae_positives_mwh(hours),
            smape_positives=smape_positives(hours),
            pinball_10=pinball_component(hours, SERVED_QUANTILES[0]),
            pinball_50=pinball_component(hours, SERVED_QUANTILES[1]),
            pinball_90=pinball_component(hours, SERVED_QUANTILES[2]),
            qloss_mwh=qloss_mwh(hours),
            interval_width_mean_mwh=interval_width_mean_mwh(hours),
            crossing_rate=crossing_rate(hour.forecast for hour in hours),
            coverage=(
                None
                if not positives
                else CoverageReport.of(hours, fold_id=segment.row_id)
            ),
            delta_lo=None if correction is None else correction.delta_lo,
            delta_hi=None if correction is None else correction.delta_hi,
            day_grain=day_grain,
            collapse=CollapseBlock.of(hours),
        )

    def as_card_entry(self) -> dict[str, Any]:
        """The published row. Flat, and every optional slot present as ``None``."""
        entry: dict[str, Any] = {
            "run": self.run,
            "rung": self.rung,
            "rung_number": self.rung_number,
            "imputed": self.imputed,
            "calibrated": self.calibrated,
            "conformalised": self.conformalised,
            "row_id": self.row_id,
            "fold_id": self.segment.fold_id,
            "segment_hash": self.segment.segment_hash,
            "vintage_fidelity": self.fidelity,
            "rows": self.rows,
            "prevalence": self.prevalence,
            "pr_auc": self.pr_auc,
            "pr_auc_by_subsystem": [cell.as_card_entry() for cell in self.by_subsystem],
            "brier": self.brier,
            "ece": self.ece,
            "mce": self.mce,
            "top_bin_gap": self.top_bin_gap,
            "mae_positives_mwh": self.mae_positives_mwh,
            "smape_positives": self.smape_positives,
            "pinball_10": self.pinball_10,
            "pinball_50": self.pinball_50,
            "pinball_90": self.pinball_90,
            "qloss_mwh": self.qloss_mwh,
            "interval_width_mean_mwh": self.interval_width_mean_mwh,
            "crossing_rate": self.crossing_rate,
            "delta_lo": self.delta_lo,
            "delta_hi": self.delta_hi,
            "day_total_coverage": (
                None if self.day_grain is None else self.day_grain.day_total_coverage
            ),
            "peak_coverage": (
                None if self.day_grain is None else self.day_grain.peak_coverage
            ),
            "share_p50_zero": self.share_p50_zero,
        }
        entry.update(self.at_fixed.as_card_entry("0.5"))
        entry.update(self.at_best.as_card_entry("best"))
        if self.coverage is not None:
            entry.update(self.coverage.card_fields())
        if self.collapse is not None:
            entry.update(self.collapse.as_card_entry())
        return entry


@dataclass(frozen=True)
class MetricsTable:
    """Every rung of every run over every segment, with the averaging refused.

    The one aggregate this project publishes, and the checks it runs on
    construction are the whole reason it is a type rather than a list: a fold
    reported once when it should be reported twice, or twice as one row, is the
    accident that makes a caveat disappear, and it is invisible in a list of
    numbers that all look fine.
    """

    rows: tuple[MetricsRow, ...]

    def __post_init__(self) -> None:
        if not self.rows:
            raise MetricsError("a metrics table with no rows")
        seen: set[tuple[str, str, str]] = set()
        for row in self.rows:
            key = (row.run, row.rung, row.segment.row_id)
            if key in seen:
                raise MetricsError(
                    f"{key!r} appears twice; one rung of one run has one row per "
                    "fold segment, and a duplicate is a number counted twice"
                )
            seen.add(key)
        for run, rung in sorted({(row.run, row.rung) for row in self.rows}):
            assert_no_averaged_rows(
                [row.segment for row in self.rows if row.run == run and row.rung == rung]
            )

    def __len__(self) -> int:
        return len(self.rows)

    def where(
        self,
        *,
        run: str | None = None,
        rung: str | None = None,
        row_id: str | None = None,
    ) -> tuple[MetricsRow, ...]:
        """The rows matching every stated filter, in the table's own order."""
        return tuple(
            row
            for row in self.rows
            if (run is None or row.run == run)
            and (rung is None or row.rung == rung)
            and (row_id is None or row.row_id == row_id)
        )

    def pooled_qloss(self, *, run: str, rung: str) -> float:
        """``qloss_mwh`` pooled over this rung's segments, hour-weighted.

        Refuses a pool whose segments do not share one
        :class:`~wattsteer_ml.canonical.VintageFidelity`, through
        :func:`~wattsteer_ml.evaluation.vintage.pooled_fidelity`. Hour-weighted
        rather than fold-weighted because the folds are not the same length —
        the live edge grows — and a mean of means would silently reweight the
        newest quarter as it filled up.
        """
        rows = self.where(run=run, rung=rung)
        if not rows:
            raise MetricsError(f"no rows for {run}/{rung}")
        pooled_fidelity([row.segment for row in rows])
        weight = sum(row.rows for row in rows)
        return sum(row.qloss_mwh * row.rows for row in rows) / weight

    def pooled_fidelity(self, *, run: str, rung: str) -> VintageFidelity:
        """The vintage a pooled number for this rung may be labelled with."""
        rows = self.where(run=run, rung=rung)
        if not rows:
            raise MetricsError(f"no rows for {run}/{rung}")
        return pooled_fidelity([row.segment for row in rows])

    def delta_against(self, *, run: str, rung: str, baseline: str) -> dict[str, float]:
        """``Δ qloss_mwh`` per segment, this rung minus the baseline rung.

        Negative means the rung beat the baseline, because lower pinball loss is
        better. Refuses to subtract two rows whose segments differ by hash: two
        rungs scored on different rows are not a delta, and the segment hash is
        what notices a live edge materialised on two different days.
        """
        deltas: dict[str, float] = {}
        for row in self.where(run=run, rung=rung):
            others = self.where(run=run, rung=baseline, row_id=row.row_id)
            if not others:
                raise MetricsError(
                    f"{run}/{rung} was scored on {row.row_id} and {baseline} was "
                    "not; the ladder compares rungs on identical folds"
                )
            other = others[0]
            if other.segment.segment_hash != row.segment.segment_hash:
                raise MetricsError(
                    f"{run}/{rung} and {run}/{baseline} both report {row.row_id}, "
                    "but under different segments; these are not the same rows"
                )
            deltas[row.row_id] = row.qloss_mwh - other.qloss_mwh
        if not deltas:
            raise MetricsError(f"no rows for {run}/{rung}")
        return deltas

    def as_card_entry(self) -> list[dict[str, Any]]:
        return [row.as_card_entry() for row in self.rows]


@dataclass(frozen=True)
class RevisionPremium:
    """``revision_premium_qloss`` — the measured size of the caveat.

    `docs/specs/forecaster.md`: "The first fold to exist in both forms — scored
    once against the labels as ingested at the time and once against the latest
    vintage — yields `revision_premium_qloss`, the difference between the two.
    It is the measured size of the caveat every earlier number carries."

    **The sign, and the question it answers.** The premium is
    ``qloss_as_ingested − qloss_latest_vintage``. Positive means the honest,
    as-ingested scoring is *worse* than the flattering one, which is the
    expected direction and is the amount by which every revision-optimistic
    number in the table should be discounted.

    **The asymmetry this does not contradict.** The protocol reads labels
    ``AsOf(now)`` in training and in evaluation alike, and the
    `revision_optimistic` stamp is about *features*. This one figure is the
    deliberate exception: it is the only place the project scores against two
    label vintages at all, and it exists precisely so the rest of the table
    never has to.
    """

    run: str
    rung: str
    fold_id: str
    row_id: str
    qloss_as_ingested: float
    qloss_latest_vintage: float
    rows: int

    @property
    def revision_premium_qloss(self) -> float:
        return self.qloss_as_ingested - self.qloss_latest_vintage

    @classmethod
    def of(
        cls, *, as_ingested: MetricsRow, latest_vintage: MetricsRow
    ) -> RevisionPremium:
        """Refuse anything but two scorings of one fold by one rung of one run."""
        for field, left, right in (
            ("run", as_ingested.run, latest_vintage.run),
            ("rung", as_ingested.rung, latest_vintage.rung),
            ("row_id", as_ingested.row_id, latest_vintage.row_id),
        ):
            if left != right:
                raise MetricsError(
                    f"a revision premium is one fold scored twice; these rows "
                    f"differ in {field} ({left!r} against {right!r})"
                )
        if as_ingested.rows != latest_vintage.rows:
            raise MetricsError(
                f"{as_ingested.row_id}: {as_ingested.rows} hours were scored "
                f"as-ingested and {latest_vintage.rows} against the latest "
                "vintage; a premium over two different row sets measures the "
                "difference in rows and not the difference in vintages"
            )
        return cls(
            run=as_ingested.run,
            rung=as_ingested.rung,
            fold_id=as_ingested.segment.fold_id,
            row_id=as_ingested.row_id,
            qloss_as_ingested=as_ingested.qloss_mwh,
            qloss_latest_vintage=latest_vintage.qloss_mwh,
            rows=as_ingested.rows,
        )

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "revision_premium_qloss": self.revision_premium_qloss,
            "revision_premium_run": self.run,
            "revision_premium_rung": self.rung,
            "revision_premium_fold": self.row_id,
            "revision_premium_rows": self.rows,
            "qloss_as_ingested": self.qloss_as_ingested,
            "qloss_latest_vintage": self.qloss_latest_vintage,
            "revision_premium_note": (
                "qloss_as_ingested minus qloss_latest_vintage on the first fold "
                "that exists in both label vintages. Positive means the honest "
                "scoring is worse, and is the amount by which every "
                "revision_optimistic row in the table should be discounted."
            ),
        }


def first_revision_premium(
    *, as_ingested: MetricsTable, latest_vintage: MetricsTable
) -> RevisionPremium | None:
    """The premium on the **first** fold that exists in both vintages.

    First by test-period start, so "first" is a fact about the calendar rather
    than about the order two tables happened to be assembled in. ``None`` when
    no fold exists in both — which is the state of the project until ingestion
    go-live has been passed by a fold that was also scored beforehand, and is
    reported as absence rather than as a zero premium.
    """
    shared = [
        (row, other)
        for row in as_ingested.rows
        for other in latest_vintage.where(run=row.run, rung=row.rung, row_id=row.row_id)
    ]
    if not shared:
        return None
    row, other = min(
        shared,
        key=lambda pair: (
            pair[0].segment.test_start,
            pair[0].run,
            pair[0].rung_number,
        ),
    )
    return RevisionPremium.of(as_ingested=row, latest_vintage=other)


def out_of_fold_pool(hours: Sequence[ScoredHour], segment: FoldSegment) -> OutOfFoldPool:
    """This segment's hours as a pool the reliability machinery can bin.

    A pool of one segment, so the curve it produces is the *fold's* calibration
    rather than the pooled out-of-fold curve the model card publishes. Both are
    real and they are not the same number: the card's is measured across every
    walk-forward fold, and the table's is what this fold alone showed.
    :class:`~wattsteer_ml.training.calibration.OutOfFoldPool` still does its two
    checks, so an hour outside the segment's test period cannot get in.
    """
    return OutOfFoldPool.of(
        [
            OutOfFoldPrediction(
                fold_id=segment.fold_id,
                key=hour.key,
                probability=hour.forecast.occurrence_probability,
                observed=hour.is_positive,
            )
            for hour in hours
        ],
        segments=[segment],
    )


def _reliability(
    hours: Sequence[ScoredHour], segment: FoldSegment, field: str
) -> float | None:
    """One scalar off this segment's reliability curve, or ``None``.

    ``None`` when the curve cannot be built — a segment whose hours all fall in
    one bin, say. The three scalars are computed from the same
    :class:`~wattsteer_ml.training.calibration.ReliabilityCurve` machinery the
    card publishes, including its merge rule, rather than from a second binning
    that would drift from it.
    """
    try:
        curve = ReliabilityCurve.of(out_of_fold_pool(hours, segment))
    except CalibrationError:
        return None
    value = getattr(curve, field)
    return float(value) if isinstance(value, float) else None


def _by_subsystem(hours: Sequence[ScoredHour]) -> tuple[SubsystemOccurrence, ...]:
    cells: list[SubsystemOccurrence] = []
    for code in SUBSYSTEM_CODES:
        cell = [hour for hour in hours if hour.key.subsystem == code]
        if not cell:
            continue
        cells.append(
            SubsystemOccurrence(
                subsystem=code,
                rows=len(cell),
                prevalence=prevalence(cell),
                pr_auc=pr_auc(cell),
            )
        )
    return tuple(cells)


def _assert_inside(hours: Iterable[ScoredHour], segment: FoldSegment) -> None:
    """Every scored hour belongs to the segment whose row this will be.

    The check that makes a split fold's two rows mean what they say: a
    `revision_optimistic` half scored with three days of its `point_in_time`
    twin's rows in it is a row whose caveat is already wrong, and nothing
    downstream would notice.
    """
    for hour in hours:
        day = hour.key.target_date
        if not segment.test_start <= day <= segment.test_end:
            raise MixedFidelityError(
                f"{hour.key.line} is outside {segment.row_id} "
                f"({segment.test_start.isoformat()}–{segment.test_end.isoformat()}); "
                "a metric over rows from two segments has averaged across the "
                "split this protocol exists to keep"
            )


def _served(hour: ScoredHour, alpha: float) -> float:
    """``Q_Y(α | x)`` off the composed band, by the band's own field."""
    band = hour.forecast.band
    if alpha == SERVED_QUANTILES[0]:
        return band.p10
    if alpha == SERVED_QUANTILES[1]:
        return band.p50
    return band.p90


def _ratio(numerator: int, denominator: int) -> float:
    return 0.0 if denominator == 0 else numerator / denominator
