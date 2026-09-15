"""The hot-swap gate: one number decides, the constants only veto.

`docs/specs/forecaster.md`, "The hot-swap gate — the checks, in order. All must
pass." An operator does not make a judgement call at 03:00: the weekly candidate
is promoted or refused by a comparison against the incumbent, and either way the
decision and its evidence land on the volume.

**No invented constant decides anything here.** The map records the backtest
threshold as unspecifiable before the first honest numbers exist, which is an
argument against an *absolute* bar and not against a gate. The decision is a
paired block bootstrap against the incumbent: decidable on day one, automatically
stricter as the incumbent improves, and impossible to tune into passing, because
the thing it is measured against is the thing currently being served.

**The guardrails are vetoes and are stated as constants** — :data:`PR_AUC_SLACK`,
:data:`~wattsteer_ml.training.conformal.COVERAGE_GUARDRAIL`,
:data:`P50_UNBIASEDNESS_WINDOW`, :data:`ECE_CEILING`,
:data:`CROSSING_RATE_CEILING`, :data:`RECALL_SLACK`,
:data:`NULL_RATE_DRIFT_CEILING`. They are placed where a wrong value **blocks a
swap rather than choosing one**: every one of them can only turn a promotion into
a refusal, never the other way round. That is also why an unmeasurable guardrail
vetoes — a candidate whose ECE could not be computed has not shown that its ECE
is under the ceiling, and "not shown" and "shown to be fine" are different
sentences.

**This is not a Backtest.** `docs/domain-model.md` gives that noun to the
aggregate of many `Replay`s; what this module reads is *fold evaluation*
(:mod:`wattsteer_ml.evaluation`). Two harnesses, two names.

**What the shapes here make unrepresentable:**

**A coverage rail is counted over the rows that could falsify it** — forecaster
34. The marginal ``coverage_p10`` is *not* a rail here and never was a usable
one: 56% of its denominator on the first two artifacts was the mixture's point
mass at zero, where a scored hour clears a 0 MWh floor whatever the fit does, so
the statistic read 0.9753 and 0.9884 against a 0.97 ceiling on a candidate that
beat the baseline at ``P = 1.000`` while a shuffled-label control read 0.9211
and passed. :data:`BAND_COVERAGE_RAIL` replaces it with the same coverage over
the hours whose served P10 is a positive magnitude above ``τ``, and refuses —
saying the sample was too small — when fewer than
:func:`minimum_band_coverage_rows` of them exist. The marginal stays on the
card, under its own name, as the description of the fold it has always been.

- **A decision without its evidence.** :class:`GateDecision` carries every check
  it ran, in order, and refuses to be a promotion unless a bootstrap that
  cleared :data:`PROMOTION_PROBABILITY` is attached to it. "We swapped and
  nobody knows why" is not a value this module can hold.
- **A comparison across rows.** The paired bootstrap refuses two hour sequences
  whose keys are not identical and in the same order, and refuses two that were
  scored against different labels. Two models scored on different rows are not a
  paired comparison, and the difference is invisible in two numbers that both
  look fine.
- **An hour-wise bootstrap.** :func:`paired_block_bootstrap` resamples whole
  target days and has no parameter that would let it do anything else. Hours
  within a day are strongly dependent, and an hour-wise resample reports a
  confidence the data does not support.
- **A second bootstrap.** The resampling is :func:`resample_day_blocks` and
  :func:`paired_block_bootstrap` is the ``qloss_mwh`` statistic laid over it.
  :mod:`~wattsteer_ml.evaluation.dessem_ab` lays a floor-MWh statistic over the
  *same* function, with the same :data:`BOOTSTRAP_DRAWS`, the same
  :data:`BOOTSTRAP_SEED` and the same whole-day blocks, because
  `docs/specs/forecaster.md` ships DESSEM only under "the same paired block
  bootstrap the hot-swap gate uses" — and two implementations of one sentence
  is how that stops being true.
- **A promotion onto a value the gate could not have seen.** Check 7 refuses a
  candidate whose serving rows carry an attribute its gate profile withholds —
  a ``gate_early`` artifact holding a ``programmed_*`` value has been fitted on
  a number it will not have at 09:00. The refusal is a fault rather than a
  tolerance, because there is no acceptable amount of it.
- **A promotion into a changed feature contract.** Check 3 compares the
  candidate's ``feature_hash`` against the hash the *live* ``feature_rows``
  produces right now. When they disagree the incumbent was fitted against the
  same departed SQL, so it is invalid too: the gate refuses, marks the
  incumbent's card with a contract fault — which
  :func:`~wattsteer_ml.training.bundle.load_artifact` then refuses to load past
  — and raises :class:`ContractDriftError`. Nothing is deleted and the log keeps
  every line it had.
- **A refusal that vanishes.** :func:`record_decision` writes the card's
  ``gate`` block first and appends exactly one line second, so a crash between
  the two leaves an inspectable card and an unpromoted artifact rather than a
  promotion whose evidence never landed.

**Rollback is an append.** :func:`rollback` writes a new ``promote`` line naming
an earlier artifact. The bad promotion's line stays where it was and no file on
the volume is removed, which is what makes the incident readable afterwards.

**A retrain that produced no artifact is not a refusal.**
:func:`~wattsteer_ml.training.calibration.derive_risk_bins` *raises* when no
split of the pool satisfies the spec's rule and there is no usable incumbent, so
training fails loudly rather than publishing risk edges nobody measured. There is
then no bundle, no card and no ``artifact_id`` — and a promotion log keyed by
artifact id has nothing to say. :class:`NoCandidate` is that outcome named: the
log is untouched, the incumbent goes on serving because the most recent
``promote`` line still names it, and the weekly job reports why. Writing a
refusal against an invented id would be worse than silence, because the id would
name nothing an operator could go and inspect.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from statistics import NormalDist
from typing import Any, Literal

import numpy as np

from wattsteer_ml.admissibility import (
    WithheldAtGateError,
    assert_nothing_withheld_was_seen,
)
from wattsteer_ml.artifacts import ARTIFACT_SUFFIX, CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation.ladder import FoldRows, SameHourSevenDayRung
from wattsteer_ml.evaluation.matrix import HOURS_PER_DAY
from wattsteer_ml.evaluation.metrics import MetricsRow, MetricsTable, pinball
from wattsteer_ml.evaluation.vintage import FoldSegment
from wattsteer_ml.lanes import Lane, format_instant
from wattsteer_ml.mixture import SERVED_QUANTILES
from wattsteer_ml.promotions import (
    PROMOTION_LOG_FILENAME,
    Decision,
    PromotionRecord,
    append,
)
from wattsteer_ml.replay.floor_guardrail import (
    FLOOR_COVERAGE_SLACK,
    FloorCoverageVeto,
    floor_coverage_guardrail,
)
from wattsteer_ml.training.bundle import (
    CONTRACT_FAULT_KEY,
    GATE_BLOCK_KEY,
    HurdleBundle,
    read_card,
    write_card,
)
from wattsteer_ml.training.conformal import (
    COVERAGE_GUARDRAIL,
    NOMINAL_MISCOVERAGE,
    TARGET_COVERAGE,
    ScoredHour,
)
from wattsteer_ml.training.contract import feature_column_names
from wattsteer_ml.training.design import TOTAL_COLUMN
from wattsteer_ml.training.hurdle import HourForecast, day_grain_rows, forecast_rows
from wattsteer_ml.training.hyperparameters import ESTIMATOR_FAMILY

#: Check 2. `docs/specs/forecaster.md`: ``estimator_family ∈ {"lightgbm"}``.
#: "This is where the transformer's benchmark-only status is enforced" — by the
#: gate rather than by agreement, so the agreement cannot be forgotten.
ESTIMATOR_ALLOW_LIST: frozenset[str] = frozenset({ESTIMATOR_FAMILY})

#: Check 4. The newest training target date must be no older than this. A model
#: fitted on a window that stopped a fortnight ago is a model nobody noticed had
#: stopped being retrained.
MAXIMUM_TRAINING_AGE_DAYS = 7

#: Check 4. The deciding fold's test period, in days. Sixty because the
#: bootstrap resamples days, and a block bootstrap over a handful of blocks
#: reports a precision it does not have.
MINIMUM_TEST_DAYS = 60

#: Check 5. Resamples of the deciding fold. The spec's number.
BOOTSTRAP_DRAWS = 2_000

#: Check 5. The seed, so the statistic in the card is reproducible from the
#: card. A gate whose number moves between two runs on the same rows is a gate
#: nobody can audit.
BOOTSTRAP_SEED = 20_260_913

#: Check 5. ``Promote iff P(qloss_candidate < qloss_incumbent) ≥ 0.90``. **Not a
#: guardrail**: this is the decision, and it is a probability rather than a
#: threshold on a loss, which is why no absolute bar had to be invented for it.
PROMOTION_PROBABILITY = 0.90

#: Guardrail. ``pr_auc ≥ incumbent.pr_auc − 0.02``, pooled *and* per subsystem.
PR_AUC_SLACK = 0.02

#: Guardrail. ``recall@0.5 ≥ incumbent.recall@0.5 − 0.05``. IDEA §18's emphasis,
#: as a floor rather than as the objective — recall is trivially maximised by a
#: model that predicts curtailment always, which is why it is never the gate.
RECALL_SLACK = 0.05

#: Guardrail. ``p50_unbiasedness ∈ [0.45, 0.55]`` — the check that stands in for
#: the correction the median deliberately does not get.
P50_UNBIASEDNESS_WINDOW: tuple[float, float] = (0.45, 0.55)

#: Guardrail. ``ece ≤ 0.05``.
ECE_CEILING = 0.05

#: The name the corrected lower-coverage rail is published under, in the card's
#: gate block and on the promotion log's line. **Not** ``coverage_p10``, which
#: is the marginal over every curtailed hour and stays on the card as
#: :attr:`~wattsteer_ml.training.conformal.CoverageReport.coverage_p10`. The two
#: are different populations — forecaster 33 measured the marginal reading
#: 0.9753 where this one reads 0.9433 on the same artifact — and forecaster 29
#: already established what happens when one name carries two denominators:
#: whichever was written last wins and a reader cannot tell which they hold. The
#: name states the population, so it travels with it.
BAND_COVERAGE_RAIL = "coverage_p10_in_band"

#: The name the corrected median rail is published under, for the reason
#: :data:`BAND_COVERAGE_RAIL` carries its own: ``p50_unbiasedness`` is the
#: marginal over every curtailed hour and stays on the card under that name.
#: These are two counts over two populations, and forecaster 29 established what
#: happens when one name carries two denominators.
BAND_MEDIAN_RAIL = "p50_unbiasedness_in_band"

#: The name the calibration-excess rail is published under. A third population
#: name for the same rows as :data:`BAND_COVERAGE_RAIL`, because it is a
#: different *statement* about them — how far the realised floor clearance is
#: from the model's own implied rate, rather than where it sits in a window.
CALIBRATION_EXCESS_RAIL = "p10_calibration_excess"

#: Guardrail. ``crossing_rate ≤ 0.01``.
CROSSING_RATE_CEILING = 0.01

#: Check 7. A feature whose serve-time NULL rate exceeds its training NULL rate
#: by more than five percentage points. The check that catches an upstream
#: dataset having gone quiet, which no historical metric can see.
NULL_RATE_DRIFT_CEILING = 0.05

#: What a candidate is measured against. ``same_hour_7d`` is rung 1 of the
#: baseline ladder — the cold-start bar, and the baseline a domain expert would
#: use by hand.
ComparatorKind = Literal["incumbent", "same_hour_7d"]

#: The named checks, in the order the spec runs them.
CheckName = Literal[
    "lane_identity",
    "estimator_allow_list",
    "feature_contract",
    "freshness_and_coverage",
    "paired_block_bootstrap",
    "guardrails",
    "serving_smoke",
]


class GateError(RuntimeError):
    """The gate could not decide, or was asked to decide something malformed."""


class GateInputError(GateError, ValueError):
    """Two things the gate was handed do not describe one comparison."""


class ContractDriftError(GateError):
    """The live ``feature_rows`` no longer produces the hash the artifacts carry.

    Its own class, and raised *after* the refusal has been recorded, because the
    spec asks for both: "the gate refuses the swap **and** raises, rather than
    promoting into a mismatch or leaving a stale model serving a changed contract
    silently". The candidate is refused on the volume; the incumbent's card is
    marked with a contract fault, which
    :func:`~wattsteer_ml.training.bundle.load_artifact` refuses to load past; and
    this reaches the weekly job, which is what stops the mismatch being a line in
    a log nobody read.
    """


@dataclass(frozen=True)
class ContractDrift:
    """The three hashes involved when check 3 fails, kept together."""

    lane: Lane
    live: str
    candidate: str
    #: ``None`` on a cold start: there is no incumbent to also be invalid.
    incumbent_artifact_id: str | None
    incumbent: str | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "lane": self.lane.directory_name,
            "live_feature_hash": self.live,
            "candidate_feature_hash": self.candidate,
            "incumbent_artifact_id": self.incumbent_artifact_id,
            "incumbent_feature_hash": self.incumbent,
        }

    @property
    def fault(self) -> str:
        """The prose written onto the incumbent's card. For a human to act on."""
        return (
            f"the live feature_rows definition hashes to {self.live}, and this "
            f"artifact was fitted against {self.incumbent}. Every number it would "
            "serve was measured in a feature space the database no longer "
            "produces, so it is invalid rather than stale. Retrain the lane; "
            "nothing on the volume has been removed."
        )


