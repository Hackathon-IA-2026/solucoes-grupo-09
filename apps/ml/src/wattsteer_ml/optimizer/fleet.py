"""The `FlexibilityAsset` variants, as the model sees them.

This is the *model-boundary* form of `docs/domain-model.md` §6's sum type: the
numbers the MILP builder needs, already derived. Decoding a scenario blob and
refusing a nonsensical one belong to the transport and validation tickets; what
is here is the shape those tickets hand the builder, and the two derivations the
spec is emphatic must happen exactly once.

**Derivation 1 — the efficiency splits.** A datasheet prints one round-trip
number and the SOC balance needs two, because the loss enters asymmetrically:
``×ηc`` on the way in and ``÷ηd`` on the way out. :meth:`Battery.from_round_trip`
sets ``ηc = ηd = √RTE`` — 0.92 becomes 0.959 — and `apps/web`'s `optimize.ts`
splits the same way, so the two never disagree about a 92 % battery. A modeller
who actually has an asymmetric pair passes it to the constructor instead; ``RTE``
is then ``ηc·ηd`` and is never stored twice.

**Derivation 2 — the throughput penalty.** ``δ_b`` is anchored on the research's
§4.3 venting threshold computed from *this* battery's own efficiency, not on a
flat constant: a flat 0.05 would sit below the threshold for any battery under
~90 % round-trip, and the LP cross-check in the test suite would then fail for a
legitimate reason, which is the worst kind of failing test.

v1 implements `Battery` and `ShiftableLoad`. The second variant landed as
exactly what the spec says a variant is — a dataclass here, a constraint block
in :mod:`.shiftable`, and one more term in the coupling sum (C1) — and nothing
above it moved: not the common fields, not the transport, not the result shape,
not the simulator, not the KPI definitions. `EV`, `DataCentre`, `Electrolyzer`
and `HVAC` are meant to land the same way, and this is where the third one
starts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

from ..constants import REFERENCE_FLEET
from .errors import OptimizerBugError
from .horizon import HORIZON_HOURS

#: `docs/specs/flex-optimizer.md`'s defaults for a battery that does not say.
DEFAULT_MIN_STATE_OF_CHARGE = 0.05
DEFAULT_MAX_STATE_OF_CHARGE = 0.95

#: The divisor in a shiftable load's flat baseline, ``daily_energy_mwh / 24``.
#: The hours in a civil day — deliberately not :data:`.horizon.HORIZON_HOURS`,
#: which is the number of *periods*, so that a 15-minute horizon does not
#: quietly divide a daily energy by 96.
HOURS_PER_DAY = 24


@dataclass(frozen=True)
class Availability:
    """Half-open ``[from, to)`` in local hours on the Scenario's target date.

    Outside it every decision variable for the asset is fixed to zero. A
    battery's state of charge simply persists: (B1) with ``ch = dis = 0`` is
    ``soc[t] = soc[t−1]``, so no special case is needed and none is written.
    """

    from_hour: int = 0
    to_hour: int = HORIZON_HOURS

    def covers(self, hour: int) -> bool:
        return self.from_hour <= hour < self.to_hour


#: The default: the asset is dispatchable all day.
WHOLE_DAY = Availability()


@dataclass(frozen=True)
class Battery:
    """A `Battery`, with both efficiencies already separated.

    ``key`` is what the asset's MILP variables are named after and must be
    unique across the fleet — the builder asserts it, because a duplicate
    variable name aborts the whole process under CBC and makes every model dump
    unreadable under SCIP.
    """

    key: str
    label: str
    #: ``P̄_b`` — the inverter limit on ``charge + discharge`` (B6).
    max_power_mw: float
    energy_capacity_mwh: float
    #: ``ηc``.
    charge_efficiency: float
    #: ``ηd``.
    discharge_efficiency: float
    #: ``S⁰_b``, as a fraction of capacity.
    initial_state_of_charge: float
    min_state_of_charge: float = DEFAULT_MIN_STATE_OF_CHARGE
    max_state_of_charge: float = DEFAULT_MAX_STATE_OF_CHARGE
    #: ``P̄ch_b`` (B4). ``None`` → ``max_power_mw``.
    max_charge_mw: float | None = None
    #: ``P̄dis_b`` (B5). ``None`` → ``max_power_mw``.
    max_discharge_mw: float | None = None
    availability: Availability = WHOLE_DAY

    @classmethod
    def from_round_trip(
        cls,
        *,
        key: str,
        label: str,
        max_power_mw: float,
        energy_capacity_mwh: float,
        round_trip_efficiency: float,
        initial_state_of_charge: float,
        min_state_of_charge: float = DEFAULT_MIN_STATE_OF_CHARGE,
        max_state_of_charge: float = DEFAULT_MAX_STATE_OF_CHARGE,
        max_charge_mw: float | None = None,
        max_discharge_mw: float | None = None,
        availability: Availability = WHOLE_DAY,
    ) -> Battery:
        """Build from the single number a datasheet prints, split ``√RTE``."""
        half = math.sqrt(round_trip_efficiency)
        return cls(
            key=key,
            label=label,
            max_power_mw=max_power_mw,
            energy_capacity_mwh=energy_capacity_mwh,
            charge_efficiency=half,
            discharge_efficiency=half,
            initial_state_of_charge=initial_state_of_charge,
            min_state_of_charge=min_state_of_charge,
            max_state_of_charge=max_state_of_charge,
            max_charge_mw=max_charge_mw,
            max_discharge_mw=max_discharge_mw,
            availability=availability,
        )

    @property
    def round_trip_efficiency(self) -> float:
        """``RTE = ηc·ηd``. Derived, never stored twice."""
        return self.charge_efficiency * self.discharge_efficiency

    @property
    def charge_limit_mw(self) -> float:
        return self.max_power_mw if self.max_charge_mw is None else self.max_charge_mw

    @property
    def discharge_limit_mw(self) -> float:
        if self.max_discharge_mw is None:
            return self.max_power_mw
        return self.max_discharge_mw

    @property
    def soc_floor_mwh(self) -> float:
        """``S̲_b``."""
        return self.min_state_of_charge * self.energy_capacity_mwh

    @property
    def soc_ceiling_mwh(self) -> float:
        """``S̄_b``."""
        return self.max_state_of_charge * self.energy_capacity_mwh

    @property
    def initial_soc_mwh(self) -> float:
        """``S⁰_b``."""
        return self.initial_state_of_charge * self.energy_capacity_mwh

    def throughput_penalty(self, rho: float) -> float:
        """``δ_b = ρ · k_b / (2 + k_b)`` with ``k_b = (1 − RTE_b) / RTE_b``.

        A tie-breaker anchored on the venting threshold, not a degradation
        model: its only job is to make the optimizer prefer, among dispatches
        that recover the same energy, the one that cycles the battery less.
        """
        rte = self.round_trip_efficiency
        k = (1.0 - rte) / rte
        return rho * k / (2.0 + k)


@dataclass(frozen=True)
class ShiftableLoad:
    """A `ShiftableLoad` — IDEA.md §31's freezer, as (D1)–(D5) needs it.

    ``key`` names the asset's MILP variables and must be unique across the whole
    fleet, batteries included: two assets sharing a key is a model dump nobody
    can read, and the builder refuses it.

    The asset schema carries one ``max_shift_mw``, so ``C̄up = C̄do``; the two
    are separate properties because the formulation distinguishes them and an
    asymmetric process is a field away, not a reformulation.
    """

    key: str
    label: str
    #: The connection limit, MW. A common field, and not itself a (D) parameter:
    #: what bounds the shift is ``max_shift_mw``, which validation holds at or
    #: below this.
    max_power_mw: float
    #: ``C̄up_a`` and ``C̄do_a`` — the shiftable portion of the process, MW.
    max_shift_mw: float
    #: ``L_a`` — the window within which a shift must be compensated, hours.
    shift_window_hours: int
    #: A **validation input, not a constraint**: (D1) conserves the load's daily
    #: energy by construction, and a daily-energy equality would be redundant
    #: against it and would make an infeasible model far harder to diagnose.
    #: What it buys is the flat baseline below.
    daily_energy_mwh: float
    #: ``R`` — optional. Present emits (D5); absent emits no (D5) row at all.
    recovery_time_hours: int | None = None
    availability: Availability = WHOLE_DAY

    @property
    def up_limit_mw(self) -> float:
        """``C̄up_a`` (D2)."""
        return self.max_shift_mw

    @property
    def down_limit_mw(self) -> float:
        """``C̄do_a`` (D3)."""
        return self.max_shift_mw

    @property
    def simultaneity_limit_mw(self) -> float:
        """``max(C̄up_a, C̄do_a)`` (D4) — the load's mutual-exclusion analogue."""
        return max(self.up_limit_mw, self.down_limit_mw)

    @property
    def flat_baseline_mw(self) -> float:
        """``daily_energy_mwh / 24`` — the power the process draws in an hour.

        The one physical check (D1)–(D4) cannot make for itself: **a load cannot
        be shed by more power than it draws.** With no baseline profile supplied
        the baseline is flat, which is where ticket 04's `SHIFT_EXCEEDS_BASELINE`
        comes from — and the divisor is the hours in a day, not the periods in
        the horizon, so a 15-minute horizon would not silently change it.
        """
        return self.daily_energy_mwh / HOURS_PER_DAY

    @property
    def cycle_energy_mwh(self) -> float:
        """``C̄up_a · L_a`` — the upward energy of one DSM cycle, (D5)'s bound."""
        return self.max_shift_mw * self.shift_window_hours


