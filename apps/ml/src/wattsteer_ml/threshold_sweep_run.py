"""The caller the threshold sweep was missing: three arms, one database, one block.

`.scratch/forecaster/issues/17-threshold-sweep.md`, as api-surface 30 corrected
it:

    `grep -rn "run_threshold_sweep" apps/ml` finds the `def`, its own
    `__all__`, and one docstring cross-reference — **no caller at all, not even
    a test** … What is missing is the *run*.

:mod:`wattsteer_ml.evaluation.threshold_sweep` is the question — what the three
arms may and may not be read as saying — and it is complete and covered. What it
has never had is a driver: nothing in the repository ever produced a
:data:`~wattsteer_ml.evaluation.threshold_sweep.SweepScorer`, so
:func:`~wattsteer_ml.evaluation.threshold_sweep.run_threshold_sweep` was
unreachable from every process and the block's only attainable state was
:class:`~wattsteer_ml.evaluation.threshold_sweep.UnmeasuredThresholdSweep`. This
module is that driver, and it is deliberately the thinnest one that can exist —
the same shape, and for the same reasons, as :mod:`wattsteer_ml.dessem_ab_run`,
which is forecaster 18's answer to the identical omission.

## What is the same as the DESSEM A/B's driver, and why it is not shared

The composition is the retrain's, reused and not restated:
:func:`~wattsteer_ml.retrain.read_lane_inputs`,
:func:`~wattsteer_ml.retrain.build_pool`,
:func:`~wattsteer_ml.training.train_fold`,
:func:`~wattsteer_ml.retrain.settled_rows`,
:func:`~wattsteer_ml.retrain.scored_hours`. A shared base class over the two
drivers was considered and rejected: what differs is *what an arm is* — the A/B
varies the matrix run's window at one lane, this varies the lane's threshold at
one window — and that is exactly the axis a shared abstraction would have to
make generic, leaving both callers to configure the one thing each exists to
state. Two ninety-line drivers that each say what they vary are cheaper to read
than one that says neither.

## Three things are this module's own

1. **An arm is a lane, and every arm is saved.** The artifact's identity is the
   triple (feature set, gate profile, threshold), so each threshold trains into
   its own directory —
   :func:`~wattsteer_ml.evaluation.threshold_sweep.sweep_lane` is the authority
   on which. Unlike the A/B's twelve fits, these three *are* saved, because
   :func:`~wattsteer_ml.evaluation.threshold_sweep.record_threshold_sweep`
   writes onto a card in each lane and two of the three lanes have nothing
   promoted to write onto. That is the ticket's second box — "each threshold
   writes its own lane" — and it is why it is structural rather than a
   convention.

2. **Nothing is promoted, and that is checked rather than intended.**
   :func:`~wattsteer_ml.evaluation.threshold_sweep.assert_no_sweep_lane_promoted`
   runs *before* the first fit and again after the last write, against the
   append-only log. A sweep arm holding a ``promote`` line is a sweep that was
   acted on, which is the one outcome the ticket forbids in as many words. This
   module appends nothing to ``promotions.jsonl`` and has no branch that could.

3. **Identical folds and identical rows, which is the first box.** All three
   arms read the same fold through the same arm of the matrix — they differ
   only in the ``threshold_mw`` handed to ``feature_rows`` — so the row set is
   the same by construction and not by comparison. The module still asserts it:
   :class:`~wattsteer_ml.evaluation.threshold_sweep.ScoredFold` digests each
   arm's hour keys per fold segment, and a mismatch is a
   :class:`~wattsteer_ml.evaluation.matrix.RowIdentityError` naming the arm.

## What an empty or half-ingested database gets you

``UnmeasuredThresholdSweep``, written onto whatever cards exist, naming the
failure — never a prevalence of zero and never a fixture dressed as a reading.
The exceptions isolated are the retrain's own set (the ways the *data* can say
there is nothing to fit) plus :class:`asyncpg.PostgresError`, which is what an
unmigrated database raises, and :class:`NoArmHoursError`, this module's name for
a segment whose test rows carry no settled label. Anything else propagates: a
run that raised something nobody predicted has not been understood.

:meth:`~wattsteer_ml.evaluation.threshold_sweep.SweepProvenance.measured` is
reached from exactly one place here, and only after all three arms have come
back from ``forecast_rows`` over rows read out of Postgres. There is no flag and
no fixture path that reaches it.

## What this module does *not* claim

Writing the driver is not running the sweep.
:data:`~wattsteer_ml.evaluation.threshold_sweep.SWEEP_ARMS_NOT_SCORED` stays
published on ``/v1/meta`` — and stays the truthful thing to publish — until a
real run against an ingested database replaces it, because the block's
``sweep_source`` is what decides that and only a measured run sets it. The
prevalence conditions in the ticket's fourth box are evaluated by
:class:`~wattsteer_ml.evaluation.threshold_sweep.PrevalenceVerdict` off numbers
this driver produces; no number here is computed anywhere else.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Protocol

import asyncpg

from wattsteer_ml.canonical_reads import read_go_live
from wattsteer_ml.config import settings
from wattsteer_ml.evaluation import (
    Fold,
    FoldCalendar,
    FoldSegment,
    materialize_fold_calendar,
    stamp_fidelity,
)
from wattsteer_ml.evaluation.ladder import FoldRows
from wattsteer_ml.evaluation.threshold_sweep import (
    SWEEP_LANES,
    SWEPT_THRESHOLDS,
    THRESHOLD_SWEEP_BLOCK_KEY,
    SweepProvenance,
    ThresholdSweepError,
    ThresholdSweepReport,
    UnmeasuredThresholdSweep,
    assert_no_sweep_lane_promoted,
    record_threshold_sweep,
    run_threshold_sweep,
    sweep_lane,
)
from wattsteer_ml.experiment_reports import save_report
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
    save_artifact,
    train_fold,
)

#: The view whose ingestion go-live splits a fold into two vintage rows. The
#: retrain's constant, spelt the same way, because a segment stamped against a
#: different go-live is a different row.
GO_LIVE_VIEW = "canonical_forecast_hour"


class ThresholdSweepRunError(RuntimeError):
    """The run cannot proceed — no database, no scoreable fold, no arm."""


class NoArmHoursError(ThresholdSweepRunError):
    """A segment the database holds no settled label for.

    Its own class because it is the failure an un-ingested database produces
    *after* every query has succeeded, and it is therefore the one that would
    otherwise look like a bug in the sweep rather than like an empty table.
    """


#: The failures that mean *the data is not there*, as against the failures that
#: mean the code is wrong. The retrain's own set plus the one this driver adds.
DATA_FAILURES = (NoArmHoursError, CalibrationError, RetrainError, TrainingError)


class ArmScorer(Protocol):
    """One arm's scoring call, plus what it actually fitted.

    :data:`~wattsteer_ml.evaluation.threshold_sweep.SweepScorer` with one field
    added, because the report has to be able to say which ``(threshold, fold)``
    pairs were fitted and a bare callable cannot. Named as a protocol rather
    than as :class:`DatabaseArms` so a caller with hours of its own — a test —
    drives the whole run without a database, and so that the one implementation
    that *does* touch Postgres is visible as the only one that does.
    """

    def __call__(
        self, threshold_mw: float, segment: FoldSegment
    ) -> Sequence[ScoredHour]: ...

    @property
    def fits(self) -> tuple[str, ...]: ...


@dataclass(frozen=True)
class SweepEnvironment:
    """The two facts the run must read from Postgres before it can pick folds.

    A value rather than two reads inside the driver, so the folds a run swept
    and the vintage split it stamped are inputs a caller can pin — which is
    what makes the whole of :func:`run_sweep_from_database` exercisable without
    a database, and what stops the driver reading a clock of its own.
    """

    #: The matrix arm's window start, read through the default lane rather than
    #: respelt: the arm is recovered from the gate profile, and a second
    #: spelling here would be a second authority on what "the same rows" means.
    window_start: date
    #: ``canonical_forecast_hour``'s ingestion go-live, or ``None`` before it.
    go_live: datetime | None

    @classmethod
    def read(cls, request: ThresholdSweepRequest) -> SweepEnvironment:
        """Both, from one connection each, against the run's own instant."""
        return cls(
            window_start=asyncio.run(_window_start(request)),
            go_live=asyncio.run(_go_live(request.database_url)),
        )


