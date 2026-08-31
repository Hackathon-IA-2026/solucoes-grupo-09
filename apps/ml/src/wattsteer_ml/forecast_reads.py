"""The band the optimizer plans against, read back from what was published.

`apps/api/src/forecast/reads.ts` is the same read on the TypeScript side and
serves `/v1/forecast/day-ahead`; this module is the modelling side of the same
rows, and it exists because flex-optimizer 06 shipped
:func:`~wattsteer_ml.optimizer.result.no_forecast_yet` — a resolver that refuses
every real scenario — with the note that wiring it was ticket 07's job. Nothing
here computes a forecast. It reads one.

## Why this is a direct read and not a canonical-manifest one

`canonical_reads.py` serves the eight reads of ``CANONICAL_READS``, and
``canonical_forecast_hour`` is deliberately **not** among them. That is the
decision flex-optimizer 06 left open and this module settles: the ML side reads
the forecast views *directly*, through the same session axes and the same
read-only pool, and not through :func:`~wattsteer_ml.canonical_reads.read_fact`.
Three reasons, in the order they bite:

1. **The manifest is the modelling contract; these rows are WattSteer's own
   output.** Every canonical read names a fact WattSteer *ingested* — ONS
   curtailment, the weather run, the registry — and the manifest is what the
   forecaster is allowed to learn from. ``curtailment_forecast_hour`` is written
   *by* the forecaster. Admitting it to the manifest would put the model's own
   predictions inside the surface the model trains against, which is a shape no
   comment survives contact with.
2. **The manifest's vintage machinery does not describe these rows.**
   ``VintageFidelity`` there is a function of ``canonical_read_go_live`` — did
   WattSteer's ingestion exist yet when the fact was true. A ``served`` forecast
   row *is* a record of a publication, so it is ``point_in_time`` by
   construction, which is exactly how ``reads.ts`` derives it. A manifest entry
   would need a go-live row and a fidelity axis that mean nothing here.
3. **It is a cross-language contract with golden vectors behind it.**
   ``CANONICAL_READS`` is asserted member-for-member against
   ``packages/core/fixtures/canonical-contract/`` from both languages. Widening
   it is a change to that contract, and it would buy this module one helper.

What is **not** duplicated is the `AsOf` discipline. The axes are written by
:func:`~wattsteer_ml.canonical_reads.apply_axes`, the one function on this side
that writes them, so ``canonical_as_of()`` cannot go unset here any more than it
can on a manifest read — the views raise when it is missing rather than
defaulting to ``now()``.

## What the query is allowed to choose, and what it is not

``origin_kind = 'served'`` is a **constant in the SQL text**, not a parameter
with a default: `docs/specs/replay.md` seam 6 requires that a
``backfilled_holdout`` row is never reachable from a live route under any query,
and a filter a caller could widen is not that.

There is no quantile here either. All three envelopes are selected on every
read, because the plan is built on one and scored on three — and the planning
basis is a property of the product, decided in
:data:`~wattsteer_ml.optimizer.result.PLANNING_BASIS`, not of a call. No
argument, column or predicate in this file can select one.
"""

from __future__ import annotations

import functools
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

import anyio.from_thread
import asyncpg

from .canonical_reads import ReadAxes, apply_axes
from .database import Database
from .optimizer.horizon import HORIZON_HOURS
from .optimizer.result import PlanningProfile, ProfileSource
from .scenario_validation import ScenarioValidationError, forecast_unavailable

#: One statement, every value bound.
#:
#: ``chosen`` picks the origin first and the hours are joined to it, so the 24
#: rows returned are 24 rows of the **same** publication. Reading the day and
#: sorting afterwards would happily mix an early-gate hour into a late-gate day
#: on a day where one gate published a partial run, and the join is what makes
#: that unrepresentable rather than merely unlikely.
#:
#: When ``$3`` is null the latest publication wins — ``published_at desc``, then
#: ``gate_profile desc``, which is ``gate_late`` first because that is the enum's
#: declaration order reversed and ``gate_late`` is v1's primary. When ``$3`` is
#: an instant, only the publication at that instant is admissible: a scenario
#: pinned to an 00Z run must never be answered from the 12Z one, which is the
#: same reason the gateway keys its cache on the resolved origin.
PLANNING_PROFILE_SQL = """
with chosen as (
  select published_at, gate_profile
  from canonical_forecast_hour
  where subsystem = $1::subsystem_code
    and target_date = $2::date
    and origin_kind = 'served'::forecast_origin_kind
    and ($3::timestamptz is null or published_at = $3::timestamptz)
  order by published_at desc, gate_profile desc
  limit 1
)
select
  hour.local_hour,
  hour.threshold_mw,
  hour.p10_mwh,
  hour.p50_mwh,
  hour.p90_mwh,
  hour.published_at
from canonical_forecast_hour as hour
join chosen
  on hour.published_at = chosen.published_at
 and hour.gate_profile = chosen.gate_profile
where hour.subsystem = $1::subsystem_code
  and hour.target_date = $2::date
  and hour.origin_kind = 'served'::forecast_origin_kind
order by hour.local_hour
"""


def _refuse(
    subsystem: str, target_date: date, forecast_origin: str | None
) -> ScenarioValidationError:
    return forecast_unavailable(subsystem, target_date.isoformat(), forecast_origin)


