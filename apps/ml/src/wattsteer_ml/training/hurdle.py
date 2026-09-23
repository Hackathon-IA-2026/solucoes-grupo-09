"""Train the hurdle on one fold, and compose a band out of it.

The tracer bullet: feature rows in, a bundle and a card on the volume, and a
P10/P50/P90 band plus an ``E[Y]`` for every subsystem-hour of the fold's test
period out.

**The two stages are fitted separately and composed once.** This module fits six
estimators and ``μ_sub`` and then hands them to
:func:`wattsteer_ml.mixture.compose`. It contains no second composition and no
arithmetic on ``p`` and a magnitude together — grep it for ``*`` between the
two. `docs/specs/forecaster.md` opens on the reason: ``p × E[Y | Y > τ]`` is an
expectation and not a P50, and the moment two places can build a mixture, two
places will build different ones.

**The magnitude models see curtailed hours only.** That is the whole difference
between a hurdle and a zero-inflated regression fitted on everything: ``Q_pos``
and ``Ê[Y | Y > τ]`` are *conditional on* ``Y > τ``, and a fit that also saw the
quiet hours would estimate something else and the composition would then be
inverting a CDF nobody fitted. The positive mask is
:attr:`~wattsteer_ml.training.design.FeatureBlock.positive`, which reads
``y_has_curtailment`` — the feature function's own decision from the
``threshold_mw`` it was given — rather than re-comparing anything here.

**The blocks come from ticket 03 and are not recomputed.** :func:`train_fold`
takes a :class:`~wattsteer_ml.evaluation.FoldBlocks`, which cannot exist unless
its base-fit and calibration windows are disjoint and ordered before the test
period. This module derives no dates: it partitions the rows it was given by
``target_date`` against those boundaries and refuses a row that falls outside
them. There is no fold calendar in this file and no call that would build one.

**Where the calibration window is and is not used.** Every fit is on base-fit
rows. The calibration block is passed to LightGBM as an *early-stopping monitor*
only — the spec's v1 configuration says "early stopping on the calibration
window's pinball loss" — so it chooses a tree count and contributes no gradient,
and the base learners are **not refit** afterwards, which is the invariant
:class:`~wattsteer_ml.evaluation.FoldBlocks` exists to hold. Set
``early_stopping_rounds`` to 0 in a configuration that wants the calibration
window untouched entirely.

**``p`` is the calibrated probability, and there is one route to it.** The
occurrence booster's raw output reaches :func:`wattsteer_ml.mixture.compose`
through :attr:`Calibration.isotonic <wattsteer_ml.training.calibration.\
Calibration.isotonic>` and through nothing else, so calibration changes the
breakpoint at ``1 − p`` and changes nothing else about the band. There is still
exactly one composition in this service and this file still holds none of it.

**The conformal correction is applied to ``Q_pos``, before the composition and
never after it.** Forecaster ticket 06 fits ``δ_lo`` and ``δ_hi`` on the
calibration window's curtailed hours, against the band *this file composed*
there with the uncorrected knots, and
:meth:`ConformalCorrection.apply <wattsteer_ml.training.conformal.\
ConformalCorrection.apply>` then maps one
:class:`~wattsteer_ml.mixture.MagnitudeQuantiles` to another on the way into
``compose``. So the correction changes the knots the mixture inverts and
changes nothing else about how a band is built — there is still one call to
:func:`~wattsteer_ml.mixture.compose` in this service, and no second route from
a scalar to a served interval. What that costs at the upper tail, and why the
lower one is exact, is written down in :mod:`wattsteer_ml.training.conformal`.

**Every figure above hour grain is drawn, and this file draws none of them.**
Forecaster ticket 07 takes the randomised PIT of the band composed *here* on
the calibration window — with the correction already applied, so ``U`` is a
property of the band the product ships — and stores it in the bundle.
:func:`day_grain_rows` then groups the composed hours into days and hands the
mixtures to :mod:`wattsteer_ml.training.ensemble`, which inverts the same
:class:`~wattsteer_ml.mixture.HurdleMixture` objects at 500 × 24 draws of
``u``. Grep this file for a day total: there is none, because a day total is
not a sum of anything this file holds.

**The attribution's "typical" is drawn here, once, and this is the only place
that can stamp it ``artifact``.** Forecaster ticket 30: ``B(s, h)`` — 128 rows
per ``(subsystem, local_hour)`` cell — comes out of the base-fit block this
function already holds and goes into the bundle beside ``μ_sub`` and ``U``.
Drawing it here rather than at publication is what makes a stored explanation
reproducible from the artifact alone, costs no second read of the ~17,000-row
window, and moves the one failure that can stop an attribution — a cell shorter
than ``|B|`` — from twice a day to once a retrain, where its repair is a longer
run window. :func:`~wattsteer_ml.training.background.draw_artifact_background`
is called from this module and no other, and an AST test in the diagnosis suite
holds that.

**The pool the reliability curve is measured on is an argument, not a
derivation.** :func:`train_fold` cannot compute out-of-fold predictions across
every walk-forward fold from one fold's rows, and a curve measured on the fold
it was trained on would be the self-portrait the spec forbids. So the caller
supplies a :class:`~wattsteer_ml.training.calibration.OutOfFoldPool`, which has
already checked every prediction against its own fold's test period, and this
module refuses rather than fabricates when one is not offered.

**The honest caveat this ticket inherits, and where it now reaches.** The
calibration block is passed to LightGBM as an early-stopping monitor, so it has
chosen the tree count even though no gradient came from it and no base learner
was refit. ``p_raw`` on that window is therefore slightly optimistic, and an
isotonic map fitted to it under-corrects a little. What that does *not* affect
is the published curve: it is measured on rows outside the calibration window
entirely.

It does reach ``δ_lo`` and ``δ_hi``. The two pinball boosters were early-stopped
on that same window, so ``q̂^0.10`` and ``q̂^0.90`` sit a hair closer to its
labels than they will on the test fold; the ``p`` that decides where the band's
breakpoint falls comes from an isotonic map fitted to the same rows. Both push
the composed band toward the labels, both shrink the residuals the corrections
are ranked from, and so both make ``δ`` **slightly small** — the direction
forecaster ticket 04 predicted. Setting ``early_stopping_rounds`` to 0 in a
configuration removes the booster half outright; the isotonic half is inherent
to fitting the map and the correction on one window.

**Forecaster 46 measured what that costs and the answer is nothing a fold can
see**: 0.9013 against 0.9014 on stationary rows, across eight folds of ~950
scored test rows, with the split-block and no-early-stopping arms at 0.9011 and
0.8994. The numbers and the arms are in
:mod:`wattsteer_ml.training.conformal`'s module docstring, where the caveat is
stated in full. The reuse stays, now as a measured cost rather than an
unquantified one.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

import lightgbm as lgb
import numpy as np
import numpy.typing as npt

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.driver_groups import DRIVER_GROUP_MAP, DriverGroupMap
from wattsteer_ml.evaluation import Fold, FoldBlocks, RowKey
from wattsteer_ml.mixture import (
    FITTED_ALPHAS,
    ComposedForecast,
    HurdleMixture,
    MagnitudeQuantiles,
    compose,
)
from wattsteer_ml.training.background import (
    BACKGROUND_ROWS_PER_CELL,
    BACKGROUND_SEED,
    BackgroundError,
    draw_artifact_background,
)
from wattsteer_ml.training.bundle import (
    HOURS_PER_DAY,
    HurdleBundle,
    ModelCard,
    SubThresholdMeans,
    TrainingCounts,
    new_artifact_id,
)
from wattsteer_ml.training.calibration import (
    Calibration,
    IsotonicCalibrator,
    OutOfFoldPool,
    OutOfFoldPrediction,
    RiskBins,
    calibrate,
)
from wattsteer_ml.training.conformal import (
    ConformalCorrection,
    CoverageReport,
    ScoredHour,
    conformalise,
)
from wattsteer_ml.training.contract import FeatureContract
from wattsteer_ml.training.design import FeatureBlock, RowStamp
from wattsteer_ml.training.ensemble import (
    ENSEMBLE_DRAWS,
    ENSEMBLE_SEED,
    DayGrainCoverage,
    DayGrainForecast,
    DrawPlan,
    PitMatrix,
    draw_day_grain,
    fit_pit_matrix,
)
from wattsteer_ml.training.headline_check import (
    HEADLINE_CHECK_SEED,
    HEADLINE_CHECK_TARGETS,
    HeadlineFeatureCheck,
    check_headline_features,
)
from wattsteer_ml.training.hyperparameters import MODEL_CONFIG_V1, ModelConfig


class TrainingError(ValueError):
    """The rows cannot train the fold that was asked for."""


@dataclass(frozen=True)
class HourForecast:
    """One subsystem-hour of the answer: who it is about, and what was said."""

    key: RowKey
    forecast: ComposedForecast


@dataclass(frozen=True)
class TrainedFold:
    """What one fold's training produced. The bundle, its card, and the blocks."""

    bundle: HurdleBundle
    card: ModelCard
    blocks: FoldBlocks
    counts: TrainingCounts


