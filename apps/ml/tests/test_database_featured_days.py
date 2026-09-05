"""The featured days, against a real Postgres — and against a rerun.

Replay ticket 07's other half. ``test_replay_featured_days.py`` exercises the
rule over hand-built candidates; this file runs the whole recompute — the
calendar, one :func:`~wattsteer_ml.replay.inputs.read_replay_inputs` and one
:func:`~wattsteer_ml.replay.scoring.score_replay` per replayable day, against
the published ``REFERENCE_FLEET`` — over rows a database actually holds, and
then asserts the two things only a database can be wrong about:

**A day that missed its promised floor is found by the query rather than
declared.** Ten replayable days are seeded, nine of them well inside their
floor. The tenth came in at a twentieth of the forecast, so the plan built on
the pinned P50 recovered far less than the P10 column promised at D−1 — and it
is the *smallest* day in the window, which every other clause excludes. It is
featured.

**A rerun invalidates the shortlist even though the origin does not move.** A
``backfilled_holdout`` row's ``published_at`` **is** ``gate_at(target_date,
gate_profile)``, so a second backtest run of the same day carries the identical
publication instant and ``forecast_origin`` cannot tell the two apart. The
``computation_id`` can, because it is a digest over the numbers that came back
and not over the origin that produced them.

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
from wattsteer_ml.replay.cards import ArtifactWindows
from wattsteer_ml.replay.featured import (
    FEATURED_DAY_COUNT,
    FEATURED_RULE_SENTENCE,
    WORST_FLOOR_SHORTFALL,
)
from wattsteer_ml.replay.shortlist import (
    FeaturedDaysCache,
    FeaturedDaysComputation,
    recompute_featured_days,
)

LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
SUBSYSTEM = "NE"
#: Ten consecutive days inside F3's test period, which the F3 artifact held out.
FIRST_DAY = date(2025, 11, 1)
DAY_COUNT = 10
LATEST = date(2025, 12, 1)
AS_OF = datetime(2026, 6, 1, tzinfo=UTC)
ARTIFACT_ID = "F3__2025-10-01T03:10:00Z"
SERVED_ARTIFACT_ID = "F5__2026-01-05T03:10:00Z"

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
SERVED_WINDOWS = ArtifactWindows(
    artifact_id=SERVED_ARTIFACT_ID,
    fold_id="F5",
    lane=LANE.directory_name,
    train_start=date(2024, 4, 1),
    train_end=date(2025, 9, 30),
    calibration_start=date(2025, 7, 3),
    calibration_end=date(2025, 9, 30),
)
CARDS = {
    ARTIFACT_ID: WINDOWS,
    SERVED_ARTIFACT_ID: SERVED_WINDOWS,
}

#: A day with one clear episode. Scaled per day so the ten differ in size.
SHAPE: tuple[float, ...] = (
    *(0.0,) * 10,
    20.0,
    70.0,
    110.0,
    90.0,
    30.0,
    10.0,
    *(0.0,) * 8,
)

#: The day that missed its floor. Not the biggest, not the worst-forecast in
#: absolute MWh — the *smallest*, so that only the mandatory clause can seat it.
MISS_OFFSET = 9


def day_at(offset: int) -> date:
    return FIRST_DAY + timedelta(days=offset)


def scaled(offset: int) -> tuple[float, ...]:
    """Descending day sizes: offset 0 is the biggest, offset 9 the smallest."""
    return tuple(value * (1.0 - offset * 0.08) for value in SHAPE)


def observed_for(offset: int) -> tuple[float, ...]:
    """What actually happened.

    Every day but the last came in slightly above the pinned P50, so its plan
    recovered comfortably more than the P10 column promised. The last came in at
    a twentieth of it, so the plan — built at the gate on the P50 and never
    rebuilt — had nothing like the energy it had scheduled, and the day fell
    below its own floor.
    """
    profile = scaled(offset)
    factor = 0.05 if offset == MISS_OFFSET else 1.1
    return tuple(value * factor for value in profile)


async def seed(conn: asyncpg.Connection[Any]) -> None:
    await truncate(conn)
    version = await source_version(conn)
    entity = await reporting_entity(conn, subsystem=SUBSYSTEM)
    for offset in range(DAY_COUNT):
        p50 = scaled(offset)
        await seed_observed_day(
            conn,
            day=day_at(offset),
            hours=observed_for(offset),
            subsystem=SUBSYSTEM,
            entity=entity,
            source=version,
        )
        await seed_publication(
            conn,
            day=day_at(offset),
            p10=tuple(value * 0.4 for value in p50),
            p50=p50,
            p90=tuple(value * 1.5 for value in p50),
            # Two provenance classes in the window, so the clause that requires
            # one day from each has something to require.
            run_label=SERVED_ARTIFACT_ID if offset % 5 == 4 else ARTIFACT_ID,
            origin_kind="served" if offset % 5 == 4 else "backfilled_holdout",
            subsystem=SUBSYSTEM,
        )


def _write_cards(root: Path) -> None:
    """The artifact volume the held-out assertion is checked against.

    Real card files rather than a patched reader: "the promoted artifact is
    never consulted" is only a property when the route does its own resolution
    off the volume.
    """
    lane_dir = root / LANE.directory_name
    lane_dir.mkdir(parents=True, exist_ok=True)
    for windows in CARDS.values():
        (lane_dir / f"{windows.artifact_id}.card.json").write_text(
            json.dumps(
                {
                    "fold": {"fold_id": windows.fold_id},
                    "lane": {"directory": windows.lane},
                    "data": {
                        "training_window": {
                            "start": windows.train_start.isoformat(),
                            "end": windows.train_end.isoformat(),
                        },
                        "calibration_window": {
                            "start": windows.calibration_start.isoformat(),
                            "end": windows.calibration_end.isoformat(),
                        },
                    },
                }
            ),
            encoding="utf-8",
        )


async def compute(conn: asyncpg.Connection[Any]) -> FeaturedDaysComputation:
    return await recompute_featured_days(
        conn,
        subsystem=SUBSYSTEM,
        lane=LANE,
        rules=FOLD_CALENDAR_RULES,
        windows_for=CARDS.get,
        as_of=AS_OF,
        latest=LATEST,
    )


def test_the_day_that_missed_its_floor_is_featured_however_small_it_was() -> None:
    """The acceptance criterion the whole ticket rests on, end to end.

    Nothing here labels the day. The rule runs
    ``min(scored.observed.recovered − recovered_floor)`` over every replayable
    day of the window, and the day that comes out is the one the seeder made
    fail — which is also the smallest day in the window and the one every other
    clause passes over.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await seed(conn)
        computed = await compute(conn)
        featured = computed.featured

        assert featured.evaluated_days == DAY_COUNT
        assert len(featured.days) == FEATURED_DAY_COUNT
        assert featured.rule == FEATURED_RULE_SENTENCE
        assert featured.missed_floor is True

        miss = day_at(MISS_OFFSET)
        entry = next(one for one in featured.days if one.target_date == miss)
        assert WORST_FLOOR_SHORTFALL in {one.criterion for one in entry.reasons}
        assert entry.floor_met is False
        assert entry.floor_margin_mwh < 0
        # It is on the list *only* because of that clause: it is the smallest
        # day in the window, so no size-based criterion could have seated it.
        assert entry.observed_total_mwh == min(
            one.observed_total_mwh for one in featured.days
        )

        # And every populated class is represented, per the acceptance list.
        for provenance in featured.populated_provenances:
            assert provenance in {one.provenance for one in featured.days}
        for fidelity in featured.populated_vintage_fidelities:
            assert fidelity in {one.vintage_fidelity for one in featured.days}

    run(work)


