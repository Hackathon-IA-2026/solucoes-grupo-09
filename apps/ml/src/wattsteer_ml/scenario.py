"""The canonical scenario transport, from the Python side.

`packages/core/src/scenario.ts` is the same three functions in TypeScript, and
neither module is generated from the other. What binds them is the shared golden
vector directory ``packages/core/fixtures/scenario-canonical/``:
:mod:`tests.test_scenario_canonical` asserts *this* module against it and
``packages/core/test/scenario-canonical.test.ts`` asserts the TypeScript side
against it, so a shared misunderstanding cannot cancel out.

**Why this module exists at all.** ``docs/specs/flex-optimizer.md`` makes the
sha256 of a scenario's canonical bytes do two jobs at once: it is the Redis
cache key ``opt:v1:<hash>:<origin>:<build>``, and it is the ``scenario_hash``
stamped on every answer as a reproducibility claim. The gateway that computes it
first is TypeScript; the service that has to agree about it is this one. Two
spellings of one scenario that hash differently are a cache that silently never
hits and a "reproduce this run" that cannot; two scenarios that hash alike are a
wrong plan under a right-looking receipt.

The gateway validates a scenario before this service ever sees it. This service
re-derives the bytes anyway, because ``docs/specs/flex-optimizer.md`` is explicit
that it "trusts nothing it did not validate itself" — and because a hash it did
not compute is a hash it cannot stand behind.

**The one function that is not obvious.** RFC 8785 §3.2.2.3 defines the number
form as ECMAScript's ``Number::toString``. Python's :func:`repr` is *also*
shortest-round-tripping, and is *not* that function: it writes ``100.0`` where
ECMAScript writes ``100``, ``1e-06`` where ECMAScript writes ``0.000001``, and
``1e+20`` where ECMAScript writes the twenty-one digits out. So
:func:`_ecmascript_number` implements the ECMAScript algorithm directly, and
``numbers.json`` in the vector directory is what holds it there.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any

#: The only ``v`` this build understands. An old link with any other fails loudly:
#: a schema change bumps it, which is the difference between a shareable URL and
#: a time bomb.
SCENARIO_VERSION = 1

#: ``SCENARIO_TOO_LARGE`` — the cap on the base64url blob, in bytes. On the
#: *encoded* form, because that is what arrives in a query string from an
#: unauthenticated caller and the cap's job is to bound what gets parsed at all.
MAX_SCENARIO_BLOB_BYTES = 4096

#: The query parameter a shared link carries the blob in.
SCENARIO_PARAM = "s"

#: ``asset_type`` — the discriminant of the `FlexibilityAsset` sum type, per
#: `docs/domain-model.md` §6.
ASSET_DISCRIMINANT = "asset_type"

#: The key set each variant admits, which is what ``additionalProperties: false``
#: on each branch of ``schema/flexibility-asset.schema.json`` means.
#:
#: Hand-transcribed rather than generated: this service has no build step and
#: ``packages/core/schema/`` is not copied into its image. What stops it drifting
#: is :func:`tests.test_scenario_schema.test_variant_fields_match_the_schema`,
#: which reads the schema files directly and fails on any difference — so adding
#: an `EV` variant is a failing test here rather than a silent acceptance.
VARIANT_FIELDS: dict[str, frozenset[str]] = {
    "battery": frozenset(
        {
            "asset_type",
            "label",
            "subsystem",
            "max_power_mw",
            "energy_capacity_mwh",
            "round_trip_efficiency",
            "charge_efficiency",
            "discharge_efficiency",
            "initial_state_of_charge",
            "min_state_of_charge",
            "max_state_of_charge",
            "max_charge_mw",
            "max_discharge_mw",
            "available_from",
            "available_to",
        }
    ),
    "shiftable_load": frozenset(
        {
            "asset_type",
            "label",
            "subsystem",
            "max_power_mw",
            "max_shift_mw",
            "shift_window_hours",
            "daily_energy_mwh",
            "recovery_time_hours",
            "available_from",
            "available_to",
        }
    ),
}


class ScenarioTransportError(ValueError):
    """A blob this build cannot read, refused with the code the spec names.

    ``code`` is a member of the closed enum in ``packages/core/src/errors.ts``
    and is what the transport layer turns into the one error envelope. It is
    carried rather than reconstructed from the message so that neither side of
    the wire has to parse prose to decide what happened.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


# --- the number rule ---------------------------------------------------------


def _digits_and_position(value: float) -> tuple[str, int]:
    """``(s, n)`` with ``value == 0.s × 10**n`` and ``s`` the shortest digits.

    Derived from :func:`repr`, which is shortest-round-tripping — the *digits*
    are the part of ``repr`` that is already right, and only their layout is
    what ECMAScript spells differently.
    """
    text = repr(value)
    mantissa, _, exponent_text = text.partition("e")
    exponent = int(exponent_text) if exponent_text else 0
    integer_part, _, fraction = mantissa.partition(".")
    combined = integer_part + fraction
    stripped = combined.lstrip("0")
    leading_zeros = len(combined) - len(stripped)
    position = len(integer_part) + exponent - leading_zeros
    return stripped.rstrip("0"), position


