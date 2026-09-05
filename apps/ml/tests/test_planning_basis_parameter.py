"""The planning basis is an internal parameter — buildable, and unreachable.

Flex-optimizer 09 is one seam and two properties that pull against each other,
and this file is the pair held together:

* **Buildable.** `forecaster.md`'s fold evaluation scores a second planning arm
  against `E[Y]` and publishes both arms' `recovered_floor_mwh`. The arm exists
  because the costs are not symmetric: the execution rule means a plan that is
  too ambitious is simply not used, while a plan that is blind in an hour cannot
  act in it at all — and `E[Y] > P50` exactly when `p < 0.5`, which is to say the
  expectation is non-zero in precisely the hours where the P50 plan goes blind.
  So the builder has to accept the envelope, and the two arms have to be
  comparable: one model, one simulator, one set of KPI definitions, and exactly
  one input that differs.
* **Unreachable.** The posture is decided and the user is never asked. No request
  body key, no query parameter and no scenario field can select the basis, and
  the public endpoint always answers ``"p50"``. Flex-optimizer 04 asserts it of
  the published contract and 08 removed the prototype's toggle from the screen;
  this file asserts it of the seam that ticket 09 opened.

The execution rule itself is `simulator.py`'s and is **imported** here, never
restated — ``test_one_simulator.py`` is the edge that keeps it that way, and the
arm is a second caller of one function rather than a fork of it.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

from fastapi.testclient import TestClient

from wattsteer_ml.app import app, profile_source
from wattsteer_ml.forecast_reads import PLANNING_PROFILE_SQL
from wattsteer_ml.optimizer import (
    PlanningEnvelope,
    PlanningProfile,
    build_plan,
    optimization_result,
    score_band,
    simulate,
)
from wattsteer_ml.optimizer import simulator as simulator_module
from wattsteer_ml.scenario import decode_scenario_body
from wattsteer_ml.scenario_validation import latest_target_date, validate_scenario

THRESHOLD_MW = 5.0
ORIGIN = datetime(2026, 8, 28, 12, 0, tzinfo=UTC)

#: IDEA.md §27's reference profile as the median envelope: quiet for eighteen
#: hours of the day, which is the shape the whole argument turns on.
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

#: `E[Y] = p·μ`, in the shape a hurdle forecaster produces. Above the median in
#: the hours whose occurrence is uncertain — where the median is zero and (C5)
#: forbids the P50 plan from acting at all — and below it where curtailment is
#: near-certain. The two arms are only interesting because of this difference.
EXPECTED: tuple[float, ...] = tuple(8.0 if value == 0.0 else value * 0.8 for value in P50)

#: The hours the median calls quiet. The arm's whole claim lives here.
BLIND_HOURS: tuple[int, ...] = tuple(
    hour for hour, value in enumerate(P50) if value == 0.0
)


def band(**overrides: Any) -> PlanningProfile:
    profile = PlanningProfile(
        forecast_origin=ORIGIN,
        vintage_fidelity="point_in_time",
        p10_mwh=P10,
        p50_mwh=P50,
        p90_mwh=P90,
        expected_mwh=EXPECTED,
        threshold_mw=THRESHOLD_MW,
    )
    return replace(profile, **overrides) if overrides else profile


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
            }
        ],
    }
    wire.update(overrides)
    return wire


def arm(basis: str) -> Any:
    """One arm, built the way `forecaster.md`'s fold evaluation would build it."""
    wire = scenario()
    validate_scenario(wire, datetime.now(tz=UTC))
    envelope = band().envelope("expected" if basis == "expected" else "p50")
    return build_plan(wire, band(), envelope)


# --- the seam ------------------------------------------------------------------


def test_the_builder_takes_the_envelope_and_the_plan_names_the_one_it_used() -> None:
    """Both arms come out of one builder, and each says which it is.

    `planning_basis` is read off the input the builder was handed rather than
    stamped on afterwards by whoever called it, so a plan cannot claim an
    envelope it was not built on.
    """
    shipped = arm("p50")
    measured = arm("expected")
    assert shipped.planning_basis == "p50"
    assert measured.planning_basis == "expected"
    assert shipped.offered_mwh == P50
    assert measured.offered_mwh == EXPECTED


def test_the_arms_differ_in_the_envelope_and_in_nothing_else() -> None:
    """The property that makes the comparison mean anything.

    Same fleet, same horizon, same weights, same model: if the two arms differ
    anywhere but in the envelope, a difference in their published numbers is
    attributable to the wrong thing.
    """
    shipped = arm("p50")
    measured = arm("expected")
    assert shipped.horizon == measured.horizon
    assert shipped.assets == measured.assets
    assert shipped.loads == measured.loads
    assert shipped.deg_penalty_rho == measured.deg_penalty_rho
    assert shipped.throughput_penalties == measured.throughput_penalties
    assert shipped.solver.backend == measured.solver.backend
    assert shipped.solver.variables == measured.solver.variables


