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

import ast
import inspect
import json
import math
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from statistics import NormalDist
from typing import Any

import numpy as np
import pytest

from conftest import FUNCTION_DEFINITION
from ladder_fixtures import rows_with_same_hour_features, without_exceedance
from wattsteer_ml.artifacts import ARTIFACT_SUFFIX, CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import Fold, FoldBlocks, FoldSegment, RowKey, stamp_fidelity
from wattsteer_ml.evaluation import gate as gate_module
from wattsteer_ml.evaluation.gate import (
    BAND_COVERAGE_RAIL,
    BAND_MEDIAN_RAIL,
    BOOTSTRAP_DRAWS,
    CALIBRATION_EXCESS_RAIL,
    CROSSING_RATE_CEILING,
    ECE_CEILING,
    MINIMUM_TEST_DAYS,
    NULL_RATE_DRIFT_CEILING,
    P50_UNBIASEDNESS_WINDOW,
    PROMOTION_COVERAGE_FLOOR,
    PROMOTION_COVERAGE_WINDOW,
    PROMOTION_PROBABILITY,
    Comparator,
    ContractDriftError,
    GateCandidate,
    GateDecision,
    GateError,
    GateInputError,
    Guardrail,
    NoCandidate,
    P50BandUnbiasedness,
    ServingSmoke,
    cold_start_baseline,
    decide,
    guardrails,
    hour_loss,
    minimum_band_coverage_rows,
    minimum_band_median_rows,
    null_rates,
    p10_band_coverage,
    p50_band_unbiasedness,
    paired_block_bootstrap,
    record_decision,
    rollback,
    run_gate,
    serving_smoke,
    states_a_falsifiable_floor,
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
from wattsteer_ml.training import conformal as conformal_module
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
from wattsteer_ml.training.conformal import (
    COVERAGE_GUARDRAIL,
    NINETY_PERCENT_BAND,
    NOMINAL_MISCOVERAGE,
    NOT_A_NINETY_PERCENT_BAND,
    TARGET_COVERAGE,
    CoverageReport,
    ScoredHour,
)
from wattsteer_ml.training.contract import SUBSYSTEM_COLUMN
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

THRESHOLD_MW = 5.0
LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
OTHER_LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_early", threshold_mw=5)

#: The deciding fold's first test day, and enough of them to clear check 4.
FIRST = date(2026, 4, 1)
TEST_DAYS = MINIMUM_TEST_DAYS

#: Local hours per day per subsystem. The gate resamples *days*, so the number
#: of hours inside one is a cost, not a property under test — which is why it
#: was two, and why raising it is not a change of what any test means.
#:
#: Three, because the corrected median rail needs a denominator to be a
#: statement. `minimum_band_median_rows()` is 271, and at two hours this fixture
#: offered 240 qualifying rows — so every gate test would have read "the sample
#: is too small", which is the rail working and no test asserting anything. At
#: three it offers 360. Production is not close to this edge: one real deciding
#: fold carried 3,201 curtailed hours, ~82% of them with a P50 off the atom, so
#: ~2,600 qualifying against a floor of 271.
HOURS_PER_DAY = 3

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


#: One curtailed hour in ten is given a band the label falls *under*, by
#: lifting all three knots this far above it. Forecaster 34: the lower coverage
#: rail is now counted over the rows whose P10 could be missed, so a fixture
#: whose P10 is never missed reads 1.0000 and is refused — correctly, and for a
#: reason that has nothing to do with what most of these tests are about. The
#: bump moves the whole band rather than the P10 alone, so the composed knots do
#: not cross, and it is applied to candidate and comparator alike, so it cannot
#: make one of them better than the other.
# One curtailed hour in **twenty**, because the fixture declares `p = 0.95` and
# a band that misses its floor more often than `1 − p` is mis-calibrated against
# its own law. At one in ten the fixture cleared its floor 90% of the time while
# claiming 95%, which `p10_calibration_excess` reads as −0.0500 ± 0.0175 and
# refuses — correctly, and for a defect the fixture had before that rail existed
# and nothing was measuring. Twenty makes the clearance rate equal the declared
# probability, which is what a correctly calibrated band means.
#
# `coverage_p10_in_band` is unaffected: 0.95 sits inside its [0.85, 0.97] window
# exactly as 0.90 did.
NOMINAL_LOWER_MISS = 20
MISS_BUMP_MWH = 2.0

#: The band is centred *on* the label, so `observed < p50` is false on every
#: unbumped row and the fixture's median read 0.1000 — refused by the corrected
#: median rail for saying something true about a fixture and nothing about the
#: gate. This nudges the centre above and below the label by turns, so the label
#: falls under the median on exactly half the curtailed hours.
#:
#: Small enough not to disturb the coverage rail: at ±0.25 the P10 is still
#: `label − 0.75` or `label − 1.25`, under the label either way, so the 1-in-10
#: miss rate is untouched. And the bump rides on the *even* rows, which are the
#: raised ones, so a bumped row is already counted and the share is 0.5 rather
#: than 0.55. Applied to candidate and comparator alike, so it cannot make one
#: better than the other.
MEDIAN_JITTER_MWH = 0.25


def scored(
    row_keys: Sequence[RowKey],
    *,
    offset_mwh: float,
    probability: float = 0.95,
    missed_in: int = NOMINAL_LOWER_MISS,
) -> tuple[ScoredHour, ...]:
    """Composed hours whose knots sit ``offset_mwh`` away from the label.

    ``offset_mwh = 0`` is a model that is right on every hour but one in
    ``missed_in`` of the curtailed ones — see :data:`NOMINAL_LOWER_MISS` — and a
    larger offset is a strictly worse model **on every day**, which is what the
    "strictly better on every test day" box needs to be able to arrange.
    ``missed_in = 0`` misses none of them, which is the fixture the corrected
    coverage rail must refuse.
    """
    labels = observations(row_keys)
    estimates: list[HourEstimates] = []
    curtailed = 0
    for label in labels:
        bump = 0.0
        jitter = 0.0
        if label > 0.0:
            if missed_in and curtailed % missed_in == 0:
                bump = MISS_BUMP_MWH
            jitter = MEDIAN_JITTER_MWH if curtailed % 2 == 0 else -MEDIAN_JITTER_MWH
            curtailed += 1
        centre = max(0.0, label + offset_mwh + bump + jitter)
        estimates.append(
            HourEstimates(
                occurrence_probability=probability,
                q10=max(0.0, centre - 1.0),
                q50=centre,
                q90=centre + 1.0,
                positive_mean_mwh=centre,
            )
        )
    composed = compose_estimates(
        row_keys,
        estimates,
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
    coverage_p10_where_stated: float | None = None,
) -> CoverageReport:
    """A report whose two lower figures agree unless a caller separates them.

    ``coverage_p10_where_stated`` defaults to the marginal, which keeps every
    fixture written before forecaster 47 saying what it said. On real folds the
    two differ — the marginal is the conditional blended with rows covered by
    arithmetic and is necessarily higher — and the tests that turn on that
    difference pass both.
    """
    return CoverageReport(
        fold_id=DECIDING.row_id,
        rows=480,
        coverage_p10=coverage_p10,
        coverage_p90=coverage_p90,
        upper_correction_realised=0.8,
        lower_stated_rows=480,
        upper_stated_rows=384,
        coverage_p10_where_stated=(
            coverage_p10
            if coverage_p10_where_stated is None
            else coverage_p10_where_stated
        ),
        coverage_p90_where_stated=coverage_p90,
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
) -> GateDecision:
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
            {"coverage": coverage_report(coverage_p90=0.99)},
            "coverage_p90",
            id="coverage_p90",
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

    **Two rails are absent from this list and neither is an oversight.** Both
    band rails read the scored *hours*, not the :class:`MetricsRow`, so there is
    no ``kwargs`` that can move them and a case here could only fake one. Each
    has a dedicated test below that drives it through the population it counts:
    :func:`test_the_rail_counts_only_the_rows_whose_floor_could_have_been_missed`
    and :func:`test_the_median_rail_counts_only_the_rows_that_could_fall_below`.
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
    rails = guardrails(metrics_row(), metrics_row(), hours=scored(keys(), offset_mwh=0.0))
    assert all(rail.passed for rail in rails)
    assert all(rail.bound for rail in rails)
    assert {rail.name for rail in rails} == {
        "pr_auc[pooled]",
        *(f"pr_auc[{code}]" for code in SUBSYSTEM_CODES),
        "recall@0.5[pooled]",
        BAND_COVERAGE_RAIL,
        CALIBRATION_EXCESS_RAIL,
        BAND_MEDIAN_RAIL,
        "coverage_p90",
        "ece",
        "crossing_rate",
    }


def test_the_crossing_rate_veto_reads_the_settled_hour_figure() -> None:
    """Forecaster 29's fourth box: the veto is over every settled hour.

    The two figures are separated in both directions, because "it reads the right
    one" is only demonstrated by a candidate the wrong one would have judged
    differently:

    - a row whose **settled-hour** rate is over the ceiling while its
      ``CoverageReport``'s curtailed-subset rate is 0.0 — vetoed;
    - the mirror, a settled-hour rate of 0.0 beside a curtailed-subset rate of
      0.5, fifty times the ceiling — **not** vetoed, because the gate is not
      reading that number and must not start.

    So the published-figure fix in ``as_card_entry`` and the promotion decision
    stay independent: the gate reads
    :attr:`~wattsteer_ml.evaluation.metrics.MetricsRow.crossing_rate`, the
    attribute, never a card field.
    """
    over_the_ceiling = metrics_row(
        crossing_rate=CROSSING_RATE_CEILING + 0.01,
        coverage=coverage_report(crossing_rate=0.0),
    )
    rails = {
        rail.name: rail
        for rail in guardrails(
            over_the_ceiling, metrics_row(), hours=scored(keys(), offset_mwh=0.0)
        )
    }
    assert rails["crossing_rate"].vetoes
    assert rails["crossing_rate"].value == CROSSING_RATE_CEILING + 0.01

    only_the_curtailed_subset = metrics_row(
        crossing_rate=0.0, coverage=coverage_report(crossing_rate=0.5)
    )
    mirrored = {
        rail.name: rail
        for rail in guardrails(
            only_the_curtailed_subset, metrics_row(), hours=scored(keys(), offset_mwh=0.0)
        )
    }
    assert not mirrored["crossing_rate"].vetoes
    assert mirrored["crossing_rate"].value == 0.0
    assert not any(rail.vetoes for rail in mirrored.values())


def test_an_unmeasurable_guardrail_vetoes() -> None:
    """A veto that passed on absent evidence would be a constant choosing a swap."""
    rails = {
        rail.name: rail
        for rail in guardrails(
            metrics_row(ece=None, no_coverage=True),
            metrics_row(),
            hours=(),
        )
    }
    assert not rails["ece"].passed
    assert not rails[BAND_COVERAGE_RAIL].passed
    assert rails[BAND_COVERAGE_RAIL].value is None
    # The median rail's twin: no hours means no denominator, and an absent
    # statement vetoes rather than passing.
    assert not rails[BAND_MEDIAN_RAIL].passed
    assert rails[BAND_MEDIAN_RAIL].value is None
    assert rails["ece"].value is None


# --- forecaster 34: the lower coverage rail counts the rows it can speak for --


def test_the_minimum_sample_is_derived_from_the_window_it_is_judged_against() -> None:
    """98, and every number behind it is one this repository already published.

    The rule is that the statement's sampling interval must fit inside the
    distance from its target to the nearer bound — otherwise the rail fires on
    noise, which is the reading forecaster 33 measured on ``p50_unbiasedness``
    and the one this rail must not re-import. Recomputed here from the
    constants rather than asserted as a literal, so moving the guardrail moves
    the sample size with it instead of silently under-powering the rail.
    """
    assert minimum_band_coverage_rows() == 98
    low, high = COVERAGE_GUARDRAIL
    margin = min(TARGET_COVERAGE - low, high - TARGET_COVERAGE)
    z = NormalDist().inv_cdf(1.0 - NOMINAL_MISCOVERAGE / 2.0)
    assert margin == pytest.approx(0.05)
    assert minimum_band_coverage_rows() == math.ceil(
        z**2 * TARGET_COVERAGE * (1 - TARGET_COVERAGE) / margin**2
    )
    # A wider window needs fewer rows to resolve and a narrower one more; the
    # rule is the relationship, not the number. It is the *nearer* edge that
    # binds, so raising the ceiling alone — the change this ticket exists to
    # refuse — moves nothing here either.
    assert minimum_band_coverage_rows(guardrail=(0.80, 0.99)) == 31
    assert minimum_band_coverage_rows(guardrail=(0.88, 0.92)) > 98
    assert minimum_band_coverage_rows(guardrail=(0.85, 0.99)) == 98


def test_the_rail_counts_only_the_rows_whose_floor_could_have_been_missed() -> None:
    """Three populations, one denominator, and it is the smallest of them.

    The fold is built so all three are present at once: hours at ``p = 0.5``,
    where the served P10 is the point mass at zero and a scored hour clears it
    for free; hours whose magnitude booster undershoots ``τ``, where the
    composed P10 is clamped onto the floor and the same thing happens for a
    second reason; and hours with a real positive floor, which are the only ones
    that can be missed.
    """
    row_keys = keys(days=30)
    labels = observations(row_keys)
    estimates = []
    with_a_real_floor = 0
    for index, label in enumerate(labels):
        if index % 6 == 0:  # the point mass: p ≤ 0.90, so Q_Y(0.10) = 0
            estimates.append(
                HourEstimates(
                    occurrence_probability=0.5,
                    q10=label,
                    q50=label,
                    q90=label + 1.0,
                    positive_mean_mwh=label,
                )
            )
        elif index % 6 == 2:  # the τ floor: the positive branch clamped onto it
            estimates.append(
                HourEstimates(
                    occurrence_probability=0.99,
                    q10=0.0,
                    q50=0.0,
                    q90=1.0,
                    positive_mean_mwh=0.0,
                )
            )
        else:
            # One in four of the rows that *can* be missed is, so the corrected
            # figure has somewhere to go that the marginal does not.
            bump = MISS_BUMP_MWH if label and with_a_real_floor % 4 == 0 else 0.0
            if label:
                with_a_real_floor += 1
            centre = label + bump
            estimates.append(
                HourEstimates(
                    occurrence_probability=0.99,
                    q10=max(0.0, centre - 1.0),
                    q50=centre,
                    q90=centre + 1.0,
                    positive_mean_mwh=centre,
                )
            )
    composed = compose_estimates(
        row_keys, estimates, sub_threshold_means=FLAT_MU_SUB, threshold_mw=THRESHOLD_MW
    )
    hours = tuple(
        ScoredHour(key=one.key, forecast=one.forecast, observed_mwh=label)
        for one, label in zip(composed, labels, strict=True)
    )
    scored_hours = [hour for hour in hours if hour.is_positive]
    on_the_floor = [
        hour
        for hour in scored_hours
        if 0.0 < hour.forecast.band.p10 <= math.nextafter(THRESHOLD_MW, math.inf)
    ]
    on_the_point_mass = [hour for hour in scored_hours if hour.forecast.band.p10 == 0.0]
    assert on_the_floor and on_the_point_mass, "the fixture must exercise both atoms"
    # Both atoms are covered for free, so the marginal counts them as successes.
    assert all(hour.covered_lower for hour in on_the_floor + on_the_point_mass)

    band = p10_band_coverage(hours)
    assert band.rows == len(scored_hours)
    assert band.qualifying_rows == len(scored_hours) - len(on_the_floor) - len(
        on_the_point_mass
    )
    assert all(
        states_a_falsifiable_floor(hour)
        is (hour.forecast.band.p10 > math.nextafter(THRESHOLD_MW, math.inf))
        for hour in scored_hours
    )
    # And the two figures disagree, which is the whole finding: the marginal is
    # pulled up by rows that could not have failed.
    marginal = CoverageReport.of(hours, fold_id="F6").coverage_p10
    assert band.coverage is not None
    assert band.coverage < marginal


def test_a_rail_that_cannot_be_computed_on_enough_rows_refuses() -> None:
    """Under-powered is a refusal that says so, never a pass.

    Three ways to arrive at one, and all three veto: no hour at all, no hour
    above ``τ``, and a fold whose qualifying rows are real but too few to
    resolve the window. The last is the one that matters — it is the reading
    that would otherwise be green — and its detail says *sample*, not *value*.
    """
    for hours in ((), scored(keys(days=1), offset_mwh=0.0)[1::2]):
        band = p10_band_coverage(hours)
        assert band.coverage is None
        assert not band.passes
        assert band.as_guardrail().vetoes

    short = scored(keys(days=5), offset_mwh=0.0)
    band = p10_band_coverage(short)
    assert 0 < band.qualifying_rows < band.minimum_rows
    # Derived from the miss rate rather than restated: five days is a short
    # sample, so the realised rate is the nearest achievable to 1 − 1/20.
    assert band.coverage == pytest.approx(1 - 1 / NOMINAL_LOWER_MISS, abs=0.05)
    assert not band.sufficient and not band.passes
    assert "too small" in band.detail
    assert f"under the {band.minimum_rows}" in band.detail
    rail = band.as_guardrail()
    assert rail.vetoes and rail.name == BAND_COVERAGE_RAIL
    assert str(band.minimum_rows) in rail.bound

    # The same *fixture* over enough rows passes, so the refusal above is about
    # the sample and nothing else. Not the same number: five days cannot realise
    # a one-in-twenty miss rate exactly, which is itself why it is refused.
    enough = p10_band_coverage(scored(keys(days=30), offset_mwh=0.0))
    assert enough.qualifying_rows >= enough.minimum_rows
    assert enough.coverage == pytest.approx(1 - 1 / NOMINAL_LOWER_MISS)
    assert enough.passes


def test_a_floor_that_is_never_missed_is_refused_and_a_nominal_one_is_not() -> None:
    """The ceiling does its job again, now that the denominator lets it.

    A band whose P10 is under every label reads 1.0000 — over-covering, a floor
    too low to be the one the product promises — and is refused. The same
    fixture missed at its declared rate reads 1 − 1/20 and passes. Under the marginal
    both read inside the window, which is why the gate refused the first
    artifact this repository ever minted and would have promoted a
    shuffled-label fit.
    """
    never_missed = scored(keys(), offset_mwh=0.0, missed_in=0)
    band = p10_band_coverage(never_missed)
    assert band.coverage == 1.0
    assert band.sufficient and not band.passes
    assert not band.as_guardrail().passed

    nominal = p10_band_coverage(scored(keys(), offset_mwh=0.0))
    assert nominal.coverage == pytest.approx(1 - 1 / NOMINAL_LOWER_MISS)
    assert nominal.passes


def test_the_corrected_rail_is_the_only_lower_coverage_veto_and_says_so() -> None:
    """Check 6 carries the new name, and no rail reads the marginal any more.

    The marginal is still published — it is the fold's description and
    ``CoverageReport`` still computes it — but a candidate whose marginal is far
    outside the guardrail no longer vetoes on it, because the number is 56%
    arithmetic on real data.
    """
    row = metrics_row(coverage=coverage_report(coverage_p10=0.80))
    decision = run(candidate(row=row), incumbent())
    assert decision.promotes
    assert [
        rail.name for rail in decision.guardrails if rail.name.startswith("coverage_p10")
    ] == [BAND_COVERAGE_RAIL]

    # A floor that is never missed fails two rails, and both readings are true
    # of it: it over-covers against the window, and it clears its own floor more
    # often than the `p` it declares. The second is `p10_calibration_excess`
    # saying the same defect in the model's own units.
    over_covering = candidate(hours=scored(keys(), offset_mwh=0.0, missed_in=0))
    refused = run(over_covering, incumbent())
    assert not refused.promotes
    assert [rail.name for rail in refused.guardrails if rail.vetoes] == [
        BAND_COVERAGE_RAIL,
        CALIBRATION_EXCESS_RAIL,
    ]
    rail = next(rail for rail in refused.guardrails if rail.name == BAND_COVERAGE_RAIL)
    assert rail.value == 1.0
    assert "could have been missed" in rail.detail
    assert BAND_COVERAGE_RAIL in refused.reason


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


# --- forecaster 41: the median rail counts the rows it can speak for ----------


def test_the_median_minimum_sample_is_derived_from_its_own_window() -> None:
    """271, recomputed from the window rather than asserted as a literal.

    The same rule as the coverage rail's 98 with the median's target and window
    substituted, and the number is larger for the reason a fair coin is harder
    to pin down than a 90% one: ``p(1 − p)`` is maximal at 0.50.
    """
    assert minimum_band_median_rows() == 271
    low, high = P50_UNBIASEDNESS_WINDOW
    margin = min(0.50 - low, high - 0.50)
    z = NormalDist().inv_cdf(1.0 - NOMINAL_MISCOVERAGE / 2.0)
    assert margin == pytest.approx(0.05)
    assert minimum_band_median_rows() == math.ceil(z**2 * 0.25 / margin**2)
    # The relationship, not the number: a wider window resolves on fewer rows.
    assert minimum_band_median_rows(guardrail=(0.40, 0.60)) < 271
    assert minimum_band_median_rows(guardrail=(0.48, 0.52)) > 271
    # It is the *nearer* edge that binds, so widening one side alone moves
    # nothing — which is what stops "just widen the window" from buying power.
    assert minimum_band_median_rows(guardrail=(0.45, 0.65)) == 271


def test_the_median_rail_counts_only_the_rows_that_could_fall_below() -> None:
    """The point mass and the τ floor are both excluded, and for one reason.

    A scored hour has ``y > τ > 0``. Wherever the served P50 is at or below
    ``τ`` the label is above it whatever the fit does, so the row is not
    evidence about whether the P50 is a median. The fold is built with all three
    populations present at once, exactly as forecaster 34's coverage fixture is.

    Longer than forecaster 34's thirty days, and the arithmetic is the reason:
    two of every three curtailed hours here are built onto an atom, so the
    qualifying third has to reach `minimum_band_median_rows()` = 271 before the
    figure is a statement at all. At thirty days it is sixty rows and the rail
    correctly refuses to say anything; at a hundred and fifty it is three
    hundred.
    """
    row_keys = keys(days=150)
    labels = observations(row_keys)
    estimates = []
    with_a_real_median = 0
    below = 0
    for index, label in enumerate(labels):
        if index % 6 == 0:  # the point mass: p ≤ 0.50, so Q_Y(0.50) = 0
            estimates.append(
                HourEstimates(
                    occurrence_probability=0.4,
                    q10=label,
                    q50=label,
                    q90=label + 1.0,
                    positive_mean_mwh=label,
                )
            )
        elif index % 6 == 2:  # the τ floor: the positive branch clamped onto it
            estimates.append(
                HourEstimates(
                    occurrence_probability=0.99,
                    q10=0.0,
                    q50=0.0,
                    q90=1.0,
                    positive_mean_mwh=0.0,
                )
            )
        else:
            # Half of the rows that *can* fall below the median do, so the
            # corrected figure lands where the rail's wording assumes it is.
            lift = MISS_BUMP_MWH if label and with_a_real_median % 2 == 0 else 0.0
            if label:
                with_a_real_median += 1
                below += 1 if lift else 0
            centre = label + lift
            estimates.append(
                HourEstimates(
                    occurrence_probability=0.99,
                    q10=max(0.0, centre - 1.0),
                    q50=centre,
                    q90=centre + 1.0,
                    positive_mean_mwh=centre,
                )
            )
    composed = compose_estimates(
        row_keys, estimates, sub_threshold_means=FLAT_MU_SUB, threshold_mw=THRESHOLD_MW
    )
    hours = tuple(
        ScoredHour(key=hour.key, forecast=hour.forecast, observed_mwh=label)
        for hour, label in zip(composed, labels, strict=True)
    )
    scored_hours = [hour for hour in hours if hour.is_positive]
    band = p50_band_unbiasedness(hours)

    on_an_atom = [
        hour
        for hour in scored_hours
        if hour.forecast.band.p50 <= math.nextafter(THRESHOLD_MW, math.inf)
    ]
    assert on_an_atom, "the fixture must contain the rows being excluded"
    assert band.rows == len(scored_hours)
    assert band.qualifying_rows == len(scored_hours) - len(on_an_atom)

    # The denominator is the correction: the marginal counts the atoms and is
    # dragged below the window by them; the corrected figure is not.
    marginal = sum(1 for hour in scored_hours if hour.below_median) / len(scored_hours)
    assert band.unbiasedness is not None
    assert band.unbiasedness > marginal
    assert band.unbiasedness == pytest.approx(0.5, abs=0.02)
    assert band.passes
    # ...and the marginal, on the very same rows, would have been refused.
    low, high = P50_UNBIASEDNESS_WINDOW
    assert not low <= marginal <= high


def test_an_under_powered_median_is_a_refusal_and_says_the_sample_was_small() -> None:
    """Too few falsifiable rows is not a pass, and the sentence says which."""
    thin = p50_band_unbiasedness(scored(keys(days=MINIMUM_TEST_DAYS), offset_mwh=0.0))
    assert thin.qualifying_rows >= thin.minimum_rows, "the fixture clears the floor"

    starved = P50BandUnbiasedness(
        rows=400,
        qualifying_rows=10,
        minimum_rows=minimum_band_median_rows(),
        unbiasedness=0.50,
    )
    assert not starved.sufficient
    assert not starved.passes, "a perfect figure over ten rows is still a refusal"
    assert "too small" in starved.detail
    assert str(minimum_band_median_rows()) in starved.detail

    # And the empty case: no denominator at all vetoes rather than passing.
    empty = p50_band_unbiasedness(())
    assert empty.unbiasedness is None
    assert not empty.passes
    assert not empty.as_guardrail().passed


# --- forecaster 47: the promotion floor is not the claim window --------------
#
# One constant was doing two jobs: may this artifact serve, and may its band be
# called a 90% band. The owner lowered the first to 0.80 to promote an artifact
# covering 0.8477; the second did not move, and these four tests are what holds
# them apart. Between the two bars an artifact serves *and* the product says its
# band is not a 90% band — which is a state the product could not express while
# one number answered both questions.


def _band_at(missed_in: int) -> tuple[ScoredHour, ...]:
    """Composed hours that miss their floor one curtailed hour in ``missed_in``.

    So :attr:`P10BandCoverage.coverage` comes out at ``1 − 1/missed_in`` exactly
    — 6 puts it between the promotion floor and the claim window, 20 inside the
    claim window, 4 under the floor — and the fixture is the one the rest of
    this file already uses rather than a second one built to land on a number.
    """
    return scored(keys(), offset_mwh=0.0, missed_in=missed_in)


def test_between_the_two_bars_the_floor_is_clear_and_the_band_is_not_a_ninety() -> None:
    """The state the owner's decision exists to make expressible, and its limit.

    The artifact this was lowered for covers 0.8477 where its floor states one.
    The fixture here covers 1 − 1/6 = 0.8333, which is the same place: above
    :data:`PROMOTION_COVERAGE_FLOOR` and below
    :data:`~wattsteer_ml.training.conformal.COVERAGE_GUARDRAIL`'s lower edge. It
    must clear the coverage rail and it must **not** be describable as a 90%
    band, and if those two ever stop being simultaneously true the product is
    either refusing what the owner decided to serve or claiming what it cannot.

    **The marginal is inside the claim window and the claim is still refused**,
    which is the second thing this asserts. ``coverage_p10`` is the conditional
    figure blended with rows covered by arithmetic — ``(1 − s) + s·where_stated``
    — so it reads 0.94 while the floor covers 0.8333, and deriving the claim
    from it would have printed :data:`NINETY_PERCENT_BAND` about this band. That
    was true before forecaster 47 and independently of any floor; it is why
    ``guardrail_satisfied`` now reads the tail where it states a bound.

    **And the limit, which is the finding of forecaster 47 and not its
    decision**: clearing this rail is not the same as promoting. The decision
    below still refuses, on :data:`CALIBRATION_EXCESS_RAIL` — a second statement
    about the same rows, which asks whether the realised clearance differs from
    the model's *own implied* rate and has no constant in it to lower. A row
    qualifies only when its P10 is above ``τ``, which needs ``p > 0.90``, so the
    implied rate over qualifying rows always exceeds 0.90 and a coverage below
    it is an excess below zero by at least the difference. Lowering the coverage
    floor therefore cannot promote a floor that under-covers; it only stops the
    product calling such a band a 90% band. The ticket says so, and this test is
    where it is true rather than argued.
    """
    hours = _band_at(6)
    band = p10_band_coverage(hours)
    assert band.coverage is not None
    assert band.sufficient
    assert PROMOTION_COVERAGE_FLOOR <= band.coverage < COVERAGE_GUARDRAIL[0]

    # Serving, as far as this rail is concerned: it passes and does not veto.
    assert band.passes and not band.as_guardrail().vetoes
    # And not a 90% band: the same figure, the other bar.
    assert not band.states_nominal_band
    assert "promotion window" in band.detail and "NOT a 90% band" in band.detail
    assert f"[{COVERAGE_GUARDRAIL[0]}, {COVERAGE_GUARDRAIL[1]}]" in band.detail

    report = coverage_report(
        coverage_p10=0.94,
        coverage_p10_where_stated=band.coverage,
        coverage_p90=0.92,
    )
    low, high = COVERAGE_GUARDRAIL
    assert low <= report.coverage_p10 <= high, (
        "the marginal must be inside the claim window for this test to mean "
        "anything: it is the number that would have granted the claim"
    )
    assert not report.nominal_claim
    assert not report.guardrail_satisfied
    assert report.claim_note.startswith(NOT_A_NINETY_PERCENT_BAND)
    assert "0.8333" in report.claim_note

    decision = run(
        candidate(hours=hours, row=metrics_row(coverage=report)),
        incumbent(),
    )
    vetoing = {rail.name for rail in decision.guardrails if rail.vetoes}
    assert vetoing == {CALIBRATION_EXCESS_RAIL}, (
        "the coverage floor is the only rail this ticket moved, and the "
        "calibration-excess rail is the reason moving it does not promote an "
        f"under-covering floor on its own: {vetoing}"
    )
    assert not decision.promotes


def test_an_artifact_inside_the_claim_window_promotes_and_keeps_the_claim() -> None:
    """The control for the test above: the gap only exists between the two bars.

    Same fixture at 1 − 1/20 = 0.95, which clears both. Without this the split
    could be a claim that is never granted at all, which would be a different
    product and not a more honest one.
    """
    hours = _band_at(NOMINAL_LOWER_MISS)
    band = p10_band_coverage(hours)
    assert band.coverage is not None
    low, high = COVERAGE_GUARDRAIL
    assert low <= band.coverage <= high
    assert band.passes and band.states_nominal_band
    assert "inside the claim window" in band.detail

    report = coverage_report(
        coverage_p10=0.96,
        coverage_p10_where_stated=band.coverage,
        coverage_p90=0.92,
    )
    decision = run(
        candidate(hours=hours, row=metrics_row(coverage=report)),
        incumbent(),
    )
    assert decision.promotes
    assert report.nominal_claim
    assert report.claim_note == NINETY_PERCENT_BAND


def test_an_artifact_under_the_promotion_floor_still_does_not_promote() -> None:
    """The floor is a floor. Lowering a rail is not removing it.

    1 − 1/4 = 0.75 is under 0.80, the rail vetoes, and the decision refuses —
    and the refusal names the floor rather than the claim window, because the
    floor is what it turned on.
    """
    hours = _band_at(4)
    band = p10_band_coverage(hours)
    assert band.coverage is not None
    assert band.sufficient and band.coverage < PROMOTION_COVERAGE_FLOOR
    assert not band.passes and not band.states_nominal_band
    assert band.as_guardrail().vetoes
    assert "Below the floor an artifact may serve at" in band.detail

    report = coverage_report(
        coverage_p10=0.91,
        coverage_p10_where_stated=band.coverage,
        coverage_p90=0.92,
    )
    decision = run(
        candidate(hours=hours, row=metrics_row(coverage=report)),
        incumbent(),
    )
    assert not decision.promotes
    assert BAND_COVERAGE_RAIL in {
        rail.name for rail in decision.guardrails if rail.vetoes
    }


def test_the_promotion_floor_and_the_claim_window_cannot_be_one_constant() -> None:
    """They are two numbers, in two modules, and the second cannot read the first.

    **Why they are separate**: ``COVERAGE_GUARDRAIL`` decides whether the card
    and the wire may call a band a 90% band; ``PROMOTION_COVERAGE_FLOOR``
    decides whether an artifact may serve. Collapsing them in either direction
    is a product change and not a tidy-up — raising the floor to meet the claim
    un-promotes what the owner decided to serve, and lowering the claim to meet
    the floor makes the product assert a 90% band about one covering 0.8477,
    which is the sentence :data:`NOT_A_NINETY_PERCENT_BAND` exists to prevent.

    The structural half is stronger than the numeric one:
    :mod:`wattsteer_ml.training.conformal` does not import
    :mod:`wattsteer_ml.evaluation.gate` — the dependency runs the other way — so
    ``nominal_claim`` *cannot* read the promotion floor whatever a later edit
    intends. Asserted against the source, because an import is easy to add.
    """
    assert COVERAGE_GUARDRAIL[0] > PROMOTION_COVERAGE_FLOOR, (
        "the promotion floor has met the claim window; if that is deliberate "
        "the two constants have stopped being two decisions"
    )
    assert (PROMOTION_COVERAGE_FLOOR, COVERAGE_GUARDRAIL[1]) == PROMOTION_COVERAGE_WINDOW
    # The ceiling did not move: over-coverage vetoes at the same place it always
    # did, so what was lowered is a floor and not a rail.
    assert PROMOTION_COVERAGE_WINDOW[1] == COVERAGE_GUARDRAIL[1] == 0.97

    # The gap is non-empty, which is what makes "serving and not a 90% band" a
    # reachable state rather than a sentence in a docstring.
    admitted = 0.8477
    assert PROMOTION_COVERAGE_FLOOR <= admitted < COVERAGE_GUARDRAIL[0]

    # Against the import statements and not the file's text, because this
    # module's own prose names the gate repeatedly — the question is whether
    # anything in `conformal` can *read* the floor, not whether it mentions it.
    # `conformal` does import `wattsteer_ml.evaluation` for `RowKey`, and the
    # package deliberately does not re-export the gate: the gate imports
    # `training.conformal`, so the reverse import would be a cycle and the
    # dependency direction is what keeps the claim above the floor.
    tree = ast.parse(inspect.getsource(conformal_module))
    modules = {
        node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
    }
    names = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom | ast.Import)
        for alias in node.names
    }
    assert "wattsteer_ml.evaluation.gate" not in modules, (
        "training.conformal has imported the gate, so the claim window can now "
        "be derived from the promotion floor; the two decisions were kept in "
        f"two modules precisely so that edit has to be visible: {sorted(modules)}"
    )
    assert "PROMOTION_COVERAGE_FLOOR" not in names
    assert "PROMOTION_COVERAGE_WINDOW" not in names

    gate_imports = {
        node.module or ""
        for node in ast.walk(ast.parse(inspect.getsource(gate_module)))
        if isinstance(node, ast.ImportFrom)
    }
    assert "wattsteer_ml.training.conformal" in gate_imports, (
        "the gate no longer imports the claim window, so the dependency that "
        "makes the reverse import a cycle — and the structural half of this "
        "guard — is gone"
    )