@dataclass(frozen=True)
class GateCheck:
    """One of the seven checks, and what it saw.

    :attr:`values` is JSON-safe by construction — every producer in this module
    puts only numbers, strings, booleans and lists of those into it — because it
    is written verbatim into the promotion log's evidence and into the card.
    """

    name: CheckName
    passed: bool
    #: Prose. Every value it takes is something a human reads at 03:00.
    detail: str
    values: Mapping[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "check": self.name,
            "passed": self.passed,
            "detail": self.detail,
            **({"values": dict(self.values)} if self.values else {}),
        }


@dataclass(frozen=True)
class Guardrail:
    """One veto, its measured value and the constant it was compared against.

    The constant travels with the answer. A reader of a refused card should not
    have to go and find the number the refusal turned on, and a guardrail whose
    value could not be measured says so in :attr:`detail` rather than reporting a
    ``0.0`` that would read as a measurement.

    **:attr:`applicable` is the third state, and it is not a waiver.** Every
    guardrail here is either measured and compared, or measured and unmeasurable
    — and an unmeasurable one *vetoes*, which is why ``passed`` alone was enough
    until floor coverage arrived. Floor coverage is comparative and there is no
    incumbent on a cold start, so the comparison does not exist rather than
    failing: ``docs/specs/replay.md``'s guardrail must be "recorded as not
    applicable rather than as satisfied", and a ``passed`` of ``True`` would be
    exactly the second. Only :attr:`vetoes` is read by the decision, so a
    not-applicable rail can neither block a swap nor claim to have cleared one.
    """

    name: str
    passed: bool
    detail: str
    value: float | None = None
    bound: str = ""
    #: ``False`` only when this guardrail had no comparison to make at all.
    #: :attr:`passed` is then ``False`` too, because nothing passed.
    applicable: bool = True

    def __post_init__(self) -> None:
        if not self.applicable and self.passed:
            raise GateInputError(
                f"{self.name}: a guardrail that made no comparison cannot have "
                "passed one; that is the reading it exists to refuse"
            )

    @property
    def vetoes(self) -> bool:
        """The one predicate the decision reads. Not-applicable never vetoes."""
        return self.applicable and not self.passed

    def as_dict(self) -> dict[str, Any]:
        return {
            "guardrail": self.name,
            "passed": self.passed,
            "applicable": self.applicable,
            "detail": self.detail,
            "value": self.value,
            "bound": self.bound,
        }


def minimum_band_coverage_rows(
    *,
    target: float = TARGET_COVERAGE,
    guardrail: tuple[float, float] = COVERAGE_GUARDRAIL,
    miscoverage: float = NOMINAL_MISCOVERAGE,
) -> int:
    """How many falsifiable rows a coverage statement needs to be one. **98.**

    Derived from the three numbers this repository has already published, and
    from no fourth one:

    - the statement's target, :data:`~wattsteer_ml.training.conformal.TARGET_COVERAGE`
      = 0.90;
    - the window it is judged against,
      :data:`~wattsteer_ml.training.conformal.COVERAGE_GUARDRAIL` = [0.85, 0.97],
      whose **nearer** edge is 0.05 away from the target;
    - the confidence the rest of this lane is written at,
      :data:`~wattsteer_ml.training.conformal.NOMINAL_MISCOVERAGE` = 0.10, so a
      two-sided ``1 − α`` interval and ``z = 1.6449``.

    A rail whose sampling interval is wider than the distance from its target to
    the bound cannot tell a calibrated model from one it should refuse: at that
    ``n`` the same correct candidate lands either side of the edge from one week
    to the next, which is the failure forecaster 33 measured on
    ``p50_unbiasedness`` and the one this module must not re-import under a new
    name. So require the half-width of that interval at the target to fit inside
    the margin::

        z·√(0.90 × 0.10 / n) ≤ min(0.90 − 0.85, 0.97 − 0.90)
        n ≥ z² × 0.09 / 0.05²  =  97.4  →  98

    **Rows, not hours, and the difference is measured rather than assumed.**
    This is an iid binomial floor. Curtailed hours cluster inside a target day,
    so the effective ``n`` behind a fold's coverage figure is smaller than its
    row count — forecaster 33 measured a design effect of 5.4 on
    ``p50_unbiasedness`` over all 3,201 scored hours, and forecaster 34
    measured **4.40** and **2.65** on the rows *this* statistic is counted over
    — an effective ``n`` of 317 and 525 behind 1,394 and 1,391 rows, both still
    clear of this floor. The floor is therefore necessary and not sufficient: a
    lane clearing it by less than its own design effect has a figure that should
    be read with the day-block interval beside it. It is stated here as the
    condition that can be checked without a bootstrap in the veto path, and the
    design effect is measured in the ticket rather than at 03:00.
    """
    low, high = guardrail
    margin = min(target - low, high - target)
    if margin <= 0.0:
        raise GateInputError(
            f"the coverage guardrail {guardrail} does not bracket the target "
            f"{target}, so there is no margin a sample size could resolve"
        )
    z = NormalDist().inv_cdf(1.0 - miscoverage / 2.0)
    return math.ceil(z * z * target * (1.0 - target) / (margin * margin))


def states_a_falsifiable_floor(hour: ScoredHour) -> bool:
    """Whether this scored hour's P10 is a floor its label could have missed.

    The corrected rail's whole content, in one predicate. A scored hour has
    ``y > τ > 0`` by the population rule, so on two of the mixture's values the
    label is at or above the served P10 **whatever the fit does**:

    - the **point mass at zero**, ``Q_Y(0.10) = 0`` for every ``p ≤ 0.90``.
      :attr:`~wattsteer_ml.training.conformal.ScoredHour.states_lower_bound`
      already names this one and ``coverage_p10_where_stated`` already nets it
      out. It was 1,807 and 1,810 of the 3,201 rows the first two artifacts were
      scored on — 56% of the denominator.
    - the **τ floor**. :func:`~wattsteer_ml.mixture._into_positive_support`
      clamps the positive branch to the smallest float above ``τ``, so a P10
      sitting there is at or below every label that could be scored against it.
      Nothing nets this one out, and forecaster 33 recommended that something
      should. On the two artifacts in hand it turns out to bind on **no row at
      all** — the smallest stated P10 is 19.53 MWh against ``τ = 5`` — so it
      costs nothing here and is refused on principle rather than on frequency:
      a rail whose denominator silently includes rows it cannot falsify is the
      defect being fixed, and "it does not happen on this fold" is not a reason
      to leave the door open on the next one.

    Everything else is a positive magnitude strictly above ``τ`` and the label
    can land under it. That — and not ``q``-space flatness — is what makes a row
    evidence: :class:`~wattsteer_ml.mixture.MagnitudeQuantiles` is flat below its
    first knot, so ``Q_Y`` is constant on ``q ∈ [1 − p, 0.10]`` and a test like
    ``Q(0.10) == Q(0.05)`` flags ~77% of the *stated* rows as "flat" — but those
    rows carry P10s of 133 MWh and upwards and the label fell below them 47
    times in ``gate_early``. A row that was missed is not a row that could not
    be.
    """
    if not hour.is_positive:
        return False
    floor = math.nextafter(hour.forecast.mixture.threshold_mwh, math.inf)
    return hour.forecast.band.p10 > floor


def states_a_falsifiable_median(hour: ScoredHour) -> bool:
    """Whether this scored hour's P50 is a median its label could have fallen below.

    :func:`states_a_falsifiable_floor`'s twin, and the same argument with the
    quantile changed. A scored hour has ``y > τ > 0``, so wherever the served
    P50 is at or below ``τ`` the label is above it **whatever the fit does**:

    - the **point mass at zero**, ``Q_Y(0.50) = 0`` for every ``p ≤ 0.50``. On
      the pooled folds forecaster 38 measured this at 1,850 and 2,066 of 10,115
      scored hours — 18% and 20% of the denominator, and every one of them a
      guaranteed "not below".
    - the **τ floor**, for the reason the P10's version of this excludes it: a
      P50 clamped to the smallest float above ``τ`` is below every label that
      could be scored against it.

    Everything else is a positive median strictly above ``τ``, and the label can
    land either side of it. That is what makes a row evidence about whether the
    P50 is a median.
    """
    if not hour.is_positive:
        return False
    floor = math.nextafter(hour.forecast.mixture.threshold_mwh, math.inf)
    return hour.forecast.band.p50 > floor


def minimum_band_median_rows(
    *,
    target: float = 0.50,
    guardrail: tuple[float, float] = P50_UNBIASEDNESS_WINDOW,
    miscoverage: float = NOMINAL_MISCOVERAGE,
) -> int:
    """How many falsifiable rows a median statement needs to be one. **271.**

    :func:`minimum_band_coverage_rows`' derivation with the median's target and
    window substituted, and it is deliberately the same function shape rather
    than a second rule: a rail whose sampling interval is wider than the
    distance from its target to its bound cannot tell a calibrated model from
    one it should refuse, whichever quantile it is about.

        z·√(0.50 × 0.50 / n) ≤ min(0.50 − 0.45, 0.55 − 0.50)
        n ≥ z² × 0.25 / 0.05²  =  270.6  →  271

    Larger than the coverage rail's 98 for the reason a fair coin is harder to
    pin down than a 90% one: the variance is maximal at 0.50. The same caveat
    applies — this is an iid binomial floor and curtailed hours cluster inside a
    day, so it is necessary and not sufficient, and the day-block interval is
    what a close reading needs beside it.
    """
    low, high = guardrail
    margin = min(target - low, high - target)
    if margin <= 0.0:
        raise GateInputError(
            f"the median guardrail {guardrail} does not bracket the target "
            f"{target}, so there is no margin a sample size could resolve"
        )
    z = NormalDist().inv_cdf(1.0 - miscoverage / 2.0)
    return math.ceil(z * z * target * (1.0 - target) / (margin * margin))


