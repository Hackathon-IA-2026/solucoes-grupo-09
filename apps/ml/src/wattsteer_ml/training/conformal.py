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

**What the two coverages are each counted over — forecaster ticket 24.** Both
are counted over the *same* rows: every curtailed hour of the fold. What they
disagree about is what a **zero edge** means. At ``p <= 0.10`` the mixture puts
both served edges on the point mass, and the hour is scored, so ``y > tau > 0``:
``y >= P10`` holds for free and ``y <= P90`` fails with certainty. One
structural zero, two opposite verdicts, neither of them a fact about a tail's
width. That is why ``coverage_p10 = 1.0`` was read as a floor that held when the
served floor was 0 MWh on every row — and why a marginal ``coverage_p90`` short
of nominal is not, on its own, evidence that one global ``delta_hi`` cannot
cover a heteroscedastic upper tail.

:class:`CoverageReport` therefore publishes the denominator beside each figure:
:attr:`~CoverageReport.lower_stated_rows` and
:attr:`~CoverageReport.upper_stated_rows` are the scored hours on which each
edge is a positive number, and the two ``*_where_stated`` figures are the
coverage over those rows alone, ``None`` where there are none. The marginal
upper coverage factorises exactly —

    ``coverage_p90 = upper_correction_realised x coverage_p90_where_stated``

— because a row whose P90 is zero can never be covered. Only the first factor is
a fact about the classifier and only the second is one about this module's
correction, and separating them is what makes either diagnosable.

**The band is never printed as a 90% statement while it is not one.**
:attr:`CoverageReport.nominal_claim` is that verdict and
:attr:`CoverageReport.claim_note` is the sentence, both derived and neither
settable, carried onto the card and the wire. The claim needs both marginals
inside :data:`COVERAGE_GUARDRAIL` *and* at least one stated row per tail: a
coverage of 1.0 over no stated row is arithmetic, not a guarantee.
:data:`MARGINAL_COVERAGE_NOT_RUN_YET` travels with every withheld claim, because
no fold this repository can score is made of real rows, and the decomposition
can say where a short marginal comes from without saying whether the share it
comes from survives outside a fixture.

**This still does not add a second path to a band.** Forecaster ticket 01 made
the mixture inversion the only composition and it still is. This module produces
a :class:`~wattsteer_ml.mixture.TailShift` — two floats and an interpolation
rule, no ``p``, no band; forecaster 43 made the lower float a *multiple* of the
row's positive spread rather than MWh, and the scale is supplied by the mixture
at application time, so this class still holds nothing conditional — and
:func:`wattsteer_ml.mixture.compose` is the one place it is ever applied.
Nothing here constructs a :class:`~wattsteer_ml.mixture.QuantileBand`, calls
``compose``, or adds a scalar to a composed quantile. Ticket 07's ensemble
inverts one object, exactly as it did: the shift lives on the mixture the
ensemble already held, so the corrected
marginals *are* the served marginals and the hour band and the day band cannot
disagree about hour 14.

**Which rows each ``δ`` is ranked over — forecaster ticket 35.** Split
conformal's order statistic makes ``P(E ≤ δ) = 1 − α`` over *the rows it was
ranked on*, and that is a statement about the served band only where the served
band is the function of ``δ`` the residual assumed. It is not, on every row.
``Q_Y(0.10) = 0`` for every ``p ≤ 0.90``, and the shift is added inside the
positive branch, so on those rows ``δ_lo`` moves the served floor by exactly
nothing while their residuals ``E_lo = 0 − y`` sit in the ranking as though it
did. Forecaster ticket 33 measured the consequence in-window, where split
conformal is supposed to be exact by construction: ``coverage_p10`` **0.9771**
and **0.9765** on the two lanes' own calibration windows, against a 0.90 target.

The arithmetic is an identity, not an estimate. Write ``s`` for the share of
scored hours whose P10 is a positive number:

    ``coverage_p10 = (1 − s)·1 + s·coverage_p10_where_stated``

— the first term because a scored hour has ``y > τ > 0`` and ``y ≥ 0`` needs no
fit. Ticket 33's published in-window triples satisfy it to four decimals
(1061/3148 at 0.9321 gives 0.97710; 1051/3148 at 0.9296 gives 0.97648), so the
marginal was never the thing the ranking controlled.

**The lower tail is therefore ranked over the rows whose P10 is a statement**,
``p > 0.90``, the same population :attr:`CoverageReport.lower_stated_rows`
counts and :attr:`CoverageReport.coverage_p10_where_stated` is taken over.
What that buys and what it costs, precisely:

