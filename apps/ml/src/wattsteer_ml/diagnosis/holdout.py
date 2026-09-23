"""The attribution of a forecast the backtest reconstructed.

`docs/specs/replay.md` deferred "diagnosis and narration of a replayed day" to
the Explain surface, and the Explain surface reads only ``served`` rows — so
every held-out day the Time Machine replays had a band and no bars. This module
is the missing half, and it is small on purpose: it calls the serving path's own
:func:`~wattsteer_ml.diagnosis.publish.build_diagnosis_publication` with the
fold artifact, and restamps what that function returns.

## Why a module of its own

:mod:`wattsteer_ml.holdout_backfill` is what a scheduler runs, and
`test_holdout_backfill_driver.py` holds that it contains no ``origin_kind``
argument anywhere — "a driver that gained an ``origin_kind`` parameter would
make the constant a suggestion". The restamp has to live somewhere, and here it
is one :func:`dataclasses.replace` with a constant, in a function that takes no
origin kind as input. The driver calls it and stays unable to name one.

## What is not reconstructed

No narration: the paragraph is a language model's, written at publication time
under a daily cap, and a paragraph generated today about a gate in 2025 would be
prose nobody published. The bars are the stored game; the words are not.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date
from typing import Any

from wattsteer_ml.diagnosis.publication import (
    BACKFILLED_HOLDOUT_ORIGIN_KIND,
    AttributionPublication,
    AttributionPublicationError,
)
from wattsteer_ml.diagnosis.publish import (
    DiagnosisPublicationRefusedError,
    build_diagnosis_publication,
)
from wattsteer_ml.evaluation.holdout import HoldoutBacktest
from wattsteer_ml.training import LoadedArtifact, TrainedFold


@dataclass(frozen=True)
class SkippedAttribution:
    """A held-out day whose forecast was minted and whose explanation was not."""

    target_date: date
    reason: str

    def as_dict(self) -> dict[str, str]:
        return {"target_date": self.target_date.isoformat(), "reason": self.reason}


def holdout_attributions(
    rows: Sequence[Mapping[str, Any]],
    *,
    trained: TrainedFold,
    backtest: HoldoutBacktest,
) -> tuple[tuple[AttributionPublication, ...], tuple[SkippedAttribution, ...]]:
    """An attribution for every held-out day the backtest minted a forecast for.

    Built by :func:`~wattsteer_ml.diagnosis.publish.build_diagnosis_publication`
    — the serving path's own function, called with the fold artifact — so the
    Shapley game, the matched background, the rules and the partition check are
    the ones Explain publishes and not a second implementation of any of them.
    Two things differ and both are stated:

    - ``base_fit_rows`` is empty, because the fold bundle carries its frozen
      background (forecaster 30) and the redraw is not a branch a fresh fit
      takes. A bundle without one is refused, per day, by that function.
    - ``recent_reasons`` is absent, so ``unmodelled_outage_regime`` cannot fire.
      The reason mix it reads is the worker's live read at ``actuals_cutoff``,
      and reconstructing it for a past gate would be a second reader of
      settled reasons with its own idea of what was knowable.

    The origin kind is set by :func:`dataclasses.replace` on a publication this
    function minted, never by a parameter anyone can pass.
    """
    loaded = LoadedArtifact(
        artifact_id=trained.card.artifact_id,
        bundle=trained.bundle,
        card=trained.card.to_dict(),
    )
    by_day: dict[date, list[Mapping[str, Any]]] = {}
    for row in rows:
        by_day.setdefault(row["target_date"], []).append(row)

    minted: list[AttributionPublication] = []
    skipped: list[SkippedAttribution] = []
    for publication in backtest.publications:
        day_rows = by_day.get(publication.target_date, [])
        try:
            explained = build_diagnosis_publication(
                day_rows,
                (),
                lane=backtest.lane,
                loaded=loaded,
                target_date=publication.target_date,
                published_at=publication.published_at,
            )
        except DiagnosisPublicationRefusedError as refusal:
            skipped.append(
                SkippedAttribution(
                    target_date=publication.target_date,
                    reason=f"{refusal.condition}: {refusal.reason}",
                )
            )
            continue
        except (AttributionPublicationError, ValueError) as error:
            skipped.append(
                SkippedAttribution(
                    target_date=publication.target_date,
                    reason=f"{type(error).__name__}: {error}",
                )
            )
            continue
        minted.append(replace(explained, origin_kind=BACKFILLED_HOLDOUT_ORIGIN_KIND))
    return tuple(minted), tuple(skipped)


__all__ = ["SkippedAttribution", "holdout_attributions"]