@dataclass(frozen=True)
class P10BandCoverage:
    """``coverage_p10`` over the rows whose P10 could have been missed.

    The figure and the denominator it was counted over, in one value, because
    forecaster 24's finding — a coverage figure and its denominator travel
    together or not at all — is the reason this class exists at all.

    **Too few rows is a refusal, not a pass.** :attr:`coverage` over a handful
    of rows is arithmetic with a wide interval around it, and a gate that read
    it as green would be shipping the vacuity failure this repository has
    already shipped four times. :attr:`sufficient` is that test, against
    :func:`minimum_band_coverage_rows`, and :attr:`passes` requires it.
    """

    #: The curtailed hours of the deciding fold — the population
    #: :class:`~wattsteer_ml.training.conformal.CoverageReport` counts the
    #: marginal over, kept so the two figures can be read against each other.
    rows: int
    #: Those of them whose P10 is a floor the label could have missed.
    qualifying_rows: int
    #: :func:`minimum_band_coverage_rows`, stored so a refusal carries the
    #: number it turned on without a reader going to find it.
    minimum_rows: int
    #: The share of :attr:`qualifying_rows` whose label is at or above the
    #: served P10, or ``None`` where there are none. **Absent, never 1.0.**
    coverage: float | None

    def __post_init__(self) -> None:
        if not 0 <= self.qualifying_rows <= self.rows:
            raise GateInputError(
                f"{self.qualifying_rows} of {self.rows} scored hours state a "
                "falsifiable floor; the qualifying rows are a subset"
            )
        if (self.qualifying_rows == 0) is not (self.coverage is None):
            raise GateInputError(
                f"coverage {self.coverage!r} over {self.qualifying_rows} "
                "qualifying rows; a statement with no denominator is not a "
                "measurement and one with a denominator is not absent"
            )

    @property
    def sufficient(self) -> bool:
        """Whether enough rows can falsify the statement for it to be one.

        ``> 0`` as well as ``≥ minimum_rows``, so that a minimum of zero — which
        no derivation here produces, and which a caller could still construct —
        cannot make an absent figure sufficient.
        """
        return self.qualifying_rows > 0 and self.qualifying_rows >= self.minimum_rows

    @property
    def passes(self) -> bool:
        """Measured, over enough rows, and inside the window. All three."""
        low, high = COVERAGE_GUARDRAIL
        return (
            self.coverage is not None and self.sufficient and low <= self.coverage <= high
        )

    @property
    def detail(self) -> str:
        """The sentence the refused card carries, with its denominator in it."""
        low, high = COVERAGE_GUARDRAIL
        if not self.sufficient:
            return (
                f"{self.qualifying_rows} of {self.rows} curtailed hours put the "
                f"served P10 above τ, which is under the {self.minimum_rows} a "
                f"{TARGET_COVERAGE:.0%} statement needs to be resolved against "
                f"[{low}, {high}]; the rest is the mixture's point mass and the "
                "τ floor, where the label clears the floor whatever the fit "
                "does. The sample is too small, which is a refusal and not a "
                "measurement of anything"
            )
        assert self.coverage is not None  # sufficient implies a denominator
        return (
            f"{self.coverage:.4f} against [{low}, {high}], over the "
            f"{self.qualifying_rows} of {self.rows} curtailed hours whose P10 is "
            f"above τ and could have been missed"
        )

    def as_guardrail(self) -> Guardrail:
        """The rail itself. Unmeasurable and under-powered both veto."""
        low, high = COVERAGE_GUARDRAIL
        return Guardrail(
            name=BAND_COVERAGE_RAIL,
            passed=self.passes,
            detail=self.detail,
            value=self.coverage,
            bound=f"in [{low}, {high}] over ≥ {self.minimum_rows} rows",
        )


def p10_band_coverage(hours: Sequence[ScoredHour]) -> P10BandCoverage:
    """Count the lower coverage over the rows it can speak for.

    The population is the deciding fold's **curtailed** hours, exactly as
    :meth:`~wattsteer_ml.training.conformal.CoverageReport.of` selects them, so
    the corrected figure and the marginal on the card are two counts over one
    set of rows and their difference is the denominator and nothing else.

    A fold with no curtailed hour, and a fold whose every P10 is on an atom,
    both come back with :attr:`~P10BandCoverage.coverage` ``None`` and veto.
    """
    scored = [hour for hour in hours if hour.is_positive]
    qualifying = [hour for hour in scored if states_a_falsifiable_floor(hour)]
    covered = sum(1 for hour in qualifying if hour.covered_lower)
    return P10BandCoverage(
        rows=len(scored),
        qualifying_rows=len(qualifying),
        minimum_rows=minimum_band_coverage_rows(),
        coverage=(covered / len(qualifying) if qualifying else None),
    )


@dataclass(frozen=True)
class P10CalibrationExcess:
    """The floor's realised clearance against the model's **own implied** rate.

    Forecaster 34 shipped `coverage_p10_in_band` with one acceptance test
    failing and handed this over as the thing that would settle it: *"score the
    floor against the model's own implied coverage — the mean of
    ``1{y ≥ P10} − p`` over qualifying rows, which is zero by construction under
    the null."*

    **Why that box could not be closed by counting different rows.** Forecaster
    34 measured the mechanism: ``Q_pos`` is flat below its first knot, so the
    served law puts probability mass ``p − 0.90`` *exactly at* the P10 — 7.9%
    and 8.2% of a perfectly-calibrated null's qualifying draws land there.
    Coverage counts ``y ≥ P10``, so that whole atom counts as covered and
    ``P(y ≥ P10) = p`` on every qualifying row. The null's coverage is therefore
    ``mean(p)`` — 0.9790 and 0.9809 — which is above the 0.97 ceiling before any
    row is chosen. No denominator can move a number that the model's own law
    fixes.

    **And the other route was refused by an older decision, not by oversight.**
    Forecaster 34's second option was to make ``Q_pos`` non-degenerate below its
    first knot. `MagnitudeQuantiles` holds it flat there deliberately: *"a
    quantile fit says nothing beyond its outermost alpha, and a straight line
    drawn past α = 0.9 is an invented tail — the ensemble's day totals would
    inherit it as though it had been fitted."* Fixing the atom that way means
    inventing the tail that design refuses.

    So the statistic moves instead of the band. ``d_i = 1{y_i ≥ P10_i} − p_i``
    has expectation **exactly zero** under the served law, whatever the atom
    does, because the atom is in both terms.

    **The bound is not invented either.** Forecaster 34 said a new statistic
    "wants the user's decision" for its threshold, and the studentised form
    removes the choice: the test is whether the excess is distinguishable from
    zero at `NOMINAL_MISCOVERAGE`, which is the constant the coverage rails
    already derive their own sample floor from. A correctly-calibrated model
    passes at the nominal rate **by construction** rather than by a window
    someone picked around it.

    **Clustered by target day, in closed form.** Curtailed hours are not
    independent inside a day — forecaster 34 measured design effects of 4.40 and
    2.65 on exactly these rows — so an iid standard error would be too small and
    the rail would veto correct models. The variance is the cluster-robust one
    over target-day blocks, which is `O(n)` arithmetic rather than a resample:
    the gate's veto path states its conditions without a bootstrap, and this
    keeps that property.
    """

    #: The curtailed hours of the deciding fold.
    rows: int
    #: Those whose P10 is a floor the label could have missed — the same
    #: population :class:`P10BandCoverage` counts over, so the two figures are
    #: two statements about one set of rows.
    qualifying_rows: int
    #: Distinct target days among them; the cluster count behind the interval.
    day_blocks: int
    #: :func:`minimum_band_coverage_rows`, shared with the coverage rail because
    #: it is the same population and the same miscoverage.
    minimum_rows: int
    #: ``mean(1{y ≥ P10} − p)``. Zero under the null. ``None`` with no rows.
    excess: float | None
    #: Cluster-robust standard error of :attr:`excess` over day blocks.
    standard_error: float | None

    def __post_init__(self) -> None:
        if not 0 <= self.qualifying_rows <= self.rows:
            raise GateInputError(
                f"{self.qualifying_rows} of {self.rows} scored hours state a "
                "falsifiable floor; the qualifying rows are a subset"
            )
        if (self.qualifying_rows == 0) is not (self.excess is None):
            raise GateInputError(
                f"excess {self.excess!r} over {self.qualifying_rows} qualifying "
                "rows; a statement with no denominator is not a measurement"
            )

    @property
    def sufficient(self) -> bool:
        """Enough rows, and more than one day block to estimate spread from."""
        return (
            self.qualifying_rows >= self.minimum_rows
            and self.qualifying_rows > 0
            and self.day_blocks > 1
            and self.standard_error is not None
        )

    @property
    def half_width(self) -> float | None:
        """``z · SE`` at :data:`NOMINAL_MISCOVERAGE`."""
        if self.standard_error is None:
            return None
        z = NormalDist().inv_cdf(1.0 - NOMINAL_MISCOVERAGE / 2.0)
        return z * self.standard_error

    @property
    def passes(self) -> bool:
        """Measured, over enough rows and days, and indistinguishable from zero."""
        if not self.sufficient or self.excess is None:
            return False
        half = self.half_width
        return half is not None and abs(self.excess) <= half

    @property
    def detail(self) -> str:
        """The sentence the card carries, with the interval that decided it."""
        if not self.sufficient:
            return (
                f"{self.qualifying_rows} of {self.rows} curtailed hours put the "
                f"served P10 above τ, over {self.day_blocks} target day(s), "
                f"against the {self.minimum_rows} rows and 2 days this needs; "
                "the excess is a refusal rather than a measurement"
            )
        assert self.excess is not None and self.half_width is not None
        verdict = "inside" if self.passes else "outside"
        return (
            f"{self.excess:+.4f} against 0 ± {self.half_width:.4f} — {verdict}. "
            f"The realised floor clearance minus the model's own implied rate, "
            f"over {self.qualifying_rows} qualifying rows in {self.day_blocks} "
            f"day blocks. Zero is what a correctly calibrated band reads here, "
            f"whatever the point mass at the P10 does, because the atom is in "
            f"both terms"
        )

    def as_guardrail(self) -> Guardrail:
        """The rail. Unmeasurable and under-powered both veto."""
        return Guardrail(
            name=CALIBRATION_EXCESS_RAIL,
            passed=self.passes,
            detail=self.detail,
            value=self.excess,
            bound=(
                f"|excess| ≤ z·SE at α={NOMINAL_MISCOVERAGE} "
                f"over ≥ {self.minimum_rows} rows and ≥ 2 day blocks"
            ),
        )


def p10_calibration_excess(hours: Sequence[ScoredHour]) -> P10CalibrationExcess:
    """Score the floor against the law that produced it.

    The population is :func:`states_a_falsifiable_floor`'s, so this and
    `coverage_p10_in_band` are two readings of one set of rows: the first says
    how often the floor was cleared, the second says whether that differs from
    what the model itself predicted.
    """
    scored = [hour for hour in hours if hour.is_positive]
    qualifying = [hour for hour in scored if states_a_falsifiable_floor(hour)]
    if not qualifying:
        return P10CalibrationExcess(
            rows=len(scored),
            qualifying_rows=0,
            day_blocks=0,
            minimum_rows=minimum_band_coverage_rows(),
            excess=None,
            standard_error=None,
        )

    # d_i = realised − implied. `occurrence_probability` is the model's own
    # P(Y ≥ P10) on a qualifying row, which is forecaster 34's measured identity
    # rather than an assumption: the atom at the P10 carries mass p − 0.90 and
    # coverage counts it, so the served law clears its own floor with
    # probability exactly p.
    by_day: dict[object, list[float]] = {}
    for hour in qualifying:
        d = (1.0 if hour.covered_lower else 0.0) - hour.forecast.occurrence_probability
        by_day.setdefault(hour.key.target_date, []).append(d)

    n = len(qualifying)
    excess = sum(sum(block) for block in by_day.values()) / n

    # Cluster-robust variance of the mean over day blocks: the sum of squared
    # block-level deviations, scaled. One block cannot estimate a spread, so it
    # comes back `None` and `sufficient` refuses.
    blocks = list(by_day.values())
    standard_error: float | None = None
    if len(blocks) > 1:
        centred = [sum(d - excess for d in block) for block in blocks]
        g = len(blocks)
        variance = sum(value * value for value in centred) * g / ((g - 1) * n * n)
        standard_error = math.sqrt(variance) if variance > 0 else 0.0

    return P10CalibrationExcess(
        rows=len(scored),
        qualifying_rows=n,
        day_blocks=len(blocks),
        minimum_rows=minimum_band_coverage_rows(),
        excess=excess,
        standard_error=standard_error,
    )


