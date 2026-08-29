"""Day totals and peak power, from a path ensemble that nothing sums.

`docs/specs/forecaster.md`, "Day grain — one path ensemble, no addition".
Quantiles do not add, so the day-grain figures the screens need — day energy,
peak power and the day-level occurrence probability — are **not derivable from
the 24 hour-wise bands by any arithmetic**. They are quantiles of 500
temporally coherent draws::

    1. On the calibration window, for every day d and hour t, the randomised
       PIT of the composed predictive CDF:
           u_{d,t} = F_Y(y_{d,t})                  if y_{d,t} > τ
           u_{d,t} ~ Uniform(0, 1 − p_{d,t})       if y_{d,t} ≤ τ
    2. Store the matrix U in the bundle.
    3. At serve time draw 500 whole *rows* of U with replacement and map each
       through tomorrow's marginals: y*_{k,t} = Q_Y(u_{k,t} | x_t)
    4. Day total  = quantiles of Σ_t y*_{k,t}
       Peak power = quantiles of max_t y*_{k,t}
       Day P(occurrence) = share of draws with at least one hour above τ

**Whole rows are the mechanism, not an optimisation.** Curtailment is
autocorrelated within a day by construction — it is an oversupply condition
that lasts hours — and independent hourly draws would produce day totals with
roughly ``1/√24`` of the true spread: a narrower band arrived at by a more
sophisticated route. :class:`DrawPlan` therefore holds *row* indices and never
a cell index, and :meth:`PathEnsemble.draw` indexes ``U`` by a draw and by
nothing else.

**The matrix is one row per calibration day and 96 columns, not 24.** The spec
writes ``U (n_days × 24)`` and that is exactly the per-subsystem slice
:meth:`PitMatrix.day_columns` returns. The stored object carries the same day
across all four subsystems — ``(subsystem, local_hour)`` in
:data:`PIT_COLUMN_KEYS` order — because that is what makes the hand-back to
forecaster ticket 08 real rather than aspirational: sharing the drawn row index
``k`` across the four subsystems preserves cross-subsystem dependence by the
same argument that sharing it across hours preserves intra-day dependence, and
a per-subsystem matrix could not do it at all. ``packages/core``'s
``GridOutlook`` says ``national.band`` is null "until the path ensemble shares
its draw index across subsystems"; :func:`day_grain_rows` draws **one**
:class:`DrawPlan` and hands the same one to every subsystem of every day, so
the national day-total quantiles are already a property of these 500 draws —
no copula, no second model, no new parameter. **Composing the national figure
is ticket 08's**; this module builds and guarantees the shared index, and
stops there.

**A row is drawable only if all 96 cells are there.** An hour ONS has not
settled has no label, a label is what a PIT needs, and nothing here imputes
one. So a calibration day missing a single subsystem-hour is dropped whole —
:attr:`PitMatrix.dropped_days` counts them and the card publishes the count —
because a row with a hole in it is not a coherent day, and patching the hole
is the independence assumption this whole construction exists to avoid.

**The randomised PIT is two branches, and both are the spec's.** For a
distribution with atoms the PIT is uniform only if it is randomised across the
jump. Above ``τ`` :func:`randomised_pit` reads the jump off the mixture itself,
by bisecting :meth:`~wattsteer_ml.mixture.HurdleMixture.quantile` — the object
the served band was composed from, which is why ticket 01 defined it at any
``q``, and which is why there is no second CDF here to disagree with the one
the band came from. At or below ``τ`` it draws ``u ~ Uniform(0, 1 − p)``
directly. That second branch is **not** a special case of the first and the
attempt to make it one is a real trap: ``F_sub`` is supported on ``[0, τ]``
while the quantile function represents the whole sub-threshold mass as a point
at zero, so a bracket read off it collapses to the single value ``1 − p`` for
every quiet hour with a small non-zero label, and the column becomes a spike at
``1 − p`` — precisely the failure the randomisation exists to prevent, arriving
by way of an elegance.

**What the flat-held upper tail costs, stated rather than hidden.** ``Q_pos``
is held flat above its 0.90 knot (`mixture.py` says why: a line drawn past the
outermost fitted alpha is an invented tail), so the mixture's CDF reaches 1 at
a finite ceiling. An observation above that ceiling is indistinguishable, to
the model, from one sitting on it: :func:`randomised_pit` clamps such an
observation to the ceiling and spreads its ``u`` over the ceiling's own jump.
That is the correct treatment of an atom, and it is **also** where forecaster
ticket 21's under-corrected upper tail becomes visible — if the ceiling is too
low, too many observations land on it, ``u`` piles up near 1, and
:meth:`PitMatrix.max_ks_statistic` sees a column that is not uniform. The KS
check is therefore the detector for that limitation rather than a formality.
What it cannot do is repair it: step 3 maps ``u`` back through the same ``Q_Y``
whose ceiling is too low, so a day total — a sum over 24 such hours — inherits
the shortfall in its upper quantiles, and :class:`DayGrainCoverage` is where
that shows up as a number.

**No copula is fitted, so no copula parameter is invented,** and day-level
occurrence is emphatically not ``1 − Π(1 − p_t)``: that assumes independence
across hours and overstates day-level risk badly.
:meth:`PathEnsemble.day_occurrence_probability` counts draws instead.

**The ensemble's marginals are the marginals**, by construction: hour ``t``'s
draws are ``Q_Y(· | x_t)`` evaluated at a sample of column ``t``, so the hour
band and the day band cannot disagree about hour 14.
:meth:`PathEnsemble.hour_band` is that claim, as a thing a test can measure.

**The floor is still an hour-wise statement.** This module makes a day-level
confidence statement *computable*; ``recovered_floor_mwh`` remains simulated
against the hour-wise P10 envelope, which is not a member of the ensemble and
is not a realisable day. Nothing here changes that, and the optimizer is not a
caller.
"""

