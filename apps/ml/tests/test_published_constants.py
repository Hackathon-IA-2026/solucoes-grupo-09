"""Parity of the published constants with the TypeScript side.

``packages/core/test/published-constants.test.ts`` reads the **same** file and
asserts the **same** values against ``packages/core/src/constants.ts``. Neither
side compares against the other — only against the vector — so a shared
misunderstanding cannot cancel out. See
``packages/core/fixtures/published-constants/README.md``.

The comparison is of the whole object rather than key by key, so a value added
to the vector for the other language and never implemented here fails *this*
suite: neither language can quietly skip one.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from wattsteer_ml.constants import (
    BRL_PER_MWH,
    MAX_GAP_HOURS,
    REFERENCE_FLEET,
    REPORTING_ENTITY_THRESHOLD_MW,
    SUBSYSTEM_THRESHOLD_MW,
    SUBSYSTEMS,
    TECHNOLOGIES,
)

# apps/ml/tests/… → repo root → packages/core/fixtures/published-constants
VECTOR_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "core"
    / "fixtures"
    / "published-constants"
    / "constants.json"
)

VECTOR: dict[str, Any] = json.loads(VECTOR_PATH.read_text())


def published() -> dict[str, Any]:
    """What this side publishes, in the vector's shape."""
    return {
        "defaults": {
            "subsystem_threshold_mw": SUBSYSTEM_THRESHOLD_MW,
            "reporting_entity_threshold_mw": REPORTING_ENTITY_THRESHOLD_MW,
            "max_gap_hours": MAX_GAP_HOURS,
            "brl_per_mwh": BRL_PER_MWH,
        },
        "subsystems": [asdict(meta) for meta in SUBSYSTEMS],
        "technologies": list(TECHNOLOGIES),
        "reference_fleet": {
            "battery": asdict(REFERENCE_FLEET.battery),
            "shiftable_load": asdict(REFERENCE_FLEET.shiftable_load),
        },
    }


def test_every_published_value_matches_the_vector() -> None:
    assert published() == VECTOR


def test_the_vector_introduces_no_section_this_side_does_not_publish() -> None:
    assert sorted(VECTOR) == sorted(published())


def test_the_reference_load_cannot_shed_more_power_than_it_draws() -> None:
    """``SHIFT_EXCEEDS_BASELINE`` in ``docs/specs/flex-optimizer.md``.

    The prototype's 70 MW against 1,200 MWh/day failed this, which is why the
    published fleet exists in this shape at all.
    """
    load = REFERENCE_FLEET.shiftable_load
    assert load.max_shift_mw <= load.daily_energy_mwh / 24


def test_the_reference_loads_shift_fits_inside_its_connection() -> None:
    """``SHIFT_EXCEEDS_CONNECTION``."""
    load = REFERENCE_FLEET.shiftable_load
    assert load.max_shift_mw <= load.max_power_mw


def test_the_fleet_is_not_one_rounding_away_from_a_422() -> None:
    """Why neither single-field repair was taken: 98.8 % and exactly 100 %."""
    load = REFERENCE_FLEET.shiftable_load
    assert load.max_shift_mw / (load.daily_energy_mwh / 24) < 0.9


def test_the_batterys_state_of_charge_and_efficiency_are_fractions() -> None:
    battery = REFERENCE_FLEET.battery
    assert 0.0 <= battery.initial_state_of_charge <= 1.0
    #: ``RTE_OUT_OF_RANGE``: [0.50, 1.00).
    assert 0.5 <= battery.round_trip_efficiency < 1.0


def test_there_are_exactly_four_subsystems_and_sin_is_not_one_of_them() -> None:
    assert len(SUBSYSTEMS) == 4
    assert "SIN" not in [meta.code for meta in SUBSYSTEMS]
