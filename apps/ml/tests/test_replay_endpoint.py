"""`POST /v1/replay` — one request, no model in it, and one row per refusal.

`docs/specs/replay.md`, "The endpoint". The claims this file makes, in the
order the ticket lists them:

1. **One request.** No job id, no polling, and — the property the spec cares
   about most — **no model in the request path**: the handler's import graph is
   read, and `load_promoted`, `artifacts.current` and the feature builder are
   asserted absent from it. A forecast that were computed here would be a
   forecast that could see the day.
2. **One case per refusal code**, each a rejection at that clause's own status
   rather than a number with a caveat over it. The five codes are five
   different sentences and the test fails if any two collapse.
3. **The pre-F1 day is refused, and what it gets instead has no WattSteer
   number on it at all** — `scored`, `avoided_energy_mwh` and
   `recovered_floor_mwh` absent, not zero.
4. **Validation parity minus the date clause**, from this side of the wire: the
   same table, and a `TARGET_DATE_OUT_OF_RANGE` that a replay never emits
   because its date verdicts are the predicate's.

The rows are injected. Reading real ones is `replay/inputs.py`'s job and the
database suite's to check; what this file needs is a day that is the same on
every run, so a failure here is a failure of the *route* rather than of the
data.
"""

from __future__ import annotations

import ast
import inspect
import json
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from wattsteer_ml import app as app_module
from wattsteer_ml.app import (
    app,
    replay,
    replay_inputs_source,
    replay_observed_only,
)
from wattsteer_ml.config import settings
from wattsteer_ml.constants import MAX_GAP_HOURS
from wattsteer_ml.evaluation import FOLD_CALENDAR_RULES
from wattsteer_ml.lanes import Lane
from wattsteer_ml.mixture import QuantileBand
from wattsteer_ml.optimizer import OPTIMIZER_BUILD
from wattsteer_ml.publication import (
    BACKFILLED_HOLDOUT_ORIGIN_KIND,
    PRODUCER,
)
from wattsteer_ml.replay.calendar import HOURS_PER_DAY, DayEvidence
from wattsteer_ml.replay.inputs import ReplayInputs
from wattsteer_ml.replay.result import ReplayEpisode
from wattsteer_ml.replay.scoring import (
    ForecastHour,
    ObservedDay,
    PinnedForecast,
    PinnedOrigin,
)

REPO = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO / "packages" / "core" / "schema"
BASE = "https://wattsteer.com/schema/"

client = TestClient(app)

SUBSYSTEM = "NE"
THRESHOLD_MW = 5.0
LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
#: A day inside F3's test period, held out by the F3 artifact.
HELD_OUT_DAY = date(2025, 11, 12)
#: ``gate_at(HELD_OUT_DAY, gate_late)`` — the instant that forecast was published.
GATE = datetime(2025, 11, 11, 22, 0, tzinfo=UTC)
ARTIFACT_ID = "2025-10-01T03:10:00Z"

#: The card the held-out assertion runs against, on a real volume the route
#: reads through `read_windows` — not a monkeypatched function, because "the
#: promoted artifact is never consulted" is only a property when the route does
#: its own resolution.
CARD = {
    "fold": {"fold_id": "F3"},
    "lane": {"directory": LANE.directory_name},
    "data": {
        "training_window": {"start": "2024-04-01", "end": "2025-09-30"},
        "calibration_window": {"start": "2025-07-03", "end": "2025-09-30"},
    },
}

#: A card whose training window *contains* the replayed day — the fabrication
#: `replay.md` seam 1 requires, and the one thing that must be a 500.
LEAKING_CARD = {
    "fold": {"fold_id": "F6"},
    "lane": {"directory": LANE.directory_name},
    "data": {
        "training_window": {"start": "2024-04-01", "end": "2026-06-30"},
        "calibration_window": {"start": "2026-04-02", "end": "2026-06-30"},
    },
}

WORKED_HOURS = (10, 11, 12)


def _registry() -> Registry[Any]:
    registry: Registry[Any] = Registry()
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        registry = registry.with_resource(
            BASE + path.name,
            Resource.from_contents(json.loads(path.read_text(encoding="utf-8"))),
        )
    return registry


