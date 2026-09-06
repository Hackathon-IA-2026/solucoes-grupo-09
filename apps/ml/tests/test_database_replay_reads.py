"""The replay reads, against a real Postgres — the seam nothing else can cover.

Replay 02 shipped `PUBLISHED_DAYS_SQL` and `OBSERVED_HOURS_SQL` validated by
hand against a throwaway container, because `apps/ml` had no harness. Replay 03
named this ticket as the one where a harness earns its keep. This file is the
harness earning it: five statements, four views, one SQL function and one
transaction, and every claim below is a claim about SQL that a fixture cannot
make.

Gated exactly like the TypeScript database suites — `WATTSTEER_TEST_DATABASE_URL`
supplies the URL and the default `pytest` skips the file. See
`database_harness.py` for the recipe.

What is asserted, in the order it matters:

1. **The day boundary is Postgres's.** Hour 0 of a replay is 03:00 UTC and hour
   23 is 02:00 UTC the next day, and the fixture writes instants rather than
   local hours so that the `at time zone` in the statement is what is under
   test.
2. **A record outranks a reconstruction.** A day holding both a `served` row
   and a `backfilled_holdout` one for the same lane resolves the served one —
   the rule, not whichever row happened to be newer.
3. **A pin resolves the publication it names, and never falls through** — and,
   the finding this file exists to record, **a publication instant cannot name
   a backtest run.** A rerun of one day publishes at the same gate by
   construction, so it is a new *vintage of one publication* and the pin cannot
   distinguish the two. That is asserted as the fact it is rather than
   papered over; see the test's own docstring for what follows.
4. **The day band is read, never summed.** `day_total` is the stored figure and
   is deliberately not the sum of the hourly one in the fixture, so a statement
   that computed it would be caught.
5. **Absences are absences.** A day short an hour yields no `ObservedDay`, and
   a lane with no publication yields no `PinnedForecast` — not a zero-filled
   one.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any

import asyncpg

from database_harness import (
    local_midnight,
    reporting_entity,
    run,
    seed_observed_day,
    seed_publication,
    source_version,
    truncate,
)
from wattsteer_ml.lanes import Lane
from wattsteer_ml.replay.inputs import read_replay_inputs

LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
DAY = date(2025, 11, 12)
SUBSYSTEM = "NE"
AS_OF = datetime(2026, 6, 1, tzinfo=UTC)

#: A day with a clear episode in the middle and quiet hours either side.
P50: tuple[float, ...] = tuple(
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    + (20.0, 70.0, 110.0, 90.0, 30.0, 10.0)
    + (0.0,) * 8
)
P10: tuple[float, ...] = tuple(value * 0.4 for value in P50)
P90: tuple[float, ...] = tuple(value * 1.5 for value in P50)
OBSERVED: tuple[float, ...] = tuple(value * 1.2 for value in P50)

FIRST_RUN = "F3__2025-10-01T03:10:00Z"
SECOND_RUN = "F3__2026-02-01T03:10:00Z"


async def _seed_one_replayable_day(conn: asyncpg.Connection[Any]) -> datetime:
    await truncate(conn)
    version = await source_version(conn)
    entity = await reporting_entity(conn)
    await seed_observed_day(conn, day=DAY, hours=OBSERVED, entity=entity, source=version)
    return await seed_publication(
        conn, day=DAY, p10=P10, p50=P50, p90=P90, run_label=FIRST_RUN
    )


def _read(conn: asyncpg.Connection[Any], *, forecast_origin: str | None = None) -> Any:
    return read_replay_inputs(
        conn,
        subsystem=SUBSYSTEM,
        target_date=DAY,
        lane=LANE,
        forecast_origin=forecast_origin,
        as_of=AS_OF,
    )


def test_one_transaction_returns_the_pinned_band_the_day_and_the_episodes() -> None:
    async def work(conn: asyncpg.Connection[Any]) -> None:
        gate = await _seed_one_replayable_day(conn)
        inputs = await _read(conn)

        assert inputs.forecast is not None
        assert inputs.forecast.p50_mwh == P50
        assert inputs.forecast.origin.run_label == FIRST_RUN
        assert inputs.forecast.origin.published_at == gate
        assert inputs.forecast.origin.origin_kind == "backfilled_holdout"
        assert inputs.forecast.threshold_mw == 5.0

        assert inputs.observed is not None
        assert inputs.observed.hours == OBSERVED
        assert inputs.evidence.observed_hours == 24
        assert inputs.evidence.artifact_id == FIRST_RUN
        assert inputs.evidence.candidate_lanes == (LANE.directory_name,)

        # The episode the day actually holds, drawn by the published SQL
        # function at the publication's own threshold — not recomputed here.
        assert len(inputs.episodes) == 1
        episode = inputs.episodes[0]
        assert episode.threshold_mw == 5.0
        assert episode.duration_hours == 6
        assert episode.started_at == local_midnight(DAY) + timedelta(hours=10)
        assert episode.peak_mw == max(OBSERVED)

        # The vintage sources came from the same cut, so a calendar is one
        # vintage rather than a mosaic of them.
        assert [source.read for source in inputs.sources] == [
            "curtailment-by-reporting-entity"
        ]

    run(work)


def test_hour_zero_is_local_midnight_and_the_boundary_is_postgres_own() -> None:
    """A profile that is non-zero in exactly one hour, found in exactly that hour.

    The fixture writes an *instant*; the statement converts it. If the two
    disagreed about `America/Sao_Paulo`, the spike would land in the wrong slot
    and the plan would be indexed against a different day's shape.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        spike = tuple(99.0 if hour == 23 else 0.0 for hour in range(24))
        await seed_observed_day(conn, day=DAY, hours=spike)
        await seed_publication(
            conn, day=DAY, p10=P10, p50=P50, p90=P90, run_label=FIRST_RUN
        )
        inputs = await _read(conn)
        assert inputs.observed is not None
        assert inputs.observed.hours[23] == 99.0
        assert inputs.observed.hours[:23] == (0.0,) * 23
        # 23:00 in Brasília is 02:00 UTC the following day. Written out, because
        # this is the arithmetic the statement is being trusted with.
        assert local_midnight(DAY) + timedelta(hours=23) == datetime(
            2025, 11, 13, 2, 0, tzinfo=UTC
        )

    run(work)


