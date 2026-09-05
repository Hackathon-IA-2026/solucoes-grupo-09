"""One replay, end to end — and every way it could have flattered itself.

`docs/specs/replay.md`, "The arithmetic — exactly", is what this file asserts.
The spec's own note on what makes a good test here is the shape of the file:

> Every defect in a replay produces a *better* number, so the tests assert the
> things that would have to be true for the number to be honest — provenance,
> direction of error, and the identity of the code being run — rather than that
> a function returns a float.

So the sections are: the worked example, reproduced number for number; the two
directions of forecast error, which are not symmetric and are the ticket's real
content; perfect foresight, which is a labelled upper bound and never a recovery
claim; the observed-only view a pre-F1 day gets, whose content is as much what
is *absent* from it as what is on it; the postures a replay is *structurally*
unable to take; and the identity of the code — that the scoring path calls the
optimizer's `simulate` and that no model is loaded anywhere in the request
path.

**Why ``η`` is not 1 here.** The spec's worked table sets ``ηc = ηd = 1`` "only
so the table can be checked by eye", and scenario validation refuses an
efficiency of 1 (``MIN_EFFICIENCY <= value < 1``). It does not matter: absorbed
energy is ``Δ[t]``, the net increase in flexible *demand*, metered at the asset
boundary before any conversion loss, so for an energy-unconstrained battery the
whole table is unchanged by the efficiency. The fixture asserts the battery is
genuinely energy-unconstrained rather than assuming it.
"""

from __future__ import annotations

import ast
import inspect
import json
import random
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator, ValidationError
from referencing import Registry, Resource

from wattsteer_ml.constants import MAX_GAP_HOURS
from wattsteer_ml.evaluation import FOLD_CALENDAR_RULES
from wattsteer_ml.evaluation.holdout import HoldoutLeakError
from wattsteer_ml.lanes import Lane
from wattsteer_ml.mixture import QuantileBand
from wattsteer_ml.optimizer import (
    TOLERANCE_MWH,
    DispatchPlan,
    PlanningProfile,
    build_plan,
    score_band,
    simulate,
)
from wattsteer_ml.publication import (
    BACKFILLED_HOLDOUT_ORIGIN_KIND,
    PRODUCER,
    SERVED_ORIGIN_KIND,
)
from wattsteer_ml.replay import result as result_module
from wattsteer_ml.replay import scoring as scoring_module
from wattsteer_ml.replay.calendar import (
    HOURS_PER_DAY,
    DayEvidence,
    HeldOutBy,
    ReplayDay,
    ReplayRefused,
    resolve_day,
)
from wattsteer_ml.replay.cards import ArtifactWindows
from wattsteer_ml.replay.result import (
    ReplayEpisode,
    observed_only_result,
    replay_result,
)
from wattsteer_ml.replay.scoring import (
    ForecastHour,
    ObservedDay,
    ObservedOnlyView,
    PerfectForesight,
    PinnedForecast,
    PinnedOrigin,
    ReplayPostureError,
    ReplayScores,
    score_observed_only,
    score_replay,
)
from wattsteer_ml.scenario import decode_scenario_body
from wattsteer_ml.scenario_validation import validate_scenario

REPO = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO / "packages" / "core" / "schema"
BASE = "https://wattsteer.com/schema/"

SUBSYSTEM = "NE"
THRESHOLD_MW = 5.0
LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
#: A day inside F3's test period, which the F3 artifact held out.
HELD_OUT_DAY = date(2025, 11, 12)
#: ``gate_at(HELD_OUT_DAY, gate_late)`` — D−1 19:00 BRT, the instant that
#: forecast would have been published.
GATE = datetime(2025, 11, 11, 22, 0, tzinfo=UTC)
NOW = datetime(2026, 9, 4, 12, 0, tzinfo=UTC)

F3 = ArtifactWindows(
    artifact_id="2025-10-01T03:10:00Z",
    fold_id="F3",
    lane=LANE.directory_name,
    train_start=date(2024, 4, 1),
    train_end=date(2025, 9, 30),
    calibration_start=date(2025, 7, 3),
    calibration_end=date(2025, 9, 30),
)

#: The artifact on serving duty. It has seen `HELD_OUT_DAY`, which is the whole
#: point: a replay resolving it would be an in-sample fit.
PROMOTED = ArtifactWindows(
    artifact_id="2026-09-01T03:10:00Z",
    fold_id="F6",
    lane=LANE.directory_name,
    train_start=date(2024, 4, 1),
    train_end=date(2026, 6, 30),
    calibration_start=date(2026, 4, 2),
    calibration_end=date(2026, 6, 30),
)

#: The worked example's three hours, placed inside a 24-hour civil day. The
#: other twenty-one hours are zero on every realisation, which is what a real
#: day looks like either side of an episode.
WORKED_HOURS = (10, 11, 12)
WORKED_P50 = (40.0, 100.0, 60.0)
WORKED_P10 = (0.0, 60.0, 0.0)
WORKED_OBSERVED = (20.0, 160.0, 60.0)


def day_profile(
    values: tuple[float, ...], at: tuple[int, ...] = WORKED_HOURS
) -> tuple[float, ...]:
    """A 24-hour profile carrying ``values`` at ``at`` and zero everywhere else."""
    hours = [0.0] * HOURS_PER_DAY
    for hour, value in zip(at, values, strict=True):
        hours[hour] = value
    return tuple(hours)


