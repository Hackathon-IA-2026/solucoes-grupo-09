"""The two queries behind the replayable calendar, and nothing else.

`docs/specs/replay.md`'s predicate has two clauses that are questions for
Postgres — *are there held-out forecast rows for this (subsystem, day)* and *are
all twenty-four hours of the day settled* — and this module is those two
questions, one statement each, asked over the whole window at once.

## Why the whole window in two statements

A calendar covering seventeen months is roughly nine hundred days. Asking per
day would be nine hundred round trips to answer what is one ``group by`` in each
view, and the answer would be assembled from nine hundred transactions with nine
hundred chances for the ``as_of`` axis to differ. Both statements run inside one
transaction with the axes written once, so a calendar is a single vintage cut
rather than a mosaic of them.

## `origin_kind` is selected, not filtered to one value

The opposite of :mod:`wattsteer_ml.forecast_reads`, deliberately. That module
pins ``origin_kind = 'served'`` as a constant in the SQL because
`docs/specs/replay.md` seam 6 requires that a reconstruction is never reachable
from the live route. This one reads *both* kinds, because the replay path is the
one surface where a reconstruction is the intended answer — and it carries the
kind out on the row so the caller maps it to a `provenance` rather than assuming
one. There is still no parameter here that widens either query beyond the two
kinds the enum has.

## The lane is not spelled in SQL

The query returns ``feature_set``, ``gate_profile`` and ``threshold_mw`` and
this module composes :attr:`~wattsteer_ml.lanes.Lane.directory_name` from them.
A ``feature_set || '__' || …`` in the statement would be a second implementation
of the lane spelling — ``thr5`` versus ``thr5.0`` is exactly the kind of drift
:mod:`wattsteer_ml.lanes` exists to make impossible — and it would live where no
test looks.

## Days come from the day rows

There is one row per (subsystem, target_date, origin_kind, gate_profile,
data_version), so a day's existence is a day row's existence. Reading it off the
hours would mean counting to twenty-four in SQL to decide whether a publication
exists, which is the day-grain arithmetic both specs put in the day row
precisely so that nobody recomputes it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

import asyncpg

from wattsteer_ml.canonical import VintageSource, vintage_fidelity
from wattsteer_ml.canonical_reads import ReadAxes, apply_axes, read_go_live
from wattsteer_ml.evaluation.vintage import earliest_valid_instant
from wattsteer_ml.lanes import Lane
from wattsteer_ml.replay.calendar import VINTAGE_READS, DayEvidence

#: Every publication of one subsystem's window, newest vintage per (day, lane).
#:
#: ``distinct on`` picks the newest ``published_at`` and then the highest
#: ``data_version``, which is the supersession rule `AsOf` applies to any
#: re-publication: a second backtest run writes a newer vintage beside the first
#: and this returns it. A replay that wants the older one pins its origin, which
#: is a later ticket's job and is why nothing here caches across vintages.
PUBLISHED_DAYS_SQL = """
select distinct on (target_date, feature_set, gate_profile, threshold_mw)
  target_date,
  feature_set,
  gate_profile::text as gate_profile,
  threshold_mw,
  origin_kind::text as origin_kind,
  run_label
from canonical_forecast_day
where subsystem = $1::subsystem_code
  and target_date between $2::date and $3::date
order by target_date, feature_set, gate_profile, threshold_mw,
         published_at desc, data_version desc
"""

#: How many distinct settled hours each local day of one subsystem holds.
#:
#: ``valid_time`` is UTC and the day is civil, so the conversion is here and in
#: the ``group by`` — the same ``America/Sao_Paulo`` boundary the forecast rows'
#: ``target_date`` was written against. ``count(distinct valid_time)`` rather
#: than ``count(*)`` because the view is at reporting-entity grain: a
#: subsystem-hour is settled when an entity reported it, and counting rows would
#: count one hour once per conjunto and call an eight-hour day complete.
OBSERVED_HOURS_SQL = """
select
  (valid_time at time zone 'America/Sao_Paulo')::date as target_date,
  count(distinct valid_time)::int as observed_hours
from canonical_curtailment_by_reporting_entity
where subsystem = $1::subsystem_code
  and (valid_time at time zone 'America/Sao_Paulo')::date
      between $2::date and $3::date
