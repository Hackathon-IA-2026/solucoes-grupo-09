"""The hot-swap gate: what promotes, what refuses, and what is left on the volume.

`docs/specs/forecaster.md`, seam 8. Every assertion here is about the *decision
procedure* — which check stopped a candidate, what the bootstrap resampled, what
landed on disk either way — and none is about accuracy. The hours are
constructed, so "the candidate is better" is a property this file arranges rather
than a fact about the Brazilian grid.

**Two builders and why they are separate.** :func:`scored` composes bands through
:func:`~wattsteer_ml.training.hurdle.compose_estimates`, so the bootstrap is run
over the bands the product ships. :func:`metrics_row` builds a
:class:`~wattsteer_ml.evaluation.metrics.MetricsRow` field by field, because the
guardrail tests need a candidate that fails **one** guardrail and nothing else,
and a row derived from hours cannot have one column moved without moving four.
The two describe one artifact in production; here they are set independently so
each veto can be exercised alone.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from conftest import FUNCTION_DEFINITION
from ladder_fixtures import rows_with_same_hour_features, without_exceedance
from wattsteer_ml.artifacts import ARTIFACT_SUFFIX, CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import Fold, FoldBlocks, FoldSegment, RowKey, stamp_fidelity
from wattsteer_ml.evaluation.gate import (
    BOOTSTRAP_DRAWS,
    CROSSING_RATE_CEILING,
    ECE_CEILING,
    MINIMUM_TEST_DAYS,
    NULL_RATE_DRIFT_CEILING,
    PROMOTION_PROBABILITY,
    Comparator,
    ContractDriftError,
    GateCandidate,
    GateError,
    GateInputError,
    Guardrail,
    NoCandidate,
    ServingSmoke,
    cold_start_baseline,
    decide,
    guardrails,
    hour_loss,
    null_rates,
    paired_block_bootstrap,
    record_decision,
    rollback,
    run_gate,
    serving_smoke,
)
from wattsteer_ml.evaluation.ladder import FoldRows, MissingBaselineFeatureError
from wattsteer_ml.evaluation.metrics import (
    MetricsRow,
    MetricsTable,
    OperatingPoint,
    SubsystemOccurrence,
    qloss_mwh,
)
from wattsteer_ml.evaluation.transformer_benchmark import BENCHMARK_ARM
from wattsteer_ml.lanes import Lane
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionLog
from wattsteer_ml.training import TrainedFold
from wattsteer_ml.training.bundle import (
    CONTRACT_FAULT_KEY,
    GATE_BLOCK_KEY,
    ContractMismatchError,
    SubThresholdMeans,
    contract_fault,
    load_artifact,
    read_card,
    save_artifact,
)
from wattsteer_ml.training.calibration import RiskBinsUndeterminedError
from wattsteer_ml.training.conformal import CoverageReport, ScoredHour
from wattsteer_ml.training.contract import SUBSYSTEM_COLUMN
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

THRESHOLD_MW = 5.0
LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
OTHER_LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_early", threshold_mw=5)

#: The deciding fold's first test day, and enough of them to clear check 4.
FIRST = date(2026, 4, 1)
TEST_DAYS = MINIMUM_TEST_DAYS

#: Two local hours per day per subsystem. The gate resamples *days*, so the
#: number of hours inside one is a cost, not a property under test.
HOURS_PER_DAY = 2

#: The per-subsystem PR-AUC the builder gives every cell unless a test moves one.
#: Held apart from the pooled figure so "pooled fell" and "one subsystem fell"
#: are two candidates and not one.
SUBSYSTEM_PR_AUC = 0.60

FIXTURE_HASH = "sha256:" + "f" * 64
LIVE_HASH = "sha256:" + "1" * 64
STALE_HASH = "sha256:" + "2" * 64

CANDIDATE_ID = "2026-06-01T03:00:00Z"
INCUMBENT_ID = "2026-05-25T03:00:00Z"
NOW = datetime(2026, 6, 1, 3, 0, tzinfo=UTC)

#: ``μ_sub`` as zeros — see `tests.test_metrics_table`: a non-zero sub-threshold
#: mean would move the expectation without moving a quantile.
FLAT_MU_SUB = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(24)) for _ in SUBSYSTEM_CODES)
)


# --- builders ----------------------------------------------------------------


def segment(
    *,
    fold_id: str = "F6",
    days: int = TEST_DAYS,
    fidelity: VintageFidelity = "point_in_time",
    first: date = FIRST,
) -> FoldSegment:
    return FoldSegment(
        fold_id=fold_id,
        row_id=fold_id,
        fidelity=fidelity,
        test_start=first,
        test_end=first + timedelta(days=days - 1),
        is_split=False,
        fold_hash=FIXTURE_HASH,
    )


DECIDING = segment()


def keys(days: int = TEST_DAYS, *, first: date = FIRST) -> list[RowKey]:
    return [
        RowKey(
            target_date=first + timedelta(days=offset), local_hour=hour, subsystem=code
        )
        for offset in range(days)
        for hour in range(HOURS_PER_DAY)
        for code in SUBSYSTEM_CODES
    ]


def observations(row_keys: Sequence[RowKey]) -> list[float]:
    """Alternating curtailed and quiet hours. Deterministic, and above ``τ``."""
    return [0.0 if index % 2 else 12.0 for index in range(len(row_keys))]


def scored(
    row_keys: Sequence[RowKey], *, offset_mwh: float, probability: float = 0.95
) -> tuple[ScoredHour, ...]:
    """Composed hours whose knots sit ``offset_mwh`` away from the label.

    ``offset_mwh = 0`` is a model that is exactly right on every hour, and a
    larger offset is a strictly worse model **on every day**, which is what the
    "strictly better on every test day" box needs to be able to arrange.
    """
    labels = observations(row_keys)
    composed = compose_estimates(
        row_keys,
        [
            HourEstimates(
                occurrence_probability=probability,
                q10=max(0.0, label + offset_mwh - 1.0),
                q50=max(0.0, label + offset_mwh),
                q90=max(0.0, label + offset_mwh + 1.0),
                positive_mean_mwh=max(0.0, label + offset_mwh),
            )
            for label in labels
        ],
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=THRESHOLD_MW,
    )
    return tuple(
        ScoredHour(key=hour.key, forecast=hour.forecast, observed_mwh=label)
        for hour, label in zip(composed, labels, strict=True)
    )


def coverage_report(
    *,
    coverage_p10: float = 0.90,
    coverage_p90: float = 0.92,
    p50_unbiasedness: float = 0.50,
    crossing_rate: float = 0.0,
) -> CoverageReport:
    return CoverageReport(
        fold_id=DECIDING.row_id,
        rows=480,
        coverage_p10=coverage_p10,
        coverage_p90=coverage_p90,
        upper_correction_realised=0.8,
        p50_unbiasedness=p50_unbiasedness,
        crossing_rate=crossing_rate,
        by_subsystem=(),
        by_local_hour=(),
    )


def metrics_row(
    *,
    run: str = "A-full",
    rung: str = "lightgbm",
    rung_number: int = 4,
    seg: FoldSegment | None = None,
    pr_auc: float | None = 0.60,
    subsystem_pr_auc: Mapping[str, float | None] | None = None,
    recall: float = 0.70,
    ece: float | None = 0.02,
    crossing_rate: float = 0.0,
    coverage: CoverageReport | None = None,
    no_coverage: bool = False,
    qloss: float = 1.0,
) -> MetricsRow:
    """One metrics row, every column set explicitly.

    Built through the constructor rather than through
    :meth:`~wattsteer_ml.evaluation.metrics.MetricsRow.of`, because the guardrail
    tests need one column moved and the rest held: a row derived from hours
    cannot have its ECE changed without changing four other numbers, and the
    resulting test would not be about one veto.
    """
    cells = dict(subsystem_pr_auc or {})
    return MetricsRow(
        run=run,
        rung=rung,
        rung_number=rung_number,
        imputed=False,
        calibrated=True,
        conformalised=True,
        segment=DECIDING if seg is None else seg,
        rows=480,
        prevalence=0.5,
        pr_auc=pr_auc,
        by_subsystem=tuple(
            SubsystemOccurrence(
                subsystem=code,
                rows=120,
                prevalence=0.5,
                pr_auc=cells.get(code, SUBSYSTEM_PR_AUC),
            )
            for code in SUBSYSTEM_CODES
        ),
        brier=0.1,
        ece=ece,
        mce=0.05,
        top_bin_gap=0.02,
        at_fixed=OperatingPoint(threshold=0.5, precision=0.7, recall=recall, f1=0.7),
        at_best=OperatingPoint(threshold=0.4, precision=0.7, recall=0.8, f1=0.75),
        mae_positives_mwh=1.0,
        smape_positives=0.1,
        pinball_10=1.0,
        pinball_50=1.0,
        pinball_90=1.0,
        qloss_mwh=qloss,
        interval_width_mean_mwh=2.0,
        crossing_rate=crossing_rate,
        coverage=(
            None if no_coverage else (coverage_report() if coverage is None else coverage)
        ),
        delta_lo=0.5,
        delta_hi=0.5,
        day_grain=None,
        collapse=None,
    )


def candidate(
    *,
    hours: Sequence[ScoredHour] | None = None,
    row: MetricsRow | None = None,
    lane: Lane = LANE,
    estimator_family: str = "lightgbm",
    feature_hash: str = LIVE_HASH,
    trained_to: date | None = None,
    artifact_id: str = CANDIDATE_ID,
) -> GateCandidate:
    deciding = metrics_row() if row is None else row
    return GateCandidate(
        artifact_id=artifact_id,
        lane=lane,
        estimator_family=estimator_family,
        feature_hash=feature_hash,
        newest_training_target_date=(
            NOW.date() - timedelta(days=1) if trained_to is None else trained_to
        ),
        metrics=MetricsTable(rows=(deciding,)),
        run=deciding.run,
        deciding_row_id=deciding.row_id,
        hours=tuple(scored(keys(), offset_mwh=0.0) if hours is None else hours),
        rung=deciding.rung,
    )


def incumbent(
    *,
    hours: Sequence[ScoredHour] | None = None,
    row: MetricsRow | None = None,
    lane: Lane = LANE,
    feature_hash: str = LIVE_HASH,
) -> Comparator:
    return Comparator.incumbent(
        artifact_id=INCUMBENT_ID,
        lane=lane,
        feature_hash=feature_hash,
        row=metrics_row() if row is None else row,
        hours=tuple(scored(keys(), offset_mwh=4.0) if hours is None else hours),
    )


def clean_smoke() -> ServingSmoke:
    """A serving smoke that found nothing wrong. Check 7 has its own tests."""
    return ServingSmoke(
        target_date=NOW.date() + timedelta(days=1),
        hours_by_subsystem=dict.fromkeys(SUBSYSTEM_CODES, 24),
        faults=(),
        drifted=(),
    )


def run(
    candidate_: GateCandidate,
    comparator: Comparator,
    *,
    live: str = LIVE_HASH,
    smoke: ServingSmoke | None = None,
    draws: int = 200,
) -> Any:
    return decide(
        candidate_,
        comparator,
        live_feature_hash=live,
        smoke=clean_smoke() if smoke is None else smoke,
        now=NOW,
        draws=draws,
    )


def lane_directory(root: Path, *, artifact_id: str = CANDIDATE_ID) -> Path:
    """A lane on a scratch volume, holding one bundle-shaped file and its card."""
    directory = root / LANE.directory_name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{artifact_id}{ARTIFACT_SUFFIX}").write_bytes(b"not a real bundle")
    (directory / f"{artifact_id}{CARD_SUFFIX}").write_text(
        json.dumps({"identity": {"artifact_id": artifact_id}}, indent=2) + "\n",
        encoding="utf-8",
    )
    return directory


# --- the acceptance boxes ----------------------------------------------------


def test_a_candidate_byte_identical_to_the_incumbent_does_not_promote() -> None:
    """The first box, and the reason the gate needs no absolute bar.

    Identical hours means every resample is a tie, so ``P(candidate < incumbent)``
    is 0.0 under the spec's strict inequality — never better rather than always
    worse, which is what :attr:`PairedBootstrap.ties` is published to say.
    """
    hours = scored(keys(), offset_mwh=1.0)
    decision = run(candidate(hours=hours), incumbent(hours=hours))
    assert not decision.promotes
    assert decision.bootstrap is not None
    assert decision.bootstrap.probability == 0.0
    assert decision.bootstrap.ties == decision.bootstrap.draws
    assert (
        decision.bootstrap.candidate_qloss_mwh == decision.bootstrap.comparator_qloss_mwh
    )
    assert decision.checks[-1].name == "paired_block_bootstrap"


def test_a_candidate_strictly_better_on_every_test_day_promotes() -> None:
    """The second box. Better on every day means better on every resample."""
    decision = run(candidate(), incumbent())
    assert decision.promotes
    assert decision.bootstrap is not None
    assert decision.bootstrap.probability == 1.0
    assert decision.bootstrap.probability >= PROMOTION_PROBABILITY
    assert [check.name for check in decision.checks] == [
        "lane_identity",
        "estimator_allow_list",
        "feature_contract",
        "freshness_and_coverage",
        "paired_block_bootstrap",
        "guardrails",
        "serving_smoke",
    ]
    assert all(check.passed for check in decision.checks)


def test_a_mismatched_feature_hash_refuses_and_raises(tmp_path: Path) -> None:
    """The third box: refused, recorded, the incumbent marked, and then raised.

    All four, in that order. Raising before the write would leave a candidate on
    the volume with nothing saying why it is not serving.
    """
    lane_directory(tmp_path)
    lane_directory(tmp_path, artifact_id=INCUMBENT_ID)
    with pytest.raises(ContractDriftError) as raised:
        run_gate(
            candidate(feature_hash=STALE_HASH),
            incumbent(feature_hash=STALE_HASH),
            root=tmp_path,
            live_feature_hash=LIVE_HASH,
            smoke=clean_smoke(),
            now=NOW,
            draws=50,
        )
    assert INCUMBENT_ID in str(raised.value)
    assert "removed" in str(raised.value)

    log = PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME)
    assert [record.decision for record in log.records] == ["refuse"]
    assert log.records[0].artifact_id == CANDIDATE_ID
    assert log.promoted(LANE) is None
    assert log.records[0].evidence["contract_drift"] == {
        "lane": LANE.directory_name,
        "live_feature_hash": LIVE_HASH,
        "candidate_feature_hash": STALE_HASH,
        "incumbent_artifact_id": INCUMBENT_ID,
        "incumbent_feature_hash": STALE_HASH,
    }

    incumbent_card = read_card(
        tmp_path / LANE.directory_name / f"{INCUMBENT_ID}{CARD_SUFFIX}"
    )
    fault = contract_fault(incumbent_card)
    assert fault is not None
    assert LIVE_HASH in fault
    assert incumbent_card[GATE_BLOCK_KEY][CONTRACT_FAULT_KEY] == fault


def test_an_artifact_marked_invalid_stops_loading(
    trained: TrainedFold, tmp_path: Path
) -> None:
    """ "Marked invalid rather than left quietly serving", as a load that refuses.

    The promotion log holds ``promote`` and ``refuse`` and neither revokes an
    earlier promotion, and after a contract change there is no earlier artifact
    for a rollback line to name — every bundle in the lane was fitted against the
    departed SQL. So the mark goes on the card, where
    :func:`~wattsteer_ml.training.bundle.load_artifact` already refuses things.
    """
    lane = trained.bundle.lane
    save_artifact(trained.bundle, trained.card, root=tmp_path)
    loaded = load_artifact(root=tmp_path, lane=lane, artifact_id=trained.card.artifact_id)
    assert loaded.artifact_id == trained.card.artifact_id

    path = tmp_path / lane.directory_name / f"{trained.card.artifact_id}{CARD_SUFFIX}"
    card = read_card(path)
    card[GATE_BLOCK_KEY] = {CONTRACT_FAULT_KEY: "the feature SQL moved"}
    path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(ContractMismatchError, match="marked invalid"):
        load_artifact(root=tmp_path, lane=lane, artifact_id=trained.card.artifact_id)


def test_an_estimator_family_off_the_allow_list_refuses() -> None:
    """The fourth box. The transformer benchmark, refused rather than agreed.

    The family under test is
    :data:`~wattsteer_ml.evaluation.transformer_benchmark.BENCHMARK_ARM` — the
    benchmark's own constant, imported rather than a literal — so this check and
    the thing it is meant to check cannot be decoupled by a rename. Forecaster
    ticket 20's fourth box is this assertion.
    """
    decision = run(candidate(estimator_family=BENCHMARK_ARM), incumbent())
    assert not decision.promotes
    assert decision.checks[-1].name == "estimator_allow_list"
    assert BENCHMARK_ARM in decision.reason
    assert decision.bootstrap is None


def test_a_different_lane_is_never_a_swap() -> None:
    """Check 1. A different triple is a different model, not a newer one."""
    decision = run(candidate(), incumbent(lane=OTHER_LANE))
    assert not decision.promotes
    assert decision.checks[-1].name == "lane_identity"


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        pytest.param({"pr_auc": 0.55}, "pr_auc[pooled]", id="pr_auc pooled"),
        pytest.param(
            {"subsystem_pr_auc": {"NE": 0.50}}, "pr_auc[NE]", id="pr_auc one subsystem"
        ),
        pytest.param({"recall": 0.60}, "recall@0.5[pooled]", id="recall@0.5"),
        pytest.param(
            {"coverage": coverage_report(coverage_p10=0.80)},
            "coverage_p10",
            id="coverage_p10",
        ),
        pytest.param(
            {"coverage": coverage_report(coverage_p90=0.99)},
            "coverage_p90",
            id="coverage_p90",
        ),
        pytest.param(
            {"coverage": coverage_report(p50_unbiasedness=0.60)},
            "p50_unbiasedness",
            id="p50_unbiasedness",
        ),
        pytest.param({"ece": ECE_CEILING + 0.01}, "ece", id="ece"),
        pytest.param(
            {"crossing_rate": CROSSING_RATE_CEILING + 0.01},
            "crossing_rate",
            id="crossing_rate",
        ),
    ],
)
def test_each_guardrail_is_exercised_alone(kwargs: dict[str, Any], expected: str) -> None:
    """The fifth box: one candidate per guardrail, failing only that one.

    Each case clears the bootstrap — the candidate is strictly better on every
    day — and is then vetoed by exactly one constant, which is what makes the
    guardrails vetoes rather than the decision.
    """
    row = metrics_row(**kwargs)
    decision = run(candidate(row=row), incumbent())
    assert not decision.promotes
    assert decision.checks[-1].name == "guardrails"
    assert decision.bootstrap is not None
    assert decision.bootstrap.promotes
    vetoed = [rail.name for rail in decision.guardrails if rail.vetoes]
    assert vetoed == [expected]
    assert expected in decision.reason
    # Replay 09's floor-coverage rail is *not applicable* on this fixture — two
    # local hours a day is no complete subsystem-day — and a not-applicable rail
    # neither vetoes nor claims to have passed anything.
    floor = [rail for rail in decision.guardrails if rail.name == "floor_coverage"]
    assert [(rail.applicable, rail.passed, rail.vetoes) for rail in floor] == [
        (False, False, False)
    ]


def test_every_guardrail_states_the_constant_it_used() -> None:
    """A refused card must not send its reader off to find the number."""
    rails = guardrails(metrics_row(), metrics_row())
    assert all(rail.passed for rail in rails)
    assert all(rail.bound for rail in rails)
    assert {rail.name for rail in rails} == {
        "pr_auc[pooled]",
        *(f"pr_auc[{code}]" for code in SUBSYSTEM_CODES),
        "recall@0.5[pooled]",
        "coverage_p10",
        "coverage_p90",
        "p50_unbiasedness",
        "ece",
        "crossing_rate",
    }


def test_an_unmeasurable_guardrail_vetoes() -> None:
    """A veto that passed on absent evidence would be a constant choosing a swap."""
    rails = {
        rail.name: rail
        for rail in guardrails(metrics_row(ece=None, no_coverage=True), metrics_row())
    }
    assert not rails["ece"].passed
    assert not rails["coverage_p10"].passed
    assert not rails["p50_unbiasedness"].passed
    assert rails["ece"].value is None


# --- the cold start ----------------------------------------------------------


def test_cold_start_refuses_a_model_that_cannot_beat_the_seven_day_baseline() -> None:
    """The sixth box. No incumbent, so the bar is rung 1 and nothing else."""
    baseline = Comparator.cold_start(
        row=metrics_row(rung="same_hour_7d", rung_number=1),
        hours=scored(keys(), offset_mwh=1.0),
    )
    decision = run(candidate(hours=scored(keys(), offset_mwh=6.0)), baseline)
    assert not decision.promotes
    assert decision.comparator == "same_hour_7d"
    assert decision.bootstrap is not None
    assert decision.bootstrap.kind == "same_hour_7d"
    assert decision.bootstrap.probability < PROMOTION_PROBABILITY
    assert "same_hour_7d" in decision.reason


def test_cold_start_promotes_a_model_that_does_beat_the_baseline() -> None:
    """The same test, the other way: an empty lane can be filled."""
    baseline = Comparator.cold_start(
        row=metrics_row(rung="same_hour_7d", rung_number=1),
        hours=scored(keys(), offset_mwh=6.0),
    )
    decision = run(candidate(), baseline)
    assert decision.promotes
    assert decision.comparator == "same_hour_7d"


def test_the_cold_start_baseline_is_rung_one_of_the_ladder(
    fold: Fold, blocks: FoldBlocks
) -> None:
    """The bar is the ladder's rung 1, fitted here rather than approximated."""
    rows = rows_with_same_hour_features(first=blocks.base_fit_start, last=blocks.test_end)
    fold_rows = FoldRows.of(
        rows, fold=fold, blocks=blocks, function_definition=FUNCTION_DEFINITION
    )
    (one,) = stamp_fidelity(fold, None)
    comparator = cold_start_baseline(fold_rows, segment=one, run="A-full")
    assert comparator.kind == "same_hour_7d"
    assert comparator.artifact_id is None
    assert comparator.row.rung == "same_hour_7d"
    assert comparator.row.rung_number == 1
    assert len(comparator.hours) == comparator.row.rows


