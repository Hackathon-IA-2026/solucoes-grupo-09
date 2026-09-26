"""The service's contract with the gateway, asserted without a database.

Every test here runs with no Postgres and no mounted volume, because that is the
state a fresh checkout and a broken deploy share — and the interesting claims
(the probe is process-only, an unconfigured database is reported rather than
hidden, a lane never claims a state it cannot know) are all true in exactly that
state.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wattsteer_ml.app import app
from wattsteer_ml.artifacts import ARTIFACT_SUFFIX, CARD_SUFFIX
from wattsteer_ml.config import settings
from wattsteer_ml.lanes import Lane
from wattsteer_ml.promotions import (
    PROMOTION_LOG_FILENAME,
    PromotionRecord,
    append,
)

client = TestClient(app)

LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
PROMOTED = "2026-08-28T03:11:07Z"
REFUSED = "2026-09-04T03:10:12Z"


def test_health_is_process_only() -> None:
    """Liveness must not consult Postgres — see the Dockerfile's HEALTHCHECK."""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_reports_an_unconfigured_database_rather_than_crashing() -> None:
    response = client.get("/ready")
    assert response.status_code == 503
    assert response.json()["database"] == "unconfigured"


def test_meta_states_the_read_only_boundary() -> None:
    """Drizzle owns migrations; Python reads. The service says so on demand."""
    body = client.get("/v1/meta").json()
    assert body["database_access"] == "read-only"
    assert body["artifacts"]["path"]


def test_meta_reports_lane_states_and_not_just_a_file_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The distinction story 33 asks for, on the wire.

    Two lanes, identical on disk except for the decision taken about them: the
    promoted one carries an older artifact than the refused one, so a screen
    reading this response cannot confuse "the newest thing we trained" with
    "the thing we are allowed to serve".
    """
    root = tmp_path / "models"
    unpromoted = Lane(
        feature_set="dessem_free_v1", gate_profile="gate_early", threshold_mw=5
    )
    for lane, artifact_id in ((LANE, PROMOTED), (unpromoted, PROMOTED)):
        directory = root / lane.directory_name
        directory.mkdir(parents=True)
        (directory / f"{artifact_id}.joblib").write_bytes(b"bundle")
    (root / LANE.directory_name / f"{REFUSED}.joblib").write_bytes(b"candidate")
    monkeypatch.setattr(settings, "artifact_dir", root)
    for artifact_id, decision, reason in (
        (PROMOTED, "promote", "bootstrap P = 0.94"),
        (REFUSED, "refuse", "crossing_rate 0.04 > 0.01"),
    ):
        append(
            root / PROMOTION_LOG_FILENAME,
            PromotionRecord(
                artifact_id=artifact_id,
                lane=LANE,
                decision="promote" if decision == "promote" else "refuse",
                reason=reason,
                at=datetime(2026, 9, 4, 3, 10, 12, tzinfo=UTC),
            ),
        )

    body = client.get("/v1/meta").json()["artifacts"]
    states = {lane["lane"]: lane for lane in body["lanes"]}
    served = states[LANE.directory_name]
    assert served["state"] == "promoted"
    assert served["promoted"] == PROMOTED
    # The refused candidate is newer and is on the volume; it is not served.
    assert served["newest"] == REFUSED
    assert states[unpromoted.directory_name]["state"] == "present_unpromoted"
    assert states[unpromoted.directory_name]["promoted"] is None
    assert body["promotion_log"]["decisions"] == 2
    assert body["promotion_log"]["error"] is None
    assert body["count"] == 3


def test_meta_says_when_the_promotion_log_cannot_be_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A damaged log is diagnosable, and no lane claims a state it cannot know."""
    root = tmp_path / "models"
    (root / LANE.directory_name).mkdir(parents=True)
    (root / LANE.directory_name / f"{PROMOTED}.joblib").write_bytes(b"bundle")
    (root / PROMOTION_LOG_FILENAME).write_text("half a line")
    monkeypatch.setattr(settings, "artifact_dir", root)

    body = client.get("/v1/meta").json()["artifacts"]
    assert body["promotion_log"]["error"]
    assert body["lanes"][0]["state"] == "unresolvable"
    assert body["lanes"][0]["promoted"] is None


