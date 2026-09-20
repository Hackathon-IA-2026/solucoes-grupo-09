"""Supervising a retrain, as opposed to running one.

:mod:`wattsteer_ml.retrain` is what the *child* executes. This is what starts
that child, watches its stderr for progress, and answers "is it still going" —
two hundred lines that lived in :mod:`wattsteer_ml.app` beside nineteen routes
and eighteen response models, reachable only by issuing an HTTP request.

**The interface is three calls; everything else is behind them.** A caller says
:func:`begin`, :func:`find` or :func:`is_running` and never touches the
registry, the stderr pump, the progress parser or the history policy. That is
the point of the split: the supervisor has state, a lifecycle and a
garbage-collection rule, and none of that is a route's business.

The state stays **in-process and module-level**, unchanged. The durable record
of what a run decided is the promotion log; this is the cheap thing that
answers "is it still going" in between, and it holds for one instance. Two ML
replicas called for the same run id would still overlap, which is why the
durable guard is the log and not this.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger(__name__)

#: Run ids currently being retrained by this instance.
#:
#: Forecaster 45 left this exactly where it was and changed only who holds it:
#: it is now taken by the POST and released by the supervising task rather than
#: by the request, because the run outlives the request. What it prevents is
#: unchanged — a second child writing the *same* artifact id in the same lane
#: directory, racing the first over one bundle. Refusing the overlap is the whole
#: repair: the first child finishes, writes its line, and a later attempt
#: short-circuits on the line rather than on this set.
#:
#: In-process, so it holds for one instance. Two ML replicas called for the same
#: run id would still overlap — which is why the *durable* guard is the promotion
#: log, and this is the cheap one that covers the case that actually happens.
_RETRAINING: set[str] = set()

#: The status route, as a template. Named here so the string in the decorator
#: below and the one the 202 hands the worker cannot drift apart.
STATUS_PATH = "/internal/retrain/{run_id}"


#: How many finished runs are remembered after the worker has read them.
#:
#: The status route has to answer a *redelivered* poll — the worker can retry a
#: request whose response it never saw — so a run cannot be forgotten the moment
#: it is read. It also cannot be remembered forever in a process that stays up
#: for months. Sixteen is several weeks of Fridays and a whole afternoon of an
#: operator's catch-up pattern, at a few kilobytes each.
_RETRAIN_HISTORY = 16

#: Bytes of the child's stderr kept for the failure body. The route publishes the
#: last 2,000 characters of it; the rest is read from the service's own log.
_STDERR_TAIL = 8_192


@dataclass
class RetrainRun:
    """One retrain, as something to ask about rather than to wait on.

    **Forecaster 45.** This route used to run the child inside the POST and
    answer with its report, which is correct on its own terms — the endpoint was
    configured with the worker's forty-minute ceiling — and did not survive the
    network. Measured on the live deployment on 2026-09-15: the worker's call
    aborted after exactly 300 s reported as `OPTIMIZER_TIMEOUT`, while this
    service went on training (CPU 36%, RSS 2.80 GB) well past the abort and
    completed; uvicorn writes its access line on *response*, so a twelve-minute
    POST was invisible for the whole twelve minutes. Every retrain reported a
    failure that had not happened. A request that transmits no bytes for twelve
    minutes is not a shape this deployment's internal networking will hold, and
    no timeout on either end changes that: the run was fine, the *waiting* was
    what failed.

    So the run outlives the request that started it. The POST starts the child
    and answers 202 with this record's id; ``GET /internal/retrain/{run_id}``
    reads this record. What was one forty-minute request is a sequence of short
    ones, which is also what makes the worker's ceiling mean what it says.
    """

    run_id: str
    #: Monotonic, so an elapsed time is not a subtraction of two wall clocks.
    started_at: float
    #: ``running`` until the child exits, then ``decided`` or ``failed``.
    status: Literal["running", "decided", "failed"] = "running"
    #: The report the POST used to return, once there is one.
    report: dict[str, Any] | None = None
    #: ``(code, message, details)`` — the refusal the status route answers with.
    failure: tuple[str, str, dict[str, Any]] | None = None
    #: Lanes finished out of lanes asked for. The child prints it, one line per
    #: lane, so the queue's progress bar is the run's progress rather than the
    #: two-point 0-then-1 a single blocking call could offer.
    progress: dict[str, Any] = field(default_factory=lambda: {"done": 0, "total": None})
    task: asyncio.Task[None] | None = None

    @property
    def finished(self) -> bool:
        return self.status != "running"


#: Every run this instance has started, newest last. In-process, like
#: :data:`_RETRAINING` and for the same reason: the durable record of what a run
#: decided is the promotion log, and this is the cheap thing that answers "is it
#: still going" between now and then.
_RETRAIN_RUNS: dict[str, RetrainRun] = {}


def _forget_old_runs() -> None:
    """Drop the oldest *finished* runs past :data:`_RETRAIN_HISTORY`.

    Never a running one: forgetting a run that is still training would make the
    status route answer 404 about a child that is alive, which is the reporting
    defect this ticket exists to remove, reintroduced from the other end.
    """
    finished = [run_id for run_id, run in _RETRAIN_RUNS.items() if run.finished]
    for run_id in finished[: max(0, len(finished) - _RETRAIN_HISTORY)]:
        del _RETRAIN_RUNS[run_id]


def _absorb_progress(run: RetrainRun, line: bytes) -> None:
    """Read one stderr line as a progress report, or ignore it.

    The child's stderr is also where a traceback goes, so this is deliberately
    total: anything that is not a JSON object carrying ``progress`` is not a
    progress line and is left to the failure tail.
    """
    try:
        parsed = json.loads(line)
    except ValueError:
        return
    if not isinstance(parsed, dict):
        return
    progress = parsed.get("progress")
    if isinstance(progress, dict) and isinstance(progress.get("done"), int):
        run.progress = {
            "done": progress["done"],
            "total": progress.get("total"),
        }


async def _pump_stderr(stream: asyncio.StreamReader, run: RetrainRun) -> bytes:
    """Read the child's stderr as it arrives, keeping the tail and the progress.

    Read in chunks and split by hand rather than with ``readline``, which raises
    on a line longer than its buffer — a LightGBM traceback is not a thing to
    lose the run's progress over.
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
            _absorb_progress(run, line)
        if len(buffered) > _STDERR_TAIL:
            # An unterminated line nobody is going to parse as JSON.
            buffered = buffered[-_STDERR_TAIL:]
    _absorb_progress(run, buffered)
    return tail


