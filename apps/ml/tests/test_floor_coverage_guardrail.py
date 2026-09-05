"""Floor coverage as a veto on the hot swap, and the constant it does not invent.

`docs/specs/replay.md`, "Floor coverage, and the map's open gate item", closes
the map's backtest-gate item as a **comparative** guardrail: a candidate is
refused if its floor coverage on the shared newest fold, computed against the
published ``REFERENCE_FLEET``, is more than five percentage points below the
incumbent's. There is no absolute bar, and this file's job is to show that there
is not one — that every number the guardrail turns on is either measured here or
written in the spec, and that the guardrail can only ever cost a promotion.

**The bands are composed, never invented**, as in ``test_second_planning_arm.py``:
every fixture hour goes through
:func:`~wattsteer_ml.training.hurdle.compose_estimates`, so the zeroes sit where
the mixture puts them rather than where a test author would have. They are still
fabricated, which is why nothing in this file asserts a floor coverage is a fact
about the Brazilian grid — only that two of them compare the way the spec says.

**Why the fixture is shaped as it is.** The incumbent is uncertain
(``p = 0.60``): the composition puts its P10 at exactly zero, so it promises no
floor and meets the one it promised on every day. The candidate is confident
(``p = 0.95``) and therefore promises a real floor — which it clears on a day
that turns out as forecast and misses on a day that comes in short. That is the
whole mechanism the metric exists to catch, and it is also why the candidate is
much better on ``qloss`` while being worse on the floor: the two are different
questions, and a gate that only asked the first would swap into the second.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from wattsteer_ml.constants import REFERENCE_FLEET, SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.evaluation.collapse_report import FIXTURE_SOURCE, UNMEASURED_SOURCE
from wattsteer_ml.evaluation.gate import (
    Comparator,
    GateCandidate,
    GateInputError,
    Guardrail,
    ServingSmoke,
    decide,
)
from wattsteer_ml.evaluation.metrics import (
    MetricsRow,
    MetricsTable,
    OperatingPoint,
    SubsystemOccurrence,
)
from wattsteer_ml.evaluation.planning_arms import PUBLISHED_FLEET
from wattsteer_ml.evaluation.vintage import FoldSegment
from wattsteer_ml.lanes import Lane
from wattsteer_ml.replay.floor_guardrail import (
    FLOOR_COVERAGE_SLACK,
    FOLD_EVALUATION_SOURCE,
    FloorCoverageError,
    FloorCoverageProvenance,
    FloorCoverageVeto,
    compare_floor_coverage,
    floor_coverage,
    floor_coverage_guardrail,
)
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.conformal import CoverageReport, ScoredHour
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

HOURS_PER_DAY = 24
THRESHOLD_MW = 5.0
LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
OTHER_LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_early", threshold_mw=5)
NOW = datetime(2026, 6, 1, 3, 0, tzinfo=UTC)
FIRST = date(2026, 4, 1)
LIVE_HASH = "sha256:" + "1" * 64
FIXTURE_HASH = "sha256:" + "f" * 64
CANDIDATE_ID = "2026-06-01T03:00:00Z"
INCUMBENT_ID = "2026-05-25T03:00:00Z"

#: Twenty days, so that one missed day is exactly five points and two are more
#: than five. The spec's constant is a *strict* "more than", and a fixture whose
#: grid cannot express the boundary would not be able to show that.
DAYS = 20
BUSY_HOURS: tuple[int, ...] = (10, 11, 12, 13, 14, 15)

#: What a day that turns out as forecast delivers in a busy hour.
AS_FORECAST_MWH = 20.0
#: What a day that comes in short delivers instead. Below the forecast, so the
#: confident model's own P10 promise is not met — which is the event
#: ``floor_met`` counts and the only way a coverage can fall.
SHORT_MWH = 18.0

#: ``p`` for a model that promises a floor: above 0.90, so the composition puts
#: a non-zero number in P10.
CONFIDENT_P = 0.95
#: ``p`` for one that does not. Below 0.90 and above 0.50: P10 is exactly zero
#: and P50 is not, so this model plans but promises nothing.
UNCERTAIN_P = 0.60

FLAT_MU_SUB = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(HOURS_PER_DAY)) for _ in SUBSYSTEM_CODES)
)

DECIDING = FoldSegment(
    fold_id="F6",
    row_id="F6",
    fidelity="point_in_time",
    test_start=FIRST,
    test_end=FIRST + timedelta(days=59),
    is_split=False,
    fold_hash=FIXTURE_HASH,
)


# --- builders ----------------------------------------------------------------


def observed_mwh(*, short_days: Sequence[int], day: int, hour: int) -> float:
    """The settled label. Quiet outside the busy block; short on a named day."""
    if hour not in BUSY_HOURS:
        return 0.0
    return SHORT_MWH if day in short_days else AS_FORECAST_MWH


def hours(
    *,
    probability: float,
    forecast_mwh: float = AS_FORECAST_MWH,
    short_days: Sequence[int] = (),
    days: int = DAYS,
    subsystems: Sequence[Subsystem] = ("NE",),
    first: date = FIRST,
    complete: bool = True,
) -> tuple[ScoredHour, ...]:
    """One artifact's composed hours over ``days`` whole subsystem-days.

    The forecast is flat — one magnitude in the busy block, zero elsewhere — so
    the only thing that varies between the two artifacts is ``p``, which is what
    decides whether the composition writes a floor at all.
    """
    keys: list[RowKey] = []
    estimates: list[HourEstimates] = []
    labels: list[float] = []
    for offset in range(days):
        for code in subsystems:
            span = range(HOURS_PER_DAY if complete else HOURS_PER_DAY - 1)
            for hour in span:
                keys.append(
                    RowKey(
                        target_date=first + timedelta(days=offset),
                        local_hour=hour,
                        subsystem=code,
                    )
                )
                magnitude = forecast_mwh if hour in BUSY_HOURS else 0.0
                estimates.append(
                    HourEstimates(
                        occurrence_probability=probability if magnitude else 0.01,
                        q10=magnitude,
                        q50=magnitude,
                        q90=magnitude,
                        positive_mean_mwh=magnitude,
                    )
                )
                labels.append(observed_mwh(short_days=short_days, day=offset, hour=hour))
    composed = compose_estimates(
        keys,
        estimates,
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=THRESHOLD_MW,
    )
    return tuple(
        ScoredHour(key=one.key, forecast=one.forecast, observed_mwh=label)
        for one, label in zip(composed, labels, strict=True)
    )


def confident(**kwargs: Any) -> tuple[ScoredHour, ...]:
    """The candidate: promises a floor, so it can miss one."""
    return hours(probability=CONFIDENT_P, **kwargs)


def uncertain(**kwargs: Any) -> tuple[ScoredHour, ...]:
    """The incumbent: P10 is exactly zero, so it meets its floor every day."""
    return hours(probability=UNCERTAIN_P, forecast_mwh=12.0, **kwargs)


def guardrail(
    *,
    short_days: Sequence[int] = (),
    incumbent_present: bool = True,
    subsystems: Sequence[Subsystem] = ("NE",),
    lane: Lane = LANE,
) -> FloorCoverageVeto:
    return floor_coverage_guardrail(
        candidate_hours=confident(short_days=short_days, subsystems=subsystems),
        incumbent_hours=(
            uncertain(short_days=short_days, subsystems=subsystems)
            if incumbent_present
            else None
        ),
        row_id=DECIDING.row_id,
        fidelity=DECIDING.fidelity,
        lane=lane,
        at=NOW,
    )


def metrics_row(*, qloss: float = 1.0, run: str = "A-full") -> MetricsRow:
    return MetricsRow(
        run=run,
        rung="lightgbm",
        rung_number=4,
        imputed=False,
        calibrated=True,
        conformalised=True,
        segment=DECIDING,
        rows=480,
        prevalence=0.5,
        pr_auc=0.60,
        by_subsystem=tuple(
            SubsystemOccurrence(subsystem=code, rows=120, prevalence=0.5, pr_auc=0.60)
            for code in SUBSYSTEM_CODES
        ),
        brier=0.1,
        ece=0.02,
        mce=0.05,
        top_bin_gap=0.02,
        at_fixed=OperatingPoint(threshold=0.5, precision=0.7, recall=0.70, f1=0.7),
        at_best=OperatingPoint(threshold=0.4, precision=0.7, recall=0.8, f1=0.75),
        mae_positives_mwh=1.0,
        smape_positives=0.1,
        pinball_10=1.0,
        pinball_50=1.0,
        pinball_90=1.0,
        qloss_mwh=qloss,
        interval_width_mean_mwh=2.0,
        crossing_rate=0.0,
        coverage=CoverageReport(
            fold_id=DECIDING.row_id,
            rows=480,
            coverage_p10=0.90,
            coverage_p90=0.92,
            upper_correction_realised=0.8,
            p50_unbiasedness=0.50,
            crossing_rate=0.0,
            by_subsystem=(),
            by_local_hour=(),
        ),
        delta_lo=0.5,
        delta_hi=0.5,
        day_grain=None,
        collapse=None,
    )


def clean_smoke() -> ServingSmoke:
    return ServingSmoke(
        target_date=NOW.date() + timedelta(days=1),
        hours_by_subsystem=dict.fromkeys(SUBSYSTEM_CODES, 24),
        faults=(),
        drifted=(),
    )


def gate_decision(
    *,
    short_days: Sequence[int] = (),
    candidate_hours: Sequence[ScoredHour] | None = None,
    incumbent_hours: Sequence[ScoredHour] | None = None,
    comparator: Comparator | None = None,
    lane: Lane = LANE,
) -> Any:
    """One run of the whole gate, on the fixture above."""
    ours = (
        confident(short_days=short_days) if candidate_hours is None else candidate_hours
    )
    theirs = (
        uncertain(short_days=short_days) if incumbent_hours is None else incumbent_hours
    )
    return decide(
        GateCandidate(
            artifact_id=CANDIDATE_ID,
            lane=lane,
            estimator_family="lightgbm",
            feature_hash=LIVE_HASH,
            newest_training_target_date=NOW.date() - timedelta(days=1),
            metrics=MetricsTable(rows=(metrics_row(),)),
            run="A-full",
            deciding_row_id=DECIDING.row_id,
            hours=tuple(ours),
        ),
        comparator
        or Comparator.incumbent(
            artifact_id=INCUMBENT_ID,
            lane=lane,
            feature_hash=LIVE_HASH,
            row=metrics_row(),
            hours=tuple(theirs),
        ),
        live_feature_hash=LIVE_HASH,
        smoke=clean_smoke(),
        now=NOW,
    )


# --- the metric ---------------------------------------------------------------


def test_the_metric_counts_days_and_not_hours() -> None:
    """`replay.md`: floor coverage is a share of *days*, at subsystem grain."""
    measured = floor_coverage(
        confident(short_days=(0, 1, 2)), row_id="F6", fidelity="point_in_time"
    )
    assert measured is not None
    assert [entry.subsystem for entry in measured.by_subsystem] == ["NE"]
    entry = measured.by_subsystem[0]
    assert entry.days == DAYS
    assert entry.days_floor_met == DAYS - 3
    assert entry.coverage == pytest.approx((DAYS - 3) / DAYS)


def test_a_model_that_promises_no_floor_meets_it_every_day() -> None:
    """The incumbent's P10 is exactly zero, so its promise is zero MWh.

    Which is the honest reading and not a bug: an hour-wise P10 envelope has no
    day-level nominal level, and a model that would not commit to one has not
    failed to keep a commitment.
    """
    measured = floor_coverage(
        uncertain(short_days=(0, 1, 2)), row_id="F6", fidelity="point_in_time"
    )
    assert measured is not None
    assert measured.by_subsystem[0].coverage == 1.0


def test_an_incomplete_subsystem_day_is_excluded_and_counted() -> None:
    """A day short an hour is not a day a plan was ever built for."""
    measured = floor_coverage(
        confident(complete=False), row_id="F6", fidelity="point_in_time"
    )
    assert measured is None


def test_coverage_is_never_pooled_across_subsystems() -> None:
    """A share over two subsystems averages two fleets' worth of curtailment."""
    measured = floor_coverage(
        confident(short_days=(0, 1), subsystems=("NE", "S"), days=4),
        row_id="F6",
        fidelity="point_in_time",
    )
    assert measured is not None
    assert [entry.subsystem for entry in measured.by_subsystem] == ["NE", "S"]
    assert not hasattr(measured, "floor_coverage")
    assert "floor_coverage" not in measured.as_dict()


