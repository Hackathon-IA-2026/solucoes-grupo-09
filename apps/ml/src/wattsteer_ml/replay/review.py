"""One replayed day, reviewed across subsystems and across its two gates.

The Time Machine's dashboard asks two questions a single replay cannot answer,
because a replay is one subsystem at one lane:

- **How did the four subsystems land?** — :func:`compare_day`. Each subsystem's
  pinned D−1 day band beside what settled, and where the settled total fell
  against the band.
- **What did WattSteer say, and when?** — :func:`timeline_day`. The same day at
  both served gates, the instants each forecast was published *and* written,
  and when the settled record it is scored against arrived and was rewritten.

## Nothing here judges a day a second time

Every verdict is :func:`~wattsteer_ml.replay.calendar.resolve_day`'s, called on
the same :class:`~wattsteer_ml.replay.inputs.ReplayInputs` a replay reads, so a
subsystem this module shows a band for is one the replay route would answer
from the same pinned row — and a leaking artifact raises here exactly as it
raises there. The band is shown on two verdicts only: a replayable day, and a
day refused as ``REPLAY_OBSERVATION_INCOMPLETE``, because that clause runs
*after* the held-out assertion and the forecast is therefore as honest as a
replayable day's; what is missing is the denominator, and the payload says so.

## What is computed here, and why each one is allowed

- **The settled total** is a sum of twenty-four settled hours — a measurement,
  and measurements add exactly.
- **The deviation** is ``settled − P50`` of *one* band: a measurement against a
  single quantile. Computed here rather than in a browser because the web app's
  no-summed-bands guard refuses any arithmetic between two ``.p50`` fields, and
  the timeline's P50-to-P50 comparison is precisely that shape.
- **The national settled total** is the sum of four subsystems' settled days,
  stated on the wire as ``sum_of_four`` — the same derivation
  ``NationalNow.derived`` names — and only when all four settled.
- **The national band is read, never assembled.** It is the joint row the path
  ensemble wrote over the four day totals on the same draw, and it is read only
  when all four subsystems resolved the *same* publication; otherwise it is an
  absence with its reason.

No percentage is computed. A day-level "accuracy" is a statistic one day cannot
produce, and `apps/web/test/replay-accuracy.test.ts` holds the same line on the
screen.
"""

from __future__ import annotations

import functools
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal

import anyio.from_thread
import asyncpg

from wattsteer_ml.canonical_reads import ReadAxes, apply_axes
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.database import Database
from wattsteer_ml.lanes import Lane, format_instant
from wattsteer_ml.mixture import QuantileBand
from wattsteer_ml.publication import BACKFILLED_HOLDOUT_ORIGIN_KIND
from wattsteer_ml.replay.calendar import ReplayDay
from wattsteer_ml.replay.inputs import ReplayInputs

#: Where a settled total fell against the band. Both edges count as inside,
#: the same rule `apps/web/src/lib/replay-accuracy.ts` draws.
Placement = Literal["inside", "above", "below"]

#: The one refusal after which the band is still an honest forecast: the
#: held-out assertion has already passed, and only the settled day is short.
_BAND_SURVIVES = "REPLAY_OBSERVATION_INCOMPLETE"

#: Why a settled total is absent. ``day_not_settled`` is the ordinary state of
#: yesterday before ONS's evening publication, and not a fault.
SETTLED_ABSENT: Literal["day_not_settled"] = "day_not_settled"

#: Why the national band is absent, as a closed vocabulary.
NationalBandAbsence = Literal[
    "subsystem_forecast_missing", "origins_differ", "no_joint_ensemble"
]

#: The derivation the national settled total carries on the wire.
SUM_OF_FOUR: Literal["sum_of_four"] = "sum_of_four"


def placement(band: QuantileBand, settled: float) -> Placement:
    """``inside`` on either edge; ``above`` past P90; ``below`` short of P10."""
    if settled > band.p90:
        return "above"
    if settled < band.p10:
        return "below"
    return "inside"


def _band(band: QuantileBand) -> dict[str, float]:
    return {"p10": band.p10, "p50": band.p50, "p90": band.p90}


