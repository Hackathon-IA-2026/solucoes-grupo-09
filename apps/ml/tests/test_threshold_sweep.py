"""The 1 / 5 / 10 MW sweep — published, and structurally unable to act.

Forecaster ticket 17. Three properties carry the whole file:

1. The three arms are scored on **identical rows**, asserted through
   :func:`~wattsteer_ml.evaluation.matrix.assert_identical_test_rows` rather
   than by counting.
2. Two of the six published figures are **artifacts of the mixture**, and the
   sweep says so as an identity it checks rather than as a footnote:
   ``share_p50_zero`` is exactly the share of hours the composition forces to
   zero at ``q = 0.50``, and moving the threshold moves ``p``, which moves the
   breakpoint, which moves the figure — with no change in model quality at all.
3. Nothing here selects a threshold. There is no field, method or card key that
   names a winner, and no path from this module to the promotion log.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES, SUBSYSTEM_THRESHOLD_MW, Subsystem
from wattsteer_ml.evaluation.matrix import RowIdentityError, RowKey
from wattsteer_ml.evaluation.serving_lanes import SERVING_LANES
from wattsteer_ml.evaluation.threshold_sweep import (
    DEFAULT_THRESHOLD_MW,
    PREVALENCE_CEILING,
    PREVALENCE_FLOOR,
    SWEEP_LANES,
    SWEPT_THRESHOLDS,
    THRESHOLD_SWEEP_BLOCK_KEY,
    PrevalenceVerdict,
    SweepProvenance,
    ThresholdSweepError,
    ThresholdSweepReport,
    UnmeasuredThresholdSweep,
    assert_no_sweep_lane_promoted,
    record_threshold_sweep,
    sweep_lane,
    sweep_rows,
)
from wattsteer_ml.evaluation.vintage import FoldSegment
from wattsteer_ml.lanes import Lane
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionLog, PromotionRecord
from wattsteer_ml.promotions import append as append_promotion
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.conformal import ScoredHour
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

HOURS_PER_DAY = 24
FIXTURE_HASH = "sha256:" + "e" * 64

FLAT_MU_SUB = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(HOURS_PER_DAY)) for _ in SUBSYSTEM_CODES)
)


def segment(
    fold_id: str = "F1",
    *,
    first: date = date(2025, 4, 1),
    days: int = 2,
    fidelity: VintageFidelity = "point_in_time",
    is_split: bool = False,
) -> FoldSegment:
    return FoldSegment(
        fold_id=fold_id,
        row_id=f"{fold_id}@{fidelity}" if is_split else fold_id,
        fidelity=fidelity,
        test_start=first,
        test_end=first + timedelta(days=days - 1),
        is_split=is_split,
        fold_hash=FIXTURE_HASH,
    )


def scored(
    observations: Sequence[tuple[float, float]],
    *,
    threshold_mw: float,
    first: date = date(2025, 4, 1),
    subsystem: Subsystem = "NE",
) -> tuple[ScoredHour, ...]:
    """``(p, observed_mwh)`` per hour, composed through the one mixture.

    Laid out as whole local days from ``first``, so the day-grain half of
    :class:`~wattsteer_ml.evaluation.collapse.CollapseBlock` has complete days
    to count and ``share_p50_zero`` is a figure rather than ``None``.
    """
    keys = [
        RowKey(
            target_date=first + timedelta(days=index // HOURS_PER_DAY),
            local_hour=index % HOURS_PER_DAY,
            subsystem=subsystem,
        )
        for index in range(len(observations))
    ]
    forecasts = compose_estimates(
        keys,
        [
            HourEstimates(
                occurrence_probability=probability,
                q10=20.0,
                q50=40.0,
                q90=80.0,
                positive_mean_mwh=45.0,
            )
            for probability, _ in observations
        ],
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=threshold_mw,
    )
    return tuple(
        ScoredHour(key=hour.key, forecast=hour.forecast, observed_mwh=observed)
        for hour, (_, observed) in zip(forecasts, observations, strict=True)
    )


def ramp(days: int = 2) -> list[float]:
    """A ``p`` per hour that sweeps the whole unit interval across the days."""
    total = days * HOURS_PER_DAY
    return [index / (total - 1) for index in range(total)]


def arms(
    magnitudes: Sequence[float], probabilities: Sequence[float]
) -> dict[float, tuple[ScoredHour, ...]]:
    """One arm per swept threshold, over one set of rows and one set of labels.

    Exactly the sweep's construction: the observed MWh do not move — only the
    threshold the label is cut at, and the composition it is composed against.
    """
    return {
        threshold: scored(
            list(zip(probabilities, magnitudes, strict=True)), threshold_mw=threshold
        )
        for threshold in SWEPT_THRESHOLDS
    }


def report(
    magnitudes: Sequence[float],
    probabilities: Sequence[float],
    *,
    fold: FoldSegment | None = None,
) -> ThresholdSweepReport:
    where = fold or segment()
    return ThresholdSweepReport(
        provenance=SweepProvenance.fixture(),
        rows=sweep_rows(arms(magnitudes, probabilities), segment=where),
    )


# --- the arms are one comparison ---------------------------------------------


def test_the_three_arms_are_scored_on_identical_rows() -> None:
    """Checkbox one, asserted by digest and never by count.

    The threshold enters ``feature_rows(...)`` as a label boundary and a stamp;
    the spine is a cross join that does not read it. So identical rows is a
    property of the construction, and this is the assertion that keeps it one.
    """
    built = report(ramp(), ramp())
    digests = {row.scored.row_digest for row in built.rows}
    assert len(digests) == 1
    assert {row.threshold_mw for row in built.rows} == set(SWEPT_THRESHOLDS)


def test_an_arm_scored_on_a_different_row_set_is_refused() -> None:
    """One extra hour in the 10 MW arm, which no count of three arms would see."""
    magnitudes = ramp()
    probabilities = ramp()
    by_threshold = arms(magnitudes, probabilities)
    short = by_threshold[10.0][:-1]
    by_threshold[10.0] = short
    with pytest.raises(RowIdentityError):
        sweep_rows(by_threshold, segment=segment())


def test_a_sweep_missing_a_threshold_is_not_a_sweep() -> None:
    by_threshold = arms(ramp(), ramp())
    del by_threshold[1.0]
    with pytest.raises(ThresholdSweepError):
        sweep_rows(by_threshold, segment=segment())


def test_an_arm_whose_hours_carry_a_second_threshold_is_refused() -> None:
    by_threshold = arms(ramp(), ramp())
    by_threshold[1.0] = by_threshold[5.0]
    with pytest.raises(ThresholdSweepError):
        sweep_rows(by_threshold, segment=segment())


# --- the six figures, and the two that are artifacts of the mixture ----------


def test_the_six_figures_are_published_per_threshold_and_per_fold() -> None:
    block = report(ramp(), ramp()).card_block()[THRESHOLD_SWEEP_BLOCK_KEY]
    assert [entry["row_id"] for entry in block["folds"]] == ["F1"]
    thresholds = block["folds"][0]["thresholds"]
    assert sorted(thresholds) == sorted(str(value) for value in SWEPT_THRESHOLDS)
    for figures in thresholds.values():
        for name in (
            "prevalence",
            "positives_per_local_hour",
            "pr_auc",
            "qloss_mwh",
            "coverage_p10",
            "share_p50_zero",
        ):
            assert name in figures


def test_share_p50_zero_is_the_mixture_breakpoint_restated() -> None:
    """The caveat, as an identity the module checks rather than a footnote.

    ``Q_Y(q) = 0`` for ``q ≤ 1 − p``, so the composed P50 is zero on exactly the
    hours where ``0.50 ≤ 1 − p`` — a statement about where the classifier's
    probabilities sit, with no model-quality content whatever. A sweep that
    reported ``share_p50_zero`` falling as the threshold drops, without this
    beside it, would be reporting the mixture as though it were a finding.
    """
    built = report(ramp(), ramp())
    for row in built.rows:
        assert row.figures.share_p50_zero == row.figures.regime.share_p50_forced_zero
        assert row.figures.regime.share_p10_forced_zero >= (
            row.figures.regime.share_p50_forced_zero
        )


def test_coverage_p10_carries_the_population_it_was_measured_over() -> None:
    """It is over curtailed hours, and which hours those are is what τ moves."""
    built = report([step * 2.0 for step in range(48)], ramp())
    populations = {
        row.threshold_mw: row.figures.regime.curtailed_hours for row in built.rows
    }
    assert populations[1.0] > populations[5.0] > populations[10.0]


def test_positives_per_local_hour_is_twenty_four_counts_with_denominators() -> None:
    built = report([step * 2.0 for step in range(48)], ramp())
    for row in built.rows:
        profile = row.figures.positives_by_local_hour
        assert len(profile.counts) == HOURS_PER_DAY
        assert len(profile.rows) == HOURS_PER_DAY
        assert sum(profile.counts) == row.figures.positives


def test_the_block_states_which_figures_survive_a_change_of_threshold() -> None:
    block = report(ramp(), ramp()).card_block()[THRESHOLD_SWEEP_BLOCK_KEY]
    comparability = block["comparability"]
    assert comparability["qloss_mwh"].startswith("comparable")
    for name in ("pr_auc", "coverage_p10", "share_p50_zero"):
        assert comparability[name].startswith("not comparable")


# --- the two move-forcing conditions -----------------------------------------


@pytest.mark.parametrize(
    ("prevalence", "condition", "forces"),
    [
        (0.02, "below_floor", True),
        (PREVALENCE_FLOOR, None, False),
        (0.20, None, False),
        (0.45, "above_ceiling", True),
    ],
)
def test_the_conditions_are_reported_as_met_or_not_met(
    prevalence: float, condition: str | None, forces: bool
) -> None:
    verdict = PrevalenceVerdict(threshold_mw=5.0, prevalence=prevalence)
    assert verdict.condition == condition
    assert verdict.forces_a_move is forces
    entry = verdict.as_card_entry()
    assert entry["below_floor"]["met"] is (condition == "below_floor")
    assert entry["above_ceiling"]["met"] is (condition == "above_ceiling")
    assert entry["below_floor"]["threshold"] == PREVALENCE_FLOOR
    assert entry["above_ceiling"]["threshold"] == PREVALENCE_CEILING


def test_every_threshold_carries_a_verdict_and_the_default_is_marked() -> None:
    built = report([step * 2.0 for step in range(48)], ramp())
    block = built.card_block()[THRESHOLD_SWEEP_BLOCK_KEY]
    assert block["default_threshold_mw"] == DEFAULT_THRESHOLD_MW
    for figures in block["folds"][0]["thresholds"].values():
        assert "prevalence_conditions" in figures
    default = block["folds"][0]["thresholds"][str(DEFAULT_THRESHOLD_MW)]
    assert default["is_default"] is True


# --- published rather than acted on ------------------------------------------


def test_the_sweep_names_no_preferred_threshold() -> None:
    """No public name and no card key ranks the arms.

    Asserted over the API surface rather than over the source text, so it holds
    against the thing a later reader actually reaches for. The failure mode is a
    convenience added for a caller — an ``ordering``, a ``best`` — which the
    optimizer or the gate then reads, and at that point the sweep has stopped
    being published and started being acted on.
    """
    built = report(ramp(), ramp())
    names = set(dir(built)) | set(dir(built.rows[0])) | set(dir(built.rows[0].figures))
    names |= _keys(built.card_block())
    for forbidden in ("best", "winner", "rank", "recommend", "select", "prefer"):
        offenders = sorted(name for name in names if forbidden in name.lower())
        assert offenders == [], offenders


def _keys(value: object) -> set[str]:
    """Every key in a nested card block, so a ranking cannot hide one level in."""
    if isinstance(value, dict):
        return set(value) | {key for entry in value.values() for key in _keys(entry)}
    if isinstance(value, list):
        return {key for entry in value for key in _keys(entry)}
    return set()


def test_a_sweep_only_lane_is_not_a_serving_lane() -> None:
    assert sweep_lane(DEFAULT_THRESHOLD_MW) in SERVING_LANES
    for lane in SWEEP_LANES:
        if lane.threshold_mw != DEFAULT_THRESHOLD_MW:
            assert lane not in SERVING_LANES


def test_a_promote_line_in_a_sweep_only_lane_is_refused(tmp_path: Path) -> None:
    path = tmp_path / PROMOTION_LOG_FILENAME
    append_promotion(
        path,
        PromotionRecord(
            artifact_id="2026-08-28T03:11:07Z",
            lane=sweep_lane(1.0),
            decision="promote",
            reason="a sweep arm promoted by hand",
            at=datetime(2026, 8, 28, 3, 11, 7, tzinfo=UTC),
        ),
    )
    with pytest.raises(ThresholdSweepError):
        assert_no_sweep_lane_promoted(PromotionLog.read(path))


def test_a_refusal_in_a_sweep_only_lane_is_fine(tmp_path: Path) -> None:
    """A refused sweep arm is evidence, and the log is where evidence goes."""
    path = tmp_path / PROMOTION_LOG_FILENAME
    append_promotion(
        path,
        PromotionRecord(
            artifact_id="2026-08-28T03:11:07Z",
            lane=sweep_lane(10.0),
            decision="refuse",
            reason="a sweep arm, gated and refused",
            at=datetime(2026, 8, 28, 3, 11, 7, tzinfo=UTC),
        ),
    )
    assert_no_sweep_lane_promoted(PromotionLog.read(path))


def test_recording_the_sweep_writes_a_card_and_no_promotion(tmp_path: Path) -> None:
    lane = sweep_lane(1.0)
    directory = tmp_path / lane.directory_name
    directory.mkdir(parents=True)
    artifact_id = "2026-08-28T03:11:07Z"
    (directory / f"{artifact_id}.card.json").write_text(
        json.dumps({"artifact_id": artifact_id}), encoding="utf-8"
    )
    path = record_threshold_sweep(
        report(ramp(), ramp()), root=tmp_path, artifact_id=artifact_id, lane=lane
    )
    card = json.loads(path.read_text(encoding="utf-8"))
    assert THRESHOLD_SWEEP_BLOCK_KEY in card
    assert card["artifact_id"] == artifact_id
    assert not (tmp_path / PROMOTION_LOG_FILENAME).exists()


def test_a_card_outside_the_swept_lanes_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ThresholdSweepError):
        record_threshold_sweep(
            report(ramp(), ramp()),
            root=tmp_path,
            artifact_id="2026-08-28T03:11:07Z",
            lane=Lane(
                feature_set="dessem_free_v1",
                gate_profile="gate_late",
                threshold_mw=7.0,
            ),
        )


# --- provenance ---------------------------------------------------------------


def test_a_fixture_sweep_says_it_is_not_evidence() -> None:
    block = report(ramp(), ramp()).card_block()[THRESHOLD_SWEEP_BLOCK_KEY]
    assert block["measured"] is False
    assert "NOT" in block["reads"]


def test_an_unmeasured_sweep_carries_a_reason_and_no_figure() -> None:
    block = UnmeasuredThresholdSweep(
        at=datetime(2026, 8, 28, 3, 11, 7, tzinfo=UTC),
        reason="no fold has been swept yet",
    ).card_block()[THRESHOLD_SWEEP_BLOCK_KEY]
    assert block["measured"] is False
    assert "folds" not in block
    assert block["default_threshold_mw"] == DEFAULT_THRESHOLD_MW


def test_the_default_is_the_published_constant() -> None:
    assert float(SUBSYSTEM_THRESHOLD_MW) == DEFAULT_THRESHOLD_MW
    assert SWEPT_THRESHOLDS == (1.0, 5.0, 10.0)