- ``coverage_p10_where_stated`` becomes exact in-window — the order statistic's
  own ``⌈(n+1)(1 − α)⌉/n``, on a population selected by ``p(x)`` alone and so
  legitimately conditionable, with the same approximate-exchangeability caveat
  as before.
- **The marginal guarantee is not traded for it.** The dropped rows are covered
  with probability one, so the marginal is ``(1 − s) + s·(≥ 0.90) ≥ 0.90`` by
  arithmetic, whatever the fit does. Nothing about the floor's promise rests on
  the fit for those rows, and nothing about it is weakened here.
- The served P10 moves, and **which way is a property of the data, not of the
  change**. Where the point-mass rows carry systematically smaller labels than
  the stated ones — which is the real classifier's behaviour, ticket 33's
  magnitude-decile table — the contaminated ranking over-covered the stated
  rows and the fix narrows the floor toward nominal. Where the two populations
  carry the same labels, it under-covered them badly and the fix widens it.
  Both directions are measured in :mod:`tests.test_conformal_quantiles`.

**The upper tail is deliberately left alone, and the asymmetry is the point.**
``E_hi`` has the same contamination — at ``p ≤ 0.10`` the served P90 is zero and
``δ_hi`` cannot move it — but its ineligible rows are certain *misses*, not
certain hits. Dropping them would lower ``δ_hi``, narrow the P90, and take the
marginal ``coverage_p90`` from ``s_hi·c`` to ``s_hi·0.90``, strictly below
nominal, with no arithmetic left to make up the difference. That is the
under-stated worst case forecaster ticket 21 refused to ship, and it is exactly
what the lower tail's fix does *not* cost. So the upper tail keeps a
conservative ``δ_hi`` and publishes the contamination instead:
:attr:`CoverageReport.upper_correction_realised` is ``s_hi`` and the
factorisation ``coverage_p90 = upper_correction_realised × coverage_p90_where_stated``
is where its shortfall is read.

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

from wattsteer_ml.caveated import CaveatedFigure
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.declined import DeclinedFigure
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

#: What the card carries in place of ``δ_lo`` when the calibration window holds
#: curtailed hours but too few of them have a P10 that is a positive number to
#: rank a residual over. **A fact about the classifier, not about the window's
#: length** — a longer window ranks the same kind of row over the same atom —
#: so the sentence says so rather than inviting a caller to widen the window
#: and try again, and ``δ_lo`` is ``0`` rather than a number ranked from
#: residuals that were never a test of the floor. On such a window every
#: ``E_lo`` is ``0 − y``: an order statistic of the negative labels, with no
#: model in it at all, which would then be applied to whatever stated rows the
#: *test* fold happens to have. Forecaster ticket 35.
LOWER_TAIL_NOT_FITTED = DeclinedFigure(
    "delta_lo is not stated for this fold. Its calibration window has too few "
    "curtailed hours whose P10 is a positive number to rank a residual over, "
    "so the served floor is the boosters' own 0.10 quantile, uncorrected, and "
    "carries no coverage statement. This is the classifier putting its "
    "curtailed hours in the point mass at zero, not a calibration window that "
    "is too short: a longer window ranks the same rows over the same atom.",
    figure="delta_lo, the lower conformal correction",
    kind="unrunnable",
    surface="the model card's Quantiles group, `conformal_lower_population`",
)

#: The hot-swap gate's coverage guardrail (`docs/specs/forecaster.md`). Named
#: here because this module is where coverage is measured; the veto itself is
#: forecaster ticket 13's and nothing in this file refuses anything.
COVERAGE_GUARDRAIL: tuple[float, float] = (0.85, 0.97)

#: The sentence :attr:`CoverageReport.claim_note` opens with when both marginal
#: coverages reach nominal over the fold's curtailed hours. The only wording
#: under which the served interval may be described as a 90% band.
NINETY_PERCENT_BAND = (
    "This fold's served band is a 90% band over its curtailed hours: each edge "
    "is a positive number on every scored row and each covers at least its "
    "nominal share of them, one tail at a time."
)

#: The sentence :attr:`CoverageReport.claim_note` opens with otherwise. It is
#: **a refusal, not a caveat**: a marginal coverage short of nominal, or a tail
#: with no row on which its edge is a bound at all, means the interval is not
#: the thing the label ``P10-P90`` invites a reader to assume, and the card and
#: the wire say so before they say anything else.
NOT_A_NINETY_PERCENT_BAND = CaveatedFigure(
    "This fold's served band is NOT a 90% band over its curtailed hours and "
    "must not be described as one.",
    figure=(
        "the served band a card prints as `P10`-`P90`, on a fold where the "
        "claim is withheld"
    ),
    misreading=(
        "that a band whose columns are labelled P10 and P90 covers 90% of the "
        "hours it is printed for"
    ),
    surface=(
        "`GET /v1/model/card`, `band.coverage.claim_note` — the opening "
        "sentence, before any figure, and `band.coverage.nominal_claim` as the "
        "same verdict in one field a caller can branch on"
    ),
)

