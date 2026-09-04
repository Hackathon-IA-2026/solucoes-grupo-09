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
