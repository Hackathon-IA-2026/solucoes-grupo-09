"""The published constants, from the Python side.

`packages/core/src/constants.ts` is the same set of values in TypeScript, and
neither module is generated from the other. What binds them is the shared golden
vector at ``packages/core/fixtures/published-constants/constants.json``:
:mod:`tests.test_published_constants` asserts *this* module against it and
``packages/core/test/published-constants.test.ts`` asserts the TypeScript side
against it, so a shared misunderstanding cannot cancel out.

**Why this module exists.** ``docs/specs/flex-optimizer.md`` calls the R$/MWh
assumption "the single place it is written down", and it was written down in
`apps/web` — a package this service cannot read. The optimizer that needs the
number is here, in Python. A constant only one of the two languages that quote
it can read is not a single definition; it is a number waiting to be retyped.

`docs/domain-model.md` is the naming authority for everything below.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

#: `Subsystem` — an enum, not a table. Exactly four members.
#:
#: ``SIN`` is **not** one of them: it is the national aggregate row ONS mixes
#: into ``balanco-energia-subsistema``, filtered at the ingest boundary. A
#: national total is a derived sum over the four, never a fifth member.
Subsystem = Literal["N", "NE", "S", "SE"]

#: `Technology` — the two variable renewable fleets, in the product's order.
#:
#: **Uppercase, on the wire and in the ``technology`` query parameter, and
#: case-sensitively.** ``docs/domain-model.md`` writes the members in prose as
#: ``wind | solar`` and the wire carries ``wind_mwh`` / ``solar_mwh``, but
#: neither is a spelling of the *value*: one is prose, the other a snake_case
#: field name. The value is uppercase because the ``technology`` Postgres enum,
#: the canonical read rows and the query parameter Elysia already validates all
#: are. See ``packages/core/src/domain.ts`` for the full argument.
Technology = Literal["WIND", "SOLAR"]

TECHNOLOGIES: tuple[Technology, ...] = ("WIND", "SOLAR")


@dataclass(frozen=True)
class SubsystemMeta:
    """A subsystem and the names it is written with."""

    code: Subsystem
    #: ONS's own display name, untranslated (`docs/domain-model.md` naming
    #: rule 2). Translating it would make a subsystem unsearchable against the
    #: files it came from.
    ons_display_name: str
    #: Short label for tight chrome.
    short: str


#: The four members, in the product's display order (north to south) — which is
#: the order the screens render and ``GET /v1/meta`` reports.
SUBSYSTEMS: tuple[SubsystemMeta, ...] = (
    SubsystemMeta(code="N", ons_display_name="NORTE", short="N"),
    SubsystemMeta(code="NE", ons_display_name="NORDESTE", short="NE"),
    SubsystemMeta(code="SE", ons_display_name="SUDESTE/CENTRO-OESTE", short="SE/CO"),
    SubsystemMeta(code="S", ons_display_name="SUL", short="S"),
)

SUBSYSTEM_CODES: tuple[Subsystem, ...] = tuple(meta.code for meta in SUBSYSTEMS)

#: ``curtailment_threshold_mw`` at subsystem grain, MW. A committed default
#: (`docs/domain-model.md` §8.3), configurable, and stamped on every output that
#: used it — a magnitude without the threshold that produced it cannot be
#: compared with another one.
SUBSYSTEM_THRESHOLD_MW = 5

#: ``curtailment_threshold_mw`` at reporting-entity grain, MW. Same rules.
REPORTING_ENTITY_THRESHOLD_MW = 1

#: ``max_gap_hours`` — one sub-threshold hour ends an episode. A non-zero
#: default would silently merge two episodes and change every duration reported.
MAX_GAP_HOURS = 0

#: The single economic assumption WattSteer puts on screen, R$/MWh.
#:
#: A labelled scenario input, never a market price: curtailment compensation and
#: pricing are live regulatory questions, so money appears on screen only beside
#: the rate it assumed. MWh recovered and % avoided are the headline KPIs.
BRL_PER_MWH = 180


@dataclass(frozen=True)
class ReferenceBattery:
    """The reference fleet's battery. Fields as `docs/specs/flex-optimizer.md`."""

    asset_type: Literal["battery"]
    label: str
    #: Inverter limit on charge and discharge, MW.
    max_power_mw: int
    energy_capacity_mwh: int
    round_trip_efficiency: float
    #: Fraction of capacity at the start of the horizon.
    initial_state_of_charge: float


@dataclass(frozen=True)
class ReferenceShiftableLoad:
    """The reference fleet's shiftable load."""

    asset_type: Literal["shiftable_load"]
    label: str
    #: Connection limit, MW.
    max_power_mw: int
    #: The shiftable portion, MW. Never above ``max_power_mw`` or the flat
    #: baseline ``daily_energy_mwh / 24`` — the optimizer rejects either as
    #: ``SHIFT_EXCEEDS_CONNECTION`` / ``SHIFT_EXCEEDS_BASELINE``.
    max_shift_mw: int
    #: ``L`` — the window within which a shift must be compensated, hours.
    shift_window_hours: int
    #: A validation input, not a constraint: it fixes the flat baseline.
    daily_energy_mwh: int


@dataclass(frozen=True)
class ReferenceFleet:
    battery: ReferenceBattery
    shiftable_load: ReferenceShiftableLoad


#: ``REFERENCE_FLEET`` — one published battery and one published flexible load.
#:
#: Floor coverage, the forecaster's ``Δ recovered_floor_mwh``, the featured-days
#: list and the weekly hot-swap guardrail are all measured against a fleet, and
#: they are comparable with each other only if it is the *same* fleet. It ships
#: as a constant rather than an endpoint for exactly that reason, and is echoed
#: in ``GET /v1/meta`` for diagnosability — echoed, never fetched to be used.
#:
#: 50 MW of shift against 1,700 MWh/day is 71 % of the flat-baseline cap. The
#: prototype's 70 MW against 1,200 MWh/day was invalid, and both single-field
#: repairs sat on the validity boundary (98.8 % and exactly 100 %); a constant
#: this many numbers are compared against must not be one rounding from a 422.
REFERENCE_FLEET = ReferenceFleet(
    battery=ReferenceBattery(
        asset_type="battery",
        label="Battery",
        max_power_mw=100,
        energy_capacity_mwh=300,
        round_trip_efficiency=0.92,
        initial_state_of_charge=0.2,
    ),
    shiftable_load=ReferenceShiftableLoad(
        asset_type="shiftable_load",
        label="Flexible load",
        max_power_mw=70,
        max_shift_mw=50,
        shift_window_hours=3,
        daily_energy_mwh=1700,
    ),
)
