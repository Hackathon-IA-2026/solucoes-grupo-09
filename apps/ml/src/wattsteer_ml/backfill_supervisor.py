"""Supervising a holdout backfill, as opposed to waiting on one.

:mod:`wattsteer_ml.holdout_backfill` is what the *child* executes. This is what
starts it, and it exists for the reason
:mod:`wattsteer_ml.retrain_supervisor` exists — measured again, on this route,
on 2026-09-23.

**The same defect, in the one place forecaster 45 did not reach.** The retrain
stopped running its child inside the POST when that shape was shown not to
survive the deployment's internal networking: a request that transmits no bytes
for minutes is cut at 300 s while the service goes on working, and uvicorn logs
the access line on *response*, so the whole run is invisible until it is over.
The backfill kept the old shape, and the consequence was worse than a wrong
failure line, because this route's product **is** its response body: the service
is read-only against Postgres and the worker is what appends the rows. So the
child ran, the connection it was going to answer was already gone, and the rows
it computed were discarded.

Measured on the live deployment: the worker's job was enqueued at 23:02 and
failed at 23:07:48 with "The ML service is unreachable" — about 350 s, not the
forty-minute ceiling it was configured with. A later attempt was refused
`HOLDOUT_BACKFILL_IN_PROGRESS` for ninety minutes, which is the same child still
running, still with nowhere to send its answer. Every replayable day the Time
Machine was missing was missing for this reason: `/v1/replay/days` offered the
five days the forecaster had *served* and none of the days a fold had held out,
because no backfill had ever landed.

So the run outlives the request that started it. The POST starts the child and
answers 202 with the fold key; ``GET /internal/backfill/holdout/{fold}`` reads
the record and, once there is one, carries the report the POST used to return —
so the worker's parser did not have to learn a second shape.

**Why a separate module and not a parameter on the retrain's.** That one's
progress is a lane count it parses out of the child's stderr, its history bound
is "several weeks of Fridays", and its refusal codes are the retrain's. Every
one of those is a different fact here. Two files that read alike are cheaper to
follow than one with a mode switch, and the retrain's is load-bearing enough
that widening it to serve a second caller is a change to the path that promotes
artifacts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Literal

logger = logging.getLogger(__name__)

#: Fold keys currently being backfilled by this instance.
#:
#: Taken by the POST and released by the supervising task rather than by the
#: request, because the run outlives the request. What it prevents is what it
#: always prevented — a second child racing the first over one artifact id.
#:
#: In-process, so it holds for one instance, which is the case that actually
#: happens: the durable guard is that the rows carry the fold's own artifact id,
#: so a later pass supersedes rather than duplicates.
_BACKFILLING: set[str] = set()

#: The status route, as a template. Named here so the string in the decorator
#: and the one the 202 hands the worker cannot drift apart.
STATUS_PATH = "/internal/backfill/holdout/{fold}"

#: The key a request with no ``fold_id`` runs under — "the newest frozen fold",
#: which is what the weekly schedule asks for. A path segment rather than an
#: empty string, because the status route's URL has to name it.
LATEST = "latest"

#: How many finished runs are remembered after the worker has read them.
#: Smaller than the retrain's: a backfill is quarterly work with an operator's
#: catch-up on top, not a weekly cadence, and the report is megabytes rather
#: than kilobytes — it is ninety days of four subsystems' hours.
_BACKFILL_HISTORY = 4

#: Bytes of the child's stderr kept for the failure body. The route publishes
#: the last 2,000 characters; the rest is in the service's own log.
_STDERR_TAIL = 8_192

#: The child's report is the rows themselves, so the pipe is sized for the
#: answer rather than for a typical one. This is the limit the blocking version
#: carried and the reason for it has not changed.
_PIPE_LIMIT = 64 * 1024 * 1024


@dataclass
class BackfillRun:
    """One backfill, as something to ask about rather than to wait on."""

    fold: str
    #: Monotonic, so an elapsed time is not a subtraction of two wall clocks.
    started_at: float
    #: ``running`` until the child exits, then ``done`` or ``failed``.
    status: Literal["running", "done", "failed"] = "running"
    #: The child's last line of stderr, as it arrives.
    #:
    #: A fold that clears the risk-bin rule goes on to mint a publication and a
    #: Shapley attribution for every held-out day, which is hours of work — and
    #: with stderr read only at exit, all of it was invisible. Measured
    #: 2026-09-24: two children at 20 CPU-hours each, four hours in, with
    #: nothing on the status route but ``running`` and a clock. An operator
    #: cannot tell that from a hang, and the first thing they reach for is a
    #: bigger ceiling.
    note: str | None = None
    #: The report the POST used to return, once there is one.
    report: dict[str, Any] | None = None
    #: ``(code, message, details)`` — the refusal the status route answers with.
    failure: tuple[str, str, dict[str, Any]] | None = None
    task: asyncio.Task[None] | None = None

    @property
    def finished(self) -> bool:
        return self.status != "running"

    @property
    def elapsed_seconds(self) -> float:
        return time.monotonic() - self.started_at


#: Every run this instance has started, newest last.
_BACKFILL_RUNS: dict[str, BackfillRun] = {}


def _forget_old_runs() -> None:
    """Drop the oldest *finished* runs past :data:`_BACKFILL_HISTORY`.

    Never a running one: forgetting a run that is still going would make the
    status route answer 404 about a live child, which is the reporting defect
    this module exists to remove, reintroduced from the other end.
    """
    finished = [fold for fold, run in _BACKFILL_RUNS.items() if run.finished]
    for fold in finished[: max(0, len(finished) - _BACKFILL_HISTORY)]:
        del _BACKFILL_RUNS[fold]


async def _pump_stderr(stream: asyncio.StreamReader, run: BackfillRun) -> bytes:
    """Read the child's stderr as it arrives, keeping the tail and the last line.

    Read in chunks and split by hand rather than with ``readline``, which raises
    on a line longer than its buffer — a traceback is not a thing to lose the
    run's last word over. This is `retrain_supervisor._pump_stderr` with the
    lane-progress parsing removed: the backfill's child prints prose rather than
    a lane count, so what is worth carrying is the latest line.
    """
    tail = b""
    buffered = b""
    while True:
        chunk = await stream.read(65_536)
        if not chunk:
            break
        tail = (tail + chunk)[-_STDERR_TAIL:]
        buffered += chunk
        *lines, buffered = buffered.split(b"\n")
        for line in lines:
            text = line.decode("utf-8", "replace").strip()
            if text:
                run.note = text[:300]
        if len(buffered) > _STDERR_TAIL:
            buffered = buffered[-_STDERR_TAIL:]
    return tail


async def _supervise_backfill(run: BackfillRun, argv: list[str]) -> None:
    """Run the child to completion and record what it did on ``run``.

    Nothing here is awaited by a request handler. It owns :data:`_BACKFILLING`
    for the length of the run and releases it however the run ends.
    """
    try:
        child = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_PIPE_LIMIT,
        )
        assert child.stdout is not None and child.stderr is not None
        # Both pipes drained concurrently: a child that fills one while nobody
        # reads it blocks on the write, and a backfill blocked on its own stderr
        # would look exactly like a backfill that is still scoring.
        err, out = await asyncio.gather(
            _pump_stderr(child.stderr, run), child.stdout.read()
        )
        returncode = await child.wait()
        if returncode != 0:
            logger.error(
                "holdout backfill %s exited %s: %s | stdout: %s",
                run.fold,
                returncode,
                err[-_STDERR_TAIL:],
                out[-2_000:],
            )
            run.failure = (
                "HOLDOUT_BACKFILL_FAILED",
                f"the holdout backfill process exited {returncode}",
                {
                    "fold_id": None if run.fold == LATEST else run.fold,
                    "exit_code": returncode,
                    "stderr": err.decode("utf-8", "replace")[-2_000:],
                    # Each lane's reason is in the report, which is on stdout: a
                    # run that reconstructed no lane exits 1 with stderr empty.
                    "stdout": out.decode("utf-8", "replace")[-2_000:],
                },
            )
            run.status = "failed"
            return
        try:
            report = json.loads(out.decode("utf-8"))
        except ValueError:
            logger.error("holdout backfill %s printed no report", run.fold)
            run.failure = (
                "HOLDOUT_BACKFILL_FAILED",
                "the holdout backfill process exited cleanly and printed no report",
                {"fold_id": None if run.fold == LATEST else run.fold},
            )
            run.status = "failed"
            return
        run.report = report
        run.status = "done"
    except Exception as error:  # the supervisor is nobody's caller
        # A task whose exception nobody retrieves is a warning on the event loop
        # and a run that says ``running`` forever. Named here instead.
        logger.exception("holdout backfill %s could not be supervised", run.fold)
        run.failure = (
            "HOLDOUT_BACKFILL_FAILED",
            f"the holdout backfill could not be run: {type(error).__name__}: {error}",
            {"fold_id": None if run.fold == LATEST else run.fold},
        )
        run.status = "failed"
    finally:
        _BACKFILLING.discard(run.fold)
        _forget_old_runs()


def key_for(fold_id: str | None) -> str:
    """The run key a request runs under. ``None`` is the newest frozen fold."""
    return fold_id or LATEST


def is_running(fold: str) -> bool:
    """Whether a child for this fold is alive in *this* instance."""
    return fold in _BACKFILLING


def find(fold: str) -> BackfillRun | None:
    """The run, or ``None`` when this instance never started it or has forgotten
    it. Forgetting is bounded by :data:`_BACKFILL_HISTORY` and never applies to
    a run that is still going."""
    return _BACKFILL_RUNS.get(fold)


def begin(fold: str, argv: list[str]) -> BackfillRun:
    """Start a child and return the run to poll.

    Replaces any earlier record of the same fold — a run being started again is
    a run whose previous attempt is over, and the rows carry the fold's own
    artifact id, so the second pass supersedes rather than duplicates.
    """
    _BACKFILLING.add(fold)
    run = BackfillRun(fold=fold, started_at=time.monotonic())
    _BACKFILL_RUNS.pop(fold, None)
    _BACKFILL_RUNS[fold] = run
    run.task = asyncio.create_task(_supervise_backfill(run, argv))
    return run
