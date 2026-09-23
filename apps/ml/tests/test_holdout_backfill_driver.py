"""The driver that scores a *named* fold and hands its held-out days over.

Forecaster ticket 23. :mod:`wattsteer_ml.evaluation.holdout` already minted the
publications and `apps/api/src/forecast/backfill.ts` already wrote them; what
did not exist was anything that *ran* either, so the Time Machine refused
`REPLAY_FORECAST_UNAVAILABLE` on exactly the F1–F5 days it exists to show. This
module is the missing caller, and the assertions here are the properties that
make it safe to run on a schedule rather than a restatement of its body:

- **it can score a frozen fold**, which the weekly retrain cannot: that driver
  is pinned to the live edge, and the live edge is post-go-live and therefore
  already `served`. The generalisation is one optional argument on
  ``read_lane_inputs``, and the pool it builds is still the folds *before* the
  one being scored — never the fold itself and never a later one;
- **the artifact id is the fold's, not the run's**, so a second pass over the
  same fold writes the same ``run_label`` and supersedes itself through
  ``ingested_at``. A clock-derived id would append a second, indistinguishable
  reconstruction of every day every week;
- **there is no argument that mints a `served` row.** The driver reaches the
  database through the same ``build_publication`` the serving path uses and the
  discriminator is a constant two modules down;
- **the report names what failed per lane** rather than taking the other lane
  down with it, which is the shape `serving_lanes` already established.

The fit itself is not simulated. A fixture-driven "end to end" that never
touched Postgres would assert that the mocks agree with each other, which is the
same objection `test_weekly_retrain.py` records; the DB-gated test at the bottom
runs the read and composition path against real Postgres.
"""

from __future__ import annotations

import inspect
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from database_harness import database_url, run
from wattsteer_ml import holdout_backfill as driver
from wattsteer_ml import retrain
from wattsteer_ml.evaluation import materialize_fold_calendar
from wattsteer_ml.evaluation.serving_lanes import LATE_LANE, SERVING_LANES
from wattsteer_ml.holdout_backfill import (
    HoldoutBackfillError,
    HoldoutBackfillRequest,
    fold_artifact_id,
    newest_frozen_fold,
)
from wattsteer_ml.lanes import is_artifact_id
from wattsteer_ml.publication import BACKFILLED_HOLDOUT_ORIGIN_KIND

AS_OF = datetime(2026, 9, 4, 3, 40, tzinfo=UTC)


def request(root: Path, **overrides: Any) -> HoldoutBackfillRequest:
    return HoldoutBackfillRequest(
        as_of=AS_OF,
        root=root,
        database_url="postgres://nobody@127.0.0.1:1/none",
        **overrides,
    )


# --- which fold, and under which id -------------------------------------------


def test_the_default_fold_is_the_newest_frozen_one() -> None:
    """The live edge is *not* it, and that is the whole point of this driver.

    The weekly retrain scores the growing fold, whose test days are post-go-live
    and are served for real. The days that answer a refusal today are the frozen
    quarters behind it, and the newest of them is the one most likely to have no
    rows yet.
    """
    calendar = materialize_fold_calendar(AS_OF.date())
    fold = newest_frozen_fold(calendar)

    assert fold is not None
    assert not fold.is_live_edge
    assert fold == calendar.frozen_folds[-1]
    live = calendar.live_edge
    assert live is None or fold.index < live.index


def test_the_artifact_id_is_the_folds_and_never_the_clocks() -> None:
    """Two passes over one fold name one artifact, so a rerun is a vintage.

    Derived from ``quarter_end`` rather than from ``test_end``: the second grows
    while a fold is the live edge, and an id that moved with the clock would
    make every weekly pass write a *different* ``run_label`` for the same day —
    which is a duplicate reconstruction rather than a newer one, because nothing
    downstream could tell the two apart.
    """
    calendar = materialize_fold_calendar(AS_OF.date())
    fold = calendar.fold("F3")

    first = fold_artifact_id(fold)

    assert is_artifact_id(first)
    assert first.startswith(fold.quarter_end.isoformat())
    assert fold_artifact_id(materialize_fold_calendar(AS_OF.date()).fold("F3")) == first
    # A different fold is a different artifact, or one fold's holdout would
    # overwrite another's.
    assert fold_artifact_id(calendar.fold("F2")) != first


