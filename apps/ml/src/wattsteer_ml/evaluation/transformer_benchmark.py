"""The Temporal Fusion Transformer benchmark — run once and never promoted.

`docs/specs/forecaster.md`, "The transformer benchmark":

    Run **once, offline**, on ``dessem_free_v1`` at ``gate_late``, on the same
    folds, scored by the same ``qloss_mwh`` through the same composition
    arithmetic (a TFT producing quantiles directly still feeds the mixture
    inversion, with its own occurrence head). Reported … with ``training time``
    and ``explainability`` columns filled in honestly. … **It is never promoted,
    and that is enforced rather than agreed.**

**A benchmark that can be promoted is not a benchmark, it is a candidate.** So
the non-promotion here is structural in four independent ways, none of which is
a convention anybody has to remember:

- **There is no ordering, no preferred arm and — unlike every other comparison
  in this package — no delta.** :class:`BenchmarkFigures` publishes each arm's
  own figures and :class:`TransformerBenchmarkReport` publishes the arms side by
  side. The lead-time A/B may publish a ``Δ`` because the decision it feeds is
  about weather ingestion; the only act *this* comparison could license is a
  promotion, so a published ``Δ qloss_mwh`` would be the promotion argument
  arriving through the back door. A reader may subtract two numbers; the block
  will not do it for them, and ``tests/test_transformer_benchmark.py`` asserts
  that over ``dir()`` and the recursive card-block keys rather than over the
  source text, so the field cannot come back under a new name.
- **There is no path from here to the promotion log.** Nothing in this file
  imports :func:`wattsteer_ml.promotions.append` or
  :func:`~wattsteer_ml.evaluation.gate.record_decision`; the one thing it writes
  is a card block. :func:`assert_no_benchmark_promoted` is the invariant in the
  other direction, runnable against a real volume: every ``promote`` line is
  read back through the card it names, and one whose ``estimator_family`` is
  outside the gate's allow-list is a benchmark that was served.
- **The family the gate refuses is this module's own constant.**
  :data:`BENCHMARK_ARM` is ``"tft"``, and :data:`ARMS`' served member is
  :data:`~wattsteer_ml.training.hyperparameters.ESTIMATOR_FAMILY` imported
  rather than respelt — the same constant
  :data:`~wattsteer_ml.evaluation.gate.ESTIMATOR_ALLOW_LIST` is built from. The
  gate's refusal is exercised in ``tests/test_hot_swap_gate.py`` against this
  constant, so renaming the family cannot quietly decouple the check from the
  thing it checks.
- **The weekly retrain cannot reach this module.** Neither
  :mod:`~wattsteer_ml.evaluation.serving_lanes`,
  :mod:`~wattsteer_ml.evaluation.gate` nor :mod:`wattsteer_ml.retrain` imports
  it, asserted as an import-graph property. "Once, offline" is then a fact about
  the graph rather than a sentence in a ticket.

## The lane is the served lane, and that is why the family is the bar

The threshold sweep gets its structural bar for free: each arm's ``threshold_mw``
gives it a lane of its own, and a lane nobody serves cannot be promoted into
serving. **That trick does not transfer here.** This benchmark runs at the
spec's profile — the free feature set, the late gate, the default threshold —
which is exactly :data:`~wattsteer_ml.evaluation.serving_lanes.LATE_LANE`'s
triple, imported here rather than rebuilt so the two cannot drift. The evening
view is the thing the benchmark is a benchmark *of*; running it in a lane of its
own would make it a comparison against a model nobody serves. So the estimator
allow-list is the whole of the enforcement, which is what the spec says and why
it says it.

Two further consequences are worth stating where they can be read together.
:class:`~wattsteer_ml.training.bundle.ModelBundle` refuses a bundle whose
``estimator_family`` is off the allow-list and
:meth:`~wattsteer_ml.training.bundle.ModelCard.to_dict` writes the served family
unconditionally, so **there is no way to produce a TFT artifact through the
served path at all**; and
:class:`~wattsteer_ml.evaluation.metrics.MetricsRow` refuses a ``rung_number``
above 4, so rung 5 cannot enter the metrics table the gate reads. This module
therefore publishes its own figures rather than widening either — the same
reason :class:`~wattsteer_ml.evaluation.matrix.MatrixRun` has no evaluation
field.

## The figures, and the arithmetic they are not allowed to invent

Every figure is read off an existing definition —
:mod:`~wattsteer_ml.evaluation.metrics`,
:class:`~wattsteer_ml.training.conformal.CoverageReport`,
:class:`~wattsteer_ml.evaluation.collapse.CollapseBlock` — so a benchmark number
and a metrics-table number of the same name are the same arithmetic. That is the
ticket's first box: *scored by the same metric through the same composition
arithmetic*.

The second box — "its occurrence head feeds the same mixture inversion; no
bespoke band is published for it" — is enforced as an identity rather than a
promise. ``Q_Y(q) = 0`` for every ``q ≤ 1 − p``, so the share of hours whose
composed P50 is zero is recomputable from ``p`` alone.
:class:`~wattsteer_ml.evaluation.threshold_sweep.MixtureRegime` is that
restatement — reused rather than re-derived, and deliberately taken from the
mixture's own comparison rather than the spec's prose, because the two differ in
floating point — and :meth:`BenchmarkFigures.of` **refuses** an arm whose
``share_p50_zero`` and restated breakpoint disagree. A TFT that published its own
quantiles instead of feeding the inversion fails that check.

## Training time and explainability, filled in honestly

:class:`TrainingCost` carries a wall clock and a peak RSS and cannot be
constructed from a negative one. It is optional on a fixture-stamped report and
**required on a measured one**: a benchmark whose whole point is the cost of the
architecture, published without the cost, is not the report the ticket asks for.

:data:`EXPLAINABILITY` is a published constant per arm rather than free text, so
two cards carry the same sentence and a reader is comparing two states rather
than two phrasings. Honestly filled in means saying what the diagnosis spec can
and cannot do with each: TreeSHAP is exact and per-row on the served model, and
a transformer's attention and variable-selection weights are neither Shapley
values nor an attribution the grouped driver map could consume.

## This run has not happened, and the card says so

Two independent things are missing, and neither is a thing this ticket may
paper over:

- **There is no TFT implementation here.** `apps/ml/pyproject.toml` has
  LightGBM, scikit-learn and statsmodels; nothing in the dependency set can fit
  a Temporal Fusion Transformer, and adding one means adding PyTorch — a heavy
  dependency and a decision with a review, which is not a thing to slip into a
  benchmark ticket.
- **No environment here has ingested data.** Forecaster ticket 15 recorded it:
  the read path returns the full spine against an empty database, and no real
  fit, bootstrap or promotion has ever been observed. So the served arm has no
  training rows either.

So the value this repository can produce today is
:class:`UnmeasuredTransformerBenchmark` carrying :data:`NO_TFT_IMPLEMENTATION`,
**written to the card** for the reason
:func:`~wattsteer_ml.evaluation.lead_time.unmeasured_for_want_of_an_archive`
writes its sibling: a card with no benchmark block and a card saying "this arm
has no data source" look identical to anybody grepping for the figure, and only
one of them is true. Two fabricated arms and a flattering decimal would look
exactly like the honest comparison the ticket asks for.

**The runtime and the memory are not estimated here.** A benchmark's training
time is a measurement, and there is nothing to measure; a number reasoned from
the shape of the work would be an estimate wearing a measurement's name.
:class:`TrainingCost` is therefore absent rather than guessed, and the unmeasured
block has no field that could be read as one.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.evaluation.collapse import CollapseBlock
from wattsteer_ml.evaluation.collapse_report import FIXTURE_SOURCE, UNMEASURED_SOURCE
from wattsteer_ml.evaluation.gate import ESTIMATOR_ALLOW_LIST
from wattsteer_ml.evaluation.matrix import (
    ScoredFold,
    assert_identical_test_rows,
    row_set_digest,
)
from wattsteer_ml.evaluation.metrics import pr_auc, prevalence, qloss_mwh
from wattsteer_ml.evaluation.serving_lanes import LATE_LANE
from wattsteer_ml.evaluation.threshold_sweep import MixtureRegime
from wattsteer_ml.evaluation.vintage import FoldSegment, assert_no_averaged_rows
from wattsteer_ml.lanes import Lane
from wattsteer_ml.promotions import PromotionLog
from wattsteer_ml.training.bundle import BundleError, read_card, write_card
from wattsteer_ml.training.conformal import CoverageReport, ScoredHour
from wattsteer_ml.training.hyperparameters import ESTIMATOR_FAMILY

#: The card block, under the name the spec's Experiments group would give it. A
#: reader of the card finds it without knowing what a fold segment or an arm is.
TRANSFORMER_BENCHMARK_BLOCK_KEY = "transformer_benchmark"

#: How often this runs. `docs/specs/forecaster.md`: "Run **once, offline**". Not
#: "once per fold calendar" like the lead-time A/B — a second run is a second
#: decision to make it, and there is nothing about it that a retrain refreshes.
CADENCE = "once_offline"

#: The served arm: rung 4, the model the gate's allow-list names. Imported from
#: :mod:`~wattsteer_ml.training.hyperparameters` rather than spelt, because it
#: is the same constant :data:`~wattsteer_ml.evaluation.gate.\
#: ESTIMATOR_ALLOW_LIST` is built from and a benchmark against a *string* that
#: happens to match the served family is a benchmark against nothing.
SERVED_ARM: str = ESTIMATOR_FAMILY

#: The benchmark arm. **Temporal Fusion Transformer, not PatchTST**: PatchTST's
#: strength is a long look-back over the target series, and this problem's
#: look-back is deliberately crippled by the publication gate — the nearest
#: usable same-hour actual is 48 hours back and most of the vector is exogenous.
#: TFT is the covariate-aware architecture and is therefore the honest
#: comparison: it is asked the same question LightGBM is asked.
BENCHMARK_ARM = "tft"

#: The two, in the order the block lists them. Exactly two: a benchmark is a
#: comparison against the served model and nothing else, and a third
#: architecture would be a different ticket with a different question.
ARMS: tuple[str, ...] = (SERVED_ARM, BENCHMARK_ARM)

#: **The served evening lane, imported rather than rebuilt.** The spec runs the
#: benchmark on the free feature set at the late gate, which is this lane's
#: triple; a lane of its own would make the comparison one against a model
#: nobody serves. See the module docstring: it is also why the estimator
#: allow-list, and not the lane, is the whole of the enforcement.
BENCHMARK_LANE: Lane = LATE_LANE

#: Spelt out for the card, derived from the lane so they cannot disagree.
BENCHMARK_FEATURE_SET = BENCHMARK_LANE.feature_set
BENCHMARK_GATE_PROFILE = BENCHMARK_LANE.gate_profile

#: :attr:`BenchmarkProvenance.benchmark_source` when both arms came out of real
#: fold evaluations — two real trainings over real rows. **The only value that
#: makes this block evidence about anything.**
FOLD_EVALUATION_SOURCE = "fold_evaluation"

#: Why the run has not happened, as one sentence on every card rather than a
#: caller's phrasing. It names both blockers, because fixing either one alone
#: leaves the benchmark unrunnable and a reason that named one would read as a
#: smaller gap than it is.
NO_TFT_IMPLEMENTATION = (
    "The benchmark has not been run, and cannot be run in this repository "
    "today, for two independent reasons. There is no TFT implementation in the "
    "dependency set — apps/ml/pyproject.toml carries LightGBM, scikit-learn and "
    "statsmodels, and fitting a Temporal Fusion Transformer would mean adding "
    "PyTorch, which is a heavy dependency and a decision with a review rather "
    "than a step inside a benchmark run. And no environment here has ingested "
    "data (forecaster ticket 15), so the served arm has no training rows "
    "either: the read path returns the full spine against an empty database and "
    "no real fit, bootstrap or promotion has ever been observed. Two arms built "
    "anyway would be arithmetic over invented labels, and a flattering decimal "
    "is indistinguishable from the honest comparison this block is for."
)

#: The ``explainability`` column, filled in honestly, per arm. A published
#: constant rather than free text, so two cards carry the same sentence and a
#: reader is comparing two states rather than two phrasings.
EXPLAINABILITY: dict[str, str] = {
    SERVED_ARM: (
        "TreeSHAP: exact, per-row, and cheap enough to run on every served "
        "hour. docs/specs/diagnosis.md's grouped attribution and the narration "
        "are built on it, and the hurdle's two heads are attributed separately "
        "because a combined attribution over a composition would not be a "
        "Shapley value of anything."
    ),
    BENCHMARK_ARM: (
        "Attention weights and variable-selection weights, which are the "
        "architecture's own interpretability story and are not Shapley values: "
        "they are not additive, they do not sum to the prediction, and they "
        "carry no baseline, so the driver-group map docs/specs/diagnosis.md "
        "consumes has nothing to consume. Kernel SHAP over a transformer is "
        "available and is a different cost class — per-row sampling against a "
        "background set, against TreeSHAP's exact pass. Serving this arm would "
        "mean replacing the explanation the product ships, not only the "
        "estimator."
    ),
}


class TransformerBenchmarkError(ValueError):
    """The arms cannot support the benchmark that was asked for.

    Also raised by :func:`assert_no_benchmark_promoted`, which is the same
    statement about a volume rather than about a set of hours: a promoted
    artifact whose family is off the allow-list is a benchmark that was served.
    """


@dataclass(frozen=True)
class TrainingCost:
    """What one arm cost to train. The ticket's ``training time`` column.

    Both numbers are measurements or the value does not exist: a wall clock
    reasoned from the shape of the work is an estimate, and an estimate in a
    field named ``wall_clock_seconds`` is the failure this class exists to make
    impossible. :attr:`peak_rss_mb` is optional only because a run may be timed
    where it cannot be measured for memory — never the other way round, since
    the column the ticket names is the time.
    """

    wall_clock_seconds: float
    peak_rss_mb: float | None = None

    def __post_init__(self) -> None:
        if self.wall_clock_seconds < 0:
            raise TransformerBenchmarkError(
                f"{self.wall_clock_seconds!r} is not a training time; a negative "
                "wall clock is a fault to stop on rather than a fast fit"
            )
        if self.peak_rss_mb is not None and self.peak_rss_mb <= 0:
            raise TransformerBenchmarkError(
                f"{self.peak_rss_mb!r} is not a peak RSS; a process that used no "
                "memory did not run"
            )

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "wall_clock_seconds": self.wall_clock_seconds,
            "peak_rss_mb": self.peak_rss_mb,
        }


@dataclass(frozen=True)
class ArmRun:
    """One arm's run: the hours it scored, and what it cost to train them.

    ``cost`` is ``None`` when the run was not timed, which a fixture-stamped
    report may be and a measured one may not — see :meth:`BenchmarkFigures.of`
    and :meth:`TransformerBenchmarkReport.of`.
    """

    hours: tuple[ScoredHour, ...]
    cost: TrainingCost | None = None


#: One fold segment's two arms, keyed by the estimator family that produced each.
BenchmarkArms = Mapping[str, ArmRun]


@dataclass(frozen=True)
class BenchmarkFigures:
    """One arm's figures over one fold segment, plus its two honest columns.

    ``pr_auc`` and ``coverage_p10`` are ``None`` when the arm gave them nothing
    to measure, never a zero: a PR-AUC over one class is no score and a coverage
    over no curtailed hour is no measurement.
    """

    arm: str
    rows: int
    prevalence: float
    positives: int
    pr_auc: float | None
    #: **The metric the gate uses**, computed by the metrics module's own
    #: function so a benchmark number and a metrics-table number of this name
    #: are the same arithmetic.
    qloss_mwh: float
    coverage_p10: float | None
    share_p50_zero: float | None
    regime: MixtureRegime
    cost: TrainingCost | None

    @property
    def explainability(self) -> str:
        return EXPLAINABILITY[self.arm]

    @classmethod
    def of(
        cls,
        run: ArmRun,
        *,
        arm: str,
        lane: Lane = BENCHMARK_LANE,
    ) -> BenchmarkFigures:
        """Compute one arm's figures, and check the mixture identity.

        The refusal at the end is the ticket's second box. If the share of hours
        whose composed P50 is zero disagrees with the share the composition's
        own breakpoint forces to zero, then this arm's band was built by
        something other than :func:`~wattsteer_ml.mixture.compose` — which for
        the benchmark arm means a TFT publishing its quantiles directly instead
        of feeding the inversion, and is exactly the bespoke band the ticket
        forbids.
        """
        if arm not in ARMS:
            raise TransformerBenchmarkError(
                f"{arm!r} is not one of the benchmark's arms {list(ARMS)}; the "
                "comparison is the served model against the transformer, and a "
                "third architecture is a different question"
            )
        hours = run.hours
        if not hours:
            raise TransformerBenchmarkError(
                f"{arm}: no settled hour was scored; an arm with none is reported "
                "as absent, not as a row of zeros"
            )
        stamped = {hour.forecast.threshold_mw for hour in hours}
        if stamped != {lane.threshold_mw}:
            raise TransformerBenchmarkError(
                f"the {arm} arm is composed of hours stamped {sorted(stamped)!r} "
                f"and the benchmark runs at {lane.threshold_mw} MW; a magnitude "
                "carries the threshold that produced it, and two arms cut at "
                "different thresholds are not one comparison"
            )
        positives = [hour for hour in hours if hour.is_positive]
        collapse = CollapseBlock.of(hours)
        regime = MixtureRegime.of(hours)
        share_p50_zero = (
            None if collapse is None else collapse.pooled.share_of_hours_with_p50_zero
        )
        if share_p50_zero is not None and share_p50_zero != regime.share_p50_forced_zero:
            raise TransformerBenchmarkError(
                f"{arm}: share_p50_zero is {share_p50_zero!r} and the mixture "
                f"forces {regime.share_p50_forced_zero!r} of these hours to a "
                "zero P50. Those are the same quantity — Q_Y(q) = 0 for "
                "q <= 1 - p — so a disagreement means this arm's band did not "
                "come through the one composition. A model that produces "
                "quantiles directly still feeds the mixture inversion, with its "
                "own occurrence head: the ladder compares models, not model "
                "families' conventions"
            )
        return cls(
            arm=arm,
            rows=len(hours),
            prevalence=prevalence(hours),
            positives=len(positives),
            pr_auc=pr_auc(hours),
            qloss_mwh=qloss_mwh(hours),
            coverage_p10=(
                None
                if not positives
                else CoverageReport.of(hours, fold_id=arm).coverage_p10
            ),
            share_p50_zero=share_p50_zero,
            regime=regime,
            cost=run.cost,
        )

    def as_card_entry(self) -> dict[str, Any]:
        """One arm's row of the table, with both honest columns filled in."""
        return {
            "arm": self.arm,
            "estimator_family": self.arm,
            "served": self.arm in ESTIMATOR_ALLOW_LIST,
            "rows": self.rows,
            "prevalence": self.prevalence,
            "positives": self.positives,
            "pr_auc": self.pr_auc,
            "qloss_mwh": self.qloss_mwh,
            "coverage_p10": self.coverage_p10,
            "share_p50_zero": self.share_p50_zero,
            "mixture_regime": self.regime.as_card_entry(),
            "training_cost": None if self.cost is None else self.cost.as_card_entry(),
            "explainability": self.explainability,
        }


