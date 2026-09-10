"""Five rungs, identical folds, one composition.

Every assertion here is structural — about which rows a rung was fitted on, which
column it read, whether its band came from the mixture inversion, and what the
table says about the imputation it was given. **None is about accuracy**, and
none could be: the rows are fixtures (`feature_row_fixtures.py` plus
`ladder_fixtures.py`), and only part of the real feature set exists in the
migration tree. Which rung wins on real data is a question this suite cannot ask
and deliberately does not.
"""

from __future__ import annotations

import inspect
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from conftest import FIXTURE_BACKGROUND_ROWS_PER_CELL, FUNCTION_DEFINITION
from ladder_fixtures import (
    EXCEEDANCE_COLUMN,
    SAME_HOUR_MEAN_COLUMN,
    rows_with_same_hour_features,
    without_exceedance,
)
from wattsteer_ml.evaluation import Fold, FoldBlocks, FoldSegment, stamp_fidelity
from wattsteer_ml.evaluation import ladder as ladder_module
from wattsteer_ml.evaluation.ladder import (
    NOT_THE_EXCEEDANCE_FEATURE,
    FoldRows,
    ForestRung,
    LadderError,
    LinearRung,
    MedianImputation,
    MissingBaselineFeatureError,
    PrevalenceRung,
    Rung,
    SameHourSevenDayRung,
    default_ladder,
    run_ladder,
    same_hour_fallback_rows,
)
from wattsteer_ml.evaluation.metrics import MetricsTable
from wattsteer_ml.mixture import SERVED_QUANTILES
from wattsteer_ml.training import OutOfFoldPool
from wattsteer_ml.training.hurdle import fit_sub_threshold_means

#: A forest small enough to fit in a test suite. The published configuration is
#: :class:`ForestRung`'s own defaults; this only makes the same code cheaper.
TEST_FOREST = ForestRung(trees=25, min_samples_leaf=25)


@pytest.fixture(scope="module")
def ladder_rows(blocks: FoldBlocks) -> list[dict[str, Any]]:
    """The shared fold's rows, carrying rung 1's two columns."""
    return rows_with_same_hour_features(first=blocks.base_fit_start, last=blocks.test_end)


@pytest.fixture(scope="module")
def fold_rows(
    ladder_rows: list[dict[str, Any]], fold: Fold, blocks: FoldBlocks
) -> FoldRows:
    return FoldRows.of(
        ladder_rows,
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
    )


@pytest.fixture(scope="module")
def segments(fold: Fold) -> tuple[FoldSegment, ...]:
    """One segment: the fold sits entirely after this fixture's go-live."""
    return stamp_fidelity(fold, None)


@pytest.fixture(scope="module")
def full_ladder(pool: OutOfFoldPool) -> tuple[Rung, ...]:
    """The five rungs, with the forest shrunk for the suite's sake."""
    published = default_ladder(
        function_definition=FUNCTION_DEFINITION,
        pool=pool,
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
    )
    return tuple(TEST_FOREST if rung.number == 3 else rung for rung in published)


@pytest.fixture(scope="module")
def table(
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    segments: tuple[FoldSegment, ...],
    full_ladder: tuple[Rung, ...],
) -> MetricsTable:
    return run_ladder(
        ladder_rows,
        fold=fold,
        blocks=blocks,
        segments=segments,
        run="A-full",
        rungs=full_ladder,
        function_definition=FUNCTION_DEFINITION,
        day_grain=False,
    )


# --- the ladder runs ---------------------------------------------------------


def test_all_five_rungs_produce_a_full_metrics_row_on_the_shared_fold(
    table: MetricsTable, blocks: FoldBlocks
) -> None:
    """One row per rung, every column populated, all on the same rows.

    The ticket's first box. What makes it a ladder rather than five numbers is
    the last assertion: every row covers the same segment and the same count of
    settled hours, so ``Δ qloss_mwh`` between any two of them is a statement
    about the models.
    """
    assert len(table) == 5
    assert sorted(row.rung_number for row in table.rows) == [0, 1, 2, 3, 4]
    counts = {row.rows for row in table.rows}
    assert len(counts) == 1
    for row in table.rows:
        assert row.run == "A-full"
        assert row.qloss_mwh > 0.0
        assert 0.0 <= row.prevalence <= 1.0
        assert row.pinball_10 >= 0.0
        assert row.interval_width_mean_mwh >= 0.0
        assert row.by_subsystem
        assert row.segment.test_start == blocks.test_start


