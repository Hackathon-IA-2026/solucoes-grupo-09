"""Train the hurdle on one fold, and get a band out.

Every assertion here is structural — about the shape of the training, the path
the band was composed by, and the reproducibility of the result. **None of them
is about accuracy**, and none could be: the rows are fixtures
(`feature_row_fixtures.py`), and only part of the real feature set is populated
in the migration tree so far. What is being checked is that the machine is wired
the way `docs/specs/forecaster.md` says, which is exactly the thing that stops
looking fine once it is wrong.
"""

from __future__ import annotations

import inspect
import math
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

import reproduce_fold
from conftest import FIXTURE_BACKGROUND_ROWS_PER_CELL, FUNCTION_DEFINITION
from feature_row_fixtures import blinded_sub_threshold
from out_of_fold_fixtures import pool as out_of_fold_pool
from wattsteer_ml.evaluation import Fold, FoldBlocks, expected_test_rows
from wattsteer_ml.mixture import SERVED_QUANTILES, ComposedForecast
from wattsteer_ml.training import (
    ESTIMATOR_FIELDS,
    OutOfFoldPool,
    TrainedFold,
    forecast_rows,
    train_fold,
)
from wattsteer_ml.training import hurdle as hurdle_module

HOURS_PER_DAY = 24


def bands(trained: TrainedFold, rows: list[dict[str, Any]]) -> list[ComposedForecast]:
    return [hour.forecast for hour in forecast_rows(trained.bundle, rows)]


def test_one_fold_produces_a_band_for_every_subsystem_hour_of_the_test_period(
    trained: TrainedFold, test_rows: list[dict[str, Any]], blocks: FoldBlocks
) -> None:
    """A complete 24-hour band and expectation, per subsystem, for the test period.

    Completeness is asserted against `evaluation.expected_test_rows`, the same
    grid the fold matrix's row-identity check uses, so "complete" means the same
    thing here as it will mean in the metrics table.
    """
    forecasts = forecast_rows(trained.bundle, test_rows)
    expected = set(expected_test_rows(blocks.test_start, blocks.test_end))
    assert {hour.key for hour in forecasts} == expected
    assert len(forecasts) == blocks.test_days * HOURS_PER_DAY * 4
    for hour in forecasts:
        band = hour.forecast.band
        assert band.p10 <= band.p50 <= band.p90
        for value in (band.p10, band.p50, band.p90, hour.forecast.expected_mwh):
            assert math.isfinite(value)