def test_a_fold_the_calendar_does_not_hold_is_refused_by_name(tmp_path: Path) -> None:
    with pytest.raises(HoldoutBackfillError, match="F9"):
        request(tmp_path, fold_id="F9").fold(materialize_fold_calendar(AS_OF.date()))


# --- the pool is the folds *before* the one being scored ----------------------


def test_scoring_a_frozen_fold_pools_only_its_predecessors() -> None:
    """A later fold cannot calibrate an earlier one, and neither can itself.

    ``read_lane_inputs`` used to take the live edge, for which "every frozen
    fold" and "every earlier fold" are the same tuple. Pointed at F2 they are
    not, and the difference is a leak: F3's test rows are in F2's future, and a
    reliability curve fitted on them would be a curve the artifact has seen.
    """
    body = inspect.getsource(retrain.read_lane_inputs).split('"""')[-1]

    # The generalisation, spelled as a comparison against the scored fold's
    # index. `calendar.frozen_folds` is the tuple that used to be walked, and it
    # is the wrong one for every fold but the live edge.
    assert "frozen_folds" not in body
    assert "for earlier in calendar.folds:" in body
    assert "earlier.index >= fold.index" in body


def test_the_driver_takes_a_fold_id_all_the_way_down() -> None:
    assert "fold_id" in inspect.signature(retrain.read_lane_inputs).parameters


# --- nothing here can mint a record -------------------------------------------


def test_no_argument_of_the_driver_can_produce_a_served_row() -> None:
    """The discriminator is two modules down and this one holds no branch on it.

    The same reading `test_holdout_forecasts.py` performs one level lower, and
    it is performed again here because this is the module a scheduler runs: a
    driver that gained an ``origin_kind`` parameter would make the constant
    below a suggestion.
    """
    source = inspect.getsource(driver)

    assert "SERVED_ORIGIN_KIND" not in source
    assert "origin_kind=" not in source
    assert BACKFILLED_HOLDOUT_ORIGIN_KIND in source


def test_the_report_names_a_failed_lane_without_losing_the_other(
    tmp_path: Path,
) -> None:
    """One lane's refusal is a line in the report, not the run's exit code.

    The database url is unreachable on purpose, so both lanes fail — what is
    asserted is the *shape*: every lane accounted for, each with its own reason,
    and no exception escaping the driver.
    """
    report = driver.run_holdout_backfill(request(tmp_path, fold_id="F2"))

    assert report.fold_id == "F2"
    assert report.runs == ()
    assert [failure.lane.directory_name for failure in report.failures] == [
        lane.directory_name for lane in SERVING_LANES
    ]
    assert all(failure.reason for failure in report.failures)
    payload = report.as_dict()
    assert payload["fold_id"] == "F2"
    assert payload["runs"] == []
    assert len(payload["failures"]) == len(SERVING_LANES)


def test_a_run_that_scored_nothing_exits_non_zero(tmp_path: Path) -> None:
    """The operator's signal, and it is the retrain's rule: no result is a fault.

    A lane that refuses is not what this measures — a backfill has no gate and
    nothing to refuse. What it measures is a run that reached no fold at all,
    which is always something to go and look at.
    """
    code = driver.main(
        [
            "--fold",
            "F2",
            "--root",
            str(tmp_path),
            "--database-url",
            "postgres://nobody@127.0.0.1:1/none",
            "--as-of",
            "2026-09-04T03:40:00Z",
        ]
    )
    assert code == 1


def test_no_database_url_is_a_configuration_complaint(tmp_path: Path) -> None:
    assert driver.main(["--root", str(tmp_path), "--database-url", ""]) == 2


# --- against real Postgres ----------------------------------------------------


def test_a_named_frozen_fold_reads_against_real_postgres() -> None:
    """The read path, pointed at a fold the weekly retrain never selects.

    The honest limit of an automated test here is the read: a database with no
    ingested rows cannot fit anything. What this asserts is that naming a frozen
    fold reaches Postgres and comes back either with that fold's blocks — its
    *own* test window, fixed by the rules and not by the clock — or with a
    refusal that says which clause could not be satisfied.
    """
    url = database_url()
    assert url
    calendar = materialize_fold_calendar(AS_OF.date())
    fold = newest_frozen_fold(calendar)
    assert fold is not None

    async def read(conn: Any) -> str:
        try:
            inputs = await retrain.read_lane_inputs(
                conn, LATE_LANE, as_of=AS_OF, fold_id=fold.id
            )
        except retrain.RetrainError as refusal:
            return f"refused: {refusal}"
        assert inputs.fold.id == fold.id
        assert not inputs.fold.is_live_edge
        assert inputs.blocks.test_end == fold.quarter_end
        assert all(earlier.index < fold.index for earlier, _, _ in inputs.prior)
        return "read"

    assert run(read).startswith(("read", "refused: "))