def test_a_cold_start_cannot_run_against_the_live_feature_function(
    fold: Fold, blocks: FoldBlocks
) -> None:
    """A contract without ``observed_constrained_off_same_hour_exceedance_7d``.

    That was the whole migration tree once; since
    `0036_the_same_hour_exceedance.sql` it is an artifact built against an older
    feature function. Either way a lane with no incumbent has no bar to clear and
    **promotes nothing**: rung 1 raises rather than substituting
    ``observed_constrained_off_hours_above_threshold_7d``, which counts all hours
    over seven days instead of the seven observations of one local hour. That is
    the honest cold start, and it is a fact about the contract in hand rather
    than about the gate.
    """
    rows = without_exceedance(
        rows_with_same_hour_features(first=blocks.base_fit_start, last=blocks.test_end)
    )
    fold_rows = FoldRows.of(
        rows, fold=fold, blocks=blocks, function_definition=FUNCTION_DEFINITION
    )
    (one,) = stamp_fidelity(fold, None)
    with pytest.raises(MissingBaselineFeatureError, match="exceedance"):
        cold_start_baseline(fold_rows, segment=one, run="A-full")


# --- the bootstrap -----------------------------------------------------------


def test_the_bootstrap_resamples_whole_days_and_is_seeded() -> None:
    """The seventh box, asserted against a reference that resamples day blocks.

    The reference draws the same day indices from the same seed, concatenates
    those days' hours and calls
    :func:`~wattsteer_ml.evaluation.metrics.qloss_mwh` on them. Agreeing with it
    pins two things at once: the block is a whole target day, and the statistic
    inside a resample is the gate's own metric rather than an approximation of it.
    """
    row_keys = keys(days=8)
    left = scored(row_keys, offset_mwh=0.0)
    right = scored(row_keys, offset_mwh=3.0)
    draws, seed = 40, 4242
    result = paired_block_bootstrap(left, right, kind="incumbent", draws=draws, seed=seed)
    assert result.days == 8
    assert result.hours == len(row_keys)
    assert result.seed == seed

    days = sorted({hour.key.target_date for hour in left})
    by_day = {
        day: (
            [hour for hour in left if hour.key.target_date == day],
            [hour for hour in right if hour.key.target_date == day],
        )
        for day in days
    }
    picks = np.random.default_rng(seed).integers(0, len(days), size=(draws, len(days)))
    wins = 0
    for draw in picks:
        chosen = [by_day[days[int(index)]] for index in draw]
        wins += qloss_mwh([hour for block, _ in chosen for hour in block]) < qloss_mwh(
            [hour for _, block in chosen for hour in block]
        )
    assert result.probability == wins / draws
    assert (
        result.probability
        == paired_block_bootstrap(
            left, right, kind="incumbent", draws=draws, seed=seed
        ).probability
    )


