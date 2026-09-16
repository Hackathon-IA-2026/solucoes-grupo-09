"""Forecaster 42's acceptance test — the one forecaster 34 could not pass.

`coverage_p10_in_band` cannot read 0.90 on a model whose own law says 0.98, and
forecaster 34 measured why: ``Q_pos`` is flat below its first knot, so the
served law puts probability mass ``p - 0.90`` exactly *at* the P10, coverage
counts that atom as covered, and ``P(y >= P10) = p`` on every qualifying row.

`p10_calibration_excess` differences against that same law, so the atom appears
in both terms and cancels. The property this file exists to hold is therefore
not "the rail is about right" but **"a correctly calibrated band passes at the
nominal rate, by construction"** — and, separately, that it still refuses the
miscalibration forecaster 34 measured on the real bundles.

The draws here are of the *statistic*, not of the whole pipeline: the null is
defined by ``P(y >= P10) = p``, which is the identity forecaster 34 established,
so a row is a Bernoulli draw at its own ``p``. Simulating the boosters would add
no information about the rail and a great deal of runtime.
"""

from __future__ import annotations

import random

# From `training.conformal`, which defines them, rather than through
# `evaluation.gate`, which only imports them to use. Reaching a constant through
# a module that happens to have imported it is the kind of coupling that breaks
# when that module stops needing it, and mypy refuses the implicit re-export.
from wattsteer_ml.training.conformal import COVERAGE_GUARDRAIL, NOMINAL_MISCOVERAGE

#: Forecaster 34's measured mean ``p`` over qualifying rows: 0.9772 and 0.9795.
#: The window rail fails *because* of this number, so a null drawn anywhere else
#: would not reproduce the defect and the comparison below would be vacuous.
NULL_P_RANGE = (0.955, 0.999)

#: Forecaster 34's measured shape: ~1,400 qualifying rows over ~120 target days.
DAYS, PER_DAY, DRAWS = 120, 12, 200


def _z() -> float:
    from statistics import NormalDist

    return NormalDist().inv_cdf(1.0 - NOMINAL_MISCOVERAGE / 2.0)


def _draw(seed: int, shortfall: float) -> tuple[float, float, float]:
    """One fold. ``shortfall`` is how far the band under-delivers on its own p."""
    rng = random.Random(seed)  # noqa: S311 — a null draw, not a security decision
    realised: list[float] = []
    blocks: list[list[float]] = []
    for _ in range(DAYS):
        block: list[float] = []
        for _ in range(PER_DAY):
            p = rng.uniform(*NULL_P_RANGE)
            hit = 0.0 if rng.random() < (1.0 - p) + shortfall else 1.0
            realised.append(hit)
            block.append(hit - p)
        blocks.append(block)
    n = len(realised)
    coverage = sum(realised) / n
    excess = sum(sum(b) for b in blocks) / n
    g = len(blocks)
    centred = [sum(d - excess for d in b) for b in blocks]
    se = (sum(c * c for c in centred) * g / ((g - 1) * n * n)) ** 0.5
    return coverage, excess, se


def _rates(shortfall: float) -> tuple[int, int]:
    """How often each rail passes, over `DRAWS` independent folds."""
    low, high = COVERAGE_GUARDRAIL
    z = _z()
    window_pass = excess_pass = 0
    for seed in range(DRAWS):
        coverage, excess, se = _draw(seed, shortfall)
        window_pass += low <= coverage <= high
        excess_pass += abs(excess) <= z * se
    return window_pass, excess_pass


def test_the_perfectly_calibrated_null_passes_the_excess_rail() -> None:
    """The box forecaster 34 left open, closed.

    Nominal is ``1 - NOMINAL_MISCOVERAGE``; the bound is loose enough to absorb
    the Monte-Carlo error of 200 draws and tight enough that a rail passing
    everything or nothing fails it.
    """
    _, excess_pass = _rates(0.0)
    nominal = (1.0 - NOMINAL_MISCOVERAGE) * DRAWS
    assert excess_pass >= nominal - 3 * (DRAWS * NOMINAL_MISCOVERAGE) ** 0.5
    assert excess_pass <= DRAWS


def test_the_window_rail_fails_the_same_null_which_is_why_this_rail_exists() -> None:
    """Non-vacuity, and the whole justification for a second statistic.

    If the window rail passed this null, forecaster 34's box would have been a
    measurement error rather than a defect and none of this would be needed.
    """
    window_pass, excess_pass = _rates(0.0)
    assert window_pass < 0.25 * DRAWS, (
        "the window rail is supposed to fail a correctly calibrated band at "
        "this mean p — if it passes, the premise of forecaster 42 is wrong"
    )
    assert excess_pass > 4 * window_pass


def test_it_refuses_the_miscalibration_forecaster_34_measured() -> None:
    """Centred *and* discriminating — which the p50 rail could not be.

    -0.034 is `gate_early`'s measured excess on the real bundle. A rail that
    passed the null and also passed that would be measuring nothing.
    """
    _, at_gate_early = _rates(0.034)
    assert at_gate_early == 0

    _, at_gross = _rates(0.10)
    assert at_gross == 0


def test_a_mild_deviation_is_not_treated_as_a_gross_one() -> None:
    """`gate_late`'s measured -0.006 is inside the noise at this sample size.

    Stated so the rail's resolution is on the record: it is a test of
    distinguishability, not a demand that the excess be exactly zero.
    """
    _, at_gate_late = _rates(0.006)
    assert at_gate_late > 0.5 * DRAWS
    _, at_null = _rates(0.0)
    assert at_gate_late < at_null