def _pinned(raw: str | None) -> datetime | None:
    """Parse the scenario's pinned origin, or ``None`` for "the latest".

    Raises :class:`ValueError` on an instant it cannot read, and the caller turns
    that into ``FORECAST_UNAVAILABLE``. Falling back to "the latest" would be the
    one repair that must not happen here: a pinned scenario would then be
    answered from a *different* run than the one it names, with that run's origin
    stamped on the result, and the pin would be silently decorative.
    """
    if raw is None:
        return None
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _profile(
    rows: list[dict[str, Any]],
    *,
    subsystem: str,
    target_date: date,
    forecast_origin: str | None,
) -> PlanningProfile:
    """Twenty-four published hours into the band the optimizer plans against.

    **A partial day is an absence, not a short horizon.** A publication missing
    hours is refused with ``FORECAST_UNAVAILABLE`` rather than planned around:
    the alternatives are both worse than saying no — zero-filling the gaps would
    invent a forecast of "no curtailment" for the missing hours and quote a
    floor computed against it, and shortening the horizon would silently move
    every hour index after the gap. `docs/specs/api-surface.md`'s standing rule
    across all four no-forecast states is that an absence is never an empty
    band, and this is the modelling side of it.
    """
    if len(rows) != HORIZON_HOURS:
        raise _refuse(subsystem, target_date, forecast_origin)
    if [int(row["local_hour"]) for row in rows] != list(range(HORIZON_HOURS)):
        raise _refuse(subsystem, target_date, forecast_origin)

    thresholds = {float(row["threshold_mw"]) for row in rows}
    if len(thresholds) != 1:
        # The grain is stamped on every row precisely so a magnitude can be
        # compared with another one. Two grains inside one publication is not a
        # day this service can put a `threshold_mw` on.
        raise _refuse(subsystem, target_date, forecast_origin)

    return PlanningProfile(
        forecast_origin=rows[0]["published_at"].astimezone(UTC),
        # A `served` row is a record of a real publication, so its fidelity is
        # `point_in_time` by construction — `docs/specs/replay.md` makes
        # `served + revision_optimistic` impossible by definition, and
        # `reads.ts` derives it from the origin kind on the other side of the
        # wire for the same reason. Not a stored fourth column: there would be
        # nothing to write a second value into.
        vintage_fidelity="point_in_time",
        p10_mwh=tuple(float(row["p10_mwh"]) for row in rows),
        p50_mwh=tuple(float(row["p50_mwh"]) for row in rows),
        p90_mwh=tuple(float(row["p90_mwh"]) for row in rows),
        threshold_mw=thresholds.pop(),
    )


async def read_planning_profile(
    conn: asyncpg.Connection[Any],
    *,
    subsystem: str,
    target_date: date,
    forecast_origin: str | None,
    as_of: datetime,
) -> PlanningProfile:
    """The published band for one subsystem-day, resolved at one vintage cut.

    Raises the ``FORECAST_UNAVAILABLE`` refusal — a 404 and not a 422 — when no
    complete publication answers. That is the one row of the refusal table that
    is not a statement about the scenario: the fleet is real and the day is
    planable, and there is nothing to plan against.

    Opens its own transaction so the axes cannot outlive it, exactly as
    :func:`~wattsteer_ml.canonical_reads.read_fact` does. The pool is already
    read-only, so this transaction is too.
    """
    try:
        pinned = _pinned(forecast_origin)
    except ValueError:
        raise _refuse(subsystem, target_date, forecast_origin) from None

    async with conn.transaction():
        await apply_axes(conn, ReadAxes(as_of=as_of))
        records = await conn.fetch(PLANNING_PROFILE_SQL, subsystem, target_date, pinned)
    return _profile(
        [dict(record) for record in records],
        subsystem=subsystem,
        target_date=target_date,
        forecast_origin=forecast_origin,
    )


def served_profile_source(
    db: Database, *, now: Callable[[], datetime] | None = None
) -> ProfileSource:
    """The resolver `POST /v1/optimize` runs with when a database is configured.

    **The bridge is the interesting part.** ``/v1/optimize`` is a ``def`` and
    not an ``async def``, deliberately: FastAPI runs a sync handler on the
    threadpool, so a worst-case two-second branch-and-bound cannot stall the
    event loop and every other in-flight request with it. That is asserted by
    ``test_optimize_endpoint.py`` and it is not negotiable — which leaves this
    module needing to await asyncpg from a worker thread.

    :func:`anyio.from_thread.run` is exactly that: Starlette starts the worker
    through ``anyio.to_thread.run_sync``, so the thread carries a token back to
    the loop it came from, and the coroutine runs *there* while this thread
    blocks. The alternatives were both worse. A second, synchronous driver would
    be a second connection pool with its own read-only story to get right. An
    ``async`` dependency resolving the profile before the handler would reorder
    the refusal table — a malformed scenario for a day with no forecast would
    answer 404 instead of 422, and the codes would stop meaning what the table
    says they mean.

    One consequence worth writing down: the coroutine runs on **the loop the
    pool was created on**, because an asyncpg pool's connections belong to their
    loop. Under uvicorn that is the process's one loop and there is nothing to
    think about. A caller that drives this app through a fresh event loop per
    request — ``TestClient(app)`` used without its context manager does exactly
    that — will hand the second request a connection whose loop has gone, and
    the symptom is asyncpg's ``another operation is in progress`` rather than
    anything that names the cause. Enter the client as a context manager.

    ``as_of`` is the request instant and is read per call, never captured: a
    resolver holding the instant it was constructed at would serve a vintage cut
    from process start-up and silently stop seeing new publications.
    """
    clock: Callable[[], datetime] = now or functools.partial(datetime.now, UTC)

    def resolve(
        *, subsystem: str, target_date: date, forecast_origin: str | None
    ) -> PlanningProfile:
        async def read() -> PlanningProfile:
            pool = await db.connect()
            async with pool.acquire() as conn:
                return await read_planning_profile(
                    conn,
                    subsystem=subsystem,
                    target_date=target_date,
                    forecast_origin=forecast_origin,
                    as_of=clock(),
                )

        return anyio.from_thread.run(read)

    return resolve
