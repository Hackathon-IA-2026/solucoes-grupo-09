"""Which days are replayable, and why the others are refused.

`docs/specs/replay.md`, "Which days are replayable — decided", is the authority.
The predicate it publishes has five clauses:

    replayable(d) ⟺  d ≥ F1.test_start
                 ∧  d ≤ yesterday (America/Sao_Paulo)
                 ∧  ∃ Forecast rows for (subsystem, d) with origin_kind ∈
                      {served, backfilled_holdout}
                 ∧  the held-out assertion passes for that origin's artifact
                 ∧  observed rows exist for all 24 hours of d

This module is that predicate — and, which is the ticket, it is the *refusals*
as well. A day that fails is not absent from the calendar and is not returned
with a caveat over a number: it is returned carrying the code of the clause that
failed, and the single-day route answers at that code's status.

## Why four clauses are values and the fifth is an exception

Four of them fail for reasons that are facts about the data: the date is outside
the window, the backtest has not run for that quarter, ONS has not settled all
twenty-four hours. Those are :class:`ReplayRefused` — a value with a code, a
status and a sentence, one per clause — and a calendar is a list of them.

The fifth is not like the others. A `Forecast` row whose artifact was fitted on
the day it forecasts is **a WattSteer bug**, and the number it would produce is
better than the product's. So it is
:class:`~wattsteer_ml.evaluation.holdout.HoldoutLeakError` — the class replay 01
raises at mint time, imported rather than re-declared — it maps to
`REPLAY_INTEGRITY_VIOLATION` (500), and it takes the whole calendar down rather
than appearing in it as one refused day. A badge in a list is exactly what
`replay.md` rules out with "a `500`, not a badge": a calendar that can be
published while it contains a leak has published the leak.

## Against the card, and never against the promoted artifact

The windows checked here are read off the **artifact card of the artifact named
on the row** (`run_label`), by :mod:`wattsteer_ml.replay.cards`. Two things
follow, and both are the point:

- The run's blocks are not consulted. :class:`FoldBlocks` refuses an overlapping
  triple on construction, so a leak is not representable there; the card is the
  only place one can be written down, which is why the card is what is asserted
  against.
- Nothing in this package calls :func:`wattsteer_ml.artifacts.current` or
  ``load_promoted``. There is no argument, and no code path, by which a
  historical day resolves the artifact on serving duty today — so a retrain that
  extends the serving training window over a day already replayed changes
  nothing here. A test asserts the absence by reading the source, because "we
  did not call it" is a property of the file rather than of a fixture.

## Two open decisions this module makes concrete rather than settles

**Which lane a replay pins.** Post-go-live the forecaster serves two lanes, so a
`served` day has two candidate forecasts and no rule anywhere says which one a
replay is *of* — `replay.md` writes ``gate_at(d, gate_late)`` where it describes
what is precomputed and the generic ``gate_at(d, gate_profile)`` on the row.
This module therefore takes the lane as a **required argument**, picks nothing,
and reports :attr:`ReplayDay.candidate_lanes` so a day with two is visibly a day
with two. A default here would answer a question nobody has asked, inside a
keyword argument.

**Whether ingestion go-live coincides with F6's start.** It does not appear
here. Fidelity is :func:`wattsteer_ml.canonical.vintage_fidelity` applied to the
day's earliest instant against the go-live of the reads a replay consults,
combined by the weakest-link rule — which is ``canonical_read_go_live``'s own
arithmetic and the position :mod:`wattsteer_ml.evaluation.vintage` already
takes. So ``2026-07-01`` is nowhere in this file: if go-live does coincide with
F6's start then `replay.md`'s three-way table falls out of the data, and if it
does not — or if the two reads went live on different days, which the migration
allows — a `fold_holdout` day can be `point_in_time` and the calendar says so
rather than asserting the table.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from wattsteer_ml.canonical import (
    VintageFidelity,
    VintageSource,
    combine_go_live,
    vintage_fidelity,
)
from wattsteer_ml.evaluation.folds import FoldCalendarRules
from wattsteer_ml.evaluation.holdout import HoldoutLeakError
from wattsteer_ml.evaluation.vintage import earliest_valid_instant
from wattsteer_ml.features import BRASILIA
from wattsteer_ml.publication import (
    BACKFILLED_HOLDOUT_ORIGIN_KIND,
    SERVED_ORIGIN_KIND,
)
from wattsteer_ml.replay.cards import ArtifactWindows

#: How many settled hours a replayable day needs. All of them: the denominator
#: of every figure on the replay screen is the whole local day, so a day short
#: an hour is a different quantity wearing the same name.
HOURS_PER_DAY = 24

#: `origin_kind` → the `provenance` the contract publishes. The two vocabularies
#: differ on purpose — `origin_kind` is a property of the *row*, `provenance` is
#: what the screen says — and this mapping is the only place they meet.
PROVENANCE_BY_ORIGIN_KIND: Mapping[str, str] = {
    SERVED_ORIGIN_KIND: "served",
    BACKFILLED_HOLDOUT_ORIGIN_KIND: "fold_holdout",
}

#: What a replay's vintage caveat touches, and what it explicitly does not.
#: `docs/specs/replay.md`, "What `revision_optimistic` actually touches": the
#: weather run is genuinely point-in-time on both sides of go-live, so naming it
#: would make the caveat vaguer *and* less true.
VINTAGE_AFFECTS: tuple[str, ...] = ("settled_actuals", "lagged_actual_features")
VINTAGE_EXEMPT: tuple[str, ...] = ("weather_run", "dessem", "ons_programming")

#: The canonical reads whose go-live decides a replayed day's fidelity — the
#: reads behind the two things :data:`VINTAGE_AFFECTS` names. A tuple rather
#: than one name because the rule is the weakest link across the reads
#: consulted, so a second read is data rather than a rewrite.
VINTAGE_READS: tuple[str, ...] = ("curtailment-by-reporting-entity",)

_ONE_DAY = timedelta(days=1)


@dataclass(frozen=True)
class ReplayRefused:
    """One clause of the predicate, failed, as the code a client acts on.

    A value and not a sentence: `docs/specs/replay.md`'s last user story is that
    "every refusal is a typed code, never a translated string", so
    :attr:`message` is developer prose for a log and :attr:`code` is the whole
    contract.

    Deliberately **not** an exception. A refusal is an answer — the calendar is
    a list of them and half of them are the ordinary case — whereas the one
    condition that *is* raised here, a leak, is the one that must not be
    catchable into a badge. Making both exceptions would put them one
    ``except`` clause apart.
    """

    code: str
    status: int
    message: str
    details: Mapping[str, object] = field(default_factory=dict)

    def __str__(self) -> str:
        return self.message

    def as_payload(self) -> dict[str, object]:
        return {
            "code": self.code,
            "status": self.status,
            "message": self.message,
            "details": dict(self.details),
        }


@dataclass(frozen=True)
class HeldOutBy:
    """The artifact that did not see the day, and the windows proving it.

    `docs/specs/replay.md` story 3: the screen names *which* artifact produced
    the forecast and *what window it was trained on*, "so that the claim is
    checkable rather than asserted". Both windows travel, because the
    calibration one is where the isotonic map and both conformal scalars were
    fitted and is the subtler leak.
    """

    fold: str
    artifact_id: str
    train_window: tuple[date, date]
    calibration_window: tuple[date, date]

    def as_payload(self) -> dict[str, object]:
        return {
            "fold": self.fold,
            "artifact_id": self.artifact_id,
            "train_window": [one.isoformat() for one in self.train_window],
            "calibration_window": [one.isoformat() for one in self.calibration_window],
        }


@dataclass(frozen=True)
class ReplayDay:
    """One day of the calendar: replayable with its provenance, or refused.

    Exactly one of :attr:`held_out_by` and :attr:`refusal` is set — checked on
    construction, so "replayable with a caveat" is not a state this type can be
    in. The caveat the product *does* carry, :attr:`vintage_fidelity`, is a
    separate axis and is populated on refused days too: "this day cannot be
    replayed" and "its actuals would have been a restatement" are two facts, and
    `replay.md` keeps them apart precisely because today they coincide.
    """

    target_date: date
    provenance: str | None
    vintage_fidelity: VintageFidelity
    held_out_by: HeldOutBy | None
    refusal: ReplayRefused | None
    #: Every lane holding a forecast for this day. One element is the ordinary
    #: case; two is the open question named in the module docstring, reported
    #: rather than resolved.
    candidate_lanes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if (self.refusal is None) == (self.held_out_by is None):
            raise ValueError(
                f"{self.target_date.isoformat()}: a day is replayable or refused, "
                "and this one claims both or neither"
            )

    @property
    def replayable(self) -> bool:
        return self.refusal is None

    def as_payload(self) -> dict[str, object]:
        body: dict[str, object] = {
            "date": self.target_date.isoformat(),
            "replayable": self.replayable,
            "provenance": self.provenance,
            "vintage_fidelity": self.vintage_fidelity,
            "candidate_lanes": list(self.candidate_lanes),
            "held_out_by": (
                None if self.held_out_by is None else self.held_out_by.as_payload()
            ),
            # Asserted, never computed hopefully — and `false` on a replayable
            # day because :func:`assert_held_out` raised if it were not. On a
            # refused day it is `null`: nothing was asserted, and `false` there
            # would be a claim this module did not check.
            "model_saw_this_day": False if self.replayable else None,
            "refusal": None if self.refusal is None else self.refusal.as_payload(),
        }
        return body


@dataclass(frozen=True)
class DayEvidence:
    """What the database holds about one (subsystem, day), before any judgement.

    Assembled by :mod:`wattsteer_ml.replay.reads` and judged by
    :func:`resolve_day`. Split in two so the predicate is exercisable without a
    Postgres — which is what makes "the boundary is legible rather than
    arbitrary" a property with tests behind it rather than a hope.
    """

    target_date: date
    #: ``served`` or ``backfilled_holdout`` for the chosen lane; ``None`` when
    #: that lane published nothing for this day.
    origin_kind: str | None = None
    #: ``run_label`` — the artifact that produced the rows. ``None`` with the
    #: above.
    artifact_id: str | None = None
    #: Distinct settled hours of the local day. Counted, never assumed.
    observed_hours: int = 0
    candidate_lanes: tuple[str, ...] = ()


def integrity_violation(
    leak: HoldoutLeakError, *, subsystem: str, lane: str
) -> ReplayRefused:
    """A leak, in the shape the route answers with — and beside its four peers.

    Here rather than in the route because the status and the code belong to the
    condition and not to the throw site: the four refusals above name their own
    status, and a fifth one chosen in a handler could disagree with this table
    without anything noticing.

    It is still not returned by :func:`resolve_day`. The route builds it from a
    caught :class:`~wattsteer_ml.evaluation.holdout.HoldoutLeakError`, so a
    violation reaches a client only as the whole answer, never as one entry of a
    calendar — "a `500`, not a badge".

    The message carries the artifact id, because the leak's own message does:
    `replay.md`'s acceptance list requires the violation to be logged with the
    artifact, and a log line that named only the day would leave an operator
    with no way to find the card that lied.
    """
    return ReplayRefused(
        code="REPLAY_INTEGRITY_VIOLATION",
        status=500,
        message=str(leak),
        details={"subsystem": subsystem, "lane": lane},
    )


def assert_held_out(
    target_date: date, windows: ArtifactWindows, *, subsystem: str
) -> None:
    """The held-out assertion, at read time, against the card's own windows.

    ``assert target_date ∉ [train_start, train_end]`` and
    ``assert target_date ∉ [calibration_start, calibration_end]`` — the two
    lines `docs/specs/replay.md` writes out, in that order. Both, because the
    calibration window is where isotonic and the two conformal scalars were
    fitted: a day inside it has shaped the very interval the replay promises a
    floor from, and it is the leak a future session is most likely to forget.

    Raises :class:`~wattsteer_ml.evaluation.holdout.HoldoutLeakError` rather
    than returning ``False``. Replay 01 raises the same class when it refuses to
    *mint* such a row; this is the same claim, checked against the same
    document, at the other end — and a caller that could branch on a boolean
    would eventually branch the wrong way.
    """
    if windows.train_start <= target_date <= windows.train_end:
        raise HoldoutLeakError(
            f"{subsystem} {target_date.isoformat()}: artifact "
            f"{windows.artifact_id} records a training window "
            f"{windows.train_start.isoformat()}–{windows.train_end.isoformat()} "
            "that contains the replayed day, so the forecast it produced is an "
            "in-sample fit and the recovery computed from it is an upper bound "
            "of unknown size"
        )
    if windows.calibration_start <= target_date <= windows.calibration_end:
        raise HoldoutLeakError(
            f"{subsystem} {target_date.isoformat()}: artifact "
            f"{windows.artifact_id} records a calibration window "
            f"{windows.calibration_start.isoformat()}–"
            f"{windows.calibration_end.isoformat()} that contains the replayed "
            "day; the isotonic map and both conformal scalars were fitted "
            "there, so the interval this replay would promise a floor from has "
            "already seen the day"
        )


def day_fidelity(target_date: date, sources: Sequence[VintageSource]) -> VintageFidelity:
    """A replayed day's `VintageFidelity` — the weakest link across its reads.

    No date is named here and none is imported. The boundary is whatever
    ``canonical_read_go_live`` says it is for the reads a replay consults, and a
    day whose earliest local instant precedes the latest of them is a
    restatement.
    """
    return vintage_fidelity(
        earliest_valid_instant(target_date), combine_go_live(list(sources))
    )


def latest_replayable_date(now: datetime) -> date:
    """Yesterday, on the grid's civil clock.

    Today is refused because its hours have not all happened, let alone settled.
    `replay.md`'s predicate writes it ``d ≤ yesterday (America/Sao_Paulo)``, and
    it is the fold calendar's own ``as_of − 1`` convention for the same reason.
    """
    return now.astimezone(BRASILIA).date() - _ONE_DAY


def _out_of_range(target_date: date, reason: str, **details: object) -> ReplayRefused:
    return ReplayRefused(
        code="REPLAY_DATE_OUT_OF_RANGE",
        status=422,
        message=f"{target_date.isoformat()} {reason}",
        details={"date": target_date.isoformat(), **details},
    )


def resolve_day(
    evidence: DayEvidence,
    *,
    subsystem: str,
    lane: str,
    rules: FoldCalendarRules,
    latest: date,
    windows: ArtifactWindows | None,
    sources: Sequence[VintageSource] = (),
) -> ReplayDay:
    """One day, judged against every clause, in the order the spec writes them.

    The order is load-bearing rather than cosmetic. "Before the data window
    opens" and "before the first test fold" are two different sentences to a
    reader — one is outside the data, the other is inside it and deliberately
    not offered — so both are decided before anything looks for a row. And the
    held-out assertion runs *before* the observed-hours count, so a leaking
    artifact cannot hide behind a day ONS has not settled yet.

    Raises :class:`~wattsteer_ml.evaluation.holdout.HoldoutLeakError` and never
    returns a refused day for it. See the module docstring.
    """
    fidelity = day_fidelity(evidence.target_date, sources)
    target_date = evidence.target_date

    def refused(refusal: ReplayRefused) -> ReplayDay:
        return ReplayDay(
            target_date=target_date,
            provenance=None,
            vintage_fidelity=fidelity,
            held_out_by=None,
            refusal=refusal,
            candidate_lanes=evidence.candidate_lanes,
        )

    if target_date < rules.window_start:
        return refused(
            _out_of_range(
                target_date,
                f"precedes the data window, which opens {rules.window_start.isoformat()}",
                window_start=rules.window_start.isoformat(),
            )
        )
    if target_date > latest:
        return refused(
            _out_of_range(
                target_date,
                "is not in the past; the latest replayable day is "
                f"{latest.isoformat()} (America/Sao_Paulo)",
                latest_replayable_date=latest.isoformat(),
            )
        )
    if target_date < rules.first_test_start:
        return refused(
            ReplayRefused(
                code="REPLAY_DATE_BEFORE_HOLDOUT_WINDOW",
                status=422,
                message=(
                    f"{target_date.isoformat()} precedes the first walk-forward "
                    f"test fold, which opens {rules.first_test_start.isoformat()}. "
                    "Every artifact was fitted on this day, so no honest "
                    "counterfactual exists for it; an observed-only view is what "
                    "is offered instead"
                ),
                details={
                    "date": target_date.isoformat(),
                    "first_test_start": rules.first_test_start.isoformat(),
                    "observed_only": True,
                },
            )
        )
    if evidence.origin_kind is None or evidence.artifact_id is None:
        return refused(
            ReplayRefused(
                code="REPLAY_FORECAST_UNAVAILABLE",
                status=404,
                message=(
                    f"no held-out forecast rows exist for {subsystem} on "
                    f"{target_date.isoformat()} in lane {lane}"
                ),
                details={
                    "date": target_date.isoformat(),
                    "subsystem": subsystem,
                    "lane": lane,
                    "candidate_lanes": list(evidence.candidate_lanes),
                },
            )
        )
    provenance = PROVENANCE_BY_ORIGIN_KIND.get(evidence.origin_kind)
    if provenance is None:
        # A row wearing an origin kind neither vocabulary knows. Refused rather
        # than rendered: the two kinds are what keep a reconstruction and a
        # record apart, and a third would be a claim nobody has defined.
        return refused(
            ReplayRefused(
                code="REPLAY_FORECAST_UNAVAILABLE",
                status=404,
                message=(
                    f"{subsystem} {target_date.isoformat()} resolves a forecast "
                    f"row carrying origin_kind {evidence.origin_kind!r}, which is "
                    "neither a record nor a reconstruction"
                ),
                details={
                    "date": target_date.isoformat(),
                    "origin_kind": evidence.origin_kind,
                },
            )
        )
    if windows is None:
        # The row names an artifact whose card cannot be read. Not a refusal a
        # client can act on, and not a day to render: the held-out property
        # cannot be *asserted*, and `replay.md`'s posture is that an unassertable
        # claim is a bug rather than a caveat.
        raise HoldoutLeakError(
            f"{subsystem} {target_date.isoformat()}: forecast rows name artifact "
            f"{evidence.artifact_id}, whose card is not readable, so the held-out "
            "property cannot be asserted against the windows it recorded. A "
            "replay whose integrity is merely likely is not offered"
        )

    assert_held_out(target_date, windows, subsystem=subsystem)

    if evidence.observed_hours < HOURS_PER_DAY:
        return refused(
            ReplayRefused(
                code="REPLAY_OBSERVATION_INCOMPLETE",
                status=404,
                message=(
                    f"{subsystem} {target_date.isoformat()} has "
                    f"{evidence.observed_hours} settled hour(s) of {HOURS_PER_DAY}; "
                    "the denominator of every figure on this screen is the whole "
                    "local day"
                ),
                details={
                    "date": target_date.isoformat(),
                    "subsystem": subsystem,
                    "observed_hours": evidence.observed_hours,
                    "hours_required": HOURS_PER_DAY,
                },
            )
        )

    return ReplayDay(
        target_date=target_date,
        provenance=provenance,
        vintage_fidelity=fidelity,
        held_out_by=HeldOutBy(
            fold=windows.fold_id,
            artifact_id=windows.artifact_id,
            train_window=(windows.train_start, windows.train_end),
            calibration_window=(windows.calibration_start, windows.calibration_end),
        ),
        refusal=None,
        candidate_lanes=evidence.candidate_lanes,
    )


@dataclass(frozen=True)
class ReplayCalendar:
    """Every day of the window, with a verdict on each. The endpoint's body.

    A *complete* enumeration and not a list of the replayable ones. The refused
    days are the deliverable as much as the replayable ones are: `replay.md`
    story 14 asks that an unreplayable date explain itself, and a calendar that
    omitted them would make the boundary something a client discovers by asking
    for a day and being told no.
    """

    subsystem: str
    lane: str
    window_start: date
    window_end: date
    #: Where the replayable range opens — the first walk-forward test fold's
    #: start, read off the fold calendar's rules and never restated here.
    holdout_window_opens: date
    days: tuple[ReplayDay, ...]

    @property
    def replayable_days(self) -> tuple[ReplayDay, ...]:
        return tuple(day for day in self.days if day.replayable)

    def as_payload(self) -> dict[str, object]:
        replayable = self.replayable_days
        return {
            "subsystem": self.subsystem,
            "lane": self.lane,
            "window": {
                "start": self.window_start.isoformat(),
                "end": self.window_end.isoformat(),
            },
            "holdout_window_opens": self.holdout_window_opens.isoformat(),
            "vintage_affects": list(VINTAGE_AFFECTS),
            "vintage_exempt": list(VINTAGE_EXEMPT),
            "counts": {
                "days": len(self.days),
                "replayable": len(replayable),
                "refused": refusal_counts(self.days),
            },
            "days": [day.as_payload() for day in self.days],
        }


def build_calendar(
    evidence: Mapping[date, DayEvidence],
    *,
    subsystem: str,
    lane: str,
    rules: FoldCalendarRules,
    window_start: date,
    window_end: date,
    latest: date,
    windows_for: Callable[[str], ArtifactWindows | None],
    sources: Sequence[VintageSource] = (),
) -> ReplayCalendar:
    """The whole window, day by day, with one verdict each.

    ``windows_for`` resolves an ``artifact_id`` to the card's recorded windows —
    :func:`wattsteer_ml.replay.cards.read_windows` bound to a volume in
    production, a dictionary in a test. It takes an **artifact id**, and that is
    the signature that makes `replay.md` story 5 structural rather than
    intended: there is no lane argument, no "current" fallback and nothing this
    function could pass that means "whatever is promoted".

    Any day that leaks raises out of here whole, taking the calendar with it.
    A leak is `replay.md`'s "`500`, not a badge", and a badge in a list is what
    a leaking day would become if this returned it as one refused entry.
    """
    days: list[ReplayDay] = []
    step = window_start
    while step <= window_end:
        day = evidence.get(step, DayEvidence(target_date=step))
        artifact_id = day.artifact_id
        days.append(
            resolve_day(
                day,
                subsystem=subsystem,
                lane=lane,
                rules=rules,
                latest=latest,
                windows=None if artifact_id is None else windows_for(artifact_id),
                sources=sources,
            )
        )
        step += _ONE_DAY
    return ReplayCalendar(
        subsystem=subsystem,
        lane=lane,
        window_start=window_start,
        window_end=window_end,
        holdout_window_opens=rules.first_test_start,
        days=tuple(days),
    )


def refusal_counts(days: Sequence[ReplayDay]) -> dict[str, int]:
    """How many days each refusal code accounts for, ascending by code.

    On the calendar rather than left to a client, because "a third of the window
    is refused as pre-F1" is the sentence `replay.md` wants a reader to be able
    to check, and a client that counted it would be a second implementation of
    the predicate's arithmetic.
    """
    counts: dict[str, int] = {}
    for day in days:
        if day.refusal is not None:
            counts[day.refusal.code] = counts.get(day.refusal.code, 0) + 1
    return dict(sorted(counts.items()))
