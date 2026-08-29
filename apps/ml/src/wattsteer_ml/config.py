"""Environment configuration — the single place this service reads env vars.

Mirrors `apps/api/src/config.ts`: one module, normalised once, typed. The
`WATTSTEER_ML_` prefix keeps the ML service's knobs distinct from the gateway's
`WATTSTEER_` ones, with two deliberate exceptions (`DATABASE_URL` and `PORT`)
that are platform conventions Railway and docker-compose already set.
"""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, read from the environment at import time."""

    model_config = SettingsConfigDict(
        env_prefix="WATTSTEER_ML_",
        env_file=".env",
        extra="ignore",
    )

    #: HTTP port. Railway injects `PORT`; the field default covers local runs.
    port: int = Field(default=8000, ge=1, le=65_535)

    #: `development` | `production`. Only gates the OpenAPI docs surface.
    env: str = "development"

    #: Postgres URL. Unset → the database-backed routes report "unconfigured"
    #: rather than failing to boot, so the service is inspectable without a DB.
    database_url: str | None = None

    #: Connection pool bounds. Small by default: this service's queries are
    #: analytical and few, and Railway's Postgres has a modest connection cap.
    db_pool_min: int = Field(default=1, ge=0, le=32)
    db_pool_max: int = Field(default=4, ge=1, le=64)
    db_connect_timeout_sec: float = Field(default=10.0, gt=0)

    #: Where trained model artifacts live. A Railway volume is mounted here in
    #: production and a named docker volume locally, so an artifact survives a
    #: redeploy — the weekly retrain writes here and inference reads from it.
    artifact_dir: Path = Path("/data/models")

    #: The flex optimizer's MILP backend. `SCIP` and `HIGHS` are the only
    #: permitted values; `optimizer.backend` refuses `CBC` and CP-SAT by name
    #: at startup, with the reason. Not validated here, so the refusal reads as
    #: a decision rather than a schema error.
    milp_backend: str = "SCIP"

    #: `ρ` in `δ_b = ρ · k_b / (2 + k_b)`, the battery-throughput tie-breaker.
    #: A modelling knob, never a scenario input: a user has no opinion about it,
    #: and correctness does not depend on it because the binaries ship.
    deg_penalty_rho: float = Field(default=1.5, ge=0)

    #: `SetTimeLimit`, milliseconds. The research measured 3.15 ms at real size;
    #: this bounds a pathological case rather than the expected one.
    milp_time_limit_ms: int = Field(default=2_000, gt=0)

    @property
    def is_prod(self) -> bool:
        return self.env == "production"


def _load() -> Settings:
    settings = Settings()
    # `PORT` and `DATABASE_URL` are set unprefixed by both Railway and
    # docker-compose. Honour them, but let the prefixed forms win so the ML
    # service can be pointed at a different database than the gateway's.
    if "WATTSTEER_ML_PORT" not in os.environ and (port := os.environ.get("PORT")):
        settings = settings.model_copy(update={"port": int(port)})
    if "WATTSTEER_ML_DATABASE_URL" not in os.environ and (
        url := os.environ.get("DATABASE_URL")
    ):
        settings = settings.model_copy(update={"database_url": url})
    # `docs/specs/flex-optimizer.md` names the optimizer's two knobs without the
    # service prefix. Honour those spellings on the same footing as `PORT`, and
    # let the prefixed forms win, so the spec's names work and this module stays
    # the only place either is read.
    if "WATTSTEER_ML_MILP_BACKEND" not in os.environ and (
        backend := os.environ.get("WATTSTEER_MILP_BACKEND")
    ):
        settings = settings.model_copy(update={"milp_backend": backend})
    if "WATTSTEER_ML_DEG_PENALTY_RHO" not in os.environ and (
        rho := os.environ.get("WATTSTEER_DEG_PENALTY_RHO")
    ):
        settings = settings.model_copy(update={"deg_penalty_rho": float(rho)})
    return settings


settings = _load()
