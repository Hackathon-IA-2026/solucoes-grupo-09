"""The validation table, from the Python side: refused, never corrected.

``packages/core/src/scenario-validation.ts`` is the same table in TypeScript and
neither module is generated from the other. What binds them is the shared vector
directory ``packages/core/fixtures/scenario-validation/``:
:mod:`tests.test_scenario_validation` asserts *this* module against it and
``packages/core/test/scenario-validation.test.ts`` asserts the TypeScript side
against it, so a shared misunderstanding has nothing to cancel out against.

**Why this module exists at all, given the gateway already ran the table.**
``docs/specs/flex-optimizer.md`` is explicit that validation "is re-asserted in
the ml service, which trusts nothing it did not validate itself". That is not
belt and braces. The gateway is one deployment away from this one, the ml
service's port is one misconfiguration away from being reachable, and the
model's own feasibility argument — the do-nothing dispatch satisfies every
constraint *provided* ``min_soc <= initial_soc <= max_soc`` — is what makes
``INFEASIBLE`` a `500` rather than a user error. A service that assumed that
invariant instead of checking it would report its own missing check as a
WattSteer bug, which is the one diagnosis that would send a reader to the wrong
file.

**Nothing is coerced.** There is no clamp in this file, no ``min()`` narrowing a
supplied bound and no default standing in for a value that was sent and refused.
The only substitutions are the four the spec *states* for absent fields — the
state-of-charge window and the availability window — and a default for a field
nobody sent is not a correction of one somebody did. A repaired scenario
produces a plan for an asset the caller did not describe, and the response says
nothing about it.

One refusal is raised, not a list, because the error envelope carries one
``code``. The order is therefore part of the contract and is the same order the
TypeScript module documents: the scenario's own fields, then each asset in index
order, and inside an asset its identity before the numbers that identity gives
meaning to.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Any, Final, NoReturn
from zoneinfo import ZoneInfo

from .constants import SUBSYSTEM_CODES
from .scenario import SCENARIO_VERSION, VARIANT_FIELDS

#: ``SCENARIO_TOO_LARGE`` — the cap on asset count. The blob cap lives in
#: :mod:`.scenario`: that one bounds what is *parsed*, this one bounds what is
#: *modelled*, and every asset is a block of MILP variables.
MAX_ASSETS: Final = 20

#: ``MAGNITUDE_OUT_OF_RANGE`` — every power in MW, ``(0, 10 000]``.
MAX_POWER_MW: Final = 10_000

#: ``MAGNITUDE_OUT_OF_RANGE`` — every energy in MWh, ``(0, 100 000]``.
MAX_ENERGY_MWH: Final = 100_000

#: ``RTE_OUT_OF_RANGE`` — ``[0.50, 1.00)``, inclusive below, exclusive above.
MIN_EFFICIENCY: Final = 0.5

#: ``SHIFT_WINDOW_OUT_OF_RANGE`` — ``L`` in ``[1, 8]`` whole hours.
MIN_SHIFT_WINDOW_HOURS: Final = 1
MAX_SHIFT_WINDOW_HOURS: Final = 8

#: ``RECOVERY_TIME_OUT_OF_RANGE`` — ``[1, 24]`` when supplied at all.
MIN_RECOVERY_TIME_HOURS: Final = 1
MAX_RECOVERY_TIME_HOURS: Final = 24

#: ``ECONOMIC_ASSUMPTION_OUT_OF_RANGE`` — ``brl_per_mwh`` in ``(0, 10 000]``.
MAX_BRL_PER_MWH: Final = 10_000

#: The spec's defaults for a battery that does not state its own SOC window.
DEFAULT_MIN_STATE_OF_CHARGE: Final = 0.05
DEFAULT_MAX_STATE_OF_CHARGE: Final = 0.95

#: The default availability: the whole local day, half-open ``[from, to)``.
DEFAULT_AVAILABLE_FROM: Final = "00:00"
DEFAULT_AVAILABLE_TO: Final = "24:00"

#: ``TARGET_DATE_OUT_OF_RANGE`` — the first civil date WattSteer has data for.
DATA_WINDOW_OPENS_ON: Final = date(2024, 4, 1)

#: Brasília civil time. The horizon is a local day, so "tomorrow" is a local one
#: — a validator reading the UTC day would admit a date for three hours every
#: evening and plan the wrong 24 hours.
GRID_ZONE: Final = ZoneInfo("America/Sao_Paulo")


class ScenarioValidationError(ValueError):
    """A scenario this build refuses to plan for, named by the code that says why.

    The sibling of :class:`~wattsteer_ml.scenario.ScenarioTransportError` and
    deliberately a second class: a transport refusal says the *bytes* could not
    be read, this one says the bytes were read and describe something that is
    not a fleet. ``code`` is a member of the closed enum in
    ``packages/core/src/errors.ts`` and ``field`` is the path the envelope
    carries in ``details.field``.
    """

    def __init__(
        self, code: str, message: str, details: dict[str, Any] | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details: dict[str, Any] = dict(details or {})

    @property
    def field(self) -> str | None:
        """The path in ``details.field``, which is what the envelope carries."""
        value = self.details.get("field")
        return value if isinstance(value, str) else None


def _refuse(
    code: str, message: str, field: str | None = None, limit: float | None = None
) -> NoReturn:
    """Raise the one refusal. ``NoReturn``, so every caller reads as a guard."""
    details: dict[str, Any] = {}
    if field is not None:
        details["field"] = field
    if limit is not None:
        details["limit"] = limit
    raise ScenarioValidationError(code, message, details)


def _number(value: Any) -> float | None:
    """A finite number, or ``None`` for anything else — ``"100"`` included.

    Not a coercion: ``float("100")`` would admit a caller who sent the wrong
    type and the plan would then be right by accident. ``bool`` is excluded
    before the numeric test because it is a subclass of ``int`` in Python and
    ``True`` would otherwise be one megawatt.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _required(asset: dict[str, Any], key: str, field: str) -> float:
    """A number the variant requires.

    ``REQUEST_INVALID`` rather than a table code, and the distinction is worth
    keeping: the table answers "this fleet is not physical", and a missing
    ``max_power_mw`` is not a claim about a battery — it is a request that never
    described one.
    """
    value = _number(asset.get(key))
    if value is None:
        _refuse("REQUEST_INVALID", f"{field} must be a finite number", field)
    return value


