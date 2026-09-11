"""The caller the DESSEM A/B was missing: three arms, one database, one block.

`.scratch/forecaster/issues/18-dessem-ab.md`:

    What is still needed is a fold sweep against a migrated, ingested database:
    `DessemScorer` is the seam, exactly as `SweepScorer` is in 17, because
    training needs a database and LightGBM and neither belongs to the question
    the module answers.

:mod:`wattsteer_ml.evaluation.dessem_ab` is that question — what the three arms
may and may not be read as saying — and it is complete. What it has never had is
a *caller*: nothing in the repository ever produced a
:data:`~wattsteer_ml.evaluation.dessem_ab.DessemScorer`, so the block's only
reachable state was
:func:`~wattsteer_ml.evaluation.dessem_ab.unmeasured_until_run`. This module is
that caller, and it is deliberately the thinnest one that can exist: it reads,
it fits, it hands the settled hours over, and every judgement about them stays
where it already lives.

## Why it is beside the retrain driver rather than inside it

The composition is the retrain's, reused and not restated —
:func:`~wattsteer_ml.retrain.read_lane_inputs`,
:func:`~wattsteer_ml.retrain.build_pool`,
:func:`~wattsteer_ml.training.train_fold`,
:func:`~wattsteer_ml.retrain.settled_rows`,
:func:`~wattsteer_ml.retrain.scored_hours` — exactly as
:mod:`wattsteer_ml.holdout_backfill` reuses it. Three things are new, and they
are the three the A/B needs:

1. **The arm is named rather than derived from the lane.** A served lane has one
   arm, so the retrain recovers it from ``lane.gate_profile``. The A/B has three
   at one gate, and two of them — ``A-full`` and ``A-common`` — share a lane
   because a lane is ``(feature_set, gate_profile, threshold_mw)`` and a *window*
   is not part of it. So ``read_lane_inputs`` now takes an optional ``arm``, and
   it refuses one that disagrees with the lane about the feature set or the gate.
2. **Nothing is saved and nothing is promoted.** The retrain and the holdout
   backfill both call :func:`~wattsteer_ml.training.save_artifact`, because their
   fits are things the product serves or replays. These twelve are not: they are
   an experiment's arms, and twelve artifacts sitting in the two served lanes
   under ids nothing promoted is exactly the confusion the lane layout exists to
   prevent. This module writes one thing — the ``dessem_delta`` block, through
   :func:`~wattsteer_ml.evaluation.dessem_ab.record_dessem_delta` — and it
   appends nothing to ``promotions.jsonl``.
3. **The folds are derived, not passed.** There is no ``--fold``. The A/B's
   sample is whatever the calendar makes scoreable, which is what makes it
   "re-runnable each quarter without a code change": a calendar materialised in
   2027 opens F7, F7 becomes reportable on its own arithmetic, and the verdict
   moves without an edit here. A flag that narrowed the folds could silently
   drop a decision-grade one and leave a *weaker* verdict looking like the same
   verdict.

## The rows are read once per window, not once per fit

``feature_rows`` measures at 58.4 s per 17,376 rows on real data (forecaster
32), and this driver used to call it once per ``(arm, fold)``: nine reads of two
distinct windows for a three-fold calendar, ninety minutes of them, inside a
loop that printed nothing. The first attempt at the real run was killed on the
strength of that silence and the A/B lost a decision-grade fold to it.

So :func:`plan_windows` derives, from the arms' own window starts and the
folds' own test ends, the smallest set of reads that covers every
``(arm, fold)`` pair — **two**, because each arm's folds share a base-fit start
and ``A-full``'s span contains ``A-common``'s — :meth:`DatabaseArms.materialise`
makes them before any arm is fitted, and
:func:`~wattsteer_ml.retrain.read_lane_inputs` slices what it is handed. It is
one path and not two: the materialised rows are an argument to the function that
otherwise reads them itself, so the arms are composed exactly as the weekly
retrain composes them.

**It is also the stronger discipline and not merely the faster one.** The old
path opened a connection per ``(arm, fold)``, so against a database under
concurrent ingestion three arms minutes apart read three databases —
and ``assert_identical_test_rows`` compares row *keys*, so it would have passed.
One read is one dataset by construction.

The equivalence materialising rests on — that a ``feature_rows`` row is a
function of its own target date and not of the range bounds it was asked for —
is a statement about SQL this module does not own, so it is **checked** rather
than assumed: :data:`EQUIVALENCE_PROBE_DAYS` at the end of each span are re-read
through the ordinary path and compared whole, and a disagreement raises
:class:`MaterialisationError` before an arm is fitted. Each window's span, row
count and probe land on the report.

## Which folds are scoreable, and why that is not the same as decision-grade

:func:`reportable_folds` applies two conditions and neither names a fold:

- every arm has a base-fit block in the fold at all
  (:meth:`~wattsteer_ml.evaluation.folds.Fold.blocks_for`, which raises for a
  window that opens inside the calibration window), and
- some earlier fold satisfies the same condition for every arm, because
  :func:`~wattsteer_ml.retrain.build_pool` needs a walk-forward predecessor and
  :func:`~wattsteer_ml.training.train_fold` refuses to fit without the pooled
  reliability curve.

**Decision grade is a third and separate thing** and it is not applied here:
that is
:meth:`~wattsteer_ml.evaluation.matrix.MatrixRun.decision_grade_folds` against
the calendar's ``min_base_fit_days``, evaluated inside
:class:`~wattsteer_ml.evaluation.dessem_ab.SegmentRow`. A fold that is
scoreable but not decision-grade is *reported and excluded from the verdict*,
which is the acceptance box, and it would be no use to anybody if this driver
had already dropped it.

## A fold an arm refuses is a row of the report, not the end of the run

The first run against an ingested database found the third case this module had
not had a shape for: not an empty database and not a complete one, but a
database on which *one arm* cannot be fitted on *some* folds. ``A-full``'s pool
admitted no publishable three-class risk split on two of the three reportable
folds, while the third — the newest, and decision-grade for all three arms —
carried every arm. A run that aborted on the first refusal would have thrown a
decision-grade quarter away over a quarter that decides nothing.

So :func:`_scoreable_segments` isolates :data:`DATA_FAILURES` per segment, and
every refusal is carried — in :attr:`DessemAbRunReport.segments_refused` and on
the block as ``folds_not_scored`` — because a verdict published beside no
statement of what was excluded is the acceptance box satisfied by hiding a row.
A database that cannot answer at all is still not a per-fold matter and still
ends the run.

## What an empty or half-ingested database gets you

``NOT_RUN_YET``, on the card, naming the failure. The exceptions caught are the
retrain's own set — the ways the *data* can say there is nothing to fit — plus
:class:`asyncpg.PostgresError`, which is what an unmigrated database raises, and
:class:`NoArmDataError`, which is this module's name for a segment whose test rows
carry no settled label. Anything else propagates: a run that raised something
nobody predicted has not been understood, and writing "the three runs have not
been scored" over it would be the one outcome this repository treats as worse
than no answer at all. The reason is carried in the report and the block, so
``dessem_source`` is ``unmeasured`` and never
:data:`~wattsteer_ml.evaluation.threshold_sweep.FOLD_EVALUATION_SOURCE`.

:meth:`~wattsteer_ml.evaluation.dessem_ab.DessemProvenance.measured` is reached
from exactly one place in this module, and only after every arm has come back
from ``forecast_rows`` over rows read out of Postgres. There is no flag, no
fixture path and no seeded default that reaches it — the fixture stamp exists
for the tests, which build their hours themselves and say so.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import asyncpg

from wattsteer_ml.canonical_reads import read_go_live
from wattsteer_ml.config import settings
from wattsteer_ml.constants import SUBSYSTEM_THRESHOLD_MW
from wattsteer_ml.evaluation import (
    Fold,
    FoldCalendar,
    FoldSegment,
    materialize_fold_calendar,
    stamp_fidelity,
)
from wattsteer_ml.evaluation.dessem_ab import (
    AB_GATE_PROFILE,
    AB_LANES,
    AB_RUNS,
    CONTRASTS,
    DESSEM_DELTA_BLOCK_KEY,
    DessemDeltaReport,
    DessemProvenance,
    DessemScorer,
    UnmeasuredDessemDelta,
    record_dessem_delta,
    run_dessem_ab,
    unmeasured_until_run,
)
from wattsteer_ml.evaluation.ladder import FoldRows
from wattsteer_ml.evaluation.matrix import MatrixRun
from wattsteer_ml.features import FeatureRowsQuery, MaterialisedFeatureRows
from wattsteer_ml.lanes import Lane, format_instant
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionLog
from wattsteer_ml.retrain import (
    LaneInputs,
    RetrainError,
    build_pool,
    read_lane_inputs,
    scored_hours,
    settled_rows,
)
from wattsteer_ml.training import (
    BundleError,
    CalibrationError,
    HurdleBundle,
    ScoredHour,
    TrainingError,
    forecast_rows,
    train_fold,
)

#: The view whose ingestion go-live splits a fold into two vintage rows. The
#: retrain's constant, spelt the same way, because a segment stamped against a
#: different go-live is a different row.
GO_LIVE_VIEW = "canonical_forecast_hour"


class DessemAbRunError(RuntimeError):
    """The run cannot proceed — no database, no scoreable fold, no card."""


class NoArmDataError(DessemAbRunError):
    """A segment the database holds no settled label for.

    Its own class because it is the failure an un-ingested database produces
    *after* every query has succeeded, and it is therefore the one that would
    otherwise look like a bug in the A/B rather than like an empty table.
    """


def _has_base_fit(fold: Fold, run: MatrixRun) -> bool:
    try:
        fold.blocks_for(run.window_start)
    except ValueError:
        # A window that opens inside this fold's calibration window leaves no
        # base fit. Not a fault: a fold this arm is too young to have.
        return False
    return True


def reportable_folds(calendar: FoldCalendar) -> tuple[Fold, ...]:
    """The folds all three arms can be fitted and scored on. No fold id written.

    See the module docstring: a base-fit block for every arm, and an earlier
    fold with one for every arm to pool the reliability curve over. Both
    conditions are the calendar's arithmetic against the runs' own window
    starts, so the answer moves when the calendar does and this function does
    not.
    """
    eligible: list[Fold] = []
    seen_predecessor = False
    for fold in calendar.folds:
        complete = all(_has_base_fit(fold, run) for run in AB_RUNS)
        if complete and seen_predecessor:
            eligible.append(fold)
        seen_predecessor = seen_predecessor or complete
    return tuple(eligible)


@dataclass(frozen=True)
class DessemAbRequest:
    """One A/B run, fully pinned. Nothing below this reads a clock."""

    as_of: datetime
    root: Path
    database_url: str
    #: The card each lane's block is written onto. ``None`` is that lane's
    #: promoted artifact, read from ``promotions.jsonl`` — the A/B describes the
    #: comparison a reader of the *served* card needs, and it is not an artifact
    #: of its own.
    artifact_id: str | None = None
    lanes: tuple[Lane, ...] = AB_LANES

    def __post_init__(self) -> None:
        if self.as_of.tzinfo is None:
            raise DessemAbRunError(
                "as_of must be tz-aware; a naive instant materialises no calendar"
            )

    def calendar(self) -> FoldCalendar:
        return materialize_fold_calendar(self.as_of.date())

    def card_artifact_id(self, lane: Lane) -> str:
        """Which card this lane's block lands on, or a refusal naming the lane."""
        if self.artifact_id is not None:
            return self.artifact_id
        log = self.root / PROMOTION_LOG_FILENAME
        promoted = PromotionLog.read(log).promoted(lane) if log.is_file() else None
        if promoted is None:
            raise DessemAbRunError(
                f"{lane.directory_name} has no promoted artifact, so there is no "
                "card for the dessem_delta block to be an edit of. Pass "
                "--artifact-id to name one, or promote something first: this "
                "module edits a card on the volume and never mints one"
            )
        return promoted