@dataclass(frozen=True)
class P50BandUnbiasedness:
    """``p50_unbiasedness`` over the rows whose P50 the label could have fallen below.

    :class:`P10BandCoverage`'s twin, and it exists for the same measured reason
    one quantile down. Forecaster 38 and 40 established that the marginal
    ``p50_unbiasedness`` **cannot be read as a rail**: pooled over three folds
    at an effective ``n`` of 1,445 it reads 0.3735 and 0.3855 against a
    ``[0.45, 0.55]`` window — and a model that is *right by construction* reads
    **0.3406 and 0.3467** on the same population, below the candidate it is
    supposed to vindicate. A rail a correct model fails harder than the
    candidate is not measuring the candidate.

    The cause is structural and is the same one forecaster 34 found in the
    coverage rail: a fifth of the denominator is rows whose served P50 is on the
    mixture's point mass, where a scored hour is above its median whatever the
    fit does. Netting them out puts the statistic where the rail's own wording
    assumes it is.

    **Why this does not cost the shuffled-label control.** Forecaster 38
    measured that on this population a permuted fit reads 0.5234 and 0.5440 and
    passes the window, and stopped there, treating per-rail discrimination as
    something every rail owes. It is not: the shuffled-label control names its
    own detector, and it is ``pr_auc`` against
    :func:`~wattsteer_ml.evaluation.shuffled_label.chance_interval` — measured
    over 40 permutation seeds to sit 0.043 to 0.070 *below* the interval's
    ceiling while the honest run sits 0.124 above it. Asking the median rail to
    catch a permutation as well is asking it to duplicate that detector, and the
    price of the duplication is the rail being unable to do its own job. So this
    rail is free to measure the median, and the permutation is still refused —
    by the check that was built to refuse it.
    """

    #: The curtailed hours of the deciding fold, kept so the marginal on the
    #: card and this figure can be read against each other.
    rows: int
    #: Those of them whose P50 is above ``τ``, and so could have been missed low.
    qualifying_rows: int
    #: :func:`minimum_band_median_rows`, stored so a refusal carries it.
    minimum_rows: int
    #: The share of :attr:`qualifying_rows` whose label is below the served P50,
    #: or ``None`` where there are none. **Absent, never 0.0.**
    unbiasedness: float | None

    def __post_init__(self) -> None:
        if not 0 <= self.qualifying_rows <= self.rows:
            raise GateInputError(
                f"{self.qualifying_rows} of {self.rows} scored hours state a "
                "falsifiable median; the qualifying rows are a subset"
            )
        if (self.qualifying_rows == 0) is not (self.unbiasedness is None):
            raise GateInputError(
                f"unbiasedness {self.unbiasedness!r} over {self.qualifying_rows} "
                "qualifying rows; a statement with no denominator is not a "
                "measurement and one with a denominator is not absent"
            )

    @property
    def sufficient(self) -> bool:
        """Whether enough rows can falsify the statement for it to be one."""
        return self.qualifying_rows > 0 and self.qualifying_rows >= self.minimum_rows

    @property
    def passes(self) -> bool:
        """Measured, over enough rows, and inside the window. All three."""
        low, high = P50_UNBIASEDNESS_WINDOW
        return (
            self.unbiasedness is not None
            and self.sufficient
            and low <= self.unbiasedness <= high
        )

    @property
    def detail(self) -> str:
        """The sentence the refused card carries, with its denominator in it."""
        low, high = P50_UNBIASEDNESS_WINDOW
        if not self.sufficient:
            return (
                f"{self.qualifying_rows} of {self.rows} curtailed hours put the "
                f"served P50 above τ, which is under the {self.minimum_rows} a "
                f"median statement needs to be resolved against [{low}, {high}]; "
                "the rest is the mixture's point mass and the τ floor, where the "
                "label is above the median whatever the fit does. The sample is "
                "too small, which is a refusal and not a measurement of anything"
            )
        assert self.unbiasedness is not None  # sufficient implies a denominator
        return (
            f"{self.unbiasedness:.4f} against [{low}, {high}], over the "
            f"{self.qualifying_rows} of {self.rows} curtailed hours whose P50 is "
            f"above τ and could have been missed low"
        )

    def as_guardrail(self) -> Guardrail:
        """The rail itself. Unmeasurable and under-powered both veto."""
        low, high = P50_UNBIASEDNESS_WINDOW
        return Guardrail(
            name=BAND_MEDIAN_RAIL,
            passed=self.passes,
            detail=self.detail,
            value=self.unbiasedness,
            bound=f"in [{low}, {high}] over ≥ {self.minimum_rows} rows",
        )


def p50_band_unbiasedness(hours: Sequence[ScoredHour]) -> P50BandUnbiasedness:
    """Count the median crossings over the rows the statistic can speak for.

    The population is the deciding fold's **curtailed** hours, exactly as
    :meth:`~wattsteer_ml.training.conformal.CoverageReport.of` selects them, so
    the corrected figure and the marginal on the card are two counts over one
    set of rows and their difference is the denominator and nothing else.

    A fold with no curtailed hour, and a fold whose every P50 is on an atom,
    both come back with :attr:`~P50BandUnbiasedness.unbiasedness` ``None`` and
    veto.
    """
    scored = [hour for hour in hours if hour.is_positive]
    qualifying = [hour for hour in scored if states_a_falsifiable_median(hour)]
    below = sum(1 for hour in qualifying if hour.below_median)
    return P50BandUnbiasedness(
        rows=len(scored),
        qualifying_rows=len(qualifying),
        minimum_rows=minimum_band_median_rows(),
        unbiasedness=(below / len(qualifying) if qualifying else None),
    )


@dataclass(frozen=True)
class PairedBootstrap:
    """The gate proper: the statistic, and everything needed to reproduce it.

    :attr:`probability` is ``P(qloss_candidate < qloss_comparator)`` over
    :attr:`draws` resamples of whole target days. **Strictly less**, as the spec
    writes it, which is why a candidate byte-identical to the incumbent scores
    ``0.0`` and not ``0.5``: every resample is a tie. :attr:`ties` is published
    beside it so that number reads as "never better" rather than as "always
    worse".
    """

    kind: ComparatorKind
    days: int
    hours: int
    draws: int
    seed: int
    probability: float
    ties: int
    candidate_qloss_mwh: float
    comparator_qloss_mwh: float

    @property
    def promotes(self) -> bool:
        return self.probability >= PROMOTION_PROBABILITY

    def as_dict(self) -> dict[str, Any]:
        return {
            "compared_against": self.kind,
            "days": self.days,
            "hours": self.hours,
            "draws": self.draws,
            "seed": self.seed,
            "probability_candidate_better": self.probability,
            "ties": self.ties,
            "promotion_probability": PROMOTION_PROBABILITY,
            "candidate_qloss_mwh": self.candidate_qloss_mwh,
            "comparator_qloss_mwh": self.comparator_qloss_mwh,
        }


@dataclass(frozen=True)
class NullRateDrift:
    """One feature whose serve-time NULLs outran its training NULLs."""

    feature: str
    training: float
    serving: float

    @property
    def excess(self) -> float:
        return self.serving - self.training

    def as_dict(self) -> dict[str, Any]:
        return {
            "feature": self.feature,
            "training_null_rate": self.training,
            "serving_null_rate": self.serving,
            "excess": self.excess,
        }


@dataclass(frozen=True)
class ServingSmoke:
    """Check 7, on the real vector: what the candidate did with tomorrow's rows.

    Produced by :func:`serving_smoke` from the *live* feature function's output,
    because this is the one check no historical metric can stand in for: a fold
    scored last quarter cannot see that an upstream dataset went quiet this week.
    """

    target_date: date
    #: Composed hours per subsystem. Every entry must be
    #: :data:`~wattsteer_ml.evaluation.matrix.HOURS_PER_DAY`.
    hours_by_subsystem: Mapping[Subsystem, int]
    #: Every way this smoke failed, in prose; empty when it did not.
    faults: tuple[str, ...]
    drifted: tuple[NullRateDrift, ...]

    @property
    def passed(self) -> bool:
        return not self.faults and not self.drifted

    def as_dict(self) -> dict[str, Any]:
        return {
            "target_date": self.target_date.isoformat(),
            "hours_by_subsystem": {
                code: self.hours_by_subsystem.get(code, 0) for code in SUBSYSTEM_CODES
            },
            "faults": list(self.faults),
            "null_rate_drift_ceiling": NULL_RATE_DRIFT_CEILING,
            "drifted_features": [drift.as_dict() for drift in self.drifted],
        }


@dataclass(frozen=True)
class GateCandidate:
    """The artifact asking to be served, and the evidence it arrived with."""

    artifact_id: str
    lane: Lane
    estimator_family: str
    feature_hash: str
    #: The newest ``target_date`` any fit in this artifact saw. Check 4's clock.
    newest_training_target_date: date
    #: The candidate's own metrics table — every fold it was scored on, so
    #: check 4 can ask about the folds it did *not* decide on too.
    metrics: MetricsTable
    #: The arm's name inside :attr:`metrics`.
    run: str
    #: The deciding fold's ``row_id`` — ``F6``, or ``F6@point_in_time``.
    deciding_row_id: str
    #: The candidate's composed, settled hours on the deciding segment.
    hours: tuple[ScoredHour, ...]
    rung: str = "lightgbm"

    @property
    def deciding(self) -> MetricsRow:
        """The metrics row the swap is decided on."""
        rows = self.metrics.where(
            run=self.run, rung=self.rung, row_id=self.deciding_row_id
        )
        if not rows:
            raise GateInputError(
                f"{self.artifact_id}: the metrics table carries no "
                f"{self.run}/{self.rung} row for {self.deciding_row_id!r}, which "
                "is the fold the gate was told decides"
            )
        return rows[0]

    @property
    def segment(self) -> FoldSegment:
        return self.deciding.segment


@dataclass(frozen=True)
class Comparator:
    """What the candidate is measured against: the incumbent, or rung 1.

    One type for both, because the gate runs one test. `docs/specs/forecaster.md`
    on the cold start: "the same test against **rung 1, the 7-day same-hour
    baseline**. A model that cannot beat the baseline a domain expert would use
    by hand does not get served, and that rule needs no prior numbers either."

    **The relative guardrails follow the comparator.** ``pr_auc`` and
    ``recall@0.5`` are specified against "the incumbent's"; on a cold start there
    is no incumbent, and this module reads them against rung 1's instead rather
    than waiving them. That is the reading a veto asks for: a model that cannot
    match the by-hand baseline's ranking should not be served either, and if the
    reading is wrong it blocks a swap rather than causing one.
    """

    kind: ComparatorKind
    row: MetricsRow
    hours: tuple[ScoredHour, ...]
    artifact_id: str | None = None
    lane: Lane | None = None
    feature_hash: str | None = None

    def __post_init__(self) -> None:
        if self.kind == "incumbent" and self.artifact_id is None:
            raise GateInputError("an incumbent comparator with no artifact id")
        if self.kind == "same_hour_7d" and self.artifact_id is not None:
            raise GateInputError(
                "the cold-start comparator is a baseline, not an artifact; it has "
                "no id because nothing was promoted to give it one"
            )

    @classmethod
    def incumbent(
        cls,
        *,
        artifact_id: str,
        lane: Lane,
        feature_hash: str,
        row: MetricsRow,
        hours: Sequence[ScoredHour],
    ) -> Comparator:
        return cls(
            kind="incumbent",
            row=row,
            hours=tuple(hours),
            artifact_id=artifact_id,
            lane=lane,
            feature_hash=feature_hash,
        )

    @classmethod
    def cold_start(cls, *, row: MetricsRow, hours: Sequence[ScoredHour]) -> Comparator:
        return cls(kind="same_hour_7d", row=row, hours=tuple(hours))


