"""The pre-`0039` `feature_hash`, against a real Postgres, through the real gate.

Forecaster ticket 26, the half a fixture cannot do. `test_retrain_debt.py` owns
the decision procedure on constructed hashes; this file owns the *hashes*, and
they are the whole claim `0039_the_gate_over_a_backfill.sql` made in prose:

  > `feature_hash` moves, and that is deliberate rather than incidental. […]
  > **Both lanes owe a retrain.**

Nothing measured that. `feature_hash` is a sha256 over the ordered feature names
**and** `pg_get_functiondef(feature_rows)`, so whether it moved is a fact about
two function bodies as the *server* renders them — and a Python fixture that
varies a string proves the hash is a hash, not that this migration moved it.

So both hashes are read from a migrated database:

- the **live** one, from `feature_rows` as `0039` left it;
- the **pre-`0039`** one, by reinstalling `0036_the_same_hour_exceedance.sql`'s
  definition — the newest restatement before `0039`, and therefore the body
  every existing artifact was fitted against — inside a transaction that is
  rolled back. `CREATE OR REPLACE FUNCTION` is transactional in Postgres, so
  the database is left exactly as it was found; the suite is otherwise read-only
  and stays that way.

Both contracts are derived from rows the respective function returned, so the
comparison is between two complete contracts and not between one contract and a
substituted string.

**Two assertions make this evidence rather than a green dot.**

1. The feature *names* are identical across the two definitions. `0039` says it
   adds no attribute and moves none, and if that were wrong the hashes would
   differ for a reason that has nothing to do with the weather repair. Asserting
   it is also the only way to say the moved hash is the *body's* — which is the
   half of the contract a column list cannot see, and the reason the hash covers
   the body at all.
2. The same candidate, the same incumbent, the same hours, with the live hash
   substituted for the pre-`0039` one, **promotes**. Without that pair a passing
   refusal test is compatible with a fixture that could never have promoted.

**Retraining is out of scope and is not attempted.** Clearing the debt needs
ingested canonical rows — weather runs, constrained-off actuals, a fleet — that
no environment in this repository has; an empty migrated database yields the
full subsystem-hour grid with every observed column NULL, which is the right
fixture for the questions here and cannot train anything. What this file
establishes is that the debt is enforced and named. Paying it is a scheduled run
against a populated database.

Gated on ``WATTSTEER_TEST_DATABASE_URL``; see ``database_harness.py``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import asyncpg
import pytest

import database_harness
from test_hot_swap_gate import (
    CANDIDATE_ID,
    INCUMBENT_ID,
    LANE,
    NOW,
    candidate,
    clean_smoke,
    incumbent,
    lane_directory,
)
from wattsteer_ml.artifacts import CARD_SUFFIX, contract_fault
from wattsteer_ml.evaluation.gate import (
    ContractDriftError,
    GateDecision,
    decide,
    run_gate,
)
from wattsteer_ml.features import FeatureRowsQuery, read_feature_rows
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionLog
from wattsteer_ml.training.bundle import read_card
from wattsteer_ml.training.contract import (
    FeatureContract,
    read_feature_function_definition,
)

#: The migration whose `feature_rows` every pre-`0039` artifact was fitted
#: against: the newest restatement before it. Read from the tree rather than
#: reconstructed, because "the definition in force before `0039`" is a fact
#: about the migration history and not something this file gets to describe.
PREVIOUS_MIGRATION = "0036_the_same_hour_exceedance.sql"

#: How Drizzle separates statements in a hand-written migration.
STATEMENT_SEPARATOR = "--> statement-breakpoint"

FUNCTION_HEAD = "CREATE OR REPLACE FUNCTION feature_rows("

#: Two days with nothing behind them. `feature_rows` is calendar-driven, so an
#: empty store still yields the full grid — and the contract's subject is the
#: function's column list and body, neither of which a seed would move.
QUERY = FeatureRowsQuery(
    target_from=date(2025, 1, 1),
    target_to=date(2025, 1, 2),
    gate_profile="gate_late",
    feature_set="dessem_free_v1",
    threshold_mw=5.0,
)


def _drizzle() -> Path:
    return Path(__file__).resolve().parents[3] / "apps" / "api" / "drizzle"


def previous_definition_sql() -> str:
    """`0036`'s `feature_rows` statement, alone, from the migration tree."""
    text = (_drizzle() / PREVIOUS_MIGRATION).read_text(encoding="utf-8")
    statements = [
        statement
        for statement in text.split(STATEMENT_SEPARATOR)
        if FUNCTION_HEAD in statement
    ]
    if len(statements) != 1:
        raise AssertionError(
            f"{PREVIOUS_MIGRATION} holds {len(statements)} `feature_rows` "
            "definitions; this file assumes the one restatement the tree's "
            "convention produces"
        )
    return statements[0][statements[0].index(FUNCTION_HEAD) :]