REGISTRY = _registry()
REPLAY_VALIDATOR = Draft202012Validator(
    json.loads((SCHEMA_DIR / "replay.schema.json").read_text(encoding="utf-8")),
    registry=REGISTRY,
)
OBSERVED_ONLY_VALIDATOR = Draft202012Validator(
    json.loads(
        (SCHEMA_DIR / "replay-observed-only.schema.json").read_text(encoding="utf-8")
    ),
    registry=REGISTRY,
)


def day_profile(values: tuple[float, ...]) -> tuple[float, ...]:
    hours = [0.0] * HOURS_PER_DAY
    for hour, value in zip(WORKED_HOURS, values, strict=True):
        hours[hour] = value
    return tuple(hours)


P50 = day_profile((40.0, 100.0, 60.0))
P10 = day_profile((0.0, 60.0, 0.0))
OBSERVED = day_profile((20.0, 160.0, 60.0))


def pinned(target_date: date = HELD_OUT_DAY) -> PinnedForecast:
    upper = tuple(value * 1.5 for value in P50)
    return PinnedForecast(
        subsystem=SUBSYSTEM,
        target_date=target_date,
        threshold_mw=THRESHOLD_MW,
        origin=PinnedOrigin(
            producer=PRODUCER,
            run_label=ARTIFACT_ID,
            published_at=GATE,
            origin_kind=BACKFILLED_HOLDOUT_ORIGIN_KIND,
            gate_profile=LANE.gate_profile,
        ),
        hours=tuple(
            ForecastHour(
                constrained_off_mwh=QuantileBand(p10=low, p50=mid, p90=high),
                expected_mwh=mid,
                occurrence_probability=1.0 if mid > 0 else 0.1,
            )
            for low, mid, high in zip(P10, P50, upper, strict=True)
        ),
        day_total=QuantileBand(p10=sum(P10) * 0.8, p50=sum(P50), p90=sum(upper) * 0.9),
        peak_power=QuantileBand(p10=max(P10), p50=max(P50), p90=max(upper)),
        day_occurrence_probability=0.9,
    )


def episode() -> ReplayEpisode:
    return ReplayEpisode(
        started_at=datetime(2025, 11, 12, 13, 0, tzinfo=UTC),
        ended_at=datetime(2025, 11, 12, 16, 0, tzinfo=UTC),
        duration_hours=3,
        total_mwh=sum(OBSERVED),
        peak_mw=max(OBSERVED),
        threshold_mw=THRESHOLD_MW,
        max_gap_hours=MAX_GAP_HOURS,
    )


def inputs(
    *,
    target_date: date = HELD_OUT_DAY,
    origin_kind: str | None = BACKFILLED_HOLDOUT_ORIGIN_KIND,
    artifact_id: str | None = ARTIFACT_ID,
    observed_hours: int = HOURS_PER_DAY,
    with_forecast: bool = True,
    with_observed: bool = True,
) -> ReplayInputs:
    """One day's evidence, as `read_replay_inputs` would have returned it."""
    return ReplayInputs(
        evidence=DayEvidence(
            target_date=target_date,
            origin_kind=origin_kind,
            artifact_id=artifact_id,
            observed_hours=observed_hours,
            candidate_lanes=(LANE.directory_name,),
        ),
        forecast=pinned(target_date) if with_forecast else None,
        observed=(
            ObservedDay(
                subsystem=SUBSYSTEM,
                target_date=target_date,
                hours=OBSERVED,
                data_version="3",
            )
            if with_observed
            else None
        ),
        episodes=(episode(),) if target_date == HELD_OUT_DAY else (),
        sources=(),
        threshold_mw=THRESHOLD_MW,
    )


def scenario(target_date: date = HELD_OUT_DAY, **overrides: Any) -> dict[str, Any]:
    wire: dict[str, Any] = {
        "v": 1,
        "subsystem": SUBSYSTEM,
        "target_date": target_date.isoformat(),
        "assets": [
            {
                "asset_type": "battery",
                "label": "Battery",
                "subsystem": SUBSYSTEM,
                "max_power_mw": 80,
                "energy_capacity_mwh": 400,
                "round_trip_efficiency": 0.99,
                "min_state_of_charge": 0,
                "max_state_of_charge": 1,
                "initial_state_of_charge": 0,
            }
        ],
        "economic_assumptions": {"brl_per_mwh": 180},
    }
    wire.update(overrides)
    return wire


