"""Seam 1 — the composition, as arithmetic.

``docs/specs/forecaster.md`` names this the test that should survive if only one
test survives. It is fixture-driven on purpose: no model, no features, no
database, so a failure here is a failure of the mixture inversion and of nothing
else.

The assertions are *properties of a distribution* rather than "the function
returned a float": ``Q_Y`` is zero exactly on the sub-threshold regime, is
non-decreasing everywhere, and exceeds ``τ`` off that regime; the expectation is
the mixture formula exactly and never sits below the median it is published
beside.

Several of these properties are structural — :class:`QuantileBand` cannot hold a
crossing band, :class:`TechnologySplit` cannot hold a quantile — and the tests
here check that the *structure* is the thing enforcing them, by asserting the
constructor raises rather than by asserting a value came out sorted.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from wattsteer_ml import mixture as mixture_module
from wattsteer_ml.constants import SUBSYSTEM_THRESHOLD_MW
from wattsteer_ml.mixture import (
    SERVED_QUANTILES,
    ComposedForecast,
    HurdleMixture,
    MagnitudeQuantiles,
    QuantileBand,
    TechnologySplit,
    compose,
    crossing_rate,
)

# τ = 5 MWh at subsystem grain. Read from the published constants so the fixture
# and the product agree about what the default is — but passed *in* to every
# composition below, never reached for from inside it.
TAU = float(SUBSYSTEM_THRESHOLD_MW)

#: A well-behaved magnitude fit: rises with the alpha, comfortably above τ.
POSITIVE = MagnitudeQuantiles.from_boosters(q10=40.0, q50=90.0, q90=200.0)

#: A dense sweep of q, including both served endpoints and the exact
#: breakpoints ``1 − p`` used below.
Q_SWEEP = [i / 200.0 for i in range(201)]


def composed(
    p: float,
    *,
    positive: MagnitudeQuantiles = POSITIVE,
    positive_mean_mwh: float = 120.0,
    sub_threshold_mean_mwh: float = 1.4,
    threshold_mw: float = TAU,
    wind_share: float | None = None,
) -> ComposedForecast:
    """One hour of forecast, with only the interesting argument at the call."""
    return compose(
        occurrence_probability=p,
        positive_quantiles=positive,
        positive_mean_mwh=positive_mean_mwh,
        sub_threshold_mean_mwh=sub_threshold_mean_mwh,
        threshold_mw=threshold_mw,
        wind_share=wind_share,
    )


# --- Q_Y is zero exactly on the sub-threshold regime --------------------------


@pytest.mark.parametrize("p", [0.0, 0.05, 0.1, 0.37, 0.5, 0.9, 0.95, 1.0])
def test_quantile_is_zero_below_the_breakpoint_and_only_there(p: float) -> None:
    """``Q_Y(q) = 0`` for every ``q ≤ 1 − p`` — and *only* then."""
    mixture = composed(p).mixture
    for q in Q_SWEEP:
        value = mixture.quantile(q)
        if q <= 1.0 - p:
            assert value == 0.0, f"q={q} is in the sub-threshold regime"
        else:
            assert value > 0.0, f"q={q} is above the breakpoint"


@pytest.mark.parametrize("p", [0.05, 0.37, 0.5, 0.9, 1.0])
def test_quantile_exceeds_tau_above_the_breakpoint(p: float) -> None:
    """``Q_Y(q) > τ`` whenever ``q > 1 − p``.

    The positive branch is a quantile of ``Y | Y > τ``, so anything it returns
    is a claim that the hour is above the threshold; a value inside ``[0, τ]``
    would be the band contradicting the regime the arithmetic put it in.
    """
    mixture = composed(p).mixture
    for q in Q_SWEEP:
        if q > 1.0 - p:
            assert mixture.quantile(q) > TAU


def test_a_magnitude_fit_below_tau_is_still_above_tau_after_composition() -> None:
    """The support floor holds even when the boosters undershoot the threshold."""
    undershooting = MagnitudeQuantiles.from_boosters(q10=0.0, q50=2.0, q90=4.0)
    mixture = composed(0.99, positive=undershooting).mixture
    for q in Q_SWEEP:
        if q > 0.01:
            assert mixture.quantile(q) > TAU


# --- monotonicity ------------------------------------------------------------


@pytest.mark.parametrize("p", [0.0, 0.01, 0.2, 0.5, 0.75, 0.9, 0.99, 1.0])
def test_quantile_is_non_decreasing_in_q(p: float) -> None:
    mixture = composed(p).mixture
    values = [mixture.quantile(q) for q in Q_SWEEP]
    assert values == sorted(values)


def test_a_band_cannot_be_constructed_out_of_order() -> None:
    """Monotonicity is structural: the type refuses to hold a crossing band.

    The mirror of ``band()`` in ``packages/core/src/domain.ts``, which raises on
    the same condition.
    """
    with pytest.raises(ValueError, match="out of order"):
        QuantileBand(p10=10.0, p50=5.0, p90=20.0)
    with pytest.raises(ValueError, match="out of order"):
        QuantileBand(p10=1.0, p50=5.0, p90=4.0)


# --- crossing is sorted, and counted -----------------------------------------


def test_crossing_boosters_are_sorted_after_composition_and_reported() -> None:
    """Independently-fitted boosters cross; the band is sorted and says so."""
    crossing = MagnitudeQuantiles.from_boosters(q10=140.0, q50=90.0, q90=200.0)
    assert crossing.crosses

    forecast = composed(1.0, positive=crossing)
    assert forecast.crossed is True
    assert forecast.band.p10 == 90.0  # P10 ← min
    assert forecast.band.p50 == 140.0
    assert forecast.band.p90 == 200.0  # P90 ← max
    assert forecast.band.p10 <= forecast.band.p50 <= forecast.band.p90


def test_a_well_ordered_fit_is_not_reported_as_crossing() -> None:
    assert composed(1.0).crossed is False
    assert POSITIVE.crosses is False


def test_crossing_rate_is_a_measured_share_of_hours() -> None:
    crossing = MagnitudeQuantiles.from_boosters(q10=140.0, q50=90.0, q90=200.0)
    fold = [composed(1.0, positive=crossing)] + [composed(1.0) for _ in range(9)]
    assert crossing_rate(fold) == pytest.approx(0.10)
    assert crossing_rate([]) == 0.0


# --- the expectation ---------------------------------------------------------


@pytest.mark.parametrize("p", [0.0, 0.05, 0.2, 0.49, 0.5, 0.51, 0.9, 1.0])
def test_expectation_is_the_mixture_formula_exactly(p: float) -> None:
    """``E[Y] = p·Ê[Y|Y>τ] + (1−p)·μ_sub``, and nothing rounder."""
    forecast = composed(p, positive_mean_mwh=120.0, sub_threshold_mean_mwh=1.4)
    assert forecast.expected_mwh == pytest.approx(p * 120.0 + (1.0 - p) * 1.4)


@pytest.mark.parametrize("p", [0.0, 0.05, 0.2, 0.37, 0.49, 0.4999])
def test_expectation_is_at_least_the_median_when_occurrence_is_unlikely(
    p: float,
) -> None:
    """``E[Y] ≥ Q_Y(0.5)`` for every ``p < 0.5``.

    Which is the whole argument for publishing the expectation as a separate
    field: below even odds the median *is* zero and the expectation is not, so
    an expectation drawn as the band's centre would sit outside its own band.
    """
    forecast = composed(p)
    assert forecast.band.p50 == 0.0
    assert forecast.expected_mwh >= forecast.band.p50


def test_expectation_is_not_the_bands_centre() -> None:
    """The band has no room for it — a structural claim, not a numeric one."""
    assert "expected_mwh" not in QuantileBand.__dataclass_fields__
    assert set(QuantileBand.__dataclass_fields__) == {"p10", "p50", "p90"}


# --- what falls out: the operating regions -----------------------------------


@pytest.mark.parametrize(("q", "threshold"), [(0.10, 0.90), (0.50, 0.50), (0.90, 0.10)])
def test_a_served_quantile_is_non_zero_only_above_its_own_p(
    q: float, threshold: float
) -> None:
    """P10 needs ``p > 0.90``, P50 needs ``p > 0.50``, P90 needs ``p > 0.10``.

    Confirmed by construction rather than by measurement — ``flex-optimizer.md``
    called this a falsifiable prediction, and it is arithmetic.

    ``p`` exactly *at* its threshold is skipped: ``1 − 0.9`` is not ``0.1`` in
    binary floating point, so which side of the branch that single point lands
    on is a fact about IEEE 754 and not about the mixture.
    """
    for step in range(101):
        p = step / 100.0
        if math.isclose(p, threshold):
            continue
        value = composed(p).mixture.quantile(q)
        assert (value > 0.0) is (p > threshold), f"q={q}, p={p}"


def test_the_low_quantiles_are_conservative_by_at_most_tau() -> None:
    """Sub-threshold mass is a point at zero, so the band errs low by ≤ τ.

    The true value in a sub-threshold hour lies in ``[0, τ]`` and the band says
    ``0``. That is the whole of the error the decision buys, and it is bounded
    by the threshold in force rather than by anything fitted.
    """
    mixture = composed(0.3).mixture
    true_values = [i * TAU / 10.0 for i in range(11)]
    for q in Q_SWEEP:
        if q > 0.7:
            continue
        served = mixture.quantile(q)
        assert served == 0.0
        # Whatever the hour actually was, it was in [0, τ] — so the band is
        # low, never high, and low by at most τ.
        assert all(0.0 <= y - served <= TAU for y in true_values)


# --- boundary cases ----------------------------------------------------------


def test_at_p_zero_the_band_is_all_zeros_and_the_expectation_is_mu_sub() -> None:
    forecast = composed(0.0, sub_threshold_mean_mwh=1.4)
    assert (forecast.band.p10, forecast.band.p50, forecast.band.p90) == (0.0, 0.0, 0.0)
    assert forecast.expected_mwh == 1.4


def test_at_p_one_the_band_is_the_positive_quantiles_unchanged() -> None:
    forecast = composed(1.0)
    served = [POSITIVE(q) for q in SERVED_QUANTILES]
    assert forecast.band.p10 == pytest.approx(served[0])
    assert forecast.band.p50 == pytest.approx(served[1])
    assert forecast.band.p90 == pytest.approx(served[2])
    assert forecast.expected_mwh == pytest.approx(120.0)


@pytest.mark.parametrize("n", [8640, 100])
def test_the_clipped_endpoints_isotonic_produces_compose(n: int) -> None:
    """Isotonic is clipped to ``[1/(2n), 1 − 1/(2n)]``; both ends compose.

    Near the lower clip the band is all zeros but the expectation is not; near
    the upper clip every served quantile is above τ. Neither endpoint divides by
    zero or leaves the quantile function's domain.
    """
    low = 1.0 / (2 * n)
    high = 1.0 - low

    at_low = composed(low)
    assert (at_low.band.p10, at_low.band.p50, at_low.band.p90) == (0.0, 0.0, 0.0)
    assert at_low.expected_mwh > 0.0

    at_high = composed(high)
    assert at_high.band.p10 > TAU
    assert at_high.band.p10 <= at_high.band.p50 <= at_high.band.p90


# --- τ travels with the composition ------------------------------------------


def test_the_threshold_in_force_is_stamped_on_the_result() -> None:
    forecast = composed(0.95, threshold_mw=12.0)
    assert forecast.threshold_mw == 12.0
    assert forecast.mixture.threshold_mwh == 12.0
    assert forecast.band.p10 > 12.0


def test_the_composition_has_no_default_threshold() -> None:
    """``threshold_mw`` is required, so the sweep cannot silently use 5 MW."""
    with pytest.raises(TypeError):
        compose(  # type: ignore[call-arg]
            occurrence_probability=0.9,
            positive_quantiles=POSITIVE,
            positive_mean_mwh=120.0,
            sub_threshold_mean_mwh=1.0,
        )


def test_the_composition_module_does_not_import_the_default_threshold() -> None:
    """A grep-level test, in the spirit of the UI's.

    The threshold is a property of the label and travels on the object. A module
    that could reach for the published default is a module that will, in the one
    lane the sweep retrained at another threshold.
    """
    source = mixture_module.__file__
    assert source is not None
    text = Path(source).read_text(encoding="utf-8")
    for line in text.splitlines():
        if line.lstrip().startswith(("import ", "from ")):
            assert "constants" not in line, line


# --- the technology split has no band ----------------------------------------


def test_the_technology_split_is_scalars_on_the_p50_and_the_expectation() -> None:
    forecast = composed(1.0, wind_share=0.75)
    assert forecast.p50_split is not None
    assert forecast.expected_split is not None
    assert forecast.p50_split.wind_mwh == pytest.approx(0.75 * forecast.band.p50)
    assert forecast.p50_split.solar_mwh == pytest.approx(0.25 * forecast.band.p50)
    assert forecast.expected_split.wind_mwh == pytest.approx(0.75 * 120.0)
    # The split reconciles with the figure it split, which is the only claim it
    # makes.
    assert forecast.p50_split.wind_mwh + forecast.p50_split.solar_mwh == pytest.approx(
        forecast.band.p50
    )


def test_the_technology_split_cannot_hold_a_band() -> None:
    """Structural: two scalars, no quantile fields to render as an interval."""
    assert set(TechnologySplit.__dataclass_fields__) == {"wind_mwh", "solar_mwh"}


def test_no_split_is_produced_when_no_share_was_supplied() -> None:
    forecast = composed(1.0)
    assert forecast.p50_split is None
    assert forecast.expected_split is None


# --- the magnitude quantile function -----------------------------------------


def test_the_magnitude_function_interpolates_between_its_fitted_alphas() -> None:
    assert POSITIVE(0.10) == 40.0
    assert POSITIVE(0.50) == 90.0
    assert POSITIVE(0.90) == 200.0
    assert POSITIVE(0.30) == pytest.approx(65.0)
    assert POSITIVE(0.70) == pytest.approx(145.0)


def test_the_magnitude_function_is_flat_outside_its_fitted_alphas() -> None:
    """No invented tail: a quantile fit says nothing past its outermost alpha."""
    assert POSITIVE(0.0) == 40.0
    assert POSITIVE(0.05) == 40.0
    assert POSITIVE(0.95) == 200.0
    assert POSITIVE(1.0) == 200.0


def test_the_magnitude_function_stores_its_knots_as_fitted() -> None:
    """Sorting before composition would hide the disagreement inside a curve."""
    crossing = MagnitudeQuantiles.from_boosters(q10=140.0, q50=90.0, q90=200.0)
    assert crossing.values == (140.0, 90.0, 200.0)
    assert crossing(0.10) == 140.0
    assert crossing(0.50) == 90.0


# --- the inputs are validated, so a nonsense mixture is unrepresentable -------


@pytest.mark.parametrize("p", [-0.01, 1.01, math.nan, math.inf])
def test_an_impossible_occurrence_probability_is_refused(p: float) -> None:
    with pytest.raises(ValueError, match="probability"):
        composed(p)


def test_a_sub_threshold_mean_above_tau_is_refused() -> None:
    """``μ_sub`` averages rows at or below τ, so it cannot exceed τ."""
    with pytest.raises(ValueError, match="cannot exceed"):
        composed(0.5, sub_threshold_mean_mwh=TAU + 0.1)


@pytest.mark.parametrize("threshold", [0.0, -5.0])
def test_a_non_positive_threshold_is_refused(threshold: float) -> None:
    with pytest.raises(ValueError, match="threshold_mw must be positive"):
        composed(0.5, threshold_mw=threshold)


def test_a_negative_magnitude_is_refused() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        MagnitudeQuantiles.from_boosters(q10=-1.0, q50=90.0, q90=200.0)


def test_a_wind_share_outside_zero_one_is_refused() -> None:
    with pytest.raises(ValueError, match="probability"):
        composed(1.0, wind_share=1.5)


# --- the mixture is the same object the ensemble will invert -----------------


def test_the_composed_result_carries_the_mixture_it_came_from() -> None:
    """Ticket 07 draws ``u`` 500 × 24 times; it must invert *this* mixture.

    Two inversions — one for the hour band, one for the day band — would let the
    two disagree about hour 14, which is the reconciliation problem the single
    ensemble exists to avoid.
    """
    forecast = composed(0.95)
    assert isinstance(forecast.mixture, HurdleMixture)
    assert forecast.mixture.quantile(0.10) == forecast.band.p10
    assert forecast.mixture.quantile(0.50) == forecast.band.p50
    assert forecast.mixture.quantile(0.90) == forecast.band.p90