def test_every_rung_is_compared_against_the_mandatory_baseline(
    table: MetricsTable,
) -> None:
    """Rung 1 is the cold-start bar, so every rung has a delta against it."""
    for rung in (
        "prevalence",
        "logistic_quantile_regression",
        "random_forest",
        "lightgbm",
    ):
        deltas = table.delta_against(run="A-full", rung=rung, baseline="same_hour_7d")
        assert set(deltas) == {row.row_id for row in table.where(rung=rung)}


def test_every_rungs_band_is_the_mixture_inversion(
    fold_rows: FoldRows, full_ladder: tuple[Rung, ...]
) -> None:
    """``Q_Y(q) = 0`` for ``q ≤ 1 − p``, on every rung including the base rate.

    The ticket's second box. A rung that had multiplied ``p`` by a magnitude —
    or that had been given a quantile function of its own — could not reproduce
    this table, because ``p × E[Y | Y > τ]`` is non-zero wherever ``p`` is.
    """
    sample = fold_rows.test_rows[:400]
    for rung in full_ladder:
        for hour in rung.fit(fold_rows).forecasts(sample):
            forecast = hour.forecast
            p = forecast.occurrence_probability
            band = (forecast.band.p10, forecast.band.p50, forecast.band.p90)
            for quantile, value in zip(SERVED_QUANTILES, band, strict=True):
                if quantile <= 1.0 - p:
                    assert value == 0.0, rung.name
                else:
                    assert value > forecast.mixture.threshold_mwh, rung.name


def test_the_sub_threshold_constant_is_the_same_on_every_rung(
    fold_rows: FoldRows, full_ladder: tuple[Rung, ...]
) -> None:
    """``μ_sub`` is not one of the things that separates a rung from the next.

    Every rung takes it from the same base-fit block through the same function,
    so a difference between two rungs' expectations in a quiet hour is a
    difference between the two models and not between two sub-threshold means.
    """
    expected = fit_sub_threshold_means(fold_rows.base_fit)
    quiet = [row for row in fold_rows.test_rows if row["target_date"] is not None][:96]
    for rung in full_ladder:
        for hour in rung.fit(fold_rows).forecasts(quiet):
            assert hour.forecast.mixture.sub_threshold_mean_mwh == pytest.approx(
                expected.mean_for(hour.key.subsystem, hour.key.local_hour)
            )


def test_a_split_fold_produces_two_rows_per_rung_and_never_one_averaged(
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
) -> None:
    """The fold that straddles ingestion go-live is reported twice.

    Two rows from **one** fitted model, differing only in the rows they cover.
    :class:`MetricsTable` then refuses any table in which one of the two is
    missing, which is the shape "the caveat disappeared" takes.
    """
    boundary = blocks.test_start + timedelta(days=3)
    segments = stamp_fidelity(
        fold,
        datetime.combine(boundary, time(0), tzinfo=ZoneInfo("America/Sao_Paulo")),
    )
    assert fold.test_start < boundary <= fold.test_end
    assert len(segments) == 2
    table = run_ladder(
        ladder_rows,
        fold=fold,
        blocks=blocks,
        segments=segments,
        run="A-full",
        rungs=(PrevalenceRung(), SameHourSevenDayRung()),
        function_definition=FUNCTION_DEFINITION,
        day_grain=False,
    )
    assert len(table) == 4
    fidelities = {row.fidelity for row in table.where(rung="prevalence")}
    assert fidelities == {"revision_optimistic", "point_in_time"}
    with pytest.raises(Exception, match="do not share a vintage"):
        table.pooled_qloss(run="A-full", rung="prevalence")


# --- rung 1, and the column that is not there --------------------------------


def test_rung_one_reads_the_feature_functions_two_columns(
    fold_rows: FoldRows,
) -> None:
    """Both heads come from ``feature_row``, so neither can disagree with it.

    The occurrence head reads the exceedance frequency and the magnitude head
    the same-hour mean; the assertion is that a change to either column changes
    the band, which is only true if the rung is reading them.
    """
    fitted = SameHourSevenDayRung().fit(fold_rows)
    sample = [dict(row) for row in fold_rows.test_rows[:96]]
    with_history = [
        row
        for row in sample
        if row[EXCEEDANCE_COLUMN] is not None and row[SAME_HOUR_MEAN_COLUMN] is not None
    ]
    assert with_history, "the fixture must carry rows with seven days behind them"
    before = fitted.forecasts(with_history)
    doubled = [
        {**row, SAME_HOUR_MEAN_COLUMN: row[SAME_HOUR_MEAN_COLUMN] * 3.0 + 50.0}
        for row in with_history
    ]
    after = fitted.forecasts(doubled)
    assert any(
        one.forecast.band.p90 != other.forecast.band.p90
        for one, other in zip(before, after, strict=True)
    )