@dataclass(frozen=True)
class GateDecision:
    """The decision, its evidence, and the two documents it becomes."""

    artifact_id: str
    lane: Lane
    decision: Decision
    reason: str
    at: datetime
    checks: tuple[GateCheck, ...]
    comparator: ComparatorKind
    bootstrap: PairedBootstrap | None = None
    guardrails: tuple[Guardrail, ...] = ()
    smoke: ServingSmoke | None = None
    #: Check 6's floor-coverage guardrail, whole: both coverages, the fold, the
    #: fidelity and the fleet they were computed against
    #: (`docs/specs/replay.md`). ``None`` when the decision stopped before check
    #: 6, which is a check that never ran rather than a comparison that passed.
    floor_coverage: FloorCoverageVeto | None = None
    #: Set only when check 3 failed. Its presence is what makes :func:`run_gate`
    #: raise, after the refusal has been recorded.
    contract_drift: ContractDrift | None = None

    def __post_init__(self) -> None:
        if self.decision != "promote":
            return
        if self.contract_drift is not None:
            raise GateInputError(
                "a promotion cannot carry a contract drift; that is exactly the "
                "mismatch the third check exists to refuse"
            )
        if self.bootstrap is None or not self.bootstrap.promotes:
            raise GateInputError(
                "a promotion without a bootstrap that cleared "
                f"{PROMOTION_PROBABILITY} is a swap no number decided"
            )

    @property
    def promotes(self) -> bool:
        return self.decision == "promote"

    def evidence(self) -> dict[str, Any]:
        """The gate's supporting numbers, as the log line carries them."""
        return {
            "bootstrap_p": (
                None if self.bootstrap is None else self.bootstrap.probability
            ),
            "bootstrap": None if self.bootstrap is None else self.bootstrap.as_dict(),
            "guardrails": [rail.as_dict() for rail in self.guardrails],
            "checks": [check.as_dict() for check in self.checks],
            "serving_smoke": None if self.smoke is None else self.smoke.as_dict(),
            "floor_coverage": (
                None if self.floor_coverage is None else self.floor_coverage.as_dict()
            ),
            "compared_against": self.comparator,
            "contract_drift": (
                None if self.contract_drift is None else self.contract_drift.as_dict()
            ),
        }

    def to_record(self) -> PromotionRecord:
        """The one line appended to ``promotions.jsonl``, either way."""
        return PromotionRecord(
            artifact_id=self.artifact_id,
            lane=self.lane,
            decision=self.decision,
            reason=self.reason,
            at=self.at,
            evidence=self.evidence(),
        )

    def card_block(self) -> dict[str, Any]:
        """The card's Decision group — the last of the card's groups to arrive."""
        return {
            "decision": self.decision,
            "reason": self.reason,
            "at": format_instant(self.at),
            **self.evidence(),
        }


@dataclass(frozen=True)
class NoCandidate:
    """A retrain that produced no artifact for the gate to decide about.

    Deliberately **not** a :class:`~wattsteer_ml.promotions.PromotionRecord`. The
    log is keyed by artifact id and there is no artifact: nothing is appended,
    nothing on the volume changes, and the incumbent keeps serving because the
    most recent ``promote`` line still names it. The one thing that happens is
    that the weekly job says why, which is this value.

    The outcome it is written for is
    :class:`~wattsteer_ml.training.calibration.RiskBinsUndeterminedError`:
    forecaster ticket 05's ``derive_risk_bins`` raises when no split of the pool
    satisfies the spec's rule and there is no usable incumbent, so training fails
    loudly rather than publishing risk edges nobody measured. A promotion
    decision has to cope with that being a legitimate outcome, and coping means
    recording nothing rather than inventing an id to record it against.
    """

    lane: Lane
    reason: str
    at: datetime

    @classmethod
    def from_training_failure(
        cls, error: Exception, *, lane: Lane, at: datetime
    ) -> NoCandidate:
        return cls(
            lane=lane,
            reason=(
                f"no candidate was produced for {lane}: {type(error).__name__}: {error}"
            ),
            at=at,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "lane": self.lane.directory_name,
            "reason": self.reason,
            "at": format_instant(self.at),
            "appended_to_promotion_log": False,
        }


def hour_loss(hour: ScoredHour) -> float:
    """One hour's contribution to ``qloss_mwh``: the mean of three pinball losses.

    Factored out of :func:`~wattsteer_ml.evaluation.metrics.qloss_mwh` so the
    bootstrap can accumulate per-day sums once and resample the sums rather than
    recomposing 2,000 hour sequences. ``qloss_mwh`` is a plain mean over hours,
    so a resample's loss is ``Σ day sums / Σ day counts`` **exactly** — which
    :mod:`tests.test_hot_swap_gate` asserts against ``qloss_mwh`` itself rather
    than leaving as a claim in a comment.
    """
    band = (hour.forecast.band.p10, hour.forecast.band.p50, hour.forecast.band.p90)
    return sum(
        pinball(alpha, hour.observed_mwh, predicted)
        for alpha, predicted in zip(SERVED_QUANTILES, band, strict=True)
    ) / len(SERVED_QUANTILES)


@dataclass(frozen=True)
class DayBlock:
    """One target day's paired totals, and the units they are totals over.

    The block the bootstrap resamples. It is a **day** and not an hour, and not
    a subsystem-day, because the dependence the block exists to respect is the
    weather's: the front that curtails one hour of one subsystem curtails the
    next hour and the subsystem beside it.

    :attr:`units` is the denominator — hours for the gate's ``qloss_mwh``,
    complete subsystem-days for
    :mod:`~wattsteer_ml.evaluation.dessem_ab`'s floor — so that a resample's
    statistic is ``Σ block totals / Σ block units`` and a day with fewer units
    weighs less, exactly as it does in the pooled figure.
    """

    day: date
    left: float
    right: float
    units: int

    def __post_init__(self) -> None:
        if self.units <= 0:
            raise GateInputError(
                f"{self.day.isoformat()} contributes {self.units} units; a block "
                "over nothing has no total to resample"
            )


@dataclass(frozen=True)
class DayBlockResample:
    """What resampling whole days said, before any statistic is named.

    Deliberately holds **both** directions and the ties. Which of the two is the
    promotion probability depends on whether the statistic is a loss or a floor,
    and that is the caller's sentence to write: the gate reads
    :attr:`left_lower` because a smaller ``qloss_mwh`` is better, and the DESSEM
    A/B reads :attr:`left_higher` because more recovered floor is better. A
    resampler that had already picked one would have decided which way the
    number points.
    """

    days: int
    units: int
    draws: int
    seed: int
    #: Draws in which the left side's per-unit statistic came out **lower**.
    left_lower: int
    #: Draws in which it came out **higher**.
    left_higher: int
    #: And draws in which the two were equal, published so a probability of zero
    #: reads as "never better" rather than as "always worse".
    ties: int
    #: The two per-unit statistics over the observed blocks — not over a
    #: resample. ``Σ totals / Σ units``, which is the pooled figure exactly.
    left_per_unit: float
    right_per_unit: float

    def __post_init__(self) -> None:
        counted = self.left_lower + self.left_higher + self.ties
        if counted != self.draws:
            raise GateInputError(
                f"{counted} of {self.draws} draws were classified; a resample "
                "whose draws do not account for themselves is not one"
            )


def resample_day_blocks(
    blocks: Sequence[DayBlock],
    *,
    draws: int = BOOTSTRAP_DRAWS,
    seed: int = BOOTSTRAP_SEED,
) -> DayBlockResample:
    """**The one resampler.** Draw ``k`` selects the same days for both sides.

    Paired by construction: a :class:`DayBlock` carries both sides, so there is
    no argument here that could resample the left over one set of days and the
    right over another. The pairing of the *rows underneath* the blocks is the
    caller's to assert — :func:`paired_block_bootstrap` does it with
    :func:`assert_paired_hours`, and
    :mod:`~wattsteer_ml.evaluation.dessem_ab` does it by row digest before it
    builds a block at all.

    The default ``draws`` and ``seed`` are the gate's, so a statistic laid over
    this function is reproducible from the card the way the gate's is.
    """
    if draws <= 0:
        raise GateInputError(f"a bootstrap of {draws} draws decides nothing")
    if not blocks:
        raise GateInputError("a paired bootstrap over no day block")
    left_block = np.asarray([block.left for block in blocks], dtype=np.float64)
    right_block = np.asarray([block.right for block in blocks], dtype=np.float64)
    weight = np.asarray([block.units for block in blocks], dtype=np.float64)
    generator = np.random.default_rng(seed)
    picks = generator.integers(0, len(blocks), size=(draws, len(blocks)))
    units = weight[picks].sum(axis=1)
    left = left_block[picks].sum(axis=1) / units
    right = right_block[picks].sum(axis=1) / units
    return DayBlockResample(
        days=len(blocks),
        units=int(weight.sum()),
        draws=draws,
        seed=seed,
        left_lower=int(np.count_nonzero(left < right)),
        left_higher=int(np.count_nonzero(left > right)),
        ties=int(np.count_nonzero(left == right)),
        left_per_unit=float(left_block.sum() / weight.sum()),
        right_per_unit=float(right_block.sum() / weight.sum()),
    )


def paired_block_bootstrap(
    candidate: Sequence[ScoredHour],
    comparator: Sequence[ScoredHour],
    *,
    kind: ComparatorKind,
    draws: int = BOOTSTRAP_DRAWS,
    seed: int = BOOTSTRAP_SEED,
) -> PairedBootstrap:
    """``P(qloss_candidate < qloss_comparator)`` over resampled **whole days**.

    Whole target days, because hours within a day are strongly dependent — the
    weather that curtails one hour of a subsystem curtails the next — and an
    hour-wise resample would report a confidence the data does not support. There
    is no parameter here that would let the block be anything else.

    **Paired**: draw ``k`` selects the same days for both models, so the
    comparison is of two predictions of one week and not of two weeks. The two
    sequences must therefore carry identical keys in identical order and identical
    labels, which is checked rather than assumed.

    The resampling itself is :func:`resample_day_blocks`; what is here is the
    ``qloss_mwh`` statistic laid over it — the per-day loss sums, and the reading
    that ``P(candidate better)`` is the share of draws in which the candidate's
    loss came out **lower**.
    """
    if not candidate:
        raise GateInputError("a paired bootstrap over no scored hour")
    if len(candidate) != len(comparator):
        raise GateInputError(
            f"the candidate was scored on {len(candidate)} hours and the "
            f"comparator on {len(comparator)}; these are not paired"
        )
    assert_paired_hours(candidate, comparator)

    index_of: dict[date, int] = {}
    days: list[date] = []
    candidate_sums: list[float] = []
    comparator_sums: list[float] = []
    counts: list[int] = []
    for left, right in zip(candidate, comparator, strict=True):
        day = left.key.target_date
        if day not in index_of:
            index_of[day] = len(counts)
            days.append(day)
            candidate_sums.append(0.0)
            comparator_sums.append(0.0)
            counts.append(0)
        index = index_of[day]
        candidate_sums[index] += hour_loss(left)
        comparator_sums[index] += hour_loss(right)
        counts[index] += 1

    resample = resample_day_blocks(
        [
            DayBlock(day=day, left=left, right=right, units=units)
            for day, left, right, units in zip(
                days, candidate_sums, comparator_sums, counts, strict=True
            )
        ],
        draws=draws,
        seed=seed,
    )
    return PairedBootstrap(
        kind=kind,
        days=resample.days,
        hours=len(candidate),
        draws=resample.draws,
        seed=resample.seed,
        probability=resample.left_lower / resample.draws,
        ties=resample.ties,
        candidate_qloss_mwh=resample.left_per_unit,
        comparator_qloss_mwh=resample.right_per_unit,
    )


