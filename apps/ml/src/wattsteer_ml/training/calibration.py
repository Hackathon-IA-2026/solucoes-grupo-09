"""A stated 80% means 80%: isotonic, the reliability curve, and the risk classes.

`docs/specs/forecaster.md`, "Calibration — isotonic, and where the curve lives".
Three things live here and they have three different provenances, which is the
only structural fact about this module worth holding in your head:

1. :class:`IsotonicCalibrator` is fitted on **the calibration window**, the
   90-day block :class:`~wattsteer_ml.evaluation.FoldBlocks` carves out of the
   training block. The base learners are not refit afterwards.
2. :class:`ReliabilityCurve` is measured on **pooled out-of-fold predictions
   across every walk-forward test fold** — never on the window the calibrator
   was fitted to, never on training data. It is a property of the model, not of
   a day.
3. :class:`RiskBins` is derived from that pool by the spec's rule, and is then
   **held stable across retrains** unless a retrain violates the rule.

**The calibrated probability is not a second path to a band.** ``p`` enters
:func:`wattsteer_ml.mixture.compose` as a breakpoint at ``1 − p`` and nowhere
else; calibrating it changes the breakpoint and changes nothing else. Nothing in
this module imports :mod:`wattsteer_ml.mixture`, constructs a quantile or
multiplies a probability by a magnitude, and
:mod:`tests.test_isotonic_calibration` asserts that against this file's source.

**Why the isotonic fit is written here rather than imported.** ``sklearn`` is not
a dependency of this service and this is not a good reason to make it one: the
fit is the pool-adjacent-violators algorithm, which is forty lines and exact,
and the *artifact* consequence is the deciding one. A pickled
``sklearn.isotonic.IsotonicRegression`` inside the bundle would couple every
stored artifact to a library version, and
:func:`~wattsteer_ml.training.bundle.load_artifact` — whose whole job is to
re-validate a bundle field by field after an ``__init__``-less
``joblib.load`` — cannot check the innards of a foreign estimator. A frozen
dataclass of knots can be checked completely, and is.

**Clipping, and what ``n`` is.** Output is clipped to
``[1/(2n), 1 − 1/(2n)]``. The spec calls ``n`` "the calibration window's row
count"; this module uses the number of calibration rows that carried a **settled
label**, because those are the rows that are evidence about how often an event
happens. An unlabelled hour told the calibrator nothing, and counting it would
widen ``n``, tighten the clip and make a *stronger* claim on the strength of
rows that said nothing — which is the direction this spec errs against
everywhere. The count used is stored on the calibrator and written to the card
under its own name, so the choice is auditable rather than implied.

**Two places where this module is deliberately stricter than the spec's prose.**

- *The pool is filtered against this artifact's calibration window.* Walk-forward
  folds are contiguous, so an earlier fold's test period can sit inside a later
  fold's calibration window. Those rows were out of fold for the model that
  predicted them, but they are rows this artifact's calibrator was fitted on, so
  :meth:`ReliabilityCurve.of` drops them and records how many it dropped. The
  curve is then disjoint from the calibration window by construction rather than
  by hope. Base-fit rows are **not** dropped: every pooled prediction was made by
  a model that had not seen its own row, which is what "out of fold" means, and
  dropping them would empty the pool for the newest fold, which is the only fold
  anyone serves.
- *The candidate edges are searched on the 5-point grid rather than rounded onto
  it afterwards.* The spec's rule filters candidates by (a) and (b) and rounds
  the winner to the nearest 5 points. Rounding last can move an edge off a
  candidate that satisfied the rule onto one that does not, and then the
  published edges fail the rule that chose them. Searching the grid directly
  gives the same granularity and makes (a) and (b) true *of the published
  numbers*, which is the property anyone would check.

**What this module does not decide.** It does not know what a fold is, does not
materialise a calendar, and does not choose which predictions are in the pool.
It is handed :class:`OutOfFoldPrediction` values that already carry the fold
they were predicted out of, and it refuses rather than repairs.

**The occurrence map is fitted per subsystem too, where the rows allow —
2026-09-23.** The live P10 diagnostic measured the pooled isotonic curve
under-stating ``p`` for N and S specifically: NE holds 68%+ of the fitting
population, and on the worst fold the pooled curve read 0.90 where N and S's
own curves read at or above 0.9998 at the same raw score, which is exactly the
gap that decides whether an hour clears conformal's ``states_lower_bound``
eligibility test in :mod:`wattsteer_ml.training.conformal`.
:func:`calibrate_by_subsystem` and :class:`SubsystemCalibration` mirror the
shape :class:`~wattsteer_ml.training.conformal.SubsystemCorrections` already
proved for ``δ_lo``, one stage earlier: the fit itself
(:meth:`IsotonicCalibrator.fit`) still takes only ``(raw, observed)`` and
never a key, so the split lives entirely in the function that calls it per
subsystem, and ``reliability``/``risk_bins`` are untouched — see
:class:`SubsystemCalibration`'s own docstring for why those two stay pooled.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from itertools import pairwise
from typing import Any, Literal

from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import FoldSegment, RowKey, pooled_fidelity

#: Equal-width reliability bins over ``[0, 1]``, before any merge.
RELIABILITY_BINS = 10

#: A bin below this many hours is merged into a neighbour and the merge is
#: recorded. `docs/specs/forecaster.md`: "a bin with fewer than 100 hours is
#: merged upward into its neighbour and the merge is recorded".
MIN_BIN_HOURS = 100

#: The grid the risk-class edges are chosen on. "Round to the nearest 5 points",
#: applied to the search rather than to its winner — see the module docstring.
RISK_EDGE_STEP = 0.05

#: (a) — within each risk bin, ``|mean predicted − observed frequency|``.
MAX_RISK_BIN_GAP = 0.05

#: The two-sided normal quantile behind a 95% interval. Named because it is the
#: only constant in condition (b) and it is not this spec's invention.
Z_95 = 1.959963984540054

#: The three named classes, in order. `packages/core` publishes the same three
#: and the overview renders them; a fourth would be a product change, not a
#: calibration one.
RISK_CLASSES: tuple[str, str, str] = ("low", "elevated", "high")

RiskClass = Literal["low", "elevated", "high"]

MergeDirection = Literal["up", "down"]


class CalibrationError(ValueError):
    """A calibration that cannot be published as written."""


class RiskBinsUndeterminedError(CalibrationError):
    """No three-class split of this curve satisfies the spec's rule.

    Its own class because the correct response is to refuse the artifact, not to
    fall back on the two percentages the prototype invented. `risk_bins` is a
    published artifact — `docs/specs/diagnosis.md` withholds narration below the
    lowest edge and `apps/web` renders the classes — so edges nobody measured
    would be a product claim with nothing behind it.
    """


@dataclass(frozen=True)
class IsotonicCalibrator:
    """``p_raw → p``, as a monotone step function with its ends clipped away.

    The knots are the pool-adjacent-violators solution: ``knots_x`` is
    non-decreasing in ``p_raw`` and ``knots_y`` is the fitted, monotone
    non-decreasing calibrated value at each. Between knots the map interpolates
    linearly and **outside the outermost knots it holds flat**, which is the
    same convention :class:`wattsteer_ml.mixture.MagnitudeQuantiles` uses for the
    same reason: a fit says nothing beyond its outermost knot, and a line drawn
    past one is an invented tail.
    """

    knots_x: tuple[float, ...]
    knots_y: tuple[float, ...]
    #: ``1/(2n)`` and ``1 − 1/(2n)``. Stored rather than recomputed at call time
    #: so that a loaded bundle carries the bound it was written under, and a
    #: served probability can be checked against the evidence behind it.
    clip_lo: float
    clip_hi: float
    #: ``n`` — the labelled calibration rows the fit saw. The clip is a function
    #: of this and of nothing else.
    fitted_rows: int

    def __post_init__(self) -> None:
        if len(self.knots_x) != len(self.knots_y):
            raise CalibrationError(
                f"the calibrator has {len(self.knots_x)} inputs and "
                f"{len(self.knots_y)} outputs"
            )
        if not self.knots_x:
            raise CalibrationError("an isotonic calibrator with no knots maps nothing")
        for name, values in (("knots_x", self.knots_x), ("knots_y", self.knots_y)):
            for value in values:
                if not math.isfinite(value):
                    raise CalibrationError(f"{name} carries {value!r}")
        for earlier, later in pairwise(self.knots_x):
            if later <= earlier:
                raise CalibrationError(
                    f"knots_x must strictly increase; {earlier!r} is followed by "
                    f"{later!r}"
                )
        for earlier, later in pairwise(self.knots_y):
            if later < earlier:
                raise CalibrationError(
                    "an isotonic map is non-decreasing; "
                    f"{earlier!r} is followed by {later!r}"
                )
        if self.fitted_rows <= 0:
            raise CalibrationError(
                f"the clip is derived from the calibration window's labelled row "
                f"count, and {self.fitted_rows!r} rows are not evidence"
            )
        expected_lo = 1.0 / (2.0 * self.fitted_rows)
        if self.clip_lo != expected_lo or self.clip_hi != 1.0 - expected_lo:
            raise CalibrationError(
                f"the clip bounds ({self.clip_lo!r}, {self.clip_hi!r}) are not "
                f"1/(2n) and 1 − 1/(2n) for n = {self.fitted_rows}; the bound is a "
                "function of evidence, not a magic epsilon"
            )
        if not 0.0 < self.clip_lo < self.clip_hi < 1.0:
            raise CalibrationError(
                f"the clip ({self.clip_lo!r}, {self.clip_hi!r}) does not exclude "
                "both endpoints, and both are forbidden"
            )

    def __call__(self, p_raw: float) -> float:
        """The calibrated probability. Never exactly 0 and never exactly 1.

        A zero is forbidden twice over: it makes ``Q_Y(q)`` undefined at
        ``q = 1``, and it puts "0%" on a screen as a claim about tomorrow.
        """
        if not math.isfinite(p_raw) or not 0.0 <= p_raw <= 1.0:
            raise CalibrationError(
                f"the classifier's raw output must be a probability, got {p_raw!r}"
            )
        return min(self.clip_hi, max(self.clip_lo, self._interpolate(p_raw)))

    def _interpolate(self, p_raw: float) -> float:
        x, y = self.knots_x, self.knots_y
        if p_raw <= x[0]:
            return y[0]
        if p_raw >= x[-1]:
            return y[-1]
        lo = 0
        hi = len(x) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if x[mid] <= p_raw:
                lo = mid
            else:
                hi = mid
        span = x[hi] - x[lo]
        weight = (p_raw - x[lo]) / span
        return y[lo] + weight * (y[hi] - y[lo])

    @classmethod
    def fit(cls, raw: Sequence[float], observed: Sequence[bool]) -> IsotonicCalibrator:
        """Pool adjacent violators on ``(p_raw, y)``, then derive the clip.

        Exact and non-parametric: the solution is the least-squares
        non-decreasing fit, and the whole algorithm is "while two adjacent blocks
        disagree about the direction, pool them". A sigmoid could not produce it,
        which is the point — the distortion a boosted classifier puts on an
        imbalanced target is well calibrated low and over-confident high, and two
        parameters cannot flatten the top without bending the bottom.
        """
        if len(raw) != len(observed):
            raise CalibrationError(
                f"{len(raw)} probabilities and {len(observed)} labels are not pairs"
            )
        if not raw:
            raise CalibrationError(
                "isotonic calibration needs the calibration window's labelled "
                "rows, and none were supplied"
            )
        for value in raw:
            if not math.isfinite(value) or not 0.0 <= value <= 1.0:
                raise CalibrationError(
                    f"the classifier's raw output must be a probability, got {value!r}"
                )
        order = sorted(range(len(raw)), key=lambda index: (raw[index], index))
        # Blocks of (x, sum of y, weight). Ties in x are pooled first, so the map
        # is a function: two identical raw scores cannot be given two answers.
        blocks: list[list[float]] = []
        for index in order:
            x = float(raw[index])
            y = 1.0 if observed[index] else 0.0
            if blocks and blocks[-1][0] == x:
                blocks[-1][1] += y
                blocks[-1][2] += 1.0
            else:
                blocks.append([x, y, 1.0])
        pooled: list[list[float]] = []
        for block in blocks:
            pooled.append(block)
            while len(pooled) > 1 and (
                pooled[-2][1] / pooled[-2][2] > pooled[-1][1] / pooled[-1][2]
            ):
                later = pooled.pop()
                earlier = pooled.pop()
                pooled.append([later[0], earlier[1] + later[1], earlier[2] + later[2]])
        knots_x: list[float] = []
        knots_y: list[float] = []
        cursor = 0
        for block in pooled:
            value = block[1] / block[2]
            # One knot per *original* x in the pooled block, so the step's left
            # edge is representable and the map is piecewise linear between the
            # steps rather than jumping at a point nothing was observed at.
            while cursor < len(blocks) and blocks[cursor][0] <= block[0]:
                knots_x.append(blocks[cursor][0])
                knots_y.append(value)
                cursor += 1
        rows = len(raw)
        half = 1.0 / (2.0 * rows)
        return cls(
            knots_x=tuple(knots_x),
            knots_y=tuple(knots_y),
            clip_lo=half,
            clip_hi=1.0 - half,
            fitted_rows=rows,
        )

    def card_fields(self) -> dict[str, Any]:
        return {
            "method": "isotonic",
            "knots": len(self.knots_x),
            "clip_lo": self.clip_lo,
            "clip_hi": self.clip_hi,
            "clip_basis": "calibration_labelled_rows",
            "calibration_labelled_rows": self.fitted_rows,
        }

    def calibrate_for(self, subsystem: Subsystem) -> IsotonicCalibrator:
        """:meth:`__call__`'s target, under the interface :class:`SubsystemCalibration`
        shares.

        Ignores ``subsystem`` — this map is marginal — so
        :func:`~wattsteer_ml.training.hurdle.compose_estimates`'s composition
        can write ``isotonic.calibrate_for(key.subsystem)`` without knowing
        whether it was handed a plain :class:`IsotonicCalibrator` or a
        :class:`SubsystemCalibration`, the same shape
        :meth:`~wattsteer_ml.training.conformal.ConformalCorrection.shift_for`
        already gives the conformal correction.
        """
        return self


#: Below this many labelled calibration-window rows for one subsystem, its own
#: isotonic fit is declined and :meth:`SubsystemCalibration.calibrate_for`
#: falls back to the pooled map. The isotonic fit's population is **every
#: scored hour in the window for that subsystem**, curtailed or not — the fit
#: needs resolution across the whole raw-score range, not only near the top —
#: so this floor is the same order of magnitude the two lowest quantile
#: boosters' ``role_overrides`` treat as "enough to say something" at
#: ``min_data_in_leaf``: 300, against v1's shared 100
#: (`training/hyperparameters.py`, ``MODEL_CONFIG_V2``). Below it, a subsystem
#: that happens to run thin in one 90-day window (N and S both do, in the fold
#: sweep behind this ticket) gets a curve with too few distinct raw scores to
#: resolve reliably, and the pooled map — fitted on four subsystems' rows at
#: once — is still the better estimate of what its own curve would say.
MINIMUM_SUBSYSTEM_CALIBRATION_ROWS = 300

#: Below this many **curtailed** (``y > τ``) rows among those, the fit is
#: declined even if the total floor above is cleared: a monotone step function
#: needs positive examples across its range to move away from the pooled
#: curve's shape at all, and a subsystem that only ever states rare, isolated
#: events would fit an isotonic map to a handful of step edges wearing 300
#: rows of resolution it does not have where it matters.
#:
#: Set at more than three times :func:`~wattsteer_ml.training.conformal.\
#: minimum_calibration_rows`'s floor of 9 at the nominal miscoverage —
#: "comfortably above" it, per the measurement this floor answers to: a curve
#: fitted on positives as thin as the conformal module's own order statistic
#: is exactly as fragile as the thing that floor exists to protect, one stage
#: earlier in the pipeline. The live P10 diagnostic (`p10_calibration_run.py`,
#: 2026-09-23) measured N and S each carrying several hundred curtailed rows
#: in a 90-day calibration window on the folds this ticket exists for — 500
#: and 250 respectively on the worst fold sampled — so this floor is not
#: expected to bind for them on a typical window; it exists for the window
#: that genuinely is that thin, so a per-subsystem curve fitted on evidence
#: this sparse is refused rather than served with unwarranted confidence.
MINIMUM_SUBSYSTEM_CALIBRATION_POSITIVE_ROWS = 30


@dataclass(frozen=True)
class SubsystemIsotonic:
    """One subsystem's own isotonic map on the calibration window, or a decline.

    Mirrors :class:`~wattsteer_ml.training.conformal.SubsystemDeltaLo`'s shape
    one stage earlier in the pipeline: :func:`calibrate_by_subsystem` builds
    one of these per subsystem, and :attr:`SubsystemCalibration.per_subsystem`
    keeps only the ones that cleared both floors — a subsystem below either is
    named in :attr:`SubsystemCalibration.declined` instead of stored here with
    a null map, exactly as :func:`~wattsteer_ml.training.conformal.\
conformalise_by_subsystem` does for :class:`~wattsteer_ml.training.conformal.\
SubsystemDeltaLo`.
    """

    subsystem: Subsystem
    #: Labelled calibration-window rows for this subsystem alone.
    rows: int
    #: Of those, the ones above τ — what
    #: :data:`MINIMUM_SUBSYSTEM_CALIBRATION_POSITIVE_ROWS` is checked against.
    positive_rows: int
    isotonic: IsotonicCalibrator | None
    fitted: bool

    def __post_init__(self) -> None:
        if self.rows < 0 or self.positive_rows < 0:
            raise CalibrationError(f"{self.subsystem}: a row count cannot be negative")
        if self.positive_rows > self.rows:
            raise CalibrationError(
                f"{self.subsystem}: {self.positive_rows} positive rows out of "
                f"{self.rows} total; the positive count is a subset of the whole"
            )
        if self.fitted and self.isotonic is None:
            raise CalibrationError(
                f"{self.subsystem}: fitted=True with no isotonic map behind it"
            )
        if not self.fitted and self.isotonic is not None:
            raise CalibrationError(
                f"{self.subsystem}: declined below the floor but carries a "
                "fitted isotonic map anyway; a curve fitted over rows the "
                "floor rejected is not a correction"
            )

    def card_fields(self) -> dict[str, Any]:
        return {
            "rows": self.rows,
            "positive_rows": self.positive_rows,
            "fitted": self.fitted,
            **(self.isotonic.card_fields() if self.isotonic is not None else {}),
        }


@dataclass(frozen=True)
class OutOfFoldPrediction:
    """One pooled prediction: whose fold it came from, and what happened.

    ``probability`` is the **calibrated** probability that fold's model actually
    published for this row — the curve is a statement about the product, not
    about a classifier's raw output — and ``observed`` is whether that hour was
    above ``τ``. It said so before it was true:
    :func:`~wattsteer_ml.training.hurdle.out_of_fold_occurrence` returned
    ``p_raw`` until 2026-09-23, which made every risk-bin derivation test a
    calibration clause against the number the calibrator had not fixed yet.
    That function's docstring carries the measurement.

    ``fold_id`` travels so that a curve can say which folds it pooled, and so
    that a row can never be pooled without one.
    """

    fold_id: str
    key: RowKey
    probability: float
    observed: bool

    def __post_init__(self) -> None:
        if not self.fold_id:
            raise CalibrationError(
                "a pooled prediction with no fold is not out of anything"
            )
        if not math.isfinite(self.probability) or not 0.0 <= self.probability <= 1.0:
            raise CalibrationError(
                f"{self.fold_id} {self.key.line}: {self.probability!r} is not a "
                "probability"
            )


@dataclass(frozen=True)
class OutOfFoldPool:
    """Pooled out-of-fold predictions, with the fidelity they may be labelled by.

    Built through :meth:`of`, which does the two checks that make "out of fold"
    a property rather than a promise:

    - **Every prediction lies inside its own fold's test period.** A row a fold's
      model was fitted on cannot be pooled as that fold's out-of-fold prediction,
      and the segments come from
      :func:`wattsteer_ml.evaluation.stamp_fidelity`, which derives them from the
      calendar rather than from whatever the run happened to score.
    - **The pool has one fidelity or it has none.**
      :func:`wattsteer_ml.evaluation.pooled_fidelity` raises on a mixed pool
      instead of picking a label, because a curve pooled across ingestion go-live
      would be ``revision_optimistic`` with no way to say how much of it was.
    """

    predictions: tuple[OutOfFoldPrediction, ...]
    fidelity: VintageFidelity
    #: The segments the pool was assembled from, in the order they were given.
    segments: tuple[FoldSegment, ...]

    def __post_init__(self) -> None:
        if not self.predictions:
            raise CalibrationError("an out-of-fold pool with no predictions")

    def __len__(self) -> int:
        return len(self.predictions)

    @classmethod
    def of(
        cls,
        predictions: Sequence[OutOfFoldPrediction],
        *,
        segments: Sequence[FoldSegment],
    ) -> OutOfFoldPool:
        """Check each prediction against its own fold's test period, then label."""
        if not segments:
            raise CalibrationError(
                "a pool needs the fold segments it was scored on; without them "
                "nothing here can tell an out-of-fold prediction from an in-sample "
                "one"
            )
        periods: dict[str, list[FoldSegment]] = {}
        for segment in segments:
            periods.setdefault(segment.fold_id, []).append(segment)
        for prediction in predictions:
            windows = periods.get(prediction.fold_id)
            if windows is None:
                raise CalibrationError(
                    f"{prediction.fold_id} is not among the pooled segments "
                    f"{sorted(periods)!r}; a prediction whose fold is unknown "
                    "cannot be shown to be out of it"
                )
            day = prediction.key.target_date
            if not any(window.test_start <= day <= window.test_end for window in windows):
                raise CalibrationError(
                    f"{prediction.fold_id} {prediction.key.line} falls outside that "
                    "fold's test period; it is a prediction the fold's own model "
                    "was fitted on, and pooling it would make the curve a "
                    "self-portrait"
                )
        return cls(
            predictions=tuple(predictions),
            fidelity=pooled_fidelity(segments),
            segments=tuple(segments),
        )