def train_fold(
    rows: Sequence[Mapping[str, Any]],
    *,
    fold: Fold,
    blocks: FoldBlocks,
    function_definition: str,
    pool: OutOfFoldPool,
    incumbent_risk_bins: RiskBins | None = None,
    config: ModelConfig = MODEL_CONFIG_V1,
    background_rows_per_cell: int = BACKGROUND_ROWS_PER_CELL,
    background_seed: int = BACKGROUND_SEED,
    group_map: DriverGroupMap = DRIVER_GROUP_MAP,
    headline_check_targets: int = HEADLINE_CHECK_TARGETS,
    headline_check_seed: int = HEADLINE_CHECK_SEED,
    created_at: datetime | None = None,
    artifact_id: str | None = None,
    feature_set_version: str | None = None,
    git_sha_ml: str | None = None,
    git_sha_api: str | None = None,
) -> TrainedFold:
    """Fit the six estimators and ``μ_sub`` on ``blocks``' base-fit block.

    Args:
        rows: everything ``feature_rows(...)`` returned for this fold — base
            fit, calibration and test together, exactly as ``FoldBlocks``
            produces them. They are partitioned here by ``target_date``.
        fold: the fold these blocks came from, for the card's ``fold_hash``.
        blocks: the three windows, from :meth:`Fold.blocks_for`.
        function_definition: ``pg_get_functiondef(feature_rows)``, the half of
            the feature contract a column list cannot see.
        pool: pooled out-of-fold predictions across the walk-forward folds, for
            the reliability curve and the risk-class edges. Required: an
            artifact whose calibrated probability has no measured curve behind
            it cannot state a risk class, and the risk classes are published.
        incumbent_risk_bins: the edges the live artifact publishes, if there is
            one. Held unless this pool violates the rule that chose them — a
            named class that moves weekly is worse than one three points off.
        config: the published configuration. Named, never searched.
        background_rows_per_cell: ``|B(s, h)|`` for the sample frozen into the
            bundle. Defaults to the spec's 128, and every production caller
            takes the default — it is a parameter so that a fixture fold of
            thirty days can carry a smaller but *real* sample rather than
            being exempted from carrying one.
        background_seed: the seed stamped onto that sample. A constant of the
            run, not a hash of the artifact id: see
            :data:`~wattsteer_ml.training.background.BACKGROUND_SEED`.
        group_map: the eight driver groups. Stamped on the card by
            identity — ``driver_group_version`` and ``driver_group_hash`` — and
            ranked over by the headline-feature check. A parameter for the same
            reason ``background_rows_per_cell`` is one: an artifact must say
            which partition produced it, and a fixture fold has to be able to
            say a *real* thing rather than be exempted from saying one.
        headline_check_targets: how many of the fold's test rows the check's
            mean ``|φ|`` is taken over.
        headline_check_seed: the seed those rows are drawn with. Stamped.

    Returns:
        The bundle, the card and the counts behind them.
    """
    stamp = RowStamp.of(rows)
    base_fit_rows, calibration_rows, test_rows = partition_rows(rows, blocks)
    if not base_fit_rows:
        raise TrainingError(
            f"{fold.id}: the base-fit block {blocks.base_fit_start.isoformat()}–"
            f"{blocks.base_fit_end.isoformat()} contains no rows"
        )
    contract = FeatureContract.of(base_fit_rows, function_definition=function_definition)
    base_fit = FeatureBlock.of(base_fit_rows, contract, threshold_mw=stamp.threshold_mw)
    calibration = FeatureBlock.of(
        calibration_rows, contract, threshold_mw=stamp.threshold_mw
    )

    fit_block = base_fit.select(base_fit.labelled)
    positives = fit_block.select(fit_block.positive)
    if not len(positives):
        raise TrainingError(
            f"{fold.id}: no base-fit hour is above τ = {stamp.threshold_mw} MWh, so "
            "there is no conditional magnitude distribution to fit; this is a "
            "statement about the data, not a configuration to relax"
        )
    monitor = calibration.select(calibration.labelled)
    monitor_positives = monitor.select(monitor.positive)
    if not len(monitor):
        raise TrainingError(
            f"{fold.id}: the calibration block "
            f"{blocks.calibration_start.isoformat()}–"
            f"{blocks.calibration_end.isoformat()} carries no settled label, so "
            "there is nothing to fit the isotonic map on; an uncalibrated "
            "probability is not a probability this product may render"
        )
    occurrence = _fit(
        config=config,
        params=config.params(objective="binary", role="occurrence"),
        train=fit_block,
        label=fit_block.positive.astype(np.float64),
        monitor=monitor,
        monitor_label=monitor.positive.astype(np.float64),
    )
    fitted_calibration = _fit_calibration(
        occurrence,
        monitor,
        blocks=blocks,
        pool=pool,
        incumbent_risk_bins=incumbent_risk_bins,
    )

    # `FITTED_ALPHAS` is (0.02, 0.10, 0.50, 0.90) — the 0.02 knot is why the
    # composed P10 interpolates instead of resting on a flat. See the constant's
    # own note in `mixture.py`.
    magnitude_p02 = _fit_quantile(config, positives, monitor_positives, FITTED_ALPHAS[0])
    magnitude_p10 = _fit_quantile(config, positives, monitor_positives, FITTED_ALPHAS[1])
    magnitude_p50 = _fit_quantile(config, positives, monitor_positives, FITTED_ALPHAS[2])
    magnitude_p90 = _fit_quantile(config, positives, monitor_positives, FITTED_ALPHAS[3])
    magnitude_mean = _fit(
        config=config,
        params=config.params(objective="l2", role="magnitude_mean"),
        train=positives,
        label=positives.total_mwh,
        monitor=monitor_positives,
        monitor_label=monitor_positives.total_mwh,
    )
    wind_share = _fit(
        config=config,
        params=config.params(objective="l2", role="wind_share"),
        train=positives,
        label=_wind_share(positives),
        monitor=monitor_positives,
        monitor_label=_wind_share(monitor_positives),
    )
    sub_threshold_means = fit_sub_threshold_means(fit_block)
    correction = _fit_conformal(
        monitor_positives,
        blocks=blocks,
        fold=fold,
        occurrence=occurrence,
        isotonic=fitted_calibration.isotonic,
        magnitude_p02=magnitude_p02,
        magnitude_p10=magnitude_p10,
        magnitude_p50=magnitude_p50,
        magnitude_p90=magnitude_p90,
        magnitude_mean=magnitude_mean,
        wind_share=wind_share,
        sub_threshold_means=sub_threshold_means,
        threshold_mw=stamp.threshold_mw,
    )
    pit = _fit_pit(
        monitor,
        blocks=blocks,
        fold=fold,
        occurrence=occurrence,
        isotonic=fitted_calibration.isotonic,
        magnitude_p02=magnitude_p02,
        magnitude_p10=magnitude_p10,
        magnitude_p50=magnitude_p50,
        magnitude_p90=magnitude_p90,
        magnitude_mean=magnitude_mean,
        wind_share=wind_share,
        sub_threshold_means=sub_threshold_means,
        threshold_mw=stamp.threshold_mw,
        correction=correction,
    )
    # ``B(s, h)``, drawn here and nowhere else. The base-fit block is already
    # in memory — the same block the boosters were fitted on and the same one
    # the publish-time fallback would re-read from the database — so the frozen
    # sample costs no second read and cannot be drawn from a window that has
    # moved since. Drawn from `base_fit` and not from `fit_block`: a background
    # row is a row of features, and dropping the unlabelled hours would make
    # "typical" a statement about the settled part of the window only.
    #
    # A short cell fails **here**, in a weekly retrain whose repair is a longer
    # run window, rather than twice a day at publication where the same repair
    # is a retrain anyway and the symptom is a missing explanation.
    try:
        background = draw_artifact_background(
            base_fit,
            seed=background_seed,
            rows_per_cell=background_rows_per_cell,
        )
    except BackgroundError as error:
        raise TrainingError(
            f"{fold.id}: no matched background can be drawn from the base-fit "
            f"block {blocks.base_fit_start.isoformat()}–"
            f"{blocks.base_fit_end.isoformat()} — {error}. The artifact carries "
            "the sample its attributions are measured against, so a window too "
            "short to supply one is a window too short to train on; the repair "
            "is a longer run window"
        ) from error
    bundle = HurdleBundle(
        lane=stamp.lane,
        contract=contract,
        model_config_version=config.version,
        threshold_mw=stamp.threshold_mw,
        occurrence=occurrence,
        magnitude_p02=magnitude_p02,
        magnitude_p10=magnitude_p10,
        magnitude_p50=magnitude_p50,
        magnitude_p90=magnitude_p90,
        magnitude_mean=magnitude_mean,
        wind_share=wind_share,
        sub_threshold_means=sub_threshold_means,
        calibration=fitted_calibration,
        conformal=correction,
        pit=pit,
        background=background,
    )
    counts = TrainingCounts(
        base_fit_rows=len(base_fit),
        base_fit_labelled_rows=len(fit_block),
        base_fit_positive_rows=len(positives),
        base_fit_sub_threshold_rows=len(fit_block) - len(positives),
        calibration_rows=len(calibration),
        calibration_labelled_rows=len(monitor),
        calibration_positive_rows=len(monitor_positives),
        test_rows=len(test_rows),
        vintage_fidelity=_fidelity_counts(rows),
    )
    card = ModelCard(
        artifact_id=artifact_id
        if artifact_id is not None
        else new_artifact_id(created_at),
        created_at=created_at if created_at is not None else datetime.now(tz=UTC),
        lane=stamp.lane,
        contract=contract,
        config=config,
        fold=fold,
        blocks=blocks,
        counts=counts,
        sub_threshold_means=bundle.sub_threshold_means,
        calibration=fitted_calibration,
        conformal=correction,
        pit=pit,
        background=background,
        headline_check=_fold_headline_check(
            bundle,
            test_rows,
            fold=fold,
            group_map=group_map,
            targets=headline_check_targets,
            seed=headline_check_seed,
        ),
        day_grain=_fold_day_grain(bundle, test_rows, fold=fold),
        coverage=_fold_coverage(bundle, test_rows, fold=fold),
        feature_set_version=feature_set_version,
        git_sha_ml=git_sha_ml,
        git_sha_api=git_sha_api,
    )
    return TrainedFold(bundle=bundle, card=card, blocks=blocks, counts=counts)