def test_the_hour_loss_the_bootstrap_accumulates_is_qloss() -> None:
    """The shortcut the block sums rely on, checked rather than commented."""
    hours = scored(keys(days=3), offset_mwh=2.0)
    pooled = sum(hour_loss(hour) for hour in hours) / len(hours)
    assert pooled == pytest.approx(qloss_mwh(hours))


def test_the_bootstrap_refuses_two_models_scored_on_different_rows() -> None:
    """A paired test over unpaired rows is not a paired test."""
    left = scored(keys(days=4), offset_mwh=0.0)
    right = scored(keys(days=4, first=FIRST + timedelta(days=1)), offset_mwh=0.0)
    with pytest.raises(GateInputError, match="one row set"):
        paired_block_bootstrap(left, right, kind="incumbent", draws=10)


def test_the_gate_refuses_two_deciding_rows_from_different_segments() -> None:
    """The metrics table's rule, applied across two tables it cannot see at once."""
    with pytest.raises(GateInputError, match="not the same rows"):
        run(candidate(), incumbent(row=metrics_row(seg=segment(fold_id="F5"))))


# --- freshness and coverage --------------------------------------------------


def test_a_stale_training_window_refuses() -> None:
    decision = run(candidate(trained_to=NOW.date() - timedelta(days=30)), incumbent())
    assert not decision.promotes
    assert decision.checks[-1].name == "freshness_and_coverage"
    assert "outside the 7-day window" in decision.reason