#: Why a marginal ``coverage_p90`` is not the conformal correction's width.
#: **The sentence is byte-for-byte the one ``upper_correction_note`` has always
#: carried** — it is lifted out of the card dictionary into a constant so that
#: the census can find it, and the card still publishes it under the same key.
UPPER_CORRECTION_BOUNDS_COVERAGE_P90 = CaveatedFigure(
    "the mean share of delta_hi that reached the composed P90. The "
    "correction is a shift in q applied to the composed quantile, so "
    "it arrives whole wherever the P90 is positive: this is 1.0 for "
    "every hour with p > 0.10, and 0.0 for the rest, where Q_Y(0.90) "
    "is exactly zero because 0.90 <= 1 - p and the mixture is stating "
    "at least a 90% chance of no curtailment. A value below 1.0 is "
    "therefore the share of scored hours the classifier put in the "
    "point mass, and it bounds coverage_p90 from above; it is no "
    "longer an under-application of delta_hi.",
    figure=(
        "coverage_p90, the marginal, on a fold where "
        "`upper_correction_realised` is below 1.0"
    ),
    misreading=(
        "that a marginal coverage_p90 short of nominal is the conformal "
        "correction's width falling short"
    ),
    surface=(
        "`GET /v1/model/card`, `band.coverage.upper_correction_note`, beside "
        "`upper_correction_realised` and `coverage_p90`"
    ),
)

#: The figure this ticket exists for. ``coverage_p10 = 1.0`` is real
#: arithmetic; forecaster 24 found it had been computed over **zero** rows on
#: which the served floor was a positive number — 79 evaluations of ``y >= 0``
#: — and read for months as evidence that the floor was perfect. Nobody was
#: lying. The caveat simply was not attached to the number, and
#: :attr:`CoverageReport.coverage_p10_where_stated` going ``None`` is an
#: absence a reader has to notice rather than a sentence they have to read.
COVERAGE_P10_OVER_NO_STATED_ROW = CaveatedFigure(
    "coverage_p10 is 1.0 here and it is not a floor that held. No scored hour "
    "on this fold has a composed P10 that is a positive number: the classifier "
    "put every curtailed hour at p <= 0.90, where the mixture serves the point "
    "mass and the floor the product prints is 0 MWh. Every one of these "
    "evaluations is therefore y >= 0 on an hour known to be above tau, which "
    "is true by construction and could not have come out any other way. There "
    "is no lower coverage on this fold, which is why "
    "coverage_p10_where_stated is absent rather than 1.0, and no statement "
    "about the lower tail's width may be read off this figure in either "
    "direction.",
    figure="coverage_p10, on a fold where `coverage_stated_rows_p10` is zero",
    misreading="that the served floor held on every curtailed hour of this fold",
    surface=(
        "`GET /v1/model/card`, `band.coverage.coverage_p10_caveat`, published "
        "in the same block as `coverage_p10` and only where the lower edge "
        "states no bound at all"
    ),
)

#: Its twin, and deliberately not the same sentence. A structural zero is free
#: coverage below and certain failure above, so the two vacuous cases are
#: opposite verdicts and rounding them into one "the tail states no bound"
#: caveat would lose exactly the distinction forecaster 24 published the two
#: denominators to create.
COVERAGE_P90_OVER_NO_STATED_ROW = CaveatedFigure(
    "coverage_p90 is 0.0 here and it is not a ceiling that failed. No scored "
    "hour on this fold has a composed P90 that is a positive number: the "
    "classifier put every curtailed hour at p <= 0.10, where 0.90 <= 1 - p and "
    "the mixture is stating at least a 90% chance of no curtailment, so the "
    "served ceiling is exactly zero and a curtailed hour cannot be covered by "
    "it at all. Every one of these evaluations is y <= 0 on an hour known to be "
    "above tau, which is false by construction. The conformal correction's "
    "width is not what produced this figure, and delta_hi is inert on every row "
    "behind it.",
    figure="coverage_p90, on a fold where `coverage_stated_rows_p90` is zero",
    misreading=("that one global delta_hi failed to cover this fold's upper tail"),
    surface=(
        "`GET /v1/model/card`, `band.coverage.coverage_p90_caveat`, published "
        "in the same block as `coverage_p90` and only where the upper edge "
        "states no bound at all"
    ),
)