@dataclass(frozen=True)
class BinMerge:
    """One recorded merge: which bin was short, where it went, and how far.

    ``direction`` is carried rather than assumed. The spec says a short bin
    merges *upward*, and the top bin has no upward — so a short top bin merges
    down and says so, rather than being quietly dropped or quietly kept.
    """

    lower: float
    upper: float
    into_lower: float
    into_upper: float
    direction: MergeDirection
    hour_count: int

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "bin": [self.lower, self.upper],
            "into": [self.into_lower, self.into_upper],
            "direction": self.direction,
            "hour_count": self.hour_count,
            "reason": f"fewer than {MIN_BIN_HOURS} hours",
        }


@dataclass(frozen=True)
class ReliabilityBin:
    """One point of the curve, with the two numbers that make it checkable.

    ``mean_predicted`` and not the bin centre: after a merge a bin can be 0.2
    wide, and the gap the spec asks for is between what was *said* and what
    happened, not between a bin's midpoint and what happened.
    """

    lower: float
    upper: float
    mean_predicted: float
    observed_frequency: float
    hour_count: int
    #: Whether this bin is the result of one or more merges.
    merged: bool

    def __post_init__(self) -> None:
        if self.hour_count <= 0:
            raise CalibrationError(
                f"the bin [{self.lower}, {self.upper}) has no hours; an empty bin "
                "is merged, never reported"
            )

    @property
    def bin_centre(self) -> float:
        return (self.lower + self.upper) / 2.0

    @property
    def gap(self) -> float:
        """``mean predicted − observed``. Signed: positive is over-confident."""
        return self.mean_predicted - self.observed_frequency

    def as_card_point(self) -> dict[str, Any]:
        return {
            "bin_lower": self.lower,
            "bin_upper": self.upper,
            "bin_centre": self.bin_centre,
            "mean_predicted": self.mean_predicted,
            "observed_frequency": self.observed_frequency,
            "hour_count": self.hour_count,
            "merged": self.merged,
        }


