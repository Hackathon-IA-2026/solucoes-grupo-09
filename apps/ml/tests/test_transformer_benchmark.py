"""The TFT benchmark — run once, and structurally unable to be promoted.

Forecaster ticket 20. Four properties carry the file:

1. The two arms are scored on **identical rows**, through
   :func:`~wattsteer_ml.evaluation.matrix.assert_identical_test_rows` rather
   than by counting, and both are composed by the one mixture — asserted as the
   breakpoint identity :class:`~wattsteer_ml.evaluation.threshold_sweep.\
MixtureRegime` restates, so a TFT that published its own band instead of
   feeding the inversion is refused rather than believed.
2. Nothing here ranks the arms. No field, property or card key names a winner,
   a preference **or a delta**: the only act this comparison could license is a
   promotion, so a published ``Δ qloss_mwh`` would be the promotion argument
   arriving through the back door.
3. The benchmark's family is outside the gate's allow-list, which is imported
   from the gate rather than respelt. ``tests/test_hot_swap_gate.py`` runs the
   real gate against this module's constant.
4. Today the block is :class:`UnmeasuredTransformerBenchmark`, because neither
   arm can be trained here: there is no TFT implementation in the dependency
   set and no environment with ingested data. That is written to the card.
"""

from __future__ import annotations

import ast
import json
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation.collapse_report import FIXTURE_SOURCE, UNMEASURED_SOURCE
from wattsteer_ml.evaluation.gate import ESTIMATOR_ALLOW_LIST
from wattsteer_ml.evaluation.matrix import RowIdentityError, RowKey
from wattsteer_ml.evaluation.serving_lanes import LATE_LANE, SERVING_LANES
from wattsteer_ml.evaluation.threshold_sweep import MixtureRegime
from wattsteer_ml.evaluation.transformer_benchmark import (
    ARMS,
    BENCHMARK_ARM,
    BENCHMARK_FEATURE_SET,
    BENCHMARK_GATE_PROFILE,
    BENCHMARK_LANE,
    CADENCE,
    EXPLAINABILITY,
    FOLD_EVALUATION_SOURCE,
    NO_TFT_IMPLEMENTATION,
    SERVED_ARM,
    TRANSFORMER_BENCHMARK_BLOCK_KEY,
    ArmRun,
    BenchmarkProvenance,
    TrainingCost,
    TransformerBenchmarkError,
    TransformerBenchmarkReport,
    assert_no_benchmark_promoted,
    benchmark_rows,
    record_transformer_benchmark,
    unmeasured_for_want_of_an_implementation,
)
from wattsteer_ml.evaluation.vintage import FoldSegment
from wattsteer_ml.lanes import Lane
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionLog, PromotionRecord
from wattsteer_ml.promotions import append as append_promotion
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.conformal import ScoredHour
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

