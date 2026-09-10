"""A stated 80% means 80%, and the risk classes come from the curve.

`docs/specs/forecaster.md`, "Calibration — isotonic, and where the curve lives".

Two kinds of assertion live here and the difference matters when reading them.
Most are **structural**: which rows the fit saw, which rows the curve is allowed
to consume, that a thin bin merged and said so, that the published edges satisfy
the rule that chose them. Those are properties of the code and the fixtures
cannot make them more or less true.

The exception is
:func:`test_isotonic_beats_platt_where_a_boosted_classifier_actually_fails`,
which is the one test in this file that is *about* calibration quality. It runs
on **synthetically distorted** probabilities with a known shape — well calibrated
low, increasingly over-confident high — precisely so that the comparison has a
ground truth. It is the test that records why isotonic was chosen over Platt, and
it makes no claim about the served model.

**One caveat this file does not hide.** The calibration window is passed to
LightGBM as an early-stopping monitor, so ``p_raw`` on that window is slightly
optimistic and an isotonic map fitted to it under-corrects a little. The
published reliability curve is measured on rows outside that window entirely, so
the *curve* is not affected; the map's residual under-correction is, and no test
here claims otherwise.
"""

from __future__ import annotations

import inspect
import math
import random
from dataclasses import replace
from datetime import date
from itertools import pairwise
from typing import Any

import joblib
import numpy as np
import pytest

from conftest import FIXTURE_BACKGROUND_ROWS_PER_CELL, FUNCTION_DEFINITION
from out_of_fold_fixtures import (
    PRIOR_FOLDS,
    PRIOR_INSIDE_CALIBRATION,
    SEGMENTS,
    pool_of,
)
from out_of_fold_fixtures import pool as out_of_fold_pool
from out_of_fold_fixtures import predictions as out_of_fold_predictions
from wattsteer_ml.evaluation import (
    Fold,
    FoldBlocks,
    FoldSegment,
    MixedFidelityError,
    RowKey,
)
from wattsteer_ml.training import (
    MAX_RISK_BIN_GAP,
    MIN_BIN_HOURS,
    MODEL_CONFIG_V1,
    RELIABILITY_BINS,
    RISK_EDGE_STEP,
    Calibration,
    CalibrationError,
    IsotonicCalibrator,
    OutOfFoldPool,
    OutOfFoldPrediction,
    PartialBundleError,
    ReliabilityCurve,
    RiskBins,
    RiskBinsUndeterminedError,
    TrainedFold,
    derive_risk_bins,
    forecast_rows,
    load_artifact,
    outside_calibration_window,
    save_artifact,
    train_fold,
    wilson_half_width,
)
from wattsteer_ml.training import calibration as calibration_module


@pytest.fixture
def volume_for_calibration(tmp_path: Any) -> Any:
    root = tmp_path / "models"
    root.mkdir()
    return root


def calibration_window(blocks: FoldBlocks) -> tuple[date, date]:
    return (blocks.calibration_start, blocks.calibration_end)


def curve_of(trained: TrainedFold) -> ReliabilityCurve:
    return trained.bundle.calibration.reliability


# --- The fit: on the calibration window, and nothing refitted after it --------


def test_isotonic_is_fitted_on_the_calibration_window_and_only_on_it(
    trained: TrainedFold,
) -> None:
    """``n`` is the calibration block's labelled rows, and no other block's.

    The base-fit block is an order of magnitude larger and the test block is a
    week; a calibrator fitted on either would carry a visibly different ``n``,
    and ``n`` is exactly what the clip is derived from.
    """
    isotonic = trained.bundle.calibration.isotonic
    counts = trained.counts
    assert isotonic.fitted_rows == counts.calibration_labelled_rows
    assert isotonic.fitted_rows != counts.base_fit_labelled_rows
    assert isotonic.fitted_rows != counts.test_rows
    assert 0 < counts.calibration_labelled_rows <= counts.calibration_rows


