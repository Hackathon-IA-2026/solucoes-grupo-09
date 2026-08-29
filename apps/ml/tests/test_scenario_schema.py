"""One JSON Schema, asserted from the Python side too.

``packages/core/schema/`` is the cross-language authority.
``packages/core/test/spec-examples.test.ts`` and
``packages/core/test/schema-generated-types.test.ts`` hold the TypeScript side
to it; this module is the other half of the same claim.

**Why both suites and not one.** ``docs/specs/flex-optimizer.md`` names the
failure it is guarding against: *"The prototype's `optimize.ts` types and the ml
service's models drifting apart is the most likely way this engine breaks
quietly, since both look right in isolation."* One suite asserting the schema
proves the schema is well-formed. Two suites, one per language, prove the two
implementations are describing the same wire — and a deliberate drift in either
fails, which is the property the ticket asks for.

The dependency is test-only. This service validates nothing at runtime that the
gateway did not already validate: ``docs/specs/flex-optimizer.md`` puts the
eighteen rules in the Elysia gateway "before the request reaches the solver",
and re-asserting a JSON Schema per request would put model construction behind a
second parse for no protection.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from wattsteer_ml.constants import REFERENCE_FLEET
from wattsteer_ml.scenario import VARIANT_FIELDS, canonicalize_scenario

REPO = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO / "packages" / "core" / "schema"
VECTORS = REPO / "packages" / "core" / "fixtures" / "scenario-canonical"

BASE = "https://wattsteer.com/schema/"


def _registry() -> Registry[Any]:
    """Every schema file, under the ``$id`` its siblings reference it by.

    Cross-file ``$ref``s are written as the bare file name and resolve against
    the ``$id``, exactly as ``packages/core/src/schema.ts`` loads them — so the
    two languages are reading one directory the same way, not two.
    """
    registry: Registry[Any] = Registry()
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        contents = json.loads(path.read_text(encoding="utf-8"))
        registry = registry.with_resource(
            BASE + path.name, Resource.from_contents(contents)
        )
    return registry


REGISTRY = _registry()
ASSET_SCHEMA = json.loads(
    (SCHEMA_DIR / "flexibility-asset.schema.json").read_text(encoding="utf-8")
)


def _validator(file: str) -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / file).read_text(encoding="utf-8"))
    return Draft202012Validator(schema, registry=REGISTRY)


def _scenario_vectors() -> list[tuple[str, dict[str, Any]]]:
    directory = VECTORS / "scenarios"
    return [
        (path.name, json.loads(path.read_text(encoding="utf-8"))["scenario"])
        for path in sorted(directory.glob("*.json"))
    ]


SCENARIOS = _scenario_vectors()


def test_the_schema_directory_is_where_it_is_expected() -> None:
    """A missing directory must fail loudly rather than skip every test below."""
    assert (SCHEMA_DIR / "scenario.schema.json").is_file()
    assert (SCHEMA_DIR / "flexibility-asset.schema.json").is_file()
    assert SCENARIOS


@pytest.mark.parametrize(
    ("name", "scenario"), SCENARIOS, ids=[name for name, _ in SCENARIOS]
)
def test_every_shared_vector_validates(name: str, scenario: dict[str, Any]) -> None:
    """The vectors this side canonicalises are scenarios the schema admits.

    Without this the transport suite could be exercising documents no gateway
    would ever forward, and a byte-exact encoder for those is worth nothing.
    """
    _validator("scenario.schema.json").validate(scenario)
    assert canonicalize_scenario(scenario)


def test_the_reference_fleet_is_a_scenario_the_schema_admits() -> None:
    """The published fleet, through the published schema.

    ``REFERENCE_FLEET`` is not defined here — it is read from
    ``wattsteer_ml.constants``, which the shared ``published-constants`` vector
    already pins against ``packages/core/src/constants.ts``. What this adds is
    that the one fleet every published figure is measured against is also a
    scenario the wire accepts.
    """
    battery = REFERENCE_FLEET.battery
    load = REFERENCE_FLEET.shiftable_load
    scenario = {
        "v": 1,
        "subsystem": "NE",
        "target_date": "2026-08-29",
        "assets": [
            {
                "asset_type": battery.asset_type,
                "label": battery.label,
                "subsystem": "NE",
                "max_power_mw": battery.max_power_mw,
                "energy_capacity_mwh": battery.energy_capacity_mwh,
                "round_trip_efficiency": battery.round_trip_efficiency,
                "initial_state_of_charge": battery.initial_state_of_charge,
            },
            {
                "asset_type": load.asset_type,
                "label": load.label,
                "subsystem": "NE",
                "max_power_mw": load.max_power_mw,
                "max_shift_mw": load.max_shift_mw,
                "shift_window_hours": load.shift_window_hours,
                "daily_energy_mwh": load.daily_energy_mwh,
            },
        ],
        "economic_assumptions": {"brl_per_mwh": 180},
    }
    _validator("scenario.schema.json").validate(scenario)


def test_variant_fields_match_the_schema() -> None:
    """``VARIANT_FIELDS`` is the schema's own key sets, and this is the check.

    The Python module transcribes them because this service has no build step
    and ``schema/`` is not copied into its image. Adding an `EV` variant to the
    schema therefore has to fail *here* rather than be silently accepted as an
    unknown ``asset_type`` — which is the difference between a transcription and
    a fork.
    """
    from_schema: dict[str, frozenset[str]] = {}
    for branch in ASSET_SCHEMA["$defs"].values():
        properties = branch["properties"]
        discriminant = properties["asset_type"]["const"]
        from_schema[discriminant] = frozenset(properties)
        # The variant's closedness is what makes FIELD_NOT_ON_VARIANT a schema
        # fact rather than a hand-written rule. A variant that opened up would
        # make the key set below meaningless.
        assert branch["additionalProperties"] is False
    assert from_schema == VARIANT_FIELDS


def test_the_variants_are_the_ones_the_union_names() -> None:
    """No variant is reachable except through the sum type's own ``oneOf``."""
    named = {branch["$ref"].removeprefix("#/$defs/") for branch in ASSET_SCHEMA["oneOf"]}
    assert named == set(ASSET_SCHEMA["$defs"])


