"""Experiment 2 of `docs/specs/feature-engineering.md` §Seam 7, against Postgres.

The recomputation of the train↔serve gap "on the real aggregate" is a claim
about **which model run answers which hour**, and no fixture can make that
claim: the archive arm is a per-hour publication cut and the served arm is a
per-day one, and whether those two cuts land on different runs is a property of
`canonical_weather_forecast`'s ``distinct on`` and of the gate, not of Python.

Gated exactly like the other database suites — ``WATTSTEER_TEST_DATABASE_URL``
supplies the URL and the default ``pytest`` skips the file. See
`database_harness.py` for the recipe.

What is asserted, in the order it matters:

1. **The two arms resolve different runs.** The served arm reads the D−1 12Z
   run because that is what ``gate_at(D, 'gate_late')`` allows; the archive arm
   reads the D 00Z run, which did not exist at the gate and is the shortest-lead
   slice the Historical Forecast archive is bit-identical to. If those two ever
   resolved the same run the correlation would be 1.0 and would look like a
   finding.
2. **The backfill shape does not empty the read.** Every weather row here is
   ingested in 2026 against a 2024 gate, which is the production shape, and it
   is the shape under which ``feature_apply_gate``'s ``as_of`` used to return
   nothing at all. This file pinned that defect as the measured fact it was
   until ticket 15 fixed it in
   `apps/api/drizzle/0039_the_gate_over_a_backfill.sql`; the last four tests are
   now the evidence of the repair and of the two properties it had to keep — the
   publication cut, and a feature entry point that accepts no instant.
3. **The aggregate is the feature's aggregate.** Capacity-weighted over the real
   frozen centroids through ``canonical_capacity_weight``, refusing an hour a
   centroid did not report rather than renormalising it — a weighted mean over
   the points that happened to be present is a mean over a different fleet.
4. **A hole in the run archive is dropped and counted, never correlated.** An
   hour whose newest available run is older than ``ARCHIVE_MAX_LEAD_HOURS`` is
   not a day-0 slice; treating it as one would quietly turn the control arm into
   a second lead-matched arm and drive ``r`` toward 1.
5. **The figure carries its provenance.** The only path to a published number is
   :meth:`AggregateCorrelation.measured`, so a card either says
   ``weather_forecast_hour`` or says on its face that it is not a measurement.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any

import asyncpg
import pytest

from database_harness import (
    BACKFILL_INGESTED_AT,
    run,
    seed_weather_fleet,
    seed_weather_run_days,
    truncate,
    truncate_weather,
)
from wattsteer_ml.evaluation.collapse_report import FIXTURE_SOURCE
from wattsteer_ml.evaluation.lead_time import (
    PER_POINT_R,
    REVISION_THRESHOLD,
    WEATHER_SERIES_SOURCE,
    AggregateCorrelation,
    CapacityWeights,
    LeadTimeError,
    unmeasured_for_want_of_an_archive,
)
from wattsteer_ml.lanes import Lane
from wattsteer_ml.weather_reads import (
    ARCHIVE_MAX_LEAD_HOURS,
    WeatherReadError,
    read_aggregate_pairs,
    read_capacity_weights,
)

DAY = date(2024, 4, 10)
SUBSYSTEM = "NE"

#: The read's own vintage: training time, which is after the backfill. It is
#: **not** the gate — the gate is a publication cut and is written separately —
#: and the difference between those two axes is the subject of the last test.
AS_OF = datetime(2026, 6, 1, tzinfo=UTC)

#: The three runs that bracket the target day. `weather-job.ts` ingests D−1's
#: two cycles for target day D and writes all three forecast days of each, so
#: the D 00Z run is on disk as target day D+1's own 00Z slot.
D_MINUS_1_00Z = datetime(2024, 4, 9, 0, tzinfo=UTC)
D_MINUS_1_12Z = datetime(2024, 4, 9, 12, tzinfo=UTC)
D_00Z = datetime(2024, 4, 10, 0, tzinfo=UTC)
D_12Z = datetime(2024, 4, 10, 12, tzinfo=UTC)
D_PLUS_1_00Z = datetime(2024, 4, 11, 0, tzinfo=UTC)

#: The 24 hours of Brasília civil day D, written as UTC instants rather than
#: derived, for the reason `local_midnight` gives: the harness must not agree
#: with the code under test about where a local day starts.
HOURS = tuple(
    datetime(2024, 4, 10, 3, tzinfo=UTC) + timedelta(hours=hour) for hour in range(24)
)

#: Where every seeded series is indexed from, so an hour's index is the same
#: number in every run and a value names the run it came from.
EPOCH = datetime(2024, 4, 9, tzinfo=UTC)

#: One level per run, far enough apart that the arm a value came from is
#: readable off the value. The archive arm must resolve the 60/90 pair and the
#: served arm the 30 pair, or the correlation is between two views of one run.
LEVELS: dict[datetime, float] = {
    D_MINUS_1_00Z: 10.0,
    D_MINUS_1_12Z: 30.0,
    D_00Z: 60.0,
    D_12Z: 90.0,
    D_PLUS_1_00Z: 120.0,
}

#: Added to W2 so the two centroids are not the same series and the weighting
#: is doing something.
W2_OFFSET = 4.0


def _value(run_init: datetime, hour_index: int, *, centroid: str) -> float:
    """The seeded forecast, deterministic in the run, the hour and the point.

    The ``% 7`` term is what keeps the two arms from being affine images of each
    other: two series that differ by a constant and a slope correlate at exactly
    1.0, and a fixture that produced that would let a broken read — one where
    both arms resolve the same run — pass as a perfect correlation.
    """
    level = LEVELS[run_init]
    wobble = float((hour_index * 3 + int(level)) % 7)
    offset = W2_OFFSET if centroid == "W2" else 0.0
    return level + offset + 0.5 * hour_index + wobble


def _series(run_init: datetime, centroid: str) -> dict[datetime, float]:
    """One run's forecast over a window wide enough to cover the day from any run.

    Wide, so which run answers an hour is decided by the publication cut and
    never by which run happened to reach that hour.
    """
    return {
        EPOCH + timedelta(hours=hour): _value(run_init, hour, centroid=centroid)
        for hour in range(24 * 3)
    }


def _hour_index(valid_time: datetime) -> int:
    return int((valid_time - EPOCH) / timedelta(hours=1))


def _expected(run_init: datetime, valid_time: datetime) -> float:
    """The capacity-weighted aggregate of one run at one hour: 0.3·W1 + 0.7·W2."""
    index = _hour_index(valid_time)
    return 0.3 * _value(run_init, index, centroid="W1") + 0.7 * _value(
        run_init, index, centroid="W2"
    )


async def _seed(conn: asyncpg.Connection[Any], *, runs: Sequence[datetime] = ()) -> None:
    await truncate(conn)
    # `truncate` no longer clears the weather tables: data-platform 18 split
    # that into `truncate_weather` so a suite cannot empty a table it never
    # writes. This suite writes them, so it clears them.
    await truncate_weather(conn)
    await conn.execute("truncate table centroid_set cascade")
    await conn.execute("truncate table plant cascade")
    await seed_weather_fleet(conn)
    for version, run_init in enumerate(
        runs or (D_MINUS_1_00Z, D_MINUS_1_12Z, D_00Z, D_12Z, D_PLUS_1_00Z), start=1
    ):
        await seed_weather_run_days(
            conn,
            run_init=run_init,
            values={
                "W1": _series(run_init, "W1"),
                "W2": _series(run_init, "W2"),
            },
            data_version=version,
        )


def test_weights_are_the_views_and_sum_to_one() -> None:
    """The vector is read, never computed. `CapacityWeights` refuses any other."""

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        await _seed(conn)
        return await read_capacity_weights(
            conn, subsystem=SUBSYSTEM, fleet_date=DAY, as_of=AS_OF
        )

    weights = run(work)
    assert weights.scope == "NE/wind"
    assert weights.set_version == "centroid_set_v1"
    # 300 MW and 700 MW placed on W1 and W2, so 0.3 and 0.7 — the capacity
    # shares, which is what the view computes and this module never does.
    assert weights.weights == pytest.approx({"W1": 0.3, "W2": 0.7})


def test_a_scope_with_no_located_capacity_is_refused_not_spread() -> None:
    """An even spread over the frozen points would be a fabricated location."""

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        await _seed(conn)
        with pytest.raises(WeatherReadError, match="no located capacity"):
            await read_capacity_weights(conn, subsystem="S", fleet_date=DAY, as_of=AS_OF)

    run(work)


def test_the_two_arms_resolve_different_runs() -> None:
    """The finding the whole experiment rests on: the archive is not the gate.

    Served reads D−1 12Z for every hour of the day, because that is the newest
    run published by ``gate_at(D, 'gate_late')``. Archive reads D 00Z before
    noon and D 12Z after it — the newest run at or before each hour, neither of
    which existed at the gate. Two aggregates of different runs over one fleet,
    which is the pair the research left open.
    """

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        await _seed(conn)
        return await read_aggregate_pairs(
            conn, target_dates=[DAY], subsystem=SUBSYSTEM, as_of=AS_OF
        )

    pairs = run(work)
    assert pairs.hours_requested == 24
    assert pairs.hours_dropped == 0
    assert tuple(pair.valid_time for pair in pairs.pairs) == HOURS

    for pair in pairs.pairs:
        assert pair.lead_matched == pytest.approx(
            _expected(D_MINUS_1_12Z, pair.valid_time)
        ), "the served arm must be the gate's run on every hour of the day"
        stitched = next(
            run_init
            for run_init in (D_PLUS_1_00Z, D_12Z, D_00Z)
            if run_init <= pair.valid_time
        )
        assert pair.archive == pytest.approx(_expected(stitched, pair.valid_time))
        assert pair.archive_lead_hours == pytest.approx(
            (pair.valid_time - stitched) / timedelta(hours=1)
        )
        assert pair.archive_lead_hours < ARCHIVE_MAX_LEAD_HOURS

    # And the two are not the same series seen twice, which is the failure a
    # correlation of 1.0 would look exactly like.
    assert any(pair.archive != pytest.approx(pair.lead_matched) for pair in pairs.pairs)


def test_an_hour_beyond_the_day_zero_lead_is_dropped_and_counted() -> None:
    """A missing run slot is a hole, not an archive reading.

    With both of day D's own runs absent, the newest run at every hour of the
    day is D−1 12Z — the *served* run — and pairing those two would report a
    correlation of exactly 1.0 that says nothing about the archive. The lead
    bound catches it, and the hours are counted rather than silently absent.

    `docs/research/weather-lead-time.md` measured 5 of 112 run slots missing, so
    this is the ordinary degraded case and not a guard against the impossible.
    """

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        await _seed(conn, runs=(D_MINUS_1_00Z, D_MINUS_1_12Z))
        return await read_aggregate_pairs(
            conn, target_dates=[DAY], subsystem=SUBSYSTEM, as_of=AS_OF
        )

    pairs = run(work)
    # Every hour of D is 15 h or more from the D−1 12Z run, so no hour of this
    # day has an archive-equivalent reading at all.
    assert pairs.pairs == ()
    assert pairs.hours_beyond_archive_lead == 24
    assert pairs.hours_dropped == 24


def test_an_hour_a_centroid_did_not_report_is_dropped_not_renormalised() -> None:
    """A weighted mean over the reporters aggregates a different fleet."""

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        await _seed(conn)
        await conn.execute(
            "delete from weather_forecast_hour where centroid_id = 'W2' "
            "and valid_time = $1",
            HOURS[5],
        )
        return await read_aggregate_pairs(
            conn, target_dates=[DAY], subsystem=SUBSYSTEM, as_of=AS_OF
        )

    pairs = run(work)
    assert len(pairs.pairs) == 23
    assert HOURS[5] not in {pair.valid_time for pair in pairs.pairs}
    assert pairs.hours_without_archive == 1


def test_the_published_figure_is_stamped_weather_forecast_hour() -> None:
    """`measured` is the only path to a number a weather decision may rest on."""

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        await _seed(conn)
        return await read_aggregate_pairs(
            conn, target_dates=[DAY], subsystem=SUBSYSTEM, as_of=AS_OF
        )

    correlation = run(work).correlation()
    assert correlation.is_measurement
    assert correlation.correlation_source == WEATHER_SERIES_SOURCE
    assert correlation.variable == "wind_speed_120m"
    assert correlation.scope == "NE/wind"
    assert correlation.points == 24
    assert correlation.per_point_r == PER_POINT_R
    assert correlation.revises_the_gap_downward is (
        correlation.aggregate_r > REVISION_THRESHOLD
    )


def test_the_measurement_lands_on_the_unmeasured_lead_time_block() -> None:
    """Experiment 2 measured, experiment 1 unrun and saying so, on one card.

    The two experiments share a card block because they are one decision, and
    the block that carries them today is the *unmeasured* one: nothing in this
    repository can build the control arm's training features, and a card with no
    block would be indistinguishable from a card whose A/B found no harm.
    """

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        await _seed(conn)
        return await read_aggregate_pairs(
            conn, target_dates=[DAY], subsystem=SUBSYSTEM, as_of=AS_OF
        )

    correlation = run(work).correlation()
    lane = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
    block = unmeasured_for_want_of_an_archive(
        lane=lane, as_of=AS_OF, correlation=correlation
    ).card_block()["lead_time_penalty"]

    assert block["measured"] is False
    assert "does not ingest it" in block["reason"]
    assert block["aggregate_correlation"]["measured"] is True
    source = block["aggregate_correlation"]["correlation_source"]
    assert source == WEATHER_SERIES_SOURCE


def test_a_fabricated_correlation_cannot_claim_the_weather_source() -> None:
    """The seventh idiom is not invented here; the sixth is reused."""
    invented = AggregateCorrelation.fixture(
        scope="NE/wind", set_version="centroid_set_v1", points=24, aggregate_r=0.97
    )
    assert invented.correlation_source == FIXTURE_SOURCE
    assert invented.is_measurement is False


def test_the_variable_cannot_drift_off_the_per_point_figure() -> None:
    """0.88 was measured on `wind_speed_120m`; an aggregate on anything else
    is not comparable with it and must not be published beside it."""
    with pytest.raises(LeadTimeError, match="wind_speed_120m"):
        AggregateCorrelation.measured(
            pairs=[(1.0, 2.0), (3.0, 5.0)],
            variable="shortwave_radiation",
            weights=CapacityWeights(
                set_version="centroid_set_v1", scope="NE/wind", weights={"W1": 1.0}
            ),
        )


def test_the_backfill_window_no_longer_empties_the_weather_block() -> None:
    """The defect this file used to pin, now the evidence that it is fixed.

    Until `0039_the_gate_over_a_backfill.sql` this test asserted ``rows == []``,
    and said so on purpose: `0016_the_feature_gate.sql` claimed of ``as_of``
    that "over the backfill window every row was ingested at go-live, so it
    filters nothing", and it filtered *everything* — ``ingested_at`` is the
    backfill instant, the gate is a D−1 instant two years earlier, and
    ``ingested_at <= canonical_as_of()`` is then false for every row. Every
    historical feature row was weatherless.

    The fixture is the production shape and always was: the weather is ingested
    in 2026 (:data:`BACKFILL_INGESTED_AT`) against a 2024 gate. So this is the
    ticket's own measurement, run the other way round — the same call that
    returned zero rows returns the fleet's weather.

    What repaired it is on the *ingestion* axis alone: `feature_as_of` suspends
    the ingestion cut for a gate that precedes WattSteer's ingestion history,
    because over that window ``ingested_at`` is the loader's clock rather than a
    record of what had been learned. The publication cut is untouched, which is
    the next test.
    """

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        await _seed(conn)
        rows = await conn.fetch(
            "select * from feature_weather_block($1::date, 'gate_late')", DAY
        )
        gate = await conn.fetchval("select gate_at($1::date, 'gate_late')", DAY)
        horizon = await conn.fetchval("select feature_ingestion_history_from()")
        return rows, gate, horizon

    rows, gate, horizon = run(work)
    # Non-vacuous: this really is the backfill shape the defect needed — every
    # row ingested long after the gate it is being read at.
    assert gate < BACKFILL_INGESTED_AT
    assert gate < horizon

    day = [row for row in rows if row["valid_time"] in HOURS]
    assert len(day) == 24, "one row per hour of the local day, for the one scope"
    assert all(row["subsystem"] == SUBSYSTEM for row in day)
    # And they carry weather rather than being a spine of holes.
    assert all(row["weather_wind_speed_120m"] is not None for row in day)
    assert all(row["weather_centroid_coverage"] == pytest.approx(1.0) for row in day)


def test_the_publication_cut_survives_the_repair() -> None:
    """A ``gate_late`` feature still cannot read a run published after its gate.

    That cut was itself a defect fixed earlier in this spec —
    `canonical_weather_forecast` carried none, so a late-gate feature read the
    D 00Z run three hours in its own future — and the repair above must not have
    bought the weather back by relaxing it. The fixture holds the D 00Z and
    D 12Z runs, which are the newest version of every hour of the day and were
    ingested at the same instant as the D−1 12Z run, so an ingestion cut alone
    cannot tell them apart. Only ``published_at <= gate`` can.

    The assertion is on the value rather than on a row count, because a block
    reading the wrong run returns exactly as many rows as one reading the right
    one: the runs are levelled 30 / 60 / 90 km/h apart so the arm a number came
    from is readable off the number.
    """

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        await _seed(conn)
        post_gate = await conn.fetchval(
            """
            select count(*) from weather_forecast_hour
            where published_at > gate_at($1::date, 'gate_late')
            """,
            DAY,
        )
        rows = await conn.fetch(
            "select * from feature_weather_block($1::date, 'gate_late')", DAY
        )
        return post_gate, rows

    post_gate, rows = run(work)
    # Non-vacuous: runs from the gate's own future really were there to be read.
    assert post_gate > 0

    by_hour = {row["valid_time"]: row for row in rows}
    for hour in HOURS:
        assert by_hour[hour]["weather_wind_speed_120m"] == pytest.approx(
            _expected(D_MINUS_1_12Z, hour)
        ), "the block must read the newest run published at or before the gate"


def test_a_fleet_with_no_readable_run_yields_coverage_zero_and_not_silence() -> None:
    """Coverage 0 and "the axis filtered everything" must not look the same.

    `0029` promises a spine row per subsystem-hour *before* the weather is
    joined, so that a subsystem-hour no centroid reported arrives as coverage 0
    rather than as an absent row. Under the defect there was no spine at all,
    because `canonical_capacity_weight` was read under the same emptied axis and
    the block had no fleet to build one from — so a weatherless day and a
    filtered-out day were the same answer.

    Here the fleet is seeded and the only runs are published *after* the gate,
    so the publication cut legitimately removes every reading. The day still has
    its rows, and they say coverage 0.
    """

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        await _seed(conn, runs=(D_00Z, D_PLUS_1_00Z))
        return await conn.fetch(
            "select * from feature_weather_block($1::date, 'gate_late')", DAY
        )

    rows = run(work)
    day = [row for row in rows if row["valid_time"] in HOURS]
    assert len(day) == 24
    assert all(row["weather_centroid_coverage"] == pytest.approx(0.0) for row in day)
    assert all(row["weather_wind_speed_120m"] is None for row in day)


def test_the_feature_entry_point_still_accepts_no_instant() -> None:
    """The property that makes train/serve skew unwritable, asked of the server.

    `features-gate.test.ts` asserts this against the migration text, which is
    the copy that catches a parameter being *written*. This one asks the
    catalogue, which is the copy that catches one being written somewhere the
    text scan does not read — and it is the same question ticket 15 had to be
    able to answer "no" to while repairing the axis: the fix could have been
    bought for one ``as_of`` argument, and an argument is exactly the door this
    spine has none of.

    ``feature_as_of`` is in the same assertion because it is the function ticket
    15 added, and a new derivation of the vintage is precisely where an instant
    would next be tempting to accept.
    """

    async def work(conn: asyncpg.Connection[Any]) -> Any:
        return await conn.fetch(
            """
            select p.proname, pg_get_function_arguments(p.oid) as arguments
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in (
                'feature_rows', 'feature_as_of', 'feature_apply_gate',
                'feature_apply_gate_for_fleet_offset', 'actuals_cutoff'
              )
            """
        )

    rows = run(work)
    signatures = {row["proname"]: row["arguments"] for row in rows}
    assert signatures["feature_rows"] == (
        "target_from date, target_to date, gate_profile text, feature_set text, "
        "threshold_mw double precision"
    )
    # Not one of them takes an instant, and every one of them derives the gate
    # from a target date instead.
    for name, arguments in signatures.items():
        assert "timestamp" not in arguments, name
        assert "target_date date" in arguments or name == "feature_rows", name