def _has_base_fit(fold: Fold, window_start: date) -> bool:
    try:
        fold.blocks_for(window_start)
    except ValueError:
        # A window that opens inside this fold's calibration window leaves no
        # base fit. Not a fault: a fold the arm is too young to have.
        return False
    return True


def reportable_folds(calendar: FoldCalendar, *, window_start: date) -> tuple[Fold, ...]:
    """The folds the three arms can be fitted and scored on. No fold id written.

    A base-fit block, and an earlier fold with one to pool the reliability curve
    over — :func:`~wattsteer_ml.retrain.build_pool` needs a walk-forward
    predecessor and :func:`~wattsteer_ml.training.train_fold` refuses to fit
    without the pooled curve. One condition set rather than three, unlike the
    A/B's: the arms share a feature set, a gate profile and therefore a window
    start, so a fold is available to all three or to none, which is the same
    fact as "identical folds" seen from the calendar's side.
    """
    eligible: list[Fold] = []
    seen_predecessor = False
    for fold in calendar.folds:
        complete = _has_base_fit(fold, window_start)
        if complete and seen_predecessor:
            eligible.append(fold)
        seen_predecessor = seen_predecessor or complete
    return tuple(eligible)


@dataclass(frozen=True)
class ThresholdSweepRequest:
    """One sweep run, fully pinned. Nothing below this reads a clock."""

    as_of: datetime
    root: Path
    database_url: str

    def __post_init__(self) -> None:
        if self.as_of.tzinfo is None:
            raise ThresholdSweepRunError(
                "as_of must be tz-aware; a naive instant materialises no calendar"
            )

    @property
    def artifact_id(self) -> str:
        """The stem every arm is saved under, in its own lane.

        One id across the three lanes, exactly as the weekly retrain uses one
        across the two served ones: the lanes are different directories, so one
        id names all three, and a reader holding any arm's card can find the
        other two without parsing a filename.
        """
        return format_instant(self.as_of)

    def calendar(self) -> FoldCalendar:
        return materialize_fold_calendar(self.as_of.date())

    def promotion_log(self) -> PromotionLog:
        log = self.root / PROMOTION_LOG_FILENAME
        return PromotionLog.read(log) if log.is_file() else PromotionLog(log, ())


