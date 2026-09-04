"""The posture, asserted on the result: plan on P50, promise P10, never ask.

`docs/specs/flex-optimizer.md` §"The uncertainty posture — decided" is three
sentences and this file is all three. The mechanism that makes them coherent is
ticket 02's execution rule — an asset charges the scheduled amount or the amount
actually being curtailed, whichever is smaller — which
``test_optimizer_simulator.py`` owns and which is imported here rather than
restated: a plan built on P50 and executed against a smaller day absorbs less,
reports less, and imports nothing.

What is left for *this* file is what the posture looks like once it has become
a published contract:

* one plan, three scorings, and the plan built against P50;
* ``recovered_floor_mwh`` and ``scored.p10.recovered_mwh`` being one number
  rather than two that agree — asserted as a property over random bands and
  fleets, because "always" is the word the ticket used;
* the basis and the execution rule travelling as **data**, so a screen that says
  "the assets absorb what is actually curtailed, never more" reads it rather
  than repeats it;
* R$ entering once, after the solve, as a labelled multiplier — change it and
  the money moves and nothing else does;
* and no field, parameter or body key anywhere that could select a quantile.

**A note the ticket asked for rather than inherited.** Ticket 21 is open: the
conformal *upper* correction barely reaches the served band at low ``p``. It
does not touch this number. The floor is simulated against **P10**, which
``δ_lo`` reaches in full at every ``p``, so ``recovered_floor_mwh`` — the one
figure the product quotes in prose — is the sound half of that band. The caveat
belongs to P90, which is drawn and never quoted.
"""

from __future__ import annotations

import inspect
import json
import random
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from wattsteer_ml import app as app_module
from wattsteer_ml.app import app, profile_source
from wattsteer_ml.constants import BRL_PER_MWH
from wattsteer_ml.database import Database
from wattsteer_ml.optimizer import PlanningProfile, no_forecast_yet, optimization_result
from wattsteer_ml.optimizer import result as result_module
from wattsteer_ml.optimizer import simulator as simulator_module
from wattsteer_ml.scenario import decode_scenario_body
from wattsteer_ml.scenario_validation import latest_target_date, validate_scenario

REPO = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO / "packages" / "core" / "schema"
BASE = "https://wattsteer.com/schema/"
HOURS = 24
THRESHOLD_MW = 5.0

#: IDEA.md §27's reference profile, as the P50 envelope. A test fixture, and it
#: stays one: the resolver that reads a real band is `forecast_reads.py`.
P50: tuple[float, ...] = (
    *(0.0,) * 10,
    20.0,
    70.0,
    110.0,
    90.0,
    30.0,
    10.0,
    *(0.0,) * 8,
)
P10: tuple[float, ...] = tuple(value * 0.4 for value in P50)
P90: tuple[float, ...] = tuple(value * 1.5 for value in P50)

ORIGIN = datetime(2026, 8, 28, 12, 0, tzinfo=UTC)


def band(
    p10: tuple[float, ...] = P10,
    p50: tuple[float, ...] = P50,
    p90: tuple[float, ...] = P90,
) -> PlanningProfile:
    return PlanningProfile(
        forecast_origin=ORIGIN,
        vintage_fidelity="point_in_time",
        p10_mwh=p10,
        p50_mwh=p50,
        p90_mwh=p90,
        threshold_mw=THRESHOLD_MW,
    )


def scenario(**overrides: Any) -> dict[str, Any]:
    """A scenario the refusal table admits, on a date it will still admit tomorrow."""
    wire: dict[str, Any] = {
        "v": 1,
        "subsystem": "NE",
        "target_date": latest_target_date(datetime.now(tz=UTC)).isoformat(),
        "assets": [
            {
                "asset_type": "battery",
                "label": "Battery",
                "subsystem": "NE",
                "max_power_mw": 100,
                "energy_capacity_mwh": 300,
                "round_trip_efficiency": 0.92,
                "initial_state_of_charge": 0.2,
            },
            {
                "asset_type": "shiftable_load",
                "label": "Flexible load",
                "subsystem": "NE",
                "max_power_mw": 70,
                "max_shift_mw": 50,
                "shift_window_hours": 3,
                "daily_energy_mwh": 1700,
            },
        ],
        "economic_assumptions": {"brl_per_mwh": 180},
    }
    wire.update(overrides)
    return wire


