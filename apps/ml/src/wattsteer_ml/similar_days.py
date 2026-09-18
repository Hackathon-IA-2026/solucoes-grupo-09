"""Which past day looked most like tomorrow — the analogue, as evidence.

## What this answers, and what it is not

A specialist review asked for a *dia histórico análogo* beside the forecast: not
another model output, but a **real day the grid already lived through** whose
conditions resembled the one being forecast. That is a different kind of
evidence from an attribution. `diagnosis` answers "which drivers moved this
number"; this answers "when did we last see a day like this, and what happened?"
— and the second is checkable by anyone with ONS's archive and no access to the
model at all.

It is therefore deliberately **not** a predictor. Nothing here is fitted,
nothing is promoted, and the neighbour's outcome is never combined with the
forecast. The product publishes a band from LightGBM and, beside it, a date.

## Why this reads the balance and not the feature function

The first version built the day vector from `feature_rows(...)`, which was the
wrong read and the gateway proved it: every call timed out at the 5 s boundary,
at **thirty days of pool as surely as at a hundred and eighty**, so the cost was
per-row and not per-range. That function computes sixty-odd columns — 48-hour
and 168-hour lags, seven-day rolling windows, same-hour exceedances — for a
caller that wanted six day-level aggregates of the day-ahead programme.

So the pool is read the way `/v1/grid/context` reads its own: two aggregate
queries over canonical views, grouped in Postgres, one row per day. The day
vector comes from `canonical_day_ahead_balance` — DESSEM's published programme,
which is where the `dessem_*` feature columns come from in the first place — and
the outcome from `canonical_curtailment_by_reporting_entity`, which is the same
view `/v1/grid/now` sums.

**What that costs, stated plainly.** Two coordinates are gone with the feature
function: the VRE surplus and the export utilisation, both of which the feature
builder derives rather than reads. The remaining six are raw programme
quantities, and a vector of raw quantities is the one a reader can reproduce
from ONS's own files — which for a panel whose whole purpose is checkable
evidence is worth more than the two it lost.

## The features, and why they are six and not sixty

    demand (mean)              the programme's own load
    wind (mean), solar (mean)  the two fleets that get curtailed
    MMGD (mean)                behind-the-meter, which displaces the same load
    residual load (mean)       demand + pumping − wind − solar − MMGD
    residual load (minimum)    the trough, where the day is tightest

All six are **average power over the day**, in MW, which is what the balance
publishes. Not summed: DESSEM's grain is instantaneous power at half-hourly
resolution, and adding MW across half hours produces a number that is neither power
nor energy. A mean is a mean of powers and is a power.

## Nothing here is available after the gate

Every coordinate is from the day-ahead programme, published D−1 and therefore
known when the forecast is made. That is the property that makes the search
honest rather than a lookup of days that turned out similar — a neighbour chosen
with any settled quantity would be answering "which day *ended* like this one",
a question nobody can ask in advance.

The **outcome** is settled, of course: it is what the analogue is for. It is
read from the neighbour's own day and never from the target's.

## Standardisation, and the degenerate cases

Each feature is z-scored against the pool, so a column in tens of thousands of
MW does not swamp one in hundreds. A column with no variance across the pool
carries no information and is dropped rather than dividing by zero. A pool with
fewer days than `k` returns what it has; a pool with no spread at all returns
nothing, which is an absence and is said as one.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from zoneinfo import ZoneInfo

#: ONS's clock. The pool is grouped by the Brasília civil day, not the UTC one.
BRASILIA = ZoneInfo("America/Sao_Paulo")
from typing import Any

#: The day vector, in a fixed order so a distance is reproducible.
#:
#: `(column, how the day aggregates it)`. Every column is `dessem_*`: the
#: day-ahead programme, published D−1. See the module docstring.
FEATURES: tuple[tuple[str, str], ...] = (
    ("demand_mw", "mean"),
    ("wind_generation_mw", "mean"),
    ("solar_generation_mw", "mean"),
    ("mmgd_generation_mw", "mean"),
    ("residual_load_mw", "mean"),
    ("residual_load_mw", "min"),
)

#: The settled label the analogue is read for.
OUTCOME = "constrained_off_mwh"

DEFAULT_K = 3


class SimilarDaysError(Exception):
    """The search cannot be run — never an empty result standing in for it."""


@dataclass(frozen=True)
class DayVector:
    """One day, reduced to the six numbers the search compares."""

    target_date: date
    values: tuple[float, ...]
    #: `None` for the day being asked about, which has not settled.
    outcome_mwh: float | None
    #: How many hourly rows the day was built from. A day built from four hours
    #: is not a day, and the caller drops it.
    hours: int


@dataclass(frozen=True)
class Neighbour:
    """One analogue: a real date, its distance, and what actually happened."""

    target_date: date
    distance: float
    outcome_mwh: float
    hours: int


def _standardise(pool: Sequence[DayVector]) -> tuple[tuple[float, ...], tuple[float, ...]]:
    """Per-feature mean and standard deviation over the pool.

    A standard deviation of zero is returned as zero and the caller drops that
    coordinate: a column every day agrees on separates no two days, and dividing
    by it would turn rounding noise into the whole distance.
    """
    width = len(FEATURES)
    means = tuple(
        math.fsum(vector.values[index] for vector in pool) / len(pool)
        for index in range(width)
    )
    deviations = tuple(
        math.sqrt(
            math.fsum((vector.values[index] - means[index]) ** 2 for vector in pool)
            / len(pool)
        )
        for index in range(width)
    )
    return means, deviations


def nearest(
    target: DayVector,
    pool: Sequence[DayVector],
    *,
    k: int = DEFAULT_K,
) -> list[Neighbour]:
    """The `k` settled days closest to `target`, nearest first.

    `pool` must not contain the target's own date — a day is its own nearest
    neighbour at distance zero, which is true and useless — and the caller is
    the one that knows the range it asked for, so that is enforced here rather
    than assumed.
    """
    if k < 1:
        raise SimilarDaysError(f"k must be at least 1, got {k}")
    settled = [
        vector
        for vector in pool
        if vector.outcome_mwh is not None and vector.target_date != target.target_date
    ]
    if not settled:
        return []

    means, deviations = _standardise(settled)
    live = [index for index, spread in enumerate(deviations) if spread > 0.0]
    if not live:
        # Every day in the pool is identical on every coordinate. There is no
        # "most similar" to report and saying so beats reporting an arbitrary
        # date at distance zero.
        return []

    def distance(vector: DayVector) -> float:
        return math.sqrt(
            math.fsum(
                ((vector.values[index] - target.values[index]) / deviations[index]) ** 2
                for index in live
            )
        )

    scored = sorted(
        (
            Neighbour(
                target_date=vector.target_date,
                distance=distance(vector),
                # Narrowed by the filter above; restated for the type checker.
                outcome_mwh=float(vector.outcome_mwh or 0.0),
                hours=vector.hours,
            )
            for vector in settled
        ),
        # The date breaks ties, so two equidistant days come back in a stable
        # order rather than in whatever order the pool arrived in.
        key=lambda neighbour: (neighbour.distance, neighbour.target_date),
    )
    return scored[:k]


#: One row per civil day of the programme, aggregated in Postgres.
#:
#: Grouped by the **Brasília** civil day, not the UTC one: ONS's timestamps are
#: local civil time and a UTC day would be the wrong day by three hours every
#: day of the year, which `/v1/curtailment/reasons` states in the same words on
#: the gateway side.
#:
#: `count(*)` travels so the caller can drop a day the programme only half
#: covers. A mean over four half hours is a mean of four numbers wearing a label
#: that says "the day", which is the failure this whole module is written
#: against.
POOL_SQL = """
select
  (valid_time at time zone 'America/Sao_Paulo')::date as target_date,
  avg(demand_mw) as demand_mw,
  avg(wind_generation_mw) as wind_generation_mw,
  avg(solar_generation_mw) as solar_generation_mw,
  avg(mmgd_generation_mw) as mmgd_generation_mw,
  avg(demand_mw + pumping_consumption_mw
      - wind_generation_mw - solar_generation_mw - mmgd_generation_mw)
    as residual_load_mean_mw,
  min(demand_mw + pumping_consumption_mw
      - wind_generation_mw - solar_generation_mw - mmgd_generation_mw)
    as residual_load_min_mw,
  count(*)::int as half_hours