def pinned(
    *,
    p10: tuple[float, ...],
    p50: tuple[float, ...],
    p90: tuple[float, ...] | None = None,
    threshold_mw: float = THRESHOLD_MW,
    origin_kind: str = BACKFILLED_HOLDOUT_ORIGIN_KIND,
    run_label: str = F3.artifact_id,
    published_at: datetime = GATE,
    target_date: date = HELD_OUT_DAY,
) -> PinnedForecast:
    """The pinned rows, as replay 01 persisted them. A lookup, never a call."""
    upper = tuple(value * 1.5 for value in p50) if p90 is None else p90
    hours = tuple(
        ForecastHour(
            constrained_off_mwh=QuantileBand(p10=low, p50=mid, p90=high),
            expected_mwh=mid,
            occurrence_probability=1.0 if mid > 0 else 0.1,
        )
        for low, mid, high in zip(p10, p50, upper, strict=True)
    )
    return PinnedForecast(
        subsystem=SUBSYSTEM,
        target_date=target_date,
        threshold_mw=threshold_mw,
        origin=PinnedOrigin(
            producer=PRODUCER,
            run_label=run_label,
            published_at=published_at,
            origin_kind=origin_kind,
            gate_profile=LANE.gate_profile,
        ),
        hours=hours,
        # From the path ensemble, and deliberately *not* the sum of the band
        # above: a joint day total is narrower than a componentwise sum, which
        # is why the contract carries it as its own figure.
        day_total=QuantileBand(p10=sum(p10) * 0.8, p50=sum(p50), p90=sum(upper) * 0.9),
        peak_power=QuantileBand(p10=max(p10), p50=max(p50), p90=max(upper)),
        day_occurrence_probability=0.9,
    )


def observed_day(
    hours: tuple[float, ...], target_date: date = HELD_OUT_DAY
) -> ObservedDay:
    return ObservedDay(subsystem=SUBSYSTEM, target_date=target_date, hours=hours)


def replayable_day(
    *,
    windows: ArtifactWindows = F3,
    origin_kind: str = BACKFILLED_HOLDOUT_ORIGIN_KIND,
) -> ReplayDay:
    """A `ReplayDay` from the calendar's own predicate, never hand-built."""
    return resolve_day(
        DayEvidence(
            target_date=HELD_OUT_DAY,
            origin_kind=origin_kind,
            artifact_id=windows.artifact_id,
            observed_hours=HOURS_PER_DAY,
            candidate_lanes=(LANE.directory_name,),
        ),
        subsystem=SUBSYSTEM,
        lane=LANE.directory_name,
        rules=FOLD_CALENDAR_RULES,
        latest=date(2026, 9, 3),
        windows=windows,
        sources=(),
    )


def scenario(
    *,
    max_power_mw: float = 80,
    energy_capacity_mwh: float = 400,
    target_date: date = HELD_OUT_DAY,
) -> dict[str, Any]:
    """One battery, energy-unconstrained unless a test says otherwise."""
    return {
        "v": 1,
        "subsystem": SUBSYSTEM,
        "target_date": target_date.isoformat(),
        "assets": [
            {
                "asset_type": "battery",
                "label": "Battery",
                "subsystem": SUBSYSTEM,
                "max_power_mw": max_power_mw,
                "energy_capacity_mwh": energy_capacity_mwh,
                # The spec's table sets η = 1; validation refuses it, and the
                # absorbed column does not move — see the module docstring.
                "round_trip_efficiency": 0.99,
                "min_state_of_charge": 0,
                "max_state_of_charge": 1,
                "initial_state_of_charge": 0,
            }
        ],
        "economic_assumptions": {"brl_per_mwh": 180},
    }


def replay(
    *,
    observed: tuple[float, ...],
    p50: tuple[float, ...] = day_profile(WORKED_P50),
    p10: tuple[float, ...] = day_profile(WORKED_P10),
    p90: tuple[float, ...] | None = None,
    wire: dict[str, Any] | None = None,
    threshold_mw: float = THRESHOLD_MW,
) -> ReplayScores:
    return score_replay(
        wire if wire is not None else scenario(),
        day=replayable_day(),
        windows=F3,
        forecast=pinned(p10=p10, p50=p50, p90=p90, threshold_mw=threshold_mw),
        observed=observed_day(observed),
    )


# --- the worked example, number for number ------------------------------------


def test_the_specs_worked_example_reproduces_exactly() -> None:
    """160 / 240 = 66.7 %, floor 60, floor met — with 100 MWh of margin.

    t₁ was over-forecast, so 20 MWh of scheduled charge simply did not happen;
    t₂ was under-forecast, so 80 MWh of real curtailment sat there and was
    correctly left alone. Recovered fell in absolute terms too (160 < 180) even
    though one hour had spare energy, because the plan is a schedule and not a
    controller.
    """
    scores = replay(observed=day_profile(WORKED_OBSERVED))

    assert scores.observed_scoring.baseline_mwh == pytest.approx(240.0)
    assert scores.observed_scoring.recovered_mwh == pytest.approx(160.0)
    assert scores.observed_scoring.remaining_mwh == pytest.approx(80.0)
    assert scores.observed_scoring.avoidability == pytest.approx(160.0 / 240.0)

    # On its own planning basis the plan absorbs 180 of 200 → 90 %.
    assert scores.band.p50.recovered_mwh == pytest.approx(180.0)
    assert scores.band.p50.avoidability == pytest.approx(0.9)

    # The promise made at D−1, and the day that cleared it.
    assert scores.recovered_floor_mwh == pytest.approx(60.0)
    assert scores.floor_met is True
    assert scores.floor_margin_mwh == pytest.approx(100.0)


