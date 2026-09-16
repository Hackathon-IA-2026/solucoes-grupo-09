"""The baseline ladder: five rungs, identical folds, one composition.

`docs/specs/forecaster.md`, "The baseline ladder". Every rung is evaluated on
identical folds, identical rows, the same threshold and **the same composition
arithmetic** — a rung that cannot naturally produce a quantile still produces
one, by the same mixture inversion, because the ladder compares models and not
model families' conventions.

| # | Rung | Occurrence | Magnitude |
|---|---|---|---|
| 0 | :class:`PrevalenceRung` | the base rate | the positives' empirical quantiles |
| 1 | :class:`SameHourSevenDayRung` | same-hour exceedance | the same-hour 7-day mean |
| 2 | :class:`LinearRung` | L2 logistic | quantile regression |
| 3 | :class:`ForestRung` | random forest | quantile forest |
| 4 | :class:`LightGbmRung` | the served model | the served model |

Rung 5 (TFT) is a benchmark that is never served and is deliberately absent.

**One composition, and this module holds none of it.** Every rung produces
:class:`~wattsteer_ml.training.hurdle.HourEstimates` — six scalars per row — and
hands them to :func:`~wattsteer_ml.training.hurdle.compose_estimates`. Nothing
here calls :func:`wattsteer_ml.mixture.compose` — it has one call site in the
whole service, in ``training/hurdle.py``, and
:mod:`tests.test_conformal_quantiles` asserts it. So the prevalence rung's band
and LightGBM's band are built by the same arithmetic, which is the only way
``Δ qloss_mwh`` between two rungs is a statement about the models.

**``μ_sub`` is shared, and that is deliberate.** Every rung takes
:func:`~wattsteer_ml.training.hurdle.fit_sub_threshold_means` over the same
base-fit block, so the sub-threshold constant is not one of the things that
separates a rung from the one above it. A ladder in which rung 0 and rung 4
disagreed about ``μ_sub`` would be measuring that disagreement in the
expectation of every quiet hour.

**Missing values are handled differently by rung, and the asymmetry is
deliberate.** Nothing on the LightGBM path is imputed — the feature spec makes
unavailability *meaningful*, and a median fill would replace that signal with a
plausible number. Rungs 2 and 3 cannot take NaN, so they get
:class:`MedianImputation`: training-median fill **plus an explicit
``_is_null`` indicator column**, and :attr:`MetricsRow.imputed
<wattsteer_ml.evaluation.metrics.MetricsRow.imputed>` marks them. Rungs 0 and 1
read no matrix column that could be missing except the two the feature function
computes for them, and what happens when *those* are NULL is
:class:`SameHourSevenDayRung`'s stated fallback rather than an imputation.

**What rungs 0–3 do not get, stated rather than hidden.** No isotonic map and no
conformal correction. Those are the served pipeline, and granting them to a
baseline would make ``Δ qloss_mwh`` between rung 3 and rung 4 partly a
measurement of the calibrator. ``qloss_mwh`` is a proper scoring rule, so an
uncalibrated rung simply scores worse — which is a true property of that rung.
:attr:`MetricsRow.calibrated <wattsteer_ml.evaluation.metrics.MetricsRow.\
calibrated>` and :attr:`MetricsRow.conformalised
<wattsteer_ml.evaluation.metrics.MetricsRow.conformalised>` say which rungs had
them, per row, so no reader has to know this paragraph exists.

**Rung 1's occurrence head, and the column it insists on by name.** The spec
gives rung 1 two columns, one per head of the hurdle, and requires both to be
"computed *from the feature function*, so it and the model cannot disagree about
what the last seven days means". The magnitude head reads
``observed_constrained_off_same_hour_mean_7d``, which
`apps/api/drizzle/0021_lagged_actuals_behind_the_cutoff.sql` built. The
occurrence head needs ``observed_constrained_off_same_hour_exceedance_7d`` — the
share of the seven same-local-hour observations at or above ``threshold_mw`` —
which `docs/specs/feature-engineering.md` adds and which
`apps/api/drizzle/0036_the_same_hour_exceedance.sql` made the 112th attribute of
``feature_row``. When this module was written the feature function did not emit
it, and rung 1 was built and tested but could not run against the live one.

That is no longer the tree's state, and the refusal stays anyway. This module
reads the column **by name** and :class:`MissingBaselineFeatureError` refuses
when a contract does not carry it — which now means a contract built against a
feature function older than `0036`, exactly the artifact a hot-swap gate must
not silently score. It does **not** substitute
``observed_constrained_off_hours_above_threshold_7d``, which counts all hours
across seven days rather than the seven observations of one local hour, and
would make rung 1 a different baseline wearing rung 1's name — the shape of
failure a silent substitution would have hidden.
"""

from __future__ import annotations

import warnings
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, Protocol

import numpy as np
import numpy.typing as npt
import statsmodels.api as sm
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.linear_model import LogisticRegression
from statsmodels.tools.sm_exceptions import (
    ConvergenceWarning,
    IterationLimitWarning,
)

from wattsteer_ml.constants import Subsystem
from wattsteer_ml.evaluation.folds import Fold, FoldBlocks
from wattsteer_ml.evaluation.metrics import MetricsRow, MetricsTable
from wattsteer_ml.evaluation.vintage import FoldSegment
from wattsteer_ml.mixture import FITTED_ALPHAS, HurdleMixture
from wattsteer_ml.training.background import BACKGROUND_ROWS_PER_CELL
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.calibration import OutOfFoldPool
from wattsteer_ml.training.conformal import ConformalCorrection, ScoredHour
from wattsteer_ml.training.contract import FeatureContract
from wattsteer_ml.training.design import TOTAL_COLUMN, FeatureBlock, RowStamp
from wattsteer_ml.training.ensemble import (
    DayGrainCoverage,
    EnsembleError,
    draw_day_grain,
    fit_pit_matrix,
)
from wattsteer_ml.training.hurdle import (
    HourEstimates,
    HourForecast,
    compose_estimates,
    fit_sub_threshold_means,
    forecast_rows,
    partition_rows,
    train_fold,
)
from wattsteer_ml.training.hyperparameters import MODEL_CONFIG_V1, ModelConfig

