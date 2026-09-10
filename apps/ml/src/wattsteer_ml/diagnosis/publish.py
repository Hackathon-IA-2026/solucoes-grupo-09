"""Assembling one lane-day's attribution publication from real rows.

The mirror of :mod:`wattsteer_ml.publication`'s ``build_publication``, for the
other half of the same job chain. `docs/specs/api-surface.md` puts the
publication table's third row on completion of each forecast publication, and
`docs/specs/diagnosis.md` fixes the direction: the worker calls
``POST /internal/publish/diagnosis``, this service computes and returns, and the
**worker** writes. Nothing here inserts, opens a session or holds an engine.

## Where "typical" comes from, stated rather than assumed

An attribution measures a day against a *matched background* — 128 rows per
``(subsystem, local_hour)`` cell, so that "typical" is hour-specific and
subsystem-specific. `docs/specs/diagnosis.md` asks the forecaster's artifact to
carry that sample frozen in the bundle, drawn once from the base-fit block with
a stamped seed. **It does not carry one:** ``HurdleBundle`` has no such field,
and no forecaster ticket had been sliced for it — see
`.scratch/forecaster/issues/30-the-matched-background-in-the-bundle.md`, written
by the ticket that needed it.

So this module draws the sample here, and the whole of the honesty question is
*what it draws from*:

- **It draws from real ingested rows.** The base-fit window is read off the
  promoted artifact's own card — ``data.base_fit_window`` — and the rows come
  back from ``feature_rows(...)`` under the lane's own gate profile, feature set
  and threshold. These are the days the boosters were fitted on. Nothing is
  simulated, no cell is filled from a neighbouring hour, and a short cell is a
  refusal rather than a draw with replacement (see
  :func:`~wattsteer_ml.diagnosis.background.draw_matched_background`).
- **It says so on every row.** ``background_source`` is
  :data:`~wattsteer_ml.diagnosis.background.BASE_FIT_SOURCE` and not
  ``artifact``, beside ``background_seed`` and ``background_rows``, and the
  gateway parses and stores all three. A row measured against a publish-time
  draw is therefore *distinguishable* from one measured against a frozen sample
  — which is the property :mod:`wattsteer_ml.diagnosis.publication` says the
  field exists for.
- **The seed is the artifact's, not the clock's.** :func:`background_seed`
  derives it from the ``artifact_id``, so two publications of the same day under
  the same artifact draw the *same* sample and produce the same numbers. That is
  what keeps the gateway's digest idempotence real: a redelivered task writes
  nothing rather than appending a vintage that differs only by a seed.

What is still weaker than the spec's ask, and is the reason the forecaster
ticket exists: the sample is reproducible from the artifact *plus the base-fit
window as the feature function returns it today*, not from the artifact alone.

## The rules cannot be skipped, and this module does not try

``AttributionRow.rule_flags`` and ``rules_evaluated`` have no defaults since
api-surface 10's reconciliation pass, and ``_assert_the_rules_ran`` refuses an
empty roll call. So a publish path that skipped ``apply_rules`` cannot construct
a row at all, and this module reaches the type through the one call that hands
the flags, the demotions and the roll call over together —
``AttributionRow(attribution=…, readings=…, **outcome.for_row())``.

``recent_reasons`` arrives *on the request*, per subsystem, read by the worker at
``actuals_cutoff`` — ``apps/api/src/diagnosis/reason-mix.ts``. A subsystem with
no qualifying settled day is **absent** from the map rather than present with
zeros, so ``unmodelled_outage_regime`` does not fire for it; "nothing was
restricted" and "we cannot see that day yet" must not be one input.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from typing import Any

import numpy as np
import numpy.typing as npt

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.diagnosis.background import (
    BACKGROUND_ROWS_PER_CELL,
    BASE_FIT_SOURCE,
    MatchedBackground,
    draw_matched_background,
)
from wattsteer_ml.diagnosis.composed_target import bundle_expectation
from wattsteer_ml.diagnosis.day_attribution import attribute_day, day_rows
from wattsteer_ml.diagnosis.driver_groups import (
    DRIVER_GROUP_CODES,
    DRIVER_GROUP_MAP,
    DriverGroupMap,
)
from wattsteer_ml.diagnosis.publication import (
    AttributionPublication,
    AttributionRow,
    build_attribution_publication,
    headline_readings,
)
from wattsteer_ml.diagnosis.rule_context import ReasonMix, build_rule_context
from wattsteer_ml.diagnosis.rules import apply_rules
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.lanes import Lane
from wattsteer_ml.training import (
    CORRECTION_REGIME,
    FeatureBlock,
    LoadedArtifact,
    day_grain_rows,
    forecast_rows,
)


class DiagnosisPublicationRefusedError(Exception):
    """This lane-day has no publishable attribution, and the reason has a name.

    Separate from ``AttributionPublicationError``, which is an assembly bug — a
    payload that disagrees with itself. These are the conditions under which a
    *correct* implementation produces nothing, and each one has its own repair:

    - ``no_matched_background`` — the artifact carries no frozen sample and its
      base-fit window cannot supply one at ``rows_per_cell``. The repair is the
      forecaster ticket, or a longer run window.
    - ``no_base_fit_window`` — the card does not say which days the boosters
      were fitted on, so there is nothing to draw from.
    - ``contract_and_groups_disagree`` — some driver group has no column in this
      artifact's contract, or some column is in no group. A player who cannot
      move is a bar that is structurally zero, and the repair is a line in
      ``driver_groups.yaml``.
    - ``incomplete_day`` — the feature rows are not a whole Brasilia civil day
      for any subsystem.
    - ``null_headline_feature`` — a driver group's headline feature was NULL for
      some hour of the day or somewhere in its background cells, so the
      observed/typical pair beside that bar has no value. **This one is a gap in
      the wire contract and not only in this module** — see
      :func:`_null_headline_features`.

    They are named rather than flattened because the gateway admits the code and
    an operator reading a job log has to know whether to wait, to retrain, or to
    edit a YAML file.
    """

    def __init__(self, condition: str, reason: str) -> None:
        super().__init__(reason)
        self.condition = condition
        self.reason = reason


#: The conditions :class:`DiagnosisPublicationRefusedError` distinguishes. A
#: closed tuple so a test can assert every one of them is reachable rather than
#: trusting that the four docstring bullets are the four branches.
REFUSAL_CONDITIONS: tuple[str, ...] = (
    "no_base_fit_window",
    "no_matched_background",
    "contract_and_groups_disagree",
    "incomplete_day",
    "null_headline_feature",
)


def background_seed(artifact_id: str) -> int:
    """The seed this artifact's background is drawn under, every time.

    Derived from the artifact id and from nothing else — not the clock, not the
    target date, not a module-level constant that a second lane would share.
    Two consequences, and both are the point:

    1. **A re-publication is not a new vintage.** The gateway appends a
       ``data_version`` when the digest moves; a seed off the clock would move
       every figure on every re-run, so a redelivered task would write a second
       explanation of one day differing from the first only by noise.
    2. **A retrain redraws.** A new artifact id is a new seed, which is correct:
       the base-fit window moved, and a background drawn from the old window
       would measure a new model's day against an old model's typical.

    31 bits, because the value is also published on the row as an integer.
    """
    digest = hashlib.blake2b(artifact_id.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") % (2**31)


def base_fit_window(loaded: LoadedArtifact) -> tuple[date, date]:
    """The days the boosters were fitted on, off the artifact's own card.

    Read rather than derived: the fold calendar plus a run window would give a
    *second* answer, and the background has to be drawn from the block this
    artifact was actually fitted on. ``card.data.base_fit_window`` is written for
    every artifact, refused or promoted.

    Raises:
        DiagnosisPublicationRefusedError: ``no_base_fit_window`` — the card does
            not carry one, so there is no block to draw a "typical" from and
            this module will not substitute a window of its own choosing.
    """
    data = loaded.card.get("data")
    window = data.get("base_fit_window") if isinstance(data, Mapping) else None
    start = window.get("start") if isinstance(window, Mapping) else None
    end = window.get("end") if isinstance(window, Mapping) else None
    if not isinstance(start, str) or not isinstance(end, str):
        raise DiagnosisPublicationRefusedError(
            "no_base_fit_window",
            f"{loaded.artifact_id}: the card carries no base-fit window, so the "
            "matched background has no block to be drawn from. An attribution "
            "measures a day against a typical one and this artifact cannot say "
            "which days were typical of it",
        )
    return date.fromisoformat(start), date.fromisoformat(end)


def build_diagnosis_publication(
    rows: Sequence[Mapping[str, Any]],
    base_fit_rows: Sequence[Mapping[str, Any]],
    *,
    lane: Lane,
    loaded: LoadedArtifact,
    target_date: date,
    published_at: datetime,
    group_map: DriverGroupMap = DRIVER_GROUP_MAP,
    rows_per_cell: int = BACKGROUND_ROWS_PER_CELL,
    recent_reasons: Mapping[Subsystem, ReasonMix] | None = None,
) -> AttributionPublication:
    """Every subsystem's explanation of one lane-day, as the worker will write it.

    Args:
        rows: ``feature_rows(target_date, target_date, ...)`` for this lane,
            exactly as :func:`~wattsteer_ml.features.read_serving_rows` returned
            them.
        base_fit_rows: the same function over :func:`base_fit_window`. Read by
            the caller so that this function performs no I/O and the window it
            was read over is visible at the call site.
        lane: the lane being published; the bundle is checked against it.
        loaded: the promoted bundle and its card.
        target_date: the civil day being explained.
        published_at: ``gate_at(target_date, gate_profile)`` — the forecast
            publication's instant, passed in rather than computed. An
            attribution is published *with* the forecast it explains, so a
            request-time stamp would make the origin a lie.
        group_map: the eight players. An argument for the same reason
            :func:`~wattsteer_ml.diagnosis.day_attribution.attribute_day` takes
            one — the fixture contract in the tests is a fraction of the real
            feature table, so the real map has no column for some groups there.
        rows_per_cell: ``|B(s, h)|``. Defaults to the spec's 128 and the route
            passes nothing else.
        recent_reasons: the most recent settled day's reported reason mix per
            subsystem, as the worker read it and put it on the request. A
            subsystem absent from the map has no mix and
            ``unmodelled_outage_regime`` does not fire for it — never an empty
            mix, which would be a rule deciding from no data that nothing was
            restricted.

    Raises:
        DiagnosisPublicationRefusedError: one of :data:`REFUSAL_CONDITIONS`.
        wattsteer_ml.publication.PublicationError: the bundle is bound to
            another lane.
        AttributionPublicationError: the assembled rows disagree with themselves.
    """
    from wattsteer_ml.publication import PublicationError

    bundle = loaded.bundle
    if bundle.lane != lane:
        raise PublicationError(
            f"the bundle is bound to {bundle.lane.directory_name} and this "
            f"attribution publication is for {lane.directory_name}"
        )
    if not rows:
        raise DiagnosisPublicationRefusedError(
            "incomplete_day",
            f"{lane.directory_name}: the feature function returned no row for "
            f"{target_date.isoformat()}; there is no day to explain and an "
            "explanation of zero hours is not one",
        )

    background = _background(base_fit_rows, loaded=loaded, rows_per_cell=rows_per_cell)

    day_block = FeatureBlock.of(rows, bundle.contract, threshold_mw=bundle.threshold_mw)
    expectation = bundle_expectation(bundle)

    # The two serving figures a rule reads, taken from the *forecast* of these
    # same rows rather than recomputed: `hours_p50_nonzero` is a count over the
    # composed hourly bands and the day-grain probability is the path ensemble's
    # own. A second computation of either here would be a second producer of a
    # published quantity.
    non_zero: dict[tuple[date, Subsystem], int] = {}
    for hour in forecast_rows(bundle, rows):
        cell = (hour.key.target_date, hour.key.subsystem)
        non_zero[cell] = non_zero.get(cell, 0) + (
            1 if hour.forecast.band.p50 > 0.0 else 0
        )
    probabilities: dict[tuple[date, Subsystem], float] = {
        (day.target_date, day.subsystem): day.day_occurrence_probability
        for day in day_grain_rows(bundle, rows)
    }

    risk_bins = _risk_bins(bundle)
    assembled: list[AttributionRow] = []
    for subsystem in SUBSYSTEM_CODES:
        cell = (target_date, subsystem)
        if cell not in probabilities or cell not in non_zero:
            # A subsystem the composed forecast dropped has no day-grain
            # probability, and a rule reading a zero there would be reading an
            # invented number. Skipped, and the publication is short a
            # subsystem — which `AttributionPublication.subsystems` reports.
            continue
        keys, target_rows = _day(day_block, subsystem=subsystem, target_date=target_date)
        try:
            attribution = attribute_day(
                keys=keys,
                target_rows=target_rows,
                background=background,
                expectation=expectation,
                group_map=group_map,
            )
        except ValueError as error:
            raise DiagnosisPublicationRefusedError(
                "contract_and_groups_disagree",
                f"{lane.directory_name} {subsystem} {target_date.isoformat()}: {error}",
            ) from error
        null_headlines = _null_headline_features(
            keys=keys,
            target_rows=target_rows,
            background=background,
            group_map=group_map,
        )
        if null_headlines:
            raise DiagnosisPublicationRefusedError(
                "null_headline_feature",
                f"{lane.directory_name} {subsystem} {target_date.isoformat()}: "
                f"{', '.join(null_headlines)} is a driver group's headline "
                "feature and is NULL for at least one hour of the day or of its "
                "background, so the observed/typical pair beside that bar has no "
                "value. The pair is a required number on the wire at both grains, "
                "so the whole day is refused rather than published with a zero or "
                "with a mean taken over the hours that happened to have a reading",
            )
        readings = headline_readings(
            attribution,
            keys=keys,
            target_rows=target_rows,
            background=background,
            group_map=group_map,
        )
        outcome = apply_rules(
            build_rule_context(
                attribution,
                target_rows=target_rows,
                feature_names=background.feature_names,
                risk_bins=risk_bins,
                day_occurrence_probability=probabilities[cell],
                hours_p50_nonzero=non_zero[cell],
                recent_reasons=(recent_reasons or {}).get(subsystem),
                group_map=group_map,
            )
        )
        # The one call that hands the flags, the demotions and the roll call
        # over together. Spelling the three out here would be spelling out a
        # lie's opportunity: `rules_evaluated` has no default, and a path that
        # wanted an empty-flagged row would have to invent a roll call.
        assembled.append(
            AttributionRow(
                attribution=attribution, readings=readings, **outcome.for_row()
            )
        )

    if not assembled:
        raise DiagnosisPublicationRefusedError(
            "incomplete_day",
            f"{lane.directory_name} {target_date.isoformat()}: no subsystem had "
            "both a composed day and a whole 24-hour block, so there is nothing "
            "to explain. An absence is refused rather than published as an empty "
            "explanation",
        )

    return build_attribution_publication(
        assembled,
        lane=lane.directory_name,
        feature_set=lane.feature_set,
        gate_profile=lane.gate_profile,
        artifact_id=loaded.artifact_id,
        target_date=target_date,
        published_at=published_at,
        threshold_mw=bundle.threshold_mw,
        correction_regime=CORRECTION_REGIME,
    )


def _background(
    base_fit_rows: Sequence[Mapping[str, Any]],
    *,
    loaded: LoadedArtifact,
    rows_per_cell: int,
) -> MatchedBackground:
    """``B(s, h)`` for this artifact, drawn from its own base-fit rows.

    Every failure here is ``no_matched_background`` and none of them is a
    fallback: a cell short of ``rows_per_cell`` is refused rather than drawn
    with replacement or filled from a neighbouring hour, because either would
    make one hour's "typical" thinner than another's and nothing downstream
    would say so.
    """
    bundle = loaded.bundle
    if not base_fit_rows:
        raise DiagnosisPublicationRefusedError(
            "no_matched_background",
            f"{loaded.artifact_id}: the feature function returned no row over "
            "this artifact's base-fit window, so there is no block to draw a "
            "matched background from. The artifact carries no frozen sample "
            "either — see forecaster 30",
        )
    try:
        block = FeatureBlock.of(
            base_fit_rows, bundle.contract, threshold_mw=bundle.threshold_mw
        )
        return draw_matched_background(
            block,
            seed=background_seed(loaded.artifact_id),
            rows_per_cell=rows_per_cell,
            # Never `ARTIFACT_SOURCE`. The bundle carries no frozen sample, and
            # a row that claimed one would be indistinguishable from a row
            # measured against the sample the spec asks for.
            source=BASE_FIT_SOURCE,
        )
    except ValueError as error:
        raise DiagnosisPublicationRefusedError(
            "no_matched_background",
            f"{loaded.artifact_id}: no matched background can be drawn from "
            f"this artifact's base-fit window — {error}. 'Typical' has no "
            "definition for this lane, and an attribution measured against an "
            "invented one is worse than an absent explanation",
        ) from error


def _null_headline_features(
    *,
    keys: Sequence[RowKey],
    target_rows: npt.NDArray[np.float64],
    background: MatchedBackground,
    group_map: DriverGroupMap,
) -> tuple[str, ...]:
    """Headline features with no reading for this day, at either grain.

    **A gap this ticket found rather than closed, and it is not this module's.**
    ``DriverReading`` refuses a non-finite ``observed`` or ``typical``, and the
    gateway's parser requires both as numbers on every one of the sixteen driver
    rows. But three of the eight real headline features are in the weather block
    — ``weather_expected_wind_mwh``, ``weather_expected_vre_ramp_1h`` and
    ``weather_centroid_coverage`` — and that block arrives from one run and goes
    NULL together. So a day with a missing weather run has no publishable
    observed/typical pair for those bars.

    The design already *knows* this happens: ``RuleContext`` carries
    ``null_headline_features`` for exactly it, and the ``stale_inputs`` rule can
    withhold the narration over it. What is missing is a representation for the
    pair's absence on the wire — the field is a required number and there is no
    ``observed_absent_reason`` beside it — so the intended outcome (publish the
    ranking, flag the degradation) is not expressible today.

    Until it is, this is a refusal. The two alternatives are both worse and both
    invisible once stored: a zero is the invented number the whole spec is
    against, and a mean over the hours that happened to carry a reading is a
    *different* "typical" than the one ``v(∅)`` was averaged over, published
    under the same name.

    Checked over the target rows **and** the background cells, because the pair
    is two numbers and either half can be the missing one.
    """
    names = background.feature_names
    index = {name: position for position, name in enumerate(names)}
    absent: list[str] = []
    for code in DRIVER_GROUP_CODES:
        feature = group_map.group(code).headline_feature
        column = index.get(feature)
        if column is None:
            # Not this condition: a headline feature outside the contract is
            # `contract_and_groups_disagree`, and `headline_readings` says so.
            continue
        if bool(np.isnan(target_rows[:, column]).any()) or any(
            bool(np.isnan(background.cell_for(key).matrix[:, column]).any())
            for key in keys
        ):
            absent.append(feature)
    return tuple(dict.fromkeys(absent))


def _day(
    block: FeatureBlock, *, subsystem: Subsystem, target_date: date
) -> tuple[tuple[RowKey, ...], npt.NDArray[np.float64]]:
    """One subsystem's 24 rows, or ``incomplete_day`` naming what was missing."""
    try:
        return day_rows(
            block.keys, block.matrix, subsystem=subsystem, target_date=target_date
        )
    except ValueError as error:
        raise DiagnosisPublicationRefusedError("incomplete_day", str(error)) from error


def _risk_bins(bundle: Any) -> dict[str, tuple[float, float]]:
    """The artifact's published class edges — the one edge a rule may read."""
    bins = bundle.calibration.risk_bins.bins
    return {"low": bins.low, "elevated": bins.elevated, "high": bins.high}
