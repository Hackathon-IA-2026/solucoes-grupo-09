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
`apps/api/drizzle/0036_the_same_hour_exceedance.sql`: **all 112 attributes, in
the same order**, because the ordered names are half of the lane's
``feature_hash`` and ``ALTER TYPE feature_row ADD ATTRIBUTE`` appends — so the
merge order of the migrations *is* the attribute order, and a plausible order is
not the order. The order is not maintained by hand:
``test_database_feature_caller.py`` asserts this file's keys against
``pg_attribute`` on the real type, name for name and position for position,
under a migrated Postgres.

The lane is ``dessem_free_v1`` (see :data:`FEATURE_SET`), and that decides which
columns carry values. ``0025_dessem_and_the_feature_set.sql`` makes the class-D
block "return no rows at all" for that set, so every ``dessem_*`` attribute
arrives NULL — which is what this file builds. Naming them and leaving them
empty is the point: the contract records such a column as *unpopulated* rather
than dropping it, and dropping it here would silently change the hash the fixture
implies.
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
    # The whole weather block goes NULL together or not at all: it arrives from
    # one join on one model run, so a row with a temperature and no wind speed
    # is a shape the real function cannot produce.
    weather_missing = rng.random() < weather_null_rate
    temperature = (
        None if weather_missing else 22.0 + 8.0 * zenith_cos + rng.gauss(0.0, 1.5)
    )
    shape = _curtailment_shape(hour)
    intensity = _INTENSITY[subsystem]
    wind_cf = 0.20 + 0.35 * (1.0 - zenith_cos)
    solar_cf = 0.85 * zenith_cos
    wind_gen = wind_mw * wind_cf
    solar_gen = solar_mw * solar_cf
    load = 1_000.0 + 12.0 * (wind_mw + solar_mw) / 100.0 + 250.0 * zenith_cos
    residual = load - wind_gen - solar_gen
    recent_off = 40.0 * intensity * shape
    weather = _weather_block(
        missing=weather_missing,
        temperature=temperature,
        zenith_cos=zenith_cos,
        wind_cf=wind_cf,
        wind_mw=wind_mw,
        solar_mw=solar_mw,
        hour=hour,
        rng=rng,
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
        # --- class K: lagged actuals behind the cutoff (0021, 0031, 0036) ----
        "observed_actual_lag_hours": float(24 - GATE_HOURS[GATE_PROFILE] + 24 + hour),
        "observed_constrained_off_lag_168h": recent_off,
        "observed_constrained_off_wind_lag_168h": recent_off * _wind_fraction(hour),
        "observed_constrained_off_solar_lag_168h": recent_off
        * (1.0 - _wind_fraction(hour)),
        "observed_constrained_off_lag_48h": 0.95 * recent_off,
        "observed_constrained_off_same_hour_mean_7d": 0.9 * recent_off,
        "observed_constrained_off_hours_above_threshold_7d": round(
            7.0 * intensity * shape
        ),
        "observed_constrained_off_total_7d_mwh": 24.0 * 7.0 * 40.0 * intensity * 0.5,
        "observed_load_lag_168h": load,
        "observed_wind_generation_lag_168h": wind_gen,
        "observed_solar_generation_lag_168h": solar_gen,
        "observed_wind_capacity_factor_mean_7d": 0.34,
        "observed_solar_capacity_factor_mean_7d": 0.21,
        "observed_net_exchange_lag_168h": -0.25 * residual,
        "observed_net_exchange_mean_24h_to_cutoff": -0.22 * residual,
        "observed_corridor_flow_ne_se_lag_168h": 0.15 * residual,
        "observed_corridor_flow_n_ne_lag_168h": 0.08 * residual,
        "observed_reason_share_ene_7d": 0.6,
        "observed_reason_share_cnf_7d": 0.3,
        "observed_reason_share_rel_7d": 0.1,
        # --- class P: the ONS day-ahead programme (0024) --------------------
        "programmed_load_mwh": load,
        "programmed_load_ramp_1h": 250.0
        * (zenith_cos - max(0.0, math.cos((hour - 13) * math.pi / 14))),
        "programmed_load_mean_3h": load * 0.99,
        "programmed_load_daily_min_mwh": 1_000.0 + 12.0 * (wind_mw + solar_mw) / 100.0,
        "programmed_load_rank_in_day": 1 + round(23.0 * zenith_cos),
        # --- class D: DESSEM. Absent for this lane, by the set's own rule ---
        "dessem_demand_mwh": None,
        "dessem_wind_mwh": None,
        "dessem_solar_mwh": None,
        "dessem_mmgd_mwh": None,
        "dessem_hydro_mwh": None,
        "dessem_thermal_mwh": None,
        "dessem_pumping_mwh": None,
        "dessem_residual_load_mwh": None,
        "dessem_renewable_load_ratio": None,
        "dessem_vre_surplus_mwh": None,
        "dessem_inflexible_share": None,
        "dessem_implied_net_export_mwh": None,
        "dessem_demand_ramp_1h": None,
        "dessem_residual_load_ramp_1h": None,
        "dessem_vre_ramp_1h": None,
        "dessem_residual_load_min_of_day": None,
        "dessem_residual_load_rank_in_day": None,
        "dessem_wind_capacity_factor": None,
        "dessem_solar_capacity_factor": None,
        "dessem_sin_residual_load_mwh": None,
        "dessem_absorber_residual_load_mwh": None,
        # --- class W: the weather block (0029) ------------------------------
        **weather,
        # --- the residual-load proxy (0030) ---------------------------------
        "proxy_residual_load_mwh": residual,
        "proxy_residual_load_ratio": residual / load,
        "proxy_renewable_load_ratio": (wind_gen + solar_gen) / load,
        "proxy_vre_surplus_mwh": max(0.0, wind_gen + solar_gen - load),
        "proxy_residual_load_ramp_1h": 200.0 * (0.5 - zenith_cos),
        "proxy_residual_load_min_of_day": load * 0.35,
        "proxy_residual_load_rank_in_day": 24 - round(23.0 * zenith_cos),
        # --- the interchange-utilisation proxy (0031) and 0036's exceedance --
        "observed_export_utilisation_mean_24h_to_cutoff": min(
            1.0, abs(0.22 * residual) / 4_000.0
        ),
        "observed_corridor_utilisation_ne_se_max_7d": min(
            1.0, abs(0.15 * residual) / 3_500.0
        ),
        "dessem_export_utilisation": None,
        "observed_constrained_off_same_hour_exceedance_7d": intensity * shape,
    }


