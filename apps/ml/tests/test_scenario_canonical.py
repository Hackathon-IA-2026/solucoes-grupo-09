"""The canonical scenario transport, against the shared vectors.

``packages/core/test/scenario-canonical.test.ts`` reads the **same** directory
and asserts the **same** expected values against the TypeScript implementation.
Neither side is asserted against the other, and both fail on a file they did not
enumerate — see ``packages/core/fixtures/scenario-canonical/README.md``.

The property under test is not "the encoder works". It is that the sha256 of a
scenario's canonical bytes is *the same number* in two languages, whatever
spelling the scenario arrived in. That number is a Redis cache key and the
``scenario_hash`` on every answer, so a disagreement is a cache that silently
never hits and a reproducibility claim that cannot be reproduced.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from wattsteer_ml.scenario import (
    MAX_SCENARIO_BLOB_BYTES,
    DecodedScenario,
    ScenarioTransportError,
    canonical_json,
    canonicalize_scenario,
    decode_scenario_body,
    decode_scenario_param,
    encode_scenario,
    from_base64url,
    hash_canonical_bytes,
    scenario_hash,
    to_base64url,
)

FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "core"
    / "fixtures"
    / "scenario-canonical"
)


def _vectors(subdirectory: str) -> list[tuple[str, dict[str, Any]]]:
    directory = FIXTURES / subdirectory
    files = sorted(path for path in directory.iterdir() if path.suffix == ".json")
    return [(path.name, json.loads(path.read_text(encoding="utf-8"))) for path in files]


def _ids(vectors: list[tuple[str, dict[str, Any]]]) -> list[str]:
    return [name for name, _ in vectors]


NUMBERS: list[dict[str, Any]] = json.loads(
    (FIXTURES / "numbers.json").read_text(encoding="utf-8")
)["cases"]
SCENARIOS = _vectors("scenarios")
EQUIVALENCES = _vectors("equivalences")
REFUSALS = _vectors("refusals")


def test_every_vector_directory_is_populated() -> None:
    """A passing run has to mean something, so an empty directory fails."""
    assert NUMBERS
    assert SCENARIOS
    assert EQUIVALENCES
    assert REFUSALS


def test_no_vector_file_is_skipped() -> None:
    """The half that stops a vector added for one language being ignored here.

    Every ``.json`` under the directory is either enumerated by one of the
    parametrised suites below or is ``numbers.json`` itself. A file that is
    neither is a case this side is silently not running.
    """
    consumed = {"numbers.json"}
    for subdirectory, vectors in (
        ("scenarios", SCENARIOS),
        ("equivalences", EQUIVALENCES),
        ("refusals", REFUSALS),
    ):
        consumed.update(f"{subdirectory}/{name}" for name, _ in vectors)
    on_disk = {str(path.relative_to(FIXTURES)) for path in FIXTURES.rglob("*.json")}
    assert on_disk == consumed


# --- the number rule ---------------------------------------------------------


@pytest.mark.parametrize("case", NUMBERS, ids=[case["name"] for case in NUMBERS])
def test_a_number_has_one_canonical_spelling(case: dict[str, Any]) -> None:
    """RFC 8785 §3.2.2.3, which is ECMAScript's ``Number::toString``.

    ``repr`` would pass a third of these and fail the rest, which is exactly why
    the rule is written out rather than delegated.
    """
    assert canonical_json(case["input"]) == case["expected"]


def test_repr_is_not_the_rule() -> None:
    """The test of the test: the obvious implementation is wrong, right here.

    If this ever stops failing, ``_ecmascript_number`` has been replaced by
    something that agrees with ``repr`` — and the two languages have quietly
    stopped agreeing about a whole number.
    """
    assert repr(100.0) == "100.0"
    assert canonical_json(100.0) == "100"
    assert repr(1e-06) == "1e-06"
    assert canonical_json(1e-06) == "0.000001"


def test_a_trailing_zero_in_a_vector_fails() -> None:
    """The test of the test, in the spelling api-surface ticket 21 names.

    ``packages/core/test/scenario-canonical.test.ts`` asserts the same pair, and
    the acceptance criterion is that a deliberately broken vector fails on
    *both* sides. ``0.92`` against ``0.920`` is the spec's own worked example:
    two spellings of one number that hash differently are a Redis key that never
    hits and a ``scenario_hash`` that cannot reproduce anything.
    """
    broken = json.loads('{"round_trip_efficiency":0.92}')
    assert canonical_json(broken) != '{"round_trip_efficiency":0.920}'
    assert canonical_json(broken) == '{"round_trip_efficiency":0.92}'


def test_a_non_finite_number_has_no_canonical_form() -> None:
    for value in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ScenarioTransportError):
            canonical_json(value)


# --- the whole scenarios -----------------------------------------------------


@pytest.mark.parametrize(("name", "vector"), SCENARIOS, ids=_ids(SCENARIOS))
def test_a_scenario_encodes_to_its_vector(name: str, vector: dict[str, Any]) -> None:
    scenario = vector["scenario"]
    assert canonicalize_scenario(scenario) == vector["canonical"]
    assert encode_scenario(scenario) == vector["blob"]
    assert scenario_hash(scenario) == vector["hash"]
    assert hash_canonical_bytes(vector["canonical"].encode("utf-8")) == vector["hash"]


@pytest.mark.parametrize(("name", "vector"), SCENARIOS, ids=_ids(SCENARIOS))
def test_both_paths_decode_to_identical_bytes(name: str, vector: dict[str, Any]) -> None:
    """``GET ?s=`` and ``POST`` reach the same bytes, asserted as an equality.

    Not as two assertions against the same constant: the claim in the spec is
    that the two transports cannot disagree, and that is a statement about them
    rather than about a fixture.
    """
    from_param: DecodedScenario = decode_scenario_param(vector["blob"])
    from_body: DecodedScenario = decode_scenario_body(vector["scenario"])
    assert from_param.payload == from_body.payload
    assert from_param.hash == from_body.hash
    assert from_param.canonical == vector["canonical"]


@pytest.mark.parametrize(("name", "vector"), SCENARIOS, ids=_ids(SCENARIOS))
def test_a_blob_round_trips_byte_identically(name: str, vector: dict[str, Any]) -> None:
    decoded = decode_scenario_param(vector["blob"])
    assert encode_scenario(decoded.scenario) == vector["blob"]
    assert decoded.canonical == vector["canonical"]


# --- the equivalences --------------------------------------------------------


@pytest.mark.parametrize(("name", "vector"), EQUIVALENCES, ids=_ids(EQUIVALENCES))
def test_different_documents_are_one_scenario(name: str, vector: dict[str, Any]) -> None:
    """Key order and float spelling are text, not scenario.

    ``0.92`` against ``0.920`` is the spec's own example and the cheapest way to
    build a cache that never hits.
    """
    variants = vector["variants"]
    assert len(variants) > 1
    for variant in variants:
        decoded = decode_scenario_body(variant)
        assert decoded.canonical == vector["canonical"]
        assert decoded.hash == vector["hash"]
        assert to_base64url(decoded.payload) == vector["blob"]


# --- the refusals ------------------------------------------------------------


@pytest.mark.parametrize(("name", "vector"), REFUSALS, ids=_ids(REFUSALS))
def test_a_refused_blob_names_its_code(name: str, vector: dict[str, Any]) -> None:
    with pytest.raises(ScenarioTransportError) as raised:
        if "blob" in vector and "scenario" not in vector:
            decode_scenario_param(vector["blob"])
        else:
            decode_scenario_body(vector["scenario"])
    assert raised.value.code == vector["expected_code"]


def test_a_five_kilobyte_blob_is_refused_before_anything_parses_it() -> None:
    blob = "A" * (5 * 1024)
    assert len(blob) > MAX_SCENARIO_BLOB_BYTES
    with pytest.raises(ScenarioTransportError) as raised:
        decode_scenario_param(blob)
    assert raised.value.code == "SCENARIO_TOO_LARGE"


def test_a_blob_at_exactly_the_cap_is_not_refused_for_its_size() -> None:
    """The boundary from the other side: the cap is ``>``, not ``>=``."""
    with pytest.raises(ScenarioTransportError) as raised:
        decode_scenario_param("A" * MAX_SCENARIO_BLOB_BYTES)
    assert raised.value.code != "SCENARIO_TOO_LARGE"


def test_a_scenario_too_large_to_share_is_refused_on_the_way_out() -> None:
    vector = json.loads(
        (FIXTURES / "refusals" / "05-a-blob-over-the-cap.json").read_text(
            encoding="utf-8"
        )
    )
    with pytest.raises(ScenarioTransportError) as raised:
        encode_scenario(vector["scenario"])
    assert raised.value.code == "SCENARIO_TOO_LARGE"


def test_a_shiftable_load_carrying_a_batterys_field_does_not_parse() -> None:
    """The sum-type rule in the direction the vectors do not cover.

    The check is about the variant, not about one field somebody remembered.
    """
    with pytest.raises(ScenarioTransportError) as raised:
        decode_scenario_body(
            {
                "v": 1,
                "subsystem": "NE",
                "target_date": "2026-08-29",
                "assets": [
                    {
                        "asset_type": "shiftable_load",
                        "label": "Flexible load",
                        "subsystem": "NE",
                        "max_power_mw": 70,
                        "max_shift_mw": 50,
                        "shift_window_hours": 3,
                        "daily_energy_mwh": 1700,
                        "energy_capacity_mwh": 300,
                    }
                ],
            }
        )
    assert raised.value.code == "FIELD_NOT_ON_VARIANT"


# --- base64url ---------------------------------------------------------------


def test_base64url_round_trips_every_length_up_to_four_blocks() -> None:
    for length in range(16):
        payload = bytes((index * 37 + 11) % 256 for index in range(length))
        assert from_base64url(to_base64url(payload)) == payload


def test_the_alphabet_is_base64urls_not_base64s() -> None:
    assert to_base64url(bytes([0xFB, 0xFF, 0xBF])) == "-_-_"
    with pytest.raises(ScenarioTransportError):
        decode_scenario_param("eyJ2Ijox+/8=")
