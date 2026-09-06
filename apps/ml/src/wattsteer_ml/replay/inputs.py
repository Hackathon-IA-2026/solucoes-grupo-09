"""Everything one replayed day needs from Postgres, in one transaction.

:mod:`wattsteer_ml.replay.reads` answers *which days*; this module answers
*this day*. The split is the same one the package is built along — the calendar
is a window-wide question and a replay is a day-wide one — and the two share
nothing but the axes discipline, which is
:func:`~wattsteer_ml.canonical_reads.apply_axes` in both.

## Why one transaction, and why that is the whole point of the module

A replay is a pure function of three reads: the **pinned** forecast rows, the
**settled** hours, and the episodes drawn over those same hours. `replay.md`
makes reproducibility the product claim — "a link I shared does not silently
re-mean itself" — and reproducibility is a property of the *cut*, not of the
statements. Three transactions would resolve ``AsOf`` three times, so a backtest
run landing between the first and the second would pair one publication's band
with another's provenance and the result would still look like a replay. Four
statements, one transaction, one ``as_of`` written once.

The episodes are read *after* the threshold is known and inside the same
transaction, because the threshold is a property of the publication being
replayed and an episode drawn at another one cannot be rendered beside it —
:func:`~wattsteer_ml.replay.result.replay_result` refuses exactly that pairing.

## What the pin is

The scenario's ``forecast_origin``. When it is present only that publication is
admissible; when it is absent the resolution rule applies — **a record outranks
a reconstruction**, then the newest publication — and the origin that answered
is echoed on the result so a shared link can pin it. That echo is what makes the
link honest: at the pinned origin the numbers are reproducible forever, and at
the unpinned one they may legitimately move because a later backtest run
supersedes the ``backfilled_holdout`` rows.

Falling back to "the latest" for a pin that resolves nothing is the one repair
this module must never make — :mod:`wattsteer_ml.forecast_reads` says the same
thing for the same reason — so a pinned origin with no rows is
``REPLAY_FORECAST_UNAVAILABLE``, not somebody else's forecast.

**What a pin cannot do, stated because the spec assumes it can.** `replay.md`
seam 7 wants a replay recomputed *at the pinned origin* after a fresh backtest
to be byte-identical. A ``forecast_origin`` cannot deliver that, and the reason
is the schema rather than this module: a ``backfilled_holdout`` row's
``published_at`` **is** ``gate_at(target_date, gate_profile)`` — seam 6 requires
precisely that — so two backtest runs of one day carry the *same* publication
instant, and ``curtailment_forecast_hour``'s business key discriminates them by
``data_version``. A rerun is therefore a new **vintage of one publication**, and
``canonical_forecast_hour``'s ``distinct on`` makes the older one invisible at
any cut after the newer ingest. A pin names a publication; the axis that names a
vintage is ``AsOf``. ``test_database_replay_reads.py`` asserts this as the fact
it is, and closing the gap means a pin that can name the *run* — which is a
change to the shared scenario transport and not a change here.

## The day-grain figures are read, never summed

``day_total`` and ``peak_power`` come from ``canonical_forecast_day``, the
companion row the path ensemble wrote. `replay.md` forbids reconstructing a day
band by summing the hourly one — quantiles do not add — and the shape of this
read is where that prohibition is cheapest to hold: there is no query here that
could produce the summed version.
"""

from __future__ import annotations

import functools
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import anyio.from_thread
import asyncpg

from wattsteer_ml.canonical import VintageSource
from wattsteer_ml.canonical_reads import ReadAxes, apply_axes
from wattsteer_ml.constants import MAX_GAP_HOURS
from wattsteer_ml.database import Database
from wattsteer_ml.evaluation.vintage import earliest_valid_instant
from wattsteer_ml.lanes import Lane
from wattsteer_ml.mixture import QuantileBand
from wattsteer_ml.replay.calendar import HOURS_PER_DAY, DayEvidence
from wattsteer_ml.replay.reads import (
    OBSERVED_HOURS_SQL,
    PUBLISHED_DAYS_SQL,
    assemble,
    read_vintage_sources,
)
from wattsteer_ml.replay.result import ReplayEpisode
from wattsteer_ml.replay.scoring import (
    NO_OBSERVED_DATA_VERSION,
    ForecastHour,
    ObservedDay,
    PinnedForecast,
    PinnedOrigin,
)