def _band_is_honest(day: ReplayDay, inputs: ReplayInputs) -> bool:
    if inputs.forecast is None:
        return False
    return day.refusal is None or day.refusal.code == _BAND_SURVIVES


def _settled_total(inputs: ReplayInputs) -> float | None:
    return None if inputs.observed is None else float(sum(inputs.observed.hours))


@dataclass(frozen=True)
class NationalDay:
    """The joint row the path ensemble wrote over one publication's four days."""

    day_total: QuantileBand
    run_label: str
    subsystems: tuple[str, ...]


#: The joint national row of one publication, bound to its instant and kind.
NATIONAL_DAY_SQL = """
select
  day_total_p10_mwh,
  day_total_p50_mwh,
  day_total_p90_mwh,
  run_label,
  subsystems::text[] as subsystems
from canonical_forecast_national_day
where target_date = $1::date
  and feature_set = $2
  and gate_profile = $3::forecast_gate_profile
  and threshold_mw = $4::double precision
  and origin_kind = $5::forecast_origin_kind
  and published_at = $6::timestamptz
"""


async def read_national_day(
    conn: asyncpg.Connection[Any],
    *,
    target_date: date,
    lane: Lane,
    origin_kind: str,
    published_at: datetime,
    as_of: datetime,
) -> NationalDay | None:
    """The joint row of exactly this publication, or ``None``. Never re-resolved."""
    async with conn.transaction():
        await apply_axes(conn, ReadAxes(as_of=as_of))
        row = await conn.fetchrow(
            NATIONAL_DAY_SQL,
            target_date,
            lane.feature_set,
            lane.gate_profile,
            lane.threshold_mw,
            origin_kind,
            published_at,
        )
    if row is None:
        return None
    return NationalDay(
        day_total=QuantileBand(
            p10=float(row["day_total_p10_mwh"]),
            p50=float(row["day_total_p50_mwh"]),
            p90=float(row["day_total_p90_mwh"]),
        ),
        run_label=str(row["run_label"]),
        subsystems=tuple(str(code) for code in row["subsystems"]),
    )


#: The national read, as the route calls it — ``None`` where the publication
#: key is not one publication.
NationalDaySource = Callable[..., NationalDay | None]


def national_day_source(
    db: Database, *, now: Callable[[], datetime] | None = None
) -> NationalDaySource:
    """The threadpool bridge, built as ``replay_input_source`` builds its own."""
    clock: Callable[[], datetime] = now or functools.partial(datetime.now, UTC)

    def read(
        *, target_date: date, lane: Lane, origin_kind: str, published_at: datetime
    ) -> NationalDay | None:
        async def run() -> NationalDay | None:
            pool = await db.connect()
            async with pool.acquire() as conn:
                return await read_national_day(
                    conn,
                    target_date=target_date,
                    lane=lane,
                    origin_kind=origin_kind,
                    published_at=published_at,
                    as_of=clock(),
                )

        return anyio.from_thread.run(run)

    return read


def _origin(inputs: ReplayInputs) -> dict[str, Any] | None:
    if inputs.forecast is None:
        return None
    origin = inputs.forecast.origin
    return {
        "producer": origin.producer,
        "run_label": origin.run_label,
        "published_at": format_instant(origin.published_at),
        "origin_kind": origin.origin_kind,
        "gate_profile": origin.gate_profile,
    }


def _figures(day: ReplayDay, inputs: ReplayInputs) -> dict[str, Any]:
    """The band, the settled total and the deviation — each present or explained."""
    honest = _band_is_honest(day, inputs)
    settled = _settled_total(inputs)
    forecast = inputs.forecast if honest else None
    return {
        "day_total": None if forecast is None else _band(forecast.day_total),
        # The refusal code itself, which the web app already has a sentence for
        # in both locales. A second vocabulary for the same clauses would be two
        # names for one fact.
        "day_total_unavailable_reason": (
            None
            if forecast is not None
            else (
                day.refusal.code
                if day.refusal is not None
                else "REPLAY_FORECAST_UNAVAILABLE"
            )
        ),
        "settled_total_mwh": settled,
        "settled_unavailable_reason": None if settled is not None else SETTLED_ABSENT,
        "settled_hours": inputs.evidence.observed_hours,
        "settled_data_version": (
            None if inputs.observed is None else inputs.observed.data_version
        ),
        "deviation_mwh": (
            None
            if forecast is None or settled is None
            else settled - forecast.day_total.p50
        ),
        "placement": (
            placement(forecast.day_total, settled)
            if forecast is not None and settled is not None
            else None
        ),
    }


