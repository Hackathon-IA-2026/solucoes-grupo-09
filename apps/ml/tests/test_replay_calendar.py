"""Which days are replayable, and why the others are refused.

Replay ticket 02. The assertions divide into five, and none of them is about a
recovered-energy number — the scoring half is a later ticket and nothing here
computes a figure:

**Every clause refuses in its own words.** Four failing clauses, four codes, four
statuses, and a date that fails two is refused by the first one in the spec's
order — so "before the data window" and "before the first test fold" stay two
different sentences instead of collapsing into one.

**The held-out property, as a property.** Over every replayable date the
calendar produces, the resolved artifact's train window *and* its calibration
window exclude the date. Asserted over the whole calendar rather than on a
chosen day, because the interesting failure is the one day nobody picked.

**A fabricated card is a 500, not a badge.** A card whose windows overlap the
replayed date raises rather than appearing in the calendar as one refused day,
and the whole calendar goes with it.

**The negative that matters most.** The replay path never resolves the promoted
serving artifact for a historical date. Asserted twice: by reading the source of
the package — nothing under `wattsteer_ml.replay` names `current` or
`load_promoted` — and by extending the *serving* artifact's training window over
a day already replayed and getting the same answer.

**No go-live date is named.** The fidelity boundary comes from
`canonical_read_go_live` through a `VintageSource`, so `2026-07-01` appears
nowhere in the package and a `fold_holdout` day whose go-live precedes it is
stamped `point_in_time`.
"""

from __future__ import annotations

import inspect
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wattsteer_ml import replay as replay_package
from wattsteer_ml.app import app
from wattsteer_ml.canonical import VintageSource
from wattsteer_ml.evaluation import FOLD_CALENDAR_RULES
from wattsteer_ml.evaluation.holdout import HoldoutLeakError
from wattsteer_ml.lanes import Lane
from wattsteer_ml.publication import (
    BACKFILLED_HOLDOUT_ORIGIN_KIND,
    SERVED_ORIGIN_KIND,
)
from wattsteer_ml.replay import calendar as calendar_module
from wattsteer_ml.replay import cards as cards_module
from wattsteer_ml.replay import reads as reads_module
from wattsteer_ml.replay.calendar import (
    HOURS_PER_DAY,
    DayEvidence,
    ReplayDay,
    build_calendar,
    day_fidelity,
    latest_replayable_date,
    resolve_day,
)
from wattsteer_ml.replay.cards import (
    ArtifactWindows,
    CardWindowError,
    read_windows,
    windows_from_card,
)

LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
OTHER_LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_early", threshold_mw=5)
RULES = FOLD_CALENDAR_RULES
#: A day inside F3's test period, which the F3 artifact held out.
HELD_OUT_DAY = date(2025, 11, 12)
LATEST = date(2026, 9, 3)

#: The F3 artifact, as its card records itself.
F3 = ArtifactWindows(
    artifact_id="2025-10-01T03:10:00Z",
    fold_id="F3",
    lane=LANE.directory_name,
    train_start=date(2024, 4, 1),
    train_end=date(2025, 9, 30),
    calibration_start=date(2025, 7, 3),
    calibration_end=date(2025, 9, 30),
)

#: The artifact on serving duty today. It has seen `HELD_OUT_DAY`, which is the
#: whole point: a replay that resolved it would be an in-sample fit.
PROMOTED = ArtifactWindows(
    artifact_id="2026-09-01T03:10:00Z",
    fold_id="F6",
    lane=LANE.directory_name,
    train_start=date(2024, 4, 1),
    train_end=date(2026, 6, 30),
    calibration_start=date(2026, 4, 2),
    calibration_end=date(2026, 6, 30),
)

#: Ingestion go-live, as a *read's* go-live and never as a constant of the
#: domain. Set to F6's start here only because that is the arrangement
#: `replay.md`'s table assumes; every test that cares varies it.
GO_LIVE = datetime(2026, 7, 1, 0, 0, tzinfo=UTC)


def sources(go_live_at: datetime | None = GO_LIVE) -> tuple[VintageSource, ...]:
    return (
        VintageSource(
            read="curtailment-by-reporting-entity",
            vintage_fidelity="revision_optimistic",
            go_live_at=go_live_at,
        ),
    )


