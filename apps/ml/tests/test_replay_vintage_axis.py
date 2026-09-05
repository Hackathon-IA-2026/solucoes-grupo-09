"""Vintage is a second honesty axis, and it gets measured.

Replay ticket 05. Two claims, and the file is in two halves.

**The axes are separate.** In-sample-ness is about the *model's* information set
and is settled before a number exists; vintage is about the *data's* and can
never be settled at all. Today they coincide — every `fold_holdout` day is
`revision_optimistic` — which is exactly why a merged badge is refused: it would
be observationally correct now and wrong the moment a post-go-live quarter is
held out. So the assertions here are that the *other* combination is reachable,
that neither field is computed from the other, and that the caveat names which
parts of the replay it touches rather than shrugging at the screen.

**The caveat is measured, in MWh.** `docs/specs/replay.md`:

```
revision_premium_recovered_mwh
  = mean over post-go-live days d of
      recovered(plan_d, a_d @ AsOf(published_at_d + 48h))
    − recovered(plan_d, a_d @ AsOf(now))
```

The second half exercises that against a fixture holding two vintages of the
same day, so the computation works on the day real data allows it rather than
being a formula in a docstring. The distinction it exists to protect is
`null` ≠ `0.0`: an absent measurement and a measured zero are different claims,
and only the second one is a claim.
"""

from __future__ import annotations

import inspect
import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from wattsteer_ml.canonical import VintageSource
from wattsteer_ml.evaluation import FOLD_CALENDAR_RULES
from wattsteer_ml.lanes import Lane
from wattsteer_ml.optimizer import PlanningProfile, build_plan, simulate
from wattsteer_ml.publication import (
    BACKFILLED_HOLDOUT_ORIGIN_KIND,
    SERVED_ORIGIN_KIND,
)
from wattsteer_ml.replay import calendar as calendar_module
from wattsteer_ml.replay import premium as premium_module
from wattsteer_ml.replay.calendar import (
    HOURS_PER_DAY,
    VINTAGE_AFFECTS,
    VINTAGE_EXEMPT,
    VINTAGE_READS,
    DayEvidence,
    ReplayDay,
    build_calendar,
    day_fidelity,
    resolve_day,
)
from wattsteer_ml.replay.cards import ArtifactWindows
from wattsteer_ml.replay.premium import (
    SETTLEMENT_LAG_HOURS,
    DayVintages,
    RevisionPremium,
    published_premium,
    revision_premium,
)
from wattsteer_ml.replay.result import _integrity
from wattsteer_ml.replay.scoring import ObservedDay, ReplayPostureError

REPO = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO / "packages" / "core" / "schema"
BASE = "https://wattsteer.com/schema/"

SUBSYSTEM = "NE"
THRESHOLD_MW = 5.0
LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
RULES = FOLD_CALENDAR_RULES
#: A day inside F3's test period, which the F3 artifact held out.
HELD_OUT_DAY = date(2025, 11, 12)
LATEST = date(2026, 9, 3)
#: ``gate_at(HELD_OUT_DAY, gate_late)`` — the instant the pinned rows carry.
GATE = datetime(2025, 11, 11, 22, 0, tzinfo=UTC)
#: The two go-lives the tests move between. Neither is a constant of the
#: product: the boundary is whatever `canonical_read_go_live` reports for the
#: reads in `VINTAGE_READS`, and these exist only to sit either side of
#: `HELD_OUT_DAY` so that both fidelities are reachable for one provenance.
GO_LIVE_AFTER = datetime(2026, 7, 1, tzinfo=UTC)
GO_LIVE_BEFORE = datetime(2025, 1, 1, tzinfo=UTC)

F3 = ArtifactWindows(
    artifact_id="2025-10-01T03:10:00Z",
    fold_id="F3",
    lane=LANE.directory_name,
    train_start=date(2024, 4, 1),
    train_end=date(2025, 9, 30),
    calibration_start=date(2025, 7, 3),
    calibration_end=date(2025, 9, 30),
)


def sources(go_live_at: datetime | None) -> tuple[VintageSource, ...]:
    """One `VintageSource` per read a replayed day's actuals depend on."""
    return tuple(
        VintageSource(
            read=read,
            vintage_fidelity="point_in_time",
            go_live_at=go_live_at,
        )
        for read in VINTAGE_READS
    )


