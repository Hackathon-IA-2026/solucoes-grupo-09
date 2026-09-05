"""The band the optimizer plans against, read back from what was published.

`wattsteer_ml.forecast_reads` is the modelling side of `canonical_forecast_hour`
and it is what makes flex-optimizer 06's `no_forecast_yet` 404 into a plan. The
connection is a stand-in rather than a live Postgres — the repository has no
database-backed Python suite and this file does not open one — so what is
asserted here is everything *this side* of the wire owns: which axes are
written, which values are bound, what twenty-four rows become, and every shape
of absence that must stay an absence rather than a zero-filled day.

What a stand-in cannot check is that the SQL is valid against the migrated
schema. That is checked by the query being the *same* two views
`apps/api/src/forecast/reads.ts` selects from, by `test_the_query_names_only_the
_canonical_view`, and — for this branch — by having been executed against a
throwaway `postgres:17-alpine` with the full migration tree applied.
"""

from __future__ import annotations

import asyncio
import inspect
import re
from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Any, Self

import pytest

from wattsteer_ml.forecast_reads import (
    PLANNING_PROFILE_SQL,
    read_planning_profile,
    served_profile_source,
)
from wattsteer_ml.optimizer.horizon import HORIZON_HOURS
from wattsteer_ml.optimizer.result import PlanningProfile
from wattsteer_ml.scenario_validation import ScenarioValidationError

SUBSYSTEM = "NE"
TARGET_DATE = date(2026, 8, 29)
#: `gate_at(2026-08-29, gate_early)` — D−1 09:00 Brasília, as UTC.
ORIGIN = datetime(2026, 8, 28, 12, 0, tzinfo=UTC)
AS_OF = datetime(2026, 8, 28, 13, 30, tzinfo=UTC)


def hours(
    *,
    count: int = HORIZON_HOURS,
    threshold_mw: float = 5.0,
    published_at: datetime = ORIGIN,
    local_hours: Sequence[int] | None = None,
) -> list[dict[str, Any]]:
    """One publication's rows, as the view hands them over."""
    indices = list(range(count)) if local_hours is None else list(local_hours)
    return [
        {
            "local_hour": hour,
            "threshold_mw": threshold_mw,
            "p10_mwh": float(hour),
            "p50_mwh": float(hour) * 2.0,
            "p90_mwh": float(hour) * 3.0,
            "expected_mwh": float(hour) * 1.5,
            "published_at": published_at,
        }
        for hour in indices
    ]


class FakeTransaction:
    def __init__(self, connection: FakeConnection) -> None:
        self._connection = connection

    async def __aenter__(self) -> Self:
        self._connection.calls.append(("begin", ()))
        return self

    async def __aexit__(self, *_: object) -> bool:
        self._connection.calls.append(("commit", ()))
        return False


