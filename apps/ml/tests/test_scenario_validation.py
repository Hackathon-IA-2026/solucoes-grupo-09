"""The validation table, against the shared vectors — refused, never corrected.

``packages/core/test/scenario-validation.test.ts`` reads the **same** directory
and asserts the **same** expected codes against the TypeScript implementation.
Neither side is asserted against the other, and both fail on a file they did not
enumerate — see ``packages/core/fixtures/scenario-validation/README.md``.

Two properties are under test here and only the first is obvious.

1. A nonsensical scenario is refused with the code the spec's table names, at
   the gateway *and* independently here, from the same bytes.
2. **The scenario is unchanged afterwards.** A validator that clamps an initial
   state of charge into its bounds passes every "is it a 422?" test ever
   written, because it never reaches the 422 — it returns a plan for a battery
   nobody described. Only an assertion about the input can see that, so every
   refusal below makes one.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from wattsteer_ml.constants import REFERENCE_FLEET
from wattsteer_ml.scenario import (
    ScenarioTransportError,
    decode_scenario_body,
    encode_scenario,
)
from wattsteer_ml.scenario_validation import (
    DATA_WINDOW_OPENS_ON,
    MAX_ASSETS,
    ScenarioValidationError,
    forecast_unavailable,
    latest_target_date,
    validate_scenario,
)

FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "core"
    / "fixtures"
    / "scenario-validation"
)

#: The spec's table, transcribed. Every code has a vector, and the suite fails
#: if a rule is added to the spec and never given one. ``FORECAST_UNAVAILABLE``
#: is deliberately absent: it is the one row that is not a fact about the
#: scenario, and answering it needs the forecast query ticket 07 owns.
TABLE = {
    "SCENARIO_VERSION_UNSUPPORTED",
    "SCENARIO_TOO_LARGE",
    "ASSET_TYPE_UNKNOWN",
    "SUBSYSTEM_MISMATCH",
    "FIELD_NOT_ON_VARIANT",
    "MAGNITUDE_OUT_OF_RANGE",
    "RTE_OUT_OF_RANGE",
    "EFFICIENCY_PAIR_INCOMPLETE",
    "SOC_BOUNDS_INVALID",
    "SOC_INITIAL_OUT_OF_BOUNDS",
    "POWER_LIMIT_INCONSISTENT",
    "SHIFT_EXCEEDS_CONNECTION",
    "SHIFT_EXCEEDS_BASELINE",
    "SHIFT_WINDOW_OUT_OF_RANGE",
    "RECOVERY_TIME_OUT_OF_RANGE",
    "AVAILABILITY_INVALID",
    "TARGET_DATE_OUT_OF_RANGE",
    "ECONOMIC_ASSUMPTION_OUT_OF_RANGE",
}


def _vectors(subdirectory: str) -> list[tuple[str, dict[str, Any]]]:
    directory = FIXTURES / subdirectory
    files = sorted(path for path in directory.iterdir() if path.suffix == ".json")
    return [(path.name, json.loads(path.read_text(encoding="utf-8"))) for path in files]


REFUSALS = _vectors("refusals")
ADMISSIONS = _vectors("admissions")


def _ids(vectors: list[tuple[str, dict[str, Any]]]) -> list[str]:
    return [name for name, _ in vectors]


def _now(vector: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(vector["now"].replace("Z", "+00:00"))


def test_every_vector_directory_is_populated() -> None:
    """A passing run has to mean something, so an empty directory fails."""
    assert REFUSALS
    assert ADMISSIONS


def test_no_vector_file_is_skipped() -> None:
    """The half that stops a vector added for TypeScript being ignored here."""
    consumed = {f"refusals/{name}" for name, _ in REFUSALS}
    consumed |= {f"admissions/{name}" for name, _ in ADMISSIONS}
    on_disk = {str(path.relative_to(FIXTURES)) for path in FIXTURES.rglob("*.json")}
    assert on_disk == consumed


def test_every_code_in_the_table_has_a_case() -> None:
    """The spec's table and the vector directory, compared as sets.

    A rule added to `docs/specs/flex-optimizer.md` with no vector fails here,
    and so does a vector claiming a code the table does not have.
    """
    assert {vector["expected_code"] for _, vector in REFUSALS} == TABLE


# --- the refusals ------------------------------------------------------------


@pytest.mark.parametrize(("name", "vector"), REFUSALS, ids=_ids(REFUSALS))
def test_a_scenario_that_is_not_one_is_refused(name: str, vector: dict[str, Any]) -> None:
    with pytest.raises(ScenarioValidationError) as raised:
        validate_scenario(vector["scenario"], _now(vector))
    assert raised.value.code == vector["expected_code"]
    if "expected_field" in vector:
        assert raised.value.field == vector["expected_field"]


@pytest.mark.parametrize(("name", "vector"), REFUSALS, ids=_ids(REFUSALS))
def test_a_refused_scenario_is_left_exactly_as_it_arrived(
    name: str, vector: dict[str, Any]
) -> None:
    """**The ticket, as an assertion.**

    Nothing is clamped, defaulted into place or rounded on the way to the
    refusal, so the object a caller handed in is the object they get back on the
    floor. A repair would be invisible to every other test in this file.
    """
    scenario = vector["scenario"]
    before = copy.deepcopy(scenario)
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario, _now(vector))
    assert scenario == before


@pytest.mark.parametrize(("name", "vector"), REFUSALS, ids=_ids(REFUSALS))
def test_the_same_blob_is_refused_when_posted_directly(
    name: str, vector: dict[str, Any]
) -> None:
    """The gateway is not in the path, and the answer is the same.

    ``docs/specs/flex-optimizer.md``: the ml service "trusts nothing it did not
    validate itself". This is that sentence as a test — the vector's scenario
    goes through *this* service's own decode and *this* service's own table, and
    reaches the same code the gateway reached from the same bytes.
    """
    with pytest.raises((ScenarioTransportError, ScenarioValidationError)) as raised:
        # Four of the codes are settled in the transport, because they make the
        # *bytes* unreadable rather than the scenario nonsensical — an unknown
        # `v` decides which grammar the bytes are in, and a battery carrying
        # `max_shift_mw` has no canonical form at all. Whichever half catches
        # it, the caller is told the same thing, and that is what is asserted:
        # the code, not which module produced it.
        decoded = decode_scenario_body(vector["scenario"])
        validate_scenario(json.loads(decoded.canonical), _now(vector))
    error = raised.value
    assert isinstance(error, ScenarioTransportError | ScenarioValidationError)
    assert error.code == vector["expected_code"]


# --- what must be admitted ---------------------------------------------------


@pytest.mark.parametrize(("name", "vector"), ADMISSIONS, ids=_ids(ADMISSIONS))
def test_a_scenario_describing_a_real_fleet_is_admitted(
    name: str, vector: dict[str, Any]
) -> None:
    validate_scenario(vector["scenario"], _now(vector))


def test_the_published_reference_fleet_is_a_scenario_this_build_will_plan() -> None:
    """Not a re-run of the vector: this is the constant itself.

    Floor coverage, the forecaster's ``Δ recovered_floor_mwh``, the featured-days
    list and the hot-swap guardrail are all measured against `REFERENCE_FLEET`,
    so it has to sit inside the rules rather than one rounding outside them. It
    sits at 71 % of the shift cap deliberately.
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
    }
    validate_scenario(scenario, datetime.fromisoformat("2026-08-28T12:00:00+00:00"))
    # And it is shareable: the fleet every published figure is measured against
    # has to fit in a URL, or the product cannot honour its own promise about one.
    assert encode_scenario(scenario)
    assert load.max_shift_mw / (load.daily_energy_mwh / 24) == pytest.approx(
        0.71, abs=0.01
    )