#: Rung 1's **occurrence** head. `docs/specs/feature-engineering.md` specifies
#: it and migration 0036 emits it. See the module docstring for why the refusal
#: below outlived the absence that motivated it.
EXCEEDANCE_FEATURE = "observed_constrained_off_same_hour_exceedance_7d"

#: Rung 1's **magnitude** head. Built by migration 0021.
SAME_HOUR_MEAN_FEATURE = "observed_constrained_off_same_hour_mean_7d"

#: The column rung 1 must **not** be built from. It counts every hour above
#: ``threshold_mw`` across the trailing seven days, which is a different
#: quantity from the exceedance frequency of one local hour and would make the
#: mandatory baseline a weaker one wearing its name.
NOT_THE_EXCEEDANCE_FEATURE = "observed_constrained_off_hours_above_threshold_7d"

#: The suffix rungs 2 and 3 append for the explicit null-indicator columns.
NULL_INDICATOR_SUFFIX = "_is_null"


class LadderError(ValueError):
    """A rung cannot be fitted or scored on the rows it was given."""


class MissingBaselineFeatureError(LadderError):
    """The mandatory 7-day baseline has no column to read.

    Raised rather than worked around. `docs/specs/forecaster.md` makes rung 1 the
    cold-start bar for the hot-swap gate and requires it to come from the
    feature function; a rung 1 computed from a query of this module's own would
    be a second opinion about "the last seven days", and one computed from a
    neighbouring column would be a different baseline under the same name.
    """


class RungFit(Protocol):
    """A fitted rung: rows in, composed bands out.

    Deliberately the same shape as
    :func:`~wattsteer_ml.training.hurdle.forecast_rows`, so rung 4 is that
    function with its bundle bound and nothing else.
    """

    def forecasts(
        self, rows: Sequence[Mapping[str, Any]]
    ) -> tuple[HourForecast, ...]: ...


class Rung(Protocol):
    """One step of the ladder: what it is called, and how it is fitted."""

    @property
    def number(self) -> int: ...

    @property
    def name(self) -> str: ...

    @property
    def imputed(self) -> bool: ...

    @property
    def calibrated(self) -> bool: ...

    @property
    def conformalised(self) -> bool: ...

    def fit(self, fold_rows: FoldRows) -> RungFit: ...

    def correction(self, fitted: RungFit) -> ConformalCorrection | None: ...


@dataclass(frozen=True)
class FoldRows:
    """One fold's rows, split once and shared by every rung.

    The split is :func:`~wattsteer_ml.training.hurdle.partition_rows` — the same
    function :func:`~wattsteer_ml.training.hurdle.train_fold` uses — so the
    ladder's base fit and the served model's are the same rows by construction
    rather than by two implementations that agree today.

    The contract is derived from the base-fit rows exactly as ``train_fold``
    derives it, and every rung encodes against **that** contract, so a rung
    cannot be scored in a feature space of its own.
    """

    fold: Fold
    blocks: FoldBlocks
    contract: FeatureContract
    threshold_mw: float
    rows: tuple[Mapping[str, Any], ...]
    base_fit_rows: tuple[Mapping[str, Any], ...]
    calibration_rows: tuple[Mapping[str, Any], ...]
    test_rows: tuple[Mapping[str, Any], ...]

    @classmethod
    def of(
        cls,
        rows: Sequence[Mapping[str, Any]],
        *,
        fold: Fold,
        blocks: FoldBlocks,
        function_definition: str,
    ) -> FoldRows:
        stamp = RowStamp.of(rows)
        base_fit, calibration, test = partition_rows(rows, blocks)
        if not base_fit:
            raise LadderError(
                f"{fold.id}: the base-fit block "
                f"{blocks.base_fit_start.isoformat()}–"
                f"{blocks.base_fit_end.isoformat()} contains no rows, so no rung "
                "of the ladder has anything to be fitted on"
            )
        return cls(
            fold=fold,
            blocks=blocks,
            contract=FeatureContract.of(
                base_fit, function_definition=function_definition
            ),
            threshold_mw=stamp.threshold_mw,
            rows=tuple(rows),
            base_fit_rows=tuple(base_fit),
            calibration_rows=tuple(calibration),
            test_rows=tuple(test),
        )

    def block(self, rows: Sequence[Mapping[str, Any]]) -> FeatureBlock:
        """Encode rows against **this fold's** contract and threshold."""
        return FeatureBlock.of(rows, self.contract, threshold_mw=self.threshold_mw)

    @property
    def base_fit(self) -> FeatureBlock:
        return self.block(self.base_fit_rows)

    def segment_rows(self, segment: FoldSegment) -> tuple[Mapping[str, Any], ...]:
        """This segment's test rows. A split fold's two halves never overlap."""
        return tuple(
            row
            for row in self.test_rows
            if segment.test_start <= row["target_date"] <= segment.test_end
        )


