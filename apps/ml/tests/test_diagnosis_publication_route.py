"""The attribution publication: a route, or a typed refusal. Never a 404.

api-surface ticket 10's third schedule row. Four kinds of assertion, in the
shape `test_publication.py` uses for the forecast's half of the same chain:

**Structural.** That the route exists at all — a probe of
``POST /internal/publish/diagnosis`` used to get FastAPI's own
``{"detail": "Not Found"}``, which `ml-proxy` maps to ``UPSTREAM_REJECTED`` and
which reads like a misconfigured base URL. That the module writes nothing. And
that the rules' roll call reaches the row through ``RuleOutcome.for_row``, which
is the one call that cannot produce an unflagged row.

**The refusals, each proved to fire.** All five of
:data:`~wattsteer_ml.diagnosis.publish.REFUSAL_CONDITIONS`, and for each one the
positive case beside it — a guard that cannot be made to pass is not evidence
that it can fail, and this repository has been bitten by that four times.

**"Typical" is measured and not invented.** Every published row says
``background_source: base_fit`` with the seed and the row count it was drawn
under, because the artifact carries no frozen sample (forecaster 30). A short
base-fit window refuses rather than thinning one hour's typical.

**Over the wire.** That a real assembly produces the payload shape the
gateway's ``parseAttributionPublication`` already accepts — sixteen driver rows,
eight per grain, per subsystem — and that the route computes nothing before it
has an artifact.
"""

from __future__ import annotations

import ast
import math
import os
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from attribution_fixtures import synthetic_map
from feature_row_fixtures import FEATURE_SET, GATE_PROFILE, THRESHOLD_MW, feature_rows
from wattsteer_ml.app import app
from wattsteer_ml.config import settings
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.diagnosis.background import BACKGROUND_ROWS_PER_CELL
from wattsteer_ml.diagnosis.driver_groups import DRIVER_GROUP_CODES
from wattsteer_ml.diagnosis.publish import (
    REFUSAL_CONDITIONS,
    DiagnosisPublicationRefusedError,
    background_seed,
    base_fit_window,
    build_diagnosis_publication,
)
from wattsteer_ml.lanes import Lane
from wattsteer_ml.publication import publication_instant
from wattsteer_ml.training import LoadedArtifact, TrainedFold

client = TestClient(app)

LANE = Lane(feature_set=FEATURE_SET, gate_profile=GATE_PROFILE, threshold_mw=THRESHOLD_MW)
PATH = "/internal/publish/diagnosis"

#: The route draws the spec's 128 rows per cell. These tests draw four, because
#: what changes with the sample size is the wall clock and not one invariant
#: below — the scale run at 128 is at the bottom of the file, behind the
#: existing ``WATTSTEER_SCALE_TESTS`` gate.
TEST_ROWS_PER_CELL = 4

SOURCE = Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml"


#: A partition over names no feature list carries — the map that cannot attribute
#: this contract. Used to prove ``contract_and_groups_disagree`` fires; every
#: other test here runs the **real** map, which is the route's own default and
#: which does cover both the fixture contract and both real feature sets
#: (`test_grouped_shapley.py` asserts the latter).
FOREIGN_MAP = synthetic_map(tuple((f"f{index}",) for index in range(8)))


@pytest.fixture(scope="module")
def target_day(trained: TrainedFold) -> date:
    """A day after the fit's window — a serve, not a re-read of training rows."""
    return trained.blocks.test_end + timedelta(days=1)


@pytest.fixture(scope="module")
def serving_rows(target_day: date) -> list[dict[str, Any]]:
    """One day, with the weather block present for every hour.

    ``weather_null_rate=0`` and it is not a convenience. Three of the eight real
    headline features are in the weather block, the observed/typical pair is a
    required number on the wire at both grains, and there is no representation
    for the pair's absence — so a day with a missing weather run is a refusal.
    :func:`test_a_null_headline_feature_is_refused_rather_than_zeroed` is that
    case, at the fixture's default rate; every other test here needs a day the
    assembly can actually finish.
    """
    return feature_rows(first=target_day, last=target_day, weather_null_rate=0.0)


@pytest.fixture(scope="module")
def nullable_serving_rows(target_day: date) -> list[dict[str, Any]]:
    """The same day with no weather run at all.

    The whole weather block arrives from one run and goes NULL together, so
    ``weather_null_rate=1.0`` is not an exaggerated fixture — it is the day
    ONS's weather did not land, which is the condition the no-imputation rule
    exists for. The fixture's default 5% is per row and this particular seeded
    day draws none, so a rate is chosen rather than relied on.
    """
    return feature_rows(first=target_day, last=target_day, weather_null_rate=1.0)