def test_the_worked_example_battery_is_genuinely_energy_unconstrained() -> None:
    """The claim the table rests on, asserted rather than assumed.

    An energy-limited fleet is where the perfect-foresight gap opens; the worked
    example is explicitly not one, and if the fixture's battery ever started
    filling up the numbers above would stop being the spec's.
    """
    scores = replay(observed=day_profile(WORKED_OBSERVED))
    battery = scores.plan.assets[0]
    for trajectory in scores.observed_scoring.state_of_charge_mwh:
        assert max(trajectory) < battery.soc_ceiling_mwh


# --- the two directions of forecast error, which are not symmetric ------------


def test_under_forecasting_shows_up_as_a_lower_percentage_never_a_smaller_actual() -> (
    None
):
    """``a = 2·f50``: the hindsight test.

    There is real curtailment in the hour the plan never asked for, and the
    simulator must not take it: ``absorb[t]`` is bounded by ``Δ[t]``, which
    derives from the *scheduled* dispatch. The unabsorbed excess flows straight
    into ``remaining_mwh``.
    """
    p50 = day_profile(WORKED_P50)
    doubled = tuple(value * 2 for value in p50)
    scores = replay(observed=doubled)

    on_the_basis = scores.band.p50
    observed = scores.observed_scoring
    # Absorption is unchanged from the f50 scoring: the plan did not grow.
    assert observed.recovered_mwh == pytest.approx(on_the_basis.recovered_mwh)
    # The actual is the observed total, whatever the forecast said.
    assert observed.baseline_mwh == pytest.approx(sum(doubled))
    # The entire excess lands in remaining.
    assert observed.remaining_mwh == pytest.approx(
        sum(doubled) - on_the_basis.recovered_mwh
    )
    # And the percentage falls by half — the fixed-fleet arithmetic, visible.
    assert on_the_basis.avoidability is not None
    assert observed.avoidability == pytest.approx(on_the_basis.avoidability / 2)


def test_over_forecasting_clips_every_hour_and_imports_nothing() -> None:
    """``a = 0.5·f50``: the execution rule, hour by hour.

    Every hour's absorption is clipped to ``a[t]``; the state of charge is
    recomputed from the *executed* dispatch, so the battery does not report
    filling up on energy it never received; and nothing is imported.
    """
    p50 = day_profile(WORKED_P50)
    halved = tuple(value * 0.5 for value in p50)
    scores = replay(observed=halved)

    scheduled = scores.plan.hours
    for hour, executed in enumerate(scores.observed_scoring.hours):
        offered = halved[hour]
        assert executed.offered_mwh == pytest.approx(offered)
        assert executed.absorbed_mwh <= offered + 1e-9, "the fleet imported"
        # Clipped to what was really there wherever the plan asked for more.
        expected = min(scheduled[hour].absorbed_mwh, offered)
        assert executed.absorbed_mwh == pytest.approx(expected)

    # The SOC trajectory is the executed one, and it is strictly below the
    # planned one by the end: the plan charged more than the day delivered.
    planned_soc = scores.plan.batteries[0].state_of_charge_mwh
    executed_soc = scores.observed_scoring.state_of_charge_mwh[0]
    assert executed_soc[-1] < planned_soc[-1]
    for planned, actual in zip(planned_soc, executed_soc, strict=True):
        assert actual <= planned + 1e-9


def test_a_day_with_no_curtailment_recovers_exactly_zero_and_reads_as_a_dash() -> None:
    """All-zero actual. `None`, never 0: there was nothing to avoid."""
    scores = replay(observed=tuple([0.0] * HOURS_PER_DAY))

    observed = scores.observed_scoring
    assert observed.baseline_mwh == 0.0
    assert observed.recovered_mwh == 0.0
    assert observed.avoidability is None
    assert all(hour.absorbed_mwh == 0.0 for hour in observed.hours)
    # Nothing was imported: the state of charge never left where it started.
    assert observed.stored_at_horizon_end_mwh == pytest.approx(
        scores.plan.assets[0].initial_soc_mwh
    )


# --- the identity of the code -------------------------------------------------


@pytest.mark.parametrize("realisation", ["p10", "p50", "p90", "observed"])
def test_the_milp_and_the_simulator_agree_on_every_realisation(realisation: str) -> None:
    """``simulate(optimize(r, S), r).recovered_mwh`` equals the MILP's own absorbed.

    Within 1e-6, per `replay.md` seam 4. This is what makes "the KPIs come from
    the simulator, never the objective" a checkable claim rather than a
    convention.
    """
    forecast = pinned(p10=day_profile(WORKED_P10), p50=day_profile(WORKED_P50))
    profiles = {
        "p10": forecast.p10_mwh,
        "p50": forecast.p50_mwh,
        "p90": forecast.p90_mwh,
        "observed": day_profile(WORKED_OBSERVED),
    }
    envelope = profiles[realisation]
    plan = build_plan(
        scenario(),
        PlanningProfile(
            forecast_origin=GATE,
            vintage_fidelity="revision_optimistic",
            p10_mwh=envelope,
            p50_mwh=envelope,
            p90_mwh=envelope,
            expected_mwh=envelope,
            threshold_mw=THRESHOLD_MW,
        ),
    )
    scored = simulate(plan, envelope, threshold_mw=THRESHOLD_MW)
    assert scored.recovered_mwh == pytest.approx(plan.absorbed_mwh, abs=1e-6)


