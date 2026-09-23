"""The attribution of a reconstructed forecast: one function called, one stamp changed.

`wattsteer_ml.diagnosis.holdout` exists so a replayed held-out day can show
what moved the forecast the replay is scored on. What has to be true for that to
be honest is narrow, and it is what these tests hold:

- the game is the serving path's own ``build_diagnosis_publication``, called
  with the fold artifact and the publication's own gate instant;
- every row it returns leaves stamped ``backfilled_holdout``, and nothing any
  caller passes can make it ``served``;
- a day that cannot be explained is named, and never takes the others with it.

The Shapley arithmetic is not re-asserted here — `test_day_attribution.py` owns
it — so the builder is replaced by a recorder. What is under test is the
wrapping, and a real fit would only make that slower to see.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from datetime import UTC, date, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from wattsteer_ml.diagnosis import holdout as module
from wattsteer_ml.diagnosis.holdout import holdout_attributions
from wattsteer_ml.diagnosis.publication import (
    BACKFILLED_HOLDOUT_ORIGIN_KIND,
    SERVED_ORIGIN_KIND,
)
from wattsteer_ml.diagnosis.publish import DiagnosisPublicationRefusedError
from wattsteer_ml.evaluation.serving_lanes import LATE_LANE

FIRST = date(2025, 11, 12)
SECOND = date(2025, 11, 13)


@dataclass(frozen=True)
class Explained:
    """The two fields the wrapper reads or writes, and nothing else."""

    target_date: date
    origin_kind: str = SERVED_ORIGIN_KIND


def trained() -> Any:
    card = SimpleNamespace(artifact_id="2025-10-01T00:00:00Z", to_dict=lambda: {"id": 1})
    return SimpleNamespace(card=card, bundle=object())


def backtest(*days: date) -> Any:
    return SimpleNamespace(
        lane=LATE_LANE,
        publications=tuple(
            SimpleNamespace(
                target_date=day,
                published_at=datetime(day.year, day.month, day.day - 1, 22, tzinfo=UTC),
            )
            for day in days
        ),
    )


def rows(*days: date) -> list[dict[str, Any]]:
    return [{"target_date": day, "subsystem": "NE"} for day in days for _ in range(24)]


def test_every_attribution_leaves_stamped_as_a_reconstruction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def build(day_rows: Any, base_fit: Any, **kwargs: Any) -> Explained:
        calls.append({"rows": len(day_rows), "base_fit": base_fit, **kwargs})
        return Explained(target_date=kwargs["target_date"])

    monkeypatch.setattr(module, "build_diagnosis_publication", build)
    minted, skipped = holdout_attributions(
        rows(FIRST, SECOND), trained=trained(), backtest=backtest(FIRST, SECOND)
    )

    assert [one.origin_kind for one in minted] == [BACKFILLED_HOLDOUT_ORIGIN_KIND] * 2
    assert skipped == ()
    # The serving function, with the fold artifact and the gate the band was
    # published at — so the bars and the band describe one model and one instant.
    assert [call["target_date"] for call in calls] == [FIRST, SECOND]
    assert calls[0]["published_at"] == datetime(2025, 11, 11, 22, tzinfo=UTC)
    assert calls[0]["loaded"].artifact_id == "2025-10-01T00:00:00Z"
    assert calls[0]["lane"] == LATE_LANE
    # One day's rows each, and no base-fit rows: the bundle's frozen background.
    assert [call["rows"] for call in calls] == [24, 24]
    assert calls[0]["base_fit"] == ()


def test_a_day_that_cannot_be_explained_is_named_and_the_rest_are_kept(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def build(_rows: Any, _base: Any, **kwargs: Any) -> Explained:
        if kwargs["target_date"] == FIRST:
            raise DiagnosisPublicationRefusedError("incomplete_day", "no whole day")
        return Explained(target_date=kwargs["target_date"])

    monkeypatch.setattr(module, "build_diagnosis_publication", build)
    minted, skipped = holdout_attributions(
        rows(FIRST, SECOND), trained=trained(), backtest=backtest(FIRST, SECOND)
    )

    assert [one.target_date for one in minted] == [SECOND]
    assert [(one.target_date, one.reason) for one in skipped] == [
        (FIRST, "incomplete_day: no whole day")
    ]


def test_no_input_can_choose_the_origin_kind() -> None:
    """The stamp is a constant in the body, and never a parameter."""
    parameters = inspect.signature(holdout_attributions).parameters
    assert "origin_kind" not in parameters
    source = inspect.getsource(module)
    assert "SERVED_ORIGIN_KIND" not in source
    assert "origin_kind=BACKFILLED_HOLDOUT_ORIGIN_KIND" in source


def test_the_serving_path_still_cannot_mint_a_reconstruction() -> None:
    """`build_attribution_publication` has no argument that reaches the field."""
    from wattsteer_ml.diagnosis.publication import build_attribution_publication

    assert (
        "origin_kind" not in inspect.signature(build_attribution_publication).parameters
    )