def _ecmascript_number(value: float) -> str:
    """ECMAScript's ``Number::toString``, which is RFC 8785's number rule.

    The five branches are the specification's own, keyed on ``n`` — where the
    decimal point falls relative to the significant digits. ``21`` and ``-6`` are
    the thresholds at which ECMAScript switches to exponential notation, and they
    are the whole reason this function is not :func:`repr`.
    """
    if math.isnan(value) or math.isinf(value):
        raise ScenarioTransportError(
            "SCENARIO_TOO_LARGE",
            f"{value} has no JSON form; a scenario carries finite numbers only",
        )
    if value == 0:
        # Covers -0.0: a signed zero is a distinction JSON cannot carry and a
        # hash must not invent.
        return "0"
    if value < 0:
        return "-" + _ecmascript_number(-value)

    digits, position = _digits_and_position(value)
    count = len(digits)
    if count <= position <= 21:
        return digits + "0" * (position - count)
    if 0 < position <= 21:
        return digits[:position] + "." + digits[position:]
    if -6 < position <= 0:
        return "0." + "0" * -position + digits
    exponent = position - 1
    sign = "+" if exponent > 0 else "-"
    mantissa = digits if count == 1 else digits[0] + "." + digits[1:]
    return f"{mantissa}e{sign}{abs(exponent)}"


def _canonical_number(value: float | int) -> str:
    """Every JSON number is an IEEE-754 double before it is serialised.

    A JSON integer parses to a Python ``int`` of arbitrary width and to a double
    in ECMAScript, so ``2**53 + 1`` is two different values in the two languages
    unless this conversion happens first. It rounds the same way ECMAScript's
    parser already did, which is what makes the two sides agree.
    """
    return _ecmascript_number(float(value))


# --- the canonical form ------------------------------------------------------


def _sort_key(key: str) -> tuple[int, ...]:
    """UTF-16 code-unit order — RFC 8785 §3.2.3, and what JavaScript sorts by.

    Python's own ``sorted`` is code-*point* order, which agrees for every key in
    the schema and disagrees above U+FFFF. Spelling it out costs one line and
    removes a class of difference nobody would find later.
    """
    return tuple(key.encode("utf-16-be"))


def canonical_json(value: Any) -> str:
    """JCS (RFC 8785) — the canonical serialisation of any JSON value."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        # Before the int branch: ``bool`` is a subclass of ``int`` in Python and
        # ``True`` would otherwise serialise as ``1``.
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _canonical_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        # Array order is data, never sorted: two assets in the other order are a
        # different scenario and must hash differently.
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        members = sorted(value.items(), key=lambda item: _sort_key(str(item[0])))
        return (
            "{"
            + ",".join(
                json.dumps(str(key), ensure_ascii=False) + ":" + canonical_json(member)
                for key, member in members
            )
            + "}"
        )
    raise ScenarioTransportError("BAD_INPUT", f"{type(value).__name__} has no JSON form")


# --- base64url ---------------------------------------------------------------


def to_base64url(payload: bytes) -> str:
    """Bytes → base64url, unpadded.

    Padding is omitted because ``=`` in a query string is one more thing to
    escape and carries no information the length does not.
    """
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def from_base64url(blob: str) -> bytes:
    """base64url → bytes. Padding is tolerated; the ``+/`` alphabet is not."""
    text = blob.rstrip("=")
    if len(text) % 4 == 1:
        raise ScenarioTransportError(
            "BAD_INPUT",
            "the scenario blob is not base64url: its length cannot decode to whole bytes",
        )
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError) as cause:
        raise ScenarioTransportError(
            "BAD_INPUT", f"the scenario blob is not base64url: {cause}"
        ) from cause


# --- the transport -----------------------------------------------------------


def _assert_within_cap(size: int) -> None:
    if size > MAX_SCENARIO_BLOB_BYTES:
        raise ScenarioTransportError(
            "SCENARIO_TOO_LARGE",
            f"the encoded scenario is {size} bytes; the cap is {MAX_SCENARIO_BLOB_BYTES}",
        )


def _assert_variant(asset: Any, index: int) -> None:
    """An asset object is exactly one variant, and carries no field off it.

    This is the one validation rule that lives in the transport rather than in
    the eighteen-rule table (flex-optimizer ticket 04): a battery carrying
    ``max_shift_mw`` has no canonical form, because there is no variant whose key
    set contains it. Everything else about whether a scenario makes *sense* is
    decided after it has been read.
    """
    if not isinstance(asset, dict):
        raise ScenarioTransportError(
            "ASSET_TYPE_UNKNOWN", f"assets[{index}] is not an object"
        )
    asset_type = asset.get(ASSET_DISCRIMINANT)
    allowed = VARIANT_FIELDS.get(asset_type) if isinstance(asset_type, str) else None
    if allowed is None:
        raise ScenarioTransportError(
            "ASSET_TYPE_UNKNOWN",
            f"assets[{index}].{ASSET_DISCRIMINANT} is {asset_type!r}",
        )
    for key in asset:
        if key not in allowed:
            raise ScenarioTransportError(
                "FIELD_NOT_ON_VARIANT",
                f"{key} is not a field of {asset_type}",
            )


def canonicalize_scenario(wire: Any) -> str:
    """The one function both transports end at.

    Everything downstream — the blob, the hash, the cache key — is derived from
    this string, which is why "both paths decode to the identical canonical
    bytes" is a fact about the call graph rather than a coincidence between two
    tests.
    """
    if not isinstance(wire, dict):
        raise ScenarioTransportError("BAD_INPUT", "a scenario is a JSON object")
    version = wire.get("v")
    if version != SCENARIO_VERSION or isinstance(version, bool):
        raise ScenarioTransportError(
            "SCENARIO_VERSION_UNSUPPORTED",
            f"v must be {SCENARIO_VERSION}; this link carries {version!r}",
        )
    assets = wire.get("assets")
    if isinstance(assets, list):
        for index, asset in enumerate(assets):
            _assert_variant(asset, index)
    return canonical_json(wire)


def canonical_scenario_bytes(wire: Any) -> bytes:
    """The canonical UTF-8 bytes of a scenario in the wire's ``snake_case``."""
    return canonicalize_scenario(wire).encode("utf-8")


