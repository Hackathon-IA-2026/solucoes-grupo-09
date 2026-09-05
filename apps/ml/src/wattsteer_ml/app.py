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
  POST /internal/replay/featured-days  worker-only; the nightly shortlist
  GET /v1/model/card          the promoted artifact's card, verbatim, off the volume

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
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal, cast

from fastapi import Body, Depends, FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import __version__, artifacts
from .artifacts import CARD_SUFFIX
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
    resolve_artifact,
)
from .replay.calendar import (
    ReplayCalendar,
    ReplayDay,
    build_calendar,
    integrity_violation,
    latest_replayable_date,
    resolve_day,
)
from .replay.cards import ArtifactWindows, read_windows
from .replay.featured import FeaturedRuleError
from .replay.inputs import ReplayInputs, ReplayInputSource, replay_input_source
from .replay.reads import read_calendar_evidence
from .replay.result import observed_only_result, replay_result
from .replay.scoring import score_observed_only, score_replay
from .replay.shortlist import (
    FeaturedDaysCache,
    pending_payload,
    recompute_featured_days,
)
from .scenario import (
    DecodedScenario,
    ScenarioTransportError,
    decode_scenario_body,
)
from .scenario_validation import (
    ScenarioValidationError,
    replay_target_date,
    validate_scenario,
)
from .training import CORRECTION_REGIME, contract_fault, read_card

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


def _solver_failure(bug: OptimizerBugError, scenario_hash: str) -> JSONResponse:
    """The solver's failure, mapped once for every route that runs a solve.

    A function rather than a block inside `/v1/optimize` because a replay runs
    the *same* MILP through the *same* builder, and two mappings of one table
    would eventually disagree about which of these is a `503` — at which point
    the same failure would be a retryable degradation on one screen and a bug
    report on the other.
    """
    status = bug.status if isinstance(bug, SolverNotOptimalError) else None
    # The scenario hash, never the scenario: `label` is attacker-controlled, and
    # the hash is what makes the run reproducible from a bug report.
    logger.error("solve: %s for scenario %s", status or type(bug).__name__, scenario_hash)
    mapped = _SOLVER_FAILURES.get(status) if status is not None else None
    if mapped is not None:
        return _refusal(mapped[0], mapped[1], str(bug))
    return _refusal(500, "SOLVER_BUG", str(bug), {"scenario_hash": scenario_hash})


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
        return _solver_failure(bug, decoded.hash)

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
    # The calendar and the shortlist travel together, per `replay.md`'s endpoint
    # table: opening the Time Machine is one request, and a second round trip
    # for the featured days would let a client render the calendar without them.
    payload = calendar.as_payload()
    payload["featured"] = _featured_payload(subsystem, parsed)
    return JSONResponse(content=payload)


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


# --- the model card -----------------------------------------------------------
#
# `docs/specs/api-surface.md` §9: `GET /v1/model/card` is the Explain screen's
# second call, and it is separate from the diagnosis on the forecaster's own
# grounds — the reliability curve is a property of the *model*, not of a day.
#
# It is here for the reason `/v1/replay/days` is here and `/v1/forecast/day-ahead`
# is not: **the card is a file on this service's volume**, and the gateway has no
# volume. What the gateway owns is the public surface — the product-facing
# subset, the ETag, the cache directive and the error envelope. What this route
# owes it is the document, whole, plus the one fact the document does not carry
# about itself: which correction regime produced the band it describes.
#
# It reads the card and **does not load the bundle**. `load_promoted` would
# joblib-load six boosters to answer a metadata question; `resolve_artifact` plus
# `read_card` answers it off one file read, and is the same pair
# `wattsteer_ml.replay.cards` already uses to assert the held-out property.
# The one check that comes with the bundle load and is kept anyway is
# `contract_fault`: an artifact marked invalid on its own card is one this lane
# may not serve, and publishing its numbers as a serving model's would describe
# a model nothing is allowed to run.