@dataclass(frozen=True)
class ReliabilityCurve:
    """The curve, its scalars, and the window and fidelity they are true over.

    Built through :meth:`of`, so a curve cannot be handed a set of bins that was
    never measured and cannot be handed a fidelity that its rows do not share:
    :func:`wattsteer_ml.evaluation.pooled_fidelity` refuses a mixed pool rather
    than averaging one, and averaging is precisely how a caveat disappears.
    """

    bins: tuple[ReliabilityBin, ...]
    merges: tuple[BinMerge, ...]
    sample_hours: int
    window_start: date
    window_end: date
    fidelity: VintageFidelity
    fold_ids: tuple[str, ...]
    #: Rows dropped because they fell inside the artifact's calibration window.
    #: Recorded, because the difference between "the pool had none" and "the pool
    #: had some and they were removed" is the difference between a curve that is
    #: disjoint from the fit and one that happens to be.
    excluded_calibration_hours: int

    def __post_init__(self) -> None:
        if not self.bins:
            raise CalibrationError("a reliability curve with no bins measures nothing")
        if self.window_start > self.window_end:
            raise CalibrationError(
                f"empty reliability window {self.window_start.isoformat()} to "
                f"{self.window_end.isoformat()}"
            )
        if self.sample_hours != sum(one.hour_count for one in self.bins):
            raise CalibrationError(
                f"the curve says {self.sample_hours} hours and its bins hold "
                f"{sum(one.hour_count for one in self.bins)}"
            )

    @property
    def ece(self) -> float:
        """Expected calibration error — the hour-weighted mean absolute gap."""
        return sum(one.hour_count * abs(one.gap) for one in self.bins) / self.sample_hours

    @property
    def mce(self) -> float:
        """Maximum calibration error — the worst bin gap, unweighted."""
        return max(abs(one.gap) for one in self.bins)

    @property
    def top_bin_gap(self) -> float:
        """The signed gap of the bin reaching 1.0. Reported on its own.

        Because that is where a curtailment classifier fails and where the
        product's confident statements come from. Positive means the model said
        more than happened.
        """
        return self.bins[-1].gap

    @classmethod
    def of(
        cls,
        pool: OutOfFoldPool,
        *,
        calibration_window: tuple[date, date] | None = None,
    ) -> ReliabilityCurve:
        """Bin a pool, merge what is too thin to say anything, and count.

        Args:
            pool: pooled out-of-fold predictions, already checked against the
                fold segments they came from and already carrying one fidelity.
            calibration_window: this artifact's calibration window. Rows inside
                it are dropped and counted — see the module docstring.
        """
        kept, excluded = outside_calibration_window(pool, calibration_window)
        bins, merges = _merged(kept)
        return cls(
            bins=tuple(_reported(one) for one in bins),
            merges=tuple(merges),
            sample_hours=len(kept),
            window_start=min(one.key.target_date for one in kept),
            window_end=max(one.key.target_date for one in kept),
            fidelity=pool.fidelity,
            fold_ids=tuple(sorted({one.fold_id for one in kept})),
            excluded_calibration_hours=excluded,
        )

    def card_fields(self) -> dict[str, Any]:
        return {
            "reliability": [one.as_card_point() for one in self.bins],
            "reliability_merges": [merge.as_card_entry() for merge in self.merges],
            "reliability_sample_hours": self.sample_hours,
            "reliability_window": {
                "start": self.window_start.isoformat(),
                "end": self.window_end.isoformat(),
            },
            "reliability_fidelity": self.fidelity,
            "reliability_folds": list(self.fold_ids),
            "reliability_excluded_calibration_hours": (self.excluded_calibration_hours),
            "ece": self.ece,
            "mce": self.mce,
            "top_bin_gap": self.top_bin_gap,
        }