def _magnitude(value: float, cap: float, field: str) -> None:
    if not 0 < value <= cap:
        _refuse(
            "MAGNITUDE_OUT_OF_RANGE",
            f"{field} is {value}; the range is (0, {cap}]",
            field,
            cap,
        )


def _efficiency(value: float, field: str) -> None:
    if not MIN_EFFICIENCY <= value < 1:
        _refuse(
            "RTE_OUT_OF_RANGE",
            f"{field} is {value}; the range is [0.5, 1.0)",
            field,
            MIN_EFFICIENCY,
        )


def _clock_hour(raw: Any, field: str) -> int:
    """``"HH:00"`` → the hour, or a refusal.

    Minutes must be ``00``: the horizon is 24 whole hours, so a window opening
    at 11:30 would have to be rounded to be usable — and rounding is the
    correction this table exists to refuse.
    """
    if not isinstance(raw, str) or len(raw) != 5 or raw[2] != ":":
        _refuse("AVAILABILITY_INVALID", f'{field} must be an "HH:00" string', field)
    hours, _, minutes = raw.partition(":")
    if not hours.isdigit() or minutes != "00" or not 0 <= int(hours) <= 24:
        _refuse(
            "AVAILABILITY_INVALID",
            f'{field} is {raw!r}; availability is "HH:00" on the hour',
            field,
        )
    return int(hours)


def _check_availability(asset: dict[str, Any], path: str) -> None:
    start = _clock_hour(
        asset.get("available_from", DEFAULT_AVAILABLE_FROM), f"{path}.available_from"
    )
    end = _clock_hour(
        asset.get("available_to", DEFAULT_AVAILABLE_TO), f"{path}.available_to"
    )
    if end <= start:
        # Half-open ``[from, to)``: ``to == from`` covers no hour at all.
        # Refused rather than read as "all day" or as "never dispatched" —
        # both are guesses about which the caller meant.
        _refuse(
            "AVAILABILITY_INVALID",
            f"{path} is available from {start}:00 to {end}:00, which is not a window",
            f"{path}.available_to",
        )


