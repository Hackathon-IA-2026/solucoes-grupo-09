"""An experiment's report is kept beside the models and is not a lane.

Before this module the DESSEM A/B and the threshold sweep printed one line of
JSON and exited, so the comparison survived only if somebody piped it. What is
held here: the report lands where a reader can find it, a half-written file is
never visible, an unwritable volume costs a warning and not the run, and the
directory does not turn up as an unrecognised entry on `/v1/meta`.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

from wattsteer_ml import artifacts
from wattsteer_ml.config import settings
from wattsteer_ml.experiment_reports import (
    EXPERIMENTS_DIRNAME,
    report_path,
    save_report,
)

AS_OF = datetime(2026, 9, 9, 3, 10, 0, tzinfo=UTC)


@pytest.fixture
def volume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    root = tmp_path / "models"
    root.mkdir()
    monkeypatch.setattr(settings, "artifact_dir", root)
    yield root


def test_a_report_is_written_under_its_kind_and_stem(volume: Path) -> None:
    written = save_report(volume, "dessem_ab", AS_OF, {"is_measurement": False})

    assert written == volume / "experiments" / "dessem_ab" / "2026-09-09T03:10:00Z.json"
    assert json.loads(written.read_text()) == {"is_measurement": False}


def test_no_partial_file_is_left_behind(volume: Path) -> None:
    written = save_report(volume, "threshold_sweep", AS_OF, {"arms": [1, 2, 3]})

    assert written is not None
    assert [entry.name for entry in written.parent.iterdir()] == [written.name]


def test_rerunning_one_instant_replaces_the_report(volume: Path) -> None:
    save_report(volume, "dessem_ab", AS_OF, {"run": 1})
    written = save_report(volume, "dessem_ab", AS_OF, {"run": 2})

    assert written is not None
    assert json.loads(written.read_text()) == {"run": 2}


def test_an_unwritable_volume_is_a_warning_and_not_an_exception(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # A file where the directory should go: mkdir fails whoever runs the test,
    # including root, which a chmod-based fixture would not.
    blocker = tmp_path / "models"
    blocker.write_text("not a directory")

    assert save_report(blocker, "dessem_ab", AS_OF, {"x": 1}) is None

    warning = json.loads(capsys.readouterr().err)
    assert "was not saved" in warning["warning"]


def test_the_experiments_directory_is_not_reported_as_unrecognised(
    volume: Path,
) -> None:
    save_report(volume, "dessem_ab", AS_OF, {"x": 1})
    (volume / "notalane").mkdir()

    store = artifacts.inspect()

    assert (volume / EXPERIMENTS_DIRNAME).is_dir()
    assert store.unrecognised == ("notalane",)
    assert store.lanes == ()


def test_the_guard_can_fail(volume: Path) -> None:
    """Without the skip a near-miss name is unrecognised, so the test above bites."""
    (volume / "experiment").mkdir()  # one letter off the reserved name

    assert artifacts.inspect().unrecognised == ("experiment",)


def test_report_path_touches_no_disk(tmp_path: Path) -> None:
    path = report_path(tmp_path / "absent", "threshold_sweep", AS_OF)

    assert not (tmp_path / "absent").exists()
    assert path.name == "2026-09-09T03:10:00Z.json"