@dataclass(frozen=True)
class ArmFit:
    """One arm on one fold: what was read, what was fitted, what it is scored on.

    Cached per ``(threshold, fold)`` and not per segment, because a fold that
    straddles ingestion go-live is two *rows* of one fit — refitting per segment
    would make the two halves of one fold two models and the split meaningless.
    """

    inputs: LaneInputs
    bundle: HurdleBundle
    fold_rows: FoldRows


@dataclass
class DatabaseArms:
    """The :data:`~wattsteer_ml.evaluation.threshold_sweep.SweepScorer`, over Postgres.

    Callable, so it *is* the seam rather than something that adapts to it. One
    fit per ``(threshold, fold)`` and the arms of one fold read against the same
    instant, because each read materialises the calendar from ``request.as_of``
    and nothing here reads a clock.
    """

    request: ThresholdSweepRequest
    #: Whether each arm's bundle is written into its lane. Always true for a
    #: real run — the block has to land on a card that exists — and false only
    #: for a caller that wants the figures without the volume, which is a test.
    save: bool = True
    _fits: dict[tuple[float, str], ArmFit] = field(default_factory=dict)

    def __call__(
        self, threshold_mw: float, segment: FoldSegment
    ) -> tuple[ScoredHour, ...]:
        fit = self.fit(threshold_mw, segment.fold_id)
        rows = settled_rows(fit.fold_rows.segment_rows(segment))
        if not rows:
            raise NoArmHoursError(
                f"the {threshold_mw} MW arm has no settled test hour on "
                f"{segment.row_id}: the feature rows for "
                f"{segment.test_start.isoformat()}–{segment.test_end.isoformat()} "
                "carry no label, which is a statement about what has been "
                "ingested and not about the arm"
            )
        return scored_hours(forecast_rows(fit.bundle, rows), rows)

    def fit(self, threshold_mw: float, fold_id: str) -> ArmFit:
        key = (threshold_mw, fold_id)
        cached = self._fits.get(key)
        if cached is not None:
            return cached
        lane = sweep_lane(threshold_mw)
        inputs = asyncio.run(self._read(lane, fold_id))
        trained = train_fold(
            inputs.rows,
            fold=inputs.fold,
            blocks=inputs.blocks,
            function_definition=inputs.function_definition,
            pool=build_pool(inputs),
            created_at=self.request.as_of,
            artifact_id=self.request.artifact_id,
        )
        if self.save:
            # Into the arm's own lane. Saving is what makes the block writable
            # at all in the two lanes nothing serves, and it appends nothing to
            # the promotion log: an artifact on the volume that no line names is
            # inert, which is the property `assert_no_sweep_lane_promoted`
            # checks rather than assumes.
            save_artifact(trained.bundle, trained.card, root=self.request.root)
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
        return fit

    async def _read(self, lane: Lane, fold_id: str) -> LaneInputs:
        conn: asyncpg.Connection[Any] = await asyncpg.connect(
            self.request.database_url,
            server_settings={"default_transaction_read_only": "on"},
        )
        try:
            return await read_lane_inputs(
                conn, lane, as_of=self.request.as_of, fold_id=fold_id
            )
        finally:
            await conn.close()

    @property
    def fits(self) -> tuple[str, ...]:
        """Which ``(threshold, fold)`` pairs were actually fitted, for the report."""
        return tuple(f"thr{threshold}@{fold}" for threshold, fold in sorted(self._fits))


