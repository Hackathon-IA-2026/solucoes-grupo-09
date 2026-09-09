"""The weather lead-time A/B, measured where the harm was predicted.

`docs/specs/forecaster.md`, "The weather lead-time A/B", and
`docs/research/weather-lead-time.md`, which names this the acceptance test for
its own recommendation. Two arms, one evaluation set, three columns.

| Column | Trained on | Evaluated on |
|---|---|---|
| ``lead_matched`` (served) | Single Runs, D−1 12Z | Single Runs, D−1 12Z |
| ``archive_to_lead`` (control) | Historical Forecast archive | **Single Runs, D−1 12Z** |
| ``archive_to_archive`` | Historical Forecast archive | the archive — *not achievable* |

## Where the harm was predicted, and therefore where it is measured

The research predicts ``Δ qloss_mwh`` is the **smaller** effect. What it
actually predicts is a *dispersion* gap: 20–26% of the weather-driven variance a
model learns from the archive is absent at serve time, so an archive-trained
model has learned the weather feature is more trustworthy than it is and its
intervals should be too narrow and under-cover when evaluated lead-matched.

So an A/B that reported ``Δ qloss_mwh`` and left the interval metrics optional
would be capable of answering a question nobody asked. :class:`IntervalHarm` is
therefore **not optional anywhere**: :class:`ColumnDelta` requires one, and
:meth:`LeadTimePenalty.of` refuses a column whose
:attr:`~wattsteer_ml.evaluation.metrics.MetricsRow.coverage` is ``None`` or
whose conformal pair is absent. A segment with no curtailed hour cannot produce
a lead-time row at all, because on that segment the prediction under test is
unmeasurable and a point-only row would read as though it had been tested.

:attr:`ColumnDelta.verdict` states the finding either way. If coverage does not
degrade, the errors-in-variables argument did not survive the move from a linear
model to boosted trees — which the ticket names as the outcome worth knowing,
not as a failure.

## The third column, and why it is not a matrix row

:class:`~wattsteer_ml.evaluation.matrix.MatrixRun` deliberately has no field for
what a run is *evaluated* on: "a run cannot carry a private view of what it is
scored on". ``archive_to_archive`` is exactly a private view — it is scored on
features serving never provides — so it is not a row of the matrix and
:data:`COLUMN_DEFINITIONS` gives it no ``matrix_run``. It is reported because
the **gap between the two archive columns is the size of the leak in the
product's own metric**, which is the number worth putting in front of a human,
and :attr:`LeadTimePenalty.leak` is that gap on every reported figure.

All three columns are scored on the *same rows* —
:func:`~wattsteer_ml.evaluation.matrix.assert_identical_test_rows` over all
three, not only over the two achievable ones. That is what makes the gap a leak
measurement rather than a difference of populations: the rows are identical and
only the features under them differ.

## ``lead_time_source``, and the discipline it inherits

`diagnosis/background.py` stamps ``background_source``, `training/conformal.py`
stamps ``correction_regime``,
:mod:`~wattsteer_ml.evaluation.collapse_report` stamps ``collapse_source`` and
:mod:`~wattsteer_ml.evaluation.planning_arms` stamps ``arm_source``. This module
is the fifth, and the failure is the same: a ``Δ coverage_p10`` of −0.04 is a
plausible decimal computable from *any* two fixture arms, and it reads exactly
like a statement about what training on the archive costs the Brazilian grid's
forecast. :class:`LeadTimeProvenance` and :class:`AggregateCorrelation` are
therefore constructible only through ``.measured()`` or ``.fixture()``, and the
shared source constants are imported from
:mod:`~wattsteer_ml.evaluation.collapse_report` rather than respelt.

## The second experiment: the aggregate correlation

The research measured the train↔serve correlation **per centroid point** at
``r = 0.88`` and named that an *upper bound on the harm*, because WattSteer's
feature is a capacity-weighted average over 12–20 points and forecast errors are
spatially correlated but not perfectly. Aggregating will raise ``r``. Above
:data:`REVISION_THRESHOLD` the claimed gap should be revised downward and this
becomes a standing model-health metric rather than a one-off.

It runs here because it needs the centroids, and it needs no training at all:
two series, one correlation — and both of them are readable, by
:func:`~wattsteer_ml.weather_reads.measure_aggregate_correlation`, which builds
the archive series as the shortest-lead slice and hands the pair to
:meth:`AggregateCorrelation.measured`. So this half is measurable in principle
and merely unrun where no ingested weather window exists.
:func:`capacity_weighted_aggregate` does the
weighting and **does not compute the weights** — they are
``canonical_capacity_weight``'s, and a second implementation of a weight vector
is a thing that drifts away from the one the features are actually built with.
:class:`CapacityWeights` refuses a vector that does not sum to one, which is the
only property of that view this module is entitled to assume.

## What is not here, and why — and the two different reasons

**The A/B is unrun because the control arm's features have no expressible
shape.** This is not the reason this module first gave. It said "there is no
archive in Postgres", on the strength of
`apps/api/src/database/schema.ts` — ``weather_forecast_hour``'s own docstring,
"The stitched Historical Forecast archive is not stored here and is not what
this table holds" — and of `ingest/weather/single-runs.ts`, which put the
ingestion out of scope. That is still true of the *table*, and it is no longer
the operative reason, because the same decision records why: the archive is
bit-identical to ``_previous_day0``, the shortest-lead slice of each run, and
every run is stored whole. :mod:`~wattsteer_ml.weather_reads` recovers the
archive **series** from exactly that, so the weather is not what is missing.

What is missing is a *shape*. The archive is twenty-four publication cuts inside
one target day; ``feature_apply_gate`` writes one instant for the whole day and
``feature_rows`` accepts no instant at all, so no setting of the axes yields an
archive-built feature row, and widening the gate seam to provide one is the
train/serve skew `docs/specs/feature-engineering.md` exists to make unwritable.
So this block's honest value today is :class:`UnmeasuredLeadTime` carrying
:data:`ARCHIVE_FEATURES_HAVE_NO_SHAPE`.

**The correlation beside it is a different absence, and says so.** It needs no
feature row and no training run, and both its series are readable today, so
:data:`CORRELATION_NOT_RUN_YET` says "unrun", never "no data source" — the
distinction :mod:`~wattsteer_ml.evaluation.dessem_ab` drew when it refused to
borrow this module's sentence for a state it did not share.

All of it is written to the card rather than omitted, for the reason
:func:`~wattsteer_ml.evaluation.planning_arms.record_planning_arms` writes its
unmeasured sibling: a card with no lead-time block and a card naming what is
absent look identical to anybody grepping for the figure, and only one of them
is true.

**It does not run on the weekly retrain.** Nothing in
:mod:`~wattsteer_ml.evaluation.serving_lanes` or
:mod:`~wattsteer_ml.evaluation.gate` imports this module, and
`tests/test_weather_lead_time_ab.py` asserts that as an import-graph property
rather than as a convention. The block carries its own :data:`CADENCE` and the
fold calendar hash it was run against, so a card whose block predates the
current calendar is visibly stale instead of being silently refreshed by a
retrain that never re-ran it.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.caveated import CaveatedFigure
from wattsteer_ml.declined import DeclinedFigure
from wattsteer_ml.evaluation.collapse_report import (
    FIXTURE_SOURCE,
    UNMEASURED_SOURCE,
)
from wattsteer_ml.evaluation.matrix import (
    MATRIX_RUN_BY_NAME,
    ScoredFold,
    WeatherArm,
    assert_identical_test_rows,
)
from wattsteer_ml.evaluation.metrics import MetricsRow
from wattsteer_ml.evaluation.vintage import FoldSegment, assert_no_averaged_rows
from wattsteer_ml.lanes import Lane
from wattsteer_ml.training.bundle import read_card, write_card
from wattsteer_ml.training.conformal import TARGET_COVERAGE, CoverageReport

#: The card block the spec's model card names under "Experiments". Spelt as the
#: spec spells it, because the card is the published surface and a reader
#: grepping the spec must find the key.
LEAD_TIME_BLOCK_KEY = "lead_time_penalty"

#: How often the block is produced. `docs/specs/forecaster.md`: "Run on
#: ``dessem_free_v1`` at ``gate_late`` across all six folds, **once, not on
#: every retrain**." It costs one extra training run per fold, and nothing about
#: it changes between two retrains against the same calendar.
CADENCE = "once_per_fold_calendar"

#: The lane the experiment is run on. One feature set, one gate, and both are
#: the spec's: the free set because that is the product's actual set-A model,
#: and the late gate because that is where the D−1 12Z run exists at all.
EXPERIMENT_FEATURE_SET = "dessem_free_v1"
EXPERIMENT_GATE_PROFILE = "gate_late"

#: :attr:`LeadTimeProvenance.lead_time_source` when the columns came out of real
#: fold evaluations — three trainings per fold against real features. **The only
#: value that makes this block evidence about the grid.**
FOLD_EVALUATION_SOURCE = "fold_evaluation"

#: :attr:`AggregateCorrelation.correlation_source` when both series were built
#: from stored weather rows and the published capacity weights.
WEATHER_SERIES_SOURCE = "weather_forecast_hour"

#: The three columns. ``archive_to_archive`` is the overstated number the
#: research exists to prevent, and it is reported so the leak has a size.
LeadTimeColumn = Literal["lead_matched", "archive_to_lead", "archive_to_archive"]

#: What serving provides, trained on what serving provides. The baseline every
#: delta is against.
SERVED_COLUMN: LeadTimeColumn = "lead_matched"

#: The control: trained on the archive, **evaluated lead-matched**, because that
#: is what serving provides. The A/B's answer is this column minus the served one.
CONTROL_COLUMN: LeadTimeColumn = "archive_to_lead"

#: Trained and evaluated on the archive. Not achievable, reported anyway.
NOT_ACHIEVABLE_COLUMN: LeadTimeColumn = "archive_to_archive"

#: In the order the spec's table lists them, so two cards diff cleanly.
COLUMNS: tuple[LeadTimeColumn, ...] = (
    SERVED_COLUMN,
    CONTROL_COLUMN,
    NOT_ACHIEVABLE_COLUMN,
)

#: The per-point train↔serve correlation on ``wind_speed_120m`` at the D−1 12Z
#: run, from `docs/research/weather-lead-time.md` §"The measurement". It is the
#: figure the aggregate is compared against, and the research is explicit that
#: it is an **upper bound on the harm** rather than the harm.
PER_POINT_R = 0.8833

#: The research's own falsifier: "build the weighted aggregate for both series
#: and find r > 0.95, at which point 'accept and label' becomes defensible."
REVISION_THRESHOLD = 0.95

#: The variable the per-point figure was measured on. The aggregate must be the
#: same variable or the two numbers are not comparable, and
#: :meth:`AggregateCorrelation.measured` is where that is checked.
CORRELATION_VARIABLE = "wind_speed_120m"

#: Weights that sum to this far from 1.0 are refused. ``canonical_capacity_weight``
#: computes a share of located mass in double precision over up to twenty rows;
#: this is float slack, not a tolerance for a vector that is missing a centroid.
WEIGHT_SUM_TOLERANCE = 1e-9


class LeadTimeError(ValueError):
    """The columns cannot support the comparison that was asked for."""


@dataclass(frozen=True)
class ColumnDefinition:
    """One column: what it trained on, what it was scored on, and whether it is
    a thing the product could ever ship.

    ``matrix_run`` is ``None`` for exactly one column, and that is the whole
    reason this type exists rather than a fourth
    :class:`~wattsteer_ml.evaluation.matrix.MatrixRun`.
    """

    column: LeadTimeColumn
    trains_on: WeatherArm
    evaluates_on: WeatherArm
    #: The matrix row this column is, when it is one. ``None`` for
    #: ``archive_to_archive``, which is scored on features serving never
    #: provides and therefore cannot be a row of a matrix whose runs may not
    #: hold a private view of what they are scored on.
    matrix_run: str | None
    #: Whether a model behaving like this column could be served. Exactly one
    #: column says ``False``, and the card prints the label beside its numbers.
    achievable: bool
    #: The one-line label the card carries, so a reader of the JSON does not
    #: have to reconstruct the table from two enum values.
    label: str

    def __post_init__(self) -> None:
        if self.matrix_run is not None and self.matrix_run not in MATRIX_RUN_BY_NAME:
            raise LeadTimeError(
                f"{self.column}: {self.matrix_run!r} is not a run of the A/B matrix"
            )
        if self.achievable != (self.evaluates_on == "lead_matched"):
            raise LeadTimeError(
                f"{self.column}: a column is achievable exactly when it is "
                "evaluated lead-matched, because lead-matched features are what "
                "serving provides"
            )

    def card_fields(self) -> dict[str, Any]:
        return {
            "column": self.column,
            "trains_on": self.trains_on,
            "evaluates_on": self.evaluates_on,
            "matrix_run": self.matrix_run,
            "achievable": self.achievable,
            "label": self.label,
        }


#: The three columns as data. ``A-full`` and ``A-full-archive`` are the matrix's
#: own rows, named rather than respelt, so a rename in
#: :mod:`~wattsteer_ml.evaluation.matrix` breaks this table loudly.
COLUMN_DEFINITIONS: dict[LeadTimeColumn, ColumnDefinition] = {
    SERVED_COLUMN: ColumnDefinition(
        column=SERVED_COLUMN,
        trains_on="lead_matched",
        evaluates_on="lead_matched",
        matrix_run="A-full",
        achievable=True,
        label="lead-matched → lead-matched (served)",
    ),
    CONTROL_COLUMN: ColumnDefinition(
        column=CONTROL_COLUMN,
        trains_on="archive",
        evaluates_on="lead_matched",
        matrix_run="A-full-archive",
        achievable=True,
        label="archive → lead-matched (the control)",
    ),
    NOT_ACHIEVABLE_COLUMN: ColumnDefinition(
        column=NOT_ACHIEVABLE_COLUMN,
        trains_on="archive",
        evaluates_on="archive",
        matrix_run=None,
        achievable=False,
        label="archive → archive (NOT ACHIEVABLE)",
    ),
}


@dataclass(frozen=True)
class ArmColumn:
    """One column's whole evaluation, and its claim about what it was scored on.

    The metrics row is :class:`~wattsteer_ml.evaluation.metrics.MetricsRow`
    unchanged — ``qloss_mwh``, ``interval_width_mean_mwh``, the
    :class:`~wattsteer_ml.training.conformal.CoverageReport` and the conformal
    pair are all already columns of the table, so this experiment adds no metric
    definition of its own. Every figure it publishes is a difference of two
    numbers the metrics table already computes the same way for every run.
    """

    column: LeadTimeColumn
    metrics: MetricsRow
    #: What this column says it was scored on. Checked against the other
    #: columns' by :meth:`LeadTimePenalty.of`, never by this class alone: a row
    #: identity is a statement about a comparison and a single column has
    #: nothing to be identical to.
    scored: ScoredFold

    def __post_init__(self) -> None:
        if self.column not in COLUMN_DEFINITIONS:
            raise LeadTimeError(f"{self.column!r} is not a column of this experiment")
        if self.scored.fold_id != self.metrics.segment.fold_id:
            raise LeadTimeError(
                f"{self.column}: metrics for {self.metrics.segment.fold_id} filed "
                f"against rows of {self.scored.fold_id}"
            )
        if self.metrics.segment.fold_hash != self.scored.fold_hash:
            raise LeadTimeError(
                f"{self.column}: the metrics row and the scored rows name "
                f"{self.metrics.segment.fold_id} under two calendars "
                f"({self.metrics.segment.fold_hash} and {self.scored.fold_hash})"
            )

    @property
    def definition(self) -> ColumnDefinition:
        return COLUMN_DEFINITIONS[self.column]

    @property
    def coverage_p10(self) -> float:
        return _required_coverage(self).coverage_p10

    @property
    def coverage_p90(self) -> float:
        return _required_coverage(self).coverage_p90

    @property
    def delta_lo(self) -> float:
        return _required_correction(self, "delta_lo")

    @property
    def delta_hi(self) -> float:
        return _required_correction(self, "delta_hi")

    def card_entry(self) -> dict[str, Any]:
        """The column's own figures, point and interval, in one flat object."""
        return {
            **self.definition.card_fields(),
            "rows": self.metrics.rows,
            "qloss_mwh": self.metrics.qloss_mwh,
            "coverage_p10": self.coverage_p10,
            "coverage_p90": self.coverage_p90,
            "interval_width_mean_mwh": self.metrics.interval_width_mean_mwh,
            "delta_lo": self.delta_lo,
            "delta_hi": self.delta_hi,
            "row_digest": self.scored.row_digest,
        }


