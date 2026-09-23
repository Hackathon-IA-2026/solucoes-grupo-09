"""The reviewed day: four subsystems against their bands, and the day's two gates.

`wattsteer_ml.replay.review` says what it computes and why each figure is
allowed. These tests assert the properties that would have to hold for that to
be true — that a band appears only where the replayable predicate would answer
from it, that every absence carries its reason, that the national band is read
from one publication and never assembled, and that a leaking artifact is a
`500` here exactly as it is on `/v1/replay`.
"""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from wattsteer_ml.app import (
    app,
    national_source,
    pinned_attribution_source,
    replay_compare,
    replay_inputs_source,
    replay_timeline,
)
from wattsteer_ml.config import settings
from wattsteer_ml.evaluation.serving_lanes import EARLY_LANE, LATE_LANE
from wattsteer_ml.lanes import Lane
from wattsteer_ml.mixture import QuantileBand
from wattsteer_ml.publication import (
    BACKFILLED_HOLDOUT_ORIGIN_KIND,
    PRODUCER,
    SERVED_ORIGIN_KIND,
)
from wattsteer_ml.replay.calendar import HOURS_PER_DAY, DayEvidence
from wattsteer_ml.replay.inputs import ReplayInputs, SettledVintage
from wattsteer_ml.replay.review import NationalDay, PinnedAttribution, placement
from wattsteer_ml.replay.scoring import (
    ForecastHour,
    ObservedDay,
    PinnedForecast,
    PinnedOrigin,
)

REPO = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO / "packages" / "core" / "schema"
BASE = "https://wattsteer.com/schema/"

client = TestClient(app)

#: Inside F3's test period.
DAY = date(2025, 11, 12)
GATE_LATE = datetime(2025, 11, 11, 22, 0, tzinfo=UTC)
GATE_EARLY = datetime(2025, 11, 11, 12, 0, tzinfo=UTC)
BACKTEST_RAN = datetime(2026, 9, 19, 3, 58, tzinfo=UTC)
ARTIFACT_ID = "2025-10-01T03:10:00Z"

CARD = {
    "fold": {"fold_id": "F3"},
    "data": {
        "training_window": {"start": "2024-04-01", "end": "2025-09-30"},
        "calibration_window": {"start": "2025-07-03", "end": "2025-09-30"},
    },
}
LEAKING_CARD = {
    "fold": {"fold_id": "F6"},
    "data": {
        "training_window": {"start": "2024-04-01", "end": "2026-06-30"},
        "calibration_window": {"start": "2026-04-02", "end": "2026-06-30"},
    },
}

#: Every settled hour is 10 MWh, so a day is 240 — and a band built around
#: other numbers makes a field read into the wrong slot visible.
SETTLED_HOUR = 10.0
DAY_BAND = QuantileBand(p10=180.0, p50=300.0, p90=520.0)


def _registry() -> Registry[Any]:
    registry: Registry[Any] = Registry()
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        registry = registry.with_resource(
            BASE + path.name,
            Resource.from_contents(json.loads(path.read_text(encoding="utf-8"))),
        )
    return registry


REGISTRY = _registry()


def validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(
        json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8")), registry=REGISTRY
    )


COMPARE = validator("replay-compare.schema.json")
TIMELINE = validator("replay-timeline.schema.json")


def pinned(
    subsystem: str,
    lane: Lane,
    *,
    origin_kind: str = BACKFILLED_HOLDOUT_ORIGIN_KIND,
    published_at: datetime = GATE_LATE,
    band: QuantileBand = DAY_BAND,
) -> PinnedForecast:
    hour = QuantileBand(p10=5.0, p50=12.0, p90=25.0)
    return PinnedForecast(
        subsystem=subsystem,
        target_date=DAY,
        threshold_mw=5.0,
        origin=PinnedOrigin(
            producer=PRODUCER,
            run_label=ARTIFACT_ID,
            published_at=published_at,
            origin_kind=origin_kind,
            gate_profile=lane.gate_profile,
        ),
        hours=tuple(
            ForecastHour(
                constrained_off_mwh=hour, expected_mwh=13.0, occurrence_probability=0.8
            )
            for _ in range(HOURS_PER_DAY)
        ),
        day_total=band,
        peak_power=QuantileBand(p10=8.0, p50=20.0, p90=40.0),
        day_occurrence_probability=0.9,
    )