from __future__ import annotations

import math
import random
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.mixture import SERVED_QUANTILES, HurdleMixture, QuantileBand

#: ``K`` — the ensemble's size. `docs/specs/forecaster.md` names 500, and the
#: number is published rather than searched for: it is what the Monte-Carlo
#: error of a served day band is quoted against, so changing it changes the
#: meaning of every day-grain figure and of ``day_total_coverage``.
ENSEMBLE_DRAWS = 500

#: The draw seed. A constant rather than a clock read, so two calls about the
#: same day return the same day band and Replay reproduces what was served.
#: :class:`DrawPlan` takes it as an argument; this is only the default.
ENSEMBLE_SEED = 20_260_829

#: The fewest complete calibration days a matrix may be built from. Below it the
#: 0.90 quantile of the day total rests on fewer than three distinct days, and
#: the bootstrap is reporting a histogram of a handful of days as a
#: distribution. A short window is a statement about the window, not a bar to
#: lower.
MIN_ENSEMBLE_DAYS = 30

#: The columns of ``U``, in order: every subsystem's every local hour. The
#: spec's ``n_days × 24`` is :meth:`PitMatrix.day_columns`, one subsystem's
#: slice of this.
PIT_COLUMN_KEYS: tuple[tuple[Subsystem, int], ...] = tuple(
    (code, hour) for code in SUBSYSTEM_CODES for hour in range(HOURS_PER_DAY)
)

#: ``4 × 24``. A row of ``U`` is a whole day of the whole grid.
PIT_COLUMNS = len(PIT_COLUMN_KEYS)

#: The two-sided Kolmogorov–Smirnov critical value at 95% for **one** column, as
#: the coefficient of ``1/√n``. The familiar 1.36, kept as the reference point a
#: reader recognises; :attr:`PitMatrix.ks_tolerance` does not use it, because a
#: matrix is 96 columns and a per-column 95% band is exceeded by about five of
#: them in a perfectly uniform matrix.
KS_CRITICAL_95 = 1.36

#: The family-wise level :attr:`PitMatrix.ks_tolerance` is set at: the
#: probability that *any* of the 96 columns of a genuinely uniform ``U`` is
#: flagged. Testing every column at 95% each would make a passing matrix fail
#: routinely, and a check that fails routinely is a check that gets deleted.
KS_FAMILYWISE_LEVEL = 0.05

#: How close the bisection gets to the true bracket of the PIT. A probability,
#: so a trillionth is far below anything 500 draws could resolve.
_BRACKET_TOLERANCE = 1e-12


class EnsembleError(ValueError):
    """A day-grain figure that cannot be drawn from these inputs."""


def pit_column(subsystem: Subsystem, local_hour: int) -> int:
    """Which column of ``U`` a ``(subsystem, local_hour)`` is.

    The one place the layout is spelt, so the fit and the draw cannot disagree
    about which column hour 14 of ``SE`` lives in.
    """
    if subsystem not in SUBSYSTEM_CODES:
        raise EnsembleError(f"{subsystem!r} is not one of {SUBSYSTEM_CODES!r}")
    if not 0 <= local_hour < HOURS_PER_DAY:
        raise EnsembleError(
            f"local hour {local_hour!r} is outside the {HOURS_PER_DAY}-hour day"
        )
    return SUBSYSTEM_CODES.index(subsystem) * HOURS_PER_DAY + local_hour


def ks_uniform_statistic(values: Sequence[float]) -> float:
    """``D_n`` — the two-sided KS distance between ``values`` and ``U(0, 1)``.

    Written out rather than imported: scipy is not a runtime dependency of this
    service, and the statistic is four lines a reader can check against the
    definition the acceptance criterion names.
    """
    if not values:
        raise EnsembleError("the KS distance of an empty column is not a number")
    ordered = sorted(values)
    count = len(ordered)
    return max(
        max((index + 1) / count - value, value - index / count)
        for index, value in enumerate(ordered)
    )