@dataclass(frozen=True)
class BaselineConstants:
    """Rung 0's whole model, and rung 1's fallback for a NULL feature.

    Six numbers fitted on the base-fit block's settled hours: the base rate, the
    empirical 0.10/0.50/0.90 quantiles of the curtailed hours' totals, their
    mean, and their mean wind share. It is a real hurdle — it just has no
    covariates — which is what lets it be composed by the same inversion as
    every rung above it and gives PR-AUC the floor the spec asks for.
    """

    probability: float
    q10: float
    q50: float
    q90: float
    positive_mean_mwh: float
    wind_share: float | None

    @classmethod
    def of(cls, block: FeatureBlock) -> BaselineConstants:
        labelled = block.select(block.labelled)
        if not len(labelled):
            raise LadderError(
                "the base-fit block carries no settled label; a base rate over "
                "no observation is not a base rate"
            )
        positives = labelled.select(labelled.positive)
        if not len(positives):
            raise LadderError(
                "no base-fit hour is above τ, so there is no conditional "
                "magnitude distribution for even the prevalence rung to hold; "
                "this is a statement about the data, not a bar to relax"
            )
        totals = positives.total_mwh
        quantiles = [float(np.quantile(totals, alpha)) for alpha in FITTED_ALPHAS]
        return cls(
            probability=len(positives) / len(labelled),
            q10=quantiles[0],
            q50=quantiles[1],
            q90=quantiles[2],
            positive_mean_mwh=float(np.mean(totals)),
            wind_share=_mean_wind_share(positives),
        )

    def estimates(self) -> HourEstimates:
        return HourEstimates(
            occurrence_probability=self.probability,
            q10=self.q10,
            q50=self.q50,
            q90=self.q90,
            positive_mean_mwh=self.positive_mean_mwh,
            wind_share=self.wind_share,
        )


@dataclass(frozen=True)
class ConstantFit:
    """Rung 0, fitted: one set of estimates, repeated for every row."""

    fold_rows: FoldRows
    constants: BaselineConstants
    sub_threshold_means: SubThresholdMeans

    def forecasts(self, rows: Sequence[Mapping[str, Any]]) -> tuple[HourForecast, ...]:
        block = self.fold_rows.block(rows)
        return compose_estimates(
            block.keys,
            [self.constants.estimates()] * len(block.keys),
            sub_threshold_means=self.sub_threshold_means,
            threshold_mw=self.fold_rows.threshold_mw,
        )


@dataclass(frozen=True)
class PrevalenceRung:
    """Rung 0 — the base rate, and PR-AUC's floor.

    On the ladder because PR-AUC is not comparable across datasets without its
    prevalence beside it, and because a rung that predicts one number for every
    hour is the honest zero point for ``Δ qloss_mwh``.
    """

    number: int = 0
    name: str = "prevalence"
    imputed: bool = False
    calibrated: bool = False
    conformalised: bool = False

    def fit(self, fold_rows: FoldRows) -> RungFit:
        base_fit = fold_rows.base_fit
        return ConstantFit(
            fold_rows=fold_rows,
            constants=BaselineConstants.of(base_fit),
            sub_threshold_means=fit_sub_threshold_means(base_fit),
        )

    def correction(self, fitted: RungFit) -> ConformalCorrection | None:
        return None


@dataclass(frozen=True)
class SameHourFit:
    """Rung 1, fitted: the feature function's two columns, read by name."""

    fold_rows: FoldRows
    exceedance_index: int
    mean_index: int
    fallback: BaselineConstants
    sub_threshold_means: SubThresholdMeans

    def forecasts(self, rows: Sequence[Mapping[str, Any]]) -> tuple[HourForecast, ...]:
        block = self.fold_rows.block(rows)
        estimates: list[HourEstimates] = []
        for index in range(len(block.keys)):
            exceedance = float(block.matrix[index, self.exceedance_index])
            same_hour_mean = float(block.matrix[index, self.mean_index])
            if np.isnan(exceedance) or np.isnan(same_hour_mean):
                estimates.append(self.fallback.estimates())
                continue
            magnitude = max(0.0, same_hour_mean)
            estimates.append(
                HourEstimates(
                    occurrence_probability=min(1.0, max(0.0, exceedance)),
                    q10=magnitude,
                    q50=magnitude,
                    q90=magnitude,
                    positive_mean_mwh=magnitude,
                    wind_share=self.fallback.wind_share,
                )
            )
        return compose_estimates(
            block.keys,
            estimates,
            sub_threshold_means=self.sub_threshold_means,
            threshold_mw=self.fold_rows.threshold_mw,
        )


def same_hour_fallback_rows(
    fold_rows: FoldRows, rows: Sequence[Mapping[str, Any]]
) -> int:
    """How many of these rows rung 1 answered from the base rate instead.

    Published rather than buried. A lag that does not clear ``actuals_cutoff``
    is NULL because it was not knowable, and a baseline that silently filled it
    would be a baseline with an imputation policy — the one thing the feature
    spec's no-imputation rule is about. The fallback is rung 0's constants,
    counted here so a reader can see how much of rung 1 is actually rung 0.
    """
    return sum(
        1
        for row in rows
        if row.get(EXCEEDANCE_FEATURE) is None or row.get(SAME_HOUR_MEAN_FEATURE) is None
    )