class FakeConnection:
    """Records what was executed and hands back the rows it was primed with."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)

    async def execute(self, query: str, *args: Any) -> None:
        self.calls.append(("execute", (query, *args)))

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.calls.append(("fetch", (query, *args)))
        return self._rows


def resolve(
    rows: list[dict[str, Any]], *, forecast_origin: str | None = None
) -> tuple[FakeConnection, PlanningProfile]:
    """Run the read against a stand-in connection. Sync, so pytest needs no plugin."""
    connection = FakeConnection(rows)
    profile = asyncio.run(
        read_planning_profile(
            connection,
            subsystem=SUBSYSTEM,
            target_date=TARGET_DATE,
            forecast_origin=forecast_origin,
            as_of=AS_OF,
        )
    )
    return connection, profile


# --- what a publication becomes -----------------------------------------------


def test_a_published_day_becomes_the_band_the_plan_is_built_on() -> None:
    """Three hour-wise envelopes, in local-hour order, and the grain they used."""
    _, profile = resolve(hours())
    assert profile.p10_mwh == tuple(float(hour) for hour in range(HORIZON_HOURS))
    assert profile.p50_mwh == tuple(float(hour) * 2.0 for hour in range(HORIZON_HOURS))
    assert profile.p90_mwh == tuple(float(hour) * 3.0 for hour in range(HORIZON_HOURS))
    # `E[Y]`, read from the same publication and beside the band rather than
    # inside it. The plan is not built on it here — nothing on this route is —
    # but an arm read from a different query would differ from the P50 plan in
    # two things instead of one.
    assert profile.expected_mwh == tuple(
        float(hour) * 1.5 for hour in range(HORIZON_HOURS)
    )
    assert profile.threshold_mw == 5.0


def test_the_origin_and_the_fidelity_travel_off_the_row() -> None:
    """A number on a screen is traceable to a run or it is not traceable at all.

    `published_at` is `gate_at(target_date, gate_profile)` and is read back
    rather than recomputed here; `point_in_time` is derived from the row being a
    `served` one, exactly as `reads.ts` derives it, because a record of a real
    publication cannot be a restatement of one.
    """
    _, profile = resolve(hours())
    assert profile.forecast_origin == ORIGIN
    assert profile.vintage_fidelity == "point_in_time"


# --- the axes and the bound values --------------------------------------------


def test_the_vintage_axis_is_written_before_the_rows_are_read() -> None:
    """`canonical_as_of()` raises when unset, so this is what makes the read work.

    Written by `canonical_reads.apply_axes` — the one function on this side that
    writes the axes — rather than by a `set_config` of this module's own.
    """
    connection, _ = resolve(hours())
    kinds = [call[0] for call in connection.calls]
    assert kinds == ["begin", "execute", "fetch", "commit"]
    axes = connection.calls[1][1]
    assert "set_config" in axes[0]
    assert axes[1] == AS_OF.isoformat()


def test_the_pinned_origin_is_bound_and_never_interpolated() -> None:
    connection, profile = resolve(hours(), forecast_origin="2026-08-28T12:00:00Z")
    query, *values = connection.calls[2][1]
    assert values == [SUBSYSTEM, TARGET_DATE, ORIGIN]
    assert "2026-08-28" not in query
    assert profile.forecast_origin == ORIGIN


def test_an_unpinned_scenario_binds_null_and_takes_the_latest() -> None:
    """`$3 is null` is the "latest" branch, in SQL rather than in two queries."""
    connection, _ = resolve(hours())
    assert connection.calls[2][1][3] is None
    assert "$3::timestamptz is null" in PLANNING_PROFILE_SQL


# --- the absences, which stay absences ----------------------------------------


@pytest.mark.parametrize(
    ("rows", "why"),
    [
        ([], "no publication at all"),
        (hours(count=23), "a publication missing an hour"),
        (hours(local_hours=[*range(23), 22]), "a duplicated hour"),
        (hours(threshold_mw=5.0)[:12] + hours(threshold_mw=1.0)[12:], "two grains"),
    ],
)
def test_an_incomplete_day_is_forecast_unavailable_and_never_zero_filled(
    rows: list[dict[str, Any]], why: str
) -> None:
    """Refused, never repaired.

    Zero-filling a gap would invent a forecast of "no curtailment" for the
    missing hours and quote a floor computed against it; shortening the horizon
    would move every hour index after the gap. Both are worse than saying no,
    and 404 is the row of the refusal table that says the scenario was fine.
    """
    with pytest.raises(ScenarioValidationError) as raised:
        resolve(rows)
    assert raised.value.code == "FORECAST_UNAVAILABLE", why
    assert raised.value.details["subsystem"] == SUBSYSTEM
    assert raised.value.details["target_date"] == TARGET_DATE.isoformat()


def test_an_origin_that_cannot_be_read_is_refused_not_widened() -> None:
    """Never "the latest instead".

    A pin that silently fell back would answer from a different run than the one
    the scenario names, and stamp *that* run's origin on the result — a pin that
    is decorative is worse than no pin at all.
    """
    with pytest.raises(ScenarioValidationError) as raised:
        resolve(hours(), forecast_origin="the latest one please")
    assert raised.value.code == "FORECAST_UNAVAILABLE"
    assert raised.value.details["forecast_origin"] == "the latest one please"


# --- what the query may and may not reach -------------------------------------


def test_a_backfilled_holdout_row_is_unreachable_from_this_read() -> None:
    """`replay.md` seam 6: never returned by a live route *under any query*.

    A constant in the SQL text and not a parameter with a default — a filter a
    caller could widen is not the requirement.
    """
    assert PLANNING_PROFILE_SQL.count("origin_kind = 'served'::forecast_origin_kind") == 2
    assert "backfilled_holdout" not in PLANNING_PROFILE_SQL


def test_the_query_names_only_the_canonical_view() -> None:
    """No base table, so no `AsOf` of this module's own and no way to skip one."""
    assert "curtailment_forecast_hour" not in PLANNING_PROFILE_SQL
    assert PLANNING_PROFILE_SQL.count("canonical_forecast_hour") == 2


def test_no_predicate_or_projection_can_select_a_planning_quantile() -> None:
    """All three envelopes on every read, and `E[Y]` beside them.

    The quantile columns appear exactly once each, in the projection, and never
    in a predicate — so there is no shape of this query that returns one
    envelope and no argument that could ask it to. ``expected_mwh`` is held to
    the same rule: `forecaster.md`'s second planning arm is built on it, and a
    column a caller could switch on would be a planning basis selectable one
    layer below the one the API refuses to expose.
    """
    for column in ("p10_mwh", "p50_mwh", "p90_mwh", "expected_mwh"):
        assert PLANNING_PROFILE_SQL.count(column) == 1
    predicates = re.findall(r"(?:where|and)\s+[^\n]*", PLANNING_PROFILE_SQL)
    assert not [
        line
        for line in predicates
        if "p10_" in line or "p90_" in line or "expected_" in line
    ]


# --- the bridge ----------------------------------------------------------------


def test_the_resolver_is_synchronous_because_the_handler_is() -> None:
    """`/v1/optimize` is a `def` on the threadpool, so its resolver must be one.

    An `async` resolver would force the handler to be `async` too, and a
    worst-case two-second branch-and-bound would then run on the event loop and
    stall every other in-flight request. The awaiting happens through
    `anyio.from_thread.run` instead, back on the loop the worker came from.
    """

    class Unused:
        async def connect(self) -> None:  # pragma: no cover — never called
            return None

    resolver = served_profile_source(Unused())  # type: ignore[arg-type]
    assert not inspect.iscoroutinefunction(resolver)