def test_the_only_structural_difference_is_the_sign_split_the_envelope_decides() -> None:
    """The model does not branch on the *basis*; it branches on ``curt[t]``.

    (C2)/(C5) is a build-time branch on the parameter, and it was there before
    this ticket. An hour the median calls quiet gets (C5) alone; an hour with
    something offered gets (C2) and (C4). So the expectation arm carries exactly
    one extra constraint per blind hour — and that arithmetic *is* the reason the
    arm exists, showing up as a shape of the model rather than as a comment about
    it. Nothing else about the formulation moves: same variables, same fleet,
    same weights.
    """
    shipped = arm("p50")
    measured = arm("expected")
    difference = measured.solver.constraints - shipped.solver.constraints
    assert difference == len(BLIND_HOURS)


def test_the_expectation_is_positive_in_the_hours_the_median_calls_quiet() -> None:
    """Why the arm exists, as arithmetic rather than as a comment.

    ``E[Y] > P50`` wherever ``p < 0.5``, so the P50 plan has nothing to act on in
    those hours and the expectation arm does. The plan's shape there is decided
    by the classifier's operating region rather than by the magnitude model.
    """
    assert BLIND_HOURS
    for hour in BLIND_HOURS:
        assert P50[hour] == 0.0
        assert EXPECTED[hour] > 0.0
    assert sum(EXPECTED) > 0.0


def test_both_arms_score_through_the_one_simulator() -> None:
    """Ticket 02's function, imported, and no second rule anywhere near here.

    Both arms are executed against the same realisation by the same callable,
    and both ``recovered_floor_mwh`` come out of the same `ScoredBand`
    definition — which is what makes the two numbers `forecaster.md` publishes
    side by side comparable at all.
    """
    assert simulate is simulator_module.simulate
    floors = {}
    for basis in ("p50", "expected"):
        plan = arm(basis)
        scored = simulate(plan, P50, threshold_mw=THRESHOLD_MW)
        assert scored.recovered_mwh >= 0.0
        floors[basis] = score_band(
            plan,
            p10_mwh=P10,
            p50_mwh=P50,
            p90_mwh=P90,
            threshold_mw=THRESHOLD_MW,
        ).recovered_floor_mwh
    assert set(floors) == {"p50", "expected"}
    for value in floors.values():
        assert value >= 0.0


def test_the_same_scenario_on_the_same_envelope_builds_the_same_plan() -> None:
    """Determinism, so an arm difference is attributable to the envelope.

    Twice through the builder on one envelope has to give one schedule. Without
    it, "the arms differ by 4 MWh" would be a statement about branch-and-bound
    tie-breaking as much as about the forecast.
    """
    for basis in ("p50", "expected"):
        first = arm(basis)
        again = arm(basis)
        assert first.planning_basis == again.planning_basis
        assert first.hours == again.hours
        assert first.batteries == again.batteries
        assert first.load_dispatch == again.load_dispatch


# --- and unreachable -----------------------------------------------------------


def test_the_published_result_always_names_p50() -> None:
    """The public assembly has no envelope to pass on, so it passes none."""
    wire = scenario()
    validate_scenario(wire, datetime.now(tz=UTC))
    body = optimization_result(wire, decode_scenario_body(wire).hash, band())
    assert body["planning_basis"] == "p50"
    assert body["recovered_floor_mwh"] == body["scored"]["p10"]["recovered_mwh"]


def test_no_body_key_or_query_parameter_reaches_the_basis() -> None:
    """Belt and braces on the gateway's closed schema, at the route.

    The profile handed to the endpoint *does* carry `E[Y]`, so this is a real
    attempt rather than a request for something that is not in the room: the arm
    is one method call away and there is still no way to ask for it. The
    strongest form of "it changed nothing" is that the dispatch is identical.
    """
    app.dependency_overrides[profile_source] = lambda: lambda **_: band()
    try:
        with TestClient(app) as client:
            plain = client.post("/v1/optimize", json=scenario()).json()
            smuggled = client.post(
                "/v1/optimize?planning_basis=expected&basis=expected&quantile=expected",
                json=scenario(planning_basis="expected", basis="expected"),
            ).json()
    finally:
        app.dependency_overrides.clear()
    assert plain["planning_basis"] == "p50"
    assert smuggled["planning_basis"] == "p50"
    assert smuggled["dispatch"] == plain["dispatch"]
    assert smuggled["recovered_floor_mwh"] == plain["recovered_floor_mwh"]


def test_the_envelope_cannot_be_spelled_by_a_request() -> None:
    """The parameter is an object, which is the whole of why it stays internal.

    A ``basis="expected"`` keyword would have been assignable straight out of the
    scenario's ``dict[str, Any]``. A `PlanningEnvelope` has to be constructed, in
    Python, by a caller that imported the module — a JSON document cannot become
    one and neither can a query string.
    """
    envelope = band().envelope("expected")
    assert isinstance(envelope, PlanningEnvelope)
    assert not isinstance(envelope, str | bytes | int | float | dict | list)
    assert envelope.basis == "expected"
    assert band().envelope().basis == "p50"


def test_the_expectation_is_read_and_never_invented() -> None:
    """Forecaster 14 persists `E[Y]` per hour; this side reads that column.

    ``expected_mwh`` is selected on every planning read, beside the three
    quantiles and with no more choice about it than they have. An arm built from
    a *different* query than the P50 plan would differ from it in two things,
    and the comparison would stop meaning anything.
    """
    assert "hour.expected_mwh" in PLANNING_PROFILE_SQL
    for word in ("planning_basis", "quantile", "$4"):
        assert word not in PLANNING_PROFILE_SQL