from canonical_day_ahead_balance
where subsystem = $1
  and valid_time >= $2
  and valid_time < $3
group by 1
order by 1
"""

#: The settled outcome, per civil day, from the same view `/v1/grid/now` sums.
OUTCOME_SQL = """
select
  (valid_time at time zone 'America/Sao_Paulo')::date as target_date,
  sum(constrained_off_mwh) as constrained_off_mwh
from canonical_curtailment_by_reporting_entity
where subsystem = $1
  and valid_time >= $2
  and valid_time < $3
group by 1
"""

#: A civil day of the programme is 48 half hours. Below this the day is a
#: fragment and is dropped: its mean describes the hours ONS happened to publish
#: and would be read as describing the day.
MIN_HALF_HOURS = 48


def pool_vectors(
    programme: Iterable[Mapping[str, Any]],
    outcomes: Mapping[Any, float],
) -> list[DayVector]:
    """Day rows plus settled outcomes, as vectors the search can compare.

    A day with no outcome row keeps `outcome_mwh = None` and is therefore never
    offered as a neighbour — which covers both "not settled yet" and "settled
    with nothing curtailed"… except that the second is a *measurement*, and ONS
    publishes no row for it. That ambiguity is the reason this function does not
    invent a zero: a day absent from the curtailment view is a day this module
    has nothing to say about, and offering it as an analogue whose outcome was
    "0 MWh" would be asserting a measurement nobody made.
    """
    vectors: list[DayVector] = []
    for row in programme:
        if int(row["half_hours"]) < MIN_HALF_HOURS:
            continue
        values = (
            float(row["demand_mw"]),
            float(row["wind_generation_mw"]),
            float(row["solar_generation_mw"]),
            float(row["mmgd_generation_mw"]),
            float(row["residual_load_mean_mw"]),
            float(row["residual_load_min_mw"]),
        )
        day = row["target_date"]
        settled = outcomes.get(day)
        vectors.append(
            DayVector(
                target_date=day,
                values=values,
                outcome_mwh=None if settled is None else float(settled),
                hours=int(row["half_hours"]) // 2,
            )
        )
    return vectors