HOURS_PER_DAY = 24
FIXTURE_HASH = "sha256:" + "d" * 64
ARTIFACT_ID = "2026-09-05T03:11:07Z"
AT = datetime(2026, 9, 5, 3, 11, 7, tzinfo=UTC)

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
    first: date = date(2025, 4, 1),
    subsystem: Subsystem = "NE",
) -> tuple[ScoredHour, ...]:
    """``(p, observed_mwh)`` per hour, composed through the one mixture.

    Both arms are composed by :func:`~wattsteer_ml.training.hurdle.\
compose_estimates`, which is the ticket's second box made a property of the
    fixture rather than a promise: a TFT arm reaches the block through the same
    inversion the served model does, with its own occurrence head.
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
        threshold_mw=BENCHMARK_LANE.threshold_mw,
    )
    return tuple(
        ScoredHour(key=hour.key, forecast=hour.forecast, observed_mwh=observed)
        for hour, (_, observed) in zip(forecasts, observations, strict=True)
    )


def ramp(days: int = 2, *, shift: float = 0.0) -> list[float]:
    """A ``p`` per hour sweeping the unit interval, optionally nudged."""
    total = days * HOURS_PER_DAY
    return [min(1.0, max(0.0, index / (total - 1) + shift)) for index in range(total)]


def cost(seconds: float = 91.5) -> TrainingCost:
    return TrainingCost(wall_clock_seconds=seconds, peak_rss_mb=1024.0)


def runs(
    magnitudes: Sequence[float],
    *,
    served: Sequence[float] | None = None,
    benchmark: Sequence[float] | None = None,
    costed: bool = True,
) -> dict[str, ArmRun]:
    """One :class:`ArmRun` per arm, over one row set and one set of labels."""
    probabilities = {
        SERVED_ARM: list(ramp() if served is None else served),
        BENCHMARK_ARM: list(ramp(shift=-0.05) if benchmark is None else benchmark),
    }
    return {
        arm: ArmRun(
            hours=scored(list(zip(probabilities[arm], magnitudes, strict=True))),
            cost=cost() if costed else None,
        )
        for arm in ARMS
    }


def report(
    magnitudes: Sequence[float] | None = None,
    *,
    fold: FoldSegment | None = None,
    provenance: BenchmarkProvenance | None = None,
    costed: bool = True,
) -> TransformerBenchmarkReport:
    where = fold or segment()
    return TransformerBenchmarkReport(
        provenance=provenance or BenchmarkProvenance.fixture(),
        rows=benchmark_rows(
            runs(list(magnitudes or ramp()), costed=costed), segment=where
        ),
    )


# --- the two arms are one comparison ------------------------------------------


def test_the_two_arms_are_scored_on_identical_rows() -> None:
    built = report()
    digests = {row.scored.row_digest for row in built.rows}
    counts = {row.scored.row_count for row in built.rows}
    assert len(digests) == 1
    assert counts == {2 * HOURS_PER_DAY}
    assert sorted(row.arm for row in built.rows) == sorted(ARMS)


def test_an_arm_scored_on_a_different_row_set_is_refused() -> None:
    """By digest, not by count: two arms can hold the same number of rows."""
    pair = runs(ramp())
    pair[BENCHMARK_ARM] = ArmRun(
        hours=scored(list(zip(ramp(), ramp(), strict=True)), first=date(2025, 5, 1)),
        cost=cost(),
    )
    with pytest.raises(RowIdentityError):
        benchmark_rows(pair, segment=segment())


def test_a_benchmark_with_one_arm_is_not_a_comparison() -> None:
    pair = runs(ramp())
    del pair[BENCHMARK_ARM]
    with pytest.raises(TransformerBenchmarkError, match="lightgbm"):
        benchmark_rows(pair, segment=segment())


def test_a_third_arm_is_refused() -> None:
    pair = runs(ramp())
    pair["patchtst"] = pair[BENCHMARK_ARM]
    with pytest.raises(TransformerBenchmarkError, match="patchtst"):
        benchmark_rows(pair, segment=segment())


def test_an_arm_at_another_threshold_is_refused() -> None:
    """The lane's threshold is stamped on every magnitude and checked."""
    hours = compose_estimates(
        [
            RowKey(target_date=date(2025, 4, 1), local_hour=hour, subsystem="NE")
            for hour in range(HOURS_PER_DAY)
        ],
        [
            HourEstimates(
                occurrence_probability=0.5,
                q10=20.0,
                q50=40.0,
                q90=80.0,
                positive_mean_mwh=45.0,
            )
            for _ in range(HOURS_PER_DAY)
        ],
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=10.0,
    )
    pair = runs(ramp(days=1), served=ramp(days=1), benchmark=ramp(days=1))
    pair[BENCHMARK_ARM] = ArmRun(
        hours=tuple(
            ScoredHour(key=one.key, forecast=one.forecast, observed_mwh=0.0)
            for one in hours
        ),
        cost=cost(),
    )
    with pytest.raises(TransformerBenchmarkError, match=r"10\.0"):
        benchmark_rows(pair, segment=segment(days=1))


# --- the mixture, restated and checked ----------------------------------------