def subsystem_row(subsystem: str, day: ReplayDay, inputs: ReplayInputs) -> dict[str, Any]:
    """One subsystem of the comparison. Every figure is present or explained."""
    honest = _band_is_honest(day, inputs)
    return {
        "subsystem": subsystem,
        "replayable": day.replayable,
        "refusal_code": None if day.refusal is None else day.refusal.code,
        "provenance": day.provenance,
        "vintage_fidelity": day.vintage_fidelity,
        "forecast_origin": _origin(inputs) if honest else None,
        **_figures(day, inputs),
    }


def national_row(
    rows: Sequence[tuple[str, ReplayDay, ReplayInputs]],
    national: NationalDay | None,
    *,
    absence: NationalBandAbsence | None,
) -> dict[str, Any]:
    """The four settled days summed, and the joint band read — or each's reason."""
    settled = [_settled_total(inputs) for _, _, inputs in rows]
    complete = len(settled) == len(SUBSYSTEM_CODES) and all(
        total is not None for total in settled
    )
    settled_total = (
        sum(total for total in settled if total is not None) if complete else None
    )
    band = None if national is None else national.day_total
    return {
        "day_total": None if band is None else _band(band),
        "day_total_unavailable_reason": None if band is not None else absence,
        "settled_total_mwh": settled_total,
        "settled_derivation": SUM_OF_FOUR if settled_total is not None else None,
        "settled_unavailable_reason": None
        if settled_total is not None
        else SETTLED_ABSENT,
        "deviation_mwh": (
            None if band is None or settled_total is None else settled_total - band.p50
        ),
        "placement": (
            None
            if band is None or settled_total is None
            else placement(band, settled_total)
        ),
    }


def shared_publication(
    rows: Sequence[tuple[str, ReplayDay, ReplayInputs]],
) -> tuple[str, datetime] | NationalBandAbsence:
    """The one ``(origin_kind, published_at)`` all four bands came from, or why not.

    The joint row is a property of one publication. Four subsystems that
    resolved two publications — a served day for three and a reconstruction for
    one — have no joint band between them, and reading either publication's
    would print it over figures it does not describe.
    """
    keys: set[tuple[str, datetime]] = set()
    for _, day, inputs in rows:
        if not _band_is_honest(day, inputs) or inputs.forecast is None:
            return "subsystem_forecast_missing"
        origin = inputs.forecast.origin
        keys.add((origin.origin_kind, origin.published_at))
    if len(rows) != len(SUBSYSTEM_CODES):
        return "subsystem_forecast_missing"
    if len(keys) != 1:
        return "origins_differ"
    return next(iter(keys))


def _fidelity(rows: Sequence[tuple[Any, ReplayDay, ReplayInputs]]) -> str:
    """The day's verdict. Every row was judged against the same sources."""
    verdicts = {day.vintage_fidelity for _, day, _ in rows}
    # `revision_optimistic` wins a disagreement, which is the weakest-link rule
    # the calendar applies across reads, and never an average of two values.
    return "revision_optimistic" if "revision_optimistic" in verdicts else "point_in_time"


def compare_day(
    target_date: date,
    lane: Lane,
    rows: Sequence[tuple[str, ReplayDay, ReplayInputs]],
    national: NationalDay | None,
    *,
    national_absence: NationalBandAbsence | None,
) -> dict[str, Any]:
    """`GET /v1/replay/compare/{date}`'s body."""
    return {
        "target_date": target_date.isoformat(),
        "lane": lane.directory_name,
        # One day, one set of vintage sources, so every row carries the same
        # verdict; it is repeated at the top because a metric-carrying object
        # states its own (vocabulary rule 9) rather than inheriting a sibling's.
        "vintage_fidelity": _fidelity(rows),
        "subsystems": [subsystem_row(code, day, inputs) for code, day, inputs in rows],
        "national": {
            **national_row(rows, national, absence=national_absence),
            "vintage_fidelity": _fidelity(rows),
        },
    }