def out_of_fold_occurrence(
    rows: Sequence[Mapping[str, Any]],
    *,
    fold: Fold,
    blocks: FoldBlocks,
    function_definition: str,
    config: ModelConfig = MODEL_CONFIG_V1,
) -> tuple[OutOfFoldPrediction, ...]:
    """This fold's **calibrated** occurrence probabilities on its own test days.

    **The bootstrap for the pooled reliability curve, and only that.**
    :func:`train_fold` requires an :class:`OutOfFoldPool`, and the pool is
    assembled from the folds *before* the one being fitted — so the first fold in
    a walk-forward has nothing to build one from, and a driver that tried to
    build the pool by calling :func:`train_fold` over the prior folds would need
    a pool to get a pool. This function is the way out, and it is a small one on
    purpose.

    The pool carries exactly two numbers per row — an occurrence probability and
    the settled label — so the only estimator it can possibly need is the
    occurrence booster and the isotonic map over it. Fitting the five magnitude
    learners for a prior fold would be minutes of work whose output is thrown
    away. What is *not* cut is the fit itself: this is :func:`train_fold`'s
    occurrence stage, reached through the same :func:`_fit`, the same params and
    the same blocks, so the predictions pooled here are the predictions that
    model made and not a cheaper model's approximation of them.

    **Calibrated, by each fold's own map, and it used to be raw.** This returned
    ``p_raw`` on the argument that "the reliability curve exists to measure how
    far the raw probability is from the truth". That is a fair description of a
    *diagnostic*, and it is not what this pool is used for. Two things read it,
    and both are about the number the product publishes:

    - `docs/specs/forecaster.md` derives the risk-class edges from it, in its
      own words "choose edges from the **calibrated** reliability curve", and
      those edges are applied by :meth:`RiskBins.classify` to the served
      probability — which this file's header says is the calibrated one, reached
      "through :attr:`Calibration.isotonic` and through nothing else". Edges
      chosen against ``p_raw`` and applied to ``p`` are chosen against a
      quantity they never meet.
    - the card's own metric table types `ece`, `mce` and `top_bin_gap` as
      *occurrence, calibrated*, and Explain draws the curve and the class edges
      **on one axis**, which is incoherent if the two are on different scales.

    Measured, on production data, 2026-09-23: with the raw pool, no split of any
    fold satisfied clause (a) — F5's closest was "low predicts 0.065 against an
    observed 0.119", and F2, F3 and F4 failed the same way and in the same
    direction. A booster whose probabilities are compressed toward the base rate
    under-predicts in the low bin by construction; that is the distortion the
    isotonic map exists to remove, and clause (a) was being asked to pass
    *before* it was removed.

    Each fold calibrates with **its own** map rather than the fitting fold's:
    the pool is what those models would have published, and a later fold's
    calibrator was fitted on a window those models never saw. The map is fitted
    here on the fold's calibration block — the same block :func:`_fit_calibration`
    uses, the same one the booster was early-stopped against — and applied to
    the test block, which is the out-of-fold half.

    :func:`~wattsteer_ml.training.calibration.calibrate` still drops whatever
    falls inside the *artifact's* own calibration window, so a prior fold that
    overlaps it does not become a self-portrait.

    Only rows with a **settled label** are pooled: an hour ONS has not yet
    restated is not an observation, and ``observed=False`` for it would be an
    invented negative.
    """
    stamp = RowStamp.of(rows)
    base_fit_rows, calibration_rows, test_rows = partition_rows(rows, blocks)
    if not base_fit_rows:
        raise TrainingError(
            f"{fold.id}: the base-fit block {blocks.base_fit_start.isoformat()}–"
            f"{blocks.base_fit_end.isoformat()} contains no rows"
        )
    contract = FeatureContract.of(base_fit_rows, function_definition=function_definition)
    base_fit = FeatureBlock.of(base_fit_rows, contract, threshold_mw=stamp.threshold_mw)
    calibration = FeatureBlock.of(
        calibration_rows, contract, threshold_mw=stamp.threshold_mw
    )
    fit_block = base_fit.select(base_fit.labelled)
    monitor = calibration.select(calibration.labelled)
    occurrence = _fit(
        config=config,
        params=config.params(objective="binary", role="occurrence"),
        train=fit_block,
        label=fit_block.positive.astype(np.float64),
        monitor=monitor,
        monitor_label=monitor.positive.astype(np.float64),
    )
    test = FeatureBlock.of(test_rows, contract, threshold_mw=stamp.threshold_mw)
    settled = test.select(test.labelled)
    if not len(settled):
        return ()
    raw = np.clip(_predict(occurrence, settled.matrix), 0.0, 1.0)
    # This fold's own map, fitted on the block the booster was early-stopped
    # against — `_fit_calibration`'s block, reached the same way. It is what
    # this fold's model would have published; see the argument above.
    monitor_raw = np.clip(_predict(occurrence, monitor.matrix), 0.0, 1.0)
    isotonic = IsotonicCalibrator.fit(
        [float(value) for value in monitor_raw],
        [bool(value) for value in monitor.positive],
    )
    return tuple(
        OutOfFoldPrediction(
            fold_id=fold.id,
            key=key,
            probability=float(isotonic(float(probability))),
            observed=bool(positive),
        )
        for key, probability, positive in zip(
            settled.keys, raw, settled.positive, strict=True
        )
    )