@dataclass(frozen=True)
class SameHourSevenDayRung:
    """Rung 1 — the mandatory same-hour 7-day baseline, from the feature function.

    The baseline a domain expert would actually use, and the cold-start bar for
    the hot-swap gate. Its two heads are two columns of ``feature_row``, read by
    name: the occurrence head is the exceedance frequency at the same local hour
    over the seven available days ending at the cutoff, and the magnitude head
    is the mean over the same seven observations.

    **The magnitude head is a point mass, composed like everything else.** Three
    equal knots, so ``Q_pos`` is the constant the seven-day mean names, and the
    mixture inversion then places it above or below the breakpoint according to
    ``p``. The rung has no quantile of its own and does not need one; the ladder
    compares models, not model families' conventions.

    **When the exceedance column is absent**, :meth:`fit` raises
    :class:`MissingBaselineFeatureError`. See the module docstring for why nothing
    is substituted for it.
    """

    number: int = 1
    name: str = "same_hour_7d"
    imputed: bool = False
    calibrated: bool = False
    conformalised: bool = False

    def fit(self, fold_rows: FoldRows) -> RungFit:
        names = fold_rows.contract.feature_names
        missing = [
            column
            for column in (EXCEEDANCE_FEATURE, SAME_HOUR_MEAN_FEATURE)
            if column not in names
        ]
        if missing:
            raise MissingBaselineFeatureError(
                f"{fold_rows.fold.id}: the mandatory 7-day baseline needs "
                f"{missing!r} from the feature function and the contract does "
                f"not carry {'them' if len(missing) > 1 else 'it'}. "
                f"{EXCEEDANCE_FEATURE!r} is specified in "
                "docs/specs/feature-engineering.md and landed in "
                "apps/api/drizzle/0036_the_same_hour_exceedance.sql, so a "
                "contract without it was built against a feature function "
                "older than that migration. It is not "
                f"{NOT_THE_EXCEEDANCE_FEATURE!r}, which counts all hours across "
                "seven days rather than the seven observations of one local "
                "hour, and substituting it would publish a different baseline "
                "under rung 1's name"
            )
        base_fit = fold_rows.base_fit
        return SameHourFit(
            fold_rows=fold_rows,
            exceedance_index=names.index(EXCEEDANCE_FEATURE),
            mean_index=names.index(SAME_HOUR_MEAN_FEATURE),
            fallback=BaselineConstants.of(base_fit),
            sub_threshold_means=fit_sub_threshold_means(base_fit),
        )

    def correction(self, fitted: RungFit) -> ConformalCorrection | None:
        return None


@dataclass(frozen=True)
class MedianImputation:
    """Training-median fill **plus** an explicit ``_is_null`` indicator column.

    `docs/specs/forecaster.md`: rungs 2 and 3 cannot take NaN, so they get this
    and the metrics table marks them. The indicator is what makes the treatment
    honest rather than lossy — the feature spec makes unavailability meaningful,
    and a median fill without an indicator destroys exactly that signal. **A
    ladder that quietly gave the weak rungs a different feature vector would be
    measuring the imputation.**

    Three properties of this implementation are decisions:

    - **Only columns that were NULL somewhere in the base-fit block get an
      indicator.** A column with no NULLs would get a constant-zero indicator,
      which is a column of zeros a linear model spends a coefficient on and a
      forest spends split candidates on.
    - **An all-NULL column's median is 0.0.** It carries no information either
      way; :attr:`~wattsteer_ml.training.contract.FeatureContract.unpopulated`
      already names such columns, and its indicator is constant, so it is
      dropped by the next rule.
    - **Zero-variance columns are dropped after filling**, and their names are
      published in :attr:`dropped`. A constant column makes the quantile
      regression's design singular; it cannot carry signal, so dropping it is
      not a modelling choice the ladder is making on the rung's behalf.
    """

    #: The contract's feature names, in order — what :meth:`transform` expects.
    source_names: tuple[str, ...]
    medians: tuple[float, ...]
    #: Indices into :attr:`source_names` that get an indicator column.
    indicated: tuple[int, ...]
    #: Indices into the filled-plus-indicator matrix that survive the variance
    #: filter, in order.
    kept: tuple[int, ...]
    dropped: tuple[str, ...]

    @property
    def feature_names(self) -> tuple[str, ...]:
        """The rung's own column names — the vector it actually sees."""
        widened = self.source_names + tuple(
            f"{self.source_names[index]}{NULL_INDICATOR_SUFFIX}"
            for index in self.indicated
        )
        return tuple(widened[index] for index in self.kept)

    @classmethod
    def fit(cls, block: FeatureBlock) -> MedianImputation:
        names = block.contract.feature_names
        matrix = block.matrix
        if not len(block):
            raise LadderError("an imputation fitted on no row")
        medians: list[float] = []
        indicated: list[int] = []
        for index in range(matrix.shape[1]):
            column = matrix[:, index]
            present = column[~np.isnan(column)]
            medians.append(0.0 if not present.size else float(np.median(present)))
            if present.size != column.size:
                indicated.append(index)
        widened = _widen(matrix, medians=tuple(medians), indicated=tuple(indicated))
        variance = widened.max(axis=0) - widened.min(axis=0)
        kept = tuple(int(index) for index in np.flatnonzero(variance > 0.0))
        widened_names = names + tuple(
            f"{names[index]}{NULL_INDICATOR_SUFFIX}" for index in indicated
        )
        return cls(
            source_names=names,
            medians=tuple(medians),
            indicated=tuple(indicated),
            kept=kept,
            dropped=tuple(
                name for index, name in enumerate(widened_names) if index not in set(kept)
            ),
        )

    def transform(self, block: FeatureBlock) -> npt.NDArray[np.float64]:
        if block.contract.feature_names != self.source_names:
            raise LadderError(
                "the block was encoded under a different contract than the "
                "imputation was fitted on"
            )
        widened = _widen(block.matrix, medians=self.medians, indicated=self.indicated)
        return np.asarray(widened[:, list(self.kept)], dtype=np.float64)