@dataclass(frozen=True)
class ArmFit:
    """One arm on one fold: what was read, what was fitted, what it is scored on.

    Cached per ``(run, fold)`` and not per segment, because a fold that
    straddles ingestion go-live is two *rows* of one fit — refitting per segment
    would make the two halves of one fold two models and the split meaningless.
    """

    inputs: LaneInputs
    bundle: HurdleBundle
    fold_rows: FoldRows


def _progress(message: str) -> None:
    """One observable line, on stderr, stamped with the instant it happened.

    The first attempt at this run was killed after ninety-three minutes because
    from outside, silence and a hang are the same thing — and that cost a
    decision-grade fold. stdout carries the one JSON report a caller parses, so
    the narration goes to stderr and is flushed: a line buffered until the run
    ends is not progress.
    """
    print(
        f"[{datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')}] {message}",
        file=sys.stderr,
        flush=True,
    )


@dataclass(frozen=True)
class ArmWindow:
    """The one ``feature_rows`` call a set of ``(arm, fold)`` reads is sliced from.

    A window is ``(feature_set, gate_profile, threshold_mw)`` plus a span of
    target dates, and it is deliberately **neither** per arm nor per fold:

    - every fold of one arm shares that arm's base-fit start and differs only in
      where the test block ends, so the widest fold's span contains all of them;
    - ``A-full`` and ``A-common`` differ only in *window start*, and the feature
      function has no parameter for one — so ``A-full``'s span contains
      ``A-common``'s and a single read serves both.

    Three arms over three folds is therefore **two** calls rather than nine, and
    at forecaster 32's measured 58.4 s per 17,376 rows that is the difference
    between a run somebody watches and a run somebody kills.
    """

    feature_set: str
    gate_profile: str
    threshold_mw: float
    target_from: date
    target_to: date

    @property
    def key(self) -> tuple[str, str, float]:
        return (self.feature_set, self.gate_profile, self.threshold_mw)

    def query(self) -> FeatureRowsQuery:
        return FeatureRowsQuery(
            target_from=self.target_from,
            target_to=self.target_to,
            gate_profile=self.gate_profile,  # type: ignore[arg-type]
            feature_set=self.feature_set,  # type: ignore[arg-type]
            threshold_mw=self.threshold_mw,
        )


