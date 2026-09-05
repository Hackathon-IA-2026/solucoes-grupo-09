"""The canonical reads, executed against a real Postgres.

Data-platform ticket 18, residual 3. ``canonical_reads.py`` is the modelling
side's whole path to the platform and its SQL was verified by hand against a
throwaway container and by nothing else — so every read here was one refactor
away from breaking with a green suite. ``test_canonical_contract.py`` covers
what can be covered without a server (the manifest, the filter whitelist, the
parameter renumbering); this file covers the half that is only correct or
incorrect against one. ``apps/api/test/database-contract.test.ts`` is the shape
it mirrors.

**What is asserted here that a mock could not be:**

* The views exist, every read resolves to one, and every column the contract
  offers as a filter is a column that view actually has. A filter naming a
  column the view dropped is a ``KeyError`` from Postgres at the worst possible
  moment; a column the view *has* and the contract does not offer is invisible
  to both languages, which is the exact residual this ticket also closes for
  ``subsystem``.
* ``canonical_as_of()`` **raises** rather than defaulting. The fail-closed
  design is a property of a plpgsql function, and no Python test that did not
  call it could tell it from a function that returns ``now()``.
* The as-of pick returns one row per key across a revision, and an earlier
  ``as_of`` returns the earlier belief.
* **The publication cut is applied and is not the as-of cut wearing its
  clothes.** See :func:`test_the_gate_hides_a_run_published_after_it` — that
  test is the reason this file exists in the shape it does.

Gated on ``WATTSTEER_TEST_DATABASE_URL`` like every other database suite here;
``bun run ml:test:db`` from the repository root is the whole recipe, and
``database_harness.py`` documents the container by hand.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import pytest

from database_harness import (
    reporting_entity,
    run,
    seed_observed_day,
    seed_weather_run,
    source_version,
    truncate,
    truncate_weather,
)
from wattsteer_ml.canonical import CANONICAL_READS
from wattsteer_ml.canonical_reads import (
    FILTERABLE,
    ReadAxes,
    apply_axes,
    read_fact,
    read_go_live,
    read_registry,
    view_name,
)

#: A vintage late enough to see everything any test here writes.
NOW = datetime(2026, 6, 1, tzinfo=UTC)

CENTROID = "NE_WIND_HARNESS"


# --- the contract's own shape, against the server -----------------------------


def test_every_read_resolves_to_a_view_that_exists() -> None:
    """Eight names, eight relations. The derivation is not a lookup table."""

    async def work(conn: asyncpg.Connection[Any]) -> None:
        for spec in CANONICAL_READS:
            relation = await conn.fetchval("select to_regclass($1)", view_name(spec.name))
            assert relation is not None, (
                f"{spec.name} derives {view_name(spec.name)}, which does not exist"
            )

    run(work)


def test_every_filterable_column_is_a_column_of_its_view() -> None:
    """The whitelist is interpolated into SQL, so a stale entry is a 42703.

    ``FILTERABLE`` is a hand-written mapping and the only thing that decides
    which columns a caller may restrict on. Nothing else compares it against
    the views, so an entry that outlived its column would surface as an error
    on the first caller that used it rather than here.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        for read, columns in FILTERABLE.items():
            present = {
                record["column_name"]
                for record in await conn.fetch(
                    "select column_name from information_schema.columns "
                    "where table_name = $1",
                    view_name(read),
                )
            }
            assert columns <= present, (
                f"{read} offers {sorted(columns - present)}, "
                f"which {view_name(read)} does not have"
            )

    run(work)


def test_the_subsystem_the_curtailment_view_carries_is_filterable() -> None:
    """Residual 1, from the side that could not see it.

    ``canonical_curtailment_by_reporting_entity`` has projected the reporting
    entity's subsystem since feature-engineering 01 and neither language
    offered it. Asserted as behaviour rather than as a name in a set: the
    filter has to actually restrict.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        version = await source_version(conn)
        north_east = await reporting_entity(conn, code="CJU_NE", subsystem="NE")
        south = await reporting_entity(conn, code="CJU_S", subsystem="S")
        day = datetime(2026, 3, 2, tzinfo=UTC).date()
        for code in (north_east, south):
            await seed_observed_day(
                conn, day=day, hours=[10.0], entity=code, source=version
            )

        both = await read_fact(
            conn,
            "curtailment-by-reporting-entity",
            as_of=NOW,
            window_from=datetime(2026, 3, 1, tzinfo=UTC),
            window_to=datetime(2026, 3, 5, tzinfo=UTC),
        )
        assert {row["subsystem"] for row in both.rows} == {"NE", "S"}

        one = await read_fact(
            conn,
            "curtailment-by-reporting-entity",
            as_of=NOW,
            window_from=datetime(2026, 3, 1, tzinfo=UTC),
            window_to=datetime(2026, 3, 5, tzinfo=UTC),
            filters={"subsystem": "NE"},
        )
        assert one.rows, "a filter that returned nothing would pass vacuously"
        assert {row["reporting_entity_code"] for row in one.rows} == {"CJU_NE"}

    run(work)


# --- fail-closed --------------------------------------------------------------


def test_reading_a_view_without_an_as_of_raises_rather_than_defaulting() -> None:
    """SQLSTATE ``22023``, by design.

    A view that answered latest-version when the axis was forgotten would be
    indistinguishable from a correct answer, which is precisely the failure
    ``AsOf`` exists to prevent. This is the one property of the contract that
    *only* a real server can state.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        with pytest.raises(asyncpg.PostgresError) as raised:
            async with conn.transaction():
                await conn.fetch("select * from canonical_system_context limit 1")
        assert raised.value.sqlstate == "22023"

    run(work)