# --- the comparison ------------------------------------------------------------


def test_more_than_five_points_below_the_incumbent_is_vetoed() -> None:
    """The spec's rule, and the only comparison this guardrail makes."""
    veto = guardrail(short_days=(0, 1))
    assert veto.verdict == "vetoed"
    assert veto.vetoes
    entry = veto.by_subsystem[0]
    assert entry.candidate == pytest.approx(0.90)
    assert entry.incumbent == pytest.approx(1.0)
    assert entry.shortfall == pytest.approx(0.10)


def test_exactly_five_points_below_is_not_a_veto() -> None:
    """ "More than five points" is strict, and the boundary is where it shows."""
    veto = guardrail(short_days=(0,))
    assert veto.verdict == "passed"
    entry = veto.by_subsystem[0]
    assert entry.shortfall == pytest.approx(FLOOR_COVERAGE_SLACK)


def test_the_slack_is_the_spec_s_five_percentage_points() -> None:
    """The one constant in the module, and the spec is where it comes from."""
    assert FLOOR_COVERAGE_SLACK == 0.05


def test_a_subsystem_the_candidate_cannot_measure_vetoes() -> None:
    """ "Not shown" and "shown to be fine" are different sentences."""
    veto = compare_floor_coverage(
        candidate=floor_coverage(
            confident(subsystems=("NE",), days=4),
            row_id="F6",
            fidelity="point_in_time",
        ),
        incumbent=floor_coverage(
            uncertain(subsystems=("NE", "S"), days=4),
            row_id="F6",
            fidelity="point_in_time",
        ),
        provenance=FloorCoverageProvenance.fixture(lane=LANE),
    )
    assert veto.verdict == "vetoed"
    fired = [entry for entry in veto.by_subsystem if entry.vetoes]
    assert [entry.subsystem for entry in fired] == ["S"]