@pytest.fixture(scope="module")
def loaded(trained: TrainedFold) -> LoadedArtifact:
    return LoadedArtifact(
        artifact_id=trained.card.artifact_id,
        bundle=trained.bundle,
        card=trained.card.to_dict(),
    )


@pytest.fixture(scope="module")
def base_fit_rows(loaded: LoadedArtifact) -> list[dict[str, Any]]:
    """The artifact's own base-fit window, read as the route reads it."""
    start, end = base_fit_window(loaded)
    return feature_rows(first=start, last=end, weather_null_rate=0.0)


@pytest.fixture(scope="module")
def published(
    serving_rows: list[dict[str, Any]],
    base_fit_rows: list[dict[str, Any]],
    loaded: LoadedArtifact,
    target_day: date,
) -> Any:
    return build_diagnosis_publication(
        serving_rows,
        base_fit_rows,
        lane=LANE,
        loaded=loaded,
        target_date=target_day,
        published_at=publication_instant(serving_rows, target_date=target_day),
        rows_per_cell=TEST_ROWS_PER_CELL,
    )


# --- the route exists, and every answer carries a code ------------------------


def test_the_route_is_registered_and_is_not_a_bare_404() -> None:
    """The box api-surface 10 left open: the chain had nowhere to go.

    Asserted on the route table rather than on a response, because the
    interesting failure is the route being *absent* — every response below is
    then a refusal this service chose.
    """
    paths = {getattr(route, "path", None) for route in app.routes}
    assert PATH in paths