def test_a_short_deciding_fold_refuses() -> None:
    short = segment(days=30)
    row = metrics_row(seg=short)
    decision = run(
        candidate(row=row, hours=scored(keys(days=30), offset_mwh=0.0)),
        Comparator.incumbent(
            artifact_id=INCUMBENT_ID,
            lane=LANE,
            feature_hash=LIVE_HASH,
            row=metrics_row(seg=short),
            hours=scored(keys(days=30), offset_mwh=4.0),
        ),
    )
    assert not decision.promotes
    assert f"under the {MINIMUM_TEST_DAYS}" in decision.reason


def test_a_revision_optimistic_fold_may_not_decide_once_a_point_in_time_one_exists() -> (
    None
):
    """The protocol's rule, enforced where it would otherwise be a convention."""
    optimistic = segment(fold_id="F5", fidelity="revision_optimistic")
    deciding = metrics_row(seg=optimistic)
    other = metrics_row(seg=segment(fold_id="F6"))
    table = MetricsTable(rows=(deciding, other))
    subject = GateCandidate(
        artifact_id=CANDIDATE_ID,
        lane=LANE,
        estimator_family="lightgbm",
        feature_hash=LIVE_HASH,
        newest_training_target_date=NOW.date() - timedelta(days=1),
        metrics=table,
        run="A-full",
        deciding_row_id="F5",
        hours=scored(keys(), offset_mwh=0.0),
    )
    decision = run(subject, incumbent(row=metrics_row(seg=optimistic)))
    assert not decision.promotes
    assert "may not be the deciding fold" in decision.reason


