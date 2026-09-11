"""The fixture harness must not be able to empty a database it did not fill.

On 2026-09-10 a suite run against ``WATTSTEER_TEST_DATABASE_URL`` pointed at a
working database destroyed 4.7M ``curtailment_report_hour`` rows, 69,888 DESSEM
rows and 330,507 weather rows — five hours of live, rate-limited API calls — and
left twenty-four fixture rows behind. Nothing refused, because a truncate cannot
tell whose rows it is dropping.

These tests are over the decision alone, with a stub connection, so every branch
is reachable without a database and without destroying anything to prove it.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from database_harness import (
    DISPOSABLE_VARIABLE,
    FIXTURE_URL_HOST,
    FIXTURE_WEATHER_RUN_CEILING,
    refuse_if_not_disposable,
)


class StubConnection:
    """Answers the two counts the guard asks for, and records that it was asked."""

    def __init__(self, foreign: int, weather_runs: int) -> None:
        self.foreign = foreign
        self.weather_runs = weather_runs
        self.asked: list[str] = []

    async def fetchval(self, query: str, *args: Any) -> int:
        self.asked.append(query)
        if "ons_resource_version" in query:
            assert args and FIXTURE_URL_HOST in str(args[0]), (
                "the guard must ask about the fixture host, not a bare count"
            )
            return self.foreign
        if "weather_run_request" in query:
            return self.weather_runs
        raise AssertionError(f"unexpected query: {query}")


def decide(foreign: int, weather_runs: int) -> StubConnection:
    conn = StubConnection(foreign, weather_runs)
    asyncio.run(refuse_if_not_disposable(conn))
    return conn


def test_a_fixture_database_is_allowed() -> None:
    """The ordinary case. A guard that refuses everything is an outage."""
    conn = decide(foreign=0, weather_runs=0)
    # Non-vacuous: it actually read both halves rather than returning early.
    assert len(conn.asked) == 2


def test_a_database_holding_real_resources_is_refused() -> None:
    """The case it exists for, measured on the real database at 541 / 870."""
    with pytest.raises(RuntimeError, match="Refusing to truncate"):
        decide(foreign=541, weather_runs=870)


def test_one_foreign_resource_is_enough() -> None:
    """No threshold on the URL half: a single real resource is real history."""
    with pytest.raises(RuntimeError, match="Refusing to truncate"):
        decide(foreign=1, weather_runs=0)


def test_weather_is_caught_by_volume_since_it_has_no_url() -> None:
    """Open-Meteo records run requests, not bulk resources, so it has no URL.

    The ceiling is the fixtures' own scale; the real backfill wrote 788.
    """
    with pytest.raises(RuntimeError, match="Refusing to truncate"):
        decide(foreign=0, weather_runs=FIXTURE_WEATHER_RUN_CEILING + 1)
    # And the boundary itself is allowed, so the ceiling means what it says.
    decide(foreign=0, weather_runs=FIXTURE_WEATHER_RUN_CEILING)


def test_the_refusal_says_what_to_do_about_it() -> None:
    """A refusal nobody can act on gets bypassed by deleting the guard."""
    with pytest.raises(RuntimeError) as refused:
        decide(foreign=541, weather_runs=870)
    message = str(refused.value)
    assert "541" in message and "870" in message
    assert DISPOSABLE_VARIABLE in message
    assert "throwaway" in message


def test_the_override_is_deliberate_and_works(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refusal that cannot be overridden is one somebody deletes."""
    monkeypatch.setenv(DISPOSABLE_VARIABLE, "1")
    conn = decide(foreign=541, weather_runs=870)
    # And it short-circuits: an override must not pay for two queries.
    assert conn.asked == []