def forecast_rows(
    bundle: HurdleBundle, rows: Sequence[Mapping[str, Any]]
) -> tuple[HourForecast, ...]:
    """Compose one band and one expectation per row, through ticket 01's inversion.

    The only place a served number is produced, and it produces it by calling
    :func:`wattsteer_ml.mixture.compose`. The six predictions are the *inputs* to
    that call; none of them is multiplied by another here.

    ``p`` is the **calibrated** probability. The booster's raw output goes
    through the bundle's isotonic map, which clips it away from both endpoints,
    and then straight into ``compose`` as the breakpoint. There is no second
    route: nothing else in this function reads ``bundle.occurrence``.

    ``Q_pos`` is the **conformalised** quantile function. The three pinball
    outputs go through ``bundle.conformal``, which moves the 0.10 and 0.90 knots
    and leaves the median alone, and the corrected knots are what ``compose``
    inverts. A served band is therefore never uncorrected, and the correction is
    never applied to a composed number.

    Two clamps, and they are type-level rather than corrective. The raw output
    and the share are clipped to ``[0, 1]`` because a regression has no
    constraint saying so and a probability outside it is not one; the magnitudes
    are
    floored at zero because MWh are non-negative and
    :class:`~wattsteer_ml.mixture.MagnitudeQuantiles` refuses a negative knot.
    The floor **into** ``F_pos``'s support — strictly above ``τ`` — is the
    mixture's own business and is applied there, not here, so there is exactly
    one place that knows where the positive branch starts.
    """
    if not rows:
        return ()
    block = FeatureBlock.of(rows, bundle.contract, threshold_mw=bundle.threshold_mw)
    return _compose_with(bundle, block)


