"""`GET /v1/model/card` — the card off the volume, or the refusal that says why.

The route is a *read of a document*, so what is worth asserting is not a shape
this module invented but the three things the gateway cannot check for itself:

- the card that comes back is the **promoted** artifact's, never the newest file
  on the volume, which is the whole reason the promotion log exists;
- a lane with nothing to serve refuses with the lane state attached, and the
  mount is reported beside it rather than folded into it;
- an artifact the loader would refuse — one the hot-swap gate marked
  contract-faulted — refuses here too. A card is an audit document and this
  route is not an auditor's, it is the serving model's: publishing a faulted
  artifact's numbers as a served model's would describe a model nothing is
  allowed to run.

`test_app.py`'s state — no database, no mounted volume unless a test makes one —
holds here too.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wattsteer_ml.app import app
from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.config import settings
from wattsteer_ml.lanes import Lane
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionRecord, append
from wattsteer_ml.training import (
    CONTRACT_FAULT_KEY,
    CORRECTION_REGIME,
    GATE_BLOCK_KEY,
    TrainedFold,
    read_card,
    save_artifact,
    write_card,
)

client = TestClient(app)

LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
CARD = f"/v1/model/card?lane={LANE.directory_name}"


def promote(root: Path, artifact_id: str) -> None:
    append(
        root / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=artifact_id,
            lane=LANE,
            decision="promote",
            reason="bootstrap P = 0.94",
            at=datetime(2026, 9, 4, 3, 10, 12, tzinfo=UTC),
        ),
    )


@pytest.fixture
def promoted(
    trained: TrainedFold, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """One real card, written by the trainer and promoted by the log."""
    root = tmp_path / "models"
    root.mkdir()
    save_artifact(trained.bundle, trained.card, root=root)
    promote(root, trained.card.artifact_id)
    monkeypatch.setattr(settings, "artifact_dir", root)
    return root


def test_it_returns_the_promoted_artifacts_card_whole(
    promoted: Path, trained: TrainedFold
) -> None:
    body = client.get(CARD).json()
    assert body["lane"] == LANE.directory_name
    assert body["artifact_id"] == trained.card.artifact_id
    # Verbatim: the document on the volume, not a re-serialisation of it.
    assert body["card"] == read_card(
        promoted / LANE.directory_name / f"{trained.card.artifact_id}{CARD_SUFFIX}"
    )


def test_the_correction_regime_travels_beside_the_card(promoted: Path) -> None:
    """The pair the gateway needs, and the card carries only half of.

    The card records `upper_correction_realised` — how much of `delta_hi`
    actually reached the composed P90 — and the note that says a short
    `coverage_p90` is under-*application* rather than a bad fit. What it does
    not record is the **name of the rule** that applied it, which is stamped on
    every published forecast row instead. Both halves have to leave here or the
    gateway has to mint one, and a regime name minted at the gateway is a claim
    about a correction the gateway did not apply.
    """
    body = client.get(CARD).json()
    assert body["correction_regime"] == CORRECTION_REGIME
    quantiles = body["card"]["quantiles"]
    assert "delta_lo" in quantiles and "delta_hi" in quantiles
    if quantiles.get("coverage") is not None or "coverage_p90" in quantiles:
        assert "upper_correction_realised" in quantiles
        assert "upper_correction_note" in quantiles


def test_the_pit_drop_count_is_on_the_card_that_leaves_here(promoted: Path) -> None:
    """`pit_dropped_days` is a limitation of the published band, not a log line.

    Every national quantile is a quantile of whole-row draws of `U`, and `U`
    holds only the calibration days whose 96 cells are all settled. How many
    days were dropped is therefore how many distinct days the whole day-grain
    band rests on, and it has to be reachable by a reader of the card.
    """
    ensemble = client.get(CARD).json()["card"]["ensemble"]
    assert isinstance(ensemble["pit_dropped_days"], int)
    assert isinstance(ensemble["pit_rows"], int)
    assert ensemble["pit_dropped_days_rule"]


def test_a_lane_with_nothing_promoted_refuses_with_its_state(
    trained: TrainedFold, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The candidate is on the volume and the gate promoted none of it."""
    root = tmp_path / "models"
    root.mkdir()
    save_artifact(trained.bundle, trained.card, root=root)
    monkeypatch.setattr(settings, "artifact_dir", root)

    response = client.get(CARD)
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "MODEL_UNAVAILABLE"
    assert error["details"]["lane_state"] == "present_unpromoted"
    assert error["details"]["volume_mounted"] is True