def test_rung_one_refuses_when_the_exceedance_column_is_absent(
    ladder_rows: list[dict[str, Any]], fold: Fold, blocks: FoldBlocks
) -> None:
    """A contract older than the column, and it is a refusal.

    `docs/specs/feature-engineering.md` specifies
    ``observed_constrained_off_same_hour_exceedance_7d`` and
    `0036_the_same_hour_exceedance.sql` emits it — so a contract without it was
    built against an earlier feature function, which is exactly the artifact
    that must not be scored as though it were current. The mandatory baseline
    says so instead of quietly substituting a neighbouring column, and the
    message names the migration that settles it.
    """
    stripped = FoldRows.of(
        without_exceedance(ladder_rows),
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
    )
    with pytest.raises(MissingBaselineFeatureError) as raised:
        SameHourSevenDayRung().fit(stripped)
    message = str(raised.value)
    assert EXCEEDANCE_COLUMN in message
    assert "0036_the_same_hour_exceedance.sql" in message
    assert NOT_THE_EXCEEDANCE_FEATURE in message


def test_rung_one_never_reads_the_hours_above_threshold_column() -> None:
    """It counts all hours over seven days, not seven observations of one hour.

    Named in the module only as the column that must not be substituted, and
    asserted here against the source so that a later convenience cannot make it
    the thing rung 1 actually reads.
    """
    source = _without_docstrings(inspect.getsource(ladder_module))
    assert NOT_THE_EXCEEDANCE_FEATURE not in source.replace(
        'NOT_THE_EXCEEDANCE_FEATURE = "observed_constrained_off_hours_above_'
        'threshold_7d"',
        "",
    )


def test_rung_one_falls_back_to_the_base_rate_and_the_fallback_is_counted(
    fold_rows: FoldRows,
) -> None:
    """A lag that does not clear the cutoff is NULL, and rung 1 says so.

    The first days of a window have no seven-day history. Rung 1 answers those
    hours from rung 0's constants — a stated fallback, not an imputation — and
    :func:`same_hour_fallback_rows` publishes how many of them there were.
    """
    first_day = [
        row
        for row in fold_rows.base_fit_rows
        if row["target_date"] == fold_rows.blocks.base_fit_start
    ]
    assert first_day
    assert same_hour_fallback_rows(fold_rows, first_day) == len(first_day)
    assert same_hour_fallback_rows(fold_rows, fold_rows.test_rows) == 0


# --- the imputation asymmetry ------------------------------------------------


def test_rungs_two_and_three_are_marked_as_imputed_and_the_others_are_not(
    table: MetricsTable,
) -> None:
    """The ticket's fourth box, as the table publishes it."""
    imputed = {row.rung for row in table.rows if row.imputed}
    assert imputed == {"logistic_quantile_regression", "random_forest"}
    served = table.where(rung="lightgbm")[0]
    assert not served.imputed
    assert served.calibrated and served.conformalised
    assert served.delta_lo is not None and served.delta_hi is not None
    for row in table.rows:
        if row.rung != "lightgbm":
            assert not row.calibrated and not row.conformalised
            assert row.delta_lo is None and row.delta_hi is None


def test_the_imputation_adds_an_explicit_indicator_for_every_nullable_column(
    fold_rows: FoldRows,
) -> None:
    """Median fill *plus* ``_is_null``, and the fill is the training median.

    Without the indicator the fill would destroy the one signal the feature
    spec's cutoff encodes; with it, the weak rungs see the same information the
    LightGBM path sees natively.
    """
    base_fit = fold_rows.base_fit
    labelled = base_fit.select(base_fit.labelled)
    imputation = MedianImputation.fit(labelled)
    indicators = [name for name in imputation.feature_names if name.endswith("_is_null")]
    assert indicators
    assert all(
        name.removesuffix("_is_null") in imputation.source_names for name in indicators
    )
    transformed = imputation.transform(labelled)
    assert transformed.shape[0] == len(labelled)
    assert not bool((transformed != transformed).any())


def test_the_imputation_refuses_a_block_from_another_contract(
    fold_rows: FoldRows,
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
) -> None:
    """A vector of floats means nothing without the list that ordered it."""
    other = FoldRows.of(
        without_exceedance(ladder_rows),
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
    )
    imputation = MedianImputation.fit(fold_rows.base_fit)
    with pytest.raises(LadderError, match="different contract"):
        imputation.transform(other.base_fit)


# --- the discipline ----------------------------------------------------------


def test_the_ladder_holds_no_composition_of_its_own() -> None:
    """Every rung reaches the band through ``compose_estimates`` and nothing else.

    ``training/hurdle.py`` is the only module that calls
    :func:`wattsteer_ml.mixture.compose`, which
    :mod:`tests.test_conformal_quantiles` asserts across the whole service. This
    is the local half: no rung builds a mixture, a band or a quantile of its own.
    """
    source = _without_docstrings(inspect.getsource(ladder_module))
    for reimplementation in (
        "QuantileBand(",
        "HurdleMixture(",
        "1.0 - p",
        "occurrence_probability *",
    ):
        assert reimplementation not in source