def test_this_service_serves_no_day_ahead_read() -> None:
    """The stub is gone, and with it the gateway's dependency on this process.

    It stood in until forecasts were persisted; api-surface ticket 11 deleted it
    together with the gateway's proxy route. The public day-ahead read is on
    Elysia and resolves from Postgres, so asserting its absence *here* is what
    stops the proxy quietly coming back: a route on this service is the only
    thing one could point at. Asserted on the route table rather than on a 404,
    because a 404 is also what a typo produces.
    """
    paths = {route.path for route in app.routes if hasattr(route, "path")}
    assert "/v1/forecast/day-ahead" not in paths
    assert not any(path.endswith("forecast/day-ahead") for path in paths)
    # What does cross the boundary: a publication and a solve, both of which
    # need this process because neither can be answered from a row.
    assert "/internal/publish/forecast" in paths
    assert "/v1/optimize" in paths


def test_readiness_refuses_when_a_promoted_artifact_will_not_load(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deploy fails instead of the publication.

    Production, 2026-09-24 to 26. `a2f1c4b` made two fields required on
    `HurdleBundle`. Bundles are pickled, so joblib rebuilds them without
    `__init__` and every artifact written before that commit came back with the
    fields absent — refused by the loader, correctly. The deploy carrying that
    change **passed its healthcheck**, because readiness asked Postgres whether
    it was up and never asked whether the thing this service claims to serve
    could be served. `publish-forecast:gate_early` then answered
    `MODEL_UNAVAILABLE` for two days while `/v1/meta` reported `usable: true`.

    Readiness reads the volume now, so a deployment that cannot load what the
    promotion log names never takes over from the one serving.
    """
    import joblib

    from wattsteer_ml import app as app_module
    from wattsteer_ml.training.bundle import HurdleBundle

    lane_dir = tmp_path / LANE.directory_name
    lane_dir.mkdir(parents=True)
    # The incident's exact shape, and the reason it was invisible: the card is
    # on the volume and parses, so `LaneView.usable` called the lane fine. The
    # bundle is on the volume too and unpickles — into an instance whose newer
    # fields are simply absent, which is what joblib gives back for an object
    # written before those fields existed, because pickle restores attributes
    # and never runs `__init__`. `_validated` is what catches it.
    (lane_dir / f"{PROMOTED}{CARD_SUFFIX}").write_text("{}")
    joblib.dump(object.__new__(HurdleBundle), lane_dir / f"{PROMOTED}{ARTIFACT_SUFFIX}")
    append(
        tmp_path / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            lane=LANE,
            artifact_id=PROMOTED,
            decision="promote",
            at=datetime(2026, 8, 28, 3, 11, 7, tzinfo=UTC),
            reason="promoted in the fixture",
        ),
    )
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    # The cache is keyed per (lane, artifact) and this test supplies its own.
    app_module._PROMOTED_LOAD_CHECKS.clear()

    faults = app_module.promoted_load_faults()
    assert LANE.directory_name in faults
    # The sentence production printed, not merely "something went wrong": the
    # reason is the repair, and it is what `/v1/meta` renders for an operator.
    assert "could not be loaded" in faults[LANE.directory_name]
    assert PROMOTED in faults[LANE.directory_name]

    # A **healthy** database, so the 503 below can only be about the volume.
    # Without this the assertion is blind: readiness already answers 503 in
    # this suite because no Postgres is configured, so it would pass with the
    # volume check removed — which is what a mutation of this file proved.
    class _Healthy:
        async def ping(self) -> bool:
            return True

        async def is_read_only(self) -> bool:
            return True

        async def relation_exists(self, _name: str) -> bool:
            return True

    monkeypatch.setattr(app_module, "database", _Healthy())

    response = client.get("/ready")
    assert response.status_code == 503
    body = response.json()
    assert body["database"] == "ok"
    assert body["read_only"] is True
    assert body["schema_present"] is True
    # Everything Postgres owns is fine, so the refusal is the volume's alone.
    assert LANE.directory_name in body["promoted_faults"]

    # And the lane stops claiming it can serve, which is the half that was
    # lying on screen: `usable` reads the card and cannot reach the bundle.
    lanes = {
        row["lane"]: row for row in client.get("/v1/meta").json()["artifacts"]["lanes"]
    }
    assert lanes[LANE.directory_name]["usable"] is False
    assert lanes[LANE.directory_name]["unusable_reason"]

    app_module._PROMOTED_LOAD_CHECKS.clear()


def test_nothing_promoted_is_not_a_fault(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty volume is the ordinary state, not a broken deployment.

    The check above must not fire when there is simply nothing to serve: this
    product renders "no forecast is published" as a stated absence and every
    observed route answers without a model. Readiness failing there would take
    a working deployment down over its normal condition.
    """
    from wattsteer_ml import app as app_module

    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    app_module._PROMOTED_LOAD_CHECKS.clear()
    assert app_module.promoted_load_faults() == {}
    assert client.get("/ready").json()["promoted_faults"] == {}
    app_module._PROMOTED_LOAD_CHECKS.clear()