group by 1
"""


@dataclass(frozen=True)
class CalendarEvidence:
    """Everything the database has to say about one subsystem's window.

    Held together rather than returned as three values, so a caller cannot read
    the day rows at one ``as_of`` and the go-lives at another and then present
    the pair as one calendar.
    """

    #: Indexed by day. A day the window covers but neither query returned is
    #: simply absent, and the calendar walks dates rather than rows so that it
    #: still has something to say about it — `replay.md` story 14.
    days: dict[date, DayEvidence]
    sources: tuple[VintageSource, ...]


async def read_vintage_sources(
    conn: asyncpg.Connection[Any], reference_date: date
) -> tuple[VintageSource, ...]:
    """The go-live of every read a replayed day's actuals depend on.

    One :class:`~wattsteer_ml.canonical.VintageSource` per
    :data:`~wattsteer_ml.replay.calendar.VINTAGE_READS` entry. The caller
    combines them by the weakest-link rule, and that is the whole reason they
    travel as a list rather than as one instant: ``canonical_read_go_live``
    computes a go-live **per read**, so ``T_go`` need not be a single instant
    and this module will not pretend it is.

    ``reference_date`` only decides the ``vintage_fidelity`` each source carries
    for itself; the per-day verdict is recomputed from ``go_live_at`` by
    :func:`~wattsteer_ml.replay.calendar.day_fidelity`, so a calendar spanning
    the boundary is stamped day by day and never window-wide.

    ``canonical_read_go_live`` is the one view without an axis — a fact about
    WattSteer's history rather than about the cut being asked for — so it is
    read here without one.
    """
    window_start = earliest_valid_instant(reference_date)
    sources: list[VintageSource] = []
    for read in VINTAGE_READS:
        go_live_at = await read_go_live(conn, read)
        sources.append(
            VintageSource(
                read=read,
                vintage_fidelity=vintage_fidelity(window_start, go_live_at),
                go_live_at=go_live_at,
            )
        )
    return tuple(sources)


async def read_calendar_evidence(
    conn: asyncpg.Connection[Any],
    *,
    subsystem: str,
    lane: Lane,
    window_start: date,
    window_end: date,
    as_of: datetime,
) -> CalendarEvidence:
    """One subsystem's window, as evidence — no judgement and no refusals.

    The split is the point: this function knows how to ask Postgres and nothing
    about which days are replayable, and
    :func:`~wattsteer_ml.replay.calendar.resolve_day` knows the predicate and
    nothing about Postgres. That is what makes every clause — including the two
    that are absences — exercisable without a database.

    Opens its own transaction so the axes cannot outlive it, exactly as
    :func:`wattsteer_ml.forecast_reads.read_planning_profile` does.
    """
    async with conn.transaction():
        await apply_axes(conn, ReadAxes(as_of=as_of))
        published = await conn.fetch(
            PUBLISHED_DAYS_SQL, subsystem, window_start, window_end
        )
        observed = await conn.fetch(
            OBSERVED_HOURS_SQL, subsystem, window_start, window_end
        )
        sources = await read_vintage_sources(conn, window_start)

    hours = {row["target_date"]: int(row["observed_hours"]) for row in observed}
    return CalendarEvidence(
        days=assemble([dict(row) for row in published], observed_hours=hours, lane=lane),
        sources=sources,
    )


def assemble(
    published: list[dict[str, Any]],
    *,
    observed_hours: dict[date, int],
    lane: Lane,
) -> dict[date, DayEvidence]:
    """Rows into per-day evidence, with the lane resolved and the others named.

    Two things happen here and neither is a judgement:

    - the row **in the named lane** becomes the day's ``origin_kind`` and
      ``artifact_id``, and every other lane holding a publication for that day
      becomes an entry in ``candidate_lanes``. Nothing picks between them, which
      is the open decision this ticket makes visible rather than settles;
    - a day with observed hours but no publication still gets an entry, because
      "there is no forecast" and "there is no data at all" are two different
      refusals and the second must not swallow the first.
    """
    lanes: dict[date, list[str]] = {}
    chosen: dict[date, dict[str, Any]] = {}
    for row in published:
        target_date = row["target_date"]
        name = Lane(
            feature_set=row["feature_set"],
            gate_profile=row["gate_profile"],
            threshold_mw=float(row["threshold_mw"]),
        ).directory_name
        lanes.setdefault(target_date, []).append(name)
        if name == lane.directory_name:
            chosen[target_date] = row

    days: dict[date, DayEvidence] = {}
    for target_date in sorted(set(lanes) | set(observed_hours)):
        found = chosen.get(target_date)
        days[target_date] = DayEvidence(
            target_date=target_date,
            origin_kind=None if found is None else found["origin_kind"],
            artifact_id=None if found is None else found["run_label"],
            observed_hours=observed_hours.get(target_date, 0),
            candidate_lanes=tuple(sorted(lanes.get(target_date, ()))),
        )
    return days