def evidence(
    target_date: date,
    *,
    origin_kind: str | None = BACKFILLED_HOLDOUT_ORIGIN_KIND,
    artifact_id: str | None = F3.artifact_id,
    observed_hours: int = HOURS_PER_DAY,
    candidate_lanes: tuple[str, ...] = (LANE.directory_name,),
) -> DayEvidence:
    return DayEvidence(
        target_date=target_date,
        origin_kind=origin_kind,
        artifact_id=artifact_id,
        observed_hours=observed_hours,
        candidate_lanes=candidate_lanes,
    )


def judge(
    day: DayEvidence,
    *,
    windows: ArtifactWindows | None = F3,
    go_live_at: datetime | None = GO_LIVE,
) -> ReplayDay:
    return resolve_day(
        day,
        subsystem="NE",
        lane=LANE.directory_name,
        rules=RULES,
        latest=LATEST,
        windows=windows,
        sources=sources(go_live_at),
    )


# --- one refusal per failing clause -------------------------------------------


def test_a_held_out_day_with_a_settled_day_behind_it_is_replayable() -> None:
    day = judge(evidence(HELD_OUT_DAY))
    assert day.replayable
    assert day.provenance == "fold_holdout"
    assert day.held_out_by is not None
    assert day.held_out_by.fold == "F3"
    assert day.held_out_by.artifact_id == F3.artifact_id
    # Both windows travel, named. Story 3: the claim is checkable rather than
    # asserted, and it cannot be checked from a training cut alone.
    assert day.held_out_by.train_window == (F3.train_start, F3.train_end)
    assert day.held_out_by.calibration_window == (
        F3.calibration_start,
        F3.calibration_end,
    )
    assert day.as_payload()["model_saw_this_day"] is False


def test_a_date_before_the_data_window_is_out_of_range() -> None:
    day = judge(evidence(RULES.window_start - timedelta(days=1)))
    assert day.refusal is not None
    assert day.refusal.code == "REPLAY_DATE_OUT_OF_RANGE"
    assert day.refusal.status == 422


def test_today_and_after_are_out_of_range() -> None:
    """`d ≤ yesterday`. Today's hours have not happened, let alone settled."""
    day = judge(evidence(LATEST + timedelta(days=1)))
    assert day.refusal is not None
    assert day.refusal.code == "REPLAY_DATE_OUT_OF_RANGE"


def test_the_pre_f1_year_is_refused_and_not_labelled() -> None:
    """The decision the ticket exists for: refused, never a number with a badge.

    A day inside every artifact's training block gets no forecast, no plan and
    no recovery figure — and the refusal says `observed_only`, which is the one
    thing that *is* offered for it.
    """
    day = judge(evidence(RULES.first_test_start - timedelta(days=1)))
    assert day.refusal is not None
    assert day.refusal.code == "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW"
    assert day.refusal.status == 422
    assert day.refusal.details["observed_only"] is True
    assert day.held_out_by is None
    assert day.provenance is None


def test_the_two_range_refusals_do_not_collapse_into_one() -> None:
    """Outside the data and inside-but-not-offered are different sentences."""
    outside = judge(evidence(RULES.window_start - timedelta(days=1)))
    inside = judge(evidence(RULES.first_test_start - timedelta(days=1)))
    assert outside.refusal is not None and inside.refusal is not None
    assert outside.refusal.code != inside.refusal.code


def test_no_forecast_row_is_a_404_naming_the_lane() -> None:
    day = judge(evidence(HELD_OUT_DAY, origin_kind=None, artifact_id=None))
    assert day.refusal is not None
    assert day.refusal.code == "REPLAY_FORECAST_UNAVAILABLE"
    assert day.refusal.status == 404
    assert day.refusal.details["lane"] == LANE.directory_name


def test_fewer_than_twenty_four_settled_hours_is_a_404() -> None:
    day = judge(evidence(HELD_OUT_DAY, observed_hours=23))
    assert day.refusal is not None
    assert day.refusal.code == "REPLAY_OBSERVATION_INCOMPLETE"
    assert day.refusal.status == 404
    assert day.refusal.details["observed_hours"] == 23


def test_every_refusal_is_a_code_and_never_a_bare_sentence() -> None:
    """Story 40, as a shape: a refusal without a code is not constructible."""
    for failing in (
        evidence(RULES.window_start - timedelta(days=1)),
        evidence(RULES.first_test_start - timedelta(days=1)),
        evidence(HELD_OUT_DAY, origin_kind=None, artifact_id=None),
        evidence(HELD_OUT_DAY, observed_hours=0),
    ):
        refusal = judge(failing).refusal
        assert refusal is not None
        assert refusal.code.startswith("REPLAY_")
        assert refusal.as_payload()["code"] == refusal.code