def test_the_scoring_path_calls_the_optimizers_simulate_and_defines_no_rule() -> None:
    """Seam 3, at the Replay end.

    ``test/one-execution-rule.test.ts`` asserts there is exactly one implementation of the
    execution rule in the repository; this asserts that Replay is a *caller* of
    it. Read off the source, because "we imported it" is a property of the file
    rather than of a fixture — a scoring path that grew its own loop would still
    return floats.
    """
    tree = ast.parse(inspect.getsource(scoring_module))
    imported_from = {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        and any(alias.name == "simulate" for alias in node.names)
    }
    assert imported_from == {"wattsteer_ml.optimizer"}, (
        "the scoring path must take `simulate` from the optimizer package"
    )
    called = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "simulate" in called, "the scoring path imports the rule and never runs it"
    # …and defines nothing of its own that could stand in for it.
    defined = {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    }
    assert not defined & {"simulate", "score_band", "execute", "_execute"}
    # The objects really are the optimizer's, not same-named locals. Read off
    # the module dictionary because they are imports rather than re-exports.
    assert vars(scoring_module)["simulate"] is simulate
    assert vars(scoring_module)["score_band"] is score_band


#: What a replay's request path may not reach: the artifact store and the
#: on-disk bundle format, the feature builder, and the estimator family. Read
#: off the *scoring* modules' own imports rather than off ``sys.modules``,
#: because the calendar half legitimately reads an artifact **card** — a JSON
#: file recording two windows, which is what the held-out assertion is checked
#: against — and that pulls `wattsteer_ml.artifacts` into the process without
#: anything having been loaded, fitted or predicted.
NO_MODEL_HERE = frozenset(
    {
        "joblib",
        "lightgbm",
        "sklearn",
        "statsmodels",
        "wattsteer_ml.artifacts",
        "wattsteer_ml.features",
        "wattsteer_ml.training",
    }
)

#: The calls that would *be* a model in the request path, by name. A module
#: that imported none of the above and still called one of these would have
#: found some other route to the same mistake.
NO_MODEL_CALLS = ("load_promoted", "artifacts.current", "FeatureRowsQuery", "predict")


def imported_modules(module: Any) -> set[str]:
    tree = ast.parse(inspect.getsource(module))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            names.add(node.module)
            names.update(f"{node.module}.{alias.name}" for alias in node.names)
    return names


@pytest.mark.parametrize("module", [scoring_module, result_module])
def test_a_replay_loads_no_model_and_builds_no_feature_row(module: Any) -> None:
    """Story 37: no joblib load, no feature build, no forecast call.

    The forecast is a pinned-row lookup — :class:`PinnedForecast` is handed in —
    so the scoring path has nothing to resolve and nothing to fit. Asserted over
    the modules' imports and their source, which is where the property lives:
    "changing the fleet re-plans and never re-forecasts" is true because there
    is no code here that could re-forecast.
    """
    imported = imported_modules(module)
    banned = {
        name
        for name in imported
        if name in NO_MODEL_HERE or name.split(".")[0] in NO_MODEL_HERE
    }
    assert not banned, f"{module.__name__} imports {sorted(banned)}"
    source = inspect.getsource(module)
    for call in NO_MODEL_CALLS:
        assert call not in source, f"{module.__name__} reaches for {call}"


# --- the published contract ---------------------------------------------------


def registry() -> Registry[Any]:
    resources: Registry[Any] = Registry()
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        resources = resources.with_resource(
            BASE + path.name,
            Resource.from_contents(json.loads(path.read_text(encoding="utf-8"))),
        )
    return resources


