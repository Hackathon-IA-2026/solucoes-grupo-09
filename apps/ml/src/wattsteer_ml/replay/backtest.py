"""The Backtest: many replays, the same code, and no averaging across a caveat.

`docs/domain-model.md` is the naming authority and it gives **`Backtest` to the
aggregate of many Replays** — the one the hot-swap gate consumes. The
forecaster's harness over the fold calendar is *fold evaluation* and lives in
:mod:`wattsteer_ml.evaluation`; the two share an English word and nothing else.

`docs/specs/replay.md`, "The Backtest — the aggregate, for humans", fixes the
table and the two rules that make it honest. Both are structural here rather
than agreed:

**One replay per day, through the one replay path.** :func:`replay_window`
reads each day with :func:`~wattsteer_ml.replay.inputs.read_replay_inputs` and
scores it with :func:`~wattsteer_ml.replay.scoring.score_replay` — the two
functions ``POST /v1/replay`` calls — against the published
:data:`~wattsteer_ml.constants.REFERENCE_FLEET`. Nothing in this module reads an
hour, sums a profile or decides whether a floor was met: every figure below is
read off a :class:`~wattsteer_ml.replay.scoring.ReplayScores`, which is the
object the replay screen renders. That is what makes a Backtest number and a
replay number the same kind of number, and ``test_backtest_aggregate.py``
asserts it off the source rather than off a fixture.

**Fidelity is a group key, never a filter.** :func:`aggregate_backtest` groups
by :class:`~wattsteer_ml.evaluation.vintage.FoldSegment`, and a segment *is* a
(fold, fidelity) pair — the forecaster's own type, from the module that split a
straddling fold in the first place. So:

- there is no ``fidelity=`` parameter anywhere in this module to filter on, and
  no comparison against a ``VintageFidelity`` value in its source; the only way
  to reach a number is through the key that carries the caveat;
- a fold straddling ingestion go-live arrives as **two** segments from
  :func:`~wattsteer_ml.evaluation.vintage.stamp_calendar` and therefore leaves
  as two rows, even when one of them replayed no days — an absent half would be
  a fold that looked unsplit;
- a day whose own :attr:`~wattsteer_ml.replay.calendar.ReplayDay.vintage_fidelity`
  disagrees with the segment covering its date raises
  :class:`~wattsteer_ml.evaluation.vintage.MixedFidelityError` rather than
  landing in the row, because the two labels come from the same canonical rule
  and a disagreement means one of them was computed against a different go-live;
- the rows are handed to
  :func:`~wattsteer_ml.evaluation.vintage.assert_no_averaged_rows` before they
  are returned, which is the check forecaster 09 wrote for exactly this.

**Nothing here is annual, and nothing is cross-fidelity.** `replay.md` puts "a
single headline over mixed fidelities" out of scope in as many words, so
:class:`Backtest` holds rows and no totals: there is no field on it, and no key
in its payload, that reduces two rows to one number. `floor_coverage` stays at
its stated grain — fold, **subsystem**, fidelity — and is not pooled across
subsystems either, because a coverage figure over two subsystems is a mean over
two different fleets' worth of curtailment.

## Absence, and why it is not zero

A segment that replayed no days carries ``metrics=None``. A row of zeros would
read as "the fleet recovered nothing across this quarter", which is the opposite
of "this quarter has not been replayed" — the same distinction
:class:`~wattsteer_ml.evaluation.collapse.P50Collapse` draws, and for the same
reason. Avoidability is ``None`` on a day with nothing to avoid, and those days
are counted (:attr:`BacktestMetrics.days_with_avoidability`) rather than folded
in as zeros, which would pull the distribution towards a number no day scored.

## What it costs, and why the route serves a cache

``test_replay_cost.py`` puts one replay at **24.4 ms** and the recompute over
the 521 currently replayable days at **~13 s** single-threaded. The gateway's ML
timeout is five seconds, so ``GET /v1/backtest`` serves what a nightly job
computed — the shape :mod:`wattsteer_ml.replay.shortlist` established for the
featured days, cache and all, because it is the same cost and the same posture:
derived, evictable, and read-only against a read-only database.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import asyncpg
import numpy as np

from wattsteer_ml.canonical import VintageSource, combine_go_live
from wattsteer_ml.evaluation.folds import FoldCalendarRules, materialize_fold_calendar
from wattsteer_ml.evaluation.vintage import (
    FoldSegment,
    MixedFidelityError,
    assert_no_averaged_rows,
    stamp_calendar,
)
from wattsteer_ml.lanes import Lane
from wattsteer_ml.optimizer import OPTIMIZER_BUILD
from wattsteer_ml.replay.calendar import (
    ReplayCalendar,
    ReplayDay,
    build_calendar,
    latest_replayable_date,
)
from wattsteer_ml.replay.cards import ArtifactWindows
from wattsteer_ml.replay.inputs import ReplayInputs, read_replay_inputs
from wattsteer_ml.replay.premium import RevisionPremium, published_premium
from wattsteer_ml.replay.reads import read_calendar_evidence
from wattsteer_ml.replay.scoring import ReplayScores, score_replay
from wattsteer_ml.replay.shortlist import reference_fleet_hash, reference_fleet_scenario
from wattsteer_ml.scenario import canonical_json

#: How long a computed aggregate is served before it is called stale. The
#: featured days' constant and for the same reason: the job is nightly, and a
#: figure that expired on the stroke of twenty-four hours would spend every
#: night claiming to be out of date while the job refreshing it was still
#: running.
BACKTEST_TTL = timedelta(hours=25)

#: The state of an aggregate nobody has computed on this instance yet. A named
#: state rather than an empty table: "the aggregate has not been computed here"
#: and "these folds replayed no days" are different answers.
PENDING = "pending"
READY = "ready"
STALE = "stale"

_ONE_DAY = timedelta(days=1)


class BacktestError(ValueError):
    """A day the aggregate cannot place, or an aggregate over nothing.

    Distinct from :class:`~wattsteer_ml.evaluation.vintage.MixedFidelityError`,
    which is raised when the caveat itself was about to be lost: this one says
    the rows do not describe the calendar they claim to.
    """


@dataclass(frozen=True)
class BacktestDay:
    """One replayed day, as the aggregate consumes it — and nothing recomputed.

    Every property here reads a figure off :attr:`scores`, which is the object
    ``POST /v1/replay`` renders for the same day. There is deliberately no
    arithmetic on hours in this class: a second expression for "did the day
    clear its promised floor" is how an aggregate starts to drift from the
    replays it aggregates, and the drift would be invisible.
    """

    subsystem: str
    scores: ReplayScores

    @property
    def day(self) -> ReplayDay:
        return self.scores.day

    @property
    def target_date(self) -> date:
        return self.scores.day.target_date

    @property
    def vintage_fidelity(self) -> str:
        """The day's own caveat, from the calendar's canonical rule."""
        return self.scores.day.vintage_fidelity

    @property
    def floor_met(self) -> bool:
        """The empirical claim, not a theorem — see ``ReplayScores.floor_met``."""
        return self.scores.floor_met

    @property
    def recovered_mwh(self) -> float:
        return self.scores.observed_scoring.recovered_mwh

    @property
    def avoidability(self) -> float | None:
        """``None`` on a day with nothing to avoid, and never a zero for it."""
        return self.scores.observed_scoring.avoidability

    @property
    def forecast_value_gap_mwh(self) -> float:
        """What better forecasting was worth on this day. The fenced number's
        one honest arithmetic use, taken from where the fence put it."""
        return self.scores.upper_bound.forecast_value_gap_mwh

    @property
    def forecast_underestimated(self) -> bool:
        """``Σf50 < Σa`` — the day that came in bigger than WattSteer said.

        Both totals are day-grain figures: the forecast's is the path ensemble's
        joint day total, never a sum of hourly quantiles (`replay.md` story 25),
        and the observed one is the settled day.
        """
        return self.scores.forecast.day_total.p50 < self.scores.observed.total_mwh


@dataclass(frozen=True)
class Distribution:
    """A distribution as three numbers, because one number is not a shape.

    `replay.md` requires mean with p25 and p75 for avoidability and forbids
    collapsing it: a quarter of days at 90 % and three quarters at 10 % has the
    same mean as every day at 30 %, and only one of those quarters is a product.

    Linear-interpolated percentiles — ``numpy.percentile``'s default, stated
    rather than assumed, as :class:`~wattsteer_ml.evaluation.collapse.HoursPerDay`
    states it: nearest-rank and linear interpolation disagree materially on the
    day counts one fold holds.
    """

    mean: float
    p25: float
    p75: float

    @classmethod
    def of(cls, values: Sequence[float]) -> Distribution:
        if not values:
            raise BacktestError(
                "a distribution over no days is not zero, it is unmeasured; the "
                "row reports it absent"
            )
        array = np.asarray(values, dtype=np.float64)
        return cls(
            mean=float(array.mean()),
            p25=float(np.percentile(array, 25.0)),
            p75=float(np.percentile(array, 75.0)),
        )

    def as_payload(self) -> dict[str, float]:
        return {"mean": self.mean, "p25": self.p25, "p75": self.p75}


@dataclass(frozen=True)
class SubsystemCoverage:
    """`days_replayed` and `floor_coverage` at their stated grain.

    Fold, **subsystem**, fidelity — the fold and the fidelity being the row this
    hangs off. Not pooled up to the row: floor coverage over two subsystems
    would average two different fleets' curtailment into one share, and the gate
    that consumes it compares like with like.
    """

    subsystem: str
    days_replayed: int
    days_floor_met: int

    def __post_init__(self) -> None:
        if self.days_replayed <= 0:
            raise BacktestError(
                f"{self.subsystem} appears with {self.days_replayed} days; a "
                "subsystem that replayed nothing is absent, not a zero row"
            )
        if not 0 <= self.days_floor_met <= self.days_replayed:
            raise BacktestError(
                f"{self.subsystem} met the floor on {self.days_floor_met} of "
                f"{self.days_replayed} days, which is not a share"
            )

    @property
    def floor_coverage(self) -> float:
        """The share of days the observed recovery cleared the D−1 promise."""
        return self.days_floor_met / self.days_replayed

    def as_payload(self) -> dict[str, object]:
        return {
            "subsystem": self.subsystem,
            "days_replayed": self.days_replayed,
            "floor_coverage": self.floor_coverage,
        }


@dataclass(frozen=True)
class BacktestMetrics:
    """The fold-and-fidelity-grain figures, over at least one day.

    Constructed only by :meth:`over`, which is the one place the arithmetic
    lives, and never for an empty population: see the module docstring on why a
    row of zeros is a different claim from an absence.
    """

    days_replayed: int
    #: ``None`` when no day in the row had an hour at ``threshold_mw`` — the
    #: ratio is undefined there and the screen renders "—".
    avoidability: Distribution | None
    #: How many days the distribution above is over. Published because "mean
    #: 0.6 over three days" and "over ninety" are not the same claim.
    days_with_avoidability: int
    total_recovered_mwh: float
    mean_forecast_value_gap_mwh: float
    #: The count of days where ``Σf50 < Σa``. The share is beside it because
    #: the metric's name says days and `replay.md`'s note says share, and a row
    #: carrying both cannot be read wrong either way.
    days_forecast_underestimated: int

    @classmethod
    def over(cls, days: Sequence[BacktestDay]) -> BacktestMetrics:
        if not days:
            raise BacktestError(
                "a backtest row over no days has no metrics; it is reported "
                "with days_replayed = 0 and no figures"
            )
        ratios = [day.avoidability for day in days if day.avoidability is not None]
        return cls(
            days_replayed=len(days),
            avoidability=Distribution.of(ratios) if ratios else None,
            days_with_avoidability=len(ratios),
            total_recovered_mwh=sum(day.recovered_mwh for day in days),
            mean_forecast_value_gap_mwh=(
                sum(day.forecast_value_gap_mwh for day in days) / len(days)
            ),
            days_forecast_underestimated=sum(
                1 for day in days if day.forecast_underestimated
            ),
        )

    @property
    def forecast_underestimated_share(self) -> float:
        return self.days_forecast_underestimated / self.days_replayed

    def as_payload(self) -> dict[str, object]:
        return {
            "avoidability": (
                None if self.avoidability is None else self.avoidability.as_payload()
            ),
            "days_with_avoidability": self.days_with_avoidability,
            "total_recovered_mwh": self.total_recovered_mwh,
            "mean_forecast_value_gap_mwh": self.mean_forecast_value_gap_mwh,
            "days_forecast_underestimated": self.days_forecast_underestimated,
            "forecast_underestimated_share": self.forecast_underestimated_share,
        }


@dataclass(frozen=True)
class BacktestRow:
    """One reported row: one fold, or one side of a fold split at go-live.

    The fidelity is not a field on this class. It is
    :attr:`FoldSegment.fidelity`, on the key the row was grouped by, so a row
    cannot be constructed with a caveat that differs from the one its days
    carried — and two rows of the same fold cannot be summed into one without
    first discarding the thing that told them apart.
    """

    segment: FoldSegment
    days_replayed: int
    by_subsystem: tuple[SubsystemCoverage, ...]
    #: ``None`` when this segment replayed no days.
    metrics: BacktestMetrics | None
    #: The measured vintage caveat, once there are days held in both vintages.
    #: ``None`` until then, and never a zero standing in for it.
    revision_premium: RevisionPremium | None = None

    def __post_init__(self) -> None:
        if (self.metrics is None) != (self.days_replayed == 0):
            raise BacktestError(
                f"{self.segment.row_id} replayed {self.days_replayed} days and "
                f"{'has' if self.metrics else 'has no'} metrics; the two say "
                "different things about whether this row was computed"
            )
        if self.metrics is not None and self.metrics.days_replayed != self.days_replayed:
            raise BacktestError(
                f"{self.segment.row_id} counts {self.days_replayed} days and its "
                f"metrics were taken over {self.metrics.days_replayed}"
            )
        counted = sum(entry.days_replayed for entry in self.by_subsystem)
        if counted != self.days_replayed:
            raise BacktestError(
                f"{self.segment.row_id} counts {self.days_replayed} days and its "
                f"subsystem rows account for {counted}"
            )

    @property
    def vintage_fidelity(self) -> str:
        """On every row, from the key it was grouped by."""
        return self.segment.fidelity

    def as_payload(self) -> dict[str, object]:
        body: dict[str, object] = {
            "fold": self.segment.fold_id,
            "row_id": self.segment.row_id,
            "vintage_fidelity": self.vintage_fidelity,
            "is_split": self.segment.is_split,
            "segment_hash": self.segment.segment_hash,
            "test_start": self.segment.test_start.isoformat(),
            "test_end": self.segment.test_end.isoformat(),
            "days_replayed": self.days_replayed,
            "by_subsystem": [entry.as_payload() for entry in self.by_subsystem],
            "revision_premium_recovered_mwh": published_premium(self.revision_premium),
        }
        if self.metrics is None:
            body["metrics"] = None
            return body
        body["metrics"] = self.metrics.as_payload()
        return body


@dataclass(frozen=True)
class Backtest:
    """Many replays, as rows — and no field that reduces them to one number.

    Everything beyond :attr:`rows` is there so a figure can be *checked* rather
    than believed: which fleet, which build, which cut, and a digest over the
    days that answered. `replay.md` story 35 puts the reference fleet on every
    aggregate for exactly this, so that floor coverage here and the forecaster's
    ``Δ recovered_floor_mwh`` are computed against the same battery.
    """

    lane: str
    #: A digest over the basis — the same construction the featured days use,
    #: and for the same reason: a rerun writes a **new vintage of the same
    #: publication**, so ``forecast_origin`` cannot see it and the realised
    #: numbers can.
    computation_id: str
    computed_at: datetime
    #: The one ``AsOf`` every day of the recompute was read at, so the whole
    #: aggregate is one vintage cut rather than a mosaic of them.
    as_of: datetime
    reference_fleet_hash: str
    optimizer_build: str
    window_start: date
    window_end: date
    rows: tuple[BacktestRow, ...]

    def __post_init__(self) -> None:
        if not self.rows:
            raise BacktestError(
                "a backtest with no rows is not an aggregate; the fold calendar "
                "has at least one segment or the window is empty"
            )
        # The check forecaster 09 wrote for this exact failure, run on the rows
        # about to be published rather than on the ones about to be computed.
        assert_no_averaged_rows(tuple(row.segment for row in self.rows))

    def row(self, row_id: str) -> BacktestRow:
        for row in self.rows:
            if row.segment.row_id == row_id:
                return row
        raise BacktestError(f"no row {row_id!r}; this aggregate has {self.row_ids}")

    @property
    def row_ids(self) -> tuple[str, ...]:
        return tuple(row.segment.row_id for row in self.rows)

    def rows_of(self, fold_id: str) -> tuple[BacktestRow, ...]:
        """Every row of one fold — one, or two when it straddles go-live.

        Two is not a degenerate case to be collapsed by the caller: it is what a
        fold spanning ingestion go-live *is*, and the endpoint serves both.
        """
        return tuple(row for row in self.rows if row.segment.fold_id == fold_id)

    def state_at(self, now: datetime, *, ttl: timedelta = BACKTEST_TTL) -> str:
        return READY if now - self.computed_at <= ttl else STALE

    def as_payload(self, now: datetime | None = None) -> dict[str, object]:
        moment = now or datetime.now(tz=UTC)
        return {
            "state": self.state_at(moment),
            "computation_id": self.computation_id,
            "computed_at": self.computed_at.isoformat(),
            "as_of": self.as_of.isoformat(),
            "lane": self.lane,
            "reference_fleet_hash": self.reference_fleet_hash,
            "optimizer_build": self.optimizer_build,
            "window": {
                "start": self.window_start.isoformat(),
                "end": self.window_end.isoformat(),
            },
            "rows": [row.as_payload() for row in self.rows],
        }


def pending_payload(reason: str) -> dict[str, object]:
    """What the route publishes before the aggregate has been computed here."""
    return {
        "state": PENDING,
        "reason": reason,
        "computation_id": None,
        "computed_at": None,
        "rows": [],
    }


def segment_for(day: BacktestDay, segments: Sequence[FoldSegment]) -> FoldSegment:
    """The one segment a replayed day belongs to, or a refusal.

    Two conditions, and the second is the load-bearing one: the segment's test
    period contains the date, **and** the segment's fidelity is the day's own.
    Both labels come from
    :func:`wattsteer_ml.canonical.vintage_fidelity` applied to the same go-live
    instant — the segment's via
    :func:`~wattsteer_ml.evaluation.vintage.stamp_fidelity`, the day's via
    :func:`~wattsteer_ml.replay.calendar.day_fidelity` — so a disagreement means
    the two were computed against different go-lives, and putting the day in the
    row anyway is precisely how a caveat is averaged away.
    """
    covering = [
        segment
        for segment in segments
        if segment.test_start <= day.target_date <= segment.test_end
    ]
    if not covering:
        raise BacktestError(
            f"{day.target_date.isoformat()} is replayable and falls in no fold of "
            "this calendar; an aggregate that dropped it would report a window it "
            "did not cover"
        )
    matching = [
        segment for segment in covering if segment.fidelity == day.vintage_fidelity
    ]
    if not matching:
        offered = ", ".join(f"{s.row_id}={s.fidelity}" for s in covering)
        raise MixedFidelityError(
            f"{day.target_date.isoformat()} is {day.vintage_fidelity} and the "
            f"segments covering it are {offered}; the day and the row it would "
            "join disagree about the vintage, and pooling them is how the caveat "
            "disappears"
        )
    if len(matching) > 1:  # pragma: no cover — the calendar's folds do not overlap
        raise BacktestError(
            f"{day.target_date.isoformat()} falls in more than one segment of the "
            "same fidelity; the fold calendar does not overlap and this one does"
        )
    return matching[0]


def aggregate_backtest(
    days: Sequence[BacktestDay],
    *,
    segments: Sequence[FoldSegment],
    lane: str,
    as_of: datetime,
    window_start: date,
    window_end: date,
    premiums: Mapping[str, RevisionPremium] | None = None,
) -> Backtest:
    """Group the replayed days by segment and report each group as a row.

    ``segments`` is the group key and there is no other: it is a (fold,
    fidelity) pair, so grouping by it *is* stamping every row with a fidelity
    and refusing to average across values. This function takes no fidelity
    argument, and nothing in it compares a fidelity to a literal — the only
    fidelity in play is the one on the key and the one on the day, and
    :func:`segment_for` refuses when they differ.

    Every segment produces a row, including one that replayed no days: a
    straddling fold reported as a single row is a fold that looks unsplit, and
    :func:`~wattsteer_ml.evaluation.vintage.assert_no_averaged_rows` — run in
    :meth:`Backtest.__post_init__` — is what says so.

    ``premiums`` maps a row id to the measured vintage caveat for it, absent
    until ONS has restated days WattSteer holds both vintages of.
    """
    if not segments:
        raise BacktestError(
            "no fold segments to report; an aggregate needs the calendar it "
            "aggregates over"
        )
    grouped: dict[str, list[BacktestDay]] = {segment.row_id: [] for segment in segments}
    for day in days:
        grouped[segment_for(day, segments).row_id].append(day)

    by_id = {segment.row_id: segment for segment in segments}
    rows = tuple(
        _row(by_id[row_id], members, (premiums or {}).get(row_id))
        for row_id, members in grouped.items()
    )
    return Backtest(
        lane=lane,
        computation_id=_digest(
            lane=lane,
            window_start=window_start,
            window_end=window_end,
            rows=rows,
        ),
        computed_at=datetime.now(tz=UTC),
        as_of=as_of,
        reference_fleet_hash=reference_fleet_hash(),
        optimizer_build=OPTIMIZER_BUILD,
        window_start=window_start,
        window_end=window_end,
        rows=rows,
    )


def _row(
    segment: FoldSegment,
    days: Sequence[BacktestDay],
    premium: RevisionPremium | None,
) -> BacktestRow:
    by_subsystem: dict[str, list[BacktestDay]] = {}
    for day in days:
        by_subsystem.setdefault(day.subsystem, []).append(day)
    return BacktestRow(
        segment=segment,
        days_replayed=len(days),
        by_subsystem=tuple(
            SubsystemCoverage(
                subsystem=subsystem,
                days_replayed=len(members),
                days_floor_met=sum(1 for day in members if day.floor_met),
            )
            for subsystem, members in sorted(by_subsystem.items())
        ),
        metrics=BacktestMetrics.over(days) if days else None,
        revision_premium=premium,
    )


def _digest(
    *,
    lane: str,
    window_start: date,
    window_end: date,
    rows: Sequence[BacktestRow],
) -> str:
    """The computation id — sha256 over the basis, in a stated order.

    Over the *rows*, which carry the realised numbers: a rerun that restates a
    single hour of a single day moves a total and therefore moves this, while a
    rerun that changes nothing does not. The origin cannot do that job — a
    ``backfilled_holdout`` row's ``published_at`` is the counterfactual gate
    instant and a second run writes the identical one.
    """
    hasher = hashlib.sha256()
    hasher.update(
        canonical_json(
            {
                "lane": lane,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "reference_fleet": reference_fleet_hash(),
                "optimizer_build": OPTIMIZER_BUILD,
            }
        ).encode()
    )
    for row in sorted(rows, key=lambda row: row.segment.row_id):
        hasher.update(b"\x1e")
        hasher.update(canonical_json(row.as_payload()).encode())
    return f"sha256:{hasher.hexdigest()}"


@dataclass(frozen=True)
class ReplayedDay:
    """One day of the window, read and scored — the unit both aggregates share."""

    day: ReplayDay
    inputs: ReplayInputs
    scores: ReplayScores


async def replay_window(
    conn: asyncpg.Connection[Any],
    *,
    subsystem: str,
    lane: Lane,
    rules: FoldCalendarRules,
    windows_for: Callable[[str], ArtifactWindows | None],
    as_of: datetime,
    window_start: date,
    window_end: date,
) -> tuple[ReplayCalendar, tuple[ReplayedDay, ...], tuple[VintageSource, ...]]:
    """Every replayable day of the window, replayed once by the replay path.

    One ``as_of`` for the whole window, so the aggregate is one vintage cut even
    though it is assembled over many transactions — the property
    :mod:`wattsteer_ml.replay.shortlist` established for the same loop. A
    recompute that let each day resolve its own ``AsOf`` could pair one backtest
    run's band for January with the next run's for February and still look like
    an aggregate.

    Raises :class:`~wattsteer_ml.evaluation.holdout.HoldoutLeakError` if any day
    resolves an artifact that had seen it. Not caught here: an aggregate built
    around a leaking day would put the flattering number in front of the gate.
    """
    evidence = await read_calendar_evidence(
        conn,
        subsystem=subsystem,
        lane=lane,
        window_start=window_start,
        window_end=window_end,
        as_of=as_of,
    )
    calendar = build_calendar(
        evidence.days,
        subsystem=subsystem,
        lane=lane.directory_name,
        rules=rules,
        window_start=window_start,
        window_end=window_end,
        latest=window_end,
        windows_for=windows_for,
        sources=evidence.sources,
    )

    replayed: list[ReplayedDay] = []
    for day in calendar.replayable_days:
        inputs = await read_replay_inputs(
            conn,
            subsystem=subsystem,
            target_date=day.target_date,
            lane=lane,
            # Unpinned, exactly as the shortlist resolves it: the aggregate is a
            # claim about what the data says now, and the realised numbers go
            # into the computation id so a rerun that moves them is visible.
            forecast_origin=None,
            as_of=as_of,
        )
        held_out_by = day.held_out_by
        if inputs.forecast is None or inputs.observed is None or held_out_by is None:
            # The calendar said replayable and the day-grain read disagrees.
            # An absence, not a guess: half a day would put a number in a row
            # that no replay of that day could reproduce.
            continue
        windows = windows_for(held_out_by.artifact_id)
        if windows is None:  # pragma: no cover — build_calendar already raised
            continue
        replayed.append(
            ReplayedDay(
                day=day,
                inputs=inputs,
                scores=score_replay(
                    reference_fleet_scenario(subsystem, day.target_date),
                    day=day,
                    windows=windows,
                    forecast=inputs.forecast,
                    observed=inputs.observed,
                ),
            )
        )
    return calendar, tuple(replayed), evidence.sources


async def recompute_backtest(
    conn: asyncpg.Connection[Any],
    *,
    subsystem: str,
    lane: Lane,
    rules: FoldCalendarRules,
    windows_for: Callable[[str], ArtifactWindows | None],
    as_of: datetime,
    latest: date | None = None,
) -> Backtest:
    """Replay the whole window and aggregate it — the nightly job's one call.

    The fold segments come from
    :func:`~wattsteer_ml.evaluation.vintage.stamp_calendar` over the calendar
    materialised at the window's own end, with the go-live instant combined from
    the *same* :class:`~wattsteer_ml.canonical_reads.VintageSource` list the
    replay calendar stamped each day's fidelity from. So the row boundary and
    the day labels cannot be computed against two different go-lives, and no
    date is named here: if a further read joins the list the boundary moves and
    the rows move with it.
    """
    window_end = latest if latest is not None else latest_replayable_date(as_of)
    window_start = rules.window_start
    calendar, replayed, sources = await replay_window(
        conn,
        subsystem=subsystem,
        lane=lane,
        rules=rules,
        windows_for=windows_for,
        as_of=as_of,
        window_start=window_start,
        window_end=window_end,
    )
    del calendar  # the aggregate reports the days it scored, not the refusals
    segments = stamp_calendar(
        materialize_fold_calendar(window_end + _ONE_DAY, rules),
        combine_go_live(list(sources)),
    )
    return aggregate_backtest(
        [BacktestDay(subsystem=subsystem, scores=entry.scores) for entry in replayed],
        segments=segments,
        lane=lane.directory_name,
        as_of=as_of,
        window_start=window_start,
        window_end=window_end,
    )


class BacktestCache:
    """The nightly aggregate, held in the process that computed it.

    Process-local and read-only for the reasons
    :class:`~wattsteer_ml.replay.shortlist.FeaturedDaysCache` is: this service
    is read-only against Postgres and cannot own a cache table, and an aggregate
    is derived — evictable at any time with no loss beyond a recompute.

    Keyed by (subsystem, lane) and not by fold: the recompute runs the whole
    window, and a cache per fold would be several recomputes of the same days.
    """

    def __init__(self) -> None:
        self._entries: dict[tuple[str, str], Backtest] = {}

    def get(self, subsystem: str, lane: Lane) -> Backtest | None:
        return self._entries.get((subsystem, lane.directory_name))

    def put(self, subsystem: str, computed: Backtest) -> None:
        self._entries[(subsystem, computed.lane)] = computed

    def clear(self) -> None:
        self._entries.clear()


__all__ = [
    "BACKTEST_TTL",
    "PENDING",
    "READY",
    "STALE",
    "Backtest",
    "BacktestCache",
    "BacktestDay",
    "BacktestError",
    "BacktestMetrics",
    "BacktestRow",
    "Distribution",
    "ReplayedDay",
    "SubsystemCoverage",
    "aggregate_backtest",
    "pending_payload",
    "recompute_backtest",
    "replay_window",
    "segment_for",
]
