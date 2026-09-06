"""The Python feature caller, against a real Postgres.

Data-platform ticket 18, residual 3, second half. ``wattsteer_ml/features.py``
is the modelling side's **only** way to obtain a feature row, and it is nine
lines of asyncpg around one statement:

    select * from feature_rows($1::date, $2::date, $3, $4, $5)

Everything downstream of it — the design matrix, the folds, the ladder, the
hurdle, the bundle — is tested against ``feature_row_fixtures.feature_rows``,
which is a synthetic ``dict`` builder written by hand. That is the right shape
for those tests and it means **nothing in this service compared either the
statement or the fixture's column names against the database**. A migration
that renamed a feature would leave the whole Python suite green and the trainer
fitting on a column that no longer arrives.

This file closes that. It asserts three things a mock cannot:

1. The statement **runs**, with its five arguments bound and cast as written.
   A changed signature is a failure here rather than at the first training run.
2. ``select *`` really projects the whole ``feature_row``, and the *names* it
   projects are the names the fixture builds. ``docs/specs/forecaster.md``
   hashes the ordered feature names into a lane's ``feature_hash``, so a name
   is an identity and not a label.
3. The fixture's columns arrive **in the database's order**, not merely as a
   set. ``test_feature_contract.py`` already asserts "the feature order is the
   database's order" — against the fixture, which cannot know. This is the
   assertion that gives that one its subject.

It seeds nothing, and it still gets rows: ``feature_rows`` is calendar-driven,
so an empty store yields the full subsystem-hour grid with every observed and
label column NULL. That is a better fixture for these questions than a plausible
fleet would be — the grid, the stamps and the projected column list are
properties of the *function*, and a seed large enough to move the numbers would
cost far more while asserting strictly less about them.
``apps/api/test/database-features.test.ts`` owns the behavioural half — what the
numbers are, and that the gate does not leak — with the seed that costs.

Gated on ``WATTSTEER_TEST_DATABASE_URL``; see ``database_harness.py``.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import asyncpg

import database_harness
from feature_row_fixtures import feature_rows, gate_at
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.features import (
    FEATURE_ROWS_SQL,
    FeatureRowsQuery,
    read_feature_rows,
    read_serving_rows,
)

#: A window with no data behind it. The questions here are about the function.
FIRST = date(2025, 1, 1)
LAST = date(2025, 1, 2)

QUERY = FeatureRowsQuery(
    target_from=FIRST,
    target_to=LAST,
    gate_profile="gate_late",
    feature_set="dessem_free_v1",
    threshold_mw=5.0,
)


def _projected_columns() -> list[str]:
    """The column names ``FEATURE_ROWS_SQL`` projects, from the server.

    Prepared rather than executed, so the answer is the statement's shape and
    does not depend on the database holding a single row.
    """

    async def work(conn: asyncpg.Connection[Any]) -> list[str]:
        statement = await conn.prepare(FEATURE_ROWS_SQL)
        return [attribute.name for attribute in statement.get_attributes()]

    return database_harness.run(work)


def test_the_one_statement_runs_with_its_five_arguments() -> None:
    """The caller's whole surface, executed, and its stamps read back.

    The grid is the function's, not this file's: two civil days by twenty-four
    hours by the subsystems the platform carries. Asserting the count catches a
    function that silently stopped emitting a subsystem; asserting the stamps
    catches arguments bound in the wrong order, which is otherwise a run that
    trains at the wrong gate and reports nothing.
    """

    async def work(conn: asyncpg.Connection[Any]) -> list[dict[str, Any]]:
        return await read_feature_rows(conn, QUERY)

    rows = database_harness.run(work)
    assert len(rows) == 2 * 24 * len(SUBSYSTEM_CODES)
    assert {row["gate_profile"] for row in rows} == {"gate_late"}
    assert {row["feature_set"] for row in rows} == {"dessem_free_v1"}
    assert {row["threshold_mw"] for row in rows} == {5.0}
    assert {row["target_date"] for row in rows} == {FIRST, LAST}
    # The gate instant the function resolves is the one the shared vectors pin.
    assert {row["gate_at"] for row in rows} == {
        gate_at(FIRST, "gate_late"),
        gate_at(LAST, "gate_late"),
    }
    # Nothing was seeded, so every label is absent — which is how an unsettled
    # hour is expressed. A zero here would be a fact about the grid that the
    # database does not have.
    assert {row["y_constrained_off_total_mwh"] for row in rows} == {None}


def test_serving_asks_for_one_day_through_the_same_statement() -> None:
    """ "The serving row equals the training row" is a property of the shape.

    Asserted against the server because the delegation is only meaningful if
    the delegated-to statement accepts ``target_from = target_to``: a function
    that required a strictly-increasing range would make serving a different
    query from training and nothing in Python would say so.
    """

    async def work(conn: asyncpg.Connection[Any]) -> list[dict[str, Any]]:
        return await read_serving_rows(
            conn,
            target_date=FIRST,
            gate_profile="gate_late",
            feature_set="dessem_free_v1",
            threshold_mw=5.0,
        )

    rows = database_harness.run(work)
    assert len(rows) == 24 * len(SUBSYSTEM_CODES)
    assert {row["target_date"] for row in rows} == {FIRST}


def test_the_statement_projects_the_whole_feature_row() -> None:
    """``select *`` over a ``SETOF feature_row``, name for name and in order."""

    async def work(conn: asyncpg.Connection[Any]) -> list[str]:
        return [
            record["attname"]
            for record in await conn.fetch(
                """
                select a.attname
                from pg_type t
                join pg_class c on c.oid = t.typrelid
                join pg_attribute a on a.attrelid = c.oid
                where t.typname = 'feature_row'
                  and a.attnum > 0 and not a.attisdropped
                order by a.attnum
                """
            )
        ]

    declared = database_harness.run(work)
    assert declared, "no feature_row type — the database is not migrated"
    assert _projected_columns() == declared


def test_every_column_the_python_fixture_builds_is_a_real_one() -> None:
    """The guard the whole training suite has been missing.

    ``feature_row_fixtures`` is what every test downstream of the caller runs
    on. A renamed or dropped feature would leave all of them green while the
    trainer read a column the database no longer returns — the exact "one
    refactor away from silently breaking with a green suite" this ticket names.
    """
    fixture = list(feature_rows(first=FIRST, last=FIRST)[0])
    projected = _projected_columns()
    unknown = [name for name in fixture if name not in projected]
    assert not unknown, (
        f"feature_row_fixtures builds {unknown}, which feature_rows does not return"
    )


def test_the_fixture_builds_every_column_the_database_returns() -> None:
    """The other direction, which is the one that rots quietly.

    "Every fixture column is real" was satisfiable by a fixture that had fallen
    an entire feature block behind: this file's first version passed against a
    fixture stuck at ``0019`` while the composite type had grown to 112
    attributes, and three separate tickets flagged it without owning it.

    A *missing* column is the worse failure of the two. An invented one blows up
    at the first real query; an absent one leaves the trainer fitting a narrower
    vector than production serves, silently and with a green suite — and
    ``FeatureContract`` takes its ordered names from the row it is handed, so
    the ``feature_hash`` the fixtures imply would not be the hash the live
    function produces.
    """
    projected = _projected_columns()
    fixture = list(feature_rows(first=FIRST, last=FIRST)[0])
    missing = [name for name in projected if name not in fixture]
    assert not missing, (
        f"feature_rows returns {missing}, which feature_row_fixtures does not "
        f"build; the fixture has fallen behind a migration"
    )


def test_the_fixture_builds_its_columns_in_the_databases_order() -> None:
    """Names *and* order, exactly: the order is hashed into a lane's identity.

    ``docs/specs/forecaster.md`` makes ``feature_hash`` a digest over the
    *ordered* feature names, and ``test_feature_contract.py`` asserts the
    fixture's order is "the database's order" without having a database to
    check it against. This is the half that does.

    Equality rather than "is a subsequence", and that is the whole point:
    ``ALTER TYPE feature_row ADD ATTRIBUTE`` appends, so the merge order of the
    migrations is the attribute order and no plausible order is the order. A
    fixture that grouped the weather block tidily together would satisfy a set
    comparison, satisfy a subsequence comparison for as long as it stayed
    behind, and still describe a different vector.
    """
    assert list(feature_rows(first=FIRST, last=FIRST)[0]) == _projected_columns()
