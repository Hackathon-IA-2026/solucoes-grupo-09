"""The P10 carries a coverage statement: two one-sided conformal corrections.

`docs/specs/forecaster.md`, "Quantiles — quantile regression, conformalised".
A pinball booster's 0.1 output is sharp and feature-dependent and carries no
coverage guarantee at all; split conformal on a point forecast carries the
guarantee and a constant width that is wrong everywhere for a distribution that
is a point mass at zero most hours. So **the boosters supply the shape and
conformal supplies a scalar per tail**::

    E_lo,i = Q_Y(0.10 | x_i) − y_i    E_hi,i = y_i − Q_Y(0.90 | x_i)
    δ_lo = δ_hi = the ⌈(n+1)(1 − 0.10)⌉-th smallest of the respective E
    Q_Y(q | x) ← Q_Y(q | x) − δ_lo·w_lo(q) + δ_hi·w_hi(q)   for q > 1 − p(x)

**Two scalars, never one.** A symmetric correction lets a badly-fitted upper
tail spend the budget the lower tail needs, and the lower tail is the one the
product promises. :meth:`ConformalCorrection.fit` takes the two residual
sequences as two arguments and ranks each on its own; there is no code path on
which an upper residual can reach ``delta_lo``.

**The correction is global, not per hour.** One scalar per tail per artifact.
Conditional coverage is *reported* — :class:`CoverageReport` breaks it down per
subsystem and per local hour — and is **never** fed back. The two things are
kept apart structurally rather than by discipline: :meth:`ConformalCorrection.fit`
is handed ``Sequence[float]`` twice and never sees a
:class:`~wattsteer_ml.evaluation.RowKey`, so it has nothing to condition on.
:mod:`tests.test_conformal_quantiles` asserts that against this file's source.

**Where the correction is applied, and why it moved.** ``w_lo`` and ``w_hi``
above are :class:`~wattsteer_ml.mixture.TailShift`: the two scalars written as a
shift in the mixture's own ``q``, piecewise-linear through ``−δ_lo`` at 0.10,
``0`` at 0.50 and ``+δ_hi`` at 0.90 and flat outside, added inside the positive
branch of :meth:`~wattsteer_ml.mixture.HurdleMixture.quantile`.

Until forecaster ticket 21 the correction was applied to the *knots* of
``Q_pos`` instead, and that under-applied it. Composition asks ``Q_pos`` for
``u = (q − (1 − p)) / p``; ``u_lo ≤ 0.10`` for every ``p``, so the lower tail
arrived in full, but ``u_hi = 1 − 0.1/p`` is below the 0.90 knot for every
``p < 1`` and at or below the *median* knot once ``p ≤ 0.20``. Ticket 06
measured the consequence on its own fixture: the mean realised share of
``δ_hi`` was **0.25**, and **49% of rows received exactly none of it**. A P90
short of what its own residuals asked for is a band too narrow at the top —
the flattering direction, and the unsafe one, because the product exists so an
operator can size storage against that edge. It is fixed rather than footnoted.

**Both tails are now exact wherever the served quantile is in the positive
branch**, and that is the whole of the change:

- ``Q_Y(0.10)`` moves by exactly ``δ_lo`` whenever ``p > 0.90``, which is what
  it did before — bit for bit, because the old path read the flat region below
  the 0.10 knot and this one adds the same scalar to the same value. The floor
  the product promises did not move.
- ``Q_Y(0.90)`` moves by exactly ``δ_hi`` whenever ``p > 0.10``.
  :func:`upper_correction_fraction` is ``1.0`` there and ``coverage_p90`` now
  means what ``coverage_p10`` means.

**The structural zero is preserved, deliberately.** ``Q_Y(q) = 0`` for every
``q ≤ 1 − p``, so at ``p ≤ 0.10`` the served P90 is exactly zero and stays so.
That is not a shortfall to be corrected: the mixture is stating there is at
least a 90% chance of no curtailment, and lifting the P90 there would invent
curtailment the model denies. The same structure puts the P10 at zero for every
``p ≤ 0.90``, where ``δ_lo`` is equally inert.
:func:`upper_correction_fraction` and :func:`lower_correction_fraction` are that
one remaining, structural asymmetry as numbers, and
:attr:`CoverageReport.upper_correction_realised` publishes the upper one.

**This still does not add a second path to a band.** Forecaster ticket 01 made
the mixture inversion the only composition and it still is. This module produces
a :class:`~wattsteer_ml.mixture.TailShift` — two floats and an interpolation
rule, no ``p``, no band — and :func:`wattsteer_ml.mixture.compose` is the one
place it is ever applied. Nothing here constructs a
:class:`~wattsteer_ml.mixture.QuantileBand`, calls ``compose``, or adds a scalar
to a composed quantile. Ticket 07's ensemble inverts one object, exactly as it
did: the shift lives on the mixture the ensemble already held, so the corrected
marginals *are* the served marginals and the hour band and the day band cannot
disagree about hour 14.

**Exchangeability is violated and is not pretended otherwise.** The calibration
window is the 90 days immediately preceding the test period, which is the best
available proxy and is not exchangeability, so the guarantee is **approximate**
and empirical fold coverage is the real check. :class:`DeltaDrift` is the
recorded hook: ``δ_lo`` growing across folds means the boosters' intervals are
drifting narrow and the split-conformal assumption is failing. It **reports**
and adapts nothing — adaptive conformal (an online update of the target level)
is the spec's named next step and is deliberately not built here.

**The caveat this ticket inherits, and what it costs the coverage claim.** The
calibration block is passed to LightGBM as an early-stopping monitor, so it
chose the tree count for the two pinball boosters as well as for the classifier.
``q̂^0.10`` and ``q̂^0.90`` on that window are therefore slightly *optimistic* —
a hair closer to the labels than they will be on the test fold — and ``p`` on
that window comes from an isotonic map fitted to the same rows, which is
optimistic in the same direction. Both push the composed band toward the labels,
both shrink ``E_lo`` and ``E_hi``, and so **both make ``δ_lo`` and ``δ_hi``
slightly small**: the published interval is a little narrower than an honest
90% and the empirical coverage a little under nominal. Forecaster ticket 04
predicted exactly this ("δ slightly optimistic") and it is not corrected here,
because a correction with no measurement behind it would be worse than a stated
bias. Setting ``early_stopping_rounds`` to 0 in a
:class:`~wattsteer_ml.training.hyperparameters.ModelConfig` removes the booster
half of it outright; the isotonic half is inherent to fitting the map and the
correction on one window, and is the cost the spec accepted when it declined
cross-conformal.

**The median gets no correction.** A median has no interval to cover.
:class:`~wattsteer_ml.mixture.TailShift` is zero at ``q = 0.50`` by
construction, so ``Q_Y(0.50)`` comes through untouched, and
``p50_unbiasedness`` — the share of observations below P50, target 0.50 — is
reported beside the two coverages as the guardrail on it instead.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.mixture import (
    SERVED_QUANTILES,
    ComposedForecast,
    TailShift,
    crossing_rate,
    in_point_mass,
)

#: ``α`` — the nominal miscoverage of each tail. One tail at a time, so the
#: served band's two-sided statement is weaker than ``1 − 2α``: each of P10 and
#: P90 is claimed to hold 90% of the time, and the pair is not claimed jointly.
NOMINAL_MISCOVERAGE = 0.10

#: ``1 − α`` — what ``coverage_p10`` and ``coverage_p90`` are aimed at.
TARGET_COVERAGE = 1.0 - NOMINAL_MISCOVERAGE

#: The hot-swap gate's coverage guardrail (`docs/specs/forecaster.md`). Named
#: here because this module is where coverage is measured; the veto itself is
#: forecaster ticket 13's and nothing in this file refuses anything.
COVERAGE_GUARDRAIL: tuple[float, float] = (0.85, 0.97)

#: Which correction regime a served number was produced under — a **stored
#: string**, stamped on every persisted forecast row by
#: :mod:`wattsteer_ml.publication`.
#:
#: **It is bumped when the composed band's correction changes, and never
#: otherwise.** A retrain under the same rule produces a new ``artifact_id`` and
#: the same regime; a change to how ``δ_hi`` reaches the composed P90 produces
#: a new regime, whatever the artifact ids say. So the value names the rule and
#: not the release.
#:
#: ``conformal_v1_partial_upper`` was one-sided split conformal applied to the
#: **knots** of ``Q_pos``, under which the composed P90 received ``δ_hi`` only
#: in the proportion :func:`upper_correction_fraction` then described — a
#: quarter of it on average and none of it below ``p = 0.20``. Forecaster
#: ticket 21 moved the correction onto the composed quantile, where its
#: residuals were measured, and both tails are now exact wherever the served
#: quantile is in the positive branch. ``v2`` names that rule.
#:
#: Rows written under ``v1`` are still in the database and are **not**
#: re-stamped: they carry a different, narrower statement about the same hour,
#: one that is re-servable at its own origin, and a reader has to be able to
#: tell the two apart with a query rather than a changelog. That is the whole
#: job of this column.
CORRECTION_REGIME = "conformal_v2_full_upper"

#: Guard against ``⌈9.0000000000000002⌉ = 10``. ``(n + 1)(1 − α)`` is an exact
#: integer at the ``n`` where the rank first becomes attainable, and binary
#: floating point does not always agree; a tolerance of a billionth cannot move
#: the rank anywhere it was not already within a rounding error of.
_RANK_TOLERANCE = 1e-9


class ConformalError(ValueError):
    """A coverage statement that cannot be made from these residuals."""


def minimum_calibration_rows(miscoverage: float = NOMINAL_MISCOVERAGE) -> int:
    """The smallest ``n`` for which ``⌈(n+1)(1 − α)⌉ ≤ n``.

    Below it the requested order statistic is off the end of the sample and
    split conformal's honest answer is ``+∞`` — an infinitely wide interval.
    This module raises instead: an unbounded band is not something the product
    can render, and "the calibration window held too few curtailed hours to make
    a 90% statement" is a fact about the fold that a caller must see rather than
    absorb. At ``α = 0.10`` it is nine.
    """
    if not math.isfinite(miscoverage) or not 0.0 < miscoverage < 1.0:
        raise ConformalError(f"α must be a miscoverage in (0, 1), got {miscoverage!r}")
    return math.ceil(1.0 / miscoverage) - 1


def conformal_rank(rows: int, miscoverage: float = NOMINAL_MISCOVERAGE) -> int:
    """``⌈(n + 1)(1 − α)⌉`` — which order statistic ``δ`` is, 1-based."""
    return math.ceil((rows + 1) * (1.0 - miscoverage) - _RANK_TOLERANCE)


def _served_correction_fraction(occurrence_probability: float, served: float) -> float:
    """``1.0`` where ``Q_Y(served)`` is in the positive branch, ``0.0`` where not.

    The one shape both published fractions have, since forecaster ticket 21 put
    the shift on the composed quantile: a served quantile either sits in the
    positive branch, where it receives its tail's whole ``δ``, or it sits on the
    point mass at zero, where it receives none — and there is nothing in
    between, because the interpolant that used to attenuate the upper tail is no
    longer on the path.
    """
    if not math.isfinite(occurrence_probability) or not (
        0.0 <= occurrence_probability <= 1.0
    ):
        raise ConformalError(f"{occurrence_probability!r} is not a probability")
    return 0.0 if in_point_mass(served, occurrence_probability) else 1.0


def upper_correction_fraction(occurrence_probability: float) -> float:
    """How much of ``δ_hi`` an hour's composed P90 actually receives.

    ``1.0`` for every ``p > 0.10`` — the correction is added to the composed
    quantile, so it arrives whole — and ``0.0`` at ``p ≤ 0.10``, where
    ``Q_Y(0.90) = 0`` because ``0.90 ≤ 1 − p``.

    **The zero is structure, not shortfall.** At ``p ≤ 0.10`` the mixture is
    saying there is at least a 90% chance of no curtailment in this hour, so the
    honest P90 is zero; adding ``δ_hi`` there would invent curtailment the model
    denies, and would do it in the 90% of hours where the model is most
    confident nothing happens. What the number *does* say is that a curtailed
    hour at such a ``p`` cannot be covered by the upper statement at all, which
    is a fact about the classifier and bounds ``coverage_p90`` from above. That
    is why it is published: :attr:`CoverageReport.upper_correction_realised` is
    its mean over the scored hours.

    Before ticket 21 this function returned a proportion strictly between the
    ends — the share of ``δ_hi`` that survived being applied to the 0.90 knot
    and read back at ``u_hi = 1 − 0.1/p``. It no longer does, and that is the
    fix.
    """
    return _served_correction_fraction(occurrence_probability, SERVED_QUANTILES[2])


def lower_correction_fraction(occurrence_probability: float) -> float:
    """How much of ``δ_lo`` an hour's composed P10 actually receives.

    :func:`upper_correction_fraction`'s twin, and the reason the pair is worth
    having: ``1.0`` for every ``p > 0.90`` and ``0.0`` below it, where
    ``Q_Y(0.10) = 0``. The floor has always behaved this way — the knot
    correction reached it in full too — so this function states a property that
    did not change, beside one that did, in the same vocabulary.

    The remaining asymmetry between the tails is entirely this: the lower
    statement goes inert at ``p ≤ 0.90`` and the upper only at ``p ≤ 0.10``. It
    belongs to the mixture's point mass, not to the correction.
    """
    return _served_correction_fraction(occurrence_probability, SERVED_QUANTILES[0])


@dataclass(frozen=True)
class ScoredHour:
    """One composed hour and the label it turned out to have.

    The unit both halves of this module consume: the residuals ``δ`` is ranked
    from, and the rows coverage is counted over. It carries the whole
    :class:`~wattsteer_ml.mixture.ComposedForecast` rather than three floats so
    that ``crossing_rate`` — which the card's Quantiles group publishes beside
    the two deltas — is measured on the same rows as the coverage, and so that
    nothing here has to be told which composition produced the band.
    """

    key: RowKey
    forecast: ComposedForecast
    #: The settled label, in MWh. Only rows above ``τ`` are scored — see
    #: :func:`residuals`.
    observed_mwh: float

    def __post_init__(self) -> None:
        if not math.isfinite(self.observed_mwh) or self.observed_mwh < 0.0:
            raise ConformalError(
                f"{self.key.line}: {self.observed_mwh!r} is not an observed MWh"
            )

    @property
    def lower_residual(self) -> float:
        """``E_lo = q̂^0.10 − y``. Positive when the floor was above the label."""
        return self.forecast.band.p10 - self.observed_mwh

    @property
    def upper_residual(self) -> float:
        """``E_hi = y − q̂^0.90``. Positive when the ceiling was below the label."""
        return self.observed_mwh - self.forecast.band.p90

    @property
    def covered_lower(self) -> bool:
        """Whether the label is at or above P10 — what ``coverage_p10`` counts."""
        return self.observed_mwh >= self.forecast.band.p10

    @property
    def covered_upper(self) -> bool:
        """Whether the label is at or below P90 — what ``coverage_p90`` counts."""
        return self.observed_mwh <= self.forecast.band.p90

    @property
    def below_median(self) -> bool:
        """What ``p50_unbiasedness`` counts. Strict: ties sit on the median."""
        return self.observed_mwh < self.forecast.band.p50

    @property
    def is_positive(self) -> bool:
        """Whether this hour is above ``τ``, and so part of the scored set."""
        return self.observed_mwh > self.forecast.mixture.threshold_mwh


@dataclass(frozen=True)
class ConformalCorrection:
    """``δ_lo`` and ``δ_hi``, with the window and the rank behind them.

    A published pair of numbers, not an implementation detail: the card's
    Quantiles group prints both per fold, and a ``δ_lo`` that grows across folds
    is the drift signal. Everything needed to re-derive them from the same window
    travels with them, because a correction whose ``n`` nobody recorded is a
    number with no evidence attached.
    """

    #: MWh subtracted from the ``α = 0.10`` knot. Negative when the boosters
    #: over-covered — the correction narrows the band then, and is allowed to:
    #: conformal makes coverage *equal* nominal, not at least nominal.
    delta_lo: float
    #: MWh added to the ``α = 0.90`` knot.
    delta_hi: float
    #: ``n`` — the calibration window's curtailed hours that both tails were
    #: ranked over. One count, because both tails see the same rows.
    calibration_rows: int
    #: ``⌈(n + 1)(1 − α)⌉``, 1-based. Stored so the published δ can be checked
    #: against the sample it came from without re-running the fit.
    rank: int
    #: ``α``. A field rather than a constant read at use time, so a bundle
    #: fitted under one miscoverage cannot be read under another.
    miscoverage: float
    window_start: date
    window_end: date

    def __post_init__(self) -> None:
        for name in ("delta_lo", "delta_hi"):
            value = getattr(self, name)
            if not math.isfinite(value):
                raise ConformalError(f"{name} is {value!r}, which is not MWh")
        if not math.isfinite(self.miscoverage) or not 0.0 < self.miscoverage < 1.0:
            raise ConformalError(
                f"α must be a miscoverage in (0, 1), got {self.miscoverage!r}"
            )
        floor = minimum_calibration_rows(self.miscoverage)
        if self.calibration_rows < floor:
            raise ConformalError(
                f"{self.calibration_rows} curtailed calibration hours cannot "
                f"support a {1.0 - self.miscoverage:.0%} statement; the "
                f"⌈(n+1)(1 − α)⌉-th smallest residual needs at least {floor}"
            )
        expected = conformal_rank(self.calibration_rows, self.miscoverage)
        if self.rank != expected:
            raise ConformalError(
                f"rank {self.rank} is not ⌈(n+1)(1 − α)⌉ = {expected} for "
                f"n = {self.calibration_rows} at α = {self.miscoverage}"
            )
        if self.window_start > self.window_end:
            raise ConformalError(
                f"empty calibration window {self.window_start.isoformat()} to "
                f"{self.window_end.isoformat()}"
            )

    @property
    def target_coverage(self) -> float:
        """``1 − α`` — what each tail is aimed at, one tail at a time."""
        return 1.0 - self.miscoverage

    @classmethod
    def fit(
        cls,
        *,
        lower_residuals: Sequence[float],
        upper_residuals: Sequence[float],
        window: tuple[date, date],
        miscoverage: float = NOMINAL_MISCOVERAGE,
    ) -> ConformalCorrection:
        """Rank each tail's residuals on its own and take the ⌈(n+1)(1−α)⌉-th.

        Two sequences and two arguments, so the independence of the tails is a
        property of the signature: nothing in this body can route an upper
        residual into ``delta_lo``. That is the acceptance criterion "perturbing
        only the upper tail's residuals leaves ``δ_lo`` unchanged", made true by
        construction rather than by a test that happens to pass.

        Neither sequence carries a key, an hour or a subsystem. The correction
        the spec asks for is global, and this signature is why a future edit
        cannot quietly make it conditional.
        """
        if len(lower_residuals) != len(upper_residuals):
            raise ConformalError(
                f"{len(lower_residuals)} lower and {len(upper_residuals)} upper "
                "residuals are not the same calibration rows; both tails are "
                "ranked over one window"
            )
        rows = len(lower_residuals)
        floor = minimum_calibration_rows(miscoverage)
        if rows < floor:
            raise ConformalError(
                f"{rows} curtailed hours in "
                f"{window[0].isoformat()}–{window[1].isoformat()} cannot support "
                f"a {1.0 - miscoverage:.0%} coverage statement; the "
                f"⌈(n+1)(1 − α)⌉-th smallest residual needs at least {floor}. "
                "A wider band is not the answer — the window is the answer."
            )
        rank = conformal_rank(rows, miscoverage)
        return cls(
            delta_lo=_order_statistic(lower_residuals, rank, "E_lo"),
            delta_hi=_order_statistic(upper_residuals, rank, "E_hi"),
            calibration_rows=rows,
            rank=rank,
            miscoverage=miscoverage,
            window_start=window[0],
            window_end=window[1],
        )

    def shift(self) -> TailShift:
        """The two scalars as a shift in ``q`` — the whole of how they are applied.

        The result is a :class:`~wattsteer_ml.mixture.TailShift`, which
        :func:`wattsteer_ml.mixture.compose` hands to the mixture and the
        mixture adds inside its positive branch. There is no other route from
        these numbers to a served interval, and this method contains no
        arithmetic beyond naming which scalar belongs to which tail — the
        interpolation rule, the median's zero and the flat ends are the shift's
        own, stated once where the composition can see them.

        No floor at zero here. The old knot correction needed one because
        ``MagnitudeQuantiles`` refuses a negative knot; a shift is a signed
        displacement of a quantile and the floor that matters is the mixture's
        own — into ``F_pos``'s support, strictly above ``τ`` — applied after the
        shift, exactly as it was applied after the corrected knot before.
        """
        return TailShift(lower_mwh=self.delta_lo, upper_mwh=self.delta_hi)

    def card_fields(self) -> dict[str, Any]:
        return {
            "delta_lo": self.delta_lo,
            "delta_hi": self.delta_hi,
            "conformal_method": "one_sided_split_cqr",
            "conformal_miscoverage": self.miscoverage,
            "conformal_target_coverage": self.target_coverage,
            "conformal_calibration_rows": self.calibration_rows,
            "conformal_rank": self.rank,
            "conformal_window": {
                "start": self.window_start.isoformat(),
                "end": self.window_end.isoformat(),
            },
            "conformal_guarantee": (
                "approximate: split conformal assumes exchangeability between "
                "the calibration window and the test period, and a time series "
                "with a growing fleet and a seasonal cycle is not exchangeable. "
                "Empirical fold coverage is the check; delta_lo growing across "
                "folds is the drift signal."
            ),
        }


@dataclass(frozen=True)
class CoverageCell:
    """Conditional coverage for one subsystem or one local hour.

    **Reported and never corrected.** A per-hour correction would fit 24 scalars
    on a window whose curtailed rows number in the low thousands and concentrate
    in a handful of hours; this dataclass is the reporting half of "correct
    marginally, report conditionally", and it has no route back into
    :class:`ConformalCorrection`.
    """

    label: str
    rows: int
    coverage_p10: float
    coverage_p90: float

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "rows": self.rows,
            "coverage_p10": self.coverage_p10,
            "coverage_p90": self.coverage_p90,
        }


@dataclass(frozen=True)
class CoverageReport:
    """Empirical coverage of one fold, marginally and two ways conditionally.

    **The population is the fold's curtailed hours**, the same population ``δ``
    was fitted over, and that choice is the difference between a check and a
    formality: over *every* hour the lower statement is trivially true, because
    the composed P10 is zero wherever ``p ≤ 0.90`` and an observed MWh is never
    negative. A ``coverage_p10`` of 0.99 over all hours would say nothing about
    the floor the product prints, and a guardrail on it could never fire.

    **Two structural limits this report is deliberately able to expose.** Both
    belong to the mixture rather than to the correction, and both are why these
    numbers are the check and the guarantee is only approximate.

    - Where ``p ≤ 0.90`` the composed P10 is **zero**, and no correction to
      ``Q_pos`` moves it — the branch is chosen before ``Q_pos`` is consulted.
      ``coverage_p10`` is then trivially 1.0 on those hours and ``δ_lo`` is
      inert. The floor the product prints really is 0 MWh there, and this report
      says so rather than dressing it up.
    - Where ``p ≤ 0.10`` the composed P90 is **zero** for the same reason, and a
      curtailed hour there cannot be covered by the upper statement at all.
      :attr:`upper_correction_realised` — the mean of
      :func:`upper_correction_fraction` over the scored hours — is that share
      published beside ``coverage_p90``, and it bounds it from above. It is
      ``1.0`` wherever the P90 is a positive number, because since forecaster
      ticket 21 the correction is added to the composed quantile and arrives
      whole; a value below ``1.0`` now says how many scored hours the classifier
      put in the point mass, not how much of ``δ_hi`` evaporated in an
      interpolant.

    **``coverage_p90`` and ``coverage_p10`` are the same kind of statement.**
    Both count a fold's curtailed hours against a served edge that has received
    its tail's whole ``δ`` wherever that edge is a positive number. Before
    ticket 21 they were not comparable — the upper edge carried a quarter of its
    correction on average — and a reader had to discount ``coverage_p90`` by a
    number in another field. They no longer have to.
    """

    fold_id: str
    rows: int
    coverage_p10: float
    coverage_p90: float
    #: The mean share of ``δ_hi`` that actually reached the composed P90 over the
    #: scored hours. ``1.0`` would mean the upper correction was applied in full
    #: everywhere; anything below it is the knot-correction attenuation, stated
    #: as a number rather than left for a reader to derive from ``p``.
    upper_correction_realised: float
    #: Share of scored hours below P50. Target 0.50 — the guardrail that stands
    #: in for the correction the median deliberately does not get.
    p50_unbiasedness: float
    #: The share of scored hours whose composed quantiles arrived out of order.
    #: Published beside the deltas because a band that had to be sorted is a
    #: band whose coverage statement is about three fits that disagreed.
    crossing_rate: float
    by_subsystem: tuple[CoverageCell, ...]
    by_local_hour: tuple[CoverageCell, ...]

    def __post_init__(self) -> None:
        if self.rows <= 0:
            raise ConformalError(
                f"{self.fold_id}: coverage over no curtailed hour is not a "
                "measurement; a fold with none is reported as absent, not as 0.0"
            )

    @property
    def guardrail_satisfied(self) -> bool:
        """Whether both coverages sit inside the gate's window. Reported only.

        The veto is forecaster ticket 13's; this property exists so the card can
        carry the answer beside the numbers rather than leaving a reader to
        compare them against a constant they have to go and find.
        """
        low, high = COVERAGE_GUARDRAIL
        return all(
            low <= value <= high for value in (self.coverage_p10, self.coverage_p90)
        )

    @classmethod
    def of(cls, hours: Sequence[ScoredHour], *, fold_id: str) -> CoverageReport:
        """Count coverage over the curtailed hours of one fold.

        Non-curtailed hours are dropped here rather than by the caller, so the
        population behind every number this class publishes is one decision made
        in one place.
        """
        scored = [hour for hour in hours if hour.is_positive]
        if not scored:
            raise ConformalError(
                f"{fold_id}: no scored hour is above τ, so there is no interval "
                "whose coverage could fail; this is a statement about the fold"
            )
        by_subsystem = [
            _cell(code, [one for one in scored if one.key.subsystem == code])
            for code in SUBSYSTEM_CODES
        ]
        by_local_hour = [
            _cell(
                f"{index:02d}",
                [one for one in scored if one.key.local_hour == index],
            )
            for index in range(HOURS_PER_DAY)
        ]
        return cls(
            fold_id=fold_id,
            rows=len(scored),
            coverage_p10=_share(scored, lambda hour: hour.covered_lower),
            coverage_p90=_share(scored, lambda hour: hour.covered_upper),
            upper_correction_realised=sum(
                upper_correction_fraction(hour.forecast.occurrence_probability)
                for hour in scored
            )
            / len(scored),
            p50_unbiasedness=_share(scored, lambda hour: hour.below_median),
            crossing_rate=crossing_rate(hour.forecast for hour in scored),
            by_subsystem=tuple(cell for cell in by_subsystem if cell is not None),
            by_local_hour=tuple(cell for cell in by_local_hour if cell is not None),
        )

    def card_fields(self) -> dict[str, Any]:
        return {
            "coverage_fold": self.fold_id,
            "coverage_population": "curtailed_hours",
            "coverage_rows": self.rows,
            "coverage_p10": self.coverage_p10,
            "coverage_p90": self.coverage_p90,
            "coverage_target": TARGET_COVERAGE,
            "coverage_guardrail": list(COVERAGE_GUARDRAIL),
            "coverage_guardrail_satisfied": self.guardrail_satisfied,
            "upper_correction_realised": self.upper_correction_realised,
            "upper_correction_note": (
                "the mean share of delta_hi that reached the composed P90. The "
                "correction is a shift in q applied to the composed quantile, so "
                "it arrives whole wherever the P90 is positive: this is 1.0 for "
                "every hour with p > 0.10, and 0.0 for the rest, where Q_Y(0.90) "
                "is exactly zero because 0.90 <= 1 - p and the mixture is stating "
                "at least a 90% chance of no curtailment. A value below 1.0 is "
                "therefore the share of scored hours the classifier put in the "
                "point mass, and it bounds coverage_p90 from above; it is no "
                "longer an under-application of delta_hi."
            ),
            "p50_unbiasedness": self.p50_unbiasedness,
            "crossing_rate": self.crossing_rate,
            "coverage_by_subsystem": [cell.as_card_entry() for cell in self.by_subsystem],
            "coverage_by_local_hour": [
                cell.as_card_entry() for cell in self.by_local_hour
            ],
            "coverage_conditional_use": (
                "reported, never corrected: the correction is one scalar per "
                "tail per artifact and no number in coverage_by_subsystem or "
                "coverage_by_local_hour is an input to it"
            ),
        }


@dataclass(frozen=True)
class DeltaDrift:
    """The drift hook: ``δ_lo`` and ``δ_hi`` across folds, in fold order.

    `docs/specs/forecaster.md` names this as the signal and names the response,
    and the two are deliberately different things. **This class detects and does
    not adapt.** A ``δ_lo`` that grows across folds means the boosters' intervals
    are drifting narrow and split conformal's exchangeability assumption is
    failing; the recorded next step is adaptive conformal — an online update of
    the target level — and it is not built, not partially built, and not
    switched on by any field here.
    """

    fold_ids: tuple[str, ...]
    delta_lo: tuple[float, ...]
    delta_hi: tuple[float, ...]

    def __post_init__(self) -> None:
        if len(self.fold_ids) != len(self.delta_lo) or len(self.fold_ids) != len(
            self.delta_hi
        ):
            raise ConformalError(
                f"{len(self.fold_ids)} folds against {len(self.delta_lo)} lower "
                f"and {len(self.delta_hi)} upper corrections"
            )
        if not self.fold_ids:
            raise ConformalError("drift across no fold is not a trend")

    @property
    def lower_drift(self) -> float:
        """``δ_lo`` last minus first. Positive is the failing direction."""
        return self.delta_lo[-1] - self.delta_lo[0]

    @property
    def upper_drift(self) -> float:
        """``δ_hi`` last minus first, reported beside its twin and not acted on."""
        return self.delta_hi[-1] - self.delta_hi[0]

    @property
    def lower_monotone_increasing(self) -> bool:
        """Whether every fold's ``δ_lo`` is at least its predecessor's.

        The sharpest form of the signal: a single noisy pair can move
        :attr:`lower_drift`, but a correction that grows at every step is a
        trend, and it is the one the spec says to act on.
        """
        return all(
            later >= earlier
            for earlier, later in zip(self.delta_lo, self.delta_lo[1:], strict=False)
        )

    @classmethod
    def across(cls, corrections: Mapping[str, ConformalCorrection]) -> DeltaDrift:
        """Assemble the trend from per-fold corrections, in the mapping's order.

        The caller's order, not a sort: fold ids are ``F1``…``F10`` and a
        lexicographic sort would put ``F10`` second. The walk-forward harness
        knows the order it ran in and hands it over.
        """
        if not corrections:
            raise ConformalError("drift across no fold is not a trend")
        return cls(
            fold_ids=tuple(corrections),
            delta_lo=tuple(one.delta_lo for one in corrections.values()),
            delta_hi=tuple(one.delta_hi for one in corrections.values()),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "folds": list(self.fold_ids),
            "delta_lo": list(self.delta_lo),
            "delta_hi": list(self.delta_hi),
            "lower_drift": self.lower_drift,
            "upper_drift": self.upper_drift,
            "lower_monotone_increasing": self.lower_monotone_increasing,
            "response": (
                "reported only. A growing delta_lo means split conformal's "
                "exchangeability assumption is failing; adaptive conformal is "
                "the spec's recorded next step and is not built"
            ),
        }


def residuals(
    hours: Sequence[ScoredHour],
) -> tuple[tuple[float, ...], tuple[float, ...]]:
    """``(E_lo, E_hi)`` over the curtailed hours of a calibration window.

    The one place the population is decided. Only rows above ``τ`` contribute:
    ``Q_pos`` is conditional on ``Y > τ`` and a sub-threshold row carries no
    information about the width of the conditional interval — its composed P10
    is zero and its residual would be ``−y``, a number that drags the order
    statistic down without ever having been a test of the tail.
    """
    scored = [hour for hour in hours if hour.is_positive]
    return (
        tuple(hour.lower_residual for hour in scored),
        tuple(hour.upper_residual for hour in scored),
    )


def conformalise(
    hours: Sequence[ScoredHour],
    *,
    window: tuple[date, date],
    miscoverage: float = NOMINAL_MISCOVERAGE,
) -> ConformalCorrection:
    """Fit both corrections on one calibration window's composed bands.

    The call training makes. It splits the hours into two residual sequences and
    hands them to :meth:`ConformalCorrection.fit`, which is where the ranking
    happens and where the keys are already gone.
    """
    lower, upper = residuals(hours)
    return ConformalCorrection.fit(
        lower_residuals=lower,
        upper_residuals=upper,
        window=window,
        miscoverage=miscoverage,
    )


def _order_statistic(values: Sequence[float], rank: int, name: str) -> float:
    """The ``rank``-th smallest, 1-based. Refuses a non-finite residual."""
    for value in values:
        if not math.isfinite(value):
            raise ConformalError(f"{name} carries {value!r}; a residual is MWh")
    return sorted(values)[rank - 1]


def _share(hours: Sequence[ScoredHour], predicate: Callable[[ScoredHour], bool]) -> float:
    return sum(1 for hour in hours if predicate(hour)) / len(hours)


def _cell(label: str, hours: Sequence[ScoredHour]) -> CoverageCell | None:
    """One conditional cell, or ``None`` where the fold had no such hour.

    Absent rather than zero: a subsystem with no curtailed hour in a fold has no
    coverage, and a 0.0 printed in that slot would read as total failure.
    """
    if not hours:
        return None
    return CoverageCell(
        label=label,
        rows=len(hours),
        coverage_p10=_share(hours, lambda hour: hour.covered_lower),
        coverage_p90=_share(hours, lambda hour: hour.covered_upper),
    )