def test_a_battery_carrying_max_shift_mw_is_refused_by_the_schema() -> None:
    """The schema half of the acceptance criterion.

    TypeScript refuses it at compile time, this side refuses it at parse time,
    and the schema refuses it for both — ``additionalProperties: false`` on each
    branch means no ``oneOf`` member matches, so the sum type has no branch to
    put it in.
    """
    asset = {
        "asset_type": "battery",
        "label": "Battery",
        "subsystem": "NE",
        "max_power_mw": 100,
        "energy_capacity_mwh": 300,
        "initial_state_of_charge": 0.2,
        "max_shift_mw": 50,
    }
    assert not _validator("flexibility-asset.schema.json").is_valid(asset)


def test_an_unknown_version_is_refused_by_the_schema() -> None:
    """``v`` is a ``const``, so ``v: 2`` fails the schema as well as the transport."""
    scenario = dict(SCENARIOS[0][1], v=2)
    assert not _validator("scenario.schema.json").is_valid(scenario)


def test_a_label_over_sixty_four_characters_is_refused() -> None:
    """``docs/specs/flex-optimizer.md``'s untrusted-input hygiene rule.

    The label is the one free-text field on an attacker-controlled object, and
    the cap is a schema fact so that neither language has to remember it.
    """
    validator = _validator("flexibility-asset.schema.json")
    base = {
        "asset_type": "battery",
        "label": "B" * 64,
        "subsystem": "NE",
        "max_power_mw": 100,
        "energy_capacity_mwh": 300,
        "initial_state_of_charge": 0.2,
    }
    assert validator.is_valid(base)
    assert not validator.is_valid(dict(base, label="B" * 65))
    assert not validator.is_valid(dict(base, label=""))


def test_the_future_variants_need_no_change_to_the_common_fields() -> None:
    """`EV`, `DataCentre`, `Electrolyzer` and `HVAC`, added and then discarded.

    The spec's extension claim, made checkable: a new variant is a new branch in
    the ``oneOf`` and nothing else. The common fields, the transport and the
    result shape do not move, and v1 implements none of them — so this test adds
    them to an in-memory copy of the schema rather than to the file.
    """
    common: dict[str, Any] = {
        "asset_type": {"const": "ev"},
        "label": {"type": "string", "minLength": 1, "maxLength": 64},
        "subsystem": {"$ref": "common.schema.json#/$defs/subsystem"},
        "max_power_mw": {"type": "number", "exclusiveMinimum": 0},
        "available_from": {"$ref": "common.schema.json#/$defs/clock_time"},
        "available_to": {"$ref": "common.schema.json#/$defs/clock_time"},
    }
    extended = json.loads(json.dumps(ASSET_SCHEMA))
    for future in ("ev", "data_centre", "electrolyzer", "hvac"):
        branch = json.loads(json.dumps(common))
        branch["asset_type"] = {"const": future}
        extended["$defs"][future] = {
            "type": "object",
            "properties": branch,
            "required": ["asset_type", "label", "subsystem", "max_power_mw"],
            "additionalProperties": False,
        }
        extended["oneOf"].append({"$ref": f"#/$defs/{future}"})

    validator = Draft202012Validator(extended, registry=REGISTRY)
    # The existing variants still validate: adding a branch did not narrow one.
    for _, scenario in SCENARIOS:
        for asset in scenario["assets"]:
            validator.validate(asset)
    validator.validate(
        {
            "asset_type": "hvac",
            "label": "Chillers",
            "subsystem": "NE",
            "max_power_mw": 12,
            "available_from": "08:00",
            "available_to": "18:00",
        }
    )
    # And the transport did not have to move: the scenario schema still points at
    # the same file, so a v1 build refuses the new variant by name rather than by
    # shape, and the result shape is not mentioned at all.
    scenario_schema = json.loads(
        (SCHEMA_DIR / "scenario.schema.json").read_text(encoding="utf-8")
    )
    assert (
        scenario_schema["properties"]["assets"]["items"]["$ref"]
        == "flexibility-asset.schema.json"
    )