def plan_windows(folds: Sequence[Fold]) -> tuple[ArmWindow, ...]:
    """The smallest set of reads that covers every arm on every fold.

    Derived from the arms' own window starts and the folds' own test ends —
    nothing here knows a date. A fold an arm has no base-fit block in
    contributes nothing to that arm's span, which is the rule
    :func:`reportable_folds` already applies and not a second one.
    """
    spans: dict[tuple[str, str, float], tuple[date, date]] = {}
    threshold = float(SUBSYSTEM_THRESHOLD_MW)
    for run in AB_RUNS:
        key = (run.feature_set, AB_GATE_PROFILE, threshold)
        for fold in folds:
            if not _has_base_fit(fold, run):
                continue
            blocks = fold.blocks_for(run.window_start)
            first, last = spans.get(key, (blocks.base_fit_start, blocks.test_end))
            spans[key] = (
                min(first, blocks.base_fit_start),
                max(last, blocks.test_end),
            )
    return tuple(
        ArmWindow(
            feature_set=feature_set,
            gate_profile=gate_profile,
            threshold_mw=threshold_mw,
            target_from=first,
            target_to=last,
        )
        for (feature_set, gate_profile, threshold_mw), (first, last) in sorted(
            spans.items()
        )
    )


#: How many days of each materialised window are re-read directly and compared
#: to the slice, whole, before any arm is fitted. Short, because what is being
#: checked is whether a feature row depends on the *range bounds* it was asked
#: for and a row either does or does not; long enough to span a fortnight of
#: gates, weekends and a month boundary rather than one lucky day.
EQUIVALENCE_PROBE_DAYS = 14


