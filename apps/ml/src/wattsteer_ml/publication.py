"""What a publication is: the rows the worker writes, and the refusal it gets instead.

`docs/specs/api-surface.md`, "The boundary — precompute the model, call the
solver", fixes both the direction and the ownership of this module:

    The worker calls the ML service over the private network at
    ``POST /internal/publish/forecast`` — **worker → ml, never gateway → ml**.
    The ML service is read-only against Postgres, so it returns the computed
    rows and the **worker** writes them.

So this module **computes and returns; it never writes**. The pool is opened
with ``default_transaction_read_only = on`` and ``/ready`` asserts it, so a
write from here would fail loudly rather than quietly — but the reason it is not
attempted is the ownership rule, not the guard: every write in this product goes
through the service that owns the Drizzle schema.

## Refuse rather than invent

:func:`build_publication` resolves the artifact through
:func:`wattsteer_ml.artifacts.current`, which reads the append-only promotion
log. There are exactly four answers and three of them are refusals:

- ``promoted`` — an artifact is named by a ``promote`` line and is on the
  volume. The only state in which anything is computed.
- ``no_artifact`` — nothing was ever trained in this lane.
- ``present_unpromoted`` — bundles are on the volume and the gate refused all of
  them. Serving the newest file is precisely what the promotion log exists to
  prevent.
- ``unresolvable`` — the log is damaged, or it promotes an artifact that is not
  on the volume. The lane cannot say what it may serve, so this module says so
  rather than guessing between the other three.

Three and not four: ``promoted`` is a condition `/v1/meta` reports and never a
refusal, so it is absent from the vocabulary these carry
(:data:`~wattsteer_ml.artifacts.EnvelopeLaneState`, mirroring `packages/core`'s
`LANE_STATES`) rather than merely unreachable within it.

Each arrives as a :class:`PublicationRefusedError` carrying the ``lane_state`` the
gateway puts in ``details.lane_state`` on its ``MODEL_UNAVAILABLE``. None of
them is an empty band: `docs/specs/forecaster.md`'s standing rule is that the
service "keeps the stub's stated rule that it will never return invented
numbers", and a zero-filled hour is an invented number wearing an absence's
clothes.

## What a published row carries, and why each field is on it

**The publication instant is not the request time.** ``published_at`` is
``gate_at(target_date, gate_profile)`` — D−1 09:00 or D−1 19:00 Brasília — and
it is read off the feature rows themselves, where the *database* resolved it
inside ``feature_rows(...)``. Nothing here computes a gate. That is what keeps
the origin from being a lie: a row's publication instant is a property of its
target date, and the one authority for it is the SQL function the features were
cut against. Every row of one publication shares one gate, and a set that does
not is refused rather than averaged.

**The day-grain figures are on the payload, not derived from the hours.**
`docs/specs/replay.md` requires ``forecast.day_total`` to come from the path
ensemble and forbids reconstructing it by summing the hourly band.
:func:`~wattsteer_ml.training.hurdle.day_grain_rows` produces them and, until
this module, nothing carried them out of the process. There is no arithmetic in
this file that turns twenty-four hour bands into a day figure — grep it for a
sum over quantiles; the only sums are over **expectations**, which add exactly,
and they are what :func:`~wattsteer_ml.training.national.\
subsystem_day_expectations` already owns.

**The technology split is two scalars at both grains.** The share model is
applied to the P50 and to the expectation by
:func:`wattsteer_ml.mixture.compose`, and both splits travel: the served
contract splits the *expectation* (``wind_mwh + solar_mwh == expected_mwh``),
and the P50 split is carried beside it because it is already computed and a
stored figure nobody can reconstruct later is a figure that has to be re-run for.
There is no ``p10`` under a split and there is nowhere for one to go.

**Every row says whether it is a record or a reconstruction.**
``origin_kind`` is on the publication itself and therefore on every row it
produces. `docs/specs/replay.md` makes it load-bearing: a ``served`` row is a
record of a publication that happened, while a ``backfilled_holdout`` row —
minted by :mod:`wattsteer_ml.evaluation.holdout` from a fold's held-out days —
carries a *counterfactual* ``published_at``, the instant the gate would have
been for a day nothing was ever published for. The two share this module's
composition on purpose, so a replayed band is the band the product would have
shown; they are kept apart by the discriminator, and the gateway's
``/v1/forecast/day-ahead`` filters ``origin_kind = 'served'`` in the query
rather than in a branch. :func:`build_publication` has **no default** for it.

**Every row is stamped with its correction regime.**
:data:`~wattsteer_ml.training.conformal.CORRECTION_REGIME` names the rule that
produced the band, not the release that shipped it. Forecaster ticket 21 moved
the correction from the knots of ``Q_pos`` onto the composed quantile and bumped
the regime to ``conformal_v2_full_upper``; the rows written before it are **not**
re-stamped and still carry the narrower band ``conformal_v1_partial_upper``
produced, whose composed P90 received only part of ``δ_hi`` and whose shortfall
compounded at day grain and again nationally. A stored regime is the difference
between a row that can be re-served at its own origin and one that quietly means
something else than a row written next to it.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal

from wattsteer_ml import artifacts
from wattsteer_ml.artifacts import EnvelopeLaneState
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.lanes import Lane
from wattsteer_ml.mixture import TechnologySplit
from wattsteer_ml.promotions import PromotionLogError
from wattsteer_ml.training import (
    CORRECTION_REGIME,
    BundleError,
    DayGrainForecast,
    ForecastOrigin,
    HourForecast,
    LoadedArtifact,
    NationalDayGrain,
    day_grain_rows,
    forecast_rows,
    load_artifact,
    national_day_grain,
    subsystem_day_expectations,
)

#: What an hour row's band was composed by. A stored string for the reason
#: ``derivation`` is one on the day row: a reader of the database must be able to
#: tell a band that came out of the one composition from one some other code
#: path assembled.
HOUR_DERIVATION = "hurdle_mixture"

#: The two things a `Forecast` row can be. `docs/specs/replay.md`: ``served`` is
#: a **record** of a publication that happened; ``backfilled_holdout`` is a
#: **reconstruction** whose ``published_at`` is the instant the gate *would* have
#: been. Storing the second without a discriminator would make it
#: indistinguishable from the first, and the discriminator is the whole reason
#: the two may share a table.
OriginKind = Literal["served", "backfilled_holdout"]

#: ``origin_kind`` on a publication the serving path produces. The field is
#: written rather than defaulted so the discriminator is on the row from the
#: moment it is minted: :func:`build_publication` has no default for it and
#: every caller says which of the two it is producing.
SERVED_ORIGIN_KIND: OriginKind = "served"

#: ``origin_kind`` on a publication reconstructed from a fold's held-out days.
#: Minted only by :mod:`wattsteer_ml.evaluation.holdout`, and never returned by
#: ``/v1/forecast/day-ahead`` — the gateway filters ``served`` in the query.
BACKFILLED_HOLDOUT_ORIGIN_KIND: OriginKind = "backfilled_holdout"

#: ``ForecastOrigin.producer`` for a WattSteer curtailment forecast.
PRODUCER: Literal["wattsteer"] = "wattsteer"


class PublicationError(ValueError):
    """These rows cannot produce a publication."""


@dataclass(frozen=True)
class PublicationRefusedError(Exception):
    """No forecast, and which of the artifact states says so.

    An exception rather than a returned union because there is nothing partial
    to hand back: a refusal is not a publication with empty fields, and a caller
    that could accidentally treat one as the other is the failure the four "no
    forecast" states exist to prevent.
    """

    lane: Lane
    #: The **error-envelope** word, three members, mirroring
    #: `packages/core`'s `LANE_STATES` — never the four-member
    #: :data:`~wattsteer_ml.artifacts.LaneCondition` `/v1/meta` reports.
    #: `promoted` is not among them and cannot be: a lane with something to
    #: serve does not produce a refusal, and the type is what says so.
    #: :attr:`~wattsteer_ml.artifacts.LaneView.absence_state` is the one
    #: crossing from a condition to this, and it raises on `promoted`.
    lane_state: EnvelopeLaneState
    reason: str
    #: Whether the artifact directory is a directory at all.
    #:
    #: Reported *beside* the lane state and never folded into it, for the reason
    #: `/v1/meta` reports the mount separately: an unmounted volume is a fact
    #: about the deployment and a lane with nothing in it is a fact about
    #: training, and the two have completely different repairs. Without this
    #: field the two produce the same refusal — ``no_artifact``, because a lane
    #: on a volume that is not there has, truthfully, no artifact — and "the
    #: volume did not mount" and "nobody has trained this lane" would look
    #: alike, which is exactly what story 33 forbids.
    volume_mounted: bool = True

    def __str__(self) -> str:  # pragma: no cover — prose, exercised via `reason`
        return f"{self.lane.directory_name}: {self.reason}"

    def as_payload(self) -> dict[str, Any]:
        """The typed body. The gateway maps it onto ``MODEL_UNAVAILABLE``."""
        return {
            "code": "MODEL_UNAVAILABLE",
            "lane": self.lane.directory_name,
            "lane_state": self.lane_state,
            "volume_mounted": self.volume_mounted,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class HourRow:
    """One ``(subsystem, valid_time)`` forecast row, as it is persisted."""

    subsystem: Subsystem
    valid_time: datetime
    target_date: date
    local_hour: int
    threshold_mw: float
    occurrence_probability: float
    p10_mwh: float
    p50_mwh: float
    p90_mwh: float
    expected_mwh: float
    p50_wind_mwh: float
    p50_solar_mwh: float
    expected_wind_mwh: float
    expected_solar_mwh: float
    #: Whether the three composed quantiles arrived out of order and were
    #: sorted. Stored, because the band is monotone either way and this is the
    #: only place a reader learns the boosters disagreed about this hour.
    crossed: bool

    def as_row(self) -> dict[str, Any]:
        return {
            "subsystem": self.subsystem,
            "valid_time": self.valid_time.isoformat(),
            "target_date": self.target_date.isoformat(),
            "local_hour": self.local_hour,
            "threshold_mw": self.threshold_mw,
            "occurrence_probability": self.occurrence_probability,
            "p10_mwh": self.p10_mwh,
            "p50_mwh": self.p50_mwh,
            "p90_mwh": self.p90_mwh,
            "expected_mwh": self.expected_mwh,
            "p50_wind_mwh": self.p50_wind_mwh,
            "p50_solar_mwh": self.p50_solar_mwh,
            "expected_wind_mwh": self.expected_wind_mwh,
            "expected_solar_mwh": self.expected_solar_mwh,
            "crossed": self.crossed,
            "derivation": HOUR_DERIVATION,
            "correction_regime": CORRECTION_REGIME,
        }


@dataclass(frozen=True)
class DayRow:
    """One ``(subsystem, target_date)`` companion row — the day-grain figures.

    The row `docs/specs/replay.md` calls "a few columns on a **companion row**,
    not a contract change", and the one forecaster ticket 14 exists to stop
    being computed twice: without it a replay can only re-run the ensemble or
    sum the hourly quantiles, and the spec forbids the second.
    """

    #: The day-grain forecast exactly as ticket 07 produced it. Its
    #: :meth:`~wattsteer_ml.training.ensemble.DayGrainForecast.as_row` is
    #: already the persistence shape, including its ``path_ensemble``
    #: derivation, so this row **decorates** it rather than restating it.
    forecast: DayGrainForecast
    #: ``Σ_t E[Y_t]`` over the day's twenty-four composed hours. Expectations
    #: add exactly; quantiles do not, and nothing else here is summed.
    expected_mwh: float
    expected_wind_mwh: float
    expected_solar_mwh: float
    #: How many of the day's hours have a non-zero P50 — a **count** of hours,
    #: not an arithmetic on their bands, and the field the day-ahead response
    #: publishes as ``hours_p50_nonzero``.
    hours_p50_nonzero: int

    @property
    def subsystem(self) -> Subsystem:
        return self.forecast.subsystem

    @property
    def target_date(self) -> date:
        return self.forecast.target_date

    def as_row(self) -> dict[str, Any]:
        return {
            **self.forecast.as_row(),
            "expected_mwh": self.expected_mwh,
            "expected_wind_mwh": self.expected_wind_mwh,
            "expected_solar_mwh": self.expected_solar_mwh,
            "hours_p50_nonzero": self.hours_p50_nonzero,
            "correction_regime": CORRECTION_REGIME,
        }


@dataclass(frozen=True)
class NationalRow:
    """The one national row of a publication — forecaster ticket 22.

    The counterpart of :class:`DayRow` at the grain above it, and a distinct
    type rather than a fifth :class:`DayRow` because ``SIN`` is not a
    ``Subsystem`` (`docs/domain-model.md`, vocabulary rule 6). It travels under
    its own ``national`` key beside ``days`` and ``hours`` for the same reason
    the wire puts the national figure under a key rather than in the subsystem
    array: a fifth member of a four-member enum is the double count the rule
    makes unrepresentable.

    It **decorates** :class:`~wattsteer_ml.training.national.NationalDayGrain`
    exactly as :class:`DayRow` decorates
    :class:`~wattsteer_ml.training.ensemble.DayGrainForecast` — the grain's own
    :meth:`~wattsteer_ml.training.national.NationalDayGrain.as_row` is already
    the persistence shape, ``joint_path_ensemble`` derivation and all — and adds
    only the correction regime, which is a property of the publication rather
    than of the draw.
    """

    #: The joint figure exactly as ticket 08 computed it: four day totals added
    #: draw by draw under one shared plan, peak-of-sum, occurrence over draws.
    figure: NationalDayGrain

    @property
    def target_date(self) -> date:
        return self.figure.target_date

    def as_row(self) -> dict[str, Any]:
        return {**self.figure.as_row(), "correction_regime": CORRECTION_REGIME}


@dataclass(frozen=True)
class ForecastPublication:
    """One lane, one target date: the rows, and everything that identifies them.

    A publication is per (lane, target date) and covers every subsystem the
    feature rows carried a complete day for. A subsystem short of twenty-four
    composed hours is **absent** from both row sets — never a partial day — for
    the reason :func:`~wattsteer_ml.training.hurdle.day_grain_rows` drops one: a
    day total over twenty-three hours is a different quantity wearing the same
    name, and half a day on the wire is how it would acquire the name.
    """

    lane: Lane
    artifact_id: str
    target_date: date
    #: Record or reconstruction. Required, and required *here* rather than at
    #: the point the payload is built, so there is no moment at which a
    #: publication exists without knowing which of the two it is.
    origin_kind: OriginKind
    #: ``gate_at(target_date, gate_profile)``, read off the feature rows. On a
    #: ``backfilled_holdout`` publication this is the counterfactual instant —
    #: the same gate, resolved by the same database function, for a day that was
    #: never actually published.
    published_at: datetime
    threshold_mw: float
    feature_set: str
    #: The last target date the artifact's training window reached, from the
    #: card. The gateway publishes it as ``artifact.trained_through``.
    trained_through: str
    #: The published class edges, so the gateway can name a risk class from a
    #: probability without holding a styling constant or reading the volume.
    risk_bins: dict[str, tuple[float, float]]
    hours: tuple[HourRow, ...]
    days: tuple[DayRow, ...]
    #: The national day, when this publication covers all four subsystems.
    #:
    #: ``None`` and not a zero when it does not: a national total over three
    #: subsystems is a different quantity wearing the same name, and the
    #: gateway's ``band_unavailable_reason`` branch is what renders the absence.
    #: An artifact trained before the shared draw index landed produces one too.
    national: NationalRow | None = None

    @property
    def subsystems(self) -> tuple[Subsystem, ...]:
        """The subsystems this publication actually covers, in canonical order."""
        covered = {day.subsystem for day in self.days}
        return tuple(code for code in SUBSYSTEM_CODES if code in covered)

    def as_payload(self) -> dict[str, Any]:
        """What crosses the private network to the worker that writes it."""
        return {
            "lane": self.lane.directory_name,
            "feature_set": self.feature_set,
            "gate_profile": self.lane.gate_profile,
            "threshold_mw": self.threshold_mw,
            "target_date": self.target_date.isoformat(),
            "forecast_origin": {
                "producer": PRODUCER,
                "run_label": self.artifact_id,
                "published_at": self.published_at.isoformat(),
                "origin_kind": self.origin_kind,
                "gate_profile": self.lane.gate_profile,
            },
            "artifact": {
                "artifact_id": self.artifact_id,
                "feature_set": self.feature_set,
                "trained_through": self.trained_through,
            },
            "risk_bins": {name: list(edges) for name, edges in self.risk_bins.items()},
            "correction_regime": CORRECTION_REGIME,
            "subsystems": list(self.subsystems),
            "hours": [hour.as_row() for hour in self.hours],
            "days": [day.as_row() for day in self.days],
            # Beside `days`, never inside it. `null` is an absence the gateway
            # publishes with a stated reason, and never a zero.
            "national": None if self.national is None else self.national.as_row(),
        }


def build_publication(
    rows: Sequence[Mapping[str, Any]],
    *,
    lane: Lane,
    loaded: LoadedArtifact,
    target_date: date,
    origin_kind: OriginKind,
) -> ForecastPublication:
    """Compose one lane's day into the rows that will be persisted.

    Args:
        rows: ``feature_rows(target_date, target_date, …)`` for this lane,
            exactly as :func:`wattsteer_ml.features.read_serving_rows` returned
            them. Nothing is re-queried and no window is derived here.
        lane: the lane being published, which the bundle is checked against.
        loaded: the bundle and its card, from
            :func:`~wattsteer_ml.training.bundle.load_artifact`.
        target_date: the civil day being forecast, checked against the rows.
        origin_kind: :data:`SERVED_ORIGIN_KIND` for the serving path,
            :data:`BACKFILLED_HOLDOUT_ORIGIN_KIND` for a fold's held-out day.
            There is no default: a publication that could not say which of the
            two it is would be exactly the row `docs/specs/replay.md` refuses to
            let exist.

    Raises:
        PublicationError: the rows are not one target date's, carry no gate, or
            carry more than one.
    """
    bundle = loaded.bundle
    if bundle.lane != lane:
        raise PublicationError(
            f"the bundle is bound to {bundle.lane.directory_name} and this "
            f"publication is for {lane.directory_name}"
        )
    if not rows:
        raise PublicationError(
            f"{lane.directory_name}: the feature function returned no row for "
            f"{target_date.isoformat()}; there is nothing to forecast and a "
            "publication of zero hours is not one"
        )

    published_at = _one_gate(rows, target_date=target_date)
    valid_times = _valid_times(rows, target_date=target_date)

    hours = forecast_rows(bundle, rows)
    hour_rows = tuple(_hour_row(hour, valid_time=valid_times[hour.key]) for hour in hours)
    expectations = subsystem_day_expectations(hours)
    splits = _day_expectation_splits(hours)
    non_zero = _hours_p50_nonzero(hours)
    # One call, and the national figure is built from *these* objects rather
    # than from a second one. `day_grain_rows` mints one `DrawPlan` per call and
    # hands it to every subsystem, and draw `k` is one calendar day nationally
    # only if the four share that plan — so a second call would produce a
    # national band over four different days that no persisted subsystem row
    # was drawn from.
    ensemble_days = tuple(day_grain_rows(bundle, rows))
    day_rows = tuple(
        DayRow(
            forecast=day,
            expected_mwh=expectations[(day.target_date, day.subsystem)],
            expected_wind_mwh=splits[(day.target_date, day.subsystem)].wind_mwh,
            expected_solar_mwh=splits[(day.target_date, day.subsystem)].solar_mwh,
            hours_p50_nonzero=non_zero[(day.target_date, day.subsystem)],
        )
        for day in ensemble_days
        # A day the ensemble kept but the expectations did not is not
        # representable — both drop a short day — and this states the rule
        # rather than trusting it.
        if (day.target_date, day.subsystem) in expectations
    )
    national = _national_row(
        ensemble_days,
        expectations=expectations,
        artifact_id=loaded.artifact_id,
        target_date=target_date,
    )

    return ForecastPublication(
        lane=lane,
        artifact_id=loaded.artifact_id,
        target_date=target_date,
        origin_kind=origin_kind,
        published_at=published_at,
        threshold_mw=bundle.threshold_mw,
        feature_set=lane.feature_set,
        trained_through=_trained_through(loaded),
        risk_bins=_risk_bins(bundle),
        hours=hour_rows,
        days=day_rows,
        national=national,
    )


def resolve_artifact(lane: Lane, *, store: artifacts.ArtifactStore | None = None) -> str:
    """The artifact ``lane`` may serve, or a refusal naming its state.

    The one route from a lane to a served artifact, and it goes through the
    promotion log. It never falls back to the newest file: that file is exactly
    the candidate the gate refused, which is why the log exists.
    """
    inspected = store if store is not None else artifacts.inspect()
    view = inspected.view(lane)
    if not inspected.mounted:
        # The first of the three distinguishable refusals. `artifacts.inspect()`
        # reports an unmounted directory as a store with no lanes, and a lane
        # read out of it is truthfully `no_artifact` — so the *state* is right
        # and is not enough on its own. The mount is reported beside it.
        raise PublicationRefusedError(
            lane=lane,
            lane_state=view.absence_state,
            volume_mounted=False,
            reason=(
                f"the artifact directory {inspected.path} is not mounted, so no "
                "lane on it can say what it is allowed to serve. This is a "
                "deployment fault and not an untrained lane"
            ),
        )
    try:
        promoted = inspected.current(lane)
    except PromotionLogError as error:
        raise PublicationRefusedError(
            lane=lane,
            lane_state="unresolvable",
            reason=(
                f"{error}. The volume cannot say what this lane is allowed to "
                "serve, and the one thing it must not do when it cannot tell is "
                "fall back to the newest file"
            ),
        ) from error
    if promoted is None:
        raise PublicationRefusedError(
            lane=lane,
            lane_state=view.absence_state,
            volume_mounted=True,
            reason=(
                "no artifact has been promoted in this lane"
                if view.state == "no_artifact"
                else (
                    f"{len(view.artifacts)} artifact(s) are on the volume and the "
                    "gate promoted none of them; the newest file is the candidate "
                    "that was refused"
                )
            ),
        )
    return promoted


def load_promoted(
    lane: Lane, *, root: Any, store: artifacts.ArtifactStore | None = None
) -> LoadedArtifact:
    """Resolve and load, turning a damaged bundle into a refusal too.

    A promotion log naming an artifact whose bundle will not load is the same
    class of fact as one naming an artifact that is not there: the lane cannot
    serve, and it cannot say which of the other states it is in either.
    """
    artifact_id = resolve_artifact(lane, store=store)
    try:
        return load_artifact(root=root, lane=lane, artifact_id=artifact_id)
    except BundleError as error:
        raise PublicationRefusedError(
            lane=lane,
            lane_state="unresolvable",
            reason=(f"the promoted artifact {artifact_id} could not be loaded: {error}"),
        ) from error


def _national_row(
    days: Sequence[DayGrainForecast],
    *,
    expectations: Mapping[tuple[date, Subsystem], float],
    artifact_id: str,
    target_date: date,
) -> NationalRow | None:
    """The publication's national row, or ``None`` when there is not one.

    :func:`~wattsteer_ml.training.national.national_day_grain` already drops a
    day that does not carry all four subsystems, so ``None`` here is exactly
    "this publication is short of a subsystem" — and it is returned rather than
    raised because a three-subsystem publication is a real, persistable state:
    the subsystem rows it does have are still records of what was served. The
    national band is the thing that does not exist, and the gateway renders that
    absence with its reason instead of a number.

    A second national figure for a *different* day is a bug and not a state:
    ``build_publication`` is one lane-day and the rows were checked against
    ``target_date`` before this is reached.
    """
    figures = national_day_grain(
        days,
        expectations=expectations,
        origin=ForecastOrigin.of_artifact(artifact_id),
    )
    for figure in figures:
        if figure.target_date == target_date:
            return NationalRow(figure=figure)
    return None


def _hour_row(hour: HourForecast, *, valid_time: datetime) -> HourRow:
    """One composed hour, as a row. No arithmetic — the composition is upstream."""
    forecast = hour.forecast
    p50_split = forecast.p50_split
    expected_split = forecast.expected_split
    if p50_split is None or expected_split is None:
        raise PublicationError(
            f"{hour.key.line}: the composition produced no technology split, so "
            "the share model was not applied; a published row splits the P50 and "
            "the expectation or it does not claim a split at all"
        )
    return HourRow(
        subsystem=hour.key.subsystem,
        valid_time=valid_time,
        target_date=hour.key.target_date,
        local_hour=hour.key.local_hour,
        threshold_mw=forecast.threshold_mw,
        occurrence_probability=forecast.occurrence_probability,
        p10_mwh=forecast.band.p10,
        p50_mwh=forecast.band.p50,
        p90_mwh=forecast.band.p90,
        expected_mwh=forecast.expected_mwh,
        p50_wind_mwh=p50_split.wind_mwh,
        p50_solar_mwh=p50_split.solar_mwh,
        expected_wind_mwh=expected_split.wind_mwh,
        expected_solar_mwh=expected_split.solar_mwh,
        crossed=forecast.crossed,
    )


def _day_expectation_splits(
    hours: Sequence[HourForecast],
) -> dict[tuple[date, Subsystem], TechnologySplit]:
    """The day's expected split, added hour by hour.

    Legitimate for the same reason
    :func:`~wattsteer_ml.training.national.subsystem_day_expectations` is:
    these are **expectations**, which add exactly and with no assumption about
    dependence whatever. A day short of twenty-four composed hours is absent
    rather than partial, matching the day-grain rule on both sides.
    """
    wind: dict[tuple[date, Subsystem], list[float]] = {}
    solar: dict[tuple[date, Subsystem], list[float]] = {}
    for hour in hours:
        split = hour.forecast.expected_split
        if split is None:
            continue
        key = (hour.key.target_date, hour.key.subsystem)
        wind.setdefault(key, []).append(split.wind_mwh)
        solar.setdefault(key, []).append(split.solar_mwh)
    return {
        key: TechnologySplit(wind_mwh=math.fsum(values), solar_mwh=math.fsum(solar[key]))
        for key, values in wind.items()
        if len(values) == HOURS_PER_DAY
    }


def _hours_p50_nonzero(
    hours: Sequence[HourForecast],
) -> dict[tuple[date, Subsystem], int]:
    """How many hours of each day have a non-zero P50 — a count, never a sum."""
    counted: dict[tuple[date, Subsystem], int] = {}
    for hour in hours:
        key = (hour.key.target_date, hour.key.subsystem)
        counted[key] = counted.get(key, 0) + (1 if hour.forecast.band.p50 > 0.0 else 0)
    return counted


def _one_gate(rows: Sequence[Mapping[str, Any]], *, target_date: date) -> datetime:
    """The one publication instant these rows were cut against.

    Read off ``feature_rows``' own ``gate_at`` column and never computed here.
    Two distinct gates in one publication would mean two different beliefs about
    what was knowable, and averaging them would produce a `published_at` no
    forecast was ever made at.
    """
    gates: set[datetime] = set()
    for row in rows:
        if row.get("target_date") != target_date:
            raise PublicationError(
                f"a publication of {target_date.isoformat()} was handed a row "
                f"for {row.get('target_date')!r}"
            )
        gate = row.get("gate_at")
        if not isinstance(gate, datetime) or gate.tzinfo is None:
            raise PublicationError(
                "every feature row carries the gate the database resolved for "
                f"it; this one carries {gate!r}, so there is no publication "
                "instant to stamp and this module will not invent one"
            )
        gates.add(gate)
    if len(gates) != 1:
        raise PublicationError(
            f"{target_date.isoformat()} was cut against {len(gates)} distinct "
            "gate instants; one publication has one publication instant"
        )
    gate = gates.pop()
    if gate >= _first_instant_of(rows):
        raise PublicationError(
            f"the gate {gate.isoformat()} does not precede the first hour it "
            "forecasts; a Forecast has published_at < valid_time by definition, "
            "and a row that fails it is an observation wearing a forecast's shape"
        )
    return gate


def _first_instant_of(rows: Sequence[Mapping[str, Any]]) -> datetime:
    """The earliest ``valid_time`` in the batch, for the forecast-shape check."""
    instants = [
        instant
        for instant in (row.get("valid_time") for row in rows)
        if isinstance(instant, datetime)
    ]
    if not instants:
        raise PublicationError(
            "the feature rows carry no valid_time, so there is no hour these "
            "numbers are about"
        )
    return min(instants)


def _valid_times(
    rows: Sequence[Mapping[str, Any]], *, target_date: date
) -> dict[RowKey, datetime]:
    """``valid_time`` per row key, taken from the database rather than derived.

    The composed forecast is keyed by (target date, local hour, subsystem) and a
    persisted row is keyed by (subsystem, valid time). The map between them is
    already in the feature rows, so it is read rather than reconstructed from a
    timezone database this process would then be a second authority on.
    """
    mapped: dict[RowKey, datetime] = {}
    for row in rows:
        key = RowKey.from_feature_row(row)
        instant = row["valid_time"]
        previous = mapped.get(key)
        if previous is not None and previous != instant:
            raise PublicationError(
                f"{key.line}: two different valid_times ({previous.isoformat()} "
                f"and {instant.isoformat()}) for one row key"
            )
        mapped[key] = instant
    if not mapped:
        raise PublicationError(
            f"no identifiable feature row for {target_date.isoformat()}"
        )
    return mapped


def _trained_through(loaded: LoadedArtifact) -> str:
    """The card's ``training_window.end`` — how far the fit's window reached."""
    data = loaded.card.get("data")
    window = data.get("training_window") if isinstance(data, Mapping) else None
    end = window.get("end") if isinstance(window, Mapping) else None
    if not isinstance(end, str):
        raise PublicationError(
            f"{loaded.artifact_id}: the card carries no training window end, so "
            "the response cannot say how far the model was trained; a forecast "
            "whose artifact cannot date itself is not publishable"
        )
    return end


def _risk_bins(bundle: Any) -> dict[str, tuple[float, float]]:
    """The published class edges, from the bundle's own calibration."""
    bins = bundle.calibration.risk_bins.bins
    return {"low": bins.low, "elevated": bins.elevated, "high": bins.high}