@dataclass(frozen=True)
class LinearFit:
    """Rung 2, fitted: a logistic map and four linear coefficient vectors.

    The fitted objects are kept as **coefficient arrays** rather than as
    estimator handles, so prediction here is one matrix product and there is no
    library's own ``predict`` deciding anything the fold evaluation cannot read.
    """

    fold_rows: FoldRows
    imputation: MedianImputation
    centre: npt.NDArray[np.float64]
    scale: npt.NDArray[np.float64]
    logistic_coefficients: npt.NDArray[np.float64]
    logistic_intercept: float
    quantile_parameters: tuple[npt.NDArray[np.float64], ...]
    mean_parameters: npt.NDArray[np.float64]
    wind_share: float | None
    sub_threshold_means: SubThresholdMeans

    def forecasts(self, rows: Sequence[Mapping[str, Any]]) -> tuple[HourForecast, ...]:
        block = self.fold_rows.block(rows)
        design = self._design(block)
        logit = design @ self.logistic_coefficients + self.logistic_intercept
        probability = 1.0 / (1.0 + np.exp(-np.clip(logit, -30.0, 30.0)))
        with_constant = _with_constant(design)
        knots = [with_constant @ parameters for parameters in self.quantile_parameters]
        mean = with_constant @ self.mean_parameters
        return compose_estimates(
            block.keys,
            [
                HourEstimates(
                    occurrence_probability=float(probability[index]),
                    q10=float(knots[0][index]),
                    q50=float(knots[1][index]),
                    q90=float(knots[2][index]),
                    positive_mean_mwh=float(mean[index]),
                    wind_share=self.wind_share,
                )
                for index in range(len(block.keys))
            ],
            sub_threshold_means=self.sub_threshold_means,
            threshold_mw=self.fold_rows.threshold_mw,
        )

    def _design(self, block: FeatureBlock) -> npt.NDArray[np.float64]:
        return (self.imputation.transform(block) - self.centre) / self.scale


@dataclass(frozen=True)
class LinearRung:
    """Rung 3's neighbour below: the interpretable rung.

    L2-regularised logistic for occurrence and ``statsmodels`` quantile
    regression for the magnitude, on the median-imputed vector with its
    indicators. On the ladder because a large gap between it and the forest says
    the problem is non-linear, and a small one says most of the signal is
    additive and the boosting is buying convenience.

    Features are centred and scaled to unit range before fitting. That is a
    conditioning decision internal to this rung — it changes no coefficient's
    meaning after the inverse transform is folded back in, and without it the
    quantile regression's design is ill-conditioned by the MWh columns alone.
    The tree rungs need none of it and get none.
    """

    max_iterations: int = 200
    #: The inverse of the L2 strength, the ``sklearn`` spelling. Fixed and
    #: published, never searched during a run: a rung whose configuration moved
    #: between folds would make the ladder's own comparison meaningless.
    inverse_regularisation: float = 1.0

    number: int = 2
    name: str = "logistic_quantile_regression"
    imputed: bool = True
    calibrated: bool = False
    conformalised: bool = False

    def fit(self, fold_rows: FoldRows) -> RungFit:
        base_fit = fold_rows.base_fit
        labelled = base_fit.select(base_fit.labelled)
        positives = labelled.select(labelled.positive)
        if not len(positives):
            raise LadderError(
                f"{fold_rows.fold.id}: no base-fit hour is above τ, so the "
                "quantile regression has no conditional population to fit"
            )
        imputation = MedianImputation.fit(labelled)
        raw = imputation.transform(labelled)
        centre = raw.mean(axis=0)
        scale = np.where(raw.std(axis=0) > 0.0, raw.std(axis=0), 1.0)
        design = (raw - centre) / scale
        # L2 is scikit-learn's default penalty and is not named here: the
        # `penalty=` keyword is deprecated from 1.8, and spelling the default
        # out would make the ladder emit a deprecation warning to say the thing
        # the spec already says in prose.
        logistic = LogisticRegression(
            C=self.inverse_regularisation, max_iter=self.max_iterations
        ).fit(design, labelled.positive)
        positive_design = (imputation.transform(positives) - centre) / scale
        exogenous = _with_constant(positive_design)
        endogenous = positives.total_mwh
        return LinearFit(
            fold_rows=fold_rows,
            imputation=imputation,
            centre=centre,
            scale=scale,
            logistic_coefficients=np.asarray(logistic.coef_, dtype=np.float64).reshape(
                -1
            ),
            logistic_intercept=float(np.asarray(logistic.intercept_).reshape(-1)[0]),
            quantile_parameters=tuple(
                _quantile_regression(exogenous, endogenous, alpha)
                for alpha in FITTED_ALPHAS
            ),
            mean_parameters=_least_squares(exogenous, endogenous),
            wind_share=_mean_wind_share(positives),
            sub_threshold_means=fit_sub_threshold_means(base_fit),
        )

    def correction(self, fitted: RungFit) -> ConformalCorrection | None:
        return None