class MaterialisationError(DessemAbRunError):
    """The materialised rows are not what a direct read returns.

    Its own class, and deliberately not one of :data:`DATA_FAILURES`: a
    window-dependent feature row would make every figure in the block a
    measurement of something other than the arms, and that is a fault in the
    code rather than an absence in the data. It ends the run.
    """


@dataclass
class DatabaseArms:
    """The :data:`~wattsteer_ml.evaluation.dessem_ab.DessemScorer`, over Postgres.

    Callable, so it *is* the seam rather than something that adapts to it. One
    fit per ``(arm, fold)`` — twelve for a four-fold calendar — and the arms of
    one fold are read against the same instant because each read materialises
    the calendar from ``request.as_of`` and nothing here reads a clock.

    **The rows underneath those fits are read once per window, not once per
    fit.** :func:`plan_windows` collapses the nine reads a three-arm,
    three-fold calendar used to make into two, and
    :func:`~wattsteer_ml.retrain.read_lane_inputs` is then handed the
    materialised rows to slice. Reading once is the stronger discipline and not
    only the faster one: the old path opened a connection per ``(arm, fold)``,
    so three arms read minutes apart saw three states of a database under
    concurrent ingestion, and
    :func:`~wattsteer_ml.evaluation.dessem_ab.assert_identical_test_rows`
    compares row *keys* and would have passed.

    The equivalence that makes it legitimate is **checked, not assumed**:
    :meth:`materialise` re-reads :data:`EQUIVALENCE_PROBE_DAYS` of each window
    through the ordinary path and compares the rows whole, and a disagreement
    raises :class:`MaterialisationError` before any arm is fitted.
    """

    request: DessemAbRequest
    folds: tuple[Fold, ...] = ()
    _fits: dict[tuple[str, str], ArmFit] = field(default_factory=dict)
    _windows: dict[tuple[str, str, float], MaterialisedFeatureRows] = field(
        default_factory=dict
    )

    def __call__(self, run: MatrixRun, segment: FoldSegment) -> tuple[ScoredHour, ...]:
        fit = self.fit(run, segment.fold_id)
        rows = settled_rows(fit.fold_rows.segment_rows(segment))
        if not rows:
            raise NoArmDataError(
                f"{run.name} has no settled test hour on {segment.row_id}: the "
                f"feature rows for {segment.test_start.isoformat()}–"
                f"{segment.test_end.isoformat()} carry no label, which is a "
                "statement about what has been ingested and not about the arm"
            )
        return scored_hours(forecast_rows(fit.bundle, rows), rows)

    @property
    def arm_artifact_id(self) -> str:
        """The id every arm's fit carries, and the reason it is not descriptive.

        An id for the card the fit carries with it, never a path: none of these
        arms is saved, and the id therefore identifies nothing on the volume.
        What it must still be is an **artifact id**:
        :class:`~wattsteer_ml.training.bundle.ModelCard` refuses any stem that
        is not an ISO-8601 UTC instant, and a descriptive
        ``dessem-ab-<arm>-<fold>`` — which this driver passed until the arms
        were first run against an ingested database — raised
        :class:`~wattsteer_ml.training.bundle.BundleError` for *every* arm whose
        calibration succeeded. ``BundleError`` is not one of
        :data:`DATA_FAILURES`, so it propagated as the fault it was; what hid it
        for a whole ticket is that the first arm of the first fold refuses on
        this database for a data reason, and the driver stops there.

        So it is the run's own instant, shared by all twelve fits. The
        ``(arm, fold)`` identity the descriptive id was reaching for is carried
        by :attr:`fits` and by every row of the block, which are read rather
        than parsed out of a filename.
        """
        return format_instant(self.request.as_of)

    def materialise(self) -> tuple[str, ...]:
        """Read every window once, prove each one sliceable, and keep it.

        Returns one line per window for the report: the span, the row count and
        the probe that was compared. Called before any fit, so the whole cost of
        the run's reads is paid in one visible place, with a timestamp on each
        line, rather than scattered through the fold loop where it looked like a
        hang.
        """
        read: list[str] = []
        for window in plan_windows(self.folds):
            span = f"{window.target_from.isoformat()}..{window.target_to.isoformat()}"
            _progress(f"read  {window.feature_set} {span} ...")
            materialised, probe = asyncio.run(self._materialise(window))
            self._windows[window.key] = materialised
            read.append(
                f"{window.feature_set}@{window.gate_profile} {span} "
                f"{len(materialised.rows)} rows; probe "
                f"{probe[0].isoformat()}..{probe[1].isoformat()} identical to a "
                "direct read"
            )
            _progress(f"read  {read[-1]}")
        return tuple(read)

    async def _materialise(
        self, window: ArmWindow
    ) -> tuple[MaterialisedFeatureRows, tuple[date, date]]:
        conn: asyncpg.Connection[Any] = await asyncpg.connect(
            self.request.database_url,
            server_settings={"default_transaction_read_only": "on"},
        )
        try:
            rows = await MaterialisedFeatureRows.of(conn, window.query())
            # The probe sits at the end of the span, which is where the test
            # blocks are: the rows the verdict is actually taken on.
            last = window.target_to
            first = max(
                window.target_from, last - timedelta(days=EQUIVALENCE_PROBE_DAYS - 1)
            )
            if not await rows.agrees_with_a_direct_read(conn, first=first, last=last):
                raise MaterialisationError(
                    f"{window.feature_set}@{window.gate_profile}: the rows sliced "
                    f"out of {window.target_from.isoformat()}.."
                    f"{window.target_to.isoformat()} for {first.isoformat()}.."
                    f"{last.isoformat()} are not the rows a direct read of that "
                    "range returns, so a feature row depends on the range it was "
                    "asked for and materialising would change every figure here"
                )
            return rows, (first, last)
        finally:
            await conn.close()

    def fit(self, run: MatrixRun, fold_id: str) -> ArmFit:
        key = (run.name, fold_id)
        cached = self._fits.get(key)
        if cached is not None:
            return cached
        lane = Lane(
            feature_set=run.feature_set,
            gate_profile=AB_GATE_PROFILE,
            threshold_mw=float(SUBSYSTEM_THRESHOLD_MW),
        )
        _progress(f"fit   {run.name}@{fold_id} reading ...")
        inputs = asyncio.run(self._read(lane, run, fold_id))
        _progress(f"fit   {run.name}@{fold_id} {len(inputs.rows)} rows, training ...")
        trained = train_fold(
            inputs.rows,
            fold=inputs.fold,
            blocks=inputs.blocks,
            function_definition=inputs.function_definition,
            pool=build_pool(inputs),
            created_at=self.request.as_of,
            artifact_id=self.arm_artifact_id,
        )
        fit = ArmFit(
            inputs=inputs,
            bundle=trained.bundle,
            fold_rows=FoldRows.of(
                inputs.rows,
                fold=inputs.fold,
                blocks=inputs.blocks,
                function_definition=inputs.function_definition,
            ),
        )
        self._fits[key] = fit
        _progress(f"fit   {run.name}@{fold_id} fitted")
        return fit

    async def _read(self, lane: Lane, run: MatrixRun, fold_id: str) -> LaneInputs:
        conn: asyncpg.Connection[Any] = await asyncpg.connect(
            self.request.database_url,
            server_settings={"default_transaction_read_only": "on"},
        )
        try:
            return await read_lane_inputs(
                conn,
                lane,
                as_of=self.request.as_of,
                fold_id=fold_id,
                arm=run,
                # ``None`` when nothing was materialised, which is the direct
                # read this driver used to make every time: the fast path is an
                # optimisation of the slow one and never a second path.
                rows=self._windows.get(
                    (run.feature_set, AB_GATE_PROFILE, lane.threshold_mw)
                ),
            )
        finally:
            await conn.close()

    @property
    def fits(self) -> tuple[str, ...]:
        """Which ``(arm, fold)`` pairs were actually fitted, for the report."""
        return tuple(f"{name}@{fold}" for name, fold in sorted(self._fits))