@app.get("/v1/model/card", tags=["model"])
def model_card(
    lane: Annotated[
        str,
        Query(
            description=(
                "The artifact lane, e.g. dessem_free_v1__gate_late__thr5. "
                "Required and never defaulted: a card is a property of one "
                "lane's promoted artifact, and nothing here picks a lane."
            )
        ),
    ],
) -> JSONResponse:
    """The promoted artifact's card, verbatim, or the refusal that says why not.

    Three refusals, and none of them is a card with empty groups:

    - a lane name that is not one — `REQUEST_INVALID`, 422;
    - nothing promoted, or a volume that cannot say — `MODEL_UNAVAILABLE`, 503,
      carrying the lane state and the mount beside it, exactly as
      `/internal/publish/forecast` does, because "the volume did not mount" and
      "nobody has trained this lane" are two different repairs;
    - a card marked invalid by the hot-swap gate's contract check, or one that
      cannot be read at all — `MODEL_UNAVAILABLE`, 503, `unresolvable`. A card
      the loader would refuse is not a serving model's card.
    """
    try:
        parsed = Lane.parse(lane)
    except LaneNameError as error:
        return _refusal(422, "REQUEST_INVALID", str(error))

    try:
        artifact_id = resolve_artifact(parsed)
    except PublicationRefusedError as refusal:
        return _refusal(
            503,
            "MODEL_UNAVAILABLE",
            refusal.reason,
            {
                "lane": parsed.directory_name,
                "lane_state": refusal.lane_state,
                "volume_mounted": refusal.volume_mounted,
            },
        )

    card_path = (
        settings.artifact_dir / parsed.directory_name / f"{artifact_id}{CARD_SUFFIX}"
    )
    try:
        card = read_card(card_path)
    # `BundleError` is the missing or non-object card; a `JSONDecodeError` is a
    # truncated one, and both are `ValueError`. `OSError` is a volume that went
    # away between the promotion log and this read. All three are the same
    # answer — the lane cannot say what it is serving — and none of them is a
    # partially parsed card.
    except (ValueError, OSError) as error:
        return _refusal(
            503,
            "MODEL_UNAVAILABLE",
            str(error),
            {
                "lane": parsed.directory_name,
                "lane_state": "unresolvable",
                "volume_mounted": True,
            },
        )

    fault = contract_fault(card)
    if fault is not None:
        return _refusal(
            503,
            "MODEL_UNAVAILABLE",
            f"{artifact_id} is marked invalid on its own card: {fault}",
            {
                "lane": parsed.directory_name,
                "lane_state": "unresolvable",
                "volume_mounted": True,
                "contract_fault": fault,
            },
        )

    return JSONResponse(
        content={
            "lane": parsed.directory_name,
            "artifact_id": artifact_id,
            # The card describes the correction; it does not name the rule that
            # applied it. `correction_regime` is stamped on every published
            # forecast row, and it belongs beside the card's own
            # `upper_correction_realised` — the pair is what makes a short
            # `coverage_p90` legible as under-*application* rather than as a bad
            # fit. Read from the constant, never retyped.
            "correction_regime": CORRECTION_REGIME,
            "card": card,
        }
    )


# --- one replay ----------------------------------------------------------------
#
# `docs/specs/replay.md`, "The endpoint": a replay answers **inside one HTTP
# request**, over exactly the same scenario transport as Mitigate. A `Replay` is
# a `Scenario` with a past `target_date`, so there is no second blob format, no
# job id and nothing to poll for — and the gateway's `GET ?d=&s=` and `POST`
# forms both arrive here as one `POST`, on the identical canonical bytes.
#
# **No model is in this path.** No joblib load, no feature build, no forecast
# call: `read_replay_inputs` is a lookup of rows replay 01 persisted. What runs
# is two MILP solves — the plan at the gate and the fenced perfect-foresight
# bound — and five simulator passes, which is why the handler below is a `def`
# and not an `async def`, exactly as `/v1/optimize` is: FastAPI runs a sync
# handler on the threadpool, so the solve cannot stall the event loop.
#
# **The lane is required and never defaulted**, for the reason `/v1/replay/days`
# requires it: post-go-live a day has one candidate forecast per served lane and
# no rule yet says which one a replay is *of*. A default here would answer a
# question nobody has asked, inside a query string.


def replay_inputs_source() -> ReplayInputSource | None:
    """The reader this deployment answers replays with, or nothing.

    A dependency rather than a module-level constant so a test can inject rows
    without a Postgres, and `None` with no database configured — an instance
    that cannot reach the rows has no replay, and saying so is the only answer
    that is not invented.
    """
    if database is None:
        return None
    return replay_input_source(database)


def _replay_scenario(scenario: dict[str, Any]) -> DecodedScenario | JSONResponse:
    """The scenario, decoded and validated — the whole table minus its date clause.

    `replay.md` seam 10 states the parity claim and its one exception in the
    same breath, because the two endpoints cannot agree about the date and an
    implementation that made them agree would be wrong about one of them. Every
    other rule is the identical function call `/v1/optimize` makes, so a blob
    refused by one is refused by the other with the same code.
    """
    try:
        decoded = decode_scenario_body(scenario)
        validate_scenario(
            decoded.scenario, datetime.now(tz=UTC), target_date=replay_target_date
        )
    except (ScenarioTransportError, ScenarioValidationError) as refusal:
        return _refused_scenario(refusal)
    return decoded


