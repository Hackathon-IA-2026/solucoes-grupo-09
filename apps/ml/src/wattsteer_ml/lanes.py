"""Lane identity — the addressable unit a forecast is served from.

An artifact's identity is the triple **(feature set, gate profile, threshold)**
(`docs/specs/forecaster.md`, "The artifact, and exactly what the gate checks").
Not the file, and not the instant it was written: two bundles trained on
different feature sets are not two versions of one model, they are two models,
and "newer" between them means nothing. The gate says so in its first check —
"a different triple is a different lane and is never a swap" — and the threshold
sweep depends on it, since 1 MW, 5 MW and 10 MW produce three lanes of which
only the 5 MW one is ever promoted.

So the triple gets a directory, and this module is the only place that knows how
the triple and the directory name are written as each other::

    Lane("dessem_free_v1", "gate_late", 5) ⇄ "dessem_free_v1__gate_late__thr5"

**What the shapes here make unrepresentable**, in the manner of
:mod:`wattsteer_ml.mixture`:

- **A lane whose directory name is ambiguous.** ``__`` separates the three
  segments, so a segment may not contain one; a segment is validated on
  construction rather than on parse, which means a :class:`Lane` that exists at
  all has a name that splits back into it. There is no lane you can build and
  then fail to find.
- **Two directories naming one lane.** ``thr5``, ``thr05`` and ``thr5.0`` would
  all read back as 5 MW, and a volume holding two of them would have two
  answers to "what is promoted here". :meth:`Lane.parse` accepts only the
  canonical spelling — the one :attr:`Lane.directory_name` produces — so the
  second directory is not a lane at all and is reported as unrecognised rather
  than merged into the first.
- **A lane on the free-floating volume root.** The root holds lane directories
  and the promotion log; a ``.joblib`` sitting directly in it belongs to no
  lane, and there is no code path that can serve one.

**Instants, once.** Artifact ids and promotion-log timestamps are the same kind
of thing — an ISO-8601 UTC instant, seconds precision, ``Z``-suffixed — and are
formatted here so they cannot drift apart. Fixed width and fixed offset is what
makes lexical order equal chronological order, which is the entire reason the
spec can say "there is no `current` symlink to go stale".
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime

#: Separates the three segments of a lane directory name. Two underscores,
#: because the segments themselves contain single ones (`dessem_free_v1`).
LANE_SEPARATOR = "__"

#: Marks the third segment as the threshold, in MW.
THRESHOLD_PREFIX = "thr"

#: A lane segment: alphanumerics joined by *single* underscores. Rejects the
#: empty string, a leading or trailing underscore, a doubled one, a dot and a
#: path separator — every spelling that would make the directory name split
#: into something other than the lane it was built from.
_SEGMENT = re.compile(r"\A[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\Z")

#: An artifact id: an ISO-8601 UTC instant at seconds precision. The stem of
#: the bundle and of its card, and the `artifact_id` the model card and the
#: promotion log both carry.
_ARTIFACT_ID = re.compile(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\Z")


class LaneNameError(ValueError):
    """A directory name that does not name a lane.

    Raised by :meth:`Lane.parse`; :meth:`Lane.try_parse` returns ``None``
    instead, which is what volume inspection uses — a stray directory on the
    mount is a thing to report, not a thing to crash on.
    """


@dataclass(frozen=True)
class Lane:
    """The triple an artifact is bound to, and the directory it lives in."""

    #: `dessem_free_v1` | `dessem_augmented_v1` — the feature set
    #: (`docs/specs/feature-engineering.md`). Kept as a string rather than a
    #: literal: the feature function is a separate spec, and pinning its
    #: members here would make this module wrong the moment it names a third.
    feature_set: str
    #: `gate_early` | `gate_late` — the publication gate profile, which fixes
    #: which weather run and which DESSEM vintage the features may see.
    gate_profile: str
    #: `curtailment_threshold_mw` in force for this lane. A magnitude without
    #: the threshold that produced it cannot be compared with another one
    #: (`docs/domain-model.md` §8.3), which is why it is part of the identity
    #: rather than a parameter of the artifact.
    threshold_mw: float

    def __post_init__(self) -> None:
        for name, value in (
            ("feature_set", self.feature_set),
            ("gate_profile", self.gate_profile),
        ):
            if not _SEGMENT.match(value):
                raise LaneNameError(
                    f"{name} must be alphanumerics joined by single underscores, "
                    f"got {value!r}"
                )
        threshold = self.threshold_mw
        if not math.isfinite(threshold) or threshold <= 0:
            raise LaneNameError(
                f"threshold_mw must be a finite positive MW value, got {threshold!r}"
            )

    @property
    def directory_name(self) -> str:
        """The one spelling of this lane on the volume."""
        return LANE_SEPARATOR.join(
            (
                self.feature_set,
                self.gate_profile,
                f"{THRESHOLD_PREFIX}{_format_threshold(self.threshold_mw)}",
            )
        )

    @classmethod
    def parse(cls, name: str) -> Lane:
        """Read a lane back out of its directory name.

        Only the canonical spelling is accepted: the parse is checked against
        :attr:`directory_name` before it is returned, so ``thr05`` is not a
        second name for the 5 MW lane — it is not a lane.
        """
        parts = name.split(LANE_SEPARATOR)
        if len(parts) != 3:
            raise LaneNameError(
                f"a lane name is three {LANE_SEPARATOR!r}-separated segments, "
                f"got {name!r}"
            )
        feature_set, gate_profile, threshold_part = parts
        if not threshold_part.startswith(THRESHOLD_PREFIX):
            raise LaneNameError(
                f"the third segment must start with {THRESHOLD_PREFIX!r}, "
                f"got {threshold_part!r}"
            )
        try:
            threshold = float(threshold_part[len(THRESHOLD_PREFIX) :])
        except ValueError as error:
            raise LaneNameError(
                f"{threshold_part!r} does not name a threshold in MW"
            ) from error
        lane = cls(
            feature_set=feature_set,
            gate_profile=gate_profile,
            threshold_mw=threshold,
        )
        if lane.directory_name != name:
            raise LaneNameError(
                f"{name!r} is not the canonical spelling of a lane; "
                f"that lane is written {lane.directory_name!r}"
            )
        return lane

    @classmethod
    def try_parse(cls, name: str) -> Lane | None:
        """:meth:`parse`, or ``None`` — for walking a directory nobody owns."""
        try:
            return cls.parse(name)
        except LaneNameError:
            return None

    def __str__(self) -> str:
        return self.directory_name


def _format_threshold(value: float) -> str:
    """``5.0 → "5"``, ``2.5 → "2.5"`` — the shortest spelling that round-trips.

    ``repr`` rather than a fixed number of decimals, because the parse is
    ``float()`` and the two have to be exact inverses for
    :meth:`Lane.parse`'s canonicality check to be satisfiable at all.
    """
    return str(int(value)) if value.is_integer() else repr(value)


def format_instant(moment: datetime) -> str:
    """An artifact id / log timestamp: ISO-8601 UTC, seconds, ``Z``-suffixed.

    Seconds precision on purpose. The retrain is weekly and the gate is one
    decision, so sub-second resolution buys nothing — while a fixed-width stem
    is what lets a plain lexical sort of a lane's filenames be a chronological
    one.
    """
    if moment.tzinfo is None:
        raise ValueError(f"an instant must be timezone-aware, got {moment!r}")
    return (
        moment.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )


def parse_instant(text: str) -> datetime:
    """Read an instant written by :func:`format_instant`.

    Accepts any ISO-8601 form Python can read *provided it carries an offset*:
    a naive timestamp in an append-only log is a timestamp whose meaning
    depends on where the reader is standing.
    """
    moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        raise ValueError(f"{text!r} carries no UTC offset")
    return moment.astimezone(UTC)


def is_artifact_id(text: str) -> bool:
    """Whether a filename stem is an artifact id and not something copied in.

    ``2026-08-28T03:11:07Z`` is; ``2026-08-28T03:11:07Z copy``,
    ``model-final`` and a half-written ``.joblib.tmp`` stem are not. The
    check is what stops a stray file in a lane directory from being counted as
    an artifact — and, since promotion resolves by id, from ever being served.
    """
    return bool(_ARTIFACT_ID.match(text))