def hash_canonical_bytes(payload: bytes) -> str:
    """``sha256:<64 hex>`` — the ``ScenarioHash`` stamped on every answer.

    Takes bytes rather than a scenario so that the hash and the cache key are
    provably over the bytes the answer was computed from, rather than over a
    second derivation of them.
    """
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def scenario_hash(wire: Any) -> str:
    """``sha256:<64 hex>`` for a scenario in the wire's ``snake_case``."""
    return hash_canonical_bytes(canonical_scenario_bytes(wire))


def encode_scenario(wire: Any) -> str:
    """A scenario → the ``?s=`` blob. Refuses over :data:`MAX_SCENARIO_BLOB_BYTES`."""
    blob = to_base64url(canonical_scenario_bytes(wire))
    _assert_within_cap(len(blob))
    return blob


@dataclass(frozen=True)
class DecodedScenario:
    """A decoded scenario, with the bytes it was decoded from."""

    #: The wire object, ``snake_case``, as the validator and the model read it.
    scenario: dict[str, Any]
    #: The canonical JSON text. Byte-identical from either transport.
    canonical: str
    #: The canonical UTF-8 bytes.
    payload: bytes
    #: ``sha256:<64 hex>`` over :attr:`payload`.
    hash: str


def _finish(wire: Any) -> DecodedScenario:
    canonical = canonicalize_scenario(wire)
    payload = canonical.encode("utf-8")
    return DecodedScenario(
        scenario=wire,
        canonical=canonical,
        payload=payload,
        hash=hash_canonical_bytes(payload),
    )


def _parse(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError as cause:
        raise ScenarioTransportError(
            "BAD_INPUT", f"the scenario is not JSON: {cause}"
        ) from cause


def decode_scenario_param(blob: str) -> DecodedScenario:
    """``GET /v1/optimize?s=<blob>`` — the deep-link path.

    The cap is checked against the blob *before* it is decoded, so an oversized
    query string is refused without allocating a buffer or running a parser over
    attacker-controlled bytes.
    """
    _assert_within_cap(len(blob))
    payload = from_base64url(blob)
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as cause:
        raise ScenarioTransportError(
            "BAD_INPUT", "the scenario blob does not decode to UTF-8"
        ) from cause
    return _finish(_parse(text))


def decode_scenario_body(body: str | bytes | dict[str, Any]) -> DecodedScenario:
    """``POST /v1/optimize`` — the body path.

    Accepts the raw body or an already-parsed object, because a route is handed
    one and a test the other, and the two must not take different code paths to
    the canonical bytes.
    """
    if isinstance(body, bytes):
        wire = _parse(body.decode("utf-8"))
    elif isinstance(body, str):
        wire = _parse(body)
    else:
        wire = body
    decoded = _finish(wire)
    # A body that cannot be shared as a link is a scenario the product cannot
    # honour its own URL promise for. Measured after canonicalisation, so the
    # size is the one a share button would produce.
    _assert_within_cap(len(to_base64url(decoded.payload)))
    return decoded