def test_an_unmounted_volume_is_reported_beside_the_state_not_as_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`no_artifact` is truthful and is not the repair. The mount is."""
    monkeypatch.setattr(settings, "artifact_dir", tmp_path / "absent")

    error = client.get(CARD).json()["error"]
    assert error["code"] == "MODEL_UNAVAILABLE"
    assert error["details"]["lane_state"] == "no_artifact"
    assert error["details"]["volume_mounted"] is False


def test_an_artifact_marked_contract_faulted_is_refused(
    promoted: Path, trained: TrainedFold
) -> None:
    """A card the loader will not load is not a serving model's card."""
    path = promoted / LANE.directory_name / f"{trained.card.artifact_id}{CARD_SUFFIX}"
    card = read_card(path)
    write_card(
        path,
        {**card, GATE_BLOCK_KEY: {CONTRACT_FAULT_KEY: "feature_rows moved under it"}},
    )

    response = client.get(CARD)
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "MODEL_UNAVAILABLE"
    assert error["details"]["lane_state"] == "unresolvable"
    assert error["details"]["contract_fault"]


def test_an_unreadable_card_refuses_rather_than_returning_a_partial_one(
    promoted: Path, trained: TrainedFold
) -> None:
    path = promoted / LANE.directory_name / f"{trained.card.artifact_id}{CARD_SUFFIX}"
    path.write_text("half a document", encoding="utf-8")

    response = client.get(CARD)
    assert response.status_code == 503
    assert response.json()["error"]["details"]["lane_state"] == "unresolvable"


def test_the_two_unresolvable_refusals_are_told_apart_in_details(
    promoted: Path, trained: TrainedFold
) -> None:
    """`unresolvable` alone would name one repair for two situations.

    The envelope vocabulary has three words and neither of the other two is
    true of a lane whose promote line is sound: it has an artifact and a
    decision about it. So this refusal and the one a corrupt promotion log
    produces share a word, and without a discriminator they are byte-identical
    on the wire — same code, same state, same `volume_mounted: true` — while
    "the decision log is damaged" and "the log is fine and the card behind a
    good promote line will not parse" are repairs to different things. `message`
    is developer prose a client may not render, so the discriminator has to be
    in `details`.
    """
    path = promoted / LANE.directory_name / f"{trained.card.artifact_id}{CARD_SUFFIX}"
    path.write_text("half a document", encoding="utf-8")
    unreadable = client.get(CARD).json()["error"]["details"]

    log = promoted / PROMOTION_LOG_FILENAME
    log.write_text("{not json\n", encoding="utf-8")
    damaged_log = client.get(CARD).json()["error"]["details"]

    # One word, because there is no other true one available.
    assert unreadable["lane_state"] == damaged_log["lane_state"] == "unresolvable"
    assert unreadable["volume_mounted"] is damaged_log["volume_mounted"] is True
    # And two different `details`, which is what a client can branch on.
    assert unreadable["card_error"]
    assert "card_error" not in damaged_log
    assert "contract_fault" not in unreadable


def test_the_card_503_and_meta_answer_differently_about_one_lane(
    promoted: Path, trained: TrainedFold
) -> None:
    """The reported contradiction, asserted as the intended behaviour.

    A contract-faulted lane: `/v1/model/card` answers 503 `unresolvable` in the
    error-envelope vocabulary, and `/v1/meta` answers `promoted` in the
    condition vocabulary. Both are true — the promote line exists and a
    migration revokes no line, and there is no servable card behind it — and
    `/v1/meta` says the second half in fields rather than by bending the word.
    """
    path = promoted / LANE.directory_name / f"{trained.card.artifact_id}{CARD_SUFFIX}"
    write_card(
        path,
        {
            **read_card(path),
            GATE_BLOCK_KEY: {CONTRACT_FAULT_KEY: "feature_rows moved under it"},
        },
    )

    envelope = client.get(CARD).json()["error"]["details"]
    assert envelope["lane_state"] == "unresolvable"
    assert envelope["contract_fault"]

    lanes = client.get("/v1/meta").json()["artifacts"]["lanes"]
    lane = next(one for one in lanes if one["lane"] == LANE.directory_name)
    assert lane["state"] == "promoted"
    # The serviceability facts that make `promoted` readable rather than a lie.
    assert lane["usable"] is False
    assert lane["retrain_owed"] is True
    assert lane["contract_fault"]
    assert lane["unusable_reason"]


def test_a_lane_name_that_is_not_one_is_a_422_and_not_a_503(promoted: Path) -> None:
    """A malformed request is a statement about the request.

    Rounding it to `MODEL_UNAVAILABLE` would tell a caller the model is missing
    when what is missing is a well-formed lane.
    """
    response = client.get("/v1/model/card?lane=not__a__lane")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REQUEST_INVALID"


def test_the_card_is_json_the_gateway_can_shape(promoted: Path) -> None:
    """The groups api-surface ticket 16 exposes a subset of, present by name."""
    card = client.get(CARD).json()["card"]
    for group in (
        "identity",
        "lane",
        "contract",
        "fold",
        "data",
        "calibration",
        "quantiles",
        "ensemble",
    ):
        assert group in card, group
    assert json.dumps(card)