def ks_critical(level: float, tests: int = 1) -> float:
    """``√(−½ ln(level / 2 tests))`` — the KS coefficient at a family-wise level.

    The asymptotic two-sided critical value, Bonferroni-corrected for ``tests``
    columns. At ``level = 0.05`` and one test it returns 1.358, which is the
    1.36 every table prints; at 96 tests it returns about 2.03, which is the
    number a 96-column matrix has to be held to if "every column is uniform" is
    to mean anything.
    """
    if not math.isfinite(level) or not 0.0 < level < 1.0:
        raise EnsembleError(f"{level!r} is not a significance level")
    if tests < 1:
        raise EnsembleError(f"{tests} tests is not a family")
    return math.sqrt(-0.5 * math.log(level / (2.0 * tests)))


def ks_uniform_tolerance(rows: int, critical: float = KS_CRITICAL_95) -> float:
    """``c(α)/√n`` — how far from uniform a column of ``n`` may drift by chance.

    The asymptotic two-sided band, which is the right tolerance for a column
    that is a sample. It is deliberately not tightened: a tolerance a
    well-calibrated model fails is a test that will be silenced.
    """
    if rows <= 0:
        raise EnsembleError(f"{rows} rows cannot carry a KS statement")
    return critical / math.sqrt(rows)


def ensemble_quantile(values: Sequence[float], q: float) -> float:
    """The ``⌈q·K⌉``-th smallest — the inverse ECDF, with no interpolation.

    Every published day-grain number is therefore **a value some draw actually
    took**: a realisable day total, not a point between two of them. The same
    order-statistic convention
    :func:`~wattsteer_ml.training.conformal.conformal_rank` uses, for the same
    reason — a rank can be checked against the sample it came from, and an
    interpolation rule is one more thing two readers can disagree about.
    """
    if not values:
        raise EnsembleError("the quantile of an empty ensemble is not a number")
    if not math.isfinite(q) or not 0.0 <= q <= 1.0:
        raise EnsembleError(f"q must be a probability in [0, 1], got {q!r}")
    ordered = sorted(values)
    rank = max(1, min(len(ordered), math.ceil(q * len(ordered))))
    return ordered[rank - 1]


def _band(values: Sequence[float]) -> QuantileBand:
    """The three served quantiles of one ensemble statistic, as ticket 01's band.

    :class:`~wattsteer_ml.mixture.QuantileBand` and not a day-grain band of its
    own: "P10 ≤ P50 ≤ P90 or it does not exist" is the same invariant at both
    grains, and a second type would be a second place to forget it.
    """
    return QuantileBand.sorted_from(
        [ensemble_quantile(values, q) for q in SERVED_QUANTILES]
    )


@dataclass(frozen=True)
class DrawPlan:
    """Which rows of ``U`` the 500 draws are, and the seed that chose them.

    **The unit of sharing.** One plan handed to four subsystems is what makes
    draw ``k`` the same calibration day for all of them, which is the whole of
    the cross-subsystem dependence forecaster ticket 08 needs. The indices are
    row indices and there is no field here that could name an hour or a
    subsystem, so a caller cannot accidentally draw a different day per
    subsystem, or a different day per hour.
    """

    #: ``K`` row indices into ``U``, with replacement. The order is meaningful:
    #: index ``k`` is draw ``k``, and two ensembles built from one plan are
    #: aligned draw by draw.
    indices: tuple[int, ...]
    #: The seed that produced them, carried so a served day band can be redrawn.
    seed: int
    #: ``U``'s row count at the time of the draw. A plan cannot be applied to a
    #: matrix of a different height, so a bundle swapped under a live plan fails
    #: loudly rather than silently reindexing into another window's days.
    rows: int

    def __post_init__(self) -> None:
        if self.rows <= 0:
            raise EnsembleError("a draw plan over no calibration day is not a plan")
        if not self.indices:
            raise EnsembleError("a draw plan with no draw is not a plan")
        for index in self.indices:
            if not 0 <= index < self.rows:
                raise EnsembleError(
                    f"draw index {index} is outside the {self.rows} rows of U"
                )

    @property
    def draws(self) -> int:
        return len(self.indices)

    @classmethod
    def seeded(
        cls, *, rows: int, seed: int = ENSEMBLE_SEED, draws: int = ENSEMBLE_DRAWS
    ) -> DrawPlan:
        """``draws`` whole-row indices, with replacement, from one seed."""
        if rows <= 0:
            raise EnsembleError("a draw plan over no calibration day is not a plan")
        if draws <= 0:
            raise EnsembleError(f"{draws} draws cannot carry a day band")
        rng = random.Random(seed)  # noqa: S311 — a reproducible resample, not a secret
        return cls(
            indices=tuple(rng.randrange(rows) for _ in range(draws)),
            seed=seed,
            rows=rows,
        )