@dataclass(frozen=True)
class IntervalHarm:
    """The four interval figures the research predicted the harm would land in.

    Never optional, anywhere. `docs/specs/forecaster.md` names
    ``Δ coverage_p10``, ``Δ coverage_p90``, ``Δ interval_width_mean_mwh`` and
    ``Δ delta_lo`` as the place the effect is expected, and an A/B that could
    report a point delta without these would be capable of answering a question
    nobody asked.

    Every field is ``later − earlier``, so a **negative** coverage delta is the
    predicted direction (the archive arm under-covers) and a **negative** width
    delta is the predicted direction too (its intervals are too narrow).
    ``Δ delta_lo`` is the cleanest single expression of the effect: the
    correction is literally the amount by which the interval was wrong, so the
    predicted direction there is **positive** — the archive arm needs more of it.
    """

    delta_coverage_p10: float
    delta_coverage_p90: float
    delta_interval_width_mean_mwh: float
    delta_delta_lo: float
    delta_delta_hi: float

    @property
    def coverage_degraded(self) -> bool:
        """Either tail covering less than the column it is measured against."""
        return self.delta_coverage_p10 < 0.0 or self.delta_coverage_p90 < 0.0

    @property
    def intervals_narrowed(self) -> bool:
        """The mean band is narrower. Sharpness bought by under-covering."""
        return self.delta_interval_width_mean_mwh < 0.0

    @property
    def needs_more_correction(self) -> bool:
        """``δ_lo`` had to grow — the interval was wrong by that many MWh."""
        return self.delta_delta_lo > 0.0

    @property
    def landed_here(self) -> bool:
        """Whether the harm showed up where the research said it would.

        Coverage degrading *or* the correction growing. Either is the
        errors-in-variables effect; requiring both would let one noisy tail
        erase a finding.
        """
        return self.coverage_degraded or self.needs_more_correction

    def card_fields(self) -> dict[str, Any]:
        return {
            "delta_coverage_p10": self.delta_coverage_p10,
            "delta_coverage_p90": self.delta_coverage_p90,
            "delta_interval_width_mean_mwh": self.delta_interval_width_mean_mwh,
            "delta_delta_lo": self.delta_delta_lo,
            "delta_delta_hi": self.delta_delta_hi,
            "coverage_degraded": self.coverage_degraded,
            "intervals_narrowed": self.intervals_narrowed,
            "needs_more_correction": self.needs_more_correction,
            "landed_here": self.landed_here,
            "target_coverage": TARGET_COVERAGE,
        }

    @classmethod
    def of(cls, later: ArmColumn, earlier: ArmColumn) -> IntervalHarm:
        return cls(
            delta_coverage_p10=later.coverage_p10 - earlier.coverage_p10,
            delta_coverage_p90=later.coverage_p90 - earlier.coverage_p90,
            delta_interval_width_mean_mwh=(
                later.metrics.interval_width_mean_mwh
                - earlier.metrics.interval_width_mean_mwh
            ),
            delta_delta_lo=later.delta_lo - earlier.delta_lo,
            delta_delta_hi=later.delta_hi - earlier.delta_hi,
        )