def _wind_fraction(hour: int) -> float:
    """Which half of the fleet the overnight and midday hours curtail."""
    return 0.85 if hour < 6 or hour >= 19 else 0.2


def _curtailment_shape(hour: int) -> float:
    """The hour-of-day shape the label and the lagged actuals both follow."""
    return 0.15 + 0.85 * max(
        math.exp(-(((hour - 13) / 3.0) ** 2)), 0.7 * math.exp(-(((hour - 3) / 3.5) ** 2))
    )


def _weather_block(
    *,
    missing: bool,
    temperature: float | None,
    zenith_cos: float,
    wind_cf: float,
    wind_mw: float,
    solar_mw: float,
    hour: int,
    rng: random.Random,
) -> dict[str, Any]:
    """Attributes 78–101, in the composite type's order — or all NULL.

    ``weather_temperature_2m`` is not here: it is attribute 9, minted by the
    original type long before ``0029_the_weather_block.sql`` appended the rest,
    and the attribute order is the merge order rather than the tidy one. It is
    driven from the same ``missing`` draw at the call site.
    """
    if missing:
        return dict.fromkeys(_WEATHER_COLUMNS)
    speed120 = 4.0 + 14.0 * wind_cf + rng.gauss(0.0, 0.8)
    ghi = 1_361.0 * zenith_cos
    clearness = 0.55 + 0.2 * zenith_cos
    shortwave = ghi * clearness
    direction = 2 * math.pi * ((hour % 12) / 12.0)
    assert temperature is not None
    return {
        "weather_wind_speed_100m": speed120 * 0.96,
        "weather_wind_speed_120m": speed120,
        "weather_wind_direction_120m_sin": math.sin(direction),
        "weather_wind_direction_120m_cos": math.cos(direction),
        "weather_wind_gusts_10m": speed120 * 1.4,
        "weather_surface_pressure": 1_010.0 - 0.05 * temperature,
        "weather_relative_humidity_2m": 85.0 - 1.5 * temperature,
        "weather_precipitation": max(0.0, rng.gauss(0.2, 0.4)),
        "weather_shortwave_radiation": shortwave,
        "weather_direct_normal_irradiance": shortwave * 0.8,
        "weather_diffuse_radiation": shortwave * 0.2,
        "weather_cloud_cover": 100.0 * (1.0 - clearness),
        "weather_clearness_index": clearness,
        "weather_wind_power_curve_cf": wind_cf,
        "weather_expected_wind_mwh": wind_mw * wind_cf,
        "weather_expected_solar_mwh": solar_mw * 0.85 * zenith_cos,
        "weather_wind_speed_120m_ramp_1h": 0.4 * (1.0 - zenith_cos),
        "weather_shortwave_radiation_ramp_1h": 60.0 * (zenith_cos - 0.5),
        "weather_expected_vre_ramp_1h": 30.0 * (zenith_cos - 0.5),
        "weather_wind_speed_120m_mean_3h": speed120 * 0.98,
        "weather_wind_speed_120m_std_6h": 0.6,
        "weather_shortwave_radiation_mean_3h": shortwave * 0.95,
        "weather_run_age_hours": float(GATE_HOURS[GATE_PROFILE] - 12 + 24),
        "weather_centroid_coverage": 1.0,
    }