def test_the_axes_do_not_outlive_their_transaction() -> None:
    """``set_config(..., true)`` is transaction-local, and it has to be.

    The connection is pooled. An axis that leaked would make the *next* read
    answer under the previous one's cut — an answer that is wrong in a way no
    test of that read alone could see.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        async with conn.transaction():
            await apply_axes(conn, ReadAxes(as_of=NOW))
            assert await conn.fetchval("select canonical_as_of()") is not None
        with pytest.raises(asyncpg.PostgresError) as raised:
            async with conn.transaction():
                await conn.fetchval("select canonical_as_of()")
        assert raised.value.sqlstate == "22023"

    run(work)


# --- the as-of pick -----------------------------------------------------------


def test_a_revision_appends_and_the_as_of_chooses_between_the_two() -> None:
    """One row per key, and which row depends on the vintage asked for."""

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        version = await source_version(conn)
        code = await reporting_entity(conn, code="CJU_REVISED")
        day = datetime(2026, 3, 9, tzinfo=UTC).date()
        first = datetime(2026, 3, 10, tzinfo=UTC)
        second = datetime(2026, 4, 10, tzinfo=UTC)
        await seed_observed_day(
            conn, day=day, hours=[11.0], entity=code, source=version, ingested_at=first
        )
        await seed_observed_day(
            conn,
            day=day,
            hours=[22.0],
            entity=code,
            source=version,
            ingested_at=second,
            data_version=2,
        )

        window_from = datetime(2026, 3, 8, tzinfo=UTC)
        window_to = datetime(2026, 3, 12, tzinfo=UTC)
        before = await read_fact(
            conn,
            "curtailment-by-reporting-entity",
            as_of=second - timedelta(days=1),
            window_from=window_from,
            window_to=window_to,
        )
        after = await read_fact(
            conn,
            "curtailment-by-reporting-entity",
            as_of=NOW,
            window_from=window_from,
            window_to=window_to,
        )

        assert len(before.rows) == 1, "an as-of read that fans out is the failure"
        assert len(after.rows) == 1
        assert before.rows[0]["constrained_off_mwh"] == 11.0
        assert after.rows[0]["constrained_off_mwh"] == 22.0
        # Non-vacuous: both versions really are in the base table.
        assert (
            await conn.fetchval(
                "select count(*) from curtailment_report_hour "
                "where reporting_entity_code = $1",
                code,
            )
            == 2
        )

    run(work)


def test_go_live_is_the_first_ingestion_and_is_not_cut_by_the_as_of() -> None:
    """The fidelity rule's only input, and it is a fact about WattSteer."""

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        version = await source_version(conn)
        code = await reporting_entity(conn, code="CJU_GOLIVE")
        first = datetime(2026, 2, 1, tzinfo=UTC)
        await seed_observed_day(
            conn,
            day=datetime(2026, 2, 3, tzinfo=UTC).date(),
            hours=[3.0],
            entity=code,
            source=version,
            ingested_at=first,
        )
        assert (await read_go_live(conn, "curtailment-by-reporting-entity")) == first

    run(work)


# --- the publication cut ------------------------------------------------------