def day_grain_rows(
    bundle: HurdleBundle,
    rows: Sequence[Mapping[str, Any]],
    *,
    seed: int = ENSEMBLE_SEED,
    draws: int = ENSEMBLE_DRAWS,
) -> tuple[DayGrainForecast, ...]:
    """Day energy, peak power and day-level occurrence, per subsystem and day.

    The only place a figure above hour grain is produced, and it produces it by
    drawing 500 whole rows of the bundle's PIT matrix through the *same*
    mixtures :func:`forecast_rows` composed the hourly band from — not through a
    second inversion, and never by adding anything up.
    :func:`~wattsteer_ml.training.ensemble.draw_day_grain` holds the arithmetic;
    this function's whole job is to group the composed hours into days.

    **One draw plan for every subsystem of every day.** That is the hand-back
    forecaster ticket 08 needs: draw ``k`` is the same calibration day in all
    four subsystems, so the national day-total quantiles are a property of these
    draws and need no copula. Composing them is ticket 08's; producing the
    shared index is this function's.

    A ``(day, subsystem)`` with fewer than twenty-four composed hours is
    dropped rather than totalled — a day total over twenty-three hours is a
    different quantity wearing the same name.
    """
    grouped: dict[tuple[date, Subsystem], list[tuple[int, HurdleMixture]]] = {}
    for hour in forecast_rows(bundle, rows):
        grouped.setdefault((hour.key.target_date, hour.key.subsystem), []).append(
            (hour.key.local_hour, hour.forecast.mixture)
        )
    days = {
        key: [mixture for _, mixture in sorted(entries, key=lambda one: one[0])]
        for key, entries in grouped.items()
    }
    return draw_day_grain(
        days,
        matrix=bundle.pit,
        threshold_mw=bundle.threshold_mw,
        plan=DrawPlan.seeded(rows=bundle.pit.rows, seed=seed, draws=draws),
    )


def expected_mwh_for_block(
    bundle: HurdleBundle, block: FeatureBlock
) -> tuple[float, ...]:
    """``E[Y | x]`` per row of a block already encoded against this contract.

    The route the diagnosis attribution evaluates its ``g`` through, and the
    reason it exists rather than the attribution holding its own arithmetic:
    the explained quantity and the served quantity must not be allowed to drift
    apart, so both reach :func:`wattsteer_ml.mixture.compose` by the same three
    lines of :func:`_compose_block`. `docs/specs/diagnosis.md` calls this the
    fifth caller of the one composition.

    A block rather than rows because the attribution constructs its coalitions
    **in the encoded space** — ``x[S] ⊕ b[S̄]`` is a row of floats, and there is
    no feature-row mapping it came from to re-encode. The block carries the
    bundle's own contract, which is what keeps that space the same one the
    boosters were fitted in.
    """
    if block.contract != bundle.contract:
        raise TrainingError(
            "the block was encoded under a different feature contract than the "
            "bundle's; a row of floats means nothing without the list that "
            "ordered it"
        )
    return tuple(hour.forecast.expected_mwh for hour in _compose_with(bundle, block))


def _compose_with(bundle: HurdleBundle, block: FeatureBlock) -> tuple[HourForecast, ...]:
    """A finished bundle's estimators, unpacked onto :func:`_compose_block`."""
    return _compose_block(
        block,
        occurrence=bundle.occurrence,
        isotonic=bundle.calibration.isotonic,
        magnitude_p02=bundle.magnitude_p02,
        magnitude_p10=bundle.magnitude_p10,
        magnitude_p50=bundle.magnitude_p50,
        magnitude_p90=bundle.magnitude_p90,
        magnitude_mean=bundle.magnitude_mean,
        wind_share=bundle.wind_share,
        sub_threshold_means=bundle.sub_threshold_means,
        threshold_mw=bundle.threshold_mw,
        correction=bundle.conformal,
    )


def _compose_block(
    block: FeatureBlock,
    *,
    occurrence: lgb.Booster,
    isotonic: IsotonicCalibrator,
    magnitude_p02: lgb.Booster,
    magnitude_p10: lgb.Booster,
    magnitude_p50: lgb.Booster,
    magnitude_p90: lgb.Booster,
    magnitude_mean: lgb.Booster,
    wind_share: lgb.Booster,
    sub_threshold_means: SubThresholdMeans,
    threshold_mw: float,
    correction: ConformalCorrection | None,
) -> tuple[HourForecast, ...]:
    """The one place a band is built, from loose estimators rather than a bundle.

    Loose because of an ordering that is real rather than incidental: ``δ_lo``
    and ``δ_hi`` are fitted against the band this function composes on the
    calibration window, and a :class:`~wattsteer_ml.training.bundle.HurdleBundle`
    cannot exist before them. So the fit calls this with ``correction=None`` and
    serving calls it with the bundle's, and both reach
    :func:`wattsteer_ml.mixture.compose` — the only call to it in this
    service — by the same three lines.

    ``correction=None`` means *uncorrected*, and it is reachable from exactly
    one caller: :func:`_fit_conformal`, which is measuring how wrong the
    uncorrected band was. It is not a serving mode.
    """
    matrix = block.matrix
    raw = np.clip(_predict(occurrence, matrix), 0.0, 1.0)
    probability = [isotonic(float(value)) for value in raw]
    q02 = _predict(magnitude_p02, matrix)
    q10 = _predict(magnitude_p10, matrix)
    q50 = _predict(magnitude_p50, matrix)
    q90 = _predict(magnitude_p90, matrix)
    mean = _predict(magnitude_mean, matrix)
    share = np.clip(_predict(wind_share, matrix), 0.0, 1.0)
    return compose_estimates(
        block.keys,
        [
            HourEstimates(
                occurrence_probability=probability[index],
                q10=float(q10[index]),
                q50=float(q50[index]),
                q90=float(q90[index]),
                positive_mean_mwh=float(mean[index]),
                wind_share=float(share[index]),
                q02=float(q02[index]),
            )
            for index in range(len(block.keys))
        ],
        sub_threshold_means=sub_threshold_means,
        threshold_mw=threshold_mw,
        correction=correction,
    )


@dataclass(frozen=True)
class HourEstimates:
    """One row's estimated quantities, as scalars, before anything inverts them.

    The seam between *what estimated the six numbers* and *how a band is built
    from them*. Serving fills it from the bundle's boosters;
    :mod:`wattsteer_ml.evaluation.ladder` fills it from a base rate, a
    seven-day feature, a logistic regression or a forest — and every one of
    those reaches the product's band through :func:`compose_estimates` and so
    through :func:`wattsteer_ml.mixture.compose`, which is called in this module
    and in no other. The baseline ladder compares models; it must not also
    compare compositions.
    """

    #: ``p(x)``. Calibrated where the rung has a calibrator, raw where it does
    #: not — which the metrics row records rather than hides.
    occurrence_probability: float
    #: The three magnitude knots, **as estimated**, crossing and all. They are
    #: floored at zero here and sorted nowhere: the crossing is the measured
    #: ``crossing_rate`` and :class:`~wattsteer_ml.mixture.QuantileBand` is
    #: where the sort happens, after composition.
    q10: float
    q50: float
    q90: float
    #: ``Ê[Y | Y > τ, x]``, floored at zero. The mixture moves it into
    #: ``F_pos``'s support; that is not this type's business.
    positive_mean_mwh: float
    #: ``ŝ(x)``. ``None`` where a rung fits no share model, in which case the
    #: composed forecast carries no technology split at all rather than a
    #: fabricated one.
    wind_share: float | None = None
    #: ``q̂_pos^0.02``, where the estimator fitted one.
    #:
    #: ``None`` on every rung of the baseline ladder, which fits three knots and
    #: not four. A rung that did not fit a 2nd percentile must not be given one:
    #: :func:`compose_estimates` repeats ``q10`` there, which reproduces exactly
    #: the flat-below-the-first-knot shape those rungs have always had. The
    #: served model fills it, and that is the only place the composed P10 stops
    #: sitting on a flat.
    q02: float | None = None


