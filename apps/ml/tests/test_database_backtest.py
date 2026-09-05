"""The Backtest against a real Postgres, and against a real go-live boundary.

Replay ticket 08's other half. ``test_backtest_aggregate.py`` exercises the
aggregation over days built from fixtures; this file runs the whole recompute —
the calendar, one :func:`~wattsteer_ml.replay.inputs.read_replay_inputs` and one
:func:`~wattsteer_ml.replay.scoring.score_replay` per replayable day against the
published ``REFERENCE_FLEET`` — over rows a database actually holds, and asserts
the two things only a database can be wrong about:

**The straddling fold is split by the go-live the database reports, not by a
date anybody wrote down.** The seeded curtailment rows are ingested mid-F3, so
``canonical_read_go_live`` puts ``T_go`` inside that quarter and the fold comes
back as ``F3@revision_optimistic`` and ``F3@point_in_time`` — four days each,
never eight averaged. Nothing in `backtest.py` names 2025-11-16; move the
seeder's ``ingested_at`` and the boundary moves with it.

**A Backtest number is the replay numbers it aggregates.** Every day of the
window is replayed a *second* time here, by hand, through the same two functions
— and the row's total, mean gap and floor coverage are asserted against those
replays. A second scoring implementation on the aggregate's side of the seam
would show up as a total that no per-day replay reproduces.

Gated on ``WATTSTEER_TEST_DATABASE_URL`` like every other database suite here;
see ``database_harness.py`` for the recipe.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from database_harness import (
    reporting_entity,
    run,
    seed_observed_day,
    seed_publication,
    source_version,
    truncate,
)
from wattsteer_ml.evaluation import FOLD_CALENDAR_RULES
from wattsteer_ml.lanes import Lane
from wattsteer_ml.replay.backtest import Backtest, BacktestCache, recompute_backtest
from wattsteer_ml.replay.calendar import ReplayDay, build_calendar
from wattsteer_ml.replay.cards import ArtifactWindows
from wattsteer_ml.replay.inputs import read_replay_inputs
from wattsteer_ml.replay.reads import read_calendar_evidence
from wattsteer_ml.replay.scoring import ReplayScores, score_replay
from wattsteer_ml.replay.shortlist import reference_fleet_hash, reference_fleet_scenario

LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
SUBSYSTEM = "NE"

#: Ingestion go-live, as the *database* will report it: the earliest
#: ``ingested_at`` of the one read a replayed day's actuals depend on. Mid-F3 on
#: purpose, so the quarter straddles it.
GO_LIVE = datetime(2025, 11, 16, 3, 0, tzinfo=UTC)

#: Four days before the boundary and four after it, all inside F3.
BEFORE = (date(2025, 11, 10), date(2025, 11, 11), date(2025, 11, 12), date(2025, 11, 13))
AFTER = (date(2025, 11, 18), date(2025, 11, 19), date(2025, 11, 20), date(2025, 11, 21))
SEEDED = (*BEFORE, *AFTER)

LATEST = date(2025, 12, 31)
AS_OF = datetime(2026, 6, 1, tzinfo=UTC)
ARTIFACT_ID = "F3__2025-10-01T03:10:00Z"

#: The card the held-out assertion runs against. Both windows close before the
#: seeded days open, which is what makes every one of them replayable.
WINDOWS = ArtifactWindows(
    artifact_id=ARTIFACT_ID,
    fold_id="F3",
    lane=LANE.directory_name,
    train_start=date(2024, 4, 1),
    train_end=date(2025, 9, 30),
    calibration_start=date(2025, 7, 3),
    calibration_end=date(2025, 9, 30),
)
CARDS = {ARTIFACT_ID: WINDOWS}

#: A day with a three-hour episode in the afternoon and nothing either side.
SHAPE = (
    *(0.0,) * 12,
    40.0,
    100.0,
    60.0,
    *(0.0,) * 9,
)


def scaled(offset: int) -> tuple[float, ...]:
    """Descending day sizes, so the avoidability distribution has a shape."""
    return tuple(value * (1.0 - offset * 0.05) for value in SHAPE)


def observed_for(offset: int) -> tuple[float, ...]:
    """What actually happened: above the pinned P50 on most days, well under on one.

    The under-forecast day is there so `days_forecast_underestimated` and the
    floor-coverage share are both exercised against something other than a
    column of identical days.
    """
    factor = 0.2 if offset == 5 else 1.1
    return tuple(value * factor for value in scaled(offset))


async def seed(conn: asyncpg.Connection[Any]) -> None:
    await truncate(conn)
    version = await source_version(conn)
    entity = await reporting_entity(conn, subsystem=SUBSYSTEM)
    for offset, day in enumerate(SEEDED):
        p50 = scaled(offset)
        await seed_observed_day(
            conn,
            day=day,
            hours=observed_for(offset),
            subsystem=SUBSYSTEM,
            entity=entity,
            # The instant the boundary is derived from. Every row shares it, so
            # `canonical_read_go_live` reports exactly this.
            ingested_at=GO_LIVE,
            source=version,
        )
        await seed_publication(
            conn,
            day=day,
            p10=tuple(value * 0.4 for value in p50),
            p50=p50,
            p90=tuple(value * 1.5 for value in p50),
            run_label=ARTIFACT_ID,
            origin_kind="backfilled_holdout",
            subsystem=SUBSYSTEM,
            ingested_at=GO_LIVE,
        )


def write_cards(root: Path) -> None:
    """The artifact volume the held-out assertion is checked against."""
    lane_dir = root / LANE.directory_name
    lane_dir.mkdir(parents=True, exist_ok=True)
    (lane_dir / f"{WINDOWS.artifact_id}.card.json").write_text(
        json.dumps(
            {
                "fold": {"fold_id": WINDOWS.fold_id},
                "lane": {"directory": WINDOWS.lane},
                "data": {
                    "training_window": {
                        "start": WINDOWS.train_start.isoformat(),
                        "end": WINDOWS.train_end.isoformat(),
                    },
                    "calibration_window": {
                        "start": WINDOWS.calibration_start.isoformat(),
                        "end": WINDOWS.calibration_end.isoformat(),
                    },
                },
            }
        ),
        encoding="utf-8",
    )


async def compute(conn: asyncpg.Connection[Any]) -> Backtest:
    return await recompute_backtest(
        conn,
        subsystem=SUBSYSTEM,
        lane=LANE,
        rules=FOLD_CALENDAR_RULES,
        windows_for=CARDS.get,
        as_of=AS_OF,
        latest=LATEST,
    )


async def replay_one(conn: asyncpg.Connection[Any], target_date: date) -> ReplayScores:
    """One day, replayed by hand — the comparison the aggregate is checked against."""
    inputs = await read_replay_inputs(
        conn,
        subsystem=SUBSYSTEM,
        target_date=target_date,
        lane=LANE,
        forecast_origin=None,
        as_of=AS_OF,
    )
    assert inputs.forecast is not None
    assert inputs.observed is not None
    calendar_day = await _calendar_day(conn, target_date)
    return score_replay(
        reference_fleet_scenario(SUBSYSTEM, target_date),
        day=calendar_day,
        windows=WINDOWS,
        forecast=inputs.forecast,
        observed=inputs.observed,
    )


async def _calendar_day(conn: asyncpg.Connection[Any], target_date: date) -> ReplayDay:
    evidence = await read_calendar_evidence(
        conn,
        subsystem=SUBSYSTEM,
        lane=LANE,
        window_start=target_date,
        window_end=target_date,
        as_of=AS_OF,
    )
    calendar = build_calendar(
        evidence.days,
        subsystem=SUBSYSTEM,
        lane=LANE.directory_name,
        rules=FOLD_CALENDAR_RULES,
        window_start=target_date,
        window_end=target_date,
        latest=LATEST,
        windows_for=CARDS.get,
        sources=evidence.sources,
    )
    return calendar.days[0]


def test_a_fold_straddling_the_databases_own_go_live_is_two_rows() -> None:
    """`replay.md` seam 9, against the instant Postgres reports rather than a constant."""

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await seed(conn)
        computed = await compute(conn)

        rows = computed.rows_of("F3")
        assert len(rows) == 2, computed.row_ids
        early = computed.row("F3@revision_optimistic")
        late = computed.row("F3@point_in_time")
        assert early.days_replayed == len(BEFORE)
        assert late.days_replayed == len(AFTER)
        assert early.segment.test_start == date(2025, 10, 1)
        assert late.segment.test_end == date(2025, 12, 31)
        # The two halves meet at the boundary and do not overlap it.
        assert early.segment.test_end + timedelta(days=1) == late.segment.test_start
        # Neither half is the whole quarter, which is what averaging would look
        # like from the outside.
        assert early.days_replayed + late.days_replayed == len(SEEDED)

        # Every fold of the calendar has a row, including the ones nothing was
        # seeded in: an absence with a fold id, not a missing row.
        assert {row.segment.fold_id for row in computed.rows} == {"F1", "F2", "F3"}
        for row in computed.rows:
            if row.segment.fold_id != "F3":
                assert row.days_replayed == 0
                assert row.metrics is None

    run(work)


def test_a_backtest_number_is_the_replay_numbers_it_aggregates() -> None:
    """Every figure re-derived from eight hand-run replays of the same rows."""

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await seed(conn)
        computed = await compute(conn)
        replays = {day: await replay_one(conn, day) for day in SEEDED}

        for row_id, population in (
            ("F3@revision_optimistic", BEFORE),
            ("F3@point_in_time", AFTER),
        ):
            row = computed.row(row_id)
            assert row.metrics is not None
            scored = [replays[day] for day in population]
            assert row.metrics.total_recovered_mwh == pytest.approx(
                sum(one.observed_scoring.recovered_mwh for one in scored)
            )
            assert row.metrics.mean_forecast_value_gap_mwh == pytest.approx(
                sum(one.upper_bound.forecast_value_gap_mwh for one in scored)
                / len(scored)
            )
            assert row.metrics.days_forecast_underestimated == sum(
                1 for one in scored if one.forecast.day_total.p50 < one.observed.total_mwh
            )
            coverage = row.by_subsystem[0]
            assert coverage.subsystem == SUBSYSTEM
            assert coverage.days_floor_met == sum(1 for one in scored if one.floor_met)
            assert coverage.floor_coverage == pytest.approx(
                coverage.days_floor_met / len(scored)
            )
            # And every day in the row carried the row's own caveat.
            for day in population:
                assert replays[day].day.vintage_fidelity == row.vintage_fidelity

    run(work)


def test_the_aggregate_is_deterministic_and_stamped_with_the_reference_fleet() -> None:
    """Twice over the same rows: the same rows, the same id, the same fleet."""

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await seed(conn)
        first = await compute(conn)
        second = await compute(conn)
        assert first.computation_id == second.computation_id
        assert [row.as_payload() for row in first.rows] == [
            row.as_payload() for row in second.rows
        ]
        assert first.reference_fleet_hash == reference_fleet_hash()

    run(work)


def test_the_nightly_job_has_one_call_that_fills_the_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`POST /internal/replay/backtest`, end to end, over real rows.

    The route is what `GET /v1/backtest` serves from, and the aggregate it
    caches is the one the recompute produced — not a second computation on the
    request path, which at ~13 s over the replayable window would be an upstream
    timeout rather than an answer.
    """
    from fastapi.testclient import TestClient

    from database_harness import database_url
    from wattsteer_ml import app as app_module
    from wattsteer_ml.config import settings
    from wattsteer_ml.database import Database

    url = database_url()
    write_cards(tmp_path)
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    run(seed)
    monkeypatch.setattr(app_module, "database", Database(url))
    monkeypatch.setattr(app_module, "backtest_cache", BacktestCache())

    with TestClient(app_module.app) as client:
        refreshed = client.post(
            "/internal/replay/backtest",
            json={"subsystem": SUBSYSTEM, "lane": LANE.directory_name},
        )
        assert refreshed.status_code == 200, refreshed.text
        served = client.get(
            "/v1/backtest",
            params={
                "fold": "F3",
                "subsystem": SUBSYSTEM,
                "lane": LANE.directory_name,
            },
        )
        assert served.status_code == 200, served.text
        unknown = client.get(
            "/v1/backtest",
            params={
                "fold": "F9",
                "subsystem": SUBSYSTEM,
                "lane": LANE.directory_name,
            },
        )

    body = served.json()
    assert body["state"] == "ready"
    assert body["computation_id"] == refreshed.json()["computation_id"]
    assert [row["row_id"] for row in body["rows"]] == [
        "F3@revision_optimistic",
        "F3@point_in_time",
    ]
    for row in body["rows"]:
        assert row["vintage_fidelity"] in {"revision_optimistic", "point_in_time"}
    # No headline over the two rows, here or anywhere in the contract.
    assert "total_recovered_mwh" not in body
    assert "floor_coverage" not in body

    # A fold this calendar does not have is a refusal, not an empty table that
    # would read as "that quarter replayed nothing".
    assert unknown.status_code == 422
    assert unknown.json()["error"]["code"] == "REQUEST_INVALID"