async def _go_live(database_url: str) -> datetime | None:
    conn: asyncpg.Connection[Any] = await asyncpg.connect(
        database_url, server_settings={"default_transaction_read_only": "on"}
    )
    try:
        return await read_go_live(conn, GO_LIVE_VIEW)
    finally:
        await conn.close()


async def _window_start(request: ThresholdSweepRequest) -> date:
    """The matrix arm's window start, read through the default lane."""
    conn: asyncpg.Connection[Any] = await asyncpg.connect(
        request.database_url, server_settings={"default_transaction_read_only": "on"}
    )
    try:
        inputs = await read_lane_inputs(conn, SWEEP_LANES[0], as_of=request.as_of)
    finally:
        await conn.close()
    return inputs.window_start


def _scoreable_segments(
    scorer: ArmScorer, segments: Sequence[FoldSegment]
) -> tuple[tuple[FoldSegment, ...], dict[str, dict[str, str]]]:
    """The segments carrying all three arms, and why the others do not.

    Isolated per segment for :mod:`wattsteer_ml.dessem_ab_run`'s recorded
    reason: the first run of that driver against an ingested database found one
    arm refusing on two of three reportable folds while the third — the newest,
    and decision-grade — carried every arm, and a run that aborted on the first
    refusal would have thrown a decision-grade quarter away.

    **What isolation must not become** is a quiet sample. Every refusal is
    returned and published on the block as ``folds_not_scored``, because a
    sweep over the folds that worked, beside no statement about the folds that
    did not, is the acceptance box satisfied by hiding a row.
    """
    scoreable: list[FoldSegment] = []
    refused: dict[str, dict[str, str]] = {}
    for segment in segments:
        reasons: dict[str, str] = {}
        for threshold in SWEPT_THRESHOLDS:
            try:
                scorer(threshold, segment)
            except DATA_FAILURES as absent:
                reasons[f"thr{threshold}"] = f"{type(absent).__name__}: {absent}"
        if reasons:
            refused[segment.row_id] = reasons
        else:
            scoreable.append(segment)
    return tuple(scoreable), refused