async def _go_live(database_url: str) -> datetime | None:
    conn: asyncpg.Connection[Any] = await asyncpg.connect(
        database_url, server_settings={"default_transaction_read_only": "on"}
    )
    try:
        return await read_go_live(conn, GO_LIVE_VIEW)
    finally:
        await conn.close()


def _scoreable_segments(
    scorer: DessemScorer, segments: Sequence[FoldSegment]
) -> tuple[tuple[FoldSegment, ...], dict[str, dict[str, str]]]:
    """The segments carrying all three arms, and why the others do not.

    **Why the failure is isolated per segment rather than taken for the run.**
    The comparison is one row set per fold and three arms over it, so a segment
    an arm cannot be fitted on is not a comparison and never becomes one. What
    it is *not* is a reason to abandon the folds that do carry all three: the
    first run against an ingested database refused ``A-full`` on two of the
    three reportable folds — no three-class risk split of its pool is both
    calibrated and separated, which is a fact about that arm on that data — and
    the third fold, the newest and the one with the longest common base fit, was
    complete. Aborting there would have thrown away a decision-grade quarter for
    a refusal in a quarter that decides nothing, which is data-platform 21's
    finding about the DESSEM ingestor in another shape: one bad day took the
    whole task with it.

    **What isolation must not become** is a quiet sample. Every refusal is
    returned, carried in :attr:`DessemAbRunReport.segments_refused` *and* on the
    block as ``folds_not_scored``, because a verdict published over the folds
    that worked, beside no statement about the folds that did not, is the
    acceptance box satisfied by hiding a row. Nothing here decides that a
    refused fold does not matter; it decides only that the refusal is a row of
    the report rather than the end of it.

    Only :data:`DATA_FAILURES` are isolated. A database that cannot answer at
    all is not a per-fold matter and still ends the run, which is why
    ``asyncpg.PostgresError`` is caught by the caller and not here.
    """
    scoreable: list[FoldSegment] = []
    refused: dict[str, dict[str, str]] = {}
    for segment in segments:
        reasons: dict[str, str] = {}
        for run in AB_RUNS:
            try:
                scorer(run, segment)
            except DATA_FAILURES as absent:
                reasons[run.name] = f"{type(absent).__name__}: {absent}"
        if reasons:
            refused[segment.row_id] = reasons
            _progress(f"score {segment.row_id} refused by {sorted(reasons)}")
        else:
            scoreable.append(segment)
            _progress(f"score {segment.row_id} carries all three arms")
    return tuple(scoreable), refused