@dataclass(frozen=True)
class _ResolvedReplay:
    """A decoded scenario, the day's evidence and the verdict on it."""

    decoded: DecodedScenario
    lane: Lane
    day: ReplayDay
    windows: ArtifactWindows | None
    inputs: ReplayInputs


def _resolve_replay(
    scenario: dict[str, Any], lane: str, read: ReplayInputSource | None
) -> _ResolvedReplay | JSONResponse:
    """Everything both replay routes do before they differ.

    Decode, validate, parse the lane, read the day at one vintage cut, and judge
    it against the replayable predicate — the *same* predicate `/v1/replay/days`
    publishes, called rather than restated, so a day the calendar calls
    replayable is a day this route can answer and a day it refuses is refused
    here with the same code.
    """
    parsed_lane = _replay_lane(lane)
    if isinstance(parsed_lane, JSONResponse):
        return parsed_lane
    decoded = _replay_scenario(scenario)
    if isinstance(decoded, JSONResponse):
        return decoded
    if read is None:
        return _refusal(
            503,
            "DATA_UNAVAILABLE",
            "this instance has no database configured, and a replay is a pure "
            "function of rows that only Postgres holds",
        )

    wire = decoded.scenario
    subsystem = str(wire["subsystem"])
    target_date = date.fromisoformat(str(wire["target_date"]))
    origin = wire.get("forecast_origin")
    inputs = read(
        subsystem=subsystem,
        target_date=target_date,
        lane=parsed_lane,
        forecast_origin=origin if isinstance(origin, str) else None,
    )

    artifact_id = inputs.evidence.artifact_id
    windows = (
        None
        if artifact_id is None
        else read_windows(settings.artifact_dir, parsed_lane, artifact_id)
    )
    try:
        day = resolve_day(
            inputs.evidence,
            subsystem=subsystem,
            lane=parsed_lane.directory_name,
            rules=FOLD_CALENDAR_RULES,
            latest=latest_replayable_date(datetime.now(tz=UTC)),
            windows=windows,
            sources=inputs.sources,
        )
    except HoldoutLeakError as leak:
        # A `500`, and never a badge over a number. The artifact that lied is in
        # the message, because an operator with only the date has no way to find
        # the card.
        logger.error("replay: integrity violation — %s", leak)
        violation = integrity_violation(
            leak, subsystem=subsystem, lane=parsed_lane.directory_name
        )
        return _refusal(
            violation.status, violation.code, violation.message, dict(violation.details)
        )
    return _ResolvedReplay(
        decoded=decoded, lane=parsed_lane, day=day, windows=windows, inputs=inputs
    )


#: The lane, spelled once for both replay routes' OpenAPI.
_REPLAY_LANE_QUERY = Query(
    description=(
        "The artifact lane the replay is pinned to, e.g. "
        "dessem_free_v1__gate_late__thr5. Required and never defaulted."
    )
)