def test_a_record_outranks_a_reconstruction_on_a_day_holding_both() -> None:
    """`served` wins, by the rule and not by whichever row is newer.

    A reconstruction of a day WattSteer actually published is not what WattSteer
    said. The reconstruction is written *later* here, so a statement ordering on
    `published_at` alone would return it.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        await seed_observed_day(conn, day=DAY, hours=OBSERVED)
        await seed_publication(
            conn,
            day=DAY,
            p10=P10,
            p50=P50,
            p90=P90,
            run_label="served-run",
            origin_kind="served",
        )
        doubled = tuple(value * 2 for value in P50)
        await seed_publication(
            conn,
            day=DAY,
            p10=tuple(value * 0.4 for value in doubled),
            p50=doubled,
            p90=tuple(value * 1.5 for value in doubled),
            run_label=SECOND_RUN,
            origin_kind="backfilled_holdout",
            ingested_at=datetime(2026, 3, 1, tzinfo=UTC),
        )
        inputs = await _read(conn)
        assert inputs.forecast is not None
        assert inputs.forecast.origin.origin_kind == "served"
        assert inputs.forecast.origin.run_label == "served-run"
        assert inputs.forecast.p50_mwh == P50
        # Both lanes-worth of candidates is one lane here, but the day rows saw
        # both publications and still resolved one.
        assert inputs.evidence.candidate_lanes == (LANE.directory_name,)

    run(work)


def test_a_second_backtest_run_supersedes_and_a_published_at_pin_cannot_stop_it() -> None:
    """**The box this ticket cannot tick, asserted as the fact it is.**

    `replay.md` seam 7 asks for a replay to be recomputed *at the pinned origin*
    after a fresh backtest and be byte-identical. That is not reachable through
    a `forecast_origin` that is a publication instant, and the reason is
    structural rather than an omission here:

    - A `backfilled_holdout` row's `published_at` **is**
      ``gate_at(target_date, gate_profile)`` — seam 6 requires exactly that — so
      two backtest runs of one day carry the *same* publication instant. The
      fixture writes the same instant for both because writing anything else
      would be a fixture the product cannot produce.
    - The business key of `curtailment_forecast_hour` is
      ``(subsystem, valid_time, origin_kind, gate_profile, data_version)`` and
      `canonical_forecast_hour` resolves `AsOf` with ``distinct on`` over the
      first four. So the second run is a **new vintage of one publication**, and
      the first is invisible at any cut after it was ingested.

    A `forecast_origin` therefore names a publication and never a backtest run.
    What is asserted below is the truth: the pin still cannot fall through to
    another publication, and the numbers a pinned link returns after a rerun are
    the rerun's. The fix is a pin that can name the run — `run_label` or
    `data_version` — and it is a change to the shared scenario transport, which
    is why it is reported rather than smuggled in here.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        await seed_observed_day(conn, day=DAY, hours=OBSERVED)
        first_gate = await seed_publication(
            conn, day=DAY, p10=P10, p50=P50, p90=P90, run_label=FIRST_RUN
        )
        before = await _read(conn, forecast_origin=first_gate.isoformat())
        assert before.forecast is not None
        assert before.forecast.p50_mwh == P50

        # The fresh backtest: same day, same gate, a new artifact and new
        # numbers, appended as `data_version` 2 rather than overwriting.
        retrained = tuple(value * 3 for value in P50)
        second_gate = await seed_publication(
            conn,
            day=DAY,
            p10=tuple(value * 0.4 for value in retrained),
            p50=retrained,
            p90=tuple(value * 1.5 for value in retrained),
            run_label=SECOND_RUN,
            ingested_at=datetime(2026, 3, 1, tzinfo=UTC),
            data_version=2,
        )
        assert second_gate == first_gate, "a rerun of one day publishes at one gate"

        # Both vintages are in the table — nothing was overwritten.
        assert (
            await conn.fetchval(
                "select count(distinct data_version) from curtailment_forecast_hour"
            )
            == 2
        )

        after = await _read(conn, forecast_origin=first_gate.isoformat())
        assert after.forecast is not None
        assert after.forecast.origin.published_at == first_gate
        # The pin resolved the same publication and a *newer vintage of it*.
        assert after.forecast.origin.run_label == SECOND_RUN
        assert after.forecast.p50_mwh == retrained

        # And the older vintage is still reachable — by the axis that actually
        # discriminates vintages, which is `AsOf` and not the origin.
        earlier = await read_replay_inputs(
            conn,
            subsystem=SUBSYSTEM,
            target_date=DAY,
            lane=LANE,
            forecast_origin=first_gate.isoformat(),
            as_of=datetime(2026, 2, 1, tzinfo=UTC),
        )
        assert earlier.forecast is not None
        assert earlier.forecast.origin.run_label == FIRST_RUN
        assert earlier.forecast.p50_mwh == P50

    run(work)


