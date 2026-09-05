"""Synthetic `feature_rows(...)` output, for tests that need a fitted model.

**These are fixtures, not data.** Every row here is invented, and nothing in
this file may be read as a claim about the Brazilian grid. What the tests built
on it assert are *structural* properties — that the magnitude boosters saw only
curtailed hours, that the composition is ticket 01's inversion, that the same
seed reproduces the same predictions, that a NULL is still NULL after encoding —
and every one of those is a property of the code rather than of the numbers.
None of them would be more true against real rows, and none of them is asserted
about accuracy, which synthetic rows genuinely cannot speak to.

The shape is the shape of the composite type `feature_row` as it stands after
`apps/api/drizzle/0019_calendar_and_astronomy.sql`: the same columns, in the
same order, because the ordered names are half of the lane's ``feature_hash``.
Only part of the feature set is populated in the migration tree so far — the
weather block is one column, and lagged actuals, the ONS day-ahead programme,
DESSEM, the residual-load proxy and the interchange proxy are all still being
sliced in `.scratch/feature-engineering/issues/`. This file mirrors what exists;
it does not invent the columns that do not.
"""

from __future__ import annotations

import math
import random
from collections.abc import Iterator, Sequence
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.features import BRASILIA

#: A lane the tests train in. `dessem_free_v1` at `gate_late`, 5 MW — v1's
#: primary, and the only combination that needs no DESSEM block.
FEATURE_SET = "dessem_free_v1"
GATE_PROFILE = "gate_late"
THRESHOLD_MW = 5.0

#: Installed capacity, MW. Constant per subsystem over a fixture's window: the
#: capacity block is day grain and moves by fractions of a percent in 30 days.
_CAPACITY: dict[Subsystem, tuple[float, float]] = {
    "N": (900.0, 400.0),
    "NE": (28_000.0, 12_000.0),
    "SE": (2_500.0, 9_000.0),
    "S": (6_500.0, 1_100.0),
}

#: How often a subsystem's hours go above τ at all, before the hourly shape.
_INTENSITY: dict[Subsystem, float] = {"N": 0.05, "NE": 0.55, "SE": 0.12, "S": 0.20}

#: The gate table, transcribed. ``gate_early`` is D-1 09:00 BRT on the 00Z run;
#: ``gate_late`` is D-1 19:00 BRT on the 12Z run.
GATE_HOURS: dict[str, int] = {"gate_early": 9, "gate_late": 19}


def gate_at(target_date: date, gate_profile: str = GATE_PROFILE) -> datetime:
    """``gate_at(target_date, gate_profile)``, on the Python side.

    The authority is ``gate_at(...)`` in
    ``apps/api/drizzle/0016_the_feature_gate.sql``, which is where every real
    row's column comes from — ``wattsteer_ml`` itself deliberately holds no
    spelling of this rule and reads the column off the rows instead. But a
    *fixture* has to mint one, and a fixture whose gate disagreed with the
    database would train and evaluate the whole ML suite against an instant the
    product never publishes at.

    So it is bound: ``packages/core/fixtures/gate-instant/`` holds the vectors
    and ``test_gate_instant_vectors.py`` asserts this function against them,
    beside the TypeScript spelling and — under a real Postgres — the SQL one.
    """
    hour = GATE_HOURS.get(gate_profile)
    if hour is None:
        # Raised rather than defaulted, for the same reason the SQL raises
        # 22023: a gate invented for a profile that does not exist would stamp
        # a publication instant on rows that claim to be a different lane's.
        raise ValueError(f"unknown gate profile {gate_profile!r}")
    local = datetime.combine(
        target_date - timedelta(days=1), time(hour=hour), tzinfo=BRASILIA
    )
    return local.astimezone(UTC)


def feature_rows(
    *,
    first: date,
    last: date,
    seed: int = 20_260_828,
    threshold_mw: float = THRESHOLD_MW,
    weather_null_rate: float = 0.05,
    unlabelled_rate: float = 0.01,
) -> list[dict[str, Any]]:
    """Rows for every subsystem-hour of ``[first, last]``, in the query's order.

    ``weather_null_rate`` and ``unlabelled_rate`` are not noise for its own
    sake. A NULL feature is the case the no-imputation rule is about, and an
    unlabelled row is what the label block returns for an hour ONS has not
    settled — both have to be in a fixture that claims the trainer handles them.
    """
    rng = random.Random(seed)  # noqa: S311 — a fixture, not a security decision
    rows: list[dict[str, Any]] = []
    for target_date in _days(first, last):
        for hour in range(24):
            for subsystem in SUBSYSTEM_CODES:
                rows.append(
                    _row(
                        rng=rng,
                        subsystem=subsystem,
                        target_date=target_date,
                        hour=hour,
                        threshold_mw=threshold_mw,
                        weather_null_rate=weather_null_rate,
                        unlabelled_rate=unlabelled_rate,
                    )
                )
    return rows