# --- the serving smoke -------------------------------------------------------


@pytest.fixture(scope="module")
def serving_day(blocks: FoldBlocks) -> date:
    return blocks.test_end


@pytest.fixture(scope="module")
def serving_rows(rows: list[dict[str, Any]], serving_day: date) -> list[dict[str, Any]]:
    return [row for row in rows if row["target_date"] == serving_day]


def test_the_serving_smoke_passes_on_the_real_vector(
    trained: TrainedFold,
    rows: list[dict[str, Any]],
    serving_rows: list[dict[str, Any]],
    serving_day: date,
) -> None:
    """Twenty-four hours for every subsystem, in order, with a day band drawn.

    The day-grain half asserts that the path ensemble produced a finite, ordered
    day total and peak for all four subsystems. It deliberately does **not**
    assert the spec's ``[Σ P10, Σ P90]`` containment — see :func:`serving_smoke`
    for the two reasons, one of which is that this fixture's own N and SE
    subsystems fail it while behaving correctly.
    """
    smoke = serving_smoke(
        trained.bundle,
        serving_rows,
        target_date=serving_day,
        training_null_rates=null_rates(rows),
    )
    assert smoke.faults == ()
    assert smoke.drifted == ()
    assert smoke.passed
    assert set(smoke.hours_by_subsystem) == set(SUBSYSTEM_CODES)
    assert set(smoke.hours_by_subsystem.values()) == {24}


