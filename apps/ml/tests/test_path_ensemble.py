"""Day grain comes from draws, and here is what that buys.

`docs/specs/forecaster.md`, "Day grain — one path ensemble, no addition", and
its Seams 2 and 3.

Four kinds of assertion live here and the difference matters when reading them.

**Structural.** Which rows the matrix is built from, that a draw is a whole row,
that one plan reaches every subsystem, that a bundle without a matrix does not
load, that no module builds a day-grain figure by adding quantiles up. Fixtures
cannot make those more or less true.

**Synthetic, with a known answer.** The uniformity tests generate labels *from*
the mixture they are then PIT-ed against, so the right answer is known before
the code runs: ``U`` must be uniform, and a deliberately mis-scaled upper tail
must be caught. They are about the construction, not about the Brazilian grid.

**Monte-Carlo, against an exact column.** ``U`` is filled with an exact uniform
grid so the only error left is the 500-draw resample, and the tolerance is that
error rather than a number chosen to make the test pass.

**Measured on the shared fit.** The seeded fold's day bands. The fixture's
*values* are meaningless — seven days of invented rows — and the assertions are
about inequalities that hold for any sample.

**One thing this file asserts is false, on purpose.** The ticket asks for
"day-total P90 strictly less than the sum of hourly P90s". That holds wherever
the hourly band is non-degenerate and it is *provably false* where every hour's
composed P90 is zero — a subsystem whose ``p`` never exceeds 0.10 has
``Σ_t P90_t = 0`` while its day still has a real chance of a curtailed hour.
Quantiles are not subadditive, and a hurdle with a large point mass at zero is
exactly the distribution where that bites. Both halves are tested, and the
second is the more interesting one.
"""

from __future__ import annotations

import inspect
import math
import random
import re
from collections.abc import Sequence
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import joblib
import pytest

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.mixture import (
    SERVED_QUANTILES,
    HurdleMixture,
    MagnitudeQuantiles,
    TailShift,
)
from wattsteer_ml.training import (
    ENSEMBLE_DRAWS,
    MIN_ENSEMBLE_DAYS,
    PIT_COLUMN_KEYS,
    PIT_COLUMNS,
    DayGrainCoverage,
    DrawPlan,
    EnsembleError,
    PartialBundleError,
    PathEnsemble,
    PitMatrix,
    TrainedFold,
    day_grain_rows,
    ensemble_quantile,
    fit_pit_matrix,
    forecast_rows,
    ks_uniform_statistic,
    ks_uniform_tolerance,
    load_artifact,
    pit_column,
    randomised_pit,
    save_artifact,
)
from wattsteer_ml.training import ensemble as ensemble_module

#: ``τ`` for every synthetic fixture here. The same 5 MWh the lanes use.
THRESHOLD_MW = 5.0

#: A window long enough for :class:`PitMatrix` to accept, in the tests that do
#: not care how long it is.
WINDOW = (date(2025, 1, 1), date(2025, 3, 31))


def a_mixture(
    *, p: float, knots: tuple[float, float, float] = (12.0, 40.0, 90.0)
) -> HurdleMixture:
    """One hour's marginal, with no model in the room."""
    return HurdleMixture(
        occurrence_probability=p,
        positive_quantiles=MagnitudeQuantiles(values=(knots[0] * 0.9, *knots)),
        positive_mean_mwh=50.0,
        sub_threshold_mean_mwh=1.0,
        threshold_mw=THRESHOLD_MW,
    )


def a_matrix(rows: Sequence[Sequence[float]]) -> PitMatrix:
    """A matrix over ``len(rows)`` consecutive days, with no fit behind it."""
    return PitMatrix(
        days=tuple(WINDOW[0] + timedelta(days=index) for index in range(len(rows))),
        values=tuple(tuple(row) for row in rows),
        window_start=WINDOW[0],
        window_end=WINDOW[1],
        dropped_days=0,
        seed=1,
    )


def a_uniform_grid(rows: int, *, seed: int = 7) -> PitMatrix:
    """Every column an exact uniform grid, independently permuted.

    Exact rather than sampled, so a test built on it measures only the 500-draw
    resampling error and never the drift of a finite calibration window.
    """
    rng = random.Random(seed)  # noqa: S311 — a fixture, not a security decision
    grid = [(index + 0.5) / rows for index in range(rows)]
    columns = []
    for _ in range(PIT_COLUMNS):
        shuffled = list(grid)
        rng.shuffle(shuffled)
        columns.append(shuffled)
    return a_matrix([[column[row] for column in columns] for row in range(rows)])