def published(
    scores: ReplayScores | None = None,
    *,
    episodes: tuple[ReplayEpisode, ...] = (),
    wire: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = wire if wire is not None else scenario()
    validate_scenario(body, NOW)
    return replay_result(
        body,
        decode_scenario_body(body).hash,
        scores if scores is not None else replay(observed=day_profile(WORKED_OBSERVED)),
        episodes=episodes,
    )


def test_the_result_validates_against_the_published_schema() -> None:
    """`packages/core/schema/replay.schema.json` is the cross-language authority."""
    schema = json.loads((SCHEMA_DIR / "replay.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator(schema, registry=registry()).validate(published())


def test_the_result_names_its_posture_its_realisation_and_its_promise() -> None:
    """Without `scored_on` beside `planning_basis` the two results are a trap."""
    body = published()
    assert body["planning_basis"] == "p50"
    assert body["scored_on"] == "observed"
    assert body["execution_rule"] == "follow_curtailment"
    assert set(body["scored"]) == {"p10", "p50", "p90", "observed"}
    assert body["floor_met"] is True
    assert body["floor_margin_mwh"] == pytest.approx(100.0)
    assert body["recovered_floor_mwh"] == pytest.approx(
        body["scored"]["p10"]["recovered_mwh"]
    )
    # One quantity, three names, one headline.
    assert body["avoided_energy_mwh"] == pytest.approx(
        body["scored"]["observed"]["recovered_mwh"]
    )
    assert body["baseline_curtailment_mwh"] == pytest.approx(body["actual"]["total_mwh"])
    assert body["integrity"]["provenance"] == "fold_holdout"
    assert body["integrity"]["model_saw_this_day"] is False
    assert body["integrity"]["revision_premium_recovered_mwh"] is None
    assert body["forecast_origin"]["origin_kind"] == BACKFILLED_HOLDOUT_ORIGIN_KIND


def test_the_day_band_is_not_a_sum_of_the_hourly_band() -> None:
    """Quantiles do not add, and the contract carries the ensemble's own figure."""
    body = published()
    hourly_sum = sum(
        hour["constrained_off_mwh"]["p90"] for hour in body["forecast"]["hours"]
    )
    assert body["forecast"]["day_total"]["p90"] != pytest.approx(hourly_sum)


def test_dispatch_and_executed_are_two_series_and_agree_only_on_the_basis() -> None:
    """Drawing one is what makes "planned against P50" read as "P50 came true"."""
    body = published()
    assert body["dispatch"] != body["executed"]

    # The realisation *is* the planning basis: the two series coincide.
    same = published(scores=replay(observed=day_profile(WORKED_P50)))
    assert same["dispatch"] == same["executed"]


def test_the_denominator_is_the_day_and_the_threshold_never_enters_it() -> None:
    """Move the threshold: the episodes drawn move, the percentage does not."""
    low = published()
    high = published(
        scores=replay(observed=day_profile(WORKED_OBSERVED), threshold_mw=30.0)
    )

    assert high["threshold_mw"] == 30.0
    assert high["baseline_curtailment_mwh"] == pytest.approx(
        low["baseline_curtailment_mwh"]
    )
    assert high["avoided_energy_mwh"] == pytest.approx(low["avoided_energy_mwh"])
    assert high["avoidability"] == pytest.approx(low["avoidability"])


def test_an_episode_drawn_at_another_threshold_cannot_be_rendered_beside_the_day() -> (
    None
):
    """Rule 8: an unstamped magnitude cannot be compared with another one."""
    drawn_here = ReplayEpisode(
        started_at=datetime(2025, 11, 12, 13, tzinfo=UTC),
        ended_at=datetime(2025, 11, 12, 16, tzinfo=UTC),
        duration_hours=3,
        total_mwh=240.0,
        peak_mw=160.0,
        threshold_mw=THRESHOLD_MW,
        max_gap_hours=MAX_GAP_HOURS,
    )
    body = published(episodes=(drawn_here,))
    assert body["episodes"][0]["threshold_mw"] == THRESHOLD_MW
    assert body["episodes"][0]["max_gap_hours"] == MAX_GAP_HOURS

    elsewhere = ReplayEpisode(**{**vars(drawn_here), "threshold_mw": 50.0})
    with pytest.raises(ReplayPostureError, match="cannot be rendered beside"):
        published(episodes=(elsewhere,))


# --- perfect foresight, fenced ------------------------------------------------


def test_the_upper_bound_is_a_bound_and_no_headline_field_can_reach_it() -> None:
    """`_headline` takes one realisation and cannot see the hindsight solve."""
    signature = inspect.signature(result_module._headline)
    assert list(signature.parameters) == ["observed"]

    body = published()
    assert body["upper_bound"]["label"] == "perfect_foresight"
    assert body["upper_bound"]["recovered_mwh"] >= body["avoided_energy_mwh"]
    assert body["upper_bound"]["forecast_value_gap_mwh"] == pytest.approx(
        body["upper_bound"]["recovered_mwh"] - body["avoided_energy_mwh"]
    )


def test_the_gap_opens_where_the_fleet_is_energy_limited() -> None:
    """Better forecasting is worth something only where the fleet must choose.

    The forecast said the curtailment was in the morning and it arrived in the
    evening. A plan that knew would have charged then; the plan that was built
    at the gate could not, and the difference is the gap — published as its own
    number and never inside a recovery claim.
    """
    p50 = day_profile((100.0, 0.0), at=(10, 18))
    observed = day_profile((0.0, 100.0), at=(10, 18))
    scores = replay(
        observed=observed,
        p50=p50,
        p10=day_profile((0.0, 0.0), at=(10, 18)),
        wire=scenario(max_power_mw=50, energy_capacity_mwh=50),
    )
    assert scores.observed_scoring.recovered_mwh == pytest.approx(0.0)
    assert scores.upper_bound.recovered_mwh > 0.0
    assert scores.upper_bound.forecast_value_gap_mwh == pytest.approx(
        scores.upper_bound.recovered_mwh
    )


def tie_breaking_tolerance(plan: DispatchPlan) -> float:
    """The objective's throughput tie-breaker, ``Σ_b δ_b · throughput_b``.

    The magnitude `replay.md` argues for and does not give. It is derived rather
    than chosen: the executed dispatch of the P50 plan is itself a feasible
    schedule of the perfect-foresight problem, so the two solves can differ in
    the *wrong* direction only by the term that breaks ties between schedules
    that recover the same energy. A constant here would be a number nobody
    decided on, and one that stopped being true the moment the penalty moved.
    """
    return TOLERANCE_MWH + sum(
        penalty * dispatch.throughput_mwh
        for penalty, dispatch in zip(
            plan.throughput_penalties, plan.batteries, strict=True
        )
    )


def test_perfect_foresight_dominates_on_random_scenarios_and_realisations() -> None:
    """Seam 5: `scored_pf.recovered_mwh ≥ recovered_mwh`, within that tolerance.

    A violation means the plan and the simulator disagree — the one bug this
    whole architecture is arranged to surface — so the fleets are deliberately
    drawn small enough to be energy-limited much of the time, which is where the
    two solves actually differ. `score_replay` raises `OptimizerBugError` on a
    violation, so this asserts twice over: that it did not, and that the
    published gap is non-negative to the same tolerance.
    """
    rng = random.Random(20260904)  # noqa: S311 — a fixture, not a security decision
    for _ in range(24):
        hours = rng.sample(range(HOURS_PER_DAY), rng.randint(1, 6))
        p50 = [0.0] * HOURS_PER_DAY
        p10 = [0.0] * HOURS_PER_DAY
        observed = [0.0] * HOURS_PER_DAY
        for hour in hours:
            p50[hour] = round(rng.uniform(0.0, 200.0), 2)
            p10[hour] = round(p50[hour] * rng.uniform(0.0, 0.6), 2)
            observed[hour] = round(rng.uniform(0.0, 200.0), 2)
        scores = replay(
            observed=tuple(observed),
            p50=tuple(p50),
            p10=tuple(p10),
            wire=scenario(
                max_power_mw=round(rng.uniform(10.0, 120.0), 1),
                energy_capacity_mwh=round(rng.uniform(20.0, 500.0), 1),
            ),
        )
        tolerance = tie_breaking_tolerance(scores.plan)
        assert scores.upper_bound.recovered_mwh >= (
            scores.observed_scoring.recovered_mwh - tolerance
        )
        assert scores.upper_bound.forecast_value_gap_mwh >= -tolerance


def test_the_gap_is_zero_unconstrained_and_opens_when_the_energy_is_capped() -> None:
    """The spec's own pair, on one battery capped two ways.

    "Perfect foresight on this toy recovers 160 as well: an energy-unconstrained
    fleet with hourly power to spare gains nothing from knowing the answer. The
    gap opens exactly when the fleet is energy-limited — cap the same battery at
    140 MWh usable and the P50 plan recovers 120 while perfect foresight
    recovers 140, a `forecast_value_gap_mwh` of 20."

    That is the honest shape of the claim, and it is the reason the gap is
    published as its own number rather than folded into anything: better
    forecasting is worth something only where the fleet has to choose which
    hours to spend itself on.
    """
    observed = day_profile(WORKED_OBSERVED)
    unconstrained = replay(observed=observed, wire=scenario(energy_capacity_mwh=400))
    capped = replay(observed=observed, wire=scenario(energy_capacity_mwh=140))

    assert unconstrained.observed_scoring.recovered_mwh == pytest.approx(160.0)
    assert unconstrained.upper_bound.recovered_mwh == pytest.approx(160.0)
    assert unconstrained.upper_bound.forecast_value_gap_mwh == pytest.approx(0.0)

    # The same day, the same battery, one constraint added. `120.7` rather than
    # the spec's `120` because η is not 1 here — see the module docstring — and
    # the *gap* is the spec's 20 either way, because the same loss applies to
    # both solves.
    assert capped.observed_scoring.recovered_mwh < 160.0
    assert capped.upper_bound.recovered_mwh > capped.observed_scoring.recovered_mwh
    assert capped.upper_bound.forecast_value_gap_mwh == pytest.approx(20.0, abs=0.5)


# --- the postures a replay cannot take ----------------------------------------


def test_a_plan_built_on_the_day_itself_cannot_be_presented_as_a_replay() -> None:
    """The single most flattering thing a replay could do, refused structurally.

    Not "a test would catch it": `ReplayScores` cannot be constructed around a
    plan built on anything but the pinned P50, so the hindsight plan has nowhere
    to be published from.
    """
    observed = day_profile(WORKED_OBSERVED)
    forecast = pinned(p10=day_profile(WORKED_P10), p50=day_profile(WORKED_P50))
    honest = replay(observed=observed)
    hindsight = build_plan(
        scenario(),
        PlanningProfile(
            forecast_origin=GATE,
            vintage_fidelity="revision_optimistic",
            p10_mwh=forecast.p10_mwh,
            p50_mwh=observed,
            p90_mwh=forecast.p90_mwh,
            expected_mwh=forecast.expected_mwh,
            threshold_mw=THRESHOLD_MW,
        ),
    )
    with pytest.raises(ReplayPostureError, match="not the pinned P50"):
        ReplayScores(
            day=honest.day,
            windows=F3,
            forecast=forecast,
            observed=observed_day(observed),
            plan=hindsight,
            band=score_band(
                hindsight,
                p10_mwh=forecast.p10_mwh,
                p50_mwh=forecast.p50_mwh,
                p90_mwh=forecast.p90_mwh,
                threshold_mw=THRESHOLD_MW,
            ),
            observed_scoring=simulate(hindsight, observed, threshold_mw=THRESHOLD_MW),
            upper_bound=honest.upper_bound,
        )


def test_a_column_scored_against_another_realisation_is_refused() -> None:
    """The "observed" column is the observed day, or there is no result."""
    honest = replay(observed=day_profile(WORKED_OBSERVED))
    with pytest.raises(ReplayPostureError, match="'observed' column"):
        ReplayScores(
            day=honest.day,
            windows=F3,
            forecast=honest.forecast,
            observed=honest.observed,
            plan=honest.plan,
            band=honest.band,
            # The planning envelope, wearing the observed day's name.
            observed_scoring=honest.band.p50,
            upper_bound=honest.upper_bound,
        )


def test_an_in_sample_day_raises_rather_than_rendering_a_badge() -> None:
    """The serving artifact has seen the day; there is no counterfactual.

    A `500`, not a badge — and raised by the same class replay 01 raises when it
    refuses to *mint* such a row, so the two ends of the claim cannot drift.
    """
    day = ReplayDay(
        target_date=HELD_OUT_DAY,
        provenance="served",
        vintage_fidelity="point_in_time",
        held_out_by=HeldOutBy(
            fold=PROMOTED.fold_id,
            artifact_id=PROMOTED.artifact_id,
            train_window=(PROMOTED.train_start, PROMOTED.train_end),
            calibration_window=(PROMOTED.calibration_start, PROMOTED.calibration_end),
        ),
        refusal=None,
    )
    with pytest.raises(HoldoutLeakError, match="in-sample fit"):
        score_replay(
            scenario(),
            day=day,
            windows=PROMOTED,
            forecast=pinned(
                p10=day_profile(WORKED_P10),
                p50=day_profile(WORKED_P50),
                origin_kind=SERVED_ORIGIN_KIND,
                run_label=PROMOTED.artifact_id,
            ),
            observed=observed_day(day_profile(WORKED_OBSERVED)),
        )


def test_a_refused_day_has_no_number_at_all() -> None:
    """Refused, never a number with a caveat over it."""
    refused = ReplayDay(
        target_date=HELD_OUT_DAY,
        provenance=None,
        vintage_fidelity="revision_optimistic",
        held_out_by=None,
        refusal=ReplayRefused(
            code="REPLAY_OBSERVATION_INCOMPLETE", status=404, message="23 of 24 hours"
        ),
    )
    with pytest.raises(ReplayPostureError, match="not replayable"):
        score_replay(
            scenario(),
            day=refused,
            windows=F3,
            forecast=pinned(p10=day_profile(WORKED_P10), p50=day_profile(WORKED_P50)),
            observed=observed_day(day_profile(WORKED_OBSERVED)),
        )


def test_the_integrity_check_must_run_against_the_artifact_that_produced_the_rows() -> (
    None
):
    """A claim checked against the wrong artifact is not checked."""
    with pytest.raises(ReplayPostureError, match="wrong artifact"):
        score_replay(
            scenario(),
            day=replayable_day(),
            windows=PROMOTED,
            forecast=pinned(p10=day_profile(WORKED_P10), p50=day_profile(WORKED_P50)),
            observed=observed_day(day_profile(WORKED_OBSERVED)),
        )


def test_a_reconstruction_cannot_be_published_as_a_record() -> None:
    """`origin_kind` and `provenance` are one mapping, checked at both ends."""
    with pytest.raises(ReplayPostureError, match="reconstruction rendered as a record"):
        score_replay(
            scenario(),
            day=replayable_day(),
            windows=F3,
            forecast=pinned(
                p10=day_profile(WORKED_P10),
                p50=day_profile(WORKED_P50),
                origin_kind=SERVED_ORIGIN_KIND,
            ),
            observed=observed_day(day_profile(WORKED_OBSERVED)),
        )


def test_another_days_actuals_cannot_be_scored_against_this_days_plan() -> None:
    with pytest.raises(ReplayPostureError, match="not a replay"):
        score_replay(
            scenario(),
            day=replayable_day(),
            windows=F3,
            forecast=pinned(p10=day_profile(WORKED_P10), p50=day_profile(WORKED_P50)),
            observed=observed_day(
                day_profile(WORKED_OBSERVED), target_date=date(2025, 11, 13)
            ),
        )


def test_a_forecast_published_inside_the_day_it_forecasts_is_not_a_forecast() -> None:
    """A D−1 forecast whose publication instant falls inside the day is hindsight."""
    with pytest.raises(ReplayPostureError, match="not before"):
        pinned(
            p10=day_profile(WORKED_P10),
            p50=day_profile(WORKED_P50),
            published_at=datetime(2025, 11, 12, 15, tzinfo=UTC),
        )


def test_the_scenario_must_describe_the_day_being_replayed() -> None:
    """The builder reads the horizon off the scenario; a mismatch is a bug."""
    scores = replay(observed=day_profile(WORKED_OBSERVED))
    elsewhere = scenario(target_date=date(2025, 11, 13))
    with pytest.raises(ReplayPostureError, match="the scenario plans"):
        replay_result(elsewhere, decode_scenario_body(elsewhere).hash, scores)


# --- the observed-only day, before the first fold -----------------------------

#: A day in the pre-F1 training block. Every artifact was fitted on it, so no
#: honest counterfactual exists and `replay.md` refuses it rather than labelling
#: it — the observed-only view is what it gets instead.
PRE_F1_DAY = date(2024, 8, 14)


def pre_f1_day(target_date: date = PRE_F1_DAY) -> ReplayDay:
    """A refused `ReplayDay` from the calendar's own predicate, never hand-built."""
    return resolve_day(
        DayEvidence(target_date=target_date, observed_hours=HOURS_PER_DAY),
        subsystem=SUBSYSTEM,
        lane=LANE.directory_name,
        rules=FOLD_CALENDAR_RULES,
        latest=date(2026, 9, 3),
        windows=None,
        sources=(),
    )


def observed_only(
    *,
    observed: tuple[float, ...] = day_profile(WORKED_OBSERVED),
    day: ReplayDay | None = None,
    threshold_mw: float = THRESHOLD_MW,
) -> ObservedOnlyView:
    return score_observed_only(
        scenario(target_date=PRE_F1_DAY),
        day=pre_f1_day() if day is None else day,
        observed=observed_day(observed, target_date=PRE_F1_DAY),
        threshold_mw=threshold_mw,
    )


def observed_only_published(
    view: ObservedOnlyView | None = None,
    *,
    episodes: tuple[ReplayEpisode, ...] = (),
) -> dict[str, Any]:
    body = scenario(target_date=PRE_F1_DAY)
    validate_scenario(body, NOW)
    return observed_only_result(
        body,
        decode_scenario_body(body).hash,
        observed_only() if view is None else view,
        episodes=episodes,
    )


def test_an_observed_only_day_has_the_day_the_episodes_and_the_bound() -> None:
    """The whole offer for a pre-F1 day, and it validates against its own schema.

    The settled profile, the episodes at the threshold in force, the bound —
    and the typed code that says why there is nothing else, which is the one
    sentence the screen renders.
    """
    episode = ReplayEpisode(
        started_at=datetime(2024, 8, 14, 13, tzinfo=UTC),
        ended_at=datetime(2024, 8, 14, 16, tzinfo=UTC),
        duration_hours=3,
        total_mwh=240.0,
        peak_mw=160.0,
        threshold_mw=THRESHOLD_MW,
        max_gap_hours=MAX_GAP_HOURS,
    )
    body = observed_only_published(episodes=(episode,))

    schema = json.loads(
        (SCHEMA_DIR / "replay-observed-only.schema.json").read_text(encoding="utf-8")
    )
    Draft202012Validator(schema, registry=registry()).validate(body)

    assert body["target_date"] == PRE_F1_DAY.isoformat()
    assert body["replayable"] is False
    assert body["refusal"]["code"] == "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW"
    assert body["refusal"]["details"]["observed_only"] is True
    # The observed profile, whole, and its episodes at the threshold in force.
    assert body["actual"]["hours"] == list(day_profile(WORKED_OBSERVED))
    assert body["actual"]["total_mwh"] == pytest.approx(240.0)
    assert body["threshold_mw"] == THRESHOLD_MW
    assert body["episodes"][0]["threshold_mw"] == THRESHOLD_MW
    assert body["upper_bound"]["label"] == "perfect_foresight"
    assert body["upper_bound"]["recovered_mwh"] > 0.0


def test_a_pre_f1_day_carries_no_wattsteer_number_at_all() -> None:
    """`scored`, `avoided_energy_mwh`, `recovered_floor_mwh`: absent, not zero.

    A zero would be a claim — "WattSteer recovered nothing" — about a day
    WattSteer was never asked to plan. The absence is structural: an
    `ObservedOnlyView` holds no plan, no `ScoredRealisation` and no floor, so
    there is nothing on it these keys could be read from, and the schema is
    closed so a future edit that invented one would fail validation.
    """
    body = observed_only_published()
    for absent in (
        "scored",
        "avoided_energy_mwh",
        "recovered_floor_mwh",
        "floor_met",
        "floor_margin_mwh",
        "avoidability",
        "baseline_curtailment_mwh",
        "optimized_curtailment_mwh",
        "dispatch",
        "executed",
        "forecast",
        "forecast_origin",
        "integrity",
        "planning_basis",
        "scored_on",
    ):
        assert absent not in body, f"{absent} is absent on an observed-only day"

    # The schema is closed, so smuggling one in is a refusal rather than a
    # convention somebody remembered.
    schema = json.loads(
        (SCHEMA_DIR / "replay-observed-only.schema.json").read_text(encoding="utf-8")
    )
    validator = Draft202012Validator(schema, registry=registry())
    with pytest.raises(ValidationError):
        validator.validate({**body, "avoided_energy_mwh": 0.0})


def test_the_bound_on_an_observed_only_day_has_nothing_to_compare_against() -> None:
    """No `forecast_value_gap_mwh`: there was no forecast, so there is no gap.

    "The forecast cost nothing" and "there was no forecast" are different
    sentences, and only the second is true here — so the two cases are two types
    rather than one type with a nullable field.
    """
    view = observed_only()
    assert not isinstance(view.upper_bound, PerfectForesight)
    assert not hasattr(view.upper_bound, "forecast_value_gap_mwh")
    assert "forecast_value_gap_mwh" not in view.upper_bound.as_payload()

    # And a hand-built view carrying the three-scalar shape is refused, because
    # `PerfectForesight` is a subclass and the type alone would let it through.
    with pytest.raises(ReplayPostureError, match="no gap to publish"):
        ObservedOnlyView(
            day=pre_f1_day(),
            observed=observed_day(day_profile(WORKED_OBSERVED), target_date=PRE_F1_DAY),
            threshold_mw=THRESHOLD_MW,
            upper_bound=PerfectForesight(
                recovered_mwh=160.0, avoidability=0.5, forecast_value_gap_mwh=0.0
            ),
        )


def test_the_observed_only_view_is_offered_for_the_pre_f1_block_and_nothing_else() -> (
    None
):
    """A replayable day has numbers; a missing read is a 404, not a screen."""
    with pytest.raises(ReplayPostureError, match="not an observed-only day"):
        observed_only(day=replayable_day())

    incomplete = ReplayDay(
        target_date=PRE_F1_DAY,
        provenance=None,
        vintage_fidelity="revision_optimistic",
        held_out_by=None,
        refusal=ReplayRefused(
            code="REPLAY_OBSERVATION_INCOMPLETE", status=404, message="23 of 24 hours"
        ),
    )
    with pytest.raises(ReplayPostureError, match="not an observed-only day"):
        observed_only(day=incomplete)


def test_an_episode_from_another_threshold_cannot_be_rendered_here_either() -> None:
    """Rule 8 holds on the day with no numbers, for the same reason."""
    elsewhere = ReplayEpisode(
        started_at=datetime(2024, 8, 14, 13, tzinfo=UTC),
        ended_at=datetime(2024, 8, 14, 16, tzinfo=UTC),
        duration_hours=3,
        total_mwh=240.0,
        peak_mw=160.0,
        threshold_mw=50.0,
        max_gap_hours=MAX_GAP_HOURS,
    )
    with pytest.raises(ReplayPostureError, match="cannot be rendered beside"):
        observed_only_published(episodes=(elsewhere,))


def test_the_observed_only_bound_is_the_day_itself_planned_against() -> None:
    """It is `optimize(curt = a, S)` and not a solve on some other profile.

    The same fleet, the same day: the bound published beside a pre-F1 day is
    numerically what a hindsight solve on that day produces, which is what makes
    "a property of the day and the fleet" a checkable sentence.
    """
    observed = day_profile(WORKED_OBSERVED)
    view = observed_only(observed=observed)
    plan = build_plan(
        scenario(target_date=PRE_F1_DAY),
        PlanningProfile(
            forecast_origin=GATE,
            vintage_fidelity="revision_optimistic",
            p10_mwh=observed,
            p50_mwh=observed,
            p90_mwh=observed,
            expected_mwh=observed,
            threshold_mw=THRESHOLD_MW,
        ),
    )
    scored = simulate(plan, observed, threshold_mw=THRESHOLD_MW)
    assert view.upper_bound.recovered_mwh == pytest.approx(scored.recovered_mwh)
    assert view.upper_bound.avoidability == pytest.approx(scored.avoidability)