@dataclass(frozen=True)
class ColumnDelta:
    """One column minus another, point **and** interval. Both, always.

    :attr:`interval` is a required field rather than an optional block, which is
    the whole shape of this ticket: an aggregate ``Δ qloss_mwh`` that improved
    while the interval metrics were unchanged has not answered the question the
    research asked.
    """

    of: LeadTimeColumn
    against: LeadTimeColumn
    delta_qloss_mwh: float
    interval: IntervalHarm

    def __post_init__(self) -> None:
        if self.of == self.against:
            raise LeadTimeError(f"{self.of} against itself is not a delta")

    @property
    def verdict(self) -> str:
        """What this delta says, in the sentence the ticket asks for either way."""
        if self.interval.landed_here:
            return _HARM_LANDED
        return _HARM_DID_NOT_LAND

    @classmethod
    def between(cls, later: ArmColumn, earlier: ArmColumn) -> ColumnDelta:
        return cls(
            of=later.column,
            against=earlier.column,
            delta_qloss_mwh=later.metrics.qloss_mwh - earlier.metrics.qloss_mwh,
            interval=IntervalHarm.of(later, earlier),
        )

    def card_fields(self) -> dict[str, Any]:
        return {
            "of": self.of,
            "against": self.against,
            "delta_qloss_mwh": self.delta_qloss_mwh,
            "verdict": self.verdict,
            **self.interval.card_fields(),
        }