def test_a_day_cannot_be_both_replayable_and_refused() -> None:
    with pytest.raises(ValueError, match="replayable or refused"):
        ReplayDay(
            target_date=HELD_OUT_DAY,
            provenance="served",
            vintage_fidelity="point_in_time",
            held_out_by=None,
            refusal=None,
        )


# --- the held-out assertion, against the card ---------------------------------


def test_a_day_inside_the_training_window_raises_rather_than_refusing() -> None:
    leaked = ArtifactWindows(
        artifact_id="fabricated",
        fold_id="F3",
        lane=LANE.directory_name,
        train_start=date(2024, 4, 1),
        train_end=date(2025, 12, 31),
        calibration_start=date(2025, 10, 3),
        calibration_end=date(2025, 12, 31),
    )
    with pytest.raises(HoldoutLeakError, match="training window"):
        judge(evidence(HELD_OUT_DAY), windows=leaked)


def test_a_day_inside_the_calibration_window_raises_too() -> None:
    """The subtler leak, and the one a future session forgets.

    The training window is moved off the day so that only the calibration
    window can catch it — otherwise this test would pass on the first assert
    and prove nothing about the second.
    """
    leaked = ArtifactWindows(
        artifact_id="fabricated",
        fold_id="F3",
        lane=LANE.directory_name,
        train_start=date(2024, 4, 1),
        train_end=date(2025, 6, 30),
        calibration_start=HELD_OUT_DAY - timedelta(days=3),
        calibration_end=HELD_OUT_DAY + timedelta(days=3),
    )
    with pytest.raises(HoldoutLeakError, match="conformal scalars"):
        judge(evidence(HELD_OUT_DAY), windows=leaked)


def test_a_leak_is_checked_before_the_observed_hours_are_counted() -> None:
    """A leaking artifact cannot hide behind a day ONS has not settled."""
    leaked = ArtifactWindows(
        artifact_id="fabricated",
        fold_id="F3",
        lane=LANE.directory_name,
        train_start=date(2024, 4, 1),
        train_end=date(2025, 12, 31),
        calibration_start=date(2025, 10, 3),
        calibration_end=date(2025, 12, 31),
    )
    with pytest.raises(HoldoutLeakError):
        judge(evidence(HELD_OUT_DAY, observed_hours=0), windows=leaked)


def test_an_unreadable_card_is_a_leak_and_not_a_pass() -> None:
    """The assertion cannot run, so the day is not offered.

    `replay.md`'s posture is that integrity is a precondition. A row whose card
    is missing is a claim WattSteer cannot check, and an unchecked claim is not
    a checked one.
    """
    with pytest.raises(HoldoutLeakError, match="not readable"):
        judge(evidence(HELD_OUT_DAY), windows=None)


def test_a_leak_answers_500_and_names_the_artifact() -> None:
    """The route's half of "a `500`, not a badge", tested where it is decided.

    The status and the code belong to the condition, so they are a value in the
    same module as the other four rather than two literals in a handler — and
    the message carries the artifact id, which is what the acceptance list means
    by "logged with the artifact id".
    """
    leaked = ArtifactWindows(
        artifact_id="fabricated-2025-10-01T03:10:00Z",
        fold_id="F3",
        lane=LANE.directory_name,
        train_start=date(2024, 4, 1),
        train_end=date(2025, 12, 31),
        calibration_start=date(2025, 10, 3),
        calibration_end=date(2025, 12, 31),
    )
    with pytest.raises(HoldoutLeakError) as raised:
        judge(evidence(HELD_OUT_DAY), windows=leaked)
    violation = calendar_module.integrity_violation(
        raised.value, subsystem="NE", lane=LANE.directory_name
    )
    assert violation.code == "REPLAY_INTEGRITY_VIOLATION"
    assert violation.status == 500
    assert leaked.artifact_id in violation.message
    assert violation.details["lane"] == LANE.directory_name


def test_a_violation_is_never_one_entry_of_a_calendar() -> None:
    """`integrity_violation` is built by the route and never by the predicate."""
    source = inspect.getsource(calendar_module.resolve_day)
    assert "integrity_violation" not in source


def test_one_leaking_day_takes_the_whole_calendar_with_it() -> None:
    """A `500`, not a badge — including "not a badge in a list of 900 days"."""
    with pytest.raises(HoldoutLeakError):
        build_calendar(
            {HELD_OUT_DAY: evidence(HELD_OUT_DAY)},
            subsystem="NE",
            lane=LANE.directory_name,
            rules=RULES,
            window_start=HELD_OUT_DAY,
            window_end=HELD_OUT_DAY,
            latest=LATEST,
            windows_for=lambda _: PROMOTED,
            sources=sources(),
        )


