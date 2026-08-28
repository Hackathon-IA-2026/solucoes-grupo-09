"""The service's contract with the gateway, asserted without a database.

Every test here runs with no Postgres and no mounted volume, because that is the
state a fresh checkout and a broken deploy share — and the interesting claims
(the probe is process-only, the stub invents nothing, an unconfigured database
is reported rather than hidden) are all true in exactly that state.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from wattsteer_ml.app import HORIZON_HOURS, app

client = TestClient(app)


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


def test_day_ahead_stub_returns_no_invented_numbers() -> None:
    response = client.get("/v1/forecast/day-ahead", params={"subsystem": "SE"})
    assert response.status_code == 200
    body = response.json()
    assert body["subsystem"] == "SE"
    assert body["status"] == "not_implemented"
    assert body["horizon_hours"] == HORIZON_HOURS
    # The point of the stub: a shape to proxy, not a forecast to believe.
    assert body["hours"] == []
    assert body["artifact"] is None


def test_day_ahead_rejects_a_subsystem_ons_does_not_publish() -> None:
    """`SECO` is a real ONS spelling, but not one of the four canonical codes."""
    assert (
        client.get("/v1/forecast/day-ahead", params={"subsystem": "SECO"}).status_code
        == 422
    )


def test_day_ahead_requires_a_subsystem() -> None:
    assert client.get("/v1/forecast/day-ahead").status_code == 422
