"""Where the served median sits high: the P50 rail, cut every way the data allows.

`gate_late` was refused on ``p50_unbiasedness_in_band`` at 0.5553 against
``[0.45, 0.55]``: the label fell *below* the served P50 on 55.5% of the curtailed
hours whose P50 is a number the label could fall under. That is one figure over
3,364 hours, and it cannot say whether the median is a little high everywhere or
a lot high somewhere. Nothing on the volume can answer that, because the retrain
scores the hours, hands them to the gate and discards them.

This driver keeps them long enough to cut the rail by subsystem, local hour,
month and occurrence-probability bin, and to say how far off the median is in
the units a correction would use: the median of ``observed / P50``.

**It changes nothing and decides nothing.** No bundle is saved, nothing is
appended to ``promotions.jsonl``, and no field of the report names a fix. The
median gets no correction by design (`training/conformal.py`, "The median gets
no correction"), so a reading here is evidence for a *spec* discussion and not an
input to one. The only file it writes is the report, under
``experiments/p50_bias/``, through :mod:`wattsteer_ml.experiment_reports`.

**The gate's own figure is the anchor.** ``gate_reading`` is
:func:`~wattsteer_ml.evaluation.gate.p50_band_unbiasedness` called on the same
hours, and the overall cell is asserted equal to it, so a cell that disagrees
with the gate is a bug here and not a second opinion.

**A cell is a reading, not a verdict.** Each carries its row count, a
day-cluster standard error (hours inside one day are not independent, exactly as
in the gate's P10 rail) and a ``thin`` flag under :data:`THIN_CELL_ROWS`. The
flag is a reading aid this module chose; it is not a threshold the gate uses.
Twenty-four hourly cells and four subsystems will throw up one that looks
extreme by chance, and the report says how many rows stand behind each so that
is visible.

**Every reportable fold, not only the live edge.** F6 is the deciding fold and
it is still growing, so a bias that appears only there is a fact about a recent
regime and one that appears in F1–F5 too is a fact about the model. The fits are
the retrain's own (:func:`~wattsteer_ml.training.train_fold` on the lane's
matrix arm), with no artifact written.

**No quantile is added anywhere.** A cell is a count of hours on one side of a
served P50 and a median of a ratio; neither sums a band across subsystems.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import statistics
import sys
from collections import defaultdict
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from typing import Any, Protocol

import asyncpg

from wattsteer_ml.config import settings
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import materialize_fold_calendar
from wattsteer_ml.evaluation.gate import (
    BAND_MEDIAN_RAIL,
    P50_UNBIASEDNESS_WINDOW,
    p50_band_unbiasedness,
    states_a_falsifiable_median,
)
from wattsteer_ml.evaluation.ladder import FoldRows
from wattsteer_ml.evaluation.matrix import MATRIX_RUN_BY_NAME
from wattsteer_ml.experiment_reports import save_report
from wattsteer_ml.features import FeatureRowsQuery, MaterialisedFeatureRows
from wattsteer_ml.lanes import Lane, format_instant
from wattsteer_ml.retrain import (
    LANE_RUNS,
    build_pool,
    read_lane_inputs,
    scored_hours,
    settled_rows,
)
from wattsteer_ml.threshold_sweep_run import DATA_FAILURES, reportable_folds
from wattsteer_ml.training import ScoredHour, forecast_rows, train_fold
from wattsteer_ml.training import calibration as calibration_module
from wattsteer_ml.training.calibration import (
    RiskBinDecision,
    RiskBins,
    RiskBinsUndeterminedError,
)

#: The lane the rail was failing in. A parameter of the request, defaulting here.
DEFAULT_LANE = "dessem_free_v1__gate_late__thr5"

#: Below this many rows a cell is flagged ``thin``. A reading aid, not a rule.
THIN_CELL_ROWS = 100

#: Upper edges of the occurrence-probability bins. Rows that qualify have a P50
#: off the point mass, i.e. ``p > 0.5``, so the first bin is open at the bottom.
P_BIN_EDGES = (0.6, 0.7, 0.8, 0.9, 1.0)


#: Edges used only when the real rule finds none and the caller asked to go on.
#: Arbitrary on purpose: the P50 rail does not read risk classes, and a report
#: field says every time that these were used.
PLACEHOLDER_RISK_BINS = RiskBins.from_edges(0.3, 0.7)


@contextmanager
def tolerating_undetermined_risk_bins(enabled: bool) -> Iterator[list[str]]:
    """Let ``train_fold`` finish on a pool the risk-class rule cannot split.

    ``calibrate`` derives the three named risk classes from the pooled
    out-of-fold predictions and **refuses** when no split satisfies the rule
    (`RiskBinsUndeterminedError`), which is the right behaviour for a retrain: a
    class edge nobody measured is not a fallback. On F2–F5 it refuses, so the
    diagnostic could not fit them and could not say whether the P50 bias is a
    property of the model or of the live edge.

    The P50 rail reads nothing the edges touch, so for *this* driver only, when
    ``enabled``, the derivation is wrapped to return a placeholder decision and
    to record the refusal it swallowed. The patch lives for the ``with`` block and
    is restored in a ``finally``; nothing in the retrain path imports this.
    """
    swallowed: list[str] = []
    if not enabled:
        yield swallowed
        return
    original = calibration_module.derive_risk_bins

    def tolerant(predictions: Any, **kwargs: Any) -> RiskBinDecision:
        try:
            return original(predictions, **kwargs)
        except RiskBinsUndeterminedError as undetermined:
            swallowed.append(str(undetermined))
            return RiskBinDecision(
                bins=PLACEHOLDER_RISK_BINS,
                changed=False,
                reason=("diagnostic placeholder: the rule found no edges on this pool"),
                incumbent=None,
                check=calibration_module._check(predictions, PLACEHOLDER_RISK_BINS),
            )

    calibration_module.derive_risk_bins = tolerant
    try:
        yield swallowed
    finally:
        calibration_module.derive_risk_bins = original


class P50BiasRunError(RuntimeError):
    """The run cannot proceed: no database, no reportable fold."""


@dataclass(frozen=True)
class BiasCell:
    """One slice of the rail: how many rows, where the median sits, how sure."""

    label: str
    rows: int
    below_share: float
    day_blocks: int
    standard_error: float | None
    median_observed_over_p50: float

    @property
    def thin(self) -> bool:
        return self.rows < THIN_CELL_ROWS

    def as_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "rows": self.rows,
            "below_share": self.below_share,
            "day_blocks": self.day_blocks,
            "standard_error": self.standard_error,
            "median_observed_over_p50": self.median_observed_over_p50,
            "thin": self.thin,
        }


def _cell(label: str, hours: Sequence[ScoredHour]) -> BiasCell | None:
    """A cell over ``hours``, or ``None`` when there are none. Never a zero row."""
    if not hours:
        return None
    n = len(hours)
    below = [1.0 if hour.below_median else 0.0 for hour in hours]
    share = sum(below) / n
    by_day: dict[object, float] = defaultdict(float)
    for hour, indicator in zip(hours, below, strict=True):
        by_day[hour.key.target_date] += indicator - share
    blocks = len(by_day)
    standard_error: float | None = None
    if blocks > 1:
        variance = sum(v * v for v in by_day.values()) * blocks / ((blocks - 1) * n * n)
        standard_error = math.sqrt(variance) if variance > 0 else 0.0
    ratios = [hour.observed_mwh / hour.forecast.band.p50 for hour in hours]
    return BiasCell(
        label=label,
        rows=n,
        below_share=share,
        day_blocks=blocks,
        standard_error=standard_error,
        median_observed_over_p50=statistics.median(ratios),
    )


def _cells(
    groups: Mapping[str, Sequence[ScoredHour]], order: Sequence[str]
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for label in order:
        cell = _cell(label, groups.get(label, ()))
        if cell is not None:
            out.append(cell.as_dict())
    return out


def _p_bin(probability: float) -> str:
    lower = None
    for edge in P_BIN_EDGES:
        if probability <= edge:
            return f"p ≤ {edge}" if lower is None else f"{lower} < p ≤ {edge}"
        lower = edge
    return f"p > {P_BIN_EDGES[-1]}"


def _p_bin_order() -> list[str]:
    labels = [f"p ≤ {P_BIN_EDGES[0]}"]
    labels += [f"{a} < p ≤ {b}" for a, b in pairwise(P_BIN_EDGES)]
    return labels


def p50_bias_breakdown(hours: Sequence[ScoredHour]) -> dict[str, Any]:
    """The rail's population, cut four ways. Pure: hours in, one dict out.

    The population is the gate's: curtailed hours whose served P50 is above τ
    (:func:`~wattsteer_ml.evaluation.gate.states_a_falsifiable_median`). Hours
    off that population are counted as ``curtailed_rows`` and appear in no cell,
    because on them "the label is above the median" is guaranteed by the point
    mass and says nothing about the fit.
    """
    gate = p50_band_unbiasedness(hours)
    qualifying = [hour for hour in hours if states_a_falsifiable_median(hour)]

    by_subsystem: dict[str, list[ScoredHour]] = defaultdict(list)
    by_hour: dict[str, list[ScoredHour]] = defaultdict(list)
    by_month: dict[str, list[ScoredHour]] = defaultdict(list)
    by_p: dict[str, list[ScoredHour]] = defaultdict(list)
    for hour in qualifying:
        by_subsystem[hour.key.subsystem].append(hour)
        by_hour[f"{hour.key.local_hour:02d}"].append(hour)
        by_month[hour.key.target_date.strftime("%Y-%m")].append(hour)
        by_p[_p_bin(hour.forecast.occurrence_probability)].append(hour)

    overall = _cell("all qualifying hours", qualifying)
    return {
        "rail": BAND_MEDIAN_RAIL,
        "window": list(P50_UNBIASEDNESS_WINDOW),
        "curtailed_rows": gate.rows,
        "qualifying_rows": gate.qualifying_rows,
        # The gate's own figure, on these hours. `None` is an absence: no
        # qualifying row, or none the statistic can speak for.
        "gate_reading": gate.unbiasedness,
        "gate_sufficient": gate.sufficient,
        "gate_passes": gate.passes,
        "overall": None if overall is None else overall.as_dict(),
        "by_subsystem": _cells(by_subsystem, list(SUBSYSTEM_CODES)),
        "by_local_hour": _cells(by_hour, [f"{h:02d}" for h in range(24)]),
        "by_month": _cells(by_month, sorted(by_month)),
        "by_occurrence_probability": _cells(by_p, _p_bin_order()),
    }


@dataclass(frozen=True)
class SegmentHours:
    """One scored fold segment, with what a reader needs to place it."""

    fold_id: str
    row_id: str
    fidelity: str
    deciding: bool
    hours: tuple[ScoredHour, ...]
    #: True when this fold's risk-class edges are the placeholder.
    placeholder_risk_bins: bool = False


class HoursSource(Protocol):
    """Where the scored hours come from — Postgres in a run, a fake in a test."""

    def fold_ids(self) -> tuple[str, ...]: ...

    def __call__(self, fold_id: str) -> Sequence[SegmentHours]: ...


@dataclass(frozen=True)
class P50BiasRequest:
    as_of: datetime
    root: Path
    database_url: str
    lane: str = DEFAULT_LANE
    #: Restrict the run to these folds. Empty means every reportable fold.
    folds: tuple[str, ...] = ()
    #: Go on past a pool the risk-class rule cannot split. See
    #: :func:`tolerating_undetermined_risk_bins`.
    tolerate_risk_bins: bool = False

    def __post_init__(self) -> None:
        if self.as_of.tzinfo is None:
            raise P50BiasRunError("as_of must be tz-aware")


def _progress(message: str) -> None:
    print(json.dumps({"progress": message}), file=sys.stderr, flush=True)


@dataclass
class DatabaseSource:
    """The retrain's reads and fits, kept in memory and never saved.

    One materialised window for every fold: ``feature_rows`` costs about a minute
    per 17,000 rows, and the folds share a base fit, so reading per fold would
    pay for the same rows six times.
    """

    request: P50BiasRequest
    _ids: tuple[str, ...] | None = None
    _rows: MaterialisedFeatureRows | None = None
    _lane: Lane = field(init=False)

    def __post_init__(self) -> None:
        self._lane = Lane.parse(self.request.lane)

    def _arm(self) -> Any:
        named = LANE_RUNS.get(self._lane.gate_profile)
        if named is None:
            raise P50BiasRunError(f"no matrix arm for {self._lane.gate_profile!r}")
        return MATRIX_RUN_BY_NAME[named]

    def fold_ids(self) -> tuple[str, ...]:
        if self._ids is None:
            calendar = materialize_fold_calendar(self.request.as_of.date())
            folds = reportable_folds(calendar, window_start=self._arm().window_start)
            wanted = set(self.request.folds)
            self._ids = tuple(f.id for f in folds if not wanted or f.id in wanted)
        return self._ids

    async def _materialise(self, last_day: Any) -> MaterialisedFeatureRows:
        arm = self._arm()
        conn: asyncpg.Connection[Any] = await asyncpg.connect(
            self.request.database_url,
            server_settings={"default_transaction_read_only": "on"},
        )
        try:
            return await MaterialisedFeatureRows.of(
                conn,
                FeatureRowsQuery(
                    target_from=arm.window_start,
                    target_to=last_day,
                    gate_profile=arm.gate_profile,
                    feature_set=arm.feature_set,
                    threshold_mw=self._lane.threshold_mw,
                ),
            )
        finally:
            await conn.close()

    async def _inputs(self, fold_id: str) -> Any:
        conn: asyncpg.Connection[Any] = await asyncpg.connect(
            self.request.database_url,
            server_settings={"default_transaction_read_only": "on"},
        )
        try:
            return await read_lane_inputs(
                conn,
                self._lane,
                as_of=self.request.as_of,
                fold_id=fold_id,
                rows=self._rows,
            )
        finally:
            await conn.close()

    def __call__(self, fold_id: str) -> Sequence[SegmentHours]:
        if self._rows is None:
            calendar = materialize_fold_calendar(self.request.as_of.date())
            arm = self._arm()
            last = max(
                calendar.fold(fid).blocks_for(arm.window_start).test_end
                for fid in self.fold_ids()
            )
            _progress(f"reading feature rows {arm.window_start}..{last} once")
            self._rows = asyncio.run(self._materialise(last))
        _progress(f"{fold_id}: reading inputs")
        inputs = asyncio.run(self._inputs(fold_id))
        _progress(f"{fold_id}: fitting")
        with tolerating_undetermined_risk_bins(
            self.request.tolerate_risk_bins
        ) as swallowed:
            trained = train_fold(
                inputs.rows,
                fold=inputs.fold,
                blocks=inputs.blocks,
                function_definition=inputs.function_definition,
                pool=build_pool(inputs),
                created_at=self.request.as_of,
                artifact_id=format_instant(self.request.as_of),
            )
        fold_rows = FoldRows.of(
            inputs.rows,
            fold=inputs.fold,
            blocks=inputs.blocks,
            function_definition=inputs.function_definition,
        )
        out: list[SegmentHours] = []
        for segment in inputs.segments:
            settled = settled_rows(fold_rows.segment_rows(segment))
            if not settled:
                continue
            out.append(
                SegmentHours(
                    fold_id=fold_id,
                    row_id=segment.row_id,
                    fidelity=str(segment.fidelity),
                    deciding=segment.row_id == inputs.deciding.row_id,
                    hours=scored_hours(forecast_rows(trained.bundle, settled), settled),
                    placeholder_risk_bins=bool(swallowed),
                )
            )
        return out


@dataclass(frozen=True)
class P50BiasReport:
    as_of: datetime
    lane: str
    segments: tuple[tuple[SegmentHours, dict[str, Any]], ...]
    folds_refused: Mapping[str, str]

    @property
    def is_measurement(self) -> bool:
        return bool(self.segments)

    def as_dict(self) -> dict[str, Any]:
        folds: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for segment, breakdown in self.segments:
            folds[segment.fold_id].append(
                {
                    "row_id": segment.row_id,
                    "vintage_fidelity": segment.fidelity,
                    "deciding_segment": segment.deciding,
                    "placeholder_risk_bins": segment.placeholder_risk_bins,
                    "breakdown": breakdown,
                }
            )
        return {
            "as_of": format_instant(self.as_of),
            "lane": self.lane,
            "measured": self.is_measurement,
            "reading_aid": (
                "Cells are counts of hours on one side of the served P50, over the "
                "gate's own population. median_observed_over_p50 below 1 means the "
                "served median is high by about that factor. Nothing here is a "
                "correction, and the median gets none by design."
            ),
            "thin_cell_rows": THIN_CELL_ROWS,
            "folds": [
                {"fold_id": fold_id, "segments": segments}
                for fold_id, segments in sorted(folds.items())
            ],
            "folds_refused": dict(self.folds_refused),
        }


def run_p50_bias(
    request: P50BiasRequest, *, source: HoursSource | None = None
) -> P50BiasReport:
    """Score each reportable fold and cut the rail. Writes nothing."""
    hours_source: HoursSource = source if source is not None else DatabaseSource(request)
    scored: list[tuple[SegmentHours, dict[str, Any]]] = []
    refused: dict[str, str] = {}
    fold_ids = hours_source.fold_ids()
    if not fold_ids:
        raise P50BiasRunError(
            "no fold on the calendar has a base-fit block and a walk-forward "
            "predecessor for this lane's window, so there is nothing to score"
        )
    for fold_id in fold_ids:
        try:
            segments = hours_source(fold_id)
        except (*DATA_FAILURES, asyncpg.PostgresError, OSError) as absent:
            # An isolated fold, and *published*: a bias reported over the folds
            # that fitted, beside no word on the ones that did not, is a sample
            # the reader cannot see the edge of.
            refused[fold_id] = f"{type(absent).__name__}: {absent}"
            continue
        if not segments:
            refused[fold_id] = "no segment carries a settled label"
            continue
        for segment in segments:
            scored.append((segment, p50_bias_breakdown(segment.hours)))
    return P50BiasReport(
        as_of=request.as_of,
        lane=request.lane,
        segments=tuple(scored),
        folds_refused=refused,
    )


def main(argv: Sequence[str] | None = None) -> int:
    """``python -m wattsteer_ml.p50_bias_run`` — one read-only diagnostic, as JSON.

    Exit 0 when at least one fold was scored, 1 when none was, 2 when the run
    could not start. Neither the promotion log nor any lane directory is touched.
    """
    parser = argparse.ArgumentParser(prog="wattsteer-ml-p50-bias")
    parser.add_argument("--root", default=str(settings.artifact_dir))
    parser.add_argument("--database-url", default=settings.database_url or "")
    parser.add_argument("--lane", default=DEFAULT_LANE)
    parser.add_argument(
        "--folds",
        default="",
        help="comma-separated fold ids (e.g. F5,F6); default is every reportable fold",
    )
    parser.add_argument(
        "--tolerate-risk-bins",
        action="store_true",
        help=(
            "fit folds on which the risk-class rule finds no edges, using "
            "placeholder edges the P50 rail does not read; each such fold is "
            "marked placeholder_risk_bins in the report"
        ),
    )
    parser.add_argument("--as-of", default=None, help="ISO-8601 UTC to the second")
    args = parser.parse_args(list(argv) if argv is not None else None)
    if not args.database_url:
        print(
            json.dumps({"error": "no database url; set DATABASE_URL or pass one"}),
            file=sys.stderr,
        )
        return 2
    as_of = (
        datetime.now(UTC)
        if args.as_of is None
        else datetime.strptime(args.as_of, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    )
    request = P50BiasRequest(
        as_of=as_of,
        root=Path(args.root),
        database_url=args.database_url,
        lane=args.lane,
        folds=tuple(f for f in args.folds.split(",") if f),
        tolerate_risk_bins=args.tolerate_risk_bins,
    )
    try:
        report = run_p50_bias(request)
    except P50BiasRunError as refusal:
        print(json.dumps({"error": str(refusal)}), file=sys.stderr)
        return 2
    payload = report.as_dict()
    save_report(request.root, "p50_bias", as_of, payload)
    print(json.dumps(payload))
    return 0 if report.is_measurement else 1


__all__ = [
    "DEFAULT_LANE",
    "PLACEHOLDER_RISK_BINS",
    "THIN_CELL_ROWS",
    "BiasCell",
    "DatabaseSource",
    "HoursSource",
    "P50BiasReport",
    "P50BiasRequest",
    "P50BiasRunError",
    "SegmentHours",
    "main",
    "p50_bias_breakdown",
    "run_p50_bias",
    "tolerating_undetermined_risk_bins",
]

if __name__ == "__main__":  # pragma: no cover - the process entry point
    sys.exit(main())