@dataclass(frozen=True)
class QuantileForest:
    """Meinshausen's quantile regression forest over a fitted sklearn forest.

    A random forest's ``predict`` is a conditional **mean**, and the ladder needs
    a conditional quantile. So the leaves are used as they were meant to be: a
    test row's prediction is a weighted empirical distribution over the training
    labels sharing its leaves, with weight ``1 / (|leaf| · trees)``, and the
    quantile is read off that. The forest is fitted once and this reads it; there
    is no second model.
    """

    forest: Any
    targets: npt.NDArray[np.float64]
    #: Per tree, leaf id → the training row indices that landed in it.
    members: tuple[dict[int, npt.NDArray[np.intp]], ...]
    order: npt.NDArray[np.intp]

    @classmethod
    def of(
        cls,
        forest: Any,
        design: npt.NDArray[np.float64],
        targets: npt.NDArray[np.float64],
    ) -> QuantileForest:
        leaves = np.asarray(forest.apply(design), dtype=np.intp)
        members: list[dict[int, npt.NDArray[np.intp]]] = []
        for tree in range(leaves.shape[1]):
            column = leaves[:, tree]
            grouped: dict[int, npt.NDArray[np.intp]] = {}
            for leaf in np.unique(column):
                grouped[int(leaf)] = np.flatnonzero(column == leaf).astype(np.intp)
            members.append(grouped)
        return cls(
            forest=forest,
            targets=targets,
            members=tuple(members),
            order=np.argsort(targets, kind="stable").astype(np.intp),
        )

    def quantiles(
        self, design: npt.NDArray[np.float64], alphas: Sequence[float]
    ) -> npt.NDArray[np.float64]:
        """``len(design) × len(alphas)`` of conditional quantiles."""
        leaves = np.asarray(self.forest.apply(design), dtype=np.intp)
        trees = leaves.shape[1]
        sorted_targets = self.targets[self.order]
        out = np.zeros((leaves.shape[0], len(alphas)), dtype=np.float64)
        for row in range(leaves.shape[0]):
            weights = np.zeros(self.targets.shape[0], dtype=np.float64)
            for tree in range(trees):
                indices = self.members[tree].get(int(leaves[row, tree]))
                if indices is None or not indices.size:
                    continue
                weights[indices] += 1.0 / (indices.size * trees)
            cumulative = np.cumsum(weights[self.order])
            total = float(cumulative[-1])
            for column, alpha in enumerate(alphas):
                if total <= 0.0:
                    out[row, column] = float(sorted_targets[-1])
                    continue
                position = int(np.searchsorted(cumulative, alpha * total, side="left"))
                out[row, column] = float(
                    sorted_targets[min(position, sorted_targets.size - 1)]
                )
        return out


@dataclass(frozen=True)
class ForestFit:
    """Rung 3, fitted: a classifier, a quantile forest and a mean forest."""

    fold_rows: FoldRows
    imputation: MedianImputation
    classifier: Any
    quantile_forest: QuantileForest
    wind_share: float | None
    sub_threshold_means: SubThresholdMeans

    def forecasts(self, rows: Sequence[Mapping[str, Any]]) -> tuple[HourForecast, ...]:
        block = self.fold_rows.block(rows)
        design = self.imputation.transform(block)
        probability = np.asarray(self.classifier.predict_proba(design), dtype=np.float64)
        positive_column = _positive_column(self.classifier)
        knots = self.quantile_forest.quantiles(design, FITTED_ALPHAS)
        mean = np.asarray(self.quantile_forest.forest.predict(design), dtype=np.float64)
        return compose_estimates(
            block.keys,
            [
                HourEstimates(
                    occurrence_probability=float(probability[index, positive_column]),
                    q10=float(knots[index, 0]),
                    q50=float(knots[index, 1]),
                    q90=float(knots[index, 2]),
                    positive_mean_mwh=float(mean[index]),
                    wind_share=self.wind_share,
                )
                for index in range(len(block.keys))
            ],
            sub_threshold_means=self.sub_threshold_means,
            threshold_mw=self.fold_rows.threshold_mw,
        )


@dataclass(frozen=True)
class ForestRung:
    """Rung 3 — non-linearity without tuning.

    On the ladder to separate "the problem is non-linear" from "the problem
    needs boosting". Its hyperparameters are small, fixed and published for the
    same reason the served model's are: a rung that searched inside a run would
    differ from itself between folds, and the ladder's comparison would be
    meaningless.
    """

    trees: int = 200
    min_samples_leaf: int = 20
    random_state: int = 20_260_829

    number: int = 3
    name: str = "random_forest"
    imputed: bool = True
    calibrated: bool = False
    conformalised: bool = False

    def fit(self, fold_rows: FoldRows) -> RungFit:
        base_fit = fold_rows.base_fit
        labelled = base_fit.select(base_fit.labelled)
        positives = labelled.select(labelled.positive)
        if not len(positives):
            raise LadderError(
                f"{fold_rows.fold.id}: no base-fit hour is above τ, so the "
                "quantile forest has no conditional population to fit"
            )
        imputation = MedianImputation.fit(labelled)
        classifier = RandomForestClassifier(
            n_estimators=self.trees,
            min_samples_leaf=self.min_samples_leaf,
            random_state=self.random_state,
        ).fit(imputation.transform(labelled), labelled.positive)
        positive_design = imputation.transform(positives)
        regressor = RandomForestRegressor(
            n_estimators=self.trees,
            min_samples_leaf=self.min_samples_leaf,
            random_state=self.random_state,
        ).fit(positive_design, positives.total_mwh)
        return ForestFit(
            fold_rows=fold_rows,
            imputation=imputation,
            classifier=classifier,
            quantile_forest=QuantileForest.of(
                regressor, positive_design, positives.total_mwh
            ),
            wind_share=_mean_wind_share(positives),
            sub_threshold_means=fit_sub_threshold_means(base_fit),
        )

    def correction(self, fitted: RungFit) -> ConformalCorrection | None:
        return None


@dataclass(frozen=True)
class LightGbmFit:
    """Rung 4, fitted: the served bundle, composed by the served function."""

    bundle: Any
    correction_: ConformalCorrection

    def forecasts(self, rows: Sequence[Mapping[str, Any]]) -> tuple[HourForecast, ...]:
        return forecast_rows(self.bundle, rows)