def test_the_observed_half_carries_the_vintage_a_restatement_moves() -> None:
    """`ObservedDay.data_version` — the greatest version among the day's rows.

    The forecast half of a replay is pinned and cannot move. The observed half
    is read ``AsOf(now)`` against a record ONS rewrites in place, and until this
    read carried the version, nothing downstream — not the published contract,
    not `apps/api`'s validator — could tell a replay computed before a
    restatement from one computed after it. It is the same quantity
    `api-surface.md`'s `/v1/curtailment/*` row validates on: `max(data_version)`
    over the rows the read returned.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await _seed_one_replayable_day(conn)
        before = await _read(conn)
        assert before.observed is not None
        assert before.observed.data_version == "1"

        # ONS restates the day in place: the same hours, new numbers, appended
        # as `data_version` 2 rather than overwriting.
        await seed_observed_day(
            conn,
            day=DAY,
            hours=tuple(value * 1.5 for value in OBSERVED),
            ingested_at=datetime(2026, 3, 1, tzinfo=UTC),
            data_version=2,
        )
        after = await _read(conn)
        assert after.observed is not None
        assert after.observed.hours != before.observed.hours
        # The numbers moved and so did the vintage. A cache or a validator built
        # on this cannot serve the first day's numbers under the second's name.
        assert after.observed.data_version == "2"

    run(work)


def test_a_pin_that_resolves_nothing_is_an_absence_and_never_a_fallback() -> None:
    """The one repair this module must never make.

    A pinned scenario answered from a *different* publication would stamp that
    publication's origin on the result and the pin would be decorative. So an
    unresolvable pin yields no forecast, which the route answers
    `REPLAY_FORECAST_UNAVAILABLE`.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await _seed_one_replayable_day(conn)
        missing = await _read(conn, forecast_origin="2024-01-01T00:00:00Z")
        assert missing.forecast is None
        assert missing.evidence.artifact_id is None
        # And an instant that is not one is the same absence, not a crash.
        assert (await _read(conn, forecast_origin="not-an-instant")).forecast is None

    run(work)