def test_the_serving_smoke_sees_an_incomplete_day(
    trained: TrainedFold,
    rows: list[dict[str, Any]],
    serving_rows: list[dict[str, Any]],
    serving_day: date,
) -> None:
    """A subsystem the feature function stopped emitting is a refusal, not a gap."""
    thinned = [row for row in serving_rows if row["subsystem"] != "NE"]
    smoke = serving_smoke(
        trained.bundle,
        thinned,
        target_date=serving_day,
        training_null_rates=null_rates(rows),
    )
    assert not smoke.passed
    assert any("NE has 0 composed hours" in fault for fault in smoke.faults)


def test_the_serving_smoke_sees_an_upstream_dataset_go_quiet(
    trained: TrainedFold,
    rows: list[dict[str, Any]],
    serving_rows: list[dict[str, Any]],
    serving_day: date,
) -> None:
    """The check no historical metric can make. One feature, gone NULL today."""
    training = null_rates(rows)
    quiet = next(
        name
        for name, rate in training.items()
        if rate == 0.0 and name != SUBSYSTEM_COLUMN
    )
    blanked = [{**row, quiet: None} for row in serving_rows]
    smoke = serving_smoke(
        trained.bundle,
        blanked,
        target_date=serving_day,
        training_null_rates=training,
    )
    assert not smoke.passed
    assert [drift.feature for drift in smoke.drifted] == [quiet]
    assert smoke.drifted[0].excess > NULL_RATE_DRIFT_CEILING
    assert smoke.drifted[0].training == 0.0
    assert smoke.drifted[0].serving == 1.0