@dataclass(frozen=True)
class LightGbmRung:
    """Rung 4 — the served model, reached through :func:`train_fold`.

    Not a reimplementation of it. This rung fits the artifact the product would
    ship, isotonic map, conformal correction and all, and composes through
    :func:`~wattsteer_ml.training.hurdle.forecast_rows` — so the top of the
    ladder is the thing being shipped rather than something that resembles it.
    **Nothing on this path is imputed**, which is the asymmetry the metrics
    table marks.
    """

    #: ``pg_get_functiondef(feature_rows)``. Rung 4 is the only rung that needs
    #: it, because it is the only rung that writes a model card.
    function_definition: str
    #: Pooled out-of-fold predictions, for the reliability curve and the risk
    #: edges. :func:`train_fold` requires it and this rung does not fabricate one.
    pool: OutOfFoldPool
    config: ModelConfig = MODEL_CONFIG_V1
    #: ``|B(s, h)|`` for the matched background :func:`train_fold` freezes into
    #: the bundle. The ladder scores forecasts and never attributions, so this
    #: rung has no use for the sample — but the artifact it fits is the served
    #: artifact, which since forecaster 30 cannot exist without one. Exposed so
    #: that a ladder run on a short window fails on its own terms rather than
    #: on a background it never reads.
    background_rows_per_cell: int = BACKGROUND_ROWS_PER_CELL

    number: int = 4
    name: str = "lightgbm"
    imputed: bool = False
    calibrated: bool = True
    conformalised: bool = True

    def fit(self, fold_rows: FoldRows) -> RungFit:
        trained = train_fold(
            fold_rows.rows,
            fold=fold_rows.fold,
            blocks=fold_rows.blocks,
            function_definition=self.function_definition,
            pool=self.pool,
            config=self.config,
            background_rows_per_cell=self.background_rows_per_cell,
        )
        return LightGbmFit(bundle=trained.bundle, correction_=trained.bundle.conformal)

    def correction(self, fitted: RungFit) -> ConformalCorrection | None:
        return fitted.correction_ if isinstance(fitted, LightGbmFit) else None


def default_ladder(
    *,
    function_definition: str,
    pool: OutOfFoldPool,
    background_rows_per_cell: int = BACKGROUND_ROWS_PER_CELL,
) -> tuple[Rung, ...]:
    """The five rungs, in the spec's order. Rung 5 (TFT) is never served."""
    return (
        PrevalenceRung(),
        SameHourSevenDayRung(),
        LinearRung(),
        ForestRung(),
        LightGbmRung(
            function_definition=function_definition,
            pool=pool,
            background_rows_per_cell=background_rows_per_cell,
        ),
    )


def run_ladder(
    rows: Sequence[Mapping[str, Any]],
    *,
    fold: Fold,
    blocks: FoldBlocks,
    segments: Sequence[FoldSegment],
    run: str,
    rungs: Sequence[Rung],
    function_definition: str,
    day_grain: bool = True,
) -> MetricsTable:
    """Fit every rung once, score it on every segment, and return the table.

    Args:
        rows: every row of this fold — base fit, calibration and test together.
        fold: the fold, from the shared calendar.
        blocks: this run's three windows, from :meth:`Fold.blocks_for`.
        segments: the fold's reported rows, from
            :func:`~wattsteer_ml.evaluation.vintage.stamp_fidelity`. One
            normally; two when the fold straddles ingestion go-live, and then
            the ladder produces two rows per rung, never one averaged one.
        run: the matrix arm's name, stamped on every row.
        rungs: usually :func:`default_ladder`. Passing a subset is how the
            threshold sweep runs one rung at three thresholds.
        day_grain: whether to draw the day band and measure its coverage.

    Each rung is fitted **once** per fold and scored on each segment, so a split
    fold's two rows come from one model and differ only in the rows they cover.
    """
    fold_rows = FoldRows.of(
        rows, fold=fold, blocks=blocks, function_definition=function_definition
    )
    table: list[MetricsRow] = []
    for rung in rungs:
        fitted = rung.fit(fold_rows)
        for segment in segments:
            settled = [
                row
                for row in fold_rows.segment_rows(segment)
                if row.get(TOTAL_COLUMN) is not None
            ]
            if not settled:
                continue
            hours = _scored(fitted.forecasts(settled), settled)
            table.append(
                MetricsRow.of(
                    hours,
                    run=run,
                    rung=rung.name,
                    rung_number=rung.number,
                    segment=segment,
                    imputed=rung.imputed,
                    calibrated=rung.calibrated,
                    conformalised=rung.conformalised,
                    correction=rung.correction(fitted),
                    day_grain=(
                        _day_grain(fitted, fold_rows, segment, settled)
                        if day_grain
                        else None
                    ),
                )
            )
    if not table:
        raise LadderError(
            f"{fold.id}: no segment of this fold carries a settled label, so no "
            "rung of the ladder has anything to be scored on"
        )
    return MetricsTable(rows=tuple(table))


def _day_grain(
    fitted: RungFit,
    fold_rows: FoldRows,
    segment: FoldSegment,
    settled: Sequence[Mapping[str, Any]],
) -> DayGrainCoverage | None:
    """``day_total_coverage`` and ``peak_coverage`` for one rung on one segment.

    Drawn through the path ensemble, from a PIT matrix fitted on **this rung's**
    band over the calibration window — so a rung's day band is a property of the
    rung and not of the served model's dependence structure borrowed for the
    occasion.

    ``None`` when the calibration window holds too few complete days for a
    bootstrap, which :class:`~wattsteer_ml.training.ensemble.PitMatrix` decides
    and this function does not second-guess. An absent measurement is reported
    as absent.
    """
    calibration = [
        row for row in fold_rows.calibration_rows if row.get(TOTAL_COLUMN) is not None
    ]
    if not calibration:
        return None
    composed = fitted.forecasts(calibration)
    try:
        matrix = fit_pit_matrix(
            [
                (hour.key, hour.forecast.mixture, float(row[TOTAL_COLUMN]))
                for hour, row in zip(composed, calibration, strict=True)
            ],
            window=(fold_rows.blocks.calibration_start, fold_rows.blocks.calibration_end),
        )
    except EnsembleError:
        return None
    days: dict[tuple[date, Subsystem], list[tuple[int, HurdleMixture]]] = {}
    observed: dict[tuple[date, Subsystem], list[float]] = {}
    for hour, row in zip(fitted.forecasts(settled), settled, strict=True):
        cell = (hour.key.target_date, hour.key.subsystem)
        days.setdefault(cell, []).append((hour.key.local_hour, hour.forecast.mixture))
        observed.setdefault(cell, []).append(float(row[TOTAL_COLUMN]))
    ordered = {
        cell: [mixture for _, mixture in sorted(entries, key=lambda one: one[0])]
        for cell, entries in days.items()
    }
    return DayGrainCoverage.of(
        observed,
        draw_day_grain(ordered, matrix=matrix, threshold_mw=fold_rows.threshold_mw),
        fold_id=segment.row_id,
    )


