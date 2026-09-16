"""What the lower tail is calibrated *to*, and why the rail cannot pass today.

`test_calibration_excess_rail.py` establishes that a correctly calibrated band
passes `p10_calibration_excess` by construction, because the served law puts
mass at the P10 and `P(y >= P10) = p` on every qualifying row. This file asks
the next question: **does split conformal, as configured, produce that band?**

It does not, and the reason is arithmetic rather than a fit going wrong.

- A floor is *stated* only where ``p > 0.90``; below that ``Q_Y(0.10)`` is the
  point mass at zero. So the calibration population is selected, and ``mean(p)``
  over it is high — 0.9762 on the 2026-09-16 artifacts.
- ``residuals()`` narrows ``E_lo`` to exactly those rows, which is right.
- ``conformal_rank`` then takes the ``⌈(n + 1)(1 − α)⌉`` order statistic at the
  **nominal** ``α = 0.10``.

Ranking at 0.10 fits a ``δ_lo`` that leaves 90% of those rows covered. But the
served law already implies ``p`` — 97.6% — on the same rows, so the correction
does not repair the floor, it *lowers coverage toward 0.90*. The rail then
differences against ``p`` and reads ``0.90 − p``, which is −0.076: outside a
±0.042 band before a single model is fitted.

The fix these tests describe is narrow. The population stays as it is; only the
target moves, from the nominal 0.10 to the miscoverage the served law itself
implies on the rows being calibrated, ``1 − mean(p)``.
"""

from __future__ import annotations

import math
import random
from statistics import NormalDist

import pytest

from wattsteer_ml.mixture import MagnitudeQuantiles, implied_lower_clearance
from wattsteer_ml.training.conformal import (
    COVERAGE_GUARDRAIL,
    NOMINAL_MISCOVERAGE,
    conformal_rank,
    lower_tail_miscoverage,
)

#: The measured mean `p` over qualifying rows on the 2026-09-16 artifacts.
#: `gate_early` read 0.9762 and `gate_late` 0.9803; the lower one is used, so a
#: passing assertion here is not resting on the more favourable lane.
MEASURED_MEAN_P = 0.9762

DAYS = 76
PER_DAY = 18
DRAWS = 400


def _z() -> float:
    return NormalDist().inv_cdf(1.0 - NOMINAL_MISCOVERAGE / 2.0)


def _excess(seed: int, delivered: float, mean_p: float) -> tuple[float, float]:
    """One fold where the band delivers `delivered` against a law implying `mean_p`.

    The draw is of the statistic, as in the rail's own test: each row is a
    Bernoulli at the *delivered* rate while the rail differences against the
    row's own ``p``, which is what a band calibrated to the wrong target does.
    """
    rng = random.Random(seed)  # noqa: S311 — a null draw, not a security decision
    blocks: list[list[float]] = []
    total = 0
    for _ in range(DAYS):
        block: list[float] = []
        for _ in range(PER_DAY):
            p = rng.uniform(mean_p - 0.02, min(0.999, mean_p + 0.02))
            hit = 1.0 if rng.random() < delivered else 0.0
            block.append(hit - p)
            total += 1
        blocks.append(block)
    excess = sum(sum(b) for b in blocks) / total
    g = len(blocks)
    centred = [sum(d - excess for d in b) for b in blocks]
    se = math.sqrt(sum(c * c for c in centred) * g / ((g - 1) * total * total))
    return excess, se


def _passes(delivered: float, mean_p: float = MEASURED_MEAN_P) -> int:
    z = _z()
    passed = 0
    for seed in range(DRAWS):
        excess, se = _excess(seed, delivered, mean_p)
        passed += abs(excess) <= z * se
    return passed


def test_ranking_at_the_nominal_alpha_targets_a_coverage_the_law_does_not_imply() -> None:
    """The defect, as one comparison.

    Nothing here is about a model being bad. A band that hits its target exactly
    still fails, because the target is not the one the served law implies.
    """
    delivered_by_nominal = 1.0 - NOMINAL_MISCOVERAGE

    assert delivered_by_nominal == 0.90
    # The gap the rail will read, before any fitting error at all.
    structural = delivered_by_nominal - MEASURED_MEAN_P
    assert structural < -0.07

    # And it is outside the band on essentially every fold.
    assert _passes(delivered_by_nominal) < DRAWS * 0.05