def null_rates(rows: Sequence[Mapping[str, Any]]) -> dict[str, float]:
    """The share of NULLs per feature column, over the rows given.

    One function for both sides of check 7's comparison — the training rows and
    tomorrow's serving rows — so "the serve-time rate exceeds the training rate"
    is a difference of two measurements of the same thing rather than of two
    conventions about what counts as a column. The split into features is
    :func:`~wattsteer_ml.training.contract.feature_column_names`'s, made once.
    """
    if not rows:
        raise GateInputError("a NULL rate over no row is not a rate")
    names = feature_column_names(rows[0])
    return {
        name: sum(1 for row in rows if row.get(name) is None) / len(rows)
        for name in names
    }


def serving_smoke(
    bundle: HurdleBundle,
    rows: Sequence[Mapping[str, Any]],
    *,
    target_date: date,
    training_null_rates: Mapping[str, float],
) -> ServingSmoke:
    """Check 7 — a complete band for tomorrow, from the live feature function.

    Five things, and the last two are why this check exists at all:

    - a complete twenty-four-hour band for **every** subsystem;
    - no NaN anywhere in the band or the expectation, and every band in order;
    - a day-grain figure for every subsystem, finite and in order, drawn through
      the path ensemble;
    - no feature whose serve-time NULL rate exceeds its training NULL rate by
      more than :data:`NULL_RATE_DRIFT_CEILING`;
    - **no attribute this lane's gate profile withholds carrying a value**
      (:func:`~wattsteer_ml.admissibility.assert_nothing_withheld_was_seen`).

    **The fifth is the leak, caught where it is visible.** At ``gate_early`` the
    ONS day-ahead programme has not been published — it is stamped D−1 15:00
    BRT, six hours after the 09:00 gate — so every ``programmed_*`` and
    ``proxy_*`` column of the morning lane's vector must be NULL in tomorrow's
    real rows. One value in one row means the model is about to be promoted on
    a number it will not have at 09:00, which is precisely the failure
    `docs/specs/feature-engineering.md` exists to prevent, and this is the one
    check that runs against the live feature function at the lane's own gate. It
    is a **fault** rather than a drift entry: drift is a rate compared against a
    ceiling, and this one has no tolerance to compare against.

    **What the third bullet is not, and why.** `docs/specs/forecaster.md` writes
    that clause as "the ensemble's day total inside the summed band's range",
    i.e. inside ``[Σ P10, Σ P90]``. This module does **not** compute that, for
    two reasons that are worth stating rather than working around:

    1. *It is not an invariant of this mixture.* The composed P90 of an hour is
       exactly zero wherever ``p ≤ 0.10`` — the branch is chosen before ``Q_pos``
       is consulted, the mirror of the P10 limit
       :class:`~wattsteer_ml.training.conformal.CoverageReport` documents at
       ``p ≤ 0.90``. A quiet subsystem therefore has ``Σ P90 = 0`` while its day
       total does not, because twenty-four chances of one hour going over put
       mass above zero in more than a tenth of the draws. Measured on the shared
       fixture fold, two of the four subsystems fail the containment for exactly
       that reason while the model is behaving correctly, so a gate that
       enforced it would refuse every candidate.
    2. *Summing a band is forbidden service-wide.*
       :mod:`tests.test_path_ensemble`'s grep-level invariant — the spec's own
       seam 2 — asserts that no line anywhere in this service adds a band's
       quantile to anything, "because this is the invariant most likely to be
       broken by a well-meaning optimisation". Adding one here under a comment
       saying it is only a bound is precisely the exception that invariant exists
       to refuse.

    So the day-grain half of check 7 asserts what is both true and useful: the
    ensemble produced a finite, ordered day total and peak for every subsystem,
    which is what catches a draw that failed rather than a day total that was
    built wrong. The gap is a real one and is recorded here rather than papered
    over.

    The last one catches an upstream dataset having gone quiet, which no
    historical metric can see: every fold in the table was scored on rows the
    dataset was still filling. ``training_null_rates`` is measured by
    :func:`null_rates` over the rows the artifact was fitted on. It is an
    argument rather than a card field because the card predates this ticket and
    carries no per-column NULL rate; measuring both sides with one function is
    what makes the two numbers comparable at all.

    Monotonicity is asserted rather than assumed even though
    :class:`~wattsteer_ml.mixture.QuantileBand` cannot hold an unordered triple:
    the smoke is the check an operator reads, and "the type made it impossible"
    is not something they can see at 03:00.
    """
    stray = sorted({row["target_date"] for row in rows} - {target_date})
    if stray:
        raise GateInputError(
            f"the serving smoke is about {target_date.isoformat()} and was given "
            f"rows for {[day.isoformat() for day in stray]}"
        )
    composed = forecast_rows(bundle, rows)
    faults: list[str] = []
    counted: dict[Subsystem, int] = dict.fromkeys(SUBSYSTEM_CODES, 0)
    for hour in composed:
        counted[hour.key.subsystem] += 1
        band = hour.forecast.band
        values = (band.p10, band.p50, band.p90, hour.forecast.expected_mwh)
        if any(not np.isfinite(value) for value in values):
            faults.append(f"{hour.key.line}: the band or the expectation is not finite")
        elif not band.p10 <= band.p50 <= band.p90:
            faults.append(f"{hour.key.line}: the band arrived out of order")
    for code in SUBSYSTEM_CODES:
        if counted[code] != HOURS_PER_DAY:
            faults.append(
                f"{code} has {counted[code]} composed hours for "
                f"{target_date.isoformat()}, not {HOURS_PER_DAY}"
            )
    faults.extend(_day_total_faults(bundle, rows, counted=counted))
    serving_rates = null_rates(rows)
    try:
        assert_nothing_withheld_was_seen(bundle.lane, serving_rates)
    except WithheldAtGateError as leak:
        faults.append(str(leak))
    drifted = tuple(
        NullRateDrift(feature=name, training=training_null_rates[name], serving=rate)
        for name, rate in sorted(serving_rates.items())
        if name in training_null_rates
        and rate - training_null_rates[name] > NULL_RATE_DRIFT_CEILING
    )
    return ServingSmoke(
        target_date=target_date,
        hours_by_subsystem=counted,
        faults=tuple(faults),
        drifted=drifted,
    )


def cold_start_baseline(
    fold_rows: FoldRows, *, segment: FoldSegment, run: str
) -> Comparator:
    """Rung 1, fitted and scored on this segment — the cold-start bar.

    Raises :class:`~wattsteer_ml.evaluation.ladder.MissingBaselineFeatureError`
    when the contract does not carry
    ``observed_constrained_off_same_hour_exceedance_7d``. That was the state of
    the live feature function when this was written; migration
    `0036_the_same_hour_exceedance.sql` has since added the column, so the
    refusal now names a contract built against an *older* feature function
    rather than the tree as a whole. **Either way it is the honest cold start.**
    The gate does not fall back to comparing against nothing, and rung 1 does not
    substitute ``observed_constrained_off_hours_above_threshold_7d`` — which
    counts all hours over seven days instead of the seven observations of one
    local hour, and would publish a different baseline under rung 1's name. So a
    lane whose contract predates the column promotes nothing, and the reason is a
    named exception rather than a model that quietly cleared a bar nobody set.
    """
    fitted = SameHourSevenDayRung().fit(fold_rows)
    settled = [
        row
        for row in fold_rows.segment_rows(segment)
        if row.get(TOTAL_COLUMN) is not None
    ]
    if not settled:
        raise GateInputError(
            f"{segment.row_id}: no settled hour, so rung 1 has no cold-start bar "
            "to be measured against"
        )
    rung = SameHourSevenDayRung()
    hours = _scored_hours(fitted.forecasts(settled), settled)
    return Comparator.cold_start(
        row=MetricsRow.of(
            hours, run=run, rung=rung.name, rung_number=rung.number, segment=segment
        ),
        hours=hours,
    )


def decide(
    candidate: GateCandidate,
    comparator: Comparator,
    *,
    live_feature_hash: str,
    smoke: ServingSmoke,
    now: datetime,
    draws: int = BOOTSTRAP_DRAWS,
    seed: int = BOOTSTRAP_SEED,
) -> GateDecision:
    """Run the seven checks in order and return the decision. **Never raises.**

    The raise the spec asks for on a feature-hash mismatch belongs to
    :func:`run_gate`, which records the refusal first. Splitting them is what
    makes the loud failure survivable: a gate that raised before writing would
    leave a candidate on the volume with no line saying why it is not serving.

    Checks stop at the first failure, because "in order; all must pass" makes
    every later check a statement about a comparison that is already void — a
    bootstrap against an incumbent in another lane is not evidence of anything.
    The **guardrails are the exception**: every one of them is evaluated even
    once one has vetoed, so the card names all of them rather than the first.
    """
    checks: list[GateCheck] = []
    for check in (
        _lane_identity(candidate, comparator),
        _estimator_allow_list(candidate),
        _feature_contract(candidate, comparator, live=live_feature_hash),
        _freshness_and_coverage(candidate, comparator, now=now),
    ):
        checks.append(check)
        if not check.passed:
            return _refused(
                candidate, comparator, checks, now=now, live=live_feature_hash
            )

    _assert_one_row_set(candidate, comparator)
    bootstrap = paired_block_bootstrap(
        candidate.hours, comparator.hours, kind=comparator.kind, draws=draws, seed=seed
    )
    checks.append(_bootstrap_check(bootstrap))
    if not bootstrap.promotes:
        return _refused(
            candidate,
            comparator,
            checks,
            now=now,
            live=live_feature_hash,
            bootstrap=bootstrap,
        )

    floor = floor_coverage_guardrail(
        candidate_hours=candidate.hours,
        # Rung 1 plans no fleet and therefore holds no floor; on a cold start
        # there is nothing to be five points below, and the guardrail says so
        # rather than passing.
        incumbent_hours=(comparator.hours if comparator.kind == "incumbent" else None),
        row_id=candidate.deciding_row_id,
        fidelity=candidate.segment.fidelity,
        lane=candidate.lane,
        at=now,
    )
    rails = guardrails(
        candidate.deciding, comparator.row, hours=candidate.hours
    ) + _floor_rails(floor)
    checks.append(_guardrail_check(rails))
    if not checks[-1].passed:
        return _refused(
            candidate,
            comparator,
            checks,
            now=now,
            live=live_feature_hash,
            bootstrap=bootstrap,
            rails=rails,
            floor=floor,
        )

    checks.append(_smoke_check(smoke))
    if not smoke.passed:
        return _refused(
            candidate,
            comparator,
            checks,
            now=now,
            live=live_feature_hash,
            bootstrap=bootstrap,
            rails=rails,
            smoke=smoke,
            floor=floor,
        )
    return GateDecision(
        artifact_id=candidate.artifact_id,
        lane=candidate.lane,
        decision="promote",
        reason=(
            f"P(candidate better) = {bootstrap.probability:.3f} ≥ "
            f"{PROMOTION_PROBABILITY} against the {comparator.kind} on "
            f"{candidate.deciding_row_id} over {bootstrap.days} resampled days; "
            f"{len(rails)} guardrails and the serving smoke passed"
        ),
        at=now,
        checks=tuple(checks),
        comparator=comparator.kind,
        bootstrap=bootstrap,
        guardrails=rails,
        smoke=smoke,
        floor_coverage=floor,
    )


