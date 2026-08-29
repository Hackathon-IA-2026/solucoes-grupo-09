"""The volume, the lanes and what "current" means.

Every test here builds a real directory tree under `tmp_path` and points
`settings.artifact_dir` at it, because the claims being made are about a
filesystem: that a lane is a directory, that a refused candidate sitting newer
than the promoted one is never served, that a rollback is an append, and that a
damaged log stops the store from answering rather than making it guess.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

from wattsteer_ml import artifacts
from wattsteer_ml.config import settings
from wattsteer_ml.lanes import Lane, LaneNameError, format_instant, is_artifact_id
from wattsteer_ml.promotions import (
    PROMOTION_LOG_FILENAME,
    PromotionLog,
    PromotionLogError,
    PromotionRecord,
    append,
)

LATE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
EARLY = Lane(feature_set="dessem_free_v1", gate_profile="gate_early", threshold_mw=5)
THR_10 = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=10)

OLD = "2026-08-21T03:09:44Z"
PROMOTED = "2026-08-28T03:11:07Z"
REFUSED = "2026-09-04T03:10:12Z"


@pytest.fixture
def volume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A mounted, empty artifact directory that the store reads."""
    root = tmp_path / "models"
    root.mkdir()
    monkeypatch.setattr(settings, "artifact_dir", root)
    yield root


def write_artifact(root: Path, lane: Lane, artifact_id: str) -> None:
    """A bundle and its card, exactly as the retrain job would leave them."""
    directory = root / lane.directory_name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{artifact_id}{artifacts.ARTIFACT_SUFFIX}").write_bytes(b"bundle")
    (directory / f"{artifact_id}{artifacts.CARD_SUFFIX}").write_text("{}")


def decide(
    root: Path,
    lane: Lane,
    artifact_id: str,
    decision: str,
    *,
    reason: str = "test",
    at: str = "2026-08-28T03:11:07Z",
) -> None:
    append(
        root / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=artifact_id,
            lane=lane,
            decision="promote" if decision == "promote" else "refuse",
            reason=reason,
            at=datetime.fromisoformat(at),
        ),
    )


# --- lane identity -----------------------------------------------------------


def test_a_lane_name_round_trips() -> None:
    assert LATE.directory_name == "dessem_free_v1__gate_late__thr5"
    assert Lane.parse(LATE.directory_name) == LATE


def test_a_fractional_threshold_round_trips() -> None:
    lane = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=2.5)
    assert lane.directory_name.endswith("thr2.5")
    assert Lane.parse(lane.directory_name) == lane


@pytest.mark.parametrize(
    "name",
    [
        "dessem_free_v1__gate_late__thr05",  # not the canonical spelling of 5 MW
        "dessem_free_v1__gate_late__thr5.0",  # nor is this
        "dessem_free_v1__gate_late",  # two segments
        "dessem_free_v1__gate_late__5",  # no `thr`
        "dessem_free_v1__gate_late__thrx",  # not a number
        "dessem_free_v1__gate_late__thr0",  # not a threshold
        "../escape__gate_late__thr5",  # not a segment
    ],
)
def test_a_name_that_is_not_a_lane_is_not_a_lane(name: str) -> None:
    with pytest.raises(LaneNameError):
        Lane.parse(name)
    assert Lane.try_parse(name) is None


def test_a_segment_cannot_smuggle_the_separator() -> None:
    """Otherwise one lane's name would split into another lane."""
    with pytest.raises(LaneNameError):
        Lane(feature_set="a__b", gate_profile="gate_late", threshold_mw=5)


def test_an_artifact_id_is_an_instant_and_nothing_else() -> None:
    assert is_artifact_id(PROMOTED)
    assert not is_artifact_id(f"{PROMOTED} copy")
    assert not is_artifact_id("model-final")
    assert format_instant(datetime(2026, 8, 28, 3, 11, 7, 123, tzinfo=UTC)) == PROMOTED


# --- the promotion log -------------------------------------------------------


def test_every_decision_is_exactly_one_line_carrying_the_five_facts(
    volume: Path,
) -> None:
    log_path = volume / PROMOTION_LOG_FILENAME
    decide(volume, LATE, PROMOTED, "promote", reason="bootstrap P = 0.94")
    decide(volume, LATE, REFUSED, "refuse", reason="pr_auc guardrail")

    lines = log_path.read_text().splitlines()
    assert len(lines) == 2
    log = PromotionLog.read(log_path)
    first, second = log.records
    assert first.artifact_id == PROMOTED
    assert first.lane == LATE
    assert first.decision == "promote"
    assert first.reason == "bootstrap P = 0.94"
    assert first.at == datetime(2026, 8, 28, 3, 11, 7, tzinfo=UTC)
    assert second.decision == "refuse"


