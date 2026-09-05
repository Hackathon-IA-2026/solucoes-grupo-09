"""Running the featured-days rule against the data, and caching the answer.

:mod:`wattsteer_ml.replay.featured` is the rule; this module is the half that
knows where the numbers come from and how long the answer is good for. It reads
the replayable calendar, replays **every** replayable day against the published
:data:`~wattsteer_ml.constants.REFERENCE_FLEET`, and hands the resulting
candidates to :func:`~wattsteer_ml.replay.featured.select_featured_days`.

## The same reader and the same scorer the endpoint runs

Each day goes through :func:`~wattsteer_ml.replay.inputs.read_replay_inputs`
and :func:`~wattsteer_ml.replay.scoring.score_replay` — the two functions
`POST /v1/replay` calls, imported rather than approximated. A cheaper bespoke
path is available and was rejected: three of the five clauses are SQL
aggregates, but the mandatory one is
``min(scored.observed.recovered − recovered_floor)``, and ``recovered_floor``
is the P10 column of the simulator's own :class:`ScoredBand`. Re-deriving it
here would put a second expression for "did the day clear its promised floor"
in the repository, and the day the two disagreed the shortlist would quietly
stop featuring the day WattSteer got wrong — which is the single failure this
ticket exists to prevent.

The cost of that choice is measured rather than assumed. ``test_replay_cost.py``
puts one replay at **24.4 ms** — two MILP solves and five simulator passes — and
the recompute over the **521** currently replayable days at **~13 s
single-threaded**. That is a nightly job, so it does not need a fan-out: a pool
of workers would buy about thirteen seconds a night at the price of a second
concurrency story, and the cut would then be spread over as many transactions as
there are workers with no single ``as_of`` to name it by.

One ``as_of`` is passed to every day's read, so the whole shortlist is one
vintage cut even though it is assembled over many transactions. A recompute that
let each day resolve its own ``AsOf`` could pair one backtest run's band for
January with the next run's for February and still look like a shortlist.

## What invalidates it, and why the origin cannot

Replay 06 established that ``forecast_origin`` names a **publication and never a
backtest run**: a ``backfilled_holdout`` row's ``published_at`` *is*
``gate_at(target_date, gate_profile)``, so a rerun writes a new **vintage of the
same publication** and the origin does not move. A cache keyed on the origin
would therefore serve a shortlist computed against superseded rows, indefinitely
and invisibly.

So the key is a :attr:`FeaturedDaysComputation.computation_id` — a digest over
the *basis*: the subsystem, the lane, the reference fleet, the optimizer build,
and for every replayable day its resolved origin **and the realised numbers that
came back**. A rerun that changes a single hour of a single day changes the id;
a rerun that changes nothing does not. That is the weak ETag
`docs/specs/api-surface.md` writes as ``W/"<featured-days computation id>"``,
and it is what the shortlist is invalidated by.

Because the digest is a function of the whole read, it cannot also be a *cheap*
staleness probe: knowing whether the cached list is current costs what computing
it costs. The cache therefore ages out on :data:`FEATURED_TTL`, and the honest
statement of currency is :attr:`FeaturedDaysComputation.computed_at`, published
beside the list.

## The cache, and the job that fills it

Process-local and read-only, because this service is read-only against Postgres
(`default_transaction_read_only`) and a shortlist is derived rather than
recorded — nothing here is a fact anybody needs to keep. It is filled by
``POST /internal/replay/featured-days``, which is what `api-surface.md`'s
``refresh-featured-days`` job (``30 3 * * *``) calls; the shape it returns is
this module's :meth:`FeaturedDaysComputation.as_payload`, and the job needs to
retain nothing from it beyond the ``computation_id`` it can log.

`GET /v1/replay/days` never recomputes on the request path. The gateway's ML
timeout is five seconds and a recompute is thirteen, so a read-through cache
would turn a cold instance's first calendar request into an upstream timeout.
A miss is published as :data:`PENDING`, with the rule and the criteria still on
the response, rather than as an empty list that would read as "the rule found
nothing".
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import asyncpg

from wattsteer_ml.constants import BRL_PER_MWH, REFERENCE_FLEET
from wattsteer_ml.evaluation.folds import FoldCalendarRules
from wattsteer_ml.lanes import Lane
from wattsteer_ml.optimizer import OPTIMIZER_BUILD
from wattsteer_ml.replay.calendar import (
    ReplayCalendar,
    ReplayDay,
    build_calendar,
    latest_replayable_date,
)
from wattsteer_ml.replay.cards import ArtifactWindows
from wattsteer_ml.replay.featured import (
    FEATURED_DAY_COUNT,
    FEATURED_RULE_SENTENCE,
    FeaturedCandidate,
    FeaturedDays,
    select_featured_days,
)
from wattsteer_ml.replay.inputs import read_replay_inputs
from wattsteer_ml.replay.reads import read_calendar_evidence
from wattsteer_ml.replay.scoring import ReplayScores, score_replay
from wattsteer_ml.scenario import canonical_json, hash_canonical_bytes

#: How long a computed shortlist is served before it is called stale. A day
#: plus an hour: the job runs nightly, and a list that went stale on the stroke
#: of twenty-four hours would spend every night briefly claiming to be out of
#: date while the job that refreshes it was still running.
FEATURED_TTL = timedelta(hours=25)

#: The state of a shortlist nobody has computed on this instance yet. A named
#: state rather than an empty list: "the rule has not run here" and "the rule
#: ran and named these" are different answers, and eight empty slots would read
#: as the second.
PENDING = "pending"
READY = "ready"
STALE = "stale"


def reference_fleet_scenario(subsystem: str, target_date: date) -> dict[str, Any]:
    """The published ``REFERENCE_FLEET``, as the `Scenario` the rule runs on.

    `docs/specs/replay.md` story 35 and the ticket's own blocker: the shortlist
    is not reproducible if the fleet it is computed against is restated per
    surface, so the numbers come from
    :data:`~wattsteer_ml.constants.REFERENCE_FLEET` and the price from
    :data:`~wattsteer_ml.constants.BRL_PER_MWH`. Both assets, because that is
    what the constant *is* — a shortlist scored on the battery alone would rank
    days by a fleet the product does not publish.
    """
    battery = REFERENCE_FLEET.battery
    load = REFERENCE_FLEET.shiftable_load
    return {
        "v": 1,
        "subsystem": subsystem,
        "target_date": target_date.isoformat(),
        "assets": [
            {
                "asset_type": battery.asset_type,
                "label": battery.label,
                "subsystem": subsystem,
                "max_power_mw": battery.max_power_mw,
                "energy_capacity_mwh": battery.energy_capacity_mwh,
                "round_trip_efficiency": battery.round_trip_efficiency,
                "initial_state_of_charge": battery.initial_state_of_charge,
            },
            {
                "asset_type": load.asset_type,
                "label": load.label,
                "subsystem": subsystem,
                "max_power_mw": load.max_power_mw,
                "max_shift_mw": load.max_shift_mw,
                "shift_window_hours": load.shift_window_hours,
                "daily_energy_mwh": load.daily_energy_mwh,
            },
        ],
        "economic_assumptions": {"brl_per_mwh": BRL_PER_MWH},
    }


#: The fleet's own hash, stamped on every computation. `replay.md` story 35
#: wants "the reference fleet used for every aggregate to be one published
#: constant in one place"; a hash on the answer is how a reader checks that the
#: list in front of them was computed against the constant they are holding,
#: rather than taking the sentence's word for it.
def reference_fleet_hash() -> str:
    battery = REFERENCE_FLEET.battery
    load = REFERENCE_FLEET.shiftable_load
    return hash_canonical_bytes(
        canonical_json(
            {
                "battery": {
                    "max_power_mw": battery.max_power_mw,
                    "energy_capacity_mwh": battery.energy_capacity_mwh,
                    "round_trip_efficiency": battery.round_trip_efficiency,
                    "initial_state_of_charge": battery.initial_state_of_charge,
                },
                "shiftable_load": {
                    "max_power_mw": load.max_power_mw,
                    "max_shift_mw": load.max_shift_mw,
                    "shift_window_hours": load.shift_window_hours,
                    "daily_energy_mwh": load.daily_energy_mwh,
                },
                "brl_per_mwh": BRL_PER_MWH,
            }
        ).encode()
    )


@dataclass(frozen=True)
class FeaturedDaysComputation:
    """One run of the rule: the shortlist, and everything it was computed from.

    Every field beyond :attr:`featured` is there so the list can be *checked*
    rather than believed — which fleet, which build, which cut, and a digest
    over the rows that answered. `replay.md`'s whole posture on this screen is
    that a number nobody can re-derive is a number nobody should quote, and a
    shortlist is no different from the figures on it.
    """

    subsystem: str
    lane: str
    #: A digest over the basis. Changes when a rerun writes a newer vintage of
    #: the same publication, which is exactly what ``forecast_origin`` cannot
    #: do — see the module docstring.
    computation_id: str
    computed_at: datetime
    #: The ``AsOf`` every day of the recompute was read at. One instant, so the
    #: shortlist is one vintage cut rather than a mosaic of them.
    as_of: datetime
    reference_fleet_hash: str
    optimizer_build: str
    window_start: date
    window_end: date
    featured: FeaturedDays

    def state_at(self, now: datetime, *, ttl: timedelta = FEATURED_TTL) -> str:
        return READY if now - self.computed_at <= ttl else STALE

    def as_payload(self, now: datetime | None = None) -> dict[str, object]:
        moment = now or datetime.now(tz=UTC)
        return {
            "state": self.state_at(moment),
            "computation_id": self.computation_id,
            "computed_at": self.computed_at.isoformat(),
            "as_of": self.as_of.isoformat(),
            "reference_fleet_hash": self.reference_fleet_hash,
            "optimizer_build": self.optimizer_build,
            "window": {
                "start": self.window_start.isoformat(),
                "end": self.window_end.isoformat(),
            },
            **self.featured.as_payload(),
        }


def pending_payload(reason: str) -> dict[str, object]:
    """What `/v1/replay/days` publishes before the rule has run on this instance.

    The rule and the size travel anyway, because they are the part of the
    contract that is true whether or not the list has been computed: a client
    can render the sentence and say the days are being recomputed, which is a
    different sentence from "there are no interesting days".
    """
    return {
        "state": PENDING,
        "reason": reason,
        "rule": FEATURED_RULE_SENTENCE,
        "size": FEATURED_DAY_COUNT,
        "computation_id": None,
        "computed_at": None,
        "days": [],
    }


def candidate_from(day: ReplayDay, scores: ReplayScores) -> FeaturedCandidate:
    """One replayed day, reduced to the five numbers the rule reads.

    Every value is a *property of the scored replay* — nothing is recomputed —
    so the floor margin the rule ranks on is the floor margin the replay screen
    renders for the same day.
    """
    provenance = day.provenance
    if provenance is None:  # pragma: no cover — a scored day is a replayable one
        raise ValueError(
            f"{day.target_date.isoformat()} was scored without a provenance; "
            "a replayable day always has one"
        )
    return FeaturedCandidate(
        target_date=day.target_date,
        provenance=provenance,
        vintage_fidelity=day.vintage_fidelity,
        observed_total_mwh=scores.observed.total_mwh,
        forecast_total_p50_mwh=scores.forecast.day_total.p50,
        floor_margin_mwh=scores.floor_margin_mwh,
    )


def _digest(
    *,
    subsystem: str,
    lane: str,
    window_start: date,
    window_end: date,
    fleet: str,
    basis: Sequence[tuple[str, ...]],
) -> str:
    """The computation id — sha256 over the basis, in a stated order.

    The per-day rows are sorted by date before hashing, so two recomputes that
    read the same data in a different order agree. Everything that could change
    a number is in here: a rerun's newer vintage shows up as different realised
    values even though the publication instant is byte-identical.
    """
    hasher = hashlib.sha256()
    header = canonical_json(
        {
            "subsystem": subsystem,
            "lane": lane,
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "reference_fleet": fleet,
            "optimizer_build": OPTIMIZER_BUILD,
            "rule": FEATURED_RULE_SENTENCE,
        }
    )
    hasher.update(header.encode())
    for row in sorted(basis):
        hasher.update(b"\x1e")
        hasher.update("\x1f".join(row).encode())
    return f"sha256:{hasher.hexdigest()}"


async def recompute_featured_days(
    conn: asyncpg.Connection[Any],
    *,
    subsystem: str,
    lane: Lane,
    rules: FoldCalendarRules,
    windows_for: Callable[[str], ArtifactWindows | None],
    as_of: datetime,
    latest: date | None = None,
    size: int = FEATURED_DAY_COUNT,
) -> FeaturedDaysComputation:
    """Replay every replayable day, then run the rule over the lot.

    Raises :class:`~wattsteer_ml.evaluation.holdout.HoldoutLeakError` if any day
    in the window resolves an artifact that had seen it, and
    :class:`~wattsteer_ml.replay.featured.FeaturedRuleError` if nothing is
    replayable. Neither is caught here: a shortlist assembled around a leaking
    day would put the flattering number on the demo screen, which is worse than
    no shortlist, and a shortlist of nothing is not a shortlist.

    ``latest`` defaults to yesterday on the grid's civil clock, read off
    ``as_of`` — the same :func:`~wattsteer_ml.replay.calendar.latest_replayable_date`
    the calendar route uses, so the recompute and the calendar never disagree
    about where the window ends.
    """
    window_end = latest if latest is not None else latest_replayable_date(as_of)
    window_start = rules.window_start
    calendar = await _read_calendar(
        conn,
        subsystem=subsystem,
        lane=lane,
        rules=rules,
        window_start=window_start,
        window_end=window_end,
        as_of=as_of,
        windows_for=windows_for,
    )

    wire_hash = reference_fleet_hash()
    candidates: list[FeaturedCandidate] = []
    basis: list[tuple[str, ...]] = []
    for day in calendar.replayable_days:
        inputs = await read_replay_inputs(
            conn,
            subsystem=subsystem,
            target_date=day.target_date,
            lane=lane,
            # Unpinned on purpose. The shortlist is a claim about *what the
            # data says now*, so it resolves each day the way the calendar
            # does — a record outranks a reconstruction, then the newest
            # publication — and the resulting numbers go into the digest so a
            # rerun that moves them moves the computation id.
            forecast_origin=None,
            as_of=as_of,
        )
        held_out_by = day.held_out_by
        if inputs.forecast is None or inputs.observed is None or held_out_by is None:
            # The calendar said replayable and the day-grain read disagrees.
            # Skipped rather than guessed at: a disagreement between two reads
            # is an absence, and inventing a candidate from half a day would put
            # a number in the ranking that no replay could reproduce.
            continue
        windows = windows_for(held_out_by.artifact_id)
        if windows is None:  # pragma: no cover — build_calendar already raised
            continue
        scores = score_replay(
            reference_fleet_scenario(subsystem, day.target_date),
            day=day,
            windows=windows,
            forecast=inputs.forecast,
            observed=inputs.observed,
        )
        candidates.append(candidate_from(day, scores))
        basis.append(
            (
                day.target_date.isoformat(),
                inputs.forecast.origin.origin_kind,
                inputs.forecast.origin.run_label,
                inputs.forecast.origin.published_at.isoformat(),
                # The realised numbers, not only the origin: a rerun is a new
                # vintage of *one* publication, so the three fields above are
                # identical across it and these three are not.
                repr(inputs.observed.total_mwh),
                repr(inputs.forecast.day_total.p50),
                repr(scores.floor_margin_mwh),
            )
        )

    return FeaturedDaysComputation(
        subsystem=subsystem,
        lane=lane.directory_name,
        computation_id=_digest(
            subsystem=subsystem,
            lane=lane.directory_name,
            window_start=window_start,
            window_end=window_end,
            fleet=wire_hash,
            basis=basis,
        ),
        computed_at=datetime.now(tz=UTC),
        as_of=as_of,
        reference_fleet_hash=wire_hash,
        optimizer_build=OPTIMIZER_BUILD,
        window_start=window_start,
        window_end=window_end,
        featured=select_featured_days(candidates, size=size),
    )


async def _read_calendar(
    conn: asyncpg.Connection[Any],
    *,
    subsystem: str,
    lane: Lane,
    rules: FoldCalendarRules,
    window_start: date,
    window_end: date,
    as_of: datetime,
    windows_for: Callable[[str], ArtifactWindows | None],
) -> ReplayCalendar:
    evidence = await read_calendar_evidence(
        conn,
        subsystem=subsystem,
        lane=lane,
        window_start=window_start,
        window_end=window_end,
        as_of=as_of,
    )
    return build_calendar(
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


class FeaturedDaysCache:
    """The nightly answer, held in the process that computed it.

    Not Redis and not a table, for one reason each: this service is read-only
    against Postgres, so it cannot own a cache table; and a shortlist is
    *derived*, evictable at any time with no user-visible loss beyond a
    recompute, which is `flex-optimizer.md`'s own standard for what may be
    cached. Two instances hold two entries that agree, because the rule is
    deterministic given the data and both compute it from the same rows.

    Keyed by (subsystem, lane) and not by window: the shortlist is always
    evaluated over the whole replayable set, whatever slice of the calendar a
    caller happens to have asked for. A shortlist over a caller's window would
    be a shortlist the caller chose.
    """

    def __init__(self) -> None:
        self._entries: dict[tuple[str, str], FeaturedDaysComputation] = {}

    def get(self, subsystem: str, lane: Lane) -> FeaturedDaysComputation | None:
        return self._entries.get((subsystem, lane.directory_name))

    def put(self, computation: FeaturedDaysComputation) -> None:
        self._entries[(computation.subsystem, computation.lane)] = computation

    def clear(self) -> None:
        self._entries.clear()


__all__ = [
    "FEATURED_TTL",
    "PENDING",
    "READY",
    "STALE",
    "FeaturedDaysCache",
    "FeaturedDaysComputation",
    "candidate_from",
    "pending_payload",
    "recompute_featured_days",
    "reference_fleet_hash",
    "reference_fleet_scenario",
]