#: The publication a replay is *of*, and the twenty-four rows it published.
#:
#: ``chosen`` picks the origin and the hours join onto it, so the rows returned
#: are twenty-four rows of the **same** publication — the shape
#: :data:`wattsteer_ml.forecast_reads.PLANNING_PROFILE_SQL` uses, for the same
#: reason: reading the day and sorting afterwards would happily mix an early-gate
#: hour into a late-gate day.
#:
#: Unlike that statement, ``origin_kind`` is **not** pinned to ``served`` here.
#: This is the one surface where a reconstruction is the intended answer, and the
#: ordering is the rule rather than the accident: a record outranks a
#: reconstruction, then the newest publication wins.
PINNED_FORECAST_HOURS_SQL = """
with chosen as (
  select published_at, gate_profile, origin_kind
  from canonical_forecast_hour
  where subsystem = $1::subsystem_code
    and target_date = $2::date
    and feature_set = $3
    and gate_profile = $4::forecast_gate_profile
    and threshold_mw = $5::double precision
    and ($6::timestamptz is null or published_at = $6::timestamptz)
  order by (origin_kind = 'served'::forecast_origin_kind) desc,
           published_at desc, data_version desc
  limit 1
)
select
  hour.local_hour,
  hour.threshold_mw,
  hour.p10_mwh,
  hour.p50_mwh,
  hour.p90_mwh,
  hour.expected_mwh,
  hour.occurrence_probability,
  hour.published_at,
  hour.origin_kind::text as origin_kind,
  hour.gate_profile::text as gate_profile,
  hour.forecast_producer::text as forecast_producer,
  hour.run_label
from canonical_forecast_hour as hour
join chosen
  on hour.published_at = chosen.published_at
 and hour.gate_profile = chosen.gate_profile
 and hour.origin_kind = chosen.origin_kind
where hour.subsystem = $1::subsystem_code
  and hour.target_date = $2::date
  and hour.feature_set = $3
  and hour.threshold_mw = $5::double precision
order by hour.local_hour
"""

#: The day-grain companion of the publication the hours came from.
#:
#: Bound to the resolved ``(published_at, gate_profile, origin_kind)`` rather
#: than re-resolved, so the day band and the hourly band are two halves of one
#: publication by construction. A second ``order by … limit 1`` here would be a
#: second resolution, and the two could disagree on a day holding both kinds.
PINNED_FORECAST_DAY_SQL = """
select
  day_total_p10_mwh,
  day_total_p50_mwh,
  day_total_p90_mwh,
  peak_power_p10_mw,
  peak_power_p50_mw,
  peak_power_p90_mw,
  day_occurrence_probability
from canonical_forecast_day
where subsystem = $1::subsystem_code
  and target_date = $2::date
  and feature_set = $3
  and gate_profile = $4::forecast_gate_profile
  and threshold_mw = $5::double precision
  and origin_kind = $6::forecast_origin_kind
  and published_at = $7::timestamptz
"""

#: ``a[t]`` — the settled day, at subsystem grain, by local hour, and its
#: vintage.
#:
#: ``sum`` over the reporting entities of the subsystem, grouped by the hour: the
#: view is at reporting-entity grain and a subsystem's curtailment in an hour is
#: the sum of what its entities were instructed not to generate. The local hour
#: is computed the same way ``target_date`` was written — the
#: ``America/Sao_Paulo`` civil day — so hour ``t`` here is hour ``t`` of the
#: forecast rows.
#:
#: ``max(data_version)`` is selected beside the sum because this half of a
#: replay is the half that can still move: ONS restates history in place and the
#: view resolves ``AsOf`` rather than freezing a vintage, so without the version
#: the read returns numbers that name no record. It is the same quantity
#: `api-surface.md`'s `/v1/curtailment/*` row validates on, asked here at day
#: grain — one aggregate over rows already being scanned, and not a second
#: query.
OBSERVED_DAY_SQL = """
select
  extract(hour from (valid_time at time zone 'America/Sao_Paulo'))::int as local_hour,
  sum(constrained_off_mwh)::double precision as constrained_off_mwh,
  max(data_version)::bigint as data_version
from canonical_curtailment_by_reporting_entity
where subsystem = $1::subsystem_code
  and (valid_time at time zone 'America/Sao_Paulo')::date = $2::date
group by 1
order by 1
"""