def day_inputs(
    subsystem: str,
    lane: Lane = LATE_LANE,
    *,
    with_forecast: bool = True,
    observed_hours: int = HOURS_PER_DAY,
    origin_kind: str = BACKFILLED_HOLDOUT_ORIGIN_KIND,
    published_at: datetime = GATE_LATE,
    band: QuantileBand = DAY_BAND,
    restated_rows: int = 0,
) -> ReplayInputs:
    complete = observed_hours == HOURS_PER_DAY
    return ReplayInputs(
        evidence=DayEvidence(
            target_date=DAY,
            origin_kind=origin_kind if with_forecast else None,
            artifact_id=ARTIFACT_ID if with_forecast else None,
            observed_hours=observed_hours,
            candidate_lanes=(lane.directory_name,),
        ),
        forecast=(
            pinned(
                subsystem,
                lane,
                origin_kind=origin_kind,
                published_at=published_at,
                band=band,
            )
            if with_forecast
            else None
        ),
        observed=(
            ObservedDay(
                subsystem=subsystem,
                target_date=DAY,
                hours=tuple(SETTLED_HOUR for _ in range(HOURS_PER_DAY)),
                data_version="2" if restated_rows else "1",
            )
            if complete
            else None
        ),
        episodes=(),
        sources=(),
        threshold_mw=5.0,
        forecast_written_at=BACKTEST_RAN if with_forecast else None,
        settled_vintage=(
            SettledVintage(
                data_version="2" if restated_rows else "1",
                earliest_ingested_at=datetime(2025, 11, 13, 22, 5, tzinfo=UTC),
                latest_ingested_at=(
                    datetime(2026, 3, 2, 10, 0, tzinfo=UTC)
                    if restated_rows
                    else datetime(2025, 11, 13, 22, 5, tzinfo=UTC)
                ),
                entity_rows=480,
                restated_rows=restated_rows,
            )
            if observed_hours
            else None
        ),
    )


@pytest.fixture
def volume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for lane in (EARLY_LANE, LATE_LANE):
        lane_dir = tmp_path / lane.directory_name
        lane_dir.mkdir(parents=True)
        card = {**CARD, "lane": {"directory": lane.directory_name}}
        (lane_dir / f"{ARTIFACT_ID}.card.json").write_text(
            json.dumps(card), encoding="utf-8"
        )
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    return tmp_path


Reader = Callable[..., ReplayInputs]


@contextmanager
def serve(read: Reader, national: NationalDay | None = None) -> Iterator[TestClient]:
    app.dependency_overrides[replay_inputs_source] = lambda: read
    app.dependency_overrides[national_source] = lambda: lambda **_kwargs: national
    try:
        yield client
    finally:
        app.dependency_overrides.clear()


def by_subsystem(table: dict[str, ReplayInputs]) -> Reader:
    def read(*, subsystem: str, **_kwargs: Any) -> ReplayInputs:
        return table[subsystem]

    return read


def every(**overrides: Any) -> dict[str, ReplayInputs]:
    return {code: day_inputs(code, **overrides) for code in ("N", "NE", "SE", "S")}


def compare(read: Reader, national: NationalDay | None = None) -> Any:
    with serve(read, national) as api:
        return api.get(
            f"/v1/replay/compare/{DAY.isoformat()}",
            params={"lane": LATE_LANE.directory_name},
        )


def timeline(read: Reader) -> Any:
    with serve(read) as api:
        return api.get(
            f"/v1/replay/timeline/{DAY.isoformat()}", params={"subsystem": "NE"}
        )


JOINT = NationalDay(
    day_total=QuantileBand(p10=900.0, p50=1100.0, p90=1500.0),
    run_label=ARTIFACT_ID,
    subsystems=("N", "NE", "SE", "S"),
)


# --- the handlers ---------------------------------------------------------------


def test_the_handlers_are_defs_because_the_reader_bridges_from_a_thread() -> None:
    """`replay_input_source` awaits on the loop a worker thread came from."""
    assert not inspect.iscoroutinefunction(replay_compare)
    assert not inspect.iscoroutinefunction(replay_timeline)