# --- The layout of U ----------------------------------------------------------


def test_the_matrix_is_one_row_per_day_and_one_column_per_subsystem_hour() -> None:
    """The spec's ``n_days × 24`` is one subsystem's slice of a wider matrix.

    The extra axis is the whole hand-back to forecaster ticket 08: without it a
    drawn day index means four different days in four subsystems, and the
    national band would need a copula after all.
    """
    assert len(SUBSYSTEM_CODES) * HOURS_PER_DAY == PIT_COLUMNS
    assert pit_column("N", 0) == 0
    assert pit_column(SUBSYSTEM_CODES[-1], HOURS_PER_DAY - 1) == PIT_COLUMNS - 1
    for index, (subsystem, hour) in enumerate(PIT_COLUMN_KEYS):
        assert pit_column(subsystem, hour) == index


def test_a_subsystem_slice_keeps_the_rows_it_was_sliced_from() -> None:
    """Row ``k`` of ``SE`` and row ``k`` of ``N`` are the same calendar day.

    Asserted rather than assumed, because it is the only reason sharing a draw
    index across subsystems means anything.
    """
    matrix = a_matrix(
        [
            [(row * PIT_COLUMNS + column) % 1000 / 1000 for column in range(PIT_COLUMNS)]
            for row in range(MIN_ENSEMBLE_DAYS)
        ]
    )
    for row in range(matrix.rows):
        for subsystem in SUBSYSTEM_CODES:
            sliced = matrix.day_columns(subsystem)[row]
            for hour in range(HOURS_PER_DAY):
                assert sliced[hour] == matrix.values[row][pit_column(subsystem, hour)]


def test_a_row_with_a_hole_in_it_is_not_a_day() -> None:
    rows = [[0.5] * PIT_COLUMNS for _ in range(MIN_ENSEMBLE_DAYS)]
    rows[3] = [0.5] * (PIT_COLUMNS - 1)
    with pytest.raises(EnsembleError, match="hole in it"):
        a_matrix(rows)


def test_a_pit_outside_the_unit_interval_is_refused() -> None:
    rows = [[0.5] * PIT_COLUMNS for _ in range(MIN_ENSEMBLE_DAYS)]
    rows[0][17] = 1.5
    with pytest.raises(EnsembleError, match="is a probability"):
        a_matrix(rows)


def test_too_short_a_window_is_a_statement_about_the_window() -> None:
    with pytest.raises(EnsembleError, match="A wider window is the answer"):
        a_matrix([[0.5] * PIT_COLUMNS for _ in range(MIN_ENSEMBLE_DAYS - 1)])


# --- The randomised PIT -------------------------------------------------------


def test_a_sub_threshold_hour_is_uniform_on_the_sub_threshold_mass() -> None:
    """The spec's second line, and it is a branch rather than a derivation.

    ``F_sub`` is supported on ``[0, τ]`` and the mixture's quantile function
    represents that whole mass as a point at zero, so a bracket read off the
    quantile function would collapse to ``1 − p`` for every quiet hour whose
    label is small but non-zero — a spike, which is what the randomisation
    exists to prevent. These three labels are all in that gap.
    """
    mixture = a_mixture(p=0.3)
    for observed in (0.0, 2.5, THRESHOLD_MW):
        assert randomised_pit(mixture, observed, uniform=0.0) == 0.0
        assert randomised_pit(mixture, observed, uniform=1.0) == pytest.approx(0.7)
        assert randomised_pit(mixture, observed, uniform=0.5) == pytest.approx(0.35)


def test_an_hour_inside_the_positive_branch_gets_the_ordinary_pit() -> None:
    """Where the CDF is strictly increasing the bracket collapses and ``u = F(y)``.

    Checked by round trip: the PIT of ``Q(q)`` is ``q``, for every ``q`` the
    interpolant is strictly increasing at.
    """
    mixture = a_mixture(p=0.8)
    # u_pos = (q - 0.2) / 0.8 must land strictly between the 0.10 and 0.90
    # knots, or the observation sits on a flat and is randomised across it.
    for q in (0.35, 0.5, 0.65, 0.8, 0.9):
        observed = mixture.quantile(q)
        assert observed > mixture.threshold_mwh
        assert randomised_pit(mixture, observed, uniform=0.5) == pytest.approx(
            q, abs=1e-9
        )