# --- the rules that are easier to state than to read out of a vector ---------

NOW = datetime.fromisoformat("2026-08-28T12:00:00+00:00")


def _battery(**over: Any) -> dict[str, Any]:
    asset: dict[str, Any] = {
        "asset_type": "battery",
        "label": "Battery",
        "subsystem": "NE",
        "max_power_mw": 100,
        "energy_capacity_mwh": 300,
        "round_trip_efficiency": 0.92,
        "initial_state_of_charge": 0.2,
    }
    asset.update(over)
    return asset


def _scenario(*assets: dict[str, Any], **over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "v": 1,
        "subsystem": "NE",
        "target_date": "2026-08-29",
        "assets": list(assets),
    }
    body.update(over)
    return body


def _code(wire: dict[str, Any], now: datetime = NOW) -> str | None:
    try:
        validate_scenario(wire, now)
    except ScenarioValidationError as error:
        return error.code
    return None


def test_an_initial_soc_below_its_floor_is_refused_not_raised_to_it() -> None:
    """The mirror of the vector, from the other side of the window.

    A clamp is symmetric and a rule has to be too: refusing only the high side
    would leave a battery starting below its floor silently topped up.
    """
    assert (
        _code(_scenario(_battery(initial_state_of_charge=0.01)))
        == "SOC_INITIAL_OUT_OF_BOUNDS"
    )
    assert _code(_scenario(_battery(initial_state_of_charge=0.05))) is None


def test_either_half_of_the_efficiency_pair_alone_is_refused() -> None:
    for half in ("charge_efficiency", "discharge_efficiency"):
        asset = _battery(**{half: 0.959})
        del asset["round_trip_efficiency"]
        assert _code(_scenario(asset)) == "EFFICIENCY_PAIR_INCOMPLETE"