def test_the_gates_supporting_numbers_survive_a_round_trip(volume: Path) -> None:
    log_path = volume / PROMOTION_LOG_FILENAME
    append(
        log_path,
        PromotionRecord(
            artifact_id=PROMOTED,
            lane=LATE,
            decision="promote",
            reason="bootstrap",
            at=datetime(2026, 8, 28, 3, 11, 7, tzinfo=UTC),
            evidence={"bootstrap_p": 0.94, "guardrails": {"ece": 0.03}},
        ),
    )
    (record,) = PromotionLog.read(log_path).records
    assert record.evidence == {"bootstrap_p": 0.94, "guardrails": {"ece": 0.03}}


def test_a_decision_without_a_reason_cannot_be_built() -> None:
    with pytest.raises(ValueError, match="reason"):
        PromotionRecord(
            artifact_id=PROMOTED,
            lane=LATE,
            decision="promote",
            reason="   ",
            at=datetime(2026, 8, 28, tzinfo=UTC),
        )


def test_a_reason_with_a_newline_stays_one_line(volume: Path) -> None:
    log_path = volume / PROMOTION_LOG_FILENAME
    append(
        log_path,
        PromotionRecord(
            artifact_id=PROMOTED,
            lane=LATE,
            decision="refuse",
            reason="traceback:\nValueError",
            at=datetime(2026, 8, 28, tzinfo=UTC),
        ),
    )
    assert len(log_path.read_text().splitlines()) == 1
    assert len(PromotionLog.read(log_path).records) == 1


def test_a_truncated_final_line_fails_loudly(volume: Path) -> None:
    log_path = volume / PROMOTION_LOG_FILENAME
    decide(volume, LATE, PROMOTED, "promote")
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write('{"artifact_id": "2026-09-04T03:10:1')
    with pytest.raises(PromotionLogError, match="mid-line"):
        PromotionLog.read(log_path)


def test_a_corrupt_line_names_the_line(volume: Path) -> None:
    log_path = volume / PROMOTION_LOG_FILENAME
    decide(volume, LATE, PROMOTED, "promote")
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write("not json at all\n")
    with pytest.raises(PromotionLogError, match="line 2"):
        PromotionLog.read(log_path)


def test_appending_onto_a_corrupt_log_is_refused(volume: Path) -> None:
    log_path = volume / PROMOTION_LOG_FILENAME
    log_path.write_text("garbage\n")
    with pytest.raises(PromotionLogError):
        decide(volume, LATE, PROMOTED, "promote")


# --- resolution --------------------------------------------------------------


def test_lanes_are_discovered_rather_than_configured(volume: Path) -> None:
    for lane in (LATE, EARLY, THR_10):
        write_artifact(volume, lane, PROMOTED)
    store = artifacts.inspect()
    assert [view.lane.directory_name for view in store.lanes] == sorted(
        lane.directory_name for lane in (LATE, EARLY, THR_10)
    )
    assert store.artifact_count == 3


def test_a_refused_candidate_newer_than_the_promoted_one_is_never_served(
    volume: Path,
) -> None:
    """The whole reason `current` is not the newest file."""
    write_artifact(volume, LATE, PROMOTED)
    write_artifact(volume, LATE, REFUSED)
    decide(volume, LATE, PROMOTED, "promote", reason="bootstrap P = 0.94")
    decide(volume, LATE, REFUSED, "refuse", reason="crossing_rate 0.04 > 0.01")

    view = artifacts.inspect().view(LATE)
    assert view.newest == REFUSED
    assert view.promoted == PROMOTED
    assert view.state == "promoted"
    assert artifacts.current(LATE) == PROMOTED


def test_a_rollback_is_an_append_and_the_bad_promotion_survives(volume: Path) -> None:
    write_artifact(volume, LATE, OLD)
    write_artifact(volume, LATE, PROMOTED)
    decide(volume, LATE, OLD, "promote", reason="cold start beats rung 1")
    decide(volume, LATE, PROMOTED, "promote", reason="bootstrap P = 0.94")
    assert artifacts.current(LATE) == PROMOTED

    decide(volume, LATE, OLD, "promote", reason=f"rollback of {PROMOTED}")

    assert artifacts.current(LATE) == OLD
    log = PromotionLog.read(volume / PROMOTION_LOG_FILENAME)
    # Nothing was deleted: the bad promotion's line is still there, in place.
    assert [record.artifact_id for record in log.for_lane(LATE)] == [
        OLD,
        PROMOTED,
        OLD,
    ]
    assert (volume / LATE.directory_name / f"{PROMOTED}.joblib").exists()


