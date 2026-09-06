"""Feature rows carrying the two columns the mandatory 7-day baseline reads.

**These are fixtures, not data.** They compute rung 1's two columns from the
fixture's own labels rather than reading them off
`feature_row_fixtures.py`'s rows. Both columns are real:
``observed_constrained_off_same_hour_mean_7d`` came with the lagged-actuals
block in `0021_lagged_actuals_behind_the_cutoff.sql`, and
``observed_constrained_off_same_hour_exceedance_7d`` — which
`docs/specs/feature-engineering.md` specifies and rung 1's *occurrence* head
needs — landed in `0036_the_same_hour_exceedance.sql`. This module stood in for
the second before it existed, and it stays because the ladder tests need the two
columns to agree *with these rows' labels*, which a plausible synthetic value
does not.

So this module computes both from the fixture's own labels, over the same frame
the migration uses — the seven available days at the same local hour, ending at
the day before the target — and the ladder tests read them through the feature
contract exactly as they will read the real columns. What that buys is that rung
1 is built, exercised and shown to refuse when the column is absent; what it
cannot buy is a number about the Brazilian grid, and no test here asserts one.

**A day with no history is NULL, and that is the point.** The first seven days of
a window have nothing to average, so both columns are NULL there and rung 1
falls back to the base rate — which is the behaviour
:func:`~wattsteer_ml.evaluation.ladder.same_hour_fallback_rows` counts, and it
would be untestable against a fixture that quietly filled them.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta
from typing import Any

from feature_row_fixtures import THRESHOLD_MW, feature_rows

#: The two columns rung 1 reads, spelt here as the feature spec spells them.
EXCEEDANCE_COLUMN = "observed_constrained_off_same_hour_exceedance_7d"
SAME_HOUR_MEAN_COLUMN = "observed_constrained_off_same_hour_mean_7d"

#: The frame both columns are computed over: the seven days ending the day
#: before the target. The migration anchors it to `actuals_cutoff` instead; the
#: difference does not matter to a fixture whose only job is to put a plausible
#: number behind a column name.
WINDOW_DAYS = 7


def rows_with_same_hour_features(
    *,
    first: date,
    last: date,
    seed: int = 20_260_828,
    threshold_mw: float = THRESHOLD_MW,
) -> list[dict[str, Any]]:
    """`feature_row_fixtures.feature_rows`, plus rung 1's two columns.

    The columns are appended, so the contract's ordered names — which are half
    of the lane's ``feature_hash`` — grow at the end rather than shuffling, the
    way an ``ALTER TYPE ... ADD ATTRIBUTE`` grows the composite type.
    """
    rows = feature_rows(first=first, last=last, seed=seed, threshold_mw=threshold_mw)
    observed: dict[tuple[str, date, int], float] = {}
    for row in rows:
        total = row["y_constrained_off_total_mwh"]
        if total is not None:
            observed[
                (row["subsystem"], row["target_date"], row["calendar_local_hour"])
            ] = float(total)
    for row in rows:
        history = _history(observed, row)
        row[SAME_HOUR_MEAN_COLUMN] = None if not history else sum(history) / len(history)
        row[EXCEEDANCE_COLUMN] = (
            None
            if not history
            else sum(1 for value in history if value > threshold_mw) / len(history)
        )
    return rows


def without_exceedance(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """The same rows with the occurrence column removed.

    The state of the live feature function today, so the test that rung 1
    refuses rather than substitutes is run against the real shape of the gap
    rather than against an invented one.
    """
    return [
        {name: value for name, value in row.items() if name != EXCEEDANCE_COLUMN}
        for row in rows
    ]


def _history(
    observed: dict[tuple[str, date, int], float], row: dict[str, Any]
) -> list[float]:
    """The settled totals at this local hour over the preceding seven days."""
    subsystem = row["subsystem"]
    hour = row["calendar_local_hour"]
    target = row["target_date"]
    values: list[float] = []
    for back in range(1, WINDOW_DAYS + 1):
        value = observed.get((subsystem, target - timedelta(days=back), hour))
        if value is not None:
            values.append(value)
    return values