@dataclass(frozen=True)
class RiskBins:
    """The three named classes, as half-open probability intervals.

    ``low = [0, e1)``, ``elevated = [e1, e2)``, ``high = [e2, 1]``. Two numbers,
    published, and the UI reads them from the API rather than holding a styling
    constant — the shape ``packages/core`` already types as ``RiskBins``.
    """

    low: tuple[float, float]
    elevated: tuple[float, float]
    high: tuple[float, float]

    def __post_init__(self) -> None:
        edges = (
            self.low[0],
            self.low[1],
            self.elevated[0],
            self.elevated[1],
            self.high[0],
            self.high[1],
        )
        for edge in edges:
            if not math.isfinite(edge) or not 0.0 <= edge <= 1.0:
                raise CalibrationError(f"{edge!r} is not a probability edge")
        if self.low[0] != 0.0 or self.high[1] != 1.0:
            raise CalibrationError(
                f"the three classes must cover [0, 1]; they run from {self.low[0]!r} "
                f"to {self.high[1]!r}"
            )
        if self.low[1] != self.elevated[0] or self.elevated[1] != self.high[0]:
            raise CalibrationError(
                "the three classes must abut; a gap between them is a probability "
                "with no risk class and an overlap is one with two"
            )
        if not 0.0 < self.low[1] < self.high[0] < 1.0:
            raise CalibrationError(
                f"the edges {self.low[1]!r} and {self.high[0]!r} do not put a "
                "non-empty class on each side"
            )

    @property
    def edges(self) -> tuple[float, float]:
        """``(e1, e2)`` — the two cut points, which is what a retrain compares."""
        return (self.low[1], self.high[0])

    @property
    def lowest_edge(self) -> float:
        """The edge `nothing_to_explain` withholds narration below.

        `docs/specs/diagnosis.md`: the day's narration is withheld when the day's
        occurrence probability is below this **and** no hour's P50 is non-zero.
        Named here so the diagnosis path reads one published number rather than
        indexing a tuple.
        """
        return self.low[1]

    def classify(self, probability: float) -> RiskClass:
        """The named class of a calibrated probability. Total on ``[0, 1]``."""
        if not math.isfinite(probability) or not 0.0 <= probability <= 1.0:
            raise CalibrationError(f"{probability!r} is not a probability")
        if probability < self.low[1]:
            return "low"
        if probability < self.high[0]:
            return "elevated"
        return "high"

    @classmethod
    def from_edges(cls, first: float, second: float) -> RiskBins:
        return cls(low=(0.0, first), elevated=(first, second), high=(second, 1.0))

    def card_fields(self) -> dict[str, list[float]]:
        return {
            "low": list(self.low),
            "elevated": list(self.elevated),
            "high": list(self.high),
        }