@pytest.fixture
def volume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An artifact volume holding one card, and the settings pointed at it."""

    lane_dir = tmp_path / LANE.directory_name
    lane_dir.mkdir(parents=True)
    (lane_dir / f"{ARTIFACT_ID}.card.json").write_text(json.dumps(CARD), encoding="utf-8")
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    return tmp_path


def served(given: ReplayInputs) -> Iterator[TestClient]:
    app.dependency_overrides[replay_inputs_source] = lambda: lambda **_kwargs: given
    yield client
    app.dependency_overrides.clear()


@pytest.fixture
def replayable(volume: Path) -> Iterator[TestClient]:
    yield from served(inputs())


def ask(
    api: TestClient, wire: dict[str, Any] | None = None, path: str = "/v1/replay"
) -> Any:
    return api.post(path, params={"lane": LANE.directory_name}, json=wire or scenario())


# --- one request, and no model in it ------------------------------------------


def test_the_handlers_are_defs_so_two_solves_cannot_block_the_loop() -> None:
    """`def`, not `async def`, for the reason `/v1/optimize` is one.

    FastAPI runs a sync handler on the threadpool. A replay is *two* MILP solves
    and five simulator passes — more than an optimize — so an `async def` here
    would stall every other in-flight request for longer than the route it was
    copied from.
    """
    assert not inspect.iscoroutinefunction(replay)
    assert not inspect.iscoroutinefunction(replay_observed_only)


def test_no_model_is_loaded_anywhere_in_the_replay_request_path() -> None:
    """The forecast is a pinned row, asserted over the source rather than hoped.

    `replay.md` story 37: a replay's request path contains no joblib load, no
    feature build and no ML-service forecast call. The two handlers and the
    resolver they share are read as an AST and every name that would load a
    model is looked for by name — including `load_promoted` and
    `artifacts.current`, which are what would turn an honest replay into an
    in-sample one after a retrain.
    """

    forbidden = {
        "load_promoted",
        "current",
        "build_publication",
        "read_serving_rows",
        "joblib",
        "read_planning_profile",
        "served_profile_source",
    }
    for handler in (replay, replay_observed_only, app_module._resolve_replay):
        tree = ast.parse(inspect.getsource(handler))
        called = {
            node.func.id if isinstance(node.func, ast.Name) else node.func.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, (ast.Name, ast.Attribute))
        }
        assert not (called & forbidden), (
            f"{handler.__name__} reaches a model: {sorted(called & forbidden)}"
        )


def test_a_replayable_day_answers_with_the_published_contract(
    replayable: TestClient,
) -> None:
    response = ask(replayable)
    assert response.status_code == 200
    body = response.json()
    REPLAY_VALIDATOR.validate(body)
    assert body["target_date"] == HELD_OUT_DAY.isoformat()
    assert body["scored_on"] == "observed"
    assert body["planning_basis"] == "p50"
    # The pinned origin, echoed rather than re-derived — the field that makes a
    # shared link reproducible after a retrain.
    assert body["forecast_origin"]["run_label"] == ARTIFACT_ID
    assert body["forecast_origin"]["origin_kind"] == BACKFILLED_HOLDOUT_ORIGIN_KIND
    assert body["forecast_origin"]["published_at"] == "2025-11-11T22:00:00Z"
    assert body["integrity"]["model_saw_this_day"] is False
    assert body["integrity"]["held_out_by"]["artifact_id"] == ARTIFACT_ID
    # No job, nothing to poll for.
    text = json.dumps(body).lower()
    for noun in ("job_id", "poll", "queued", "status_url"):
        assert noun not in text


def test_the_build_that_solved_is_stamped_for_the_gateways_cache_key(
    replayable: TestClient,
) -> None:
    """A formulation change must not serve yesterday's plan under today's code."""
    assert ask(replayable).headers["x-optimizer-build"] == OPTIMIZER_BUILD


def test_the_fleet_re_plans_and_never_re_forecasts(replayable: TestClient) -> None:
    """The what-if controls behave exactly like Mitigate's.

    Two fleets, one day: the forecast published is identical byte for byte and
    the plan is not. That is the property that makes a replay a replay — no
    interaction on this screen can change what the model said at D−1.
    """
    small = ask(replayable).json()
    bigger = scenario()
    bigger["assets"][0]["max_power_mw"] = 20
    other = ask(replayable, bigger).json()
    assert small["forecast"] == other["forecast"]
    assert small["forecast_origin"] == other["forecast_origin"]
    assert small["avoided_energy_mwh"] != other["avoided_energy_mwh"]


# --- one case per refusal code -------------------------------------------------


def test_a_pre_f1_day_is_refused_and_not_labelled(volume: Path) -> None:
    """`REPLAY_DATE_BEFORE_HOLDOUT_WINDOW`, 422 — a rejection, not a caveat."""
    pre_f1 = FOLD_CALENDAR_RULES.first_test_start.replace(day=1)
    day = date(pre_f1.year - 1, 6, 15)
    for api in served(
        inputs(target_date=day, origin_kind=None, artifact_id=None, with_forecast=False)
    ):
        response = ask(api, scenario(day))
        assert response.status_code == 422
        error = response.json()["error"]
        assert error["code"] == "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW"
        assert error["details"]["observed_only"] is True
        # Nothing that could be quoted as a result.
        for field in ("avoided_energy_mwh", "recovered_floor_mwh", "scored"):
            assert field not in json.dumps(response.json())


def test_a_date_that_has_not_happened_is_out_of_range(volume: Path) -> None:
    """`REPLAY_DATE_OUT_OF_RANGE`, 422 — and never `TARGET_DATE_OUT_OF_RANGE`.

    `/v1/optimize` plans for tomorrow and says so with its own code. A replay of
    tomorrow is not a date outside the *planning* window; it is a day that has
    not happened, and the two sentences are two codes.
    """
    tomorrow = datetime.now(tz=UTC).date()
    for api in served(inputs(target_date=tomorrow, with_forecast=False)):
        response = ask(api, scenario(tomorrow))
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "REPLAY_DATE_OUT_OF_RANGE"


def test_a_day_with_no_pinned_rows_is_a_404(volume: Path) -> None:
    """`REPLAY_FORECAST_UNAVAILABLE` — the backtest has not reached this quarter."""
    for api in served(inputs(origin_kind=None, artifact_id=None, with_forecast=False)):
        response = ask(api)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "REPLAY_FORECAST_UNAVAILABLE"


def test_a_day_short_an_hour_is_a_404(volume: Path) -> None:
    """`REPLAY_OBSERVATION_INCOMPLETE` — the denominator is the whole local day."""
    for api in served(inputs(observed_hours=23)):
        response = ask(api)
        assert response.status_code == 404
        error = response.json()["error"]
        assert error["code"] == "REPLAY_OBSERVATION_INCOMPLETE"
        assert error["details"]["observed_hours"] == 23


def test_a_leaking_card_is_a_500_and_never_a_badge(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`REPLAY_INTEGRITY_VIOLATION` — the artifact saw the day it forecasts.

    The fabricated card `replay.md` seam 1 requires. A number computed from it
    would be an in-sample fit and better than the product's, so it is a 500 with
    the artifact id in the message and not a label over a percentage.
    """

    lane_dir = tmp_path / LANE.directory_name
    lane_dir.mkdir(parents=True)
    (lane_dir / f"{ARTIFACT_ID}.card.json").write_text(
        json.dumps(LEAKING_CARD), encoding="utf-8"
    )
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)

    for api in served(inputs()):
        response = ask(api)
        assert response.status_code == 500
        error = response.json()["error"]
        assert error["code"] == "REPLAY_INTEGRITY_VIOLATION"
        assert ARTIFACT_ID in error["message"]


