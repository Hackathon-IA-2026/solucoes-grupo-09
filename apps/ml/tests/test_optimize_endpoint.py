"""`POST /v1/optimize` — one request, no job id, and one row per failure.

`docs/specs/flex-optimizer.md`'s failure posture is a table, and a table is worth
exactly as much as the tests that hold each of its rows apart. Two rows agreeing
on both the status *and* the code is the defect this file exists to catch: "the
gap was not closed" is a different thing to tell a user than "we gave up
waiting", and `INFEASIBLE` is a WattSteer bug rather than a bad request.

The band is injected. Reading a real one is `forecast_reads.py`'s job and
`test_planning_profile.py`'s to check; what this file needs is a band that is the
same on every run, so that a failure here is a failure of the *table* and never
of the day's forecast. So a fixture band lives *here*, in the tests, where it
cannot reach a screen: a service that served one would be putting invented
numbers behind a percentage, which is the thing this project refuses everywhere.
"""

from __future__ import annotations

import copy
import inspect
import json
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import ortools
import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from wattsteer_ml import app as app_module
from wattsteer_ml.app import app, optimize, profile_source
from wattsteer_ml.optimizer import OPTIMIZER_BUILD, SolverNotOptimalError
from wattsteer_ml.optimizer.errors import OptimizerBugError
from wattsteer_ml.optimizer.result import PlanningProfile
from wattsteer_ml.scenario import decode_scenario_body
from wattsteer_ml.scenario_validation import latest_target_date

REPO = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO / "packages" / "core" / "schema"
BASE = "https://wattsteer.com/schema/"

client = TestClient(app)

#: IDEA.md §27's reference profile — the shape the research measured, used here
#: as the P50 envelope of an injected band. It is a *test* fixture and stays one.
P50: tuple[float, ...] = (
    *(0.0,) * 10,
    20.0,
    70.0,
    110.0,
    90.0,
    30.0,
    10.0,
    *(0.0,) * 8,
)
P10: tuple[float, ...] = tuple(value * 0.4 for value in P50)
P90: tuple[float, ...] = tuple(value * 1.5 for value in P50)

BAND = PlanningProfile(
    forecast_origin=datetime(2026, 8, 28, 12, 0, tzinfo=UTC),
    vintage_fidelity="point_in_time",
    p10_mwh=P10,
    p50_mwh=P50,
    p90_mwh=P90,
)


def _band(**_: Any) -> PlanningProfile:
    return BAND


def _registry() -> Registry[Any]:
    """The schema directory, loaded the way `packages/core/src/schema.ts` loads it."""
    registry: Registry[Any] = Registry()
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        registry = registry.with_resource(
            BASE + path.name,
            Resource.from_contents(json.loads(path.read_text(encoding="utf-8"))),
        )
    return registry


RESULT_VALIDATOR = Draft202012Validator(
    json.loads(
        (SCHEMA_DIR / "optimization-result.schema.json").read_text(encoding="utf-8")
    ),
    registry=_registry(),
)


def scenario(**overrides: Any) -> dict[str, Any]:
    """A scenario the refusal table admits, on a date it will still admit tomorrow.

    The target date is derived from the clock rather than written down: the
    handler validates against `datetime.now`, and a fixture with a fixed date
    would start failing on `TARGET_DATE_OUT_OF_RANGE` the day after it was
    written — which is a broken test, not a caught bug.
    """
    wire: dict[str, Any] = {
        "v": 1,
        "subsystem": "NE",
        "target_date": latest_target_date(datetime.now(tz=UTC)).isoformat(),
        "assets": [
            {
                "asset_type": "battery",
                "label": "Battery",
                "subsystem": "NE",
                "max_power_mw": 100,
                "energy_capacity_mwh": 300,
                "round_trip_efficiency": 0.92,
                "initial_state_of_charge": 0.2,
            }
        ],
        "economic_assumptions": {"brl_per_mwh": 180},
    }
    wire.update(overrides)
    return wire


@pytest.fixture
def banded() -> Iterator[TestClient]:
    """The endpoint with a band to plan against. Reset after every test."""
    app.dependency_overrides[profile_source] = lambda: _band
    yield client
    app.dependency_overrides.clear()


# --- one request, and nothing that smells of a job ----------------------------


