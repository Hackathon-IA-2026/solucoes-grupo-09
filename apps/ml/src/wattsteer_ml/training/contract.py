"""What a bundle is bound to: the ordered feature names, and the SQL behind them.

`docs/specs/forecaster.md`, "The artifact": the card carries a **`feature_hash`**
— "sha256 over the ordered feature names *and* the `feature_rows` function
definition" — and the hot-swap gate's third check compares it against the hash
the *live* function produces right now, refusing the swap and raising when the
two disagree. That check is only worth anything if the hash covers the thing
that can change silently, which is the function body: renaming nothing and
moving one window frame by an hour is a change no list of column names can see.

So a contract is two things held together:

- the **ordered feature names**, taken from the row the database returned and
  never re-spelt on this side (`features.py` explains why the names are the
  identity), together with each column's dtype and, for the one categorical
  column, its levels;
- the **function definition**, read back from Postgres with
  ``pg_get_functiondef`` — the server's own normalised rendering, not the
  migration file's text, so a hash computed here matches the hash computed on a
  deployed database that reached the same definition by a different route.

**Which columns are features.** The composite type `feature_row` carries three
kinds of column and the split is by name, once, here: the stamps
(``target_date``, ``gate_at``, ``threshold_mw``, ``vintage_fidelity`` …), the
labels (everything prefixed ``y_``), and everything else, which is a feature.
``subsystem`` is deliberately on the feature side: `docs/specs/forecaster.md`
requires "one model across subsystems, with `subsystem` as a categorical
feature", so it is a column of the design matrix and also the row's identity,
and there is no third list to keep in step.

**Dtypes are read off the rows, not declared.** A second table of column types
on this side would be a dictionary to maintain against a composite type that
already has one, and it would be wrong in exactly the interesting case — a
feature block that has landed in the migration tree but is not yet populated.
The dtype is therefore the type of the first non-NULL value the training rows
show, and an all-NULL column is recorded as such: it is carried through the
contract (its name is in the hash, because the SQL emits it) and it is
:attr:`FeatureContract.unpopulated`, which is the honest description of a
feature block that exists but has no data behind it yet.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

import asyncpg

from wattsteer_ml.constants import SUBSYSTEM_CODES

#: Columns of `feature_row` that stamp the row rather than describe it. Neither
#: features nor labels: they say which gate, which lane and which vintage
#: produced the row, and every one of them is constant within a training call —
#: which is why feeding any of them to a booster would be feeding it a constant.
STAMP_COLUMNS: tuple[str, ...] = (
    "valid_time",
    "target_date",
    "gate_profile",
    "gate_at",
    "feature_set",
    "threshold_mw",
    "vintage_fidelity",
)

#: Every target column of `feature_row` is prefixed this way, so the label side
#: of the split needs no list that could fall behind a migration.
LABEL_PREFIX = "y_"

#: The one categorical feature, and its closed level set. `SIN` is not a
#: subsystem; :mod:`wattsteer_ml.constants` is the authority and a level outside
#: it is an error rather than a new category.
SUBSYSTEM_COLUMN = "subsystem"

#: How a dtype is spelt in the contract and on the card.
Dtype = Literal["numeric", "boolean", "categorical", "unpopulated"]

#: ``pg_get_functiondef`` on the five-argument `feature_rows`. One expression,
#: no join and no predicate of ours: the regprocedure cast names the overload,
#: so a future second signature cannot make this ambiguous.
FUNCTION_DEFINITION_SQL = (
    "select pg_get_functiondef("
    "'feature_rows(date, date, text, text, double precision)'::regprocedure"
    ") as definition"
)

#: Separates the two halves of the hashed payload. A byte that cannot occur in
#: an identifier or in SQL text, so no feature name can spell the boundary.
_HASH_SEPARATOR = "\n\x00\n"


class FeatureContractError(ValueError):
    """The rows and the contract disagree about what a feature vector is."""


@dataclass(frozen=True)
class FeatureColumn:
    """One column of the design matrix, as the bundle stores it."""

    name: str
    dtype: Dtype
    #: The categorical levels, in the order they are encoded. Empty for every
    #: other dtype, so the encoding of a numeric column is not a thing that can
    #: be configured by accident.
    levels: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.dtype == "categorical" and not self.levels:
            raise FeatureContractError(
                f"{self.name!r} is categorical but carries no levels; an "
                "unbounded categorical is an encoding that changes between fits"
            )
        if self.dtype != "categorical" and self.levels:
            raise FeatureContractError(
                f"{self.name!r} is {self.dtype} and cannot carry levels {self.levels!r}"
            )


@dataclass(frozen=True)
class FeatureContract:
    """The ordered feature list and the SQL that produced it, hashed together."""

    columns: tuple[FeatureColumn, ...]
    #: ``pg_get_functiondef(feature_rows)`` as the server renders it.
    function_definition: str

    def __post_init__(self) -> None:
        if not self.columns:
            raise FeatureContractError("a feature contract with no columns is not one")
        names = [column.name for column in self.columns]
        if len(set(names)) != len(names):
            raise FeatureContractError(f"duplicate feature names: {names!r}")
        if not self.function_definition.strip():
            raise FeatureContractError(
                "the feature function's definition is part of the contract; an "
                "empty one would hash a lane to a body nobody can produce"
            )

    @property
    def feature_names(self) -> tuple[str, ...]:
        """The ordered names, as the database spells them."""
        return tuple(column.name for column in self.columns)

    @property
    def categorical_indices(self) -> tuple[int, ...]:
        """Positions LightGBM must be told are categorical."""
        return tuple(
            index
            for index, column in enumerate(self.columns)
            if column.dtype == "categorical"
        )

    @property
    def unpopulated(self) -> tuple[str, ...]:
        """Feature columns the training rows showed as NULL throughout.

        Named rather than dropped. The column is in the vector because the SQL
        emits it, so it is in the hash; what this says is that no fit in this
        artifact could have learnt anything from it, which is the sentence a
        reader of the card needs when a feature block has landed but its
        ingestion has not.
        """
        return tuple(
            column.name for column in self.columns if column.dtype == "unpopulated"
        )

    @property
    def hash_payload(self) -> str:
        """Exactly what is hashed. Exposed so a test can assert on it, not on hex."""
        return "\n".join(self.feature_names) + _HASH_SEPARATOR + self.function_definition

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.hash_payload.encode()).hexdigest()

    @property
    def feature_hash(self) -> str:
        """The card and gate spelling: ``sha256:<hex>``."""
        return f"sha256:{self.digest}"

    def card_fields(self) -> dict[str, Any]:
        return {
            "feature_hash": self.feature_hash,
            "feature_names": list(self.feature_names),
            "feature_dtypes": {column.name: column.dtype for column in self.columns},
            "categorical_levels": {
                column.name: list(column.levels)
                for column in self.columns
                if column.levels
            },
            "unpopulated_features": list(self.unpopulated),
        }

    @classmethod
    def of(
        cls,
        rows: Sequence[Mapping[str, Any]],
        *,
        function_definition: str,
    ) -> FeatureContract:
        """Derive the contract from the rows the feature function returned.

        The order is the row's own key order, which is the order of the
        composite type's attributes, which is the order the ``SELECT`` writes —
        one order, decided in SQL, and read here rather than restated.
        """
        if not rows:
            raise FeatureContractError(
                "a feature contract is derived from rows; none were returned"
            )
        names = feature_column_names(rows[0])
        for row in rows:
            if feature_column_names(row) != names:
                raise FeatureContractError(
                    "the rows do not agree on their feature columns; "
                    f"{names!r} then {feature_column_names(row)!r}"
                )
        return cls(
            columns=tuple(_column(name, rows) for name in names),
            function_definition=function_definition,
        )


def feature_column_names(row: Mapping[str, Any]) -> tuple[str, ...]:
    """The feature columns of one row, in the order the database returned them."""
    return tuple(
        name
        for name in row
        if name not in STAMP_COLUMNS and not name.startswith(LABEL_PREFIX)
    )


def _column(name: str, rows: Iterable[Mapping[str, Any]]) -> FeatureColumn:
    if name == SUBSYSTEM_COLUMN:
        return FeatureColumn(
            name=name, dtype="categorical", levels=tuple(SUBSYSTEM_CODES)
        )
    for row in rows:
        value = row[name]
        if value is None:
            continue
        if isinstance(value, bool):
            return FeatureColumn(name=name, dtype="boolean")
        if isinstance(value, int | float):
            return FeatureColumn(name=name, dtype="numeric")
        raise FeatureContractError(
            f"feature {name!r} carries {type(value).__name__}, which is not a "
            "number, a boolean or the one categorical this vector has; the "
            "column belongs on the stamp side of the split or nowhere"
        )
    return FeatureColumn(name=name, dtype="unpopulated")


async def read_feature_function_definition(conn: asyncpg.Connection[Any]) -> str:
    """The live ``feature_rows`` body, as the server renders it.

    The half of the contract that a column list cannot see. Read from the
    database rather than from `apps/api/drizzle/*.sql` on purpose: the migration
    files are the history of the definition, and the gate's question is about
    the definition in force.
    """
    definition = await conn.fetchval(FUNCTION_DEFINITION_SQL)
    if not isinstance(definition, str) or not definition.strip():
        raise FeatureContractError(
            "the database returned no definition for feature_rows(date, date, "
            "text, text, double precision); the feature gate is not installed"
        )
    return definition