@dataclass(frozen=True)
class Contracts:
    """The two contracts, each derived from its own function's own rows."""

    live: FeatureContract
    previous: FeatureContract


async def _contract(conn: asyncpg.Connection[Any]) -> FeatureContract:
    rows = await read_feature_rows(conn, QUERY)
    if not rows:
        raise AssertionError(
            "feature_rows returned no rows for a two-day window; the grid is the "
            "function's own and does not depend on a seed"
        )
    return FeatureContract.of(
        rows, function_definition=await read_feature_function_definition(conn)
    )


def contracts() -> Contracts:
    """Both contracts, read in one connection, the older one rolled back.

    The pre-`0039` definition is installed and then discarded. The transaction
    is explicit rather than a context manager because the manager commits on a
    clean exit, and committing here would leave a migrated database running a
    superseded `feature_rows` — which is precisely the state `0039` exists to
    end.
    """

    async def work(conn: asyncpg.Connection[Any]) -> Contracts:
        live = await _contract(conn)
        transaction = conn.transaction()
        await transaction.start()
        try:
            await conn.execute(previous_definition_sql())
            previous = await _contract(conn)
        finally:
            await transaction.rollback()
        restored = await read_feature_function_definition(conn)
        assert restored == live.function_definition, (
            "the rollback did not restore the live definition; this test must "
            "leave the database exactly as it found it"
        )
        return Contracts(live=live, previous=previous)

    return database_harness.run(work)


@pytest.fixture(scope="module")
def two_hashes() -> Contracts:
    return contracts()


# --- the debt exists, and it is the body that moved --------------------------


def test_0039_moved_the_feature_hash(two_hashes: Contracts) -> None:
    """The migration's central claim, measured on the server's own rendering.

    Every artifact fitted before `0039` carries `previous`. The live function
    produces `live`. They are not the same string, so every one of those
    artifacts is bound to a vector the database no longer produces — which is
    the retrain both serving lanes owe.
    """
    assert two_hashes.previous.feature_hash != two_hashes.live.feature_hash


def test_the_names_did_not_move_so_only_a_column_list_would_have_missed_it(
    two_hashes: Contracts,
) -> None:
    """`0039`: "No attribute is added here and none moves."

    True, and load-bearing twice over. It means the moved hash is attributable
    to the function *body* — the half `feature_hash` covers precisely because a
    list of column names cannot see a changed predicate — and it means the
    hashes above do not differ for some unrelated schema reason.
    """
    assert two_hashes.previous.feature_names == two_hashes.live.feature_names
    assert two_hashes.previous.function_definition != two_hashes.live.function_definition
    assert (
        two_hashes.previous.hash_payload.split("\n\x00\n")[0]
        == two_hashes.live.hash_payload.split("\n\x00\n")[0]
    )


# --- the real gate refuses it, at the check that owns it ---------------------


def _refusal(two_hashes: Contracts) -> GateDecision:
    return decide(
        candidate(feature_hash=two_hashes.live.feature_hash),
        incumbent(feature_hash=two_hashes.previous.feature_hash),
        live_feature_hash=two_hashes.live.feature_hash,
        smoke=clean_smoke(),
        now=NOW,
        draws=200,
    )