# --- the property, over the whole calendar ------------------------------------


def fold_windows(index: int) -> ArtifactWindows:
    """The card one fold's artifact would write, derived from the calendar.

    Derived rather than transcribed: forecaster 03's `FoldCalendar` re-derives
    its folds from its rules and refuses any tuple that is not its own
    derivation, so a fixture that hard-coded these dates would be a second
    calendar that could drift from the first while both looked right.
    """
    fold = RULES.frozen_fold(index)
    blocks = fold.blocks_for(RULES.window_start)
    return ArtifactWindows(
        artifact_id=fold.id,
        fold_id=fold.id,
        lane=LANE.directory_name,
        train_start=blocks.train_start,
        train_end=blocks.train_end,
        calibration_start=blocks.calibration_start,
        calibration_end=blocks.calibration_end,
    )


BY_FOLD = {index: fold_windows(index) for index in (1, 2, 3)}


def whole_calendar() -> calendar_module.ReplayCalendar:
    """Every day from the data window's start to the end of F3.

    Wide enough to contain all four refusals and to hold three different
    artifacts, so the property below is checked against a *changing* pair of
    windows rather than one fixed pair that happens to exclude everything.
    """
    start = RULES.window_start
    end = RULES.frozen_fold(3).quarter_end
    days: dict[date, DayEvidence] = {}
    for index, windows in BY_FOLD.items():
        fold = RULES.frozen_fold(index)
        step = fold.test_start
        while step <= fold.quarter_end:
            days[step] = evidence(
                step,
                artifact_id=windows.artifact_id,
                # Every third day short an hour, so the settled-hours clause is
                # exercised across the window and not only on a chosen date.
                observed_hours=HOURS_PER_DAY if step.day % 3 else 5,
            )
            step += timedelta(days=1)
    return build_calendar(
        days,
        subsystem="NE",
        lane=LANE.directory_name,
        rules=RULES,
        window_start=start,
        window_end=end,
        latest=LATEST,
        windows_for=lambda artifact_id: BY_FOLD[int(artifact_id[1:])],
        sources=sources(),
    )


def test_every_replayable_date_is_excluded_by_both_of_its_windows() -> None:
    """The property `replay.md`'s seam 1 asks for, over the whole calendar."""
    calendar = whole_calendar()
    replayable = calendar.replayable_days
    assert replayable, "the fixture produced no replayable day to check"
    for day in replayable:
        held = day.held_out_by
        assert held is not None
        train_start, train_end = held.train_window
        calibration_start, calibration_end = held.calibration_window
        assert not train_start <= day.target_date <= train_end
        assert not calibration_start <= day.target_date <= calibration_end


def test_the_calendar_enumerates_the_window_and_names_every_refusal() -> None:
    calendar = whole_calendar()
    assert len(calendar.days) == (calendar.window_end - calendar.window_start).days + 1
    counts = calendar.as_payload()["counts"]
    assert isinstance(counts, dict)
    refused = counts["refused"]
    assert isinstance(refused, dict)
    assert refused["REPLAY_DATE_BEFORE_HOLDOUT_WINDOW"] > 0
    assert refused["REPLAY_OBSERVATION_INCOMPLETE"] > 0
    assert counts["replayable"] > 0
    assert calendar.holdout_window_opens == RULES.first_test_start


def test_the_pre_f1_block_is_a_third_of_the_window_and_is_all_refused() -> None:
    calendar = whole_calendar()
    pre = [day for day in calendar.days if day.target_date < RULES.first_test_start]
    assert pre
    assert all(
        day.refusal is not None
        and day.refusal.code == "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW"
        for day in pre
    )


# --- the negative that matters most -------------------------------------------


def test_no_module_in_the_replay_package_consults_the_promoted_artifact() -> None:
    """Story 5, asserted by reading the source rather than by a fixture.

    "We did not call it" is a property of the file. A test that only checked a
    return value would pass on the day someone adds a fallback to the promoted
    artifact for the days that resolve to nothing.
    """
    for module in (calendar_module, cards_module, reads_module, replay_package):
        source = inspect.getsource(module)
        body = "\n".join(
            line for line in source.splitlines() if not line.strip().startswith("#")
        )
        assert "load_promoted" not in body.replace("``load_promoted``", "")
        assert "artifacts.current" not in body.replace(
            ":func:`wattsteer_ml.artifacts.current`", ""
        )