def test_the_band_is_the_mixture_inversion_and_not_a_second_composition(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """`Q_Y(q) = 0` for `q ≤ 1 − p`, hour by hour.

    Ticket 01's arithmetic, observed on the trained model's own output. A
    trainer that had multiplied `p` by a magnitude — the composition error the
    whole spec is arranged against — could not reproduce this table, because
    `p × E[Y | Y > τ]` is non-zero wherever `p` is.
    """
    threshold_mwh = trained.bundle.threshold_mw
    for forecast in bands(trained, test_rows):
        p = forecast.occurrence_probability
        for quantile, value in zip(
            SERVED_QUANTILES,
            (forecast.band.p10, forecast.band.p50, forecast.band.p90),
            strict=True,
        ):
            if quantile <= 1.0 - p:
                assert value == 0.0
            else:
                assert value > threshold_mwh


def test_the_expectation_is_a_sibling_of_the_band_not_its_centre(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """`E[Y] > P50` whenever `p < 0.5`, which is most hours.

    The property that makes an expectation rendered as a band's centre wrong:
    it would make the band asymmetric for a reason that has nothing to do with
    uncertainty.
    """
    quiet = [f for f in bands(trained, test_rows) if f.occurrence_probability < 0.5]
    assert quiet, "the fixture should contain hours more likely than not to be quiet"
    for forecast in quiet:
        assert forecast.band.p50 == 0.0
        assert forecast.expected_mwh > forecast.band.p50


def test_the_trainer_holds_no_composition_of_its_own() -> None:
    """`compose` is imported and called; there is no second mixture in this file.

    Ticket 01 made the inversion the only path. This is the check that keeps it
    the only path when a later ticket needs "just the expectation, quickly".
    """
    source = inspect.getsource(hurdle_module)
    assert "compose(" in source
    for reimplementation in (
        "1.0 - p",
        "1 - p",
        "occurrence_probability *",
        "* positive_mean",
        "QuantileBand(",
    ):
        assert reimplementation not in source


def test_the_magnitude_models_saw_curtailed_hours_only(
    trained: TrainedFold,
    rows: list[dict[str, Any]],
    test_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
) -> None:
    """The difference between a hurdle and a zero-inflated regression.

    The instrument: refit with every *sub-threshold* row's covariates replaced
    by nonsense and its labels untouched. A magnitude booster fitted on all rows
    would move. One fitted on `y > τ` alone cannot see the change at all — so
    its predictions must be identical to the last float, while the occurrence
    classifier, which does see every row, is free to move.

    **The comparison is on the boosters, not on the served quantile function,
    and forecaster ticket 06 is why.** ``Q_pos`` as served now carries the
    conformal correction, and ``δ`` is fitted against the *composed* band —
    which the classifier's ``p`` decides the shape of. So blinding sub-threshold
    covariates legitimately moves the served knots through ``p``, and asserting
    on them would assert something this model does not claim. What it does claim
    is that the three pinball fits saw curtailed hours only, and that is a
    statement about ``bundle.magnitude_q*``, tested here directly.
    """
    blinded = train_fold(
        blinded_sub_threshold(rows),
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
        pool=out_of_fold_pool(),
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
        artifact_id="2026-08-29T05:00:00Z",
    )
    for name in ("magnitude_p10", "magnitude_p50", "magnitude_p90", "magnitude_mean"):
        one = getattr(trained.bundle, name)
        other = getattr(blinded.bundle, name)
        assert one.model_to_string() == other.model_to_string(), (
            f"{name} moved when sub-threshold covariates were blinded, so it saw "
            "rows below τ"
        )
    before = forecast_rows(trained.bundle, test_rows)
    after = forecast_rows(blinded.bundle, test_rows)
    for one_hour, other_hour in zip(before, after, strict=True):
        assert one_hour.key == other_hour.key
        assert one_hour.forecast.mixture.positive_mean_mwh == (
            other_hour.forecast.mixture.positive_mean_mwh
        )


def test_a_fold_with_no_curtailed_hour_refuses_rather_than_fits(
    rows: list[dict[str, Any]], fold: Fold, blocks: FoldBlocks
) -> None:
    """No positives is a statement about the data, not a configuration to relax."""
    quiet = [
        dict(
            row,
            y_constrained_off_total_mwh=0.0,
            y_constrained_off_wind_mwh=0.0,
            y_constrained_off_solar_mwh=0.0,
            y_has_curtailment=False,
            y_magnitude_mwh=None,
        )
        for row in rows
    ]
    with pytest.raises(ValueError, match="above τ"):
        train_fold(
            quiet,
            fold=fold,
            blocks=blocks,
            function_definition=FUNCTION_DEFINITION,
            pool=out_of_fold_pool(),
            background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
            artifact_id="2026-08-29T06:00:00Z",
        )


def test_a_window_too_short_for_the_background_fails_at_training(
    rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
) -> None:
    """Forecaster 30's sixth box: the short cell fails once, not twice a day.

    The fixture fold's base-fit block is thirty days, so thirty rows per
    ``(subsystem, local_hour)`` cell. Asked for the spec's 128 the *training
    run* refuses, and the message names the repair an operator can act on — a
    longer run window. Before this ticket the same shortage was a publication
    refusal every twelve hours, for a fact the retrain could have established
    once.

    Both halves are here: the refusal, and the same call at a sample the window
    can supply. A guard that cannot be made to pass proves nothing about
    whether it can fail, and the fixture's own row count is asserted so the
    refusal is the arithmetic and not an empty block.
    """
    days = len(
        {row["target_date"] for row in rows if row["target_date"] <= blocks.base_fit_end}
    )
    assert FIXTURE_BACKGROUND_ROWS_PER_CELL <= days < 128

    with pytest.raises(ValueError, match="no matched background can be drawn") as short:
        train_fold(
            rows,
            fold=fold,
            blocks=blocks,
            function_definition=FUNCTION_DEFINITION,
            pool=out_of_fold_pool(),
            background_rows_per_cell=128,
            artifact_id="2026-08-29T07:00:00Z",
        )
    assert "longer" in str(short.value)
    assert "rows in the block and the sample is drawn at 128" in str(short.value)

    # And the same window at a sample it can supply trains, so the refusal
    # above is the row count and not the plumbing.
    assert (
        train_fold(
            rows,
            fold=fold,
            blocks=blocks,
            function_definition=FUNCTION_DEFINITION,
            pool=out_of_fold_pool(),
            background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
            artifact_id="2026-08-29T07:00:00Z",
        ).bundle.background.rows_per_cell
        == FIXTURE_BACKGROUND_ROWS_PER_CELL
    )


def test_all_six_estimators_and_mu_sub_are_fitted(trained: TrainedFold) -> None:
    """Six, not two: the fourth booster exists so the expectation is not the median."""
    estimators = trained.bundle.estimators()
    assert tuple(estimators) == ESTIMATOR_FIELDS
    assert len(estimators) == 6
    assert all(estimator is not None for estimator in estimators.values())
    table = trained.bundle.sub_threshold_means
    assert sum(len(row) for row in table.values) == 96


def test_mu_sub_is_a_fitted_constant_bounded_by_tau(trained: TrainedFold) -> None:
    """Not zero — dropping it biases a day's expected total low by up to 24 × τ.

    And not above τ: it is a mean over rows at or below the threshold, which is
    the bound `HurdleMixture` asserts on construction.
    """
    table = trained.bundle.sub_threshold_means
    values = [value for row in table.values for value in row]
    assert all(0.0 <= value <= trained.bundle.threshold_mw for value in values)
    assert any(value > 0.0 for value in values)


def test_only_base_fit_rows_are_fitted_on(
    trained: TrainedFold, blocks: FoldBlocks
) -> None:
    """The counts say which block each number came from, and they are disjoint."""
    counts = trained.counts
    assert counts.base_fit_rows == blocks.base_fit_days * HOURS_PER_DAY * 4
    assert counts.calibration_rows == blocks.calibration_days * HOURS_PER_DAY * 4
    assert counts.test_rows == blocks.test_days * HOURS_PER_DAY * 4
    assert blocks.base_fit_end < blocks.calibration_start
    assert counts.base_fit_positive_rows > 0
    assert counts.base_fit_positive_rows < counts.base_fit_labelled_rows


def test_the_trainer_derives_no_fold_dates_of_its_own() -> None:
    """The blocks come from ticket 03; nothing here recomputes a calendar."""
    source = inspect.getsource(hurdle_module)
    for forbidden in (
        "materialize_fold_calendar",
        "timedelta",
        "blocks_for(",
        "calibration_days",
    ):
        assert forbidden not in source


def test_tau_travels_with_the_answer(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """Read off the rows, stamped on the bundle, stamped on every forecast.

    The threshold sweep retrains whole lanes at 1 / 5 / 10 MW, and a magnitude
    without the threshold that produced it cannot be compared with another one.
    """
    assert trained.bundle.threshold_mw == test_rows[0]["threshold_mw"]
    assert trained.bundle.lane.threshold_mw == trained.bundle.threshold_mw
    for forecast in bands(trained, test_rows):
        assert forecast.threshold_mw == trained.bundle.threshold_mw
    source = inspect.getsource(hurdle_module)
    assert "SUBSYSTEM_THRESHOLD_MW" not in source


def test_the_technology_split_is_a_point_split_and_not_a_band(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """The share model applies to the P50 and to the expectation only."""
    for forecast in bands(trained, test_rows):
        assert forecast.p50_split is not None
        assert forecast.expected_split is not None
        split = forecast.expected_split
        assert split.wind_mwh + split.solar_mwh == pytest.approx(
            forecast.expected_mwh, rel=1e-9
        )


def test_same_inputs_and_same_seed_reproduce_identical_predictions(
    rows: list[dict[str, Any]],
    test_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    trained: TrainedFold,
    pool: OutOfFoldPool,
) -> None:
    """A retrain the gate can compare against is a retrain that reproduces itself."""
    again = train_fold(
        rows,
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
        pool=pool,
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
        artifact_id="2026-08-29T07:00:00Z",
    )
    assert again.bundle.contract.feature_hash == trained.bundle.contract.feature_hash
    assert again.bundle.sub_threshold_means == trained.bundle.sub_threshold_means
    for one, other in zip(
        forecast_rows(trained.bundle, test_rows),
        forecast_rows(again.bundle, test_rows),
        strict=True,
    ):
        assert one.key == other.key
        assert one.forecast.band == other.forecast.band
        assert one.forecast.expected_mwh == other.forecast.expected_mwh
        assert one.forecast.occurrence_probability == (
            other.forecast.occurrence_probability
        )


def test_one_model_serves_every_subsystem(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """Subsystem is a categorical feature of one shared model, not four models.

    Four would starve S and N — the positives concentrate in NE — and the
    physics is shared.
    """
    assert trained.bundle.contract.categorical_indices == (0,)
    assert trained.bundle.contract.feature_names[0] == "subsystem"
    served = {hour.key.subsystem for hour in forecast_rows(trained.bundle, test_rows)}
    assert served == {"N", "NE", "S", "SE"}


def test_a_second_interpreter_reproduces_the_same_predictions() -> None:
    """Reproducibility across processes, which is the only kind that matters.

    A process-salted `hash()`, an unseeded shuffle or a thread-count-dependent
    histogram build all reproduce perfectly inside one interpreter and diverge
    between two — and the weekly retrain is always a second interpreter. So the
    fold is trained again in a subprocess and the digests are compared.
    """
    script = Path(__file__).parent / "reproduce_fold.py"
    result = subprocess.run(  # noqa: S603 — a fixed path, no shell, no input
        [sys.executable, str(script)],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.split() == list(reproduce_fold.digest())


def test_a_row_outside_the_three_blocks_is_refused(
    rows: list[dict[str, Any]], fold: Fold, blocks: FoldBlocks
) -> None:
    """A window nobody declared cannot be trained on by accident."""
    from datetime import timedelta

    stray = dict(rows[0], target_date=blocks.base_fit_start - timedelta(days=1))
    with pytest.raises(ValueError, match="three blocks"):
        train_fold(
            [stray, *rows],
            fold=fold,
            blocks=blocks,
            function_definition=FUNCTION_DEFINITION,
            pool=out_of_fold_pool(),
            background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
            artifact_id="2026-08-29T08:00:00Z",
        )