def compose_estimates(
    keys: Sequence[RowKey],
    estimates: Sequence[HourEstimates],
    *,
    sub_threshold_means: SubThresholdMeans,
    threshold_mw: float,
    correction: ConformalCorrection | None = None,
) -> tuple[HourForecast, ...]:
    """Compose a band per row from loose scalars. **The only composition.**

    Every route from an estimate to a served interval passes through here, which
    is what lets the baseline ladder score a base rate and LightGBM with the
    same arithmetic. ``strict=True`` on the zip: a key without an estimate is a
    band composed against another hour's row.

    The two clamps are type-level rather than corrective — the knots and the
    conditional mean are floored at zero because MWh are non-negative and
    :class:`~wattsteer_ml.mixture.MagnitudeQuantiles` refuses a negative knot.
    The floor **into** ``F_pos``'s support is the mixture's own and is applied
    there.

    ``correction`` arrives as a
    :class:`~wattsteer_ml.mixture.TailShift` rather than as corrected knots
    (forecaster ticket 21). The knots handed to the mixture are the boosters'
    own, unmodified; the conformal shift is added by the mixture at the
    composed ``q``, which is the quantity the residuals were measured on. Every
    rung of the baseline ladder passes ``None`` and composes the same
    arithmetic with a neutral shift.
    """
    floor = 0.0
    forecasts: list[HourForecast] = []
    for key, estimate in zip(keys, estimates, strict=True):
        quantiles = MagnitudeQuantiles.from_boosters(
            # Repeating `q10` where no finer knot was fitted is what keeps the
            # baseline ladder comparing models rather than compositions: a rung
            # with three knots gets the three-knot shape, flat below 0.10.
            q02=max(floor, estimate.q10 if estimate.q02 is None else estimate.q02),
            q10=max(floor, estimate.q10),
            q50=max(floor, estimate.q50),
            q90=max(floor, estimate.q90),
        )
        forecasts.append(
            HourForecast(
                key=key,
                forecast=compose(
                    occurrence_probability=estimate.occurrence_probability,
                    positive_quantiles=quantiles,
                    tail_shift=None if correction is None else correction.shift(),
                    positive_mean_mwh=max(floor, estimate.positive_mean_mwh),
                    sub_threshold_mean_mwh=sub_threshold_means.mean_for(
                        key.subsystem, key.local_hour
                    ),
                    threshold_mw=threshold_mw,
                    wind_share=estimate.wind_share,
                ),
            )
        )
    return tuple(forecasts)


def _fit_calibration(
    occurrence: lgb.Booster,
    monitor: FeatureBlock,
    *,
    blocks: FoldBlocks,
    pool: OutOfFoldPool,
    incumbent_risk_bins: RiskBins | None,
) -> Calibration:
    """Isotonic on the calibration window; the curve and the edges on the pool.

    The classifier is scored on the calibration window it was early-stopped
    against, which is the one thing that window is used for after the fits, and
    the base learners are **not** refit. The arithmetic lives in
    :mod:`wattsteer_ml.training.calibration`; this function's whole job is to
    hand it the right block.
    """
    raw = np.clip(_predict(occurrence, monitor.matrix), 0.0, 1.0)
    return calibrate(
        raw=[float(value) for value in raw],
        observed=[bool(value) for value in monitor.positive],
        pool=pool,
        calibration_window=(blocks.calibration_start, blocks.calibration_end),
        incumbent_risk_bins=incumbent_risk_bins,
    )


def _fit_conformal(
    monitor_positives: FeatureBlock,
    *,
    blocks: FoldBlocks,
    fold: Fold,
    occurrence: lgb.Booster,
    isotonic: IsotonicCalibrator,
    magnitude_p02: lgb.Booster,
    magnitude_p10: lgb.Booster,
    magnitude_p50: lgb.Booster,
    magnitude_p90: lgb.Booster,
    magnitude_mean: lgb.Booster,
    wind_share: lgb.Booster,
    sub_threshold_means: SubThresholdMeans,
    threshold_mw: float,
) -> ConformalCorrection:
    """``δ_lo`` and ``δ_hi``, on the calibration window's curtailed hours.

    Against the **composed** band, which is what the spec asks for and what
    makes the correction a statement about the interval the product ships
    rather than about one booster's output: this function composes the window
    with ``correction=None`` and hands the resulting bands to
    :func:`~wattsteer_ml.training.conformal.conformalise`.

    The rows are the calibration block's curtailed hours, and only those.
    ``Q_pos`` is conditional on ``Y > τ``, so a sub-threshold hour is not a test
    of the tail's width; the block is already masked by the feature function's
    own ``y_has_curtailment``, and
    :func:`~wattsteer_ml.training.conformal.residuals` re-checks each label
    against ``τ`` so the two definitions cannot silently diverge.

    The arithmetic is entirely in :mod:`wattsteer_ml.training.conformal`; this
    function's whole job is to hand it the right block, exactly as
    :func:`_fit_calibration` does for the isotonic map.
    """
    if not len(monitor_positives):
        raise TrainingError(
            f"{fold.id}: no hour of the calibration block "
            f"{blocks.calibration_start.isoformat()}–"
            f"{blocks.calibration_end.isoformat()} is above τ = {threshold_mw} MWh, "
            "so there are no residuals to rank and the P10 cannot carry a "
            "coverage statement; this is a statement about the window, not a "
            "configuration to relax"
        )
    composed = _compose_block(
        monitor_positives,
        occurrence=occurrence,
        isotonic=isotonic,
        magnitude_p02=magnitude_p02,
        magnitude_p10=magnitude_p10,
        magnitude_p50=magnitude_p50,
        magnitude_p90=magnitude_p90,
        magnitude_mean=magnitude_mean,
        wind_share=wind_share,
        sub_threshold_means=sub_threshold_means,
        threshold_mw=threshold_mw,
        correction=None,
    )
    return conformalise(
        _scored(composed, monitor_positives),
        window=(blocks.calibration_start, blocks.calibration_end),
    )


