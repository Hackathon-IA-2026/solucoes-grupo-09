"""The weekly retrain — forecaster ticket 15, `docs/specs/forecaster.md` seam 11.

The expensive half of this ticket is a full fit against a live database, and it
is deliberately not simulated here: a fixture-driven "end to end" that never
touched Postgres would assert that the mocks agree with each other. What *is*
asserted is everything that can be decided without one, and each of these is a
property the ticket names rather than a restatement of the code:

- the run is identified, so a retry is a retry (:func:`decided_in_run`);
- nothing in the driver reads a clock, so a rerun of the same request reads the
  same window — the reproducibility half of the title;
- a partly-written artifact never lands under an artifact id;
- the wall clock and the peak resident set reach the card, beside the receipt
  that says how to reissue the run;
- the two lanes are the evaluation matrix's own arms, not a second naming
  scheme that could drift from it.

The DB-gated suite at the bottom runs the read path against real Postgres under
the repository's existing `WATTSTEER_TEST_DATABASE_URL` switch.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from database_harness import database_url, run
from wattsteer_ml import retrain as driver
from wattsteer_ml.app import app as ml_app
from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.evaluation.gate import NoCandidate
from wattsteer_ml.evaluation.matrix import MATRIX_RUN_BY_NAME
from wattsteer_ml.evaluation.serving_lanes import (
    EARLY_LANE,
    LATE_LANE,
    SERVING_LANES,
    LaneOutcome,
)
from wattsteer_ml.lanes import Lane, is_artifact_id
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionRecord, append
from wattsteer_ml.retrain import (
    LANE_RUNS,
    RETRAIN_BLOCK_KEY,
    Resources,
    RetrainError,
    RetrainRequest,
    Stopwatch,
    decided_in_run,
    lanes_from_names,
    main,
    run_retrain,
)
from wattsteer_ml.training import bundle as bundle_module

app_client = TestClient(ml_app)

RUN_ID = "2026-09-04T03:10:00Z"
AS_OF = datetime(2026, 9, 4, 3, 10, tzinfo=UTC)


def request(root: Path, **overrides: Any) -> RetrainRequest:
    return RetrainRequest(
        run_id=RUN_ID,
        as_of=AS_OF,
        root=root,
        database_url="postgres://nobody@127.0.0.1:1/none",
        **overrides,
    )


def line(root: Path, lane: Lane, *, decision: str, artifact_id: str = RUN_ID) -> None:
    append(
        root / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=artifact_id,
            lane=lane,
            decision=decision,  # type: ignore[arg-type]
            reason="written by the test",
            at=AS_OF,
        ),
    )


# --- the run's identity -------------------------------------------------------


def test_lane_names_select_served_lanes_and_nothing_else() -> None:
    """`--lane` is for an hour that cannot hold both lanes; it still cannot
    gate a lane nobody serves, or one lane twice."""
    assert lanes_from_names(None) == SERVING_LANES
    assert lanes_from_names([]) == SERVING_LANES
    assert lanes_from_names([EARLY_LANE.directory_name]) == (EARLY_LANE,)
    assert lanes_from_names([LATE_LANE.directory_name, EARLY_LANE.directory_name]) == (
        LATE_LANE,
        EARLY_LANE,
    )
    with pytest.raises(ValueError, match="not a served lane"):
        lanes_from_names(["dessem_free_v1__gate_early__thr1"])
    with pytest.raises(ValueError, match="twice"):
        lanes_from_names([EARLY_LANE.directory_name, EARLY_LANE.directory_name])
    with pytest.raises(Exception, match="thr5"):
        lanes_from_names(["dessem_free_v1__gate_early__thr05"])


def test_the_run_id_is_the_artifact_stem() -> None:
    """One id per run, and it is an artifact id in both lanes' directories.

    The whole idempotency story rests on this: without it a retry would have to
    be recognised from a wall clock, and two attempts a second apart would mint
    two artifacts nothing could tell were the same run.
    """
    assert is_artifact_id(RUN_ID)


def test_a_run_id_that_disagrees_with_its_instant_is_refused(tmp_path: Path) -> None:
    with pytest.raises(RetrainError, match="cannot be reproduced from the card"):
        RetrainRequest(
            run_id="2026-09-04T03:10:00Z",
            as_of=datetime(2026, 9, 4, 4, 0, tzinfo=UTC),
            root=tmp_path,
            database_url="",
        )


def test_a_naive_instant_names_no_run(tmp_path: Path) -> None:
    with pytest.raises(RetrainError, match="tz-aware"):
        RetrainRequest(
            run_id=RUN_ID,
            as_of=datetime(2026, 9, 4, 3, 10),
            root=tmp_path,
            database_url="",
        )


def test_a_lane_that_already_decided_this_run_is_recognised(tmp_path: Path) -> None:
    assert decided_in_run(tmp_path, LATE_LANE, RUN_ID) is None
    line(tmp_path, LATE_LANE, decision="refuse")
    assert decided_in_run(tmp_path, LATE_LANE, RUN_ID) == "refuse"
    # Per lane, and per run. The morning lane has not taken its turn, and a line
    # from last Friday is not this Friday's.
    assert decided_in_run(tmp_path, EARLY_LANE, RUN_ID) is None
    assert decided_in_run(tmp_path, LATE_LANE, "2026-08-28T03:10:00Z") is None


def test_a_retry_retrains_nothing_and_appends_nothing(tmp_path: Path) -> None:
    """The idempotency box, asserted by the log not growing.

    Both lanes already carry a line for this run — the state a queue redelivery
    finds. The database url is unreachable on purpose: if the short-circuit did
    not fire, the run would try to connect and the outcome would say so.
    """
    for lane in SERVING_LANES:
        line(tmp_path, lane, decision="promote")
    log = root_log = tmp_path / PROMOTION_LOG_FILENAME
    before = root_log.read_text(encoding="utf-8")

    report = run_retrain(request(tmp_path))

    assert log.read_text(encoding="utf-8") == before
    for outcome in report.outcomes:
        assert outcome.status == "no_candidate"
        assert "already carries a 'promote' line" in outcome.no_candidate.reason  # type: ignore[union-attr]


def test_a_lane_that_has_not_decided_this_run_still_runs(tmp_path: Path) -> None:
    """Only the decided lane is short-circuited — the other one takes its turn.

    The morning lane fails, because the url points nowhere, and that failure is
    the assertion: it *reached* the database rather than being skipped along
    with the evening one. One lane's completed turn is not the other's, which is
    the same independence forecaster 19 built and this ticket must not lose.

    Note also which word each lane gets. The decided lane is ``no_candidate`` —
    nothing to gate, nothing appended — and the unreachable database is
    ``failed``: a connection that was refused is not a statement about the data,
    and rounding it to "there was nothing to fit" would hide an outage inside a
    routine outcome.
    """
    line(tmp_path, LATE_LANE, decision="refuse")
    report = run_retrain(request(tmp_path))
    assert report.for_lane(LATE_LANE).status == "no_candidate"
    assert report.for_lane(EARLY_LANE).status == "failed"
    assert "already carries" not in (report.for_lane(EARLY_LANE).failure or "")


# --- reproducibility ----------------------------------------------------------


def test_the_driver_reads_no_clock_outside_its_entry_point() -> None:
    """A grep-level test, in the spirit of seam 2's.

    "Same inputs and seed give identical predictions" is only reachable if the
    inputs are inputs. Every instant the run depends on — the fold calendar's
    live edge, the serving day, the artifact stem, the gate's ``now`` — is
    derived from ``request.as_of``, and a single ``datetime.now()`` anywhere
    below :func:`~wattsteer_ml.retrain.main` would make two runs of the same
    request two different runs. The one permitted reader is ``main``, which is
    where a wall clock becomes a run id and stops being a clock.
    """
    source = Path(driver.__file__).read_text(encoding="utf-8")
    body = source[: source.index("def main(")]
    offenders = [
        match.group(0)
        for match in re.finditer(r"datetime\.now\(|time\.time\(|date\.today\(", body)
    ]
    assert offenders == []


def test_the_reproduction_receipt_names_everything_a_rerun_needs(tmp_path: Path) -> None:
    """The card's ``retrain`` block, written onto a card already on the volume.

    Written after the gate, so it can carry the wall clock; written by spreading
    the card, so the gate's own block — which lands first — survives it.
    """
    lane = LATE_LANE
    directory = tmp_path / lane.directory_name
    directory.mkdir(parents=True)
    card_path = directory / f"{RUN_ID}{CARD_SUFFIX}"
    card_path.write_text(json.dumps({"identity": {}, "gate": {"decision": "refuse"}}))

    inputs = _stub_inputs(lane)
    driver._write_retrain_block(
        request(tmp_path),
        lane=lane,
        inputs=inputs,
        resources=Resources(wall_clock_seconds=612.5, peak_rss_mb=1843.0),
        incumbent_id="2026-08-28T03:10:00Z",
        comparator="incumbent",
        live_feature_hash="sha256:" + "a" * 64,
    )

    card = json.loads(card_path.read_text(encoding="utf-8"))
    assert card["gate"] == {"decision": "refuse"}
    block = card[RETRAIN_BLOCK_KEY]
    assert block["run_id"] == RUN_ID
    assert block["resources"] == {"wall_clock_seconds": 612.5, "peak_rss_mb": 1843.0}
    receipt = block["reproduction"]
    # The two dates are both there and they are different questions: what the
    # boosters were fitted to, and how far the run's data window reached.
    assert receipt["trained_to"] != receipt["data_to"]
    for field in (
        "run",
        "window_start",
        "fold",
        "fold_hash",
        "deciding_row_id",
        "serving_day",
        "live_feature_hash",
        "comparator",
        "incumbent",
        "ladder",
    ):
        assert field in receipt


def test_a_run_that_wrote_no_card_is_not_an_error(tmp_path: Path) -> None:
    """A failure before ``save_artifact`` has no artifact to annotate."""
    driver._write_retrain_block(
        request(tmp_path),
        lane=LATE_LANE,
        inputs=_stub_inputs(LATE_LANE),
        resources=Resources(wall_clock_seconds=1.0, peak_rss_mb=1.0),
        incumbent_id=None,
        comparator="same_hour_7d",
        live_feature_hash="sha256:" + "b" * 64,
    )
    assert not (tmp_path / LATE_LANE.directory_name).exists()


# --- what it cost -------------------------------------------------------------


def test_the_peak_resident_set_is_a_plausible_number_of_mebibytes() -> None:
    """``ru_maxrss`` is kilobytes on Linux and bytes on macOS.

    Unhandled, that difference reports a 900 MB retrain as 900 GB on one of the
    two platforms — a number nobody would notice was wrong until it was used to
    size a container. The bound is loose on purpose: what is under test is the
    unit, not this interpreter's footprint.
    """
    peak = driver._peak_rss_mb()
    assert 1.0 < peak < 100_000.0


def test_the_stopwatch_reports_both_numbers() -> None:
    resources = Stopwatch().read()
    assert resources.wall_clock_seconds >= 0.0
    assert set(resources.as_dict()) == {"wall_clock_seconds", "peak_rss_mb"}


# --- the lanes are the matrix's arms ------------------------------------------


def test_each_served_lane_is_a_row_of_the_evaluation_matrix() -> None:
    """Not a parallel naming scheme.

    The morning view is ``A-full-early`` and the evening view is ``A-full`` in
    `docs/specs/forecaster.md`'s matrix, and the retrain reads its window start
    out of that table — so the weekly retrain and the A/B matrix cannot come to
    hold two different opinions about where set A's window opens.
    """
    assert set(LANE_RUNS) == {lane.gate_profile for lane in SERVING_LANES}
    for lane in SERVING_LANES:
        arm = MATRIX_RUN_BY_NAME[LANE_RUNS[lane.gate_profile]]
        assert arm.gate_profile == lane.gate_profile
        assert arm.feature_set == lane.feature_set
    assert LANE_RUNS["gate_early"] == "A-full-early"
    assert LANE_RUNS["gate_late"] == "A-full"


# --- the DB-gated half --------------------------------------------------------


def test_the_read_path_composes_against_real_postgres() -> None:
    """The live read, end to end as far as data allows.

    `docs/specs/forecaster.md`'s seam 11 is "live, scheduled", and the honest
    limit of an automated test is the *read*: a database with no ingested rows
    cannot train anything, and pretending otherwise would be a fixture wearing a
    database's clothes. What this asserts is that the driver's composition —
    calendar, live edge, go-live, ``feature_rows`` over the window, the live
    ``pg_get_functiondef``, tomorrow's serving rows — reaches Postgres and comes
    back either with inputs or with a :class:`RetrainError` that says which
    clause could not be satisfied. Both are results; a ``TypeError`` is not.
    """
    url = database_url()
    assert url

    async def read(conn: Any) -> str:
        try:
            inputs = await driver.read_lane_inputs(conn, LATE_LANE, as_of=AS_OF)
        except RetrainError as refusal:
            return f"refused: {refusal}"
        assert inputs.run == "A-full"
        assert inputs.fold.is_live_edge
        assert inputs.blocks.test_end == AS_OF.date() - _one_day()
        assert inputs.serving_day > AS_OF.date()
        assert inputs.function_definition.strip()
        return "read"

    outcome = run(read)
    assert outcome.startswith(("read", "refused: "))


def _one_day() -> Any:
    from datetime import timedelta

    return timedelta(days=1)


def _stub_inputs(lane: Lane) -> Any:
    """A :class:`LaneInputs` with only the fields the card block reads.

    Built by hand rather than from a database, because the block under test is a
    projection of the run's parameters and nothing in it depends on a row.
    """
    from wattsteer_ml.evaluation import materialize_fold_calendar, stamp_fidelity

    calendar = materialize_fold_calendar(AS_OF.date())
    fold = calendar.live_edge
    assert fold is not None
    arm = MATRIX_RUN_BY_NAME[LANE_RUNS[lane.gate_profile]]
    blocks = fold.blocks_for(arm.window_start)
    return driver.LaneInputs(
        lane=lane,
        run=arm.name,
        window_start=arm.window_start,
        calendar=calendar,
        fold=fold,
        blocks=blocks,
        segments=stamp_fidelity(fold, None),
        prior=(),
        function_definition="create function feature_rows() ...",
        rows_by_fold={},
        serving_rows=(),
        serving_day=date(2026, 9, 5),
    )


# --- nothing half-written -----------------------------------------------------


def test_an_interrupted_write_leaves_nothing_under_an_artifact_id(
    tmp_path: Path,
) -> None:
    """The ticket's sixth box, at the seam that decides it.

    ``save_artifact`` wrote the bundle straight to its final path, so a retrain
    killed part-way through ``joblib.dump`` — an OOM, a redeploy, a ``SIGKILL``
    — left a truncated ``.joblib`` under a real artifact id.
    :mod:`wattsteer_ml.artifacts` lists that as an artifact, and
    :func:`~wattsteer_ml.evaluation.gate.rollback` would accept it as a rollback
    target on the strength of the file being there. Now the file is composed
    beside its destination and moved in, so a failure leaves neither the
    destination nor anything an artifact-id rule matches.
    """
    destination = tmp_path / f"{RUN_ID}.joblib"

    def explode(path: Path) -> None:
        path.write_bytes(b"half a bundle")
        raise OSError("no space left on device")

    with pytest.raises(OSError, match="no space left"):
        bundle_module._atomically(destination, explode)

    assert not destination.exists()
    assert [
        entry.name for entry in tmp_path.iterdir() if is_artifact_id(entry.stem)
    ] == []


def test_a_rewritten_card_is_never_seen_truncated(tmp_path: Path) -> None:
    """The same guarantee for the card, which the gate rewrites in place.

    ``record_decision`` reads the card and writes it back with its gate block
    added. A crash mid-``write_text`` used to leave a card that
    :func:`~wattsteer_ml.training.read_card` refuses to parse — and the promotion
    log, appended a moment later, would then name an artifact whose card is
    unreadable. Two changes make that unreachable: the JSON is composed *before*
    anything is opened, so a card that cannot be serialised never reaches the
    filesystem at all, and what is opened is a temporary name that is moved into
    place.
    """
    path = tmp_path / f"{RUN_ID}{CARD_SUFFIX}"
    bundle_module.write_card(path, {"identity": {"artifact_id": RUN_ID}})
    before = path.read_text(encoding="utf-8")

    with pytest.raises(TypeError, match="not JSON serializable"):
        bundle_module.write_card(path, {"identity": object()})

    assert path.read_text(encoding="utf-8") == before
    assert list(tmp_path.iterdir()) == [path]


# --- the route the schedule calls ---------------------------------------------


def test_a_run_id_that_is_not_an_artifact_stem_is_refused_before_anything_runs() -> None:
    """422 before a process is spawned.

    The id is the artifact stem: a malformed one discovered on the far side
    would be discovered *after* the fits, which is forty wasted minutes and a
    lane directory with a file nothing can promote.
    """
    response = app_client.post("/internal/retrain", json={"run_id": "friday"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REQUEST_INVALID"


def test_a_run_already_in_flight_here_is_refused_rather_than_raced() -> None:
    """409, and it is the queue's retry policy this exists for.

    A retrain outlives most client timeouts, so the worker can give up on a call
    that is still running and hand the job back for another attempt. Without
    this, the second attempt would spawn a second child writing the *same*
    artifact id into the same directory and the two would race over one bundle.
    """
    # The supervisor's own registry, not the app's internals. That module owns
    # the in-flight set now, and a test that reached through `app` to touch it
    # was asserting on where the state happened to live rather than on what it
    # means.
    from wattsteer_ml import retrain_supervisor as supervisor

    supervisor._RETRAINING.add(RUN_ID)
    try:
        response = app_client.post("/internal/retrain", json={"run_id": RUN_ID})
    finally:
        supervisor._RETRAINING.discard(RUN_ID)
    # The public reading of the same fact, which is what the route uses.
    assert not supervisor.is_running(RUN_ID)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "RETRAIN_IN_PROGRESS"


# --- forecaster 45: the run outlives the request that started it -------------
#
# The measurement this section exists for, taken on the live deployment on
# 2026-09-15: the worker's POST aborted after exactly 300 s and was reported as
# `OPTIMIZER_TIMEOUT`, while this service went on training (CPU 36%, RSS
# 2.80 GB) well past the abort and completed. Every retrain reported a failure
# that had not happened. A request that transmits no bytes for twelve minutes is
# not a shape the deployment's internal networking will hold, and no timeout on
# either end changes that.
#
# So the POST starts a child and answers, and a *separate* short request asks how
# it is going. The child below is a real second process with real pipes — what is
# under test is process supervision, and a stubbed coroutine would only assert
# that the stub agrees with itself.

#: How long the fake retrain runs for. An order of magnitude longer than the 202
#: may take, which is the whole property.
_CHILD_SECONDS = 0.8

#: The report the fake child prints on stdout, in the shape
#: `python -m wattsteer_ml.retrain` prints.
_CHILD_REPORT = {
    "at": "2026-09-04T03:10:00Z",
    "run_id": RUN_ID,
    "lanes": [
        {
            "lane": "dessem_free_v1__gate_early__thr5",
            "gate_profile": "gate_early",
            "status": "refused",
            "artifact_id": None,
            "reason": "coverage_p90 = 0.83 is outside [0.85, 0.97]",
            "already_decided": False,
        }
    ],
    "promoted": [],
    "resources": {"wall_clock_seconds": 742.25, "peak_rss_mb": 1912.4},
}

#: A child in the driver's shape: one progress line per lane on stderr as it
#: goes, one JSON report on stdout at the end.
_CHILD_SCRIPT = (
    "import json, sys, time\n"
    "for done in (1, 2):\n"
    f"    time.sleep({_CHILD_SECONDS} / 2)\n"
    '    print(json.dumps({"progress": {"done": done, "total": 2}}),'
    " file=sys.stderr, flush=True)\n"
    f"print({json.dumps(json.dumps(_CHILD_REPORT))})\n"
)


def _stub_child(monkeypatch: pytest.MonkeyPatch, script: str, exit_code: int = 0) -> None:
    """Make the retrain route spawn ``script`` instead of the real driver.

    Intercepted at ``asyncio.create_subprocess_exec`` rather than at the argv, so
    everything the route does with the child — the two pipes, the stderr pump,
    the exit code — is the production path over a real process.
    """
    real = asyncio.create_subprocess_exec

    async def spawn(*_argv: str, **kwargs: Any) -> Any:
        return await real(
            sys.executable, "-c", f"{script}\nimport sys\nsys.exit({exit_code})", **kwargs
        )

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)


def _startable(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The two settings the POST refuses without, neither of them under test."""
    # From `config`, which defines it, rather than through `app`, which imports
    # it to use. `app` re-exporting it is incidental, and mypy refuses to treat
    # an incidental re-export as interface.
    from wattsteer_ml.config import settings as app_settings

    monkeypatch.setattr(app_settings, "database_url", "postgresql://stub/stub")
    monkeypatch.setattr(app_settings, "artifact_dir", tmp_path)


