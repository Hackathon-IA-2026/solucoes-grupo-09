"""The P10 carries a coverage statement, and here is what that statement is.

`docs/specs/forecaster.md`, "Quantiles — quantile regression, conformalised",
and its Seam 4: "generate exchangeable data with a known conditional
distribution, fit deliberately mis-scaled quantile regressors, and assert the
conformalised interval's empirical coverage reaches nominal ± ε while the
uncorrected one does not."

Three kinds of assertion live here and the difference matters when reading them.

**Structural.** Which rows the correction is fitted on, that the two tails
cannot reach each other, that no conditional coverage number has a route back
into the correction, that the median comes through untouched, that a bundle
without a correction does not load. Fixtures cannot make those more or less
true.

**Synthetic, with a known answer.** ``test_conformalised_coverage_reaches_
nominal_on_exchangeable_data`` and its neighbours draw from a distribution this
file defines, so the right answer is known before the code runs. They are about
conformal, not about the Brazilian grid, and nothing in them may be read as a
claim about the served model.

**Measured on the shared fit.** The card's numbers, the calibration window's
in-sample coverage. The fixture's *values* are meaningless — the fold is seven
days of invented rows — and the assertions are about shape and about
inequalities that hold for any sample.

**One caveat this file does not hide.** The two pinball boosters and the
occurrence classifier are early-stopped on the calibration window, and the
isotonic map is fitted on it, so the composed band there is slightly closer to
the labels than it will be out of sample. That makes ``δ_lo`` and ``δ_hi``
slightly small and the published coverage slightly optimistic — the direction
forecaster ticket 04 predicted. No test here claims otherwise, and
``test_with_early_stopping_off_the_calibration_window_touches_nothing_but_the_map``
in `test_isotonic_calibration.py` is the configuration under which the booster
half of it is gone.
"""

from __future__ import annotations

import inspect
import json
import math
import random
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import joblib
import pytest

from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import Fold, FoldBlocks, RowKey
from wattsteer_ml.mixture import (
    SERVED_QUANTILES,
    MagnitudeQuantiles,
    QuantileBand,
    TailShift,
    compose,
    in_point_mass,
)
from wattsteer_ml.training import (
    COVERAGE_GUARDRAIL,
    NOMINAL_MISCOVERAGE,
    TARGET_COVERAGE,
    ConformalCorrection,
    ConformalError,
    CoverageReport,
    DeltaDrift,
    PartialBundleError,
    ScoredHour,
    TrainedFold,
    conformal_rank,
    conformalise,
    forecast_rows,
    load_artifact,
    lower_correction_fraction,
    minimum_calibration_rows,
    residuals,
    save_artifact,
    upper_correction_fraction,
)
from wattsteer_ml.training import conformal as conformal_module

#: ``τ`` for every synthetic fixture in this file. The same 5 MWh the lanes use,
#: named here so a reader does not have to go and find it.
THRESHOLD_MW = 5.0

#: Enough draws that a 0.90 coverage estimate has a standard error near 0.005,
#: so a ±0.02 tolerance is four standard errors and not a hopeful margin.
SYNTHETIC_ROWS = 3000

#: The tolerance the spec's "nominal ± ε" is spelt as here.
COVERAGE_TOLERANCE = 0.02


# --- Synthetic data with a known conditional distribution --------------------


def _rng(seed: int) -> random.Random:
    """A seeded generator. A fixture, not a security decision."""
    return random.Random(seed)  # noqa: S311 — a fixture, not a security decision