@dataclass(frozen=True)
class ThresholdSweepRunReport:
    """What one run produced: the block, where it was written, and what it cost.

    ``measured`` and ``not_run`` are exclusive, and the second carries the
    exception's own sentence: an operator who ran this against a database that
    has not been ingested needs the reason, and
    :data:`~wattsteer_ml.evaluation.threshold_sweep.SWEEP_ARMS_NOT_SCORED` is
    deliberately the same sentence every time and therefore cannot hold it.
    """

    as_of: datetime
    artifact_id: str
    fold_ids: tuple[str, ...]
    segment_ids: tuple[str, ...]
    fitted: tuple[str, ...]
    measured: ThresholdSweepReport | None
    not_run: str | None
    cards: tuple[str, ...]
    cards_absent: tuple[str, ...]
    #: The reportable segments no sweep could be made on, by row id, each naming
    #: the arm that refused and its reason. Beside ``fold_ids`` rather than
    #: subtracted from it, so the difference between the folds the calendar
    #: opened and the folds the evidence rests on is visible in the report.
    segments_refused: Mapping[str, Mapping[str, str]] = field(default_factory=dict)

    @property
    def is_measurement(self) -> bool:
        return self.measured is not None

    def as_dict(self) -> dict[str, Any]:
        block: dict[str, Any] = {
            "as_of": format_instant(self.as_of),
            "artifact_id": self.artifact_id,
            "folds_reportable": list(self.fold_ids),
            "segments": list(self.segment_ids),
            "segments_refused": {
                row_id: dict(reasons)
                for row_id, reasons in sorted(self.segments_refused.items())
            },
            "arms_fitted": list(self.fitted),
            "lanes": [lane.directory_name for lane in SWEEP_LANES],
            "measured": self.is_measurement,
            "not_run": self.not_run,
            "cards_written": list(self.cards),
            "cards_absent": list(self.cards_absent),
        }
        if self.measured is not None:
            block[THRESHOLD_SWEEP_BLOCK_KEY] = self.measured.card_block()[
                THRESHOLD_SWEEP_BLOCK_KEY
            ]
        return block