@dataclass(frozen=True)
class BenchmarkRow:
    """One arm, one fold segment: the figures and the rows they were over."""

    segment: FoldSegment
    figures: BenchmarkFigures
    #: The digest of the rows this arm was scored on, as a claim that can be
    #: checked against its sibling. Never supplied by a caller.
    scored: ScoredFold

    def __post_init__(self) -> None:
        if self.scored.fold_id != self.segment.fold_id:
            raise TransformerBenchmarkError(
                f"a row filed under {self.segment.row_id} carries rows scored on "
                f"{self.scored.fold_id}"
            )

    @property
    def arm(self) -> str:
        return self.figures.arm


def benchmark_rows(
    arms: BenchmarkArms, *, segment: FoldSegment
) -> tuple[BenchmarkRow, ...]:
    """**The comparison.** Two arms over one fold segment, on identical rows.

    Args:
        arms: one :class:`ArmRun` per member of :data:`ARMS`. Exactly the two:
            a benchmark reported without the served arm is a transformer's
            figures with nothing to be a benchmark against.
        segment: the fold segment both were scored on.

    Row identity is asserted through
    :func:`~wattsteer_ml.evaluation.matrix.assert_identical_test_rows` — the same
    function the A/B matrix and the threshold sweep use, over the same
    :class:`~wattsteer_ml.evaluation.matrix.ScoredFold`. Two arms with the same
    number of rows can hold different rows, and one missing hour and one extra
    day cancel in a count.
    """
    missing = sorted(set(ARMS) - set(arms))
    extra = sorted(set(arms) - set(ARMS))
    if missing or extra:
        raise TransformerBenchmarkError(
            f"a benchmark is exactly {list(ARMS)}; this one is missing {missing} "
            f"and adds {extra}. The comparison is the served model against the "
            "transformer on identical rows, and either half alone is not it"
        )
    rows = tuple(
        BenchmarkRow(
            segment=segment,
            figures=BenchmarkFigures.of(arms[arm], arm=arm),
            scored=_scored_fold(arm, arms[arm].hours, segment=segment),
        )
        for arm in ARMS
    )
    assert_identical_test_rows([row.scored for row in rows])
    return rows