def judged(
    *,
    go_live_at: datetime | None,
    origin_kind: str = BACKFILLED_HOLDOUT_ORIGIN_KIND,
    target_date: date = HELD_OUT_DAY,
) -> ReplayDay:
    """A day from the calendar's own predicate, never hand-built."""
    return resolve_day(
        DayEvidence(
            target_date=target_date,
            origin_kind=origin_kind,
            artifact_id=F3.artifact_id,
            observed_hours=HOURS_PER_DAY,
            candidate_lanes=(LANE.directory_name,),
        ),
        subsystem=SUBSYSTEM,
        lane=LANE.directory_name,
        rules=RULES,
        latest=LATEST,
        windows=F3,
        sources=sources(go_live_at),
    )


# --- the two axes, kept apart -------------------------------------------------


def test_fidelity_is_stamped_from_go_live_and_provenance_from_the_row() -> None:
    """Two fields, two inputs. Move one and only one verdict moves.

    The `origin_kind` on the row decides `provenance`; the reads' go-live
    decides `vintage_fidelity`. Here the row is held fixed and the go-live moves,
    and then the go-live is held fixed and the row moves — so neither field can
    be a rename of the other.
    """
    optimistic = judged(go_live_at=GO_LIVE_AFTER)
    point_in_time = judged(go_live_at=GO_LIVE_BEFORE)
    assert optimistic.provenance == point_in_time.provenance == "fold_holdout"
    assert optimistic.vintage_fidelity == "revision_optimistic"
    assert point_in_time.vintage_fidelity == "point_in_time"

    served = judged(go_live_at=GO_LIVE_AFTER, origin_kind=SERVED_ORIGIN_KIND)
    assert served.provenance == "served"
    assert served.vintage_fidelity == optimistic.vintage_fidelity


def test_the_combination_that_is_empty_today_is_representable() -> None:
    """`fold_holdout` + `point_in_time` — the pair that populates when F7 opens.

    This is the whole argument for two fields rather than one badge. Today it
    has no rows, and a merged indicator would therefore be indistinguishable
    from the right answer; the day a post-go-live quarter is held out it becomes
    ordinary, and nothing here has to change for it to render correctly.
    """
    day = judged(go_live_at=GO_LIVE_BEFORE)
    assert (day.provenance, day.vintage_fidelity) == ("fold_holdout", "point_in_time")


def test_no_code_path_derives_one_axis_from_the_other() -> None:
    """Structural, not observational: neither function can see the other's input.

    :func:`day_fidelity` takes a date and the reads' go-lives, so there is no
    `origin_kind` in scope for it to consult; the provenance mapping is a
    `dict` keyed on `origin_kind` alone, whose values are the two provenances
    and nothing else. A derivation would have to widen one of those two
    signatures first, which is a change somebody has to argue for.
    """
    assert list(inspect.signature(day_fidelity).parameters) == ["target_date", "sources"]
    assert set(calendar_module.PROVENANCE_BY_ORIGIN_KIND.values()) == {
        "served",
        "fold_holdout",
    }
    for value in calendar_module.PROVENANCE_BY_ORIGIN_KIND.values():
        assert value not in {"point_in_time", "revision_optimistic"}


def test_a_refused_day_still_carries_its_vintage_verdict() -> None:
    """ "Cannot be replayed" and "would have been a restatement" are two facts."""
    day = resolve_day(
        DayEvidence(target_date=RULES.first_test_start - timedelta(days=1)),
        subsystem=SUBSYSTEM,
        lane=LANE.directory_name,
        rules=RULES,
        latest=LATEST,
        windows=None,
        sources=sources(GO_LIVE_AFTER),
    )
    assert day.refusal is not None
    assert day.provenance is None
    assert day.vintage_fidelity == "revision_optimistic"


# --- what the caveat touches, asserted rather than written on the screen -------