# --- the route the worker calls ------------------------------------------------


def test_a_fold_already_in_flight_here_is_refused_rather_than_raced() -> None:
    """409, and it is the queue's retry policy this exists for.

    A backfill outlives most client timeouts, so the worker can give up on a
    call that is still running and hand the job back. Without this, the second
    attempt would spawn a second child fitting the *same* artifact id into the
    same lane directory, and the two would race over one bundle. The id being
    the fold's rather than a clock's makes that collision certain rather than
    unlikely, which is why the guard is here and not merely advisable.
    """
    from fastapi.testclient import TestClient

    from wattsteer_ml import app as app_module
    from wattsteer_ml import backfill_supervisor

    client = TestClient(app_module.app)
    # The set moved to the supervisor when the run stopped living inside the
    # request: it is taken by the POST and released by the supervising task,
    # because the run now outlives the request that started it.
    backfill_supervisor._BACKFILLING.add("F3")
    try:
        response = client.post("/internal/backfill/holdout", json={"fold_id": "F3"})
    finally:
        backfill_supervisor._BACKFILLING.discard("F3")
    assert response.status_code == 409
    body = response.json()["error"]
    assert body["code"] == "HOLDOUT_BACKFILL_IN_PROGRESS"
    # The worker reads this as "go and poll it" rather than as a failure, so
    # the refusal has to say where.
    assert body["details"]["status"] == "/internal/backfill/holdout/F3"


def test_the_route_is_worker_only_and_spawns_a_child_interpreter() -> None:
    """`/internal`, and the fit is never on this instance's event loop.

    Both are the retrain's rules and both are asserted rather than described: a
    multi-minute LightGBM fit inside the handler would stall every read the
    modelling service is also serving, and a public prefix would put a
    forty-minute job behind an unauthenticated request.
    """
    from wattsteer_ml import app as app_module
    from wattsteer_ml import backfill_supervisor

    source = inspect.getsource(app_module.backfill_holdout)
    assert "wattsteer_ml.holdout_backfill" in source
    # The spawn moved to the supervising task with the run. Asserted there
    # rather than dropped: "the fit is never on this instance's event loop" is
    # the property, and the route handing the argv to `begin` is how it holds.
    assert "backfill_supervisor.begin" in source
    assert "create_subprocess_exec" in inspect.getsource(backfill_supervisor)
    routes = [getattr(route, "path", "") for route in app_module.app.routes]
    assert "/internal/backfill/holdout" in routes
    assert "/internal/backfill/holdout/{fold}" in routes
    assert not any(path.startswith("/v1") and "backfill" in path for path in routes)


def test_the_start_answers_202_without_waiting_for_the_child() -> None:
    """The repair, asserted where it can fail.

    Measured on the live deployment on 2026-09-22: the worker's call was cut at
    about 350 s — not the forty-minute ceiling it carried — while the child went
    on scoring for another ninety minutes. This route's product *is* its
    response body, because the service is read-only against Postgres and the
    worker appends the rows, so a cut connection threw a scored fold away. A
    POST that waits for the child is therefore not a slower version of this: it
    is the defect.
    """
    import asyncio
    import inspect as _inspect

    from wattsteer_ml import app as app_module

    source = _inspect.getsource(app_module.backfill_holdout)
    assert "202" in source
    # Nothing in the handler awaits the child: `communicate` is the call that
    # made the POST as long as the run.
    assert "communicate" not in source
    assert asyncio.iscoroutinefunction(app_module.backfill_holdout_status)


def test_a_fold_this_instance_never_started_is_a_404_and_says_so() -> None:
    """Which is what the worker sees when this service was replaced mid-run.

    A real failure of *that* run — the child went with the container — and it
    has to be distinguishable from a run that is still going, or the queue
    would poll a dead id until its ceiling.
    """
    from fastapi.testclient import TestClient

    from wattsteer_ml import app as app_module

    client = TestClient(app_module.app)
    response = client.get("/internal/backfill/holdout/F9")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "HOLDOUT_BACKFILL_UNKNOWN"