def test_a_round_trip_beside_either_half_is_refused() -> None:
    assert (
        _code(_scenario(_battery(charge_efficiency=0.959, discharge_efficiency=0.959)))
        == "EFFICIENCY_PAIR_INCOMPLETE"
    )


def test_a_mixed_subsystem_scenario_is_refused_rather_than_summed() -> None:
    assert (
        _code(_scenario(_battery(), _battery(label="South", subsystem="S")))
        == "SUBSYSTEM_MISMATCH"
    )


def test_a_magnitude_is_refused_at_zero_as_well_as_above_the_cap() -> None:
    assert _code(_scenario(_battery(max_power_mw=0))) == "MAGNITUDE_OUT_OF_RANGE"
    assert _code(_scenario(_battery(energy_capacity_mwh=-1))) == "MAGNITUDE_OUT_OF_RANGE"
    assert _code(_scenario(_battery(max_power_mw=10_000))) is None


def test_a_numeric_string_is_not_a_number() -> None:
    """``float("100")`` would admit this and the plan would be right by accident."""
    assert _code(_scenario(_battery(max_power_mw="100"))) == "REQUEST_INVALID"


def test_the_target_dates_own_boundaries() -> None:
    def on(day: str, now: datetime = NOW) -> str | None:
        return _code(_scenario(_battery(), target_date=day), now)

    assert (
        on(
            DATA_WINDOW_OPENS_ON.isoformat(),
            datetime.fromisoformat("2024-04-01T12:00:00+00:00"),
        )
        is None
    )
    assert on("2024-03-31") == "TARGET_DATE_OUT_OF_RANGE"
    assert on(latest_target_date(NOW).isoformat()) is None
    assert on("2026-08-31") == "TARGET_DATE_OUT_OF_RANGE"
    # A pattern-shaped string that names no day is malformed, not out of range.
    assert on("2026-02-31") == "REQUEST_INVALID"


def test_tomorrow_is_a_brasilia_day_not_a_utc_one() -> None:
    """23:00 on the 28th in Brasília is already the 29th in UTC.

    A validator reading the UTC day would admit a date three hours a day that
    the forecaster has nothing for, and would then plan the wrong 24 hours.
    """
    late = datetime.fromisoformat("2026-08-29T02:00:00+00:00")
    assert latest_target_date(late).isoformat() == "2026-08-29"
    assert _code(_scenario(_battery(), target_date="2026-08-30"), late) == (
        "TARGET_DATE_OUT_OF_RANGE"
    )


def test_the_asset_cap_is_on_the_count_not_only_on_the_bytes() -> None:
    def many(count: int) -> dict[str, Any]:
        return _scenario(*[_battery(label=f"B{index}") for index in range(count)])

    assert _code(many(MAX_ASSETS)) is None
    assert _code(many(MAX_ASSETS + 1)) == "SCENARIO_TOO_LARGE"


def test_the_byte_cap_not_the_asset_cap_is_what_a_fleet_of_batteries_hits() -> None:
    """The two halves of ``SCENARIO_TOO_LARGE`` do not bite in the table's order.

    Nineteen minimal batteries already exceed the 4 096-byte blob cap, so the
    twenty-asset limit is a second bound on a request no transport can carry.
    They share a code on purpose - a caller who hand-edited a URL into either is
    told the same thing - and both are kept because the byte cap is a property
    of the encoding and the asset cap a property of the model.
    """

    def fleet(count: int) -> dict[str, Any]:
        return _scenario(*[_battery(label=f"B{index}") for index in range(count)])

    assert encode_scenario(fleet(18))
    for count in (19, 21):
        with pytest.raises(ScenarioTransportError) as raised:
            encode_scenario(fleet(count))
        assert raised.value.code == "SCENARIO_TOO_LARGE"
    # The table's own bound answers with the same code, one asset further out.
    assert _code(fleet(MAX_ASSETS)) is None
    assert _code(fleet(MAX_ASSETS + 1)) == "SCENARIO_TOO_LARGE"


# --- the code defined here and raised by ticket 07 ---------------------------


def test_forecast_unavailable_has_one_definition() -> None:
    """Defined here and raised nowhere in the module.

    It is the only row of the table that is not a fact about the scenario: the
    scenario is well formed and the fleet is real, and there is simply no
    forecast to plan against. ``packages/core/src/scenario-validation.ts``
    builds the identical details on the other side of the wire.
    """
    error = forecast_unavailable("NE", "2026-08-29", "2026-08-28T12:00:00Z")
    assert error.code == "FORECAST_UNAVAILABLE"
    assert error.details == {
        "subsystem": "NE",
        "target_date": "2026-08-29",
        "forecast_origin": "2026-08-28T12:00:00Z",
    }
    assert forecast_unavailable("S", "2026-08-29").details == {
        "subsystem": "S",
        "target_date": "2026-08-29",
    }