def _keys(count: int) -> list[RowKey]:
    """Distinct keys for ``count`` synthetic rows, cycling hours and subsystems.

    The correction never sees these — :meth:`ConformalCorrection.fit` takes two
    float sequences — but :class:`CoverageReport` conditions on them, so the
    synthetic rows have to spread across subsystems and hours for the
    conditional breakdown to have anything in it.
    """
    keys: list[RowKey] = []
    for index in range(count):
        keys.append(
            RowKey(
                target_date=date(2025, 1, 1)
                + timedelta(days=index // (24 * len(SUBSYSTEM_CODES))),
                local_hour=index % 24,
                subsystem=SUBSYSTEM_CODES[index % len(SUBSYSTEM_CODES)],
            )
        )
    return keys


def _draw(
    rng: random.Random,
    count: int,
    *,
    lower_scale: float,
    upper_scale: float,
    occurrence: float = 1.0,
) -> list[ScoredHour]:
    """Exchangeable rows from a lognormal magnitude, with mis-scaled regressors.

    The conditional distribution is known: ``y = τ + exp(N(μ(x), σ))`` with
    ``μ(x)`` a function of one covariate the "regressors" also see, so a
    correctly-scaled quantile regressor would be exactly right. The draws are
    i.i.d., which is the exchangeability the guarantee needs and the one the
    real series does not have.

    ``lower_scale`` and ``upper_scale`` are the deliberate misfit: at ``1.0``
    each regressor is the true conditional quantile, and away from it the
    interval is too narrow (``lower_scale > 1``, ``upper_scale < 1``) or too
    wide. Nothing about the misfit is estimated — it is imposed, so the test
    knows what conformal has to undo.
    """
    sigma = 0.6
    z_lo, z_50, z_hi = -1.2815515655446004, 0.0, 1.2815515655446004
    hours: list[ScoredHour] = []
    for key in _keys(count):
        mu = math.log(40.0) + 0.5 * rng.uniform(-1.0, 1.0)
        observed = THRESHOLD_MW + math.exp(rng.gauss(mu, sigma))
        true_lo = THRESHOLD_MW + math.exp(mu + z_lo * sigma)
        true_50 = THRESHOLD_MW + math.exp(mu + z_50 * sigma)
        true_hi = THRESHOLD_MW + math.exp(mu + z_hi * sigma)
        quantiles = MagnitudeQuantiles.from_boosters(
            q10=true_lo * lower_scale,
            q50=true_50,
            q90=true_hi * upper_scale,
        )
        hours.append(
            ScoredHour(
                key=key,
                forecast=compose(
                    occurrence_probability=occurrence,
                    positive_quantiles=quantiles,
                    positive_mean_mwh=true_50,
                    sub_threshold_mean_mwh=THRESHOLD_MW / 2.0,
                    threshold_mw=THRESHOLD_MW,
                ),
                observed_mwh=observed,
            )
        )
    return hours


def _recomposed(
    hours: list[ScoredHour], correction: ConformalCorrection
) -> list[ScoredHour]:
    """The same rows, composed again with the correction's shift on the mixture.

    Through :func:`wattsteer_ml.mixture.compose` and the correction's own
    :meth:`~wattsteer_ml.training.conformal.ConformalCorrection.shift`, because
    a test that added ``δ`` to a band by hand would be testing arithmetic this
    codebase deliberately does not contain.
    """
    corrected: list[ScoredHour] = []
    for hour in hours:
        mixture = hour.forecast.mixture
        assert isinstance(mixture.positive_quantiles, MagnitudeQuantiles)
        corrected.append(
            ScoredHour(
                key=hour.key,
                forecast=compose(
                    occurrence_probability=mixture.occurrence_probability,
                    positive_quantiles=mixture.positive_quantiles,
                    tail_shift=correction.shift(),
                    positive_mean_mwh=mixture.positive_mean_mwh,
                    sub_threshold_mean_mwh=mixture.sub_threshold_mean_mwh,
                    threshold_mw=mixture.threshold_mw,
                ),
                observed_mwh=hour.observed_mwh,
            )
        )
    return corrected


def _v1_knot_correction(
    quantiles: MagnitudeQuantiles, correction: ConformalCorrection
) -> MagnitudeQuantiles:
    """``conformal_v1_partial_upper``, reconstructed here and nowhere else.

    The regime forecaster ticket 21 replaced: ``δ`` applied to the *knots* of
    ``Q_pos``, floored at zero because ``MagnitudeQuantiles`` refuses a negative
    one. It is kept in this file — not in ``training/conformal.py``, which must
    have exactly one way of applying a correction — so that two claims can be
    *measured* rather than asserted from prose:

    - the realised share of ``δ_hi`` under v1 reproduces the table ticket 21
      opens with, so the "before" column is this repository's own arithmetic and
      not a remembered number; and
    - the served **P10** is bit-identical under v1 and v2, which is what "the
      lower tail did not move" has to mean.
    """
    low, mid, high = quantiles.values
    return MagnitudeQuantiles(
        values=(
            max(0.0, low - correction.delta_lo),
            mid,
            max(0.0, high + correction.delta_hi),
        )
    )


def _window() -> tuple[date, date]:
    return (date(2025, 1, 1), date(2025, 3, 31))


# --- Seam 4: the coverage a known answer says it should reach ----------------


def test_conformalised_coverage_reaches_nominal_on_exchangeable_data() -> None:
    """The spec's Seam 4, both halves: corrected reaches nominal, raw does not.

    The regressors are mis-scaled in the direction the weather research says the
    real ones will be — the interval too narrow at both ends — so the
    uncorrected band under-covers and conformal has to widen it. The data is
    i.i.d. and ``p = 1``, which isolates the magnitude interval: this is a test
    of the correction, not of the mixture's breakpoint.
    """
    rng = _rng(20260829)
    calibration = _draw(rng, SYNTHETIC_ROWS, lower_scale=1.45, upper_scale=0.65)
    evaluation = _draw(rng, SYNTHETIC_ROWS, lower_scale=1.45, upper_scale=0.65)

    raw = CoverageReport.of(evaluation, fold_id="synthetic-raw")
    assert raw.coverage_p10 < TARGET_COVERAGE - 4 * COVERAGE_TOLERANCE
    assert raw.coverage_p90 < TARGET_COVERAGE - 4 * COVERAGE_TOLERANCE

    correction = conformalise(calibration, window=_window())
    corrected = CoverageReport.of(
        _recomposed(evaluation, correction), fold_id="synthetic-conformalised"
    )
    assert abs(corrected.coverage_p10 - TARGET_COVERAGE) <= COVERAGE_TOLERANCE
    assert abs(corrected.coverage_p90 - TARGET_COVERAGE) <= COVERAGE_TOLERANCE
    assert corrected.upper_correction_realised == pytest.approx(1.0), (
        "at p = 1 the whole of δ_hi reaches the composed P90, which is what "
        "makes this a test of conformal rather than of the mixture"
    )


def test_at_a_low_occurrence_probability_the_upper_tail_reaches_nominal() -> None:
    """What forecaster ticket 21 changed, at the ``p`` where v1 did nothing.

    At ``p = 0.15`` the composed P90 is a positive number — ``0.90 > 1 − p`` —
    but under ``conformal_v1_partial_upper`` it sat at or below the *median*
    knot, so a shift of the 0.90 knot could not reach it and ``δ_hi`` was
    fitted, stored, published and inert. ``p ≤ 0.20`` is not an edge case; it is
    most hours on most days.

    The shift is now applied to the composed quantile, so the upper statement
    here reaches nominal like any other, and the fraction that says so is
    ``1.0``. This test is the reason the ticket was decided as a fix rather than
    as a footnote: a P90 short of its own residuals is a band too narrow at the
    top, and an operator sizing storage against it under-sizes.
    """
    rng = _rng(4242)
    calibration = _draw(
        rng, SYNTHETIC_ROWS, lower_scale=1.45, upper_scale=0.65, occurrence=0.15
    )
    evaluation = _draw(
        rng, SYNTHETIC_ROWS, lower_scale=1.45, upper_scale=0.65, occurrence=0.15
    )
    correction = conformalise(calibration, window=_window())
    assert correction.delta_hi > 0.0, "the residuals asked for a correction"

    raw = CoverageReport.of(evaluation, fold_id="synthetic-low-p-raw")
    assert raw.coverage_p90 < TARGET_COVERAGE - COVERAGE_TOLERANCE

    corrected = CoverageReport.of(
        _recomposed(evaluation, correction), fold_id="synthetic-low-p"
    )
    assert corrected.upper_correction_realised == pytest.approx(1.0)
    assert corrected.upper_correction_realised == upper_correction_fraction(0.15)
    assert abs(corrected.coverage_p90 - TARGET_COVERAGE) <= COVERAGE_TOLERANCE, (
        "δ_hi now reaches the composed P90 in full, so the upper statement is "
        "the coverage statement and not whatever the boosters happened to give"
    )
    # The floor at this p is structurally zero — 0.10 <= 1 - 0.15 — so the lower
    # statement is trivially satisfied and delta_lo is inert. That has not
    # changed and is not something this ticket set out to change.
    assert corrected.coverage_p10 == 1.0
    assert lower_correction_fraction(0.15) == 0.0


def test_conformal_narrows_a_band_that_was_too_wide() -> None:
    """Conformal makes coverage *equal* nominal, not at least nominal.

    The mirror of the test above, and the reason ``delta_lo`` is allowed to be
    negative. A band drawn far too wide over-covers, which is not free: the
    optimizer plans against the P10 and an interval that is honest only by being
    useless is a worse product, not a safer one.
    """
    rng = _rng(7)
    calibration = _draw(rng, SYNTHETIC_ROWS, lower_scale=0.4, upper_scale=2.5)
    evaluation = _draw(rng, SYNTHETIC_ROWS, lower_scale=0.4, upper_scale=2.5)

    raw = CoverageReport.of(evaluation, fold_id="synthetic-wide")
    assert raw.coverage_p10 > TARGET_COVERAGE + 4 * COVERAGE_TOLERANCE
    assert raw.coverage_p90 > TARGET_COVERAGE + 4 * COVERAGE_TOLERANCE

    correction = conformalise(calibration, window=_window())
    assert correction.delta_lo < 0.0, "an over-covering lower tail is corrected up"
    assert correction.delta_hi < 0.0
    corrected = CoverageReport.of(
        _recomposed(evaluation, correction), fold_id="synthetic-narrowed"
    )
    assert abs(corrected.coverage_p10 - TARGET_COVERAGE) <= COVERAGE_TOLERANCE
    assert abs(corrected.coverage_p90 - TARGET_COVERAGE) <= COVERAGE_TOLERANCE


#: The knots every application-point test in this file composes from. Wide
#: enough apart that the interpolant has room to attenuate a shift, and far
#: enough above ``τ`` that the mixture's floor into ``F_pos``'s support never
#: bites and so never flatters the measurement.
_KNOTS = MagnitudeQuantiles.from_boosters(q10=60.0, q50=90.0, q90=140.0)

#: The ``p`` grid the realised-fraction table is measured on. Its first five
#: rows are the ones forecaster ticket 21 tabulates; ``0.15`` is the band the
#: ticket collapses into "0.20 and below" and where the fix does its work; the
#: last three are at and below the mixture's own breakpoint, where zero is the
#: right answer.
_PROBABILITY_GRID = (1.00, 0.90, 0.50, 0.30, 0.20, 0.15, 0.10, 0.05)


def _composed_p90(
    quantiles: MagnitudeQuantiles,
    *,
    probability: float,
    tail_shift: TailShift | None = None,
) -> float:
    """One hour's served P90, composed the only way this codebase composes."""
    return compose(
        occurrence_probability=probability,
        positive_quantiles=quantiles,
        tail_shift=tail_shift,
        positive_mean_mwh=95.0,
        sub_threshold_mean_mwh=1.0,
        threshold_mw=THRESHOLD_MW,
    ).band.p90


def _correction(*, delta_lo: float, delta_hi: float) -> ConformalCorrection:
    return ConformalCorrection(
        delta_lo=delta_lo,
        delta_hi=delta_hi,
        calibration_rows=100,
        rank=conformal_rank(100),
        miscoverage=NOMINAL_MISCOVERAGE,
        window_start=_window()[0],
        window_end=_window()[1],
    )


def test_the_lower_tail_is_corrected_exactly_at_every_occurrence_probability() -> None:
    """``Q_Y(0.10)`` moves by exactly ``δ_lo`` wherever it is a positive number.

    The property the module docstring claims, and the tail the product promises
    in prose. It held under ``conformal_v1_partial_upper`` and it holds now —
    the next test is the one that proves the two agree to the bit.
    """
    correction = _correction(delta_lo=7.5, delta_hi=3.0)
    for probability in (0.91, 0.95, 0.99, 1.0):
        before = compose(
            occurrence_probability=probability,
            positive_quantiles=_KNOTS,
            positive_mean_mwh=95.0,
            sub_threshold_mean_mwh=1.0,
            threshold_mw=THRESHOLD_MW,
        )
        after = compose(
            occurrence_probability=probability,
            positive_quantiles=_KNOTS,
            tail_shift=correction.shift(),
            positive_mean_mwh=95.0,
            sub_threshold_mean_mwh=1.0,
            threshold_mw=THRESHOLD_MW,
        )
        assert before.band.p10 - after.band.p10 == pytest.approx(
            correction.delta_lo, abs=1e-9
        )
        assert lower_correction_fraction(probability) == 1.0


def test_moving_the_correction_did_not_move_the_floor() -> None:
    """The served P10 is **bit-identical** under v1 and v2, at every ``p``.

    Forecaster ticket 21's hard constraint. The floor is the number the product
    quotes, the optimizer plans against and `docs/specs/flex-optimizer.md`
    builds a promise on; a fix to the ceiling that shifted it by a rounding
    error would be a regression dressed as an improvement.

    It is exact rather than approximate for a reason that is worth stating: for
    ``p > 0.90`` composition reads ``Q_pos`` at ``u_lo = 1 − 0.9/p ≤ 0.10``,
    where the interpolant is flat and returns the 0.10 knot itself. v1 shifted
    that knot; v2 adds the same scalar to the same value after reading it. The
    two are the same float operations in the other order, and the zero-floor v1
    applied to the knot is subsumed by the floor into ``F_pos``'s support that
    both apply afterwards. Below ``p = 0.90`` both are the structural zero.

    ``δ_hi`` is deliberately large here: the claim is that *the upper tail's
    correction cannot reach the lower edge*, which is the same independence
    ``fit`` guarantees, asserted on the served number rather than on the fit.
    """
    correction = _correction(delta_lo=7.5, delta_hi=40.0)
    for probability in (*_PROBABILITY_GRID, 0.95, 0.99, 0.91, 0.9001):
        v1 = compose(
            occurrence_probability=probability,
            positive_quantiles=_v1_knot_correction(_KNOTS, correction),
            positive_mean_mwh=95.0,
            sub_threshold_mean_mwh=1.0,
            threshold_mw=THRESHOLD_MW,
        ).band.p10
        v2 = compose(
            occurrence_probability=probability,
            positive_quantiles=_KNOTS,
            tail_shift=correction.shift(),
            positive_mean_mwh=95.0,
            sub_threshold_mean_mwh=1.0,
            threshold_mw=THRESHOLD_MW,
        ).band.p10
        assert v2 == v1, f"the floor moved at p = {probability}"
        if in_point_mass(SERVED_QUANTILES[0], probability):
            assert v2 == 0.0


def test_the_realised_share_of_delta_hi_is_one_wherever_the_p90_is_positive() -> None:
    """The table forecaster ticket 21 opens with, and the table it closes with.

    Both columns are measured here from this repository's own composition, so
    the "before" is not a remembered number and the "after" is not a claim.

    ======  ==========  ==========
    ``p``   v1 (knots)  v2 (composed)
    ======  ==========  ==========
    1.00    1.000       1.000
    0.90    0.972       1.000
    0.50    0.750       1.000
    0.30    0.417       1.000
    0.20    0.000       1.000
    0.15    0.000       1.000
    0.10    0.000       0.000
    0.05    0.000       0.000
    ======  ==========  ==========

    The last two rows are the ones that must stay zero. There ``0.90 ≤ 1 − p``,
    so ``Q_Y(0.90)`` is the mixture's point mass and the served P90 is exactly
    zero — the model saying there is at least a 90% chance of no curtailment.
    Correcting *that* upward would invent curtailment the mixture denies, and it
    would do it in the hours the classifier is most confident about. The defect
    ticket 21 fixed was the positive edge, not the structural zero, and the two
    are distinguished here rather than in prose.

    ``δ_lo`` is zero so the measurement is of ``δ_hi`` alone: under v1 the
    composed P90 at a low ``p`` is read off the segment between the 0.10 and
    0.50 knots and would otherwise inherit the lower correction, which is the
    interpolant and not the quantity being tabulated.
    """
    correction = _correction(delta_lo=0.0, delta_hi=20.0)
    expected_v1 = {
        1.00: 1.0,
        0.90: 0.9722222222222223,
        0.50: 0.75,
        0.30: 0.41666666666666663,
        0.20: 0.0,
        0.15: 0.0,
        0.10: 0.0,
        0.05: 0.0,
    }
    for probability in _PROBABILITY_GRID:
        uncorrected = _composed_p90(_KNOTS, probability=probability)
        v1 = _composed_p90(
            _v1_knot_correction(_KNOTS, correction), probability=probability
        )
        v2 = _composed_p90(_KNOTS, probability=probability, tail_shift=correction.shift())
        assert (v1 - uncorrected) / correction.delta_hi == pytest.approx(
            expected_v1[probability], abs=1e-9
        ), f"the v1 column of the ticket's table does not reproduce at {probability}"
        realised = (v2 - uncorrected) / correction.delta_hi
        assert realised == pytest.approx(
            upper_correction_fraction(probability), abs=1e-12
        )
        assert realised == pytest.approx(
            0.0 if in_point_mass(SERVED_QUANTILES[2], probability) else 1.0, abs=1e-12
        )


def test_the_structural_zero_survives_a_correction_that_dwarfs_the_band() -> None:
    """``Q_Y(q) = 0`` for ``q ≤ 1 − p``, and no shift is ever added to it.

    The half of the "0% at low ``p``" that was always **correct** and had to
    stay: at ``p ≤ 0.10`` the served P90 is zero because nine hours in ten are
    expected to be quiet, and at ``p ≤ 0.90`` the served P10 is zero for the
    same reason. The shift is added inside the positive branch, so it cannot
    reach either — asserted with a ``δ`` two orders of magnitude larger than the
    band, which is the only way to tell "preserved" apart from "too small to
    see".
    """
    shift = TailShift(lower_mwh=-5_000.0, upper_mwh=5_000.0)
    for probability in (0.0, 0.001, 0.05, 0.10):
        assert _composed_p90(_KNOTS, probability=probability, tail_shift=shift) == 0.0
    for probability in (0.0, 0.05, 0.50, 0.85):
        band = compose(
            occurrence_probability=probability,
            positive_quantiles=_KNOTS,
            tail_shift=shift,
            positive_mean_mwh=95.0,
            sub_threshold_mean_mwh=1.0,
            threshold_mw=THRESHOLD_MW,
        ).band
        assert band.p10 == 0.0


# --- The two tails are independent -------------------------------------------


def test_perturbing_only_the_upper_tail_leaves_delta_lo_unchanged() -> None:
    """The acceptance criterion, and the reason for two scalars instead of one.

    A symmetric correction would let a badly-fitted upper tail spend the budget
    the lower tail needs. Here the upper residuals are moved by two orders of
    magnitude and ``δ_lo`` does not move at all — not approximately, exactly,
    because the two are separate order statistics over separate sequences.
    """
    lower = [float(value) for value in range(50)]
    upper = [float(value) for value in range(50)]
    baseline = ConformalCorrection.fit(
        lower_residuals=lower, upper_residuals=upper, window=_window()
    )
    perturbed = ConformalCorrection.fit(
        lower_residuals=lower,
        upper_residuals=[value * 100.0 + 7.0 for value in upper],
        window=_window(),
    )
    assert perturbed.delta_lo == baseline.delta_lo
    assert perturbed.delta_hi != baseline.delta_hi


def test_the_fit_never_sees_a_key_to_condition_on() -> None:
    """Correct marginally, report conditionally — as a property of the source.

    The spec's asymmetry is easy to state and easy to erode: a future session
    that wanted per-hour coverage to improve could reach for a per-hour
    correction and the diff would look reasonable. It cannot happen through this
    signature, and this test is what says so out loud.
    """
    source = _without_docstring(inspect.getsource(ConformalCorrection.fit))
    for forbidden in ("subsystem", "local_hour", "RowKey", "key", "CoverageReport"):
        assert forbidden not in source, (
            f"ConformalCorrection.fit mentions {forbidden!r}; the correction is "
            "global and has nothing to condition on"
        )
    parameters = inspect.signature(ConformalCorrection.fit).parameters
    assert set(parameters) == {
        "lower_residuals",
        "upper_residuals",
        "window",
        "miscoverage",
    }


def test_nothing_in_the_module_builds_a_band_of_its_own() -> None:
    """Ticket 01's invariant, still true after a correction was added.

    The mixture inversion is the only composition. This module maps one
    ``MagnitudeQuantiles`` to another and stops; it never constructs a
    ``QuantileBand``, never calls ``compose``, and never adds a scalar to a
    composed quantile.
    """
    source = _without_docstring(inspect.getsource(conformal_module))
    for forbidden in ("QuantileBand(", "compose(", "HurdleMixture("):
        assert forbidden not in source, (
            f"training/conformal.py contains {forbidden!r}, which is a second "
            "route from a scalar to a served interval"
        )


def test_the_service_still_has_exactly_one_composition() -> None:
    """One ``compose(...)`` call site in the whole service, correction or not.

    ``mixture.py`` defines it; exactly one other module may call it. Ticket 01
    bought that and adding a correction is not allowed to spend it.
    """
    root = Path(inspect.getfile(conformal_module)).parents[1]
    call_sites = sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*.py")
        if any(
            "compose(" in line and not line.lstrip().startswith("def ")
            for line in path.read_text(encoding="utf-8").splitlines()
        )
    )
    assert call_sites == ["training/hurdle.py"], (
        "the composition is imported by training, serving, fold evaluation and "
        "Replay, and called in one place"
    )