def test_an_hour_above_the_ceiling_is_spread_over_the_ceilings_own_jump() -> None:
    """The flat-held upper tail is an atom, and an atom gets randomised.

    ``Q_pos`` is held flat above its 0.90 knot, so the mixture's CDF reaches 1
    at a finite ceiling and an observation past it is indistinguishable from one
    on it. Forecaster ticket 21's under-corrected upper tail arrives here as a
    pile-up of ``u`` near 1 — which is what makes the KS check a detector rather
    than a formality.
    """
    mixture = a_mixture(p=1.0)
    ceiling = mixture.quantile(1.0)
    far_above = randomised_pit(mixture, ceiling * 10, uniform=0.5)
    on_it = randomised_pit(mixture, ceiling, uniform=0.5)
    assert far_above == pytest.approx(on_it, abs=1e-9)
    assert randomised_pit(mixture, ceiling * 10, uniform=0.0) == pytest.approx(
        0.9, abs=1e-6
    )
    assert randomised_pit(mixture, ceiling * 10, uniform=1.0) == pytest.approx(1.0)


# --- Seam 3: the stored matrix is uniform, per column -------------------------


def _synthetic_matrix(*, days: int, seed: int, ceiling_scale: float = 1.0) -> PitMatrix:
    """Labels drawn *from* the marginals they are then PIT-ed against.

    ``ceiling_scale`` below 1 shrinks the 0.90 knot after the labels were drawn,
    which is the shape of a model whose upper tail is too tight: the same defect
    the conformal correction under-corrects.
    """
    rng = random.Random(seed)  # noqa: S311 — a fixture, not a security decision
    knots_of: dict[tuple[Subsystem, int], tuple[float, float, float]] = {
        cell: (8.0 + index % 5, 30.0 + index % 9, 70.0 + index % 13)
        for index, cell in enumerate(PIT_COLUMN_KEYS)
    }
    truth = {
        cell: a_mixture(p=0.15 + 0.7 * ((index * 37) % 11) / 10.0, knots=knots_of[cell])
        for index, cell in enumerate(PIT_COLUMN_KEYS)
    }
    served = {
        cell: replace(
            mixture,
            positive_quantiles=MagnitudeQuantiles(
                values=(
                    knots[0] * 0.9,
                    knots[0],
                    knots[1],
                    knots[2] * ceiling_scale,
                )
            ),
        )
        for cell, mixture, knots in (
            (one, truth[one], knots_of[one]) for one in PIT_COLUMN_KEYS
        )
    }
    hours: list[tuple[RowKey, HurdleMixture, float]] = []
    for offset in range(days):
        target_date = WINDOW[0] + timedelta(days=offset)
        for subsystem, hour in PIT_COLUMN_KEYS:
            observed = truth[(subsystem, hour)].quantile(rng.random())
            hours.append(
                (
                    RowKey(target_date=target_date, local_hour=hour, subsystem=subsystem),
                    served[(subsystem, hour)],
                    observed,
                )
            )
    # A different seed from the one the labels were drawn with. Sharing it
    # would make each hour's randomisation the very uniform its label came
    # from, and the column would be biased by the correlation rather than by
    # anything the code does.
    return fit_pit_matrix(hours, window=WINDOW, seed=seed * 7 + 1)


def test_the_stored_matrix_is_uniform_per_column_within_a_ks_tolerance() -> None:
    """Seam 3, and the only test that sees a miscalibrated marginal.

    The labels are drawn from the very mixtures the PIT is taken against, so a
    non-uniform column here is a fault in the construction and nothing else. A
    matrix that fails this makes every day-grain number meaningless.
    """
    matrix = _synthetic_matrix(days=250, seed=11)
    assert matrix.rows == 250
    for subsystem, hour in PIT_COLUMN_KEYS:
        statistic = matrix.ks_statistic(subsystem, hour)
        assert statistic <= matrix.ks_tolerance, (
            f"column {subsystem}/{hour:02d} is {statistic:.3f} from uniform, past "
            f"the {matrix.ks_tolerance:.3f} a sample of {matrix.rows} may drift"
        )
    assert matrix.uniform_within_tolerance


def test_a_tail_that_is_too_tight_shows_up_as_a_column_that_is_not_uniform() -> None:
    """The check has teeth: shrink the 0.90 knot and the KS statistic sees it.

    This is forecaster ticket 21's shape — an upper tail the correction does not
    reach — reproduced deliberately. The matrix is still built, because refusing
    is the hot-swap gate's job; what this module does is publish the number.
    """
    honest = _synthetic_matrix(days=250, seed=11)
    tight = _synthetic_matrix(days=250, seed=11, ceiling_scale=0.5)
    assert tight.max_ks_statistic() > honest.max_ks_statistic()
    assert not tight.uniform_within_tolerance


