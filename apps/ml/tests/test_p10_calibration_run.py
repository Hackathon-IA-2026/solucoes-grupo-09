"""The P10 calibration diagnostic: cells reconcile to the gate on every cut,
not only the pooled one; a subsystem short of calibration rows gets an absence
and never a fitted delta; the driver writes only its report."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from wattsteer_ml import p10_calibration_run
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.evaluation.gate import (
    p10_calibration_excess,
)
from wattsteer_ml.experiment_reports import report_path, save_report
from wattsteer_ml.p10_calibration_run import (
    DeltaBlock,
    FoldScoring,
    P10CalibrationRequest,
    P10CalibrationRunError,
    SegmentHours,
    _clustered_excess,
    _fit_subsystem_delta,
    _oracle_delta,
    build_delta_block,
    p10_calibration_breakdown,
    run_p10_calibration,
)
from wattsteer_ml.training import ScoredHour
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.conformal import (
    NOMINAL_MISCOVERAGE,
    ConformalCorrection,
    minimum_calibration_rows,
)
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

THRESHOLD_MW = 5.0
FIRST = date(2026, 7, 1)
ZEROS = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(24)) for _ in SUBSYSTEM_CODES)
)


def _hours(
    days: int = 20,
    *,
    p: float = 0.99,
    q02: float = 15.0,
    q10: float = 20.0,
    q50: float = 30.0,
    q90: float = 40.0,
    label_over_p10: dict[str, float] | None = None,
    fixed_label: float | None = None,
    subsystems: tuple[Subsystem, ...] = SUBSYSTEM_CODES,
    hours_per_day: int = 3,
) -> tuple[ScoredHour, ...]:
    """Curtailed hours with the label at ``ratio`` times each hour's served P10.

    A ratio under 1 puts the label below the served floor — missed — and one at
    or above 1 clears it, which the breakdown has to place in the right
    subsystem, exactly as `p50_bias_run`'s fixture does one quantile up.
    ``q02`` distinct from ``q10`` by default keeps rows in the *interpolating*
    region above ``p = 0.918`` (`mixture.implied_lower_clearance`'s own
    boundary) rather than the flat one, which is the population this rail's
    own population lives in.
    """
    ratios = label_over_p10 or {}
    keys = [
        RowKey(target_date=FIRST + timedelta(days=d), local_hour=h, subsystem=code)
        for d in range(days)
        for h in range(hours_per_day)
        for code in subsystems
    ]
    estimates = [
        HourEstimates(
            occurrence_probability=p,
            q02=q02,
            q10=q10,
            q50=q50,
            q90=q90,
            positive_mean_mwh=q50,
        )
        for _ in keys
    ]
    composed = compose_estimates(
        keys, estimates, sub_threshold_means=ZEROS, threshold_mw=THRESHOLD_MW
    )
    return tuple(
        ScoredHour(
            key=hour.key,
            forecast=hour.forecast,
            observed_mwh=(
                fixed_label
                if fixed_label is not None
                else hour.forecast.band.p10 * ratios.get(hour.key.subsystem, 1.0)
            ),
        )
        for hour in composed
    )


def _fake_conformal(n: int = 20) -> ConformalCorrection:
    lower = [float(i) * 0.01 for i in range(n)]
    upper = [float(i) * 0.02 for i in range(n)]
    return ConformalCorrection.fit(
        lower_residuals=lower,
        upper_residuals=upper,
        window=(FIRST, FIRST + timedelta(days=30)),
    )


# --- The anchor: a cell can never disagree with the gate on the same rows. ---


def test_the_overall_cell_is_the_gates_own_figure() -> None:
    hours = _hours(label_over_p10={"N": 0.5, "NE": 1.5, "S": 0.5, "SE": 1.5})
    breakdown = p10_calibration_breakdown(hours)
    gate = p10_calibration_excess(hours)
    assert breakdown["gate_reading"] == gate.excess
    assert breakdown["gate_standard_error"] == gate.standard_error
    assert breakdown["overall"]["excess"] == gate.excess
    assert breakdown["overall"]["standard_error"] == gate.standard_error
    assert breakdown["overall"]["qualifying_rows"] == gate.qualifying_rows


def test_every_cut_agrees_with_the_gate_on_its_own_rows() -> None:
    """Not only overall: a subsystem cell reads the same figure the gate would
    read on exactly that subsystem's rows — the anchor generalised."""
    hours = _hours(label_over_p10={"N": 0.5, "NE": 1.5, "S": 0.5, "SE": 1.5})
    breakdown = p10_calibration_breakdown(hours)
    for cell in breakdown["by_subsystem"]:
        subset = [h for h in hours if h.key.subsystem == cell["label"]]
        expected = p10_calibration_excess(subset)
        assert cell["excess"] == expected.excess
        assert cell["qualifying_rows"] == expected.qualifying_rows