@dataclass(frozen=True)
class RiskBinCheck:
    """Whether one candidate split satisfies (a) and (b), and by how much."""

    bins: RiskBins
    hour_counts: tuple[int, int, int]
    mean_predicted: tuple[float, float, float]
    observed: tuple[float, float, float]
    #: The largest ``|mean predicted − observed|`` across the three classes.
    worst_gap: float
    satisfies_a: bool
    satisfies_b: bool
    #: One line naming the first condition that failed, or why it passed.
    reason: str

    @property
    def satisfied(self) -> bool:
        return self.satisfies_a and self.satisfies_b

    @property
    def imbalance(self) -> int:
        """``max − min`` hour count. Smaller is "more nearly equal"."""
        return max(self.hour_counts) - min(self.hour_counts)


@dataclass(frozen=True)
class RiskBinDecision:
    """The edges, whether they moved, and why. A move is product-visible.

    "A named risk class that moves weekly is worse than one that is three points
    off", so an incumbent that still satisfies the rule is kept unchanged and
    ``changed`` is ``False``. When it does not, the re-derivation is recorded
    with the condition that forced it, because that is the sentence a product
    owner needs when the classes on the overview shift under them.
    """

    bins: RiskBins
    changed: bool
    reason: str
    incumbent: RiskBins | None
    check: RiskBinCheck

    def card_fields(self) -> dict[str, Any]:
        return {
            "risk_bins": self.bins.card_fields(),
            "risk_bins_changed": self.changed,
            "risk_bins_reason": self.reason,
            "risk_bins_incumbent": (
                self.incumbent.card_fields() if self.incumbent is not None else None
            ),
            "risk_bins_hour_counts": dict(
                zip(RISK_CLASSES, self.check.hour_counts, strict=True)
            ),
            "risk_bins_observed_frequency": dict(
                zip(RISK_CLASSES, self.check.observed, strict=True)
            ),
            "risk_bins_mean_predicted": dict(
                zip(RISK_CLASSES, self.check.mean_predicted, strict=True)
            ),
            "risk_bins_rule": (
                "(a) |mean predicted − observed| ≤ "
                f"{MAX_RISK_BIN_GAP} in every class; (b) adjacent classes' observed "
                "frequencies differ by more than the sum of their 95% binomial CI "
                f"half-widths; edges on a {RISK_EDGE_STEP} grid, most nearly equal "
                "in hour count"
            ),
        }