def _without_docstring(source: str) -> str:
    """The code of a function or module, with its own prose removed.

    These assertions are about what the code *does*, and the docstrings here
    explain at length what it deliberately does not do — which is exactly the
    vocabulary a naive grep would trip over.
    """
    parts = source.split('"""')
    return parts[0] + "".join(parts[2::2]) if len(parts) > 2 else source


# --- The median is not corrected ---------------------------------------------


def test_the_median_comes_through_untouched() -> None:
    """A median has no interval to cover, so it gets no correction.

    Under ``conformal_v1_partial_upper`` this was a property of
    ``ConformalCorrection.apply``, which copied the 0.50 knot through. It is now
    a property of the shift itself: :class:`~wattsteer_ml.mixture.TailShift` is
    zero at ``q = 0.50``, so the served P50 is the uncorrected composition at
    every ``p``, and the two ``δ`` reach the shape of the correction on either
    side of it without ever meeting at the middle.

    Its guardrail is ``p50_unbiasedness`` — the share of observations below P50,
    target 0.50 — and that is reported instead.
    """
    correction = _correction(delta_lo=11.0, delta_hi=23.0)
    shift = correction.shift()
    assert shift(SERVED_QUANTILES[1]) == 0.0
    assert shift(SERVED_QUANTILES[0]) == -11.0
    assert shift(SERVED_QUANTILES[2]) == 23.0
    # Flat outside the served quantiles, for the reason MagnitudeQuantiles is:
    # nothing was fitted past them and a line drawn beyond one is invented.
    assert shift(0.0) == shift(0.05) == -11.0
    assert shift(0.95) == shift(1.0) == 23.0

    for probability in (0.3, 0.51, 0.75, 1.0):
        kwargs: dict[str, Any] = {
            "occurrence_probability": probability,
            "positive_quantiles": _KNOTS,
            "positive_mean_mwh": 95.0,
            "sub_threshold_mean_mwh": 1.0,
            "threshold_mw": THRESHOLD_MW,
        }
        assert compose(**kwargs, tail_shift=shift).band.p50 == compose(**kwargs).band.p50