async def _supervise_retrain(run: RetrainRun, argv: list[str]) -> None:
    """Run the child to completion and record what it did on ``run``.

    Nothing here is awaited by a request handler. It owns
    :data:`_RETRAINING` for the length of the run — the guard against a second
    child writing the same artifact id — and releases it however the run ends.
    """
    try:
        child = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert child.stdout is not None and child.stderr is not None
        # Both pipes drained concurrently: a child that fills one while nobody
        # reads it blocks on the write, and a retrain blocked on its own stderr
        # would look exactly like a retrain that is still training.
        stderr_tail, out = await asyncio.gather(
            _pump_stderr(child.stderr, run), child.stdout.read()
        )
        returncode = await child.wait()
        if returncode != 0:
            logger.error(
                "retrain %s exited %s: %s | stdout: %s",
                run.run_id,
                returncode,
                stderr_tail,
                out[-2_000:],
            )
            run.failure = (
                "RETRAIN_FAILED",
                f"the retrain process exited {returncode}",
                {
                    "run_id": run.run_id,
                    "exit_code": returncode,
                    # The tail, not the whole of it: a LightGBM traceback is long
                    # and this body is read by a job log, not by a debugger.
                    "stderr": stderr_tail.decode("utf-8", "replace")[-2_000:],
                    # The report is on stdout, and a run that decided no lane
                    # exits 1 with every lane's reason in it and nothing on
                    # stderr. Without this the body said "exited 1" and no more.
                    "stdout": out.decode("utf-8", "replace")[-2_000:],
                },
            )
            run.status = "failed"
            return
        try:
            report = json.loads(out.decode("utf-8"))
        except ValueError:
            logger.error("retrain %s printed no report", run.run_id)
            run.failure = (
                "RETRAIN_FAILED",
                "the retrain process exited cleanly and printed no report",
                {"run_id": run.run_id},
            )
            run.status = "failed"
            return
        run.report = report
        run.status = "decided"
    except Exception as error:  # the supervisor is nobody's caller
        # A task whose exception nobody retrieves is a warning on the event loop
        # and a run that says ``running`` forever. Named here instead.
        logger.exception("retrain %s could not be supervised", run.run_id)
        run.failure = (
            "RETRAIN_FAILED",
            f"the retrain could not be run: {type(error).__name__}: {error}",
            {"run_id": run.run_id},
        )
        run.status = "failed"
    finally:
        _RETRAINING.discard(run.run_id)
        _forget_old_runs()


def is_running(run_id: str) -> bool:
    """Whether a child for this id is alive in *this* instance.

    The cheap guard against a redelivered job starting a second trainer. The
    durable one is the promotion log — see this module's header.
    """
    return run_id in _RETRAINING


def find(run_id: str) -> RetrainRun | None:
    """The run, or ``None`` when this instance never started it or has forgotten
    it. Forgetting is bounded by :data:`_RETRAIN_HISTORY` and never applies to a
    run that is still going."""
    return _RETRAIN_RUNS.get(run_id)


def begin(run_id: str, argv: list[str]) -> RetrainRun:
    """Start a child and return the run to poll.

    Replaces any earlier record of the same id — a run being started again is a
    run whose previous attempt is over, and the lanes it already decided
    short-circuit inside the child.
    """
    _RETRAINING.add(run_id)
    run = RetrainRun(run_id=run_id, started_at=time.monotonic())
    _RETRAIN_RUNS.pop(run_id, None)
    _RETRAIN_RUNS[run_id] = run
    run.task = asyncio.create_task(_supervise_retrain(run, argv))
    return run