def _check_battery(asset: dict[str, Any], path: str) -> None:
    max_power = _required(asset, "max_power_mw", f"{path}.max_power_mw")
    _magnitude(max_power, MAX_POWER_MW, f"{path}.max_power_mw")
    _magnitude(
        _required(asset, "energy_capacity_mwh", f"{path}.energy_capacity_mwh"),
        MAX_ENERGY_MWH,
        f"{path}.energy_capacity_mwh",
    )

    # --- the efficiency pair, before either half is range-checked ------------
    #
    # One number or two, never one and a half. Half a pair is refused rather
    # than mirrored, because mirroring invents the number the caller did not
    # have; a round trip *beside* a half is refused because reconciling the two
    # means picking one and silently discarding the other.
    round_trip = "round_trip_efficiency" in asset
    charge = "charge_efficiency" in asset
    discharge = "discharge_efficiency" in asset
    if charge != discharge:
        half = "charge_efficiency" if charge else "discharge_efficiency"
        _refuse(
            "EFFICIENCY_PAIR_INCOMPLETE",
            f"{path} supplies {half} without its pair",
            f"{path}.{half}",
        )
    if round_trip and (charge or discharge):
        _refuse(
            "EFFICIENCY_PAIR_INCOMPLETE",
            f"{path} supplies round_trip_efficiency alongside an explicit pair",
            f"{path}.round_trip_efficiency",
        )
    if not round_trip and not charge:
        _refuse(
            "REQUEST_INVALID",
            f"{path} states no efficiency",
            f"{path}.round_trip_efficiency",
        )
    if round_trip:
        _efficiency(
            _required(asset, "round_trip_efficiency", f"{path}.round_trip_efficiency"),
            f"{path}.round_trip_efficiency",
        )
    else:
        for key in ("charge_efficiency", "discharge_efficiency"):
            _efficiency(_required(asset, key, f"{path}.{key}"), f"{path}.{key}")

    # --- the state-of-charge window, then the point inside it ---------------
    min_soc = (
        _required(asset, "min_state_of_charge", f"{path}.min_state_of_charge")
        if "min_state_of_charge" in asset
        else DEFAULT_MIN_STATE_OF_CHARGE
    )
    max_soc = (
        _required(asset, "max_state_of_charge", f"{path}.max_state_of_charge")
        if "max_state_of_charge" in asset
        else DEFAULT_MAX_STATE_OF_CHARGE
    )
    if not 0 <= min_soc < max_soc <= 1:
        _refuse(
            "SOC_BOUNDS_INVALID",
            f"{path} has min_state_of_charge {min_soc} and max_state_of_charge "
            f"{max_soc}; the rule is 0 <= min < max <= 1",
            f"{path}.min_state_of_charge",
        )
    initial = _required(
        asset, "initial_state_of_charge", f"{path}.initial_state_of_charge"
    )
    if not min_soc <= initial <= max_soc:
        # **The clamp that does not happen.** `docs/specs/flex-optimizer.md`
        # names this case on its own: an initial state of charge outside its
        # bounds is an error, never a clamp, because the plan would otherwise be
        # computed for a battery the user did not describe.
        _refuse(
            "SOC_INITIAL_OUT_OF_BOUNDS",
            f"{path} starts at {initial}, outside its own bounds [{min_soc}, {max_soc}]",
            f"{path}.initial_state_of_charge",
        )

    # --- the per-direction limits, against the inverter ---------------------
    for key in ("max_charge_mw", "max_discharge_mw"):
        if key not in asset:
            continue
        value = _required(asset, key, f"{path}.{key}")
        # The table names three magnitudes explicitly; the same code covers the
        # rest, because a negative ``max_charge_mw`` has no other code in the
        # closed enum and admitting it would hand the solver a free direction.
        _magnitude(value, MAX_POWER_MW, f"{path}.{key}")
        if value > max_power:
            _refuse(
                "POWER_LIMIT_INCONSISTENT",
                f"{path}.{key} is {value}, above max_power_mw {max_power}",
                f"{path}.{key}",
                max_power,
            )