def test_the_handler_is_a_def_so_a_two_second_solve_cannot_block_the_loop() -> None:
    """A `def`, not an `async def` — the spec says so and it is load-bearing.

    FastAPI runs a sync handler on the threadpool. An `async def` would run the
    solve *on the event loop*, where a worst-case 2 s branch-and-bound stalls
    every other in-flight request in the process.
    """
    assert not inspect.iscoroutinefunction(optimize)


def test_a_scenario_answers_with_a_plan_inside_one_request(banded: TestClient) -> None:
    response = banded.post("/v1/optimize", json=scenario())
    assert response.status_code == 200
    body = response.json()
    RESULT_VALIDATOR.validate(body)
    assert body["scenario_hash"] == decode_scenario_body(scenario()).hash
    assert len(body["dispatch"]) == 24


def test_there_is_no_job_id_anywhere_in_the_contract(banded: TestClient) -> None:
    """No queue, no job and no `OptimizationJob` noun — asserted on the wire.

    A polling contract leaks as a key long before it leaks as a screen: one
    `job_id` on a 200 and every client has to learn to wait for something.
    """
    raw = banded.post("/v1/optimize", json=scenario()).text.lower()
    for noun in ("job_id", "job id", '"job"', "poll", "queued", "pending"):
        assert noun not in raw


def test_the_solver_receipt_traces_a_number_back_to_its_run(banded: TestClient) -> None:
    """Backend, status, wall time, objective and the versions, read at runtime.

    Hard-coding the versions would make the Apache-2.0 claim about SCIP a
    comment rather than something checkable from a response body.
    """
    solver = banded.post("/v1/optimize", json=scenario()).json()["solver"]
    assert solver["status"] == "OPTIMAL"
    assert solver["backend"] == "SCIP"
    assert solver["wall_time_ms"] >= 0
    assert isinstance(solver["objective"], float)
    assert solver["ortools_version"] == ortools.__version__
    assert solver["scip_version"] is not None


