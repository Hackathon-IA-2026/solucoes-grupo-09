"""The two weather aggregate series the train/serve gap is measured between.

`docs/specs/feature-engineering.md` §*Seam 7*, experiment 2: "recompute the
train/serve gap on the real aggregate". The research measured the train↔serve
correlation **per centroid point** at ``r = 0.88`` and called that an *upper
bound on the harm*, because WattSteer's feature is a capacity-weighted average
over the frozen centroids and forecast errors are spatially correlated but not
perfectly. This module builds the two aggregates the recomputation needs, out of
the real weather rows and the real weights, and hands them to
:meth:`~wattsteer_ml.evaluation.lead_time.AggregateCorrelation.measured`.

:mod:`~wattsteer_ml.evaluation.lead_time` holds the arithmetic and the
provenance; this module holds the reads. That split is deliberate: the
evaluation module is offline and fixture-testable, and a Postgres cursor inside
it would make the one place the ``correlation_source`` stamp is decided also the
one place that needs a database to exercise.

## The archive arm, and why it does not need an archive ingestion

The A/B's *other* experiment — train twice — needs archive-built **features**,
which this repository cannot materialise; see
:data:`~wattsteer_ml.evaluation.lead_time.ARCHIVE_NOT_INGESTED` and the note at
the end of this docstring. The correlation is a different shape of question and
is answerable today, because it needs no feature row and no training run — two
series and a correlation.

`apps/api/src/ingest/weather/single-runs.ts` records the measurement that makes
it answerable: **the stitched Historical Forecast archive is bit-identical to**
``_previous_day0``, **the shortest-lead slice of each run**. Every run this
repository ingests is stored whole — `weather-job.ts` writes all three forecast
days of every 00Z and 12Z run, and ``published_at`` *is* the run initialisation
— so for any valid hour the shortest-lead slice is already a **version** of that
hour on ``canonical_weather_forecast``: the one published by the newest run at
or before it. Reading it is one axis:

* **lead-matched (served)** — ``published_at_or_before = gate_at(D, profile)``.
  One cut for the whole target day, which is what the gate is.
* **archive (train)** — ``published_at_or_before = valid_time``, moved hour by
  hour. That per-hour cut *is* the stitch, and it is exactly why the archive arm
  is not expressible through ``feature_rows``: the gate writes one instant for a
  whole target day, and a stitch is twenty-four.

The reconstruction is asserted rather than assumed. ECMWF IFS publishes at 00Z
and 12Z in this window, so a genuine day-0 slice is never more than
:data:`ARCHIVE_MAX_LEAD_HOURS` old; an hour whose newest available run is older
than that is a hole in the run archive rather than an archive-equivalent
reading, and it is **dropped and counted** instead of quietly correlated. A
weighted mean over the centroids that happened to be present is refused
upstream, by
:func:`~wattsteer_ml.evaluation.lead_time.capacity_weighted_aggregate`.

## Why the axes are written here and not by ``feature_apply_gate``

Because the archive arm moves ``published_at_or_before`` **hour by hour**, and
``feature_apply_gate`` writes one instant for a whole target day. No setting of
the axes it offers expresses a stitch of twenty-four publication cuts — which is
the same missing *shape* that keeps experiment 1 unrunnable, one level down. So
the axes are written here, and nothing about the gate is redefined while doing
it: the gate instant still comes from ``gate_at(...)`` and the local day still
comes from ``feature_local_day_hours(...)``, the two SQL functions that define
them. ``as_of`` is the training-time instant on both arms, so neither arm can
see rows the other cannot.

This section used to give a different reason, and it was a defect rather than a
design. ``feature_apply_gate`` set ``as_of`` to the gate, and over the backfill
window ``ingested_at <= canonical_as_of()`` was false for every row, so
``feature_weather_block('2024-04-10', 'gate_late')`` returned nothing at all
against weather ingested in 2026. `drizzle/0039_the_gate_over_a_backfill.sql`
fixed that on the ingestion axis. The per-hour cut above is what remains, and it
was always the real reason this module holds its own reads.

## What this module does not do

It does not compute weights: ``canonical_capacity_weight`` is the authority, for
the reason :class:`~wattsteer_ml.evaluation.lead_time.CapacityWeights` states.
It does not train anything, does not write a card, and is not imported by the
weekly retrain. Composing the measurement onto a card is the caller's, and it is
one expression, because the block that carries it is the *unmeasured* lead-time
block:

.. code-block:: python

    correlation = await measure_aggregate_correlation(conn, ...)
    record_lead_time_penalty(
        unmeasured_for_want_of_an_archive(
            lane=lane, as_of=as_of, correlation=correlation
        ),
        root=root,
        artifact_id=artifact_id,
    )

That is the honest shape of today's card: experiment 1 unrun with the reason
named, experiment 2 measured beside it. A card with no block and a card saying
"the control arm has no data source" look identical to anyone grepping for the
figure, and only one of them is true.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import asyncpg

from .canonical_reads import ReadAxes, apply_axes
from .evaluation.lead_time import (
    CORRELATION_VARIABLE,
    AggregateCorrelation,
    CapacityWeights,
    LeadTimeError,
    capacity_weighted_aggregate,
)

#: The gate the experiment is run at, matching
#: :data:`~wattsteer_ml.evaluation.lead_time.EXPERIMENT_GATE_PROFILE`: the late
#: gate is where the D−1 12Z run — the one the research measured — exists at all.
GATE_PROFILE = "gate_late"

#: The technology vector ``wind_speed_120m`` is weighted on. The wind fleet and
#: the solar fleet sit in different places, so a wind variable weighted on solar
#: capacity is an aggregate over the wrong geography.
TECHNOLOGY = "WIND"

#: How old the newest available run may be and still be the archive's own
#: shortest-lead slice. ECMWF IFS publishes at 00Z and 12Z over this window, so
#: a genuine day-0 hour is 0–11 h from its run; twelve is the first lead that
#: can only mean a run slot was missing. `docs/research/weather-lead-time.md`
#: measured 5 of 112 slots missing, so this is a real case and not a guard
#: against the impossible.
ARCHIVE_MAX_LEAD_HOURS = 12


class WeatherReadError(ValueError):
    """A read that cannot be answered as the quantity it was asked for."""


@dataclass(frozen=True)
class HourPair:
    """One valid hour, seen twice: as the archive holds it and as serving does."""

    valid_time: datetime
    #: The capacity-weighted aggregate over the shortest-lead slice.
    archive: float
    #: The same aggregate over the run the gate allows.
    lead_matched: float
    #: ``valid_time − published_at`` on the archive arm, in hours. Carried
    #: because it is the evidence that the arm is a day-0 slice rather than
    #: another lead-matched forecast under a different name.
    archive_lead_hours: float


@dataclass(frozen=True)
class AggregatePairs:
    """The two series, aligned, with the hours that could not be paired counted.

    ``hours_dropped`` is on the value rather than left to a log line: the
    correlation is computed over ``pairs`` alone, and a caller cannot tell a
    window that paired cleanly from one that lost a third of its hours to a
    missing run unless the number travels with the answer.
    """

    weights: CapacityWeights
    variable: str
    gate_profile: str
    hours_requested: int
    pairs: tuple[HourPair, ...]
    #: Hours no centroid-complete archive reading existed for.
    hours_without_archive: int
    #: Hours whose newest run was older than :data:`ARCHIVE_MAX_LEAD_HOURS`.
    hours_beyond_archive_lead: int
    #: Hours no centroid-complete lead-matched reading existed for.
    hours_without_lead_matched: int

    @property
    def hours_dropped(self) -> int:
        return self.hours_requested - len(self.pairs)

    def correlation(self) -> AggregateCorrelation:
        """The published figure, stamped
        :data:`~wattsteer_ml.evaluation.lead_time.WEATHER_SERIES_SOURCE`.

        Through :meth:`AggregateCorrelation.measured
        <wattsteer_ml.evaluation.lead_time.AggregateCorrelation.measured>` and
        no other path, so a figure on a card came out of stored weather rows or
        it says on its face that it did not.
        """
        return AggregateCorrelation.measured(
            pairs=[(pair.archive, pair.lead_matched) for pair in self.pairs],
            variable=self.variable,
            weights=self.weights,
        )


async def read_capacity_weights(
    conn: asyncpg.Connection[Any],
    *,
    subsystem: str,
    fleet_date: date,
    as_of: datetime,
    technology: str = TECHNOLOGY,
) -> CapacityWeights:
    """One scope's weights, as ``canonical_capacity_weight`` holds them.

    The fleet date is the target date and the vintage is the training-time
    instant, which is the double as-of the weight view is built for. Weights are
    re-read per target date rather than pinned once, because
    `docs/research/plant-registry.md` §5 measured a fixed vector misallocating
    50.4% of one scope's weight mass at window start.

    Opens its own transaction so the axes cannot outlive it, exactly as
    :func:`~wattsteer_ml.canonical_reads.read_fact` does. The axes are session
    settings on a pooled connection, and a read that left them behind would
    decide the *next* read's vintage.
    """
    async with conn.transaction():
        await apply_axes(
            conn,
            ReadAxes(
                as_of=as_of,
                fleet_date=datetime.combine(fleet_date, datetime.min.time()),
            ),
        )
        rows = await conn.fetch(
            """
            select set_version, centroid_id, weight
            from canonical_capacity_weight
            where subsystem = $1::subsystem_code and technology = $2::technology
            """,
            subsystem,
            technology,
        )
    if not rows:
        raise WeatherReadError(
            f"{subsystem}/{technology} places no located capacity on "
            f"{fleet_date}: there is no weight vector to aggregate under, and an "
            "even spread over the frozen points would be a fabricated location"
        )
    return CapacityWeights(
        set_version=str(rows[0]["set_version"]),
        scope=f"{subsystem}/{technology.lower()}",
        weights={str(row["centroid_id"]): float(row["weight"]) for row in rows},
    )


async def _local_day_hours(
    conn: asyncpg.Connection[Any], target_date: date
) -> tuple[datetime, ...]:
    """The 24 hours of the target day, from the database's own definition.

    ``feature_local_day_hours`` is the DST canary the feature spine already
    carries; a second Python opinion about where a Brasília civil day starts is
    exactly the drift this repository keeps refusing.
    """
    rows = await conn.fetch(
        "select feature_local_day_hours($1::date) as valid_time", target_date
    )
    return tuple(row["valid_time"] for row in rows)


async def _readings_at(
    conn: asyncpg.Connection[Any],
    *,
    hours: Sequence[datetime],
    as_of: datetime,
    published_at_or_before: datetime,
) -> dict[datetime, dict[str, tuple[float, datetime]]]:
    """Every centroid's value and run for a set of hours, under one publication cut.

    One transaction, so the publication cut cannot outlive the read that asked
    for it — which matters more here than anywhere else in this module, because
    the archive arm moves that cut on every hour.
    """
    async with conn.transaction():
        await apply_axes(
            conn,
            ReadAxes(as_of=as_of, published_at_or_before=published_at_or_before),
        )
        # ``wind_speed120m_kmh`` is the view's spelling of
        # :data:`~wattsteer_ml.evaluation.lead_time.CORRELATION_VARIABLE`, and
        # it is written into the statement rather than interpolated from a
        # constant: this module measures one variable, because ``measured``
        # refuses any other, so a column name that could vary would be a
        # parameter with exactly one legal value.
        rows = await conn.fetch(
            """
            select centroid_id, valid_time, published_at,
                   wind_speed120m_kmh as value
            from canonical_weather_forecast
            where valid_time = any($1::timestamptz[])
              and wind_speed120m_kmh is not null
            """,
            list(hours),
        )
    readings: dict[datetime, dict[str, tuple[float, datetime]]] = {}
    for row in rows:
        readings.setdefault(row["valid_time"], {})[str(row["centroid_id"])] = (
            float(row["value"]),
            row["published_at"],
        )
    return readings


def _aggregate(
    readings: dict[str, tuple[float, datetime]], weights: CapacityWeights
) -> float | None:
    """The scope's aggregate, or ``None`` when a centroid did not report."""
    try:
        return capacity_weighted_aggregate(
            {centroid: value for centroid, (value, _) in readings.items()}, weights
        )
    except LeadTimeError:
        return None


