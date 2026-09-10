"""The out-of-fold forecasts, kept — and kept unservable.

`docs/specs/replay.md`, "Where the `fold_holdout` forecasts come from":

    The backtest already computes a composed band for every test row in every
    fold — that is what `qloss_mwh` is computed from. It then discards them.
    Replay's entire storage requirement is to stop discarding them.

This module is that sentence. It takes a fold that has already been fitted —
:class:`~wattsteer_ml.training.hurdle.TrainedFold`, the artifact
:class:`~wattsteer_ml.evaluation.ladder.LightGbmRung` fits at the top of the
ladder — and turns its **test block** into
:class:`~wattsteer_ml.publication.ForecastPublication` values, one per held-out
civil day, in exactly the shape the serving path emits.

## Why it composes through `build_publication` and holds no arithmetic

A replayed band has to be the band the product *would have shown*. If this
module composed a band of its own, "the replay shows what we would have said"
would be a claim about two code paths agreeing rather than a property. So there
is no mixture composition here, no day-grain draw, no gate arithmetic and no
sum over anything: :func:`~wattsteer_ml.publication.build_publication` does all
of it, and the only thing this module adds is *which* days, *which* artifact and
*which* ``origin_kind``. Grep it for a quantile — there is none.

## The counterfactual instant, and the discriminator that makes it safe

``published_at`` on these rows is ``gate_at(target_date, gate_profile)`` — the
instant the gate *would* have been for a day nothing was ever published for. It
is not computed here either: it is read off the feature rows, where the database
resolved it inside ``feature_rows(...)``, by the same
:func:`~wattsteer_ml.publication.publication_instant` the served path goes through. So a
held-out row's publication instant is the served row's function of the same
date, to the second, rather than a second implementation that agrees today.

A counterfactual instant stored without a discriminator would make a
reconstruction indistinguishable from a record. So every publication this module
mints carries :data:`~wattsteer_ml.publication.BACKFILLED_HOLDOUT_ORIGIN_KIND`,
and there is **no parameter that can change it** — the constant is written into
the one call below. The gateway's other half is
`apps/api/src/forecast/reads.ts`, which filters ``origin_kind = 'served'`` in
the query rather than in a branch, so no query shape reaches
``/v1/forecast/day-ahead`` that could return one of these rows.

## Held out, asserted against the card and not against the caller

The days come from :func:`~wattsteer_ml.training.hurdle.partition_rows` over the
run's blocks, and each one is then re-checked against **the blocks the
artifact's own card records**. Two different sources on purpose: the run's
blocks say which rows were held out, the card says which days the artifact was
actually fitted on, and a `TrainedFold` whose two disagree is exactly how a day
the model saw would acquire a held-out forecast of itself. That is also the
check `docs/specs/replay.md` performs again at read time, where a violation is
"a `500`, not a badge".

Both windows are checked — the base fit *and* the calibration window — since
isotonic and the two conformal scalars were fitted on the second, and a day
inside it has shaped the very interval a replay promises a floor from.

## `ingested_at` is not here, and that is the point

Nothing in this module stamps an ingestion instant. The rows are written by the
gateway — the modelling service is read-only against Postgres — and
``ingested_at`` is the real instant that write happened. That is what makes
supersession free: a second backtest run appends a newer vintage, and a replay
pinned to the older ``AsOf`` still reconstructs the older numbers.

## The regime travels, exactly as it does on a served row

:data:`~wattsteer_ml.training.conformal.CORRECTION_REGIME` is stamped by
:meth:`~wattsteer_ml.publication.HourRow.as_row` and
:meth:`~wattsteer_ml.publication.DayRow.as_row`, which is the same method the
served path calls. Forecaster ticket 21 changed how ``δ_hi`` reaches the
composed P90 and bumped the regime with it; rows written under the old rule are
one ``group by`` away from rows written under the new one — and a holdout row
records its regime by the same mechanism a served one does rather than by a
second one that could forget.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from wattsteer_ml.evaluation.folds import FoldBlocks
from wattsteer_ml.lanes import Lane
from wattsteer_ml.publication import (
    BACKFILLED_HOLDOUT_ORIGIN_KIND,
    ForecastPublication,
    PublicationError,
    build_publication,
)
from wattsteer_ml.training import (
    CORRECTION_REGIME,
    LoadedArtifact,
    TrainedFold,
    partition_rows,
)


class HoldoutLeakError(ValueError):
    """A day this artifact was fitted on cannot be minted as a holdout forecast.

    Raised rather than skipped. A leaked day is not a day with a missing figure
    — it is a day whose forecast would be *better than the product's*, and the
    replay built on it would overstate what WattSteer can do. That is the one
    failure this whole ticket exists to make unrepresentable, so it is loud.
    """


@dataclass(frozen=True)
class HoldoutBacktest:
    """One fold's held-out days, as publications that were never published.

    A value rather than a write. The modelling service is read-only against
    Postgres, so this crosses the private network as :meth:`as_payload` and the
    gateway appends it — the same direction, and the same parser, the served
    publication already goes through.
    """

    fold_id: str
    #: The fold artifact's ``artifact_id``, which becomes every row's
    #: ``ForecastOrigin.run_label``. The artifact that did **not** see these
    #: days is the artifact a replay of them must name.
    artifact_id: str
    lane: Lane
    publications: tuple[ForecastPublication, ...]
    #: Days of the test block that produced no complete publication, named
    #: rather than silently absent. A ``(day, subsystem)`` short of twenty-four
    #: composed hours is dropped by
    #: :func:`~wattsteer_ml.training.hurdle.day_grain_rows` — a day total over
    #: twenty-three hours is a different quantity wearing the same name — and a
    #: day on which *every* subsystem is short yields no publication at all.
    incomplete_days: tuple[date, ...]

    @property
    def target_dates(self) -> tuple[date, ...]:
        """The held-out days this run actually reconstructed, in order."""
        return tuple(one.target_date for one in self.publications)

    @property
    def hours(self) -> int:
        """How many hour rows this run would write. The spec's ~52,000 per run."""
        return sum(len(one.hours) for one in self.publications)

    def as_payload(self) -> dict[str, Any]:
        """What crosses the private network to the worker that writes it.

        ``origin_kind`` is on the envelope *and* on every publication's
        ``forecast_origin``. Not redundancy for its own sake: the envelope is
        what the gateway's backfill writer refuses on, and the per-publication
        field is what reaches the row. A payload in which they disagreed is
        refused on the other side rather than half-written.
        """
        return {
            "origin_kind": BACKFILLED_HOLDOUT_ORIGIN_KIND,
            "fold_id": self.fold_id,
            "artifact_id": self.artifact_id,
            "lane": self.lane.directory_name,
            "correction_regime": CORRECTION_REGIME,
            "incomplete_days": [day.isoformat() for day in self.incomplete_days],
            "publications": [one.as_payload() for one in self.publications],
        }