def test_a_pre_0039_artifact_is_refused_by_the_real_gate(
    two_hashes: Contracts,
) -> None:
    """Check 3, and the two before it having passed.

    Not "was refused": *refused there*. A refusal from check 1 or check 4 would
    be equally green and would say nothing about `feature_rows`.
    """
    decision = _refusal(two_hashes)
    assert not decision.promotes
    assert [check.name for check in decision.checks] == [
        "lane_identity",
        "estimator_allow_list",
        "feature_contract",
    ]
    assert all(check.passed for check in decision.checks[:-1])
    assert not decision.checks[-1].passed


def test_the_refusal_names_the_two_real_hashes(two_hashes: Contracts) -> None:
    """The mismatch, in the reason an operator reads, with both real digests."""
    decision = _refusal(two_hashes)
    assert decision.checks[-1].values == {
        "live_feature_hash": two_hashes.live.feature_hash,
        "candidate_feature_hash": two_hashes.live.feature_hash,
        "incumbent_feature_hash": two_hashes.previous.feature_hash,
    }
    assert two_hashes.live.feature_hash in decision.reason
    assert two_hashes.previous.feature_hash in decision.reason
    drift = decision.contract_drift
    assert drift is not None
    assert drift.live == two_hashes.live.feature_hash
    assert drift.incumbent == two_hashes.previous.feature_hash


def test_the_same_pair_promotes_under_the_live_hash(two_hashes: Contracts) -> None:
    """The control. One field moved; everything else identical.

    This is what makes the two tests above evidence: the refusal is caused by
    the pre-`0039` hash and not by anything else in the fixture.
    """
    promoted = decide(
        candidate(feature_hash=two_hashes.live.feature_hash),
        incumbent(feature_hash=two_hashes.live.feature_hash),
        live_feature_hash=two_hashes.live.feature_hash,
        smoke=clean_smoke(),
        now=NOW,
        draws=200,
    )
    assert promoted.promotes
    assert all(check.passed for check in promoted.checks)


def test_the_refusal_is_recorded_and_the_incumbent_marked(
    two_hashes: Contracts, tmp_path: Path
) -> None:
    """`run_gate`'s whole obligation, on the real hashes.

    Written first, then the incumbent marked, then raised. And nothing softened:
    the lane's only sound artifact is the candidate the gate just refused, so the
    lane serves nothing — which is the correct outcome and the reason `0039` put
    the conjunct inside `feature_rows`.
    """
    lane_directory(tmp_path)
    lane_directory(tmp_path, artifact_id=INCUMBENT_ID)
    with pytest.raises(ContractDriftError) as raised:
        run_gate(
            candidate(feature_hash=two_hashes.live.feature_hash),
            incumbent(feature_hash=two_hashes.previous.feature_hash),
            root=tmp_path,
            live_feature_hash=two_hashes.live.feature_hash,
            smoke=clean_smoke(),
            now=NOW,
            draws=50,
        )
    message = str(raised.value)
    assert two_hashes.live.feature_hash in message
    assert two_hashes.previous.feature_hash in message

    log = PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME)
    assert [record.decision for record in log.records] == ["refuse"]
    assert log.records[0].artifact_id == CANDIDATE_ID
    assert log.promoted(LANE) is None
    assert log.records[0].evidence["contract_drift"] == {
        "lane": LANE.directory_name,
        "live_feature_hash": two_hashes.live.feature_hash,
        "candidate_feature_hash": two_hashes.live.feature_hash,
        "incumbent_artifact_id": INCUMBENT_ID,
        "incumbent_feature_hash": two_hashes.previous.feature_hash,
    }

    fault = contract_fault(
        read_card(tmp_path / LANE.directory_name / f"{INCUMBENT_ID}{CARD_SUFFIX}")
    )
    assert fault is not None
    assert two_hashes.previous.feature_hash in fault
    assert two_hashes.live.feature_hash in fault