_ONE_DAY = timedelta(days=1)

#: The episodes of the replayed day, drawn by the published parameterised query.
#:
#: ``canonical_curtailment_episodes`` is the one implementation of the run
#: detection and it is SQL precisely so both languages can ask it — re-deriving
#: it here would be a second implementation of a published query, in a language
#: that cannot see the rows. ``technology`` is null: a replay is at subsystem
#: grain and the plan is built against the subsystem's curtailment, so splitting
#: the episodes by fleet would draw runs the plan was never scored against.
EPISODES_SQL = """
select started_at, ended_at, duration_hours, total_mwh, peak_mw
from canonical_curtailment_episodes(
  $1::subsystem_code,
  $2::timestamptz,
  $3::timestamptz,
  $4::double precision,
  $5::int,
  null::technology
)
"""


@dataclass(frozen=True)
class ReplayInputs:
    """One day's evidence, at one vintage cut. No judgement, no arithmetic.

    The same split :class:`~wattsteer_ml.replay.reads.CalendarEvidence` makes and
    for the same reason: this object knows how to ask Postgres and nothing about
    whether the day is replayable, and
    :func:`~wattsteer_ml.replay.calendar.resolve_day` knows the predicate and
    nothing about Postgres. Every field here is therefore constructible in a
    fixture, which is what keeps the endpoint's arithmetic exercisable without a
    database.

    :attr:`forecast` is ``None`` when nothing was published for this (day, lane)
    — including when the scenario pinned an origin that resolves no rows, which
    is a `404` and never a fallback to whatever else was there.
    """

    evidence: DayEvidence
    forecast: PinnedForecast | None
    observed: ObservedDay | None
    episodes: tuple[ReplayEpisode, ...]
    sources: tuple[VintageSource, ...]
    #: The threshold the episodes were drawn at, and the one the result carries.
    #: The publication's when there is one; the published subsystem default when
    #: there is not, because an observed-only day has no publication to take it
    #: from and a day's episodes still have to be drawn at *some* stated grain.
    threshold_mw: float


def _pinned_instant(raw: str | None) -> datetime | None:
    """The scenario's pinned origin as an instant, or ``None`` for "resolve it".

    Raises :class:`ValueError` on an instant it cannot read; the caller answers
    ``REPLAY_FORECAST_UNAVAILABLE``. Repairing an unreadable pin into "the
    latest" would answer a pinned link from a different publication and stamp
    that publication's origin on the result, which makes the pin decorative and
    the link dishonest — the failure this whole ticket exists to prevent.
    """
    if raw is None:
        return None
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _forecast(
    hours: list[dict[str, Any]],
    day: dict[str, Any] | None,
    *,
    subsystem: str,
    target_date: date,
) -> PinnedForecast | None:
    """Twenty-four published hours and their companion row, or nothing.

    **A partial day is an absence, not a short horizon**, exactly as
    :func:`wattsteer_ml.forecast_reads._profile` has it: zero-filling the gaps
    would invent a forecast of "no curtailment" and quote a floor computed
    against it, and shortening the horizon would move every hour index after the
    gap. A publication without its day row is the same absence — the day band is
    a stored figure and there is no arithmetic that recovers it from the hours.
    """
    if len(hours) != HOURS_PER_DAY or day is None:
        return None
    if [int(row["local_hour"]) for row in hours] != list(range(HOURS_PER_DAY)):
        return None
    thresholds = {float(row["threshold_mw"]) for row in hours}
    if len(thresholds) != 1:
        # Two grains inside one publication is not a day this service can put a
        # `threshold_mw` on, and every figure on the screen is stamped with one.
        return None

    first = hours[0]
    return PinnedForecast(
        subsystem=subsystem,
        target_date=target_date,
        threshold_mw=thresholds.pop(),
        origin=PinnedOrigin(
            producer=str(first["forecast_producer"]),
            run_label=str(first["run_label"]),
            published_at=first["published_at"].astimezone(UTC),
            origin_kind=str(first["origin_kind"]),
            gate_profile=str(first["gate_profile"]),
        ),
        hours=tuple(
            ForecastHour(
                constrained_off_mwh=QuantileBand(
                    p10=float(row["p10_mwh"]),
                    p50=float(row["p50_mwh"]),
                    p90=float(row["p90_mwh"]),
                ),
                expected_mwh=float(row["expected_mwh"]),
                occurrence_probability=float(row["occurrence_probability"]),
            )
            for row in hours
        ),
        day_total=QuantileBand(
            p10=float(day["day_total_p10_mwh"]),
            p50=float(day["day_total_p50_mwh"]),
            p90=float(day["day_total_p90_mwh"]),
        ),
        peak_power=QuantileBand(
            p10=float(day["peak_power_p10_mw"]),
            p50=float(day["peak_power_p50_mw"]),
            p90=float(day["peak_power_p90_mw"]),
        ),
        day_occurrence_probability=float(day["day_occurrence_probability"]),
    )