@app.post("/v1/replay", tags=["replay"])
def replay(
    scenario: Annotated[dict[str, Any], Body()],
    lane: Annotated[str, _REPLAY_LANE_QUERY],
    read: Annotated[ReplayInputSource | None, Depends(replay_inputs_source)],
) -> JSONResponse:
    """One replayed day: planned at the gate, scored on what happened.

    Gateway-only, like `/v1/optimize`: `apps/api` validates, meters the solve
    tier, checks the cache and proxies. This service re-decodes and re-validates
    anyway — it trusts nothing it did not validate itself, and a hash it did not
    compute is a hash it cannot stand behind.

    Every refusal is the typed code of the clause that failed, at that clause's
    own status, and never a computed answer with a caveat over it. A pre-F1 day
    is refused with `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW`; what those days get
    instead is `POST /v1/replay/observed-only`, which carries no WattSteer
    number at all.
    """
    resolved = _resolve_replay(scenario, lane, read)
    if isinstance(resolved, JSONResponse):
        return resolved
    day, inputs = resolved.day, resolved.inputs
    if day.refusal is not None:
        return _refusal(
            day.refusal.status,
            day.refusal.code,
            day.refusal.message,
            dict(day.refusal.details),
        )

    # Unreachable through the predicate — a replayable day has a resolved
    # artifact and twenty-four settled hours — but reachable through a
    # disagreement between the two counts, and a disagreement is an absence
    # rather than a number to publish.
    if resolved.windows is None or inputs.forecast is None:
        return _refusal(
            404,
            "REPLAY_FORECAST_UNAVAILABLE",
            f"no complete pinned publication answers {day.target_date.isoformat()}",
        )
    if inputs.observed is None:
        return _refusal(
            404,
            "REPLAY_OBSERVATION_INCOMPLETE",
            f"the settled hours of {day.target_date.isoformat()} do not form a "
            "whole local day, which is the denominator of every figure here",
        )

    wire = resolved.decoded.scenario
    try:
        scores = score_replay(
            wire,
            day=day,
            windows=resolved.windows,
            forecast=inputs.forecast,
            observed=inputs.observed,
        )
        body = replay_result(
            wire, resolved.decoded.hash, scores, episodes=list(inputs.episodes)
        )
    except HoldoutLeakError as leak:
        logger.error("replay: integrity violation — %s", leak)
        violation = integrity_violation(
            leak, subsystem=inputs.forecast.subsystem, lane=resolved.lane.directory_name
        )
        return _refusal(violation.status, violation.code, violation.message)
    except OptimizerBugError as bug:
        return _solver_failure(bug, resolved.decoded.hash)

    return JSONResponse(
        content=body,
        # The build that actually solved, so the gateway's cache key cannot name
        # a formulation that did not produce the plan it is storing.
        headers={"x-optimizer-build": OPTIMIZER_BUILD},
    )


@app.post("/v1/replay/observed-only", tags=["replay"])
def replay_observed_only(
    scenario: Annotated[dict[str, Any], Body()],
    lane: Annotated[str, _REPLAY_LANE_QUERY],
    read: Annotated[ReplayInputSource | None, Depends(replay_inputs_source)],
) -> JSONResponse:
    """A pre-F1 day: what happened, and the bound. Nothing of WattSteer's.

    Every artifact was fitted on the days before F1's test period, so no honest
    counterfactual exists for them and `replay.md` refuses rather than labels.
    This is the view it offers instead, and it is a **separate route** rather
    than a mode of the one above for exactly that reason: `/v1/replay` answers
    "what would WattSteer have done", and on these days the honest answer is a
    422 rather than a screen with `scored`, `avoided_energy_mwh` and
    `recovered_floor_mwh` zeroed. Here those three are *absent*, and absent
    structurally — `ObservedOnlyView` holds no plan, no scored realisation and
    no floor for them to be read from.

    Refused with the day's own code for any day that is not pre-F1: a date out
    of range has no settled day, and a missing forecast or an unsettled day is a
    gap rather than a decision. None of them is a screen.
    """
    resolved = _resolve_replay(scenario, lane, read)
    if isinstance(resolved, JSONResponse):
        return resolved
    day, inputs = resolved.day, resolved.inputs
    refusal = day.refusal
    if refusal is None:
        return _refusal(
            422,
            "REQUEST_INVALID",
            f"{day.target_date.isoformat()} is replayable against an artifact "
            "that did not see it, so the observed-only view is not what it "
            "gets; ask /v1/replay",
        )
    if refusal.details.get("observed_only") is not True:
        return _refusal(
            refusal.status, refusal.code, refusal.message, dict(refusal.details)
        )
    if inputs.observed is None:
        return _refusal(
            404,
            "REPLAY_OBSERVATION_INCOMPLETE",
            f"the settled hours of {day.target_date.isoformat()} do not form a "
            "whole local day",
        )

    wire = resolved.decoded.scenario
    try:
        view = score_observed_only(
            wire, day=day, observed=inputs.observed, threshold_mw=inputs.threshold_mw
        )
        body = observed_only_result(
            wire, resolved.decoded.hash, view, episodes=list(inputs.episodes)
        )
    except OptimizerBugError as bug:
        return _solver_failure(bug, resolved.decoded.hash)

    return JSONResponse(content=body, headers={"x-optimizer-build": OPTIMIZER_BUILD})