def test_a_failing_smoke_refuses_after_the_bootstrap_passed() -> None:
    """Check 7 is a check, not a report: it can stop a candidate on its own."""
    failed = ServingSmoke(
        target_date=NOW.date() + timedelta(days=1),
        hours_by_subsystem=dict.fromkeys(SUBSYSTEM_CODES, 24),
        faults=("N 2026-06-02: the band or the expectation is not finite",),
        drifted=(),
    )
    decision = run(candidate(), incumbent(), smoke=failed)
    assert not decision.promotes
    assert decision.checks[-1].name == "serving_smoke"
    assert decision.smoke is failed


# --- what lands on the volume ------------------------------------------------


def test_a_refusal_writes_a_card_and_exactly_one_log_line(tmp_path: Path) -> None:
    """The eighth box, first half. A refused candidate stays inspectable."""
    lane_directory(tmp_path)
    decision = run(candidate(estimator_family=BENCHMARK_ARM), incumbent())
    record_decision(decision, root=tmp_path)

    text = (tmp_path / PROMOTION_LOG_FILENAME).read_text(encoding="utf-8")
    assert len(text.splitlines()) == 1
    log = PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME)
    assert log.promoted(LANE) is None
    assert log.records[0].decision == "refuse"

    card = read_card(tmp_path / LANE.directory_name / f"{CANDIDATE_ID}{CARD_SUFFIX}")
    assert card[GATE_BLOCK_KEY]["decision"] == "refuse"
    assert card["identity"]["artifact_id"] == CANDIDATE_ID


def test_the_bootstrap_statistic_is_written_into_the_cards_decision_block(
    tmp_path: Path,
) -> None:
    """The seventh box's last clause: the number that decided is on the card."""
    lane_directory(tmp_path)
    decision = run(candidate(), incumbent())
    assert decision.promotes
    record_decision(decision, root=tmp_path)

    block = read_card(tmp_path / LANE.directory_name / f"{CANDIDATE_ID}{CARD_SUFFIX}")[
        GATE_BLOCK_KEY
    ]
    assert decision.bootstrap is not None
    assert block["bootstrap_p"] == decision.bootstrap.probability
    assert block["bootstrap"]["draws"] == decision.bootstrap.draws
    assert block["bootstrap"]["seed"] == decision.bootstrap.seed
    assert block["bootstrap"]["days"] == TEST_DAYS
    assert block["bootstrap"]["promotion_probability"] == PROMOTION_PROBABILITY
    assert [rail["guardrail"] for rail in block["guardrails"]]
    assert block["serving_smoke"]["target_date"]

    log = PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME)
    assert log.promoted(LANE) == CANDIDATE_ID
    assert log.records[0].evidence["bootstrap_p"] == decision.bootstrap.probability


