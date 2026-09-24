"""The national band is a quantile of a sum, and never a sum of quantiles.

`docs/specs/api-surface.md`, "The national readout, and the band that cannot be
built", and forecaster ticket 08.

Four kinds of assertion, the same four ticket 07's suite uses.

**Structural.** That a national day needs all four subsystems, that they must
have drawn under one plan, that a subsystem cannot be counted twice, that the
origin names WattSteer and the artifact, and that no source line reads an ONS
aggregate row. Fixtures cannot make those more or less true.

**Synthetic, with a known answer.** Two matrices with a dependence structure
chosen by hand. Perfectly comonotone subsystems are the *only* case in which the
national band equals the componentwise sum of the four — so that case is tested
as the boundary, and the anti-dependent case, where the national band nearly
collapses, is tested as what the machinery actually buys. Neither is about the
Brazilian grid; both are about which arithmetic is being done.

**Measured on the shared fit.** The seeded fold's national days. The fixture's
*values* are meaningless, and the assertions are inequalities that hold for any
sample: the national band strictly inside the summed one, the national median
away from the sum of the four medians, the national expectation exactly on the
sum of the four.

**What is asserted to be exact, and what is not.** ``expected_mwh`` is exact —
expectations add, and the test uses ``==`` against ``math.fsum`` rather than an
approximation, because an approximate equality here would hide the day someone
starts averaging the draws instead. Everything else is a quantile and is
asserted as an inequality.
"""

from __future__ import annotations

import inspect
import math
from collections.abc import Sequence
from datetime import date, timedelta
from typing import Any

import pytest

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import HOURS_PER_DAY
from wattsteer_ml.mixture import HurdleMixture, MagnitudeQuantiles
from wattsteer_ml.training import (
    CORRECTION_REGIME,
    ENSEMBLE_DRAWS,
    MIN_ENSEMBLE_DAYS,
    PIT_COLUMNS,
    DayGrainForecast,
    DrawPlan,
    ForecastOrigin,
    NationalDayGrain,
    NationalError,
    PitMatrix,
    TrainedFold,
    day_grain_rows,
    draw_day_grain,
    forecast_rows,
    national_day_grain,
    national_rows,
    pit_column,
    subsystem_day_expectations,
)
from wattsteer_ml.training import national as national_module

#: ``τ`` for every synthetic fixture here. The same 5 MWh the lanes use.
THRESHOLD_MW = 5.0

#: A window long enough for :class:`PitMatrix` to accept.
WINDOW = (date(2025, 1, 1), date(2025, 3, 31))

#: The day the synthetic fixtures describe.
A_DAY = date(2025, 4, 2)