async def read_aggregate_pairs(
    conn: asyncpg.Connection[Any],
    *,
    target_dates: Sequence[date],
    subsystem: str,
    as_of: datetime,
    gate_profile: str = GATE_PROFILE,
    technology: str = TECHNOLOGY,
) -> AggregatePairs:
    """The archive and lead-matched aggregates, hour by hour, over real rows.

    Each target date is aggregated under **its own** weight vector, which is
    what the weather block does; the vector returned on the value is the last
    date's, and it is there to name the scope and the centroid set rather than
    to claim one vector served the whole window.
    """
    if not target_dates:
        raise WeatherReadError("a correlation over no target dates")

    weights: CapacityWeights | None = None
    pairs: list[HourPair] = []
    requested = 0
    without_archive = 0
    beyond_lead = 0
    without_lead_matched = 0

    for target_date in target_dates:
        weights = await read_capacity_weights(
            conn,
            subsystem=subsystem,
            fleet_date=target_date,
            as_of=as_of,
            technology=technology,
        )
        hours = await _local_day_hours(conn, target_date)
        requested += len(hours)

        gate = await conn.fetchval(
            "select gate_at($1::date, $2)", target_date, gate_profile
        )
        served = await _readings_at(
            conn, hours=hours, as_of=as_of, published_at_or_before=gate
        )

        for hour in hours:
            # The archive stitch: one publication cut per hour, at the hour.
            archive = await _readings_at(
                conn, hours=[hour], as_of=as_of, published_at_or_before=hour
            )
            archive_hour = archive.get(hour, {})
            archive_value = _aggregate(archive_hour, weights)
            if archive_value is None:
                without_archive += 1
                continue
            lead = max(
                (hour - published) for _, published in archive_hour.values()
            ) / timedelta(hours=1)
            if lead > ARCHIVE_MAX_LEAD_HOURS:
                beyond_lead += 1
                continue
            served_value = _aggregate(served.get(hour, {}), weights)
            if served_value is None:
                without_lead_matched += 1
                continue
            pairs.append(
                HourPair(
                    valid_time=hour,
                    archive=archive_value,
                    lead_matched=served_value,
                    archive_lead_hours=lead,
                )
            )

    assert weights is not None
    return AggregatePairs(
        weights=weights,
        variable=CORRELATION_VARIABLE,
        gate_profile=gate_profile,
        hours_requested=requested,
        pairs=tuple(pairs),
        hours_without_archive=without_archive,
        hours_beyond_archive_lead=beyond_lead,
        hours_without_lead_matched=without_lead_matched,
    )


async def measure_aggregate_correlation(
    conn: asyncpg.Connection[Any],
    *,
    target_dates: Sequence[date],
    subsystem: str,
    as_of: datetime,
    gate_profile: str = GATE_PROFILE,
    technology: str = TECHNOLOGY,
) -> AggregateCorrelation:
    """:func:`read_aggregate_pairs`, correlated. The whole of experiment 2."""
    pairs = await read_aggregate_pairs(
        conn,
        target_dates=target_dates,
        subsystem=subsystem,
        as_of=as_of,
        gate_profile=gate_profile,
        technology=technology,
    )
    return pairs.correlation()


__all__ = [
    "ARCHIVE_MAX_LEAD_HOURS",
    "GATE_PROFILE",
    "TECHNOLOGY",
    "AggregatePairs",
    "HourPair",
    "WeatherReadError",
    "measure_aggregate_correlation",
    "read_aggregate_pairs",
    "read_capacity_weights",
]