def test_the_base_learners_are_not_refit_after_calibration(
    rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    trained: TrainedFold,
) -> None:
    """The invariant `FoldBlocks` exists to hold, observed rather than asserted.

    The instrument: retrain with a **different pool**. A different pool produces
    a different reliability curve and can produce different risk-class edges, so
    if anything downstream of the calibration fed back into the boosters, at
    least one of the six would move. None of them may — the calibration window
    chooses a tree count through early stopping and contributes no gradient, and
    the pool is not seen by any booster at all.
    """
    other = train_fold(
        rows,
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
        pool=out_of_fold_pool(seed=7),
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
        artifact_id="2026-08-29T10:00:00Z",
    )
    for name, booster in trained.bundle.estimators().items():
        assert booster.model_to_string() == (
            other.bundle.estimators()[name].model_to_string()
        ), f"{name} moved when only the out-of-fold pool changed"
    assert other.bundle.calibration.isotonic == trained.bundle.calibration.isotonic
    assert other.bundle.calibration.reliability != curve_of(trained)


def test_with_early_stopping_off_the_calibration_window_touches_nothing_but_the_map(
    rows: list[dict[str, Any]], fold: Fold, blocks: FoldBlocks
) -> None:
    """The stronger instrument, and the escape hatch from the ticket's caveat.

    Changing the pool shows that nothing *downstream* of the fits feeds back, but
    it cannot separate the calibration window from the boosters, because with
    early stopping on that window genuinely does choose the tree count — which is
    the honest caveat this ticket inherits from 04.

    Set ``early_stopping_rounds`` to 0 and the separation becomes total, and this
    test measures it: the calibration block's labels are replaced wholesale, the
    isotonic map moves as it must, and all six boosters come back byte-identical.
    That is "the base learners are not refit afterwards" observed rather than
    argued, and it is also the configuration under which no coverage number
    anywhere is optimistic.

    **Forecaster ticket 06 widened the list of things that window is allowed to
    reach, and this test now names both.** The isotonic map and the two conformal
    corrections are both fitted there; the boosters still are not. So the
    assertion is not "only the map moves" — it is "the map and ``δ`` move, and
    the six boosters do not".

    The flip is applied to the whole label, not to ``y_has_curtailment`` alone.
    A row marked curtailed with a zero MWh is not a label a fold can carry: the
    conformal residuals re-check each label against ``τ``, so a half-flipped
    window would present zero curtailed hours and the fit would refuse — which
    would be this fixture failing, not the code.
    """
    config = replace(MODEL_CONFIG_V1, early_stopping_rounds=0)
    flipped = [
        _flipped_label(row)
        if blocks.calibration_start <= row["target_date"] <= blocks.calibration_end
        else row
        for row in rows
    ]
    baseline = train_fold(
        rows,
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
        pool=out_of_fold_pool(),
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
        config=config,
        artifact_id="2026-08-29T12:00:00Z",
    )
    perturbed = train_fold(
        flipped,
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
        pool=out_of_fold_pool(),
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
        config=config,
        artifact_id="2026-08-29T13:00:00Z",
    )
    for name, booster in baseline.bundle.estimators().items():
        assert booster.model_to_string() == (
            perturbed.bundle.estimators()[name].model_to_string()
        ), f"{name} saw the calibration window's labels"
    assert (
        perturbed.bundle.calibration.isotonic != baseline.bundle.calibration.isotonic
    ), "the calibration window's labels must reach the isotonic map"
    assert perturbed.bundle.conformal != baseline.bundle.conformal, (
        "the calibration window's labels must reach δ_lo and δ_hi too; those two "
        "and the isotonic map are the whole of what that window is used for"
    )


def _flipped_label(row: dict[str, Any]) -> dict[str, Any]:
    """One row's settled label, inverted and left coherent.

    A curtailed hour becomes a quiet one with zero MWh; a quiet hour becomes a
    curtailed one carrying a magnitude well above ``τ``. Unlabelled rows are
    passed through — an absence has nothing to invert.
    """
    if row["y_has_curtailment"] is None:
        return row
    if row["y_has_curtailment"]:
        return dict(
            row,
            y_has_curtailment=False,
            y_constrained_off_total_mwh=0.0,
            y_constrained_off_wind_mwh=0.0,
            y_constrained_off_solar_mwh=0.0,
            y_magnitude_mwh=None,
        )
    return dict(
        row,
        y_has_curtailment=True,
        y_constrained_off_total_mwh=40.0,
        y_constrained_off_wind_mwh=25.0,
        y_constrained_off_solar_mwh=15.0,
        y_magnitude_mwh=40.0,
    )


