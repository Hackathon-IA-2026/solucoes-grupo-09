"""The comparison page: a fixture volume, its absences, and its failure mode."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from wattsteer_ml import model_report
from wattsteer_ml.model_report import render, write_report, write_report_or_warn
from wattsteer_ml.retrain import FOLD_METRICS_KEY

LANE = "dessem_free_v1__gate_late__thr5"
NEW, OLD = "2026-09-18T03:10:00Z", "2026-09-11T03:10:00Z"


def _row(
    rung: str, number: int, qloss: float, fidelity: str = "point_in_time"
) -> dict[str, Any]:
    return {
        "run": "r",
        "rung": rung,
        "rung_number": number,
        "fold_id": "F6",
        "vintage_fidelity": fidelity,
        "rows": 100,
        "qloss_mwh": qloss,
        "pr_auc": 0.5,
        "coverage_p10": None,
        "coverage_p90": 0.9,
    }


def _volume(root: Path) -> None:
    lane = root / LANE
    lane.mkdir(parents=True)
    (lane / f"{NEW}.card.json").write_text(
        json.dumps(
            {
                FOLD_METRICS_KEY: [
                    _row("same_hour_7d", 1, 10.0),
                    _row("lightgbm", 4, 8.0),
                    _row("lightgbm", 4, 99.0, "revision_optimistic"),
                ]
            }
        )
    )
    (lane / f"{OLD}.card.json").write_text(json.dumps({"other": 1}))
    line = {
        "artifact_id": NEW,
        "lane": LANE,
        "decision": "promote",
        "reason": "bootstrap P = 0.94 <script>",
        "at": NEW,
        "bootstrap_p": 0.94,
    }
    (root / "promotions.jsonl").write_text(json.dumps(line) + "\n")


def test_ladder_delta_is_within_one_fidelity_block(tmp_path: Path) -> None:
    _volume(tmp_path)
    page = render(tmp_path)
    assert "-20.0%" in page  # 8 vs 10, point_in_time
    assert "revision_optimistic" in page
    assert page.count("<h3>F6") == 2  # never merged
    assert "-90" not in page  # 99 was not compared against the other block


def test_missing_data_is_a_stated_absence_not_a_zero(tmp_path: Path) -> None:
    _volume(tmp_path)
    assert "not measured" in render(tmp_path)  # coverage_p10 is None
    (tmp_path / LANE / f"{NEW}.card.json").write_text("{}")
    assert "no ladder data" in render(tmp_path)


def test_reason_is_escaped(tmp_path: Path) -> None:
    _volume(tmp_path)
    assert "<script>" not in render(tmp_path)


def test_experiments_dir_is_not_a_lane_and_is_listed(tmp_path: Path) -> None:
    _volume(tmp_path)
    (tmp_path / "experiments" / "dessem_ab").mkdir(parents=True)
    (tmp_path / "experiments" / "dessem_ab" / f"{NEW}.json").write_text('{"a": 1}')
    page = render(tmp_path)
    assert "dessem_ab" in page and "No lane directory" not in page


def test_report_is_written_atomically_beside_the_lanes(tmp_path: Path) -> None:
    _volume(tmp_path)
    path = write_report(tmp_path)
    assert path == tmp_path / "experiments" / "report.html"
    assert not list(path.parent.glob("*.tmp"))


def test_render_failure_warns_and_returns_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom(_root: Path) -> str:
        raise RuntimeError("no page")

    monkeypatch.setattr(model_report, "render", lambda root, **_: boom(root))
    assert write_report_or_warn(tmp_path) is None
    assert "model report was not written" in capsys.readouterr().err


def test_the_page_carries_no_per_subsystem_or_summed_quantile() -> None:
    source = Path(model_report.__file__).read_text()
    assert "by_subsystem" not in source and "sum(" not in source


def test_retrain_main_exit_code_ignores_a_report_failure() -> None:
    module = __import__("wattsteer_ml.retrain", fromlist=["x"])
    assert module.__file__ is not None
    src = Path(module.__file__).read_text()
    main = src[src.index("def main(") :]
    assert "write_report_or_warn(request.root)" in main
    assert main.index("write_report_or_warn") < main.index("return 0 if decided")