@dataclass(frozen=True)
class PitMatrix:
    """``U`` — one row per complete calibration day, ninety-six columns.

    Every value is a randomised PIT of the *composed and corrected* predictive
    CDF, so the matrix is a property of the band the product ships rather than
    of any one booster. It is stored in the bundle because the draw happens at
    serve time, long after the window it describes has passed.
    """

    #: The calibration days that survived the completeness rule, ascending. One
    #: per row of :attr:`values`, so a row index is a day a reader can name.
    days: tuple[date, ...]
    #: ``n_days × 96``, in :data:`PIT_COLUMN_KEYS` order, each in ``[0, 1]``.
    values: tuple[tuple[float, ...], ...]
    window_start: date
    window_end: date
    #: Calibration days dropped for holding an unsettled subsystem-hour.
    #: Published: a matrix built from a third of its window has a third of the
    #: window's dependence structure in it, and a reader must be able to see
    #: that without re-running the fit.
    dropped_days: int
    #: The seed the randomisation used. The PIT of a sub-threshold hour is a
    #: draw, so ``U`` is only reproducible with it.
    seed: int

    def __post_init__(self) -> None:
        if len(self.days) != len(self.values):
            raise EnsembleError(
                f"{len(self.days)} days against {len(self.values)} rows of U"
            )
        if len(self.values) < MIN_ENSEMBLE_DAYS:
            raise EnsembleError(
                f"{len(self.values)} complete days in "
                f"{self.window_start.isoformat()}–{self.window_end.isoformat()} "
                "cannot support a day band; the bootstrap needs at least "
                f"{MIN_ENSEMBLE_DAYS} so its 0.90 quantile rests on more than one "
                "day. A wider window is the answer, not a lower bar"
            )
        if self.dropped_days < 0:
            raise EnsembleError(f"{self.dropped_days} dropped days is not a count")
        if sorted(self.days) != list(self.days) or len(set(self.days)) != len(self.days):
            raise EnsembleError("the rows of U are one day each, in ascending order")
        for day, row in zip(self.days, self.values, strict=True):
            if len(row) != PIT_COLUMNS:
                raise EnsembleError(
                    f"{day.isoformat()} has {len(row)} of the {PIT_COLUMNS} "
                    "subsystem-hours a whole day has; a row with a hole in it is "
                    "not a coherent day"
                )
            for value in row:
                if not math.isfinite(value) or not 0.0 <= value <= 1.0:
                    raise EnsembleError(
                        f"{day.isoformat()} carries a PIT of {value!r}; a PIT is a "
                        "probability"
                    )
        if self.window_start > self.window_end:
            raise EnsembleError(
                f"empty calibration window {self.window_start.isoformat()} to "
                f"{self.window_end.isoformat()}"
            )

    @property
    def rows(self) -> int:
        return len(self.values)

    def column(self, subsystem: Subsystem, local_hour: int) -> tuple[float, ...]:
        """One ``(subsystem, local_hour)`` column of ``U``, over the days."""
        index = pit_column(subsystem, local_hour)
        return tuple(row[index] for row in self.values)

    def day_columns(self, subsystem: Subsystem) -> tuple[tuple[float, ...], ...]:
        """The spec's ``U (n_days × 24)`` — one subsystem's slice, rows intact.

        A slice and never a re-assembly: row ``k`` here is row ``k`` there, so
        two subsystems sliced out of one matrix and drawn under one
        :class:`DrawPlan` are drawing the same calendar days as each other.
        """
        if subsystem not in SUBSYSTEM_CODES:
            raise EnsembleError(f"{subsystem!r} is not one of {SUBSYSTEM_CODES!r}")
        start = SUBSYSTEM_CODES.index(subsystem) * HOURS_PER_DAY
        return tuple(row[start : start + HOURS_PER_DAY] for row in self.values)

    def ks_statistic(self, subsystem: Subsystem, local_hour: int) -> float:
        """How far one column is from uniform. Ticket 07's calibration check."""
        return ks_uniform_statistic(self.column(subsystem, local_hour))

    def max_ks_statistic(self) -> float:
        """The worst column's KS distance — the number the card publishes."""
        return max(
            self.ks_statistic(subsystem, hour) for subsystem, hour in PIT_COLUMN_KEYS
        )

    @property
    def ks_tolerance(self) -> float:
        """The family-wise KS band at this matrix's height, over its 96 columns.

        Family-wise and not per-column: :meth:`uniform_within_tolerance` asks
        whether the *worst* of 96 columns is further from uniform than chance
        explains, and about five columns of a perfectly uniform matrix clear a
        per-column 95% band. A check that a good matrix fails one time in two is
        a check somebody deletes.
        """
        return ks_uniform_tolerance(
            self.rows, ks_critical(KS_FAMILYWISE_LEVEL, PIT_COLUMNS)
        )

    @property
    def uniform_within_tolerance(self) -> bool:
        """Whether every column is uniform within the KS band. Reported only.

        A false here means the **marginals** are miscalibrated — the composed
        CDF is not the distribution the labels came from — and every day-grain
        number drawn from this matrix is meaningless. It is a fact the card
        carries; refusing on it belongs to the hot-swap gate, which is
        forecaster ticket 13's and is not here.
        """
        return self.max_ks_statistic() <= self.ks_tolerance

    def card_fields(self) -> dict[str, Any]:
        return {
            "pit_rows": self.rows,
            "pit_columns": PIT_COLUMNS,
            "pit_dropped_days": self.dropped_days,
            "pit_seed": self.seed,
            "pit_window": {
                "start": self.window_start.isoformat(),
                "end": self.window_end.isoformat(),
            },
            "pit_max_ks": self.max_ks_statistic(),
            "pit_ks_tolerance": self.ks_tolerance,
            "pit_ks_level": KS_FAMILYWISE_LEVEL,
            "pit_ks_note": (
                "the largest per-column two-sided KS distance from U(0, 1), "
                "against a band corrected for the 96 columns it is the maximum "
                "of. Above it, the marginals are miscalibrated and every "
                "day-grain number drawn from this matrix is meaningless"
            ),
            "pit_uniform_within_tolerance": self.uniform_within_tolerance,
            "pit_dropped_days_rule": (
                "a calibration day missing any of the 96 subsystem-hours is "
                "dropped whole; nothing is imputed, because a row with a hole in "
                "it is not a coherent day"
            ),
            "ensemble_draws": ENSEMBLE_DRAWS,
            "ensemble_note": (
                "day-grain figures are quantiles of whole-row draws of U. Nothing "
                "sums a band, and the drawn row index is shared across the four "
                "subsystems, so a national day total is a property of these same "
                "draws rather than of a copula"
            ),
        }


