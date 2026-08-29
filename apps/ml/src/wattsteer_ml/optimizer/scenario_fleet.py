"""The fleet a `Scenario` describes, as the model sees it.

The seam between the transport (:mod:`wattsteer_ml.scenario`), the refusal table
(:mod:`wattsteer_ml.scenario_validation`) and :mod:`.fleet`. Three modules and
three jobs: one reads the bytes, one refuses what is not a fleet, and this one
translates what survives. Nothing here validates and nothing here coerces — it
runs *after* :func:`~wattsteer_ml.scenario_validation.validate_scenario` and is
entitled to the guarantees that function makes, which is why a missing
`max_power_mw` here is an :class:`OptimizerBugError` rather than a 422: the only
way to reach it is for validation to have let something through.

**Why the keys are positional.** A MILP variable name must be unique across the
whole fleet, and `label` is attacker-controlled and capped at 64 characters —
two batteries both labelled "Battery" is an ordinary scenario, not an attack, and
naming variables from labels would make it a `500`. The index is the one thing
the wire guarantees is unique, so `assets[0]` becomes `a0` and the label travels
only as prose.
"""

from __future__ import annotations

from typing import Any

from .errors import OptimizerBugError
from .fleet import (
    DEFAULT_MAX_STATE_OF_CHARGE,
    DEFAULT_MIN_STATE_OF_CHARGE,
    Availability,
    Battery,
    ShiftableLoad,
)
from .horizon import HORIZON_HOURS

#: The default window: the whole local day, half-open ``[00:00, 24:00)``.
DEFAULT_AVAILABLE_FROM = "00:00"
DEFAULT_AVAILABLE_TO = "24:00"


def _required(asset: dict[str, Any], key: str, index: int) -> float:
    value = asset.get(key)
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise OptimizerBugError(
            f"assets[{index}].{key} is {value!r} after validation admitted it."
        )
    return float(value)


def _optional(asset: dict[str, Any], key: str, index: int) -> float | None:
    return None if key not in asset else _required(asset, key, index)


def _defaulted(asset: dict[str, Any], key: str, default: float, index: int) -> float:
    """The stated value or the spec's default — ``or`` would eat a legal zero.

    ``min_state_of_charge: 0`` is a battery a caller may legitimately describe,
    and it is falsy. This function exists so that fact is written down once
    rather than being a bug waiting in a boolean.
    """
    stated = _optional(asset, key, index)
    return default if stated is None else stated


def _hour(asset: dict[str, Any], key: str, default: str, index: int) -> int:
    raw = asset.get(key, default)
    if not isinstance(raw, str) or len(raw) != 5 or raw[2] != ":":
        raise OptimizerBugError(
            f"assets[{index}].{key} is {raw!r} after validation admitted it."
        )
    return int(raw[:2])


def _availability(asset: dict[str, Any], index: int) -> Availability:
    """The half-open ``[from, to)`` window, in local hours on the target date."""
    window = Availability(
        from_hour=_hour(asset, "available_from", DEFAULT_AVAILABLE_FROM, index),
        to_hour=_hour(asset, "available_to", DEFAULT_AVAILABLE_TO, index),
    )
    if not 0 <= window.from_hour < window.to_hour <= HORIZON_HOURS:
        raise OptimizerBugError(
            f"assets[{index}] is available [{window.from_hour}, {window.to_hour}), "
            "which validation should have refused."
        )
    return window


def _label(asset: dict[str, Any], index: int) -> str:
    """The caller's prose, echoed and never interpolated anywhere structural."""
    label = asset.get("label")
    return label if isinstance(label, str) else f"assets[{index}]"


def _battery(asset: dict[str, Any], index: int) -> Battery:
    common: dict[str, Any] = {
        "key": f"a{index}",
        "label": _label(asset, index),
        "max_power_mw": _required(asset, "max_power_mw", index),
        "energy_capacity_mwh": _required(asset, "energy_capacity_mwh", index),
        "initial_state_of_charge": _required(asset, "initial_state_of_charge", index),
        "min_state_of_charge": _defaulted(
            asset, "min_state_of_charge", DEFAULT_MIN_STATE_OF_CHARGE, index
        ),
        "max_state_of_charge": _defaulted(
            asset, "max_state_of_charge", DEFAULT_MAX_STATE_OF_CHARGE, index
        ),
        "max_charge_mw": _optional(asset, "max_charge_mw", index),
        "max_discharge_mw": _optional(asset, "max_discharge_mw", index),
        "availability": _availability(asset, index),
    }
    if "round_trip_efficiency" in asset:
        # The datasheet's single number, split `ηc = ηd = √RTE` in exactly one
        # place. `apps/web`'s `optimize.ts` splits the same way, so the two
        # never disagree about a 92 % battery.
        return Battery.from_round_trip(
            round_trip_efficiency=_required(asset, "round_trip_efficiency", index),
            **common,
        )
    # An asymmetric pair the modeller actually has. Validation has already
    # refused half a pair and refused a pair beside a round trip, so reaching
    # here means both are present.
    return Battery(
        charge_efficiency=_required(asset, "charge_efficiency", index),
        discharge_efficiency=_required(asset, "discharge_efficiency", index),
        **common,
    )


def _shiftable_load(asset: dict[str, Any], index: int) -> ShiftableLoad:
    # ``null`` and absent are the same thing — no (D5) block — and are a
    # different scenario from a recovery time of zero. Validation says so; this
    # reads it the same way rather than treating a stated `null` as a number.
    stated = asset.get("recovery_time_hours")
    recovery = None if stated is None else _required(asset, "recovery_time_hours", index)
    return ShiftableLoad(
        key=f"a{index}",
        label=_label(asset, index),
        max_power_mw=_required(asset, "max_power_mw", index),
        max_shift_mw=_required(asset, "max_shift_mw", index),
        shift_window_hours=int(_required(asset, "shift_window_hours", index)),
        daily_energy_mwh=_required(asset, "daily_energy_mwh", index),
        recovery_time_hours=None if recovery is None else int(recovery),
        availability=_availability(asset, index),
    )


def fleet_from_scenario(
    wire: dict[str, Any],
) -> tuple[tuple[Battery, ...], tuple[ShiftableLoad, ...]]:
    """The validated wire scenario's assets, as the two variants the model has.

    Returns the batteries and the loads separately because the builder takes
    them separately: a variant is a dataclass, a constraint block and one term
    in the coupling sum, and keeping the sequences apart is what keeps a third
    variant from touching anything above it.
    """
    assets = wire.get("assets")
    if not isinstance(assets, list) or not assets:
        raise OptimizerBugError("a validated scenario carries at least one asset.")
    batteries: list[Battery] = []
    loads: list[ShiftableLoad] = []
    for index, asset in enumerate(assets):
        if not isinstance(asset, dict):
            raise OptimizerBugError(f"assets[{index}] is not an object.")
        kind = asset.get("asset_type")
        if kind == "battery":
            batteries.append(_battery(asset, index))
        elif kind == "shiftable_load":
            loads.append(_shiftable_load(asset, index))
        else:
            # `ASSET_TYPE_UNKNOWN` is validation's refusal and a 422. Reaching
            # it here means the two tables disagree, which is ours.
            raise OptimizerBugError(
                f"assets[{index}] is a {kind!r}, which validation admitted and "
                "this builder has no block for."
            )
    return tuple(batteries), tuple(loads)