def test_the_day_band_is_the_stored_figure_and_never_a_sum_of_the_hourly_one() -> None:
    """Quantiles do not add, and the read is where that is cheapest to hold."""

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        await seed_observed_day(conn, day=DAY, hours=OBSERVED)
        await seed_publication(
            conn,
            day=DAY,
            p10=P10,
            p50=P50,
            p90=P90,
            run_label=FIRST_RUN,
            # A joint day total is narrower than a componentwise sum. Written
            # far from the sums so a statement that computed them is obvious.
            day_total=(1.0, 2.0, 3.0),
        )
        inputs = await _read(conn)
        assert inputs.forecast is not None
        assert (
            inputs.forecast.day_total.p10,
            inputs.forecast.day_total.p50,
            inputs.forecast.day_total.p90,
        ) == (1.0, 2.0, 3.0)
        assert inputs.forecast.day_total.p50 != sum(P50)

    run(work)


def test_a_day_short_an_hour_yields_no_observed_day_and_says_how_short() -> None:
    """`REPLAY_OBSERVATION_INCOMPLETE`'s two halves, from one read."""

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        await seed_observed_day(conn, day=DAY, hours=OBSERVED[:23])
        await seed_publication(
            conn, day=DAY, p10=P10, p50=P50, p90=P90, run_label=FIRST_RUN
        )
        inputs = await _read(conn)
        assert inputs.observed is None
        assert inputs.evidence.observed_hours == 23

    run(work)


def test_another_lane_is_not_this_lane_and_is_reported_as_a_candidate() -> None:
    """The day with two candidate forecasts, which is the open decision.

    A publication in a lane the caller did not name resolves nothing — no
    silent substitution — and still appears in `candidate_lanes`, so a day with
    two is visibly a day with two.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        await seed_observed_day(conn, day=DAY, hours=OBSERVED)
        await seed_publication(
            conn,
            day=DAY,
            p10=P10,
            p50=P50,
            p90=P90,
            run_label=FIRST_RUN,
            gate_profile="gate_early",
        )
        inputs = await _read(conn)
        assert inputs.forecast is None
        assert inputs.evidence.artifact_id is None
        assert inputs.evidence.candidate_lanes == ("dessem_free_v1__gate_early__thr5",)

    run(work)


def test_the_as_of_axis_is_written_and_an_earlier_cut_sees_less() -> None:
    """`AsOf(t)` is the only sanctioned read, and it is honoured here.

    A publication ingested after the cut is invisible at that cut — which is
    what makes a replay's numbers a function of the vintage rather than of when
    the request happened to arrive.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        await truncate(conn)
        await seed_observed_day(conn, day=DAY, hours=OBSERVED)
        await seed_publication(
            conn,
            day=DAY,
            p10=P10,
            p50=P50,
            p90=P90,
            run_label=FIRST_RUN,
            ingested_at=datetime(2026, 8, 1, tzinfo=UTC),
        )
        assert (await _read(conn)).forecast is None  # AS_OF is 2026-06-01
        later = await read_replay_inputs(
            conn,
            subsystem=SUBSYSTEM,
            target_date=DAY,
            lane=LANE,
            forecast_origin=None,
            as_of=datetime(2026, 9, 1, tzinfo=UTC),
        )
        assert later.forecast is not None

    run(work)