def test_the_query_is_deterministic_given_the_data() -> None:
    """Twice over the same rows: the same dates, the same reasons, the same id."""

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await seed(conn)
        first = await compute(conn)
        second = await compute(conn)
        assert first.computation_id == second.computation_id
        assert first.featured.as_payload() == second.featured.as_payload()
        assert first.reference_fleet_hash == second.reference_fleet_hash

    run(work)


def test_a_rerun_moves_the_computation_id_though_the_origin_cannot() -> None:
    """The invalidation the cache actually needs, and the one a pin cannot give.

    A second backtest run of the same day writes a **new vintage of one
    publication**: `published_at` is `gate_at(target_date, gate_profile)` by
    construction, so it is byte-identical across runs and `forecast_origin`
    names the same thing before and after. A shortlist keyed on the origin would
    therefore serve numbers computed against superseded rows for ever. The
    `computation_id` is a digest over what came back, so it moves.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await seed(conn)
        before = await compute(conn)

        # The rerun: same day, same gate, same run label — a newer ingest and a
        # different band.
        offset = 0
        p50 = tuple(value * 1.4 for value in scaled(offset))
        await seed_publication(
            conn,
            day=day_at(offset),
            p10=tuple(value * 0.4 for value in p50),
            p50=p50,
            p90=tuple(value * 1.5 for value in p50),
            run_label=ARTIFACT_ID,
            subsystem=SUBSYSTEM,
            ingested_at=datetime(2026, 3, 1, tzinfo=UTC),
            data_version=2,
        )
        after = await compute(conn)

        assert before.computation_id != after.computation_id
        # The origin is what a shared link pins, and it did not move — which is
        # exactly why it cannot be the cache key.
        assert before.featured.rule == after.featured.rule

    run(work)


def test_the_calendar_and_the_featured_days_arrive_together(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`GET /v1/replay/days` carries both, per `replay.md`'s endpoint table.

    Opening the Time Machine is one request. The shortlist is served from the
    cache the nightly job fills — never recomputed on the request path, because
    a recompute is thirteen seconds and the gateway's ML timeout is five — so
    this test fills it the way the job does and then asks the route.
    """
    from fastapi.testclient import TestClient

    from database_harness import database_url
    from wattsteer_ml import app as app_module
    from wattsteer_ml.config import settings
    from wattsteer_ml.database import Database

    url = database_url()
    _write_cards(tmp_path)
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)

    computed = run(lambda conn: _seed_and_compute(conn))
    monkeypatch.setattr(app_module, "database", Database(url))
    cache = FeaturedDaysCache()
    cache.put(computed)
    monkeypatch.setattr(app_module, "featured_days_cache", cache)

    with TestClient(app_module.app) as client:
        response = client.get(
            "/v1/replay/days",
            params={
                "subsystem": SUBSYSTEM,
                "lane": LANE.directory_name,
                "from": FIRST_DAY.isoformat(),
                "to": day_at(DAY_COUNT - 1).isoformat(),
            },
        )
    assert response.status_code == 200
    body = response.json()
    assert len(body["days"]) == DAY_COUNT
    featured = body["featured"]
    assert featured["state"] == "ready"
    assert featured["rule"] == FEATURED_RULE_SENTENCE
    assert len(featured["days"]) == FEATURED_DAY_COUNT
    assert featured["computation_id"].startswith("sha256:")
    assert featured["reference_fleet_hash"].startswith("sha256:")
    # The mandatory clause is on the wire, not only in the object.
    assert any(
        reason["criterion"] == WORST_FLOOR_SHORTFALL
        for entry in featured["days"]
        for reason in entry["reasons"]
    )
    # And the featured dates are all dates the calendar calls replayable.
    replayable = {one["date"] for one in body["days"] if one["replayable"]}
    assert {one["date"] for one in featured["days"]} <= replayable