@dataclass(frozen=True)
class LeadTimePenalty:
    """One fold segment's three columns, the A/B's answer, and the leak's size.

    Built through :meth:`of`, which asserts row identity across all three
    columns before computing anything. The digest is the assertion's return
    value rather than a field a caller supplies, so a penalty cannot name a row
    set it did not check.
    """

    segment: FoldSegment
    row_digest: str
    columns: tuple[ArmColumn, ...]
    #: ``archive_to_lead − lead_matched``. **The A/B's answer**: what training on
    #: the archive costs, measured on the features serving actually provides.
    harm: ColumnDelta
    #: ``archive_to_archive − archive_to_lead``. The gap between the two archive
    #: columns, which is the size of the leak in the product's own metric.
    leak: ColumnDelta

    @property
    def fidelity(self) -> VintageFidelity:
        return self.segment.fidelity

    def column(self, name: LeadTimeColumn) -> ArmColumn:
        for entry in self.columns:
            if entry.column == name:
                return entry
        raise LeadTimeError(f"{self.segment.row_id}: no {name!r} column here")

    @classmethod
    def of(cls, segment: FoldSegment, columns: Sequence[ArmColumn]) -> LeadTimePenalty:
        """The three columns, checked, differenced and stated.

        Raises when a column is missing, doubled, scored on different rows, or
        cannot produce an interval figure — the last because a point-only
        lead-time row would read as though the prediction under test had been
        tested.
        """
        by_name = {entry.column: entry for entry in columns}
        if len(by_name) != len(columns):
            raise LeadTimeError(
                f"{segment.row_id}: a column appears twice in "
                f"{[entry.column for entry in columns]!r}"
            )
        missing = [name for name in COLUMNS if name not in by_name]
        if missing:
            raise LeadTimeError(
                f"{segment.row_id}: the comparison needs all three columns and "
                f"has no {missing!r}. The third one is not decoration: without it "
                "the leak in the product's own metric has no size."
            )
        for entry in by_name.values():
            if entry.metrics.segment != segment:
                raise LeadTimeError(
                    f"{entry.column}: scored on {entry.metrics.segment.row_id} and "
                    f"filed under {segment.row_id}"
                )
            _required_coverage(entry)
            _required_correction(entry, "delta_lo")
            _required_correction(entry, "delta_hi")
        ordered = tuple(by_name[name] for name in COLUMNS)
        digest = assert_identical_test_rows([entry.scored for entry in ordered])
        return cls(
            segment=segment,
            row_digest=digest,
            columns=ordered,
            harm=ColumnDelta.between(by_name[CONTROL_COLUMN], by_name[SERVED_COLUMN]),
            leak=ColumnDelta.between(
                by_name[NOT_ACHIEVABLE_COLUMN], by_name[CONTROL_COLUMN]
            ),
        )

    def card_entry(self) -> dict[str, Any]:
        return {
            "row_id": self.segment.row_id,
            "fold_id": self.segment.fold_id,
            "vintage_fidelity": self.fidelity,
            "segment_hash": self.segment.segment_hash,
            "test_start": self.segment.test_start.isoformat(),
            "test_end": self.segment.test_end.isoformat(),
            "row_digest": self.row_digest,
            "columns": [entry.card_entry() for entry in self.columns],
            "harm": self.harm.card_fields(),
            "leak": self.leak.card_fields(),
        }


@dataclass(frozen=True)
class CapacityWeights:
    """One scope's centroid weights, as ``canonical_capacity_weight`` holds them.

    **Not computed here.** The view is the authority — it is the double as-of
    read the features themselves are built with, and a second implementation of
    a weight vector is a thing that drifts away from the one the model actually
    saw. The one property this module asserts is the one the view guarantees:
    "a scope's weights sum to 1".
    """

    #: ``centroid_set_v1``. A literal on the row rather than "whichever set
    #: happens to be loaded", exactly as the view spells it.
    set_version: str
    #: ``NE/wind``, ``SE/solar`` — the subsystem-technology scope the weights
    #: are a share of. One string, because this module never splits it.
    scope: str
    weights: Mapping[str, float]

    def __post_init__(self) -> None:
        if not self.weights:
            raise LeadTimeError(
                f"{self.scope}: a scope with no located capacity has no weight "
                "vector, and an even spread over the frozen points would be a "
                "fabricated location"
            )
        total = math.fsum(self.weights.values())
        if abs(total - 1.0) > WEIGHT_SUM_TOLERANCE:
            raise LeadTimeError(
                f"{self.scope}: weights sum to {total!r}, not 1.0; this is a "
                "partial vector rather than a scope's share of located mass"
            )