def _observed(
    rows: list[dict[str, Any]], *, subsystem: str, target_date: date
) -> ObservedDay | None:
    """``a[t]``, all twenty-four hours or none.

    ``None`` rather than a short day, so the calendar's
    ``REPLAY_OBSERVATION_INCOMPLETE`` is the answer instead of a denominator that
    is a different quantity wearing the same name. A civil day with a DST shift
    is not special-cased and does not need to be: the grid's zone has had no
    transition since 2019, and if one returns the count itself refuses the day
    rather than silently re-indexing the plan.
    """
    by_hour = {int(row["local_hour"]): float(row["constrained_off_mwh"]) for row in rows}
    if sorted(by_hour) != list(range(HOURS_PER_DAY)):
        return None
    versions = [
        int(row["data_version"]) for row in rows if row["data_version"] is not None
    ]
    return ObservedDay(
        subsystem=subsystem,
        target_date=target_date,
        hours=tuple(by_hour[hour] for hour in range(HOURS_PER_DAY)),
        # The greatest version among the rows that answered, as a string, so a
        # restatement of any hour of the day moves the day's vintage. `max` and
        # not the first row's: ONS rewrites hours, not days, and a day whose
        # 14:00 was restated is a day that moved.
        data_version=str(max(versions)) if versions else NO_OBSERVED_DATA_VERSION,
    )


async def read_replay_inputs(
    conn: asyncpg.Connection[Any],
    *,
    subsystem: str,
    target_date: date,
    lane: Lane,
    forecast_origin: str | None,
    as_of: datetime,
    max_gap_hours: int = MAX_GAP_HOURS,
) -> ReplayInputs:
    """One day's pinned rows, settled hours and episodes — one cut, one call.

    Opens its own transaction so the axes cannot outlive it, and closes it before
    anything is judged: what comes back is evidence, and every refusal downstream
    is a function of it rather than of a second query.

    A pinned ``forecast_origin`` that resolves nothing yields
    ``forecast=None``, which the caller answers ``REPLAY_FORECAST_UNAVAILABLE``.
    It never falls through to the unpinned resolution.
    """
    try:
        pinned = _pinned_instant(forecast_origin)
    except ValueError:
        pinned = None
        unreadable_pin = True
    else:
        unreadable_pin = False

    # The civil day's half-open bounds as instants, derived by the one function
    # that knows where a local day starts — never `date` arithmetic in UTC,
    # which would draw episodes over the wrong twenty-four hours.
    day_start = earliest_valid_instant(target_date)
    day_end = earliest_valid_instant(target_date + _ONE_DAY)

    async with conn.transaction():
        await apply_axes(conn, ReadAxes(as_of=as_of))
        hour_rows = (
            []
            if unreadable_pin
            else [
                dict(row)
                for row in await conn.fetch(
                    PINNED_FORECAST_HOURS_SQL,
                    subsystem,
                    target_date,
                    lane.feature_set,
                    lane.gate_profile,
                    lane.threshold_mw,
                    pinned,
                )
            ]
        )
        day_row: dict[str, Any] | None = None
        if hour_rows:
            found = await conn.fetchrow(
                PINNED_FORECAST_DAY_SQL,
                subsystem,
                target_date,
                lane.feature_set,
                hour_rows[0]["gate_profile"],
                lane.threshold_mw,
                hour_rows[0]["origin_kind"],
                hour_rows[0]["published_at"],
            )
            day_row = None if found is None else dict(found)

        forecast = _forecast(
            hour_rows, day_row, subsystem=subsystem, target_date=target_date
        )
        threshold_mw = (
            forecast.threshold_mw if forecast is not None else lane.threshold_mw
        )

        observed_rows = [
            dict(row)
            for row in await conn.fetch(OBSERVED_DAY_SQL, subsystem, target_date)
        ]
        settled = [
            dict(row)
            for row in await conn.fetch(
                OBSERVED_HOURS_SQL, subsystem, target_date, target_date
            )
        ]
        # Drawn inside the same transaction and at the threshold the replay
        # carries, because `replay_result` refuses an episode drawn at any other
        # one — a duration or a total without the threshold that produced it
        # cannot be compared with another.
        episode_rows = [
            dict(row)
            for row in await conn.fetch(
                EPISODES_SQL, subsystem, day_start, day_end, threshold_mw, max_gap_hours
            )
        ]
        # Which lanes hold a publication for this day, by the calendar's own
        # statement, so a day with two candidates is visibly a day with two here
        # exactly as it is there. The *chosen* origin is the pinned one and not
        # this query's, which is why it is read for `candidate_lanes` alone.
        published = [
            dict(row)
            for row in await conn.fetch(
                PUBLISHED_DAYS_SQL, subsystem, target_date, target_date
            )
        ]
        sources = await read_vintage_sources(conn, target_date)

    observed = _observed(observed_rows, subsystem=subsystem, target_date=target_date)
    candidates = assemble(published, observed_hours={}, lane=lane).get(target_date)
    return ReplayInputs(
        evidence=DayEvidence(
            target_date=target_date,
            # From the **pinned** publication, never from `assemble`'s choice: the
            # held-out assertion has to run against the card of the artifact that
            # produced the rows being scored, and a pin can legitimately resolve
            # an older vintage than the one the calendar would have picked.
            origin_kind=None if forecast is None else forecast.origin.origin_kind,
            artifact_id=None if forecast is None else forecast.origin.run_label,
            observed_hours=int(settled[0]["observed_hours"]) if settled else 0,
            candidate_lanes=() if candidates is None else candidates.candidate_lanes,
        ),
        forecast=forecast,
        observed=observed,
        episodes=tuple(
            ReplayEpisode(
                started_at=row["started_at"].astimezone(UTC),
                ended_at=row["ended_at"].astimezone(UTC),
                duration_hours=int(row["duration_hours"]),
                total_mwh=float(row["total_mwh"]),
                peak_mw=float(row["peak_mw"]),
                threshold_mw=threshold_mw,
                max_gap_hours=max_gap_hours,
            )
            for row in episode_rows
        ),
        sources=sources,
        threshold_mw=threshold_mw,
    )


