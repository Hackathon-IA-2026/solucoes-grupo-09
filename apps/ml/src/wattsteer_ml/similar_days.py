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

## The features, and why they are six and not sixty

The pool rows carry more than sixty columns. A nearest-neighbour search over all
of them is dominated by whichever block has the most columns — the weather block
alone is twenty — and its answer cannot be explained to the reader it exists to
convince. So the vector is six **day-level** aggregates of the operational
programme, named here and nowhere else:

    residual load (sum)       the quantity curtailment is actually about
    wind (sum), solar (sum)   the two fleets that get curtailed
    VRE surplus (sum)         the programme's own headroom figure
    export utilisation (mean) how full the way out of the subsystem is
    residual load minimum     the trough, where the day is tightest

## Nothing here is available after the gate

Every one is a `dessem_*` column: ONS's day-ahead programme, published D−1 and
therefore known when the forecast is made. That is the property that makes the
search honest rather than a lookup of days that turned out similar — a neighbour
chosen with any settled quantity would be answering "which day *ended* like this
one", which is a question nobody can ask in advance.

The **outcome** is settled, of course: it is what the analogue is for. It is
read from the neighbour's own label and never from the target's.

## Standardisation, and the degenerate cases

Each feature is z-scored against the pool, so a column in tens of thousands of
MWh does not swamp a utilisation ratio in [0, 1]. A column with no variance
across the pool carries no information and is dropped rather than dividing by
zero. A pool with fewer days than `k` returns what it has; a pool with no
complete rows returns nothing, which is an absence and is said as one.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

#: The day vector, in a fixed order so a distance is reproducible.
#:
#: `(column, how the day aggregates it)`. Every column is `dessem_*`: the
#: day-ahead programme, published D−1. See the module docstring.
FEATURES: tuple[tuple[str, str], ...] = (
    ("dessem_residual_load_mwh", "sum"),
    ("dessem_wind_mwh", "sum"),
    ("dessem_solar_mwh", "sum"),
    ("dessem_vre_surplus_mwh", "sum"),
    ("dessem_export_utilisation", "mean"),
    ("dessem_residual_load_mwh", "min"),
)

#: The settled label the analogue is read for.
OUTCOME = "y_constrained_off_total_mwh"

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


def _aggregate(values: Sequence[float], how: str) -> float:
    if how == "sum":
        return math.fsum(values)
    if how == "mean":
        return math.fsum(values) / len(values)
    if how == "min":
        return min(values)
    raise SimilarDaysError(f"{how!r} is not an aggregation this module defines")


def day_vectors(rows: Iterable[Mapping[str, Any]]) -> list[DayVector]:
    """Group hourly feature rows into day vectors, dropping incomplete days.

    A day is dropped when any one of the six columns is NULL in any of its
    hours. Imputing a zero would move the day in the space by an amount nobody
    chose, and the whole claim of this read is that the neighbour is *like* the
    target — an imputed coordinate is a claim about likeness that no data
    supports.
    """
    by_day: dict[date, list[Mapping[str, Any]]] = {}
    for row in rows:
        day = row["target_date"]
        by_day.setdefault(day, []).append(row)

    vectors: list[DayVector] = []
    for day, hours in sorted(by_day.items()):
        columns: list[float] = []
        complete = True
        for column, how in FEATURES:
            raw = [hour.get(column) for hour in hours]
            if any(value is None for value in raw):
                complete = False
                break
            columns.append(_aggregate([float(value) for value in raw], how))
        if not complete:
            continue
        settled = [hour.get(OUTCOME) for hour in hours]
        vectors.append(
            DayVector(
                target_date=day,
                values=tuple(columns),
                outcome_mwh=(
                    None
                    if any(value is None for value in settled)
                    else math.fsum(float(value) for value in settled)
                ),
                hours=len(hours),
            )
        )
    return vectors


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
