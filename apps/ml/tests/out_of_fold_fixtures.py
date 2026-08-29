"""Synthetic pooled out-of-fold predictions, for the tests that need a curve.

**These are fixtures, not data.** Every probability here is invented and nothing
in this file may be read as a claim about the Brazilian grid, or about how well
any model calibrates. What the tests built on it assert are *structural*
properties — that the curve refuses a pool it cannot show is out of fold, that
rows inside the calibration window are dropped and counted, that a thin bin
merges and the merge is recorded, that the risk-class edges come out of the
spec's rule — and every one of those is a property of the code.

**The fold segments are constructed rather than stamped.** The shared calendar's
`as_of` in `conftest.py` leaves F1 as the live edge, so there is exactly one real
fold and it has no predecessors to pool. Production builds these through
:func:`wattsteer_ml.evaluation.stamp_fidelity`; a fixture that needs three prior
folds has to name them, and does so here in one place rather than inline in four
tests.

**One of the three segments deliberately overlaps the calibration window.** That
is the whole point of `PRIOR_INSIDE_CALIBRATION`: without it the exclusion in
:func:`wattsteer_ml.training.calibration.outside_calibration_window` would never
have anything to do, and "the curve is disjoint from the window the calibrator
was fitted on" would be a property the test could not distinguish from luck.
"""

from __future__ import annotations

import random
from collections.abc import Iterator, Sequence
from datetime import date, timedelta

from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import FoldSegment, RowKey
from wattsteer_ml.training import OutOfFoldPool, OutOfFoldPrediction

HOURS_PER_DAY = 24

#: A hash of the shape :attr:`wattsteer_ml.evaluation.Fold.fold_hash` has. It is
#: never compared against a real calendar here; it exists because a segment that
#: could not say which calendar produced it is a segment this codebase refuses.
_FIXTURE_HASH = "sha256:" + "f" * 64


def _segment(fold_id: str, first: date, last: date) -> FoldSegment:
    return FoldSegment(
        fold_id=fold_id,
        row_id=fold_id,
        fidelity="revision_optimistic",
        test_start=first,
        test_end=last,
        is_split=False,
        fold_hash=_FIXTURE_HASH,
    )


#: Two prior folds entirely before the shared fold's training window, and one
#: that lands inside its calibration window.
PRIOR_FOLDS: tuple[FoldSegment, ...] = (
    _segment("P1", date(2024, 7, 1), date(2024, 9, 30)),
    _segment("P2", date(2024, 10, 1), date(2024, 11, 30)),
)
PRIOR_INSIDE_CALIBRATION: FoldSegment = _segment(
    "P3", date(2025, 1, 1), date(2025, 2, 28)
)

SEGMENTS: tuple[FoldSegment, ...] = (*PRIOR_FOLDS, PRIOR_INSIDE_CALIBRATION)


def _days(first: date, last: date) -> Iterator[date]:
    day = first
    while day <= last:
        yield day
        day += timedelta(days=1)


def predictions(
    segments: tuple[FoldSegment, ...] = SEGMENTS,
    *,
    seed: int = 20_260_829,
    skew: float = 4.0,
) -> list[OutOfFoldPrediction]:
    """One prediction per subsystem-hour of each segment's test period.

    The probability is drawn skewed towards zero, because that is the shape a
    curtailment classifier's output has — most hours are quiet — and because it
    is what leaves the top bins thin enough that the merge rule has something to
    do. The label is then drawn **at that probability**, so the pool is
    calibrated up to sampling error: the fixture exists to exercise the machinery
    and must not smuggle in a distortion the machinery is supposed to measure.
    """
    rng = random.Random(seed)  # noqa: S311 — a fixture, not a security decision
    pool: list[OutOfFoldPrediction] = []
    for segment in segments:
        for day in _days(segment.test_start, segment.test_end):
            for hour in range(HOURS_PER_DAY):
                for subsystem in SUBSYSTEM_CODES:
                    probability = round(rng.random() ** skew, 4)
                    pool.append(
                        OutOfFoldPrediction(
                            fold_id=segment.fold_id,
                            key=RowKey(
                                target_date=day,
                                local_hour=hour,
                                subsystem=subsystem,
                            ),
                            probability=probability,
                            observed=rng.random() < probability,
                        )
                    )
    return pool


def pool(
    segments: tuple[FoldSegment, ...] = SEGMENTS, *, seed: int = 20_260_829
) -> OutOfFoldPool:
    """The pool as ``train_fold`` takes it, checked against its own segments."""
    return OutOfFoldPool.of(predictions(segments, seed=seed), segments=list(segments))


def pool_of(
    pairs: Sequence[tuple[float, bool]],
    *,
    fold_id: str = "S1",
    first: date = date(2023, 1, 1),
) -> OutOfFoldPool:
    """Wrap bare ``(probability, observed)`` pairs in a pool with real keys.

    Some tests are about the arithmetic and not about the calendar — the
    synthetic over-confidence comparison against Platt is the clearest case. They
    still go through :class:`OutOfFoldPool`, so that there is one implementation
    of ECE in this service rather than a second one written inside a test to
    avoid the ceremony of building keys.
    """
    keys: list[RowKey] = []
    day = first
    while len(keys) < len(pairs):
        for hour in range(HOURS_PER_DAY):
            for subsystem in SUBSYSTEM_CODES:
                if len(keys) < len(pairs):
                    keys.append(
                        RowKey(target_date=day, local_hour=hour, subsystem=subsystem)
                    )
        day += timedelta(days=1)
    return OutOfFoldPool.of(
        [
            OutOfFoldPrediction(
                fold_id=fold_id, key=key, probability=probability, observed=observed
            )
            for key, (probability, observed) in zip(keys, pairs, strict=True)
        ],
        segments=[_segment(fold_id, first, keys[-1].target_date)],
    )