def solved(wire: dict[str, Any] | None = None, **band_kwargs: Any) -> dict[str, Any]:
    """One published `OptimizationResult`, with no socket in the way."""
    body = wire if wire is not None else scenario()
    validate_scenario(body, datetime.now(tz=UTC))
    return optimization_result(body, decode_scenario_body(body).hash, band(**band_kwargs))


def _registry() -> Registry[Any]:
    registry: Registry[Any] = Registry()
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        registry = registry.with_resource(
            BASE + path.name,
            Resource.from_contents(json.loads(path.read_text(encoding="utf-8"))),
        )
    return registry


RESULT_VALIDATOR = Draft202012Validator(
    json.loads(
        (SCHEMA_DIR / "optimization-result.schema.json").read_text(encoding="utf-8")
    ),
    registry=_registry(),
)

SCENARIO_SCHEMA = json.loads(
    (SCHEMA_DIR / "scenario.schema.json").read_text(encoding="utf-8")
)


# --- one plan, three scorings --------------------------------------------------


def test_one_milp_is_built_and_it_is_built_against_p50(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The three envelopes are used for scoring, not planning.

    Asserted on the *argument* the solver was handed rather than on the answer:
    "it was built on P50" is a fact about one call, and a result that happened to
    look right would prove nothing about which envelope produced it.
    """
    seen: list[tuple[float, ...]] = []
    real = result_module.solve  # type: ignore[attr-defined]

    def recording(*args: Any, **kwargs: Any) -> Any:
        seen.append(tuple(kwargs["offered_mwh"]))
        return real(*args, **kwargs)

    monkeypatch.setattr(result_module, "solve", recording)
    solved()
    assert seen == [P50]


def test_the_plan_is_executed_three_times_by_the_one_simulator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Three passes of the same function, over the three envelopes, in band order."""
    seen: list[tuple[float, ...]] = []
    real = simulator_module.simulate

    def recording(plan: Any, realisation: Any, **kwargs: Any) -> Any:
        seen.append(tuple(realisation))
        return real(plan, realisation, **kwargs)

    monkeypatch.setattr(simulator_module, "simulate", recording)
    solved()
    assert seen == [P10, P50, P90]


def test_the_result_carries_all_three_realisations() -> None:
    body = solved()
    RESULT_VALIDATOR.validate(body)
    assert set(body["scored"]) == {"p10", "p50", "p90"}
    for realisation in body["scored"].values():
        assert set(realisation) == {
            "baseline_mwh",
            "remaining_mwh",
            "recovered_mwh",
            "avoidability",
        }


# --- the promise ---------------------------------------------------------------


def test_the_floor_is_the_p10_recovery_and_the_headline_is_the_p50_one() -> None:
    """Two identities the contract states, read rather than recomputed.

    `avoided_energy_mwh` and `scored.p50.recovered_mwh` are one quantity with
    one name — the domain-model scalars at the top level are evaluated on the
    planning envelope — and `recovered_floor_mwh` is `scored.p10.recovered_mwh`,
    defined once on `ScoredBand` so the floor and the P10 column cannot drift.
    """
    body = solved()
    assert body["recovered_floor_mwh"] == body["scored"]["p10"]["recovered_mwh"]
    assert body["avoided_energy_mwh"] == body["scored"]["p50"]["recovered_mwh"]
    assert body["baseline_curtailment_mwh"] == body["scored"]["p50"]["baseline_mwh"]
    assert body["optimized_curtailment_mwh"] == body["scored"]["p50"]["remaining_mwh"]
    assert body["avoidability"] == body["scored"]["p50"]["avoidability"]


def _random_band(rng: random.Random) -> dict[str, tuple[float, ...]]:
    """A monotone hour-wise band, sometimes empty, sometimes flat, usually spiky."""
    shape = rng.choice(("empty", "flat", "spiky"))
    if shape == "empty":
        p50 = (0.0,) * HOURS
    elif shape == "flat":
        p50 = (rng.uniform(0.0, 400.0),) * HOURS
    else:
        p50 = tuple(
            rng.uniform(0.0, 300.0) if rng.random() < 0.4 else 0.0 for _ in range(HOURS)
        )
    return {
        "p10": tuple(value * rng.uniform(0.0, 1.0) for value in p50),
        "p50": p50,
        "p90": tuple(value * rng.uniform(1.0, 2.0) for value in p50),
    }


@pytest.mark.parametrize("seed", range(12))
def test_the_floor_equals_the_p10_recovery_for_every_band_and_fleet(seed: int) -> None:
    """ "Always", asserted over random bands rather than over one fixture.

    Random because the failure worth guarding against is a second definition of
    the floor appearing somewhere — a `max(0, …)`, a rounding, a "the floor is
    the smallest of the three" — that a single hand-picked band would not
    separate from the real one. On an empty band all three agree at zero, which
    is exactly the case a duplicate definition survives.
    """
    rng = random.Random(seed)  # noqa: S311 — a fixture generator, not a secret
    wire = scenario()
    battery = wire["assets"][0]
    battery["max_power_mw"] = rng.uniform(1.0, 500.0)
    battery["energy_capacity_mwh"] = rng.uniform(1.0, 2000.0)
    battery["round_trip_efficiency"] = rng.uniform(0.5, 0.999)
    battery["initial_state_of_charge"] = rng.uniform(0.05, 0.95)
    body = solved(wire, **_random_band(rng))
    assert body["recovered_floor_mwh"] == body["scored"]["p10"]["recovered_mwh"]


def test_a_null_avoidability_at_p10_may_sit_beside_a_real_one_at_p50() -> None:
    """Legitimate, and the contract permits it.

    Avoidability is `None` when the realisation holds no `CurtailmentHour` at
    the grain in force — `None` and never `0`, because zero reads as "nothing
    could be avoided" rather than "there was nothing to avoid". On the low edge
    of a band there may genuinely be nothing to avoid while the median day has
    plenty, and that is a sentence the schema has to be able to carry.
    """
    quiet = (1.0,) * HOURS  # every hour below the 5 MW grain
    body = solved(p10=quiet)
    RESULT_VALIDATOR.validate(body)
    assert body["scored"]["p10"]["avoidability"] is None
    assert isinstance(body["scored"]["p50"]["avoidability"], float)
    assert body["scored"]["p10"]["baseline_mwh"] > 0.0


# --- the posture as data -------------------------------------------------------


def test_the_basis_and_the_execution_rule_are_data_and_not_documentation() -> None:
    """A screen reads them off the result rather than restating them in a string."""
    body = solved()
    assert body["planning_basis"] == "p50"
    assert body["execution_rule"] == "follow_curtailment"


def test_the_vintage_travels_on_every_result() -> None:
    """`forecast_origin` and `VintageFidelity`, per the spec's point 5.

    A number on a screen is traceable to a run or it is not traceable at all —
    and the gateway keys its cache on the resolved origin, so a superseding 12Z
    run cannot be served an 00Z plan.
    """
    body = solved()
    assert body["forecast_origin"] == "2026-08-28T12:00:00Z"
    assert body["vintage_fidelity"] == "point_in_time"
    assert body["threshold_mw"] == THRESHOLD_MW


# --- R$ enters once, after the solve -------------------------------------------


def test_changing_the_price_changes_the_money_and_nothing_else() -> None:
    """The recommendation is visibly not a function of a price somebody made up.

    Asserted by differencing the whole response rather than by checking two
    fields: a price that reached the objective would move the dispatch, and a
    test naming the fields it expects to change would not notice.
    """
    cheap = solved(scenario(economic_assumptions={"brl_per_mwh": 90}))
    dear = solved(scenario(economic_assumptions={"brl_per_mwh": 1800}))
    for body in (cheap, dear):
        body.pop("solver")  # wall time is not a function of anything asserted here
        body.pop("scenario_hash")  # the assumption is inside the canonical bytes
    assert cheap["economic_scenario"] == {
        "brl_per_mwh": 90,
        "brl": pytest.approx(cheap["avoided_energy_mwh"] * 90),
    }
    assert dear["economic_scenario"] == {
        "brl_per_mwh": 1800,
        "brl": pytest.approx(dear["avoided_energy_mwh"] * 1800),
    }
    cheap.pop("economic_scenario")
    dear.pop("economic_scenario")
    assert cheap == dear


def test_the_price_is_written_down_in_one_place_and_defaulted_from_it() -> None:
    """A scenario that states no price gets the one constant, not a second one."""
    wire = scenario()
    wire.pop("economic_assumptions")
    body = solved(wire)
    assert body["economic_scenario"]["brl_per_mwh"] == float(BRL_PER_MWH)


# --- nothing can select the quantile -------------------------------------------


def test_the_scenario_contract_has_no_key_that_could_select_a_quantile() -> None:
    """The published body schema, read rather than paraphrased.

    `additionalProperties: false` is what makes this an assertion about every
    possible body and not just about the five keys that exist today.
    """
    assert SCENARIO_SCHEMA["additionalProperties"] is False
    keys = set(SCENARIO_SCHEMA["properties"])
    assert keys == {
        "v",
        "subsystem",
        "target_date",
        "forecast_origin",
        "assets",
        "economic_assumptions",
    }
    text = json.dumps(SCENARIO_SCHEMA).lower()
    for word in ("quantile", "planning_basis", "p10", "p50", "p90", "percentile"):
        assert word not in text


def test_nothing_in_the_solve_path_takes_a_quantile_argument() -> None:
    """The basis is a property of the product, not a parameter of a call.

    Ticket 09 makes it an *internal* parameter for the `E[Y]` measurement arm;
    until then there is no argument to pass and therefore no caller who could.
    """
    for function in (optimization_result, result_module.build_plan):
        names = set(inspect.signature(function).parameters)
        for word in ("quantile", "basis", "planning_basis", "envelope"):
            assert word not in names


def test_a_body_key_that_asks_for_p10_changes_nothing_about_the_plan() -> None:
    """Belt and braces on the gateway's `additionalProperties: false`.

    This service re-validates what it was sent and trusts nothing it did not
    validate itself. A key the contract does not admit reaching it anyway must
    not be able to reach the *basis*, and the strongest way to say so is that the
    plan is identical to the one without it.
    """
    plain = solved()
    smuggled = solved(scenario(planning_basis="p10", quantile="p10"))
    assert smuggled["planning_basis"] == "p50"
    assert smuggled["dispatch"] == plain["dispatch"]
    assert smuggled["recovered_floor_mwh"] == plain["recovered_floor_mwh"]


def test_no_query_parameter_on_the_route_can_reach_the_basis() -> None:
    """The endpoint takes a body and a resolver, and nothing else.

    Asserted on the signature FastAPI builds the OpenAPI document from, so a
    `?basis=p10` added in a hurry is a failing test rather than a new feature.
    """
    parameters = app.openapi()["paths"]["/v1/optimize"]["post"].get("parameters", [])
    assert parameters == []


# --- and the 404 that is now a real path ---------------------------------------


def test_an_instance_with_no_database_still_refuses_rather_than_inventing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The refusal table's one non-422 row, and the resolver behind it.

    With nothing to read there is no forecast, and saying so is the only answer
    that is not invented — the alternative, a fixture band served as though it
    were a forecast, is the thing this project refuses everywhere.
    """
    monkeypatch.setattr(app_module, "database", None)
    assert app_module.profile_source() is no_forecast_yet

    app.dependency_overrides[profile_source] = app_module.profile_source
    try:
        response = TestClient(app).post("/v1/optimize", json=scenario())
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "FORECAST_UNAVAILABLE"


def test_a_configured_database_is_what_makes_the_404_stop_being_the_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """flex-optimizer 07, in one line: a database means a band can be read.

    `served_profile_source` is the resolver then in force, and it is the only
    thing between a published `curtailment_forecast_hour` row and a plan.
    """
    monkeypatch.setattr(app_module, "database", Database("postgres://unused"))
    resolver = app_module.profile_source()
    assert resolver is not no_forecast_yet
    assert getattr(resolver, "__qualname__", "").startswith("served_profile_source")


def test_the_endpoint_plans_against_the_band_the_resolver_returns() -> None:
    """End to end, with the resolver injected where `forecast_reads` will sit."""
    app.dependency_overrides[profile_source] = lambda: lambda **_: band()
    try:
        body = TestClient(app).post("/v1/optimize", json=scenario()).json()
    finally:
        app.dependency_overrides.clear()
    RESULT_VALIDATOR.validate(body)
    assert body["planning_basis"] == "p50"
    assert body["recovered_floor_mwh"] == body["scored"]["p10"]["recovered_mwh"]
    assert isinstance(date.fromisoformat(scenario()["target_date"]), date)
