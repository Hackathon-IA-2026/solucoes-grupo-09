"""Where the served floor's excess comes from: the P10 rail, cut every way the
data allows, and the tail boosters' own calibration underneath it.

`p10_calibration_excess` pools every qualifying curtailed hour into one
statistic, and a pooled statistic cannot tell "the floor is a little wide
everywhere" from "two subsystems clear it too often and two clear it far too
rarely, and they average out". `docs/todo-gate-late-p50-experiments.md` parks
this rail under "Not in this list" with exactly that instruction: it "needs its
own diagnostic (by subsystem, by probability bin, by month) before any
change." This is that diagnostic, built on `p50_bias_run`'s shape.

**It changes nothing and decides nothing.** No bundle is saved, nothing is
appended to ``promotions.jsonl``, and no field of the report names a fix. The
only file it writes is the report, under ``experiments/p10_calibration/``,
through :mod:`wattsteer_ml.experiment_reports`.

**The gate's own figure is the anchor, on every cut, not only the pooled one.**
``gate.p10_calibration_excess`` is a pure function of a sequence of scored
hours, so every cell here — the overall one and every cut of it — calls it on
that cell's own rows rather than re-deriving the arithmetic. A cell that
disagrees with what the gate would read on the same rows is a bug in this
module, not a second opinion.

**Two different populations, on purpose.** ``qualifying_rows`` is the rail's
own population — curtailed hours whose *served* P10 states a floor the label
could have missed (`gate.states_a_falsifiable_floor`) — and ``excess`` is
scored over it. ``stated_rows`` is broader: curtailed hours whose occurrence
probability alone puts the P10 in the positive branch
(`ScoredHour.states_lower_bound`, ``p > 0.90``), which is what the magnitude
tail boosters were fitted and calibrated over, before the mixture's shape or
the conformal shift enter at all. ``raw_q02_coverage`` and ``raw_q10_coverage``
are read over the second population, against the boosters' own raw knots
(`mixture.FITTED_ALPHAS`, before ``delta_lo`` moves anything) — the number that
separates "the boosters are conditionally miscalibrated" from "the served law
and the conformal shift disagree", which the pooled rail cannot.

**The delta block is what `p50_bias_run` has no analogue for**, because the
median gets no correction and the floor does. Per fold it carries the served
``delta_lo`` and the calibration-window counts it was ranked over, a
per-subsystem refit of the same order statistic on that subsystem's own
calibration rows (absent, with a reason, where too few state a floor), and two
numbers fitted on the **test** block that are never a servable correction:
``delta_lo_oracle`` (the δ that would have zeroed this fold's excess) and the
counterfactual pooled excess under the per-subsystem deltas. Both exist to
answer one question — is the pooled rail's failure a bias a single scalar could
fix, or is it two opposite-signed errors and fold-to-fold noise that a scalar
cannot reach — and neither is an input to a retrain.

**Every reportable fold, not only the live edge**, for the same reason
`p50_bias_run` reads every fold: a bias that appears only on the growing live
edge is a fact about a recent regime, and one that appears across folds is a
fact about the model.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from typing import Any, Protocol

import asyncpg

from wattsteer_ml.config import settings
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.diagnostics import tolerating_undetermined_risk_bins
from wattsteer_ml.evaluation import materialize_fold_calendar
from wattsteer_ml.evaluation.gate import (
    CALIBRATION_EXCESS_RAIL,
    P10CalibrationExcess,
    p10_calibration_excess,
    states_a_falsifiable_floor,
)
from wattsteer_ml.evaluation.ladder import FoldRows
from wattsteer_ml.evaluation.matrix import MATRIX_RUN_BY_NAME
from wattsteer_ml.experiment_reports import save_report
from wattsteer_ml.features import FeatureRowsQuery, MaterialisedFeatureRows
from wattsteer_ml.lanes import Lane, format_instant
from wattsteer_ml.mixture import FITTED_ALPHAS, SERVED_QUANTILES, implied_lower_clearance
from wattsteer_ml.retrain import (
    LANE_RUNS,
    build_pool,
    read_lane_inputs,
    scored_hours,
    settled_rows,
)
from wattsteer_ml.threshold_sweep_run import DATA_FAILURES, reportable_folds
from wattsteer_ml.training import ScoredHour, forecast_rows, train_fold
from wattsteer_ml.training.conformal import (
    ConformalCorrection,
    conformal_rank,
    minimum_calibration_rows,
)

#: The lane the rail actually refuses on the 2026-09-18 retrain. A parameter of
#: the request, defaulting here.
DEFAULT_LANE = "dessem_free_v1__gate_early__thr5"

#: Below this many *qualifying* rows a cell is flagged ``thin``. A reading aid
#: this module chose, exactly as `p50_bias_run.THIN_CELL_ROWS` is — it is not a
#: threshold the gate uses.
THIN_CELL_ROWS = 100

#: Upper edges of the occurrence-probability bins. The rail's own population
#: lives above 0.90 (`ScoredHour.states_lower_bound`), and 0.918 is
#: `mixture`'s own boundary — the ``p`` above which the composed P10
#: interpolates rather than sitting on the knot at 0.10 (see
#: `mixture.implied_lower_clearance`'s docstring). Below 0.90 the served floor
#: is the point mass at zero and no cell in this cut can carry a reading.
P_BIN_EDGES: tuple[float, ...] = (0.90, 0.918, 0.95, 0.99, 1.0)


def _p_bin(probability: float) -> str:
    lower: float | None = None
    for edge in P_BIN_EDGES:
        if probability <= edge:
            return f"p ≤ {edge}" if lower is None else f"{lower} < p ≤ {edge}"
        lower = edge
    return f"p > {P_BIN_EDGES[-1]}"


def _p_bin_order() -> list[str]:
    labels = [f"p ≤ {P_BIN_EDGES[0]}"]
    labels += [f"{a} < p ≤ {b}" for a, b in pairwise(P_BIN_EDGES)]
    labels.append(f"p > {P_BIN_EDGES[-1]}")
    return labels


class P10CalibrationRunError(RuntimeError):
    """The run cannot proceed: no database, no reportable fold."""


@dataclass(frozen=True)
class CalibrationCell:
    """One slice of the rail: the gate's own reading, plus the raw booster check.

    Wraps a `gate.P10CalibrationExcess` rather than re-deriving its arithmetic,
    so a cell can never disagree with what the gate would read on the same
    rows — the anchor `p50_bias_run.BiasCell` established for the P50 rail,
    generalised to every cut and not only the overall one.
    """

    label: str
    positive_rows: int
    stated_rows: int
    reading: P10CalibrationExcess
    realised_clearance: float | None
    implied_clearance: float | None
    raw_q02_coverage: float | None
    raw_q10_coverage: float | None

    @property
    def thin(self) -> bool:
        return self.reading.qualifying_rows < THIN_CELL_ROWS

    def as_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "positive_rows": self.positive_rows,
            "stated_rows": self.stated_rows,
            "qualifying_rows": self.reading.qualifying_rows,
            "day_blocks": self.reading.day_blocks,
            "minimum_rows": self.reading.minimum_rows,
            "realised_clearance": self.realised_clearance,
            "implied_clearance": self.implied_clearance,
            "excess": self.reading.excess,
            "standard_error": self.reading.standard_error,
            "half_width": self.reading.half_width,
            "sufficient": self.reading.sufficient,
            "passes": self.reading.passes,
            "raw_q02_coverage": self.raw_q02_coverage,
            "raw_q10_coverage": self.raw_q10_coverage,
            "thin": self.thin,
        }


def _at_or_below_raw_knot(hour: ScoredHour, knot_index: int) -> bool:
    """Whether the label sits at or below the raw, uncorrected magnitude knot.

    Calls ``positive_quantiles(FITTED_ALPHAS[knot_index])`` rather than reading
    ``.values[knot_index]`` directly: the field is typed as ``PositiveQuantileFn``
    — "anything callable will do" is `mixture.py`'s own contract for
    composition — and calling at exactly a fitted knot returns that knot's
    value by construction (`MagnitudeQuantiles.__call__` is flat at and below
    its first knot, and the second knot is a span boundary with weight 1.0), so
    this reads the same number without assuming the concrete type.
    """
    knot = hour.forecast.mixture.positive_quantiles(FITTED_ALPHAS[knot_index])
    return hour.observed_mwh <= knot


def _cell(label: str, hours: Sequence[ScoredHour]) -> CalibrationCell | None:
    """A cell over ``hours``, or ``None`` when there are none. Never a zero row."""
    if not hours:
        return None
    reading = p10_calibration_excess(hours)
    qualifying = [hour for hour in hours if states_a_falsifiable_floor(hour)]
    stated = [hour for hour in hours if hour.is_positive and hour.states_lower_bound]
    realised: float | None = None
    implied: float | None = None
    if qualifying:
        realised = sum(1.0 for hour in qualifying if hour.covered_lower) / len(qualifying)
        implied = sum(
            implied_lower_clearance(
                hour.forecast.occurrence_probability,
                hour.forecast.mixture.positive_quantiles,
            )
            for hour in qualifying
        ) / len(qualifying)
    raw_q02: float | None = None
    raw_q10: float | None = None
    if stated:
        n_stated = len(stated)
        raw_q02 = sum(1.0 for h in stated if _at_or_below_raw_knot(h, 0)) / n_stated
        raw_q10 = sum(1.0 for h in stated if _at_or_below_raw_knot(h, 1)) / n_stated
    return CalibrationCell(
        label=label,
        positive_rows=len(hours),
        stated_rows=len(stated),
        reading=reading,
        realised_clearance=realised,
        implied_clearance=implied,
        raw_q02_coverage=raw_q02,
        raw_q10_coverage=raw_q10,
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


def p10_calibration_breakdown(hours: Sequence[ScoredHour]) -> dict[str, Any]:
    """The rail's population, cut four ways. Pure: hours in, one dict out.

    ``hours`` is every settled hour of the segment, curtailed or not —
    `_cell` and `gate.p10_calibration_excess` both filter to the positive ones
    themselves, exactly as the gate does, so the population is decided in one
    place.
    """
    reading = p10_calibration_excess(hours)
    by_subsystem: dict[str, list[ScoredHour]] = defaultdict(list)
    by_hour: dict[str, list[ScoredHour]] = defaultdict(list)
    by_month: dict[str, list[ScoredHour]] = defaultdict(list)
    by_p: dict[str, list[ScoredHour]] = defaultdict(list)
    for hour in hours:
        if not hour.is_positive:
            continue
        by_subsystem[hour.key.subsystem].append(hour)
        by_hour[f"{hour.key.local_hour:02d}"].append(hour)
        by_month[hour.key.target_date.strftime("%Y-%m")].append(hour)
        by_p[_p_bin(hour.forecast.occurrence_probability)].append(hour)

    overall = _cell("all curtailed hours", hours)
    return {
        "rail": CALIBRATION_EXCESS_RAIL,
        "positive_rows": reading.rows,
        "qualifying_rows": reading.qualifying_rows,
        "minimum_rows": reading.minimum_rows,
        # The gate's own figure, on these hours. `None` is an absence: no
        # qualifying row, or none the statistic can speak for.
        "gate_reading": reading.excess,
        "gate_standard_error": reading.standard_error,
        "gate_sufficient": reading.sufficient,
        "gate_passes": reading.passes,
        "overall": None if overall is None else overall.as_dict(),
        "by_subsystem": _cells(by_subsystem, list(SUBSYSTEM_CODES)),
        "by_local_hour": _cells(by_hour, [f"{h:02d}" for h in range(24)]),
        "by_month": _cells(by_month, sorted(by_month)),
        "by_occurrence_probability": _cells(by_p, _p_bin_order()),
    }


def _raw_lower_residual(hour: ScoredHour) -> float:
    """``(Q_pos(u_lo) − y) / spread`` — what ``delta_lo`` is ranked over.

    Reads ``hour.forecast.mixture.positive_quantiles`` directly rather than
    ``ScoredHour.lower_residual``, which is defined on ``band.p10`` — the
    *served*, already-shifted quantile. Ranking a residual of an
    already-corrected quantity would measure this fold's own correction
    against itself; `mixture.HurdleMixture.positive_quantiles` is the raw
    booster output the shift is never applied to, which is the quantity
    `training.conformal.residuals` actually ranks in production.
    """
    p = hour.forecast.occurrence_probability
    u = min(1.0, max(0.0, (SERVED_QUANTILES[0] - (1.0 - p)) / p))
    raw_q10 = hour.forecast.mixture.positive_quantiles(u)
    return (raw_q10 - hour.observed_mwh) / hour.forecast.mixture.positive_spread_mwh


def _clustered_excess(
    entries: Iterable[tuple[Any, float]],
) -> tuple[float | None, float | None]:
    """Day-clustered mean and SE of ``value`` over ``(day, value)`` pairs.

    The same arithmetic `gate.p10_calibration_excess` uses internally, so a
    counterfactual scored here is comparable to the rail's own reading rather
    than to a statistic that merely looks similar. ``(None, None)`` with no
    rows, and ``(excess, None)`` with only one day block — a single cluster
    cannot estimate a spread, exactly as the gate declines to.
    """
    by_day: dict[Any, list[float]] = defaultdict(list)
    n = 0
    for day, value in entries:
        by_day[day].append(value)
        n += 1
    if n == 0:
        return None, None
    excess = sum(sum(block) for block in by_day.values()) / n
    g = len(by_day)
    if g <= 1:
        return excess, None
    centred = [sum(v - excess for v in block) for block in by_day.values()]
    variance = sum(c * c for c in centred) * g / ((g - 1) * n * n)
    return excess, math.sqrt(variance) if variance > 0 else 0.0


def _oracle_delta(rows: Sequence[tuple[str, Any, float, float]]) -> float | None:
    """Bisect for the δ that zeros this population's excess.

    ``rows`` is ``(subsystem, target_date, raw_residual, implied)`` over the
    test block. **Fitted on the block it is scored on, and therefore never a
    servable correction** — a diagnostic reading of how far ``delta_lo_used``
    sits from what would have zeroed this fold, nothing more. ``excess(δ)`` is
    monotone non-decreasing in δ (a larger δ clears more rows), so bisection
    converges; 60 halvings of a ``[-5, 5]`` bracket resolve to about 1e-17,
    far past anything this statistic can distinguish from noise.
    """
    if not rows:
        return None
    lo, hi = -5.0, 5.0
    for _ in range(60):
        mid = (lo + hi) / 2.0
        excess, _ = _clustered_excess(
            (day, (1.0 if residual <= mid else 0.0) - implied)
            for _, day, residual, implied in rows
        )
        if excess is None or excess > 0.0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2.0


@dataclass(frozen=True)
class SubsystemDelta:
    """``delta_lo`` refit on one subsystem's own calibration rows, or an absence.

    The absence is `honesty.md`'s rule applied to a fitted number: a subsystem
    whose calibration rows fall short of `minimum_calibration_rows` gets
    ``delta_lo: None`` with a stated reason, never a fitted value on too few
    rows and never a zero standing in for "not enough data".
    """

    subsystem: str
    calibration_rows: int
    delta_lo: float | None
    rank: int | None
    reason: str | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "subsystem": self.subsystem,
            "calibration_rows": self.calibration_rows,
            "delta_lo": self.delta_lo,
            "rank": self.rank,
            "reason": self.reason,
        }


def _fit_subsystem_delta(
    calibration_hours: Sequence[ScoredHour], subsystem: str, *, miscoverage: float
) -> SubsystemDelta:
    """The same order statistic `conformalise` ranks, narrowed to one subsystem.

    ``miscoverage`` is the fold's own — the nominal 0.10 that production ranks
    the lower tail at (`training.conformal.conformalise`'s "the lower tail is
    still ranked at the nominal α"), never `lower_tail_miscoverage`'s implied
    target, which `test_lower_tail_target.py` records as refused for breaking
    the marginal coverage rail. A per-subsystem candidate is only comparable to
    the served ``delta_lo`` if it targets the same thing.
    """
    stated = [
        hour
        for hour in calibration_hours
        if hour.key.subsystem == subsystem
        and hour.is_positive
        and hour.states_lower_bound
    ]
    n = len(stated)
    floor = minimum_calibration_rows(miscoverage)
    if n < floor:
        return SubsystemDelta(
            subsystem=subsystem,
            calibration_rows=n,
            delta_lo=None,
            rank=None,
            reason=(
                f"{n} calibration rows state a floor for {subsystem}; a "
                f"{1.0 - miscoverage:.0%} statement needs at least {floor}. The "
                "order statistic is a refusal here, not a correction fitted on "
                "too little."
            ),
        )
    residuals = sorted(_raw_lower_residual(hour) for hour in stated)
    rank = conformal_rank(n, miscoverage)
    return SubsystemDelta(
        subsystem=subsystem,
        calibration_rows=n,
        delta_lo=residuals[rank - 1],
        rank=rank,
        reason=None,
    )


@dataclass(frozen=True)
class DeltaBlock:
    """What `p50_bias_run` has no analogue for: the correction, cut by subsystem.

    ``delta_lo_used``, ``lower_calibration_rows``, ``lower_rank`` and
    ``lower_miscoverage`` are read straight off this fold's own
    `training.conformal.ConformalCorrection` — the number actually served —
    rather than refitted, so they cannot drift from what the artifact would
    carry. Everything else here is diagnostic-only.
    """

    delta_lo_used: float
    lower_calibration_rows: int
    lower_rank: int
    lower_miscoverage: float
    lower_tail_fitted: bool
    delta_lo_oracle: float | None
    per_subsystem: tuple[SubsystemDelta, ...]
    excess_per_subsystem_delta: float | None
    excess_per_subsystem_delta_standard_error: float | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "reading_aid": (
                "delta_lo_used is this fold's served correction, read off the "
                "artifact's own ConformalCorrection. delta_lo_oracle is "
                "bisected on the TEST block for the δ that would have zeroed "
                "this fold's excess — fitted on the block it is scored on, "
                "and therefore never a servable correction. per_subsystem is "
                "the same order statistic fit on each subsystem's own "
                "calibration rows, absent with a reason where too few state a "
                "floor. excess_per_subsystem_delta is the counterfactual "
                "pooled excess if every row had used its own subsystem's "
                "delta (falling back to delta_lo_used where absent) — compare "
                "it against the deciding segment's own gate_reading."
            ),
            "delta_lo_used": self.delta_lo_used,
            "lower_calibration_rows": self.lower_calibration_rows,
            "lower_rank": self.lower_rank,
            "lower_miscoverage": self.lower_miscoverage,
            "lower_tail_fitted": self.lower_tail_fitted,
            "delta_lo_oracle": self.delta_lo_oracle,
            "per_subsystem": [d.as_dict() for d in self.per_subsystem],
            "excess_per_subsystem_delta": self.excess_per_subsystem_delta,
            "excess_per_subsystem_delta_standard_error": (
                self.excess_per_subsystem_delta_standard_error
            ),
        }


def build_delta_block(
    *,
    conformal: ConformalCorrection,
    calibration_hours: Sequence[ScoredHour],
    test_hours: Sequence[ScoredHour],
) -> DeltaBlock:
    """Assemble one fold's delta block from its calibration and test hours."""
    per_subsystem = tuple(
        _fit_subsystem_delta(
            calibration_hours, subsystem, miscoverage=conformal.miscoverage
        )
        for subsystem in SUBSYSTEM_CODES
    )
    rows: list[tuple[str, Any, float, float]] = [
        (
            hour.key.subsystem,
            hour.key.target_date,
            _raw_lower_residual(hour),
            implied_lower_clearance(
                hour.forecast.occurrence_probability,
                hour.forecast.mixture.positive_quantiles,
            ),
        )
        for hour in test_hours
        if states_a_falsifiable_floor(hour)
    ]
    oracle = _oracle_delta(rows)

    fallback = {delta.subsystem: delta.delta_lo for delta in per_subsystem}
    counterfactual_pairs: list[tuple[Any, float]] = []
    for subsystem, day, residual, implied in rows:
        sub_delta = fallback.get(subsystem)
        used = sub_delta if sub_delta is not None else conformal.delta_lo
        hit = 1.0 if residual <= used else 0.0
        counterfactual_pairs.append((day, hit - implied))
    counterfactual, counterfactual_se = _clustered_excess(counterfactual_pairs)

    return DeltaBlock(
        delta_lo_used=conformal.delta_lo,
        lower_calibration_rows=conformal.lower_calibration_rows,
        lower_rank=conformal.lower_rank,
        lower_miscoverage=conformal.lower_miscoverage,
        lower_tail_fitted=conformal.lower_tail_fitted,
        delta_lo_oracle=oracle,
        per_subsystem=per_subsystem,
        excess_per_subsystem_delta=counterfactual,
        excess_per_subsystem_delta_standard_error=counterfactual_se,
    )


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


@dataclass(frozen=True)
class FoldScoring:
    """One fold's raw scored segments, plus its own calibration-block delta."""

    fold_id: str
    delta: DeltaBlock
    segments: tuple[SegmentHours, ...]


class HoursSource(Protocol):
    """Where the scored hours come from — Postgres in a run, a fake in a test."""

    def fold_ids(self) -> tuple[str, ...]: ...

    def __call__(self, fold_id: str) -> FoldScoring: ...


@dataclass(frozen=True)
class P10CalibrationRequest:
    as_of: datetime
    root: Path
    database_url: str
    lane: str = DEFAULT_LANE
    #: Restrict the run to these folds. Empty means every reportable fold.
    folds: tuple[str, ...] = ()
    #: Go on past a pool the risk-class rule cannot split. See
    #: `wattsteer_ml.diagnostics.tolerating_undetermined_risk_bins`.
    tolerate_risk_bins: bool = False

    def __post_init__(self) -> None:
        if self.as_of.tzinfo is None:
            raise P10CalibrationRunError("as_of must be tz-aware")


def _progress(message: str) -> None:
    print(json.dumps({"progress": message}), file=sys.stderr, flush=True)


@dataclass
class DatabaseSource:
    """The retrain's reads and fits, kept in memory and never saved.

    One materialised window for every fold, exactly as `p50_bias_run`'s source
    reads once: ``feature_rows`` costs about a minute per 17,000 rows, and the
    folds share a base fit.
    """

    request: P10CalibrationRequest
    _ids: tuple[str, ...] | None = None
    _rows: MaterialisedFeatureRows | None = None
    _lane: Lane = field(init=False)

    def __post_init__(self) -> None:
        self._lane = Lane.parse(self.request.lane)

    def _arm(self) -> Any:
        named = LANE_RUNS.get(self._lane.gate_profile)
        if named is None:
            raise P10CalibrationRunError(f"no matrix arm for {self._lane.gate_profile!r}")
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

    def __call__(self, fold_id: str) -> FoldScoring:
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

        calibration_settled = settled_rows(fold_rows.calibration_rows)
        calibration_hours = (
            scored_hours(
                forecast_rows(trained.bundle, calibration_settled), calibration_settled
            )
            if calibration_settled
            else ()
        )

        segments: list[SegmentHours] = []
        for segment in inputs.segments:
            settled = settled_rows(fold_rows.segment_rows(segment))
            if not settled:
                continue
            segments.append(
                SegmentHours(
                    fold_id=fold_id,
                    row_id=segment.row_id,
                    fidelity=str(segment.fidelity),
                    deciding=segment.row_id == inputs.deciding.row_id,
                    hours=scored_hours(forecast_rows(trained.bundle, settled), settled),
                    placeholder_risk_bins=bool(swallowed),
                )
            )
        deciding_hours = next(
            (segment.hours for segment in segments if segment.deciding),
            segments[-1].hours if segments else (),
        )
        delta = build_delta_block(
            conformal=trained.bundle.conformal,
            calibration_hours=calibration_hours,
            test_hours=deciding_hours,
        )
        return FoldScoring(fold_id=fold_id, delta=delta, segments=tuple(segments))


@dataclass(frozen=True)
class ScoredFold:
    fold_id: str
    delta: DeltaBlock
    segments: tuple[tuple[SegmentHours, dict[str, Any]], ...]


@dataclass(frozen=True)
class P10CalibrationReport:
    as_of: datetime
    lane: str
    folds: tuple[ScoredFold, ...]
    folds_refused: Mapping[str, str]

    @property
    def is_measurement(self) -> bool:
        return bool(self.folds)

    def as_dict(self) -> dict[str, Any]:
        return {
            "as_of": format_instant(self.as_of),
            "lane": self.lane,
            "measured": self.is_measurement,
            "reading_aid": (
                "Cells are counts of curtailed hours against the served P10, "
                "over the gate's own population (qualifying_rows) and, for the "
                "raw knot columns, over the boosters' own population "
                "(stated_rows). excess is realised_clearance minus "
                "implied_clearance, exactly as gate.p10_calibration_excess "
                "reads it. raw_q02_coverage and raw_q10_coverage are read "
                "against the fitted boosters' own knots, before the composed "
                "law or the conformal shift enter — a low reading there means "
                "the tail booster, not the calibration step, is the cause."
            ),
            "thin_cell_rows": THIN_CELL_ROWS,
            "probability_bin_edges": list(P_BIN_EDGES),
            "folds": [
                {
                    "fold_id": scored.fold_id,
                    "delta": scored.delta.as_dict(),
                    "segments": [
                        {
                            "row_id": segment.row_id,
                            "vintage_fidelity": segment.fidelity,
                            "deciding_segment": segment.deciding,
                            "placeholder_risk_bins": segment.placeholder_risk_bins,
                            "breakdown": breakdown,
                        }
                        for segment, breakdown in scored.segments
                    ],
                }
                for scored in self.folds
            ],
            "folds_refused": dict(self.folds_refused),
        }


def run_p10_calibration(
    request: P10CalibrationRequest, *, source: HoursSource | None = None
) -> P10CalibrationReport:
    """Score each reportable fold and cut the rail. Writes nothing."""
    hours_source: HoursSource = source if source is not None else DatabaseSource(request)
    scored: list[ScoredFold] = []
    refused: dict[str, str] = {}
    fold_ids = hours_source.fold_ids()
    if not fold_ids:
        raise P10CalibrationRunError(
            "no fold on the calendar has a base-fit block and a walk-forward "
            "predecessor for this lane's window, so there is nothing to score"
        )
    for fold_id in fold_ids:
        try:
            scoring = hours_source(fold_id)
        except (*DATA_FAILURES, asyncpg.PostgresError, OSError) as absent:
            # An isolated fold, and *published*: a bias reported over the folds
            # that fitted, beside no word on the ones that did not, is a sample
            # the reader cannot see the edge of.
            refused[fold_id] = f"{type(absent).__name__}: {absent}"
            continue
        if not scoring.segments:
            refused[fold_id] = "no segment carries a settled label"
            continue
        breakdowns = tuple(
            (segment, p10_calibration_breakdown(segment.hours))
            for segment in scoring.segments
        )
        scored.append(
            ScoredFold(fold_id=fold_id, delta=scoring.delta, segments=breakdowns)
        )
    return P10CalibrationReport(
        as_of=request.as_of, lane=request.lane, folds=tuple(scored), folds_refused=refused
    )


def main(argv: Sequence[str] | None = None) -> int:
    """``python -m wattsteer_ml.p10_calibration_run`` — one read-only diagnostic.

    Exit 0 when at least one fold was scored, 1 when none was, 2 when the run
    could not start. Neither the promotion log nor any lane directory is
    touched.
    """
    parser = argparse.ArgumentParser(prog="wattsteer-ml-p10-calibration")
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
            "placeholder edges the P10 rail does not read; each such fold is "
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
    request = P10CalibrationRequest(
        as_of=as_of,
        root=Path(args.root),
        database_url=args.database_url,
        lane=args.lane,
        folds=tuple(f for f in args.folds.split(",") if f),
        tolerate_risk_bins=args.tolerate_risk_bins,
    )
    try:
        report = run_p10_calibration(request)
    except P10CalibrationRunError as refusal:
        print(json.dumps({"error": str(refusal)}), file=sys.stderr)
        return 2
    payload = report.as_dict()
    save_report(request.root, "p10_calibration", as_of, payload)
    print(json.dumps(payload))
    return 0 if report.is_measurement else 1


__all__ = [
    "DEFAULT_LANE",
    "P_BIN_EDGES",
    "THIN_CELL_ROWS",
    "CalibrationCell",
    "DatabaseSource",
    "DeltaBlock",
    "FoldScoring",
    "HoursSource",
    "P10CalibrationReport",
    "P10CalibrationRequest",
    "P10CalibrationRunError",
    "ScoredFold",
    "SegmentHours",
    "SubsystemDelta",
    "build_delta_block",
    "main",
    "p10_calibration_breakdown",
    "run_p10_calibration",
]

if __name__ == "__main__":  # pragma: no cover - the process entry point
    sys.exit(main())
