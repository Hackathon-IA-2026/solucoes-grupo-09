"""The HTTP surface of the ML service.

This is an internal service: only `apps/api` (Elysia) calls it, and the Expo app
never does. So there is no CORS layer and no rate limiter here — those live in
the gateway, which is the only thing on the public network. What this service
owes the gateway is a stable contract, a probe that means what it says, and
enough self-description that a misconfigured deploy is diagnosable from one
request.

Routes:
  GET /                       identity
  GET /health                 liveness — process only, never touches Postgres
  GET /ready                  readiness — database reachable, read-only, migrated
  GET /v1/meta                what this instance can actually do right now
  GET /v1/forecast/day-ahead  the stub the gateway proxies to
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from typing import Annotated, Literal

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__, artifacts
from .config import settings
from .constants import Subsystem
from .database import database

#: `Subsystem` comes from `constants.py`, which is bound to the TypeScript
#: definition by a shared golden vector rather than by a comment. It is a
#: literal rather than a database lookup so a request naming a nonsense
#: subsystem — or `SIN`, which is not one — is rejected by the schema before it
#: reaches Postgres.

#: Day-ahead is the only horizon WattSteer forecasts (charting decision), so the
#: hour count is a constant of the domain rather than a request parameter.
HORIZON_HOURS = 24

#: A canonical **view** Drizzle creates. `/ready` uses it to tell "migrations
#: have not run" apart from "there is no database".
#:
#: A view rather than a table since ticket 016, and the change is not cosmetic:
#: the views are what this service actually reads, and a readiness probe should
#: assert the surface it depends on rather than one underneath it. A database
#: migrated as far as the base tables but not as far as the views would answer
#: every canonical read with `relation does not exist`, and the old probe would
#: have called that ready.
CANONICAL_VIEW = "canonical_system_context"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Hold the connection pool open for the process's life.

    Nothing is opened eagerly: a pool created at boot would make Postgres a
    startup dependency, and a database blip would then become a restart loop of
    a service whose job is mostly reading files off a volume.
    """
    yield
    if database is not None:
        await database.close()


app = FastAPI(
    title="WattSteer ML",
    version=__version__,
    summary="Features, training, inference, SHAP, backtests and the flex optimizer.",
    lifespan=lifespan,
    # Docs are for whoever is wiring the gateway up; closed in production
    # because this service has no public surface to document.
    docs_url=None if settings.is_prod else "/docs",
    redoc_url=None,
    openapi_url=None if settings.is_prod else "/openapi.json",
)


class Identity(BaseModel):
    name: str
    version: str
    docs: str | None


class Health(BaseModel):
    status: Literal["ok"]


class Readiness(BaseModel):
    """Why the service is or is not ready, in the terms of its dependencies."""

    ready: bool
    database: Literal["ok", "unconfigured", "unreachable"]
    #: False would mean the read-only session guard did not take — a bug worth
    #: failing readiness over, since this service must never be able to write.
    read_only: bool | None = None
    #: False means Postgres is up but Drizzle has not migrated it yet. Not our
    #: fix, and worth saying so plainly.
    schema_present: bool | None = None


class ArtifactState(BaseModel):
    path: str
    mounted: bool
    writable: bool
    count: int
    current: str | None


class Meta(BaseModel):
    """Everything needed to diagnose a misconfigured instance in one request."""

    service: str
    version: str
    environment: str
    database_configured: bool
    #: Stated as a fact about this service, not a hope: the pool is opened with
    #: `default_transaction_read_only = on`. Drizzle owns migrations.
    database_access: Literal["read-only"]
    artifacts: ArtifactState


class ForecastStub(BaseModel):
    """The day-ahead response shape, with no forecast in it yet.

    Deliberately carries `status: "not_implemented"` and an empty `hours` list
    rather than plausible-looking numbers. A stub that invents a P10/P50/P90
    profile is indistinguishable from a trained model having a bad day, and this
    project's standing rule is that nothing reaches a screen it cannot defend.
    The gateway can wire and test its proxy against this shape today, and the
    only thing that changes when the forecaster lands is that `hours` fills in
    and `status` becomes `ok`.
    """

    subsystem: Subsystem
    target_date: date
    horizon_hours: int = Field(default=HORIZON_HOURS)
    status: Literal["not_implemented"]
    detail: str
    #: Which artifact produced the numbers. `None` while there are none.
    artifact: str | None
    hours: list[dict[str, float]]
    generated_at: datetime


@app.get("/", response_model=Identity, tags=["meta"])
def identity() -> Identity:
    return Identity(
        name="wattsteer-ml",
        version=__version__,
        docs=None if settings.is_prod else "/docs",
    )


@app.get("/health", response_model=Health, tags=["meta"])
def health() -> Health:
    """Liveness. Answers from the process alone — see `lifespan`."""
    return Health(status="ok")


@app.get("/ready", response_model=Readiness, tags=["meta"])
async def ready() -> JSONResponse:
    """Readiness: can this instance actually serve a database-backed request?

    Returns 503 with the same body when it cannot, so a load balancer and a
    human reading the JSON learn the same thing.
    """
    if database is None:
        state = Readiness(ready=False, database="unconfigured")
    elif not await database.ping():
        state = Readiness(ready=False, database="unreachable")
    else:
        read_only = await database.is_read_only()
        migrated = await database.relation_exists(CANONICAL_VIEW)
        state = Readiness(
            ready=read_only and migrated,
            database="ok",
            read_only=read_only,
            schema_present=migrated,
        )
    return JSONResponse(
        status_code=200 if state.ready else 503,
        content=state.model_dump(mode="json"),
    )


@app.get("/v1/meta", response_model=Meta, tags=["meta"])
def meta() -> Meta:
    store = artifacts.inspect()
    return Meta(
        service="wattsteer-ml",
        version=__version__,
        environment=settings.env,
        database_configured=database is not None,
        database_access="read-only",
        artifacts=ArtifactState(
            path=str(store.path),
            mounted=store.mounted,
            writable=store.writable,
            count=len(store.artifacts),
            current=store.current,
        ),
    )


@app.get("/v1/forecast/day-ahead", response_model=ForecastStub, tags=["forecast"])
def day_ahead(
    subsystem: Annotated[Subsystem, Query(description="ONS subsystem code.")],
    target_date: Annotated[
        date | None,
        Query(description="The day being forecast (UTC). Defaults to today."),
    ] = None,
) -> ForecastStub:
    """The endpoint the Elysia gateway proxies, standing in for the forecaster.

    It exists to prove the boundary — gateway → ml over the compose/Railway
    private network, with a typed request and a typed response — before any
    model exists to serve.
    """
    now = datetime.now(tz=UTC)
    return ForecastStub(
        subsystem=subsystem,
        target_date=target_date or now.date(),
        status="not_implemented",
        detail=(
            "The day-ahead forecaster is not built yet. This endpoint returns "
            "its shape so the gateway proxy can be wired and tested; it will "
            "never return invented numbers."
        ),
        artifact=artifacts.inspect().current,
        hours=[],
        generated_at=now,
    )