def test_the_benchmark_arm_goes_through_the_same_mixture_inversion() -> None:
    """Box 2, as an identity rather than a promise.

    ``share_p50_zero`` counts the composed P50s that are zero;
    :class:`MixtureRegime` recomputes the same share from ``p`` alone, using the
    composition's own ``q <= 1 - p``. A band built by anything other than
    :func:`~wattsteer_ml.mixture.compose` breaks the equality.
    """
    figures = report().rows[1].figures
    assert figures.arm == BENCHMARK_ARM
    assert figures.share_p50_zero == figures.regime.share_p50_forced_zero
    assert isinstance(figures.regime, MixtureRegime)


def test_coverage_carries_the_population_it_was_measured_over() -> None:
    figures = report().rows[0].figures
    assert figures.regime.curtailed_hours >= 0
    entry = figures.as_card_entry()
    assert entry["mixture_regime"]["curtailed_hours"] == figures.regime.curtailed_hours


# --- the two columns the ticket asks for --------------------------------------


def test_training_time_and_explainability_are_recorded_beside_the_metrics() -> None:
    """Box 3. Both columns, per arm, in the arm's own card entry."""
    for entry in (row.figures.as_card_entry() for row in report().rows):
        assert entry["training_cost"]["wall_clock_seconds"] == 91.5
        assert entry["explainability"] == EXPLAINABILITY[entry["arm"]]
        assert entry["explainability"].strip() != ""


def test_a_measured_benchmark_that_did_not_time_its_training_is_refused() -> None:
    """An untimed run cannot be published as the measurement the ticket wants."""
    with pytest.raises(TransformerBenchmarkError, match="training time"):
        report(provenance=BenchmarkProvenance.measured(at=AT), costed=False)


def test_a_fixture_benchmark_may_carry_no_cost_because_it_measured_nothing() -> None:
    entry = report(costed=False).rows[0].figures.as_card_entry()
    assert entry["training_cost"] is None


def test_a_negative_training_time_is_not_a_measurement() -> None:
    with pytest.raises(TransformerBenchmarkError):
        TrainingCost(wall_clock_seconds=-1.0, peak_rss_mb=None)


def test_the_explainability_column_is_published_for_both_arms() -> None:
    assert set(EXPLAINABILITY) == set(ARMS)
    assert "SHAP" in EXPLAINABILITY[SERVED_ARM]
    assert "attention" in EXPLAINABILITY[BENCHMARK_ARM].lower()


# --- published rather than acted on -------------------------------------------


def test_the_benchmark_names_no_winner_and_publishes_no_delta() -> None:
    """Asserted over the API surface and the card, not over the source text.

    A benchmark's only possible act is a promotion, so an ``ordering``, a
    ``best`` — or a ``delta``, which is the shape a promotion argument takes —
    would turn this block from evidence into a candidate's case.
    """
    built = report()
    names = set(dir(built)) | set(dir(built.rows[0])) | set(dir(built.rows[0].figures))
    names |= _keys(built.card_block())
    for forbidden in (
        "best",
        "winner",
        "rank",
        "recommend",
        "select",
        "prefer",
        "delta",
        "improve",
    ):
        offenders = sorted(name for name in names if forbidden in name.lower())
        assert offenders == [], offenders


def _keys(value: object) -> set[str]:
    """Every key in a nested card block, so a ranking cannot hide one level in."""
    if isinstance(value, dict):
        return set(value) | {key for entry in value.values() for key in _keys(entry)}
    if isinstance(value, list):
        return {key for entry in value for key in _keys(entry)}
    return set()


def test_the_benchmark_family_is_outside_the_gates_allow_list() -> None:
    """The allow-list is the gate's, imported rather than restated."""
    assert BENCHMARK_ARM not in ESTIMATOR_ALLOW_LIST
    assert SERVED_ARM in ESTIMATOR_ALLOW_LIST


def test_the_benchmark_runs_in_the_served_lane_which_is_why_the_family_is_the_bar() -> (
    None
):
    """Unlike the threshold sweep, this experiment has no lane of its own.

    ``(dessem_free_v1, gate_late, 5 MW)`` *is* the evening view's triple, so the
    sweep's "each arm gets a lane nobody serves" bar cannot be borrowed here and
    the estimator allow-list is the whole of the enforcement.
    """
    assert BENCHMARK_LANE is LATE_LANE
    assert BENCHMARK_LANE in SERVING_LANES
    assert LATE_LANE.feature_set == BENCHMARK_FEATURE_SET
    assert LATE_LANE.gate_profile == BENCHMARK_GATE_PROFILE