def test_p50_unbiasedness_finds_a_correct_median_and_a_wrong_one() -> None:
    """The guardrail has to be able to fail, or it is decoration."""
    rng = _rng(11)
    honest = CoverageReport.of(
        _draw(rng, SYNTHETIC_ROWS, lower_scale=1.0, upper_scale=1.0),
        fold_id="synthetic-median",
    )
    assert abs(honest.p50_unbiasedness - 0.5) <= COVERAGE_TOLERANCE

    skewed = [
        replace(hour, observed_mwh=hour.observed_mwh * 1.9)
        for hour in _draw(rng, SYNTHETIC_ROWS, lower_scale=1.0, upper_scale=1.0)
    ]
    assert CoverageReport.of(skewed, fold_id="synthetic-skewed").p50_unbiasedness < 0.2


# --- What the order statistic is, and when it cannot be taken ----------------


def test_the_rank_is_the_specs_order_statistic() -> None:
    """``⌈(n + 1)(1 − α)⌉``, including at the ``n`` where float arithmetic bites."""
    assert conformal_rank(9) == 9
    assert conformal_rank(19) == 18
    assert conformal_rank(99) == 90
    assert conformal_rank(100) == 91
    assert minimum_calibration_rows() == 9
    assert minimum_calibration_rows(0.2) == 4


