"""The weekly retrain: live database in, one gate decision per lane out.

`docs/specs/forecaster.md`, **seam 11 — live, scheduled**: "The weekly retrain
runs end to end against real Postgres, produces a card, reaches a decision, and
appends exactly one line. Wall-clock and peak memory are recorded so a retrain
that starts to outgrow the service is visible before it fails."

Forecaster 19 built the driver's *shape* —
:func:`~wattsteer_ml.evaluation.serving_lanes.run_serving_lanes` gates the two
served lanes independently, so one lane's refusal cannot take the other's
fallback down with it — and left ``gate_one`` as a parameter with no production
caller. This module is that caller, and it is the only place in the repository
that composes the whole pipeline:

    calendar → prior folds' out-of-fold occurrence → the pool → ``train_fold``
    → ``save_artifact`` → the ladder → the incumbent, scored on the same rows
    → the serving smoke on tomorrow's real vector → ``run_gate``

Everything above already existed and none of it is reimplemented here. What is
new is the *order*, the inputs' provenance, and three properties the ticket
names as the deliverable rather than as aspirations.

**One: a run is identified, so a retry is not a second run.** ``run_id`` is the
scheduled instant, and it is also the artifact id for every lane in the run —
lanes live in different directories, so one id can name both, and a reader of
``promotions.jsonl`` can see at a glance which two lines belong to one Friday.
:func:`decided_in_run` then makes the whole thing idempotent: a lane whose
``(lane, run_id)`` pair already carries a decision line is *not* retrained and
appends nothing, so a queue redelivery, a manual re-submit or a catch-up run
leaves exactly one line per lane per run. Without a run id, idempotency would
have to be inferred from a wall clock, and two retries a second apart would
produce two artifacts and two lines.

**Two: the inputs are pinned, so the run can be reissued.** Nothing here reads
a clock except :func:`main`, which turns one into a ``run_id`` and an ``as_of``
and then hands both down. ``as_of`` fixes the fold calendar's live edge and the
serving day; the seeds are the published constants; the artifact id is the run
id. Re-running :func:`retrain_lane` with the same
:class:`RetrainRequest` against the same database therefore produces the same
feature hash, the same conformal corrections and the same predictions — which is
the property the gate depends on, because a bootstrap comparing two artifacts
from a nondeterministic pipeline compares noise. The ``reproduction`` block of
the card records exactly what a second run would need to be given.

**Three: what it cost is on the card.** :class:`Resources` measures the run's
wall clock and its peak resident set, and both land in the card's ``retrain``
block beside the reproduction receipt. Peak RSS rather than
:mod:`tracemalloc`: most of a retrain's memory is LightGBM's histograms and
NumPy's buffers, which Python's allocator never sees, and the number that
matters is the one the container's memory limit is compared against.

**Why it is a process rather than a request handler.** The measurement above is
only meaningful in an interpreter that does nothing else — a peak RSS taken
inside the API's own process is the API's peak, not the retrain's — and a
LightGBM fit that runs on the event loop stalls every read the service is also
serving. ``tests/reproduce_fold.py`` already states the same fact from the
determinism side: "the weekly retrain is always a second interpreter". So
:func:`main` is a ``python -m wattsteer_ml.retrain`` entry point that prints one
JSON report on stdout, and ``POST /internal/retrain`` spawns it. The schedule
itself is neither here nor there: it is one repeatable job on the queue the
worker already owns (`apps/api/src/jobs/retrain.ts`), because
`docs/specs/data-platform.md` is emphatic that the one thing worse than no
scheduler is a second one.

**Two readings this module had to choose between, and the choice is stated.**

- *Which fold decides.* The spec is unambiguous — "the weekly retrain always
  scores against F6", the live edge — and the base learners are fitted on what
  the window provides **before that fold's start**. The ticket's prose ("fit the
  calibration layer and the two conformal scalars on the trailing 90 days")
  reads, taken literally, as a calibration window ending yesterday, which would
  put the deciding fold's own test rows in-sample and make the gate a
  self-portrait. The spec's reading wins: the trailing 90 days are the last 90
  of the *training block*, which is what :meth:`Fold.blocks_for` already
  computes and what seam 7 asserts.
- *What "the newest training target date" means to check 4.* Under the reading
  above, a fold-trained artifact's last fitted day is the live edge's
  ``train_end`` — the start of the quarter — so it is more than seven days old
  for almost all of every quarter, and check 4's freshness rule would refuse
  every candidate forever. That cannot be what a rule named "freshness and
  coverage" is for: it exists to notice that *ingestion has stopped*. So the
  candidate reports the newest target date the run's data window reached
  (``blocks.test_end``, i.e. ``as_of − 1``), which is the quantity that answers
  that question, and the card records both that and the true ``trained_to`` so
  the artifact never overstates what it was fitted on.

Neither of these is a licence to promote loosely. Check 4's other half —
sixty test days on the deciding fold — is left exactly as it is, and it means a
live edge in the first two thirds of a quarter refuses every candidate on the
honest grounds that twenty days of paired bootstrap decide nothing. A retrain
that refuses is still a retrain that ran: the artifact is on the volume, the
card is inspectable and the line is in the log.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import resource
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import asyncpg

from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.canonical_reads import read_go_live
from wattsteer_ml.config import settings
from wattsteer_ml.evaluation import (
    Fold,
    FoldBlocks,
    FoldCalendar,
    FoldCalendarError,
    FoldSegment,
    materialize_fold_calendar,
    stamp_fidelity,
)
from wattsteer_ml.evaluation.gate import (
    Comparator,
    ContractDriftError,
    GateCandidate,
    GateDecision,
    NoCandidate,
    ServingSmoke,
    cold_start_baseline,
    null_rates,
    run_gate,
    serving_smoke,
)
from wattsteer_ml.evaluation.ladder import (
    FoldRows,
    ForestRung,
    LinearRung,
    PrevalenceRung,
    Rung,
    SameHourSevenDayRung,
    run_ladder,
)
from wattsteer_ml.evaluation.matrix import MATRIX_RUN_BY_NAME, MatrixRun
from wattsteer_ml.evaluation.metrics import MetricsRow, MetricsTable
from wattsteer_ml.evaluation.planning_arms import (
    PlanningArmError,
    PlanningArmReport,
    UnmeasuredPlanningArms,
    measure_planning_arms,
    record_planning_arms,
)
from wattsteer_ml.evaluation.serving_lanes import (
    SERVING_LANES,
    ServingLanesReport,
    run_serving_lanes,
)
from wattsteer_ml.features import (
    FeatureRowsQuery,
    MaterialisedFeatureRows,
    read_feature_rows,
    read_serving_rows,
    serving_target_date,
)
from wattsteer_ml.lanes import Lane, format_instant
from wattsteer_ml.model_report import write_report_or_warn
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionLog
from wattsteer_ml.training import (
    CalibrationError,
    HurdleBundle,
    OutOfFoldPool,
    OutOfFoldPrediction,
    ScoredHour,
    TrainingError,
    forecast_rows,
    load_artifact,
    out_of_fold_occurrence,
    read_card,
    read_feature_function_definition,
    save_artifact,
    train_fold,
    write_card,
)
from wattsteer_ml.training.calibration import RiskBinDecision, RiskBins
from wattsteer_ml.training.design import TOTAL_COLUMN

#: The card group this module owns. The gate appends its own under ``gate``;
#: this one is written first and survives that append, because
#: :func:`~wattsteer_ml.evaluation.gate.record_decision` rewrites the card by
#: spreading it rather than by rebuilding it.
RETRAIN_BLOCK_KEY = "retrain"

#: The card key holding the ladder table, one slim row per
#: ``(rung, fold segment)``. Read by :mod:`wattsteer_ml.model_report` and by
#: nothing that decides: :func:`run_gate` is handed the in-memory table.
FOLD_METRICS_KEY = "fold_metrics"

#: The columns of a published row a comparison needs. The full row also carries
#: the collapse block and per-subsystem cells, which multiply the card by the
#: number of rungs and folds for a figure no comparison reads.
_FOLD_METRIC_COLUMNS = (
    "run",
    "rung",
    "rung_number",
    "fold_id",
    "vintage_fidelity",
    "rows",
    "prevalence",
    "pr_auc",
    "brier",
    "ece",
    "pinball_10",
    "pinball_50",
    "pinball_90",
    "qloss_mwh",
    "interval_width_mean_mwh",
    "crossing_rate",
    "coverage_p10",
    "coverage_p90",
    "day_total_coverage",
)

#: Which matrix arm each served lane *is*. Not a parallel naming scheme: the
#: morning view is ``A-full-early`` and the evening view is ``A-full`` in
#: `docs/specs/forecaster.md`'s evaluation matrix, and reading the run out of
#: :data:`~wattsteer_ml.evaluation.matrix.MATRIX_RUNS` is what keeps the weekly
#: retrain's window start and the matrix's the same date by construction.
LANE_RUNS: Mapping[str, str] = {"gate_early": "A-full-early", "gate_late": "A-full"}


class RetrainError(RuntimeError):
    """The run cannot proceed — a missing calendar edge, no database, no rows."""


# --- what it cost -------------------------------------------------------------


def _peak_rss_mb() -> float:
    """Peak resident set of this process so far, in mebibytes.

    ``ru_maxrss`` is kilobytes on Linux and bytes on macOS — a difference that
    silently reports a 900 MB retrain as 900 GB if it is not handled, so it is
    handled here in the one place that reads it.
    """
    peak = float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return peak / (1024.0 * 1024.0) if sys.platform == "darwin" else peak / 1024.0


@dataclass(frozen=True)
class Resources:
    """What one run cost, so that outgrowing the service is visible early.

    Peak RSS is the *process's* peak, which is why :func:`main` exists: in a
    dedicated interpreter that number is the retrain's, and inside a web server
    it would be whatever the server had already touched.
    """

    wall_clock_seconds: float
    peak_rss_mb: float

    def as_dict(self) -> dict[str, float]:
        return {
            "wall_clock_seconds": round(self.wall_clock_seconds, 3),
            "peak_rss_mb": round(self.peak_rss_mb, 1),
        }


class Stopwatch:
    """A wall clock and a high-water mark, read whenever a caller wants them."""

    def __init__(self) -> None:
        self._started = time.monotonic()

    def read(self) -> Resources:
        return Resources(
            wall_clock_seconds=time.monotonic() - self._started,
            peak_rss_mb=_peak_rss_mb(),
        )


# --- the request --------------------------------------------------------------


@dataclass(frozen=True)
class RetrainRequest:
    """One run, fully pinned. Two of these with equal fields are one run twice.

    ``run_id`` is both the run's identity in the promotion log and the artifact
    id every lane writes under, which is what makes :func:`decided_in_run` able
    to recognise a retry without a second bookkeeping file.
    """

    run_id: str
    as_of: datetime
    root: Path
    database_url: str
    lanes: tuple[Lane, ...] = SERVING_LANES
    #: Whether to fit rungs 0–3 beside the served model. On by default because
    #: `docs/specs/forecaster.md`'s acceptance gate asks for the baseline ladder
    #: to be populated for every rung, and because rung 1 is the cold-start bar
    #: — without it a first artifact has nothing to be measured against.
    ladder: bool = True

    def __post_init__(self) -> None:
        if self.as_of.tzinfo is None:
            raise RetrainError("as_of must be tz-aware; a naive instant names no run")
        if format_instant(self.as_of) != self.run_id:
            raise RetrainError(
                f"run_id {self.run_id!r} is not as_of {self.as_of.isoformat()} — the "
                "run id is the instant the run was scheduled for, and an artifact "
                "stem that disagrees with it cannot be reproduced from the card"
            )


# --- one lane -----------------------------------------------------------------


@dataclass(frozen=True)
class LaneInputs:
    """Everything one lane's retrain read, fetched once and sliced here."""

    lane: Lane
    run: str
    window_start: date
    calendar: FoldCalendar
    fold: Fold
    blocks: FoldBlocks
    segments: tuple[FoldSegment, ...]
    prior: tuple[tuple[Fold, FoldBlocks, tuple[FoldSegment, ...]], ...]
    function_definition: str
    rows_by_fold: Mapping[str, tuple[Mapping[str, Any], ...]]
    serving_rows: tuple[Mapping[str, Any], ...]
    serving_day: date

    @property
    def deciding(self) -> FoldSegment:
        """The segment the swap is decided on: the newest of the live edge's.

        A fold that straddles ingestion go-live is reported as two rows and never
        one averaged one, and the newer of the two is the point-in-time half —
        which is the half check 4 insists on once it exists.
        """
        return self.segments[-1]

    @property
    def rows(self) -> tuple[Mapping[str, Any], ...]:
        return self.rows_by_fold[self.fold.id]