#: What a timeline event records, as a closed vocabulary.
EventKind = Literal[
    "forecast_published", "forecast_written", "settled_written", "settled_restated"
]


def _event(kind: EventKind, at: datetime, **extra: Any) -> dict[str, Any]:
    return {"kind": kind, "at": format_instant(at), **extra}


def gate_entry(lane: Lane, day: ReplayDay, inputs: ReplayInputs) -> dict[str, Any]:
    """One gate's forecast of the day, and the two instants behind it."""
    honest = _band_is_honest(day, inputs)
    forecast = inputs.forecast if honest else None
    return {
        "lane": lane.directory_name,
        "gate_profile": lane.gate_profile,
        "vintage_fidelity": day.vintage_fidelity,
        "replayable": day.replayable,
        "refusal_code": None if day.refusal is None else day.refusal.code,
        "provenance": day.provenance,
        "forecast_origin": _origin(inputs) if honest else None,
        # A backfilled row's `published_at` is the gate that *would* have been.
        # Said on the row, so a timeline cannot draw a reconstruction as though
        # it had been published at that instant.
        "published_at_is_counterfactual": (
            None
            if forecast is None
            else forecast.origin.origin_kind == BACKFILLED_HOLDOUT_ORIGIN_KIND
        ),
        "written_at": (
            None
            if forecast is None or inputs.forecast_written_at is None
            else format_instant(inputs.forecast_written_at)
        ),
        **_figures(day, inputs),
    }


def _events(
    gates: Sequence[tuple[Lane, ReplayDay, ReplayInputs]],
    settled: ReplayInputs | None,
) -> list[dict[str, Any]]:
    events: list[tuple[datetime, dict[str, Any]]] = []
    for lane, day, inputs in gates:
        if not _band_is_honest(day, inputs) or inputs.forecast is None:
            continue
        origin = inputs.forecast.origin
        counterfactual = origin.origin_kind == BACKFILLED_HOLDOUT_ORIGIN_KIND
        events.append(
            (
                origin.published_at,
                _event(
                    "forecast_published",
                    origin.published_at,
                    lane=lane.directory_name,
                    gate_profile=lane.gate_profile,
                    counterfactual=counterfactual,
                ),
            )
        )
        if inputs.forecast_written_at is not None:
            events.append(
                (
                    inputs.forecast_written_at,
                    _event(
                        "forecast_written",
                        inputs.forecast_written_at,
                        lane=lane.directory_name,
                        gate_profile=lane.gate_profile,
                        counterfactual=counterfactual,
                    ),
                )
            )
    vintage = None if settled is None else settled.settled_vintage
    if vintage is not None:
        events.append(
            (
                vintage.earliest_ingested_at,
                _event(
                    "settled_written",
                    vintage.earliest_ingested_at,
                    rows=vintage.entity_rows,
                    data_version=vintage.data_version,
                ),
            )
        )
        if vintage.restated_rows > 0:
            events.append(
                (
                    vintage.latest_ingested_at,
                    _event(
                        "settled_restated",
                        vintage.latest_ingested_at,
                        rows=vintage.restated_rows,
                        data_version=vintage.data_version,
                    ),
                )
            )
    events.sort(key=lambda pair: (pair[0], pair[1]["kind"]))
    return [event for _, event in events]


def timeline_day(
    subsystem: str,
    target_date: date,
    gates: Sequence[tuple[Lane, ReplayDay, ReplayInputs]],
) -> dict[str, Any]:
    """`GET /v1/replay/timeline/{date}`'s body — the day at every served gate."""
    settled = gates[0][2] if gates else None
    vintage = None if settled is None else settled.settled_vintage
    return {
        "subsystem": subsystem,
        "target_date": target_date.isoformat(),
        "vintage_fidelity": _fidelity(gates),
        "gates": [gate_entry(lane, day, inputs) for lane, day, inputs in gates],
        "settled": {
            "settled_total_mwh": None if settled is None else _settled_total(settled),
            "settled_unavailable_reason": (
                None
                if settled is not None and _settled_total(settled) is not None
                else SETTLED_ABSENT
            ),
            "settled_hours": 0 if settled is None else settled.evidence.observed_hours,
            "data_version": None if vintage is None else vintage.data_version,
            "earliest_written_at": (
                None if vintage is None else format_instant(vintage.earliest_ingested_at)
            ),
            "latest_written_at": (
                None if vintage is None else format_instant(vintage.latest_ingested_at)
            ),
            "entity_rows": 0 if vintage is None else vintage.entity_rows,
            "restated_rows": 0 if vintage is None else vintage.restated_rows,
        },
        "events": _events(gates, settled),
    }


