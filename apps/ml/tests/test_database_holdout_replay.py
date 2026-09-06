"""A `fold_holdout` date answers with a replay — forecaster 23, against Postgres.

The acceptance line the ticket writes as "`/v1/replay` on a `fold_holdout` date
returns the replay rather than `REPLAY_FORECAST_UNAVAILABLE`, asserted against
real Postgres". Everything on the read side was already built and correct;
nothing had ever *written* a `backfilled_holdout` row, so the clause

    ∃ Forecast rows for (subsystem, d) with origin_kind ∈
      {served, backfilled_holdout}

was false for every day of F1–F5 and the endpoint refused all of them.

What is asserted here is the whole read path over rows that are in the table:
:func:`~wattsteer_ml.replay.reads.read_calendar_evidence` — the two statements
the endpoint runs, at the endpoint's own ``AsOf`` axis — into
:func:`~wattsteer_ml.replay.calendar.build_calendar`, which is what
``GET /v1/replay/days/{date}`` resolves a day through. The day comes back
replayable, with ``provenance = fold_holdout``, and naming the artifact and both
windows that held it out.

**The refusal is asserted first, on the same database.** A test that only showed
the day resolving would not distinguish "the writer fixed it" from "it was never
broken". So the calendar is built once with the table empty — one
``REPLAY_FORECAST_UNAVAILABLE`` — and once with the rows a backtest run writes.

Gated exactly like the other database suites: `WATTSTEER_TEST_DATABASE_URL`
supplies the URL and the default `uv run pytest` skips this file.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

import asyncpg

from database_harness import (
    reporting_entity,
    run,
    seed_observed_day,
    seed_publication,
    source_version,
    truncate,
)
from wattsteer_ml.canonical import VintageSource
from wattsteer_ml.evaluation import FOLD_CALENDAR_RULES
from wattsteer_ml.lanes import Lane
from wattsteer_ml.publication import BACKFILLED_HOLDOUT_ORIGIN_KIND
from wattsteer_ml.replay.calendar import build_calendar
from wattsteer_ml.replay.cards import ArtifactWindows
from wattsteer_ml.replay.reads import read_calendar_evidence

LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
SUBSYSTEM = "NE"
AS_OF = datetime(2026, 6, 1, tzinfo=UTC)

#: A day inside F3's test period — `revision_optimistic`, pre-go-live, and one
#: of the days `/v1/replay` refused before anything wrote a row for it.
DAY = date(2025, 11, 12)

#: The fold artifact, under the id `holdout_backfill.fold_artifact_id` mints:
#: F3's ``quarter_end`` at midnight UTC, which is the same string on every pass.
ARTIFACT_ID = "2025-12-31T00:00:00Z"

#: The card that artifact wrote, as `replay/cards.py` reads it back. Both
#: windows exclude `DAY`, which is the property `assert_held_out` re-checks at
#: read time and the one the driver refuses to mint a row without.
F3 = ArtifactWindows(
    artifact_id=ARTIFACT_ID,
    fold_id="F3",
    lane=LANE.directory_name,
    train_start=date(2024, 4, 1),
    train_end=date(2025, 9, 30),
    calibration_start=date(2025, 7, 3),
    calibration_end=date(2025, 9, 30),
)

P50: tuple[float, ...] = tuple(
    (0.0,) * 10 + (20.0, 70.0, 110.0, 90.0, 30.0, 10.0) + (0.0,) * 8
)
P10: tuple[float, ...] = tuple(value * 0.4 for value in P50)
P90: tuple[float, ...] = tuple(value * 1.5 for value in P50)
OBSERVED: tuple[float, ...] = tuple(value * 1.2 for value in P50)

SOURCES = (
    VintageSource(
        read="curtailment-by-reporting-entity",
        vintage_fidelity="revision_optimistic",
        go_live_at=datetime(2026, 7, 1, tzinfo=UTC),
    ),
)


async def _calendar(conn: asyncpg.Connection[Any]) -> Any:
    """The one day, resolved exactly as ``GET /v1/replay/days/{date}`` does."""
    evidence = await read_calendar_evidence(
        conn,
        subsystem=SUBSYSTEM,
        lane=LANE,
        window_start=DAY,
        window_end=DAY,
        as_of=AS_OF,
    )
    return build_calendar(
        evidence.days,
        subsystem=SUBSYSTEM,
        lane=LANE.directory_name,
        rules=FOLD_CALENDAR_RULES,
        window_start=DAY,
        window_end=DAY,
        latest=date(2026, 5, 31),
        # The card the driver saved beside the bundle before minting a row. It
        # takes an artifact id and nothing else — there is no "current" to fall
        # back to, which is what keeps the serving artifact out of a replay.
        windows_for=lambda artifact_id: F3 if artifact_id == ARTIFACT_ID else None,
        sources=SOURCES,
    )


def test_a_fold_holdout_day_refuses_until_a_backtest_run_has_written_it() -> None:
    """The before and the after, on one database, in one test.

    Separating them would let the first half pass against a table some other
    test had already filled, which is the failure mode that makes a guard read
    green while governing nothing.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        version = await source_version(conn)
        entity = await reporting_entity(conn)
        # The observed day exists throughout: the clause under test is the
        # forecast one, and a day short of twenty-four settled hours would
        # refuse for a different reason and prove nothing about this one.
        await seed_observed_day(
            conn, day=DAY, hours=OBSERVED, entity=entity, source=version
        )

        before = (await _calendar(conn)).days[0]
        assert before.refusal is not None
        assert before.refusal.code == "REPLAY_FORECAST_UNAVAILABLE"
        assert before.refusal.status == 404
        assert before.provenance is None
        assert before.held_out_by is None

        # What a backtest run appends: the composed band for a held-out day,
        # under the fold artifact's id and the reconstruction's discriminator.
        await seed_publication(
            conn,
            day=DAY,
            p10=P10,
            p50=P50,
            p90=P90,
            run_label=ARTIFACT_ID,
            origin_kind=BACKFILLED_HOLDOUT_ORIGIN_KIND,
        )

        after = (await _calendar(conn)).days[0]
        assert after.refusal is None
        assert after.replayable
        assert after.provenance == "fold_holdout"
        # The vintage axis stays separate from the in-sample one: this day is
        # held out *and* revision-optimistic, and neither statement is the other.
        assert after.vintage_fidelity == "revision_optimistic"

        # The fold identity, off the row's `run_label` and the card it names.
        held = after.held_out_by
        assert held is not None
        assert held.fold == "F3"
        assert held.artifact_id == ARTIFACT_ID
        assert held.train_window == (F3.train_start, F3.train_end)
        assert held.calibration_window == (F3.calibration_start, F3.calibration_end)
        assert after.as_payload()["model_saw_this_day"] is False

    run(work)