def test_the_caveat_names_exactly_what_it_touches_and_what_it_exempts() -> None:
    """`replay.md`, "What `revision_optimistic` actually touches".

    The label and the lagged-actual features are affected; the weather run,
    DESSEM and the ONS programming are cut on `published_at` and are genuinely
    point-in-time on both sides of go-live. A blanket "this day is unreliable"
    would be both vaguer and less true, so the lists are data on the contract
    rather than a sentence the client wrote.
    """
    assert VINTAGE_AFFECTS == ("settled_actuals", "lagged_actual_features")
    assert VINTAGE_EXEMPT == ("weather_run", "dessem", "ons_programming")
    assert not set(VINTAGE_AFFECTS) & set(VINTAGE_EXEMPT)


def test_a_pre_go_live_calendar_publishes_the_stamp_and_both_lists() -> None:
    """The acceptance box, end to end and over a window rather than a day."""
    calendar = build_calendar(
        {
            HELD_OUT_DAY: DayEvidence(
                target_date=HELD_OUT_DAY,
                origin_kind=BACKFILLED_HOLDOUT_ORIGIN_KIND,
                artifact_id=F3.artifact_id,
                observed_hours=HOURS_PER_DAY,
            )
        },
        subsystem=SUBSYSTEM,
        lane=LANE.directory_name,
        rules=RULES,
        window_start=HELD_OUT_DAY,
        window_end=HELD_OUT_DAY,
        latest=LATEST,
        windows_for=lambda _: F3,
        sources=sources(GO_LIVE_AFTER),
    )
    payload = calendar.as_payload()
    assert payload["vintage_affects"] == list(VINTAGE_AFFECTS)
    assert payload["vintage_exempt"] == list(VINTAGE_EXEMPT)
    days = payload["days"]
    assert isinstance(days, list)
    assert days[0]["vintage_fidelity"] == "revision_optimistic"
    assert days[0]["provenance"] == "fold_holdout"


# --- the measurement ----------------------------------------------------------


def scenario(*, max_power_mw: float = 40, energy_capacity_mwh: float = 200) -> Any:
    """One battery, deliberately power-limited so a restatement can move the number."""
    return {
        "v": 1,
        "subsystem": SUBSYSTEM,
        "target_date": HELD_OUT_DAY.isoformat(),
        "assets": [
            {
                "asset_type": "battery",
                "label": "Battery",
                "subsystem": SUBSYSTEM,
                "max_power_mw": max_power_mw,
                "energy_capacity_mwh": energy_capacity_mwh,
                "round_trip_efficiency": 0.99,
                "min_state_of_charge": 0,
                "max_state_of_charge": 1,
                "initial_state_of_charge": 0,
            }
        ],
        "economic_assumptions": {"brl_per_mwh": 180},
    }


def day_profile(values: tuple[float, ...]) -> tuple[float, ...]:
    """A 24-hour profile carrying ``values`` from hour 10, zero elsewhere."""
    hours = [0.0] * HOURS_PER_DAY
    for offset, value in enumerate(values):
        hours[10 + offset] = value
    return tuple(hours)


PLANNED = day_profile((40.0, 100.0, 60.0))
#: What ONS first settled, and what ONS says today. The restatement is a real
#: one, and it is deliberately below the hour's *scheduled* charge: a revision
#: that leaves every hour above what the plan was going to absorb moves the
#: baseline and not the recovery, which is a case the premium correctly reports
#: as zero and which would make a poor fixture for the case it does measure.
AS_INGESTED = day_profile((40.0, 100.0, 60.0))
LATEST_VINTAGE = day_profile((40.0, 20.0, 60.0))


def plan_for(profile: tuple[float, ...] = PLANNED) -> Any:
    """The plan WattSteer built at the gate, from the live builder."""
    return build_plan(
        scenario(),
        PlanningProfile(
            forecast_origin=GATE,
            vintage_fidelity="revision_optimistic",
            p10_mwh=tuple(value * 0.5 for value in profile),
            p50_mwh=profile,
            p90_mwh=tuple(value * 1.5 for value in profile),
            # Required since flex-optimizer 09 landed the second planning arm.
            # This fixture plans on P50 and never reads it; giving it the P50
            # would make the two arms indistinguishable here, so it carries the
            # mixture's own relation instead: `E[Y] > P50` where `p < 0.5`.
            expected_mwh=tuple(value * 1.1 for value in profile),
            threshold_mw=THRESHOLD_MW,
        ),
    )