def capacity_weighted_aggregate(
    readings: Mapping[str, float], weights: CapacityWeights
) -> float:
    """The feature's own aggregate: ``Σ weight_c · value_c`` over one scope.

    Every centroid of the vector must have a reading. A weighted mean over the
    subset that happened to be present is a mean over a *different* fleet, and
    the resulting correlation would be between two aggregates of two different
    regions rather than between two forecasts of one.
    """
    absent = sorted(set(weights.weights) - set(readings))
    if absent:
        raise LeadTimeError(
            f"{weights.scope}: no reading at {absent!r}; a weighted mean over the "
            "centroids that happened to be present aggregates a different fleet"
        )
    return math.fsum(
        weight * readings[centroid] for centroid, weight in weights.weights.items()
    )


def pearson_r(xs: Sequence[float], ys: Sequence[float]) -> float:
    """Pearson correlation of two aligned series.

    Raises on a constant series rather than returning ``0.0``: a correlation
    with something that does not vary is undefined, and a zero in that slot
    would read as "these forecasts are unrelated", which is the opposite of what
    a flat series means.
    """
    if len(xs) != len(ys):
        raise LeadTimeError(
            f"a correlation over {len(xs)} points against {len(ys)}; the two "
            "series are the same hours seen two ways or they are not a pair"
        )
    if len(xs) < 2:
        raise LeadTimeError("a correlation over fewer than two points")
    mean_x = math.fsum(xs) / len(xs)
    mean_y = math.fsum(ys) / len(ys)
    dx = [value - mean_x for value in xs]
    dy = [value - mean_y for value in ys]
    var_x = math.fsum(value * value for value in dx)
    var_y = math.fsum(value * value for value in dy)
    if var_x <= 0.0 or var_y <= 0.0:
        raise LeadTimeError(
            "a correlation against a constant series is undefined, and 0.0 would "
            "read as 'unrelated' rather than 'did not vary'"
        )
    return math.fsum(a * b for a, b in zip(dx, dy, strict=True)) / math.sqrt(
        var_x * var_y
    )


@dataclass(frozen=True)
class AggregateCorrelation:
    """The second experiment: ``r`` on the real capacity-weighted aggregate.

    Constructed through :meth:`measured` or :meth:`fixture`, so
    ``correlation_source`` cannot be set to :data:`WEATHER_SERIES_SOURCE` by a
    caller that did not read a weather row. It is
    :class:`LeadTimeProvenance`'s discipline applied to the figure beside it,
    and the two share their source constants for the reason the collapse and
    planning-arm blocks do.
    """

    correlation_source: str
    variable: str
    scope: str
    set_version: str
    points: int
    #: The research's per-point figure, carried so the comparison is on the card
    #: rather than in a reader's memory. It is an **upper bound on the harm**.
    per_point_r: float
    aggregate_r: float

    def __post_init__(self) -> None:
        if not -1.0 <= self.aggregate_r <= 1.0:
            raise LeadTimeError(f"{self.aggregate_r!r} is not a correlation")
        if self.points < 2:
            raise LeadTimeError("a correlation over fewer than two points")

    @property
    def is_measurement(self) -> bool:
        return self.correlation_source == WEATHER_SERIES_SOURCE

    @property
    def revises_the_gap_downward(self) -> bool:
        """The research's falsifier, evaluated. ``r > 0.95`` on the aggregate."""
        return self.aggregate_r > REVISION_THRESHOLD

    @property
    def aggregation_raised_r(self) -> bool:
        """Whether aggregation moved ``r`` the way spatial correlation predicts."""
        return self.aggregate_r > self.per_point_r

    @classmethod
    def measured(
        cls,
        *,
        pairs: Sequence[tuple[float, float]],
        variable: str,
        weights: CapacityWeights,
    ) -> AggregateCorrelation:
        """``r`` over aggregates built from stored weather rows.

        ``pairs`` are ``(archive_aggregate, lead_matched_aggregate)`` per valid
        hour, both already through :func:`capacity_weighted_aggregate` with the
        same ``weights``, because a correlation between an aggregate and a point
        is not the quantity the research left open.
        """
        if variable != CORRELATION_VARIABLE:
            raise LeadTimeError(
                f"the per-point figure {PER_POINT_R!r} was measured on "
                f"{CORRELATION_VARIABLE!r}; an aggregate on {variable!r} is not "
                "comparable with it and must not be published beside it"
            )
        return cls(
            correlation_source=WEATHER_SERIES_SOURCE,
            variable=variable,
            scope=weights.scope,
            set_version=weights.set_version,
            points=len(pairs),
            per_point_r=PER_POINT_R,
            aggregate_r=pearson_r(
                [archive for archive, _ in pairs],
                [served for _, served in pairs],
            ),
        )

    @classmethod
    def fixture(
        cls, *, scope: str, set_version: str, points: int, aggregate_r: float
    ) -> AggregateCorrelation:
        """The stamp for an ``r`` computed over fabricated series.

        Named rather than left to a default, because the default is the value
        that would do damage: an ``r`` of 0.97 over invented weather retires the
        research's headline claim on the strength of nothing.
        """
        return cls(
            correlation_source=FIXTURE_SOURCE,
            variable=CORRELATION_VARIABLE,
            scope=scope,
            set_version=set_version,
            points=points,
            per_point_r=PER_POINT_R,
            aggregate_r=aggregate_r,
        )

    def card_fields(self) -> dict[str, Any]:
        return {
            "measured": self.is_measurement,
            "correlation_source": self.correlation_source,
            "variable": self.variable,
            "scope": self.scope,
            "centroid_set_version": self.set_version,
            "points": self.points,
            "per_point_r": self.per_point_r,
            "aggregate_r": self.aggregate_r,
            "revision_threshold": REVISION_THRESHOLD,
            "aggregation_raised_r": self.aggregation_raised_r,
            "revises_the_gap_downward": self.revises_the_gap_downward,
            "reads": (
                _R_REVISES if self.revises_the_gap_downward else _R_DOES_NOT_REVISE
            ),
        }