def run_sweep_from_database(
    request: ThresholdSweepRequest,
    *,
    scorer: ArmScorer | None = None,
    environment: SweepEnvironment | None = None,
) -> ThresholdSweepRunReport:
    """Score the three arms on every scoreable fold, and write the block.

    The order is deliberate and each step is a refusal the ticket names: no arm
    lane may already be promoted; the calendar decides the folds; the database
    decides whether they can be scored; and the block is written either way —
    a card with no ``threshold_sweep`` block and a card saying "the arms have
    not been scored" look identical to anybody grepping for the figure, and only
    one of them is true.
    """
    # Before the first fit, because a volume on which a sweep arm is already
    # promoted is one where the sweep has been acted on, and three more fits
    # would not make that less true.
    assert_no_sweep_lane_promoted(request.promotion_log())

    arms = scorer if scorer is not None else DatabaseArms(request=request)
    measured: ThresholdSweepReport | None = None
    not_run: str | None = None
    folds: tuple[Fold, ...] = ()
    segments: tuple[FoldSegment, ...] = ()
    refused: dict[str, dict[str, str]] = {}
    try:
        env = environment if environment is not None else SweepEnvironment.read(request)
        folds = reportable_folds(request.calendar(), window_start=env.window_start)
        if not folds:
            raise ThresholdSweepRunError(
                f"no fold on the calendar as of {request.as_of.date().isoformat()} "
                "has a base-fit block with a walk-forward predecessor behind it, "
                "so there is nothing to sweep. This is the calendar's arithmetic "
                "against the arm's window start, and it changes when the next "
                "quarter freezes"
            )
        segments = tuple(
            segment for fold in folds for segment in stamp_fidelity(fold, env.go_live)
        )
        scoreable, refused = _scoreable_segments(arms, segments)
        if not scoreable:
            raise NoArmHoursError(
                "no reportable fold carries all three arms: "
                + "; ".join(
                    f"{row_id} ({', '.join(sorted(reasons))})"
                    for row_id, reasons in sorted(refused.items())
                )
            )
        measured = run_threshold_sweep(
            arms,
            segments=scoreable,
            provenance=SweepProvenance.measured(at=request.as_of),
        )
    except (*DATA_FAILURES, asyncpg.PostgresError, OSError) as absent:
        # The database cannot support the sweep. The unmeasured block, with the
        # reason beside it in the report — never a prevalence of zero.
        not_run = f"{type(absent).__name__}: {absent}"

    report: ThresholdSweepReport | UnmeasuredThresholdSweep = (
        measured
        if measured is not None
        else UnmeasuredThresholdSweep(
            at=request.as_of,
            reason=not_run
            or "the three arms have not been scored against an ingested database",
        )
    )
    cards: list[str] = []
    absent_cards: list[str] = []
    for lane in SWEEP_LANES:
        try:
            path = record_threshold_sweep(
                report, root=request.root, artifact_id=request.artifact_id, lane=lane
            )
        except (BundleError, ThresholdSweepError, OSError) as missing:
            absent_cards.append(f"{lane.directory_name}: {missing}")
            continue
        cards.append(str(path))

    # And again after the writes: nothing above appends to the log, and this is
    # what makes that a checked property rather than a reading of this file.
    assert_no_sweep_lane_promoted(request.promotion_log())

    return ThresholdSweepRunReport(
        as_of=request.as_of,
        artifact_id=request.artifact_id,
        fold_ids=tuple(fold.id for fold in folds),
        segment_ids=tuple(segment.row_id for segment in segments),
        fitted=arms.fits,
        measured=measured,
        not_run=not_run,
        cards=tuple(cards),
        cards_absent=tuple(absent_cards),
        segments_refused={
            row_id: dict(reasons) for row_id, reasons in sorted(refused.items())
        },
    )


def main(argv: Sequence[str] | None = None) -> int:
    """``python -m wattsteer_ml.threshold_sweep_run`` — the sweep, once, as JSON.

    A process for the retrain's reasons: three LightGBM fits per reportable fold
    on the modelling service's event loop is an outage, and the sweep is a
    one-off against a frozen calendar rather than request-shaped. It has no
    cron and wants none — the ticket's own words are that the sweep is
    "published rather than acted on", and a weekly re-sweep would be three more
    artifact lanes a week for a question that is asked once.

    The exit code is the operator's signal. Non-zero when the arms were not
    scored, because a run that wrote the unmeasured block has recorded an
    absence honestly and has still not answered the question.
    """
    parser = argparse.ArgumentParser(prog="wattsteer-ml-threshold-sweep")
    parser.add_argument("--root", default=str(settings.artifact_dir))
    parser.add_argument("--database-url", default=settings.database_url or "")
    parser.add_argument(
        "--as-of",
        default=None,
        help=(
            "the instant the calendar is materialised at and the stem every arm "
            "is saved under, ISO-8601 UTC to the second. Defaults to now."
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
        report = run_sweep_from_database(
            ThresholdSweepRequest(
                as_of=as_of, root=Path(args.root), database_url=args.database_url
            )
        )
    except (ThresholdSweepRunError, ThresholdSweepError) as refusal:
        print(json.dumps({"error": str(refusal)}), file=sys.stderr)
        return 2
    payload = report.as_dict()
    save_report(Path(args.root), "threshold_sweep", as_of, payload)
    print(json.dumps(payload))
    return 0 if report.is_measurement else 1


__all__ = [
    "DATA_FAILURES",
    "GO_LIVE_VIEW",
    "ArmFit",
    "ArmScorer",
    "DatabaseArms",
    "NoArmHoursError",
    "SweepEnvironment",
    "ThresholdSweepRequest",
    "ThresholdSweepRunError",
    "ThresholdSweepRunReport",
    "main",
    "reportable_folds",
    "run_sweep_from_database",
]


if __name__ == "__main__":  # pragma: no cover - the process entry point
    sys.exit(main())
