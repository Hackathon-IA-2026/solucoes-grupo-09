"""The bundle on the volume, the card beside it, and the loads that must fail.

`docs/specs/forecaster.md`: the bundle is "one joblib of a frozen dataclass, so
a partial load fails loudly", and "a card whose feature hash disagrees with its
bundle's stored feature list fails to load". Both are refusals, so both are
tested by making the bad artifact and asking for it back.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import joblib
import pytest

from wattsteer_ml.artifacts import ARTIFACT_SUFFIX, CARD_SUFFIX
from wattsteer_ml.artifacts import inspect as inspect_store
from wattsteer_ml.config import settings
from wattsteer_ml.lanes import Lane
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionRecord, append
from wattsteer_ml.training import (
    BundleError,
    ContractMismatchError,
    PartialBundleError,
    TrainedFold,
    forecast_rows,
    load_artifact,
    save_artifact,
)


@pytest.fixture
def volume(tmp_path: Path) -> Path:
    root = tmp_path / "models"
    root.mkdir()
    return root


def written(trained: TrainedFold, root: Path) -> tuple[Path, Path]:
    return save_artifact(trained.bundle, trained.card, root=root)


def test_the_bundle_and_its_card_land_in_the_lane_directory(
    trained: TrainedFold, volume: Path
) -> None:
    """The layout ticket 02 defined: one directory per lane, ISO-8601 stems."""
    bundle_path, card_path = written(trained, volume)
    lane_dir = volume / trained.bundle.lane.directory_name
    assert bundle_path == lane_dir / f"{trained.card.artifact_id}{ARTIFACT_SUFFIX}"
    assert card_path == lane_dir / f"{trained.card.artifact_id}{CARD_SUFFIX}"


def test_the_store_sees_the_artifact_but_serves_nothing_until_it_is_promoted(
    trained: TrainedFold, volume: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A freshly trained candidate is on the volume and is not `current`.

    Ticket 02's rule, exercised from the writing end: "a candidate that fails
    the gate is still written to the volume — that is the point of writing it".
    """
    monkeypatch.setattr(settings, "artifact_dir", volume)
    written(trained, volume)
    lane = trained.bundle.lane
    view = inspect_store().view(lane)
    assert view.artifacts == (trained.card.artifact_id,)
    assert view.state == "present_unpromoted"
    append(
        volume / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=trained.card.artifact_id,
            lane=lane,
            decision="promote",
            reason="a test, not a gate",
            at=datetime(2026, 8, 29, 9, 0, tzinfo=UTC),
        ),
    )
    assert inspect_store().current(lane) == trained.card.artifact_id


def test_a_reloaded_bundle_predicts_identically(
    trained: TrainedFold, volume: Path, test_rows: list[dict[str, Any]]
) -> None:
    """Reloading is not a second training run, and must not be a second answer."""
    written(trained, volume)
    loaded = load_artifact(
        root=volume, lane=trained.bundle.lane, artifact_id=trained.card.artifact_id
    )
    for one, other in zip(
        forecast_rows(trained.bundle, test_rows),
        forecast_rows(loaded.bundle, test_rows),
        strict=True,
    ):
        assert one.key == other.key
        assert one.forecast.band == other.forecast.band
        assert one.forecast.expected_mwh == other.forecast.expected_mwh


def test_a_card_whose_feature_hash_disagrees_fails_to_load(
    trained: TrainedFold, volume: Path
) -> None:
    """Two copies of one fact. Disagreeing, neither can be served.

    The card's copy is what the hot-swap gate compares against the live
    `feature_rows`; the bundle's copy is what the design matrix is encoded
    under. An artifact where they differ is an artifact serving a vector nobody
    can name.
    """
    _, card_path = written(trained, volume)
    card = json.loads(card_path.read_text())
    card["contract"]["feature_hash"] = "sha256:" + "0" * 64
    card_path.write_text(json.dumps(card))
    with pytest.raises(ContractMismatchError, match="feature_hash"):
        load_artifact(
            root=volume, lane=trained.bundle.lane, artifact_id=trained.card.artifact_id
        )