#: Ticket 18's shape and deliberately not ticket 16's. The decomposition below
#: says *where* a short marginal ``coverage_p90`` comes from; it cannot say
#: whether the share it comes from is a property of the served classifier,
#: because every fold this repository can score is fabricated. The arms exist
#: and the data exists -- the fold calendar, the feature function and the
#: settled labels are all here -- so the comparison is unmade rather than made
#: and found uninteresting.
MARGINAL_COVERAGE_NOT_RUN_YET = DeclinedFigure(
    "Whether a marginal coverage short of nominal survives outside a fixture "
    "has not been measured. It is not a finding that the served band "
    "under-covers on the grid and not a data source that is missing: the fold "
    "calendar, feature_rows and the settled labels are all present, and what "
    "this needs is a fold sweep against a migrated database with an ingested "
    "window. Every coverage figure in this repository's fixtures is arithmetic "
    "over invented rows and describes nothing about Brazil.",
    figure=("whether the served band's marginal coverage survives outside a fixture"),
    kind="unrun",
    surface="`GET /v1/model/card`, `band.coverage.claim_note`",
)

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
        """``E_lo = (q̂^0.10 − y) / spread``. Positive when the floor was too high.

        **Divided by this row's own positive spread since forecaster 43**, and
        `δ_lo` is therefore a multiple rather than MWh. The reason is measured:
        one fold's bands run 1,691→12,700 MWh on one subsystem and 0→3,029 on
        another, so a single MWh scalar is a rounding error on one row and most
        of the interval on the next — and what it delivers then depends on the
        magnitude mix of whatever period it lands on. Across a sweep of that
        shift the flat form gave 0.8023 to 0.9504 coverage with the model
        unchanged; normalised it gave 0.9165 throughout.

        The divisor is the mixture's, not the band's, so it is a property of the
        magnitude fit rather than of ``p`` — see
        `HurdleMixture.positive_spread_mwh`.
        """
        return (
            self.forecast.band.p10 - self.observed_mwh
        ) / self.forecast.mixture.positive_spread_mwh

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
    def states_lower_bound(self) -> bool:
        """Whether this hour's P10 is a positive number, and so says anything.

        Where it is not, the mixture has put the served 0.10 quantile on the
        point mass at zero, and ``covered_lower`` is true for free: the hour is
        scored, so ``y > tau > 0``, and ``y >= 0`` needs no fit to hold. Counting
        such a row in ``coverage_p10``'s numerator is correct -- the served floor
        really is 0 MWh and the label really is above it -- and reading the
        result as a statement about the floor's width is not.
        """
        return not in_point_mass(
            SERVED_QUANTILES[0], self.forecast.occurrence_probability
        )

    @property
    def states_upper_bound(self) -> bool:
        """Its twin, for the P90 -- and the same structure with the sign flipped.

        Where the P90 is on the point mass, ``covered_upper`` is false with
        certainty for exactly the reason its counterpart is true for free. One
        structural zero, two opposite verdicts, neither of them about the
        conformal correction's width.
        """
        return not in_point_mass(
            SERVED_QUANTILES[2], self.forecast.occurrence_probability
        )

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
    #: ``n_hi`` — the calibration window's curtailed hours, which is what the
    #: **upper** tail is ranked over. It was both tails' count until forecaster
    #: ticket 35; the lower tail now carries its own, below, and this field
    #: keeps its old name, its old meaning and its old value.
    calibration_rows: int
    #: ``⌈(n_hi + 1)(1 − α)⌉``, 1-based — the upper tail's order statistic.
    #: Stored so the published δ can be checked against the sample it came from
    #: without re-running the fit.
    rank: int
    #: ``n_lo`` — the subset of those hours whose served P10 is a positive
    #: number, and so the only rows ``δ_lo`` can move. Never above
    #: :attr:`calibration_rows`, and on Brazilian curtailment roughly a third
    #: of it. A separate field and not a ratio because the rank is an integer
    #: order statistic over an integer sample and a reader has to be able to
    #: re-derive it.
    lower_calibration_rows: int
    #: ``⌈(n_lo + 1)(1 − α)⌉``, 1-based — the lower tail's own order statistic.
    lower_rank: int
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
        if self.lower_calibration_rows > self.calibration_rows:
            raise ConformalError(
                f"{self.lower_calibration_rows} rows state a P10 out of "
                f"{self.calibration_rows} curtailed calibration hours; the "
                "lower tail is ranked over a subset of the window, never over "
                "more rows than the window holds"
            )
        if self.lower_calibration_rows < 0:
            raise ConformalError(f"{self.lower_calibration_rows} is not a row count")
        if self.lower_calibration_rows < floor:
            if self.lower_rank != 0 or self.delta_lo != 0.0:
                raise ConformalError(
                    f"{self.lower_calibration_rows} of {self.calibration_rows} "
                    "curtailed calibration hours state a P10, which is below "
                    f"the {floor} an order statistic needs, so delta_lo is "
                    "declined and must be 0.0 at rank 0; got "
                    f"delta_lo={self.delta_lo!r} at rank {self.lower_rank!r}. "
                    "A number ranked over rows the shift cannot move is not a "
                    "correction, and it is not made into one by being stored."
                )
            return
        expected_lower = conformal_rank(self.lower_calibration_rows, self.miscoverage)
        if self.lower_rank != expected_lower:
            raise ConformalError(
                f"lower_rank {self.lower_rank} is not ⌈(n+1)(1 − α)⌉ = "
                f"{expected_lower} for n = {self.lower_calibration_rows} at "
                f"α = {self.miscoverage}"
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

    @property
    def lower_tail_fitted(self) -> bool:
        """Whether ``δ_lo`` is an order statistic or a declined figure.

        ``False`` means the calibration window had fewer than
        :func:`minimum_calibration_rows` curtailed hours whose P10 was a
        positive number, ``delta_lo`` is ``0.0`` because nothing could be
        ranked, and the served floor is uncorrected. One predicate, so no
        reader has to infer it from a zero — ``delta_lo = 0.0`` is also a
        perfectly possible *fitted* value.
        """
        return self.lower_rank != 0

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

        **The two sequences are no longer the same rows** — forecaster ticket
        35. ``upper_residuals`` is the window's curtailed hours;
        ``lower_residuals`` is the subset of them whose P10 is a positive
        number, because ``δ_lo`` moves nothing on the rest. So the lengths
        differ, each tail gets its own ``n`` and its own
        ``⌈(n+1)(1 − α)⌉``, and the only cross-check left is the one that is
        actually an invariant: the lower population is a subset, so it can
        never be the larger of the two.

        **A window with too few stated rows declines ``δ_lo`` rather than
        inventing one.** Below :func:`minimum_calibration_rows` on the lower
        population there is no order statistic to take, and the residuals that
        remain are all ``0 − y`` — an order statistic of the negative labels,
        with no model in it. So ``delta_lo`` is ``0.0``, ``lower_rank`` is
        ``0``, :attr:`lower_tail_fitted` is ``False`` and the card carries
        :data:`LOWER_TAIL_NOT_FITTED`. The served floor is then the boosters'
        own 0.10 quantile, uncorrected and carrying no coverage statement,
        which is what it always was on such a window — the difference is that
        it now says so. The *upper* tail still refuses outright when the window
        itself is too short, because there is then no fold to speak of at all.
        """
        if len(lower_residuals) > len(upper_residuals):
            raise ConformalError(
                f"{len(lower_residuals)} lower and {len(upper_residuals)} upper "
                "residuals: the lower tail is ranked over the subset of this "
                "window's curtailed hours whose P10 is positive, so it cannot "
                "hold more rows than the window does"
            )
        rows = len(upper_residuals)
        lower_rows = len(lower_residuals)
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
        for value in lower_residuals:
            if not math.isfinite(value):
                raise ConformalError(f"E_lo carries {value!r}; a residual is MWh")
        fitted = lower_rows >= floor
        lower_rank = conformal_rank(lower_rows, miscoverage) if fitted else 0
        return cls(
            delta_lo=(
                _order_statistic(lower_residuals, lower_rank, "E_lo") if fitted else 0.0
            ),
            delta_hi=_order_statistic(upper_residuals, rank, "E_hi"),
            calibration_rows=rows,
            rank=rank,
            lower_calibration_rows=lower_rows,
            lower_rank=lower_rank,
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
        return TailShift(lower_spread_multiple=self.delta_lo, upper_mwh=self.delta_hi)

    def card_fields(self) -> dict[str, Any]:
        population = (
            (
                "delta_lo is ranked over the "
                f"{self.lower_calibration_rows} of this window's "
                f"{self.calibration_rows} curtailed hours whose P10 is a "
                "positive number, because the shift moves nothing on the "
                "others: their served floor is the mixture's point mass at "
                "zero. The 90% the lower tail is aimed at is therefore a "
                "statement about coverage_p10_where_stated, and the marginal "
                "coverage_p10 is that number blended with the rows covered by "
                "arithmetic — necessarily higher, never lower. delta_lo is a "
                "multiple of the row's own positive spread, Q_pos(0.90) − "
                "Q_pos(0.10), and not MWh: a flat MWh floor correction "
                "delivered between 0.8023 and 0.9504 coverage depending only "
                "on how the fleet's magnitudes moved between the calibration "
                "window and the test period, and scaled per row it delivered "
                "0.9165 across the same sweep. delta_hi is still MWh — the "
                "upper tail was covering, and a tail that covers is not "
                "changed on an argument measured somewhere else."
            )
            if self.lower_tail_fitted
            else LOWER_TAIL_NOT_FITTED
        )
        return {
            "delta_lo": self.delta_lo,
            "delta_hi": self.delta_hi,
            "conformal_method": "one_sided_split_cqr_stated_lower_spread_normalised",
            "conformal_miscoverage": self.miscoverage,
            "conformal_target_coverage": self.target_coverage,
            "conformal_calibration_rows": self.calibration_rows,
            "conformal_rank": self.rank,
            "conformal_lower_calibration_rows": self.lower_calibration_rows,
            "conformal_lower_rank": self.lower_rank,
            "conformal_lower_tail_fitted": self.lower_tail_fitted,
            "conformal_lower_population": population,
            "conformal_window": {
                "start": self.window_start.isoformat(),
                "end": self.window_end.isoformat(),
            },
            "conformal_guarantee": (
                "approximate: split conformal assumes exchangeability between "
                "the calibration window and the test period, and a time series "
                "with a growing fleet and a seasonal cycle is not exchangeable. "
                "Empirical fold coverage is the check; delta_lo growing across "
                "folds is the drift signal. What is aimed at 90% is "
                "coverage_p10_where_stated on the lower tail and the marginal "
                "coverage_p90 on the upper: the lower tail is ranked over the "
                "rows its delta can move, so the marginal coverage_p10 comes "
                "out above 90% by the share of rows whose floor is the point "
                "mass at zero, and that excess is structure rather than slack."
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
    #: The scored hours whose composed **P10 is a positive number** -- the rows
    #: on which the lower edge states a bound at all. Zero on a fold where the
    #: classifier put every curtailed hour at ``p <= 0.90``, and a
    #: ``coverage_p10`` of 1.0 beside a zero here is arithmetic over an edge
    #: that is 0 MWh everywhere, not a floor that held.
    lower_stated_rows: int
    #: Its twin: the scored hours whose composed **P90 is a positive number**.
    #: ``upper_correction_realised`` is this count over :attr:`rows`, and the
    #: count is published beside the share because a denominator a reader can
    #: see is the whole of what forecaster 24 asked for.
    upper_stated_rows: int
    #: ``coverage_p10`` counted over :attr:`lower_stated_rows` alone, or
    #: ``None`` where there are none. **Absent rather than 1.0**: a fold on
    #: which the floor was never a bound has no lower coverage, and printing a
    #: perfect score there is how ``coverage_p10 = 1.0`` came to read as
    #: evidence about a tail it says nothing about.
    coverage_p10_where_stated: float | None
    #: ``coverage_p90`` counted over :attr:`upper_stated_rows` alone, or
    #: ``None``. This is the figure the conformal correction's **width** is
    #: answerable for; the marginal is that width times
    #: :attr:`upper_correction_realised`, and only the second factor is a fact
    #: about the classifier.
    coverage_p90_where_stated: float | None
    #: Share of scored hours below P50. Target 0.50 — the guardrail that stands
    #: in for the correction the median deliberately does not get.
    p50_unbiasedness: float
    #: The share of scored hours whose composed quantiles arrived out of order.
    #: Published beside the deltas because a band that had to be sorted is a
    #: band whose coverage statement is about three fits that disagreed.
    #:
    #: Over this report's **curtailed** rows, and published as
    #: ``coverage_crossing_rate``:
    #: :attr:`~wattsteer_ml.evaluation.metrics.MetricsRow.crossing_rate` is the
    #: same quantity over every settled hour and keeps the bare
    #: ``crossing_rate`` key. The two are different populations and are not
    #: interchangeable — see :meth:`card_fields`.
    crossing_rate: float
    by_subsystem: tuple[CoverageCell, ...]
    by_local_hour: tuple[CoverageCell, ...]

    def __post_init__(self) -> None:
        if self.rows <= 0:
            raise ConformalError(
                f"{self.fold_id}: coverage over no curtailed hour is not a "
                "measurement; a fold with none is reported as absent, not as 0.0"
            )
        for tail, stated, where in (
            ("p10", self.lower_stated_rows, self.coverage_p10_where_stated),
            ("p90", self.upper_stated_rows, self.coverage_p90_where_stated),
        ):
            if not 0 <= stated <= self.rows:
                raise ConformalError(
                    f"{self.fold_id}: {stated} rows state a {tail} bound out of "
                    f"{self.rows} scored; the stated rows are a subset"
                )
            # The invariant forecaster 24 exists to protect: a coverage figure
            # and the denominator it was counted over travel together or not at
            # all. A number beside a zero denominator is the vacuous 1.0 that
            # started this, and `None` beside a positive one is a figure a
            # caller declined to count.
            if (stated == 0) is not (where is None):
                raise ConformalError(
                    f"{self.fold_id}: coverage_{tail}_where_stated is "
                    f"{where!r} over {stated} stated rows; a tail that states "
                    "no bound has no coverage, and one that does has a number"
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

    @property
    def nominal_claim(self) -> bool:
        """Whether this fold's served band may be described as a 90% band.

        Two conditions, both necessary, and neither of them new arithmetic.

        **The marginals sit inside** :data:`COVERAGE_GUARDRAIL` --
        :attr:`guardrail_satisfied`, the window the hot-swap gate already
        vetoes outside. A hard ``>= 0.90`` would be the wrong test and not a
        stricter one: conformal makes empirical coverage *equal* nominal rather
        than exceed it, so an honest 90% band lands either side of 0.90 by
        sampling noise, and a claim that flipped on the noise would say nothing.
        The window is the repository's already-published statement of where a
        coverage figure has to be, so nothing is invented here.

        **And each edge is a bound on at least one row.** A ``coverage_p10`` of
        1.0 over no stated row is arithmetic over an edge that is 0 MWh
        everywhere; it sits inside no window worth passing, and forecaster 24's
        finding is that it was being read as a tail that held.

        It is a property and not a stored field so that no caller can publish a
        band as 90% by handing this class a boolean. The card and the wire read
        it; nothing writes it.
        """
        return (
            self.guardrail_satisfied
            and self.lower_stated_rows > 0
            and self.upper_stated_rows > 0
        )

    @property
    def claim_note(self) -> str:
        """What the band may be called, and -- when it may not -- why not.

        Assembled from this fold's own numbers rather than stored, so it cannot
        go stale against them, and it opens with the verdict because that is the
        field a reader reaches first. Where the claim is withheld it carries the
        decomposition that says which factor is short, and
        :data:`MARGINAL_COVERAGE_NOT_RUN_YET`, because "this fixture's marginal
        is 0.66" is not a measurement of anything and must never be read as one.
        """
        if self.nominal_claim:
            return NINETY_PERCENT_BAND
        return " ".join(
            (
                NOT_A_NINETY_PERCENT_BAND,
                f"Over {self.rows} curtailed hours: coverage_p10 "
                f"{self.coverage_p10:.4f} on {self.lower_stated_rows} rows whose "
                f"P10 is a positive number, coverage_p90 {self.coverage_p90:.4f} "
                f"on {self.upper_stated_rows} rows whose P90 is. Where the edge "
                "is a bound at all the figures are "
                f"{_stated(self.coverage_p10_where_stated)} and "
                f"{_stated(self.coverage_p90_where_stated)}; the rest is the "
                "mixture's point mass at zero, which is free coverage below and "
                "certain failure above and is not the conformal correction's "
                "width in either direction.",
                MARGINAL_COVERAGE_NOT_RUN_YET,
            )
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
        lower_stated = [one for one in scored if one.states_lower_bound]
        upper_stated = [one for one in scored if one.states_upper_bound]
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
            lower_stated_rows=len(lower_stated),
            upper_stated_rows=len(upper_stated),
            coverage_p10_where_stated=(
                _share(lower_stated, lambda hour: hour.covered_lower)
                if lower_stated
                else None
            ),
            coverage_p90_where_stated=(
                _share(upper_stated, lambda hour: hour.covered_upper)
                if upper_stated
                else None
            ),
            p50_unbiasedness=_share(scored, lambda hour: hour.below_median),
            crossing_rate=crossing_rate(hour.forecast for hour in scored),
            by_subsystem=tuple(cell for cell in by_subsystem if cell is not None),
            by_local_hour=tuple(cell for cell in by_local_hour if cell is not None),
        )

    def card_fields(self) -> dict[str, Any]:
        """The block, and the caveat on either coverage that is vacuous.

        **The caveat is attached, not collected.** ``coverage_p10`` and
        ``coverage_p90`` are read by the hot-swap gate's guardrail, by the card
        and by whoever quotes the card, and none of those consumers is going to
        fetch ``/v1/meta`` to discover that the figure in their hand was
        counted over no row that could falsify it. So the sentence is published
        in the same dictionary as the number, under a key beside it, and only
        on the fold where it is true — a caveat that is always present is a
        caveat that is never read.

        :func:`~wattsteer_ml.caveated.caveated_figures` collects the same two
        objects for a reviewer, which is the other half and not a substitute:
        see :mod:`wattsteer_ml.caveated`.

        **Every key here names its population.** ``coverage_``-prefixed, and
        that is why ``crossing_rate`` is published from here as
        ``coverage_crossing_rate`` (forecaster 29): the bare name belongs to
        :attr:`~wattsteer_ml.evaluation.metrics.MetricsRow.crossing_rate`, over
        every settled hour, which is the figure the hot-swap gate vetoes on.
        **A reader holding both** quotes the settled-hour one — it is the
        model's crossing rate and the gate's — and reads
        ``coverage_crossing_rate`` only as a qualifier on the coverage numbers
        beside it: a coverage statement counted over rows whose band had to be
        sorted is a statement about three fits that disagreed. They are never
        compared to each other and never substituted for one another; they have
        different denominators, so a difference between them is a fact about
        which hours are curtailed and not about the band.
        """
        fields: dict[str, Any] = {
            "coverage_fold": self.fold_id,
            "coverage_population": "curtailed_hours",
            "coverage_rows": self.rows,
            "coverage_p10": self.coverage_p10,
            "coverage_p90": self.coverage_p90,
            "coverage_target": TARGET_COVERAGE,
            "coverage_guardrail": list(COVERAGE_GUARDRAIL),
            "coverage_guardrail_satisfied": self.guardrail_satisfied,
            "upper_correction_realised": self.upper_correction_realised,
            "coverage_stated_rows_p10": self.lower_stated_rows,
            "coverage_stated_rows_p90": self.upper_stated_rows,
            "coverage_p10_where_stated": self.coverage_p10_where_stated,
            "coverage_p90_where_stated": self.coverage_p90_where_stated,
            "coverage_nominal_claim": self.nominal_claim,
            "coverage_claim_note": self.claim_note,
            "upper_correction_note": UPPER_CORRECTION_BOUNDS_COVERAGE_P90,
            "p50_unbiasedness": self.p50_unbiasedness,
            # `coverage_crossing_rate`, and never `crossing_rate` — forecaster
            # 29. This figure is counted over the **curtailed hours** this
            # report covers; `MetricsRow.crossing_rate` is the same quantity
            # over **every settled hour**, and it is the one the hot-swap gate
            # vetoes on and the one a reader should quote. Under the bare name
            # this dictionary won whenever it was merged into a row that had
            # already published the settled-hour figure, so the published
            # `crossing_rate` meant one population or the other depending on
            # whether a `CoverageReport` existed. The prefix every other key
            # here carries is what states the population, so it carries it too.
            "coverage_crossing_rate": self.crossing_rate,
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
        if self.lower_stated_rows == 0:
            fields["coverage_p10_caveat"] = COVERAGE_P10_OVER_NO_STATED_ROW
        if self.upper_stated_rows == 0:
            fields["coverage_p90_caveat"] = COVERAGE_P90_OVER_NO_STATED_ROW
        return fields


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
    """``(E_lo, E_hi)`` over the rows each tail's ``δ`` can actually move.

    The one place the population is decided, and **the two tails no longer
    share it** — forecaster ticket 35. Both start from the curtailed hours:
    ``Q_pos`` is conditional on ``Y > τ`` and a sub-threshold row carries no
    information about the width of the conditional interval — its composed P10
    is zero and its residual would be ``−y``, a number that drags the order
    statistic down without ever having been a test of the tail.

    ``E_lo`` is then narrowed again, to the curtailed hours whose **P10 is a
    positive number** — :attr:`ScoredHour.states_lower_bound`, ``p > 0.90``,
    the same rows :attr:`CoverageReport.coverage_p10_where_stated` is counted
    over. On the others the served floor is the point mass at zero, ``δ_lo``
    moves it by nothing at all, and the row is covered by arithmetic rather
    than by a fit. Ranking such a row is the same category error a
    sub-threshold row would be, one level up: a residual that was never a test
    of the tail. See the module docstring, "Which rows each ``δ`` is ranked
    over".

    ``E_hi`` is **not** narrowed the same way, deliberately, and the module
    docstring says why: its ineligible rows are certain *misses*, not certain
    hits, and dropping them would trade a marginal guarantee the lower tail's
    fix keeps for free.

    The two sequences therefore differ in length, and the shorter one is always
    the lower tail's.
    """
    scored = [hour for hour in hours if hour.is_positive]
    return (
        tuple(hour.lower_residual for hour in scored if hour.states_lower_bound),
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


def _stated(value: float | None) -> str:
    """A conditional coverage for the note, or the word for its absence.

    ``"absent"`` and never ``"1.0000"``: a tail with no stated row has no
    coverage, and forecaster 24's finding is that a number printed in that slot
    is read as a tail that held.
    """
    return "absent" if value is None else f"{value:.4f}"


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
