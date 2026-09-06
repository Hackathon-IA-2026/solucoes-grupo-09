"""The feature contract: what `feature_hash` covers, and what it refuses.

`docs/specs/forecaster.md` makes the hash "sha256 over the ordered feature names
*and* the `feature_rows` function definition", and the hot-swap gate's third
check compares it against the hash the live function produces. Every test here
is about a change the hash must see — because a hash that misses one is a hash
that lets a silently different feature vector keep serving.
"""

from __future__ import annotations

import inspect
from datetime import date
from typing import Any

import pytest

from conftest import FUNCTION_DEFINITION
from feature_row_fixtures import feature_rows
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.training import contract as contract_module
from wattsteer_ml.training.contract import (
    FUNCTION_DEFINITION_SQL,
    FeatureColumn,
    FeatureContract,
    FeatureContractError,
    feature_column_names,
)

ROWS = feature_rows(first=date(2025, 1, 1), last=date(2025, 1, 2))


def contract_of(rows: list[dict[str, Any]], definition: str) -> FeatureContract:
    return FeatureContract.of(rows, function_definition=definition)


def test_the_stamps_and_the_labels_are_not_features() -> None:
    """A stamp is constant within a lane and a label is the answer.

    Feeding either to a booster is a different failure each way round: a stamp
    is a column with no variance, a label is the target read straight back.
    """
    names = feature_column_names(ROWS[0])
    assert "subsystem" in names, "the one categorical feature is a feature"
    for stamp in ("target_date", "gate_at", "threshold_mw", "vintage_fidelity"):
        assert stamp not in names
    assert not [name for name in names if name.startswith("y_")]


def test_the_feature_order_is_the_databases_order() -> None:
    """The names are the identity, in the order the composite type declares."""
    assert feature_column_names(ROWS[0])[0] == "subsystem"
    assert contract_of(ROWS, FUNCTION_DEFINITION).feature_names == feature_column_names(
        ROWS[0]
    )


def test_the_hash_moves_when_the_function_body_moves() -> None:
    """The half a column list cannot see.

    A window frame moved by one hour renames nothing. If the hash did not cover
    the body, the gate would compare two identical hashes across a changed
    feature and promote into it.
    """
    one = contract_of(ROWS, FUNCTION_DEFINITION)
    other = contract_of(ROWS, FUNCTION_DEFINITION.replace("RETURN;", "RETURN NEXT;"))
    assert one.feature_names == other.feature_names
    assert one.feature_hash != other.feature_hash


def test_the_hash_moves_when_the_order_moves() -> None:
    """Two vectors with the same names in a different order are two vectors."""
    columns = contract_of(ROWS, FUNCTION_DEFINITION).columns
    reordered = FeatureContract(
        columns=columns[:1] + tuple(reversed(columns[1:])),
        function_definition=FUNCTION_DEFINITION,
    )
    assert reordered.feature_hash != contract_of(ROWS, FUNCTION_DEFINITION).feature_hash


def test_the_hash_is_stable_across_processes() -> None:
    """sha256 of a stated payload, so a second run of the retrain agrees."""
    contract = contract_of(ROWS, FUNCTION_DEFINITION)
    assert contract.feature_hash.startswith("sha256:")
    assert contract.hash_payload.startswith("subsystem\n")
    assert contract.hash_payload.endswith(FUNCTION_DEFINITION)


def test_an_all_null_column_is_named_rather_than_dropped() -> None:
    """A feature block that has landed but is not populated says so.

    Dropping the column would change the hash and hide the fact; imputing it
    would invent the data. Naming it is the third option and the honest one.
    """
    blanked = [dict(row, weather_temperature_2m=None) for row in ROWS]
    contract = contract_of(blanked, FUNCTION_DEFINITION)
    assert "weather_temperature_2m" in contract.unpopulated
    assert "weather_temperature_2m" in contract.feature_names


def test_the_lanes_absent_block_is_unpopulated_rather_than_missing() -> None:
    """The unblanked case, and the one a real ``dessem_free_v1`` row shows.

    ``0025_dessem_and_the_feature_set.sql`` makes the class-D block return no
    rows for this set, so its twenty-two attributes arrive NULL at every hour.
    They are still in the hash — the SQL emits them — and the contract's job is
    to say "named, empty" rather than to quietly narrow the vector.
    """
    contract = contract_of(ROWS, FUNCTION_DEFINITION)
    dessem = tuple(name for name in contract.feature_names if name.startswith("dessem_"))
    assert dessem, "the fixture builds no dessem_* columns at all"
    assert set(dessem) <= set(contract.unpopulated)


def test_the_subsystem_levels_are_the_closed_enum() -> None:
    """Four members, from `constants`. `SIN` is not a fifth."""
    contract = contract_of(ROWS, FUNCTION_DEFINITION)
    subsystem = next(c for c in contract.columns if c.name == "subsystem")
    assert subsystem.dtype == "categorical"
    assert subsystem.levels == tuple(SUBSYSTEM_CODES)
    assert contract.categorical_indices == (0,)


def test_rows_that_disagree_about_their_columns_are_refused() -> None:
    mixed = [ROWS[0], {k: v for k, v in ROWS[1].items() if k != "solar_zenith_cos"}]
    with pytest.raises(FeatureContractError):
        contract_of(mixed, FUNCTION_DEFINITION)


def test_a_categorical_without_levels_cannot_be_built() -> None:
    with pytest.raises(FeatureContractError):
        FeatureColumn(name="subsystem", dtype="categorical")


def test_the_definition_is_read_from_the_server_not_the_migrations() -> None:
    """One expression, no join, and the overload named by a regprocedure cast.

    The migration files are the *history* of the definition; the gate asks about
    the definition in force, which only the server can answer.
    """
    assert "pg_get_functiondef" in FUNCTION_DEFINITION_SQL
    assert "regprocedure" in FUNCTION_DEFINITION_SQL
    assert " join " not in FUNCTION_DEFINITION_SQL.lower()
    assert inspect.getsource(contract_module).count("select ") == 1