def test_a_calibration_block_with_no_settled_label_refuses(
    rows: list[dict[str, Any]], fold: Fold, blocks: FoldBlocks
) -> None:
    """An uncalibrated probability is not a probability this product may render."""
    blinded = [
        dict(row, y_constrained_off_total_mwh=None, y_has_curtailment=None)
        if blocks.calibration_start <= row["target_date"] <= blocks.calibration_end
        else row
        for row in rows
    ]
    with pytest.raises(ValueError, match="isotonic"):
        train_fold(
            blinded,
            fold=fold,
            blocks=blocks,
            function_definition=FUNCTION_DEFINITION,
            pool=out_of_fold_pool(),
            background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
            artifact_id="2026-08-29T11:00:00Z",
        )


# --- The clip: derived from evidence, and never an endpoint ------------------


def test_a_calibrated_probability_is_never_exactly_zero_or_one(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """Zero is forbidden twice over, and both reasons are load-bearing.

    It makes the composed quantile undefined at ``q = 1``, and it puts "0%" on a
    screen as a claim about tomorrow. The fixture's quiet hours drive the raw
    classifier hard towards zero, which is exactly the case that would otherwise
    produce one.
    """
    isotonic = trained.bundle.calibration.isotonic
    for hour in forecast_rows(trained.bundle, test_rows):
        probability = hour.forecast.occurrence_probability
        assert 0.0 < probability < 1.0
        assert isotonic.clip_lo <= probability <= isotonic.clip_hi
    assert isotonic.clip_lo <= isotonic(0.0)
    assert isotonic(1.0) <= isotonic.clip_hi
    # The clip binds where isotonic actually returns an endpoint, which it does
    # at both ends of any pool whose extreme blocks are one-sided — and the
    # extreme blocks of a curtailment classifier's output always are.
    endpoints = IsotonicCalibrator.fit(
        raw=[0.1, 0.2, 0.8, 0.9], observed=[False, False, True, True]
    )
    assert endpoints.knots_y[0] == 0.0
    assert endpoints.knots_y[-1] == 1.0
    assert endpoints(0.1) == endpoints.clip_lo
    assert endpoints(0.9) == endpoints.clip_hi
    assert endpoints(0.1) > 0.0 and endpoints(0.9) < 1.0


def test_the_clip_bounds_are_a_function_of_evidence_and_travel_in_the_bundle(
    trained: TrainedFold, volume_for_calibration: Any
) -> None:
    """``[1/(2n), 1 − 1/(2n)]`` — the Laplace-style bound, not a magic epsilon.

    Stored on the bundle rather than recomputed at call time, so a loaded
    artifact carries the bound it was written under, and written to the card
    under a name that says which count ``n`` is.
    """
    isotonic = trained.bundle.calibration.isotonic
    expected = 1.0 / (2.0 * trained.counts.calibration_labelled_rows)
    assert isotonic.clip_lo == expected
    assert isotonic.clip_hi == 1.0 - expected
    save_artifact(trained.bundle, trained.card, root=volume_for_calibration)
    loaded = load_artifact(
        root=volume_for_calibration,
        lane=trained.bundle.lane,
        artifact_id=trained.card.artifact_id,
    )
    assert loaded.bundle.calibration.isotonic == isotonic
    group = trained.card.to_dict()["calibration"]
    assert group["clip_lo"] == expected
    assert group["clip_hi"] == 1.0 - expected
    assert group["clip_basis"] == "calibration_labelled_rows"
    assert group["calibration_labelled_rows"] == isotonic.fitted_rows


def test_a_clip_that_does_not_match_its_row_count_is_refused() -> None:
    """The two are one fact. A bundle where they disagree cannot be served."""
    with pytest.raises(CalibrationError, match="function of evidence"):
        IsotonicCalibrator(
            knots_x=(0.0, 1.0),
            knots_y=(0.0, 1.0),
            clip_lo=0.001,
            clip_hi=0.999,
            fitted_rows=1_000,
        )


def test_the_map_is_monotone_and_never_extrapolated_past_its_knots() -> None:
    """Non-decreasing everywhere, and flat outside the outermost knot.

    The same convention `MagnitudeQuantiles` uses, for the same reason: a fit
    says nothing beyond its outermost knot, and a line drawn past one is an
    invented tail.
    """
    isotonic = IsotonicCalibrator.fit(
        raw=[0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
        observed=[False, True, False, True, True, True],
    )
    grid = [index / 200.0 for index in range(201)]
    values = [isotonic(point) for point in grid]
    assert all(later >= earlier for earlier, later in pairwise(values))
    assert isotonic(0.0) == isotonic(0.05)
    assert isotonic(0.7) == isotonic(1.0)


# --- The curve: pooled, out of fold, and disjoint from the fit ----------------


def test_the_curve_consumes_no_row_the_calibrator_was_fitted_on(
    trained: TrainedFold, blocks: FoldBlocks
) -> None:
    """The box this ticket makes checkable: disjoint, by construction and counted.

    The fixture pool deliberately contains a fold whose test period lands inside
    the calibration window — walk-forward folds are contiguous, so that is the
    normal case and not a contrived one. Those rows are dropped, the count is
    recorded, and the curve's own window is then outside the calibration window
    at both ends.
    """
    window = calibration_window(blocks)
    curve = curve_of(trained)
    assert curve.excluded_calibration_hours > 0
    assert curve.excluded_calibration_hours == 24 * 4 * (
        (PRIOR_INSIDE_CALIBRATION.test_end - PRIOR_INSIDE_CALIBRATION.test_start).days + 1
    )
    assert curve.window_end < window[0] or curve.window_start > window[1]
    assert curve.fold_ids == tuple(sorted(one.fold_id for one in PRIOR_FOLDS))
    kept, _ = outside_calibration_window(out_of_fold_pool(), window)
    for prediction in kept:
        assert not window[0] <= prediction.key.target_date <= window[1]


def test_a_pool_entirely_inside_the_calibration_window_refuses(
    blocks: FoldBlocks,
) -> None:
    """A curve over those rows would be a self-portrait of the fit."""
    pool = OutOfFoldPool.of(
        out_of_fold_predictions((PRIOR_INSIDE_CALIBRATION,)),
        segments=[PRIOR_INSIDE_CALIBRATION],
    )
    with pytest.raises(CalibrationError, match="self-portrait"):
        ReliabilityCurve.of(pool, calibration_window=calibration_window(blocks))


def test_a_prediction_outside_its_own_folds_test_period_is_not_out_of_fold() -> None:
    """ "Out of fold" is checked against the calendar, not taken on trust."""
    predictions = out_of_fold_predictions(PRIOR_FOLDS)
    stray = OutOfFoldPrediction(
        fold_id="P1",
        key=RowKey(target_date=date(2024, 12, 5), local_hour=3, subsystem="NE"),
        probability=0.4,
        observed=True,
    )
    with pytest.raises(CalibrationError, match="outside that fold's test period"):
        OutOfFoldPool.of([*predictions, stray], segments=list(PRIOR_FOLDS))
    unknown = OutOfFoldPrediction(
        fold_id="P9", key=stray.key, probability=0.4, observed=True
    )
    with pytest.raises(CalibrationError, match="not among the pooled segments"):
        OutOfFoldPool.of([unknown], segments=list(PRIOR_FOLDS))


def test_a_pool_that_straddles_go_live_refuses_rather_than_averaging() -> None:
    """Averaging is precisely how a caveat disappears.

    `pooled_fidelity` is the one reduction this codebase offers, and the pool
    goes through it rather than round it — so a curve cannot be labelled with a
    fidelity only half its rows have.
    """
    point_in_time = FoldSegment(
        fold_id="P2",
        row_id="P2",
        fidelity="point_in_time",
        test_start=PRIOR_FOLDS[1].test_start,
        test_end=PRIOR_FOLDS[1].test_end,
        is_split=False,
        fold_hash=PRIOR_FOLDS[1].fold_hash,
    )
    segments = [PRIOR_FOLDS[0], point_in_time]
    with pytest.raises(MixedFidelityError):
        OutOfFoldPool.of(
            out_of_fold_predictions((PRIOR_FOLDS[0], point_in_time)),
            segments=segments,
        )


def test_the_curve_carries_its_window_its_hours_and_its_fidelity(
    trained: TrainedFold,
) -> None:
    """A curve that cannot say what it is true over is a decoration."""
    curve = curve_of(trained)
    assert curve.sample_hours == sum(one.hour_count for one in curve.bins)
    assert curve.fidelity == "revision_optimistic"
    assert curve.window_start <= curve.window_end
    group = trained.card.to_dict()["calibration"]
    assert group["reliability_sample_hours"] == curve.sample_hours
    assert group["reliability_window"] == {
        "start": curve.window_start.isoformat(),
        "end": curve.window_end.isoformat(),
    }
    assert group["reliability_fidelity"] == "revision_optimistic"
    assert len(group["reliability"]) == len(curve.bins)


# --- Merges, and the scalars beside the curve --------------------------------


def _flat(counts: dict[float, int]) -> OutOfFoldPool:
    """A pool with an exact hour count at each named probability."""
    pairs: list[tuple[float, bool]] = []
    for probability, hours in counts.items():
        events = round(probability * hours)
        pairs.extend((probability, index < events) for index in range(hours))
    return pool_of(pairs)


def test_a_thin_bin_merges_upward_into_its_neighbour_and_the_merge_is_recorded() -> None:
    """`docs/specs/forecaster.md`: below 100 hours, merged upward, and recorded."""
    counts = {0.05: 500, 0.15: 50, 0.25: 200}
    counts.update({0.05 + index / 10.0: 150 for index in range(3, RELIABILITY_BINS)})
    curve = ReliabilityCurve.of(_flat(counts))
    assert all(one.hour_count >= MIN_BIN_HOURS for one in curve.bins)
    assert len(curve.merges) == 1
    merge = curve.merges[0]
    assert (merge.lower, merge.upper) == (0.1, 0.2)
    assert (merge.into_lower, merge.into_upper) == (0.2, 0.3)
    assert merge.direction == "up"
    assert merge.hour_count == 50
    merged = [one for one in curve.bins if one.merged]
    assert len(merged) == 1
    assert (merged[0].lower, merged[0].upper) == (0.1, 0.3)


def test_a_thin_top_bin_merges_downward_and_says_which_way_it_went() -> None:
    """The top bin has no upward, and a bin that is dropped silently is worse.

    The spec's rule says "merged upward"; the last bin is the one case where that
    is not a direction, so it merges down and the record carries which way it
    went rather than leaving a reader to infer it from the edges.
    """
    counts = {0.05 + index / 10.0: 150 for index in range(RELIABILITY_BINS - 1)}
    counts[0.95] = 50
    curve = ReliabilityCurve.of(_flat(counts))
    assert len(curve.merges) == 1
    merge = curve.merges[0]
    assert (merge.lower, merge.upper) == (0.9, 1.0)
    assert (merge.into_lower, merge.into_upper) == (0.8, 0.9)
    assert merge.direction == "down"
    assert curve.bins[-1].upper == 1.0
    assert curve.bins[-1].hour_count == 200


def test_ece_mce_and_the_top_bin_gap_are_stored_as_scalars_beside_the_curve(
    trained: TrainedFold,
) -> None:
    """Three numbers, and the third on its own because that is where it fails.

    The top-bin gap is signed: positive means the model said more than happened,
    which is the direction a curtailment classifier fails in and the direction
    the product's confident statements come from.
    """
    curve = curve_of(trained)
    weighted = sum(one.hour_count * abs(one.gap) for one in curve.bins)
    assert curve.ece == pytest.approx(weighted / curve.sample_hours)
    assert curve.mce == pytest.approx(max(abs(one.gap) for one in curve.bins))
    assert curve.mce >= curve.ece
    assert curve.top_bin_gap == pytest.approx(curve.bins[-1].gap)
    assert curve.bins[-1].upper == 1.0
    group = trained.card.to_dict()["calibration"]
    for name, value in (
        ("ece", curve.ece),
        ("mce", curve.mce),
        ("top_bin_gap", curve.top_bin_gap),
    ):
        assert group[name] == pytest.approx(value)
    assert group["reliability_merges"] == [
        merge.as_card_entry() for merge in curve.merges
    ]


# --- The risk classes --------------------------------------------------------


def test_the_risk_edges_satisfy_the_rule_that_chose_them(
    trained: TrainedFold,
) -> None:
    """(a), (b), the 5-point grid, and the tie-break, checked on the published pair.

    Searching the grid rather than rounding the winner onto it is what makes this
    assertion possible at all: rounding last can move an edge off a candidate
    that satisfied the rule onto one that does not.
    """
    decision = trained.bundle.calibration.risk_bins
    first, second = decision.bins.edges
    for edge in (first, second):
        assert round(edge / RISK_EDGE_STEP) * RISK_EDGE_STEP == pytest.approx(edge)
    assert decision.check.satisfies_a
    assert decision.check.satisfies_b
    assert decision.check.worst_gap <= MAX_RISK_BIN_GAP
    observed = decision.check.observed
    counts = decision.check.hour_counts
    for index in range(2):
        separation = abs(observed[index + 1] - observed[index])
        needed = wilson_half_width(
            round(observed[index] * counts[index]), counts[index]
        ) + wilson_half_width(
            round(observed[index + 1] * counts[index + 1]), counts[index + 1]
        )
        assert separation > needed
    assert all(count > 0 for count in counts)


def test_the_edges_are_written_to_the_card_and_are_what_the_bundle_holds(
    trained: TrainedFold,
) -> None:
    """The UI reads them from the API, so they are an artifact and not a style."""
    bins = trained.bundle.calibration.risk_bins.bins
    group = trained.card.to_dict()["calibration"]
    assert group["risk_bins"] == {
        "low": list(bins.low),
        "elevated": list(bins.elevated),
        "high": list(bins.high),
    }
    assert group["risk_bins_changed"] is False
    assert group["risk_bins_reason"]
    assert set(group["risk_bins_hour_counts"]) == {"low", "elevated", "high"}


def test_the_named_classes_cover_every_probability_exactly_once() -> None:
    """A gap is a probability with no class; an overlap is one with two."""
    bins = RiskBins.from_edges(0.25, 0.60)
    assert bins.lowest_edge == 0.25
    assert bins.classify(0.0) == "low"
    assert bins.classify(0.2499) == "low"
    assert bins.classify(0.25) == "elevated"
    assert bins.classify(0.5999) == "elevated"
    assert bins.classify(0.60) == "high"
    assert bins.classify(1.0) == "high"
    with pytest.raises(CalibrationError):
        RiskBins(low=(0.0, 0.3), elevated=(0.25, 0.6), high=(0.6, 1.0))
    with pytest.raises(CalibrationError):
        RiskBins.from_edges(0.6, 0.25)


def test_the_edges_are_held_stable_across_retrains_unless_the_rule_breaks(
    blocks: FoldBlocks,
) -> None:
    """A named class that moves weekly is worse than one three points off.

    Both halves in one test, because they are one rule: an incumbent that still
    satisfies (a) and (b) is kept *even when the rule would now prefer another*
    pair, and one that does not is replaced and the replacement says which
    condition forced it.
    """
    kept, _ = outside_calibration_window(out_of_fold_pool(), calibration_window(blocks))
    derived = derive_risk_bins(kept)
    assert derived.changed is False
    assert derived.incumbent is None

    incumbent = RiskBins.from_edges(0.25, 0.60)
    assert incumbent.edges != derived.bins.edges
    held = derive_risk_bins(kept, incumbent=incumbent)
    assert held.changed is False
    assert held.bins == incumbent
    assert "still satisfy" in held.reason

    # An incumbent whose lowest class swallows almost the whole pool: its two
    # upper classes are then too thin, or too close, to survive (b).
    broken = RiskBins.from_edges(0.90, 0.95)
    moved = derive_risk_bins(kept, incumbent=broken)
    assert moved.changed is True
    assert moved.bins.edges != broken.edges
    assert moved.incumbent == broken
    assert "no longer" in moved.reason
    assert moved.check.satisfied


def test_no_split_satisfying_the_rule_refuses_rather_than_inventing_edges() -> None:
    """Edges nobody measured would be a product claim with nothing behind it."""
    pool = pool_of([(0.5, index % 2 == 0) for index in range(2_000)])
    with pytest.raises(RiskBinsUndeterminedError, match="no split of this pool"):
        derive_risk_bins(list(pool.predictions))


def test_condition_b_uses_an_interval_that_stays_wide_on_one_sided_evidence() -> None:
    """Wald collapses to zero at ``f = 0``; Wilson does not, and (b) needs that.

    (b) asks whether two classes are far enough apart *relative to their
    uncertainty*. A half-width of zero would declare them distinguishable on no
    evidence at all, which is the failure the condition exists to prevent.
    """
    assert wilson_half_width(0, 50) > 0.0
    assert wilson_half_width(50, 50) > 0.0
    assert wilson_half_width(25, 50) > wilson_half_width(250, 500)
    with pytest.raises(CalibrationError):
        wilson_half_width(3, 0)


# --- Why isotonic, and not Platt ---------------------------------------------


def _platt(raw: list[float], observed: list[bool]) -> Any:
    """A two-parameter sigmoid in logit space, fitted by IRLS.

    Written here rather than in the service because nothing serves it: it exists
    to be the comparison the decision was made against, and a calibrator the
    product never uses does not belong in the bundle's module.
    """
    x = np.log(np.clip(np.asarray(raw), 1e-6, 1 - 1e-6))
    x = x - np.log1p(-np.clip(np.asarray(raw), 1e-6, 1 - 1e-6))
    design = np.column_stack([x, np.ones_like(x)])
    y = np.asarray(observed, dtype=np.float64)
    beta = np.zeros(2)
    for _ in range(50):
        eta = design @ beta
        mu = 1.0 / (1.0 + np.exp(-eta))
        weight = np.clip(mu * (1.0 - mu), 1e-9, None)
        working = eta + (y - mu) / weight
        scaled = design * weight[:, None]
        beta = np.linalg.solve(design.T @ scaled, scaled.T @ working)

    def apply(value: float) -> float:
        clipped = min(1 - 1e-6, max(1e-6, value))
        logit = math.log(clipped) - math.log1p(-clipped)
        return float(1.0 / (1.0 + math.exp(-(beta[0] * logit + beta[1]))))

    return apply


def _distorted(seed: int, rows: int) -> tuple[list[float], list[bool]]:
    """Well calibrated below 0.3, increasingly over-confident above it.

    The shape `docs/specs/forecaster.md` names: what a gradient-boosted
    classifier on an imbalanced target reliably produces, and what the
    prototype's own reliability fixture draws.
    """
    rng = random.Random(seed)  # noqa: S311 — a fixture, not a security decision
    raw: list[float] = []
    observed: list[bool] = []
    for _ in range(rows):
        value = rng.random()
        excess = max(0.0, value - 0.3)
        truth = value - 0.6 * excess * excess / 0.7
        raw.append(value)
        observed.append(rng.random() < truth)
    return raw, observed


def test_isotonic_beats_platt_where_a_boosted_classifier_actually_fails() -> None:
    """The test that records why isotonic was chosen, on a known distortion.

    Fitted on one half and measured on the other, because a calibrator scored on
    the rows it was fitted to flatters itself — which is the same reason the
    reliability curve is not computed on the calibration window.

    Three claims, and each is one the decision rested on: isotonic reduces ECE;
    it stays monotone, so it cannot reorder two hours; and it beats a
    two-parameter sigmoid **in the top bin**, which is where the distortion is
    and where the product's confident statements come from. A sigmoid cannot
    flatten the top without bending the bottom, because it has two parameters and
    this needs a shape.
    """
    raw, observed = _distorted(seed=20_260_829, rows=24_000)
    half = len(raw) // 2
    isotonic = IsotonicCalibrator.fit(raw[:half], observed[:half])
    platt = _platt(raw[:half], observed[:half])
    held_raw, held_observed = raw[half:], observed[half:]

    def curve(mapper: Any) -> ReliabilityCurve:
        return ReliabilityCurve.of(
            pool_of(
                [
                    (mapper(value), event)
                    for value, event in zip(held_raw, held_observed, strict=True)
                ]
            )
        )

    uncalibrated = ReliabilityCurve.of(
        pool_of(list(zip(held_raw, held_observed, strict=True)))
    )
    calibrated = curve(isotonic)
    sigmoid = curve(platt)

    assert calibrated.ece < uncalibrated.ece
    assert calibrated.mce < uncalibrated.mce
    grid = [index / 500.0 for index in range(501)]
    mapped = [isotonic(point) for point in grid]
    assert all(later >= earlier for earlier, later in pairwise(mapped))
    assert abs(calibrated.top_bin_gap) < abs(sigmoid.top_bin_gap)
    assert abs(uncalibrated.top_bin_gap) > 0.1


# --- One path to a band, and one bundle that refuses a partial calibration ----


def test_calibrating_p_does_not_create_a_second_path_to_a_band(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """Ticket 01 made the mixture inversion the only composition; it still is.

    The calibrated probability enters `compose` at the breakpoint and nowhere
    else, so the two properties that identify the inversion still hold hour by
    hour — and the calibration module holds no composition of its own to reach
    them by a second route.
    """
    source = inspect.getsource(calibration_module)
    for forbidden in ("compose(", "QuantileBand", "from wattsteer_ml.mixture"):
        assert forbidden not in source
    for hour in forecast_rows(trained.bundle, test_rows):
        probability = hour.forecast.occurrence_probability
        band = hour.forecast.band
        for quantile, value in ((0.10, band.p10), (0.50, band.p50), (0.90, band.p90)):
            if quantile <= 1.0 - probability:
                assert value == 0.0
            else:
                assert value > trained.bundle.threshold_mw


def test_the_served_probability_is_the_raw_output_put_through_the_map(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """One map, applied once. The raw score is never what reaches the screen."""
    from wattsteer_ml.training.design import FeatureBlock

    block = FeatureBlock.of(
        test_rows, trained.bundle.contract, threshold_mw=trained.bundle.threshold_mw
    )
    raw = np.clip(
        np.asarray(trained.bundle.occurrence.predict(block.matrix), dtype=np.float64),
        0.0,
        1.0,
    )
    isotonic = trained.bundle.calibration.isotonic
    served = [
        hour.forecast.occurrence_probability
        for hour in forecast_rows(trained.bundle, test_rows)
    ]
    assert served == [isotonic(float(value)) for value in raw]
    assert any(
        served[index] != pytest.approx(float(raw[index])) for index in range(len(served))
    ), "the fixture should contain an hour the calibration actually moves"


def test_a_bundle_whose_calibration_did_not_survive_the_load_is_refused(
    trained: TrainedFold, volume_for_calibration: Any
) -> None:
    """The same refusal the six estimators get, for the same reason.

    A bundle whose isotonic map came back as `None` would serve `p_raw` under a
    card that claims a calibrated probability — wrong in the one place the
    product renders a percentage and names a risk class from it.
    """
    bundle_path, _ = save_artifact(
        trained.bundle, trained.card, root=volume_for_calibration
    )
    partial = joblib.load(bundle_path)
    object.__setattr__(
        partial,
        "calibration",
        Calibration(
            isotonic=None,  # type: ignore[arg-type]
            reliability=trained.bundle.calibration.reliability,
            risk_bins=trained.bundle.calibration.risk_bins,
        ),
    )
    joblib.dump(partial, bundle_path)
    with pytest.raises(PartialBundleError, match="isotonic"):
        load_artifact(
            root=volume_for_calibration,
            lane=trained.bundle.lane,
            artifact_id=trained.card.artifact_id,
        )


def test_the_calibration_module_names_no_fold_and_materialises_no_calendar() -> None:
    """It is handed a checked pool; it does not go and build one."""
    source = inspect.getsource(calibration_module)
    for forbidden in ("materialize_fold_calendar", "blocks_for(", "FoldCalendar"):
        assert forbidden not in source
    assert "SEGMENTS" not in source
    assert len(SEGMENTS) == 3