def test_nothing_here_can_reach_the_promotion_log() -> None:
    """No writer is in this module's namespace, in either spelling."""
    from wattsteer_ml.evaluation import transformer_benchmark as module

    assert "append" not in vars(module)
    assert "record_decision" not in vars(module)
    tree = ast.parse(Path(module.__file__ or "").read_text(encoding="utf-8"))
    imported = {
        f"{node.module}.{alias.name}"
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    }
    assert "wattsteer_ml.promotions.append" not in imported
    assert "wattsteer_ml.evaluation.gate.record_decision" not in imported
    assert [name for name in imported if name.endswith(".append")] == []


def test_a_promoted_artifact_off_the_allow_list_is_refused(tmp_path: Path) -> None:
    """The volume-level half, over the log and the cards it names."""
    _card(tmp_path, family=BENCHMARK_ARM)
    _promote(tmp_path)
    with pytest.raises(TransformerBenchmarkError, match=BENCHMARK_ARM):
        assert_no_benchmark_promoted(
            PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME), root=tmp_path
        )


def test_a_promoted_lightgbm_artifact_is_fine(tmp_path: Path) -> None:
    _card(tmp_path, family=SERVED_ARM)
    _promote(tmp_path)
    assert_no_benchmark_promoted(
        PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME), root=tmp_path
    )


def test_a_refused_benchmark_artifact_is_evidence_and_stays(tmp_path: Path) -> None:
    _card(tmp_path, family=BENCHMARK_ARM)
    _promote(tmp_path, decision="refuse")
    assert_no_benchmark_promoted(
        PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME), root=tmp_path
    )


def test_a_promotion_whose_card_is_missing_cannot_be_cleared(tmp_path: Path) -> None:
    """Unverifiable is not the same as fine, and is not reported as fine."""
    _promote(tmp_path)
    with pytest.raises(TransformerBenchmarkError, match="cannot be read"):
        assert_no_benchmark_promoted(
            PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME), root=tmp_path
        )


def test_recording_the_benchmark_writes_a_card_and_no_promotion(tmp_path: Path) -> None:
    _card(tmp_path, family=SERVED_ARM)
    path = record_transformer_benchmark(report(), root=tmp_path, artifact_id=ARTIFACT_ID)
    card = json.loads(path.read_text(encoding="utf-8"))
    assert TRANSFORMER_BENCHMARK_BLOCK_KEY in card
    assert card["identity"]["estimator_family"] == SERVED_ARM
    assert not (tmp_path / PROMOTION_LOG_FILENAME).exists()


def test_a_card_outside_the_benchmark_lane_is_refused(tmp_path: Path) -> None:
    with pytest.raises(TransformerBenchmarkError):
        record_transformer_benchmark(
            report(),
            root=tmp_path,
            artifact_id=ARTIFACT_ID,
            lane=Lane(
                feature_set="dessem_free_v1",
                gate_profile="gate_early",
                threshold_mw=5.0,
            ),
        )


def test_the_block_is_not_attached_to_an_artifact_off_the_allow_list(
    tmp_path: Path,
) -> None:
    _card(tmp_path, family=BENCHMARK_ARM)
    with pytest.raises(TransformerBenchmarkError, match="allow-list"):
        record_transformer_benchmark(report(), root=tmp_path, artifact_id=ARTIFACT_ID)


# --- provenance ---------------------------------------------------------------


def test_a_fixture_benchmark_says_it_is_not_evidence() -> None:
    block = report().card_block()[TRANSFORMER_BENCHMARK_BLOCK_KEY]
    assert block["measured"] is False
    assert block["benchmark_source"] == FIXTURE_SOURCE
    assert "NOT" in block["reads"]


def test_a_measured_benchmark_says_what_produced_it() -> None:
    stamped = BenchmarkProvenance.measured(at=AT)
    assert stamped.is_measurement
    assert stamped.benchmark_source == FOLD_EVALUATION_SOURCE
    block = report(provenance=stamped).card_block()[TRANSFORMER_BENCHMARK_BLOCK_KEY]
    assert block["measured"] is True
    assert block["at"] == AT.isoformat()