@dataclass(frozen=True)
class PathEnsemble:
    """``K`` temporally coherent day paths for one subsystem, in MWh.

    The object every day-grain number is read off, and the object
    `flex-optimizer.md` names as the precondition for scenario-based dispatch:
    the paths exist internally from day one, and serialising them across the API
    is a stated v1 non-goal rather than a modelling gap.
    """

    #: ``K × 24`` MWh. Row ``k`` is one drawn calibration day mapped through
    #: tomorrow's marginals — a realisable day, not an envelope.
    paths: tuple[tuple[float, ...], ...]
    #: ``τ`` in MWh — what "at least one hour above τ" is counted against.
    threshold_mwh: float
    #: The plan the rows came from, carried so that two subsystems' ensembles
    #: can be *shown* to be aligned draw by draw rather than assumed to be.
    plan: DrawPlan

    def __post_init__(self) -> None:
        if len(self.paths) != self.plan.draws:
            raise EnsembleError(
                f"{len(self.paths)} paths against a plan of {self.plan.draws} draws"
            )
        for path in self.paths:
            if len(path) != HOURS_PER_DAY:
                raise EnsembleError(
                    f"a path is {len(path)} hours, not the {HOURS_PER_DAY} of a day"
                )

    @classmethod
    def draw(
        cls,
        *,
        mixtures: Sequence[HurdleMixture],
        matrix: PitMatrix,
        subsystem: Subsystem,
        plan: DrawPlan,
    ) -> PathEnsemble:
        """Map ``K`` whole rows of ``U`` through one day's twenty-four marginals.

        ``mixtures`` are tomorrow's hours in local order, and they are the very
        :class:`~wattsteer_ml.mixture.HurdleMixture` objects the served hour
        band was composed from — not a re-derivation of them. That is what makes
        "the ensemble's marginals *are* the marginals" true by construction
        rather than within a tolerance.

        Whole rows: the comprehension below indexes ``columns`` by a *draw* and
        the inner loop only walks the hours of the row that draw selected, so
        there is no edit that makes the resample hour-wise without rewriting it.
        """
        if len(mixtures) != HOURS_PER_DAY:
            raise EnsembleError(
                f"{len(mixtures)} marginals cannot make a {HOURS_PER_DAY}-hour day"
            )
        if plan.rows != matrix.rows:
            raise EnsembleError(
                f"the plan was drawn over {plan.rows} rows and U has {matrix.rows}; "
                "a plan and a matrix that disagree about the calibration window "
                "are not one ensemble"
            )
        thresholds = {mixture.threshold_mwh for mixture in mixtures}
        if len(thresholds) != 1:
            raise EnsembleError(
                f"the day's hours carry {len(thresholds)} thresholds; a magnitude "
                "and the threshold that produced it travel together"
            )
        columns = matrix.day_columns(subsystem)
        return cls(
            paths=tuple(
                tuple(
                    mixture.quantile(row[hour]) for hour, mixture in enumerate(mixtures)
                )
                for row in (columns[index] for index in plan.indices)
            ),
            threshold_mwh=thresholds.pop(),
            plan=plan,
        )

    @property
    def day_totals(self) -> tuple[float, ...]:
        """``Σ_t y*_{k,t}`` per draw. A sum of *draws*, never of quantiles."""
        return tuple(math.fsum(path) for path in self.paths)

    @property
    def peaks(self) -> tuple[float, ...]:
        """``max_t y*_{k,t}`` per draw, in MW — MWh over one hour."""
        return tuple(max(path) for path in self.paths)

    def day_total(self) -> QuantileBand:
        """The day-energy band.

        Strictly inside ``[Σ_t P10_t, Σ_t P90_t]`` unless the hours are
        perfectly rank-dependent, which no real calibration window is: the sum
        of the hourly P90s is the total of a day on which every hour
        simultaneously landed at its own ninetieth percentile, and that day is
        far rarer than one in ten.
        """
        return _band(self.day_totals)

    def peak_power(self) -> QuantileBand:
        """The peak-power band, in MW."""
        return _band(self.peaks)

    def day_occurrence_probability(self) -> float:
        """The share of draws with at least one hour above ``τ``.

        **Not** ``1 − Π(1 − p_t)``: that formula assumes the hours are
        independent and overstates day-level risk badly. This counts days.
        """
        above = sum(
            1 for path in self.paths if any(hour > self.threshold_mwh for hour in path)
        )
        return above / len(self.paths)

    def hour_band(self, local_hour: int) -> QuantileBand:
        """The ensemble's own marginal band for one hour.

        Never served — the served hour band is ticket 01's composition, and a
        second route to one is the thing that ticket bought. This exists so that
        "the ensemble's marginals are the marginals" is a measurable claim:
        within Monte-Carlo error at ``K`` draws it equals the composed band for
        the same hour.
        """
        if not 0 <= local_hour < HOURS_PER_DAY:
            raise EnsembleError(f"local hour {local_hour!r} is outside the day")
        return _band([path[local_hour] for path in self.paths])