def test_two_coverages_over_different_populations_are_refused() -> None:
    """A share over other days is not a comparison; it looks like a regression."""
    with pytest.raises(FloorCoverageError, match="different subsystem-hours"):
        floor_coverage_guardrail(
            candidate_hours=confident(days=4),
            incumbent_hours=uncertain(days=3),
            row_id="F6",
            fidelity="point_in_time",
            lane=LANE,
            at=NOW,
        )


def test_two_coverages_against_different_labels_are_refused() -> None:
    with pytest.raises(FloorCoverageError, match="different observed MWh"):
        floor_coverage_guardrail(
            candidate_hours=confident(days=4),
            incumbent_hours=uncertain(days=4, short_days=(0,)),
            row_id="F6",
            fidelity="point_in_time",
            lane=LANE,
            at=NOW,
        )


def test_a_comparison_across_folds_or_fidelities_is_refused() -> None:
    """The spec says *the shared newest fold*, at one fidelity."""
    with pytest.raises(FloorCoverageError, match="shared newest fold"):
        compare_floor_coverage(
            candidate=floor_coverage(
                confident(days=4), row_id="F6", fidelity="point_in_time"
            ),
            incumbent=floor_coverage(
                uncertain(days=4), row_id="F5", fidelity="point_in_time"
            ),
            provenance=FloorCoverageProvenance.fixture(lane=LANE),
        )