def _days(first: date, last: date) -> Iterator[date]:
    day = first
    while day <= last:
        yield day
        day += timedelta(days=1)


def _row(
    *,
    rng: random.Random,
    subsystem: Subsystem,
    target_date: date,
    hour: int,
    threshold_mw: float,
    weather_null_rate: float,
    unlabelled_rate: float,
) -> dict[str, Any]:
    valid_time = (
        datetime.combine(target_date, time(), tzinfo=BRASILIA) + timedelta(hours=hour)
    ).astimezone(UTC)
    gate = gate_at(target_date, GATE_PROFILE)
    wind_mw, solar_mw = _CAPACITY[subsystem]
    doy = target_date.timetuple().tm_yday
    zenith_cos = max(0.0, math.cos((hour - 12) * math.pi / 14))

    wind_mwh, solar_mwh, total = _label(
        rng=rng,
        subsystem=subsystem,
        hour=hour,
        threshold_mw=threshold_mw,
        unlabelled=rng.random() < unlabelled_rate,
    )
    temperature = (
        None
        if rng.random() < weather_null_rate
        else 22.0 + 8.0 * zenith_cos + rng.gauss(0.0, 1.5)
    )
    return {
        "subsystem": subsystem,
        "valid_time": valid_time,
        "target_date": target_date,
        "gate_profile": GATE_PROFILE,
        "gate_at": gate,
        "feature_set": FEATURE_SET,
        "threshold_mw": threshold_mw,
        "vintage_fidelity": "point_in_time",
        "weather_temperature_2m": temperature,
        "y_constrained_off_wind_mwh": wind_mwh,
        "y_constrained_off_solar_mwh": solar_mwh,
        "y_constrained_off_total_mwh": total,
        "y_has_curtailment": None if total is None else total > threshold_mw,
        "y_magnitude_mwh": None if total is None or total <= threshold_mw else total,
        "capacity_wind_mw": wind_mw,
        "capacity_solar_mw": solar_mw,
        "capacity_wind_added_28d_mw": 12.0,
        "capacity_solar_added_28d_mw": 30.0,
        "calendar_local_hour": hour,
        "calendar_hour_sin": math.sin(2 * math.pi * hour / 24),
        "calendar_hour_cos": math.cos(2 * math.pi * hour / 24),
        "calendar_doy_sin": math.sin(2 * math.pi * doy / 365.25),
        "calendar_doy_cos": math.cos(2 * math.pi * doy / 365.25),
        "calendar_day_of_week": target_date.isoweekday(),
        "calendar_is_weekend": target_date.isoweekday() >= 6,
        "calendar_is_holiday_national": False,
        "calendar_holiday_state_share": 0.0,
        "calendar_is_day_before_holiday": False,
        "calendar_is_bridge_day": False,
        "solar_zenith_cos": zenith_cos,
        "solar_extraterrestrial_ghi": 1_361.0 * zenith_cos,
    }


def _label(
    *,
    rng: random.Random,
    subsystem: Subsystem,
    hour: int,
    threshold_mw: float,
    unlabelled: bool,
) -> tuple[float | None, float | None, float | None]:
    """One hour's wind, solar and total constrained-off MWh, or three NULLs."""
    if unlabelled:
        return None, None, None
    # Curtailment concentrates in the solar middle of the day and in the
    # overnight wind hours, which is the shape the boosters have to find.
    shape = 0.15 + 0.85 * max(
        math.exp(-(((hour - 13) / 3.0) ** 2)), 0.7 * math.exp(-(((hour - 3) / 3.5) ** 2))
    )
    if rng.random() > _INTENSITY[subsystem] * shape:
        total = rng.random() * threshold_mw
    else:
        total = threshold_mw + rng.lognormvariate(3.0 + 2.0 * shape, 0.8)
    wind_fraction = 0.85 if hour < 6 or hour >= 19 else 0.2
    return total * wind_fraction, total * (1.0 - wind_fraction), total


def blinded_sub_threshold(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """The same rows, with every *sub-threshold* hour's features made nonsense.

    The instrument behind "the magnitude model is fitted on curtailed hours
    only". Labels are untouched, so ``μ_sub`` and the occurrence classifier's
    target are unchanged; only the covariates of the quiet hours move. A
    magnitude booster that had seen those rows would predict differently
    afterwards. One that was fitted on the positive rows alone cannot.
    """
    blinded: list[dict[str, Any]] = []
    for row in rows:
        copy = dict(row)
        if row["y_has_curtailment"] is not True:
            copy["weather_temperature_2m"] = -273.0
            copy["solar_zenith_cos"] = 99.0
            copy["solar_extraterrestrial_ghi"] = -1.0
            copy["capacity_wind_mw"] = 1.0
            copy["capacity_solar_mw"] = 1.0
        blinded.append(copy)
    return blinded