def _floor_rails(floor: FloorCoverageVeto) -> tuple[Guardrail, ...]:
    """`docs/specs/replay.md`'s comparative guardrail, as rows of check 6.

    One rail per subsystem, never pooled — a floor coverage over two subsystems
    averages two different fleets' worth of curtailment, which is the rule
    :class:`~wattsteer_ml.replay.backtest.SubsystemCoverage` already holds — and
    one not-applicable rail when there was no comparison to make at all.

    Every rail states the incumbent it was measured against and the slack, and
    **none of them states a bar**: there is no absolute floor-coverage level in
    this repository, because an hour-wise P10 envelope has no day-level nominal
    level to compare against.
    """
    bound = f"≥ incumbent − {FLOOR_COVERAGE_SLACK}"
    if not floor.by_subsystem:
        return (
            Guardrail(
                name="floor_coverage",
                passed=False,
                applicable=False,
                detail=floor.detail,
                bound=bound,
            ),
        )
    return tuple(
        Guardrail(
            name=f"floor_coverage[{entry.subsystem}]",
            passed=entry.verdict == "passed",
            applicable=entry.verdict != "not_applicable",
            detail=entry.detail,
            value=entry.candidate,
            bound=bound,
        )
        for entry in floor.by_subsystem
    )


def guardrails(
    candidate: MetricsRow,
    comparator: MetricsRow,
    *,
    hours: Sequence[ScoredHour],
) -> tuple[Guardrail, ...]:
    """Check 6 — every veto, evaluated, whether or not an earlier one fired.

    Every constant is stated on the :class:`Guardrail` it decided, and every one
    of them can only turn a promotion into a refusal. **An unmeasurable guardrail
    vetoes**: a candidate whose ECE could not be computed has not shown that its
    ECE is under the ceiling, and a veto that passed on absent evidence would be
    a constant silently choosing a swap — which is the failure mode the whole
    arrangement is built to avoid.

    ``hours`` is the candidate's own composed hours on the deciding segment —
    the same rows ``candidate.coverage`` was counted over. They are a parameter
    rather than a lookup because the lower-coverage rail is
    :func:`p10_band_coverage`, which needs each row's served P10 and the
    threshold behind it and not only the fold's marginal: forecaster 34's
    finding is that the marginal ``coverage_p10`` **cannot** be read as a rail
    at all, because 56% of its denominator is the mixture's point mass at zero,
    where a scored hour clears its floor whatever the fit does. The marginal is
    still published, by :meth:`CoverageReport.card_fields`, under its own name.
    """
    rails: list[Guardrail] = [
        _relative(
            "pr_auc",
            candidate.pr_auc,
            comparator.pr_auc,
            slack=PR_AUC_SLACK,
            where="pooled",
        )
    ]
    comparator_cells = {cell.subsystem: cell.pr_auc for cell in comparator.by_subsystem}
    rails.extend(
        _relative(
            "pr_auc",
            cell.pr_auc,
            comparator_cells.get(cell.subsystem),
            slack=PR_AUC_SLACK,
            where=cell.subsystem,
        )
        for cell in candidate.by_subsystem
    )
    rails.append(
        _relative(
            "recall@0.5",
            candidate.at_fixed.recall,
            comparator.at_fixed.recall,
            slack=RECALL_SLACK,
            where="pooled",
        )
    )
    rails.append(p10_band_coverage(hours).as_guardrail())
    rails.append(p10_calibration_excess(hours).as_guardrail())
    rails.append(p50_band_unbiasedness(hours).as_guardrail())
    coverage = candidate.coverage
    if coverage is None:
        rails.append(
            Guardrail(
                name="coverage_p90",
                passed=False,
                detail=(
                    "this fold's test period held no curtailed hour, so there is "
                    "no coverage to measure; a guardrail cannot pass on a "
                    "measurement that was not taken"
                ),
                bound=f"in {list(COVERAGE_GUARDRAIL)}",
            )
        )
    else:
        rails.append(_window("coverage_p90", coverage.coverage_p90, COVERAGE_GUARDRAIL))
    rails.append(_ceiling("ece", candidate.ece, ECE_CEILING))
    rails.append(
        _ceiling("crossing_rate", candidate.crossing_rate, CROSSING_RATE_CEILING)
    )
    return tuple(rails)


def record_decision(decision: GateDecision, *, root: Path) -> PromotionRecord:
    """Write the card's ``gate`` block, then append exactly one log line.

    **In that order.** The promotion log is the authority for what a lane may
    serve, so a crash between the two writes leaves a card carrying a decision
    nobody acted on — which serves the incumbent, the safe reading — rather than
    a promotion whose evidence never landed. The card is written whatever the
    decision is, so a refused candidate is inspectable.
    """
    card_path = (
        root / decision.lane.directory_name / f"{decision.artifact_id}{CARD_SUFFIX}"
    )
    card = read_card(card_path)
    write_card(card_path, {**card, GATE_BLOCK_KEY: decision.card_block()})
    return append(root / PROMOTION_LOG_FILENAME, decision.to_record())


def run_gate(
    candidate: GateCandidate,
    comparator: Comparator,
    *,
    root: Path,
    live_feature_hash: str,
    smoke: ServingSmoke,
    now: datetime,
    draws: int = BOOTSTRAP_DRAWS,
    seed: int = BOOTSTRAP_SEED,
) -> GateDecision:
    """:func:`decide`, recorded — and raised on a feature-contract mismatch.

    The whole of the spec's step 8 and the second half of its step 3. On drift
    the refusal is written first, the incumbent's card is then marked with a
    contract fault so that
    :func:`~wattsteer_ml.training.bundle.load_artifact` refuses it rather than
    letting a stale model go on serving a changed contract, and only then does
    :class:`ContractDriftError` reach the caller. Nothing is deleted; the
    promotion log keeps every line it had, including the one that promoted the
    now-invalid incumbent.
    """
    decision = decide(
        candidate,
        comparator,
        live_feature_hash=live_feature_hash,
        smoke=smoke,
        now=now,
        draws=draws,
        seed=seed,
    )
    record_decision(decision, root=root)
    drift = decision.contract_drift
    if drift is not None:
        _mark_incumbent_invalid(drift, root=root)
        raise ContractDriftError(
            f"{candidate.lane}: the live feature_rows definition hashes to "
            f"{drift.live}, the candidate carries {drift.candidate} and the "
            f"incumbent {drift.incumbent_artifact_id} carries {drift.incumbent}. "
            f"{candidate.artifact_id} is refused and the incumbent is marked "
            "invalid — it was fitted against SQL the database no longer runs. "
            "Nothing on the volume has been removed."
        )
    return decision


def rollback(
    *,
    root: Path,
    lane: Lane,
    artifact_id: str,
    reason: str,
    at: datetime,
) -> PromotionRecord:
    """Restore an earlier artifact by **appending** a ``promote`` line for it.

    Never a delete, and never an edit. The bad promotion's line stays exactly
    where it was, which is what makes the incident readable afterwards, and the
    refused candidates keep their lines too. The artifact is checked to be on the
    volume first: a ``promote`` line naming a bundle that is not there makes the
    lane ``unresolvable`` (:mod:`wattsteer_ml.artifacts`), which is a worse state
    than the one being rolled back from.
    """
    if not reason.strip():
        raise GateInputError("a rollback without a reason is not a decision")
    directory = root / lane.directory_name
    for suffix, what in ((ARTIFACT_SUFFIX, "bundle"), (CARD_SUFFIX, "card")):
        path = directory / f"{artifact_id}{suffix}"
        if not path.is_file():
            raise GateError(
                f"cannot roll {lane} back to {artifact_id}: its {what} is not at "
                f"{path}. A promote line naming an absent artifact makes the lane "
                "unresolvable rather than restored"
            )
    return append(
        root / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=artifact_id,
            lane=lane,
            decision="promote",
            reason=reason,
            at=at,
            evidence={"rollback": True},
        ),
    )


def _lane_identity(candidate: GateCandidate, comparator: Comparator) -> GateCheck:
    """Check 1. A different triple is a different lane and is never a swap."""
    if comparator.lane is None:
        return GateCheck(
            name="lane_identity",
            passed=True,
            detail=(
                f"{candidate.lane} has no incumbent, so there is no triple to "
                "cross; the cold-start comparator is a baseline in this lane"
            ),
            values={"lane": candidate.lane.directory_name},
        )
    passed = candidate.lane == comparator.lane
    return GateCheck(
        name="lane_identity",
        passed=passed,
        detail=(
            f"candidate and incumbent are both {candidate.lane}"
            if passed
            else (
                f"the candidate is {candidate.lane} and the incumbent is "
                f"{comparator.lane}; a different (feature set, gate profile, "
                "threshold) is a different lane and never a swap"
            )
        ),
        values={
            "candidate_lane": candidate.lane.directory_name,
            "incumbent_lane": comparator.lane.directory_name,
        },
    )


def _estimator_allow_list(candidate: GateCandidate) -> GateCheck:
    """Check 2. The transformer's benchmark-only status, enforced."""
    passed = candidate.estimator_family in ESTIMATOR_ALLOW_LIST
    return GateCheck(
        name="estimator_allow_list",
        passed=passed,
        detail=(
            f"estimator_family {candidate.estimator_family!r} is on the allow-list"
            if passed
            else (
                f"estimator_family {candidate.estimator_family!r} is outside "
                f"{sorted(ESTIMATOR_ALLOW_LIST)}; a benchmark is not a served model"
            )
        ),
        values={
            "estimator_family": candidate.estimator_family,
            "allow_list": sorted(ESTIMATOR_ALLOW_LIST),
        },
    )


def _feature_contract(
    candidate: GateCandidate, comparator: Comparator, *, live: str
) -> GateCheck:
    """Check 3. The candidate's hash against the hash the live function makes."""
    candidate_ok = candidate.feature_hash == live
    incumbent_ok = comparator.feature_hash is None or comparator.feature_hash == live
    if candidate_ok and incumbent_ok:
        return GateCheck(
            name="feature_contract",
            passed=True,
            detail=f"the candidate and the live feature_rows both hash to {live}",
            values={"live_feature_hash": live},
        )
    return GateCheck(
        name="feature_contract",
        passed=False,
        detail=(
            f"the live feature_rows hashes to {live}; the candidate carries "
            f"{candidate.feature_hash} and the incumbent "
            f"{comparator.feature_hash}. The SQL changed, so the incumbent is "
            "invalid too — this refuses and raises rather than promoting into a "
            "mismatch or leaving a stale model serving a changed contract"
        ),
        values={
            "live_feature_hash": live,
            "candidate_feature_hash": candidate.feature_hash,
            "incumbent_feature_hash": comparator.feature_hash,
        },
    )