@dataclass(frozen=True)
class BenchmarkProvenance:
    """What the benchmark's figures are figures *of*. Never optional.

    The sixth block in this service to carry one, and for the reason the other
    five state: a ``qloss_mwh`` of 3.4 is computable from any set of hours,
    including the fabricated ones this repository's fixtures are full of, and it
    reads exactly like a measurement of the Brazilian grid. Constructible only
    through :meth:`measured` or :meth:`fixture`, and the shared source constants
    come from :mod:`~wattsteer_ml.evaluation.collapse_report` rather than being
    respelt.
    """

    benchmark_source: str
    at: datetime | None
    #: Derived, so a stamp cannot name a lane the benchmark did not run in.
    lane: Lane = BENCHMARK_LANE

    @property
    def is_measurement(self) -> bool:
        return self.benchmark_source == FOLD_EVALUATION_SOURCE

    @classmethod
    def measured(cls, *, at: datetime) -> BenchmarkProvenance:
        """The stamp for arms scored by real fold evaluations."""
        return cls(benchmark_source=FOLD_EVALUATION_SOURCE, at=at)

    @classmethod
    def fixture(cls) -> BenchmarkProvenance:
        """The stamp for arms built on fabricated hours. Named, never defaulted."""
        return cls(benchmark_source=FIXTURE_SOURCE, at=None)

    def card_fields(self) -> dict[str, Any]:
        return {
            "measured": self.is_measurement,
            "benchmark_source": self.benchmark_source,
            "cadence": CADENCE,
            "lane": self.lane.directory_name,
            "feature_set": BENCHMARK_FEATURE_SET,
            "gate_profile": BENCHMARK_GATE_PROFILE,
            "arms": list(ARMS),
            "served_estimator_family": SERVED_ARM,
            "benchmark_estimator_family": BENCHMARK_ARM,
            "allow_list": sorted(ESTIMATOR_ALLOW_LIST),
            "at": None if self.at is None else self.at.isoformat(),
        }


