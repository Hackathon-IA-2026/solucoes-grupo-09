"""The A/B matrix, and the row identity that makes it a comparison.

`docs/specs/forecaster.md`: the test-fold calendar is fixed once and shared by
every run in the A/B matrix, "so that A-full, A-common, B-common and the
archive-weather arm are all scored on identical test rows. The training block is
whatever each run's window provides before that fold's start."

Two things follow, and this module is both of them.

**The runs differ in exactly three ways.** Feature set, window start and weather
arm — nothing else, and in particular not the calendar. :class:`MatrixRun` has
no field for a fold, a date range or a test period, so a run cannot carry a
private view of what it is scored on.

**Identity is asserted by hash, never by count.** Two runs with the same number
of test rows can hold different rows: one missing hour and one extra day cancel
in a count and do not cancel in a hash. :func:`assert_identical_test_rows`
compares :func:`row_set_digest` over the full key set, and it compares the
fold's own hash first — because two runs that agree on the rows of *different*
folds agree about nothing.

**What the shapes here make unrepresentable:**

- **A comparison across calendars.** :class:`ScoredFold` carries the
  ``fold_hash`` it was scored under. A run that re-materialised the calendar on
  a different day gets a different hash for the live edge, and the comparison
  fails loudly instead of silently comparing 74 days against 75.
- **A row set with a duplicate.** :func:`row_set_digest` refuses one. A
  duplicated row is a row weighted twice, which changes a metric without
  changing the row set it claims to be over.
- **A row set assembled from whatever the data happened to have.**
  :func:`expected_test_rows` derives the keys from the calendar and the two
  closed enums — four subsystems, twenty-four local hours — which is exactly
  what `feature_rows(...)` builds its spine from: a cross join of the subsystem
  enum and the local day, LEFT JOINed to weather and labels. A subsystem-hour
  with no weather and no settled label is still a row there, so "the rows the
  data had" and "the rows the calendar names" are the same set by construction,
  and a run that returns anything else has a fault worth stopping for.

**What is not here, and why.** The end-to-end assertion — run all four arms
against the database, key the rows they actually return and compare the hashes —
needs the feature function to exist for both feature sets. `features.py` is the
seam and `feature_rows(...)` is in the migration tree, but only the weather
block of set A is populated so far and `dessem_augmented_v1` has no columns of
its own yet. :meth:`RowKey.from_feature_row` is the adapter that assertion will
use, and it is tested against the row shape the migration declares; the
assertion itself is deliberately absent rather than written against a stub, because
a row-identity test that passes against fabricated rows is worse than no test.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from itertools import pairwise
from typing import Any, Literal

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation.folds import Fold, FoldCalendar, FoldCalendarError
from wattsteer_ml.features import BRASILIA, FeatureSet

#: Local hours in a target day. The same twenty-four `feature_rows(...)` builds
#: its spine from, and the same count
#: :func:`wattsteer_ml.optimizer.horizon.local_day` asserts: Brazil's last DST
#: transition predates the data window, so no 23- or 25-hour day exists in
#: range. A day that is not 24 hours long is refused rather than absorbed.
HOURS_PER_DAY = 24

#: The two arms of the weather lead-time A/B. Both are *evaluated* on the
#: lead-matched features, because that is what serving provides; the arm names
#: which features the model was **trained** on.
WeatherArm = Literal["lead_matched", "archive"]


class RowIdentityError(ValueError):
    """Two runs were scored on different test rows.

    Raised by :func:`assert_identical_test_rows`. It is the failure the whole
    protocol is arranged around: every number in the matrix still looks fine
    when this happens, and nothing else notices.
    """


@dataclass(frozen=True, order=True)
class RowKey:
    """One scored row: a target date, a local hour and a subsystem.

    Ordered, so that a row set has one canonical spelling to hash. That order is
    this dataclass's field order and nothing else's — deliberately **not** the
    order `feature_rows(...)` returns rows in, which sorts subsystems by the
    Postgres enum's ordinal rather than by their code. Row identity is a
    statement about a *set*, so the query's order is not something this module
    needs, reproduces or asserts.
    """

    target_date: date
    local_hour: int
    subsystem: Subsystem

    def __post_init__(self) -> None:
        if not 0 <= self.local_hour < HOURS_PER_DAY:
            raise ValueError(
                f"local hour {self.local_hour!r} is outside the "
                f"{HOURS_PER_DAY}-hour target day of "
                f"{self.target_date.isoformat()}"
            )
        if self.subsystem not in SUBSYSTEM_CODES:
            raise ValueError(
                f"{self.subsystem!r} is not one of the four subsystems "
                f"{SUBSYSTEM_CODES!r}"
            )

    @property
    def line(self) -> str:
        """The key as hashed. One line, three fields, no separator collision."""
        return f"{self.target_date.isoformat()}\t{self.local_hour:02d}\t{self.subsystem}"

    @classmethod
    def from_feature_row(cls, row: Mapping[str, Any]) -> RowKey:
        """The key of a row `feature_rows(...)` returned.

        ``valid_time`` is a UTC instant and ``target_date`` is the civil day it
        belongs to, so the local hour is the offset between the two on the
        grid's clock — derived, never assumed to equal the UTC hour, which it is
        not for any hour of any Brazilian day.
        """
        for column in ("subsystem", "target_date", "valid_time"):
            if column not in row:
                raise RowIdentityError(
                    f"a feature row must carry {column!r} to be identified; got "
                    f"{sorted(row)!r}"
                )
        target_date = row["target_date"]
        valid_time = row["valid_time"]
        if not isinstance(target_date, date) or isinstance(target_date, datetime):
            raise RowIdentityError(
                f"target_date must be a civil date, got {target_date!r}"
            )
        if not isinstance(valid_time, datetime) or valid_time.tzinfo is None:
            raise RowIdentityError(
                f"valid_time must be an aware instant, got {valid_time!r}"
            )
        local_midnight = datetime.combine(
            target_date, datetime.min.time(), tzinfo=BRASILIA
        )
        offset = valid_time.astimezone(BRASILIA) - local_midnight
        if offset % timedelta(hours=1):
            raise RowIdentityError(
                f"{valid_time.isoformat()} is not a whole local hour into "
                f"{target_date.isoformat()}"
            )
        return cls(
            target_date=target_date,
            local_hour=offset // timedelta(hours=1),
            subsystem=row["subsystem"],
        )


@dataclass(frozen=True)
class MatrixRun:
    """One arm of the experiment matrix.

    `docs/specs/forecaster.md`, "The DESSEM A/B" and "The weather lead-time
    A/B". Three differences and no fourth: there is no field for a fold, a date
    range or a test period, so a run cannot hold a private view of what it is
    scored on.
    """

    name: str
    feature_set: FeatureSet
    #: The run's training window start. The only reason two runs of the same
    #: feature set differ.
    window_start: date
    weather_arm: WeatherArm
    #: What this arm exists to isolate, in one line, for the reviewer reading
    #: the matrix rather than the spec.
    isolates: str

    def decision_grade_folds(self, calendar: FoldCalendar) -> tuple[str, ...]:
        """The folds in which this run's base fit is long enough to decide.

        `docs/specs/forecaster.md`, "Which folds are decision-grade". It is what
        restricts the DESSEM verdict to two test quarters, and it is stated
        rather than footnoted because it is the single largest reason that
        answer might be wrong.
        """
        minimum = calendar.rules.min_base_fit_days
        return tuple(
            fold.id
            for fold in calendar.folds
            if fold.is_decision_grade(self.window_start, minimum)
        )


#: `dessem_free_v1`'s full window, opening where solar constrained-off begins.
_FULL_WINDOW_START = date(2024, 4, 1)

#: `dessem_augmented_v1` starts here, and A-common shares the date so that the
#: short-window handicap is absorbed by an arm of its own rather than charged to
#: DESSEM's features.
_COMMON_WINDOW_START = date(2025, 5, 23)

#: The matrix, in the spec's order. Every one of these is scored on the same
#: calendar, and — fold for fold — on the same rows.
MATRIX_RUNS: tuple[MatrixRun, ...] = (
    MatrixRun(
        name="A-full",
        feature_set="dessem_free_v1",
        window_start=_FULL_WINDOW_START,
        weather_arm="lead_matched",
        isolates="the product's actual set-A model",
    ),
    MatrixRun(
        name="A-common",
        feature_set="dessem_free_v1",
        window_start=_COMMON_WINDOW_START,
        weather_arm="lead_matched",
        isolates="the short-window handicap, so it is not charged to DESSEM",
    ),
    MatrixRun(
        name="B-common",
        feature_set="dessem_augmented_v1",
        window_start=_COMMON_WINDOW_START,
        weather_arm="lead_matched",
        isolates="DESSEM's contribution, against A-common",
    ),
    MatrixRun(
        name="A-full-archive",
        feature_set="dessem_free_v1",
        window_start=_FULL_WINDOW_START,
        weather_arm="archive",
        isolates="the size of the weather lead-time leak, evaluated lead-matched",
    ),
)

MATRIX_RUN_BY_NAME: dict[str, MatrixRun] = {run.name: run for run in MATRIX_RUNS}


@dataclass(frozen=True)
class ScoredFold:
    """What one run was scored on, in one fold, as a claim that can be checked.

    Built through :meth:`of` so the digest is never supplied by the caller: a
    run that computed its own hash of what it meant to score is a run whose
    hash cannot disagree with what it scored.
    """

    run: str
    fold_id: str
    fold_hash: str
    row_digest: str
    row_count: int

    @classmethod
    def of(cls, run: str, fold: Fold, rows: Iterable[RowKey]) -> ScoredFold:
        keys = tuple(rows)
        return cls(
            run=run,
            fold_id=fold.id,
            fold_hash=fold.fold_hash,
            row_digest=row_set_digest(keys),
            row_count=len(keys),
        )


def expected_test_rows(test_start: date, test_end: date) -> tuple[RowKey, ...]:
    """Every row a fold's test period contains.

    Four subsystems by twenty-four local hours by the days of the period. This
    is the calendar's own statement of what a run must be scored on, and it is
    derived from two closed enums and a date range — never from what a query
    happened to return.
    """
    if test_start > test_end:
        raise FoldCalendarError(
            f"empty test period {test_start.isoformat()} to {test_end.isoformat()}"
        )
    days = (test_end - test_start).days + 1
    return tuple(
        RowKey(
            target_date=test_start + timedelta(days=day),
            local_hour=hour,
            subsystem=subsystem,
        )
        for day in range(days)
        for hour in range(HOURS_PER_DAY)
        for subsystem in SUBSYSTEM_CODES
    )


def row_set_digest(rows: Iterable[RowKey]) -> str:
    """sha256 over the sorted row keys, hex, prefixed.

    Sorted, so the digest is a statement about the *set* and two runs that
    emitted rows in different orders still agree. Duplicates are refused rather
    than collapsed: a row present twice is a row weighted twice, which moves a
    metric without moving the set it claims to be over.
    """
    keys = sorted(rows)
    for earlier, later in pairwise(keys):
        if earlier == later:
            raise RowIdentityError(
                f"the row set contains {earlier.line!r} twice; a duplicated row is "
                "weighted twice and the set it claims to be over is unchanged"
            )
    payload = "\n".join(key.line for key in keys).encode()
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def assert_identical_test_rows(scored: Sequence[ScoredFold]) -> str:
    """Every run here was scored on the same fold and the same rows.

    Returns the shared row digest, so a caller can stamp it on the comparison it
    is about to publish.

    The fold hash is checked before the rows. Two runs scored on identical rows
    of *different* folds — a live edge materialised on two different days, say —
    would otherwise be reported as a row mismatch, which sends the reader
    looking in the wrong place.
    """
    if len(scored) < 2:
        raise RowIdentityError(
            "a comparison needs at least two runs; got "
            f"{[entry.run for entry in scored]!r}"
        )
    first = scored[0]
    for entry in scored[1:]:
        if entry.fold_id != first.fold_id:
            raise RowIdentityError(
                f"{first.run} was scored on {first.fold_id} and {entry.run} on "
                f"{entry.fold_id}; these are not the same comparison"
            )
        if entry.fold_hash != first.fold_hash:
            raise RowIdentityError(
                f"{first.run} and {entry.run} both report {first.fold_id}, but "
                f"under different calendars ({first.fold_hash} and "
                f"{entry.fold_hash}). The fold calendar is fixed once and shared; "
                "it is not recomputed per run."
            )
        if entry.row_digest != first.row_digest:
            raise RowIdentityError(
                f"{first.run} and {entry.run} were scored on different rows of "
                f"{first.fold_id}: {first.row_digest} over {first.row_count} rows "
                f"against {entry.row_digest} over {entry.row_count} rows. Equal "
                "counts would not have made these the same rows."
            )
    return first.row_digest