#: The failures that mean *the data is not there*, as against the failures that
#: mean the code is wrong. The retrain's own set — an empty base-fit block, a
#: risk-class edge the pool cannot determine, a window the feature function
#: returned nothing for — plus the two this driver adds: a database that cannot
#: answer at all, and a segment with no settled label.
DATA_FAILURES = (NoArmDataError, CalibrationError, RetrainError, TrainingError)


@dataclass(frozen=True)
class DessemAbRunReport:
    """What one run produced: the block, where it was written, and what it cost.

    ``measured`` and ``not_run`` are exclusive, and the second carries the
    exception's own sentence: an operator who ran this against a database that
    has not been ingested needs the reason, and the block's ``NOT_RUN_YET`` is
    deliberately the same sentence every time and therefore cannot hold it.
    """

    as_of: datetime
    fold_ids: tuple[str, ...]
    segment_ids: tuple[str, ...]
    fitted: tuple[str, ...]
    measured: DessemDeltaReport | None
    not_run: str | None
    cards: tuple[str, ...]
    cards_absent: tuple[str, ...]
    #: The reportable segments no comparison could be made on, by row id, each
    #: naming the arm that refused and its reason. Beside ``fold_ids`` rather
    #: than subtracted from it, so the difference between the folds the calendar
    #: opened and the folds the verdict rests on is visible in the report.
    segments_refused: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    #: One line per materialised ``feature_rows`` window: its span, its row
    #: count and the probe range that was re-read directly and found identical.
    #: On the report rather than only in the log, because "the arms were scored
    #: on rows nobody re-read" and "the arms were scored on rows checked against
    #: a direct read" are different claims and only one of them is this run's.
    windows: tuple[str, ...] = ()

    @property
    def is_measurement(self) -> bool:
        return self.measured is not None

    def as_dict(self) -> dict[str, Any]:
        block: dict[str, Any] = {
            "as_of": format_instant(self.as_of),
            "folds_reportable": list(self.fold_ids),
            "segments": list(self.segment_ids),
            "segments_refused": {
                row_id: dict(reasons)
                for row_id, reasons in sorted(self.segments_refused.items())
            },
            "windows_materialised": list(self.windows),
            "arms_fitted": list(self.fitted),
            "measured": self.is_measurement,
            "not_run": self.not_run,
            "cards_written": list(self.cards),
            "cards_absent": list(self.cards_absent),
        }
        if self.measured is not None:
            body = self.measured.card_block()[DESSEM_DELTA_BLOCK_KEY]
            block["verdicts"] = {
                contrast.name: body["contrasts"][contrast.name]["verdict"]
                for contrast in CONTRASTS
            }
            block[DESSEM_DELTA_BLOCK_KEY] = body
        return block