def test_the_gate_hides_a_run_published_after_it() -> None:
    """The defect this file exists to make impossible to reintroduce.

    ``canonical_weather_forecast`` once had **no publication cut at all**, and
    nothing noticed: a late-gate feature read a run three hours in its own
    future while every test passed. The reason it passed is the fixture below,
    inverted — over a backfill every row in the store shares one ``ingested_at``,
    so ``AsOf(gate)`` filters nothing and the publication cut is the only thing
    doing any work. A fixture that gave the two runs honest, ordered ingestion
    instants would let the as-of hide a broken gate and this test would certify
    the bug.

    So both runs are ingested at **one** instant, long before either was
    published, and the assertion has two halves: the gate hides the later run,
    *and* the later run is really there and is really what an un-gated read
    returns. Delete the cut from the view and the second half still passes while
    the first fails, which is the direction a regression test has to fail in.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate_weather(conn)
        ingested = datetime(2026, 1, 1, tzinfo=UTC)
        valid = datetime(2026, 8, 20, 15, tzinfo=UTC)
        before_gate = datetime(2026, 8, 19, 12, tzinfo=UTC)
        after_gate = datetime(2026, 8, 20, 0, tzinfo=UTC)
        gate = datetime(2026, 8, 19, 22, tzinfo=UTC)

        await seed_weather_run(
            conn,
            run_init=before_gate,
            run_cycle="12Z",
            values=[(valid, 40.0)],
            ingested_at=ingested,
        )
        await seed_weather_run(
            conn,
            run_init=after_gate,
            run_cycle="00Z",
            values=[(valid, 99.0)],
            ingested_at=ingested,
            data_version=2,
        )

        window_from = valid - timedelta(hours=1)
        window_to = valid + timedelta(hours=1)
        gated = await read_fact(
            conn,
            "weather-forecast",
            as_of=NOW,
            published_at_or_before=gate,
            window_from=window_from,
            window_to=window_to,
        )
        assert [row["wind_speed120m_kmh"] for row in gated.rows] == [40.0], (
            "the gate let a run published after it into a feature's past"
        )

        # The control. Without the cut, the newest run wins — so the fixture is
        # not passing because the post-gate row is missing or unreachable.
        ungated = await read_fact(
            conn,
            "weather-forecast",
            as_of=NOW,
            window_from=window_from,
            window_to=window_to,
        )
        assert [row["wind_speed120m_kmh"] for row in ungated.rows] == [99.0]

        # And the as-of, alone, cannot tell them apart: this is the sentence the
        # original defect hid behind.
        assert (
            await conn.fetchval(
                "select count(distinct ingested_at) from weather_forecast_hour"
            )
            == 1
        )

    run(work)


def test_the_run_cycle_axis_is_applied_before_the_version_pick() -> None:
    """ "The latest version of the 00Z run" is not "the latest, if it was 00Z".

    Both runs answer the same hour and the 12Z one is newer, so a filter
    applied *after* the ``distinct on`` would return nothing for ``00Z``
    rather than the 00Z row.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate_weather(conn)
        ingested = datetime(2026, 1, 1, tzinfo=UTC)
        valid = datetime(2026, 9, 2, 15, tzinfo=UTC)
        await seed_weather_run(
            conn,
            run_init=datetime(2026, 9, 1, 0, tzinfo=UTC),
            run_cycle="00Z",
            values=[(valid, 21.0)],
            ingested_at=ingested,
        )
        await seed_weather_run(
            conn,
            run_init=datetime(2026, 9, 1, 12, tzinfo=UTC),
            run_cycle="12Z",
            values=[(valid, 34.0)],
            ingested_at=ingested,
            data_version=2,
        )

        window_from = valid - timedelta(hours=1)
        window_to = valid + timedelta(hours=1)
        early = await read_fact(
            conn,
            "weather-forecast",
            as_of=NOW,
            weather_run_cycle="00Z",
            window_from=window_from,
            window_to=window_to,
        )
        assert [row["wind_speed120m_kmh"] for row in early.rows] == [21.0]
        both = await read_fact(
            conn,
            "weather-forecast",
            as_of=NOW,
            window_from=window_from,
            window_to=window_to,
        )
        assert [row["wind_speed120m_kmh"] for row in both.rows] == [34.0]

    run(work)


# --- the registry reads -------------------------------------------------------


def test_a_registry_read_runs_and_needs_both_of_its_instants() -> None:
    """Two axes, neither defaulted. The fleet date is the second.

    Empty rows are the honest answer against an unseeded registry; what is
    being asserted is that the statement executes under the axes the module
    writes, and that omitting the fleet date is a failure rather than a
    plausible answer.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        result = await read_registry(
            conn, "installed-capacity", as_of=NOW, fleet_date=NOW
        )
        assert result.rows == []
        assert result.vintage.fleet_date == NOW

        with pytest.raises(asyncpg.PostgresError) as raised:
            async with conn.transaction():
                await apply_axes(conn, ReadAxes(as_of=NOW))
                await conn.fetch("select * from canonical_installed_capacity")
        assert raised.value.sqlstate == "22023"

    run(work)


def test_every_fact_read_executes_under_its_axes() -> None:
    """A smoke pass over all six fact reads: the SQL is valid, today.

    Zero rows is a fine answer; a column this module names and the view no
    longer projects is not, and neither is a view whose body stopped compiling
    because a base table changed underneath it.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        for spec in CANONICAL_READS:
            if spec.fidelity_axis == "fleet_date":
                continue
            result = await read_fact(
                conn,
                spec.name,
                as_of=NOW,
                window_from=datetime(2026, 5, 1, tzinfo=UTC),
                window_to=datetime(2026, 5, 2, tzinfo=UTC),
            )
            assert result.read == spec.name
            assert result.kind == spec.kind

    run(work)


def test_a_backwards_window_is_refused_rather_than_answered_empty() -> None:
    """An empty result would read as "there was no curtailment"."""

    async def work(conn: asyncpg.Connection[Any]) -> None:
        with pytest.raises(ValueError, match="strictly after"):
            await read_fact(
                conn,
                "system-context",
                as_of=NOW,
                window_from=datetime(2026, 5, 2, tzinfo=UTC),
                window_to=datetime(2026, 5, 1, tzinfo=UTC),
            )

    run(work)
