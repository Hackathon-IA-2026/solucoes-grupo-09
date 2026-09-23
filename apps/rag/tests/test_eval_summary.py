"""An evaluation reports accuracy and availability as two numbers."""

from __future__ import annotations

import importlib.util
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "run_eval", Path(__file__).resolve().parents[1] / "eval" / "run_eval.py"
)
run_eval = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run_eval)  # type: ignore[union-attr]


def test_a_provider_that_was_down_is_not_a_refusal_of_the_service():
    """Measured on 22/09/2026: six refusals of a 95-question run were NVIDIA out
    of quota, and each was correct twice when asked again. Counted as refusals
    they pulled accuracy from 89.5% to 82%, a number about the free tier that
    read as a number about the service."""
    rows = (
        [{"id": "B1", "grade": "correct", "page_expected": True}] * 8
        + [{"id": "B2", "grade": "refused", "page_expected": False}]
        + [{"id": "B3", "grade": "unavailable", "page_expected": False}]
    )
    summary = run_eval._question_summary(rows)
    assert summary["unavailable"] == 1
    assert summary["accuracy"] == round(8 / 9, 4)
    assert summary["precision"] == 1.0
