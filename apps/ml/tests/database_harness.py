"""A Postgres for the Python tests — the harness replay 02 and 03 asked for.

Replay 02 shipped two SQL statements it could not test: `apps/ml` had no
database harness, and both were validated by hand against a throwaway container.
Replay 03 said explicitly that this ticket is where a harness earns its keep,
because a replay reads **pinned forecast rows, settled hours, episodes and the
day rows in one transaction** — and the statement that does that is only
correct or incorrect against a real server. A `dict` cannot disagree with a
`distinct on`.

## What it is, and what it is deliberately not

It is asyncpg, an env-var gate and a seeder. It is **not** a migration runner:
the schema is Drizzle's and lives in `apps/api`, and a second definition of it
in Python is the thing this project keeps refusing. So the contract is exactly
the TypeScript suites': point `WATTSTEER_TEST_DATABASE_URL` at a database
someone has already migrated, and the suite runs; leave it unset and the suite
skips.

    docker run -d -p 5487:5432 -e POSTGRES_PASSWORD=wattsteer \\
      -e POSTGRES_DB=wattsteer postgres:17-alpine
    cd apps/api && DATABASE_URL=postgres://postgres:wattsteer@localhost:5487/wattsteer \\
      bun run db:migrate
    bun run ml:test:db

`bun run ml:test:db` in the repo root does the last two steps.

## Why the seeder writes raw SQL and not an ORM

There is no Python ORM here and there should not be one: what these tests
assert is the behaviour of the *views*, which are SQL, under the axes, which are
session settings. Anything that generated the inserts would be a second opinion
about the schema. The column lists below are therefore explicit and will break
loudly when a migration adds a `not null` — which is the correct failure, since
a harness that silently stopped covering a column would be worse than no
harness.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any

import asyncpg
import pytest

#: The same variable the TypeScript database suites gate on. One switch for the
#: repository, so "the database tests ran" is one fact rather than two.
URL_VARIABLE = "WATTSTEER_TEST_DATABASE_URL"

#: A view every canonical read depends on. Its absence means the database is
#: reachable but not migrated, which is a different message to print than
#: "no database configured" — an operator who set the variable and got a skip
#: would otherwise have nothing to act on.
MIGRATED_MARKER = "canonical_forecast_hour"

#: The producer enum's only member for these tables.
PRODUCER = "wattsteer"


def database_url() -> str:
    """The URL, or skip the test. Never a default, and never localhost."""
    url = os.environ.get(URL_VARIABLE)
    if not url:
        pytest.skip(f"{URL_VARIABLE} is unset; see database_harness.py for the recipe")
    return url


def run[T](work: Callable[[asyncpg.Connection[Any]], Awaitable[T]]) -> T:
    """Open one connection, run one coroutine, close it.

    A connection per test rather than a pooled one, because the thing under test
    writes *session* settings — `canonical_as_of()` reads a GUC — and a pooled
    connection carrying one test's axes into the next is a failure mode that
    would show up as an unrelated test being wrong.
    """

    async def main() -> T:
        conn = await asyncpg.connect(database_url())
        try:
            migrated = await conn.fetchval("select to_regclass($1)", MIGRATED_MARKER)
            if migrated is None:
                pytest.skip(
                    f"{URL_VARIABLE} points at a database with no "
                    f"{MIGRATED_MARKER}; run `bun run --cwd apps/api db:migrate`"
                )
            return await work(conn)
        finally:
            await conn.close()

    return asyncio.run(main())


async def truncate(conn: asyncpg.Connection[Any]) -> None:
    """Everything these fixtures write, and nothing they do not."""
    await conn.execute(
        "truncate table curtailment_forecast_hour, curtailment_forecast_day, "
        "curtailment_report_hour"
    )
    await conn.execute("truncate table reporting_entity cascade")
    await conn.execute("truncate table ons_resource_version cascade")


async def truncate_weather(conn: asyncpg.Connection[Any]) -> None:
    """The weather tables, which only :func:`seed_weather_run` writes.

    Separate from :func:`truncate` because the two are used by different
    suites and a fixture that emptied a table it never writes is a fixture
    that can break an unrelated one.
    """
    await conn.execute("truncate table weather_run_request cascade")


async def source_version(conn: asyncpg.Connection[Any]) -> Any:
    """One `OnsResourceVersion`, because every observed row must name its source."""
    return await conn.fetchval(
        """
        insert into ons_resource_version
          (dataset_slug, resource_name, resource_url, format, change_key)
        values ($1, $2, $3, $4, $5)
        returning id
        """,
        "restricao_coff_eolica_conj",
        "Restricoes_coff_eolicas-replay-harness",
        "https://example.invalid/replay-harness.csv",
        "CSV",
        f"replay-harness|{datetime.now(tz=UTC).timestamp()}",
    )


async def reporting_entity(
    conn: asyncpg.Connection[Any],
    *,
    code: str = "CJU_HARNESS",
    subsystem: str = "NE",
) -> str:
    await conn.execute(
        """
        insert into reporting_entity (ons_code, kind, name, subsystem, state_code)
        values ($1, 'CONJUNTO', $2, $3::subsystem_code, 'BA')
        on conflict (ons_code) do nothing
        """,
        code,
        f"Conjunto {code}",
        subsystem,
    )
    return code


def local_midnight(day: date) -> datetime:
    """The UTC instant a Brasília civil day opens.

    Written as `-03:00` rather than derived, because the harness must not agree
    with the code under test about where a local day starts: the whole point of
    `OBSERVED_DAY_SQL` is that Postgres resolves the boundary, and a fixture
    that used the same helper would prove nothing about it.
    """
    return datetime.fromisoformat(f"{day.isoformat()}T00:00:00-03:00").astimezone(UTC)


async def seed_observed_day(
    conn: asyncpg.Connection[Any],
    *,
    day: date,
    hours: Sequence[float],
    subsystem: str = "NE",
    entity: str | None = None,
    ingested_at: datetime | None = None,
    source: Any = None,
    technology: str = "WIND",
    data_version: int = 1,
) -> None:
    """One civil day of settled curtailment, at reporting-entity grain.

    ``hours`` is indexed by *local* hour and may be shorter than twenty-four —
    that is how the ``REPLAY_OBSERVATION_INCOMPLETE`` case is built, and it is
    an absence of rows rather than a column of zeros, because a settled zero and
    an unsettled hour are two different facts.
    """
    version = source if source is not None else await source_version(conn)
    code = entity or await reporting_entity(conn, subsystem=subsystem)
    stamp = ingested_at or datetime(2026, 1, 1, tzinfo=UTC)
    start = local_midnight(day)
    await conn.executemany(
        """
        insert into curtailment_report_hour (
          reporting_entity_code, technology, valid_time,
          verified_generation_mwh, constrained_off_mwh, half_hours_observed,
          cause_mixed, data_version, published_at, published_at_precision,
          ingested_at, value_digest, source_version_id
        ) values ($1, $2::technology, $3, 0, $4, 2, 0, $5, $6, 'file', $7, $8, $9)
        """,
        [
            (
                code,
                technology,
                start + timedelta(hours=hour),
                float(value),
                data_version,
                stamp,
                stamp,
                f"{code}|{day}|{hour}|{value}|{data_version}",
                version,
            )
            for hour, value in enumerate(hours)
        ],
    )


async def seed_publication(
    conn: asyncpg.Connection[Any],
    *,
    day: date,
    p10: Sequence[float],
    p50: Sequence[float],
    p90: Sequence[float],
    run_label: str,
    origin_kind: str = "backfilled_holdout",
    gate_profile: str = "gate_late",
    feature_set: str = "dessem_free_v1",
    threshold_mw: float = 5.0,
    subsystem: str = "NE",
    published_at: datetime | None = None,
    ingested_at: datetime | None = None,
    data_version: int = 1,
    day_total: tuple[float, float, float] | None = None,
) -> datetime:
    """One publication: twenty-four hour rows and the day-grain companion.

    Both, always, and written together — a publication missing its day row is
    the absence :func:`~wattsteer_ml.replay.inputs._forecast` refuses, and a
    harness that could write one without the other would let a test pass that
    the product would fail.

    Returns the publication instant, which is what a scenario pins.
    """
    gate = published_at or (local_midnight(day) - timedelta(hours=5))
    stamp = ingested_at or datetime(2026, 1, 1, tzinfo=UTC)
    start = local_midnight(day)
    correction = "hurdle_isotonic_conformal_v1"

    await conn.executemany(
        """
        insert into curtailment_forecast_hour (
          subsystem, valid_time, origin_kind, gate_profile, target_date, local_hour,
          forecast_producer, run_label, feature_set, correction_regime,
          threshold_mw, occurrence_probability, p10_mwh, p50_mwh, p90_mwh,
          expected_mwh, p50_wind_mwh, p50_solar_mwh, expected_wind_mwh,
          expected_solar_mwh, crossed, data_version, published_at, ingested_at,
          value_digest
        ) values (
          $1::subsystem_code, $2, $3::forecast_origin_kind,
          $4::forecast_gate_profile, $5::date, $6, $7::forecast_producer, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $13, 0, $16, 0, $17, $18, $19, $20, $21
        )
        """,
        [
            (
                subsystem,
                start + timedelta(hours=hour),
                origin_kind,
                gate_profile,
                day,
                hour,
                PRODUCER,
                run_label,
                feature_set,
                correction,
                threshold_mw,
                1.0 if mid > 0 else 0.1,
                float(low),
                float(mid),
                float(high),
                float(mid),
                mid > threshold_mw,
                data_version,
                gate,
                stamp,
                f"{run_label}|{day}|{hour}|{mid}|{data_version}",
            )
            for hour, (low, mid, high) in enumerate(zip(p10, p50, p90, strict=True))
        ],
    )

    totals = day_total or (sum(p10) * 0.8, sum(p50), sum(p90) * 0.9)
    await conn.execute(
        """
        insert into curtailment_forecast_day (
          subsystem, target_date, origin_kind, gate_profile, forecast_producer,
          run_label, feature_set, correction_regime, threshold_mw,
          day_total_p10_mwh, day_total_p50_mwh, day_total_p90_mwh,
          peak_power_p10_mw, peak_power_p50_mw, peak_power_p90_mw,
          day_occurrence_probability, expected_mwh, expected_wind_mwh,
          expected_solar_mwh, hours_p50_nonzero, derivation, ensemble_draws,
          ensemble_seed, ensemble_calibration_days, trained_through,
          risk_bin_elevated_from, risk_bin_high_from, data_version, published_at,
          ingested_at, value_digest
        ) values (
          $1::subsystem_code, $2::date, $3::forecast_origin_kind,
          $4::forecast_gate_profile, $5::forecast_producer, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $11, $11, 0, $17, 'path_ensemble',
          500, 7, 90, $18::date, 0.25, 0.75, $19, $20, $21, $22
        )
        """,
        subsystem,
        day,
        origin_kind,
        gate_profile,
        PRODUCER,
        run_label,
        feature_set,
        correction,
        threshold_mw,
        float(totals[0]),
        float(totals[1]),
        float(totals[2]),
        float(max(p10)),
        float(max(p50)),
        float(max(p90)),
        0.9,
        sum(1 for value in p50 if value > 0),
        day - timedelta(days=1),
        data_version,
        gate,
        stamp,
        f"{run_label}|{day}|day|{data_version}",
    )
    return gate


async def seed_weather_run(
    conn: asyncpg.Connection[Any],
    *,
    run_init: datetime,
    run_cycle: str,
    values: Sequence[tuple[datetime, float]],
    centroid_id: str = "NE_WIND_HARNESS",
    ingested_at: datetime,
    data_version: int = 1,
) -> None:
    """One weather run: a request row and its hours.

    ``ingested_at`` is **required and has no default**, and ``run_init`` is
    what lands in ``published_at``. Those two being separable is the whole
    point of this seeder: over a backfill every run in the store shares one
    ingestion instant, so ``AsOf(gate)`` filters *nothing* and the publication
    cut is the only thing standing between a late-gate read and a run from its
    own future. A seeder that derived one from the other could not build the
    fixture that notices.

    ``values`` carries ``wind_speed120m_kmh`` only — it is enough to tell one
    run's answer from another's, which is all any assertion here needs.
    """
    request_id = await conn.fetchval(
        """
        insert into weather_run_request (
          model, run_init, run_cycle, scheduled_run_init, centroid_set_version,
          centroid_count, variables, forecast_days, request_url, http_status,
          row_count, content_sha256, byte_size
        ) values (
          'ecmwf_ifs', $1, $2::weather_run_cycle, $1, 'centroid_set_v1',
          1, 'wind_speed_120m', 2, $3, 200, $4, $5, 1
        )
        returning id
        """,
        run_init,
        run_cycle,
        f"https://example.invalid/weather?run={run_init.isoformat()}",
        len(values),
        f"harness-{run_init.isoformat()}-{run_cycle}-{data_version}",
    )
    await conn.executemany(
        """
        insert into weather_forecast_hour (
          centroid_id, valid_time, grid_latitude, grid_longitude,
          grid_elevation_m, run_cycle, run_age_hours, wind_speed120m_kmh,
          data_version, published_at, published_at_precision, ingested_at,
          value_digest, source_request_id
        ) values (
          $1, $2, -9.5, -40.5, 400, $3::weather_run_cycle, $4, $5,
          $6, $7, 'row', $8, $9, $10
        )
        """,
        [
            (
                centroid_id,
                valid_time,
                run_cycle,
                max(0, int((valid_time - run_init).total_seconds() // 3600)),
                float(speed),
                data_version,
                run_init,
                ingested_at,
                f"{centroid_id}|{valid_time.isoformat()}|{speed}|{data_version}",
                request_id,
            )
            for valid_time, speed in values
        ],
    )


__all__ = [
    "MIGRATED_MARKER",
    "URL_VARIABLE",
    "database_url",
    "local_midnight",
    "reporting_entity",
    "run",
    "seed_observed_day",
    "seed_publication",
    "seed_weather_run",
    "source_version",
    "truncate",
    "truncate_weather",
]


# --- Added by feature-engineering 13 ---------------------------------------
# A second weather seeder, kept beside `seed_weather_run` rather than merged
# into it: that one seeds a single run's hours for the canonical-read tests,
# this one seeds whole forecast days across runs for the aggregate train/serve
# gap. Same table, different question; one signature cannot answer both
# without a parameter that means "which test are you".

#: The frozen set every weather fixture writes into. The literal the view
#: spells, not a parameter: `canonical_capacity_weight` filters on it.
CENTROID_SET_VERSION = "centroid_set_v1"

#: Backfill stamp. Deliberately *later* than any gate these tests use, because
#: that is the production shape — 2024 weather ingested in 2026 — and a fixture
#: that backdated `ingested_at` would hide the very read this harness exists to
#: exercise.
BACKFILL_INGESTED_AT = datetime(2026, 1, 1, tzinfo=UTC)


async def seed_weather_fleet(
    conn: asyncpg.Connection[Any],
    *,
    subsystem: str = "NE",
    technology: str = "WIND",
    points: Sequence[tuple[str, float, float, float]] = (
        ("W1", -12.5, -41.5, 300.0),
        ("W2", -5.5, -36.5, 700.0),
    ),
) -> None:
    """A frozen centroid set and one plant sitting exactly on each point.

    Each plant is placed *at* its centroid so the nearest-point assignment in
    `canonical_capacity_weight` is unambiguous: the weights these tests assert
    against are then the capacity shares and nothing about the haversine.
    """
    version = await source_version(conn)
    await conn.execute(
        """
        insert into centroid_set (
          version, source, geometry_digest, centroid_count, represented_mw,
          registry_as_of, fleet_on, freeze_located_mw, freeze_plants,
          collision_check
        )
        select $1, (select min(e::text)::centroid_set_source
                    from unnest(enum_range(null::centroid_set_source)) e),
               'harness', $2, $3, $4, $4, $3, $2,
               (select min(e::text)::centroid_collision_check
                from unnest(enum_range(null::centroid_collision_check)) e)
        on conflict (version) do nothing
        """,
        CENTROID_SET_VERSION,
        len(points),
        float(sum(mw for _, _, _, mw in points)),
        BACKFILL_INGESTED_AT,
    )
    await conn.executemany(
        """
        insert into centroid_point (
          set_version, centroid_id, label, latitude, longitude, technology,
          represented_mw, origin, municipalities, plants, merged_from,
          grid_latitude, grid_longitude
        ) values ($1, $2, $2, $3, $4, $5::technology, $6,
                  'municipality_centroid', $2, 1, '', $3, $4)
        on conflict do nothing
        """,
        [
            (CENTROID_SET_VERSION, point, lat, lon, technology, mw)
            for point, lat, lon, mw in points
        ],
    )
    await conn.executemany(
        """
        insert into plant (
          ceg_core, ceg_raw, ons_plant_code, name, subsystem, state_code,
          technology, operation_modality, owner_name, operator_name
        ) values ($1, $1, $1, $1, $2::subsystem_code, 'BA', $3::technology,
                  'TIPO_I', 'harness', 'harness')
        on conflict (ceg_core) do nothing
        """,
        [(f"PLANT_{point}", subsystem, technology) for point, _, _, _ in points],
    )
    await conn.executemany(
        """
        insert into generating_unit (
          plant_ceg_core, equipment_code, unit_number, name, rated_power_mw,
          commissioned_on, data_version, published_at, published_at_precision,
          ingested_at, value_digest, source_version_id
        ) values ($1, $2, '1', $1, $3, $4, 1, $5, 'file', $5, $2, $6)
        on conflict do nothing
        """,
        [
            (
                f"PLANT_{point}",
                f"PLANT_{point}-1",
                float(mw),
                datetime(2020, 1, 1, tzinfo=UTC),
                BACKFILL_INGESTED_AT,
                version,
            )
            for point, _, _, mw in points
        ],
    )
    await conn.executemany(
        """
        insert into plant_geo (
          plant_ceg_core, ceg_raw, siga_name, latitude, longitude,
          location_source, municipalities_raw, ownership, observed_on,
          data_version, published_at, published_at_precision, ingested_at,
          value_digest, source_version_id
        ) values ($1, $1, $1, $2, $3, 'siga_coordinate', '', '', $4, 1, $4,
                  'file', $4, $1, $5)
        on conflict do nothing
        """,
        [
            (f"PLANT_{point}", lat, lon, BACKFILL_INGESTED_AT, version)
            for point, lat, lon, _ in points
        ],
    )


async def seed_weather_run_days(
    conn: asyncpg.Connection[Any],
    *,
    run_init: datetime,
    values: Mapping[str, Mapping[datetime, float]],
    data_version: int,
    ingested_at: datetime | None = None,
) -> None:
    """One named model run's `wind_speed_120m`, for the hours it forecasts.

    ``run_init`` is written to ``published_at`` because on this table the run
    initialisation *is* the publication — the check constraint on
    ``weather_forecast_hour`` enforces it — and that identity is the whole of
    what makes the 12Z run a newer vintage of the 00Z run's hours.

    ``data_version`` is the caller's, because a later run revising an hour an
    earlier run already forecast is the ordinary case here and the harness must
    be able to write the two runs in either order.
    """
    cycle = "00Z" if run_init.astimezone(UTC).hour == 0 else "12Z"
    stamp = ingested_at or BACKFILL_INGESTED_AT
    request = await conn.fetchval(
        """
        insert into weather_run_request (
          model, run_init, run_cycle, scheduled_run_init, centroid_set_version,
          centroid_count, variables, forecast_days, request_url, http_status,
          row_count, content_sha256, byte_size
        ) values ('ecmwf_ifs', $1, $2::weather_run_cycle, $1, $3, $4,
                  'wind_speed_120m', 3, 'https://example.invalid/run', 200, $5,
                  $6, 1)
        returning id
        """,
        run_init,
        cycle,
        CENTROID_SET_VERSION,
        len(values),
        sum(len(hours) for hours in values.values()),
        f"harness|{run_init.isoformat()}",
    )
    await conn.executemany(
        """
        insert into weather_forecast_hour (
          centroid_id, valid_time, grid_latitude, grid_longitude,
          grid_elevation_m, run_cycle, run_age_hours, wind_speed120m_kmh,
          data_version, published_at, published_at_precision, ingested_at,
          value_digest, source_request_id
        ) values ($1, $2, 0, 0, 0, $3::weather_run_cycle, 0, $4, $5, $6, 'file',
                  $7, $8, $9)
        """,
        [
            (
                centroid,
                valid_time,
                cycle,
                float(value),
                data_version,
                run_init,
                stamp,
                f"{centroid}|{valid_time.isoformat()}|{data_version}",
                request,
            )
            for centroid, hours in values.items()
            for valid_time, value in hours.items()
        ],
    )


__all__ = [
    "BACKFILL_INGESTED_AT",
    "CENTROID_SET_VERSION",
    "MIGRATED_MARKER",
    "URL_VARIABLE",
    "database_url",
    "local_midnight",
    "reporting_entity",
    "run",
    "seed_observed_day",
    "seed_publication",
    "seed_weather_fleet",
    "seed_weather_run",
    "source_version",
    "truncate",
]