def test_a_lane_name_that_is_not_one_is_refused_before_anything_is_loaded() -> None:
    response = client.post(PATH, json={"lane": "nonsense"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REQUEST_INVALID"


def test_an_unmounted_volume_answers_model_unavailable_with_its_lane_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The forecast route's refusal, verbatim, because it is the same absence.

    `MODEL_UNAVAILABLE` is required to carry ``details.lane_state``, and the
    mount is reported beside it: a lane on a volume that is not mounted has,
    truthfully, no artifact, and the two have different repairs.
    """
    monkeypatch.setattr(settings, "artifact_dir", tmp_path / "not-mounted")
    response = client.post(PATH, json={"lane": LANE.directory_name})
    assert response.status_code == 503
    failure = response.json()["error"]
    assert failure["code"] == "MODEL_UNAVAILABLE"
    assert failure["details"]["lane_state"] == "no_artifact"
    assert failure["details"]["volume_mounted"] is False


def test_the_route_reads_no_row_before_it_has_an_artifact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An untrained lane costs no query, and no ~17,000-row window read.

    The order is load, then the day's 96 rows, then the base-fit window — each
    one gated on the cheaper answer before it. Asserted by reading the handler,
    because the alternative is a database in this suite.
    """
    monkeypatch.setattr(settings, "artifact_dir", tmp_path / "not-mounted")
    source = (SOURCE / "app.py").read_text(encoding="utf-8")
    handler = source.split("async def publish_diagnosis(")[1].split("\n@app.")[0]
    assert handler.index("load_promoted(") < handler.index("read_serving_rows(")
    assert handler.index("read_serving_rows(") < handler.index("read_feature_rows(")


# --- "typical" is measured, and a short sample is refused ---------------------


def test_a_short_base_fit_window_refuses_rather_than_thinning_typical(
    serving_rows: list[dict[str, Any]],
    base_fit_rows: list[dict[str, Any]],
    loaded: LoadedArtifact,
    target_day: date,
) -> None:
    """The guard that matters, proved to fail — and proved not to fail vacuously.

    The fixture fold's base-fit window is thirty days, which is thirty rows per
    ``(subsystem, local_hour)`` cell. Asked for the spec's 128 it refuses; asked
    for four it publishes. Both halves are here on purpose: a refusal from an
    *empty* window would prove nothing about the arithmetic, so the row count
    the block actually holds is asserted first.
    """
    assert len(base_fit_rows) > 0
    days = len({row["target_date"] for row in base_fit_rows})
    assert 30 <= days < BACKGROUND_ROWS_PER_CELL

    with pytest.raises(DiagnosisPublicationRefusedError) as refused:
        build_diagnosis_publication(
            serving_rows,
            base_fit_rows,
            lane=LANE,
            loaded=loaded,
            target_date=target_day,
            published_at=publication_instant(serving_rows, target_date=target_day),
            rows_per_cell=BACKGROUND_ROWS_PER_CELL,
        )
    assert refused.value.condition == "no_matched_background"
    assert "invented" in refused.value.reason

    # The same call at a sample the window can supply publishes, so the refusal
    # above is the row count and not the plumbing.
    assert build_diagnosis_publication(
        serving_rows,
        base_fit_rows,
        lane=LANE,
        loaded=loaded,
        target_date=target_day,
        published_at=publication_instant(serving_rows, target_date=target_day),
        rows_per_cell=TEST_ROWS_PER_CELL,
    ).rows


def test_an_empty_base_fit_window_is_a_refusal_and_not_a_pooled_sample(
    serving_rows: list[dict[str, Any]],
    loaded: LoadedArtifact,
    target_day: date,
) -> None:
    with pytest.raises(DiagnosisPublicationRefusedError) as refused:
        build_diagnosis_publication(
            serving_rows,
            [],
            lane=LANE,
            loaded=loaded,
            target_date=target_day,
            published_at=publication_instant(serving_rows, target_date=target_day),
            rows_per_cell=TEST_ROWS_PER_CELL,
        )
    assert refused.value.condition == "no_matched_background"


def test_a_card_with_no_base_fit_window_cannot_say_what_typical_means(
    loaded: LoadedArtifact,
) -> None:
    """``no_base_fit_window`` — and the positive case beside it."""
    assert base_fit_window(loaded)[0] < base_fit_window(loaded)[1]

    card = {key: value for key, value in loaded.card.items() if key != "data"}
    blinded = LoadedArtifact(
        artifact_id=loaded.artifact_id, bundle=loaded.bundle, card=card
    )
    with pytest.raises(DiagnosisPublicationRefusedError) as refused:
        base_fit_window(blinded)
    assert refused.value.condition == "no_base_fit_window"


def test_a_group_with_no_column_in_this_contract_stops_the_publication(
    serving_rows: list[dict[str, Any]],
    base_fit_rows: list[dict[str, Any]],
    loaded: LoadedArtifact,
    target_day: date,
) -> None:
    """``contract_and_groups_disagree`` — a bar that is structurally zero.

    The real map over the fixture contract is exactly this case, which is why
    every other test here substitutes a partition. The refusal names the repair
    — a line in the YAML — instead of publishing eight bars one of which could
    never move.
    """
    with pytest.raises(DiagnosisPublicationRefusedError) as refused:
        build_diagnosis_publication(
            serving_rows,
            base_fit_rows,
            lane=LANE,
            loaded=loaded,
            target_date=target_day,
            published_at=publication_instant(serving_rows, target_date=target_day),
            group_map=FOREIGN_MAP,
            rows_per_cell=TEST_ROWS_PER_CELL,
        )
    assert refused.value.condition == "contract_and_groups_disagree"


def test_a_day_short_of_its_hours_is_refused(
    serving_rows: list[dict[str, Any]],
    base_fit_rows: list[dict[str, Any]],
    loaded: LoadedArtifact,
    target_day: date,
) -> None:
    """``incomplete_day`` — and the empty case, which is the same condition."""
    short = [row for row in serving_rows if row["calendar_local_hour"] != 3]
    assert len(short) == len(serving_rows) - len(SUBSYSTEM_CODES)
    with pytest.raises(DiagnosisPublicationRefusedError) as refused:
        build_diagnosis_publication(
            short,
            base_fit_rows,
            lane=LANE,
            loaded=loaded,
            target_date=target_day,
            published_at=publication_instant(short, target_date=target_day),
            rows_per_cell=TEST_ROWS_PER_CELL,
        )
    assert refused.value.condition == "incomplete_day"

    with pytest.raises(DiagnosisPublicationRefusedError) as empty:
        build_diagnosis_publication(
            [],
            base_fit_rows,
            lane=LANE,
            loaded=loaded,
            target_date=target_day,
            published_at=datetime(2026, 3, 3, 22, tzinfo=UTC),
            rows_per_cell=TEST_ROWS_PER_CELL,
        )
    assert empty.value.condition == "incomplete_day"


def test_a_null_headline_feature_is_refused_rather_than_zeroed(
    nullable_serving_rows: list[dict[str, Any]],
    base_fit_rows: list[dict[str, Any]],
    loaded: LoadedArtifact,
    target_day: date,
) -> None:
    """``null_headline_feature`` — the gap this ticket found rather than closed.

    The whole weather block arrives from one run and goes NULL together, and
    three of the eight *real* headline features are in it. ``observed`` and
    ``typical`` are required numbers on every one of the sixteen driver rows —
    ``apps/api/src/diagnosis/publication.ts`` reads both through ``num()`` — and
    there is no ``observed_absent_reason`` beside them, so a day with a missing
    weather run has no publishable pair for those bars.

    The two alternatives are both invisible once stored: a zero is the invented
    number the spec is against, and a mean over the hours that happened to carry
    a reading is a *different* "typical" than the one ``v(∅)`` was averaged over,
    published under the same name. So it refuses, and api-surface 10 carries the
    box.
    """
    with pytest.raises(DiagnosisPublicationRefusedError) as refused:
        build_diagnosis_publication(
            nullable_serving_rows,
            base_fit_rows,
            lane=LANE,
            loaded=loaded,
            target_date=target_day,
            published_at=publication_instant(
                nullable_serving_rows, target_date=target_day
            ),
            rows_per_cell=TEST_ROWS_PER_CELL,
        )
    assert refused.value.condition == "null_headline_feature"
    assert "invented" not in refused.value.reason
    assert "no value" in refused.value.reason


def test_a_realistic_window_refuses_because_the_weather_block_has_gaps(
    serving_rows: list[dict[str, Any]],
    loaded: LoadedArtifact,
    target_day: date,
) -> None:
    """How big the gap above is, measured rather than characterised.

    The pair is refused if the headline feature is NULL *anywhere* in the day or
    in its background cells, and a background is 128 rows per cell over months
    of days. At the fixture's own 5% per-day weather-null rate — which is there
    because a NULL feature is the case the no-imputation rule is about — a
    window of base-fit length contains gaps with near-certainty.

    So this is not a corner case. Until the wire can say "this bar has no
    reading", a base-fit-drawn attribution refuses on any window with a missing
    weather run in it, which is most real ones. That is the box on api-surface
    10, and this test is its size.
    """
    start, end = base_fit_window(loaded)
    realistic = feature_rows(first=start, last=end)
    gaps = sum(1 for row in realistic if row["weather_expected_wind_mwh"] is None)
    assert gaps > 0

    with pytest.raises(DiagnosisPublicationRefusedError) as refused:
        build_diagnosis_publication(
            serving_rows,
            realistic,
            lane=LANE,
            loaded=loaded,
            target_date=target_day,
            published_at=publication_instant(serving_rows, target_date=target_day),
            rows_per_cell=TEST_ROWS_PER_CELL,
        )
    assert refused.value.condition == "null_headline_feature"


def test_every_named_refusal_condition_is_one_a_test_above_produced() -> None:
    """The closed tuple is a census, not a list of intentions."""
    assert set(REFUSAL_CONDITIONS) == {
        "no_base_fit_window",
        "no_matched_background",
        "contract_and_groups_disagree",
        "incomplete_day",
        "null_headline_feature",
    }


# --- the seed, and what it buys ------------------------------------------------


def test_the_background_seed_is_the_artifacts_and_never_the_clock() -> None:
    """Two publications of one day under one artifact draw the same sample.

    Which is what keeps the gateway's digest idempotence real: a redelivered
    task must write nothing, not append a vintage differing only by noise. A
    retrain is a new artifact id and therefore a new draw, which is correct —
    the base-fit window moved.
    """
    once = background_seed("2026-08-29T04:00:00Z")
    assert once == background_seed("2026-08-29T04:00:00Z")
    assert once != background_seed("2026-09-05T04:00:00Z")
    assert 0 <= once < 2**31


def test_the_seed_is_not_read_from_a_clock_anywhere_in_the_module() -> None:
    source = (SOURCE / "diagnosis" / "publish.py").read_text(encoding="utf-8")
    for wall_clock in ("datetime.now", "time.time", "random.seed", "default_rng("):
        assert wall_clock not in source


# --- what a published row says about where its "typical" came from ------------


def test_every_row_says_its_typical_came_from_the_base_fit_block(
    published: Any,
) -> None:
    """The artifact carries no frozen sample, and the row does not pretend one.

    `docs/specs/diagnosis.md`'s first addition to the bundle has not landed —
    see `.scratch/forecaster/issues/30-*`. ``background_source`` is what makes a
    row drawn from the base-fit block at publish time distinguishable from one
    measured against the frozen sample, and the two are different explanations.
    """
    payload = published.as_payload()
    assert payload["attributions"]
    for row in payload["attributions"]:
        assert row["background_source"] == "base_fit"
        assert row["background_rows"] == TEST_ROWS_PER_CELL
        assert row["background_seed"] == background_seed(
            payload["forecast_origin"]["run_label"]
        )


def test_the_publication_is_the_shape_the_gateway_already_parses(
    published: Any, target_day: date
) -> None:
    """Sixteen driver rows per subsystem: the day's eight, then the peak hour's.

    ``apps/api/src/diagnosis/publication.ts`` refuses a payload short a driver
    group at either grain, unconditionally, and the cross-language vector in
    ``apps/api/test/fixtures/diagnosis/attribution.json`` is that parser's
    fixture. This asserts the *assembled* payload meets the same invariants, so
    the route and the vector cannot drift apart silently.
    """
    payload = published.as_payload()
    assert payload["lane"] == LANE.directory_name
    assert payload["target_date"] == target_day.isoformat()
    assert payload["forecast_origin"]["origin_kind"] == "served"
    assert payload["forecast_origin"]["gate_profile"] == GATE_PROFILE
    assert payload["subsystems"] == [
        code for code in SUBSYSTEM_CODES if code in payload["subsystems"]
    ]
    for row in payload["attributions"]:
        assert row["target"] == "expected_mwh_day"
        assert row["hours_attributed"] == 24
        assert len(row["groups"]) == len(DRIVER_GROUP_CODES)
        assert len(row["peak_hour_groups"]) == len(DRIVER_GROUP_CODES)
        assert [one["rank"] for one in row["groups"]] == list(
            range(1, len(DRIVER_GROUP_CODES) + 1)
        )
        assert math.fsum(one["share"] for one in row["groups"]) == pytest.approx(1.0)
        # The shares are over all eight, and the denominator is the one the
        # attribution computed rather than one recomputed here.
        assert row["sum_abs_attributed_mwh"] > 0.0
        assert row["total_attributed_mwh"] == pytest.approx(
            row["day_expected_mwh"] - row["baseline_expected_mwh"],
            abs=1e-9 * max(1.0, abs(row["day_expected_mwh"])),
        )
        for one in row["groups"]:
            assert one["headline_feature"]
            assert one["unit"]
            assert math.isfinite(one["observed"])
            assert math.isfinite(one["typical"])


# --- the rules ran, and the module writes nothing -----------------------------


def test_the_publish_path_cannot_produce_an_unflagged_row(published: Any) -> None:
    """The roll call reaches the row, and it reaches it through the one call.

    api-surface 10 closed the "a publish path that skips the rules fails" box by
    removing the defaults from ``rule_flags`` and ``rules_evaluated`` and
    refusing an empty roll call in ``_assert_the_rules_ran``. This asserts the
    other half — that this path spells the three fields through
    ``RuleOutcome.for_row()`` rather than listing them, so a future edit cannot
    quietly hand over a roll call it made up — read off the AST rather than off
    a comment.
    """
    source = (SOURCE / "diagnosis" / "publish.py").read_text(encoding="utf-8")
    assert "apply_rules(" in source
    constructions = [
        node
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "AttributionRow"
    ]
    assert constructions
    for call in constructions:
        supplied = {keyword.arg for keyword in call.keywords}
        # `None` is the AST's spelling of `**outcome.for_row()`.
        assert None in supplied
        assert "rule_flags" not in supplied
        assert "rules_evaluated" not in supplied

    # And it reaches the payload: every row names the rules that were evaluated,
    # and `governing_rule_action` is `None` when none fired — an absence, not a
    # fourth action.
    for row in published.as_payload()["attributions"]:
        assert isinstance(row["rule_flags"], list)
        assert len(row["rules_evaluated"]) > 0
        assert row["governing_rule_action"] in {None, "annotate", "demote", "withhold"}


def test_a_subsystem_with_no_reason_mix_is_absent_and_never_zeroed() -> None:
    """``recent_reasons`` arrives per subsystem, and an absence stays one.

    api-surface 10 built the read (``diagnosis/reason-mix.ts``) and the wire
    half (``reason_mixes_from_payload``). What this module must not do is
    manufacture a mix for a subsystem the worker did not supply one for: an
    empty ``ReasonMix`` would be a rule deciding, from no data, that nothing was
    restricted.
    """
    source = (SOURCE / "diagnosis" / "publish.py").read_text(encoding="utf-8")
    assert "recent_reasons: Mapping[Subsystem, ReasonMix] | None = None" in source
    # No constructor call and no default mix: the only thing done to the map is
    # a lookup that yields `None` for an absent subsystem.
    assert "ReasonMix(" not in source
    assert "(recent_reasons or {}).get(subsystem)" in source


def test_a_malformed_reason_block_is_refused_at_the_route() -> None:
    """A dropped mix is indistinguishable from an absent day.

    So the route refuses the request rather than silently explaining the day
    with one fewer input than the caller believes it supplied. Refused *before*
    the artifact is loaded, because a 503 about the volume would send an
    operator to the wrong service.
    """
    response = client.post(
        PATH,
        json={"lane": LANE.directory_name, "recent_reasons": {"SIN": {"shares": {}}}},
    )
    assert response.status_code == 422
    failure = response.json()["error"]
    assert failure["code"] == "REQUEST_INVALID"
    assert "SIN" in failure["message"]

    # And the positive case beside it: a well-formed block gets past this check
    # and reaches the artifact refusal, so the 422 above is the block and not
    # the presence of the field.
    accepted = client.post(
        PATH,
        json={
            "lane": LANE.directory_name,
            "recent_reasons": {
                "NE": {"settled_date": "2026-03-02", "shares": {"REL": 1.0}}
            },
        },
    )
    assert accepted.status_code == 503
    assert accepted.json()["error"]["code"] == "MODEL_UNAVAILABLE"


def test_the_modelling_service_writes_nothing_on_this_path() -> None:
    """The read-only guarantee, as an import graph rather than a promise."""
    source = (SOURCE / "diagnosis" / "publish.py").read_text(encoding="utf-8")
    for write in ("INSERT", "insert(", "execute(", "create_engine", "asyncpg"):
        assert write not in source


# --- the scale run, behind the existing gate ----------------------------------


@pytest.mark.skipif(
    not os.environ.get("WATTSTEER_SCALE_TESTS"),
    reason=(
        "The publication at the spec's sample: 128 rows per cell over a widened "
        "base-fit window, four subsystems, ~3.1M row evaluations through the "
        "real boosters. Every invariant it checks is covered above at four rows "
        "per cell; what it uniquely provides is that the *route's own* sample "
        "size assembles a whole publication. Run it with WATTSTEER_SCALE_TESTS=1, "
        "or `bun run ml:test:scale`."
    ),
)
def test_the_whole_publication_assembles_at_the_specs_sample(
    trained: TrainedFold,
    loaded: LoadedArtifact,
    serving_rows: list[dict[str, Any]],
    target_day: date,
    record_property: Any,
) -> None:
    """The route's default, run once, with the wall clock recorded.

    The fixture fold's base-fit window is thirty days and the sample needs 128,
    so the window is widened to the 160 days a 128-row cell needs — the same
    widening `test_day_attribution.py`'s scale run does, and the reason
    forecaster 30 asks for the sample to be frozen in the bundle rather than
    redrawn from whatever window is readable at publish time.
    """
    widened = feature_rows(
        first=trained.blocks.base_fit_end - timedelta(days=159),
        last=trained.blocks.base_fit_end,
        # No weather gaps, which is what this run needs and *not* what a real
        # 160-day window looks like — see
        # `test_a_realistic_window_refuses_because_the_weather_block_has_gaps`.
        # What this test measures is the wall clock of the route's own sample
        # size, and a refusal on hour three would measure nothing.
        weather_null_rate=0.0,
    )
    started = datetime.now(tz=UTC)
    publication = build_diagnosis_publication(
        serving_rows,
        widened,
        lane=LANE,
        loaded=loaded,
        target_date=target_day,
        published_at=publication_instant(serving_rows, target_date=target_day),
    )
    elapsed = (datetime.now(tz=UTC) - started).total_seconds()
    record_property("diagnosis_publication_seconds", elapsed)

    assert len(publication.rows) == len(SUBSYSTEM_CODES)
    for row in publication.as_payload()["attributions"]:
        assert row["background_rows"] == BACKGROUND_ROWS_PER_CELL == 128
        assert row["background_source"] == "base_fit"
        assert row["coalitions"] == 256
    print(
        f"\ndiagnosis publication: {len(publication.rows)} subsystems in {elapsed:.1f} s"
    )