@dataclass(frozen=True)
class Calibration:
    """Everything the card's Calibration group holds, as one required field.

    One field and not three, for the reason
    :class:`~wattsteer_ml.training.bundle.HurdleBundle` is one dataclass and not
    six loose boosters: a calibrated probability with no measured curve behind it
    and no published edges is a claim nobody checked, and an optional field is a
    field a serving path can forget to check.
    """

    isotonic: IsotonicCalibrator
    reliability: ReliabilityCurve
    risk_bins: RiskBinDecision

    def card_fields(self) -> dict[str, Any]:
        return {
            **self.isotonic.card_fields(),
            **self.reliability.card_fields(),
            **self.risk_bins.card_fields(),
        }


@dataclass(frozen=True)
class SubsystemCalibration:
    """The pooled :class:`Calibration`, plus a per-subsystem isotonic map where
    the rows allow.

    **Why ``reliability`` and ``risk_bins`` stay pooled.** Both are properties
    of the *served* probability measured against the whole fleet's out-of-fold
    predictions, and nothing measured indicts them the way the occurrence
    map's own fitting population was measured to be dominated by NE — see the
    module docstring's Step 0. Splitting them would halve an already-thin
    out-of-fold pool for no measured gain, the same scoping decision that kept
    ``δ_hi`` marginal in
    :class:`~wattsteer_ml.training.conformal.SubsystemCorrections`.

    **Why some subsystems fall back.** A 90-day calibration window's rows per
    subsystem are bursty rather than scarce — some windows catch an episode of
    N/S curtailment, most do not — and :data:`MINIMUM_SUBSYSTEM_CALIBRATION_\
ROWS` and :data:`MINIMUM_SUBSYSTEM_CALIBRATION_POSITIVE_ROWS` are the floors a
    window has to clear before its own curve is trusted over the pooled one.
    Declining and falling back is the same discipline
    :class:`~wattsteer_ml.training.conformal.SubsystemCorrections` already
    applies one stage later; inventing a curve for a handful of rows would not
    be a calibration.
    """

    pooled: Calibration
    #: Only the subsystems whose rows cleared both floors. A subsystem absent
    #: here fell back to :attr:`pooled`'s isotonic map — see :attr:`declined`.
    per_subsystem: Mapping[Subsystem, SubsystemIsotonic]
    #: The subsystems :attr:`per_subsystem` does not carry, named rather than
    #: left for a reader to infer from a missing key.
    declined: tuple[Subsystem, ...]

    def __post_init__(self) -> None:
        covered = set(self.per_subsystem) | set(self.declined)
        if covered != set(SUBSYSTEM_CODES):
            raise CalibrationError(
                f"{covered} does not account for every subsystem in "
                f"{SUBSYSTEM_CODES}; a subsystem with no verdict at all would "
                "silently fall back to the pooled isotonic map with nothing on "
                "the card saying so"
            )
        if set(self.per_subsystem) & set(self.declined):
            raise CalibrationError("a subsystem cannot be both fitted and declined")

    def calibrate_for(self, subsystem: Subsystem) -> IsotonicCalibrator:
        """This subsystem's own map, or the pooled one if it declined."""
        fit = self.per_subsystem.get(subsystem)
        return (
            fit.isotonic
            if fit is not None and fit.isotonic is not None
            else (self.pooled.isotonic)
        )

    def card_fields(self) -> dict[str, Any]:
        return {
            **self.pooled.card_fields(),
            "subsystem_isotonic": {
                subsystem: fit.card_fields()
                for subsystem, fit in self.per_subsystem.items()
            },
            "subsystem_isotonic_declined": list(self.declined),
        }


def outside_calibration_window(
    pool: OutOfFoldPool, calibration_window: tuple[date, date] | None
) -> tuple[tuple[OutOfFoldPrediction, ...], int]:
    """The pooled rows the calibrator did not see, and how many were dropped.

    The one place the exclusion happens, so the curve and the risk-class edges
    are derived from exactly the same rows. Returning the count alongside is what
    lets the card say "the pool had some and they were removed" rather than
    leaving a reader to assume it had none.
    """
    kept: list[OutOfFoldPrediction] = []
    excluded = 0
    for prediction in pool.predictions:
        if calibration_window is not None and (
            calibration_window[0] <= prediction.key.target_date <= calibration_window[1]
        ):
            excluded += 1
            continue
        kept.append(prediction)
    if not kept:
        raise CalibrationError(
            "every pooled prediction falls inside the calibration window the "
            "calibrator was fitted on; a curve over those rows would be a "
            "self-portrait of the fit"
        )
    return tuple(kept), excluded


def calibrate(
    *,
    raw: Sequence[float],
    observed: Sequence[bool],
    pool: OutOfFoldPool,
    calibration_window: tuple[date, date],
    incumbent_risk_bins: RiskBins | None = None,
) -> Calibration:
    """Fit the map on the calibration window, measure it on the pool, publish edges.

    The three provenances of the module docstring, in one call, so that no caller
    can assemble a :class:`Calibration` whose curve and whose edges were derived
    from different rows: both come from
    :func:`outside_calibration_window` applied once to the same pool.

    ``raw`` and ``observed`` are the occurrence classifier's **uncalibrated**
    output on the calibration window's labelled rows and the labels beside them.
    The base learners are not refit afterwards; this is the whole of what the
    calibration window is used for after the fits.
    """
    curve = ReliabilityCurve.of(pool, calibration_window=calibration_window)
    kept, _ = outside_calibration_window(pool, calibration_window)
    return Calibration(
        isotonic=IsotonicCalibrator.fit(raw, observed),
        reliability=curve,
        risk_bins=derive_risk_bins(kept, incumbent=incumbent_risk_bins),
    )