def test_an_unreadable_card_is_a_500_rather_than_a_replay(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A claim that cannot be asserted is not a claim that passes."""

    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    for api in served(inputs()):
        response = ask(api)
        assert response.status_code == 500
        assert response.json()["error"]["code"] == "REPLAY_INTEGRITY_VIOLATION"


def test_the_five_refusals_keep_three_statuses_apart(volume: Path) -> None:
    """Two rows of the table agreeing on both status and code is the defect."""
    seen: set[tuple[int, str]] = set()
    cases = (
        inputs(target_date=date(2024, 6, 15), with_forecast=False),
        inputs(target_date=datetime.now(tz=UTC).date(), with_forecast=False),
        inputs(origin_kind=None, artifact_id=None, with_forecast=False),
        inputs(observed_hours=23),
    )
    for given in cases:
        for api in served(given):
            response = ask(api, scenario(given.evidence.target_date))
            seen.add((response.status_code, response.json()["error"]["code"]))
    assert len(seen) == 4
    assert {status for status, _ in seen} == {404, 422}


# --- the observed-only view a pre-F1 day gets ---------------------------------


def test_the_observed_only_view_carries_no_wattsteer_number(volume: Path) -> None:
    """The three fields `replay.md` requires absent are absent, not zero."""
    day = date(2024, 6, 15)
    given = ReplayInputs(
        evidence=DayEvidence(target_date=day, observed_hours=HOURS_PER_DAY),
        forecast=None,
        observed=ObservedDay(
            subsystem=SUBSYSTEM, target_date=day, hours=OBSERVED, data_version="3"
        ),
        episodes=(),
        sources=(),
        threshold_mw=THRESHOLD_MW,
    )
    for api in served(given):
        response = ask(api, scenario(day), path="/v1/replay/observed-only")
        assert response.status_code == 200
        body = response.json()
        OBSERVED_ONLY_VALIDATOR.validate(body)
        assert body["replayable"] is False
        assert body["refusal"]["code"] == "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW"
        assert body["upper_bound"]["label"] == "perfect_foresight"
        for field in ("scored", "avoided_energy_mwh", "recovered_floor_mwh"):
            assert field not in body
        # The gap is unrepresentable, not null: there was no forecast to cost.
        assert "forecast_value_gap_mwh" not in body["upper_bound"]


def test_a_replayable_day_is_not_offered_the_observed_only_view(
    replayable: TestClient,
) -> None:
    response = ask(replayable, path="/v1/replay/observed-only")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REQUEST_INVALID"


def test_a_missing_read_is_not_an_observed_only_day(volume: Path) -> None:
    """A 404 is a gap, not a decision, and it is not answered with a screen."""
    for api in served(inputs(observed_hours=23)):
        response = ask(api, path="/v1/replay/observed-only")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "REPLAY_OBSERVATION_INCOMPLETE"


# --- validation parity, minus the date clause ---------------------------------


def test_the_table_is_the_optimizers_everywhere_but_the_date(
    volume: Path,
) -> None:
    """Every non-date rule refuses identically at both endpoints.

    Asserted here as well as at the gateway because this service re-validates
    what it did not validate itself, and a second table that had drifted would
    make the gateway's parity test true and the system's claim false.
    """
    corpus: list[dict[str, Any]] = [
        scenario(v=2),
        scenario(subsystem="SIN"),
        scenario(assets=[]),
        scenario(assets=[scenario()["assets"][0]] * 21),
        scenario(economic_assumptions={"brl_per_mwh": 1_000_000}),
    ]
    for wire in corpus:
        for api in served(inputs()):
            from_replay = ask(api, wire)
        from_optimize = client.post("/v1/optimize", json=wire)
        assert (from_replay.status_code, from_replay.json()["error"]["code"]) == (
            from_optimize.status_code,
            from_optimize.json()["error"]["code"],
        ), wire


def test_a_replay_never_emits_the_planning_windows_code(volume: Path) -> None:
    """`TARGET_DATE_OUT_OF_RANGE` is `/v1/optimize`'s sentence, not a replay's.

    A 2024-06 target is a valid planning date and is refused here as pre-F1.
    That is the carve-out `replay.md` seam 10 names, and the assertion is that
    the *replay* codes are what a replay answers with.
    """
    day = date(2024, 6, 15)
    for api in served(
        inputs(target_date=day, origin_kind=None, artifact_id=None, with_forecast=False)
    ):
        assert (
            api.post(
                "/v1/replay",
                params={"lane": LANE.directory_name},
                json=scenario(day),
            ).json()["error"]["code"]
            == "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW"
        )
    # The same blob at `/v1/optimize` is a perfectly good planning request; only
    # its forecast is missing, which is a 404 about the data and not a 422 about
    # the date.
    assert (
        client.post("/v1/optimize", json=scenario(day)).json()["error"]["code"]
        != "TARGET_DATE_OUT_OF_RANGE"
    )


def test_a_malformed_lane_is_refused_before_anything_is_read(
    volume: Path,
) -> None:
    for api in served(inputs()):
        response = api.post("/v1/replay", params={"lane": "not a lane"}, json=scenario())
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "REQUEST_INVALID"


def test_no_database_is_a_503_rather_than_an_invented_replay() -> None:
    """An instance that cannot reach the rows has no replay, and says so."""
    app.dependency_overrides[replay_inputs_source] = lambda: None
    try:
        response = ask(client)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "DATA_UNAVAILABLE"
    finally:
        app.dependency_overrides.clear()