def test_a_bias_in_one_subsystem_is_placed_in_that_subsystem() -> None:
    breakdown = p10_calibration_breakdown(_hours(label_over_p10={"NE": 0.5}))
    by = {cell["label"]: cell for cell in breakdown["by_subsystem"]}
    assert by["NE"]["realised_clearance"] == pytest.approx(0.0)
    for other in ("N", "S", "SE"):
        assert by[other]["realised_clearance"] == pytest.approx(1.0)


def test_the_anchor_is_not_vacuous() -> None:
    """A mutation that moves the pooled excess must move the cell with it."""
    hours = list(_hours())
    before = p10_calibration_breakdown(hours)
    victim = hours[0]
    hours[0] = ScoredHour(
        key=victim.key,
        forecast=victim.forecast,
        observed_mwh=victim.forecast.band.p10 * 0.1,
    )
    after = p10_calibration_breakdown(hours)
    assert after["gate_reading"] != before["gate_reading"]
    assert after["overall"]["excess"] == p10_calibration_excess(hours).excess


# --- Two populations, and the raw-knot columns. ---


def test_raw_coverage_reads_the_boosters_own_knots() -> None:
    """A label fixed exactly on the raw q10 knot clears it; one just under misses."""
    at_knot = _hours(q02=6.0, q10=8.0, q50=10.0, q90=12.0, fixed_label=8.0, days=5)
    breakdown = p10_calibration_breakdown(at_knot)
    assert breakdown["overall"]["raw_q10_coverage"] == pytest.approx(1.0)

    below_knot = _hours(q02=6.0, q10=8.0, q50=10.0, q90=12.0, fixed_label=7.99, days=5)
    breakdown_below = p10_calibration_breakdown(below_knot)
    assert breakdown_below["overall"]["raw_q10_coverage"] == pytest.approx(1.0)
    # A label above both knots clears neither.
    above = _hours(q02=6.0, q10=8.0, q50=10.0, q90=12.0, fixed_label=100.0, days=5)
    coverage = p10_calibration_breakdown(above)["overall"]["raw_q02_coverage"]
    assert coverage == pytest.approx(0.0)


def test_rows_off_the_gates_population_carry_the_absence_not_a_zero() -> None:
    """Below p = 0.90 the served floor is the point mass; nothing can falsify it."""
    breakdown = p10_calibration_breakdown(_hours(p=0.4, fixed_label=12.0))
    assert breakdown["positive_rows"] > 0
    assert breakdown["qualifying_rows"] == 0
    assert breakdown["gate_reading"] is None
    assert breakdown["overall"] is not None
    assert breakdown["overall"]["excess"] is None
    assert breakdown["overall"]["qualifying_rows"] == 0
    # Below p = 0.90 the floor never states a bound, so the raw-knot columns
    # have no population to read either.
    assert breakdown["overall"]["raw_q10_coverage"] is None


def test_every_cut_sums_back_to_the_positive_rows() -> None:
    breakdown = p10_calibration_breakdown(_hours())
    n = breakdown["positive_rows"]
    assert n > 0
    for cut in ("by_subsystem", "by_local_hour", "by_month", "by_occurrence_probability"):
        assert sum(cell["positive_rows"] for cell in breakdown[cut]) == n, cut


def test_thin_cells_are_flagged() -> None:
    breakdown = p10_calibration_breakdown(_hours(days=20))
    hour_cells = breakdown["by_local_hour"]
    assert hour_cells
    assert all(
        cell["thin"] is (cell["qualifying_rows"] < p10_calibration_run.THIN_CELL_ROWS)
        for cell in hour_cells
    )
    assert any(cell["thin"] for cell in hour_cells)


