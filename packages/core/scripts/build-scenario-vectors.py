"""Build `fixtures/scenario-canonical/` — the shared golden vectors.

**This script is not either shipped implementation, and that is the point.**
`packages/core/src/scenario.ts` walks a value recursively and writes the bytes
itself; `apps/ml/src/wattsteer_ml/scenario.py` does the same in Python. Both are
asserted against the files this script writes, and neither is asserted against
the other — the third property in `../fixtures/canonical-contract/README.md`,
which a rewrite loses first and which is the reason a shared misunderstanding
cannot cancel out here.

So the expected values below come from a *different* route to the same answer:
`json.dumps(sort_keys=True, separators=(",", ":"))`, `hashlib.sha256` and
`base64.urlsafe_b64encode` from the standard library. That route cannot express
ECMAScript's number rule, so every scenario vector is restricted to numbers
whose Python `repr` and ECMAScript `String()` agree (integers, and decimals like
`0.92`); the number rule itself is pinned separately in `numbers.json`, whose
expected strings were read off a real ECMAScript engine, which is the authority
RFC 8785 §3.2.2.3 defers to.

Run: `python3 packages/core/scripts/build-scenario-vectors.py`, then
`bunx biome check --write packages/core/fixtures/scenario-canonical` — Biome
formats JSON as well as TypeScript, and `bun run lint` covers the fixtures.
"""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib

FIXTURES = pathlib.Path(__file__).resolve().parent.parent / "fixtures" / "scenario-canonical"

BATTERY = {
    "asset_type": "battery",
    "label": "Battery",
    "subsystem": "NE",
    "max_power_mw": 100,
    "energy_capacity_mwh": 300,
    "round_trip_efficiency": 0.92,
    "initial_state_of_charge": 0.2,
}

