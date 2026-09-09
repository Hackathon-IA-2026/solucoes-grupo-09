"""The model-artifact store.

The charting decision: the Python service retrains weekly from Postgres, writes
the artifact and its metrics to a Railway volume, and hot-swaps only if the
backtest gate passes. This module is the volume's half of that — it knows where
artifacts live, which lanes exist, and which artifact each lane is allowed to
serve. Training writes into it in a later ticket.

The directory is a *mount point*, so its state is diagnostic information rather
than an invariant: it can be missing (volume not attached), present and empty
(attached, nothing trained yet), or present and read-only (attached wrong).
`/v1/meta` reports which, because "the forecast is stale" and "the volume did
not mount" look identical from the outside otherwise.

**The layout is one directory per lane** (`docs/specs/forecaster.md`)::

    /data/models/
      promotions.jsonl                       # append-only decision log
      dessem_free_v1__gate_late__thr5/
        2026-08-28T03:11:07Z.joblib          # the bundle
        2026-08-28T03:11:07Z.card.json       # model card + metrics
        2026-08-21T03:09:44Z.joblib
      dessem_free_v1__gate_early__thr5/
        …

ISO-8601 UTC stems sort meaningfully, so there is no `current` symlink to go
stale — the original rationale survives intact. Two things about it did not, and
the spec calls both out rather than assuming them:

1. **Inspection walks one level of lane directories, not a flat `iterdir()`.**
   "Newest" is well-defined *within* a lane and meaningless across them: an
   artifact trained on a different feature set at a different threshold is not a
   newer version of this one. A flat listing mixes three lanes' timestamps into
   one ordering and calls the winner `current`.
2. **`current(lane)` means the newest artifact named by a `promote` decision in
   `promotions.jsonl`, not the newest file.** A candidate that fails the gate is
   still written to the volume — that is why it is written, so a refused model
   can be inspected — so a newest-file rule serves exactly the model the gate
   refused. Which artifact a lane serves is a recorded decision; a stray copy, a
   partial write or a skewed clock cannot make it.

**The three states, kept distinct from the mount's two.** `api-surface.md`
requires four different "no forecast" sentences, and this module is what makes
one of them — *no promoted artifact* — sayable at all:

- ``no_artifact`` — the lane holds nothing. Nothing was ever trained here.
- ``present_unpromoted`` — bundles are on the volume and none of them passed the
  gate. The forecast panels are absent, and the reason is a model that was
  refused rather than a model that is missing.
- ``promoted`` — an artifact is named by a `promote` line and is on disk. This
  is the only state in which anything is served.

Each is a **fact about a decision**, not an absent file, which is what lets
`/v1/forecast/day-ahead` answer `MODEL_UNAVAILABLE` with a `lane_state` in its
details instead of a spinner.

There is a fourth value, ``unresolvable``, and it is not a fourth lane state so
much as the refusal to guess between the first three. Two things produce it: a
corrupt or truncated promotion log, and a `promote` line naming an artifact that
is not on the volume. In either case the lane cannot say what it is allowed to
serve, so :func:`current` raises and `/v1/meta` reports the fault in prose —
because the one thing this module must never do when it cannot tell is fall back
to the newest file.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .config import settings
from .lanes import Lane, is_artifact_id
from .promotions import (
    PROMOTION_LOG_FILENAME,
    PromotionLog,
    PromotionLogError,
)

#: Suffix used for serialised models. One place, so the retrain job and the
#: loader cannot disagree about it.
ARTIFACT_SUFFIX = ".joblib"

#: Suffix of the model card that travels beside every bundle, promoted or not —
#: "the card is written regardless, so a refused candidate is inspectable".
CARD_SUFFIX = ".card.json"

#: The card group the hot-swap gate writes its decision into
#: (`docs/specs/forecaster.md`, the card's Decision group). Spelt in this module
#: — the one that owns the volume and the card's filename — because three
#: importers need it and none of them may import the others: the gate writes it,
#: :func:`~wattsteer_ml.training.bundle.load_artifact` refuses on it, and
#: :func:`inspect` reports it. `wattsteer_ml.training.bundle` re-exports both
#: names, so the spelling every caller already uses is unchanged.
GATE_BLOCK_KEY = "gate"

#: The key inside :data:`GATE_BLOCK_KEY` that marks an artifact as invalid
#: because the feature contract moved out from under it. Written by the gate's
#: third check, read by the loader, and reported by :func:`inspect`.
CONTRACT_FAULT_KEY = "contract_fault"

#: The gate check whose refusals are a property of the fold calendar rather than
#: of the candidate. `docs/specs/forecaster.md`: check 4's sixty-test-day floor
#: and the quarterly live edge mean promotion is only possible in roughly the
#: last third of each quarter, so runs of these are the gate working. Named here
#: because :attr:`LaneView.unusable_reason` has to say so — a sentence that read
#: as an alarm for eight weeks of every quarter would train an operator to
#: ignore the one that is not.
CALENDAR_BOUND_CHECK = "freshness_and_coverage"


def contract_fault(card: Mapping[str, Any]) -> str | None:
    """Why this artifact was marked invalid, or ``None`` when it was not.

    Set by the hot-swap gate's third check when the live ``feature_rows``
    definition stops producing the hash the artifact was fitted against. The
    incumbent is then invalid rather than stale — every number it would serve was
    measured in a feature space the database no longer produces — and
    `docs/specs/forecaster.md` requires that it not be "left quietly serving a
    changed contract". The promotion log cannot say so: it holds ``promote`` and
    ``refuse``, and neither revokes an earlier promotion, while a rollback needs
    an earlier artifact to name and after a contract change there is none. So the
    mark lives on the card, where
    :func:`~wattsteer_ml.training.bundle.load_artifact` refuses it — nothing is
    deleted and no log line is rewritten.
    """
    block = card.get(GATE_BLOCK_KEY)
    if not isinstance(block, dict):
        return None
    fault = block.get(CONTRACT_FAULT_KEY)
    return fault if isinstance(fault, str) and fault.strip() else None


#: What one lane can be, reported by `/v1/meta` and consumed by the gateway as
#: `details.lane_state`. The first three are the spec's three; see the module
#: docstring for why there is a fourth.
LaneState = Literal[
    "no_artifact",
    "present_unpromoted",
    "promoted",
    "unresolvable",
]


@dataclass(frozen=True)
class LaneView:
    """One lane on the volume, and the decision that governs it.

    The invariants are enforced here rather than tested for, so no caller has to
    handle a view that says two things at once:

    - a lane cannot be both resolved and faulted;
    - :attr:`promoted` names an artifact that is *on the volume* — a promote
      line pointing at a file that is not there becomes a :attr:`fault`, never
      a served id.
    """

    lane: Lane
    #: Artifact ids present in the lane directory, oldest first. Ids, not
    #: filenames: the bundle and its card share a stem, and the stem is what the
    #: promotion log names.
    artifacts: tuple[str, ...]
    #: The artifact this lane may serve, per the promotion log. ``None`` is a
    #: fact — nothing has been promoted — and not an absence of information.
    promoted: str | None
    #: Why this lane could not be resolved, when it could not be. Prose for a
    #: human, because every value it takes is something someone has to go fix.
    fault: str | None = None
    #: Names in the lane directory that are not artifacts — a stray copy, a
    #: half-written `.tmp`, a `.joblib` whose stem is not an instant. Reported
    #: rather than silently skipped, since a file nobody can explain on a
    #: serving volume is worth a look, and *counted as nothing* rather than
    #: as a candidate.
    ignored: tuple[str, ...] = ()
    #: Why the **promoted** artifact will not load, when it will not: the mark
    #: the gate's third check writes on a card whose `feature_hash` the live
    #: `feature_rows` no longer produces. ``None`` when the promoted artifact is
    #: sound, and always ``None`` when nothing is promoted — the debt is a fact
    #: about an artifact, and a lane with none owes nothing to a moved contract.
    #:
    #: Reported *beside* :attr:`promoted` rather than folded into
    #: :attr:`state`, for two reasons. The promotion log is the authority for
    #: which artifact a lane may serve and a migration revokes no line, so
    #: ``promoted`` stays true; and `docs/specs/forecaster.md`'s four states are
    #: the vocabulary `packages/core`'s `LANE_STATES` mirrors, where a fifth
    #: would be a spec change rather than a field.
    contract_fault: str | None = None
    #: Why the promoted artifact's card could not be read, when it could not.
    #: Held apart from :attr:`contract_fault` on purpose: a truncated card means
    #: the volume *cannot say* whether the contract still holds, and the safe
    #: reading of that on a serving volume is that the lane is not usable — but
    #: it is not a retrain debt, because the repair is to the volume and not to
    #: the model. Collapsing the two would make :attr:`retrain_owed` mean "not
    #: serving", which is the one thing it must not mean.
    card_error: str | None = None
    #: The newest decision's reason, when the newest decision was a refusal.
    #: Carried so :attr:`unusable_reason` can name *which* check declined —
    #: "the gate promoted none of them" is not something an operator can act on.
    newest_refusal: str | None = None

    def __post_init__(self) -> None:
        if self.promoted is not None and self.fault is not None:
            raise ValueError(
                f"lane {self.lane} cannot both resolve to {self.promoted!r} and "
                f"be faulted ({self.fault})"
            )
        if self.promoted is not None and self.promoted not in self.artifacts:
            raise ValueError(
                f"lane {self.lane} promotes {self.promoted!r}, which is not on the "
                "volume; that is a fault, not a served artifact"
            )
        for name, value in (
            ("a contract fault", self.contract_fault),
            ("a card error", self.card_error),
        ):
            if value is not None and self.promoted is None:
                raise ValueError(
                    f"lane {self.lane} carries {name} ({value}) and promotes "
                    "nothing; both are facts about the artifact this lane serves, "
                    "and a lane with none owes no retrain"
                )
        if self.contract_fault is not None and self.card_error is not None:
            raise ValueError(
                f"lane {self.lane} cannot both have read the promoted card and "
                "failed to; a card that would not parse states no contract fault"
            )

    @property
    def state(self) -> LaneState:
        """Which of the states this lane is in — derived, never stored."""
        if self.fault is not None:
            return "unresolvable"
        if self.promoted is not None:
            return "promoted"
        return "present_unpromoted" if self.artifacts else "no_artifact"

    @property
    def retrain_owed(self) -> bool:
        """Whether this lane needs a retrain before it can serve anything.

        True in exactly one situation, and it is the one `0039` created: the
        artifact the promotion log names is marked invalid against the live
        feature contract. Every other way a lane can be unserviceable — nothing
        trained, nothing promoted, a damaged log — is answered by training,
        waiting or repairing the volume, and calling those a retrain debt would
        make the word mean "not serving".
        """
        return self.contract_fault is not None

    @property
    def usable(self) -> bool:
        """Whether this lane can answer a forecast right now.

        Promoted *and* loadable. The second conjunct is the one `/v1/meta` was
        missing: an artifact marked invalid on its own card is refused by
        :func:`~wattsteer_ml.training.bundle.load_artifact`, so a lane reporting
        `promoted` alone was reporting something that could not serve. A card
        that would not parse is refused by the same loader and counts here too —
        without counting as a retrain debt.
        """
        return (
            self.state == "promoted"
            and self.contract_fault is None
            and self.card_error is None
        )

    @property
    def unusable_reason(self) -> str | None:
        """One sentence saying why this lane has no usable artifact.

        ``None`` when it has one. Otherwise prose for a human, because every
        value it takes is a different repair — and one of them, a run of
        :data:`CALENDAR_BOUND_CHECK` refusals, is not a repair at all but the
        gate working through the first two thirds of a quarter. That case says
        so in as many words: the sentence has to be readable during the weeks it
        is expected without making the weeks it is not look the same.
        """
        if self.usable:
            return None
        if self.contract_fault is not None:
            return (
                f"{self.promoted} is the artifact this lane is promoted to serve "
                f"and it is marked invalid on its own card: {self.contract_fault}. "
                "Nothing in this lane can serve until a candidate is trained "
                "against the live feature contract and clears the gate; a retrain "
                "is owed."
            )
        if self.card_error is not None:
            return (
                f"{self.card_error} The artifact this lane is promoted to serve "
                f"is {self.promoted}, and the loader refuses a card it cannot "
                "read — so the lane serves nothing until the volume is repaired. "
                "Whether a retrain is also owed cannot be said from here."
            )
        if self.fault is not None:
            return self.fault
        if not self.artifacts:
            return (
                "nothing has ever been trained in this lane; there is no bundle "
                "on the volume and no decision about one"
            )
        refusal = (
            f" The newest decision refused: {self.newest_refusal}."
            if self.newest_refusal
            else ""
        )
        expected = (
            " A run of these is the gate working rather than a fault: check 4's "
            "sixty-test-day floor and the quarterly live edge mean a candidate "
            "can only be promoted in roughly the last third of each quarter, so "
            "refusals before then are expected."
            if self.newest_refusal and CALENDAR_BOUND_CHECK in self.newest_refusal
            else ""
        )
        return (
            f"{len(self.artifacts)} artifact(s) are on the volume and the gate "
            f"has promoted none of them.{refusal}{expected}"
        )

    @property
    def newest(self) -> str | None:
        """The newest artifact *on disk*, which is not what is served.

        Kept because the difference between this and :attr:`promoted` is the
        whole point of the promotion log, and an operator staring at `/v1/meta`
        after a refused retrain wants to see both.
        """
        return self.artifacts[-1] if self.artifacts else None

    def path_in(self, root: Path, artifact_id: str) -> Path:
        """Where a bundle of this lane lives under ``root``."""
        return root / self.lane.directory_name / f"{artifact_id}{ARTIFACT_SUFFIX}"


@dataclass(frozen=True)
class ArtifactStore:
    """A view of the artifact directory at one moment."""

    path: Path
    mounted: bool
    writable: bool
    #: Every lane discovered — on the volume, in the log, or both. Lanes are
    #: *discovered*, never configured: a threshold sweep that writes three lanes
    #: needs no deploy to make them visible, and a lane nobody configured but
    #: which exists on the mount is exactly the thing an operator needs told.
    lanes: tuple[LaneView, ...]
    #: The decision log, or ``None`` when it could not be read.
    log: PromotionLog | None
    #: Why the log could not be read. Exactly one of this and :attr:`log` is set.
    log_error: str | None = None
    #: Entries at the root of the mount that are neither a lane directory nor
    #: the promotion log — including a `.joblib` sitting loose in the root,
    #: which under the old flat listing would have been servable.
    unrecognised: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if (self.log is None) == (self.log_error is None):
            raise ValueError(
                "an artifact store either read its promotion log or knows why it "
                "could not; it cannot be both or neither"
            )

    @property
    def artifact_count(self) -> int:
        """Bundles on the volume, across every lane."""
        return sum(len(lane.artifacts) for lane in self.lanes)

    def view(self, lane: Lane) -> LaneView:
        """The lane's view — an empty, unpromoted one when it is not there.

        An unknown lane is ``no_artifact`` rather than a `KeyError`: "this lane
        has nothing" is an answer the caller has to render anyway, and a lane
        that has never been trained is indistinguishable from one whose
        directory has not been created yet.
        """
        for view in self.lanes:
            if view.lane == lane:
                return view
        return LaneView(
            lane=lane,
            artifacts=(),
            promoted=None,
            fault=self.log_error,
        )

    def current(self, lane: Lane) -> str | None:
        """The artifact id this lane serves, or ``None`` when it serves none.

        Raises :class:`PromotionLogError` when the volume cannot say. That is
        the loud failure the spec asks for: a caller that cannot distinguish
        "nothing is promoted" from "the log is damaged" would go on to render
        the first sentence for the second situation.
        """
        view = self.view(lane)
        if view.fault is not None:
            raise PromotionLogError(f"lane {lane}: {view.fault}")
        return view.promoted


def inspect() -> ArtifactStore:
    """Describe the artifact directory without creating or mutating anything.

    Never raises: `/v1/meta` is the endpoint an operator reaches for when
    something is wrong with the volume, so a damaged log has to arrive as a
    reported state rather than a 500. :meth:`ArtifactStore.current` is where the
    same damage is loud, because that is the call whose answer would otherwise
    be a guess about what to serve.
    """
    path = settings.artifact_dir
    log_path = path / PROMOTION_LOG_FILENAME
    if not path.is_dir():
        return ArtifactStore(
            path=path,
            mounted=False,
            writable=False,
            lanes=(),
            log=PromotionLog(path=log_path, records=()),
        )

    log: PromotionLog | None
    log_error: str | None
    try:
        log = PromotionLog.read(log_path)
        log_error = None
    except PromotionLogError as error:
        log = None
        log_error = str(error)

    lanes: dict[Lane, tuple[tuple[str, ...], tuple[str, ...]]] = {}
    unrecognised: list[str] = []
    for entry in sorted(path.iterdir(), key=lambda item: item.name):
        if entry.is_dir():
            lane = Lane.try_parse(entry.name)
            if lane is None:
                unrecognised.append(entry.name)
                continue
            lanes[lane] = _read_lane_directory(entry)
        elif entry.name != PROMOTION_LOG_FILENAME:
            unrecognised.append(entry.name)

    # A lane can be named by the log and have no directory. Discovering it from
    # both sides is what turns "the promoted artifact is gone" into a fault
    # rather than into silence.
    if log is not None:
        for lane in log.lanes():
            lanes.setdefault(lane, ((), ()))

    views = tuple(
        _resolve(lane, artifacts, ignored, root=path, log=log, log_error=log_error)
        for lane, (artifacts, ignored) in sorted(
            lanes.items(), key=lambda item: item[0].directory_name
        )
    )
    return ArtifactStore(
        path=path,
        mounted=True,
        writable=os.access(path, os.W_OK),
        lanes=views,
        log=log,
        log_error=log_error,
        unrecognised=tuple(unrecognised),
    )


def current(lane: Lane) -> str | None:
    """The artifact id ``lane`` is allowed to serve, right now.

    The one function serving calls. It resolves through the promotion log, so an
    unpromoted newer file on the volume is never the answer, and it raises
    rather than guessing when the log cannot be read.
    """
    return inspect().current(lane)


def _read_lane_directory(directory: Path) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Split a lane directory into artifact ids and everything else."""
    artifacts: list[str] = []
    ignored: list[str] = []
    for entry in sorted(directory.iterdir(), key=lambda item: item.name):
        if entry.is_dir():
            ignored.append(entry.name)
            continue
        if entry.name.endswith(CARD_SUFFIX):
            # The card travels with the bundle and is not itself an artifact.
            continue
        stem = entry.name.removesuffix(ARTIFACT_SUFFIX)
        if entry.name.endswith(ARTIFACT_SUFFIX) and is_artifact_id(stem):
            artifacts.append(stem)
        else:
            ignored.append(entry.name)
    return tuple(sorted(artifacts)), tuple(ignored)