#: The weather block's own column order, so an all-NULL run keeps it.
_WEATHER_COLUMNS: tuple[str, ...] = (
    "weather_wind_speed_100m",
    "weather_wind_speed_120m",
    "weather_wind_direction_120m_sin",
    "weather_wind_direction_120m_cos",
    "weather_wind_gusts_10m",
    "weather_surface_pressure",
    "weather_relative_humidity_2m",
    "weather_precipitation",
    "weather_shortwave_radiation",
    "weather_direct_normal_irradiance",
    "weather_diffuse_radiation",
    "weather_cloud_cover",
    "weather_clearness_index",
    "weather_wind_power_curve_cf",
    "weather_expected_wind_mwh",
    "weather_expected_solar_mwh",
    "weather_wind_speed_120m_ramp_1h",
    "weather_shortwave_radiation_ramp_1h",
    "weather_expected_vre_ramp_1h",
    "weather_wind_speed_120m_mean_3h",
    "weather_wind_speed_120m_std_6h",
    "weather_shortwave_radiation_mean_3h",
    "weather_run_age_hours",
    "weather_centroid_coverage",
)


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
    shape = _curtailment_shape(hour)
    if rng.random() > _INTENSITY[subsystem] * shape:
        total = rng.random() * threshold_mw
    else:
        total = threshold_mw + rng.lognormvariate(3.0 + 2.0 * shape, 0.8)
    wind_fraction = _wind_fraction(hour)
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
            for name, value in row.items():
                if name in _NEVER_BLINDED or name.startswith(LABEL_PREFIX):
                    continue
                # A NULL stays NULL: the no-imputation rule is a property of
                # the trainer, and filling one here would blind the wrong thing.
                if value is None:
                    continue
                copy[name] = _nonsense(value)
        blinded.append(copy)
    return blinded


#: The label prefix, spelt here rather than imported: this module is a fixture
#: and importing the trainer's contract to build one would make the fixture
#: depend on the thing it is used to test.
LABEL_PREFIX = "y_"

#: Stamps and the row's identity. Blinding a stamp would move the lane the row
#: claims to belong to, and blinding ``subsystem`` would move the group — both
#: are changes to *which rows these are*, not to their covariates.
_NEVER_BLINDED: frozenset[str] = frozenset(
    {
        "subsystem",
        "valid_time",
        "target_date",
        "gate_profile",
        "gate_at",
        "feature_set",
        "threshold_mw",
        "vintage_fidelity",
    }
)


def _nonsense(value: Any) -> Any:
    """A value of the same dtype that the real column could never take.

    Same dtype, because the design matrix is built from the dtypes the rows
    show: a column that changed type between the honest and the blinded run
    would be a second difference, and the instrument needs exactly one.
    """
    if isinstance(value, bool):
        return not value
    if isinstance(value, int):
        return -1
    return -273.0
