"""The promotion log — which artifact each lane is *allowed* to serve.

`docs/specs/forecaster.md` makes this an append-only file at the root of the
volume, one JSON object per line, written by the hot-swap gate on every
decision::

    {"artifact_id": "…", "lane": "…", "decision": "promote"|"refuse",
     "reason": "…", "at": "…", …}

**Why a log and not a pointer.** A candidate that fails the gate is still
written to the volume — that is the point of writing it, so a refused model is
inspectable — so "the newest file in the lane" and "the artifact this lane may
serve" are different questions with different answers, and only one of them is
a decision anyone made. A stray copy, a partial write or a skewed clock changes
the first and cannot touch the second. The log is also the only thing that
survives to say a hot swap happened: a pointer overwritten in place records
nothing.

**Rollback is an append, never a delete.** Restoring an earlier artifact is a
new `promote` line naming it. The bad promotion's line stays exactly where it
was, which is what makes the incident readable afterwards; nothing on the
volume is removed and the refused candidates keep their lines too.

**What the shapes here make unrepresentable:**

- **A decision without its evidence.** :class:`PromotionRecord` requires an
  artifact id, a lane, a decision, a reason and an instant. There is no
  constructor that omits the reason, so "we swapped and nobody knows why" is
  not a state the log can be in.
- **A silent fallback.** Every read failure — a truncated final line, a byte of
  garbage, a decision word nobody defined — raises
  :class:`PromotionLogError`. This module has no path that returns "nothing is
  promoted" when it *could not tell*; the caller has to distinguish "nothing is
  promoted here" from "the log did not parse", because those two are different
  sentences on a screen.
- **A half-written line.** A log whose last line has no terminator was
  interrupted mid-append, and is refused rather than parsed as far as it goes.
  Appending onto a corrupt log is refused for the same reason: an append-only
  record built on an unreadable prefix is not a record.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal, get_args

from .lanes import Lane, LaneNameError, format_instant, is_artifact_id, parse_instant

#: The log's name, at the root of the artifact directory — one file for every
#: lane, so the decisions are in the order they were taken across all of them.
PROMOTION_LOG_FILENAME = "promotions.jsonl"

#: What the gate can conclude. Both are recorded: a refusal is evidence, and a
#: lane whose log holds only refusals is a lane with nothing to serve — which
#: is a different sentence from a lane with nothing on the volume.
Decision = Literal["promote", "refuse"]

DECISIONS: tuple[Decision, ...] = get_args(Decision)

#: Keys the record owns. Anything else on a line — `bootstrap_p`, `guardrails`,
#: whatever a later gate check adds — is kept verbatim in
#: :attr:`PromotionRecord.evidence` rather than dropped, because this module
#: must be able to read a log written by a version of the gate it predates.
_RESERVED_KEYS = frozenset({"artifact_id", "lane", "decision", "reason", "at"})


class PromotionLogError(RuntimeError):
    """The promotion log could not be read, or could not be trusted.

    Deliberately loud. The alternative to raising is guessing, and the guess a
    newest-file rule would make is exactly the one this log exists to prevent.
    """


@dataclass(frozen=True)
class PromotionRecord:
    """One line of the log: a decision, about one artifact, in one lane."""

    #: The artifact the decision is about — the bundle's stem, an ISO-8601 UTC
    #: instant. Not a path: a lane plus an id locates the file, and a path in
    #: the log would go stale the moment the mount point changed.
    artifact_id: str
    lane: Lane
    decision: Decision
    #: Why. Free text from the gate ("bootstrap P = 0.94", "pr_auc guardrail",
    #: "rollback of 2026-08-28T03:11:07Z"), and never empty.
    reason: str
    #: When the decision was taken — the gate instant, which is also the
    #: `published_at` of every `Forecast` the promoted artifact goes on to
    #: produce.
    at: datetime
    #: The gate's supporting numbers, carried through unread.
    evidence: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not is_artifact_id(self.artifact_id):
            raise ValueError(
                "artifact_id must be an ISO-8601 UTC instant at seconds "
                f"precision, got {self.artifact_id!r}"
            )
        if self.decision not in DECISIONS:
            raise ValueError(
                f"decision must be one of {DECISIONS}, got {self.decision!r}"
            )
        if not self.reason.strip():
            raise ValueError("a decision without a reason is not a decision")
        if self.at.tzinfo is None:
            raise ValueError("the decision instant must be timezone-aware")
        overlap = _RESERVED_KEYS.intersection(self.evidence)
        if overlap:
            raise ValueError(
                f"evidence may not restate the record's own keys: {sorted(overlap)}"
            )

    @property
    def promotes(self) -> bool:
        return self.decision == "promote"

    def to_line(self) -> str:
        """The record as one line of JSON, with no newline in it.

        `json.dumps` escapes any newline inside a string, so a reason pasted
        out of a stack trace cannot turn one decision into two lines.
        """
        payload: dict[str, object] = {
            "artifact_id": self.artifact_id,
            "lane": self.lane.directory_name,
            "decision": self.decision,
            "reason": self.reason,
            "at": format_instant(self.at),
            **dict(self.evidence),
        }
        return json.dumps(payload, ensure_ascii=False)

    @classmethod
    def from_line(cls, text: str, *, line_number: int) -> PromotionRecord:
        """Parse one line, or say precisely which line is wrong."""
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as error:
            raise PromotionLogError(f"line {line_number} is not JSON: {error}") from (
                error
            )
        if not isinstance(parsed, dict):
            raise PromotionLogError(
                f"line {line_number} is not a JSON object: {text[:80]!r}"
            )
        raw: dict[str, object] = parsed
        missing = sorted(_RESERVED_KEYS.difference(raw))
        if missing:
            raise PromotionLogError(f"line {line_number} is missing {missing}")
        try:
            return cls(
                artifact_id=_require_str(raw, "artifact_id", line_number),
                lane=Lane.parse(_require_str(raw, "lane", line_number)),
                decision=_require_decision(raw, line_number),
                reason=_require_str(raw, "reason", line_number),
                at=parse_instant(_require_str(raw, "at", line_number)),
                evidence={
                    key: value for key, value in raw.items() if key not in _RESERVED_KEYS
                },
            )
        except (LaneNameError, ValueError) as error:
            raise PromotionLogError(f"line {line_number} is invalid: {error}") from error


@dataclass(frozen=True)
class PromotionLog:
    """Every decision on the volume, in the order it was taken."""

    path: Path
    records: tuple[PromotionRecord, ...]

    @classmethod
    def read(cls, path: Path) -> PromotionLog:
        """Read the whole log, or raise.

        A missing file is an empty log, not an error: a freshly attached volume
        has taken no decisions. A file that exists and does not parse is an
        error, every time.
        """
        if not path.exists():
            return cls(path=path, records=())
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise PromotionLogError(f"{path} could not be read: {error}") from error
        if text and not text.endswith("\n"):
            raise PromotionLogError(
                f"{path} ends mid-line — the last append did not complete, so the "
                "log cannot be trusted to name what is promoted"
            )
        records: list[PromotionRecord] = []
        for number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                raise PromotionLogError(
                    f"{path} line {number} is blank; an append-only decision log "
                    "has no blank lines, so this one was damaged"
                )
            try:
                records.append(PromotionRecord.from_line(line, line_number=number))
            except PromotionLogError as error:
                raise PromotionLogError(f"{path}: {error}") from error
        return cls(path=path, records=tuple(records))

    def for_lane(self, lane: Lane) -> tuple[PromotionRecord, ...]:
        """Every decision taken about this lane, oldest first."""
        return tuple(record for record in self.records if record.lane == lane)

    def lanes(self) -> tuple[Lane, ...]:
        """The lanes the log has an opinion about, in first-seen order.

        A lane can be named by the log and absent from the volume — a promotion
        whose directory went away. That is a fault worth surfacing, which it can
        only be if the lane is discoverable from here as well as from the mount.
        """
        seen: dict[Lane, None] = {}
        for record in self.records:
            seen.setdefault(record.lane, None)
        return tuple(seen)

    def promoted(self, lane: Lane) -> str | None:
        """The artifact id this lane may serve — ``None`` when there is none.

        *The most recent `promote` line for that lane*, and nothing else. Which
        is what makes a rollback work without a special case: the restoring line
        is simply the most recent one. Refusals are skipped rather than
        forgotten — they stay in :meth:`for_lane`.
        """
        for record in reversed(self.records):
            if record.lane == lane and record.promotes:
                return record.artifact_id
        return None


def append(path: Path, record: PromotionRecord) -> PromotionRecord:
    """Append exactly one decision line, durably.

    The log is read first: appending onto a log that does not parse would build
    an audit trail on top of an unreadable prefix, and the next reader would
    fail on the old damage while trusting nothing after it. One `write` of one
    terminated line, then `fsync`, so a crash leaves the file either without the
    line or with all of it — never with the half :meth:`PromotionLog.read`
    refuses.
    """
    PromotionLog.read(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(record.to_line() + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return record


def _require_str(raw: Mapping[str, object], key: str, line_number: int) -> str:
    value = raw[key]
    if not isinstance(value, str):
        raise PromotionLogError(f"line {line_number}: {key} must be a string")
    return value


def _require_decision(raw: Mapping[str, object], line_number: int) -> Decision:
    value = _require_str(raw, "decision", line_number)
    if value not in DECISIONS:
        raise PromotionLogError(
            f"line {line_number}: decision must be one of {DECISIONS}, got {value!r}"
        )
    # Spelled as a comparison rather than a `cast`: the narrowing is then
    # something the type checker verifies rather than something it is told.
    return "promote" if value == "promote" else "refuse"