@dataclass(frozen=True)
class LeadTimeProvenance:
    """What the three columns are columns *of*. Travels with them, never optional.

    Constructed through :meth:`measured` or :meth:`fixture` rather than by
    field, so ``lead_time_source`` cannot be set to
    :data:`FOLD_EVALUATION_SOURCE` by a caller that trained nothing.
    """

    lead_time_source: str
    lane: Lane
    #: The fold calendar the three columns share. On the block because the
    #: experiment is run once per calendar and a block naming an older hash is
    #: a stale block rather than a current one.
    fold_calendar_hash: str | None
    #: When the evaluation ran. ``None`` for fixtures, which ran against nothing.
    as_of: datetime | None
    #: The fold-evaluation run behind the columns. ``None`` for fixtures.
    run_label: str | None

    def __post_init__(self) -> None:
        if self.lane.feature_set != EXPERIMENT_FEATURE_SET:
            raise LeadTimeError(
                f"the lead-time A/B is run on {EXPERIMENT_FEATURE_SET!r} "
                f"(`docs/specs/forecaster.md`), not {self.lane.feature_set!r}"
            )
        if self.lane.gate_profile != EXPERIMENT_GATE_PROFILE:
            raise LeadTimeError(
                f"the lead-time A/B is run at {EXPERIMENT_GATE_PROFILE!r}, which is "
                "where the D−1 12Z run exists at all, not "
                f"{self.lane.gate_profile!r}"
            )

    @property
    def is_measurement(self) -> bool:
        """Whether this block is evidence about the grid. One predicate."""
        return self.lead_time_source == FOLD_EVALUATION_SOURCE

    @classmethod
    def measured(
        cls,
        *,
        lane: Lane,
        fold_calendar_hash: str,
        as_of: datetime,
        run_label: str,
    ) -> LeadTimeProvenance:
        """The stamp for columns produced by three real fold evaluations."""
        return cls(
            lead_time_source=FOLD_EVALUATION_SOURCE,
            lane=lane,
            fold_calendar_hash=fold_calendar_hash,
            as_of=as_of,
            run_label=run_label,
        )

    @classmethod
    def fixture(cls, *, lane: Lane) -> LeadTimeProvenance:
        """The stamp for columns built on fabricated metrics rows.

        Every test in this repository builds this one, and it is named rather
        than defaulted because the default is the value that would do damage.
        """
        return cls(
            lead_time_source=FIXTURE_SOURCE,
            lane=lane,
            fold_calendar_hash=None,
            as_of=None,
            run_label=None,
        )

    def card_fields(self) -> dict[str, Any]:
        return {
            "measured": self.is_measurement,
            "lead_time_source": self.lead_time_source,
            "cadence": CADENCE,
            "lane": self.lane.directory_name,
            "feature_set": self.lane.feature_set,
            "gate_profile": self.lane.gate_profile,
            "threshold_mw": self.lane.threshold_mw,
            "fold_calendar_hash": self.fold_calendar_hash,
            "run_label": self.run_label,
            "as_of": None if self.as_of is None else self.as_of.isoformat(),
        }


@dataclass(frozen=True)
class LeadTimeReport:
    """The whole experiment: three columns per fold segment, and the correlation.

    Never pooled across segments, for the reason
    :mod:`~wattsteer_ml.evaluation.metrics` and
    :mod:`~wattsteer_ml.evaluation.planning_arms` do not pool: a
    `revision_optimistic` quarter's coverage delta averaged into a
    `point_in_time` one is a number whose caveat cannot be recovered.
    """

    provenance: LeadTimeProvenance
    penalties: tuple[LeadTimePenalty, ...]
    #: The second experiment. ``None`` when it was not run — it needs no
    #: training and is cheap, and both its series are readable, so its absence
    #: is :data:`CORRELATION_NOT_RUN_YET` and never the A/B's own reason.
    correlation: AggregateCorrelation | None = None

    def __post_init__(self) -> None:
        if not self.penalties:
            raise LeadTimeError(
                "a lead-time report with no fold segment; an absent comparison is "
                "UnmeasuredLeadTime, which carries a reason instead of no rows"
            )
        seen = [penalty.segment.row_id for penalty in self.penalties]
        if len(set(seen)) != len(seen):
            raise LeadTimeError(f"a fold segment is reported twice: {sorted(seen)!r}")
        assert_no_averaged_rows([penalty.segment for penalty in self.penalties])

    @property
    def lane(self) -> Lane:
        return self.provenance.lane

    @property
    def fidelities(self) -> tuple[VintageFidelity, ...]:
        seen: list[VintageFidelity] = []
        for penalty in self.penalties:
            if penalty.fidelity not in seen:
                seen.append(penalty.fidelity)
        return tuple(seen)

    @property
    def harm_landed_where_predicted(self) -> tuple[str, ...]:
        """The segments where the interval harm showed up. Possibly empty.

        Empty is a finding rather than a failure: the research's
        errors-in-variables argument was made about a linear model, and a
        boosted-tree model that does not reproduce it has told us something.
        """
        return tuple(
            penalty.segment.row_id
            for penalty in self.penalties
            if penalty.harm.interval.landed_here
        )

    def card_block(self) -> dict[str, Any]:
        """The block, under :data:`LEAD_TIME_BLOCK_KEY`.

        ``reads`` is prose and always present, because the two things a reader
        of this block must not do are take a fixture-stamped coverage delta for
        a statement about the grid, and read the ``archive → archive`` column as
        a number the product could ship.
        """
        block: dict[str, Any] = {
            **self.provenance.card_fields(),
            "reads": _READS if self.provenance.is_measurement else _NOT_A_READING,
            "not_achievable_column": NOT_ACHIEVABLE_COLUMN,
            "vintage_fidelities": list(self.fidelities),
            "harm_landed_where_predicted": list(self.harm_landed_where_predicted),
            "folds": [penalty.card_entry() for penalty in self.penalties],
        }
        block["aggregate_correlation"] = (
            None if self.correlation is None else self.correlation.card_fields()
        )
        block["aggregate_correlation_reason"] = (
            CORRELATION_NOT_RUN_YET if self.correlation is None else None
        )
        if "point_in_time" not in self.fidelities:
            block["vintage_caveat"] = _REVISION_OPTIMISTIC_ONLY
        return {LEAD_TIME_BLOCK_KEY: block}