async def _seed_and_compute(
    conn: asyncpg.Connection[Any],
) -> FeaturedDaysComputation:
    await seed(conn)
    return await compute(conn)


def test_the_nightly_job_has_one_call_that_fills_the_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`POST /internal/replay/featured-days` — what `refresh-featured-days` calls.

    One call per (subsystem, lane), returning the same block the calendar
    publishes under `featured`, so the job can log the `computation_id` — the
    weak ETag `api-surface.md` puts on `/v1/replay/days` — and keep nothing
    else. Afterwards the calendar route serves it, which is the whole wiring.
    """
    from fastapi.testclient import TestClient

    from database_harness import database_url
    from wattsteer_ml import app as app_module
    from wattsteer_ml.config import settings
    from wattsteer_ml.database import Database

    url = database_url()
    _write_cards(tmp_path)
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    run(seed)
    monkeypatch.setattr(app_module, "database", Database(url))
    monkeypatch.setattr(app_module, "featured_days_cache", FeaturedDaysCache())

    with TestClient(app_module.app) as client:
        refreshed = client.post(
            "/internal/replay/featured-days",
            json={"subsystem": SUBSYSTEM, "lane": LANE.directory_name},
        )
        assert refreshed.status_code == 200
        body = refreshed.json()
        assert body["state"] == "ready"
        assert len(body["days"]) == FEATURED_DAY_COUNT
        assert body["rule"] == FEATURED_RULE_SENTENCE

        calendar = client.get(
            "/v1/replay/days",
            params={
                "subsystem": SUBSYSTEM,
                "lane": LANE.directory_name,
                "from": FIRST_DAY.isoformat(),
                "to": day_at(DAY_COUNT - 1).isoformat(),
            },
        )
    assert calendar.status_code == 200
    # The job filled the cache and the route serves exactly what it computed.
    assert calendar.json()["featured"]["computation_id"] == body["computation_id"]