def _scored(
    forecasts: Sequence[HourForecast], rows: Sequence[Mapping[str, Any]]
) -> tuple[ScoredHour, ...]:
    """Pair each composed hour with the label of the row it was composed from."""
    return tuple(
        ScoredHour(
            key=hour.key,
            forecast=hour.forecast,
            observed_mwh=float(row[TOTAL_COLUMN]),
        )
        for hour, row in zip(forecasts, rows, strict=True)
    )


def _widen(
    matrix: npt.NDArray[np.float64],
    *,
    medians: tuple[float, ...],
    indicated: tuple[int, ...],
) -> npt.NDArray[np.float64]:
    """Filled columns, then one ``_is_null`` indicator per indicated column."""
    filled = np.where(np.isnan(matrix), np.asarray(medians, dtype=np.float64), matrix)
    if not indicated:
        return np.asarray(filled, dtype=np.float64)
    indicators = np.isnan(matrix[:, list(indicated)]).astype(np.float64)
    return np.asarray(np.hstack([filled, indicators]), dtype=np.float64)


def _with_constant(design: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
    """The design with an intercept column in front. One spelling, one place."""
    return np.asarray(
        np.hstack([np.ones((design.shape[0], 1), dtype=np.float64), design]),
        dtype=np.float64,
    )


def _quantile_regression(
    exogenous: npt.NDArray[np.float64],
    endogenous: npt.NDArray[np.float64],
    alpha: float,
) -> npt.NDArray[np.float64]:
    """``statsmodels`` quantile regression, as the spec names for rung 2.

    Falls back to the least-squares fit when the IRLS does not converge — a
    singular design after the variance filter, which happens on a fold whose
    curtailed hours are too few to identify every coefficient. The fallback is
    stated here rather than hidden as a NaN coefficient that would compose into
    a band nobody can read.

    **The most common non-convergence raises nothing**, which is why the
    warnings are caught rather than the exceptions alone. ``statsmodels``
    signals both of its failures — the iteration cap and a detected convergence
    cycle — with ``warnings.warn`` and nothing else: no exception, no flag on
    the result, and finite coefficients taken from whatever the last iterate
    happened to be. So the fallback above was documented and unreachable for the
    case that actually occurs, and rung 2 was taking an unconverged iterate as
    its baseline band. The test suite had been printing
    ``IterationLimitWarning: Maximum number of iterations (1000) reached`` all
    along, in a run that reported 1,817 passes.

    That baseline is what a candidate model is scored against before promotion,
    so "whatever the solver held at iteration 1000" is not a number this may
    quietly stand on. A least-squares fit is a worse quantile estimate and an
    honest one, which is the trade the docstring already chose.

    Unrelated warnings are re-emitted, so catching these two never silences a
    third.
    """
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            fitted = sm.QuantReg(endogenous, exogenous).fit(q=alpha)
        except (ValueError, np.linalg.LinAlgError):
            return _least_squares(exogenous, endogenous)
    unconverged = False
    for entry in caught:
        if issubclass(entry.category, (IterationLimitWarning, ConvergenceWarning)):
            unconverged = True
        else:
            warnings.warn_explicit(
                entry.message, entry.category, entry.filename, entry.lineno
            )
    if unconverged:
        return _least_squares(exogenous, endogenous)
    parameters = np.asarray(fitted.params, dtype=np.float64).reshape(-1)
    if not np.all(np.isfinite(parameters)):
        return _least_squares(exogenous, endogenous)
    return parameters


def _least_squares(
    exogenous: npt.NDArray[np.float64], endogenous: npt.NDArray[np.float64]
) -> npt.NDArray[np.float64]:
    solution, *_ = np.linalg.lstsq(exogenous, endogenous, rcond=None)
    return np.asarray(solution, dtype=np.float64).reshape(-1)


def _positive_column(classifier: Any) -> int:
    """Which column of ``predict_proba`` is ``P(curtailed)``.

    Read off ``classes_`` rather than assumed to be 1: a base-fit block with no
    negative hour would train a one-class forest, and index 1 would raise or —
    worse — silently be the wrong class.
    """
    classes = [bool(value) for value in np.asarray(classifier.classes_).reshape(-1)]
    if True not in classes:
        raise LadderError(
            "the occurrence classifier never saw a curtailed hour; its "
            "probability of curtailment is not a number this ladder will invent"
        )
    return classes.index(True)


def _mean_wind_share(positives: FeatureBlock) -> float | None:
    """``ŝ`` as one constant. ``None`` when no positive row carries a split.

    ``None`` rather than 0.5: the composed forecast then carries no technology
    split at all, which is the honest output for a rung that fits no share
    model, and a fabricated half would be rendered as a number.
    """
    with np.errstate(invalid="ignore", divide="ignore"):
        share = positives.wind_mwh / positives.total_mwh
    present = share[np.isfinite(share)]
    if not present.size:
        return None
    return float(min(1.0, max(0.0, float(np.mean(present)))))