def test_too_few_curtailed_hours_refuse_rather_than_widen() -> None:
    """Split conformal's honest answer below the floor is ``+∞``; this refuses.

    An unbounded band is not something the product can render, and quietly
    taking the largest residual instead would publish a 90% claim backed by
    eight observations.
    """
    with pytest.raises(ConformalError, match="at least 9"):
        ConformalCorrection.fit(
            lower_residuals=[1.0] * 8, upper_residuals=[1.0] * 8, window=_window()
        )


def test_residuals_are_taken_over_curtailed_hours_only() -> None:
    """``Q_pos`` is conditional on ``Y > τ``; a quiet hour is not a test of it."""
    rng = _rng(3)
    hours = _draw(rng, 40, lower_scale=1.0, upper_scale=1.0)
    quiet = [replace(hour, observed_mwh=0.0) for hour in hours[:20]]
    lower, upper = residuals(quiet + hours[20:])
    assert len(lower) == len(upper) == 20


# --- What the shared fit produces --------------------------------------------


def test_the_correction_is_fitted_on_the_calibration_window(
    trained: TrainedFold, blocks: FoldBlocks
) -> None:
    """The window, the count and the rank, all as stored on the artifact."""
    correction = trained.bundle.conformal
    assert correction.window_start == blocks.calibration_start
    assert correction.window_end == blocks.calibration_end
    assert correction.miscoverage == NOMINAL_MISCOVERAGE
    assert correction.rank == conformal_rank(correction.calibration_rows)
    assert correction.calibration_rows <= trained.counts.calibration_positive_rows
    assert trained.card.conformal == correction


