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
    return settings


settings = _load()