@dataclass(frozen=True)
class TransformerBenchmarkReport:
    """Both arms per fold segment, published, with nothing that selects one.

    :meth:`card_block` is the whole published surface. There is no ordering
    here, no delta and no winner: the benchmark is never promoted, so a field
    that ranked the two arms would be the promotion argument written down.
    """

    provenance: BenchmarkProvenance
    rows: tuple[BenchmarkRow, ...]

    def __post_init__(self) -> None:
        if not self.rows:
            raise TransformerBenchmarkError(
                "a benchmark report with no fold; an absent benchmark is "
                "UnmeasuredTransformerBenchmark, which carries a reason instead "
                "of no rows"
            )
        by_segment: dict[str, list[BenchmarkRow]] = {}
        for row in self.rows:
            by_segment.setdefault(row.segment.row_id, []).append(row)
        segments: list[FoldSegment] = []
        for row_id, group in by_segment.items():
            arms = sorted(row.arm for row in group)
            if arms != sorted(ARMS):
                raise TransformerBenchmarkError(
                    f"{row_id} is reported with {arms}; a fold carries exactly "
                    f"the two arms {list(ARMS)}, and a fold missing one is a fold "
                    "whose comparison was not made"
                )
            assert_identical_test_rows([row.scored for row in group])
            segments.append(group[0].segment)
        assert_no_averaged_rows(segments)
        if self.provenance.is_measurement:
            untimed = sorted(row.arm for row in self.rows if row.figures.cost is None)
            if untimed:
                raise TransformerBenchmarkError(
                    f"the measured benchmark reports no training time for "
                    f"{untimed}. The ticket asks for training time and an "
                    "explainability note recorded beside the metrics, and the "
                    "cost of the architecture is half of what a benchmark is for"
                )

    @classmethod
    def of(
        cls,
        arms_by_segment: Iterable[tuple[FoldSegment, BenchmarkArms]],
        *,
        provenance: BenchmarkProvenance,
    ) -> TransformerBenchmarkReport:
        return cls(
            provenance=provenance,
            rows=tuple(
                row
                for segment, arms in arms_by_segment
                for row in benchmark_rows(arms, segment=segment)
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
        """The block, under :data:`TRANSFORMER_BENCHMARK_BLOCK_KEY`.

        ``decides`` and ``reads`` are prose and always present, the discipline
        the three blocks beside this one apply: a reader who reaches the figures
        has already read what they do not license.
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
                    "fold_hash": row.segment.fold_hash,
                    "test_start": row.segment.test_start.isoformat(),
                    "test_end": row.segment.test_end.isoformat(),
                    "row_digest": row.scored.row_digest,
                    "rows": row.scored.row_count,
                    "arms": {},
                },
            )
            entry["arms"][row.arm] = row.figures.as_card_entry()
        return {
            TRANSFORMER_BENCHMARK_BLOCK_KEY: {
                **self.provenance.card_fields(),
                "decides": _DECIDES_NOTHING,
                "reads": _READS if self.provenance.is_measurement else _NOT_A_READING,
                "composition": _ONE_COMPOSITION,
                "vintage_fidelities": list(self.fidelities),
                "folds": list(folds.values()),
            }
        }


@dataclass(frozen=True)
class UnmeasuredTransformerBenchmark:
    """No arms, and the sentence saying why — the shape of an absent benchmark.

    A card with no benchmark block and a card saying "this arm has no data
    source" look identical to anybody grepping for the figure, and only one of
    them is true of a repository that has neither a TFT implementation nor
    ingested data. It has no field that could be mistaken for a figure, and in
    particular no training time: the runtime of a run that did not happen is not
    a thing to reason out to one decimal place.
    """

    at: datetime
    reason: str
    lane: Lane = BENCHMARK_LANE
    benchmark_source: str = UNMEASURED_SOURCE

    @property
    def is_measurement(self) -> bool:
        return False

    def card_block(self) -> dict[str, Any]:
        return {
            TRANSFORMER_BENCHMARK_BLOCK_KEY: {
                "measured": False,
                "benchmark_source": self.benchmark_source,
                "cadence": CADENCE,
                "lane": self.lane.directory_name,
                "feature_set": BENCHMARK_FEATURE_SET,
                "gate_profile": BENCHMARK_GATE_PROFILE,
                "arms": list(ARMS),
                "served_estimator_family": SERVED_ARM,
                "benchmark_estimator_family": BENCHMARK_ARM,
                "allow_list": sorted(ESTIMATOR_ALLOW_LIST),
                "at": self.at.isoformat(),
                "reason": self.reason,
                "decides": _DECIDES_NOTHING,
                "reads": _NOTHING_YET,
            }
        }


def unmeasured_for_want_of_an_implementation(
    *, at: datetime, lane: Lane = BENCHMARK_LANE
) -> UnmeasuredTransformerBenchmark:
    """The benchmark that cannot be run, named as the things that are missing.

    A named constructor rather than a caller-supplied reason string, so the
    sentence on every card is the same sentence and a reader comparing two cards
    is comparing two states rather than two phrasings.
    """
    return UnmeasuredTransformerBenchmark(at=at, reason=NO_TFT_IMPLEMENTATION, lane=lane)


def record_transformer_benchmark(
    report: TransformerBenchmarkReport | UnmeasuredTransformerBenchmark,
    *,
    root: Path,
    artifact_id: str,
    lane: Lane = BENCHMARK_LANE,
) -> Path:
    """Write the block onto the card. **The only thing this module writes.**

    Through the one card reader and the one card writer
    :func:`~wattsteer_ml.evaluation.gate.record_decision` and the other
    experiment blocks use, so the blocks cannot disagree about what a card is.

    Two refusals guard which card it lands on. ``lane`` must be
    :data:`BENCHMARK_LANE` — a benchmark block on another lane's card would
    describe a comparison that lane was not part of. And the card's own
    ``estimator_family``, when it carries one, must be on the gate's allow-list:
    the block is *about* the transformer and belongs on a served artifact's
    card, and a benchmark block on a benchmark artifact's card would be the
    first half of an artifact nobody may serve looking like one somebody did.

    Nothing here appends to ``promotions.jsonl``, and there is no argument that
    could make it.
    """
    if lane != BENCHMARK_LANE:
        raise TransformerBenchmarkError(
            f"{lane} is not the benchmark's lane {BENCHMARK_LANE.directory_name}; "
            "the transformer is compared against the evening view on the "
            "evening view's own triple, and a block on another lane's card would "
            "describe a run it was not part of"
        )
    path = root / lane.directory_name / f"{artifact_id}{CARD_SUFFIX}"
    card = read_card(path)
    family = _family_on(card)
    if family is not None and family not in ESTIMATOR_ALLOW_LIST:
        raise TransformerBenchmarkError(
            f"{path} is the card of a {family!r} artifact, which is outside the "
            f"gate's allow-list {sorted(ESTIMATOR_ALLOW_LIST)}. The benchmark "
            "block is published on the served artifact's card; writing it onto "
            "an artifact nobody may serve is how a benchmark starts looking like "
            "a lane's model"
        )
    write_card(path, {**card, **report.card_block()})
    return path


def assert_no_benchmark_promoted(log: PromotionLog, *, root: Path) -> None:
    """No artifact off the gate's allow-list has ever been promoted.

    The structural half of "it is never served", checked against the append-only
    log and the cards it names rather than against a convention. The promotion
    log records an artifact id and a lane and not a family, so the family is
    read back from the card each ``promote`` line points at — which is also what
    makes this runnable against a real volume rather than only against a report.

    A refusal is fine: a refused benchmark is exactly what the spec's second
    gate check produces, and the log is where evidence goes. A ``promote`` line
    whose card cannot be read is **not** cleared, because "the volume cannot
    tell us" and "nothing off the allow-list was promoted" are different
    sentences and only one of them is a clean bill of health.
    """
    for record in log.records:
        if not record.promotes:
            continue
        path = root / record.lane.directory_name / f"{record.artifact_id}{CARD_SUFFIX}"
        try:
            card = read_card(path)
        except (BundleError, OSError, ValueError) as error:
            raise TransformerBenchmarkError(
                f"{record.lane.directory_name}/{record.artifact_id} holds a "
                f"promote line and its card cannot be read ({error}), so the "
                "estimator family that was promoted is unknown. Unverifiable is "
                "not the same as clean"
            ) from error
        family = _family_on(card)
        if family is None:
            raise TransformerBenchmarkError(
                f"{path} names no estimator_family, so the family that was "
                "promoted is unknown. The gate's second check reads that field, "
                "and a card without it cannot have passed it"
            )
        if family not in ESTIMATOR_ALLOW_LIST:
            raise TransformerBenchmarkError(
                f"{record.lane.directory_name} holds a promote line naming "
                f"{record.artifact_id}, whose estimator_family is {family!r} — "
                f"outside the gate's allow-list {sorted(ESTIMATOR_ALLOW_LIST)}. "
                "A benchmark is not a served model, and changing that is a "
                "change to the allow-list with a review rather than a promotion. "
                "Rolling this back is an append, not a delete"
            )


def _family_on(card: Mapping[str, Any]) -> str | None:
    """The card's ``identity.estimator_family``, or ``None`` when it has none."""
    identity = card.get("identity")
    if not isinstance(identity, dict):
        return None
    family = identity.get("estimator_family")
    return family if isinstance(family, str) else None


def _scored_fold(
    arm: str, hours: Sequence[ScoredHour], *, segment: FoldSegment
) -> ScoredFold:
    """One arm's row-identity claim, computed here and never supplied.

    The run name is the arm's family, so a
    :class:`~wattsteer_ml.evaluation.matrix.RowIdentityError` names the arm a
    reader can go and look at rather than an index.
    """
    return ScoredFold(
        run=arm,
        fold_id=segment.fold_id,
        fold_hash=segment.fold_hash,
        row_digest=row_set_digest(hour.key for hour in hours),
        row_count=len(hours),
    )


#: The sentence the ticket requires on every block this module writes, the
#: unmeasured one included.
_DECIDES_NOTHING = (
    f"The {BENCHMARK_ARM} arm is a benchmark and is never served. This block is "
    "evidence and not a decision: it holds no ordering, no delta and no "
    "preferred arm, and nothing in it is read by the hot-swap gate, by serving "
    f"or by the optimizer. The gate's second check refuses any candidate whose "
    f"estimator_family is outside {sorted(ESTIMATOR_ALLOW_LIST)}, so promoting "
    "this arm would take a change to that allow-list with a review — which is "
    "what 'we agreed it stays a benchmark' has to mean six months from now. "
    "assert_no_benchmark_promoted is the same statement about the volume."
)

#: What the block's ``reads`` field says when the arms came from real runs.
_READS = (
    "Two fold evaluations over identical folds and identical rows, differing "
    "only in the estimator family. Row identity is asserted by digest per fold "
    "segment, never by count. Both arms are scored by qloss_mwh through the "
    "same composition arithmetic, so the two figures are comparable; the block "
    "publishes them side by side and states no difference, because the only act "
    "this comparison could license is a promotion the gate refuses."
)

#: And what it says when they did not.
_NOT_A_READING = (
    "THESE FIGURES ARE NOT A MEASUREMENT OF THE GRID. The hours both arms were "
    "scored over were fabricated, so every qloss, PR-AUC and coverage here is "
    "arithmetic over invented labels. Only a block whose benchmark_source is "
    f"{FOLD_EVALUATION_SOURCE!r} says anything about how a transformer compares "
    "to the served model on the Brazilian system."
)

#: The composition sentence, which is the ticket's second box in prose.
_ONE_COMPOSITION = (
    "Both arms feed the same mixture inversion, with their own occurrence "
    "heads, and no bespoke band is published for the benchmark: the ladder "
    "compares models, not model families' conventions. That is checked rather "
    "than asserted — share_p50_zero is compared against "
    "mixture_regime.share_p50_forced_zero, which is the same quantity "
    "recomputed from p using the composition's own q <= 1 - p, and an arm whose "
    "band did not come through the service's one composition fails the check."
)

#: And when there were no arms at all.
_NOTHING_YET = (
    "The benchmark did not run. This is not a finding that the transformer ties "
    "with the served model and not a finding that it loses: the comparison is "
    "unmade rather than made and found uninteresting. No training time is "
    "recorded here either — the runtime of a run that did not happen is a "
    "measurement that does not exist, not a number to reason out."
)


__all__ = [
    "ARMS",
    "BENCHMARK_ARM",
    "BENCHMARK_FEATURE_SET",
    "BENCHMARK_GATE_PROFILE",
    "BENCHMARK_LANE",
    "CADENCE",
    "EXPLAINABILITY",
    "FOLD_EVALUATION_SOURCE",
    "NO_TFT_IMPLEMENTATION",
    "SERVED_ARM",
    "TRANSFORMER_BENCHMARK_BLOCK_KEY",
    "ArmRun",
    "BenchmarkArms",
    "BenchmarkFigures",
    "BenchmarkProvenance",
    "BenchmarkRow",
    "TrainingCost",
    "TransformerBenchmarkError",
    "TransformerBenchmarkReport",
    "UnmeasuredTransformerBenchmark",
    "assert_no_benchmark_promoted",
    "benchmark_rows",
    "record_transformer_benchmark",
    "unmeasured_for_want_of_an_implementation",
]