#: The read, as the route calls it. A protocol-shaped alias rather than the
#: coroutine, because ``POST /v1/replay`` is a ``def`` and not an ``async def``.
ReplayInputSource = Callable[..., ReplayInputs]


def replay_input_source(
    db: Database, *, now: Callable[[], datetime] | None = None
) -> ReplayInputSource:
    """The reader `POST /v1/replay` runs with when a database is configured.

    The same bridge :func:`wattsteer_ml.forecast_reads.served_profile_source`
    builds and for the same reason, which is worth restating because it is the
    load-bearing half: the replay handler is a **`def`**, so FastAPI runs it on
    the threadpool and two MILP solves plus five simulator passes cannot stall
    the event loop and every other in-flight request with it.
    :func:`anyio.from_thread.run` awaits asyncpg on the loop the worker thread
    came from, which is the loop the pool's connections belong to.

    ``as_of`` is read per call and never captured: a reader holding the instant
    it was constructed at would serve a vintage cut from process start-up and
    stop seeing new backtest runs.
    """
    clock: Callable[[], datetime] = now or functools.partial(datetime.now, UTC)

    def read(
        *,
        subsystem: str,
        target_date: date,
        lane: Lane,
        forecast_origin: str | None,
    ) -> ReplayInputs:
        async def run() -> ReplayInputs:
            pool = await db.connect()
            async with pool.acquire() as conn:
                return await read_replay_inputs(
                    conn,
                    subsystem=subsystem,
                    target_date=target_date,
                    lane=lane,
                    forecast_origin=forecast_origin,
                    as_of=clock(),
                )

        return anyio.from_thread.run(run)

    return read


__all__ = [
    "EPISODES_SQL",
    "OBSERVED_DAY_SQL",
    "PINNED_FORECAST_DAY_SQL",
    "PINNED_FORECAST_HOURS_SQL",
    "ReplayInputSource",
    "ReplayInputs",
    "read_replay_inputs",
    "replay_input_source",
]
