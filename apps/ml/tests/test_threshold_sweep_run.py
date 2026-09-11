"""The driver forecaster 17 never had — api-surface 30's second orphan.

`run_threshold_sweep` had **no caller at all, not even a test**: three textual
hits in the whole repository, its own `def`, its own `__all__`, and a docstring
cross-reference. `wattsteer_ml.threshold_sweep_run` is the caller, and this file
is about the four properties the driver owns that neither the sweep module nor
the retrain can:

1. the folds are the calendar's arithmetic and no fold id is written down;
2. the block is written onto **every** arm's card, measured or not, because a
   card with no block and a card saying "this has not been swept" look
   identical to anybody grepping for the figure;
3. a segment no arm can be scored on is a row of the report rather than the end
   of the run, and the refusal is published;
4. nothing is promoted, and an already-promoted sweep arm stops the run **before
   the first fit** rather than after three of them.

**The scorer is a stand-in here**, as in `test_second_planning_arm.py`: what
Postgres and LightGBM contribute is a `ScoredHour` per test hour, and the
driver's own logic is everything that happens around that. Whether a real
database can produce those hours is the *run*, which this file does not claim
to have done and which `SWEEP_ARMS_NOT_SCORED` goes on saying until it has.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import materialize_fold_calendar
from wattsteer_ml.evaluation.matrix import RowKey
from wattsteer_ml.evaluation.threshold_sweep import (
    SWEEP_LANES,
    SWEPT_THRESHOLDS,
    THRESHOLD_SWEEP_BLOCK_KEY,
    ThresholdSweepError,
    sweep_lane,
)
from wattsteer_ml.evaluation.vintage import FoldSegment
from wattsteer_ml.lanes import format_instant
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionRecord
from wattsteer_ml.promotions import append as append_promotion
from wattsteer_ml.threshold_sweep_run import (
    NoArmHoursError,
    SweepEnvironment,
    ThresholdSweepRequest,
    reportable_folds,
    run_sweep_from_database,
)
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.conformal import ScoredHour
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

HOURS_PER_DAY = 24
AS_OF = datetime(2026, 8, 28, 3, 11, 7, tzinfo=UTC)
ARTIFACT_ID = format_instant(AS_OF)
#: The matrix arm's window start for the free feature set at the late gate. Held
#: as a value here rather than read from Postgres, which is the whole point of
#: `SweepEnvironment` being a parameter.
WINDOW_START = date(2023, 1, 1)

FLAT_MU_SUB = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(HOURS_PER_DAY)) for _ in SUBSYSTEM_CODES)
)


def _hours(first: date, threshold_mw: float, days: int = 2) -> tuple[ScoredHour, ...]:
    """Two whole local days of composed hours, at one threshold.

    The probabilities ramp across the unit interval so that every arm has both
    classes and the mixture's breakpoint is crossed — the sweep refuses a
    degenerate arm, and a test that fed it one would be testing the refusal.
    """
    total = days * HOURS_PER_DAY
    keys = [
        RowKey(
            target_date=first + timedelta(days=index // HOURS_PER_DAY),
            local_hour=index % HOURS_PER_DAY,
            subsystem="NE",
        )
        for index in range(total)
    ]
    forecasts = compose_estimates(
        keys,
        [
            HourEstimates(
                occurrence_probability=index / (total - 1),
                q10=20.0,
                q50=40.0,
                q90=80.0,
                positive_mean_mwh=45.0,
            )
            for index in range(total)
        ],
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=threshold_mw,
    )
    return tuple(
        ScoredHour(
            key=hour.key,
            forecast=hour.forecast,
            observed_mwh=float(index % 13),
        )
        for index, hour in enumerate(forecasts)
    )


class FakeArms:
    """A `SweepScorer` over invented hours. Records what it was asked for."""

    def __init__(self, *, refuse: bool = False) -> None:
        self.refuse = refuse
        self.asked: list[tuple[float, str]] = []

    def __call__(self, threshold_mw: float, segment: FoldSegment) -> Sequence[ScoredHour]:
        self.asked.append((threshold_mw, segment.row_id))
        if self.refuse:
            raise NoArmHoursError(
                f"the {threshold_mw} MW arm has no settled test hour on {segment.row_id}"
            )
        return _hours(segment.test_start, threshold_mw)

    @property
    def fits(self) -> tuple[str, ...]:
        return tuple(sorted({f"thr{one}@{row}" for one, row in self.asked}))


def _request(root: Path) -> ThresholdSweepRequest:
    return ThresholdSweepRequest(as_of=AS_OF, root=root, database_url="postgres://unused")


def _cards(root: Path) -> None:
    """One card per arm lane, which is what `record_threshold_sweep` edits."""
    for lane in SWEEP_LANES:
        directory = root / lane.directory_name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{ARTIFACT_ID}.card.json").write_text(
            json.dumps({"artifact_id": ARTIFACT_ID}), encoding="utf-8"
        )


def _environment() -> SweepEnvironment:
    return SweepEnvironment(window_start=WINDOW_START, go_live=None)


# --- the folds are the calendar's, and no fold id is written down -------------


def test_reportable_folds_need_a_base_fit_and_a_predecessor() -> None:
    """The first box's other half: identical folds, chosen by arithmetic.

    Every reportable fold has a base-fit block for the arm's window *and* an
    earlier fold that also has one, because the pooled reliability curve is
    walked forward and `train_fold` refuses to fit without it.
    """
    calendar = materialize_fold_calendar(AS_OF.date())
    folds = reportable_folds(calendar, window_start=WINDOW_START)

    assert folds, "the 2026 calendar opens no fold this arm can be fitted on"
    first = folds[0]
    assert any(fold.index < first.index for fold in calendar.folds)
    for fold in folds:
        fold.blocks_for(WINDOW_START)  # raises if there is no base fit


def test_an_impossible_window_makes_no_fold_reportable() -> None:
    """The empty case, refused at the verdict rather than passing as `[] == []`.

    A window opening after the calendar's last fold leaves every fold without a
    base fit, and the driver turns that into a stated refusal rather than a
    sweep of nothing.
    """
    calendar = materialize_fold_calendar(AS_OF.date())

    assert reportable_folds(calendar, window_start=date(2099, 1, 1)) == ()


# --- the run writes the block on every arm's card -----------------------------


def test_a_measured_run_publishes_the_three_arms_on_every_lane(tmp_path: Path) -> None:
    _cards(tmp_path)
    arms = FakeArms()

    report = run_sweep_from_database(
        _request(tmp_path), scorer=arms, environment=_environment()
    )

    assert report.is_measurement
    assert report.not_run is None
    # Every arm on every reportable segment, and never a subset of them.
    assert {threshold for threshold, _ in arms.asked} == set(SWEPT_THRESHOLDS)
    assert len(report.cards) == len(SWEEP_LANES)
    for lane in SWEEP_LANES:
        card = json.loads(
            (tmp_path / lane.directory_name / f"{ARTIFACT_ID}.card.json").read_text(
                encoding="utf-8"
            )
        )
        block = card[THRESHOLD_SWEEP_BLOCK_KEY]
        assert block["measured"] is True
        assert block["swept_thresholds_mw"] == list(SWEPT_THRESHOLDS)
    # Published rather than acted on: not one line in the log.
    assert not (tmp_path / PROMOTION_LOG_FILENAME).exists()


def test_a_database_with_no_settled_hour_writes_the_absence_not_a_zero(
    tmp_path: Path,
) -> None:
    """The unmeasured block, carrying the reason, on every card.

    Never a prevalence of zero: `SWEEP_ARMS_NOT_SCORED` is what an unmeasured
    block reads as, and it says the sweep has not been run rather than that it
    was run and found nothing.
    """
    _cards(tmp_path)

    report = run_sweep_from_database(
        _request(tmp_path), scorer=FakeArms(refuse=True), environment=_environment()
    )

    assert not report.is_measurement
    assert report.not_run is not None
    assert "NoArmHoursError" in report.not_run
    # And the refusals are published rather than quietly dropped.
    assert report.segments_refused
    card = json.loads(
        (tmp_path / SWEEP_LANES[0].directory_name / f"{ARTIFACT_ID}.card.json").read_text(
            encoding="utf-8"
        )
    )
    block = card[THRESHOLD_SWEEP_BLOCK_KEY]
    assert block["measured"] is False
    assert "reason" in block


def test_a_missing_card_is_reported_rather_than_minted(tmp_path: Path) -> None:
    """This driver edits cards on the volume; the fits are what create them.

    With no card on disk the run still happens and says which lanes it could
    not write to, because an absent card is an operator's problem and not a
    reason to lose the figures.
    """
    report = run_sweep_from_database(
        _request(tmp_path), scorer=FakeArms(), environment=_environment()
    )

    assert report.cards == ()
    assert len(report.cards_absent) == len(SWEEP_LANES)


# --- nothing is promoted ------------------------------------------------------


def test_a_promoted_sweep_arm_stops_the_run_before_the_first_fit(
    tmp_path: Path,
) -> None:
    """The ticket's structural rule, checked before three LightGBM fits.

    A sweep arm holding a `promote` line is a sweep that was acted on, and
    three more fits would not make that less true.
    """
    lane = sweep_lane(1.0)
    append_promotion(
        tmp_path / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=ARTIFACT_ID,
            lane=lane,
            decision="promote",
            reason="a sweep arm promoted by hand",
            at=AS_OF,
        ),
    )
    arms = FakeArms()

    with pytest.raises(ThresholdSweepError):
        run_sweep_from_database(
            _request(tmp_path), scorer=arms, environment=_environment()
        )

    assert arms.asked == []