def _resolve(
    lane: Lane,
    artifacts: tuple[str, ...],
    ignored: tuple[str, ...],
    *,
    root: Path,
    log: PromotionLog | None,
    log_error: str | None,
) -> LaneView:
    """Turn a lane's files and the log's decisions into one honest view."""
    if log is None:
        return LaneView(
            lane=lane,
            artifacts=artifacts,
            promoted=None,
            fault=log_error,
            ignored=ignored,
        )
    promoted = log.promoted(lane)
    if promoted is not None and promoted not in artifacts:
        return LaneView(
            lane=lane,
            artifacts=artifacts,
            promoted=None,
            fault=(
                f"the promotion log names {promoted!r} as promoted, but no such "
                "artifact is on the volume — the bundle was removed, or the lane "
                "directory was not mounted"
            ),
            ignored=ignored,
        )
    serviceability = (
        _Serviceability()
        if promoted is None
        else _serviceability(root / lane.directory_name / f"{promoted}{CARD_SUFFIX}")
    )
    return LaneView(
        lane=lane,
        artifacts=artifacts,
        promoted=promoted,
        ignored=ignored,
        contract_fault=serviceability.contract_fault,
        card_error=serviceability.card_error,
        newest_refusal=_newest_refusal(log, lane),
    )


@dataclass(frozen=True)
class _Serviceability:
    """What the promoted artifact's card says about itself, or why it cannot."""

    contract_fault: str | None = None
    card_error: str | None = None


def _serviceability(path: Path) -> _Serviceability:
    """Read the promoted artifact's card and answer both questions. Never raises.

    One small file read per lane, and it is the read that turns "this lane is
    promoted" into "this lane can serve". The two answers are kept apart because
    they need different repairs: a contract fault is a retrain, an unreadable
    card is a volume. Neither is silence — the loader refuses both, so a view
    that called either lane usable would be describing something nothing may
    run.
    """
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return _Serviceability(
            card_error=(
                f"the promoted artifact's card at {path} cannot be read ({error})."
            )
        )
    if not isinstance(parsed, dict):
        return _Serviceability(card_error=f"{path} does not hold a model card.")
    return _Serviceability(contract_fault=contract_fault(parsed))


def _newest_refusal(log: PromotionLog, lane: Lane) -> str | None:
    """The reason on this lane's newest decision, when that decision refused.

    Newest rather than newest-refusal: a lane whose last decision promoted has
    nothing outstanding to report, and quoting an older refusal beside a live
    artifact would describe a state the lane has already left.
    """
    decisions = log.for_lane(lane)
    if not decisions or decisions[-1].promotes:
        return None
    return decisions[-1].reason