def _fit_pit(
    monitor: FeatureBlock,
    *,
    blocks: FoldBlocks,
    fold: Fold,
    occurrence: lgb.Booster,
    isotonic: IsotonicCalibrator,
    magnitude_p02: lgb.Booster,
    magnitude_p10: lgb.Booster,
    magnitude_p50: lgb.Booster,
    magnitude_p90: lgb.Booster,
    magnitude_mean: lgb.Booster,
    wind_share: lgb.Booster,
    sub_threshold_means: SubThresholdMeans,
    threshold_mw: float,
    correction: ConformalCorrection,
) -> PitMatrix:
    """``U`` on the calibration window's settled hours, against the served band.

    ``correction`` is passed rather than omitted, and that is the whole
    ordering: ``δ_lo`` and ``δ_hi`` are fitted first, on this same window's
    curtailed hours, and the PIT is then taken of the band the product would
    actually have shown. A matrix built from the uncorrected band would describe
    a distribution nobody serves, and the ensemble would map its draws back
    through a different one.

    **Every settled hour, not only the curtailed ones.** The conformal residuals
    are about the width of the conditional interval and so see positives only;
    ``U`` is about the whole predictive CDF, and a sub-threshold hour is exactly
    what supplies the ``Uniform(0, 1 − p)`` mass that keeps the column uniform.

    The arithmetic lives in :mod:`wattsteer_ml.training.ensemble`; this
    function's job is to hand it the right block, as :func:`_fit_calibration`
    and :func:`_fit_conformal` do for theirs.

    **The same in-sample optimism this file already declares reaches here too.**
    The band composed on this window is a hair closer to its labels than it will
    be out of sample, so ``U`` is very slightly *under*-dispersed and the day
    band it produces is very slightly narrow. It is stated rather than
    corrected, for the reason the module docstring gives about ``δ``.
    """
    if not len(monitor):
        raise TrainingError(
            f"{fold.id}: the calibration block "
            f"{blocks.calibration_start.isoformat()}–"
            f"{blocks.calibration_end.isoformat()} carries no settled label, so "
            "there is no PIT to take and no day-grain figure that is not a sum "
            "of quantiles"
        )
    composed = _compose_block(
        monitor,
        occurrence=occurrence,
        isotonic=isotonic,
        magnitude_p02=magnitude_p02,
        magnitude_p10=magnitude_p10,
        magnitude_p50=magnitude_p50,
        magnitude_p90=magnitude_p90,
        magnitude_mean=magnitude_mean,
        wind_share=wind_share,
        sub_threshold_means=sub_threshold_means,
        threshold_mw=threshold_mw,
        correction=correction,
    )
    return fit_pit_matrix(
        [
            (hour.key, hour.forecast.mixture, float(observed))
            for hour, observed in zip(composed, monitor.total_mwh.tolist(), strict=True)
        ],
        window=(blocks.calibration_start, blocks.calibration_end),
    )


def _fold_day_grain(
    bundle: HurdleBundle, rows: Sequence[Mapping[str, Any]], *, fold: Fold
) -> DayGrainCoverage | None:
    """``day_total_coverage`` and ``peak_coverage`` on this fold's test period.

    Measured on the **served** day band — drawn from the bundle's own matrix
    through the bundle's own mixtures — because the number the card publishes
    has to be a property of what the product would have shown. Nothing about it
    feeds back: the matrix was fitted before this function ran, on a different
    window, and :class:`~wattsteer_ml.training.ensemble.PitMatrix` has no field
    a coverage number could reach.

    ``None`` when no test day has all twenty-four hours settled.
    """
    if not rows:
        return None
    block = FeatureBlock.of(rows, bundle.contract, threshold_mw=bundle.threshold_mw)
    labelled = block.select(block.labelled)
    if not len(labelled):
        return None
    observed: dict[tuple[date, Subsystem], list[float]] = {}
    for key, value in zip(labelled.keys, labelled.total_mwh.tolist(), strict=True):
        observed.setdefault((key.target_date, key.subsystem), []).append(float(value))
    return DayGrainCoverage.of(observed, day_grain_rows(bundle, rows), fold_id=fold.id)


def _fold_headline_check(
    bundle: HurdleBundle,
    rows: Sequence[Mapping[str, Any]],
    *,
    fold: Fold,
    group_map: DriverGroupMap,
    targets: int,
    seed: int,
) -> HeadlineFeatureCheck:
    """Whether each group's declared headline is the member doing the work.

    Measured on the fold's **test** rows — "the newest fold", in the spec's
    words, and the same rows ``_fold_coverage`` and ``_fold_day_grain`` are
    measured over. Against the bundle's own frozen background, so the ``|φ|``
    a member is ranked by is the same kind of quantity as the bar it would sit
    beside.

    ``g`` is :func:`expected_mwh_for_block` with this bundle applied, so the
    check reads the composition the product serves and holds none of its own.

    Unlike the coverage blocks beside it there is no ``None`` here. A card that
    could not say whether its subtitles are the right subtitles is a card that
    cannot say which partition produced it either, and forecaster 30 settled
    that argument for ``background``: the field is required and a fold that
    cannot produce one is a training failure whose repair is a longer run
    window, not a card with a hole in it.
    """
    if not rows:
        raise TrainingError(
            f"{fold.id}: the test block contains no row, so the declared "
            "headline features cannot be checked against the newest fold; the "
            "card records which member of each group moves the model and a "
            "fold with no newest rows cannot answer that"
        )
    block = FeatureBlock.of(rows, bundle.contract, threshold_mw=bundle.threshold_mw)
    return check_headline_features(
        block=block,
        background=bundle.background,
        expectation=lambda one: expected_mwh_for_block(bundle, one),
        group_map=group_map,
        fold_id=fold.id,
        targets=targets,
        seed=seed,
    )


def _fold_coverage(
    bundle: HurdleBundle, rows: Sequence[Mapping[str, Any]], *, fold: Fold
) -> CoverageReport | None:
    """Empirical coverage of this fold's test period, or ``None`` if unmeasured.

    Measured on the **served** band — the correction is already in the bundle
    and :func:`_compose_with` applies it — because the number the card publishes
    has to be a property of what the product would have shown, not of an
    intermediate. Nothing about it feeds back: the correction was fitted before
    this function ran, on a different window, and
    :class:`~wattsteer_ml.training.conformal.ConformalCorrection` has no field a
    coverage number could reach.

    ``None`` when the test period holds no settled curtailed hour. A fold with
    nothing above ``τ`` has no interval whose coverage could fail, and a row of
    zeros in that slot would read as total failure.
    """
    if not rows:
        return None
    block = FeatureBlock.of(rows, bundle.contract, threshold_mw=bundle.threshold_mw)
    labelled = block.select(block.labelled)
    scored = labelled.select(labelled.positive)
    if not len(scored):
        return None
    return CoverageReport.of(
        _scored(_compose_with(bundle, scored), scored), fold_id=fold.id
    )


