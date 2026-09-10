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

**"Typical" is measured and not invented, and the row says which measurement.**
Since forecaster 30 the artifact carries its own ``B(s, h)``, so a published row
says ``background_source: artifact`` with the seed the *training run* stamped —
and a publication with no base-fit rows at all still assembles, which is this
suite's sharpest statement that the frozen sample is used and not redrawn. The
publish-time draw is still exercised, on a bundle with the field deleted (the
``pre_thirty`` fixture, which is the shape ``joblib.load`` produces for an
artifact written before the ticket): it says ``base_fit``, its seed is the
artifact id's, and a short base-fit window refuses rather than thinning one
hour's typical.

**Over the wire.** That a real assembly produces the payload shape the
gateway's ``parseAttributionPublication`` already accepts — sixteen driver rows,
eight per grain, per subsystem — and that the route computes nothing before it
has an artifact.
"""

from __future__ import annotations

import ast
import math
import os
from dataclasses import replace
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
from wattsteer_ml.diagnosis.driver_groups import DRIVER_GROUP_CODES
from wattsteer_ml.diagnosis.publication import (
    READING_ABSENCE_REASONS,
    AttributionPublicationError,
    DriverReading,
)
from wattsteer_ml.diagnosis.publish import (
    REFUSAL_CONDITIONS,
    DiagnosisPublicationRefusedError,
    background_seed,
    base_fit_window,
    build_diagnosis_publication,
)
from wattsteer_ml.lanes import Lane
from wattsteer_ml.publication import publication_instant
from wattsteer_ml.training import FeatureBlock, LoadedArtifact, TrainedFold
from wattsteer_ml.training.background import (
    BACKGROUND_ROWS_PER_CELL,
    draw_artifact_background,
)

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
def loaded(trained: TrainedFold, base_fit_rows: list[dict[str, Any]]) -> LoadedArtifact:
    """The artifact as forecaster 30 writes it: carrying its own ``B(s, h)``.

    The frozen sample is *redrawn here* from the null-free base-fit rows rather
    than taken off ``trained.bundle``, and the reason is the gap
    :func:`test_a_realistic_window_refuses_because_the_weather_block_has_gaps`
    measures: the shared fixture fold is generated at the harness's own 5%
    weather-null rate, so its frozen background contains NULL headline features
    and every publication from it is a ``null_headline_feature`` refusal —
    which is the *real* behaviour of a real window and is asserted as such
    below, not something to be worked around silently.

    So the redraw is the same call the training run makes, on the same block
    with the weather present, at the sample size this module runs at. What it
    buys the tests below is a day that assembles; what it does not do is
    weaken any of them, because nothing here reads the row values.
    """
    block = FeatureBlock.of(
        base_fit_rows, trained.bundle.contract, threshold_mw=trained.bundle.threshold_mw
    )
    background = draw_artifact_background(block, rows_per_cell=TEST_ROWS_PER_CELL)
    bundle = replace(trained.bundle, background=background)
    return LoadedArtifact(
        artifact_id=trained.card.artifact_id,
        bundle=bundle,
        card=replace(trained.card, background=background).to_dict(),
    )


@pytest.fixture(scope="module")
def pre_thirty(trained: TrainedFold) -> LoadedArtifact:
    """The artifact the publish-time fallback exists for, and the only one.

    A bundle written before forecaster 30 has no ``background`` **attribute** —
    ``joblib.load`` reconstructs an object without running ``__init__``, so the
    field is absent rather than ``None`` — and ``load_artifact`` refuses it. It
    is reachable in this suite and nowhere else, and it is what keeps
    ``_background``'s redraw and every refusal below from being dead code
    asserted against nothing.

    ``object.__delattr__`` and not a subclass or a mock: the value under test
    has to be a real :class:`HurdleBundle` reaching the real branch, and this
    is precisely the shape the unpickle produces.
    """
    bundle = replace(trained.bundle)
    object.__delattr__(bundle, "background")
    assert not hasattr(bundle, "background")
    return LoadedArtifact(
        artifact_id=trained.card.artifact_id,
        bundle=bundle,
        card=trained.card.to_dict(),
    )


@pytest.fixture(scope="module")
def base_fit_rows(trained: TrainedFold) -> list[dict[str, Any]]:
    """The artifact's own base-fit window, read as the route reads it."""
    return feature_rows(
        first=trained.blocks.base_fit_start,
        last=trained.blocks.base_fit_end,
        weather_null_rate=0.0,
    )


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
    pre_thirty: LoadedArtifact,
    target_day: date,
) -> None:
    """The guard that matters, proved to fail — and proved not to fail vacuously.

    On ``pre_thirty``, because since forecaster 30 this is the redraw's guard
    and the redraw only runs for a bundle with no frozen sample. The same short
    window now fails at *training* instead, which is
    :func:`test_hurdle_training.\
test_a_window_too_short_for_the_background_fails_at_training`.

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
            loaded=pre_thirty,
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
        loaded=pre_thirty,
        target_date=target_day,
        published_at=publication_instant(serving_rows, target_date=target_day),
        rows_per_cell=TEST_ROWS_PER_CELL,
    ).rows


def test_an_empty_base_fit_window_is_a_refusal_and_not_a_pooled_sample(
    serving_rows: list[dict[str, Any]],
    pre_thirty: LoadedArtifact,
    target_day: date,
) -> None:
    with pytest.raises(DiagnosisPublicationRefusedError) as refused:
        build_diagnosis_publication(
            serving_rows,
            [],
            lane=LANE,
            loaded=pre_thirty,
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


def test_a_null_headline_feature_publishes_the_bar_with_a_stated_absence(
    nullable_serving_rows: list[dict[str, Any]],
    base_fit_rows: list[dict[str, Any]],
    loaded: LoadedArtifact,
    target_day: date,
) -> None:
    """The box api-surface 10 carried, closed the way it said to close it.

    The whole weather block arrives from one run and goes NULL together, and
    three of the eight *real* headline features are in it. That used to refuse
    the day: ``observed`` and ``typical`` were required numbers on all sixteen
    driver rows and there was nowhere to say the pair was unavailable.

    Now the absence is a value. The pair goes ``None`` beside a reason from the
    closed vocabulary, the bar keeps its ``φ``, its sign, its share and its
    rank — which the boosters computed and a missing subtitle does not touch —
    and the day publishes. What is asserted here is the *whole* of that:

    - the publication exists and covers every subsystem;
    - at least one bar has no ``observed``, and its reason is ``null_in_day``;
    - **no bar reports a zero or a NaN where a reading is absent**, which is
      the failure the old refusal existed to prevent;
    - a group whose headline feature is *not* in the weather block still
      reports both halves, so the absence is the NULL and not the plumbing.
    """
    publication = build_diagnosis_publication(
        nullable_serving_rows,
        base_fit_rows,
        lane=LANE,
        loaded=loaded,
        target_date=target_day,
        published_at=publication_instant(nullable_serving_rows, target_date=target_day),
        rows_per_cell=TEST_ROWS_PER_CELL,
    )
    assert publication.rows
    assert set(publication.subsystems) == set(SUBSYSTEM_CODES)

    bars = [
        one
        for row in publication.as_payload()["attributions"]
        for key in ("groups", "peak_hour_groups")
        for one in row[key]
    ]
    absent = [one for one in bars if one["observed"] is None]
    assert absent, "the weather block is NULL for every hour; some bar has no reading"
    for one in absent:
        assert one["observed_absent_reason"] == "null_in_day"
        assert one["headline_feature"].startswith("weather_")
    # The other half of the pair is a different question with a different
    # answer: this fixture's base-fit rows are gap-free, so `typical` is a
    # number even where `observed` is not. An absence is per side.
    for one in bars:
        assert one["typical"] is not None
        assert one["typical_absent_reason"] is None
        # Neither a zero nor a NaN stands in for an absence anywhere.
        if one["observed"] is None:
            assert one["observed_absent_reason"] in READING_ABSENCE_REASONS
        else:
            assert math.isfinite(one["observed"])
            assert one["observed_absent_reason"] is None
    # And the ranking is intact: eight bars at each grain, shares summing to 1.
    for row in publication.as_payload()["attributions"]:
        assert len(row["groups"]) == len(DRIVER_GROUP_CODES)
        assert math.fsum(one["share"] for one in row["groups"]) == pytest.approx(1.0)


def test_a_reading_is_a_number_or_a_stated_absence_and_never_both(
    nullable_serving_rows: list[dict[str, Any]],
) -> None:
    """The guard on the pair, proved to fail in both directions.

    A number beside a reason, and a reason beside no number, are the two shapes
    that would let an absence be read as a zero or as a dropped field. Both are
    refused, and the positive case beside them is the ordinary reading. The
    NaN refusal survives too: a NaN is what a NULL column reads as in a matrix,
    and only :func:`headline_readings` may turn one into an absence — a NaN
    arriving here is a computation that went wrong.
    """
    assert nullable_serving_rows  # the fixture this file's absence comes from

    assert DriverReading(feature="f", unit="MW", observed=1.0, typical=2.0)
    assert DriverReading(
        feature="f",
        unit="MW",
        observed=None,
        typical=2.0,
        observed_absent_reason="null_in_day",
    )

    with pytest.raises(AttributionPublicationError, match="never both"):
        DriverReading(
            feature="f",
            unit="MW",
            observed=1.0,
            typical=2.0,
            observed_absent_reason="null_in_day",
        )
    with pytest.raises(AttributionPublicationError, match="never neither"):
        DriverReading(feature="f", unit="MW", observed=None, typical=2.0)
    with pytest.raises(AttributionPublicationError, match="not one of"):
        DriverReading(
            feature="f",
            unit="MW",
            observed=None,
            typical=2.0,
            observed_absent_reason="because",  # type: ignore[arg-type]
        )
    with pytest.raises(AttributionPublicationError, match="nan"):
        DriverReading(feature="f", unit="MW", observed=float("nan"), typical=2.0)


def test_a_realistic_window_publishes_where_it_used_to_refuse(
    serving_rows: list[dict[str, Any]],
    pre_thirty: LoadedArtifact,
    target_day: date,
) -> None:
    """How big the old refusal was, measured — and that it is gone.

    The pair was refused if the headline feature was NULL *anywhere* in the day
    or in its background cells, and a background is 128 rows per cell drawn
    over months of days. At the feature fixture's own 5%-per-row weather-null
    rate — which is there because a NULL feature is the case the no-imputation
    rule is about — a window of base-fit length contains gaps with near
    certainty, so the old contract refused the whole day on most real windows.

    This is the same window, asserted to have gaps first so the test cannot
    pass vacuously, and it now publishes: the weather bars say
    ``null_in_background`` and every other bar carries its pair.
    """
    start, end = base_fit_window(pre_thirty)
    realistic = feature_rows(first=start, last=end)
    gaps = sum(1 for row in realistic if row["weather_expected_wind_mwh"] is None)
    assert gaps > 0

    publication = build_diagnosis_publication(
        serving_rows,
        realistic,
        lane=LANE,
        loaded=pre_thirty,
        target_date=target_day,
        published_at=publication_instant(serving_rows, target_date=target_day),
        rows_per_cell=TEST_ROWS_PER_CELL,
    )
    assert publication.rows

    bars = [
        one
        for row in publication.as_payload()["attributions"]
        for key in ("groups", "peak_hour_groups")
        for one in row[key]
    ]
    without_typical = [one for one in bars if one["typical"] is None]
    assert without_typical
    for one in without_typical:
        assert one["typical_absent_reason"] == "null_in_background"
    # `serving_rows` has no weather NULL, so the day's own side is intact —
    # which is what makes the absence above the *background's* and nothing else.
    for one in bars:
        assert one["observed"] is not None
        assert one["observed_absent_reason"] is None


def test_every_named_refusal_condition_is_one_a_test_above_produced() -> None:
    """The closed tuple is a census, not a list of intentions.

    ``null_headline_feature`` was the fifth and is deliberately not here: it is
    no longer a refusal but a stated absence on the row, which the two tests
    above measure. A refusal condition with no test is what this asserts
    against, and a *removed* condition with a test still on file is the same
    drift in the other direction.
    """
    assert set(REFUSAL_CONDITIONS) == {
        "no_base_fit_window",
        "no_matched_background",
        "contract_and_groups_disagree",
        "incomplete_day",
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


def test_every_row_says_its_typical_came_from_the_artifact(
    published: Any, loaded: LoadedArtifact
) -> None:
    """The frozen sample reaches the wire, and it says so — forecaster 30.

    Three of the four facts on the row are read off the bundle's own sample
    rather than restated here, so a publish path that redrew one while the
    artifact held another cannot pass: the seed in particular is the training
    run's stamp and is **not** :func:`background_seed`, which is what the
    fallback derives from the artifact id. The two are asserted to differ,
    because equal values would make this test unable to tell the paths apart.
    """
    payload = published.as_payload()
    assert payload["attributions"]
    frozen = loaded.bundle.background
    assert frozen.source == "artifact"
    assert frozen.seed != background_seed(loaded.artifact_id)
    for row in payload["attributions"]:
        assert row["background_source"] == "artifact"
        assert row["background_rows"] == frozen.rows_per_cell == TEST_ROWS_PER_CELL
        assert row["background_seed"] == frozen.seed


def test_the_frozen_sample_is_used_and_the_window_is_not_read_again(
    serving_rows: list[dict[str, Any]],
    loaded: LoadedArtifact,
    target_day: date,
) -> None:
    """A publication with **no** base-fit rows at all still publishes.

    The sharpest available statement that the frozen sample is *used* rather
    than redrawn: the same empty argument that is a ``no_matched_background``
    refusal for a pre-30 bundle —
    :func:`test_an_empty_base_fit_window_is_a_refusal_and_not_a_pooled_sample`
    — assembles a whole publication here, and every row is stamped
    ``artifact``. The two tests are each other's control.
    """
    publication = build_diagnosis_publication(
        serving_rows,
        [],
        lane=LANE,
        loaded=loaded,
        target_date=target_day,
        published_at=publication_instant(serving_rows, target_date=target_day),
    )
    assert len(publication.rows) == len(SUBSYSTEM_CODES)
    assert {row.attribution.background_source for row in publication.rows} == {"artifact"}


def test_the_fallback_still_says_base_fit_on_a_bundle_with_no_sample(
    serving_rows: list[dict[str, Any]],
    base_fit_rows: list[dict[str, Any]],
    pre_thirty: LoadedArtifact,
    target_day: date,
) -> None:
    """The distinction, on the other branch. Not deleted, and not confusable.

    ``background_source`` has two possible values and this suite produces both,
    which is the only thing that makes the field worth storing: a row measured
    against a publish-time draw of the base-fit window stays distinguishable
    from one measured against the artifact's own sample, and the seed says
    which derivation produced it.
    """
    publication = build_diagnosis_publication(
        serving_rows,
        base_fit_rows,
        lane=LANE,
        loaded=pre_thirty,
        target_date=target_day,
        published_at=publication_instant(serving_rows, target_date=target_day),
        rows_per_cell=TEST_ROWS_PER_CELL,
    )
    payload = publication.as_payload()
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
            # A reading is a finite number or a stated absence, and the two
            # keys always travel: an omitted reason and "there is a number"
            # would be the same bytes to a reader looking for the absence.
            for half in ("observed", "typical"):
                reason = one[f"{half}_absent_reason"]
                if one[half] is None:
                    assert reason in READING_ABSENCE_REASONS
                else:
                    assert math.isfinite(one[half])
                    assert reason is None


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
    pre_thirty: LoadedArtifact,
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
        loaded=pre_thirty,
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