@dataclass(frozen=True)
class DayGrainForecast:
    """One subsystem's day: two bands, a probability, and where they came from.

    **The shape forecaster ticket 14 persists.** `docs/specs/replay.md` requires
    ``forecast.day_total`` to be read from the contract and forbids
    reconstructing it by summing the hourly band, so these three figures have to
    reach the database alongside the day's twenty-four ``Forecast`` rows.
    :meth:`as_row` is that shape — one companion row per (subsystem, day).
    """

    target_date: date
    subsystem: Subsystem
    threshold_mw: float
    day_total: QuantileBand
    #: MW. A day's largest hourly MWh is numerically its peak MW at hour grain.
    peak_power: QuantileBand
    day_occurrence_probability: float
    #: The draws themselves, kept rather than discarded: forecaster ticket 08
    #: sums *paths* across subsystems draw by draw, which it can only do if the
    #: paths and their shared :class:`DrawPlan` outlive this call.
    ensemble: PathEnsemble

    def __post_init__(self) -> None:
        if not 0.0 <= self.day_occurrence_probability <= 1.0:
            raise EnsembleError(
                f"{self.day_occurrence_probability!r} is not a probability"
            )

    def as_row(self) -> dict[str, Any]:
        """The persistence shape, keyed as ``replay.md``'s ``forecast`` block.

        ``derivation`` is a stored string and not a comment. A reader of the
        database has to be able to tell a day total that came from the ensemble
        from one an earlier code path summed, and the prototype's summed row is
        exactly what `docs/specs/replay.md` says must come out.
        """
        return {
            "target_date": self.target_date.isoformat(),
            "subsystem": self.subsystem,
            "threshold_mw": self.threshold_mw,
            "day_total": _band_row(self.day_total),
            "peak_power": _band_row(self.peak_power),
            "day_occurrence_probability": self.day_occurrence_probability,
            "ensemble_draws": self.ensemble.plan.draws,
            "ensemble_seed": self.ensemble.plan.seed,
            "ensemble_calibration_days": self.ensemble.plan.rows,
            "derivation": "path_ensemble",
        }