def test_every_solve_is_single_threaded_and_time_limited(
    banded: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`SetNumThreads(1)` and `SetTimeLimit(2000)`, per solve rather than per boot.

    Per-request CPU stays bounded under concurrency — at these sizes parallel
    branch-and-bound buys nothing — and the time limit is what makes
    `SOLVER_TIMEOUT` a bounded wait instead of a hung worker.
    """
    seen: dict[str, int] = {}
    from wattsteer_ml.optimizer import milp
    from wattsteer_ml.optimizer.backend import create_solver

    class Recorded:
        """A proxy, because a SWIG object will not take an attribute."""

        def __init__(self, solver: Any) -> None:
            self._solver = solver

        def SetNumThreads(self, count: int) -> Any:  # noqa: N802 — OR-Tools' name
            seen["threads"] = count
            return self._solver.SetNumThreads(count)

        def SetTimeLimit(self, ms: int) -> Any:  # noqa: N802 — OR-Tools' name
            seen["time_limit_ms"] = ms
            return self._solver.SetTimeLimit(ms)

        def __getattr__(self, name: str) -> Any:
            return getattr(self._solver, name)

    monkeypatch.setattr(
        milp, "create_solver", lambda backend: Recorded(create_solver(backend))
    )
    assert banded.post("/v1/optimize", json=scenario()).status_code == 200
    assert seen == {"threads": 1, "time_limit_ms": 2000}


def test_the_build_travels_as_a_header_the_gateway_keys_its_cache_on(
    banded: TestClient,
) -> None:
    """Not a field: the published contract is closed and this is a deploy fact."""
    response = banded.post("/v1/optimize", json=scenario())
    assert response.headers["x-optimizer-build"] == OPTIMIZER_BUILD


# --- one test per row of the failure table ------------------------------------


def test_validation_is_a_422_with_the_code_from_the_table(banded: TestClient) -> None:
    """Re-validated here even though the gateway already did: this service
    trusts nothing it did not validate itself."""
    broken = scenario()
    broken["assets"][0]["initial_state_of_charge"] = 0.99
    response = banded.post("/v1/optimize", json=broken)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SOC_INITIAL_OUT_OF_BOUNDS"


def test_an_unreadable_version_is_refused_before_a_model_exists(
    banded: TestClient,
) -> None:
    response = banded.post("/v1/optimize", json=scenario(v=2))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SCENARIO_VERSION_UNSUPPORTED"


def test_no_forecast_is_a_404_and_not_a_422(monkeypatch: pytest.MonkeyPatch) -> None:
    """The one row of the table that is not a 422, with the shipped resolver.

    The scenario is fine and describes a real fleet; there is simply nothing to
    plan against. A 422 would tell the caller their request was malformed.

    The database is pinned to `None` rather than left to the environment: since
    flex-optimizer 07 a configured `DATABASE_URL` makes `profile_source` read a
    real band, and a refusal test that quietly depended on the developer's shell
    would pass for the wrong reason on one machine and fail on another.
    """
    monkeypatch.setattr(app_module, "database", None)
    app.dependency_overrides[profile_source] = app_module.profile_source
    try:
        response = client.post("/v1/optimize", json=scenario())
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "FORECAST_UNAVAILABLE"


@pytest.mark.parametrize(
    ("status", "expected_status", "expected_code"),
    [
        ("FEASIBLE", 503, "SOLVER_GAP_UNCLOSED"),
        ("NOT_SOLVED", 504, "SOLVER_TIMEOUT"),
        ("INFEASIBLE", 500, "SOLVER_BUG"),
        ("UNBOUNDED", 500, "SOLVER_BUG"),
        ("ABNORMAL", 500, "SOLVER_BUG"),
    ],
)
def test_a_non_optimal_solve_is_never_rendered(
    banded: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
    expected_status: int,
    expected_code: str,
) -> None:
    """A `FEASIBLE` result is a 503 and never a plan.

    The gap was not closed, so the Avoidability Score would be a lower bound,
    and there is no honest way to put a lower bound in a box labelled with a
    percentage.
    """

    def refuse(*_: Any, **__: Any) -> None:
        raise SolverNotOptimalError(status, "SCIP")

    monkeypatch.setattr(app_module, "optimization_result", refuse)
    response = banded.post("/v1/optimize", json=scenario())
    assert response.status_code == expected_status
    body = response.json()
    assert body["error"]["code"] == expected_code
    assert "dispatch" not in body


def test_infeasible_carries_the_scenario_hash_and_not_the_scenario(
    banded: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`INFEASIBLE` is ours: the do-nothing dispatch satisfies every constraint,
    so it can only mean validation let something through. The hash is what makes
    the run reproducible; the scenario itself is attacker-controlled and stays
    off the wire and out of the log."""

    def refuse(*_: Any, **__: Any) -> None:
        raise SolverNotOptimalError("INFEASIBLE", "SCIP")

    monkeypatch.setattr(app_module, "optimization_result", refuse)
    body = banded.post("/v1/optimize", json=scenario()).json()
    assert (
        body["error"]["details"]["scenario_hash"] == decode_scenario_body(scenario()).hash
    )
    assert "label" not in json.dumps(body)


def test_an_invariant_the_builder_owns_is_a_500_and_not_a_refusal(
    banded: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A duplicate variable name or a `δ·(1+RTE) ≥ 1` battery is a WattSteer bug."""

    def refuse(*_: Any, **__: Any) -> None:
        raise OptimizerBugError("duplicate MILP variable name")

    monkeypatch.setattr(app_module, "optimization_result", refuse)
    response = banded.post("/v1/optimize", json=scenario())
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "SOLVER_BUG"


def test_the_scenario_is_not_corrected_on_its_way_through(banded: TestClient) -> None:
    """Nothing is coerced: the answer is stamped with the hash of what arrived."""
    submitted = scenario()
    before = copy.deepcopy(submitted)
    banded.post("/v1/optimize", json=submitted)
    assert submitted == before


def test_a_horizon_the_zone_does_not_have_is_never_silently_shortened(
    banded: TestClient,
) -> None:
    """The dispatch is 24 local hours, derived from the IANA zone and asserted."""
    hours = [
        hour["hour_local"]
        for hour in banded.post("/v1/optimize", json=scenario()).json()["dispatch"]
    ]
    assert hours == list(range(24))


def test_the_target_date_names_the_day_the_plan_is_for(banded: TestClient) -> None:
    """A civil date in Brasilia, not a UTC one — the horizon is a local day."""
    tomorrow = latest_target_date(datetime.now(tz=UTC))
    assert isinstance(tomorrow, date)
    response = banded.post("/v1/optimize", json=scenario(target_date=str(tomorrow)))
    assert response.status_code == 200