@dataclass(frozen=True)
class UnmeasuredLeadTime:
    """No columns, and the sentence saying why — the shape of an absent A/B.

    This is the value the repository produces **today**, and
    :data:`ARCHIVE_FEATURES_HAVE_NO_SHAPE` is why: the control arm trains on the
    stitched Historical Forecast archive, and while
    :mod:`~wattsteer_ml.weather_reads` recovers that archive as a *series*, no
    setting of the feature axes turns twenty-four publication cuts inside one
    target day into a feature row.

    Three equal columns would say training on the archive costs nothing, and
    three zeroed ones would say the model forecasts nothing. Both are readings
    of an absent arm, and neither is a thing anybody may decide on. So this
    value has no field that could be mistaken for a figure — except
    :attr:`correlation`, which is a **different experiment** with a source of
    its own and is carried when it was made.

    That field is the only home the correlation needs and no new one is added
    beside it: it was put here for exactly this case, back when the case was
    hypothetical. What it did not have was a sentence for its own absence, and
    :data:`CORRELATION_NOT_RUN_YET` is that sentence — the block therefore says
    two things, because two different absences are being reported.
    """

    lane: Lane
    as_of: datetime
    reason: str
    correlation: AggregateCorrelation | None = None
    lead_time_source: str = UNMEASURED_SOURCE

    @property
    def is_measurement(self) -> bool:
        return False

    def card_block(self) -> dict[str, Any]:
        return {
            LEAD_TIME_BLOCK_KEY: {
                "measured": False,
                "lead_time_source": self.lead_time_source,
                "cadence": CADENCE,
                "lane": self.lane.directory_name,
                "as_of": self.as_of.isoformat(),
                "reason": self.reason,
                "reads": _NOTHING_YET,
                "not_achievable_column": NOT_ACHIEVABLE_COLUMN,
                "aggregate_correlation": (
                    None if self.correlation is None else self.correlation.card_fields()
                ),
                "aggregate_correlation_reason": (
                    CORRELATION_NOT_RUN_YET if self.correlation is None else None
                ),
            }
        }


def unmeasured_for_want_of_archive_features(
    *, lane: Lane, as_of: datetime, correlation: AggregateCorrelation | None = None
) -> UnmeasuredLeadTime:
    """The A/B that cannot be run, named as the one thing that is missing.

    A named constructor rather than a caller-supplied reason string, so the
    sentence on every card is the same sentence and a reader comparing two cards
    is comparing two states rather than two phrasings.

    **Features, not an archive.** The archive weather is recoverable and
    :mod:`~wattsteer_ml.weather_reads` recovers it; what has no shape is the
    feature row built from it. Pass ``correlation`` when the second experiment
    *was* run — the block then reports one absence and one measurement instead
    of one sentence covering both.
    """
    return UnmeasuredLeadTime(
        lane=lane,
        as_of=as_of,
        reason=ARCHIVE_FEATURES_HAVE_NO_SHAPE,
        correlation=correlation,
    )


def record_lead_time_penalty(
    report: LeadTimeReport | UnmeasuredLeadTime, *, root: Path, artifact_id: str
) -> Path:
    """Write the block onto a card, under :data:`LEAD_TIME_BLOCK_KEY`.

    An edit of a card already on the volume, through the one reader and the one
    writer :func:`~wattsteer_ml.evaluation.gate.record_decision` and
    :func:`~wattsteer_ml.evaluation.planning_arms.record_planning_arms` use, so
    the blocks cannot disagree about what a card is.

    **An** :class:`UnmeasuredLeadTime` **is written too.** A card with no
    lead-time block and a card saying "the control arm has no data source" look
    identical to anybody grepping for the figure, and only one of them is true.
    """
    path = root / report.lane.directory_name / f"{artifact_id}{CARD_SUFFIX}"
    card = read_card(path)
    write_card(path, {**card, **report.card_block()})
    return path


def carry_forward(previous: Mapping[str, Any]) -> dict[str, Any] | None:
    """The block a previous card carried, for a retrain that must not re-run it.

    `docs/specs/forecaster.md` runs this experiment **once, not on every
    retrain**, and a weekly artifact still has to publish it or the figure
    disappears from the card the moment a model is swapped. So the block travels
    with the lane rather than being recomputed: this returns the previous card's
    block unchanged, and ``None`` when there was none.

    It is deliberately a copy and not a refresh. The block names the fold
    calendar hash it was measured against, so a reader can see that it predates
    the current calendar; silently recomputing it here is exactly the thing the
    cadence forbids.
    """
    block = previous.get(LEAD_TIME_BLOCK_KEY)
    if block is None:
        return None
    if not isinstance(block, dict):
        raise LeadTimeError(
            f"{LEAD_TIME_BLOCK_KEY!r} on the previous card is a "
            f"{type(block).__name__}, not a block"
        )
    return {LEAD_TIME_BLOCK_KEY: dict(block)}


def _required_coverage(entry: ArmColumn) -> CoverageReport:
    coverage = entry.metrics.coverage
    if coverage is None:
        raise LeadTimeError(
            f"{entry.column} on {entry.metrics.segment.row_id} has no coverage "
            "report, because the segment holds no curtailed hour. The harm this "
            "experiment exists to measure is an interval harm, so a segment that "
            "cannot produce coverage cannot produce a lead-time row — a point-only "
            "row would read as though the prediction under test had been tested."
        )
    return coverage


def _required_correction(entry: ArmColumn, field: str) -> float:
    value = getattr(entry.metrics, field)
    if value is None:
        raise LeadTimeError(
            f"{entry.column} on {entry.metrics.segment.row_id} was scored without "
            f"a conformal {field}. Δ delta_lo is the cleanest single expression of "
            "the effect — the correction is literally the amount by which the "
            "interval was wrong — so an unconformalised column is not one of the "
            "two arms this A/B compares."
        )
    return float(value)


#: Why **the A/B** is unmeasured today, in one sentence, on every card. It
#: replaced an earlier sentence that named a missing ingestion, which
#: :mod:`~wattsteer_ml.weather_reads` made the wrong sentence for this half:
#: the archive series is recoverable and the archive *feature row* is not.
ARCHIVE_FEATURES_HAVE_NO_SHAPE = DeclinedFigure(
    "The control arm trains on the stitched Historical Forecast archive, and "
    "this repository cannot build a feature row from it. Not for want of the "
    "weather: `wattsteer_ml.weather_reads` recovers the archive series out of "
    "the runs already stored, because the stitch is bit-identical to the "
    "shortest-lead slice of each run and every run is stored whole. What is "
    "missing is a shape. The archive is twenty-four publication cuts inside one "
    "target day; `feature_apply_gate` writes one instant for a whole target day "
    "and `feature_rows` accepts no instant at all, so no setting of the axes "
    "yields an archive-built feature row. Providing one would mean a second "
    "weather read axis inside the feature spine — the train/serve skew the "
    "feature spec exists to make unwritable — or a parallel feature builder, "
    "which is a second definition of the vector. So the A/B is unrun rather "
    "than run and found uninteresting: the comparison, the row-identity "
    "assertion and the interval deltas are built and tested, and what is "
    "missing is a shape no ingestion ticket would supply.",
    figure=(
        "the weather lead-time A/B's control arm, and the three interval deltas over it"
    ),
    kind="unrunnable",
    surface="the model card's `lead_time_penalty` block, `reason`",
)