def test_the_source_cannot_be_set_by_a_caller_that_ran_nothing() -> None:
    assert BenchmarkProvenance.fixture().benchmark_source == FIXTURE_SOURCE
    assert not BenchmarkProvenance.fixture().is_measurement


# --- the run that cannot happen here ------------------------------------------


def test_an_unmeasured_benchmark_carries_a_reason_and_no_figure() -> None:
    """A missing block and 'there is no TFT here' look alike to a grep."""
    block = unmeasured_for_want_of_an_implementation(at=AT).card_block()[
        TRANSFORMER_BENCHMARK_BLOCK_KEY
    ]
    assert block["measured"] is False
    assert block["benchmark_source"] == UNMEASURED_SOURCE
    assert "folds" not in block
    assert block["reason"] == NO_TFT_IMPLEMENTATION
    assert block["cadence"] == CADENCE
    assert block["benchmark_estimator_family"] == BENCHMARK_ARM
    assert block["allow_list"] == sorted(ESTIMATOR_ALLOW_LIST)


def test_the_named_reason_states_both_blockers() -> None:
    """One sentence on every card, rather than a caller's phrasing."""
    assert "no TFT implementation" in NO_TFT_IMPLEMENTATION
    assert "ingested" in NO_TFT_IMPLEMENTATION


def test_an_unmeasured_benchmark_is_written_to_the_card(tmp_path: Path) -> None:
    _card(tmp_path, family=SERVED_ARM)
    path = record_transformer_benchmark(
        unmeasured_for_want_of_an_implementation(at=AT),
        root=tmp_path,
        artifact_id=ARTIFACT_ID,
    )
    card = json.loads(path.read_text(encoding="utf-8"))
    assert card[TRANSFORMER_BENCHMARK_BLOCK_KEY]["measured"] is False


def test_an_unmeasured_benchmark_has_no_field_that_reads_as_a_figure() -> None:
    absent = unmeasured_for_want_of_an_implementation(at=AT)
    names = set(dir(absent)) | _keys(absent.card_block())
    for forbidden in ("qloss", "coverage", "pr_auc", "prevalence", "training_cost"):
        assert [name for name in names if forbidden in name.lower()] == []


# --- once, offline ------------------------------------------------------------


def test_the_weekly_retrain_cannot_reach_this_module() -> None:
    """Box 5, as an import-graph property rather than a convention.

    The retrain driver is :mod:`~wattsteer_ml.evaluation.serving_lanes` and the
    thing it calls per lane is the gate. Neither reaches this module, so a
    future import fails here rather than quietly adding a transformer training
    to a weekly job — and, more to the point, rather than putting a TFT on the
    path that ends in a promotion line.
    """
    root = Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml"
    for module in ("evaluation/serving_lanes.py", "evaluation/gate.py", "retrain.py"):
        source = (root / module).read_text(encoding="utf-8")
        code = "\n".join(
            line for line in source.splitlines() if not line.lstrip().startswith("#")
        )
        assert "import transformer_benchmark" not in code, module
        assert "transformer_benchmark import" not in code, module


def test_the_block_names_its_cadence_and_the_calendar_it_ran_against() -> None:
    block = report().card_block()[TRANSFORMER_BENCHMARK_BLOCK_KEY]
    assert block["cadence"] == CADENCE
    assert block["folds"][0]["fold_hash"] == FIXTURE_HASH


def _card(root: Path, *, family: str) -> Path:
    directory = root / BENCHMARK_LANE.directory_name
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{ARTIFACT_ID}{CARD_SUFFIX}"
    path.write_text(
        json.dumps(
            {"identity": {"artifact_id": ARTIFACT_ID, "estimator_family": family}}
        ),
        encoding="utf-8",
    )
    return path


def _promote(root: Path, *, decision: str = "promote") -> None:
    append_promotion(
        root / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=ARTIFACT_ID,
            lane=BENCHMARK_LANE,
            decision="promote" if decision == "promote" else "refuse",
            reason="a benchmark promoted by hand",
            at=AT,
        ),
    )