def fold_holdout_publications(
    rows: Sequence[Mapping[str, Any]], *, trained: TrainedFold
) -> HoldoutBacktest:
    """Every out-of-fold day of one fold, as forecasts that cannot be served.

    Args:
        rows: every row of this fold — base fit, calibration and test together,
            exactly as :func:`~wattsteer_ml.training.hurdle.train_fold` took
            them. They are partitioned by
            :func:`~wattsteer_ml.training.hurdle.partition_rows`, the *same*
            function the fit used, so the days reconstructed here are the days
            the artifact was scored on and not a second reading of the calendar.
        trained: the fitted fold. Its card names the artifact and the blocks,
            and its bundle composes the band.

    Returns:
        The publications, one per held-out civil day that produced a whole one.

    Raises:
        HoldoutLeakError: a day of the test block is inside the base-fit or
            calibration window the artifact's **card** records.
        PublicationError: the rows of a day carry no gate, carry more than one,
            or carry a gate that does not precede the hours it forecasts.
    """
    blocks = trained.blocks
    _, _, test_rows = partition_rows(rows, blocks)
    if not test_rows:
        raise HoldoutLeakError(
            f"{trained.card.fold.id}: the test block "
            f"{blocks.test_start.isoformat()}–{blocks.test_end.isoformat()} "
            "carries no row, so this fold held nothing out and there is no "
            "out-of-fold forecast to keep"
        )

    # The artifact as the serving path would have handed it over. The same
    # value, so `build_publication` reads the training window off a card rather
    # than off a second shape that exists only for the backtest.
    loaded = LoadedArtifact(
        artifact_id=trained.card.artifact_id,
        bundle=trained.bundle,
        card=trained.card.to_dict(),
    )
    lane = trained.card.lane

    by_day: dict[date, list[Mapping[str, Any]]] = {}
    for row in test_rows:
        by_day.setdefault(row["target_date"], []).append(row)

    publications: list[ForecastPublication] = []
    incomplete: list[date] = []
    for target_date in sorted(by_day):
        # Against the card's windows, not the run's: see the module docstring.
        _assert_held_out(
            target_date, blocks=trained.card.blocks, fold_id=trained.card.fold.id
        )
        publication = build_publication(
            by_day[target_date],
            lane=lane,
            loaded=loaded,
            target_date=target_date,
            # A constant, not a parameter. There is no argument to this function
            # that can make it mint a `served` row, which is the difference
            # between unservable and merely intended to be unserved.
            origin_kind=BACKFILLED_HOLDOUT_ORIGIN_KIND,
        )
        if not publication.days or not publication.hours:
            # No whole subsystem-day survived the twenty-four-hour rule. Named
            # on the result rather than written as an empty band.
            incomplete.append(target_date)
            continue
        publications.append(publication)

    if not publications:
        raise PublicationError(
            f"{trained.card.fold.id}: none of the "
            f"{len(by_day)} held-out day(s) composed a whole subsystem-day, so "
            "this backtest run has nothing to persist. An absent reconstruction "
            "is reported as absent and never written as a zero-filled day"
        )

    return HoldoutBacktest(
        fold_id=trained.card.fold.id,
        artifact_id=trained.card.artifact_id,
        lane=lane,
        publications=tuple(publications),
        incomplete_days=tuple(incomplete),
    )