def observed(hours: tuple[float, ...]) -> ObservedDay:
    return ObservedDay(subsystem=SUBSYSTEM, target_date=HELD_OUT_DAY, hours=hours)


def vintages(
    *,
    as_ingested: tuple[float, ...] = AS_INGESTED,
    latest: tuple[float, ...] = LATEST_VINTAGE,
    day: ReplayDay | None = None,
    as_ingested_at: datetime | None = None,
    latest_at: datetime | None = None,
) -> DayVintages:
    """One day, one plan, two vintages of its own actuals."""
    return DayVintages(
        day=day if day is not None else judged(go_live_at=GO_LIVE_BEFORE),
        plan=plan_for(),
        threshold_mw=THRESHOLD_MW,
        published_at=GATE,
        as_ingested=observed(as_ingested),
        latest=observed(latest),
        as_ingested_at=(
            GATE + timedelta(hours=SETTLEMENT_LAG_HOURS)
            if as_ingested_at is None
            else as_ingested_at
        ),
        latest_at=datetime(2026, 9, 4, 12, tzinfo=UTC)
        if latest_at is None
        else latest_at,
    )


def test_the_premium_is_one_plan_against_two_vintages_of_one_day() -> None:
    """The formula, computed — and checked against the simulator directly.

    The expectation is not a hand-written float: it is the same `simulate` the
    replay screen's headline came out of, run twice by the test. What is being
    asserted is that the premium is a difference in the *actuals* and in nothing
    else — same plan, same threshold, same function.
    """
    pair = vintages()
    plan = pair.plan
    first = simulate(plan, AS_INGESTED, threshold_mw=THRESHOLD_MW).recovered_mwh
    today = simulate(plan, LATEST_VINTAGE, threshold_mw=THRESHOLD_MW).recovered_mwh
    assert pair.premium_recovered_mwh == pytest.approx(first - today)
    # The restatement moved the number. If it had not, this fixture would be
    # measuring nothing and the test below about zero would be the same test.
    assert first != pytest.approx(today)
    assert pair.restated is True


def test_the_mean_is_over_the_days_and_the_population_travels_with_it() -> None:
    """ "0.4 MWh over two days" and "over ninety" are not the same claim."""
    quiet = vintages(as_ingested=LATEST_VINTAGE, latest=LATEST_VINTAGE)
    moved = vintages()
    # Two distinct days: the same day twice would weight one restatement double.
    second = DayVintages(
        day=judged(
            go_live_at=GO_LIVE_BEFORE, target_date=HELD_OUT_DAY + timedelta(days=1)
        ),
        plan=quiet.plan,
        threshold_mw=THRESHOLD_MW,
        published_at=quiet.published_at,
        as_ingested=ObservedDay(
            subsystem=SUBSYSTEM,
            target_date=HELD_OUT_DAY + timedelta(days=1),
            hours=LATEST_VINTAGE,
        ),
        latest=ObservedDay(
            subsystem=SUBSYSTEM,
            target_date=HELD_OUT_DAY + timedelta(days=1),
            hours=LATEST_VINTAGE,
        ),
        as_ingested_at=quiet.as_ingested_at,
        latest_at=quiet.latest_at,
    )
    premium = revision_premium([moved, second])
    assert premium is not None
    assert premium.recovered_mwh == pytest.approx(moved.premium_recovered_mwh / 2)
    assert premium.days_restated == 1
    payload = premium.as_payload()
    assert payload["days"] == 2
    assert payload["days_restated"] == 1
    assert len(payload["contributions"]) == 2  # type: ignore[arg-type]


def test_the_same_day_twice_is_refused() -> None:
    """A day weighted twice is a restatement counted twice."""
    with pytest.raises(ReplayPostureError, match="appears twice"):
        RevisionPremium(days=(vintages(), vintages()))


def test_a_premium_over_no_days_is_null_and_never_zero() -> None:
    """The distinction the nullable field exists for.

    `revision_premium` returns `None` for an empty set and `RevisionPremium`
    refuses to hold none, so there is no path from "nothing to average" to a
    `0.0` on the contract. The screen says **unmeasured** because the wire says
    `null`.
    """
    assert revision_premium([]) is None
    assert published_premium(None) is None
    with pytest.raises(ReplayPostureError, match="unmeasured"):
        RevisionPremium(days=())