def test_in_sample_lower_coverage_is_at_least_the_order_statistics_share(
    trained: TrainedFold, rows: list[dict[str, Any]], blocks: FoldBlocks
) -> None:
    """The one coverage inequality that holds for any sample, checked here.

    On the window the correction was fitted on, ``#{E_lo ≤ δ_lo} = rank`` by the
    definition of the order statistic, and the composed P10 moves by exactly
    ``δ_lo`` wherever it is in the positive branch and stays at zero — covering
    trivially — wherever it is not. So in-sample lower coverage is at least
    ``rank / n``. It is *not* evidence about the test fold: the boosters were
    early-stopped here and the isotonic map was fitted here, so this window is
    the optimistic one.
    """
    correction = trained.bundle.conformal
    window = [
        row
        for row in rows
        if blocks.calibration_start <= row["target_date"] <= blocks.calibration_end
    ]
    scored = [
        ScoredHour(
            key=hour.key,
            forecast=hour.forecast,
            observed_mwh=float(row["y_constrained_off_total_mwh"]),
        )
        for hour, row in zip(forecast_rows(trained.bundle, window), window, strict=True)
        if row["y_constrained_off_total_mwh"] is not None
    ]
    report = CoverageReport.of(scored, fold_id="calibration-window")
    assert report.rows == correction.calibration_rows
    assert report.coverage_p10 >= correction.rank / correction.calibration_rows