# --- the stamp -----------------------------------------------------------------


def test_the_comparison_is_stamped_with_the_published_reference_fleet() -> None:
    """`replay.md` story 35: one fleet, one place, stamped on every aggregate."""
    veto = guardrail()
    assert veto.provenance.reference_fleet_hash == PUBLISHED_FLEET.fleet_hash
    assert PUBLISHED_FLEET.battery_max_power_mw == REFERENCE_FLEET.battery.max_power_mw
    assert (
        PUBLISHED_FLEET.load_max_shift_mw == REFERENCE_FLEET.shiftable_load.max_shift_mw
    )
    assert veto.provenance.floor_coverage_source == FOLD_EVALUATION_SOURCE
    assert veto.provenance.is_measurement


def test_a_fabricated_comparison_cannot_claim_to_be_a_measurement() -> None:
    """The fifth stamp, with the same discipline as the other five."""
    assert not FloorCoverageProvenance.fixture(lane=LANE).is_measurement
    assert (
        FloorCoverageProvenance.fixture(lane=LANE).floor_coverage_source == FIXTURE_SOURCE
    )
    assert (
        FloorCoverageProvenance.unmeasured(lane=LANE).floor_coverage_source
        == UNMEASURED_SOURCE
    )


# --- the cold start ------------------------------------------------------------