def _check_shiftable_load(asset: dict[str, Any], path: str) -> None:
    max_power = _required(asset, "max_power_mw", f"{path}.max_power_mw")
    _magnitude(max_power, MAX_POWER_MW, f"{path}.max_power_mw")
    daily_energy = _required(asset, "daily_energy_mwh", f"{path}.daily_energy_mwh")
    _magnitude(daily_energy, MAX_ENERGY_MWH, f"{path}.daily_energy_mwh")
    max_shift = _required(asset, "max_shift_mw", f"{path}.max_shift_mw")
    _magnitude(max_shift, MAX_POWER_MW, f"{path}.max_shift_mw")

    if max_shift > max_power:
        _refuse(
            "SHIFT_EXCEEDS_CONNECTION",
            f"{path}.max_shift_mw is {max_shift}, above the connection limit {max_power}",
            f"{path}.max_shift_mw",
            max_power,
        )

    # The one physical check the formulation cannot make for itself. Zerrahn &
    # Schill's (D1) conserves daily energy by construction, so nothing in the
    # model stops a load being shed by more power than it draws; with no
    # baseline profile supplied the flat baseline is ``daily_energy_mwh / 24``.
    baseline = daily_energy / 24
    if max_shift > baseline:
        _refuse(
            "SHIFT_EXCEEDS_BASELINE",
            f"{path}.max_shift_mw is {max_shift}, above the flat baseline "
            f"{baseline} (daily_energy_mwh / 24)",
            f"{path}.max_shift_mw",
            baseline,
        )

    window = asset.get("shift_window_hours")
    if (
        isinstance(window, bool)
        or not isinstance(window, int)
        or not MIN_SHIFT_WINDOW_HOURS <= window <= MAX_SHIFT_WINDOW_HOURS
    ):
        _refuse(
            "SHIFT_WINDOW_OUT_OF_RANGE",
            f"{path}.shift_window_hours is {window!r}; the range is "
            f"[{MIN_SHIFT_WINDOW_HOURS}, {MAX_SHIFT_WINDOW_HOURS}] whole hours",
            f"{path}.shift_window_hours",
            MAX_SHIFT_WINDOW_HOURS,
        )

    # ``null`` is a stated member of the contract and means "no (D5) block",
    # which is a different scenario from a recovery time of zero. Absent and
    # null are the same thing here and neither is a refusal.
    recovery = asset.get("recovery_time_hours")
    if recovery is not None:
        hours = _number(recovery)
        if (
            hours is None
            or not MIN_RECOVERY_TIME_HOURS <= hours <= MAX_RECOVERY_TIME_HOURS
        ):
            _refuse(
                "RECOVERY_TIME_OUT_OF_RANGE",
                f"{path}.recovery_time_hours is {recovery!r}; the range is "
                f"[{MIN_RECOVERY_TIME_HOURS}, {MAX_RECOVERY_TIME_HOURS}]",
                f"{path}.recovery_time_hours",
                MAX_RECOVERY_TIME_HOURS,
            )


def _check_asset(raw: Any, index: int, scenario_subsystem: str) -> None:
    path = f"assets[{index}]"
    if not isinstance(raw, dict):
        _refuse("ASSET_TYPE_UNKNOWN", f"{path} is not an object", path)
    asset_type = raw.get("asset_type")
    allowed = VARIANT_FIELDS.get(asset_type) if isinstance(asset_type, str) else None
    if allowed is None:
        _refuse(
            "ASSET_TYPE_UNKNOWN",
            f"{path}.asset_type is {asset_type!r}",
            f"{path}.asset_type",
        )
    for key in raw:
        if key not in allowed:
            _refuse(
                "FIELD_NOT_ON_VARIANT",
                f"{key} is not a field of {asset_type}",
                f"{path}.{key}",
            )

    # One subsystem per scenario: ``curt[t]`` is a subsystem-level series and an
    # asset elsewhere cannot absorb it. Mixed-subsystem scenarios are rejected,
    # never summed — summing would report Northeast curtailment absorbed by a
    # battery in the South.
    if raw.get("subsystem") != scenario_subsystem:
        _refuse(
            "SUBSYSTEM_MISMATCH",
            f"{path}.subsystem is {raw.get('subsystem')!r}; the scenario is "
            f"{scenario_subsystem}",
            f"{path}.subsystem",
        )

    if asset_type == "battery":
        _check_battery(raw, path)
    else:
        _check_shiftable_load(raw, path)
    _check_availability(raw, path)


def _local_today(now: datetime) -> date:
    """The Brasília civil day ``now`` falls in."""
    return now.astimezone(GRID_ZONE).date()


def latest_target_date(now: datetime) -> date:
    """The last ``target_date`` this API will plan for: tomorrow, in Brasília."""
    return _local_today(now) + timedelta(days=1)


def _check_target_date(raw: Any, now: datetime) -> None:
    if not isinstance(raw, str):
        _refuse("REQUEST_INVALID", "target_date must be YYYY-MM-DD", "target_date")
    try:
        # ``fromisoformat`` accepts ``YYYYMMDD`` too, so the length is checked as
        # well: the wire form is the schema's ``civil_date`` and nothing else.
        if len(raw) != 10:
            raise ValueError(raw)
        target = date.fromisoformat(raw)
    except ValueError:
        _refuse(
            "REQUEST_INVALID",
            f"target_date {raw!r} is not a calendar date",
            "target_date",
        )
    latest = latest_target_date(now)
    if target < DATA_WINDOW_OPENS_ON or target > latest:
        _refuse(
            "TARGET_DATE_OUT_OF_RANGE",
            f"target_date {raw} is outside "
            f"[{DATA_WINDOW_OPENS_ON.isoformat()}, {latest.isoformat()}]",
            "target_date",
        )


