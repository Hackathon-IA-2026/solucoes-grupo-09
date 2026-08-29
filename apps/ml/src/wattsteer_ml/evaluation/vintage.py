"""Every fold carries a `VintageFidelity`, and a straddling fold carries two.

`docs/specs/forecaster.md`, "The revision-optimistic label across the go-live
boundary". A fold whose test period ends before ingestion go-live is
`revision_optimistic` in full; one that starts after it is `point_in_time`; and
**a fold that straddles go-live is split at that date and reported as two rows,
never averaged — because averaging is precisely how a caveat disappears.**

**Why this module names no go-live date.** `T_go` is a deployment fact, not a
modelling constant, and it lives in `canonical_read_go_live`: one instant per
read, and the fidelity of a composed answer is the weakest link across the reads
it used (:func:`wattsteer_ml.canonical.combine_fidelity`,
:func:`wattsteer_ml.canonical.combine_go_live`). So every function here takes
``go_live_at`` as an argument and there is no default and no constant to import.

That is also the honest position on an **open question this ticket does not
settle**: `docs/specs/replay.md` partitions the window on the assumption that
ingestion go-live coincides with F6's start, 2026-07-01, while
`docs/specs/forecaster.md` treats the calendar and `T_go` as independent and
explicitly specifies the straddling fold. They cannot both be structural. If
they do coincide, :func:`stamp_fidelity` simply never returns two segments —
which is the correct behaviour under either reading, and is why this module can
be built before the question is answered. It must not be answered *here*, by a
constant nobody argued for.

**What the shapes here make unrepresentable:**

- **An averaged straddling row.** :func:`stamp_fidelity` returns a tuple of
  segments, never a fold with a fidelity attached; a straddling fold returns two
  of them and there is no operation on this module's types that merges them.
  :func:`pooled_fidelity` — the one function that reduces several segments to a
  single label — raises :class:`MixedFidelityError` rather than picking one.
- **A segment whose fidelity was decided by a different rule.** The inequality
  is :func:`wattsteer_ml.canonical.vintage_fidelity`'s, applied to each
  segment's earliest valid instant. This module converts dates to instants and
  does not re-decide anything.
- **A segment that has lost its fold.** Each carries the fold's id and hash, so
  a row in a metrics table can still say which calendar produced it.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from wattsteer_ml.canonical import VintageFidelity, vintage_fidelity
from wattsteer_ml.evaluation.folds import Fold, FoldCalendar
from wattsteer_ml.features import BRASILIA

_ONE_DAY = timedelta(days=1)

#: Separates a fold id from a fidelity in a split fold's row id. Chosen because
#: `/` already separates the segments of a cache key and `__` already separates
#: the segments of a lane name; a third meaning for either would be a name that
#: parses two ways.
ROW_ID_SEPARATOR = "@"


class MixedFidelityError(ValueError):
    """Two fidelities were about to be reduced to one number.

    The one error this module exists to raise. A `qloss_mwh` averaged over a
    `revision_optimistic` quarter and a `point_in_time` one is a number with no
    caveat and no way to recover the caveat it lost.
    """


@dataclass(frozen=True)
class FoldSegment:
    """A reported row: a fold, or one side of a fold split at go-live.

    ``row_id`` is what a metrics table keys on. For an unsplit fold it is the
    fold id, so the common case reads exactly as the spec's table does; for a
    split one it is ``F6@revision_optimistic`` / ``F6@point_in_time``, which
    cannot be mistaken for a fold and cannot be silently summed with its twin.
    """

    fold_id: str
    row_id: str
    fidelity: VintageFidelity
    test_start: date
    test_end: date
    #: Whether this segment is one of two. Carried rather than inferred: a
    #: report that shows one half of a split fold must be able to say so.
    is_split: bool
    #: The fold's :attr:`wattsteer_ml.evaluation.folds.Fold.fold_hash`.
    fold_hash: str

    def __post_init__(self) -> None:
        if self.test_start > self.test_end:
            raise ValueError(
                f"{self.row_id}: empty test period "
                f"{self.test_start.isoformat()} to {self.test_end.isoformat()}"
            )
        expected = (
            f"{self.fold_id}{ROW_ID_SEPARATOR}{self.fidelity}"
            if self.is_split
            else self.fold_id
        )
        if self.row_id != expected:
            raise ValueError(
                f"row id {self.row_id!r} does not name this segment; it is {expected!r}"
            )

    @property
    def test_days(self) -> int:
        return (self.test_end - self.test_start).days + 1

    @property
    def segment_hash(self) -> str:
        """This row's identity: the fold's hash, its own dates and its fidelity.

        A split fold's two rows differ here, so neither can be cached over the
        other and neither can be served as "the fold".
        """
        payload = "\t".join(
            (
                self.fold_hash,
                self.row_id,
                self.fidelity,
                self.test_start.isoformat(),
                self.test_end.isoformat(),
            )
        )
        return f"sha256:{hashlib.sha256(payload.encode()).hexdigest()}"

    def __str__(self) -> str:
        return f"{self.row_id} [{self.fidelity}] {self.test_days}d"


def earliest_valid_instant(target_date: date) -> datetime:
    """The first instant belonging to a target date, in UTC.

    Local midnight on the grid's civil clock. Fidelity is a property of the
    *weakest* hour of a window, so this is the instant a whole day's fidelity is
    decided by — which is the same convention
    :func:`wattsteer_ml.canonical.vintage_fidelity` applies to any window.
    """
    return datetime.combine(target_date, time(0), tzinfo=BRASILIA).astimezone(UTC)


def first_point_in_time_date(go_live_at: datetime | None) -> date | None:
    """The earliest target date that is honestly point-in-time.

    ``None`` when ``go_live_at`` is ``None``: a source that has ingested nothing
    has no such date, and an empty table cannot have been watching. A go-live
    instant that falls part-way through a civil day makes that whole day
    revision-optimistic — the day's earlier hours predate it — so the boundary
    is the following day.
    """
    if go_live_at is None:
        return None
    local = go_live_at.astimezone(BRASILIA)
    boundary = local.date()
    if local.time() != time(0):
        boundary += _ONE_DAY
    return boundary


def stamp_fidelity(fold: Fold, go_live_at: datetime | None) -> tuple[FoldSegment, ...]:
    """The one or two rows this fold is reported as.

    One segment when the whole test period sits on one side of go-live; two,
    split at the first point-in-time target date, when it straddles. Never a
    third, and never one averaged row: the caller receives a tuple and the only
    reduction this module offers is :func:`pooled_fidelity`, which refuses a
    mixed one.
    """
    boundary = first_point_in_time_date(go_live_at)
    if boundary is None or not fold.test_start < boundary <= fold.test_end:
        return (
            _segment(
                fold,
                fold.test_start,
                fold.test_end,
                _fidelity_of(fold.test_start, go_live_at),
                is_split=False,
            ),
        )
    return (
        _segment(
            fold,
            fold.test_start,
            boundary - _ONE_DAY,
            "revision_optimistic",
            is_split=True,
        ),
        _segment(fold, boundary, fold.test_end, "point_in_time", is_split=True),
    )


def stamp_calendar(
    calendar: FoldCalendar, go_live_at: datetime | None
) -> tuple[FoldSegment, ...]:
    """Every fold of a calendar, stamped, in fold order.

    The rows a metrics table has, before any model has run. Six folds with one
    straddling go-live produce seven rows, and the report is seven rows long.
    """
    return tuple(
        segment for fold in calendar.folds for segment in stamp_fidelity(fold, go_live_at)
    )


def pooled_fidelity(segments: Sequence[FoldSegment]) -> VintageFidelity:
    """The fidelity of a number pooled over these segments, or a refusal.

    The reliability curve is computed on pooled out-of-fold predictions, and the
    pool has to be able to state its own fidelity. It can, when every segment
    agrees; when they do not, the pooled number would be `revision_optimistic`
    with no way to say how much of it was — so this raises instead, and the
    caller pools within a fidelity or reports two numbers.

    An empty sequence raises for the same reason
    :func:`wattsteer_ml.canonical.combine_fidelity` calls an empty list
    revision-optimistic: nothing was consulted. Here it is an error rather than
    a value, because an empty pool has no metric to label in the first place.
    """
    if not segments:
        raise MixedFidelityError("an empty pool has no fidelity to state")
    fidelities = {segment.fidelity for segment in segments}
    if len(fidelities) > 1:
        rows = ", ".join(f"{s.row_id}={s.fidelity}" for s in segments)
        raise MixedFidelityError(
            "these segments do not share a vintage fidelity and must not be "
            f"pooled into one number: {rows}. Report them as separate rows — "
            "averaging is precisely how a caveat disappears."
        )
    return fidelities.pop()


def assert_no_averaged_rows(segments: Sequence[FoldSegment]) -> None:
    """No fold appears once when it should appear twice, or twice as one row.

    The check a report runs on the rows it is about to print. Two failures are
    caught: a fold present as a single row *and* as split rows, which means
    something averaged and something did not; and two rows for one fold sharing
    a fidelity, which means a fold was split on something other than go-live.
    """
    by_fold: dict[str, list[FoldSegment]] = {}
    for segment in segments:
        by_fold.setdefault(segment.fold_id, []).append(segment)
    for fold_id, rows in by_fold.items():
        if len(rows) == 1:
            if rows[0].is_split:
                raise MixedFidelityError(
                    f"{fold_id} is reported as one half of a split fold and its "
                    "other half is missing"
                )
            continue
        if len(rows) != 2:
            raise MixedFidelityError(
                f"{fold_id} is reported as {len(rows)} rows; a fold is one row, or "
                "two when it straddles go-live"
            )
        if not all(row.is_split for row in rows):
            raise MixedFidelityError(
                f"{fold_id} is reported both as a whole fold and as a split one; "
                "one of those two numbers averaged across go-live"
            )
        if rows[0].fidelity == rows[1].fidelity:
            raise MixedFidelityError(
                f"{fold_id} is split into two rows of the same fidelity "
                f"{rows[0].fidelity!r}; the only split this protocol defines is at "
                "ingestion go-live"
            )


def _fidelity_of(window_start: date, go_live_at: datetime | None) -> VintageFidelity:
    """One segment's fidelity, decided by the canonical rule and not a second one."""
    return vintage_fidelity(earliest_valid_instant(window_start), go_live_at)


def _segment(
    fold: Fold,
    test_start: date,
    test_end: date,
    fidelity: VintageFidelity,
    *,
    is_split: bool,
) -> FoldSegment:
    row_id = f"{fold.id}{ROW_ID_SEPARATOR}{fidelity}" if is_split else fold.id
    return FoldSegment(
        fold_id=fold.id,
        row_id=row_id,
        fidelity=fidelity,
        test_start=test_start,
        test_end=test_end,
        is_split=is_split,
        fold_hash=fold.fold_hash,
    )
