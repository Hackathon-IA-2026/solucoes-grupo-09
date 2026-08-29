"""The hurdle's two estimators, composed into the band the product ships.

``docs/specs/forecaster.md`` opens on the reason this module exists: a hurdle
model predicts a **mixture**, and a mixture's quantiles are not a function of
its parts that anyone reaches for by accident. ``p × E[Y | Y > τ]`` is an
expectation; it is not a P50, and calling it one publishes a number
*conditional on curtailment happening* as though it were unconditional.

So the two estimators are never multiplied. They are composed by **inverting
the mixture CDF**. With ``F_sub`` supported on ``[0, τ]`` and ``F_pos`` on
``(τ, ∞)``::

    F_Y(y | x) = (1 − p) · F_sub(y | x) + p · F_pos(y | x)

    Q_Y(q | x) =  0                                    if q ≤ 1 − p(x)
                  Q_pos( (q − (1 − p(x))) / p(x) )     if q >  1 − p(x)

    E[Y | x] = p(x) · Ê[Y | Y > τ, x] + (1 − p(x)) · μ_sub(subsystem, hour)

Training, serving, backtesting and Replay all import :func:`compose`, so four
callers cannot hold four mixtures. Nothing here knows about LightGBM, features
or the database: the inputs are ``p``, a positive-magnitude quantile function,
a conditional mean and ``μ_sub``, and the composition is arithmetic on them.

**What the shapes here make unrepresentable**, rather than merely tested:

- **A crossing band.** :class:`QuantileBand` refuses to hold quantiles out of
  order, exactly as ``band()`` in ``packages/core/src/domain.ts`` does on the
  TypeScript side, and the only constructor that composition uses sorts. Three
  independently-fitted quantile boosters *can* cross; the sort is where that
  stops, and :attr:`ComposedForecast.crossed` is how it is counted rather than
  swallowed (`crossing_rate ≤ 0.01` is a hot-swap guardrail).
- **An expectation drawn inside the band.** :class:`QuantileBand` has no field
  for it. ``E[Y] > P50`` whenever ``p < 0.5``, so an expectation rendered as a
  band's centre would make the band asymmetric for a reason that has nothing to
  do with uncertainty.
- **A per-technology band.** The hurdle is trained on the total; the share model
  applies to the P50 and to the expectation *only*. :class:`TechnologySplit`
  holds two scalars and no quantiles, so there is nothing for a caller to
  render as an interval.
- **A ``τ`` that drifts.** ``threshold_mw`` is a required argument and is
  stamped on the result. It is deliberately *not* imported from
  :mod:`wattsteer_ml.constants` here: the threshold sweep retrains whole lanes
  at other thresholds, and a magnitude without the threshold that produced it
  cannot be compared with another one (`docs/domain-model.md` §8.3).

**The one asymmetry, on purpose.** Sub-threshold mass is a point at zero for the
quantiles and the fitted constant ``μ_sub`` for the expectation. The band is
therefore conservative by at most ``τ`` (5 MWh at subsystem grain) in any hour
whose quantile lands in the sub-threshold regime. The promise errs low; the
expectation does not.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from itertools import pairwise

#: The three quantiles the product publishes, in order. The composition itself
#: is defined for any ``q`` — the path ensemble inverts it at 500 × 24 draws of
#: ``u`` — and this tuple is only what the served band is made of.
SERVED_QUANTILES: tuple[float, float, float] = (0.10, 0.50, 0.90)

#: The alphas the three magnitude boosters are fitted at
#: (`docs/specs/forecaster.md`, "Model B"). Knots of
#: :class:`MagnitudeQuantiles`, and not the same thing as
#: :data:`SERVED_QUANTILES`: composition asks ``Q_pos`` for
#: ``(q − (1 − p)) / p``, which equals ``q`` only when ``p = 1``.
FITTED_ALPHAS: tuple[float, float, float] = (0.10, 0.50, 0.90)

#: A positive-magnitude quantile function: ``u ∈ [0, 1] → MWh``, conditional on
#: ``Y > τ``. :class:`MagnitudeQuantiles` is the implementation the boosters
#: produce; anything callable will do, which is what lets the composition be
#: tested on fixtures with no model in the room.
PositiveQuantileFn = Callable[[float], float]


def _check_probability(name: str, value: float) -> None:
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be a probability in [0, 1], got {value!r}")


def _check_mwh(name: str, value: float) -> None:
    if not math.isfinite(value) or value < 0.0:
        raise ValueError(f"{name} must be a finite non-negative MWh, got {value!r}")


@dataclass(frozen=True)
class MagnitudeQuantiles:
    """``Q_pos`` — the magnitude boosters' output, as a function of ``u``.

    Three boosters give three points of a quantile function and the composition
    needs it at arbitrary ``u``, so the points are joined by linear
    interpolation and **held flat outside them**. Flat rather than extrapolated
    because a quantile fit says nothing beyond its outermost alpha, and a
    straight line drawn past ``α = 0.9`` is an invented tail — the ensemble's
    day totals would inherit it as though it had been fitted.

    The knots are stored **as fitted**, crossing and all. Sorting them here
    would hide a disagreement between the boosters inside an interpolant;
    `docs/specs/forecaster.md` puts the sort *after* composition so the crossing
    stays visible as a measured rate.
    """

    #: ``q̂_pos^0.10``, ``q̂_pos^0.50``, ``q̂_pos^0.90`` — MWh, as fitted.
    values: tuple[float, float, float]

    def __post_init__(self) -> None:
        if len(self.values) != len(FITTED_ALPHAS):
            raise ValueError(
                f"expected {len(FITTED_ALPHAS)} fitted quantiles, got {self.values!r}"
            )
        for alpha, value in zip(FITTED_ALPHAS, self.values, strict=True):
            _check_mwh(f"q_pos^{alpha:.2f}", value)

    @classmethod
    def from_boosters(cls, q10: float, q50: float, q90: float) -> MagnitudeQuantiles:
        """Name the three boosters at the call site, so they cannot swap."""
        return cls(values=(q10, q50, q90))

    @property
    def crosses(self) -> bool:
        """Whether the fitted knots disagree about the shape of the tail."""
        return not _is_sorted(self.values)

    def __call__(self, u: float) -> float:
        _check_probability("u", u)
        alphas = FITTED_ALPHAS
        values = self.values
        if u <= alphas[0]:
            return values[0]
        if u >= alphas[-1]:
            return values[-1]
        for lo in range(len(alphas) - 1):
            hi = lo + 1
            if u <= alphas[hi]:
                span = alphas[hi] - alphas[lo]
                weight = (u - alphas[lo]) / span
                return values[lo] + weight * (values[hi] - values[lo])
        raise AssertionError("unreachable: u is bracketed by the fitted alphas")


@dataclass(frozen=True)
class QuantileBand:
    """A P10/P50/P90 triple that cannot be out of order.

    The mirror of ``band()`` in ``packages/core/src/domain.ts``, which raises on
    the same condition: the invariant is asserted on both sides of the wire
    rather than assumed to survive the crossing.

    There is deliberately **no expectation field**. ``E[Y]`` is published beside
    a band, never inside one.
    """

    p10: float
    p50: float
    p90: float

    def __post_init__(self) -> None:
        if not (self.p10 <= self.p50 <= self.p90):
            raise ValueError(
                f"band quantiles out of order: {self.p10}, {self.p50}, {self.p90}"
            )

    @classmethod
    def sorted_from(cls, values: Sequence[float]) -> QuantileBand:
        """Build a band from three composed quantiles, sorting if they cross.

        ``P10 ← min``, ``P90 ← max`` — the rule `docs/specs/forecaster.md`
        states. Whether the sort did anything is a fact the caller keeps: see
        :attr:`ComposedForecast.crossed`.
        """
        if len(values) != 3:
            raise ValueError(f"a band is three quantiles, got {len(values)}")
        low, mid, high = sorted(values)
        return cls(p10=low, p50=mid, p90=high)


@dataclass(frozen=True)
class TechnologySplit:
    """One figure's wind/solar split — two scalars, and no band.

    The hurdle is trained on the subsystem **total** and the share model ``ŝ(x)``
    is applied to the P50 and to the expectation only. Publishing a wind band
    and a solar band would need either two hurdles whose bands do not reconcile
    with the total's, or a joint draw nobody fits; so the split is a point split
    of a figure, labelled as one, and there is no field here to hang an interval
    from.
    """

    wind_mwh: float
    solar_mwh: float

    @classmethod
    def of(cls, total_mwh: float, wind_share: float) -> TechnologySplit:
        _check_mwh("total_mwh", total_mwh)
        _check_probability("wind_share", wind_share)
        return cls(
            wind_mwh=total_mwh * wind_share,
            solar_mwh=total_mwh * (1.0 - wind_share),
        )


@dataclass(frozen=True)
class HurdleMixture:
    """The mixture itself: invertible at any ``q``, and nothing more.

    Held on the composed result because the path ensemble (ticket 07) needs
    ``Q_Y`` at 500 × 24 draws of ``u``, not only at the three served quantiles —
    and it must be the *same* inversion, or the hour band and the day band
    disagree about hour 14.
    """

    #: ``p(x)`` — the calibrated occurrence probability, ``P(Y > τ | x)``.
    #: Isotonic clips it away from 0 and 1, but both endpoints are accepted
    #: here: the arithmetic is total, and a clip bound is the calibrator's
    #: business rather than the composition's.
    occurrence_probability: float
    #: ``Q_pos`` — the positive-magnitude quantile function.
    positive_quantiles: PositiveQuantileFn
    #: ``Ê[Y | Y > τ, x]`` — the conditional-mean booster. **Not**
    #: ``q̂_pos^0.50``: the mean of a right-skewed magnitude sits above its
    #: median, and the expectation is the number narration reaches for.
    positive_mean_mwh: float
    #: ``μ_sub(subsystem, local_hour)`` — the training-fold empirical mean of
    #: the label over sub-threshold rows. A fitted constant, not zero: dropping
    #: it biases a day's expected total low by up to 24 × τ.
    sub_threshold_mean_mwh: float
    #: ``threshold_mw`` in force. ``τ = threshold_mw × 1 h``.
    threshold_mw: float

    def __post_init__(self) -> None:
        _check_probability("occurrence_probability", self.occurrence_probability)
        _check_mwh("positive_mean_mwh", self.positive_mean_mwh)
        _check_mwh("sub_threshold_mean_mwh", self.sub_threshold_mean_mwh)
        if not math.isfinite(self.threshold_mw) or self.threshold_mw <= 0.0:
            raise ValueError(f"threshold_mw must be positive, got {self.threshold_mw!r}")
        if self.sub_threshold_mean_mwh > self.threshold_mwh:
            raise ValueError(
                "sub_threshold_mean_mwh is a mean over rows at or below the "
                f"threshold, so it cannot exceed τ = {self.threshold_mwh}; got "
                f"{self.sub_threshold_mean_mwh}"
            )

    @property
    def threshold_mwh(self) -> float:
        """``τ`` — the threshold as energy over one hour."""
        return self.threshold_mw * 1.0

    @property
    def expected_mwh(self) -> float:
        """``E[Y | x]``, the mixture's expectation. Never the band's centre."""
        p = self.occurrence_probability
        return p * self._positive_mean_in_support + (1.0 - p) * (
            self.sub_threshold_mean_mwh
        )

    @property
    def _positive_mean_in_support(self) -> float:
        """The conditional mean, moved into ``F_pos``'s support if it fell out.

        ``Y | Y > τ`` is supported on ``(τ, ∞)``, so its mean is above ``τ``. A
        squared-error booster has no way to know that, and one that undershoots
        would put an expectation *below* the threshold the label declares to be
        noise. Clamping to the support is not a nudge to the promise — the
        promise is the band, and the band is floored by the same rule.
        """
        return _into_positive_support(self.positive_mean_mwh, self.threshold_mwh)

    def quantile(self, q: float) -> float:
        """``Q_Y(q | x)`` — the mixture's inverse CDF at ``q``.

        Zero for every ``q ≤ 1 − p`` and only then, because that is the branch
        written below; strictly above ``τ`` otherwise, because the positive
        branch is floored into ``F_pos``'s support. Non-decreasing in ``q``,
        because ``q ↦ (q − (1 − p)) / p`` is increasing and both the floor and
        a flat-tailed piecewise-linear ``Q_pos`` preserve order.
        """
        _check_probability("q", q)
        p = self.occurrence_probability
        sub_threshold_mass = 1.0 - p
        if q <= sub_threshold_mass:
            return 0.0
        u = (q - sub_threshold_mass) / p
        # Floating point can push u a hair past 1 at q = 1; the quantile
        # function is only defined on [0, 1].
        u = min(1.0, max(0.0, u))
        return _into_positive_support(self.positive_quantiles(u), self.threshold_mwh)


@dataclass(frozen=True)
class ComposedForecast:
    """What one hour of forecast is: a band, an expectation, and its provenance.

    The band and the expectation are separate fields on purpose, and the
    threshold that produced both travels with them.
    """

    band: QuantileBand
    #: ``E[Y | x]`` — published beside the band, never as its centre.
    expected_mwh: float
    #: ``p(x)``, echoed because the band's shape is decided by it: P10 is
    #: non-zero only when ``p > 0.90``, P50 only when ``p > 0.50``.
    occurrence_probability: float
    #: ``threshold_mw`` in force, stamped on every output that used it.
    threshold_mw: float
    #: Whether the composed quantiles arrived out of order and were sorted.
    #: :func:`crossing_rate` over a fold is the published metric, and a rate
    #: above 1% of served hours is a hot-swap veto.
    crossed: bool
    #: The mixture, kept so the path ensemble inverts the same one.
    mixture: HurdleMixture
    #: The share model applied to the P50. ``None`` when no share was supplied.
    p50_split: TechnologySplit | None = None
    #: The share model applied to the expectation.
    expected_split: TechnologySplit | None = None


def compose(
    *,
    occurrence_probability: float,
    positive_quantiles: PositiveQuantileFn,
    positive_mean_mwh: float,
    sub_threshold_mean_mwh: float,
    threshold_mw: float,
    wind_share: float | None = None,
) -> ComposedForecast:
    """Compose one hour's band and expectation from the hurdle's two estimators.

    The one function training, serving, backtesting and Replay call. Its inputs
    are the four estimated quantities — ``p``, ``Q_pos``, ``Ê[Y | Y > τ]``,
    ``μ_sub`` — plus the ``threshold_mw`` that has to travel with them and,
    optionally, the share model's ``ŝ(x)``. No feature vector, no artifact, no
    model object: everything here is arithmetic, which is why it could be built
    and checked before any model existed.

    Args:
        occurrence_probability: ``p(x)``, calibrated.
        positive_quantiles: ``Q_pos``, conditional on ``Y > τ``.
        positive_mean_mwh: ``Ê[Y | Y > τ, x]`` from the conditional-mean
            booster — not the median booster.
        sub_threshold_mean_mwh: ``μ_sub(subsystem, local_hour)``.
        threshold_mw: the ``curtailment_threshold_mw`` in force.
        wind_share: ``ŝ(x) ∈ [0, 1]``. Applied to the P50 and the expectation
            only; there is no such thing as a per-technology band.

    Returns:
        The band, the expectation, and the mixture they came from.
    """
    mixture = HurdleMixture(
        occurrence_probability=occurrence_probability,
        positive_quantiles=positive_quantiles,
        positive_mean_mwh=positive_mean_mwh,
        sub_threshold_mean_mwh=sub_threshold_mean_mwh,
        threshold_mw=threshold_mw,
    )
    composed = [mixture.quantile(q) for q in SERVED_QUANTILES]
    band = QuantileBand.sorted_from(composed)
    expected_mwh = mixture.expected_mwh
    return ComposedForecast(
        band=band,
        expected_mwh=expected_mwh,
        occurrence_probability=mixture.occurrence_probability,
        threshold_mw=mixture.threshold_mw,
        crossed=not _is_sorted(composed),
        mixture=mixture,
        p50_split=(
            None if wind_share is None else TechnologySplit.of(band.p50, wind_share)
        ),
        expected_split=(
            None if wind_share is None else TechnologySplit.of(expected_mwh, wind_share)
        ),
    )


def crossing_rate(forecasts: Iterable[ComposedForecast]) -> float:
    """``crossing_rate`` — the share of composed hours whose quantiles crossed.

    A measured quantity rather than a swallowed one: the sort in
    :meth:`QuantileBand.sorted_from` always produces a monotone band, so the
    only way a reviewer learns the boosters disagreed is this number. Above
    0.01 it is a hot-swap guardrail veto — the fits are not describing one
    distribution and the interval does not mean what it says.

    Returns ``0.0`` for an empty fold: no hour crossed, because no hour was
    served.
    """
    total = 0
    crossed = 0
    for forecast in forecasts:
        total += 1
        crossed += 1 if forecast.crossed else 0
    return crossed / total if total else 0.0


def _is_sorted(values: Sequence[float]) -> bool:
    return all(a <= b for a, b in pairwise(values))


def _into_positive_support(value: float, threshold_mwh: float) -> float:
    """Move a magnitude into ``(τ, ∞)``, the support ``F_pos`` is defined on.

    ``Q_pos`` is fitted on rows where ``y > τ``, so every value it describes is
    above the threshold — but a booster is a regression, not a constrained one,
    and nothing in its objective stops a prediction landing at or below ``τ``.
    Returning such a value would break the mixture's own statement that
    ``Q_Y(q) > τ`` whenever ``q > 1 − p``: the band would claim the
    sub-threshold regime in an hour the arithmetic says is above it.

    The floor is the smallest float above ``τ`` rather than ``τ`` itself, so the
    inequality is strict by construction and not by rounding. The difference is
    ~1e-15 MWh, which is to say the clamp is a type-level statement about the
    support and not a correction anyone can see on a screen.
    """
    return max(value, math.nextafter(threshold_mwh, math.inf))
