"""The great-circle distance, asserted from the SQL side of the parity.

``packages/core/fixtures/great-circle/`` is the shared table and its
``README.md`` carries the reasoning — including why there are two
implementations of one formula and why neither can become the other's
authority. ``apps/api/test/great-circle-vectors.test.ts`` holds the TypeScript
spelling (``haversineKm`` in ``apps/api/src/features/capacity-weights.ts``) to
the same vectors; this module is the other half of the same claim and adds the
SQL one, ``great_circle_km`` from
``apps/api/drizzle/0038_one_great_circle.sql``.

**Nothing here is compared against the TypeScript side.** Every assertion is
against ``expected_km``, which was written by neither implementation —
``packages/core/scripts/build-great-circle-vectors.py`` reaches it a third way,
with Vincenty's formula specialised to a sphere — so a shared misunderstanding
has nothing to cancel out against.

**Why this file rather than one more assertion in a database suite.**
``apps/api/test/database-features.test.ts`` already compares the whole weighting
computed both ways, and it is the more complete test, but it compares the two
implementations *with each other*: it is silent about a formula both sides get
wrong identically, and it is one ``it(...)`` inside eight hundred lines.
Data-platform ticket 18 asked for this parity to be made explicit and hard to
delete rather than left as an ordinary assertion. A named directory that three
files address by path, whose suites fail when it is empty, is that.

Gated on ``WATTSTEER_TEST_DATABASE_URL``; see ``database_harness.py``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import asyncpg
import pytest

import database_harness

# apps/ml/tests/… → repo root → packages/core/fixtures/great-circle
FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "core"
    / "fixtures"
    / "great-circle"
)

#: IUGG mean Earth radius. Asserted as a literal here, in
#: ``capacity-weights.ts`` and in the vector builder, because a radius is a
#: choice rather than a derivation: a fourth spelling of it is a fourth answer.
EARTH_RADIUS_KM = 6371.0088


def _vectors() -> list[tuple[str, dict[str, Any]]]:
    files = sorted(path for path in FIXTURES.iterdir() if path.suffix == ".json")
    assert files, f"no vectors in {FIXTURES} — a passing run would mean nothing"
    return [(path.name, json.loads(path.read_text(encoding="utf-8"))) for path in files]


VECTORS = _vectors()
IDS = [name for name, _ in VECTORS]


def test_no_vector_file_is_skipped() -> None:
    """The listing above is flat; this compares it against a recursive walk.

    ``README.md`` claimed both suites "fail when the directory holds a file they
    did not enumerate", and until now neither did: a vector filed under a
    subdirectory was read by nobody, and ``_vectors``'s own ``assert files``
    only sees an empty directory — never a file nobody reads. Measured: a copy
    of ``04-a-metre-apart.json`` with ``expected_km`` set to 999999, filed under
    ``regression/``, left this suite and
    ``apps/api/test/great-circle-vectors.test.ts`` entirely green.

    Adding a vector anywhere under here is therefore sufficient, or it fails
    loudly. The siblings ``gate-instant`` and ``canonical-contract`` have
    carried this check all along; this is the one that did not.
    """
    consumed = {name for name, _ in VECTORS}
    on_disk = {str(path.relative_to(FIXTURES)) for path in FIXTURES.rglob("*.json")}
    assert on_disk == consumed


@pytest.mark.parametrize(("name", "vector"), VECTORS, ids=IDS)
def test_the_sql_reaches_the_vector(name: str, vector: dict[str, Any]) -> None:
    """``great_circle_km`` against the third-way expected value."""

    async def work(conn: asyncpg.Connection[Any]) -> float:
        value = await conn.fetchval(
            "select great_circle_km($1, $2, $3, $4)",
            vector["from"]["latitude"],
            vector["from"]["longitude"],
            vector["to"]["latitude"],
            vector["to"]["longitude"],
        )
        assert isinstance(value, float)
        return value

    got = database_harness.run(work)
    expected = float(vector["expected_km"])
    # Relative, because the vectors span a millimetre to half the planet and one
    # absolute tolerance cannot be meaningful at both ends. The measured worst
    # disagreement between the haversine and Vincenty across this set is 5e-15
    # relative; 1e-12 leaves three orders of headroom and is still far tighter
    # than any error a wrong formula could hide inside.
    assert abs(got - expected) <= max(1e-12 * expected, 1e-9), name


def test_the_function_is_symmetric_and_immutable() -> None:
    """Two properties the vectors cannot state, and both are load-bearing.

    Symmetry, because ``canonical_capacity_weight`` passes the plant first and
    the centroid second while ``capacity-weights.ts`` passes them the other way
    round; an asymmetric distance would make the two disagree on real fleets
    while agreeing on every vector.

    ``IMMUTABLE``, because the function is evaluated inside a ``cross join
    lateral`` with ``order by distance_km limit 1`` over every centroid of a
    technology, for every plant. A volatile marking would forbid the planner
    from folding it and would silently make the weighting quadratic.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        for _, vector in VECTORS:
            there, back = await conn.fetchrow(
                "select great_circle_km($1, $2, $3, $4), "
                "       great_circle_km($3, $4, $1, $2)",
                vector["from"]["latitude"],
                vector["from"]["longitude"],
                vector["to"]["latitude"],
                vector["to"]["longitude"],
            )
            assert there == pytest.approx(back, abs=1e-9)

        volatility = await conn.fetchval(
            "select provolatile::text from pg_proc where proname = 'great_circle_km'"
        )
        assert volatility == "i", "great_circle_km must stay IMMUTABLE"

    database_harness.run(work)


def test_the_radius_is_the_one_the_vectors_were_built_with() -> None:
    """A quarter-meridian, read straight back out of the function.

    The radius is the single constant the three implementations share, so it is
    worth a check that names it rather than only checking distances that happen
    to depend on it.
    """

    async def work(conn: asyncpg.Connection[Any]) -> float:
        value = await conn.fetchval("select great_circle_km(90, 0, 0, 0)")
        assert isinstance(value, float)
        return value

    quarter = database_harness.run(work)
    assert quarter == pytest.approx(EARTH_RADIUS_KM * 3.14159265358979 / 2, rel=1e-12)


def test_the_view_evaluates_the_named_function_rather_than_its_own_copy() -> None:
    """The point of naming it: there is one SQL spelling, not one per view.

    ``canonical_capacity_weight`` carried the expression inline until ticket 18.
    An author who pasted it back — or who added a second view with its own copy
    — would leave this passing only until they also removed the call, which is
    the smallest failure this can be made to have.
    """

    async def work(conn: asyncpg.Connection[Any]) -> None:
        definition = await conn.fetchval(
            "select pg_get_viewdef('canonical_capacity_weight'::regclass)"
        )
        assert "great_circle_km" in definition
        assert "6371.0088" not in definition, (
            "the radius is back inside the view — the formula has been re-inlined"
        )

    database_harness.run(work)