#: The attribution of exactly the publication a replay is pinned to.
#:
#: Bound on ``run_label`` *and* ``published_at`` as well as the origin kind,
#: because the bars have to decompose the forecast being replayed and no other:
#: a served attribution of the same day explains a different artifact's number,
#: and printing it beside a reconstruction would label one model's reasons with
#: another's band.
ATTRIBUTION_SQL = """
select
  data_version,
  total_attributed_mwh,
  sum_abs_attributed_mwh,
  attribution_stderr_mwh,
  baseline_expected_mwh,
  day_expected_mwh,
  driver_group_version,
  driver_group_hash,
  governing_rule_action::text as governing_rule_action,
  rule_flags
from canonical_diagnosis_attribution
where subsystem = $1::subsystem_code
  and target_date = $2::date
  and gate_profile = $3::forecast_gate_profile
  and origin_kind = $4::forecast_origin_kind
  and published_at = $5::timestamptz
  and run_label = $6
"""

#: The day-grain drivers of that one row, ranked as they were written.
ATTRIBUTION_DRIVERS_SQL = """
select
  driver_group,
  label_code,
  phi_mwh,
  share,
  direction::text as direction,
  hour_disagreement,
  headline_feature,
  observed,
  typical,
  observed_absent_reason,
  typical_absent_reason,
  unit,
  demoted
from canonical_diagnosis_driver
where subsystem = $1::subsystem_code
  and target_date = $2::date
  and gate_profile = $3::forecast_gate_profile
  and origin_kind = $4::forecast_origin_kind
  and data_version = $5
  and grain = 'day'
order by rank
"""


@dataclass(frozen=True)
class PinnedAttribution:
    """One stored attribution and its day-grain drivers, read back verbatim."""

    total_attributed_mwh: float
    sum_abs_attributed_mwh: float
    stderr_mwh: float
    baseline_expected_mwh: float
    day_expected_mwh: float
    driver_group_version: str
    driver_group_hash: str
    governing_rule_action: str | None
    rule_codes: tuple[str, ...]
    drivers: tuple[dict[str, Any], ...]


def _rule_codes(raw: Any) -> tuple[str, ...]:
    flags = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(flags, list):
        return ()
    return tuple(
        str(flag["code"]) for flag in flags if isinstance(flag, dict) and "code" in flag
    )


async def read_pinned_attribution(
    conn: asyncpg.Connection[Any],
    *,
    subsystem: str,
    target_date: date,
    gate_profile: str,
    origin_kind: str,
    published_at: datetime,
    run_label: str,
    as_of: datetime,
) -> PinnedAttribution | None:
    """The attribution of one publication, or ``None`` when none was written."""
    async with conn.transaction():
        await apply_axes(conn, ReadAxes(as_of=as_of))
        row = await conn.fetchrow(
            ATTRIBUTION_SQL,
            subsystem,
            target_date,
            gate_profile,
            origin_kind,
            published_at,
            run_label,
        )
        if row is None:
            return None
        drivers = await conn.fetch(
            ATTRIBUTION_DRIVERS_SQL,
            subsystem,
            target_date,
            gate_profile,
            origin_kind,
            row["data_version"],
        )
    return PinnedAttribution(
        total_attributed_mwh=float(row["total_attributed_mwh"]),
        sum_abs_attributed_mwh=float(row["sum_abs_attributed_mwh"]),
        stderr_mwh=float(row["attribution_stderr_mwh"]),
        baseline_expected_mwh=float(row["baseline_expected_mwh"]),
        day_expected_mwh=float(row["day_expected_mwh"]),
        driver_group_version=str(row["driver_group_version"]),
        driver_group_hash=str(row["driver_group_hash"]),
        governing_rule_action=row["governing_rule_action"],
        rule_codes=_rule_codes(row["rule_flags"]),
        drivers=tuple(
            {
                "code": driver["driver_group"],
                "label_code": driver["label_code"],
                "phi_mwh": float(driver["phi_mwh"]),
                "share": float(driver["share"]),
                "direction": driver["direction"],
                "headline_feature": driver["headline_feature"],
                # `None` stays `None`: a zero where a reading is absent is the
                # one substitution the absent-reason pair exists to prevent.
                "observed": None
                if driver["observed"] is None
                else float(driver["observed"]),
                "typical": None
                if driver["typical"] is None
                else float(driver["typical"]),
                "observed_absent_reason": driver["observed_absent_reason"],
                "typical_absent_reason": driver["typical_absent_reason"],
                "unit": driver["unit"],
                "hour_disagreement": (
                    0.0
                    if driver["hour_disagreement"] is None
                    else float(driver["hour_disagreement"])
                ),
                "demoted": bool(driver["demoted"]),
            }
            for driver in drivers
        ),
    )


