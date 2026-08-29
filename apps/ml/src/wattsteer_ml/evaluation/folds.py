"""The fold calendar — fixed once, shared by every run, and hashed.

`docs/specs/forecaster.md`, "The fold-evaluation protocol", is the authority.
Note the name: this is **fold evaluation**, the walk-forward harness that scores
model quality on held-out folds and produces `qloss_mwh`. It is not a Backtest.
`docs/domain-model.md` §`Replay` and `Backtest` gives that noun to a different
object — the aggregate of many Replays, each a full plan-and-score against the
reference fleet, consumed by the hot-swap gate. Two harnesses, two outputs, two
names, and nothing in this package borrows the other one's.

**The discipline is the deliverable.** A-full, A-common, B-common and the
archive-weather arm are comparable only if they were scored on identical test
rows. A calendar that can be recomputed per run, shuffled, or silently
re-derived from a different window makes every comparison in the matrix
meaningless while every number still looks fine — which is the whole failure
mode this module exists to make unrepresentable.

**What the shapes here make unrepresentable**, in the manner of
:mod:`wattsteer_ml.mixture` and :mod:`wattsteer_ml.lanes`:

- **A calendar that is not *the* calendar.** :class:`FoldCalendar` re-derives
  its folds from its rules and its ``as_of`` in ``__post_init__`` and refuses
  any tuple that is not exactly that. So a calendar object cannot be built by
  hand, by a per-run tweak, or by dropping an awkward fold: the only degree of
  freedom a caller has is ``as_of``, and ``as_of`` moves nothing but the live
  edge (see below).
- **A shuffled fold order.** Folds are a tuple, validated to carry
  ``index = 1…n`` in ascending order with contiguous, non-overlapping test
  periods. There is no sort, no reorder and no setter. A shuffled tuple is
  reported as shuffled — :class:`FoldOrderError` — rather than quietly re-sorted
  into looking fine.
- **A training block that overlaps its own calibration window.**
  :class:`FoldBlocks` is the only value that carries the base-fit block, the
  calibration window and the test period, it produces all three together, and it
  refuses any triple that is not strictly ordered and disjoint. There is no way
  to obtain one of the three without the other two, so no caller can fit base
  learners on a range it chose separately.
- **A calibration window that is not the most recent 90 days.** It is derived
  from ``train_end`` and ``calibration_days``, never supplied; the pinned table
  in `fold_calendar.yaml` is checked against that derivation at load.
- **A fold result that outlives the calendar that produced it.**
  :attr:`Fold.fold_hash` folds the rules' hash into the fold's own dates, and
  :meth:`Fold.cache_key` is built from it. Editing the YAML changes every hash
  and therefore every cache key; growing the live edge changes that fold's hash
  and no other's, which is exactly the set of results a day's new rows
  invalidate.

**The live edge, without a manual edit.** The rules generate quarters. The last
quarter that has started is truncated at ``as_of − 1`` and is the live edge; the
day it reaches its own quarter end it is complete, ``is_live_edge`` goes false,
its hash stops moving, and the following quarter opens by itself on the next
call. Nothing in the YAML names F6, F7 or a count.

**Why ``as_of`` is safe to vary and everything else is not.** Two runs
materialising the calendar on different days agree, fold for fold, on every
frozen fold — same dates, same ``fold_hash`` — and disagree only about the live
edge, which genuinely holds different rows on the two days. That disagreement is
not smoothed over: it surfaces as a differing ``fold_hash``, which
:func:`wattsteer_ml.evaluation.matrix.assert_identical_test_rows` refuses.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from itertools import pairwise
from pathlib import Path
from typing import cast

import yaml

#: The calendar, beside this module. Loaded, never generated.
FOLD_CALENDAR_PATH = Path(__file__).with_name("fold_calendar.yaml")

#: Fold ids are ``F1``, ``F2``, … in materialisation order. One-based, because
#: the spec's table is, and a fold called ``F0`` in a report would be a fold
#: nobody can look up.
_FOLD_ID_PREFIX = "F"

_ONE_DAY = timedelta(days=1)

_MONTHS_PER_YEAR = 12


class FoldCalendarError(ValueError):
    """The calendar on disk, or the calendar in hand, is not a calendar.

    Every failure in this module is one of these or a subclass. There is no
    path that returns a best-effort calendar: a harness that cannot say which
    rows it is scoring must stop, not score something.
    """


class FoldOrderError(FoldCalendarError):
    """Folds out of order, overlapping, or renumbered.

    Its own class because "the folds were shuffled" is the specific accident
    the protocol forbids by name, and a caller catching it should not have to
    read a message to tell it from a malformed YAML file.
    """


class FoldWindowError(FoldCalendarError):
    """A run's window leaves this fold no base-fit block at all.

    Raised by :meth:`Fold.blocks_for`. It is not "zero rows": a window that
    starts inside or after the calibration window means the run has nothing to
    fit base learners on in this fold, which is a fact about the *matrix* — see
    :meth:`Fold.is_decision_grade`, which answers the same question without
    raising.
    """


@dataclass(frozen=True)
class FoldBlocks:
    """The three blocks of one fold, for one run's window, produced together.

    The spec's rule, in one value: base learners are fitted on
    ``train − calibration``; isotonic and the two conformal scalars are fitted
    on the calibration window; **the base learners are not refit afterwards**.
    Refitting would put the calibration data in-sample and shrink the conformal
    correction toward zero, which is the failure that produces a confident,
    narrow, wrong interval.

    There is no constructor that yields one block without the others, and the
    ordering below is checked on construction, so "the base fit accidentally
    saw the calibration window" is not a state this type can be in.

    There is **no purge** beyond the base-fit / calibration split. Trailing
    feature windows do cross the train/test boundary, but they cross it
    *forward* — a test row's 7-day aggregate is computed from labels in the
    training period, which is point-in-time information the serving path also
    has. There is no label leaking backward.
    """

    #: The run's window start, or the calendar's, whichever is later.
    base_fit_start: date
    #: The day before the calibration window opens.
    base_fit_end: date
    calibration_start: date
    calibration_end: date
    test_start: date
    test_end: date

    def __post_init__(self) -> None:
        ordered = (
            self.base_fit_start,
            self.base_fit_end,
            self.calibration_start,
            self.calibration_end,
            self.test_start,
            self.test_end,
        )
        if self.base_fit_start > self.base_fit_end:
            raise FoldWindowError(
                f"the base-fit block is empty: {self.base_fit_start.isoformat()} "
                f"to {self.base_fit_end.isoformat()}"
            )
        if self.base_fit_end >= self.calibration_start:
            raise FoldCalendarError(
                "the base-fit block and the calibration window must be disjoint; "
                f"base fit ends {self.base_fit_end.isoformat()} and calibration "
                f"opens {self.calibration_start.isoformat()}"
            )
        if self.calibration_start > self.calibration_end:
            raise FoldCalendarError(
                f"the calibration window is empty: "
                f"{self.calibration_start.isoformat()} to "
                f"{self.calibration_end.isoformat()}"
            )
        if self.calibration_end >= self.test_start:
            raise FoldCalendarError(
                "the training block must end before the test period opens; "
                f"training ends {self.calibration_end.isoformat()} and testing "
                f"opens {self.test_start.isoformat()}"
            )
        if self.test_start > self.test_end:
            raise FoldCalendarError(
                f"the test period is empty: {self.test_start.isoformat()} to "
                f"{self.test_end.isoformat()}"
            )
        if list(ordered) != sorted(ordered):
            raise FoldCalendarError(f"blocks are not in chronological order: {ordered!r}")

    @property
    def train_start(self) -> date:
        """The training block opens where the base fit does."""
        return self.base_fit_start

    @property
    def train_end(self) -> date:
        """The training block closes where the calibration window does.

        The calibration window is carved *out of* the training block, so the
        latest training target date is the last calibration day and not the last
        base-fit day. This is the value the never-shuffled assertion compares
        against :attr:`test_start`.
        """
        return self.calibration_end

    @property
    def base_fit_days(self) -> int:
        return _inclusive_days(self.base_fit_start, self.base_fit_end)

    @property
    def calibration_days(self) -> int:
        return _inclusive_days(self.calibration_start, self.calibration_end)

    @property
    def test_days(self) -> int:
        return _inclusive_days(self.test_start, self.test_end)


@dataclass(frozen=True)
class Fold:
    """One test fold of the shared calendar.

    A fold owns its test period and its training *boundary* — ``train_end`` and
    the calibration window — and deliberately not a training *start*: "the
    training block is whatever each run's window provides before that fold's
    start". :meth:`blocks_for` is where a run's window meets the calendar.
    """

    #: ``F1``, ``F2``, … — the spec's own labels.
    id: str
    #: One-based position. Equal to the position in
    #: :attr:`FoldCalendar.folds` plus one, which is what makes a renumbered
    #: tuple detectable.
    index: int
    test_start: date
    #: ``as_of − 1`` while this fold is the live edge, ``quarter_end`` after.
    test_end: date
    #: Where this fold's test period will end once it has frozen. Fixed by the
    #: calendar rules and never by the clock.
    quarter_end: date
    train_end: date
    calibration_start: date
    calibration_end: date
    #: The hash of the rules that generated this fold. Carried rather than
    #: looked up, so a :class:`Fold` handed around on its own still says which
    #: calendar it belongs to.
    rules_digest: str

    def __post_init__(self) -> None:
        if self.index < 1:
            raise FoldCalendarError(f"fold index is one-based, got {self.index!r}")
        if self.id != f"{_FOLD_ID_PREFIX}{self.index}":
            raise FoldCalendarError(
                f"fold {self.id!r} at index {self.index} should be called "
                f"{_FOLD_ID_PREFIX}{self.index!s}"
            )
        if self.train_end != self.test_start - _ONE_DAY:
            raise FoldCalendarError(
                f"{self.id}: the training block must end the day before the test "
                f"period opens; train_end {self.train_end.isoformat()}, test opens "
                f"{self.test_start.isoformat()}"
            )
        if self.calibration_end != self.train_end:
            raise FoldCalendarError(
                f"{self.id}: the calibration window must close at train_end "
                f"{self.train_end.isoformat()}, got "
                f"{self.calibration_end.isoformat()}"
            )
        if self.calibration_start > self.calibration_end:
            raise FoldCalendarError(f"{self.id}: the calibration window is empty")
        if not self.test_start <= self.test_end <= self.quarter_end:
            raise FoldCalendarError(
                f"{self.id}: the test period {self.test_start.isoformat()} to "
                f"{self.test_end.isoformat()} does not sit inside its quarter, "
                f"which ends {self.quarter_end.isoformat()}"
            )

    @property
    def test_days(self) -> int:
        """Test days so far. Grows daily while this fold is the live edge."""
        return _inclusive_days(self.test_start, self.test_end)

    @property
    def quarter_days(self) -> int:
        """Test days this fold will have once frozen."""
        return _inclusive_days(self.test_start, self.quarter_end)

    @property
    def calibration_days(self) -> int:
        return _inclusive_days(self.calibration_start, self.calibration_end)

    @property
    def is_live_edge(self) -> bool:
        """Whether this fold is still growing.

        False the moment ``test_end`` reaches ``quarter_end``: the fold is then
        frozen, its hash stops moving, and the next quarter opens on the next
        materialisation.
        """
        return self.test_end < self.quarter_end

    @property
    def line(self) -> str:
        """The fold as hashed. Exposed so a test can assert on it, not on hex."""
        return "\t".join(
            (
                self.id,
                str(self.index),
                self.test_start.isoformat(),
                self.test_end.isoformat(),
                self.quarter_end.isoformat(),
                self.train_end.isoformat(),
                self.calibration_start.isoformat(),
                self.calibration_end.isoformat(),
            )
        )

    @property
    def digest(self) -> str:
        """sha256 over the rules' digest and this fold's own dates, hex.

        The rules go in so that a calendar edit invalidates every fold; the
        dates go in so that a growing live edge invalidates only itself.
        """
        payload = f"{self.rules_digest}\n{self.line}".encode()
        return hashlib.sha256(payload).hexdigest()

    @property
    def fold_hash(self) -> str:
        """The card and log spelling of :attr:`digest`."""
        return f"sha256:{self.digest}"

    def blocks_for(self, window_start: date) -> FoldBlocks:
        """The three blocks for a run whose training window opens on this date.

        ``window_start`` is the run's, not the calendar's: A-full opens
        2024-04-01 and A-common and B-common open 2025-05-23, and that is the
        only thing that differs between them in this fold.

        Raises :class:`FoldWindowError` when the window leaves no base-fit block
        — which is a real answer about the matrix, not an empty result. Use
        :meth:`is_decision_grade` to ask the same question without a raise.
        """
        base_fit_end = self.calibration_start - _ONE_DAY
        if window_start > base_fit_end:
            raise FoldWindowError(
                f"{self.id}: a window opening {window_start.isoformat()} leaves no "
                f"base-fit block — the calibration window opens "
                f"{self.calibration_start.isoformat()}, so the base fit would have "
                f"to end {base_fit_end.isoformat()}"
            )
        return FoldBlocks(
            base_fit_start=window_start,
            base_fit_end=base_fit_end,
            calibration_start=self.calibration_start,
            calibration_end=self.calibration_end,
            test_start=self.test_start,
            test_end=self.test_end,
        )

    def base_fit_days_for(self, window_start: date) -> int:
        """Base-fit days a window buys in this fold. ``0`` when it buys none.

        Zero rather than a raise, because "how much history does this arm have
        here" is a question the matrix asks of every (run, fold) pair including
        the ones where the answer is none.
        """
        base_fit_end = self.calibration_start - _ONE_DAY
        if window_start > base_fit_end:
            return 0
        return _inclusive_days(window_start, base_fit_end)

    def is_decision_grade(self, window_start: date, min_base_fit_days: int) -> bool:
        """Whether a run with this window may decide anything in this fold.

        `docs/specs/forecaster.md`, "Which folds are decision-grade": a run is
        decision-grade in a fold only if its base-fit block — the training block
        minus the 90-day calibration window — is at least 180 days. It is what
        restricts the DESSEM verdict to two test quarters.
        """
        return self.base_fit_days_for(window_start) >= min_base_fit_days

    def cache_key(self, run: str) -> str:
        """The key a cached fold result for this run is stored under.

        The fold hash is in the key rather than beside it, so a changed calendar
        cannot produce a stale hit: the old result is still on disk, under a key
        nothing will ask for again.
        """
        if not run or run != run.strip():
            raise FoldCalendarError(f"a run name must be non-empty text, got {run!r}")
        return f"{self.id}/{run}/{self.fold_hash}"

    def __str__(self) -> str:
        return f"{self.id} {self.test_start.isoformat()}→{self.test_end.isoformat()}"


@dataclass(frozen=True)
class PinnedFold:
    """One row of the spec's own table, held against the generator.

    Every field is checked against the derivation at load, so this type never
    reaches a caller: it exists to make `fold_calendar.yaml` a document a
    reviewer can diff against `docs/specs/forecaster.md` line for line, while
    still refusing to be a second source of truth.
    """

    id: str
    test_start: date
    quarter_end: date
    quarter_days: int
    train_end: date
    calibration_start: date
    calibration_end: date


@dataclass(frozen=True)
class FoldCalendarRules:
    """The rules the folds are generated from, and their hash.

    Validated on construction: an invalid set of rules cannot exist as a value,
    so no caller re-checks. The ``pinned`` table is checked against the
    derivation here too — which is the point at which a spec table and a
    generator that disagree stop the build.
    """

    version: int
    window_start: date
    first_test_start: date
    quarter_months: int
    calibration_days: int
    min_base_fit_days: int
    pinned: tuple[PinnedFold, ...]

    def __post_init__(self) -> None:
        if self.version < 1:
            raise FoldCalendarError(f"version is one-based, got {self.version!r}")
        if self.quarter_months < 1 or _MONTHS_PER_YEAR % self.quarter_months:
            raise FoldCalendarError(
                "quarter_months must divide the year, so that fold boundaries fall "
                f"on the same days every year; got {self.quarter_months!r}"
            )
        if self.first_test_start.day != 1:
            raise FoldCalendarError(
                "first_test_start must be the first of a month, so that stepping by "
                f"months is total; got {self.first_test_start.isoformat()}"
            )
        if self.calibration_days < 1:
            raise FoldCalendarError(
                f"calibration_days must be positive, got {self.calibration_days!r}"
            )
        if self.min_base_fit_days < 1:
            raise FoldCalendarError(
                f"min_base_fit_days must be positive, got {self.min_base_fit_days!r}"
            )
        if self.window_start >= self.first_test_start:
            raise FoldCalendarError(
                f"the window must open before the first test fold; window opens "
                f"{self.window_start.isoformat()}, first fold tests from "
                f"{self.first_test_start.isoformat()}"
            )
        first_calibration_start = (
            self.first_test_start - _ONE_DAY - timedelta(days=self.calibration_days - 1)
        )
        if first_calibration_start < self.window_start:
            raise FoldCalendarError(
                f"the first fold's calibration window would open "
                f"{first_calibration_start.isoformat()}, before the window opens on "
                f"{self.window_start.isoformat()}"
            )
        self._check_pinned()

    def _check_pinned(self) -> None:
        if not self.pinned:
            raise FoldCalendarError(
                "pinned_folds is empty; the spec's table is what holds the "
                "generator in place and there is nothing to hold it with"
            )
        for position, pinned in enumerate(self.pinned):
            derived = self.frozen_fold(position + 1)
            expected = PinnedFold(
                id=derived.id,
                test_start=derived.test_start,
                quarter_end=derived.quarter_end,
                quarter_days=derived.quarter_days,
                train_end=derived.train_end,
                calibration_start=derived.calibration_start,
                calibration_end=derived.calibration_end,
            )
            if pinned != expected:
                raise FoldCalendarError(
                    f"pinned fold {pinned.id!r} does not match the calendar rules.\n"
                    f"  pinned:  {pinned!r}\n"
                    f"  derived: {expected!r}\n"
                    "Either the rules or the pinned row is wrong; they cannot both "
                    "be right, and neither may be adjusted to hide the other."
                )

    def frozen_fold(self, index: int) -> Fold:
        """The ``index``-th fold as it will look once it has frozen.

        One-based. ``test_end`` is the quarter end: truncation to the live edge
        is :func:`materialize_fold_calendar`'s job and depends on the clock,
        which nothing else in this class touches.
        """
        if index < 1:
            raise FoldCalendarError(f"fold index is one-based, got {index!r}")
        test_start = _add_months(self.first_test_start, (index - 1) * self.quarter_months)
        quarter_end = _add_months(test_start, self.quarter_months) - _ONE_DAY
        train_end = test_start - _ONE_DAY
        return Fold(
            id=f"{_FOLD_ID_PREFIX}{index}",
            index=index,
            test_start=test_start,
            test_end=quarter_end,
            quarter_end=quarter_end,
            train_end=train_end,
            calibration_start=train_end - timedelta(days=self.calibration_days - 1),
            calibration_end=train_end,
            rules_digest=self.digest,
        )

    @property
    def rule_lines(self) -> tuple[str, ...]:
        """The rules as hashed. Serialised here so a test can assert on them.

        Deliberately **not** the YAML bytes: the hash must move for a changed
        boundary and stay put for a reworded comment, because a comment edit
        that invalidated every cached fold result would teach everyone to stop
        editing comments.
        """
        return (
            f"version\t{self.version}",
            f"window_start\t{self.window_start.isoformat()}",
            f"first_test_start\t{self.first_test_start.isoformat()}",
            f"quarter_months\t{self.quarter_months}",
            f"calibration_days\t{self.calibration_days}",
            f"min_base_fit_days\t{self.min_base_fit_days}",
        )

    @property
    def digest(self) -> str:
        """sha256 over :attr:`rule_lines`, hex."""
        return hashlib.sha256("\n".join(self.rule_lines).encode()).hexdigest()

    @property
    def rules_hash(self) -> str:
        """The card and log spelling of :attr:`digest`."""
        return f"sha256:{self.digest}"

    def card_fields(self) -> dict[str, str]:
        """The two model-card fields that pin which calendar a number came from.

        A metric without them is a metric nobody can place: `qloss_mwh` on F5 of
        a calendar whose first fold moved is a different number with the same
        name.
        """
        return {
            "fold_calendar_version": str(self.version),
            "fold_calendar_hash": self.rules_hash,
        }


@dataclass(frozen=True)
class FoldCalendar:
    """The materialised calendar: the rules, the day it was read, the folds.

    Constructing one re-derives the folds and refuses anything else, so this
    type has exactly one degree of freedom — ``as_of`` — and ``as_of`` moves
    nothing but the live edge. There is no supported way to hold a calendar with
    a fold removed, a fold reordered, or a boundary nudged.
    """

    rules: FoldCalendarRules
    #: The civil date the calendar was read on. Test rows run to ``as_of − 1``:
    #: today has not happened yet and its labels are not settled.
    as_of: date
    folds: tuple[Fold, ...]

    def __post_init__(self) -> None:
        assert_folds_in_order(self.folds)
        expected = _derive_folds(self.rules, self.as_of)
        if self.folds != expected:
            raise FoldCalendarError(
                "these are not the folds this calendar's rules produce on "
                f"{self.as_of.isoformat()}. Expected "
                f"{[str(fold) for fold in expected]!r}, got "
                f"{[str(fold) for fold in self.folds]!r}. The calendar is fixed "
                "once and shared; it is not recomputed per run."
            )

    def __len__(self) -> int:
        return len(self.folds)

    def __iter__(self) -> Iterator[Fold]:
        return iter(self.folds)

    def fold(self, fold_id: str) -> Fold:
        """The fold with this id, or a failure naming the ones that exist."""
        for fold in self.folds:
            if fold.id == fold_id:
                return fold
        raise FoldCalendarError(
            f"no fold {fold_id!r} on this calendar; it holds "
            f"{[fold.id for fold in self.folds]!r}"
        )

    @property
    def live_edge(self) -> Fold | None:
        """The fold still growing, if any.

        ``None`` on the one day of the quarter when the last fold has just
        frozen and the next has not opened — which is a real state and not a
        fault: ``as_of`` is then the first day of a new quarter, whose only
        target date so far is the last day of the old one.
        """
        last = self.folds[-1]
        return last if last.is_live_edge else None

    @property
    def frozen_folds(self) -> tuple[Fold, ...]:
        """The folds whose test periods will never change again."""
        return tuple(fold for fold in self.folds if not fold.is_live_edge)


def assert_folds_in_order(folds: tuple[Fold, ...]) -> None:
    """Folds are ascending, one-based, contiguous and non-overlapping.

    The protocol's "never shuffled", as a check a caller can run on any tuple of
    folds it was handed — including one that has been through a serialisation
    round trip, a list comprehension or a dictionary's ``values()``.

    Contiguity is asserted, not just ordering. A calendar missing a fold in the
    middle would still be ascending, and every metric computed on it would still
    look fine.
    """
    if not folds:
        raise FoldOrderError("a calendar with no folds scores nothing")
    for position, fold in enumerate(folds):
        if fold.index != position + 1:
            raise FoldOrderError(
                f"fold {fold.id!r} sits at position {position} but carries index "
                f"{fold.index}; the folds have been reordered"
            )
    for earlier, later in pairwise(folds):
        if later.test_start <= earlier.test_end:
            raise FoldOrderError(
                f"{later.id} tests from {later.test_start.isoformat()}, which is not "
                f"after {earlier.id}'s test period ending "
                f"{earlier.test_end.isoformat()}"
            )
        if later.test_start != earlier.quarter_end + _ONE_DAY:
            raise FoldOrderError(
                f"{later.id} opens {later.test_start.isoformat()} but {earlier.id}'s "
                f"quarter ends {earlier.quarter_end.isoformat()}; a fold is missing "
                "between them"
            )
    digests = [fold.rules_digest for fold in folds]
    if len(set(digests)) != 1:
        raise FoldOrderError(
            "these folds come from more than one set of calendar rules, so they "
            "were not fixed once and shared"
        )


def materialize_fold_calendar(
    as_of: date, rules: FoldCalendarRules | None = None
) -> FoldCalendar:
    """The calendar as it stands on ``as_of``. The only way to build one.

    ``as_of`` is a civil date in the grid's own clock — the day the harness is
    running — and the newest target date any fold may test is ``as_of − 1``.

    The last quarter that has started is truncated there and is the live edge.
    On the day ``as_of − 1`` reaches that quarter's end the fold is complete and
    stops growing; on the next day the following quarter opens by itself. No
    edit to `fold_calendar.yaml` is involved in either step.
    """
    resolved = rules if rules is not None else load_fold_calendar_rules()
    return FoldCalendar(rules=resolved, as_of=as_of, folds=_derive_folds(resolved, as_of))


def _derive_folds(rules: FoldCalendarRules, as_of: date) -> tuple[Fold, ...]:
    """Every fold whose test period has opened by ``as_of − 1``, truncated there."""
    last_target = as_of - _ONE_DAY
    if last_target < rules.first_test_start:
        raise FoldCalendarError(
            f"nothing is testable on {as_of.isoformat()}: the first fold opens "
            f"{rules.first_test_start.isoformat()} and the newest settled target "
            f"date is {last_target.isoformat()}"
        )
    folds: list[Fold] = []
    index = 1
    while True:
        frozen = rules.frozen_fold(index)
        if frozen.test_start > last_target:
            break
        test_end = min(frozen.quarter_end, last_target)
        folds.append(
            Fold(
                id=frozen.id,
                index=frozen.index,
                test_start=frozen.test_start,
                test_end=test_end,
                quarter_end=frozen.quarter_end,
                train_end=frozen.train_end,
                calibration_start=frozen.calibration_start,
                calibration_end=frozen.calibration_end,
                rules_digest=frozen.rules_digest,
            )
        )
        index += 1
    return tuple(folds)


def _add_months(anchor: date, months: int) -> date:
    """``anchor`` moved by whole months. Total only for day-of-month 1.

    The rules validate ``first_test_start.day == 1``, so every date this is ever
    asked about is the first of a month and there is no end-of-month clamping
    rule to get wrong.
    """
    if anchor.day != 1:
        raise FoldCalendarError(
            f"month stepping is only defined from the first of a month, got "
            f"{anchor.isoformat()}"
        )
    total = anchor.month - 1 + months
    return date(anchor.year + total // _MONTHS_PER_YEAR, total % _MONTHS_PER_YEAR + 1, 1)


def _inclusive_days(start: date, end: date) -> int:
    """Days from ``start`` to ``end`` counting both ends, as the spec's table does."""
    return (end - start).days + 1


