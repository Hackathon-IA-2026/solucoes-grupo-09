"""The artifact card, read at replay time for the two windows it records.

`docs/specs/replay.md`, "Assertion, not trust":

    assert target_date ∉ [artifact.train_start, artifact.train_end]
    assert target_date ∉ [artifact.calibration_start, artifact.calibration_end]

This module is the left-hand side of both lines. It reads
``<root>/<lane>/<artifact_id>.card.json`` — the document
:class:`~wattsteer_ml.training.bundle.ModelCard` wrote beside the bundle — and
returns the four dates, and nothing else.

## Why the card, and not the run's blocks

:class:`~wattsteer_ml.evaluation.folds.FoldBlocks` refuses an overlapping triple
on construction, so a leak cannot be written down there: a run's blocks are
strictly ordered and disjoint or they do not exist. The **card** is the only
place in the system where a training window that contains its own test day is
representable, which is exactly why it is the thing asserted against. A check
against the blocks would be a check that cannot fail, and a check that cannot
fail is a comment.

## Why the card and not the promoted artifact

The artifact id comes from the forecast row's ``run_label``. Nothing in this
module — or anywhere in :mod:`wattsteer_ml.replay` — asks
:func:`wattsteer_ml.artifacts.current` what is on serving duty. That is
`replay.md` story 5 and the negative its testing section calls the one that
matters most: a retrain that extends the serving training window over a day
already replayed must not be able to turn an honest replay into an in-sample
one, and it cannot, because the serving artifact is never consulted for a
historical day.

## What an unreadable card is

Not a default. :func:`read_windows` returns ``None`` and the caller raises
:class:`~wattsteer_ml.evaluation.holdout.HoldoutLeakError`: a claim that cannot
be asserted is not a claim that passes. A card missing its ``data`` block, a
window that is not two dates, a window whose start follows its end — all of
them are the same answer, because a card this module cannot read is a card the
assertion cannot run against.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.lanes import Lane


@dataclass(frozen=True)
class ArtifactWindows:
    """The two windows an artifact card records, plus who recorded them.

    Both windows and never one: the calibration window is carved *out of* the
    training block, so ``[train_start, train_end]`` already contains it — but it
    is checked separately anyway, because the containment is a property of how
    folds are built today and the assertion has to survive an artifact built
    some other way tomorrow.
    """

    artifact_id: str
    fold_id: str
    lane: str
    train_start: date
    train_end: date
    calibration_start: date
    calibration_end: date

    def __post_init__(self) -> None:
        if self.train_start > self.train_end:
            raise CardWindowError(
                f"{self.artifact_id}: training window "
                f"{self.train_start.isoformat()}–{self.train_end.isoformat()} "
                "ends before it opens"
            )
        if self.calibration_start > self.calibration_end:
            raise CardWindowError(
                f"{self.artifact_id}: calibration window "
                f"{self.calibration_start.isoformat()}–"
                f"{self.calibration_end.isoformat()} ends before it opens"
            )


class CardWindowError(ValueError):
    """A card whose windows are not windows.

    Distinct from an absent card so that "the volume is not mounted" and "this
    card says something impossible" are two sentences in a log.
    """


def card_path(root: Path, lane: Lane, artifact_id: str) -> Path:
    """Where the card for one artifact of one lane lives.

    Composed from :attr:`~wattsteer_ml.lanes.Lane.directory_name` and
    :data:`~wattsteer_ml.artifacts.CARD_SUFFIX`, so this module cannot disagree
    with :func:`~wattsteer_ml.training.bundle.save_artifact` about the layout.
    """
    return root / lane.directory_name / f"{artifact_id}{CARD_SUFFIX}"


def _window(block: object, name: str, artifact_id: str) -> tuple[date, date]:
    if not isinstance(block, dict):
        raise CardWindowError(f"{artifact_id}: card has no {name}")
    start, end = block.get("start"), block.get("end")
    if not isinstance(start, str) or not isinstance(end, str):
        raise CardWindowError(
            f"{artifact_id}: {name} is {block!r}, which is not a pair of dates"
        )
    try:
        return date.fromisoformat(start), date.fromisoformat(end)
    except ValueError as error:
        raise CardWindowError(f"{artifact_id}: {name} — {error}") from error


def windows_from_card(card: object, *, artifact_id: str) -> ArtifactWindows:
    """The four dates, out of a parsed card.

    Separate from the file read so that a fabricated card — the fixture
    `replay.md`'s testing section requires, whose windows overlap the replayed
    date — is a dictionary in a test rather than a file on a volume.
    """
    if not isinstance(card, dict):
        raise CardWindowError(f"{artifact_id}: the card is not an object")
    data = card.get("data")
    if not isinstance(data, dict):
        raise CardWindowError(f"{artifact_id}: the card has no data block")
    train_start, train_end = _window(
        data.get("training_window"), "training_window", artifact_id
    )
    calibration_start, calibration_end = _window(
        data.get("calibration_window"), "calibration_window", artifact_id
    )
    fold = card.get("fold")
    fold_id = fold.get("fold_id") if isinstance(fold, dict) else None
    lane = card.get("lane")
    directory = lane.get("directory") if isinstance(lane, dict) else None
    if not isinstance(fold_id, str) or not isinstance(directory, str):
        raise CardWindowError(
            f"{artifact_id}: the card names no fold or no lane, so a replay "
            "served by it could not say which artifact held the day out"
        )
    return ArtifactWindows(
        artifact_id=artifact_id,
        fold_id=fold_id,
        lane=directory,
        train_start=train_start,
        train_end=train_end,
        calibration_start=calibration_start,
        calibration_end=calibration_end,
    )


def read_windows(root: Path, lane: Lane, artifact_id: str) -> ArtifactWindows | None:
    """The card's windows, or ``None`` when there is no card to read.

    ``None`` is an absence of evidence and the caller treats it as one — see the
    module docstring. It is never a permissive default, and there is no argument
    to this function that makes it one.
    """
    path = card_path(root, lane, artifact_id)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        return windows_from_card(json.loads(raw), artifact_id=artifact_id)
    except (json.JSONDecodeError, CardWindowError):
        return None