def test_ranking_at_the_implied_miscoverage_passes_at_the_nominal_rate() -> None:
    """The fix, as the same comparison.

    A band calibrated to ``1 − mean(p)`` delivers what the law implies, and the
    rail is then measuring a fit rather than a definition.
    """
    assert _passes(MEASURED_MEAN_P) > DRAWS * 0.85


def test_the_implied_miscoverage_is_read_off_the_rows_being_calibrated() -> None:
    """`lower_tail_miscoverage` is the whole change, and it is one line of algebra.

    It is a function of the calibration population rather than a constant,
    because the population is selected by ``p > 0.90`` and its mean ``p`` is a
    property of the fold, not of the spec.
    """
    assert lower_tail_miscoverage([0.98] * 200) == pytest.approx(0.02)
    assert lower_tail_miscoverage([0.95] * 100 + [0.99] * 100) == pytest.approx(0.03)


def test_it_never_targets_finer_than_the_sample_can_resolve() -> None:
    """``n`` residuals resolve miscoverage no finer than ``1 / (n + 1)``.

    Below that the ``⌈(n + 1)(1 − α)⌉``-th order statistic is the ``n + 1``-th,
    which does not exist — an `IndexError` rather than a wrong number, and the
    first thing this change broke. A tiny sample of confident rows therefore
    gets the floor, not the target its mean implies.
    """
    # Three rows at 0.98 imply 0.02, but three rows resolve only 0.25 — so the
    # nominal wins, and the fold declines rather than over-claiming.
    assert lower_tail_miscoverage([0.98] * 3) == NOMINAL_MISCOVERAGE
    # Rows that are all certain would imply "cover always", which no finite
    # sample can state.
    assert lower_tail_miscoverage([1.0] * 50) == pytest.approx(1.0 / 51)


def test_it_never_targets_less_than_the_nominal_floor() -> None:
    """A guard the spec needs and the algebra does not give for free.

    If a fold's qualifying rows came back with a low mean ``p`` — every one of
    them barely over 0.90 — the implied miscoverage would approach the nominal
    0.10 from below and never exceed it. A *wider* miscoverage than nominal
    would be this function quietly relaxing the product's published 90% floor,
    which is not a trade the calibration step is allowed to make on its own.
    """
    assert lower_tail_miscoverage([0.901, 0.902]) <= NOMINAL_MISCOVERAGE
    # Degenerate input keeps the nominal rather than inventing a target.
    assert lower_tail_miscoverage([]) == NOMINAL_MISCOVERAGE


def test_the_rank_moves_with_the_target() -> None:
    """The rank is where the new miscoverage has to arrive, or nothing changes."""
    rows = 1346
    nominal = conformal_rank(rows, NOMINAL_MISCOVERAGE)
    implied = conformal_rank(rows, lower_tail_miscoverage([MEASURED_MEAN_P] * rows))

    # A higher order statistic: less of the residual distribution is discarded,
    # so the floor sits lower and clears more often.
    assert implied > nominal
    assert nominal == math.ceil((rows + 1) * 0.90 - 1e-9)


def test_targeting_the_implied_miscoverage_breaks_the_marginal_rail() -> None:
    """**Why the narrow fix is refused, as arithmetic rather than opinion.**

    Ranking at ``1 − mean(p)`` does make `p10_calibration_excess` pass — the two
    tests above measure that. It also drives *marginal* `coverage_p10` out of
    `COVERAGE_GUARDRAIL`, and this is why.

    The free-floor rows — those with ``p ≤ 0.90``, whose served P10 is the point
    mass at zero — are covered with probability 1 whatever ``δ_lo`` does. On the
    2026-09-16 artifacts they are 2,141 of 3,487 rows, 61%. Marginal coverage is
    therefore ``f + (1 − f) × stated``, and pushing ``stated`` up to ``p`` pushes
    the marginal above the guardrail's ceiling.

    Measured on the synthetic fold in `test_conformal_quantiles.py`, the wired
    version read 0.9997 against a ceiling of 0.97.

    So the two claims cannot both hold while the composed P10 is pinned to
    `MagnitudeQuantiles`' first knot: "a P10 with 90% marginal coverage" and
    "a floor that clears at the rate the served law states". Choosing between
    them is a decision about what the product's floor *means*.
    """
    free_share = 2141 / 3487
    low, high = COVERAGE_GUARDRAIL

    # Targeting the nominal keeps the marginal inside the guardrail.
    at_nominal = free_share + (1 - free_share) * (1.0 - NOMINAL_MISCOVERAGE)
    assert low <= at_nominal <= high

    # Targeting what the law implies does not.
    at_implied = free_share + (1 - free_share) * MEASURED_MEAN_P
    assert at_implied > high