# --- the featured days ---------------------------------------------------------
#
# `docs/specs/replay.md`, "The shortlist is a query, not a list": the Time
# Machine opens on eight days chosen by a published deterministic rule, one of
# which is — mandatorily — a day WattSteer got wrong. The rule lives in
# `wattsteer_ml.replay.featured` and travels *on the response*, so the sentence
# the screen renders and the sentence that ran are one string.
#
# **The list is computed nightly and never on the request path.** A recompute
# replays every replayable day against the published `REFERENCE_FLEET` — 24.4 ms
# each, measured, ~13 s over the 521 days currently replayable — and the
# gateway's ML timeout is five seconds. So `GET /v1/replay/days` serves the
# cache, `POST /internal/replay/featured-days` fills it, and a miss is published
# as `pending` with the rule still attached rather than as an empty list that
# would read as "the rule found nothing interesting".
#
# The cache is process-local because this service is read-only against Postgres
# and a shortlist is derived rather than recorded: it is evictable at any time
# with no user-visible loss beyond a recompute, which is the optimizer's own
# standard for what may be cached.

#: This instance's copy of the nightly answer, keyed by (subsystem, lane).
featured_days_cache = FeaturedDaysCache()


def _featured_payload(subsystem: str, lane: Lane) -> dict[str, object]:
    """The shortlist as the calendar publishes it, or a stated absence."""
    computed = featured_days_cache.get(subsystem, lane)
    if computed is None:
        return pending_payload(
            "the featured-days rule has not been run on this instance yet; "
            "the nightly refresh-featured-days job computes it"
        )
    return computed.as_payload()


class RefreshFeaturedDaysRequest(BaseModel):
    """Which subsystem's shortlist, and against which lane."""

    #: ONS subsystem code. One shortlist per subsystem: the days that were
    #: interesting in the Northeast are not the days that were interesting in
    #: the South, and a national list would be a fifth subsystem.
    subsystem: Subsystem
    #: The lane directory name. Required and never defaulted, for the reason
    #: both replay routes require it: a post-go-live day has one candidate
    #: forecast per served lane and no rule yet says which one a replay is of.
    lane: str


@app.post("/internal/replay/featured-days", tags=["replay"])
async def refresh_featured_days(
    request: Annotated[RefreshFeaturedDaysRequest, Body()],
) -> JSONResponse:
    """Run the featured-days rule and cache the answer. Writes nothing.

    What `api-surface.md`'s `refresh-featured-days` job (`30 3 * * *`) calls.
    It is `/internal` for the reason `/internal/publish/forecast` is: the
    gateway does not call it, the app cannot reach it, and the worker is the
    only client. The body it hands back is the same block `GET /v1/replay/days`
    publishes under `featured`, so the job can log the `computation_id` — which
    is also the weak ETag that spec puts on the calendar — and keep nothing.

    Every day of the window is replayed against `REFERENCE_FLEET` by the same
    reader and the same scorer `POST /v1/replay` runs, so a featured day's floor
    margin is the number the replay screen shows for that day rather than a
    second derivation of it.
    """
    parsed = _replay_lane(request.lane)
    if isinstance(parsed, JSONResponse):
        return parsed
    if database is None:
        return _refusal(
            503,
            "DATA_UNAVAILABLE",
            "this instance has no database configured, and the featured days "
            "are a query over rows that only Postgres holds",
        )

    now = datetime.now(tz=UTC)
    pool = await database.connect()
    try:
        async with pool.acquire() as conn:
            computed = await recompute_featured_days(
                conn,
                subsystem=request.subsystem,
                lane=parsed,
                rules=FOLD_CALENDAR_RULES,
                # The artifact id the *row* names, exactly as the calendar does.
                # `artifacts.current` is not reachable from here either: a
                # shortlist resolved against the promoted artifact would go
                # in-sample the first time a retrain extended its window over a
                # featured day.
                windows_for=lambda artifact_id: read_windows(
                    settings.artifact_dir, parsed, artifact_id
                ),
                as_of=now,
            )
    except HoldoutLeakError as leak:
        # A `500`, and never a shortlist with the leaking day quietly dropped:
        # a list that silently skipped days would be selectable on outcome by
        # anyone who could arrange for a card to look wrong.
        logger.error("replay: integrity violation building the shortlist — %s", leak)
        violation = integrity_violation(
            leak, subsystem=request.subsystem, lane=parsed.directory_name
        )
        return _refusal(
            violation.status, violation.code, violation.message, dict(violation.details)
        )
    except FeaturedRuleError as empty:
        return _refusal(
            404,
            "REPLAY_FORECAST_UNAVAILABLE",
            str(empty),
            {"subsystem": request.subsystem, "lane": parsed.directory_name},
        )

    featured_days_cache.put(computed)
    return JSONResponse(content=computed.as_payload(now))