def calibrate_by_subsystem(
    raw: Sequence[float],
    observed: Sequence[bool],
    keys: Sequence[RowKey],
    *,
    pool: OutOfFoldPool,
    calibration_window: tuple[date, date],
    incumbent_risk_bins: RiskBins | None = None,
    minimum_rows: int = MINIMUM_SUBSYSTEM_CALIBRATION_ROWS,
    minimum_positive_rows: int = MINIMUM_SUBSYSTEM_CALIBRATION_POSITIVE_ROWS,
) -> SubsystemCalibration:
    """The pooled :func:`calibrate`, plus a per-subsystem isotonic map where
    the rows allow.

    Fits the pooled :class:`Calibration` exactly as :func:`calibrate` does —
    ``reliability`` and ``risk_bins`` are untouched by this function — and then
    refits :meth:`IsotonicCalibrator.fit` once per subsystem, on that
    subsystem's own slice of ``raw``/``observed``, declining below
    ``minimum_rows`` total or ``minimum_positive_rows`` curtailed. Each
    subsystem's own fit sees only its own rows and nothing conditions
    :meth:`IsotonicCalibrator.fit` itself, which never takes a key — see the
    module docstring and ``tests.test_isotonic_calibration``'s structural
    guard. The split happens here, one level up, exactly as
    :func:`~wattsteer_ml.training.conformal.conformalise_by_subsystem` splits
    ``δ_lo`` one level above :meth:`~wattsteer_ml.training.conformal.\
ConformalCorrection.fit`.
    """
    if len(raw) != len(observed) or len(raw) != len(keys):
        raise CalibrationError(
            f"{len(raw)} raw scores, {len(observed)} labels and {len(keys)} "
            "keys are not one set of rows"
        )
    pooled = calibrate(
        raw=raw,
        observed=observed,
        pool=pool,
        calibration_window=calibration_window,
        incumbent_risk_bins=incumbent_risk_bins,
    )
    per_subsystem: dict[Subsystem, SubsystemIsotonic] = {}
    declined: list[Subsystem] = []
    for subsystem in SUBSYSTEM_CODES:
        indices = [index for index, key in enumerate(keys) if key.subsystem == subsystem]
        subset_raw = [raw[index] for index in indices]
        subset_observed = [observed[index] for index in indices]
        rows = len(subset_raw)
        positive_rows = sum(1 for value in subset_observed if value)
        fitted = rows >= minimum_rows and positive_rows >= minimum_positive_rows
        fit = SubsystemIsotonic(
            subsystem=subsystem,
            rows=rows,
            positive_rows=positive_rows,
            isotonic=(
                IsotonicCalibrator.fit(subset_raw, subset_observed) if fitted else None
            ),
            fitted=fitted,
        )
        if fitted:
            per_subsystem[subsystem] = fit
        else:
            declined.append(subsystem)
    return SubsystemCalibration(
        pooled=pooled, per_subsystem=per_subsystem, declined=tuple(declined)
    )


def derive_risk_bins(
    predictions: Sequence[OutOfFoldPrediction],
    *,
    incumbent: RiskBins | None = None,
) -> RiskBinDecision:
    """The spec's rule, run over a pool, with the incumbent held unless it breaks.

    > Choose edges from the calibrated reliability curve such that (a) within
    > each bin ``|mean predicted − observed frequency| ≤ 0.05``, and (b) adjacent
    > bins' observed frequencies differ by more than the sum of their 95%
    > binomial CI half-widths. Among the candidate edge sets satisfying both,
    > take the one whose bins are most nearly equal in hour count.

    The incumbent is checked first and against the same two conditions, so
    "held stable" and "derived by the rule" are the same code path evaluated on
    different candidates rather than two rules that could drift apart.
    """
    if not predictions:
        raise CalibrationError("no pooled predictions to derive risk classes from")
    held = _check(predictions, incumbent) if incumbent is not None else None
    if incumbent is not None and held is not None and held.satisfied:
        return RiskBinDecision(
            bins=incumbent,
            changed=False,
            reason=(
                "the incumbent edges still satisfy (a) and (b) on this pool; a "
                "named class that moves weekly is worse than one three points off"
            ),
            incumbent=incumbent,
            check=held,
        )
    candidates = [
        _check(predictions, RiskBins.from_edges(first, second))
        for first, second in _candidate_edges()
    ]
    satisfying = [candidate for candidate in candidates if candidate.satisfied]
    if not satisfying:
        nearest = min(candidates, key=lambda candidate: candidate.worst_gap)
        raise RiskBinsUndeterminedError(
            "no split of this pool on the "
            f"{RISK_EDGE_STEP} grid satisfies both (a) and (b); the closest, "
            f"{nearest.bins.edges}, fails because {nearest.reason}. Edges nobody "
            "measured are not an acceptable fallback: `nothing_to_explain` "
            "withholds narration below the lowest edge and the overview renders "
            "the classes."
        )
    best = min(
        satisfying,
        key=lambda candidate: (candidate.imbalance, candidate.bins.edges),
    )
    if incumbent is not None and incumbent.edges == best.bins.edges:
        return RiskBinDecision(
            bins=best.bins,
            changed=False,
            reason="the rule re-derived the incumbent edges unchanged",
            incumbent=incumbent,
            check=best,
        )
    broke = held
    reason = (
        f"first derivation: {len(satisfying)} of {len(candidates)} candidate splits "
        "satisfy (a) and (b), and these are the most nearly equal in hour count"
        if broke is None
        else (
            f"the incumbent edges {incumbent.edges if incumbent else ()} no longer "
            f"satisfy the rule — {broke.reason} — so the edges move, which is a "
            "product-visible event"
        )
    )
    return RiskBinDecision(
        bins=best.bins,
        changed=incumbent is not None,
        reason=reason,
        incumbent=incumbent,
        check=best,
    )


def wilson_half_width(successes: int, trials: int) -> float:
    """Half-width of the 95% Wilson interval for a binomial proportion.

    Wilson and not Wald. The Wald half-width is ``z·sqrt(f(1−f)/n)``, which is
    **exactly zero** when a bin saw no events or nothing but events — and
    condition (b) asks whether two bins are far enough apart *relative to their
    uncertainty*, so a zero there would declare two classes distinguishable on
    the strength of no evidence at all. That is the failure mode (b) exists to
    prevent, so the interval used is the one that stays wide where the data is
    one-sided.
    """
    if trials <= 0:
        raise CalibrationError("a binomial interval needs at least one trial")
    if not 0 <= successes <= trials:
        raise CalibrationError(f"{successes} successes in {trials} trials")
    z2 = Z_95 * Z_95
    denominator = trials + z2
    inner = successes * (trials - successes) / trials + z2 / 4.0
    return (Z_95 / denominator) * math.sqrt(inner)