def _freshness_and_coverage(
    candidate: GateCandidate, comparator: Comparator, *, now: datetime
) -> GateCheck:
    """Check 4. Freshness, sixty test days, and the vintage of every fold used."""
    age = (now.date() - candidate.newest_training_target_date).days
    segment = candidate.segment
    used = tuple(row.segment for row in candidate.metrics.where(run=candidate.run))
    floor = comparator.row.fidelity
    faults: list[str] = []
    if age > MAXIMUM_TRAINING_AGE_DAYS:
        faults.append(
            "the newest training target date is "
            f"{candidate.newest_training_target_date.isoformat()}, {age} days "
            f"before {now.date().isoformat()} and outside the "
            f"{MAXIMUM_TRAINING_AGE_DAYS}-day window"
        )
    if segment.test_days < MINIMUM_TEST_DAYS:
        faults.append(
            f"{segment.row_id} has {segment.test_days} test days, under the "
            f"{MINIMUM_TEST_DAYS} a day-block bootstrap needs to mean anything"
        )
    if segment.fidelity == "revision_optimistic" and any(
        one.fidelity == "point_in_time" for one in used
    ):
        faults.append(
            f"{segment.row_id} is revision_optimistic and this run has at least "
            "one point_in_time fold; a revision-optimistic fold may not be the "
            "deciding fold once any point-in-time fold exists"
        )
    weaker = sorted({one.row_id for one in used if _weaker_than(one.fidelity, floor)})
    if weaker:
        faults.append(
            f"{weaker} are revision_optimistic and the comparator's deciding fold "
            f"{comparator.row.row_id} is {floor}; no fold used may have a worse "
            "vintage fidelity than the fold the swap is measured on"
        )
    return GateCheck(
        name="freshness_and_coverage",
        passed=not faults,
        detail=(
            "; ".join(faults)
            if faults
            else (
                f"trained to {candidate.newest_training_target_date.isoformat()} "
                f"({age}d), {segment.row_id} covers {segment.test_days} days at "
                f"{segment.fidelity}"
            )
        ),
        values={
            "training_age_days": age,
            "maximum_training_age_days": MAXIMUM_TRAINING_AGE_DAYS,
            "test_days": segment.test_days,
            "minimum_test_days": MINIMUM_TEST_DAYS,
            "deciding_fidelity": segment.fidelity,
            "comparator_fidelity": floor,
            "folds_used": [one.row_id for one in used],
        },
    )


def _bootstrap_check(bootstrap: PairedBootstrap) -> GateCheck:
    """Check 5, as a row of the card."""
    return GateCheck(
        name="paired_block_bootstrap",
        passed=bootstrap.promotes,
        detail=(
            f"P(qloss_candidate < qloss_{bootstrap.kind}) = "
            f"{bootstrap.probability:.3f} over {bootstrap.draws} resamples of "
            f"{bootstrap.days} whole target days"
        ),
        values=bootstrap.as_dict(),
    )


def _guardrail_check(rails: Sequence[Guardrail]) -> GateCheck:
    """Check 6, as a row of the card: which vetoes fired, if any."""
    failed = [rail for rail in rails if rail.vetoes]
    waived = [rail.name for rail in rails if not rail.applicable]
    return GateCheck(
        name="guardrails",
        passed=not failed,
        detail=(
            f"all {len(rails)} guardrails passed"
            if not failed
            else "; ".join(f"{rail.name}: {rail.detail}" for rail in failed)
        ),
        values={"vetoed": [rail.name for rail in failed], "not_applicable": waived},
    )


def _smoke_check(smoke: ServingSmoke) -> GateCheck:
    """Check 7, as a row of the card."""
    faults = list(smoke.faults) + [
        f"{drift.feature} is NULL in {drift.serving:.1%} of serving rows against "
        f"{drift.training:.1%} in training, over the "
        f"{NULL_RATE_DRIFT_CEILING:.0%} ceiling — an upstream dataset has gone quiet"
        for drift in smoke.drifted
    ]
    return GateCheck(
        name="serving_smoke",
        passed=smoke.passed,
        detail=(
            f"a complete {HOURS_PER_DAY}-hour band for every subsystem on "
            f"{smoke.target_date.isoformat()}, from the live feature function"
            if smoke.passed
            else "; ".join(faults)
        ),
        values=smoke.as_dict(),
    )


def _refused(
    candidate: GateCandidate,
    comparator: Comparator,
    checks: Sequence[GateCheck],
    *,
    now: datetime,
    live: str,
    bootstrap: PairedBootstrap | None = None,
    rails: Sequence[Guardrail] = (),
    smoke: ServingSmoke | None = None,
    floor: FloorCoverageVeto | None = None,
) -> GateDecision:
    """One refusal, built from the check that stopped it."""
    failed = checks[-1]
    drift = (
        ContractDrift(
            lane=candidate.lane,
            live=live,
            candidate=candidate.feature_hash,
            incumbent_artifact_id=comparator.artifact_id,
            incumbent=comparator.feature_hash,
        )
        if failed.name == "feature_contract"
        else None
    )
    return GateDecision(
        artifact_id=candidate.artifact_id,
        lane=candidate.lane,
        decision="refuse",
        reason=f"{failed.name}: {failed.detail}",
        at=now,
        checks=tuple(checks),
        comparator=comparator.kind,
        bootstrap=bootstrap,
        guardrails=tuple(rails),
        smoke=smoke,
        floor_coverage=floor,
        contract_drift=drift,
    )


def _relative(
    name: str,
    candidate: float | None,
    comparator: float | None,
    *,
    slack: float,
    where: str,
) -> Guardrail:
    """``candidate ≥ comparator − slack``, with both absences handled honestly."""
    label = f"{name}[{where}]"
    bound = f"≥ comparator − {slack}"
    if comparator is None:
        return Guardrail(
            name=label,
            passed=True,
            detail=(
                f"the comparator has no {name} on {where} — that population held "
                "no curtailed hour — so there is no floor to fall below"
            ),
            value=candidate,
            bound=bound,
        )
    if candidate is None:
        return Guardrail(
            name=label,
            passed=False,
            detail=(
                f"the comparator scores {comparator:.4f} on {where} and the "
                f"candidate has no {name} there; a guardrail cannot pass on a "
                "measurement that was not taken"
            ),
            bound=bound,
        )
    return Guardrail(
        name=label,
        passed=candidate >= comparator - slack,
        detail=(
            f"{candidate:.4f} against the comparator's {comparator:.4f}, slack {slack}"
        ),
        value=candidate,
        bound=bound,
    )


def _window(name: str, value: float, window: tuple[float, float]) -> Guardrail:
    """``value ∈ [low, high]``, with the window spelt on the answer."""
    low, high = window
    return Guardrail(
        name=name,
        passed=low <= value <= high,
        detail=f"{value:.4f} against [{low}, {high}]",
        value=value,
        bound=f"in [{low}, {high}]",
    )


def _ceiling(name: str, value: float | None, ceiling: float) -> Guardrail:
    """``value ≤ ceiling``; an absent measurement vetoes rather than passing."""
    if value is None:
        return Guardrail(
            name=name,
            passed=False,
            detail=(
                f"{name} was not measured on this fold, so it has not been shown "
                f"to be at or under {ceiling}; an unmeasured veto blocks"
            ),
            bound=f"≤ {ceiling}",
        )
    return Guardrail(
        name=name,
        passed=value <= ceiling,
        detail=f"{value:.4f} against {ceiling}",
        value=value,
        bound=f"≤ {ceiling}",
    )


def _weaker_than(fidelity: VintageFidelity, floor: VintageFidelity) -> bool:
    """Whether ``fidelity`` is a worse vintage than ``floor``.

    Two values, one inequality: ``revision_optimistic`` is weaker than
    ``point_in_time``, and nothing is weaker than ``revision_optimistic``. Spelt
    as a comparison rather than as an ordering table, because a table with two
    rows is a table that will be read as though it had more.
    """
    return fidelity == "revision_optimistic" and floor == "point_in_time"


def assert_paired_hours(
    candidate: Sequence[ScoredHour], comparator: Sequence[ScoredHour]
) -> None:
    """The two sequences are two predictions of one row set, in one order.

    Public because it is the pairing rule, and a second expression of it is a
    second thing to keep in step: :mod:`~wattsteer_ml.evaluation.dessem_ab`
    holds three arms to it before it builds a floor out of any of them, for the
    reason this one holds two — two sequences scored against different labels
    look exactly like a difference between two models.
    """
    for left, right in zip(candidate, comparator, strict=True):
        if left.key != right.key:
            raise GateInputError(
                f"the candidate and the comparator disagree at {left.key.line!r} "
                f"vs {right.key.line!r}; a paired bootstrap resamples one row set"
            )
        if left.observed_mwh != right.observed_mwh:
            raise GateInputError(
                f"{left.key.line}: the two models were scored against different "
                f"labels ({left.observed_mwh} and {right.observed_mwh})"
            )


def _assert_one_row_set(candidate: GateCandidate, comparator: Comparator) -> None:
    """The two metrics rows describe the same segment, by hash.

    :meth:`~wattsteer_ml.evaluation.metrics.MetricsTable.delta_against`'s rule,
    applied where the two rows come from two different tables and so cannot be
    checked by that method: "two rungs scored on different rows are not a delta",
    and two artifacts scored on different rows are not a swap.
    """
    if candidate.segment.segment_hash != comparator.row.segment.segment_hash:
        raise GateInputError(
            f"the candidate decides on {candidate.segment.row_id} and the "
            f"comparator on {comparator.row.row_id}, under different segments; "
            "these are not the same rows and the comparison is not paired"
        )


def _day_total_faults(
    bundle: HurdleBundle,
    rows: Sequence[Mapping[str, Any]],
    *,
    counted: Mapping[Subsystem, int],
) -> list[str]:
    """A finite, ordered day total and peak for every subsystem, or the faults.

    Read off :func:`~wattsteer_ml.training.hurdle.day_grain_rows`, which is the
    one route to a figure above hour grain. See :func:`serving_smoke` for why
    this is not the summed-band containment the spec's wording asks for.

    Skipped entirely when a subsystem's day is already incomplete: that fault is
    reported once, by its own check, and a day total over twenty-three hours is a
    different quantity wearing the same name.
    """
    if any(count != HOURS_PER_DAY for count in counted.values()):
        return []
    faults: list[str] = []
    seen: set[Subsystem] = set()
    for day in day_grain_rows(bundle, rows):
        seen.add(day.subsystem)
        where = f"{day.subsystem} {day.target_date.isoformat()}"
        for label, band in (("day total", day.day_total), ("peak", day.peak_power)):
            values = (band.p10, band.p50, band.p90)
            if any(not np.isfinite(value) for value in values):
                faults.append(f"{where}: the {label} band is not finite")
            elif values[0] > values[1] or values[1] > values[2]:
                faults.append(f"{where}: the {label} band arrived out of order")
    missing = sorted(set(SUBSYSTEM_CODES) - seen)
    if missing:
        faults.append(
            f"the path ensemble produced no day-grain figure for {missing}, so "
            "tomorrow has twenty-four hourly bands and no day total"
        )
    return faults


def _scored_hours(
    forecasts: Sequence[HourForecast], rows: Sequence[Mapping[str, Any]]
) -> tuple[ScoredHour, ...]:
    """Pair each composed hour with the label of the row it was composed from."""
    return tuple(
        ScoredHour(
            key=hour.key, forecast=hour.forecast, observed_mwh=float(row[TOTAL_COLUMN])
        )
        for hour, row in zip(forecasts, rows, strict=True)
    )


def _mark_incumbent_invalid(drift: ContractDrift, *, root: Path) -> None:
    """Write the contract fault onto the incumbent's card.

    The mark is on the card rather than in the promotion log because the log has
    two decisions — ``promote`` and ``refuse`` — and neither revokes an earlier
    promotion: a rollback is an append naming an *earlier artifact*, and after a
    contract change there is no earlier artifact to name, since every bundle in
    the lane was fitted against the departed SQL. So the invalidation goes where
    :func:`~wattsteer_ml.training.bundle.load_artifact` already refuses things —
    the card — and the artifact stops loading rather than going on serving.
    Nothing is deleted and no log line is rewritten.
    """
    if drift.incumbent_artifact_id is None:
        return
    path = (
        root / drift.lane.directory_name / f"{drift.incumbent_artifact_id}{CARD_SUFFIX}"
    )
    if not path.is_file():
        return
    card = read_card(path)
    existing = card.get(GATE_BLOCK_KEY)
    block = dict(existing) if isinstance(existing, dict) else {}
    block[CONTRACT_FAULT_KEY] = drift.fault
    write_card(path, {**card, GATE_BLOCK_KEY: block})