def _check_economic_assumptions(raw: Any) -> None:
    if raw is None:
        # Absent means the published ``BRL_PER_MWH`` is used and stamped on the
        # answer. Not a default standing in for a bad value — there is no value.
        return
    if not isinstance(raw, dict):
        _refuse(
            "REQUEST_INVALID", "economic_assumptions is an object", "economic_assumptions"
        )
    rate = _number(raw.get("brl_per_mwh"))
    field = "economic_assumptions.brl_per_mwh"
    if rate is None:
        _refuse("REQUEST_INVALID", f"{field} must be a number", field)
    if not 0 < rate <= MAX_BRL_PER_MWH:
        _refuse(
            "ECONOMIC_ASSUMPTION_OUT_OF_RANGE",
            f"{field} is {rate}; the range is (0, {MAX_BRL_PER_MWH}]",
            field,
            MAX_BRL_PER_MWH,
        )


def validate_scenario(wire: Any, now: datetime) -> None:
    """Refuse a scenario that is not one, or return.

    Takes the wire form — ``snake_case``, as :func:`~wattsteer_ml.scenario.
    decode_scenario_body` produces it and as the hash was taken over it — and
    ``now``, which is what "tomorrow" is measured from. The clock is a parameter
    rather than a call to :func:`datetime.now` so that a fixture asserting the
    boundary asserts a boundary rather than the day the suite happened to run.

    Returns nothing. There is no repaired scenario to hand back, which is this
    module's whole posture expressed in a signature.
    """
    if not isinstance(wire, dict):
        _refuse("BAD_INPUT", "a scenario is a JSON object")
    version = wire.get("v")
    if isinstance(version, bool) or version != SCENARIO_VERSION:
        _refuse(
            "SCENARIO_VERSION_UNSUPPORTED",
            f"v must be {SCENARIO_VERSION}; this scenario carries {version!r}",
            "v",
            SCENARIO_VERSION,
        )

    subsystem = wire.get("subsystem")
    if not isinstance(subsystem, str) or subsystem not in SUBSYSTEM_CODES:
        _refuse(
            "SUBSYSTEM_UNKNOWN",
            f"subsystem is {subsystem!r}; the four are {', '.join(SUBSYSTEM_CODES)}",
            "subsystem",
        )

    _check_target_date(wire.get("target_date"), now)

    assets = wire.get("assets")
    if not isinstance(assets, list) or not assets:
        _refuse("REQUEST_INVALID", "a scenario describes at least one asset", "assets")
    if len(assets) > MAX_ASSETS:
        _refuse(
            "SCENARIO_TOO_LARGE",
            f"the scenario carries {len(assets)} assets; the cap is {MAX_ASSETS}",
            "assets",
            MAX_ASSETS,
        )
    for index, asset in enumerate(assets):
        _check_asset(asset, index, subsystem)

    _check_economic_assumptions(wire.get("economic_assumptions"))


def forecast_unavailable(
    subsystem: str, target_date: str, forecast_origin: str | None = None
) -> ScenarioValidationError:
    """``FORECAST_UNAVAILABLE`` — defined here, raised by flex-optimizer ticket 07.

    The table lists it beside the other refusals, but it is the only row that is
    not a fact about the scenario: the scenario is well formed and describes a
    real fleet, and there is simply no forecast for that subsystem, date and
    origin to plan against. Deciding that needs the query ticket 07 owns, so
    nothing in this module raises it — and it is constructed here anyway so that
    its code and its ``details`` shape have one definition rather than being
    invented at the throw site. ``packages/core/src/scenario-validation.ts``
    builds the identical envelope on the other side of the wire.
    """
    origin = f" at origin {forecast_origin}" if forecast_origin else ""
    details: dict[str, Any] = {"subsystem": subsystem, "target_date": target_date}
    if forecast_origin is not None:
        details["forecast_origin"] = forecast_origin
    return ScenarioValidationError(
        "FORECAST_UNAVAILABLE",
        f"No forecast exists for {subsystem} on {target_date}{origin}",
        details,
    )