async def read_lane_inputs(
    conn: asyncpg.Connection[Any],
    lane: Lane,
    *,
    as_of: datetime,
    fold_id: str | None = None,
    arm: MatrixRun | None = None,
    rows: MaterialisedFeatureRows | None = None,
) -> LaneInputs:
    """One query for the whole window, then slice it per fold.

    One query rather than one per fold because the folds overlap heavily — every
    fold's base fit starts at the same window start — and reading the window
    once is both faster and the only way the folds are guaranteed to have been
    read at the same instant, which a reproducible run needs.

    Args:
        fold_id: which fold to score. ``None`` — the weekly retrain's case — is
            the live edge, because "the weekly retrain always scores against
            F6". Naming one instead is forecaster ticket 23's case: the days
            that are `fold_holdout` are the days of the **frozen** quarters, and
            nothing else in the repository can read a frozen fold's window.
        arm: which matrix run's window and feature set to read. ``None`` — the
            weekly retrain's case and this module's own — is the arm
            :data:`LANE_RUNS` maps the lane's gate profile to, because a served
            lane has exactly one. Naming one instead is forecaster ticket 18's
            case: the DESSEM A/B reads ``A-full``, ``A-common`` and ``B-common``
            *at one gate*, and two of those share the lane the third does not,
            so the arm cannot be recovered from the lane. It must agree with the
            lane on the feature set and the gate profile — the two together are
            what the feature function is asked for — and only the window start
            is then the arm's own, which is exactly the difference the A/B is
            measuring.
        rows: feature rows already materialised for **this** arm's
            ``(feature_set, gate_profile, threshold_mw)``, covering at least
            ``[blocks.base_fit_start, blocks.test_end]``. ``None`` — the weekly
            retrain's case — reads them here, which is the only behaviour this
            function ever had. Passing them is forecaster ticket 18's case: one
            fold's three arms, and one arm's several folds, all slice the *same*
            rows out of one window, and ``feature_rows`` measures at 58.4 s per
            17,376 rows on real data, so a driver that reads once per
            ``(arm, fold)`` pays for the same rows nine times over and looks
            hung while it does. The rows are sliced by ``target_date`` exactly as
            a fresh read would be, and a caller that hands over a window too
            narrow for the fold it asked for is refused rather than quietly
            scored on a short block.

    Raises:
        RetrainError: if ``rows`` is given and does not span the arm's blocks,
            or if no rows are found for the window at all.

    The pool built from the result is the folds *before* the one being scored
    and never ``calendar.frozen_folds``. For the live edge those are the same
    tuple, which is why the distinction could stay implicit until now; pointed
    at F2 they are not, and the difference is a leak — F3's test rows are in
    F2's future, so a reliability curve fitted on them would be fitted on days
    the artifact is about to be measured on.
    """
    if arm is None:
        named = LANE_RUNS.get(lane.gate_profile)
        if named is None:
            raise RetrainError(
                f"{lane}: no matrix arm is defined for gate profile "
                f"{lane.gate_profile!r}; the served lanes are {sorted(LANE_RUNS)}"
            )
        arm = MATRIX_RUN_BY_NAME[named]
    elif (arm.feature_set, arm.gate_profile) != (lane.feature_set, lane.gate_profile):
        raise RetrainError(
            f"{arm.name} reads {arm.feature_set!r} at {arm.gate_profile!r} and "
            f"{lane} is {lane.feature_set!r} at {lane.gate_profile!r}; the feature "
            "set and the gate are what the feature function is asked for, so an "
            "arm read through a lane that disagrees with it would be reported "
            "under a lane whose rows it never saw"
        )
    run = arm.name
    calendar = materialize_fold_calendar(as_of.date())
    if fold_id is None:
        fold = calendar.live_edge
        if fold is None:
            raise RetrainError(
                f"{as_of.date().isoformat()} is the first day of a quarter: the last "
                "fold has frozen and the next has not opened, so there is no live edge "
                "to score against. The next run has one."
            )
    else:
        try:
            fold = calendar.fold(fold_id)
        except FoldCalendarError as unknown:
            raise RetrainError(str(unknown)) from unknown
    go_live = await read_go_live(conn, "canonical_forecast_hour")
    blocks = fold.blocks_for(arm.window_start)
    window: Sequence[Mapping[str, Any]]
    if rows is None:
        window = await read_feature_rows(
            conn,
            FeatureRowsQuery(
                target_from=blocks.base_fit_start,
                target_to=blocks.test_end,
                gate_profile=arm.gate_profile,
                feature_set=arm.feature_set,
                threshold_mw=lane.threshold_mw,
            ),
        )
    else:
        # A materialised window is this fold's rows only if it *contains* them,
        # and containment is judged against the span the caller asked the
        # database for rather than against the dates that came back. A database
        # holding no row for the last week of a test block is a data fact; a
        # caller that read a week too few is a bug, and comparing observed dates
        # would make the two indistinguishable.
        if not rows.covers(blocks.base_fit_start, blocks.test_end):
            raise RetrainError(
                f"{lane}: materialised rows were read for "
                f"{rows.target_from.isoformat()}–{rows.target_to.isoformat()} and "
                f"{fold.id} needs "
                f"{blocks.base_fit_start.isoformat()}–{blocks.test_end.isoformat()} "
                f"for {run}; a window narrower than the fold would be scored on a "
                "short block that looks like an ingestion gap"
            )
        if (rows.gate_profile, rows.feature_set, rows.threshold_mw) != (
            arm.gate_profile,
            arm.feature_set,
            lane.threshold_mw,
        ):
            raise RetrainError(
                f"{lane}: materialised rows are "
                f"{rows.feature_set!r} at {rows.gate_profile!r}/"
                f"{rows.threshold_mw} and {run} reads {arm.feature_set!r} at "
                f"{arm.gate_profile!r}/{lane.threshold_mw}; rows shared between "
                "two arms that disagree about the feature function are not one "
                "dataset"
            )
        window = rows.between(blocks.base_fit_start, blocks.test_end)
    if not window:
        raise RetrainError(
            f"{lane}: feature_rows returned nothing for "
            f"{blocks.base_fit_start.isoformat()}–{blocks.test_end.isoformat()}"
        )
    prior: list[tuple[Fold, FoldBlocks, tuple[FoldSegment, ...]]] = []
    by_fold: dict[str, tuple[Mapping[str, Any], ...]] = {
        fold.id: _between(window, blocks.base_fit_start, blocks.test_end)
    }
    for earlier in calendar.folds:
        if earlier.index >= fold.index:
            # Only the folds this one is walked forward *from*. Never itself,
            # and never a later one: an expanding-origin calibration that
            # reached forward would be fitted on the days it is about to score.
            continue
        try:
            earlier_blocks = earlier.blocks_for(arm.window_start)
        except ValueError:
            # A fold whose base fit does not exist for this arm's window is not
            # a fault; it is a fold this arm is too young to have. The pool is
            # assembled from the ones that do.
            continue
        prior.append((earlier, earlier_blocks, stamp_fidelity(earlier, go_live)))
        by_fold[earlier.id] = _between(
            window, earlier_blocks.base_fit_start, earlier_blocks.test_end
        )
    serving_day = serving_target_date(as_of)
    return LaneInputs(
        lane=lane,
        run=run,
        window_start=arm.window_start,
        calendar=calendar,
        fold=fold,
        blocks=blocks,
        segments=stamp_fidelity(fold, go_live),
        prior=tuple(prior),
        function_definition=await read_feature_function_definition(conn),
        rows_by_fold=by_fold,
        serving_rows=tuple(
            await read_serving_rows(
                conn,
                target_date=serving_day,
                gate_profile=arm.gate_profile,
                feature_set=arm.feature_set,
                threshold_mw=lane.threshold_mw,
            )
        ),
        serving_day=serving_day,
    )