def test_a_cold_start_is_not_applicable_rather_than_satisfied() -> None:
    """The ticket's last box. A first artifact cleared no bar, and says so."""
    veto = guardrail(incumbent_present=False)
    assert veto.verdict == "not_applicable"
    assert not veto.vetoes
    assert veto.candidate is None and veto.incumbent is None
    assert "not applicable rather than satisfied" in veto.detail
    assert veto.provenance.floor_coverage_source == UNMEASURED_SOURCE


def test_a_not_applicable_guardrail_cannot_be_recorded_as_passed() -> None:
    """The gate's own type refuses the reading, rather than trusting callers."""
    with pytest.raises(GateInputError, match="cannot have passed"):
        Guardrail(name="floor_coverage", passed=True, applicable=False, detail="x")


# --- in the gate ---------------------------------------------------------------


def test_the_gate_refuses_a_candidate_the_bootstrap_would_have_promoted() -> None:
    """The guardrail earning its keep: better ``qloss``, worse floor, refused."""
    decision = gate_decision(short_days=(0, 1))
    assert decision.bootstrap is not None
    assert decision.bootstrap.promotes, "the fixture must clear check 5 to be a test"
    assert not decision.promotes
    assert decision.checks[-1].name == "guardrails"
    vetoed = [rail.name for rail in decision.guardrails if rail.vetoes]
    assert vetoed == ["floor_coverage[NE]"]
    assert "floor_coverage[NE]" in decision.reason


def test_the_same_candidate_one_day_better_promotes() -> None:
    """The veto is a veto: at five points it blocks nothing."""
    decision = gate_decision(short_days=(0,))
    assert decision.promotes
    assert decision.floor_coverage is not None
    assert decision.floor_coverage.verdict == "passed"


def test_a_higher_floor_coverage_cannot_promote_anything() -> None:
    """The third box: the guardrail is never the decision.

    The candidate's floor coverage is *above* the incumbent's here and its
    ``qloss`` is worse on every day, so the bootstrap refuses — and there is no
    field, branch or constant anywhere that lets the floor figure overturn that.
    """
    decision = gate_decision(
        candidate_hours=uncertain(short_days=(0, 1, 2)),
        incumbent_hours=confident(short_days=(0, 1, 2)),
    )
    assert not decision.promotes
    assert decision.checks[-1].name == "paired_block_bootstrap"
    assert decision.bootstrap is not None
    assert not decision.bootstrap.promotes
    # Check 6 never ran, so there is no floor block — a check that did not run
    # is not a comparison that passed.
    assert decision.floor_coverage is None


