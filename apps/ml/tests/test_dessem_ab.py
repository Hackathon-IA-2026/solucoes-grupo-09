"""The DESSEM A/B, priced in MWh of promised floor. Forecaster ticket 18.

Five properties carry the file, and they are the ticket's five boxes:

1. The three runs are scored on **identical test rows** of one shared calendar,
   asserted by digest through the matrix's own function rather than by count.
2. Which folds may decide is computed from the calendar's 180-day base-fit rule
   and each run's window start. No fold id is written down here, and a calendar
   materialised a quarter later produces a new decision-grade fold on its own.
3. The unit is ``Δ recovered_floor_mwh`` — the simulator's floor, on the
   published reference fleet, on the shipped planning basis — and the fleet is
   stamped on the comparison.
4. The verdict is the **same** paired block bootstrap the hot-swap gate uses:
   the same resampler, the same draws, the same seed, the same bar. And the
   sample size in target days is printed beside it.
5. The block lands on both lanes' cards and holds nothing that could ship
   anything.
"""

from __future__ import annotations

import ast
import json
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from wattsteer_ml.admissibility import WITHHELD_REASONS
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES, SUBSYSTEM_THRESHOLD_MW, Subsystem
from wattsteer_ml.evaluation.dessem_ab import (
    AB_GATE_PROFILE,
    AB_LANES,
    AB_RUNS,
    CADENCE,
    CONTRAST_BY_NAME,
    CONTRASTS,
    DESSEM_CONTRAST,
    DESSEM_DELTA_BLOCK_KEY,
    HISTORY_CONTRAST,
    NOT_RUN_YET,
    DessemAbError,
    DessemDeltaReport,
    DessemProvenance,
    SegmentRow,
    carry_forward,
    record_dessem_delta,
    run_dessem_ab,
    structurally_withheld,
    unmeasured_until_run,
)
from wattsteer_ml.evaluation.folds import materialize_fold_calendar
from wattsteer_ml.evaluation.gate import (
    BOOTSTRAP_DRAWS,
    BOOTSTRAP_SEED,
    PROMOTION_PROBABILITY,
    DayBlock,
    resample_day_blocks,
)
from wattsteer_ml.evaluation.matrix import MATRIX_RUN_BY_NAME, RowIdentityError, RowKey
from wattsteer_ml.evaluation.planning_arms import (
    PUBLISHED_FLEET,
    SHIPPED_BASIS,
    ArmDay,
    score_arm,
)
from wattsteer_ml.evaluation.vintage import FoldSegment, MixedFidelityError
from wattsteer_ml.lanes import Lane
from wattsteer_ml.model_inputs import MODEL_INPUTS
from wattsteer_ml.training.bundle import SubThresholdMeans, write_card
from wattsteer_ml.training.conformal import ScoredHour
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

HOURS_PER_DAY = 24
FIXTURE_HASH = "sha256:" + "d" * 64
TODAY = date(2026, 9, 5)

FLAT_MU_SUB = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(HOURS_PER_DAY)) for _ in SUBSYSTEM_CODES)
)