def test_a_rung_cannot_be_fitted_on_rows_from_outside_the_fold(
    ladder_rows: list[dict[str, Any]], fold: Fold, blocks: FoldBlocks
) -> None:
    """The split is the trainer's own, so a stray row is refused there."""
    stray = dict(ladder_rows[0])
    stray["target_date"] = blocks.test_end + timedelta(days=30)
    with pytest.raises(ValueError, match="none of this fold's three blocks"):
        FoldRows.of(
            [*ladder_rows, stray],
            fold=fold,
            blocks=blocks,
            function_definition=FUNCTION_DEFINITION,
        )


def test_the_ladder_is_five_rungs_and_the_tft_benchmark_is_absent(
    pool: OutOfFoldPool,
) -> None:
    """Rung 5 is a benchmark that is never served, so it is not on the ladder."""
    rungs = default_ladder(
        function_definition=FUNCTION_DEFINITION,
        pool=pool,
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
    )
    assert [rung.number for rung in rungs] == [0, 1, 2, 3, 4]
    assert [rung.name for rung in rungs] == [
        "prevalence",
        "same_hour_7d",
        "logistic_quantile_regression",
        "random_forest",
        "lightgbm",
    ]


def test_a_rung_with_no_curtailed_base_fit_hour_refuses_rather_than_invents(
    fold_rows: FoldRows,
) -> None:
    """A statement about the data, not a configuration to relax."""
    quiet = FoldRows.of(
        [
            {
                **row,
                "y_constrained_off_total_mwh": 0.0,
                "y_has_curtailment": False,
                "y_magnitude_mwh": None,
            }
            for row in fold_rows.rows
        ],
        fold=fold_rows.fold,
        blocks=fold_rows.blocks,
        function_definition=FUNCTION_DEFINITION,
    )
    for rung in (PrevalenceRung(), LinearRung(), TEST_FOREST):
        with pytest.raises(LadderError, match="above τ"):
            rung.fit(quiet)


# --- the day-grain figures ---------------------------------------------------


def test_the_day_grain_figures_are_measured_for_a_baseline_rung(
    ladder_rows: list[dict[str, Any]],
    fold: Fold,
    blocks: FoldBlocks,
    segments: tuple[FoldSegment, ...],
) -> None:
    """``day_total_coverage`` and ``peak_coverage`` come from the rung's own band.

    Drawn through the path ensemble from a PIT matrix fitted on this rung's
    composed band over the calibration window — never by summing the hourly
    quantiles, which is the invariant `docs/specs/forecaster.md` names as the
    one most likely to be broken by a well-meaning optimisation.
    """
    table = run_ladder(
        ladder_rows,
        fold=fold,
        blocks=blocks,
        segments=segments,
        run="A-full",
        rungs=(PrevalenceRung(),),
        function_definition=FUNCTION_DEFINITION,
        day_grain=True,
    )
    row = table.rows[0]
    assert row.day_grain is not None
    assert row.day_grain.days > 0
    assert 0.0 <= row.day_grain.day_total_coverage <= 1.0
    assert 0.0 <= row.day_grain.peak_coverage <= 1.0
    published = row.as_card_entry()
    assert published["day_total_coverage"] == row.day_grain.day_total_coverage


# --- the ticket-011 block ----------------------------------------------------


def test_every_row_carries_the_number_ticket_011_is_owed(table: MetricsTable) -> None:
    """The six figures, per fold and per subsystem, on every rung's row."""
    for row in table.rows:
        assert row.collapse is not None
        pooled = row.collapse.pooled
        assert 0.0 <= pooled.share_of_days_with_no_non_zero_p50_hour <= 1.0
        assert 0.0 <= pooled.share_of_hours_with_p50_zero <= 1.0
        assert 0.0 <= pooled.share_with_p10_zero <= 1.0
        assert pooled.hours_per_day_p_ge_50.p25 <= pooled.hours_per_day_p_ge_50.p75
        assert row.share_p50_zero == pooled.share_of_hours_with_p50_zero
        assert {cell.label for cell in row.collapse.by_subsystem}


def _without_docstrings(source: str) -> str:
    """The code, with its prose removed.

    The prose here explains at length what this module deliberately does not do,
    which is exactly the vocabulary a naive grep trips over.
    """
    parts = source.split('"""')
    return parts[0] + "".join(parts[2::2]) if len(parts) > 2 else source
