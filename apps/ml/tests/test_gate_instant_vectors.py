"""The gate instant, asserted from this side of the wire too.

``packages/core/fixtures/gate-instant/`` is the shared table.
``packages/core/test/gate-instant.test.ts`` holds the TypeScript spellings —
``GATES`` and ``localWallClock`` in ``packages/core/src/schedule.ts``, composed
into ``gateAt`` by ``apps/api/src/forecast/gate.ts`` — to it; this module is the
other half of the same claim, and adds the SQL one.

**Nothing here is compared against the TypeScript side.** Every assertion is
against ``expected_gate_at``, which was written by neither implementation —
``packages/core/scripts/build-gate-vectors.py`` reaches it a fourth way, with
``datetime.combine`` and ``zoneinfo`` — so a shared misunderstanding has nothing
to cancel out against. See the directory's ``README.md``.

**Why this matters.** ``docs/specs/api-surface.md``: a ``Forecast`` row's
``published_at`` *is* ``gate_at(target_date, gate_profile)``. The instant decides
every published forecast's age, the ``ForecastOrigin`` on every number a screen
renders, and whether a caller is told "come back at seven"
(``FORECAST_NOT_YET_PUBLISHED``) or "something broke" (``FORECAST_UNAVAILABLE``).
Before these vectors the only cross-language check was
``packages/core/test/schedule.test.ts`` asserting the migration's *text*
contains the integers 9 and 19 — a check two spellings of an hour pass while
resolving different instants.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

import database_harness
from feature_row_fixtures import GATE_HOURS, gate_at
from wattsteer_ml.features import BRASILIA

# apps/ml/tests/… → repo root → packages/core/fixtures/gate-instant
FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "core"
    / "fixtures"
    / "gate-instant"
)


def _vectors() -> list[tuple[str, dict[str, Any]]]:
    files = sorted(path for path in FIXTURES.iterdir() if path.suffix == ".json")
    assert files, f"no vectors in {FIXTURES} — a passing run would mean nothing"
    return [(path.name, json.loads(path.read_text(encoding="utf-8"))) for path in files]


VECTORS = _vectors()
IDS = [name for name, _ in VECTORS]


def _instant(text: str) -> datetime:
    """The vector's ``…Z`` spelling, as an aware UTC instant."""
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def test_the_directory_is_populated() -> None:
    assert VECTORS


def test_no_vector_file_is_skipped() -> None:
    """The half that stops a vector added for another language being ignored here."""
    consumed = {name for name, _ in VECTORS}
    on_disk = {path.name for path in FIXTURES.rglob("*.json")}
    assert on_disk == consumed


@pytest.mark.parametrize(("name", "vector"), VECTORS, ids=IDS)
def test_gate_at_resolves_the_expected_instant(name: str, vector: dict[str, Any]) -> None:
    target = date.fromisoformat(vector["target_date"])
    resolved = gate_at(target, vector["gate_profile"])
    assert resolved == _instant(vector["expected_gate_at"]), name


@pytest.mark.parametrize(("name", "vector"), VECTORS, ids=IDS)
def test_the_gate_table_names_the_expected_local_hour(
    name: str, vector: dict[str, Any]
) -> None:
    """The half a wrong instant cannot distinguish from a wrong zone.

    If this fails the table moved; if only the assertion above fails, the zone
    did.
    """
    hour = int(vector["expected_local_time"].split(":")[0])
    assert GATE_HOURS[vector["gate_profile"]] == hour, name


@pytest.mark.parametrize(("name", "vector"), VECTORS, ids=IDS)
def test_the_gate_is_the_day_before_the_target_date(
    name: str, vector: dict[str, Any]
) -> None:
    """D−1, in Brasília civil time rather than in UTC.

    Between 21:00 and 24:00 BRT the two calendars disagree, and ``gate_late``
    sits inside that window — so a gate whose local date was read off the UTC
    instant would name the wrong day for the primary lane every evening.
    """
    resolved = gate_at(date.fromisoformat(vector["target_date"]), vector["gate_profile"])
    local = resolved.astimezone(BRASILIA)
    assert local.date().isoformat() == vector["expected_local_date"], name
    assert local.strftime("%H:%M") == vector["expected_local_time"], name
    offset = local.utcoffset()
    assert offset is not None
    assert offset.total_seconds() / 60 == vector["expected_utc_offset_minutes"], name


def test_an_unknown_profile_is_refused_rather_than_defaulted() -> None:
    """The SQL raises 22023 on an unknown profile; this side raises too.

    A gate invented for a profile that does not exist would stamp a publication
    instant on rows claiming to be a different lane's, which no vector can see
    because no vector names a profile that is not in the table.
    """
    with pytest.raises(ValueError, match="unknown gate profile"):
        gate_at(date(2026, 8, 29), "gate_middle")


def _naive_wall(vector: dict[str, Any]) -> datetime:
    """The vector's wall clock read as though it were UTC. Not an instant."""
    return datetime.fromisoformat(
        f"{vector['expected_local_date']}T{vector['expected_local_time']}:00+00:00"
    )


def test_a_fixed_three_hour_offset_disagrees_with_at_least_one_vector() -> None:
    """The test of the test.

    Brazil has observed no summer time since February 2019, so subtracting a
    fixed three hours from the wall clock is right on every date the product
    serves. The pre-2019 vectors exist so that it is nevertheless caught here.
    If this ever stops finding a disagreement, those vectors have been deleted
    and this suite says nothing about the zone at all.
    """
    disagreements = [
        name
        for name, vector in VECTORS
        if _naive_wall(vector) + timedelta(hours=3)
        != _instant(vector["expected_gate_at"])
    ]
    assert disagreements, "no vector distinguishes the zone from a fixed -03:00"


@pytest.mark.parametrize(("name", "vector"), VECTORS, ids=IDS)
def test_the_database_resolves_the_expected_instant(
    name: str, vector: dict[str, Any]
) -> None:
    """The SQL side, against a real Postgres.

    ``gate_at`` is ``plpgsql``; there is nothing to import, so this is the only
    place the authority for every stored ``published_at`` can be asserted at
    all. Gated on ``WATTSTEER_TEST_DATABASE_URL`` exactly like every other
    database suite here — the default ``pytest`` run skips it and the two
    in-process sides above still run everywhere. See ``database_harness.py``.
    """

    async def resolve(conn: Any) -> Any:
        return await conn.fetchval(
            "select gate_at($1::date, $2)",
            date.fromisoformat(vector["target_date"]),
            vector["gate_profile"],
        )

    resolved = database_harness.run(resolve)
    assert resolved.astimezone(UTC) == _instant(vector["expected_gate_at"]), name