def test_a_second_backtest_run_supersedes_rather_than_duplicating() -> None:
    """One fold, one artifact id, two ingestion instants — a vintage, not a pair.

    The driver derives the artifact id from the fold's ``quarter_end``, so a
    rerun writes the same ``run_label``. That is what makes the second pass a
    newer vintage of one reconstruction: ``PUBLISHED_DAYS_SQL`` is
    ``distinct on`` the lane key, and two reconstructions under two ids would
    be ranked by a ``published_at`` and a ``data_version`` that are equal.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        version = await source_version(conn)
        entity = await reporting_entity(conn)
        await seed_observed_day(
            conn, day=DAY, hours=OBSERVED, entity=entity, source=version
        )
        for data_version, ingested_at in (
            (1, datetime(2026, 1, 1, tzinfo=UTC)),
            (2, datetime(2026, 2, 1, tzinfo=UTC)),
        ):
            await seed_publication(
                conn,
                day=DAY,
                p10=P10,
                p50=P50,
                p90=P90,
                run_label=ARTIFACT_ID,
                origin_kind=BACKFILLED_HOLDOUT_ORIGIN_KIND,
                data_version=data_version,
                ingested_at=ingested_at,
                day_total=(1.0, float(data_version), 3.0),
            )

        day = (await _calendar(conn)).days[0]
        assert day.replayable
        assert day.held_out_by is not None
        assert day.held_out_by.artifact_id == ARTIFACT_ID

        # And the older vintage is still reconstructible at its own as-of — the
        # property that makes a shared replay link keep meaning what it meant.
        rows = await conn.fetch(
            "select data_version, day_total_p50_mwh from curtailment_forecast_day "
            "where subsystem = $1::subsystem_code and target_date = $2::date "
            "and run_label = $3 order by data_version",
            SUBSYSTEM,
            DAY,
            ARTIFACT_ID,
        )
        # Two vintages of one reconstruction, side by side, neither overwritten.
        assert [int(row["data_version"]) for row in rows] == [1, 2]
        assert [float(row["day_total_p50_mwh"]) for row in rows] == [1.0, 2.0]

    run(work)
