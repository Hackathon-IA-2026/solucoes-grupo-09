"""The bundle on the volume, the card beside it, and the loads that must fail.

`docs/specs/forecaster.md`: the bundle is "one joblib of a frozen dataclass, so
a partial load fails loudly", and "a card whose feature hash disagrees with its
bundle's stored feature list fails to load". Both are refusals, so both are
tested by making the bad artifact and asking for it back.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import joblib
import pytest

from conftest import FIXTURE_BACKGROUND_ROWS_PER_CELL
from wattsteer_ml.artifacts import ARTIFACT_SUFFIX, CARD_SUFFIX
from wattsteer_ml.artifacts import inspect as inspect_store
from wattsteer_ml.config import settings
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import HOURS_PER_DAY
from wattsteer_ml.lanes import Lane
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionRecord, append
from wattsteer_ml.training import (
    ARTIFACT_SOURCE,
    BACKGROUND_SEED,
    BUNDLE_COMPRESSION,
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


# --- forecaster 30: the matched background, frozen beside μ_sub and U ---------


def test_the_bundle_carries_the_matched_background_the_training_run_drew(
    trained: TrainedFold,
) -> None:
    """``B(s, h)``, in the artifact, stamped ``artifact`` and fully populated.

    96 cells and not "at least one": a background missing an hour is a
    ``MissingBackgroundCellError`` at attribution time, which is a refusal
    twice a day for a fact the training run could have established once.
    """
    background = trained.bundle.background
    assert background.source == ARTIFACT_SOURCE
    assert background.seed == BACKGROUND_SEED
    assert background.rows_per_cell == FIXTURE_BACKGROUND_ROWS_PER_CELL
    assert len(background.cells) == len(SUBSYSTEM_CODES) * HOURS_PER_DAY
    assert background.feature_names == trained.bundle.contract.feature_names
    for subsystem in SUBSYSTEM_CODES:
        for hour in range(HOURS_PER_DAY):
            cell = background.cell(subsystem, hour)
            assert len(cell) == FIXTURE_BACKGROUND_ROWS_PER_CELL
            assert {key.subsystem for key in cell.keys} == {subsystem}
            assert {key.local_hour for key in cell.keys} == {hour}


def test_the_backgrounds_rows_come_from_the_base_fit_window_and_nowhere_else(
    trained: TrainedFold,
) -> None:
    """Measured rows, and measured rows from the block the boosters saw.

    The one property that separates this sample from a fixture: every drawn row
    is a row of this artifact's own base-fit block. A background drawn from
    invented rows would render eight plausible bars and nothing downstream
    would say the comparison was against nothing.
    """
    drawn = {
        key for cell in trained.bundle.background.cells.values() for key in cell.keys
    }
    assert drawn
    for key in drawn:
        assert trained.blocks.base_fit_start <= key.target_date
        assert key.target_date <= trained.blocks.base_fit_end


def test_the_card_holds_the_frozen_samples_four_values_and_its_measured_size(
    trained: TrainedFold,
) -> None:
    """The card's Background group is the bundle's sample, not a second opinion.

    Held against ``MatchedBackground.card_fields()`` rather than against
    literals, because the failure worth catching is the card and the bundle
    disagreeing — a card that published 128 over a sample of 24 would be an
    audit document describing a different artifact.
    """
    background = trained.card.to_dict()["background"]
    assert background == {
        **trained.bundle.background.card_fields(),
        "background_matrix_bytes": str(trained.bundle.background.matrix_bytes),
    }
    assert background["background_source"] == ARTIFACT_SOURCE
    assert background["background_cells"] == str(len(SUBSYSTEM_CODES) * HOURS_PER_DAY)
    assert int(background["background_matrix_bytes"]) > 0
    # Measured, not derived: the number is the arrays' own, and it is the
    # largest single field in the bundle.
    assert int(background["background_matrix_bytes"]) == sum(
        cell.matrix.nbytes for cell in trained.bundle.background.cells.values()
    )


def test_the_card_group_does_not_collide_with_another_groups_keys(
    trained: TrainedFold,
) -> None:
    """`merge_disjointly` raises on a card-key collision, so the keys are checked.

    The Background group is a group of its own and its four keys are prefixed,
    which is two defences rather than one; this asserts the second, because a
    later refactor that flattened the group into ``data`` or ``ensemble`` would
    be where the collision arrives.
    """
    card = trained.card.to_dict()
    assert "background" in card
    for group, entries in card.items():
        if group == "background" or not isinstance(entries, dict):
            continue
        assert not set(entries) & set(card["background"]), group


def test_a_reloaded_bundle_carries_the_same_sample_bit_for_bit(
    trained: TrainedFold, volume: Path
) -> None:
    """Reproducible *from the artifact*, which is the whole of this ticket.

    The joblib round trip is the path a published attribution's "typical"
    actually takes, and the sample has a ``mappingproxy`` in it that pickle
    cannot carry on its own — so this is asserted on the bytes rather than left
    to the type.
    """
    written(trained, volume)
    reloaded = load_artifact(
        root=volume, lane=trained.bundle.lane, artifact_id=trained.card.artifact_id
    ).bundle
    original = trained.bundle.background
    restored = reloaded.background
    assert restored.source == original.source == ARTIFACT_SOURCE
    assert restored.seed == original.seed
    assert restored.rows_per_cell == original.rows_per_cell
    assert restored.cells.keys() == original.cells.keys()
    for cell_key, cell in original.cells.items():
        assert restored.cells[cell_key].keys == cell.keys
        assert restored.cells[cell_key].matrix.tobytes() == cell.matrix.tobytes()


def test_the_written_artifact_is_compressed_and_the_sample_survives_it(
    trained: TrainedFold, volume: Path, tmp_path: Path
) -> None:
    """Forecaster 32's decision, at the seam that carries it.

    The frozen sample is the largest thing in the bundle and none of it is
    droppable — 128 rows per cell is `docs/specs/diagnosis.md`'s number, and the
    eight driver groups are a total partition of the contract, so every column
    of every background row is read at some coalition. So the artifact is
    compressed instead, and this test states the two halves of that being
    allowed:

    - the file on the volume really is a ``zlib`` stream and really is smaller
      than the float64 payload it carries, so deleting ``compress=`` from
      :func:`save_artifact` fails here rather than quietly costing 9 MB a
      retrain;
    - the sample comes back **bit-identical and still float64**, cell by cell on
      ``tobytes()`` with no tolerance, so this stayed a decision about bytes and
      never became one about what "typical" means.

    The size comparison is against a raw dump of the same bundle rather than a
    literal, because a literal would be a measurement of this fixture's fold.
    """
    bundle_path, _ = written(trained, volume)
    raw = tmp_path / "uncompressed.joblib"
    joblib.dump(trained.bundle, raw, compress=0)

    assert BUNDLE_COMPRESSION == ("zlib", 3)
    # zlib streams start 0x78; an uncompressed joblib starts with pickle's own
    # protocol marker, 0x80. The byte is what ties the constant to the file.
    assert bundle_path.read_bytes()[:1] == b"\x78"
    assert raw.read_bytes()[:1] == b"\x80"
    assert bundle_path.stat().st_size < raw.stat().st_size
    assert bundle_path.stat().st_size < trained.bundle.background.matrix_bytes

    restored = load_artifact(
        root=volume, lane=trained.bundle.lane, artifact_id=trained.card.artifact_id
    ).bundle.background
    assert restored.cells.keys() == trained.bundle.background.cells.keys()
    for cell_key, cell in trained.bundle.background.cells.items():
        assert restored.cells[cell_key].matrix.dtype == cell.matrix.dtype == "float64"
        assert restored.cells[cell_key].matrix.tobytes() == cell.matrix.tobytes()


def test_a_bundle_written_before_the_background_does_not_load(
    trained: TrainedFold, volume: Path
) -> None:
    """The required-and-undefaulted half, proved by making the old artifact.

    ``joblib.load`` reconstructs without running ``__init__``, so a pre-ticket
    bundle comes back with the attribute *absent* — which is why the field
    being required is a statement about loading and not only about
    construction. The alternative is an artifact that serves attributions whose
    "typical" is redrawn from a window that may have moved under it.
    """
    bundle_path, _ = written(trained, volume)
    stale = joblib.load(bundle_path)
    object.__delattr__(stale, "background")
    assert not hasattr(stale, "background")
    joblib.dump(stale, bundle_path)
    with pytest.raises(PartialBundleError, match="background"):
        load_artifact(
            root=volume, lane=trained.bundle.lane, artifact_id=trained.card.artifact_id
        )


def test_a_background_that_came_back_as_something_else_does_not_load(
    trained: TrainedFold, volume: Path
) -> None:
    """And the shape check beside the presence check.

    A bundle whose sample came back as some other object would still serve
    every forecast — the estimators are untouched — and the failure would
    surface as an attribution measured against whatever that object held. So
    the loader checks the type and re-runs the value's own invariants.
    """
    bundle_path, _ = written(trained, volume)
    wrong = joblib.load(bundle_path)
    object.__setattr__(wrong, "background", {"cells": {}})
    joblib.dump(wrong, bundle_path)
    with pytest.raises(PartialBundleError, match="not a MatchedBackground"):
        load_artifact(
            root=volume, lane=trained.bundle.lane, artifact_id=trained.card.artifact_id
        )


def test_a_sample_encoded_under_another_feature_list_is_not_a_bundle(
    trained: TrainedFold,
) -> None:
    """The two halves of ``v(S)`` are encoded under one contract or neither.

    A sample whose columns are not the target's columns attributes the wrong
    feature to the wrong group, in silence, and every bar still renders.
    """
    background = trained.bundle.background
    shifted = replace(
        background, feature_names=(*background.feature_names[1:], "invented_column")
    )
    with pytest.raises(BundleError, match="different feature list"):
        replace(trained.bundle, background=shifted)