def test_no_database_is_a_503_rather_than_an_invented_comparison() -> None:
    app.dependency_overrides[replay_inputs_source] = lambda: None
    app.dependency_overrides[national_source] = lambda: None
    try:
        response = client.get(
            f"/v1/replay/compare/{DAY.isoformat()}",
            params={"lane": LATE_LANE.directory_name},
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "DATA_UNAVAILABLE"
    finally:
        app.dependency_overrides.clear()


# --- the comparison ---------------------------------------------------------------


def test_a_replayable_day_carries_its_band_its_settled_total_and_the_deviation(
    volume: Path,
) -> None:
    response = compare(by_subsystem(every()))
    assert response.status_code == 200
    body = response.json()
    COMPARE.validate(body)
    assert [row["subsystem"] for row in body["subsystems"]] == ["N", "NE", "SE", "S"]
    ne = body["subsystems"][1]
    assert ne["replayable"] is True
    assert ne["provenance"] == "fold_holdout"
    assert ne["day_total"] == {"p10": 180.0, "p50": 300.0, "p90": 520.0}
    # 24 × 10 — a sum of measurements, which is the one kind of sum allowed.
    assert ne["settled_total_mwh"] == 240.0
    assert ne["deviation_mwh"] == -60.0
    assert ne["placement"] == "inside"
    assert ne["forecast_origin"]["origin_kind"] == BACKFILLED_HOLDOUT_ORIGIN_KIND


def test_an_unsettled_day_keeps_its_band_and_says_why_the_total_is_absent(
    volume: Path,
) -> None:
    table = every()
    table["NE"] = day_inputs("NE", observed_hours=17)
    body = compare(by_subsystem(table)).json()
    COMPARE.validate(body)
    ne = body["subsystems"][1]
    # The held-out assertion ran before the settled-hours clause, so the band is
    # as honest as a replayable day's. Only the denominator is missing.
    assert ne["refusal_code"] == "REPLAY_OBSERVATION_INCOMPLETE"
    assert ne["day_total"] is not None
    assert ne["settled_total_mwh"] is None
    assert ne["settled_unavailable_reason"] == "day_not_settled"
    assert ne["settled_hours"] == 17
    assert ne["deviation_mwh"] is None
    assert ne["placement"] is None


def test_a_subsystem_with_no_held_out_forecast_is_a_row_with_its_reason(
    volume: Path,
) -> None:
    table = every()
    table["S"] = day_inputs("S", with_forecast=False)
    body = compare(by_subsystem(table)).json()
    COMPARE.validate(body)
    south = body["subsystems"][3]
    assert south["day_total"] is None
    assert south["day_total_unavailable_reason"] == "REPLAY_FORECAST_UNAVAILABLE"
    assert south["forecast_origin"] is None
    # The settled day is still a fact about the grid, and it is still shown.
    assert south["settled_total_mwh"] == 240.0


def test_the_national_band_is_the_joint_row_and_the_settled_total_is_the_sum_of_four(
    volume: Path,
) -> None:
    body = compare(by_subsystem(every()), JOINT).json()
    COMPARE.validate(body)
    national = body["national"]
    assert national["day_total"] == {"p10": 900.0, "p50": 1100.0, "p90": 1500.0}
    assert national["settled_total_mwh"] == 960.0
    assert national["settled_derivation"] == "sum_of_four"
    assert national["deviation_mwh"] == -140.0
    # Never four P50s added: 4 × 300 is 1200, and the joint row says 1100.
    assert national["day_total"]["p50"] != 4 * DAY_BAND.p50


def test_four_bands_from_two_publications_have_no_joint_band(volume: Path) -> None:
    table = every()
    table["N"] = day_inputs("N", origin_kind=SERVED_ORIGIN_KIND)
    body = compare(by_subsystem(table), JOINT).json()
    assert body["national"]["day_total"] is None
    assert body["national"]["day_total_unavailable_reason"] == "origins_differ"


def test_a_missing_joint_row_is_named_rather_than_assembled(volume: Path) -> None:
    body = compare(by_subsystem(every()), None).json()
    assert body["national"]["day_total"] is None
    assert body["national"]["day_total_unavailable_reason"] == "no_joint_ensemble"


def test_the_national_settled_total_waits_for_all_four(volume: Path) -> None:
    table = every()
    table["SE"] = day_inputs("SE", observed_hours=20)
    body = compare(by_subsystem(table), JOINT).json()
    assert body["national"]["settled_total_mwh"] is None
    assert body["national"]["settled_unavailable_reason"] == "day_not_settled"
    assert body["national"]["deviation_mwh"] is None


def test_a_leaking_card_is_a_500_here_as_it_is_on_the_replay(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lane_dir = tmp_path / LATE_LANE.directory_name
    lane_dir.mkdir(parents=True)
    card = {**LEAKING_CARD, "lane": {"directory": LATE_LANE.directory_name}}
    (lane_dir / f"{ARTIFACT_ID}.card.json").write_text(json.dumps(card), encoding="utf-8")
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    response = compare(by_subsystem(every()))
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "REPLAY_INTEGRITY_VIOLATION"


def test_no_percentage_is_published(volume: Path) -> None:
    """One day cannot produce an accuracy, and nothing here pretends it can."""
    text = json.dumps(compare(by_subsystem(every()), JOINT).json())
    for word in ("percent", "accuracy", "mape", "error_pct", "ratio"):
        assert word not in text.lower()


def test_placement_counts_both_edges_as_inside() -> None:
    band = QuantileBand(p10=10.0, p50=20.0, p90=30.0)
    assert placement(band, 10.0) == "inside"
    assert placement(band, 30.0) == "inside"
    assert placement(band, 9.99) == "below"
    assert placement(band, 30.01) == "above"


# --- the timeline -----------------------------------------------------------------


def by_lane(early: ReplayInputs, late: ReplayInputs) -> Reader:
    def read(*, lane: Lane, **_kwargs: Any) -> ReplayInputs:
        return early if lane == EARLY_LANE else late

    return read


def test_the_timeline_carries_both_gates_early_first(volume: Path) -> None:
    early = day_inputs(
        "NE", EARLY_LANE, published_at=GATE_EARLY, band=replace(DAY_BAND, p50=340.0)
    )
    late = day_inputs("NE", LATE_LANE)
    response = timeline(by_lane(early, late))
    assert response.status_code == 200
    body = response.json()
    TIMELINE.validate(body)
    assert [gate["gate_profile"] for gate in body["gates"]] == ["gate_early", "gate_late"]
    assert body["gates"][0]["deviation_mwh"] == -100.0
    assert body["gates"][1]["deviation_mwh"] == -60.0


def test_a_reconstruction_says_its_publication_instant_is_counterfactual(
    volume: Path,
) -> None:
    body = timeline(by_lane(day_inputs("NE", EARLY_LANE), day_inputs("NE"))).json()
    for gate in body["gates"]:
        assert gate["published_at_is_counterfactual"] is True
        # Written by the backtest run, long after the gate it stands in for.
        assert gate["written_at"] == "2026-09-19T03:58:00Z"
    published = [
        event for event in body["events"] if event["kind"] == "forecast_published"
    ]
    assert all(event["counterfactual"] is True for event in published)


def test_a_served_forecast_is_not_marked_counterfactual(volume: Path) -> None:
    served = day_inputs("NE", origin_kind=SERVED_ORIGIN_KIND)
    body = timeline(by_lane(day_inputs("NE", EARLY_LANE), served)).json()
    assert body["gates"][1]["published_at_is_counterfactual"] is False


def test_events_are_oldest_first_and_a_restatement_is_its_own_event(
    volume: Path,
) -> None:
    # Both gates read the same settled day; the fixture says so rather than
    # letting the two disagree about ONS's record.
    early = day_inputs("NE", EARLY_LANE, published_at=GATE_EARLY, restated_rows=6)
    late = day_inputs("NE", restated_rows=6)
    body = timeline(by_lane(early, late)).json()
    TIMELINE.validate(body)
    instants = [event["at"] for event in body["events"]]
    assert instants == sorted(instants)
    kinds = [event["kind"] for event in body["events"]]
    assert kinds[0] == "forecast_published"
    assert "settled_written" in kinds
    restated = [event for event in body["events"] if event["kind"] == "settled_restated"]
    assert restated == [
        {
            "kind": "settled_restated",
            "at": "2026-03-02T10:00:00Z",
            "rows": 6,
            "data_version": "2",
        }
    ]
    assert body["settled"]["restated_rows"] == 6


def test_an_unrestated_day_has_no_restatement_event(volume: Path) -> None:
    body = timeline(by_lane(day_inputs("NE", EARLY_LANE), day_inputs("NE"))).json()
    assert all(event["kind"] != "settled_restated" for event in body["events"])


def test_an_unsettled_day_has_a_settled_absence_and_no_settled_event(
    volume: Path,
) -> None:
    early = day_inputs("NE", EARLY_LANE, observed_hours=0)
    late = day_inputs("NE", observed_hours=0)
    body = timeline(by_lane(early, late)).json()
    TIMELINE.validate(body)
    assert body["settled"]["settled_total_mwh"] is None
    assert body["settled"]["settled_unavailable_reason"] == "day_not_settled"
    assert all(not event["kind"].startswith("settled") for event in body["events"])


# --- the attribution --------------------------------------------------------------

ATTRIBUTION = validator("replay-attribution.schema.json")


def pinned_attribution() -> PinnedAttribution:
    driver = {
        "code": "export_stress",
        "label_code": "driver.export_stress",
        "phi_mwh": -42.0,
        "share": 0.61,
        "direction": "lowers",
        "headline_feature": "observed_export_utilisation_mean_24h_to_cutoff",
        "observed": 0.83,
        "typical": None,
        "observed_absent_reason": None,
        "typical_absent_reason": "null_in_background",
        "unit": "ratio",
        "hour_disagreement": 0.12,
        "demoted": False,
    }
    return PinnedAttribution(
        total_attributed_mwh=-42.0,
        sum_abs_attributed_mwh=69.0,
        stderr_mwh=3.5,
        baseline_expected_mwh=354.0,
        day_expected_mwh=312.0,
        driver_group_version="3",
        driver_group_hash="sha256:groups",
        governing_rule_action=None,
        rule_codes=(),
        drivers=(driver,),
    )


def attribution_of(
    read: Reader, found: PinnedAttribution | None, asked: list[dict[str, Any]]
) -> Any:
    def lookup(**query: Any) -> PinnedAttribution | None:
        asked.append(query)
        return found

    app.dependency_overrides[replay_inputs_source] = lambda: read
    app.dependency_overrides[pinned_attribution_source] = lambda: lookup
    try:
        return client.get(
            f"/v1/replay/attribution/{DAY.isoformat()}",
            params={"subsystem": "NE", "lane": LATE_LANE.directory_name},
        )
    finally:
        app.dependency_overrides.clear()


def test_the_attribution_is_read_for_exactly_the_pinned_publication(
    volume: Path,
) -> None:
    asked: list[dict[str, Any]] = []
    response = attribution_of(
        lambda **_kwargs: day_inputs("NE"), pinned_attribution(), asked
    )
    assert response.status_code == 200
    body = response.json()
    ATTRIBUTION.validate(body)
    assert asked == [
        {
            "subsystem": "NE",
            "target_date": DAY,
            "gate_profile": "gate_late",
            "origin_kind": BACKFILLED_HOLDOUT_ORIGIN_KIND,
            "published_at": GATE_LATE,
            "run_label": ARTIFACT_ID,
        }
    ]
    assert body["attribution"]["drivers"][0]["phi_mwh"] == -42.0
    assert body["attribution"]["drivers"][0]["typical"] is None
    assert body["attribution_unavailable_reason"] is None


def test_a_publication_nobody_explained_says_so_rather_than_borrowing_one(
    volume: Path,
) -> None:
    body = attribution_of(lambda **_kwargs: day_inputs("NE"), None, []).json()
    ATTRIBUTION.validate(body)
    assert body["attribution"] is None
    assert body["attribution_unavailable_reason"] == "not_published"


def test_a_day_with_no_band_is_not_asked_for_bars(volume: Path) -> None:
    asked: list[dict[str, Any]] = []
    body = attribution_of(
        lambda **_kwargs: day_inputs("NE", with_forecast=False),
        pinned_attribution(),
        asked,
    ).json()
    ATTRIBUTION.validate(body)
    assert asked == []
    assert body["attribution"] is None
    assert body["attribution_unavailable_reason"] == "no_pinned_forecast"