def test_the_decision_record_names_the_fold_the_fidelity_the_fleet_and_both() -> None:
    """The fifth box, on the line the promotion log actually carries."""
    decision = gate_decision(short_days=(0, 1))
    line = json.loads(decision.to_record().to_line())
    block = line["floor_coverage"]
    assert block["verdict"] == "vetoed"
    assert block["slack"] == FLOOR_COVERAGE_SLACK
    assert block["candidate"]["row_id"] == DECIDING.row_id
    assert block["candidate"]["vintage_fidelity"] == DECIDING.fidelity
    assert block["incumbent"]["row_id"] == DECIDING.row_id
    assert block["incumbent"]["vintage_fidelity"] == DECIDING.fidelity
    assert block["provenance"]["reference_fleet_hash"] == PUBLISHED_FLEET.fleet_hash
    assert block["candidate"]["by_subsystem"][0]["floor_coverage"] == pytest.approx(0.9)
    assert block["incumbent"]["by_subsystem"][0]["floor_coverage"] == pytest.approx(1.0)
    assert decision.card_block()["floor_coverage"] == block


def test_a_cold_start_reaches_the_card_as_not_applicable() -> None:
    decision = gate_decision(
        comparator=Comparator.cold_start(row=metrics_row(qloss=99.0), hours=uncertain())
    )
    assert decision.floor_coverage is not None
    assert decision.floor_coverage.verdict == "not_applicable"
    rails = {rail.name: rail for rail in decision.guardrails}
    assert not rails["floor_coverage"].applicable
    assert not rails["floor_coverage"].passed
    assert not rails["floor_coverage"].vetoes
    assert decision.card_block()["floor_coverage"]["verdict"] == "not_applicable"


def test_one_lane_s_floor_refusal_leaves_the_other_lane_alone() -> None:
    """Forecaster 19's property, restated for this guardrail.

    The evening lane is refused on floor coverage and the morning lane promotes
    in the same run. The guardrail holds no cross-lane state — it is computed
    from the hours of the two artifacts it is handed — so there is nothing here
    that *could* couple them, and this is the test that says so.
    """
    refused = gate_decision(short_days=(0, 1), lane=LANE)
    promoted = gate_decision(short_days=(0,), lane=OTHER_LANE)
    assert not refused.promotes
    assert promoted.promotes
    assert promoted.lane == OTHER_LANE


# --- no absolute bar -----------------------------------------------------------


SOURCE_ROOT = Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml"

#: A floor coverage compared against a number. The thing `replay.md` says does
#: not exist, looked for rather than promised.
ABSOLUTE_BAR = re.compile(
    r"(floor_coverage\w*|coverage_of\([^)]*\)(?:\.coverage)?)\s*"
    r"(<=|>=|<|>|==)\s*[-+]?\d",
)


def _code_lines(path: Path) -> list[str]:
    """Source with ``#`` comments removed. Prose about the rule is not the rule."""
    return [line.split("#", 1)[0] for line in path.read_text().splitlines()]


def test_no_absolute_floor_coverage_bar_exists_anywhere_in_the_service() -> None:
    """The fourth box, asserted against the repository rather than promised.

    `docs/specs/replay.md`: "No absolute floor is set, because an hour-wise P10
    envelope has no day-level nominal level to compare against — the joint
    probability that all 24 hours land at or above their own P10 is not 90 %, is
    not computed, and is not claimed."
    """
    offenders = [
        f"{path.relative_to(SOURCE_ROOT)}:{number}: {line.strip()}"
        for path in sorted(SOURCE_ROOT.rglob("*.py"))
        for number, line in enumerate(_code_lines(path), start=1)
        if ABSOLUTE_BAR.search(line)
    ]
    assert offenders == []


def test_the_module_publishes_exactly_one_numeric_constant() -> None:
    """And it is a slack subtracted from a measured incumbent, not a bar."""
    module = SOURCE_ROOT / "replay" / "floor_guardrail.py"
    numeric = re.findall(r"^([A-Z][A-Z0-9_]*) = [-+0-9.]", module.read_text(), re.M)
    assert numeric == ["FLOOR_COVERAGE_SLACK"]
    comparisons = [
        line.strip()
        for line in _code_lines(module)
        if "FLOOR_COVERAGE_SLACK" in line and ("-" in line or "<" in line)
    ]
    assert comparisons == ["floor = theirs.coverage - FLOOR_COVERAGE_SLACK"]