def load_fold_calendar_rules(path: Path = FOLD_CALENDAR_PATH) -> FoldCalendarRules:
    """Read and validate the calendar. Every failure is a load failure."""
    document = _read_yaml(path)
    where = str(path)
    pinned = tuple(
        PinnedFold(
            id=_as_str(raw.get("id"), f"{where}: pinned_folds[].id"),
            test_start=_as_date(raw.get("test_start"), f"{where}: test_start"),
            quarter_end=_as_date(raw.get("quarter_end"), f"{where}: quarter_end"),
            quarter_days=_as_int(raw.get("quarter_days"), f"{where}: quarter_days"),
            train_end=_as_date(raw.get("train_end"), f"{where}: train_end"),
            calibration_start=_as_date(
                raw.get("calibration_start"), f"{where}: calibration_start"
            ),
            calibration_end=_as_date(
                raw.get("calibration_end"), f"{where}: calibration_end"
            ),
        )
        for raw in _as_mapping_tuple(
            document.get("pinned_folds"), f"{where}: pinned_folds"
        )
    )
    return FoldCalendarRules(
        version=_as_int(document.get("version"), f"{where}: version"),
        window_start=_as_date(document.get("window_start"), f"{where}: window_start"),
        first_test_start=_as_date(
            document.get("first_test_start"), f"{where}: first_test_start"
        ),
        quarter_months=_as_int(
            document.get("quarter_months"), f"{where}: quarter_months"
        ),
        calibration_days=_as_int(
            document.get("calibration_days"), f"{where}: calibration_days"
        ),
        min_base_fit_days=_as_int(
            document.get("min_base_fit_days"), f"{where}: min_base_fit_days"
        ),
        pinned=pinned,
    )