@dataclass(frozen=True)
class DayGrainCoverage:
    """``day_total_coverage`` and ``peak_coverage`` — the ensemble's own calibration.

    The metrics table's two day-grain rows, reported per fold. The population is
    the fold's **complete settled days**: a day missing an hour has no observed
    total for a day band to be compared against, and counting it as a miss would
    score the ingest rather than the model.

    The target is 0.80 and not 0.90. The two hour-grain coverages are one-sided
    statements at 90% each; these count days inside ``[P10, P90]``, which is the
    two-sided interval those two tails bracket.

    **What it is expected to show, given what it inherits.** The composed P90 of
    an hour receives only :func:`~wattsteer_ml.training.conformal.
    upper_correction_fraction` of ``δ_hi``, so the ensemble draws from marginals
    whose upper tails are under-corrected, and a day total is a sum over
    twenty-four of them. ``day_total_coverage`` short of 0.80 with the misses
    concentrated above the band is that limitation arriving at day grain, not a
    fault in the resample; it is measured here rather than corrected, because
    forecaster ticket 21 owns the decision.
    """

    fold_id: str
    days: int
    day_total_coverage: float
    peak_coverage: float

    def __post_init__(self) -> None:
        if self.days <= 0:
            raise EnsembleError(
                f"{self.fold_id}: day-grain coverage over no complete day is not a "
                "measurement; a fold with none is reported as absent, not as 0.0"
            )

    @classmethod
    def of(
        cls,
        observed: Mapping[tuple[date, Subsystem], Sequence[float]],
        forecasts: Iterable[DayGrainForecast],
        *,
        fold_id: str,
    ) -> DayGrainCoverage | None:
        """Count both coverages over the days both sides have complete.

        ``None`` when no such day exists, for the same reason
        :class:`~wattsteer_ml.training.conformal.CoverageReport` is absent
        rather than zero: nothing was measured, and a row of zeros would read as
        total failure.
        """
        inside_total = 0
        inside_peak = 0
        counted = 0
        for forecast in forecasts:
            hours = observed.get((forecast.target_date, forecast.subsystem))
            if hours is None or len(hours) != HOURS_PER_DAY:
                continue
            counted += 1
            total = math.fsum(hours)
            peak = max(hours)
            if forecast.day_total.p10 <= total <= forecast.day_total.p90:
                inside_total += 1
            if forecast.peak_power.p10 <= peak <= forecast.peak_power.p90:
                inside_peak += 1
        if not counted:
            return None
        return cls(
            fold_id=fold_id,
            days=counted,
            day_total_coverage=inside_total / counted,
            peak_coverage=inside_peak / counted,
        )

    def card_fields(self) -> dict[str, Any]:
        return {
            "day_grain_fold": self.fold_id,
            "day_grain_days": self.days,
            "day_total_coverage": self.day_total_coverage,
            "peak_coverage": self.peak_coverage,
            "day_grain_coverage_target": SERVED_QUANTILES[2] - SERVED_QUANTILES[0],
            "day_grain_coverage_population": "complete_settled_days",
            "day_grain_coverage_note": (
                "the ensemble inverts the same Q_pos the hour band does, whose "
                "0.90 knot receives delta_hi only in the proportion "
                "upper_correction_fraction states. A day total is a sum over 24 "
                "such hours, so a shortfall here concentrated above the band is "
                "that under-correction at day grain and is reported, not repaired"
            ),
        }


def randomised_pit(
    mixture: HurdleMixture, observed_mwh: float, *, uniform: float
) -> float:
    """``u`` for one hour — the spec's two branches, and nothing invented between.

    ``uniform`` is the ``U(0, 1)`` draw the randomisation needs, passed in rather
    than drawn here, so this function is a pure inversion and the seed lives in
    exactly one place.

    **Sub-threshold: ``u ~ Uniform(0, 1 − p)``, branched on ``y ≤ τ``.** It is
    tempting to derive this from the general randomised-PIT rule
    ``u ~ Uniform(F(y⁻), F(y))`` and have one code path instead of two, and it
    is wrong. ``F_sub`` is supported on ``[0, τ]``, but
    :meth:`~wattsteer_ml.mixture.HurdleMixture.quantile` represents that whole
    mass as a **point at zero** — `mixture.py`'s stated "one asymmetry, on
    purpose" — so the quantile function has no value anywhere in ``(0, τ]``, and
    a bracket read off it would collapse to the single point ``1 − p`` for every
    quiet hour whose label is small but non-zero. The column would then be a
    spike at ``1 − p``: exactly the failure the randomisation exists to prevent,
    reintroduced by an elegance. The branch below is the spec's line, and the
    spec's line is right.

    **Above ``τ``: the bracket, read off the mixture itself.** Bisecting
    :meth:`~wattsteer_ml.mixture.HurdleMixture.quantile` — the same object the
    served band was composed from, which is why ticket 01 defined it at any
    ``q`` — gives ``F(y⁻)`` and ``F(y)``. Where the positive branch's CDF is
    continuous the two coincide and ``u`` is the ordinary PIT; where it jumps,
    because ``Q_pos`` is held flat outside its outermost knots, ``u`` is spread
    across the jump. There is no second CDF here to disagree with the one the
    band came from.

    An observation above the mixture's ceiling is clamped to it. See the module
    docstring: the model cannot tell such an hour from one sitting on the
    ceiling, and pretending otherwise would need a tail nobody fitted.
    """
    if not math.isfinite(observed_mwh) or observed_mwh < 0.0:
        raise EnsembleError(f"{observed_mwh!r} is not an observed MWh")
    if not math.isfinite(uniform) or not 0.0 <= uniform <= 1.0:
        raise EnsembleError(f"{uniform!r} is not a U(0, 1) draw")
    if observed_mwh <= mixture.threshold_mwh:
        return uniform * (1.0 - mixture.occurrence_probability)
    ceiling = mixture.quantile(1.0)
    value = min(observed_mwh, ceiling)
    lower = _first_q_reaching(mixture, value)
    upper = _last_q_at_most(mixture, value)
    if upper < lower:  # pragma: no cover — monotonicity makes this unreachable
        raise EnsembleError(
            f"the mixture's quantile function is not monotone at {value} MWh"
        )
    return min(1.0, max(0.0, lower + uniform * (upper - lower)))