def test_a_bundle_missing_an_estimator_fails_to_load(
    trained: TrainedFold, volume: Path
) -> None:
    """Five estimators compose a different model, not a degraded one.

    `joblib.load` reconstructs without running `__init__`, so a frozen dataclass
    is not on its own enough: the loader re-checks every field. Without that,
    a bundle with no conditional-mean booster would serve an expectation drawn
    from the median — the exact systematic understatement `mixture.py` exists to
    prevent, arriving by a different door.
    """
    bundle_path, _ = written(trained, volume)
    partial = joblib.load(bundle_path)
    object.__setattr__(partial, "magnitude_mean", None)
    joblib.dump(partial, bundle_path)
    with pytest.raises(PartialBundleError, match="magnitude_mean"):
        load_artifact(
            root=volume, lane=trained.bundle.lane, artifact_id=trained.card.artifact_id
        )


def test_a_bundle_without_its_card_fails_to_load(
    trained: TrainedFold, volume: Path
) -> None:
    """The card is written whatever the gate decides; its absence is a partial write."""
    _, card_path = written(trained, volume)
    card_path.unlink()
    with pytest.raises(BundleError, match="card"):
        load_artifact(
            root=volume, lane=trained.bundle.lane, artifact_id=trained.card.artifact_id
        )


def test_a_bundle_in_the_wrong_lane_fails_to_load(
    trained: TrainedFold, volume: Path
) -> None:
    """A different triple is a different lane and is never the same model."""
    written(trained, volume)
    other = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=10)
    (volume / other.directory_name).mkdir()
    for suffix in (ARTIFACT_SUFFIX, CARD_SUFFIX):
        source = (
            volume
            / trained.bundle.lane.directory_name
            / f"{trained.card.artifact_id}{suffix}"
        )
        (
            volume / other.directory_name / f"{trained.card.artifact_id}{suffix}"
        ).write_bytes(source.read_bytes())
    with pytest.raises(ContractMismatchError):
        load_artifact(root=volume, lane=other, artifact_id=trained.card.artifact_id)


def test_the_card_records_what_the_ticket_requires(trained: TrainedFold) -> None:
    """Identity, lane, feature hash, windows, counts and environment versions."""
    card = trained.card.to_dict()
    assert card["identity"]["artifact_id"] == trained.card.artifact_id
    assert card["identity"]["estimator_family"] == "lightgbm"
    assert card["identity"]["model_config_version"] == trained.bundle.model_config_version
    assert card["lane"]["feature_set"] == trained.bundle.lane.feature_set
    assert card["lane"]["gate_profile"] == trained.bundle.lane.gate_profile
    assert card["lane"]["threshold_mw"] == trained.bundle.threshold_mw
    assert card["lane"]["subsystems"] == ["N", "NE", "SE", "S"]
    assert card["contract"]["feature_hash"] == trained.bundle.contract.feature_hash
    assert card["contract"]["feature_names"] == list(
        trained.bundle.contract.feature_names
    )
    for window in (
        "training_window",
        "base_fit_window",
        "calibration_window",
        "test_window",
    ):
        assert set(card["data"][window]) == {"start", "end"}
    assert card["data"]["base_fit_positive_rows"] > 0
    assert card["data"]["base_fit_rows"] > card["data"]["base_fit_positive_rows"]
    assert card["fold"]["fold_hash"].startswith("sha256:")
    for package in ("python", "lightgbm", "numpy"):
        assert card["environment"][package]


def test_the_card_says_the_feature_set_version_is_unknown_rather_than_inventing_one(
    trained: TrainedFold,
) -> None:
    """`docs/specs/feature-engineering.md` owns the dictionary and has not issued one.

    An explicit null is auditable; a minted string would be a claim about a
    version that does not exist.
    """
    assert trained.card.to_dict()["lane"]["feature_set_version"] is None


def test_the_card_carries_the_ninety_six_sub_threshold_means(
    trained: TrainedFold,
) -> None:
    table = trained.card.to_dict()["sub_threshold_means"]
    assert sorted(table) == ["N", "NE", "S", "SE"]
    assert all(len(hours) == 24 for hours in table.values())


def test_the_card_counts_vintage_fidelity_and_never_averages_it(
    trained: TrainedFold,
) -> None:
    """Two values are reported as two numbers; their mean describes no fold."""
    fidelity = trained.card.to_dict()["data"]["vintage_fidelity"]
    assert isinstance(fidelity, dict)
    assert sum(fidelity.values()) == (
        trained.counts.base_fit_rows
        + trained.counts.calibration_rows
        + trained.counts.test_rows
    )