# --- The delta block. ---


def test_a_subsystem_with_too_few_calibration_rows_gets_no_delta() -> None:
    calibration = _hours(days=2, subsystems=("N",))  # 6 rows, well under the floor of 9
    delta = _fit_subsystem_delta(calibration, "N", miscoverage=NOMINAL_MISCOVERAGE)
    assert delta.delta_lo is None
    assert delta.rank is None
    assert delta.reason is not None and "N" in delta.reason
    assert delta.calibration_rows < minimum_calibration_rows(NOMINAL_MISCOVERAGE)

    absent = _fit_subsystem_delta(calibration, "NE", miscoverage=NOMINAL_MISCOVERAGE)
    assert absent.calibration_rows == 0
    assert absent.delta_lo is None
    assert absent.reason is not None


def test_a_subsystem_with_enough_calibration_rows_gets_a_fitted_delta() -> None:
    calibration = _hours(days=10, subsystems=("NE",), hours_per_day=3)  # 30 rows
    delta = _fit_subsystem_delta(calibration, "NE", miscoverage=NOMINAL_MISCOVERAGE)
    assert delta.delta_lo is not None
    assert delta.rank is not None
    assert delta.reason is None
    assert delta.calibration_rows >= minimum_calibration_rows(NOMINAL_MISCOVERAGE)


