"""The P50 bias diagnostic: cells reconcile to the gate; it writes only its report."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from wattsteer_ml import p50_bias_run
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.evaluation.gate import p50_band_unbiasedness
from wattsteer_ml.experiment_reports import report_path, save_report
from wattsteer_ml.p50_bias_run import (
    P50BiasRequest,
    P50BiasRunError,
    SegmentHours,
    p50_bias_breakdown,
    run_p50_bias,
)
from wattsteer_ml.training import ScoredHour
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

THRESHOLD_MW = 5.0
FIRST = date(2026, 7, 1)
ZEROS = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(24)) for _ in SUBSYSTEM_CODES)
)


def _hours(
    days: int = 20,
    *,
    p: float = 0.9,
    label_over_p50: dict[str, float] | None = None,
    fixed_label: float | None = None,
) -> tuple[ScoredHour, ...]:
    """Curtailed hours with the label at ``ratio`` times each hour's served P50.

    A ratio under 1 puts the label below the served median, so a subsystem given
    0.8 reads share 1.0 and one given 1.2 reads share 0.0 — a bias the breakdown
    has to place in the right subsystem, which a pooled figure cannot.
    """
    ratios = label_over_p50 or {}
    keys = [
        RowKey(target_date=FIRST + timedelta(days=d), local_hour=h, subsystem=code)
        for d in range(days)
        for h in range(3)
        for code in SUBSYSTEM_CODES
    ]
    estimates = [
        HourEstimates(
            occurrence_probability=p, q10=8.0, q50=10.0, q90=12.0, positive_mean_mwh=10.0
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
                else hour.forecast.band.p50 * ratios.get(hour.key.subsystem, 1.0)
            ),
        )
        for hour in composed
    )


def test_the_overall_cell_is_the_gates_own_figure() -> None:
    hours = _hours(label_over_p50={"N": 0.8, "NE": 1.2, "S": 0.8, "SE": 1.2})
    breakdown = p50_bias_breakdown(hours)
    gate = p50_band_unbiasedness(hours)
    assert breakdown["gate_reading"] == gate.unbiasedness
    assert breakdown["overall"]["below_share"] == gate.unbiasedness
    assert breakdown["overall"]["rows"] == gate.qualifying_rows


def test_a_bias_in_one_subsystem_is_placed_in_that_subsystem() -> None:
    breakdown = p50_bias_breakdown(_hours(label_over_p50={"NE": 0.8}))
    by = {cell["label"]: cell for cell in breakdown["by_subsystem"]}
    assert by["NE"]["below_share"] == 1.0
    assert by["NE"]["median_observed_over_p50"] == pytest.approx(0.8)
    for other in ("N", "S", "SE"):
        assert by[other]["below_share"] == 0.0
        assert by[other]["median_observed_over_p50"] == pytest.approx(1.0)


def test_rows_off_the_gates_population_appear_in_no_cell() -> None:
    """Under p = 0.5 the served P50 is on the point mass; no label can be below it."""
    breakdown = p50_bias_breakdown(_hours(p=0.4, fixed_label=12.0))
    assert breakdown["curtailed_rows"] > 0
    assert breakdown["qualifying_rows"] == 0
    assert breakdown["overall"] is None
    assert breakdown["by_subsystem"] == []
    assert breakdown["gate_reading"] is None


def test_every_cut_sums_back_to_the_qualifying_rows() -> None:
    breakdown = p50_bias_breakdown(_hours())
    n = breakdown["qualifying_rows"]
    assert n > 0
    for cut in ("by_subsystem", "by_local_hour", "by_month", "by_occurrence_probability"):
        assert sum(cell["rows"] for cell in breakdown[cut]) == n, cut


def test_thin_cells_are_flagged() -> None:
    breakdown = p50_bias_breakdown(_hours(days=20))
    hour_cells = breakdown["by_local_hour"]
    assert hour_cells
    assert all(
        cell["thin"] is (cell["rows"] < p50_bias_run.THIN_CELL_ROWS)
        for cell in hour_cells
    )
    assert any(cell["thin"] for cell in hour_cells)


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


def _request(tmp_path: Path) -> P50BiasRequest:
    return P50BiasRequest(
        as_of=datetime(2026, 9, 20, 15, 9, 10, tzinfo=UTC),
        root=tmp_path,
        database_url="postgres://unused",
    )


def test_a_refused_fold_is_published_and_the_others_still_report(tmp_path: Path) -> None:
    from wattsteer_ml.retrain import RetrainError

    good = SegmentHours("F5", "F5", "revision_optimistic", True, _hours())
    report = run_p50_bias(
        _request(tmp_path),
        source=_Source({"F5": [good], "F6": RetrainError("no settled label")}),
    )
    payload = report.as_dict()
    assert payload["measured"] is True
    assert [fold["fold_id"] for fold in payload["folds"]] == ["F5"]
    assert "RetrainError" in payload["folds_refused"]["F6"]


def test_no_fold_scored_is_not_a_measurement(tmp_path: Path) -> None:
    from wattsteer_ml.retrain import RetrainError

    report = run_p50_bias(
        _request(tmp_path), source=_Source({"F6": RetrainError("nothing ingested")})
    )
    assert report.is_measurement is False
    assert report.as_dict()["folds"] == []


def test_no_reportable_fold_refuses_to_start(tmp_path: Path) -> None:
    with pytest.raises(P50BiasRunError):
        run_p50_bias(_request(tmp_path), source=_Source({}))


def test_the_report_is_saved_beside_the_lanes_and_nothing_else_is_written(
    tmp_path: Path,
) -> None:
    request = _request(tmp_path)
    good = SegmentHours("F6", "F6", "revision_optimistic", True, _hours())
    payload = run_p50_bias(request, source=_Source({"F6": [good]})).as_dict()
    path = save_report(tmp_path, "p50_bias", request.as_of, payload)
    assert path == report_path(tmp_path, "p50_bias", request.as_of)
    assert json.loads(path.read_text())["lane"] == request.lane
    written = sorted(
        p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file()
    )
    assert written == ["experiments/p50_bias/2026-09-20T15:09:10Z.json"]


def test_the_driver_cannot_promote_or_save_an_artifact() -> None:
    """Source-level: the property lives in what the module calls, not in a value."""
    source = Path(p50_bias_run.__file__).read_text()
    for forbidden in ("save_artifact", "promotions.append", "PromotionRecord", "record_"):
        assert forbidden not in source, forbidden


def test_the_risk_bin_patch_is_scoped_recorded_and_restored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from wattsteer_ml.p50_bias_run import (
        PLACEHOLDER_RISK_BINS,
        tolerating_undetermined_risk_bins,
    )
    from wattsteer_ml.training import calibration
    from wattsteer_ml.training.calibration import RiskBinsUndeterminedError

    def refuses(predictions: Any, **_: Any) -> Any:
        raise RiskBinsUndeterminedError("no edges on this pool")

    monkeypatch.setattr(calibration, "derive_risk_bins", refuses)
    monkeypatch.setattr(calibration, "_check", lambda predictions, bins: "checked")

    # Disabled: the refusal is the retrain's behaviour and passes straight through.
    with (
        tolerating_undetermined_risk_bins(False) as swallowed,
        pytest.raises(RiskBinsUndeterminedError),
    ):
        calibration.derive_risk_bins([])
    assert swallowed == []

    # Enabled: a placeholder comes back and the swallowed reason is kept.
    with tolerating_undetermined_risk_bins(True) as swallowed:
        decision = calibration.derive_risk_bins([])
    assert decision.bins == PLACEHOLDER_RISK_BINS
    assert "no edges on this pool" in swallowed[0]

    # And the real function is back afterwards, so nothing else is affected.
    with pytest.raises(RiskBinsUndeterminedError):
        calibration.derive_risk_bins([])


def test_the_placeholder_is_marked_in_the_report(tmp_path: Path) -> None:
    segment = SegmentHours(
        "F3", "F3", "revision_optimistic", True, _hours(), placeholder_risk_bins=True
    )
    payload = run_p50_bias(
        _request(tmp_path), source=_Source({"F3": [segment]})
    ).as_dict()
    assert payload["folds"][0]["segments"][0]["placeholder_risk_bins"] is True
