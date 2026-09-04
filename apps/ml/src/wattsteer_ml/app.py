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
  POST /internal/publish/forecast  worker-only; returns rows, writes nothing
  POST /v1/optimize           the MILP and the simulator, inside one request
  GET /v1/replay/days         which days are replayable, and why the others are not
  GET /v1/replay/days/{date}  one day, at the status of the clause that refused it

There is deliberately **no day-ahead read here**. This service carried a
`GET /v1/forecast/day-ahead` stub for the gateway to proxy — a typed shape with
an empty `hours` list, so the boundary could be wired and tested before a model
existed. api-surface ticket 11 deleted it together with the gateway's proxy
route: the public read is `GET /v1/forecast/day-ahead` on Elysia and it resolves
entirely from Postgres, so the most-viewed screen survives this process being
down. What crosses this boundary now is a publication (worker → ml, ten minutes
after each gate), a solve, and the replay calendar — none of which a row can
answer.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal, cast

from fastapi import Body, Depends, FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import __version__, artifacts
from .config import settings
from .constants import Subsystem
from .database import database
from .evaluation.folds import FOLD_CALENDAR_RULES
from .evaluation.holdout import HoldoutLeakError
from .features import FeatureSet, GateProfile, read_serving_rows, serving_target_date
from .forecast_reads import served_profile_source
from .lanes import Lane, LaneNameError
from .optimizer import (
    OptimizerBugError,
    SolverNotOptimalError,
    configured_milp_backend,
)
from .optimizer.result import (
    OPTIMIZER_BUILD,
    ProfileSource,
    no_forecast_yet,
    optimization_result,
)
from .promotions import PROMOTION_LOG_FILENAME
from .publication import (
    SERVED_ORIGIN_KIND,
    ForecastPublication,
    PublicationError,
    PublicationRefusedError,
    build_publication,
    load_promoted,
)
from .replay.calendar import (
    ReplayCalendar,
    build_calendar,
    integrity_violation,
    latest_replayable_date,
)
from .replay.cards import read_windows
from .replay.reads import read_calendar_evidence
from .scenario import ScenarioTransportError, decode_scenario_body
from .scenario_validation import ScenarioValidationError, validate_scenario

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