def test_the_card_publishes_both_deltas_and_coverage_three_ways(
    trained: TrainedFold,
) -> None:
    """The card's Quantiles group: ``δ_lo``, ``δ_hi``, coverage, ``crossing_rate``.

    Round-tripped through JSON because that is the form an auditor reads, and a
    number that does not survive ``json.dumps`` is not published.
    """
    card = json.loads(trained.card.to_json())
    quantiles = card["quantiles"]
    assert quantiles["delta_lo"] == trained.bundle.conformal.delta_lo
    assert quantiles["delta_hi"] == trained.bundle.conformal.delta_hi
    assert quantiles["conformal_window"]["start"] == (
        trained.bundle.conformal.window_start.isoformat()
    )
    assert quantiles["coverage_target"] == TARGET_COVERAGE
    assert quantiles["coverage_guardrail"] == list(COVERAGE_GUARDRAIL)
    assert quantiles["coverage_population"] == "curtailed_hours"
    assert quantiles["coverage_by_subsystem"], "per-subsystem coverage is reported"
    assert quantiles["coverage_by_local_hour"], "per-local-hour coverage is reported"
    assert "p50_unbiasedness" in quantiles
    assert "crossing_rate" in quantiles
    assert 0.0 <= quantiles["upper_correction_realised"] <= 1.0
    assert "under-application" in quantiles["upper_correction_note"]
    assert "never corrected" in quantiles["coverage_conditional_use"]
    assert "approximate" in quantiles["conformal_guarantee"]