def test_the_ks_tolerance_is_the_asymptotic_band_and_nothing_invented() -> None:
    assert ks_uniform_tolerance(100) == pytest.approx(0.136)
    assert ks_uniform_statistic([0.5]) == pytest.approx(0.5)
    assert ks_uniform_statistic([(i + 0.5) / 100 for i in range(100)]) == pytest.approx(
        0.005
    )


# --- Seam 3: the ensemble's marginals are the marginals ------------------------


def test_the_ensembles_own_marginals_reproduce_the_composed_hour_band() -> None:
    """Within Monte-Carlo error at 500 draws, and the error is derived not chosen.

    The column is an exact uniform grid, so the only randomness left is the
    resample. The ``q``-th order statistic of ``K`` draws has a standard error of
    ``√(q(1−q)/K)`` in ``u``; four of those, plus one grid step, is the window
    the ensemble's quantile must land inside once mapped through ``Q_Y``.
    """
    rows = 400
    matrix = a_uniform_grid(rows)
    mixtures = [a_mixture(p=0.7 + 0.02 * (hour % 5)) for hour in range(HOURS_PER_DAY)]
    ensemble = PathEnsemble.draw(
        mixtures=mixtures,
        matrix=matrix,
        subsystem="SE",
        plan=DrawPlan.seeded(rows=rows, seed=3),
    )
    for hour, mixture in enumerate(mixtures):
        band = ensemble.hour_band(hour)
        for q, drawn in zip(
            SERVED_QUANTILES, (band.p10, band.p50, band.p90), strict=True
        ):
            error = 4.0 * math.sqrt(q * (1.0 - q) / ENSEMBLE_DRAWS) + 1.0 / rows
            low = mixture.quantile(max(0.0, q - error))
            high = mixture.quantile(min(1.0, q + error))
            assert low <= drawn <= high, (
                f"hour {hour}'s ensemble {q:.2f} is {drawn}, outside "
                f"[{low}, {high}] — wider than the resample can explain"
            )


def test_the_ensemble_inverts_the_corrected_mixture_and_not_a_second_one() -> None:
    """Forecaster ticket 21's soundness condition, and why the shift lives here.

    The conformal residuals are measured on the composed band, so the honest
    place to apply them is the composed quantile. The reason that is not simply
    "add ``δ_hi`` to the served P90" is this test: the served band is not the
    only thing that inverts the mixture. This ensemble asks
    :meth:`~wattsteer_ml.mixture.HurdleMixture.quantile` for 500 × 24 draws of
    ``q``, at values that have nothing to do with 0.10 and 0.90, and ticket 07's
    own invariant is that its marginals **are** the served marginals — the hour
    band and the day band cannot disagree about hour 14.

    A correction applied at the two served probabilities alone would break that:
    the band would move and the ensemble would keep drawing from the
    uncorrected distribution. So the shift is defined at every ``q`` and carried
    on the mixture, which is why the ensemble still inverts one object and this
    test is the same test as its neighbour above with a correction on.
    """
    rows = 400
    matrix = a_uniform_grid(rows)
    # 0.04 of `a_mixture`'s 78 MWh positive spread — about 3 MWh, the flat
    # figure this read before forecaster 43 made the lower end a multiple.
    shift = TailShift(lower_spread_multiple=0.04, upper_mwh=25.0)
    mixtures = [
        replace(a_mixture(p=0.7 + 0.02 * (hour % 5)), tail_shift=shift)
        for hour in range(HOURS_PER_DAY)
    ]
    ensemble = PathEnsemble.draw(
        mixtures=mixtures,
        matrix=matrix,
        subsystem="SE",
        plan=DrawPlan.seeded(rows=rows, seed=3),
    )
    moved = 0
    for hour, mixture in enumerate(mixtures):
        band = ensemble.hour_band(hour)
        uncorrected = replace(mixture, tail_shift=TailShift.none())
        for q, drawn in zip(
            SERVED_QUANTILES, (band.p10, band.p50, band.p90), strict=True
        ):
            error = 4.0 * math.sqrt(q * (1.0 - q) / ENSEMBLE_DRAWS) + 1.0 / rows
            low = mixture.quantile(max(0.0, q - error))
            high = mixture.quantile(min(1.0, q + error))
            assert low <= drawn <= high, (
                f"hour {hour}'s ensemble {q:.2f} is {drawn}, outside "
                f"[{low}, {high}] — the ensemble is drawing from a distribution "
                "the served band was not composed from"
            )
            if not (
                uncorrected.quantile(max(0.0, q - error))
                <= drawn
                <= uncorrected.quantile(min(1.0, q + error))
            ):
                moved += 1
    assert moved > 0, (
        "the corrected and uncorrected marginals are indistinguishable here, so "
        "this test would pass against an ensemble that ignored the shift"
    )