def run_dessem_ab_from_database(request: DessemAbRequest) -> DessemAbRunReport:
    """Score the three arms on every scoreable fold, and write the block.

    The order is deliberate: the calendar decides the folds, the database
    decides whether they can be scored, and the block is written either way —
    a card with no ``dessem_delta`` block and a card saying "the three runs have
    not been scored" look identical to anybody grepping for the figure, and only
    one of them is true.
    """
    calendar = request.calendar()
    folds = reportable_folds(calendar)
    if not folds:
        raise DessemAbRunError(
            f"no fold on the calendar as of {request.as_of.date().isoformat()} "
            f"gives all of {[run.name for run in AB_RUNS]} a base-fit block with "
            "a walk-forward predecessor behind it, so there is nothing to score. "
            "This is the calendar's arithmetic against the runs' window starts, "
            "and it changes when the next quarter freezes"
        )
    scorer = DatabaseArms(request=request, folds=folds)
    measured: DessemDeltaReport | None = None
    not_run: str | None = None
    segments: tuple[FoldSegment, ...] = ()
    refused: dict[str, dict[str, str]] = {}
    windows: tuple[str, ...] = ()
    _progress(f"folds reportable {[fold.id for fold in folds]}")
    try:
        go_live = asyncio.run(_go_live(request.database_url))
        # Every read the run will make, made now, checked now, and narrated.
        # A MaterialisationError here is not a DATA_FAILURE and propagates.
        windows = scorer.materialise()
        segments = tuple(
            segment for fold in folds for segment in stamp_fidelity(fold, go_live)
        )
        scoreable, refused = _scoreable_segments(scorer, segments)
        if not scoreable:
            raise NoArmDataError(
                "no reportable fold carries all three arms: "
                + "; ".join(
                    f"{row_id} ({', '.join(sorted(reasons))})"
                    for row_id, reasons in sorted(refused.items())
                )
            )
        measured = run_dessem_ab(
            scorer,
            segments=scoreable,
            calendar=calendar,
            provenance=DessemProvenance.measured(at=request.as_of),
            not_scored=refused,
        )
    except (*DATA_FAILURES, asyncpg.PostgresError, OSError) as absent:
        # The database cannot support the comparison. NOT_RUN_YET, with the
        # reason beside it in the report — never a floor of zero, and never a
        # fixture dressed as a reading.
        not_run = f"{type(absent).__name__}: {absent}"

    cards: list[str] = []
    absent_cards: list[str] = []
    for lane in request.lanes:
        report: DessemDeltaReport | UnmeasuredDessemDelta = (
            measured
            if measured is not None
            else unmeasured_until_run(lane=lane, at=request.as_of)
        )
        try:
            path = record_dessem_delta(
                report,
                root=request.root,
                artifact_id=request.card_artifact_id(lane),
                lane=lane,
            )
        except (BundleError, DessemAbRunError) as missing:
            absent_cards.append(f"{lane.directory_name}: {missing}")
            continue
        cards.append(str(path))
    return DessemAbRunReport(
        as_of=request.as_of,
        fold_ids=tuple(fold.id for fold in folds),
        segment_ids=tuple(segment.row_id for segment in segments),
        fitted=scorer.fits,
        measured=measured,
        not_run=not_run,
        cards=tuple(cards),
        cards_absent=tuple(absent_cards),
        windows=windows,
        segments_refused={
            row_id: dict(reasons) for row_id, reasons in sorted(refused.items())
        },
    )