def test_a_fold_whose_coverage_cannot_be_measured_says_so_rather_than_zero(
    trained: TrainedFold,
) -> None:
    """Absent, and absent for a reason. A row of zeros would read as failure."""
    card = json.loads(replace(trained.card, coverage=None).to_json())
    assert card["quantiles"]["coverage"] is None
    assert "no curtailed hour" in card["quantiles"]["coverage_absent_reason"]


def test_a_bundle_without_a_correction_fails_to_load(
    trained: TrainedFold, tmp_path: Path
) -> None:
    """A band served with no measured correction is three outputs and a promise.

    ``joblib.load`` reconstructs without running ``__init__``, so the loader
    re-checks the correction as closely as it re-checks the six estimators.
    """
    root = tmp_path / "models"
    root.mkdir()
    bundle_path, _ = save_artifact(trained.bundle, trained.card, root=root)
    partial = joblib.load(bundle_path)
    object.__setattr__(partial, "conformal", None)
    joblib.dump(partial, bundle_path)
    with pytest.raises(PartialBundleError, match="conformal"):
        load_artifact(
            root=root, lane=trained.bundle.lane, artifact_id=trained.card.artifact_id
        )


def test_a_served_band_is_never_the_uncorrected_one(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """Serving applies the correction, and the band it produces is still monotone."""
    correction = trained.bundle.conformal
    uncorrected = ConformalCorrection(
        delta_lo=0.0,
        delta_hi=0.0,
        calibration_rows=correction.calibration_rows,
        rank=correction.rank,
        miscoverage=correction.miscoverage,
        window_start=correction.window_start,
        window_end=correction.window_end,
    )
    blank = replace(trained.bundle, conformal=uncorrected)
    served = forecast_rows(trained.bundle, test_rows)
    plain = forecast_rows(blank, test_rows)
    assert any(
        one.forecast.band != other.forecast.band
        for one, other in zip(served, plain, strict=True)
    ), "the correction reaches the served band"
    for hour in served:
        assert isinstance(hour.forecast.band, QuantileBand)
        assert hour.forecast.band.p10 <= hour.forecast.band.p50
        assert hour.forecast.band.p50 <= hour.forecast.band.p90
        assert hour.forecast.band.p10 >= 0.0


# --- The drift hook reports and does not adapt -------------------------------


def test_delta_drift_reports_the_signal_and_changes_nothing() -> None:
    """`docs/specs/forecaster.md` names the signal and names the response.

    A growing ``δ_lo`` means the boosters' intervals are drifting narrow and
    split conformal's exchangeability assumption is failing. The response is
    adaptive conformal, which is **not built**: this class has no field, method
    or output that changes a correction, and its own report says so.
    """
    corrections = {
        fold: ConformalCorrection(
            delta_lo=value,
            delta_hi=2.0,
            calibration_rows=100,
            rank=conformal_rank(100),
            miscoverage=NOMINAL_MISCOVERAGE,
            window_start=_window()[0],
            window_end=_window()[1],
        )
        for fold, value in (("F1", 1.0), ("F2", 3.0), ("F3", 9.0))
    }
    drift = DeltaDrift.across(corrections)
    assert drift.fold_ids == ("F1", "F2", "F3")
    assert drift.lower_drift == 8.0
    assert drift.upper_drift == 0.0
    assert drift.lower_monotone_increasing
    assert "not built" in drift.as_dict()["response"]

    source = inspect.getsource(DeltaDrift)
    assert "ConformalCorrection(" not in source, "the hook must not mint a correction"
    for banned in ("adapt(", "update(", "target_level"):
        assert banned not in source


def test_delta_drift_keeps_the_walk_forward_order_rather_than_sorting() -> None:
    """``F10`` is not the second fold, and a lexicographic sort would say it is."""
    correction = ConformalCorrection(
        delta_lo=1.0,
        delta_hi=1.0,
        calibration_rows=100,
        rank=conformal_rank(100),
        miscoverage=NOMINAL_MISCOVERAGE,
        window_start=_window()[0],
        window_end=_window()[1],
    )
    drift = DeltaDrift.across({"F9": correction, "F10": correction})
    assert drift.fold_ids == ("F9", "F10")


def test_the_coverage_report_names_the_fold_it_is_true_of(
    trained: TrainedFold, fold: Fold
) -> None:
    """Per fold, and the fold is on the object rather than in the caller's head."""
    coverage = trained.card.coverage
    assert coverage is not None
    assert coverage.fold_id == fold.id
    assert coverage.rows > 0
    assert {cell.label for cell in coverage.by_subsystem} <= set(SUBSYSTEM_CODES)
    assert all(0 <= int(cell.label) < 24 for cell in coverage.by_local_hour)
    assert sum(cell.rows for cell in coverage.by_subsystem) == coverage.rows
    assert sum(cell.rows for cell in coverage.by_local_hour) == coverage.rows