#: The attribution read, as the route calls it.
AttributionSource = Callable[..., PinnedAttribution | None]


def attribution_source(
    db: Database, *, now: Callable[[], datetime] | None = None
) -> AttributionSource:
    """The threadpool bridge for :func:`read_pinned_attribution`."""
    clock: Callable[[], datetime] = now or functools.partial(datetime.now, UTC)

    def read(**query: Any) -> PinnedAttribution | None:
        async def run() -> PinnedAttribution | None:
            pool = await db.connect()
            async with pool.acquire() as conn:
                return await read_pinned_attribution(conn, **query, as_of=clock())

        return anyio.from_thread.run(run)

    return read


#: Why a replayed day has no attribution beside it.
AttributionAbsence = Literal["no_pinned_forecast", "not_published"]


def attribution_day(
    subsystem: str,
    target_date: date,
    lane: Lane,
    day: ReplayDay,
    inputs: ReplayInputs,
    attribution: PinnedAttribution | None,
) -> dict[str, Any]:
    """`GET /v1/replay/attribution/{date}`'s body.

    What moved the *forecast* at D−1 — never the error, and never the grid. The
    bars decompose the expectation the pinned artifact published against its
    matched background, which is why they are bound to that publication.
    """
    honest = _band_is_honest(day, inputs)
    absence: AttributionAbsence | None = None
    if not honest:
        absence = "no_pinned_forecast"
    elif attribution is None:
        absence = "not_published"
    shown = attribution if absence is None else None
    return {
        "subsystem": subsystem,
        "target_date": target_date.isoformat(),
        "lane": lane.directory_name,
        "vintage_fidelity": day.vintage_fidelity,
        "forecast_origin": _origin(inputs) if honest else None,
        "attribution": (
            None
            if shown is None
            else {
                "target": "expected_mwh_day",
                "total_attributed_mwh": shown.total_attributed_mwh,
                "sum_abs_attributed_mwh": shown.sum_abs_attributed_mwh,
                "stderr_mwh": shown.stderr_mwh,
                "baseline_expected_mwh": shown.baseline_expected_mwh,
                "day_expected_mwh": shown.day_expected_mwh,
                "driver_group_version": shown.driver_group_version,
                "driver_group_hash": shown.driver_group_hash,
                "governing_rule_action": shown.governing_rule_action,
                "rule_codes": list(shown.rule_codes),
                "drivers": list(shown.drivers),
            }
        ),
        "attribution_unavailable_reason": absence,
    }


__all__ = [
    "ATTRIBUTION_DRIVERS_SQL",
    "ATTRIBUTION_SQL",
    "NATIONAL_DAY_SQL",
    "SETTLED_ABSENT",
    "SUM_OF_FOUR",
    "AttributionSource",
    "NationalBandAbsence",
    "NationalDay",
    "NationalDaySource",
    "PinnedAttribution",
    "Placement",
    "attribution_day",
    "attribution_source",
    "compare_day",
    "gate_entry",
    "national_day_source",
    "national_row",
    "placement",
    "read_national_day",
    "read_pinned_attribution",
    "shared_publication",
    "subsystem_row",
    "timeline_day",
]