def segment(
    fold_id: str = "F5",
    *,
    first: date = date(2026, 4, 1),
    days: int = 2,
    fidelity: VintageFidelity = "point_in_time",
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


def hours(
    *,
    probability: float,
    q50: float,
    days: int = 2,
    first: date = date(2026, 4, 1),
    observed: float = 40.0,
    subsystem: Subsystem = "NE",
) -> tuple[ScoredHour, ...]:
    """Whole local days of one subsystem, composed through the one mixture.

    ``probability`` above 0.90 is what puts a non-zero value in the composed
    P10 — ``Q_Y(q) = 0`` for ``q <= 1 - p`` — and therefore what gives the
    optimizer's floor anything to recover.
    """
    keys = [
        RowKey(
            target_date=first + timedelta(days=index // HOURS_PER_DAY),
            local_hour=index % HOURS_PER_DAY,
            subsystem=subsystem,
        )
        for index in range(days * HOURS_PER_DAY)
    ]
    composed = compose_estimates(
        keys,
        [
            HourEstimates(
                occurrence_probability=probability,
                q10=20.0,
                q50=q50,
                q90=q50 * 2.0,
                positive_mean_mwh=q50,
            )
            for _ in keys
        ],
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=SUBSYSTEM_THRESHOLD_MW,
    )
    return tuple(
        ScoredHour(key=hour.key, forecast=hour.forecast, observed_mwh=observed)
        for hour in composed
    )


def arms(
    *,
    full: float = 40.0,
    common: float = 40.0,
    augmented: float = 60.0,
    probability: float = 0.99,
    days: int = 2,
    first: date = date(2026, 4, 1),
) -> dict[str, tuple[ScoredHour, ...]]:
    """One sequence per run, on identical rows, differing only in the band."""
    by_run = {"A-full": full, "A-common": common, "B-common": augmented}
    return {
        name: hours(probability=probability, q50=q50, days=days, first=first)
        for name, q50 in by_run.items()
    }


def report(
    *,
    calendar_as_of: date = TODAY,
    segments: Sequence[FoldSegment] | None = None,
    **kwargs: float,
) -> DessemDeltaReport:
    calendar = materialize_fold_calendar(calendar_as_of)
    rows = segments if segments is not None else (segment(),)
    return DessemDeltaReport.of(
        ((one, arms(first=one.test_start, days=one.test_days, **kwargs)) for one in rows),
        calendar=calendar,
        provenance=DessemProvenance.fixture(),
    )


# --- the three runs, and where they come from -------------------------------


def test_the_three_runs_are_the_matrixs_own() -> None:
    """No run is respelt here: the matrix is the authority on all three."""
    assert [run.name for run in AB_RUNS] == ["A-full", "A-common", "B-common"]
    for run in AB_RUNS:
        assert run is MATRIX_RUN_BY_NAME[run.name]
        assert run.gate_profile == AB_GATE_PROFILE
    assert MATRIX_RUN_BY_NAME["B-common"].feature_set == "dessem_augmented_v1"
    assert (
        MATRIX_RUN_BY_NAME["A-common"].window_start
        == MATRIX_RUN_BY_NAME["B-common"].window_start
    )


def test_the_two_contrasts_are_the_specs_two() -> None:
    """B − A-common prices DESSEM; A-full − A-common prices the history."""
    assert [contrast.name for contrast in CONTRASTS] == [
        DESSEM_CONTRAST,
        HISTORY_CONTRAST,
    ]
    dessem = CONTRAST_BY_NAME[DESSEM_CONTRAST]
    assert (dessem.treatment, dessem.control) == ("B-common", "A-common")
    history = CONTRAST_BY_NAME[HISTORY_CONTRAST]
    assert (history.treatment, history.control) == ("A-full", "A-common")
    assert history.control == dessem.control


def test_both_lanes_are_derived_from_the_runs() -> None:
    """Two feature sets at one gate, at the served threshold. Not a list."""
    assert set(AB_LANES) == {
        Lane(
            feature_set=run.feature_set,
            gate_profile=AB_GATE_PROFILE,
            threshold_mw=SUBSYSTEM_THRESHOLD_MW,
        )
        for run in AB_RUNS
    }
    assert len(AB_LANES) == 2


# --- box 1: identical test rows ---------------------------------------------


def test_arms_scored_on_different_rows_are_refused_by_digest() -> None:
    built = arms()
    moved = list(built["B-common"])
    moved[0] = ScoredHour(
        key=RowKey(
            target_date=date(2026, 4, 3),
            local_hour=0,
            subsystem="NE",
        ),
        forecast=moved[0].forecast,
        observed_mwh=moved[0].observed_mwh,
    )
    built["B-common"] = tuple(moved)
    with pytest.raises(RowIdentityError):
        SegmentRow.of(built, segment=segment(), calendar=materialize_fold_calendar(TODAY))


def test_arms_scored_against_different_labels_are_refused() -> None:
    """The pairing rule the gate applies to two artifacts, applied to three."""
    built = arms()
    first = built["A-common"][0]
    built["A-common"] = (
        ScoredHour(key=first.key, forecast=first.forecast, observed_mwh=999.0),
        *built["A-common"][1:],
    )
    with pytest.raises(Exception) as raised:
        SegmentRow.of(built, segment=segment(), calendar=materialize_fold_calendar(TODAY))
    assert "label" in str(raised.value)


def test_a_partial_matrix_is_refused() -> None:
    built = arms()
    del built["A-common"]
    with pytest.raises(DessemAbError):
        SegmentRow.of(built, segment=segment(), calendar=materialize_fold_calendar(TODAY))


# --- box 2: decision-grade folds, computed rather than listed ---------------


def test_decision_grade_folds_are_the_180_day_rule() -> None:
    calendar = materialize_fold_calendar(TODAY)
    rows = [
        SegmentRow.of(
            arms(first=fold.test_start),
            segment=segment(fold.id, first=fold.test_start),
            calendar=calendar,
        )
        for fold in calendar.folds
    ]
    graded = {row.segment.fold_id: row.decision_grade for row in rows}
    assert graded == {
        "F1": False,
        "F2": False,
        "F3": False,
        "F4": False,
        "F5": True,
        "F6": True,
    }


def test_a_later_calendar_grades_a_new_fold_with_no_code_change() -> None:
    """Re-runnable each quarter: F7 opens and decides on its own arithmetic."""
    later = materialize_fold_calendar(date(2027, 1, 15))
    assert "F7" in [fold.id for fold in later.folds]
    row = SegmentRow.of(
        arms(first=date(2026, 10, 1)),
        segment=segment("F7", first=date(2026, 10, 1)),
        calendar=later,
    )
    assert row.decision_grade
    assert row.base_fit_days["B-common"] >= later.rules.min_base_fit_days


def test_a_non_decision_grade_fold_is_reported_and_excluded() -> None:
    calendar = materialize_fold_calendar(TODAY)
    early = segment("F2", first=date(2025, 7, 1))
    late = segment("F5", first=date(2026, 4, 1))
    built = DessemDeltaReport.of(
        (
            (early, arms(first=early.test_start)),
            (late, arms(first=late.test_start)),
        ),
        calendar=calendar,
        provenance=DessemProvenance.fixture(),
    )
    block = built.card_block()[DESSEM_DELTA_BLOCK_KEY]
    reported = {fold["row_id"] for fold in block["folds"]}
    assert reported == {"F2", "F5"}
    verdict = built.verdict(DESSEM_CONTRAST)
    assert verdict is not None
    assert verdict.decision_grade_rows == ("F5",)


def test_no_decision_grade_fold_yields_no_verdict() -> None:
    calendar = materialize_fold_calendar(TODAY)
    early = segment("F2", first=date(2025, 7, 1))
    built = DessemDeltaReport.of(
        ((early, arms(first=early.test_start)),),
        calendar=calendar,
        provenance=DessemProvenance.fixture(),
    )
    assert built.verdict(DESSEM_CONTRAST) is None
    block = built.card_block()[DESSEM_DELTA_BLOCK_KEY]
    assert block["contrasts"][DESSEM_CONTRAST]["verdict"] is None


# --- box 3: the unit is the simulator's floor, and the fleet is stamped ------


def test_the_floor_is_the_simulators_own_number() -> None:
    """Not recomputed here: ``score_arm`` on the shipped basis, summed."""
    built = report()
    row = built.rows[0]
    scored = arms()["B-common"]
    days, _ = _days_of(scored)
    expected = sum(score_arm(day, SHIPPED_BASIS).recovered_floor_mwh for day in days)
    assert row.floor("B-common").recovered_floor_mwh == pytest.approx(expected)


def _days_of(scored: Sequence[ScoredHour]) -> tuple[tuple[ArmDay, ...], int]:
    from wattsteer_ml.evaluation.planning_arms import days_of

    return days_of(scored, fidelity="point_in_time")


def test_the_delta_is_the_difference_of_two_floors() -> None:
    built = report(augmented=80.0, common=40.0)
    row = built.rows[0]
    assert row.delta(DESSEM_CONTRAST) == pytest.approx(
        row.floor("B-common").recovered_floor_mwh
        - row.floor("A-common").recovered_floor_mwh
    )
    assert row.delta(DESSEM_CONTRAST) > 0.0


def test_a_fold_that_was_not_scored_is_named_on_the_block() -> None:
    """A verdict beside no statement of what was excluded hides a row.

    The first run against an ingested database scored one of three reportable
    folds, because one arm's calibration was refused on the other two. A block
    carrying that fold's verdict alone would read as a sample the *calendar*
    produced. So the refusals travel on the block, keyed by row id and naming
    the arm and its reason, beside ``folds`` rather than folded into it.
    """
    calendar = materialize_fold_calendar(TODAY)
    one = segment()
    built = DessemDeltaReport.of(
        ((one, arms(first=one.test_start, days=one.test_days)),),
        calendar=calendar,
        provenance=DessemProvenance.fixture(),
        not_scored={"F4": {"A-full": "RiskBinsUndeterminedError: no split of this pool"}},
    )

    block = built.card_block()[DESSEM_DELTA_BLOCK_KEY]

    assert [entry["row_id"] for entry in block["folds"]] == [one.row_id]
    assert block["folds_not_scored"] == {
        "F4": {"A-full": "RiskBinsUndeterminedError: no split of this pool"}
    }
    # And the default is empty rather than absent, so a reader who greps the key
    # on a complete run finds it saying nothing was excluded.
    assert report().card_block()[DESSEM_DELTA_BLOCK_KEY]["folds_not_scored"] == {}


def test_the_reference_fleet_is_stamped_on_the_comparison() -> None:
    block = report().card_block()[DESSEM_DELTA_BLOCK_KEY]
    assert block["reference_fleet"]["fleet_hash"] == PUBLISHED_FLEET.fleet_hash
    assert block["planning_basis"] == SHIPPED_BASIS


def test_the_mixture_regime_travels_with_the_floor() -> None:
    """``Q_Y(q) = 0`` for ``q <= 1 - p``, so the P10 is the floor's breakpoint."""
    low = report(probability=0.5).rows[0].floor("B-common")
    high = report(probability=0.99).rows[0].floor("B-common")
    assert low.regime.share_p10_forced_zero == 1.0
    assert high.regime.share_p10_forced_zero == 0.0
    assert low.recovered_floor_mwh == 0.0
    assert high.recovered_floor_mwh > 0.0


def test_floor_coverage_comes_from_the_guardrails_machinery() -> None:
    built = report(augmented=80.0)
    coverage = built.rows[0].floor("B-common").coverage
    assert coverage is not None
    assert [entry.subsystem for entry in coverage.by_subsystem] == ["NE"]
    assert coverage.row_id == "F5"


# --- box 4: the gate's bootstrap, and the sample size beside it -------------


def test_the_verdict_is_the_gates_own_resampler() -> None:
    built = report(augmented=80.0, common=40.0)
    verdict = built.verdict(DESSEM_CONTRAST)
    assert verdict is not None
    bootstrap = verdict.bootstrap
    assert bootstrap.resample.draws == BOOTSTRAP_DRAWS
    assert bootstrap.resample.seed == BOOTSTRAP_SEED
    assert bootstrap.bar == PROMOTION_PROBABILITY
    assert all(isinstance(block, DayBlock) for block in bootstrap.blocks)
    expected = resample_day_blocks(bootstrap.blocks)
    assert bootstrap.probability == expected.left_higher / expected.draws


def test_a_bigger_floor_clears_the_bar_and_a_smaller_one_does_not() -> None:
    better = report(augmented=80.0, common=40.0).verdict(DESSEM_CONTRAST)
    worse = report(augmented=40.0, common=80.0).verdict(DESSEM_CONTRAST)
    assert better is not None and worse is not None
    assert better.evidence_bar_met
    assert not worse.evidence_bar_met
    assert "monitored candidate" in worse.statement


def test_an_identical_arm_never_clears_the_bar() -> None:
    """A tie is never better, and the ties are published so it reads that way."""
    verdict = report(augmented=40.0, common=40.0).verdict(DESSEM_CONTRAST)
    assert verdict is not None
    assert verdict.bootstrap.probability == 0.0
    assert verdict.bootstrap.resample.ties == BOOTSTRAP_DRAWS
    assert not verdict.evidence_bar_met


def test_the_sample_size_in_target_days_is_printed_beside_the_verdict() -> None:
    built = report(
        segments=(
            segment("F5", first=date(2026, 4, 1), days=3),
            segment("F6", first=date(2026, 7, 1), days=4),
        )
    )
    verdict = built.verdict(DESSEM_CONTRAST)
    assert verdict is not None
    assert verdict.target_days == 7
    assert "7 target days" in verdict.statement
    entry = built.card_block()[DESSEM_DELTA_BLOCK_KEY]["contrasts"][DESSEM_CONTRAST]
    assert entry["verdict"]["target_days"] == 7


def test_the_verdict_never_says_ship() -> None:
    """The other half of the ruling is a human's, and has no field here."""
    verdict = report(augmented=80.0).verdict(DESSEM_CONTRAST)
    assert verdict is not None
    entry = verdict.as_card_entry()
    assert "ship" not in entry
    assert not any(key.startswith("ship") for key in entry)
    assert "publication" in verdict.statement


def test_a_verdict_pooled_over_two_vintages_is_refused() -> None:
    calendar = materialize_fold_calendar(TODAY)
    mixed = (
        FoldSegment(
            fold_id="F5",
            row_id="F5@revision_optimistic",
            fidelity="revision_optimistic",
            test_start=date(2026, 4, 1),
            test_end=date(2026, 4, 2),
            is_split=True,
            fold_hash=FIXTURE_HASH,
        ),
        FoldSegment(
            fold_id="F5",
            row_id="F5@point_in_time",
            fidelity="point_in_time",
            test_start=date(2026, 4, 3),
            test_end=date(2026, 4, 4),
            is_split=True,
            fold_hash=FIXTURE_HASH,
        ),
    )
    built = DessemDeltaReport.of(
        ((one, arms(first=one.test_start)) for one in mixed),
        calendar=calendar,
        provenance=DessemProvenance.fixture(),
    )
    with pytest.raises(MixedFidelityError):
        built.verdict(DESSEM_CONTRAST)


# --- box 5: the block, the card, and what it cannot do ----------------------


def test_the_block_lands_on_both_lanes_cards(tmp_path: Path) -> None:
    built = report()
    for lane in AB_LANES:
        directory = tmp_path / lane.directory_name
        directory.mkdir(parents=True)
        write_card(directory / "2026-09-05T03:00:00Z.card.json", {"artifact_id": "x"})
        path = record_dessem_delta(
            built, root=tmp_path, artifact_id="2026-09-05T03:00:00Z", lane=lane
        )
        card = json.loads(path.read_text())
        assert card["artifact_id"] == "x"
        assert DESSEM_DELTA_BLOCK_KEY in card


def test_a_lane_the_ab_did_not_run_is_refused(tmp_path: Path) -> None:
    with pytest.raises(DessemAbError):
        record_dessem_delta(
            report(),
            root=tmp_path,
            artifact_id="x",
            lane=Lane(
                feature_set="dessem_free_v1",
                gate_profile="gate_early",
                threshold_mw=SUBSYSTEM_THRESHOLD_MW,
            ),
        )


def test_the_unmeasured_block_carries_a_reason(tmp_path: Path) -> None:
    """An absent A/B and no block look identical to anybody grepping."""
    absent = unmeasured_until_run(lane=AB_LANES[0], at=datetime(2026, 9, 5, tzinfo=UTC))
    directory = tmp_path / AB_LANES[0].directory_name
    directory.mkdir(parents=True)
    write_card(directory / "x.card.json", {})
    path = record_dessem_delta(absent, root=tmp_path, artifact_id="x", lane=AB_LANES[0])
    block = json.loads(path.read_text())[DESSEM_DELTA_BLOCK_KEY]
    assert block["measured"] is False
    assert block["reason"] == NOT_RUN_YET
    assert "contrasts" not in block
    assert not any("floor" in key for key in block)


def test_a_fixture_block_says_so_in_the_field_a_reader_reaches_first() -> None:
    block = report().card_block()[DESSEM_DELTA_BLOCK_KEY]
    assert block["measured"] is False
    assert "NOT A MEASUREMENT" in block["reads"]
    measured = DessemProvenance.measured(at=datetime(2026, 9, 5, tzinfo=UTC))
    assert measured.is_measurement


def test_the_block_carries_the_cadence_and_the_calendar_it_was_run_against() -> None:
    calendar = materialize_fold_calendar(TODAY)
    block = report().card_block()[DESSEM_DELTA_BLOCK_KEY]
    assert block["cadence"] == CADENCE
    assert block["fold_calendar_rules_hash"] == calendar.rules.rules_hash
    assert block["min_base_fit_days"] == calendar.rules.min_base_fit_days


def test_carry_forward_copies_and_does_not_recompute() -> None:
    block = report().card_block()
    assert carry_forward(block) == block
    assert carry_forward({}) is None


def test_the_structural_census_is_the_databases_own() -> None:
    """The 22 dessem columns, named by ``available_at_gate_early`` and not here."""
    withheld = structurally_withheld()
    free = {item.column_name for item in MODEL_INPUTS.inputs_for("dessem_free_v1")}
    augmented = {
        item.column_name for item in MODEL_INPUTS.inputs_for("dessem_augmented_v1")
    }
    assert {item.column_name for item in withheld} == augmented - free
    assert {item.reason for item in withheld} == {"structural"}
    block = report().card_block()[DESSEM_DELTA_BLOCK_KEY]
    census = block["structural_withholding"]
    assert census["columns"] == sorted(item.column_name for item in withheld)
    assert census["explanation"] == WITHHELD_REASONS["structural"]


def test_nothing_here_can_promote_anything() -> None:
    """No path from this module to the promotion log, as an import property.

    Prose about ``promotions.jsonl`` is the point of the block; an *import* of
    it would be a way to write one, which is why this reads the import graph
    and not the text.
    """
    imported = _imports("evaluation/dessem_ab.py")
    assert "wattsteer_ml.promotions" not in imported
    assert "record_decision" not in _imported_names("evaluation/dessem_ab.py")


def test_the_weekly_retrain_cannot_reach_this_module() -> None:
    """Quarterly, and enforced by the import graph rather than by a convention."""
    for module in ("evaluation/serving_lanes.py", "evaluation/gate.py", "retrain.py"):
        assert "wattsteer_ml.evaluation.dessem_ab" not in _imports(module), module


def _parsed(module: str) -> ast.Module:
    return ast.parse(
        (Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml" / module).read_text(
            encoding="utf-8"
        )
    )


def _imports(module: str) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(_parsed(module)):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
    return found


def _imported_names(module: str) -> set[str]:
    return {
        alias.name
        for node in ast.walk(_parsed(module))
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    }


def test_the_scorer_is_run_once_per_run_per_segment() -> None:
    calendar = materialize_fold_calendar(TODAY)
    seen: list[tuple[str, str]] = []

    def score(run, one) -> Sequence[ScoredHour]:  # type: ignore[no-untyped-def]
        seen.append((run.name, one.row_id))
        return arms(first=one.test_start)[run.name]

    segments = (segment("F5", first=date(2026, 4, 1)),)
    built = run_dessem_ab(
        score,
        segments=segments,
        calendar=calendar,
        provenance=DessemProvenance.fixture(),
    )
    assert sorted(seen) == sorted((run.name, "F5") for run in AB_RUNS)
    assert len(built.rows) == 1


def test_an_empty_segment_list_is_a_caller_mistake() -> None:
    with pytest.raises(DessemAbError):
        run_dessem_ab(
            lambda run, one: (),
            segments=(),
            calendar=materialize_fold_calendar(TODAY),
            provenance=DessemProvenance.fixture(),
        )