def _scored(
    forecasts: Sequence[HourForecast], block: FeatureBlock
) -> tuple[ScoredHour, ...]:
    """Pair each composed hour with the label of the row it was composed from.

    ``strict=True``: :func:`_compose_block` walks ``block.keys`` in order and
    emits one forecast per row, so a length mismatch here would mean the two
    have drifted apart, and a silently truncated ``zip`` would score a band
    against another hour's label.
    """
    return tuple(
        ScoredHour(key=hour.key, forecast=hour.forecast, observed_mwh=float(observed))
        for hour, observed in zip(forecasts, block.total_mwh.tolist(), strict=True)
    )


def fit_sub_threshold_means(block: FeatureBlock) -> SubThresholdMeans:
    """``μ_sub`` — the base-fit empirical mean over sub-threshold rows, 96 numbers.

    By (subsystem, local hour), as the spec specifies. A cell the base-fit block
    has no sub-threshold row for falls back to that subsystem's mean and then to
    the pooled one, so the table is complete: a serving path that had to handle a
    missing cell would need a rule for it, and a rule for a missing value is an
    imputation policy, which is the one thing this model does not have.

    Every value is a mean over rows the feature function itself marked
    sub-threshold, so every value is at or below ``τ`` — the bound
    :class:`~wattsteer_ml.mixture.HurdleMixture` asserts on construction.
    """
    labelled = block.select(block.labelled)
    sub = labelled.select(~labelled.positive)
    totals: dict[tuple[Subsystem, int], list[float]] = {}
    by_subsystem: dict[Subsystem, list[float]] = {}
    pooled: list[float] = []
    for key, value in zip(sub.keys, sub.total_mwh.tolist(), strict=True):
        totals.setdefault((key.subsystem, key.local_hour), []).append(value)
        by_subsystem.setdefault(key.subsystem, []).append(value)
        pooled.append(value)
    pooled_mean = _mean(pooled, 0.0)
    return SubThresholdMeans(
        values=tuple(
            tuple(
                _mean(
                    totals.get((code, hour), []),
                    _mean(by_subsystem.get(code, []), pooled_mean),
                )
                for hour in range(HOURS_PER_DAY)
            )
            for code in SUBSYSTEM_CODES
        )
    )


def partition_rows(
    rows: Sequence[Mapping[str, Any]], blocks: FoldBlocks
) -> tuple[list[Mapping[str, Any]], list[Mapping[str, Any]], list[Mapping[str, Any]]]:
    """Split rows into the three blocks. No date arithmetic beyond comparison.

    Public because the baseline ladder splits the *same* rows by the *same*
    boundaries before it fits a rung, and two functions that partition a fold
    are two chances for the ladder's base fit and the served model's to differ
    by a day.
    """
    base_fit: list[Mapping[str, Any]] = []
    calibration: list[Mapping[str, Any]] = []
    test: list[Mapping[str, Any]] = []
    for row in rows:
        target = row["target_date"]
        if blocks.base_fit_start <= target <= blocks.base_fit_end:
            base_fit.append(row)
        elif blocks.calibration_start <= target <= blocks.calibration_end:
            calibration.append(row)
        elif blocks.test_start <= target <= blocks.test_end:
            test.append(row)
        else:
            raise TrainingError(
                f"{target.isoformat()} is in none of this fold's three blocks "
                f"({blocks.base_fit_start.isoformat()}–{blocks.test_end.isoformat()}); "
                "a row outside them belongs to a window nobody declared"
            )
    return base_fit, calibration, test


def _fit_quantile(
    config: ModelConfig,
    positives: FeatureBlock,
    monitor: FeatureBlock,
    alpha: float,
) -> lgb.Booster:
    """One pinball booster, on curtailed hours only."""
    return _fit(
        config=config,
        params=config.params(
            objective="quantile", role=f"magnitude_q{alpha:.2f}", alpha=alpha
        ),
        train=positives,
        label=positives.total_mwh,
        monitor=monitor,
        monitor_label=monitor.total_mwh,
    )


def _fit(
    *,
    config: ModelConfig,
    params: Mapping[str, Any],
    train: FeatureBlock,
    label: npt.NDArray[np.float64],
    monitor: FeatureBlock,
    monitor_label: npt.NDArray[np.float64],
) -> lgb.Booster:
    """One booster. Fitted on ``train``; ``monitor`` only chooses where to stop."""
    if not len(train):
        raise TrainingError("a booster cannot be fitted on an empty block")
    contract = train.contract
    names = list(contract.feature_names)
    categorical = list(contract.categorical_indices)
    dataset = lgb.Dataset(
        train.matrix,
        label=label,
        feature_name=names,
        categorical_feature=categorical,
        free_raw_data=False,
    )
    callbacks: list[Any] = [lgb.log_evaluation(period=0)]
    valid_sets: list[Any] = []
    if config.early_stopping_rounds and len(monitor):
        valid_sets.append(
            lgb.Dataset(
                monitor.matrix,
                label=monitor_label,
                reference=dataset,
                feature_name=names,
                categorical_feature=categorical,
                free_raw_data=False,
            )
        )
        callbacks.append(lgb.early_stopping(config.early_stopping_rounds, verbose=False))
    booster = lgb.train(
        dict(params),
        dataset,
        num_boost_round=config.num_boost_round,
        valid_sets=valid_sets,
        callbacks=callbacks,
    )
    # The Dataset holds a reference to the training matrix; the bundle must not.
    return lgb.Booster(model_str=booster.model_to_string())


def _predict(
    booster: lgb.Booster, matrix: npt.NDArray[np.float64]
) -> npt.NDArray[np.float64]:
    predictions = np.asarray(booster.predict(matrix), dtype=np.float64)
    return predictions.reshape(matrix.shape[0])


def _wind_share(block: FeatureBlock) -> npt.NDArray[np.float64]:
    """``wind_mwh / total_mwh`` on the positive rows. NaN where either is NULL.

    Not clipped and not filled: LightGBM drops a row whose *label* is NaN from
    the objective, which is the correct treatment of an hour whose split is
    unknown, and a filled 0.5 would be a fabricated observation.
    """
    with np.errstate(invalid="ignore", divide="ignore"):
        share = block.wind_mwh / block.total_mwh
    return np.asarray(share, dtype=np.float64)


def _fidelity_counts(rows: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    """``vintage_fidelity`` as counts. Two numbers, never one average."""
    counts: dict[str, int] = {}
    for row in rows:
        value = row.get("vintage_fidelity")
        key = str(value) if value is not None else "unknown"
        counts[key] = counts.get(key, 0) + 1
    return counts


def _mean(values: Sequence[float], fallback: float) -> float:
    return sum(values) / len(values) if values else fallback