def main(argv: Sequence[str] | None = None) -> int:
    """``python -m wattsteer_ml.dessem_ab_run`` — the A/B, once, as JSON.

    A process for the retrain's reasons: twelve LightGBM fits on the modelling
    service's event loop is an outage, and the A/B is quarterly rather than
    request-shaped.

    The exit code is the operator's signal. Non-zero when the arms were not
    scored, because a run that wrote ``NOT_RUN_YET`` has recorded an absence
    honestly and has still not answered the question.
    """
    parser = argparse.ArgumentParser(prog="wattsteer-ml-dessem-ab")
    parser.add_argument("--root", default=str(settings.artifact_dir))
    parser.add_argument("--database-url", default=settings.database_url or "")
    parser.add_argument(
        "--artifact-id",
        default=None,
        help=(
            "the card the block is written onto, in every lane. Defaults to each "
            "lane's promoted artifact, which is the card a reader of the served "
            "model holds."
        ),
    )
    parser.add_argument(
        "--as-of",
        default=None,
        help=(
            "the instant the calendar is materialised at, ISO-8601 UTC to the "
            "second. Defaults to now, which is right for the quarterly run."
        ),
    )
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
    try:
        report = run_dessem_ab_from_database(
            DessemAbRequest(
                as_of=as_of,
                root=Path(args.root),
                database_url=args.database_url,
                artifact_id=args.artifact_id,
            )
        )
    except DessemAbRunError as refusal:
        print(json.dumps({"error": str(refusal)}), file=sys.stderr)
        return 2
    print(json.dumps(report.as_dict()))
    return 0 if report.is_measurement else 1


__all__ = [
    "DATA_FAILURES",
    "EQUIVALENCE_PROBE_DAYS",
    "GO_LIVE_VIEW",
    "ArmFit",
    "ArmWindow",
    "DatabaseArms",
    "DessemAbRequest",
    "DessemAbRunError",
    "DessemAbRunReport",
    "MaterialisationError",
    "NoArmDataError",
    "main",
    "plan_windows",
    "reportable_folds",
    "run_dessem_ab_from_database",
]


if __name__ == "__main__":  # pragma: no cover - the process entry point
    sys.exit(main())