def test_lanes_do_not_resolve_across_each_other(volume: Path) -> None:
    write_artifact(volume, LATE, PROMOTED)
    write_artifact(volume, EARLY, REFUSED)
    decide(volume, LATE, PROMOTED, "promote")

    assert artifacts.current(LATE) == PROMOTED
    # `REFUSED` is newer than `PROMOTED` and sits in another lane. A flat
    # newest-file listing would have served it.
    assert artifacts.current(EARLY) is None
    assert artifacts.inspect().view(EARLY).state == "present_unpromoted"


def test_the_three_states_are_distinguishable(volume: Path) -> None:
    write_artifact(volume, EARLY, REFUSED)
    write_artifact(volume, LATE, PROMOTED)
    decide(volume, LATE, PROMOTED, "promote")
    store = artifacts.inspect()

    assert store.view(LATE).state == "promoted"
    assert store.view(EARLY).state == "present_unpromoted"
    # A lane nobody has trained: an answer, not a KeyError.
    assert store.view(THR_10).state == "no_artifact"


def test_a_lane_holding_only_refusals_has_nothing_to_serve(volume: Path) -> None:
    write_artifact(volume, LATE, REFUSED)
    decide(volume, LATE, REFUSED, "refuse", reason="ece 0.08 > 0.05")
    store = artifacts.inspect()
    assert store.current(LATE) is None
    assert store.view(LATE).state == "present_unpromoted"
    # The refusal is not forgotten — it is why the panel is absent.
    assert store.log is not None
    assert store.log.for_lane(LATE)[0].reason == "ece 0.08 > 0.05"


def test_a_corrupt_log_fails_loudly_rather_than_falling_back(volume: Path) -> None:
    write_artifact(volume, LATE, PROMOTED)
    write_artifact(volume, LATE, REFUSED)
    (volume / PROMOTION_LOG_FILENAME).write_text("{}\n")

    store = artifacts.inspect()
    # `/v1/meta` still answers — the operator needs to be told.
    assert store.log_error is not None
    assert store.view(LATE).state == "unresolvable"
    # Serving does not.
    with pytest.raises(PromotionLogError):
        store.current(LATE)


def test_a_promotion_naming_a_missing_artifact_is_a_fault(volume: Path) -> None:
    write_artifact(volume, LATE, PROMOTED)
    decide(volume, LATE, PROMOTED, "promote")
    (volume / LATE.directory_name / f"{PROMOTED}.joblib").unlink()

    store = artifacts.inspect()
    assert store.view(LATE).state == "unresolvable"
    assert store.view(LATE).promoted is None
    with pytest.raises(PromotionLogError, match="no such artifact is on the volume"):
        store.current(LATE)


def test_a_lane_in_the_log_but_not_on_the_volume_is_still_reported(
    volume: Path,
) -> None:
    decide(volume, LATE, PROMOTED, "promote")
    store = artifacts.inspect()
    assert [view.lane for view in store.lanes] == [LATE]
    assert store.view(LATE).fault is not None


def test_a_stray_file_is_ignored_rather_than_served(volume: Path) -> None:
    write_artifact(volume, LATE, PROMOTED)
    directory = volume / LATE.directory_name
    (directory / f"{PROMOTED} copy.joblib").write_bytes(b"stray")
    (directory / f"{REFUSED}.joblib.tmp").write_bytes(b"partial")
    (volume / "loose.joblib").write_bytes(b"flat")
    (volume / "notalane").mkdir()

    store = artifacts.inspect()
    assert store.view(LATE).artifacts == (PROMOTED,)
    assert set(store.view(LATE).ignored) == {
        f"{PROMOTED} copy.joblib",
        f"{REFUSED}.joblib.tmp",
    }
    assert set(store.unrecognised) == {"loose.joblib", "notalane"}


def test_an_unmounted_volume_is_reported_as_such(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "artifact_dir", tmp_path / "never-attached")
    store = artifacts.inspect()
    assert not store.mounted
    assert store.lanes == ()
    assert store.current(LATE) is None


def test_a_view_cannot_both_resolve_and_fault() -> None:
    with pytest.raises(ValueError, match="cannot both"):
        artifacts.LaneView(
            lane=LATE,
            artifacts=(PROMOTED,),
            promoted=PROMOTED,
            fault="something",
        )


def test_a_view_cannot_promote_an_artifact_that_is_not_there() -> None:
    with pytest.raises(ValueError, match="not on the volume"):
        artifacts.LaneView(lane=LATE, artifacts=(), promoted=PROMOTED)