def test_a_rollback_restores_the_earlier_artifact_and_deletes_nothing(
    tmp_path: Path,
) -> None:
    """The eighth box, second half. Rollback is an append, and only an append."""
    lane_directory(tmp_path, artifact_id=INCUMBENT_ID)
    lane_directory(tmp_path, artifact_id=CANDIDATE_ID)
    good = run(candidate(artifact_id=INCUMBENT_ID), incumbent())
    record_decision(good, root=tmp_path)
    bad = run(candidate(), incumbent())
    record_decision(bad, root=tmp_path)
    log = PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME)
    assert log.promoted(LANE) == CANDIDATE_ID

    restored = rollback(
        root=tmp_path,
        lane=LANE,
        artifact_id=INCUMBENT_ID,
        reason=f"rollback of {CANDIDATE_ID}",
        at=NOW + timedelta(hours=1),
    )
    assert restored.decision == "promote"

    log = PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME)
    assert log.promoted(LANE) == INCUMBENT_ID
    assert [record.artifact_id for record in log.for_lane(LANE)] == [
        INCUMBENT_ID,
        CANDIDATE_ID,
        INCUMBENT_ID,
    ]
    directory = tmp_path / LANE.directory_name
    for artifact_id in (INCUMBENT_ID, CANDIDATE_ID):
        assert (directory / f"{artifact_id}{ARTIFACT_SUFFIX}").is_file()
        assert (directory / f"{artifact_id}{CARD_SUFFIX}").is_file()


def test_a_rollback_to_an_absent_artifact_is_refused(tmp_path: Path) -> None:
    """A promote line naming nothing makes the lane unresolvable, not restored."""
    lane_directory(tmp_path)
    with pytest.raises(GateInputError):
        rollback(root=tmp_path, lane=LANE, artifact_id=CANDIDATE_ID, reason=" ", at=NOW)
    with pytest.raises(GateError, match="is not at"):
        rollback(
            root=tmp_path,
            lane=LANE,
            artifact_id=INCUMBENT_ID,
            reason="restore",
            at=NOW,
        )
    assert not (tmp_path / PROMOTION_LOG_FILENAME).exists()


def test_a_retrain_that_produced_no_artifact_writes_nothing(tmp_path: Path) -> None:
    """``derive_risk_bins`` raising is a legitimate outcome, and not a refusal.

    There is no bundle, no card and no artifact id, so there is nothing the
    promotion log — which is keyed by artifact id — could honestly say. The
    incumbent goes on serving because the most recent ``promote`` line still
    names it.
    """
    lane_directory(tmp_path, artifact_id=INCUMBENT_ID)
    record_decision(run(candidate(artifact_id=INCUMBENT_ID), incumbent()), root=tmp_path)
    before = (tmp_path / PROMOTION_LOG_FILENAME).read_text(encoding="utf-8")

    outcome = NoCandidate.from_training_failure(
        RiskBinsUndeterminedError("no split of this pool satisfies (a) and (b)"),
        lane=LANE,
        at=NOW,
    )
    assert "RiskBinsUndeterminedError" in outcome.reason
    assert outcome.as_dict()["appended_to_promotion_log"] is False
    assert (tmp_path / PROMOTION_LOG_FILENAME).read_text(encoding="utf-8") == before
    assert PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME).promoted(LANE) == (
        INCUMBENT_ID
    )


def test_a_promotion_cannot_be_built_without_a_bootstrap_that_cleared() -> None:
    """ "We swapped and nobody knows why" is not a value this module can hold."""
    from wattsteer_ml.evaluation.gate import GateCheck, GateDecision

    with pytest.raises(GateInputError, match="no number decided"):
        GateDecision(
            artifact_id=CANDIDATE_ID,
            lane=LANE,
            decision="promote",
            reason="because",
            at=NOW,
            checks=(GateCheck(name="lane_identity", passed=True, detail="ok"),),
            comparator="incumbent",
        )


def test_the_defaults_are_the_specs_numbers() -> None:
    """The constants a reader would otherwise have to trust a docstring for."""
    assert BOOTSTRAP_DRAWS == 2_000
    assert PROMOTION_PROBABILITY == 0.90
    assert MINIMUM_TEST_DAYS == 60
    assert NULL_RATE_DRIFT_CEILING == 0.05
    assert isinstance(Guardrail(name="x", passed=True, detail="y").value, type(None))