def _assert_held_out(target_date: date, *, blocks: FoldBlocks, fold_id: str) -> None:
    """The held-out property, checked against the artifact card's own windows.

    `docs/specs/replay.md` performs this assertion again at read time and calls
    a violation "a `500`, not a badge". It is performed here too, because the
    read-time check can only refuse a row that already exists and this one stops
    it being minted. Both windows, and the calibration one is the subtler leak:
    isotonic and the two conformal scalars were fitted on it, so a day inside it
    has shaped the very interval a replay would promise a floor from.
    """
    if blocks.base_fit_start <= target_date <= blocks.base_fit_end:
        raise HoldoutLeakError(
            f"{fold_id}: {target_date.isoformat()} is inside the base-fit block "
            f"{blocks.base_fit_start.isoformat()}–{blocks.base_fit_end.isoformat()}; "
            "an artifact that was fitted on a day cannot produce a held-out "
            "forecast of it"
        )
    if blocks.calibration_start <= target_date <= blocks.calibration_end:
        raise HoldoutLeakError(
            f"{fold_id}: {target_date.isoformat()} is inside the calibration "
            f"window {blocks.calibration_start.isoformat()}–"
            f"{blocks.calibration_end.isoformat()}; the isotonic map and both "
            "conformal scalars were fitted there, so the band this day would "
            "get has already seen it"
        )