def test_a_measured_zero_is_a_finding_and_is_published_as_a_number() -> None:
    """Both vintages held and identical: ONS did not restate. That is a claim."""
    premium = revision_premium([vintages(as_ingested=LATEST_VINTAGE)])
    assert premium is not None
    assert premium.recovered_mwh == pytest.approx(0.0)
    assert premium.days_restated == 0
    assert published_premium(premium) == pytest.approx(0.0)


def test_a_pre_go_live_day_cannot_have_a_premium() -> None:
    """The measurement is taken where it is honest and applied where it is needed.

    A `revision_optimistic` day predates ingestion, so WattSteer never held the
    actuals as first published and the second vintage would have to be invented.
    Refused by the type rather than filtered by a caller, so the population of
    the mean is stated rather than assumed.
    """
    with pytest.raises(ReplayPostureError, match="revision_optimistic"):
        vintages(day=judged(go_live_at=GO_LIVE_AFTER))


def test_the_two_reads_have_to_be_the_two_the_formula_names() -> None:
    """`published_at + 48 h`, and something strictly later than it."""
    with pytest.raises(ReplayPostureError, match="published_at plus"):
        vintages(as_ingested_at=GATE + timedelta(hours=SETTLEMENT_LAG_HOURS + 1))
    with pytest.raises(ReplayPostureError, match="no restatement between a read"):
        vintages(latest_at=GATE)


def test_the_premium_names_which_way_it_was_subtracted() -> None:
    """A signed difference with no stated order inverts the caveat when guessed."""
    premium = revision_premium([vintages()])
    assert premium is not None
    note = premium.as_payload()["note"]
    assert isinstance(note, str)
    assert "minus" in note
    assert note == premium_module.PREMIUM_NOTE


# --- the contract -------------------------------------------------------------


def registry() -> Registry[Any]:
    resources: Registry[Any] = Registry()
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        resources = resources.with_resource(
            BASE + path.name,
            Resource.from_contents(json.loads(path.read_text(encoding="utf-8"))),
        )
    return resources


def integrity_schema() -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / "replay.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(
        {
            "$id": BASE + "replay.schema.json",
            **schema["$defs"]["integrity"],
            "$defs": schema["$defs"],
        },
        registry=registry(),
    )


class _Scores:
    """The two fields `_integrity` reads, and nothing else it could reach.

    A stand-in rather than a real :class:`~wattsteer_ml.replay.scoring.
    ReplayScores` because what is under test is the *assembly* of the integrity
    block: which fields it publishes, and that the fidelity it publishes is the
    day's own rather than one derived from the provenance beside it. The full
    object is exercised end to end in ``test_replay_one_day.py``.
    """

    def __init__(self, day: ReplayDay) -> None:
        self.day = day


def integrity_of(day: ReplayDay, premium: RevisionPremium | None = None) -> Any:
    return _integrity(_Scores(day), premium)  # type: ignore[arg-type]


def test_the_integrity_block_carries_both_axes_and_validates() -> None:
    """`integrity.vintage_fidelity` beside `integrity.provenance`, on the wire."""
    for go_live, expected in (
        (GO_LIVE_AFTER, "revision_optimistic"),
        (GO_LIVE_BEFORE, "point_in_time"),
    ):
        day = judged(go_live_at=go_live)
        block = integrity_of(day)
        assert block["provenance"] == "fold_holdout"
        assert block["vintage_fidelity"] == expected == day.vintage_fidelity
        assert block["vintage_affects"] == list(VINTAGE_AFFECTS)
        assert block["vintage_exempt"] == list(VINTAGE_EXEMPT)
        assert block["revision_premium_recovered_mwh"] is None
        integrity_schema().validate(block)


def test_the_measured_premium_reaches_the_contract_as_a_number() -> None:
    """And the same block validates with a number where the `null` was."""
    block = integrity_of(judged(go_live_at=GO_LIVE_AFTER), revision_premium([vintages()]))
    assert block["revision_premium_recovered_mwh"] == pytest.approx(
        vintages().premium_recovered_mwh
    )
    integrity_schema().validate(block)