#: Where a `SOLVER_BUG` says which scenario it was, by hash and never by value.
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Hold the connection pool open for the process's life.

    Nothing is opened eagerly: a pool created at boot would make Postgres a
    startup dependency, and a database blip would then become a restart loop of
    a service whose job is mostly reading files off a volume.

    The solver backend is the one exception, and deliberately so: `CBC` aborts
    the whole Python process on a duplicate variable name, which in a worker is
    a crash and not an exception. A deploy configured onto it has to die at
    boot with the reason, not on whichever request first reaches the optimizer.
    """
    configured_milp_backend()
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


class PromotionLogState(BaseModel):
    """The decision log, as a fact separate from the artifacts it governs.

    `decisions` counts refusals as well as promotions: a lane whose log holds
    only refusals is a lane that has been looked at and found wanting, which is
    not the same story as a volume nobody has written to.
    """

    path: str
    decisions: int
    #: Set when the log could not be read. While it is set, no lane on this
    #: volume can say what it is allowed to serve, and serving raises rather
    #: than falling back to the newest file.
    error: str | None


class LaneReport(BaseModel):
    """One artifact lane, and which of the three states it is in."""

    lane: str
    feature_set: str
    gate_profile: str
    threshold_mw: float
    #: `no_artifact` | `present_unpromoted` | `promoted` | `unresolvable`.
    #: The gateway forwards the first three as `details.lane_state` on a
    #: `MODEL_UNAVAILABLE`, which is how "no promoted artifact" reaches a screen
    #: as its own sentence rather than as a spinner.
    state: artifacts.LaneState
    artifact_count: int
    #: The artifact this lane serves. `None` is a decision — nothing has been
    #: promoted — not a missing file.
    promoted: str | None
    #: The newest bundle *on disk*. Differs from `promoted` exactly when the
    #: newest candidate was refused, which is the case the promotion log exists
    #: to keep off the wire.
    newest: str | None
    fault: str | None


class ArtifactState(BaseModel):
    path: str
    mounted: bool
    writable: bool
    count: int
    lanes: list[LaneReport]
    promotion_log: PromotionLogState
    #: Entries on the mount that name no lane — a loose `.joblib` in the root,
    #: a directory nobody can parse. Never served, always reported.
    unrecognised: list[str]


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
            count=store.artifact_count,
            lanes=[
                LaneReport(
                    lane=view.lane.directory_name,
                    feature_set=view.lane.feature_set,
                    gate_profile=view.lane.gate_profile,
                    threshold_mw=view.lane.threshold_mw,
                    state=view.state,
                    artifact_count=len(view.artifacts),
                    promoted=view.promoted,
                    newest=view.newest,
                    fault=view.fault,
                )
                for view in store.lanes
            ],
            promotion_log=PromotionLogState(
                path=str(store.path / PROMOTION_LOG_FILENAME),
                decisions=len(store.log.records) if store.log is not None else 0,
                error=store.log_error,
            ),
            unrecognised=list(store.unrecognised),
        ),
    )


# --- the publication route ----------------------------------------------------
#
# `docs/specs/api-surface.md`, "The boundary": **worker → ml, never gateway →
# ml**. The public day-ahead read resolves entirely from Postgres, and this
# route is what puts the rows there — ten minutes after each gate, called by the
# worker, computed here and *written by the caller*. This service is read-only
# against Postgres and stays that way; what it returns is rows, not an effect.
#
# It is under `/internal` and not `/v1` because it is not part of the public
# contract and never will be: the gateway does not call it, the app cannot reach
# it, and its shape is free to follow the tables it feeds.


class PublishForecastRequest(BaseModel):
    """Which lane, and which day of it."""

    #: The lane directory name — `dessem_free_v1__gate_late__thr5`. The lane is
    #: the addressable unit a forecast is served from, so the caller names one
    #: rather than passing three loose fields that could disagree.
    lane: str
    #: The civil day being forecast, in Brasília. Defaults to tomorrow, which is
    #: what the two gate jobs publish; a caller that wants another day says so.
    target_date: date | None = None


@app.post("/internal/publish/forecast", tags=["forecast"])
async def publish_forecast(
    request: Annotated[PublishForecastRequest, Body()],
) -> JSONResponse:
    """Compose one lane's day and hand the rows back. Writes nothing.

    Refuses rather than invents, in the four ways the spec distinguishes:

    - no promoted artifact — `MODEL_UNAVAILABLE`, 503, carrying which of the
      three lane states holds, which is what reaches a screen as its own
      sentence instead of a spinner;
    - no database — `DATA_UNAVAILABLE`, 503, because features come from
      Postgres and a publication built without them would be built from nothing;
    - no feature rows for the day — `FORECAST_UNAVAILABLE`, 404: the model is
      fine and the inputs are not, and the two are different repairs;
    - a lane name that is not one — `REQUEST_INVALID`, 422.

    None of them is an empty band.
    """
    try:
        lane = Lane.parse(request.lane)
    except LaneNameError as error:
        return _refusal(422, "REQUEST_INVALID", str(error))

    try:
        loaded = load_promoted(lane, root=settings.artifact_dir)
    except PublicationRefusedError as refusal:
        return _refusal(
            503,
            "MODEL_UNAVAILABLE",
            refusal.reason,
            {
                "lane": lane.directory_name,
                "lane_state": refusal.lane_state,
                # Beside the state, never folded into it: an unmounted volume
                # and an untrained lane are the same `no_artifact` and two
                # completely different repairs.
                "volume_mounted": refusal.volume_mounted,
            },
        )

    if database is None:
        return _refusal(
            503,
            "DATA_UNAVAILABLE",
            "this instance has no database configured, and a forecast is a "
            "function of feature rows that only Postgres holds",
        )

    target_date = request.target_date or serving_target_date(datetime.now(tz=UTC))
    pool = await database.connect()
    async with pool.acquire() as conn:
        rows = await read_serving_rows(
            conn,
            target_date=target_date,
            # The lane is the authority on all three. They are strings on it —
            # it is deliberately not pinned to a literal, since the feature
            # dictionary owns which sets exist — so the cast is at this edge and
            # the refusal for an unknown one comes from the database.
            gate_profile=cast(GateProfile, lane.gate_profile),
            feature_set=cast(FeatureSet, lane.feature_set),
            threshold_mw=lane.threshold_mw,
        )

    if not rows:
        return _refusal(
            404,
            "FORECAST_UNAVAILABLE",
            f"the feature function returned no row for "
            f"{target_date.isoformat()} in {lane.directory_name}; the model is "
            "promoted and its inputs are not there",
            {"lane": lane.directory_name, "target_date": target_date.isoformat()},
        )

    try:
        publication: ForecastPublication = build_publication(
            rows,
            lane=lane,
            loaded=loaded,
            target_date=target_date,
            # Said, not defaulted. This route is the serving path and the only
            # thing it may mint is a record; the counterfactual publication
            # instant belongs to the backtest, which does not come through here.
            origin_kind=SERVED_ORIGIN_KIND,
        )
    except PublicationError as error:
        # A 500 and not a 422: the caller asked for a well-formed thing and
        # the rows it was built from are the database's own. Something upstream
        # is wrong, and rounding that to "your request was bad" would send an
        # operator to the wrong place.
        logger.error("publish: %s", error)
        return _refusal(500, "INTERNAL", str(error))

    return JSONResponse(content=publication.as_payload())


# --- the flex optimizer's synchronous endpoint --------------------------------
#
# `docs/specs/flex-optimizer.md`: one HTTP request, no job id, no polling and no
# `OptimizationJob` noun. The research measured 3.15 ms at real size, 33.7 ms at
# ten batteries plus ten loads and 63.2 ms at 96 periods, so there is nothing a
# queue would buy — and Mitigate is a what-if tool, where a slider must move the
# chart.
#
# The handler below is a **`def`, not an `async def`**, and that is load-bearing
# rather than stylistic: FastAPI runs a sync handler on the threadpool, so a
# worst-case 2 s solve cannot block the event loop and stall every other
# in-flight request. `test_optimize_endpoint.py` asserts it is not a coroutine
# function, because "someone adds `async` while adding a field" is exactly the
# kind of change that looks harmless in a diff.


def profile_source() -> ProfileSource:
    """Which resolver serves the curtailment band this deployment plans against.

    A dependency rather than a module-level constant so that the resolver is one
    function, and so a test that needs a band can inject one, without either
    reaching into the other's module.

    A configured database means the published band is readable, so
    :func:`~wattsteer_ml.forecast_reads.served_profile_source` is what runs —
    that is flex-optimizer 07, and it is what turns the 404 that ticket 06
    shipped into a plan. With no database there is nothing to read, and
    :func:`~wattsteer_ml.optimizer.result.no_forecast_yet` still refuses: an
    instance that cannot reach Postgres has no forecast, and saying so is the
    only answer that is not invented.
    """
    if database is None:
        return no_forecast_yet
    return served_profile_source(database)


def _refusal(
    status: int, code: str, message: str, details: dict[str, Any] | None = None
) -> JSONResponse:
    """The error shape `ml-proxy.ts` reads the code out of.

    `{"error": {"code": …}}` where this service owns the shape. The gateway
    re-wraps it in its own envelope and admits the *code* into its closed enum
    rather than forwarding the body, so what has to survive the trip is this
    pair — the status and the identifier — and nothing else.
    """
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if details:
        body["error"]["details"] = details
    return JSONResponse(status_code=status, content=body)


def _refused_scenario(
    error: ScenarioTransportError | ScenarioValidationError,
) -> JSONResponse:
    """Every row of the refusal table is a 422 except the one that is not.

    `FORECAST_UNAVAILABLE` says the scenario was fine and there is nothing to
    plan against, so it is a 404: a 422 would tell the caller their request was
    malformed when it was not.
    """
    details = getattr(error, "details", None)
    status = 404 if error.code == "FORECAST_UNAVAILABLE" else 422
    return _refusal(status, error.code, str(error), details)


#: `SolverNotOptimalError.status` → the pair the caller reads. A `FEASIBLE`
#: result means the gap was not closed at the time limit, so the Avoidability
#: Score would be a lower bound, and there is no honest way to put a lower bound
#: in a box labelled with a percentage — hence a 503 and never a rendered
#: result. Everything not named here is a `SOLVER_BUG` (500), `INFEASIBLE`
#: included: the do-nothing dispatch satisfies every constraint, so the model is
#: feasible by construction for every scenario that passes validation, and
#: infeasibility can only mean validation let something through.
_SOLVER_FAILURES: dict[str, tuple[int, str]] = {
    "FEASIBLE": (503, "SOLVER_GAP_UNCLOSED"),
    "NOT_SOLVED": (504, "SOLVER_TIMEOUT"),
}


@app.post("/v1/optimize", tags=["optimizer"])
def optimize(
    scenario: Annotated[dict[str, Any], Body()],
    resolve: Annotated[ProfileSource, Depends(profile_source)],
) -> JSONResponse:
    """A `Scenario` in, an `OptimizationResult` out, inside one request.

    Gateway-only: `apps/api` validates, applies the rate limit, checks the cache
    and proxies, and this service is not publicly routable. It re-decodes and
    re-validates anyway — it trusts nothing it did not validate itself, and a
    hash it did not compute is a hash it cannot stand behind.
    """
    try:
        decoded = decode_scenario_body(scenario)
        validate_scenario(decoded.scenario, datetime.now(tz=UTC))
    except (ScenarioTransportError, ScenarioValidationError) as refusal:
        return _refused_scenario(refusal)

    wire = decoded.scenario
    origin = wire.get("forecast_origin")
    try:
        profile = resolve(
            subsystem=str(wire["subsystem"]),
            target_date=date.fromisoformat(str(wire["target_date"])),
            forecast_origin=origin if isinstance(origin, str) else None,
        )
    except ScenarioValidationError as refusal:
        return _refused_scenario(refusal)

    try:
        body = optimization_result(wire, decoded.hash, profile)
    except OptimizerBugError as bug:
        status = bug.status if isinstance(bug, SolverNotOptimalError) else None
        # The scenario hash, never the scenario: `label` is attacker-controlled,
        # and the hash is what makes the run reproducible from a bug report.
        logger.error(
            "optimize: %s for scenario %s",
            status or type(bug).__name__,
            decoded.hash,
        )
        mapped = _SOLVER_FAILURES.get(status) if status is not None else None
        if mapped is not None:
            return _refusal(mapped[0], mapped[1], str(bug))
        return _refusal(500, "SOLVER_BUG", str(bug), {"scenario_hash": decoded.hash})

    return JSONResponse(
        content=body,
        # Not a field on the body: `optimization-result.schema.json` is closed,
        # and the build is a property of *this deploy* rather than of the plan.
        # The gateway keys its cache on it, so a deploy that changes the
        # formulation cannot serve yesterday's plan under today's code.
        headers={"x-optimizer-build": OPTIMIZER_BUILD},
    )


# --- the replayable calendar ---------------------------------------------------
#
# `docs/specs/replay.md`, "The endpoint": `GET /v1/replay/days` returns the
# replayable calendar, **server-evaluated**. The gateway proxies it rather than
# computing it, and that is forced rather than chosen: the held-out assertion is
# made against the *artifact card*, the cards live on this service's volume, and
# `apps/api` has no volume. A gateway that fetched the windows and then judged
# them would be a second implementation of the predicate on the far side of a
# network hop, which is the shape this project keeps ruling out.
#
# Two routes. The calendar answers `200` with a verdict per day; the single-day
# route answers **at the failing clause's own status** — 422 for a date outside
# the window or before the first fold, 404 for a missing forecast or an
# unsettled day — because "never a computed answer with a caveat" is only a
# property when the refusal *is* the response.


async def _replay_calendar(
    subsystem: str, lane: Lane, window_from: date | None, window_to: date | None
) -> ReplayCalendar | JSONResponse:
    """One subsystem's calendar, or the refusal that stands in for it.

    Returns the calendar so both routes share one evaluation; the two of them
    then differ only in how much of it they render, which is what keeps the
    single-day answer from being a second predicate.
    """
    if database is None:
        return _refusal(
            503,
            "DATA_UNAVAILABLE",
            "this instance has no database configured, and a replayable "
            "calendar is a question about rows that only Postgres holds",
        )

    now = datetime.now(tz=UTC)
    latest = latest_replayable_date(now)
    rules = FOLD_CALENDAR_RULES
    start = window_from if window_from is not None else rules.window_start
    end = window_to if window_to is not None else latest
    if start > end:
        return _refusal(
            422,
            "REPLAY_DATE_OUT_OF_RANGE",
            f"the window {start.isoformat()}–{end.isoformat()} closes before it opens",
            {"from": start.isoformat(), "to": end.isoformat()},
        )

    pool = await database.connect()
    async with pool.acquire() as conn:
        evidence = await read_calendar_evidence(
            conn,
            subsystem=subsystem,
            lane=lane,
            window_start=start,
            window_end=end,
            as_of=now,
        )

    try:
        return build_calendar(
            evidence.days,
            subsystem=subsystem,
            lane=lane.directory_name,
            rules=rules,
            window_start=start,
            window_end=end,
            latest=latest,
            # Bound to the volume and to this lane, and taking an artifact id —
            # the one the *row* names. `artifacts.current` is not called here and
            # is imported by nothing under `wattsteer_ml.replay`: `replay.md`
            # story 5, a replay never consults the promoted serving artifact for
            # a historical day, so a retrain cannot turn an honest replay into
            # an in-sample one.
            windows_for=lambda artifact_id: read_windows(
                settings.artifact_dir, lane, artifact_id
            ),
            sources=evidence.sources,
        )
    except HoldoutLeakError as leak:
        # A `500`, and never a badge. The whole calendar fails rather than
        # carrying the leaking day as one refused entry among many, because an
        # entry in a list is exactly the label this spec refuses to ship.
        logger.error("replay: integrity violation — %s", leak)
        violation = integrity_violation(
            leak, subsystem=subsystem, lane=lane.directory_name
        )
        return _refusal(
            violation.status,
            violation.code,
            violation.message,
            dict(violation.details),
        )


def _replay_lane(lane: str) -> Lane | JSONResponse:
    try:
        return Lane.parse(lane)
    except LaneNameError as error:
        return _refusal(422, "REQUEST_INVALID", str(error))


@app.get("/v1/replay/days", tags=["replay"])
async def replay_days(
    subsystem: Annotated[Subsystem, Query(description="ONS subsystem code.")],
    lane: Annotated[
        str,
        Query(
            description=(
                "The artifact lane a replay is pinned to, e.g. "
                "dessem_free_v1__gate_late__thr5. Required and never defaulted: "
                "a post-go-live day has one candidate forecast per served lane "
                "and no rule yet says which one a replay is of."
            )
        ),
    ],
    window_from: Annotated[
        date | None,
        Query(alias="from", description="Window start. Defaults to the data window."),
    ] = None,
    window_to: Annotated[
        date | None,
        Query(alias="to", description="Window end. Defaults to yesterday, BRT."),
    ] = None,
) -> JSONResponse:
    """Which days of the window are replayable, and why the others are not.

    Every day in range is present with a verdict. The refused ones are the
    deliverable as much as the replayable ones: `replay.md` story 14 asks that
    an unreplayable date explain *why*, "so that the boundary is legible rather
    than arbitrary", and a calendar of only the good days makes the boundary
    something a client discovers by being told no.
    """
    parsed = _replay_lane(lane)
    if isinstance(parsed, JSONResponse):
        return parsed
    calendar = await _replay_calendar(subsystem, parsed, window_from, window_to)
    if isinstance(calendar, JSONResponse):
        return calendar
    return JSONResponse(content=calendar.as_payload())


@app.get("/v1/replay/days/{target_date}", tags=["replay"])
async def replay_day(
    target_date: date,
    subsystem: Annotated[Subsystem, Query(description="ONS subsystem code.")],
    lane: Annotated[str, Query(description="The artifact lane a replay is pinned to.")],
) -> JSONResponse:
    """One day, answered at the status of the clause that refused it.

    The four refusals of `replay.md`'s table, as statuses rather than as fields:
    `REPLAY_DATE_OUT_OF_RANGE` and `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW` are 422,
    `REPLAY_FORECAST_UNAVAILABLE` and `REPLAY_OBSERVATION_INCOMPLETE` are 404,
    and a failed held-out assertion is a 500 logged with the artifact id. None of
    them is a number with a caveat over it.
    """
    parsed = _replay_lane(lane)
    if isinstance(parsed, JSONResponse):
        return parsed
    calendar = await _replay_calendar(subsystem, parsed, target_date, target_date)
    if isinstance(calendar, JSONResponse):
        return calendar

    day = calendar.days[0]
    if day.refusal is None:
        return JSONResponse(content=day.as_payload())
    return _refusal(
        day.refusal.status,
        day.refusal.code,
        day.refusal.message,
        dict(day.refusal.details),
    )
