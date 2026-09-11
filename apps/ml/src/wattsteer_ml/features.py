"""The modelling side's only way to obtain a feature row.

``feature_rows(...)`` is a set-returning function in the API's migration tree
(``apps/api/drizzle/0016_the_feature_gate.sql``). This module calls it and does
**nothing else**: no window, no join, no time offset. That line is precise and
it is the ownership boundary — if a computation needs another row, it belongs in
the function, because the leak lives in the window frame and there must be
exactly one place where that frame is written.

What this service may still do is everything row-local and model-internal:
scaling, categorical encoding, the imputation policy inside the estimator
pipeline, sample weighting, the train/test split.

## Why there is no ``as_of`` argument here

Because ``feature_rows`` has no parameter for one. It takes a date range, a gate
profile, a feature set and a threshold; the gate is derived per row from the
target date inside the function, and the read axes the canonical views run on
are written by the function itself. So this module never calls
:func:`wattsteer_ml.canonical_reads.apply_axes` and never could usefully — there
is no instant it is allowed to choose. Training passes a range, serving passes
tomorrow twice, and the two execute the same expression over the same views.

That is also why :func:`read_serving_rows` delegates rather than implements.
There is no second query to drift from the first.

## Rows are returned exactly as the database names them

Every other read here maps nothing either, but for this one it is load-bearing:
a feature's name is its identity, ``docs/specs/forecaster.md`` hashes the ordered
names into a lane's ``feature_hash``, and a second spelling on the Python side
would be a second dictionary kept in step by hand.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

import asyncpg

#: The two decision gates. `docs/specs/feature-engineering.md` §"The gate":
#: ``gate_early`` is D-1 09:00 BRT on the 00Z run with no DESSEM; ``gate_late``
#: is D-1 19:00 BRT on the 12Z run, and is v1's primary.
GateProfile = Literal["gate_early", "gate_late"]

#: The two feature sets of the DESSEM A/B. ``dessem_augmented_v1`` exists only
#: at ``gate_late``, and the database refuses the other combination rather than
#: returning empty columns for it.
FeatureSet = Literal["dessem_free_v1", "dessem_augmented_v1"]

#: The grid's own civil time. The day-ahead product forecasts a Brazilian
#: calendar day, so "tomorrow" is tomorrow here and not in UTC.
BRASILIA = ZoneInfo("America/Sao_Paulo")

#: The one statement in this module. Five bound arguments, no predicate of our
#: own, and nothing to interpolate.
FEATURE_ROWS_SQL = "select * from feature_rows($1::date, $2::date, $3, $4, $5)"


@dataclass(frozen=True)
class FeatureRowsQuery:
    """A training call: a range of target dates, one gate per date.

    ``target_from`` and ``target_to`` are civil dates and never instants. A
    range query does not have "a gate" — it has one per day, resolved inside the
    function — which is exactly why the caller cannot hold one.
    """

    target_from: date
    target_to: date
    gate_profile: GateProfile
    feature_set: FeatureSet
    #: The positive class boundary, in MW at subsystem grain. An argument so the
    #: >1 / >5 / >10 sweep costs a parameter rather than a rebuild, and stamped
    #: on every returned row so no artifact can disagree about which one it saw.
    threshold_mw: float


async def read_feature_rows(
    conn: asyncpg.Connection[Any], query: FeatureRowsQuery
) -> list[dict[str, Any]]:
    """The training call. Rows come back keyed as the database names them."""
    records = await conn.fetch(
        FEATURE_ROWS_SQL,
        query.target_from,
        query.target_to,
        query.gate_profile,
        query.feature_set,
        query.threshold_mw,
    )
    return [dict(record) for record in records]


async def read_serving_rows(
    conn: asyncpg.Connection[Any],
    *,
    target_date: date,
    gate_profile: GateProfile,
    feature_set: FeatureSet,
    threshold_mw: float,
) -> list[dict[str, Any]]:
    """The serving call: ``target_from = target_to = tomorrow``.

    A delegation on purpose. "The serving row equals the training row" is a
    property of this function's shape before it is a fact any test discovers.
    """
    return await read_feature_rows(
        conn,
        FeatureRowsQuery(
            target_from=target_date,
            target_to=target_date,
            gate_profile=gate_profile,
            feature_set=feature_set,
            threshold_mw=threshold_mw,
        ),
    )


@dataclass(frozen=True)
class MaterialisedFeatureRows:
    """One ``feature_rows`` call's result, kept so several readers can slice it.

    ``feature_rows`` is a set-returning function whose every row is a function
    of that row's own target date and the four other arguments — the range
    bounds only choose *which* rows are returned, never what is in one. So a
    read over a wide window and a read over a narrow one agree, row for row, on
    the dates they share, and a caller that needs the same
    ``(gate_profile, feature_set, threshold_mw)`` over several overlapping
    windows may read the widest once and slice it.

    That is not a micro-optimisation. Forecaster 32 measured the call at 58.4 s
    per 17,376 rows against real data, and the DESSEM A/B reads one
    ``(arm, fold)`` at a time over folds that share a base fit: nine reads of
    two distinct windows, ninety minutes of it, which is what made the first
    attempt at that run look like a hang.

    **The property this rests on is checked rather than assumed.** It is a
    statement about SQL nobody here owns — ``feature_rows`` lives in the API's
    migration tree — so :meth:`agrees_with_a_direct_read` re-reads a narrow
    slice through the ordinary path and compares the rows whole. A driver that
    materialises should call it; it costs one short window.

    The query arguments are carried with the rows because rows shared between
    two readers that disagree about the feature function are not one dataset,
    and because containment has to be judged against the window that was
    *asked for* rather than the dates that came back: a database missing the
    tail of a block is a data fact, and a caller that read a window too narrow
    is a bug.
    """

    target_from: date
    target_to: date
    gate_profile: GateProfile
    feature_set: FeatureSet
    threshold_mw: float
    rows: tuple[dict[str, Any], ...]

    @classmethod
    async def of(
        cls, conn: asyncpg.Connection[Any], query: FeatureRowsQuery
    ) -> MaterialisedFeatureRows:
        return cls(
            target_from=query.target_from,
            target_to=query.target_to,
            gate_profile=query.gate_profile,
            feature_set=query.feature_set,
            threshold_mw=query.threshold_mw,
            rows=tuple(await read_feature_rows(conn, query)),
        )

    def covers(self, first: date, last: date) -> bool:
        """Was the window this was *read* for wide enough for ``first..last``?"""
        return self.target_from <= first and last <= self.target_to

    def between(self, first: date, last: date) -> tuple[dict[str, Any], ...]:
        """The rows a direct read of ``first..last`` would have returned."""
        return tuple(row for row in self.rows if first <= row["target_date"] <= last)

    async def agrees_with_a_direct_read(
        self, conn: asyncpg.Connection[Any], *, first: date, last: date
    ) -> bool:
        """Read ``first..last`` directly and compare it to the slice, whole.

        Full row equality in order, not a count and not a key digest: the thing
        that would make materialising wrong is a column whose value depends on
        the window frame, and a count could not see one.
        """
        if not self.covers(first, last):
            raise ValueError(
                f"{first.isoformat()}–{last.isoformat()} is not inside the "
                f"materialised {self.target_from.isoformat()}–"
                f"{self.target_to.isoformat()}; a probe outside the window "
                "compares nothing"
            )
        direct = await read_feature_rows(
            conn,
            FeatureRowsQuery(
                target_from=first,
                target_to=last,
                gate_profile=self.gate_profile,
                feature_set=self.feature_set,
                threshold_mw=self.threshold_mw,
            ),
        )
        return list(direct) == list(self.between(first, last))


def serving_target_date(now: datetime) -> date:
    """Tomorrow's target date, in Brasília civil time.

    Between 21:00 and 24:00 BRT the Brazilian and UTC calendar days disagree,
    and that window sits squarely inside ``gate_late``'s working evening — so a
    UTC reading would serve the wrong day for three hours every night.
    """
    return (now.astimezone(BRASILIA) + timedelta(days=1)).date()