#: Why **the aggregate correlation** is absent when it is absent, which is a
#: different thing and must not read like the sentence above. The discipline is
#: :data:`~wattsteer_ml.evaluation.dessem_ab.NOT_RUN_YET`'s, and it is borrowed
#: rather than restated: that block chose its own words precisely so it would
#: not read as this module's "no data source", and this half is now in its
#: position rather than in the A/B's.
CORRELATION_NOT_RUN_YET = DeclinedFigure(
    "The aggregate correlation was not computed for this card. This is not a "
    "missing data source and not a finding that aggregation leaves r where the "
    "per-point figure put it: both series are readable — "
    "`wattsteer_ml.weather_reads` builds the archive arm as the shortest-lead "
    "slice and the served arm at the gate, out of stored weather versions and "
    "the published capacity weights — so this half is unrun rather than "
    "unrunnable. What it needs is an ingested weather window on a migrated "
    "database, which the offline card writer does not have, and a figure "
    "produced without one would be a fixture rather than a measurement.",
    figure="the aggregate train/serve weather correlation",
    kind="unrun",
    surface=(
        "the model card's `lead_time_penalty` block, `aggregate_correlation_reason`"
    ),
)

#: When the interval harm showed up where the research said it would.
_HARM_LANDED = (
    "The harm landed where the research predicted: coverage degraded, the "
    "conformal correction grew, or both. An archive-trained model has learned "
    "that the weather feature is more trustworthy than it is, and the interval "
    "is where that shows."
)

#: And when it did not, which is a finding rather than a failure.
_HARM_DID_NOT_LAND = (
    "The harm did not land in the interval metrics. The errors-in-variables "
    "argument was made about a linear model, and it did not survive the move to "
    "boosted trees on this segment. That is worth knowing, and it is not a "
    "reason to read the point delta as the whole answer."
)

#: What the block's ``reads`` field says when the columns came from real runs.
_READS = (
    "Three fold evaluations on identical test rows: the same model trained on "
    "lead-matched weather and on the archive, both evaluated on the lead-matched "
    "features serving provides, plus the archive-trained model evaluated on "
    "archive features. The third column is NOT ACHIEVABLE and is reported "
    "because the gap between the two archive columns is the size of the leak in "
    "the product's own metric. Δ qloss_mwh is the point-forecast harm and the "
    "research predicts it is the smaller effect; the interval deltas beside it "
    "are where the harm was predicted to land and are the answer this "
    "experiment exists for."
)

#: And what it says when they did not. Same field, so a reader who reaches the
#: numbers has already read this.
_NOT_A_READING = CaveatedFigure(
    "THESE DELTAS ARE NOT A MEASUREMENT OF THE GRID. The columns were built from "
    "fabricated metrics rows, so every coverage and MWh figure here is "
    "arithmetic over invented forecasts. Only a block whose lead_time_source is "
    f"{FOLD_EVALUATION_SOURCE!r} says anything about what training on the "
    "weather archive would cost, and no weather decision may be taken on this "
    "one.",
    figure=(
        "the lead-time A/B's three interval deltas and its delta qloss_mwh, "
        "on a block whose columns were built from fabricated metrics rows"
    ),
    misreading=(
        "that training on the stitched weather archive costs the served "
        "interval this much on the Brazilian grid"
    ),
    surface=(
        "the model card's `lead_time_penalty` block, `reads` -- the field a "
        "reader meets before the folds"
    ),
)

#: And when there were no columns at all.
_NOTHING_YET = (
    "The A/B did not run. This is not a finding of no harm and not a tie "
    "between the arms: the control arm's training features have no expressible "
    "shape here, so the comparison is unmade rather than made and found "
    "uninteresting. It says nothing about the aggregate correlation beside it, "
    "which is a second experiment with a source of its own — read "
    "aggregate_correlation, and aggregate_correlation_reason when it is absent."
)

#: On a block whose every segment predates ingestion go-live.
_REVISION_OPTIMISTIC_ONLY = CaveatedFigure(
    "Every fold segment here is revision_optimistic: no reported segment's test "
    "period begins after ingestion go-live. All three columns were scored "
    "against labels that have since been revised, so this block may not carry "
    "the weather decision until a point_in_time segment exists.",
    figure=(
        "every coverage and MWh figure in the lead-time A/B, on a block "
        "none of whose fold segments begins after ingestion go-live"
    ),
    misreading=(
        "that the three columns were scored against the labels the product "
        "will be judged on"
    ),
    surface="the model card's `lead_time_penalty` block, `vintage_caveat`",
)

#: When the aggregate cleared the research's own falsifier.
_R_REVISES = (
    "The capacity-weighted aggregate clears the research's falsifier of r > "
    "0.95, so the per-point figure overstated the harm and the claimed size of "
    "the gap should be revised downward. This becomes a standing model-health "
    "metric rather than a one-off."
)

#: And when it did not.
_R_DOES_NOT_REVISE = (
    "The capacity-weighted aggregate did not clear r > 0.95, so the research's "
    "claimed gap stands as measured. The per-point figure remains an upper bound "
    "on the harm and the aggregate is the number to quote."
)


__all__ = [
    "ARCHIVE_FEATURES_HAVE_NO_SHAPE",
    "CADENCE",
    "COLUMNS",
    "COLUMN_DEFINITIONS",
    "CONTROL_COLUMN",
    "CORRELATION_NOT_RUN_YET",
    "CORRELATION_VARIABLE",
    "EXPERIMENT_FEATURE_SET",
    "EXPERIMENT_GATE_PROFILE",
    "FOLD_EVALUATION_SOURCE",
    "LEAD_TIME_BLOCK_KEY",
    "NOT_ACHIEVABLE_COLUMN",
    "PER_POINT_R",
    "REVISION_THRESHOLD",
    "SERVED_COLUMN",
    "WEATHER_SERIES_SOURCE",
    "WEIGHT_SUM_TOLERANCE",
    "AggregateCorrelation",
    "ArmColumn",
    "CapacityWeights",
    "ColumnDefinition",
    "ColumnDelta",
    "IntervalHarm",
    "LeadTimeColumn",
    "LeadTimeError",
    "LeadTimePenalty",
    "LeadTimeProvenance",
    "LeadTimeReport",
    "UnmeasuredLeadTime",
    "capacity_weighted_aggregate",
    "carry_forward",
    "pearson_r",
    "record_lead_time_penalty",
    "unmeasured_for_want_of_archive_features",
]