LOAD = {
    "asset_type": "shiftable_load",
    "label": "Flexible load",
    "subsystem": "NE",
    "max_power_mw": 70,
    "max_shift_mw": 50,
    "shift_window_hours": 3,
    "daily_energy_mwh": 1700,
}


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def blob(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def write(name: str, body: dict[str, object]) -> None:
    path = FIXTURES / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {path.relative_to(FIXTURES.parent.parent)}")


def scenario_vector(name: str, description: str, scenario: dict[str, object]) -> dict[str, object]:
    text = canonical(scenario)
    return {
        "name": name,
        "description": description,
        "scenario": scenario,
        "canonical": text,
        "blob": blob(text),
        "hash": digest(text),
    }


def main() -> None:
    write(
        "scenarios/01-the-reference-fleet.json",
        scenario_vector(
            "the reference fleet, both assets",
            "The published REFERENCE_FLEET as a scenario. Every figure the product "
            "compares across screens is measured against this fleet, so this is the "
            "blob a share link most often carries.",
            {
                "v": 1,
                "subsystem": "NE",
                "target_date": "2026-08-29",
                "forecast_origin": "2026-08-28T12:00:00Z",
                "assets": [BATTERY, LOAD],
                "economic_assumptions": {"brl_per_mwh": 180},
            },
        ),
    )
    write(
        "scenarios/02-one-battery-no-optional-fields.json",
        scenario_vector(
            "the smallest scenario the schema admits",
            "No forecast_origin (the latest run is resolved server-side) and no "
            "economic assumptions. An absent optional field and one never written "
            "must produce the same bytes.",
            {
                "v": 1,
                "subsystem": "S",
                "target_date": "2026-08-29",
                "assets": [{**BATTERY, "subsystem": "S"}],
            },
        ),
    )
    write(
        "scenarios/03-a-label-that-needs-escaping.json",
        scenario_vector(
            "a label carrying characters the escape rule owns",
            "The label is the one free-text field on an attacker-controlled object. "
            'A quote, a backslash, a newline, a tab and a non-ASCII character pin '
            "RFC 8785 §3.2.2.2: the two-character escapes where they exist, \\u00xx "
            "for the rest of the control range, and the raw code point otherwise.",
            {
                "v": 1,
                "subsystem": "SE",
                "target_date": "2026-08-29",
                "assets": [
                    {
                        **BATTERY,
                        "subsystem": "SE",
                        "label": 'Bateria "Açu" \\ \n\t <script> é',
                        "available_from": "06:00",
                        "available_to": "22:00",
                    }
                ],
            },
        ),
    )
    write(
        "scenarios/04-availability-and-a-null.json",
        scenario_vector(
            "an explicit null is carried, not dropped",
            "recovery_time_hours is `number | null` in the schema: null is a stated "
            "member of the contract, so it survives canonicalisation and changes the "
            "hash. A canonicaliser that dropped nulls would make two different "
            "scenarios share a cache key.",
            {
                "v": 1,
                "subsystem": "N",
                "target_date": "2026-08-29",
                "assets": [
                    {
                        **LOAD,
                        "subsystem": "N",
                        "recovery_time_hours": None,
                        "available_from": "00:00",
                        "available_to": "24:00",
                    }
                ],
                "economic_assumptions": {"brl_per_mwh": 180},
            },
        ),
    )

    # --- the equivalences: different text, one scenario, one hash -------------
    reordered_base = {
        "v": 1,
        "subsystem": "NE",
        "target_date": "2026-08-29",
        "assets": [BATTERY],
        "economic_assumptions": {"brl_per_mwh": 180},
    }
    reordered_other = {
        "economic_assumptions": {"brl_per_mwh": 180},
        "assets": [
            {
                "initial_state_of_charge": 0.2,
                "round_trip_efficiency": 0.92,
                "energy_capacity_mwh": 300,
                "max_power_mw": 100,
                "subsystem": "NE",
                "label": "Battery",
                "asset_type": "battery",
            }
        ],
        "target_date": "2026-08-29",
        "subsystem": "NE",
        "v": 1,
    }
    text = canonical(reordered_base)
    write(
        "equivalences/01-key-order-does-not-matter.json",
        {
            "name": "the same scenario with every key reversed",
            "description": "Two JSON documents differing only in key order are one "
            "scenario. If they hashed differently the cache would miss on a link a "
            "different client built, which is a cache that silently never hits.",
            "variants": [reordered_base, reordered_other],
            "canonical": text,
            "blob": blob(text),
            "hash": digest(text),
        },
    )

    # 0.92 / 0.920 / 9.2e-1 are one double; the canonical form is a function of
    # the double, never of the text. `json.loads` is what proves it here: all
    # three literals load to the same Python float, exactly as they parse to the
    # same IEEE-754 value in ECMAScript.
    spellings = ["0.92", "0.920", "9.2e-1", "0.9200000000000000"]
    variants = []
    for spelling in spellings:
        variants.append(
            json.loads(
                '{"v":1,"subsystem":"NE","target_date":"2026-08-29","assets":[{"asset_type":"battery",'
                '"label":"Battery","subsystem":"NE","max_power_mw":100,"energy_capacity_mwh":300,'
                f'"round_trip_efficiency":{spelling},"initial_state_of_charge":0.2}}]}}'
            )
        )
    text = canonical(variants[0])
    write(
        "equivalences/02-float-spellings-are-one-number.json",
        {
            "name": "0.92, 0.920, 9.2e-1 and 0.9200000000000000",
            "description": "Four spellings of one IEEE-754 double. The canonical "
            "number rule is the shortest form that round-trips, so all four produce "
            "`0.92` and one hash. This is the vector that would catch a Python side "
            "emitting `0.9200000000000001` or a `%.17g` formatter.",
            "source_spellings": spellings,
            "variants": variants,
            "canonical": text,
            "blob": blob(text),
            "hash": digest(text),
        },
    )

    integer_spellings = ["100", "100.0", "1e2", "100.00"]
    int_variants = [
        json.loads(
            '{"v":1,"subsystem":"NE","target_date":"2026-08-29","assets":[{"asset_type":"battery",'
            '"label":"Battery","subsystem":"NE",'
            f'"max_power_mw":{spelling},'
            '"energy_capacity_mwh":300,"round_trip_efficiency":0.92,"initial_state_of_charge":0.2}]}'
        )
        for spelling in integer_spellings
    ]
    text = canonical(int_variants[0])
    write(
        "equivalences/03-a-whole-number-has-no-trailing-zero.json",
        {
            "name": "100, 100.0, 1e2 and 100.00",
            "description": "`no trailing zeros` in the spec's own words. This is the "
            "vector a naive Python implementation fails: `repr(100.0)` is `100.0` and "
            "`String(100)` is `100`, so the two languages disagree about a battery "
            "nobody typed a decimal point into.",
            "source_spellings": integer_spellings,
            "variants": int_variants,
            "canonical": text,
            "blob": blob(text),
            "hash": digest(text),
        },
    )

    # --- the refusals --------------------------------------------------------
    write(
        "refusals/01-an-unknown-version.json",
        {
            "name": "v: 2",
            "description": "A schema change bumps `v`, and an old client meeting a "
            "new link must fail loudly rather than parse it into a subtly different "
            "scenario. This is the whole difference between a shareable URL and a "
            "time bomb, and it is one integer comparison.",
            "scenario": {**reordered_base, "v": 2},
            "expected_code": "SCENARIO_VERSION_UNSUPPORTED",
        },
    )
    write(
        "refusals/02-no-version-at-all.json",
        {
            "name": "v absent",
            "description": "`v` is mandatory. An absent version is not version 1: it "
            "is a document from a grammar this build cannot name.",
            "scenario": {
                "subsystem": "NE",
                "target_date": "2026-08-29",
                "assets": [BATTERY],
            },
            "expected_code": "SCENARIO_VERSION_UNSUPPORTED",
        },
    )
    write(
        "refusals/03-a-battery-carrying-max-shift-mw.json",
        {
            "name": "a battery with a shiftable load's field",
            "description": "The sum type is discriminated by `asset_type`, so "
            "`max_shift_mw` is not a field a battery has. It does not typecheck in "
            "TypeScript (`additionalProperties: false` becomes an excess-property "
            "error on the variant) and it does not parse in either language.",
            "scenario": {
                "v": 1,
                "subsystem": "NE",
                "target_date": "2026-08-29",
                "assets": [{**BATTERY, "max_shift_mw": 50}],
            },
            "expected_code": "FIELD_NOT_ON_VARIANT",
        },
    )
    write(
        "refusals/04-an-unknown-asset-type.json",
        {
            "name": "asset_type: ev",
            "description": "`EV`, `DataCentre`, `Electrolyzer` and `HVAC` are the "
            "spec's named future variants and v1 implements none of them. Until one "
            "is a variant in the schema it is not a variant on the wire, and the "
            "refusal names the discriminant rather than guessing a shape.",
            "scenario": {
                "v": 1,
                "subsystem": "NE",
                "target_date": "2026-08-29",
                "assets": [
                    {
                        "asset_type": "ev",
                        "label": "Fleet",
                        "subsystem": "NE",
                        "max_power_mw": 10,
                    }
                ],
            },
            "expected_code": "ASSET_TYPE_UNKNOWN",
        },
    )

    # Twenty batteries with the longest label the schema admits. It is inside
    # the 20-asset cap and outside the 4096-byte one, which is the ordering that
    # matters: the blob cap binds first, before anything is parsed.
    oversized = {
        "v": 1,
        "subsystem": "NE",
        "target_date": "2026-08-29",
        "assets": [
            {**BATTERY, "label": f"{index:02d} " + "B" * 61} for index in range(20)
        ],
        "economic_assumptions": {"brl_per_mwh": 180},
    }
    oversized_blob = blob(canonical(oversized))
    assert len(oversized_blob) > 4096, len(oversized_blob)
    write(
        "refusals/05-a-blob-over-the-cap.json",
        {
            "name": "twenty assets with maximum-length labels",
            "description": "The encoded blob is over 4096 bytes. Measured on the "
            "base64url, not on the JSON, because the blob is what arrives in a query "
            "string from an unauthenticated caller and the cap's job is to bound what "
            "gets parsed at all.",
            "scenario": oversized,
            "blob": oversized_blob,
            "blob_length": len(oversized_blob),
            "expected_code": "SCENARIO_TOO_LARGE",
        },
    )
    write(
        "refusals/06-not-base64url.json",
        {
            "name": "a blob outside the alphabet",
            "description": "`+` and `/` are base64's alphabet, not base64url's. A "
            "link mangled by a mailer is a refusal, never a best-effort decode.",
            "blob": "eyJ2Ijox+/8=",
            "expected_code": "BAD_INPUT",
        },
    )
    write(
        "refusals/07-not-json.json",
        {
            "name": "valid base64url, and not JSON",
            "description": blob("not json at all") + " decodes cleanly to bytes and "
            "then to text, and is still not a scenario. The three failures are kept "
            "apart so a diagnosis says which one happened.",
            "blob": blob("not json at all"),
            "expected_code": "BAD_INPUT",
        },
    )


if __name__ == "__main__":
    main()
