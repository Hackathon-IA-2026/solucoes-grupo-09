"""Fixtures shared by the training tests: one fold, one fit, reused.

Fitting six boosters is the only expensive thing in this suite, so it happens
once per session and the assertions read the same bundle. The fold is a **real**
fold of the shared calendar — materialised from `fold_calendar.yaml` with an
``as_of`` that leaves F1 as the live edge, so its test period is seven days
rather than a whole quarter. Nothing here recomputes a fold: the blocks come
from :meth:`Fold.blocks_for`, which is the only constructor there is.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import Any

import pytest

from feature_row_fixtures import feature_rows
from out_of_fold_fixtures import pool as out_of_fold_pool
from wattsteer_ml.evaluation import Fold, FoldBlocks, materialize_fold_calendar
from wattsteer_ml.training import OutOfFoldPool, TrainedFold, train_fold

#: The harness's day. F1 opened on 2025-04-01, so on this date it is the live
#: edge with seven settled test days behind it.
AS_OF = date(2025, 4, 8)

#: The run's window. Thirty base-fit days: enough for the boosters to have
#: something to split on, small enough that the suite fits in a coffee break.
WINDOW_START = date(2024, 12, 2)

#: Stands in for ``pg_get_functiondef(feature_rows)``. The tests that care about
#: the hash vary it deliberately; the ones that do not just need it to be fixed.
FUNCTION_DEFINITION = (
    "CREATE OR REPLACE FUNCTION public.feature_rows(target_from date, "
    "target_to date, gate_profile text, feature_set text, "
    "threshold_mw double precision)\n RETURNS SETOF feature_row\n"
    " LANGUAGE plpgsql\nAS $function$ BEGIN RETURN; END $function$\n"
)


@pytest.fixture(scope="session")
def fold() -> Fold:
    return materialize_fold_calendar(AS_OF).fold("F1")


@pytest.fixture(scope="session")
def blocks(fold: Fold) -> FoldBlocks:
    return fold.blocks_for(WINDOW_START)


@pytest.fixture(scope="session")
def rows(blocks: FoldBlocks) -> list[dict[str, Any]]:
    return feature_rows(first=blocks.base_fit_start, last=blocks.test_end)


@pytest.fixture(scope="session")
def test_rows(rows: Sequence[dict[str, Any]], blocks: FoldBlocks) -> list[dict[str, Any]]:
    return [row for row in rows if row["target_date"] >= blocks.test_start]


@pytest.fixture(scope="session")
def pool() -> OutOfFoldPool:
    """The pooled out-of-fold predictions the reliability curve is measured on.

    Fabricated (`out_of_fold_fixtures.py`), because the shared calendar's
    ``as_of`` leaves F1 as the live edge and a first fold has no predecessors to
    pool. The curve's *numbers* are therefore meaningless and no test asserts
    anything about them; what the tests assert is which rows it is allowed to
    consume.
    """
    return out_of_fold_pool()


@pytest.fixture(scope="session")
def trained(
    rows: Sequence[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    pool: OutOfFoldPool,
) -> TrainedFold:
    return train_fold(
        rows,
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
        pool=pool,
        artifact_id="2026-08-29T04:00:00Z",
        created_at=None,
    )