def fit_pit_matrix(
    hours: Sequence[tuple[RowKey, HurdleMixture, float]],
    *,
    window: tuple[date, date],
    seed: int = ENSEMBLE_SEED,
) -> PitMatrix:
    """``U`` over a calibration window: one row per complete day.

    Args:
        hours: every **settled** hour of the window, as its key, the mixture the
            band there was composed from, and the label it turned out to have.
            Unsettled hours are simply absent, so this function never sees a
            missing label and has no imputation rule to get wrong.
        window: the calibration window, carried onto the matrix.
        seed: the randomisation's seed. ``U`` is only reproducible with it,
            because the PIT of a sub-threshold hour is a draw.

    Days are walked in calendar order and columns in :data:`PIT_COLUMN_KEYS`
    order, so one seed and one input produce one matrix.
    """
    by_day: dict[date, dict[tuple[Subsystem, int], tuple[HurdleMixture, float]]] = {}
    for key, mixture, observed in hours:
        cell = (key.subsystem, key.local_hour)
        day = by_day.setdefault(key.target_date, {})
        if cell in day:
            raise EnsembleError(
                f"{key.line} appears twice in the calibration window; a duplicated "
                "hour is an hour weighted twice"
            )
        day[cell] = (mixture, observed)
    rng = random.Random(seed)  # noqa: S311 — the randomised PIT, not a secret
    days: list[date] = []
    rows: list[tuple[float, ...]] = []
    dropped = 0
    for day_key in sorted(by_day):
        cells = by_day[day_key]
        if len(cells) != PIT_COLUMNS:
            dropped += 1
            continue
        days.append(day_key)
        rows.append(
            tuple(
                randomised_pit(cells[cell][0], cells[cell][1], uniform=rng.random())
                for cell in PIT_COLUMN_KEYS
            )
        )
    return PitMatrix(
        days=tuple(days),
        values=tuple(rows),
        window_start=window[0],
        window_end=window[1],
        dropped_days=dropped,
        seed=seed,
    )


def draw_day_grain(
    days: Mapping[tuple[date, Subsystem], Sequence[HurdleMixture]],
    *,
    matrix: PitMatrix,
    threshold_mw: float,
    plan: DrawPlan | None = None,
    seed: int = ENSEMBLE_SEED,
    draws: int = ENSEMBLE_DRAWS,
) -> tuple[DayGrainForecast, ...]:
    """Every ``(day, subsystem)``'s day-grain figures, under **one** draw plan.

    The shared index, made structural. One :class:`DrawPlan` is minted here and
    handed to every subsystem of every day, so draw ``k`` is the same
    calibration day everywhere in the returned tuple. Forecaster ticket 08 adds
    the four subsystems' :attr:`PathEnsemble.paths` draw by draw and reads the
    national day-total quantiles off the result; it needs no new draw, no
    copula and no parameter, because the dependence is already in the shared
    ``k``.

    A day is returned only if all twenty-four of its hours are present. There is
    no partial day here: a day total over twenty-three hours is a different
    quantity wearing the same name.
    """
    if plan is None:
        plan = DrawPlan.seeded(rows=matrix.rows, seed=seed, draws=draws)
    forecasts: list[DayGrainForecast] = []
    for target_date, subsystem in sorted(days, key=lambda key: (key[0], key[1])):
        mixtures = days[(target_date, subsystem)]
        if len(mixtures) != HOURS_PER_DAY:
            continue
        ensemble = PathEnsemble.draw(
            mixtures=mixtures, matrix=matrix, subsystem=subsystem, plan=plan
        )
        forecasts.append(
            DayGrainForecast(
                target_date=target_date,
                subsystem=subsystem,
                threshold_mw=threshold_mw,
                day_total=ensemble.day_total(),
                peak_power=ensemble.peak_power(),
                day_occurrence_probability=ensemble.day_occurrence_probability(),
                ensemble=ensemble,
            )
        )
    return tuple(forecasts)


def _band_row(quantiles: QuantileBand) -> dict[str, float]:
    return {"p10": quantiles.p10, "p50": quantiles.p50, "p90": quantiles.p90}


def _first_q_reaching(mixture: HurdleMixture, value: float) -> float:
    """``inf{q : Q(q) ≥ value}`` — the bottom of the jump ``value`` sits on."""
    if mixture.quantile(0.0) >= value:
        return 0.0
    return _bisect(lambda q: mixture.quantile(q) >= value)


def _last_q_at_most(mixture: HurdleMixture, value: float) -> float:
    """``sup{q : Q(q) ≤ value}`` — the top of that same jump."""
    if mixture.quantile(1.0) <= value:
        return 1.0
    return _bisect(lambda q: mixture.quantile(q) > value)


def _bisect(reached: Callable[[float], bool]) -> float:
    """Where a monotone false-then-true predicate on ``[0, 1]`` turns true.

    ``reached(0)`` is false and ``reached(1)`` is true at both call sites above,
    each checked there, so the bracket is valid from the first iteration.
    """
    low, high = 0.0, 1.0
    while high - low > _BRACKET_TOLERANCE:
        middle = (low + high) / 2.0
        if reached(middle):
            high = middle
        else:
            low = middle
    return high