def test_the_oracle_delta_zeros_the_population_it_is_fit_on() -> None:
    # Built directly as (subsystem, day, residual, implied) tuples, with 240
    # distinct residuals: `_oracle_delta` and `_clustered_excess` need nothing
    # else, and a fixture routed through `_hours` gives every row inside one
    # subsystem the identical residual, which quantises the achievable excess
    # into four steps and can leave every one of them far from zero — a
    # property of that fixture's symmetry, not of the bisection.
    rows = [
        (f"S{i % 4}", FIRST + timedelta(days=i // 4), 0.01 * (i - 120), 0.90)
        for i in range(240)
    ]
    oracle = _oracle_delta(rows)
    assert oracle is not None
    excess, _ = _clustered_excess(
        (day, (1.0 if residual <= oracle else 0.0) - implied)
        for _, day, residual, implied in rows
    )
    # excess(δ) is a step function — it jumps at each row's own residual — so
    # the bisection lands within one row's worth of zero, never exactly at it,
    # unless a residual happens to sit exactly on the boundary.
    resolution = 1.0 / len(rows)
    assert excess is not None
    assert abs(excess) <= resolution + 1e-9


def test_the_oracle_delta_is_absent_with_no_qualifying_row() -> None:
    assert _oracle_delta([]) is None


def test_build_delta_block_reads_the_served_correction_verbatim() -> None:
    conformal = _fake_conformal()
    calibration = _hours(days=10)
    test_hours = _hours(days=5)
    delta = build_delta_block(
        conformal=conformal, calibration_hours=calibration, test_hours=test_hours
    )
    assert delta.delta_lo_used == conformal.delta_lo
    assert delta.lower_calibration_rows == conformal.lower_calibration_rows
    assert delta.lower_rank == conformal.lower_rank
    assert delta.lower_miscoverage == conformal.lower_miscoverage
    assert delta.lower_tail_fitted == conformal.lower_tail_fitted
    assert len(delta.per_subsystem) == len(SUBSYSTEM_CODES)


def test_the_delta_block_survives_an_empty_calibration_and_test_pool() -> None:
    conformal = _fake_conformal()
    delta = build_delta_block(conformal=conformal, calibration_hours=(), test_hours=())
    assert delta.delta_lo_oracle is None
    assert delta.excess_per_subsystem_delta is None
    assert all(d.delta_lo is None for d in delta.per_subsystem)


# --- The driver: refusals, the promise not to write anywhere else. ---


class _Source:
    def __init__(self, folds: dict[str, Any]) -> None:
        self._folds = folds

    def fold_ids(self) -> tuple[str, ...]:
        return tuple(self._folds)

    def __call__(self, fold_id: str) -> Any:
        outcome = self._folds[fold_id]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _empty_delta() -> DeltaBlock:
    return build_delta_block(
        conformal=_fake_conformal(), calibration_hours=(), test_hours=()
    )


def _fold_scoring(fold_id: str, hours: tuple[ScoredHour, ...]) -> FoldScoring:
    segment = SegmentHours(fold_id, fold_id, "revision_optimistic", True, hours)
    return FoldScoring(fold_id=fold_id, delta=_empty_delta(), segments=(segment,))


def _request(tmp_path: Path) -> P10CalibrationRequest:
    return P10CalibrationRequest(
        as_of=datetime(2026, 9, 20, 15, 9, 10, tzinfo=UTC),
        root=tmp_path,
        database_url="postgres://unused",
    )


def test_a_refused_fold_is_published_and_the_others_still_report(tmp_path: Path) -> None:
    from wattsteer_ml.retrain import RetrainError

    good = _fold_scoring("F5", _hours())
    report = run_p10_calibration(
        _request(tmp_path),
        source=_Source({"F5": good, "F6": RetrainError("no settled label")}),
    )
    payload = report.as_dict()
    assert payload["measured"] is True
    assert [fold["fold_id"] for fold in payload["folds"]] == ["F5"]
    assert "RetrainError" in payload["folds_refused"]["F6"]


def test_no_fold_scored_is_not_a_measurement(tmp_path: Path) -> None:
    from wattsteer_ml.retrain import RetrainError

    report = run_p10_calibration(
        _request(tmp_path), source=_Source({"F6": RetrainError("nothing ingested")})
    )
    assert report.is_measurement is False
    assert report.as_dict()["folds"] == []


def test_no_reportable_fold_refuses_to_start(tmp_path: Path) -> None:
    with pytest.raises(P10CalibrationRunError):
        run_p10_calibration(_request(tmp_path), source=_Source({}))


def test_the_report_is_saved_beside_the_lanes_and_nothing_else_is_written(
    tmp_path: Path,
) -> None:
    request = _request(tmp_path)
    good = _fold_scoring("F6", _hours())
    payload = run_p10_calibration(request, source=_Source({"F6": good})).as_dict()
    path = save_report(tmp_path, "p10_calibration", request.as_of, payload)
    assert path == report_path(tmp_path, "p10_calibration", request.as_of)
    assert json.loads(path.read_text())["lane"] == request.lane
    written = sorted(
        p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file()
    )
    assert written == ["experiments/p10_calibration/2026-09-20T15:09:10Z.json"]


def test_the_driver_cannot_promote_or_save_an_artifact() -> None:
    """Source-level: the property lives in what the module calls, not in a value."""
    source = Path(p10_calibration_run.__file__).read_text()
    for forbidden in ("save_artifact", "promotions.append", "PromotionRecord", "record_"):
        assert forbidden not in source, forbidden


def test_the_placeholder_is_marked_in_the_report(tmp_path: Path) -> None:
    hours = _hours()
    segment = SegmentHours(
        "F3", "F3", "revision_optimistic", True, hours, placeholder_risk_bins=True
    )
    scoring = FoldScoring(fold_id="F3", delta=_empty_delta(), segments=(segment,))
    payload = run_p10_calibration(
        _request(tmp_path), source=_Source({"F3": scoring})
    ).as_dict()
    assert payload["folds"][0]["segments"][0]["placeholder_risk_bins"] is True


def test_the_delta_block_travels_with_the_fold_not_the_segment(tmp_path: Path) -> None:
    delta = build_delta_block(
        conformal=_fake_conformal(),
        calibration_hours=_hours(days=10),
        test_hours=_hours(days=5),
    )
    segment = SegmentHours("F6", "F6", "revision_optimistic", True, _hours())
    scoring = FoldScoring(fold_id="F6", delta=delta, segments=(segment,))
    payload = run_p10_calibration(
        _request(tmp_path), source=_Source({"F6": scoring})
    ).as_dict()
    fold = payload["folds"][0]
    assert fold["delta"]["delta_lo_used"] == delta.delta_lo_used
    assert len(fold["delta"]["per_subsystem"]) == len(SUBSYSTEM_CODES)