def _poll_until(client: TestClient, run_id: str, *, deadline: float) -> dict[str, Any]:
    """Short requests until the run is over — exactly how the worker polls."""
    running: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        response = client.get(f"/internal/retrain/{run_id}")
        # Annotated because `response.json()` is `Any`, and a function that
        # promises a typed dict should not quietly hand one back untyped.
        body: dict[str, Any] = response.json()
        if response.status_code != 200 or body.get("status") != "running":
            body["_running_polls"] = running
            return body
        running.append(body)
        time.sleep(0.05)
    raise AssertionError(f"the run never left 'running'; saw {running}")


def test_a_run_longer_than_a_request_still_reaches_a_decision(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """**The property this whole ticket exists for.**

    A retrain that takes longer than any single request may last still reaches a
    decision, because no single request is waiting for it. The assertions say why
    the old shape cannot satisfy it: the POST is answered *while the child is
    still running* — 202, in a fraction of the run — and the verdict arrives over
    a sequence of short GETs.

    Against the synchronous shape this fails twice over: the POST does not return
    until the child is done, and it answers 200 with the report rather than 202
    with a run id.
    """
    _startable(monkeypatch, tmp_path)
    _stub_child(monkeypatch, _CHILD_SCRIPT)
    with TestClient(ml_app) as client:
        began = time.monotonic()
        accepted = client.post("/internal/retrain", json={"run_id": RUN_ID})
        answered_in = time.monotonic() - began

        assert accepted.status_code == 202
        assert accepted.json()["run_id"] == RUN_ID
        assert accepted.json()["status"] == "running"
        # Answered while the child is still training, not after it.
        assert answered_in < _CHILD_SECONDS / 2

        final = _poll_until(client, RUN_ID, deadline=began + 30)

    assert final["status"] == "decided"
    assert [lane["status"] for lane in final["lanes"]] == ["refused"]
    assert final["resources"]["wall_clock_seconds"] == 742.25
    # And it was observable while it mattered, which a 202 and nothing else
    # would leave out.
    assert final["_running_polls"], "no poll ever observed the run in flight"


def test_the_queues_progress_is_the_runs_progress(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """One lane finished is one lane reported, mid-run.

    ``report({done, total})`` used to be called once before the POST and once
    after, so a forty-minute job had no progress at all and an operator's only
    window on a live run was the container's process metrics. The child prints a
    line per lane on stderr, the service reads that stream as the run goes, and
    the status route publishes it.
    """
    _startable(monkeypatch, tmp_path)
    _stub_child(monkeypatch, _CHILD_SCRIPT)
    with TestClient(ml_app) as client:
        assert (
            client.post("/internal/retrain", json={"run_id": RUN_ID}).status_code == 202
        )
        final = _poll_until(client, RUN_ID, deadline=time.monotonic() + 30)

    progressed = [poll["progress"]["done"] for poll in final["_running_polls"]]
    assert max(progressed, default=0) >= 1, (
        f"no poll saw a lane finish while the run was in flight: {progressed}"
    )
    assert final["_running_polls"][-1]["progress"]["total"] == 2
    # Elapsed is measured rather than asserted from a ceiling — the same repair
    # forecaster 45 made to the worker's failure line.
    assert final["_running_polls"][0]["elapsed_seconds"] >= 0


def test_a_child_that_fails_is_reported_by_the_status_route(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The verdict moved with the run: a failed child is now a failed *poll*.

    The POST cannot report it any more — it answered before the child had
    finished — so `RETRAIN_FAILED`, its exit code and the tail of its stderr are
    what the status route answers, which is the body the POST used to return.
    """
    _startable(monkeypatch, tmp_path)
    _stub_child(
        monkeypatch,
        'import sys\nprint("Traceback: LightGBMError", file=sys.stderr)',
        exit_code=3,
    )
    with TestClient(ml_app) as client:
        assert (
            client.post("/internal/retrain", json={"run_id": RUN_ID}).status_code == 202
        )
        final = _poll_until(client, RUN_ID, deadline=time.monotonic() + 30)
    assert final["error"]["code"] == "RETRAIN_FAILED"
    assert final["error"]["details"]["exit_code"] == 3
    assert "LightGBMError" in final["error"]["details"]["stderr"]


def test_a_child_that_states_its_reason_on_stdout_is_not_reported_as_silent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The report is on stdout, and a barren run exits 1 with nothing on stderr.

    Measured on 20/09/2026: every lane failed with ``PermissionError: [Errno 13]
    Permission denied: '/root/.postgresql/postgresql.key'``, the child printed
    that in its report and exited 1, and the failure body carried an empty
    ``stderr`` and nothing else. The reason existed and was thrown away, so the
    job log read "exited 1" for hours. The tail of stdout travels with it now.
    """
    _startable(monkeypatch, tmp_path)
    _stub_child(
        monkeypatch,
        'print(\'{"failures": [{"reason": "PermissionError: postgresql.key"}]}\')',
        exit_code=1,
    )
    with TestClient(ml_app) as client:
        assert (
            client.post("/internal/retrain", json={"run_id": RUN_ID}).status_code == 202
        )
        final = _poll_until(client, RUN_ID, deadline=time.monotonic() + 30)
    assert final["error"]["code"] == "RETRAIN_FAILED"
    assert final["error"]["details"]["stderr"] == ""
    assert "PermissionError: postgresql.key" in final["error"]["details"]["stdout"]


def test_a_failed_holdout_backfill_carries_the_reason_its_child_printed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The same loss, on the other route that spawns a reporting child.

    This route used to answer synchronously and now starts the run and answers
    202, for the reason the retrain does — so the body under test is the
    *status* route's. What it must carry is unchanged: a child that
    reconstructed no lane exits 1 with its report on stdout and nothing on
    stderr, and a failure that dropped stdout would say "exited 1" and no more.
    """
    _startable(monkeypatch, tmp_path)
    _stub_child(
        monkeypatch,
        'print(\'{"failures": [{"reason": "PermissionError: postgresql.key"}]}\')',
        exit_code=1,
    )
    with TestClient(ml_app) as client:
        started = client.post("/internal/backfill/holdout", json={"fold_id": "F6"})
        assert started.status_code == 202
        for _ in range(200):
            response = client.get("/internal/backfill/holdout/F6")
            if response.status_code != 200 or response.json().get("status") != "running":
                break
            time.sleep(0.02)
    assert response.status_code == 500
    error = response.json()["error"]
    assert error["code"] == "HOLDOUT_BACKFILL_FAILED"
    assert error["details"]["stderr"] == ""
    assert "PermissionError: postgresql.key" in error["details"]["stdout"]


def test_a_run_this_instance_never_started_is_unknown_rather_than_running() -> None:
    """404 `RETRAIN_UNKNOWN` — which is what a replaced container looks like.

    It must not read as ``running``: a worker polling a run whose child went with
    the container would poll for forty minutes and report a timeout, which is the
    same confident wrong answer this ticket removed from the other end. The
    worker fails that attempt instead, and the queue's retry is safe because a
    lane carrying a decision line for the run id appends nothing.
    """
    response = app_client.get("/internal/retrain/2026-01-02T03:10:00Z")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "RETRAIN_UNKNOWN"

    # The worker escapes the run id as the path parameter it is — `%3A` for the
    # stem's colons — so the escaped form has to name the same run as the plain
    # one. It is asserted here rather than taken on trust because the two sides
    # spell the path differently and nothing else would notice.
    escaped = app_client.get("/internal/retrain/2026-01-02T03%3A10%3A00Z")
    assert escaped.status_code == 404
    assert escaped.json()["error"]["details"]["run_id"] == "2026-01-02T03:10:00Z"


def test_a_run_still_in_flight_is_never_forgotten(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The eviction pass drops finished runs only.

    Forgetting a live run would make the status route answer 404 about a child
    that is alive — this ticket's defect, reintroduced from the other end.
    """
    from wattsteer_ml import retrain_supervisor as supervisor

    monkeypatch.setattr(supervisor, "_RETRAIN_HISTORY", 1)
    monkeypatch.setattr(supervisor, "_RETRAIN_RUNS", {})
    runs: dict[str, Any] = supervisor._RETRAIN_RUNS
    for index in range(4):
        finished = supervisor.RetrainRun(
            run_id=f"2026-01-0{index + 1}T03:10:00Z", started_at=time.monotonic()
        )
        finished.status = "decided"
        finished.report = {"lanes": []}
        runs[finished.run_id] = finished
    live = supervisor.RetrainRun(run_id=RUN_ID, started_at=time.monotonic())
    runs[live.run_id] = live

    supervisor._forget_old_runs()

    assert RUN_ID in runs
    assert len([one for one in runs.values() if one.finished]) == 1


# --- forecaster 44: an idempotent run is not a failed one --------------------


def test_a_fully_decided_run_exits_zero_and_a_barren_one_does_not(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The exit code the operator's catch-up turns on — forecaster 44.

    `main`'s own docstring says non-zero is for the run where "*no* lane reached
    a decision, **which is the only outcome that is unambiguously a failed
    run**". A run whose every lane was already decided is unambiguously not one:
    it is the idempotent no-op `gate_one`'s short-circuit exists to produce.

    It exited 1. On the deployment of 2026-09-15 an operator set
    `WATTSTEER_RETRAIN_PATTERN=5 * * * *` to catch up after forecaster 43; the
    run id resolved to that morning's scheduled instant, both lanes
    short-circuited, this returned 1, and the modelling service reported
    `RETRAIN_FAILED` / HTTP 500 — which the queue retried three times, in under
    two seconds each, against a healthy run time of ~750 s.

    Both arms are here because the exit code has to keep *failing* on the
    outcome it was written for: a run that reached no decision and had nothing
    already decided either.
    """
    for lane in SERVING_LANES:
        line(tmp_path, lane, decision="promote")
    code = main(["--run-id", RUN_ID, "--root", str(tmp_path), "--database-url", "x"])
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0, "a run whose every lane was already decided is not a failure"
    assert all(one["status"] == "no_candidate" for one in payload["lanes"])
    assert all(one["already_decided"] for one in payload["lanes"])

    # The control, and the reason the line above is not simply `return 0`: a run
    # where nothing was decided and nothing had been decided before still fails.
    # Here the database url points nowhere and no lane carries a line, so both
    # lanes reach `failed` — the outcome the non-zero exit was written for.
    barren = tmp_path / "barren"
    barren.mkdir()
    code = main(["--run-id", RUN_ID, "--root", str(barren), "--database-url", "x"])
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 1, "a run that decided nothing and skipped nothing is a failure"
    assert not any(one["already_decided"] for one in payload["lanes"])


def test_already_decided_is_a_field_and_not_a_sentence(tmp_path: Path) -> None:
    """The flag is read off the outcome, never matched out of its prose.

    An exit code that greps its own reason string breaks the first time somebody
    rewords it, and the reword would look like a comment change. So
    `NoCandidate.already_decided` is a field, `LaneOutcome.already_decided`
    reads it, and `main` reads that.
    """
    line(tmp_path, LATE_LANE, decision="refuse")
    report = run_retrain(request(tmp_path))
    late, early = report.for_lane(LATE_LANE), report.for_lane(EARLY_LANE)
    assert late.already_decided is True
    # The other lane failed on the unreachable database: a `failed` outcome
    # carries no `no_candidate` at all, so the property must be false rather
    # than raise. That is the arm a prose match would have got wrong.
    assert early.status == "failed"
    assert early.already_decided is False

    # Non-vacuity: a `no_candidate` that is *not* a retry — a lane that produced
    # nothing to gate — must not be mistaken for one.
    nothing = NoCandidate.from_training_failure(
        RuntimeError("no risk bins"), lane=EARLY_LANE, at=AS_OF
    )
    assert nothing.already_decided is False
    assert LaneOutcome.of(EARLY_LANE, nothing).already_decided is False

    source = Path(driver.__file__).read_text(encoding="utf-8")
    assert "already carries" not in source[source.index("def main(") :], (
        "main matches the reason string, so a reword changes the exit code"
    )