# --- Seam 2: quantiles do not add ---------------------------------------------


def _summed(hours: Sequence[Any], attribute: str) -> float:
    """The forbidden arithmetic, spelt out **in the test** so nothing else has to.

    This is the number the day band must not equal. It exists in this file and
    in no module, which is the point of the grep below.
    """
    return math.fsum(getattr(hour.forecast.band, attribute) for hour in hours)


def _hours_of(
    trained: TrainedFold, rows: Sequence[Any], key: tuple[date, Subsystem]
) -> list[Any]:
    return [
        hour
        for hour in forecast_rows(trained.bundle, rows)
        if (hour.key.target_date, hour.key.subsystem) == key
    ]


def test_the_day_band_is_strictly_inside_the_summed_band_where_the_band_is_real(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """Ticket 07's headline inequality, on the subsystem whose ``p`` is high.

    ``NE`` is the fixture's busy subsystem, so its hourly bands are in the
    positive branch and the sums are non-zero. The gap is not marginal: the
    summed P90 is a day on which all twenty-four hours simultaneously landed at
    their own ninetieth percentile, and that day is far rarer than one in ten.
    """
    days = [
        day for day in day_grain_rows(trained.bundle, test_rows) if day.subsystem == "NE"
    ]
    assert days, "the fixture's busy subsystem must produce day-grain rows"
    for day in days:
        hours = _hours_of(trained, test_rows, (day.target_date, day.subsystem))
        assert len(hours) == HOURS_PER_DAY
        summed_p90 = _summed(hours, "p90")
        summed_p10 = _summed(hours, "p10")
        assert summed_p90 > 0.0
        assert day.day_total.p90 < summed_p90
        assert day.day_total.p10 > summed_p10


def test_where_every_hourly_p90_is_zero_the_day_p90_is_not(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """The half of the ticket's inequality that is false, and why that is right.

    A subsystem whose ``p`` never exceeds 0.10 has a composed P90 of zero in
    every hour, so ``Σ_t P90_t`` is zero — and the day still has a real chance
    of a curtailed hour. Quantiles are not subadditive; a hurdle with a large
    point mass at zero is precisely where that bites, and a day band clamped to
    the summed one would be the lie, not the fix.
    """
    quiet = [
        day
        for day in day_grain_rows(trained.bundle, test_rows)
        if _summed(_hours_of(trained, test_rows, (day.target_date, day.subsystem)), "p90")
        == 0.0
    ]
    assert quiet, "the fixture must contain a subsystem-day with a degenerate band"
    assert any(day.day_total.p90 > 0.0 for day in quiet)
    assert all(0.0 <= day.day_occurrence_probability <= 1.0 for day in quiet)


def test_whole_day_draws_are_wider_than_independent_hourly_draws() -> None:
    """The ``1/√24`` claim, as an experiment rather than an assertion in prose.

    The matrix's rows are perfectly dependent within a day — every hour of a day
    carries the same ``u`` — so a whole-row draw keeps that and a column-wise
    shuffle destroys it. The shuffled ensemble's day totals are dramatically
    tighter, which is the "narrower band arrived at by a more sophisticated
    route" the spec warns about.
    """
    rows = 300
    grid = [(index + 0.5) / rows for index in range(rows)]
    coherent = a_matrix([[value] * PIT_COLUMNS for value in grid])
    rng = random.Random(5)  # noqa: S311 — a fixture, not a security decision
    columns = []
    for _ in range(PIT_COLUMNS):
        shuffled = list(grid)
        rng.shuffle(shuffled)
        columns.append(shuffled)
    scrambled = a_matrix([[column[row] for column in columns] for row in range(rows)])
    mixtures = [a_mixture(p=0.9) for _ in range(HOURS_PER_DAY)]
    plan = DrawPlan.seeded(rows=rows, seed=2)
    together = PathEnsemble.draw(
        mixtures=mixtures, matrix=coherent, subsystem="SE", plan=plan
    ).day_total()
    apart = PathEnsemble.draw(
        mixtures=mixtures, matrix=scrambled, subsystem="SE", plan=plan
    ).day_total()
    assert (together.p90 - together.p10) > 4.0 * (apart.p90 - apart.p10)


def test_day_occurrence_is_counted_and_is_not_one_minus_the_product() -> None:
    """``1 − Π(1 − p_t)`` assumes independence and overstates day-level risk.

    With the hours perfectly dependent within a day, the true day-level
    probability is one hour's ``p``; the independence formula is very nearly 1.
    """
    rows = 200
    grid = [(index + 0.5) / rows for index in range(rows)]
    matrix = a_matrix([[value] * PIT_COLUMNS for value in grid])
    p = 0.3
    mixtures = [a_mixture(p=p) for _ in range(HOURS_PER_DAY)]
    ensemble = PathEnsemble.draw(
        mixtures=mixtures,
        matrix=matrix,
        subsystem="S",
        plan=DrawPlan.seeded(rows=rows, seed=4),
    )
    independent = 1.0 - (1.0 - p) ** HOURS_PER_DAY
    assert ensemble.day_occurrence_probability() == pytest.approx(p, abs=0.06)
    assert independent > 0.99
    assert ensemble.day_occurrence_probability() < independent


def test_the_published_quantile_is_a_draw_and_not_a_point_between_two() -> None:
    values = [float(index) for index in range(1, 11)]
    assert ensemble_quantile(values, 0.10) == 1.0
    assert ensemble_quantile(values, 0.50) == 5.0
    assert ensemble_quantile(values, 0.90) == 9.0
    assert ensemble_quantile(values, 0.0) == 1.0
    assert ensemble_quantile(values, 1.0) == 10.0


# --- The shared draw index ----------------------------------------------------


def test_one_plan_reaches_every_subsystem_of_every_day(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """The hand-back to forecaster ticket 08, asserted rather than intended.

    Draw ``k`` is the same calibration day in all four subsystems, so summing
    the four ensembles' paths draw by draw gives the national day total's own
    distribution — with no copula, no second model and no new parameter. Ticket
    08 composes that figure; this ticket is what makes it available.
    """
    days = day_grain_rows(trained.bundle, test_rows)
    plans = {day.ensemble.plan for day in days}
    assert len(plans) == 1, "every subsystem of every day draws under one plan"
    plan = plans.pop()
    assert plan.draws == ENSEMBLE_DRAWS
    assert plan.rows == trained.bundle.pit.rows

    one_day = [day for day in days if day.target_date == days[0].target_date]
    assert {day.subsystem for day in one_day} == set(SUBSYSTEM_CODES)
    # Draw k of every subsystem reads row plan.indices[k] of U, so a national
    # path is the four subsystem paths at the same k, added.
    national = [
        math.fsum(day.ensemble.day_totals[k] for day in one_day)
        for k in range(plan.draws)
    ]
    assert len(national) == ENSEMBLE_DRAWS
    assert min(national) >= max(min(day.ensemble.day_totals) for day in one_day) - 1e-9


def test_a_plan_cannot_be_applied_to_a_matrix_of_another_height() -> None:
    matrix = a_uniform_grid(MIN_ENSEMBLE_DAYS)
    with pytest.raises(EnsembleError, match="are not one ensemble"):
        PathEnsemble.draw(
            mixtures=[a_mixture(p=0.5)] * HOURS_PER_DAY,
            matrix=matrix,
            subsystem="N",
            plan=DrawPlan.seeded(rows=matrix.rows + 1, seed=1),
        )


def test_a_plan_names_rows_and_has_no_field_that_could_name_an_hour() -> None:
    """The draw is whole-day by shape, not by discipline."""
    fields = {field for field in DrawPlan.__dataclass_fields__}
    assert fields == {"indices", "seed", "rows"}
    plan = DrawPlan.seeded(rows=50, seed=9)
    assert plan == DrawPlan.seeded(rows=50, seed=9)
    assert plan != DrawPlan.seeded(rows=50, seed=10)
    assert all(0 <= index < 50 for index in plan.indices)


def test_the_same_seed_reproduces_the_same_day_band(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    first = day_grain_rows(trained.bundle, test_rows)
    second = day_grain_rows(trained.bundle, test_rows)
    assert [day.as_row() for day in first] == [day.as_row() for day in second]
    assert [day.as_row() for day in first] != [
        day.as_row() for day in day_grain_rows(trained.bundle, test_rows, seed=1)
    ]


# --- The shape ticket 14 persists ---------------------------------------------


def test_the_day_grain_row_is_the_shape_replay_reads(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """`docs/specs/replay.md` reads ``forecast.day_total`` from the contract.

    The row carries its own derivation, because a reader of the database has to
    be able to tell an ensemble day total from one an earlier code path summed —
    which is exactly what that spec says must come out of the prototype.
    """
    row = day_grain_rows(trained.bundle, test_rows)[0].as_row()
    assert set(row) == {
        "target_date",
        "subsystem",
        "threshold_mw",
        "day_total",
        "peak_power",
        "day_occurrence_probability",
        "ensemble_draws",
        "ensemble_seed",
        "ensemble_calibration_days",
        "derivation",
    }
    assert row["derivation"] == "path_ensemble"
    assert set(row["day_total"]) == {"p10", "p50", "p90"}
    assert set(row["peak_power"]) == {"p10", "p50", "p90"}
    assert row["threshold_mw"] == trained.bundle.threshold_mw
    assert row["ensemble_draws"] == ENSEMBLE_DRAWS


def test_a_day_missing_an_hour_is_not_totalled(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """A day total over twenty-three hours is a different quantity, same name."""
    short = [
        row
        for row in test_rows
        if not (
            row["target_date"] == min(one["target_date"] for one in test_rows)
            and row["subsystem"] == "NE"
            and row["valid_time"].hour % 7 == 0
        )
    ]
    days = day_grain_rows(trained.bundle, short)
    assert not [
        day
        for day in days
        if day.subsystem == "NE"
        and day.target_date == min(row["target_date"] for row in test_rows)
    ]


# --- day_total_coverage and peak_coverage, per fold ---------------------------


def test_the_card_reports_both_day_grain_coverages_for_the_fold(
    trained: TrainedFold,
) -> None:
    """The metrics table's two day-grain rows, at fold grain.

    The *values* are meaningless on seven invented days; that they are measured,
    over a named population, on the served day band, is not.
    """
    card = trained.card.to_dict()["ensemble"]
    assert card["day_grain_fold"] == trained.card.fold.id
    assert card["day_grain_coverage_population"] == "complete_settled_days"
    assert card["day_grain_coverage_target"] == pytest.approx(0.8)
    for name in ("day_total_coverage", "peak_coverage"):
        assert 0.0 <= card[name] <= 1.0
    assert card["day_grain_days"] > 0


def test_the_card_publishes_the_matrix_and_what_it_measures_of_itself(
    trained: TrainedFold,
) -> None:
    card = trained.card.to_dict()["ensemble"]
    assert card["pit_rows"] == trained.bundle.pit.rows
    assert card["pit_columns"] == PIT_COLUMNS
    assert card["pit_dropped_days"] >= 0
    assert card["pit_max_ks"] == pytest.approx(trained.bundle.pit.max_ks_statistic())
    assert card["pit_ks_tolerance"] == pytest.approx(trained.bundle.pit.ks_tolerance)
    assert card["ensemble_draws"] == ENSEMBLE_DRAWS
    assert card["pit_window"] == {
        "start": trained.card.blocks.calibration_start.isoformat(),
        "end": trained.card.blocks.calibration_end.isoformat(),
    }


def test_day_grain_coverage_is_absent_rather_than_zero_when_nothing_is_complete() -> None:
    assert DayGrainCoverage.of({}, (), fold_id="F1") is None
    with pytest.raises(EnsembleError, match="reported as absent"):
        DayGrainCoverage(fold_id="F1", days=0, day_total_coverage=0.0, peak_coverage=0.0)


# --- The bundle ---------------------------------------------------------------


def test_a_bundle_without_a_matrix_does_not_load(
    trained: TrainedFold, tmp_path: Path
) -> None:
    """Absent means the day-grain row cannot be produced, not that it degrades.

    A bundle with no ``U`` can still serve twenty-four hourly bands, which is
    exactly why this has to fail loudly: the alternative is a caller who adds
    them up.
    """
    save_artifact(trained.bundle, trained.card, root=tmp_path)
    directory = tmp_path / trained.bundle.lane.directory_name
    path = next(directory.glob("*.joblib"))
    joblib.dump(replace(trained.bundle, pit=None), path)  # type: ignore[arg-type]
    with pytest.raises(PartialBundleError, match="missing"):
        load_artifact(
            root=tmp_path,
            lane=trained.bundle.lane,
            artifact_id=trained.card.artifact_id,
        )


def test_a_matrix_that_came_back_as_something_else_does_not_load(
    trained: TrainedFold, tmp_path: Path
) -> None:
    save_artifact(trained.bundle, trained.card, root=tmp_path)
    directory = tmp_path / trained.bundle.lane.directory_name
    path = next(directory.glob("*.joblib"))
    joblib.dump(replace(trained.bundle, pit="U"), path)  # type: ignore[arg-type]
    with pytest.raises(PartialBundleError, match="not a PitMatrix"):
        load_artifact(
            root=tmp_path,
            lane=trained.bundle.lane,
            artifact_id=trained.card.artifact_id,
        )


def test_the_matrix_is_fitted_on_the_calibration_window(trained: TrainedFold) -> None:
    """The same window ``δ`` was ranked over, and against the corrected band.

    A matrix built from the uncorrected band would describe a distribution
    nobody serves.
    """
    pit = trained.bundle.pit
    assert pit.window_start == trained.card.blocks.calibration_start
    assert pit.window_end == trained.card.blocks.calibration_end
    assert all(pit.window_start <= day <= pit.window_end for day in pit.days)
    assert pit.rows + pit.dropped_days == ((pit.window_end - pit.window_start).days + 1)


# --- The grep-level invariants ------------------------------------------------


#: Attribute reads that name a band's quantile.
_QUANTILE = r"\.p(?:10|50|90)\b"

#: The arithmetic that must not appear beside one.
_SUMMED_BAND = (
    re.compile(rf"(?:math\.fsum|sum)\([^\n]*{_QUANTILE}"),
    re.compile(rf"{_QUANTILE}\s*\+"),
    re.compile(rf"\+\s*[\w.\[\]]*{_QUANTILE}"),
)


def _source_files() -> dict[str, str]:
    root = Path(inspect.getfile(ensemble_module)).parents[1]
    return {
        path.relative_to(root).as_posix(): _without_docstrings(
            path.read_text(encoding="utf-8")
        )
        for path in sorted(root.rglob("*.py"))
    }


def _without_docstrings(source: str) -> str:
    """The code, with its prose removed.

    These assertions are about what the code *does*, and the prose here explains
    at length what it deliberately does not do — the vocabulary a naive grep
    trips over.
    """
    parts = source.split('"""')
    return parts[0] + "".join(parts[2::2]) if len(parts) > 2 else source


def test_no_code_path_computes_a_day_grain_figure_by_summing_a_band() -> None:
    """The UI's invariant, one layer down, as a grep.

    `docs/specs/forecaster.md`'s Seam 2 asks for exactly this, "because this is
    the invariant most likely to be broken by a well-meaning optimisation".

    **What it catches and what it cannot.** It catches a band's quantile being
    added to anything, anywhere in the service. It cannot follow a P50 profile
    passed into a function that sums its argument — which the optimizer's
    simulator legitimately does with the hour-wise P10 envelope, a *simulated*
    figure both specs already say is not a realisable day. The structural half
    below is the teeth: a day-grain figure exists in one module.
    """
    offences = [
        f"{name}:{index + 1}: {line.strip()}"
        for name, source in _source_files().items()
        for index, line in enumerate(source.splitlines())
        for pattern in _SUMMED_BAND
        if pattern.search(line)
    ]
    assert not offences, "a day-grain figure computed by summing a band:\n" + "\n".join(
        offences
    )


def test_a_day_grain_figure_is_built_in_exactly_one_module() -> None:
    """The structural half. ``DayGrainForecast`` is constructed in one place."""
    built = sorted(
        name for name, source in _source_files().items() if "DayGrainForecast(" in source
    )
    assert built == ["training/ensemble.py"]


def test_the_service_still_has_exactly_one_composition() -> None:
    """Ticket 01's invariant, still true after a day grain was added.

    The ensemble inverts :meth:`HurdleMixture.quantile` — the same object the
    hour band came from — and never composes a second one.
    """
    call_sites = sorted(
        name
        for name, source in _source_files().items()
        if any(
            "compose(" in line and not line.lstrip().startswith("def ")
            for line in source.splitlines()
        )
    )
    assert call_sites == ["training/hurdle.py"]


def test_the_ensemble_builds_no_band_of_its_own() -> None:
    """It reads ``Q_Y`` and sorts draws; it never composes a mixture."""
    source = _without_docstrings(inspect.getsource(ensemble_module))
    for forbidden in ("compose(", "HurdleMixture(", "MagnitudeQuantiles("):
        assert forbidden not in source, (
            f"training/ensemble.py contains {forbidden!r}, which is a second "
            "route from a scalar to a served interval"
        )