def _between(
    rows: Sequence[Mapping[str, Any]], first: date, last: date
) -> tuple[Mapping[str, Any], ...]:
    return tuple(row for row in rows if first <= row["target_date"] <= last)


def build_pool(inputs: LaneInputs) -> OutOfFoldPool:
    """The pooled out-of-fold curve, walked forward over the prior folds.

    `docs/specs/forecaster.md` publishes a reliability curve "measured across
    every walk-forward fold", and :func:`~wattsteer_ml.training.train_fold`
    refuses to fit without one — so the pool has to exist before the artifact
    does, and it cannot be built by training the artifact on each prior fold
    because that would need a pool per fold. It is built from
    :func:`~wattsteer_ml.training.out_of_fold_occurrence` instead, which is the
    same occurrence fit reaching the same predictions without the five learners
    the pool has no field for.

    **The pool carries one vintage fidelity or it carries none.** A curve pooled
    across ingestion go-live would be ``revision_optimistic`` with no way to say
    how much of it was, so when both kinds are present the point-in-time
    segments win and the rest are dropped: the curve then describes the world
    the artifact will actually be served into.
    """
    segments = [segment for _, _, stamped in inputs.prior for segment in stamped]
    if not segments:
        raise RetrainError(
            f"{inputs.lane}: {inputs.fold.id} has no frozen predecessor with a "
            "base-fit block, so there is no out-of-fold pool to calibrate on"
        )
    if any(segment.fidelity == "point_in_time" for segment in segments):
        segments = [
            segment for segment in segments if segment.fidelity == "point_in_time"
        ]
    keep: dict[str, list[FoldSegment]] = {}
    for segment in segments:
        keep.setdefault(segment.fold_id, []).append(segment)
    predictions: list[OutOfFoldPrediction] = []
    for earlier, earlier_blocks, _ in inputs.prior:
        windows = keep.get(earlier.id)
        if not windows:
            continue
        for prediction in out_of_fold_occurrence(
            inputs.rows_by_fold[earlier.id],
            fold=earlier,
            blocks=earlier_blocks,
            function_definition=inputs.function_definition,
        ):
            day = prediction.key.target_date
            if any(window.test_start <= day <= window.test_end for window in windows):
                predictions.append(prediction)
    if not predictions:
        raise RetrainError(
            f"{inputs.lane}: no prior fold produced a settled out-of-fold "
            "prediction, so the reliability curve has nothing behind it"
        )
    return OutOfFoldPool.of(predictions, segments=segments)