def reference_battery(key: str = "battery") -> Battery:
    """`packages/core`'s published ``REFERENCE_FLEET`` battery, as a model asset.

    100 MW / 300 MWh at 0.92 round-trip, 20 % initial. It ships as a constant
    rather than a fixture because floor coverage, the forecaster's
    ``Δ recovered_floor_mwh``, the featured-days list and the hot-swap guardrail
    are all measured against a fleet and are comparable only if it is the same
    one. There is no fourth fleet to define here.
    """
    published = REFERENCE_FLEET.battery
    return Battery.from_round_trip(
        key=key,
        label=published.label,
        max_power_mw=float(published.max_power_mw),
        energy_capacity_mwh=float(published.energy_capacity_mwh),
        round_trip_efficiency=published.round_trip_efficiency,
        initial_state_of_charge=published.initial_state_of_charge,
    )


def reference_load(key: str = "load") -> ShiftableLoad:
    """`packages/core`'s published ``REFERENCE_FLEET`` load, as a model asset.

    70 MW connected, 50 MW shiftable, ``L = 3``, 1,700 MWh/day — which is 71 %
    of the flat-baseline cap and deliberately not on it. The prototype's default
    (70 MW of shift against 1,200 MWh/day) is a `SHIFT_EXCEEDS_BASELINE` refusal,
    and both single-field repairs sit on the validity boundary; a constant this
    many numbers are compared against must not be one rounding from a 422. There
    is no second fleet defined here either.
    """
    published = REFERENCE_FLEET.shiftable_load
    return ShiftableLoad(
        key=key,
        label=published.label,
        max_power_mw=float(published.max_power_mw),
        max_shift_mw=float(published.max_shift_mw),
        shift_window_hours=int(published.shift_window_hours),
        daily_energy_mwh=float(published.daily_energy_mwh),
    )


def available_between[FlexibilityAsset: (Battery, ShiftableLoad)](
    asset: FlexibilityAsset, from_hour: int, to_hour: int
) -> FlexibilityAsset:
    """The same asset, dispatchable only in ``[from_hour, to_hour)``.

    One helper for both variants: availability is a *common* field, and a second
    function per variant is how a common field stops being one.
    """
    if not 0 <= from_hour < to_hour <= HORIZON_HOURS:
        raise OptimizerBugError(
            f"availability [{from_hour}, {to_hour}) is not inside the horizon."
        )
    return replace(asset, availability=Availability(from_hour, to_hour))
