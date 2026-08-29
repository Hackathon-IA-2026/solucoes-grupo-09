"""The canonical read contract, executed against Postgres.

**This is the module ticket 016 exists to make possible.** Ticket 013's contract
was a TypeScript module composing TypeScript functions, which Python cannot
hold, so it had to be re-served over HTTP at ``/v1/canonical`` and the modelling
service reached the platform through the gateway. That inverted the direction
`docs/specs/api-surface.md` documents, put a ~37M-row training read through
JSON, and made ``ml → api → ml`` a dependency cycle.

The contract is SQL views now, so this module is what the modelling side uses:
it opens a read-only transaction on the pool, writes the read axes, and selects
from the same views ``apps/api/src/contract/reads.ts`` selects from. **There is
no HTTP client here and there must never be one.** The ``/v1/canonical`` routes
still serve, but for the web app and for debugging — they are not this path.

What is *not* duplicated from the TypeScript side, and why:

* The ``AsOf`` pick, the renames, the grain, the unit and timestamp resolution —
  all of it is in the view. Nothing here writes a ``DISTINCT ON``, and a search
  of this file for a base table name finds none.
* The view a read lives in is **derived** from its manifest name rather than
  listed, so a table mapping cannot go stale on one side (:func:`view_name`).

What *is* duplicated, deliberately, is :func:`~wattsteer_ml.canonical.
vintage_fidelity` — two timestamps and an inequality, bound in both languages by
the golden vectors in ``packages/core/fixtures/canonical-contract/``. The
database supplies its input (``canonical_read_go_live``) and nothing more.

`docs/contracts/canonical-reads.md` is the document; `docs/domain-model.md` is
the authority for every name.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import asyncpg

from .canonical import (
    CANONICAL_READ_BY_NAME,
    CanonicalRead,
    FactKind,
    VintageFidelity,
    VintageSource,
    combine_fidelity,
    combine_go_live,
    vintage_fidelity,
)

#: The view a canonical read is served by.
#:
#: Derived, not tabulated: a lookup table mapping eight read names to eight view
#: names is a second place the pairing is written down, and the failure it
#: invites is the quiet one — a renamed view and a stale entry that still parses.
#: `apps/api/src/database/canonical-views.ts` declares the same names under the
#: same rule, and `tests/test_canonical_contract.py` checks every read resolves.


def view_name(read: str) -> str:
    """``curtailment-by-plant`` → ``canonical_curtailment_by_plant``."""
    if read not in CANONICAL_READ_BY_NAME:
        raise KeyError(f"{read!r} is not a canonical read")
    return "canonical_" + read.replace("-", "_")


#: Which equality filters each read accepts, by view column.
#:
#: A whitelist rather than an escape: the column name is interpolated into the
#: SQL text (it cannot be a bind parameter) and the value never is. A filter not
#: in this mapping is a programming error and is refused loudly, so no caller can
#: reach a column the contract does not offer — and none can reach a filter the
#: view applies *before* choosing a version, which are axes and not filters.
FILTERABLE: Mapping[str, frozenset[str]] = {
    "curtailment-by-reporting-entity": frozenset(
        {"reporting_entity_code", "reporting_entity_kind", "technology"}
    ),
    "curtailment-by-plant": frozenset({"plant_ons_code", "technology"}),
    "system-context": frozenset({"subsystem"}),
    "system-exchange": frozenset({"from_subsystem", "to_subsystem"}),
    "day-ahead-balance": frozenset({"subsystem"}),
    "weather-forecast": frozenset({"centroid_id"}),
    "installed-capacity": frozenset({"subsystem", "technology"}),
    "conjunto-membership": frozenset({"plant_ons_code", "conjunto_code"}),
}


@dataclass(frozen=True)
class ReadAxes:
    """The axes the canonical views read from the session.

    Mirrors ``ReadAxes`` in ``apps/api/src/contract/scope.ts``. ``as_of`` has no
    default here and none in the database: ``canonical_as_of()`` raises when the
    setting is missing rather than falling back to ``now()``, because a default
    would turn a forgotten axis into a latest-version read that is
    indistinguishable from a correct answer.
    """

    as_of: datetime
    #: Fleet date for a registry read. The database truncates it to a UTC day.
    fleet_date: datetime | None = None
    #: The day-ahead gate. Cuts on publication, not on ingestion.
    published_at_or_before: datetime | None = None
    #: Restrict the weather read to one run cycle. ``None`` is the normal read.
    weather_run_cycle: str | None = None


@dataclass(frozen=True)
class VintageReceipt:
    """The vintage of an answer, returned beside its rows on every read.

    Not optional, not nullable and not behind a flag — there is no shape of this
    contract in which a consumer holds rows without holding the receipt that
    says which version of the truth they are.
    """

    as_of: datetime
    #: Valid-time window ``[from, to)`` for a fact read; ``None`` for a registry one.
    window: tuple[datetime, datetime] | None
    #: The fleet date for a registry read; ``None`` for a fact read.
    fleet_date: datetime | None
    vintage_fidelity: VintageFidelity
    go_live_at: datetime | None
    sources: list[VintageSource]


@dataclass(frozen=True)
class CanonicalReadResult:
    """The envelope every canonical read returns."""

    read: str
    #: Observation or forecast, restated on the answer as well as in the manifest.
    kind: FactKind
    rows: list[dict[str, Any]]
    vintage: VintageReceipt


async def apply_axes(conn: asyncpg.Connection[Any], axes: ReadAxes) -> None:
    """Write the read axes for the rest of this transaction.

    Every axis on every call, absent ones as the empty string. The settings live
    on a pooled connection, and a read that only wrote the axes it cared about
    would inherit the previous read's gate — an answer that is wrong in a way no
    test of that read alone could see.
    """

    def instant(value: datetime | None) -> str:
        return "" if value is None else value.isoformat()

    await conn.execute(
        """
        select
          set_config('wattsteer.as_of', $1, true),
          set_config('wattsteer.fleet_date', $2, true),
          set_config('wattsteer.published_at_or_before', $3, true),
          set_config('wattsteer.weather_run_cycle', $4, true)
        """,
        instant(axes.as_of),
        instant(axes.fleet_date),
        instant(axes.published_at_or_before),
        axes.weather_run_cycle or "",
    )


async def read_go_live(conn: asyncpg.Connection[Any], read: str) -> datetime | None:
    """WattSteer's own go-live for one read — the fidelity rule's only input.

    Deliberately not filtered by ``as_of``: go-live is a fact about WattSteer's
    history rather than about the cut being asked for, and filtering it would
    make a sufficiently early ``as_of`` report a live source as having ingested
    nothing. It is also the one canonical view that needs no axis set.
    """
    value = await conn.fetchval(
        "select go_live_at from canonical_read_go_live where read = $1", read
    )
    return value if value is None else _as_datetime(value)


def _as_datetime(value: object) -> datetime:
    if not isinstance(value, datetime):  # pragma: no cover — asyncpg types these
        raise TypeError(f"expected a timestamptz, got {type(value)!r}")
    return value


def _filters(read: str, filters: Mapping[str, object] | None) -> tuple[str, list[object]]:
    """Render the equality filters, refusing any column the read does not offer."""
    if not filters:
        return "", []
    allowed = FILTERABLE[read]
    clauses: list[str] = []
    values: list[object] = []
    for column, value in filters.items():
        if column not in allowed:
            raise KeyError(
                f"{column!r} is not filterable on {read!r}; "
                f"the contract offers {sorted(allowed)}"
            )
        values.append(value)
        clauses.append(f"and {column} = ${len(values)}")
    return " ".join(clauses), values


def _receipt(
    spec: CanonicalRead,
    axes: ReadAxes,
    window: tuple[datetime, datetime] | None,
    go_live_at: datetime | None,
) -> VintageReceipt:
    """Apply the fidelity rule on the axis this read's fidelity is decided by.

    ``valid_time`` for a fact read — the window start, because one pre-go-live
    hour makes the whole answer a restatement. ``fleet_date`` for a registry
    read, where today's snapshot is the only record of a past fleet.
    """
    if spec.fidelity_axis == "fleet_date":
        axis_instant = axes.fleet_date
    elif spec.fidelity_axis == "as_of":
        axis_instant = axes.as_of
    else:
        axis_instant = window[0] if window else axes.as_of
    if axis_instant is None:  # pragma: no cover — the callers below always set it
        raise ValueError(f"{spec.name} needs a {spec.fidelity_axis} to state fidelity")

    source = VintageSource(
        read=spec.name,
        vintage_fidelity=vintage_fidelity(axis_instant, go_live_at),
        go_live_at=go_live_at,
    )
    return VintageReceipt(
        as_of=axes.as_of,
        window=window,
        fleet_date=axes.fleet_date if window is None else None,
        vintage_fidelity=source.vintage_fidelity,
        go_live_at=source.go_live_at,
        sources=[source],
    )


async def _select(
    conn: asyncpg.Connection[Any],
    read: str,
    predicate: str,
    values: Sequence[object],
) -> list[dict[str, Any]]:
    # S608: the two interpolated fragments are both closed sets, not input.
    # `view_name` refuses anything outside the eight-name manifest, and
    # `predicate` is assembled from `FILTERABLE` — a whitelist of view columns —
    # with every *value* bound as a parameter. A relation name and a column name
    # cannot be bind parameters in Postgres, so a whitelist is the only
    # available safety and it is applied before either reaches this line.
    query = f"select * from {view_name(read)} where {predicate}"  # noqa: S608
    records = await conn.fetch(query, *values)
    return [dict(record) for record in records]


async def read_fact(
    conn: asyncpg.Connection[Any],
    read: str,
    *,
    as_of: datetime,
    window_from: datetime,
    window_to: datetime,
    filters: Mapping[str, object] | None = None,
    published_at_or_before: datetime | None = None,
    weather_run_cycle: str | None = None,
) -> CanonicalReadResult:
    """One fact read, over the half-open valid-time window ``[from, to)``.

    ``published_at_or_before`` and ``weather_run_cycle`` are **axes**, not
    filters, and are passed as such: the view applies them before choosing a
    version, because "the latest version of the 00Z run" is not "the latest
    version, discarded if it turned out to be 12Z", and the day-ahead gate has
    the same shape.

    Opens its own transaction so the axes cannot outlive it. The pool is already
    read-only (``default_transaction_read_only``), so this transaction is too.
    """
    spec = CANONICAL_READ_BY_NAME[read]
    if window_to <= window_from:
        # An empty result would read as "there was no curtailment", which is a
        # different and much worse statement than "your window is backwards".
        raise ValueError("window_to must be strictly after window_from — [from, to)")

    axes = ReadAxes(
        as_of=as_of,
        published_at_or_before=published_at_or_before,
        weather_run_cycle=weather_run_cycle,
    )
    clauses, values = _filters(read, filters)
    async with conn.transaction():
        await apply_axes(conn, axes)
        rows = await _select(
            conn,
            read,
            f"valid_time >= $1 and valid_time < $2 {_shift(clauses, 2)}",
            [window_from, window_to, *values],
        )
        go_live_at = await read_go_live(conn, read)

    return CanonicalReadResult(
        read=spec.name,
        kind=spec.kind,
        rows=rows,
        vintage=_receipt(spec, axes, (window_from, window_to), go_live_at),
    )


async def read_registry(
    conn: asyncpg.Connection[Any],
    read: str,
    *,
    as_of: datetime,
    fleet_date: datetime,
    filters: Mapping[str, object] | None = None,
) -> CanonicalReadResult:
    """One registry read, resolved at a fleet date.

    Both registry reads are functions of *two* instants — what WattSteer had
    learned, and which day the fleet is being asked about — and neither is
    defaulted. Installed capacity is never a stored scalar: it is the sum over
    the units live on the fleet date, and the units of one plant routinely
    commission months apart.
    """
    spec = CANONICAL_READ_BY_NAME[read]
    axes = ReadAxes(as_of=as_of, fleet_date=fleet_date)
    clauses, values = _filters(read, filters)
    async with conn.transaction():
        await apply_axes(conn, axes)
        rows = await _select(conn, read, f"true {clauses}", values)
        go_live_at = await read_go_live(conn, read)

    return CanonicalReadResult(
        read=spec.name,
        kind=spec.kind,
        rows=rows,
        vintage=_receipt(spec, axes, None, go_live_at),
    )


def _shift(clauses: str, offset: int) -> str:
    """Renumber ``$1, $2 …`` in a filter fragment past the window's parameters."""
    if not clauses:
        return ""
    shifted = clauses
    # Descending, so ``$2`` cannot be rewritten twice on its way to ``$4``.
    for index in range(clauses.count("$"), 0, -1):
        shifted = shifted.replace(f"${index}", f"${index + offset}")
    return shifted


def combine(results: Iterable[CanonicalReadResult]) -> VintageReceipt | None:
    """One receipt over several reads — the weakest link across all of them.

    A bundle assembled from a point-in-time curtailment series and a
    revision-optimistic weather series is revision-optimistic as a whole,
    because a consumer cannot use half of it, and ``go_live_at`` is the *latest*
    contributing go-live — or ``None`` if any source has ingested nothing at
    all, because then no such instant exists.

    ``None`` when nothing was read: there is no window and no cut to report.
    """
    parts = list(results)
    if not parts:
        return None
    sources = [source for part in parts for source in part.vintage.sources]
    first = parts[0].vintage
    return VintageReceipt(
        as_of=first.as_of,
        window=first.window,
        fleet_date=first.fleet_date,
        vintage_fidelity=combine_fidelity(sources),
        go_live_at=combine_go_live(sources),
        sources=sources,
    )