def scored_hours(
    forecasts: Sequence[Any], rows: Sequence[Mapping[str, Any]]
) -> tuple[ScoredHour, ...]:
    """A fitted bundle's forecasts, married to the labels they are scored on.

    Public rather than private because forecaster 18's driver needs the same
    two lines for each of the DESSEM A/B's three arms, and a third copy of
    ``ScoredHour(key=…, forecast=…, observed_mwh=row[TOTAL_COLUMN])`` is a third
    place the label column could be read wrongly.
    """
    return tuple(
        ScoredHour(
            key=hour.key, forecast=hour.forecast, observed_mwh=float(row[TOTAL_COLUMN])
        )
        for hour, row in zip(forecasts, rows, strict=True)
    )


def settled_rows(rows: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The rows whose label has settled. An unsettled hour is absent, not zero."""
    return [row for row in rows if row.get(TOTAL_COLUMN) is not None]


def _ladder_rungs() -> tuple[Rung, ...]:
    """Rungs 0–3. Rung 4 is the artifact itself and is scored from the bundle.

    :func:`~wattsteer_ml.evaluation.ladder.default_ladder` would fit rung 4 a
    second time — once for the table and once for the artifact — from the same
    rows to the same numbers, which is minutes of a weekly budget spent proving
    that ``train_fold`` is a function.
    """
    return (PrevalenceRung(), SameHourSevenDayRung(), LinearRung(), ForestRung())


def decided_in_run(root: Path, lane: Lane, run_id: str) -> str | None:
    """The decision this lane already recorded for ``run_id``, if it has one.

    The idempotency the ticket asks for, and it needs no new state: the run id
    *is* the artifact id, so a lane already carrying a line for it has taken its
    turn in this run. A redelivery therefore retrains nothing and appends
    nothing, which is what keeps "exactly one decision line per run" true the
    first time the queue redelivers a job. The decision word is returned rather
    than a rebuilt :class:`~wattsteer_ml.evaluation.gate.GateDecision`: the line
    and the card already hold the evidence, and a reconstruction would be a
    second, weaker copy of it.
    """
    log = root / PROMOTION_LOG_FILENAME
    if not log.is_file():
        return None
    for record in PromotionLog.read(log).for_lane(lane):
        if record.artifact_id == run_id:
            return record.decision
    return None


def retrain_lane(
    inputs: LaneInputs,
    *,
    request: RetrainRequest,
    stopwatch: Stopwatch | None = None,
) -> GateDecision | NoCandidate:
    """One lane, from its rows to its line. Raises only what the gate raises.

    The order is the spec's and it is load-bearing at two points. The artifact is
    written **before** the gate runs, because a refused candidate has to be
    inspectable — that is the whole reason a refusal writes a card. And the
    ``retrain`` block is written **after** the gate, because the wall clock the
    ticket asks for is not known until the decision is, and because
    :func:`~wattsteer_ml.evaluation.gate.record_decision` has by then already
    put the gate block on the same card.
    """
    watch = stopwatch or Stopwatch()
    lane = inputs.lane
    pool = build_pool(inputs)
    fold_rows = FoldRows.of(
        inputs.rows,
        fold=inputs.fold,
        blocks=inputs.blocks,
        function_definition=inputs.function_definition,
    )
    live_feature_hash = fold_rows.contract.feature_hash
    incumbent_id, incumbent = _incumbent(inputs, request=request, fold_rows=fold_rows)
    trained = train_fold(
        inputs.rows,
        fold=inputs.fold,
        blocks=inputs.blocks,
        function_definition=inputs.function_definition,
        pool=pool,
        incumbent_risk_bins=(
            None if incumbent is None else _incumbent_risk_bins(inputs, request)
        ),
        created_at=request.as_of,
        artifact_id=request.run_id,
    )
    save_artifact(trained.bundle, trained.card, root=request.root)

    rows = _metrics_rows(inputs, trained.bundle, fold_rows)
    if request.ladder:
        rows = (
            tuple(
                run_ladder(
                    inputs.rows,
                    fold=inputs.fold,
                    blocks=inputs.blocks,
                    segments=inputs.segments,
                    run=inputs.run,
                    rungs=_ladder_rungs(),
                    function_definition=inputs.function_definition,
                    day_grain=False,
                ).rows
            )
            + rows
        )
    # Both planning arms, onto the card this run just wrote. Forecaster 11's
    # missing line: `planning_arms.py` was merged, complete and covered, and
    # `grep -rn "planning_arms"` over this file, `app.py` and `__main__.py`
    # returned nothing, so no run ever produced the `planning_arm_comparison`
    # block the ticket said was "published per fold in the card, side by side".
    #
    # Here rather than in the gate, and deliberately not a gate input: the block
    # is evidence for a *posture* decision — whether v1 should go on planning
    # against P50 — and nothing in `run_gate` reads it. v1 still ships the P50
    # plan, which `_V1_SERVES_P50` says on the block itself.
    #
    # After `save_artifact` because `record_planning_arms` edits a card on the
    # volume and never mints one, and before the gate because the arms are read
    # out of Postgres rather than out of this candidate: the numbers do not
    # depend on the decision, and a refused candidate's card is exactly the one
    # an operator goes and looks at.
    _record_planning_arms(request, lane=lane, segments=inputs.segments)

    table = MetricsTable(rows=rows)
    _record_fold_metrics(request, lane=lane, table=table)
    deciding = inputs.deciding
    hours = scored_hours(
        forecast_rows(trained.bundle, settled_rows(fold_rows.segment_rows(deciding))),
        settled_rows(fold_rows.segment_rows(deciding)),
    )
    comparator = incumbent or cold_start_baseline(
        fold_rows, segment=deciding, run=inputs.run
    )
    candidate = GateCandidate(
        artifact_id=request.run_id,
        lane=lane,
        estimator_family=trained.bundle.estimator_family,
        feature_hash=trained.bundle.contract.feature_hash,
        # The newest target date this run's data window reached — see the module
        # docstring: check 4 is the alarm for ingestion having stopped, and the
        # base fit's last day cannot serve as one under a growing live edge.
        newest_training_target_date=inputs.blocks.test_end,
        metrics=table,
        run=inputs.run,
        deciding_row_id=deciding.row_id,
        hours=hours,
    )
    smoke = _smoke(inputs, trained.bundle, fold_rows)
    try:
        return run_gate(
            candidate,
            comparator,
            root=request.root,
            live_feature_hash=live_feature_hash,
            smoke=smoke,
            now=request.as_of,
        )
    finally:
        _write_retrain_block(
            request,
            lane=lane,
            inputs=inputs,
            resources=watch.read(),
            incumbent_id=incumbent_id,
            comparator=comparator.kind,
            live_feature_hash=live_feature_hash,
        )


async def _measure_arms(
    request: RetrainRequest, *, lane: Lane, segments: Sequence[FoldSegment]
) -> PlanningArmReport | UnmeasuredPlanningArms:
    """One read-only connection, one measurement, closed before anything is written."""
    conn: asyncpg.Connection[Any] = await asyncpg.connect(
        request.database_url, server_settings={"default_transaction_read_only": "on"}
    )
    try:
        return await measure_planning_arms(
            conn, segments=list(segments), lane=lane, as_of=request.as_of
        )
    finally:
        await conn.close()


def _record_planning_arms(
    request: RetrainRequest, *, lane: Lane, segments: Sequence[FoldSegment]
) -> None:
    """Write the arm comparison onto this run's card, or write why there is none.

    **A failed measurement does not fail the retrain**, and it does not leave
    the card silent either. The two failures caught here are the ones that are
    statements about the *data* rather than about the comparison —
    :class:`~wattsteer_ml.evaluation.planning_arms.PlanningArmError` for a
    segment whose held-out bands come from more than one backtest run, and
    :class:`asyncpg.PostgresError` for a database that cannot answer — and both
    become an :class:`~wattsteer_ml.evaluation.planning_arms.UnmeasuredPlanningArms`
    carrying the reason, for the reason that class exists: a card with no arm
    block and a card saying "this could not be measured" look identical to
    anybody grepping for the figure, and only one of them is true.

    Anything else propagates. A gate decision is not worth losing to a card
    edit, but a run that raised something nobody predicted has not been
    understood, and writing "the arms could not be measured" over it would be
    the one outcome this repository treats as worse than no answer at all.

    The empty case is *not* caught: ``measure_planning_arms`` raises on an empty
    segment list, which is a caller mistake rather than an empty table, and a
    retrain that reached here with no segment has a broken calendar.
    """
    try:
        report: PlanningArmReport | UnmeasuredPlanningArms = asyncio.run(
            _measure_arms(request, lane=lane, segments=segments)
        )
    except (PlanningArmError, asyncpg.PostgresError) as error:
        print(
            f"⚠️  planning arms {lane.directory_name}: {error}",
            file=sys.stderr,
        )
        report = UnmeasuredPlanningArms(
            lane=lane,
            as_of=request.as_of,
            reason=(
                f"the arm measurement did not complete against this database: {error}"
            ),
        )
    record_planning_arms(report, root=request.root, artifact_id=request.run_id)


def _record_fold_metrics(
    request: RetrainRequest, *, lane: Lane, table: MetricsTable
) -> None:
    """Keep the ladder on the card, which the gate used to be the only reader of.

    Every retrain scored rungs 0–4 on identical folds and then kept only the
    gate's verdict, so "what did the model add over the 7-day baseline" was
    computed weekly and unanswerable afterwards. The grain is the table's own —
    one row per ``(rung, fold, vintage_fidelity)`` — and nothing is averaged
    here, for the reason :class:`MetricsTable` refuses to.

    **A row's absent column is written as ``null``**, never left out and never
    zeroed: ``coverage_p10`` is ``None`` on a segment with no row that could
    falsify it, and the report renders that as an absence.
    """
    path = request.root / lane.directory_name / f"{request.run_id}{CARD_SUFFIX}"
    if not path.is_file():
        return
    entries = []
    for row in table.rows:
        full = row.as_card_entry()
        entries.append({key: full.get(key) for key in _FOLD_METRIC_COLUMNS})
    write_card(path, {**read_card(path), FOLD_METRICS_KEY: entries})


def _incumbent_risk_bins(inputs: LaneInputs, request: RetrainRequest) -> RiskBins | None:
    """The live artifact's published risk edges, held unless the pool moves them.

    **`.bins`, not the decision.** `calibration.risk_bins` is a
    `RiskBinDecision` — the edges *plus* whether they moved, why, the incumbent
    they were held against and the check that decided it — and
    `derive_risk_bins` takes the edges. Returning the whole decision type-checked
    only because this function was annotated `Any`, and every weekly retrain of a
    lane with a promoted artifact died on it:

        AttributeError: 'RiskBinDecision' object has no attribute 'classify'

    raised inside `_check`, which calls `bins.classify(...)`. `publication.py`
    reaches for `.bins` in the same situation and was right to.

    The return type is the real one now, so the next version of this mistake is
    a type error rather than a Monday morning.
    """
    try:
        loaded = load_artifact(
            root=request.root,
            lane=inputs.lane,
            artifact_id=_promoted(request.root, inputs.lane) or "",
        )
    except Exception:
        return None
    decision: RiskBinDecision = loaded.bundle.calibration.risk_bins
    return decision.bins


def _promoted(root: Path, lane: Lane) -> str | None:
    log = root / PROMOTION_LOG_FILENAME
    if not log.is_file():
        return None
    return PromotionLog.read(log).promoted(lane)


def _incumbent(
    inputs: LaneInputs, *, request: RetrainRequest, fold_rows: FoldRows
) -> tuple[str | None, Comparator | None]:
    """The promoted artifact, scored on the very rows the candidate will be.

    ``(None, None)`` — a cold start — in three cases, and the third is a
    decision rather than an oversight:

    - nothing has been promoted in this lane yet;
    - the promoted artifact is not on the volume;
    - the promoted artifact **refuses to load**, which is what
      :func:`~wattsteer_ml.training.load_artifact` does once the gate has stamped
      a contract fault on its card. That is the gate's own judgement that the
      incumbent was fitted against SQL the database no longer runs, and a lane
      whose incumbent has been declared invalid is cold: the candidate is then
      measured against rung 1, which it still has to beat, rather than against a
      model nothing may serve. Without this the lane would be stuck — refusing
      every week against an incumbent it cannot read.
    """
    artifact_id = _promoted(request.root, inputs.lane)
    if artifact_id is None:
        return None, None
    try:
        loaded = load_artifact(
            root=request.root, lane=inputs.lane, artifact_id=artifact_id
        )
    except Exception:
        return artifact_id, None
    settled = settled_rows(fold_rows.segment_rows(inputs.deciding))
    if not settled:
        return artifact_id, None
    hours = scored_hours(forecast_rows(loaded.bundle, settled), settled)
    return artifact_id, Comparator.incumbent(
        artifact_id=artifact_id,
        lane=inputs.lane,
        feature_hash=loaded.bundle.contract.feature_hash,
        row=MetricsRow.of(
            hours,
            run=f"{inputs.run}@incumbent",
            rung="lightgbm",
            rung_number=4,
            segment=inputs.deciding,
            calibrated=True,
            conformalised=True,
            correction=loaded.bundle.conformal,
        ),
        hours=hours,
    )


def _metrics_rows(
    inputs: LaneInputs, bundle: HurdleBundle, fold_rows: FoldRows
) -> tuple[MetricsRow, ...]:
    """Rung 4's row per segment — the artifact, scored by the served function."""
    rows: list[MetricsRow] = []
    for segment in inputs.segments:
        settled = settled_rows(fold_rows.segment_rows(segment))
        if not settled:
            continue
        hours = scored_hours(forecast_rows(bundle, settled), settled)
        rows.append(
            MetricsRow.of(
                hours,
                run=inputs.run,
                rung="lightgbm",
                rung_number=4,
                segment=segment,
                calibrated=True,
                conformalised=True,
                correction=bundle.conformal,
            )
        )
    if not rows:
        raise RetrainError(
            f"{inputs.lane}: {inputs.fold.id} carries no settled label, so the "
            "candidate has nothing to be scored on"
        )
    return tuple(rows)


def _smoke(inputs: LaneInputs, bundle: HurdleBundle, fold_rows: FoldRows) -> ServingSmoke:
    """Check 7, on tomorrow's real vector rather than on a fold's."""
    training = list(fold_rows.base_fit_rows) + list(fold_rows.calibration_rows)
    return serving_smoke(
        bundle,
        inputs.serving_rows,
        target_date=inputs.serving_day,
        training_null_rates=null_rates(training),
    )


def _write_retrain_block(
    request: RetrainRequest,
    *,
    lane: Lane,
    inputs: LaneInputs,
    resources: Resources,
    incumbent_id: str | None,
    comparator: str,
    live_feature_hash: str,
) -> None:
    """The cost of the run and the receipt for reproducing it, onto the card.

    Written in a ``finally``, so a candidate that was refused — or one whose gate
    raised on a contract drift — still carries what it cost. A card that is not
    on the volume is not an error here: a run that failed before
    :func:`~wattsteer_ml.training.save_artifact` has no artifact to annotate, and
    the report carries the resources instead.
    """
    path = request.root / lane.directory_name / f"{request.run_id}{CARD_SUFFIX}"
    if not path.is_file():
        return
    card = read_card(path)
    write_card(
        path,
        {
            **card,
            RETRAIN_BLOCK_KEY: {
                "run_id": request.run_id,
                "as_of": format_instant(request.as_of),
                "resources": resources.as_dict(),
                "reproduction": {
                    "run": inputs.run,
                    "window_start": inputs.window_start.isoformat(),
                    "fold": inputs.fold.id,
                    "fold_hash": inputs.fold.fold_hash,
                    "deciding_row_id": inputs.deciding.row_id,
                    # The true last day any booster was fitted on, beside the
                    # newest day the run's window reached. The gate is handed the
                    # second; the card never lets the first go unsaid.
                    "trained_to": inputs.blocks.calibration_end.isoformat(),
                    "data_to": inputs.blocks.test_end.isoformat(),
                    "serving_day": inputs.serving_day.isoformat(),
                    "live_feature_hash": live_feature_hash,
                    "comparator": comparator,
                    "incumbent": incumbent_id,
                    "ladder": request.ladder,
                },
            },
        },
    )


# --- both lanes ---------------------------------------------------------------


async def _lane_inputs(request: RetrainRequest, lane: Lane) -> LaneInputs:
    conn: asyncpg.Connection[Any] = await asyncpg.connect(
        request.database_url, server_settings={"default_transaction_read_only": "on"}
    )
    try:
        return await read_lane_inputs(conn, lane, as_of=request.as_of)
    finally:
        await conn.close()


def run_retrain(
    request: RetrainRequest,
    *,
    on_lane: Callable[[int, int], None] | None = None,
) -> ServingLanesReport:
    """Both lanes, once each, whatever the other did.

    The independence is
    :func:`~wattsteer_ml.evaluation.serving_lanes.run_serving_lanes`'s and is not
    re-argued here: it catches every per-lane exception — including the
    :class:`~wattsteer_ml.evaluation.gate.ContractDriftError` the gate raises on
    purpose, after its refusal is already on the volume — because the morning
    view is the fallback that makes a wrong evening call recoverable.

    ``on_lane`` is called with ``(lanes finished, lanes asked for)`` after each
    lane's turn, however that turn ended. **Forecaster 45**: the worker's only
    progress used to be one report before the call and one after, so a
    forty-minute job showed nothing for forty minutes and the operator's only
    window on a live run was the container's process metrics. A lane is the
    coarsest unit that is honestly finished, and it is the unit the report is
    already written in.
    """
    finished = 0
    total = len(request.lanes)

    def gate_one(lane: Lane) -> GateDecision | NoCandidate:
        recorded = decided_in_run(request.root, lane, request.run_id)
        if recorded is not None:
            return NoCandidate.from_decided_run(
                lane=lane,
                run_id=request.run_id,
                recorded=recorded,
                at=request.as_of,
            )
        watch = Stopwatch()
        try:
            inputs = asyncio.run(_lane_inputs(request, lane))
            return retrain_lane(inputs, request=request, stopwatch=watch)
        except ContractDriftError:
            # The gate's deliberate raise. Its refusal is already on the volume
            # and in the log; `run_serving_lanes` files it as this lane's
            # failure, and the other lane still runs.
            raise
        except (CalibrationError, RetrainError, TrainingError) as error:
            # A retrain that produced no artifact for the gate to decide about:
            # ``no_candidate``, not ``failed``. Nothing was appended and the
            # incumbent goes on serving. The three exceptions named here are the
            # ways the *data* can say there is nothing to fit — an empty base-fit
            # block, a risk-class edge the pool cannot determine, a window the
            # feature function returned nothing for — and an operator reading the
            # report should see those as statements about ingestion rather than
            # as a crash. Anything else still reaches ``run_serving_lanes`` as a
            # failure, because a lane that raised something nobody predicted has
            # not been understood.
            return NoCandidate.from_training_failure(error, lane=lane, at=request.as_of)

    def gate_one_reporting(lane: Lane) -> GateDecision | NoCandidate:
        # ``finally``, so a lane that raised still moves the count: the run's
        # progress is how far through the lanes it is, not how many of them went
        # well, and a bar that stuck on a failing lane would say the opposite.
        nonlocal finished
        try:
            return gate_one(lane)
        finally:
            finished += 1
            if on_lane is not None:
                on_lane(finished, total)

    return run_serving_lanes(gate_one_reporting, at=request.as_of, lanes=request.lanes)


# --- the process --------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    """``python -m wattsteer_ml.retrain`` — one run, one JSON report on stdout.

    A process rather than a request handler for the two reasons the module
    docstring gives: a peak RSS measured anywhere else is somebody else's, and a
    multi-minute LightGBM fit on a web server's event loop is an outage. The
    exit code is the operator's signal — non-zero when *no* lane reached a
    decision, which is the only outcome that is unambiguously a failed run.
    """
    parser = argparse.ArgumentParser(prog="wattsteer-ml-retrain")
    parser.add_argument(
        "--run-id",
        help=(
            "the scheduled instant, ISO-8601 UTC to the second. It becomes the "
            "artifact id in every lane, which is what makes a retry idempotent. "
            "Defaults to now, which is only right for a hand-run retrain."
        ),
    )
    parser.add_argument("--root", default=str(settings.artifact_dir))
    parser.add_argument("--database-url", default=settings.database_url or "")
    parser.add_argument(
        "--no-ladder",
        action="store_true",
        help="skip rungs 0–3. The card's ladder is then empty and a cold start "
        "has no rung-1 bar, so this is for a time-boxed rerun and not the schedule.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)
    if not args.database_url:
        print(
            json.dumps({"error": "no database url; set DATABASE_URL or pass one"}),
            file=sys.stderr,
        )
        return 2
    run_id = args.run_id or format_instant(datetime.now(UTC))
    request = RetrainRequest(
        run_id=run_id,
        as_of=datetime.strptime(run_id, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC),
        root=Path(args.root),
        database_url=args.database_url,
        ladder=not args.no_ladder,
    )
    watch = Stopwatch()

    def announce(done: int, total: int) -> None:
        """One progress line per lane, on stderr, flushed.

        **Forecaster 45.** stdout carries exactly one thing — the JSON report the
        service parses — so progress cannot go there without teaching the reader
        to skip lines. stderr is already read by the service as the run goes (it
        has to be: a child that fills a pipe nobody drains blocks on the write),
        so a line here reaches the status route within milliseconds and the
        queue's progress becomes the run's progress.
        """
        print(
            json.dumps({"progress": {"done": done, "total": total}}),
            file=sys.stderr,
            flush=True,
        )

    report = run_retrain(request, on_lane=announce)
    # After every decision is on the volume and before the exit code is read: the
    # page is a record of them, and its failure is a warning of its own.
    write_report_or_warn(request.root)
    payload = {
        **report.as_dict(),
        "run_id": request.run_id,
        "resources": watch.read().as_dict(),
    }
    print(json.dumps(payload))
    # Non-zero when *no* lane reached a decision, which is the only outcome that
    # is unambiguously a failed run — and a lane that was **already decided** is
    # not one. It is the idempotent no-op the short-circuit in `gate_one` exists
    # to produce, and forecaster 44 is what happens when the exit code cannot
    # tell the two apart: an operator's catch-up resolved to a run both lanes had
    # finished, every lane short-circuited, this returned 1, and the modelling
    # service reported `RETRAIN_FAILED` / HTTP 500 about a run that behaved
    # exactly as designed. The queue then retried it three times.
    decided = [
        outcome
        for outcome in report.outcomes
        if outcome.status in ("promoted", "refused")
    ]
    already = [outcome for outcome in report.outcomes if outcome.already_decided]
    return 0 if decided or already else 1


if __name__ == "__main__":  # pragma: no cover - the process entry point
    sys.exit(main())