def _read_yaml(path: Path) -> dict[str, object]:
    loaded: object = yaml.safe_load(path.read_text(encoding="utf-8"))
    return _as_mapping(loaded, str(path))


def _as_mapping(value: object, where: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise FoldCalendarError(
            f"{where}: expected a mapping, got {type(value).__name__}"
        )
    for key in value:
        if not isinstance(key, str):
            raise FoldCalendarError(f"{where}: expected string keys, got {key!r}")
    return cast(dict[str, object], value)


def _as_mapping_tuple(value: object, where: str) -> tuple[dict[str, object], ...]:
    if not isinstance(value, list):
        raise FoldCalendarError(f"{where}: expected a list, got {type(value).__name__}")
    return tuple(_as_mapping(item, where) for item in value)


def _as_str(value: object, where: str) -> str:
    if not isinstance(value, str):
        raise FoldCalendarError(f"{where}: expected a string, got {value!r}")
    return value


def _as_int(value: object, where: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise FoldCalendarError(f"{where}: expected an integer, got {value!r}")
    return value


def _as_date(value: object, where: str) -> date:
    """A civil date. A ``datetime`` is refused rather than truncated.

    ``2025-04-01T00:00:00Z`` in this file would mean somebody was thinking in
    instants, and the fold boundary they meant depends on a timezone this file
    does not name. Fold boundaries are civil dates on the grid's clock.
    """
    if isinstance(value, datetime):
        raise FoldCalendarError(
            f"{where}: expected a civil date such as 2025-04-01, got an instant "
            f"{value!r}; fold boundaries are dates, not timestamps"
        )
    if not isinstance(value, date):
        raise FoldCalendarError(f"{where}: expected a date, got {value!r}")
    return value


#: The calendar's rules, loaded once. The folds are not: they depend on the day
#: the harness runs, which is :func:`materialize_fold_calendar`'s argument.
FOLD_CALENDAR_RULES = load_fold_calendar_rules()