def test_a_retrain_that_extends_the_serving_window_changes_no_replay() -> None:
    """The exact regression the spec exists to prevent.

    The promoted artifact is retrained so that its training window now covers a
    day already replayed. The replay resolves the artifact **the row names**, so
    the answer is unchanged — and the calendar built with the promoted card
    instead would have raised, which is what the second half asserts.
    """
    before = judge(evidence(HELD_OUT_DAY))
    retrained = ArtifactWindows(
        artifact_id=PROMOTED.artifact_id,
        fold_id="F6",
        lane=LANE.directory_name,
        train_start=PROMOTED.train_start,
        train_end=date(2026, 9, 1),
        calibration_start=date(2026, 6, 4),
        calibration_end=date(2026, 9, 1),
    )
    after = resolve_day(
        evidence(HELD_OUT_DAY),
        subsystem="NE",
        lane=LANE.directory_name,
        rules=RULES,
        latest=LATEST,
        # Still resolved from the row's own `run_label`; the retrain moved a
        # different artifact.
        windows=F3,
        sources=sources(),
    )
    assert after.as_payload() == before.as_payload()
    with pytest.raises(HoldoutLeakError):
        judge(evidence(HELD_OUT_DAY), windows=retrained)


# --- the two open decisions, as they look from inside the code ----------------


def test_a_day_with_two_candidate_lanes_reports_both_and_picks_neither() -> None:
    """Open decision 1, made visible rather than settled.

    Nothing in the calendar chooses between a `gate_early` and a `gate_late`
    forecast of the same day. The lane is an argument, and the day says which
    other lanes could have answered.
    """
    both = (LANE.directory_name, OTHER_LANE.directory_name)
    day = judge(evidence(HELD_OUT_DAY, candidate_lanes=both))
    assert day.candidate_lanes == both
    assert day.as_payload()["candidate_lanes"] == list(both)


def test_the_lane_has_no_default_anywhere_in_the_predicate() -> None:
    """A default would answer the open question inside a keyword argument."""
    for function in (resolve_day, build_calendar):
        parameter = inspect.signature(function).parameters["lane"]
        assert parameter.default is inspect.Parameter.empty


def test_the_replay_package_writes_down_no_date_at_all() -> None:
    """Open decision 2, as a shape rather than as a promise.

    `T_go` is a read's fact and not a modelling constant, so there is no
    go-live in this package — and, more strongly, no date literal of any kind:
    every boundary is either the fold calendar's rules or
    `canonical_read_go_live`. Asserted over the AST so that the prose above,
    which does mention 2026-07-01 in order to explain why it is not used, does
    not make the test pass or fail.
    """
    import ast

    for module in (calendar_module, cards_module, reads_module):
        tree = ast.parse(inspect.getsource(module))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                try:
                    parsed = date.fromisoformat(node.value)
                except ValueError:
                    continue
                raise AssertionError(
                    f"{module.__name__} writes down the date {parsed.isoformat()}"
                )
            if isinstance(node, ast.Constant) and isinstance(node.value, int):
                assert node.value not in range(1970, 2100), (
                    f"{module.__name__} writes down what looks like a year"
                )


def test_fidelity_follows_the_reads_go_live_and_not_the_fold_calendar() -> None:
    """A `fold_holdout` day *can* be point-in-time, and the calendar says so.

    `replay.md`'s three-way table pairs `fold_holdout` with
    `revision_optimistic` throughout, on the assumption that go-live coincides
    with F6's start. `forecaster.md` treats the two as independent. This test
    holds the second reading: move go-live back and an F3 day becomes
    point-in-time without anything else changing.
    """
    assert day_fidelity(HELD_OUT_DAY, sources()) == "revision_optimistic"
    early = datetime(2025, 1, 1, tzinfo=UTC)
    assert day_fidelity(HELD_OUT_DAY, sources(early)) == "point_in_time"
    provenance = judge(evidence(HELD_OUT_DAY), go_live_at=early)
    assert provenance.provenance == "fold_holdout"
    assert provenance.vintage_fidelity == "point_in_time"


def test_a_source_that_ingested_nothing_is_revision_optimistic() -> None:
    """An empty table cannot have been watching, so it is never a free pass."""
    assert day_fidelity(HELD_OUT_DAY, sources(None)) == "revision_optimistic"
    assert day_fidelity(HELD_OUT_DAY, ()) == "revision_optimistic"