def a_mixture(
    *, p: float, knots: tuple[float, float, float] = (12.0, 40.0, 90.0)
) -> HurdleMixture:
    """One hour's marginal, with no model in the room."""
    return HurdleMixture(
        occurrence_probability=p,
        positive_quantiles=MagnitudeQuantiles(
            values=(knots[0] * 0.9, *knots)
        ),
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


def an_origin() -> ForecastOrigin:
    return ForecastOrigin.of_artifact("2026-08-29T04:00:00Z")


def a_day(
    matrix: PitMatrix,
    mixtures_of: dict[Subsystem, list[HurdleMixture]],
    *,
    seed: int = 3,
) -> tuple[DayGrainForecast, ...]:
    """One day's four subsystem forecasts, under the one plan ticket 07 mints."""
    return draw_day_grain(
        {(A_DAY, code): mixtures_of[code] for code in SUBSYSTEM_CODES},
        matrix=matrix,
        threshold_mw=THRESHOLD_MW,
        seed=seed,
    )


def flat_expectations(value: float = 100.0) -> dict[tuple[date, Subsystem], float]:
    return {(A_DAY, code): value for code in SUBSYSTEM_CODES}


def _width(band: Any) -> float:
    return float(band.p90) - float(band.p10)


# --- Synthetic: which arithmetic is being done --------------------------------


def test_comonotone_subsystems_are_the_one_case_the_summed_band_is_right() -> None:
    """The boundary, tested as a boundary.

    Every column of ``U`` carries the same value, so the four subsystems move
    together perfectly and the national day *is* four times one subsystem's. The
    componentwise sum of the four bands is exactly right here — and only here,
    which is why publishing it in general was publishing an assumption.
    """
    rows = 200
    grid = [(index + 0.5) / rows for index in range(rows)]
    matrix = a_matrix([[value] * PIT_COLUMNS for value in grid])
    mixtures = [a_mixture(p=0.8) for _ in range(HOURS_PER_DAY)]
    forecasts = a_day(matrix, dict.fromkeys(SUBSYSTEM_CODES, mixtures))
    national = national_day_grain(
        forecasts, expectations=flat_expectations(), origin=an_origin()
    )[0]
    summed_p50 = math.fsum(day.day_total.p50 for day in forecasts)
    summed_p90 = math.fsum(day.day_total.p90 for day in forecasts)
    assert national.day_total.p50 == pytest.approx(summed_p50, rel=1e-12)
    assert national.day_total.p90 == pytest.approx(summed_p90, rel=1e-12)


def test_subsystems_that_do_not_move_together_collapse_the_national_band() -> None:
    """And what that buys, on a window with dependence chosen by hand.

    ``N`` and ``S`` are high on the days ``NE`` and ``SE`` are low. The four
    day totals are as wide as ever; the national one is far narrower, because a
    day on which all four simultaneously reach their own ninetieth percentile
    does not exist in this window. That gap is the whole ticket.
    """
    rows = 200
    grid = [(index + 0.5) / rows for index in range(rows)]
    values = []
    for value in grid:
        row = [0.0] * PIT_COLUMNS
        for code in SUBSYSTEM_CODES:
            level = value if code in ("N", "S") else 1.0 - value
            for hour in range(HOURS_PER_DAY):
                row[pit_column(code, hour)] = level
        values.append(row)
    matrix = a_matrix(values)
    mixtures = [a_mixture(p=0.9) for _ in range(HOURS_PER_DAY)]
    forecasts = a_day(matrix, dict.fromkeys(SUBSYSTEM_CODES, mixtures))
    national = national_day_grain(
        forecasts, expectations=flat_expectations(), origin=an_origin()
    )[0]
    summed_width = math.fsum(_width(day.day_total) for day in forecasts)
    assert summed_width > 0.0
    assert _width(national.day_total) < 0.6 * summed_width


def test_the_national_peak_is_a_peak_of_the_sum_and_not_a_sum_of_peaks() -> None:
    """Four subsystems that peak in four different hours never peak together.

    Each subsystem here curtails in exactly one hour of the day, and no two
    share it. ``Σ_s max_t`` is therefore a day that happened in no draw; the
    national peak is the largest of the four, hour by hour.
    """
    rows = 200
    grid = [(index + 0.5) / rows for index in range(rows)]
    matrix = a_matrix([[value] * PIT_COLUMNS for value in grid])
    quiet = a_mixture(p=0.0)
    mixtures_of: dict[Subsystem, list[HurdleMixture]] = {}
    for index, code in enumerate(SUBSYSTEM_CODES):
        hours = [quiet] * HOURS_PER_DAY
        hours[3 + 6 * index] = a_mixture(p=1.0)
        mixtures_of[code] = hours
    forecasts = a_day(matrix, mixtures_of)
    national = national_day_grain(
        forecasts, expectations=flat_expectations(), origin=an_origin()
    )[0]
    summed_peak = math.fsum(day.peak_power.p50 for day in forecasts)
    assert summed_peak > 0.0
    assert national.peak_power.p50 < summed_peak
    assert national.peak_power.p50 == pytest.approx(
        max(day.peak_power.p50 for day in forecasts), rel=1e-12
    )


def test_national_occurrence_is_counted_and_is_not_one_minus_the_product() -> None:
    """``1 − Π_s (1 − p_s)`` assumes the four subsystems are independent.

    They are perfectly dependent in this window, so the national day-level
    probability is one subsystem's — and the independence formula is nearly
    three times it.
    """
    rows = 200
    grid = [(index + 0.5) / rows for index in range(rows)]
    matrix = a_matrix([[value] * PIT_COLUMNS for value in grid])
    p = 0.3
    mixtures = [a_mixture(p=p) for _ in range(HOURS_PER_DAY)]
    forecasts = a_day(matrix, dict.fromkeys(SUBSYSTEM_CODES, mixtures))
    national = national_day_grain(
        forecasts, expectations=flat_expectations(), origin=an_origin()
    )[0]
    independent = 1.0 - math.prod(
        1.0 - day.day_occurrence_probability for day in forecasts
    )
    assert national.day_occurrence_probability == pytest.approx(p, abs=0.06)
    assert national.day_occurrence_probability < independent
    assert independent > 0.75


# --- Structural: what a national day is allowed to be -------------------------


def test_a_day_without_all_four_subsystems_is_not_national() -> None:
    """Three subsystems are a different quantity wearing the same name."""
    rows = 200
    matrix = a_matrix([[0.4] * PIT_COLUMNS for _ in range(rows)])
    mixtures = [a_mixture(p=0.6) for _ in range(HOURS_PER_DAY)]
    forecasts = a_day(matrix, dict.fromkeys(SUBSYSTEM_CODES, mixtures))
    partial = tuple(day for day in forecasts if day.subsystem != "S")
    assert (
        national_day_grain(partial, expectations=flat_expectations(), origin=an_origin())
        == ()
    )


def test_four_plans_are_four_different_days_added_together() -> None:
    """Sharing the draw index is the mechanism, so a second plan is refused."""
    rows = 200
    matrix = a_matrix([[(index % 97) / 97 for index in range(PIT_COLUMNS)]] * rows)
    mixtures = [a_mixture(p=0.6) for _ in range(HOURS_PER_DAY)]
    forecasts = list(a_day(matrix, dict.fromkeys(SUBSYSTEM_CODES, mixtures), seed=1))
    other = a_day(matrix, dict.fromkeys(SUBSYSTEM_CODES, mixtures), seed=99)
    forecasts[0] = other[0]
    assert forecasts[0].ensemble.plan != forecasts[1].ensemble.plan
    with pytest.raises(NationalError, match="share"):
        national_day_grain(
            forecasts, expectations=flat_expectations(), origin=an_origin()
        )


def test_a_subsystem_counted_twice_is_a_double_count_of_the_grid() -> None:
    rows = 200
    matrix = a_matrix([[0.4] * PIT_COLUMNS for _ in range(rows)])
    mixtures = [a_mixture(p=0.6) for _ in range(HOURS_PER_DAY)]
    forecasts = a_day(matrix, dict.fromkeys(SUBSYSTEM_CODES, mixtures))
    with pytest.raises(NationalError, match="double count"):
        national_day_grain(
            [*forecasts, forecasts[0]],
            expectations=flat_expectations(),
            origin=an_origin(),
        )


def test_an_expectation_is_never_estimated_from_the_draws() -> None:
    """A missing ``E[Y]`` refuses rather than falling back to a mean of draws."""
    rows = 200
    matrix = a_matrix([[0.4] * PIT_COLUMNS for _ in range(rows)])
    mixtures = [a_mixture(p=0.6) for _ in range(HOURS_PER_DAY)]
    forecasts = a_day(matrix, dict.fromkeys(SUBSYSTEM_CODES, mixtures))
    expectations = flat_expectations()
    del expectations[(A_DAY, "NE")]
    with pytest.raises(NationalError, match="adds exactly"):
        national_day_grain(forecasts, expectations=expectations, origin=an_origin())


def test_the_origin_is_wattsteer_and_the_run_label_is_the_artifact_id() -> None:
    origin = ForecastOrigin.of_artifact("2026-08-29T04:00:00Z")
    assert origin.producer == "wattsteer"
    assert origin.run_label == "2026-08-29T04:00:00Z"
    with pytest.raises(NationalError, match="does not produce"):
        ForecastOrigin(producer="open_meteo", run_label="D−1 12Z")
    with pytest.raises(NationalError, match="no run label"):
        ForecastOrigin(producer="wattsteer", run_label="  ")


def test_a_national_day_names_the_four_and_no_fifth_member() -> None:
    """``SIN`` is not a ``Subsystem``, and a national row cannot claim it is."""
    rows = 200
    matrix = a_matrix([[0.4] * PIT_COLUMNS for _ in range(rows)])
    mixtures = [a_mixture(p=0.6) for _ in range(HOURS_PER_DAY)]
    forecasts = a_day(matrix, dict.fromkeys(SUBSYSTEM_CODES, mixtures))
    national = national_day_grain(
        forecasts, expectations=flat_expectations(), origin=an_origin()
    )[0]
    assert national.subsystems == tuple(SUBSYSTEM_CODES)
    assert "SIN" not in SUBSYSTEM_CODES
    with pytest.raises(NationalError, match="derived sum over"):
        NationalDayGrain(
            target_date=national.target_date,
            threshold_mw=national.threshold_mw,
            origin=national.origin,
            day_total=national.day_total,
            peak_power=national.peak_power,
            day_occurrence_probability=national.day_occurrence_probability,
            expected_mwh=national.expected_mwh,
            subsystems=("N", "NE", "S"),
            plan=national.plan,
        )


def test_nothing_in_the_module_reads_an_ons_aggregate_row() -> None:
    """The national figure is derived from four subsystems, as a grep."""
    code = _without_docstrings(inspect.getsource(national_module))
    assert "SIN" not in code
    assert "balanco" not in code
    assert "sum_of_four" not in code


def _without_docstrings(source: str) -> str:
    """The code, with its prose removed. Ticket 07's helper, same reason."""
    parts = source.split('"""')
    return parts[0] + "".join(parts[2::2]) if len(parts) > 2 else source


# --- Measured on the shared fit -----------------------------------------------


def test_the_national_band_is_strictly_inside_the_summed_subsystem_bands(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """The ticket's headline inequality, on a real fit.

    The summed P90 is the total of a day on which all four subsystems
    simultaneously landed at their own ninetieth percentile, and that day is far
    rarer than one in ten. The summed P10 is the mirror.
    """
    days = day_grain_rows(trained.bundle, test_rows)
    nationals = national_day_grain(
        days,
        expectations=subsystem_day_expectations(forecast_rows(trained.bundle, test_rows)),
        origin=ForecastOrigin.of_artifact(trained.card.artifact_id),
    )
    assert nationals, "the fixture must produce at least one complete national day"
    for national in nationals:
        four = [day for day in days if day.target_date == national.target_date]
        assert len(four) == len(SUBSYSTEM_CODES)
        summed_p90 = math.fsum(day.day_total.p90 for day in four)
        summed_p10 = math.fsum(day.day_total.p10 for day in four)
        assert summed_p90 > 0.0
        assert national.day_total.p90 < summed_p90
        assert national.day_total.p10 > summed_p10
        assert _width(national.day_total) < math.fsum(
            _width(day.day_total) for day in four
        )


def test_the_national_median_is_not_the_componentwise_sum_of_four_medians(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """The number the landing hero used to show, and why it is not this one.

    The median of a sum is the sum of the medians only under comonotonicity. The
    fit's four subsystems are not comonotone, so the two figures differ on
    every day of it — and the assertion is on the difference rather than on its
    sign, because which way it falls is a property of the window rather than a
    law. A window whose subsystems really were comonotone would make the two
    agree, which is the boundary case tested above.
    """
    days = day_grain_rows(trained.bundle, test_rows)
    nationals = national_day_grain(
        days,
        expectations=subsystem_day_expectations(forecast_rows(trained.bundle, test_rows)),
        origin=ForecastOrigin.of_artifact(trained.card.artifact_id),
    )
    assert nationals
    for national in nationals:
        four = [day for day in days if day.target_date == national.target_date]
        summed_p50 = math.fsum(day.day_total.p50 for day in four)
        assert national.day_total.p50 != summed_p50


def test_the_national_expectation_is_exactly_the_sum_of_the_four(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """Expectations add exactly, so this is ``==`` and not an approximation."""
    expectations = subsystem_day_expectations(forecast_rows(trained.bundle, test_rows))
    nationals = national_rows(
        trained.bundle,
        test_rows,
        origin=ForecastOrigin.of_artifact(trained.card.artifact_id),
    )
    assert nationals
    for national in nationals:
        assert national.expected_mwh == math.fsum(
            expectations[(national.target_date, code)] for code in SUBSYSTEM_CODES
        )


def test_every_national_day_draws_under_the_one_shared_plan(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """Ticket 07's hand-back, consumed: one plan, 500 draws, the fit's days."""
    nationals = national_rows(
        trained.bundle,
        test_rows,
        origin=ForecastOrigin.of_artifact(trained.card.artifact_id),
    )
    plans = {national.plan for national in nationals}
    assert len(plans) == 1
    plan = plans.pop()
    assert plan.draws == ENSEMBLE_DRAWS
    assert plan.rows == trained.bundle.pit.rows
    assert plan.rows >= MIN_ENSEMBLE_DAYS


def test_the_same_seed_reproduces_the_same_national_band(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    origin = ForecastOrigin.of_artifact(trained.card.artifact_id)
    first = national_rows(trained.bundle, test_rows, origin=origin)
    again = national_rows(trained.bundle, test_rows, origin=origin)
    assert [day.as_row() for day in first] == [day.as_row() for day in again]


def test_the_national_row_says_how_it_was_derived(
    trained: TrainedFold, test_rows: list[dict[str, Any]]
) -> None:
    """`docs/specs/replay.md` forbids a day total rebuilt from an hourly band.

    ``derivation`` is what lets a reader of the database tell this row from one
    an earlier code path summed, and ``forecast_origin`` is what lets them tell
    which artifact drew it.
    """
    national = national_rows(
        trained.bundle,
        test_rows,
        origin=ForecastOrigin.of_artifact(trained.card.artifact_id),
    )[0]
    row = national.as_row()
    assert row["grain"] == "national"
    assert row["derivation"] == "joint_path_ensemble"
    assert row["forecast_origin"] == {
        "producer": "wattsteer",
        "run_label": trained.card.artifact_id,
    }
    assert row["subsystems"] == list(SUBSYSTEM_CODES)
    assert set(row["day_total"]) == {"p10", "p50", "p90"}
    assert row["ensemble_draws"] == ENSEMBLE_DRAWS
    assert row["expected_mwh"] == national.expected_mwh
    # The note names the regime the row was drawn under and the one limit that
    # is still inherited from the hour band — an hour whose `p <= 0.10` puts a
    # structural zero into every draw's ceiling. Before forecaster ticket 21 it
    # named an under-applied `delta_hi` instead, and a reader of the database
    # has to be able to tell the two statements apart from the row itself.
    assert CORRECTION_REGIME in row["upper_tail_note"]
    assert "point mass" in row["upper_tail_note"]


def test_the_dropped_day_rule_is_the_national_sample(
    trained: TrainedFold,
) -> None:
    """The cost inherited from ticket 07, as a number rather than a caveat.

    A national band needs all four subsystems on a row, which is the same
    all-96-cells rule that decides whether a calibration day is drawable at all.
    So the national ensemble resamples exactly the complete days and no others,
    and its effective sample is :attr:`PitMatrix.rows` — published on the card
    beside the count that was dropped, because a band drawn from a fraction of
    its window has a fraction of the window's dependence structure in it.
    """
    pit = trained.bundle.pit
    card = trained.card.to_dict()["ensemble"]
    assert card["pit_rows"] == pit.rows
    assert card["pit_dropped_days"] == pit.dropped_days
    window_days = (pit.window_end - pit.window_start).days + 1
    assert pit.rows + pit.dropped_days == window_days
    assert pit.rows >= MIN_ENSEMBLE_DAYS


def test_a_plan_over_the_complete_days_is_all_the_national_band_resamples(
    trained: TrainedFold,
) -> None:
    """500 draws over ``pit.rows`` distinct days — the sample, said plainly."""
    plan = DrawPlan.seeded(rows=trained.bundle.pit.rows)
    assert plan.draws == ENSEMBLE_DRAWS
    assert len(set(plan.indices)) <= trained.bundle.pit.rows
    assert all(0 <= index < trained.bundle.pit.rows for index in plan.indices)