def _candidate_edges() -> list[tuple[float, float]]:
    """Every ``(e1, e2)`` on the 5-point grid with a non-empty class each side."""
    steps = round(1.0 / RISK_EDGE_STEP)
    grid = [round(index * RISK_EDGE_STEP, 10) for index in range(1, steps)]
    return [(first, second) for first in grid for second in grid if first < second]


def _check(predictions: Sequence[OutOfFoldPrediction], bins: RiskBins) -> RiskBinCheck:
    """(a) and (b), evaluated on one candidate split of one pool."""
    buckets: dict[str, list[OutOfFoldPrediction]] = {name: [] for name in RISK_CLASSES}
    for prediction in predictions:
        buckets[bins.classify(prediction.probability)].append(prediction)
    counts = tuple(len(buckets[name]) for name in RISK_CLASSES)
    if any(count == 0 for count in counts):
        empty = [name for name in RISK_CLASSES if not buckets[name]]
        return RiskBinCheck(
            bins=bins,
            hour_counts=(counts[0], counts[1], counts[2]),
            mean_predicted=(0.0, 0.0, 0.0),
            observed=(0.0, 0.0, 0.0),
            worst_gap=1.0,
            satisfies_a=False,
            satisfies_b=False,
            reason=f"{', '.join(empty)} contains no hour of the pool",
        )
    predicted = tuple(
        sum(one.probability for one in buckets[name]) / len(buckets[name])
        for name in RISK_CLASSES
    )
    successes = tuple(
        sum(1 for one in buckets[name] if one.observed) for name in RISK_CLASSES
    )
    observed = tuple(
        successes[index] / counts[index] for index in range(len(RISK_CLASSES))
    )
    half_widths = tuple(
        wilson_half_width(successes[index], counts[index])
        for index in range(len(RISK_CLASSES))
    )
    gaps = tuple(abs(predicted[index] - observed[index]) for index in range(3))
    worst = max(gaps)
    satisfies_a = worst <= MAX_RISK_BIN_GAP
    failures: list[str] = []
    if not satisfies_a:
        worst_class = RISK_CLASSES[gaps.index(worst)]
        failures.append(
            f"(a) {worst_class} predicts {predicted[gaps.index(worst)]:.3f} against "
            f"an observed {observed[gaps.index(worst)]:.3f}, a gap of {worst:.3f} "
            f"above {MAX_RISK_BIN_GAP}"
        )
    satisfies_b = True
    for index in range(len(RISK_CLASSES) - 1):
        separation = abs(observed[index + 1] - observed[index])
        needed = half_widths[index] + half_widths[index + 1]
        if separation <= needed:
            satisfies_b = False
            failures.append(
                f"(b) {RISK_CLASSES[index]} and {RISK_CLASSES[index + 1]} observe "
                f"{observed[index]:.3f} and {observed[index + 1]:.3f}, "
                f"{separation:.3f} apart against a combined 95% half-width of "
                f"{needed:.3f}"
            )
    return RiskBinCheck(
        bins=bins,
        hour_counts=(counts[0], counts[1], counts[2]),
        mean_predicted=(predicted[0], predicted[1], predicted[2]),
        observed=(observed[0], observed[1], observed[2]),
        worst_gap=worst,
        satisfies_a=satisfies_a,
        satisfies_b=satisfies_b,
        reason="; ".join(failures) if failures else "(a) and (b) both hold",
    )


@dataclass
class _Accumulator:
    """A bin under construction. Mutable on purpose; nothing outside sees it."""

    lower: float
    upper: float
    hours: int
    predicted: float
    successes: int
    merged: bool


def _accumulate(predictions: Sequence[OutOfFoldPrediction]) -> list[_Accumulator]:
    """Ten equal-width bins, then merge every one below the floor."""
    width = 1.0 / RELIABILITY_BINS
    bins = [
        _Accumulator(
            lower=round(index * width, 10),
            upper=round((index + 1) * width, 10),
            hours=0,
            predicted=0.0,
            successes=0,
            merged=False,
        )
        for index in range(RELIABILITY_BINS)
    ]
    for prediction in predictions:
        index = min(int(prediction.probability * RELIABILITY_BINS), RELIABILITY_BINS - 1)
        bin_ = bins[index]
        bin_.hours += 1
        bin_.predicted += prediction.probability
        bin_.successes += 1 if prediction.observed else 0
    return bins


def _merged(
    predictions: Sequence[OutOfFoldPrediction],
) -> tuple[list[_Accumulator], list[BinMerge]]:
    bins = _accumulate(predictions)
    merges: list[BinMerge] = []
    index = 0
    while index < len(bins) and len(bins) > 1:
        if bins[index].hours >= MIN_BIN_HOURS:
            index += 1
            continue
        if index + 1 < len(bins):
            short, into = bins[index], bins[index + 1]
            merges.append(_merge_record(short, into, "up"))
            bins[index : index + 2] = [_combine(short, into)]
        else:
            short, into = bins[index], bins[index - 1]
            merges.append(_merge_record(short, into, "down"))
            bins[index - 1 : index + 1] = [_combine(into, short)]
            index -= 1
    return bins, merges


def _reported(one: _Accumulator) -> ReliabilityBin:
    return ReliabilityBin(
        lower=one.lower,
        upper=one.upper,
        mean_predicted=one.predicted / one.hours,
        observed_frequency=one.successes / one.hours,
        hour_count=one.hours,
        merged=one.merged,
    )


def _merge_record(
    short: _Accumulator, into: _Accumulator, direction: MergeDirection
) -> BinMerge:
    return BinMerge(
        lower=short.lower,
        upper=short.upper,
        into_lower=into.lower,
        into_upper=into.upper,
        direction=direction,
        hour_count=short.hours,
    )


def _combine(lower: _Accumulator, upper: _Accumulator) -> _Accumulator:
    return _Accumulator(
        lower=lower.lower,
        upper=upper.upper,
        hours=lower.hours + upper.hours,
        predicted=lower.predicted + upper.predicted,
        successes=lower.successes + upper.successes,
        merged=True,
    )