def test_the_window_rail_still_reads_what_it_always_did() -> None:
    """The other rail is unchanged, and must stay unchanged.

    `coverage_p10_in_band` measures marginal coverage against the published
    90% floor. Moving the *lower tail's* calibration target does not move that
    claim: the product still publishes a P10, and the guardrail around it is
    still the one the spec names.
    """
    low, high = COVERAGE_GUARDRAIL
    assert low <= 0.90 <= high


def test_the_rail_now_expects_what_the_served_law_actually_implies() -> None:
    """The rail's premise follows the knot that changed under it.

    Forecaster 34's identity — a stated floor clears at ``p`` — was a
    consequence of `MagnitudeQuantiles` being flat below 0.10, not a property of
    hurdle mixtures in general. With the 0.02 knot the composed P10 interpolates
    above ``p = 0.918`` and a correct band clears it at 0.90, so a rail still
    differencing against ``p`` would score the band against a law the product no
    longer serves — and would keep refusing every artifact for a reason that had
    been fixed.
    """
    fitted = MagnitudeQuantiles.from_boosters(q02=30.0, q10=40.0, q50=90.0, q90=200.0)

    # Still on the flat below the first knot: mass sits at the floor.
    assert implied_lower_clearance(0.905, fitted) == pytest.approx(0.905)
    # Interpolating: a genuine 10th percentile, so 0.90 whatever `p` is.
    assert implied_lower_clearance(0.95, fitted) == pytest.approx(0.90)
    assert implied_lower_clearance(0.999, fitted) == pytest.approx(0.90)

    # The boundary is where u crosses the first knot, and it is 0.90 / 0.98.
    boundary = 0.90 / (1.0 - 0.02)
    assert implied_lower_clearance(boundary - 0.001, fitted) > 0.90
    assert implied_lower_clearance(boundary + 0.001, fitted) == pytest.approx(0.90)


def test_a_repeated_knot_keeps_the_old_law_because_it_is_still_flat() -> None:
    """Every rung of the baseline ladder, and why `u` alone cannot decide this.

    A rung fits three knots, so `compose_estimates` repeats ``q10`` into the
    0.02 slot. A repeated knot is a flat segment: the mass is still at the
    served floor and the row still clears at ``p``. Reading flatness off ``u``
    would have scored the whole ladder against a law it does not serve — the
    mirror of the defect this change fixes.
    """
    repeated = MagnitudeQuantiles.from_boosters(q02=40.0, q10=40.0, q50=90.0, q90=200.0)

    for p in (0.93, 0.95, 0.976, 0.99):
        assert implied_lower_clearance(p, repeated) == pytest.approx(p)


def test_the_two_targets_now_agree_on_the_rows_that_interpolate() -> None:
    """Why this is the fix and the lower-tail retarget was not.

    Split conformal ranks `E_lo` at the nominal 0.10, so it fits a floor that
    leaves 90% of the stated rows covered. Above p = 0.918 the served law now
    implies exactly that. The two components want the same number, and the
    marginal guardrail is untouched because the floor did not move — what moved
    is what the law claims about it.
    """
    fitted = MagnitudeQuantiles.from_boosters(q02=30.0, q10=40.0, q50=90.0, q90=200.0)
    for p in (0.93, 0.95, 0.976, 0.99):
        assert implied_lower_clearance(p, fitted) == pytest.approx(
            1.0 - NOMINAL_MISCOVERAGE
        )