def test_fidelity_is_stamped_on_refused_days_too() -> None:
    """Two axes, kept apart: "cannot replay" and "would be a restatement"."""
    day = judge(evidence(RULES.first_test_start - timedelta(days=1)))
    assert day.refusal is not None
    assert day.vintage_fidelity == "revision_optimistic"


# --- the card, read off the volume --------------------------------------------


def card(train: tuple[date, date], calibration: tuple[date, date]) -> dict[str, object]:
    return {
        "lane": {"directory": LANE.directory_name},
        "fold": {"fold_id": "F3"},
        "data": {
            "training_window": {
                "start": train[0].isoformat(),
                "end": train[1].isoformat(),
            },
            "calibration_window": {
                "start": calibration[0].isoformat(),
                "end": calibration[1].isoformat(),
            },
        },
    }


def test_the_windows_come_off_the_card_the_bundle_wrote() -> None:
    windows = windows_from_card(
        card((F3.train_start, F3.train_end), (F3.calibration_start, F3.calibration_end)),
        artifact_id=F3.artifact_id,
    )
    assert windows == F3


def test_a_card_without_a_calibration_window_is_refused() -> None:
    incomplete = card(
        (F3.train_start, F3.train_end), (F3.calibration_start, F3.calibration_end)
    )
    data = incomplete["data"]
    assert isinstance(data, dict)
    del data["calibration_window"]
    with pytest.raises(CardWindowError, match="calibration_window"):
        windows_from_card(incomplete, artifact_id=F3.artifact_id)


def test_a_missing_card_reads_as_absent_and_never_as_permissive(
    tmp_path: Path,
) -> None:
    assert read_windows(tmp_path, LANE, F3.artifact_id) is None


def test_a_card_on_the_volume_round_trips(tmp_path: Path) -> None:
    import json

    directory = tmp_path / LANE.directory_name
    directory.mkdir(parents=True)
    (directory / f"{F3.artifact_id}.card.json").write_text(
        json.dumps(
            card(
                (F3.train_start, F3.train_end),
                (F3.calibration_start, F3.calibration_end),
            )
        ),
        encoding="utf-8",
    )
    assert read_windows(tmp_path, LANE, F3.artifact_id) == F3


# --- the two vocabularies, and the clock --------------------------------------


def test_origin_kind_maps_to_provenance_in_exactly_one_place() -> None:
    assert calendar_module.PROVENANCE_BY_ORIGIN_KIND == {
        SERVED_ORIGIN_KIND: "served",
        BACKFILLED_HOLDOUT_ORIGIN_KIND: "fold_holdout",
    }
    served = judge(evidence(HELD_OUT_DAY, origin_kind=SERVED_ORIGIN_KIND))
    assert served.provenance == "served"


def test_an_unknown_origin_kind_is_refused_rather_than_rendered() -> None:
    day = judge(evidence(HELD_OUT_DAY, origin_kind="guessed"))
    assert day.refusal is not None
    assert day.refusal.code == "REPLAY_FORECAST_UNAVAILABLE"


def test_the_latest_replayable_day_is_yesterday_on_the_grid_clock() -> None:
    """23:00 UTC is already the next civil day in Brasília, and vice versa."""
    assert latest_replayable_date(datetime(2026, 9, 4, 12, tzinfo=UTC)) == date(
        2026, 9, 3
    )
    assert latest_replayable_date(datetime(2026, 9, 4, 2, tzinfo=UTC)) == date(2026, 9, 2)


# --- the endpoint, without a database -----------------------------------------

client = TestClient(app)


def test_the_calendar_route_refuses_a_lane_name_that_is_not_one() -> None:
    response = client.get(
        "/v1/replay/days", params={"subsystem": "NE", "lane": "thr5__gate_late"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REQUEST_INVALID"


def test_the_calendar_route_says_so_when_there_is_no_database() -> None:
    """An absence reported as an absence, never as an empty calendar."""
    response = client.get(
        "/v1/replay/days",
        params={"subsystem": "NE", "lane": LANE.directory_name},
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "DATA_UNAVAILABLE"


def test_the_single_day_route_takes_the_same_lane_and_refuses_the_same_way() -> None:
    response = client.get(
        f"/v1/replay/days/{HELD_OUT_DAY.isoformat()}",
        params={"subsystem": "NE", "lane": "not-a-lane"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REQUEST_INVALID"


def test_the_calendar_route_requires_a_lane() -> None:
    """No default, on the wire as well as in the signature."""
    response = client.get("/v1/replay/days", params={"subsystem": "NE"})
    assert response.status_code == 422
