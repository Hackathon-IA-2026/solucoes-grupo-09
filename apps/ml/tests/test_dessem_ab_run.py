"""The caller the DESSEM A/B was missing, and what it refuses to invent.

Forecaster ticket 18 built the comparison and left ``DessemScorer`` as a
parameter with no production caller, so the ``dessem_delta`` block's only
reachable state was "not run yet". :mod:`wattsteer_ml.dessem_ab_run` is that
caller. What is asserted here is not a restatement of its body but the four
properties that make it safe to run on a schedule and honest when it cannot run
at all:

- **the folds are the calendar's arithmetic**, so the sample grows when a
  quarter freezes and no fold id is written anywhere in the driver — which is
  the ticket's "re-runnable each quarter without a code change" box;
- **scoreable is not decision-grade**, and the driver applies only the first:
  a fold whose base fit is short of ``min_base_fit_days`` is still fitted,
  reported, and excluded from the verdict by
  :class:`~wattsteer_ml.evaluation.dessem_ab.SegmentRow` — a driver that had
  dropped it would have satisfied the box by hiding the row;
- **an arm is named, and a lane it disagrees with is refused**, because two of
  the three arms share one lane and the third does not;
- **a database that cannot support the comparison produces ``NOT_RUN_YET`` and
  never a floor.** There is no fixture path into
  :meth:`~wattsteer_ml.evaluation.dessem_ab.DessemProvenance.measured` here, and
  the tests that need hours build them themselves in ``test_dessem_ab.py`` and
  stamp them ``fixture``.

The fit itself is not simulated: a fixture-driven "end to end" would assert that
the mocks agree with each other. The DB-gated tests at the bottom run the read
and composition path against real Postgres, which on an un-ingested database is
exactly how the honest absence is produced.
"""

from __future__ import annotations

import asyncio
import inspect
import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from database_harness import database_url, run
from wattsteer_ml import dessem_ab_run as driver
from wattsteer_ml import retrain
from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.constants import SUBSYSTEM_THRESHOLD_MW
from wattsteer_ml.dessem_ab_run import (
    DessemAbRequest,
    DessemAbRunError,
    reportable_folds,
)
from wattsteer_ml.evaluation import materialize_fold_calendar, stamp_fidelity
from wattsteer_ml.evaluation.dessem_ab import (
    AB_GATE_PROFILE,
    AB_LANES,
    AB_RUNS,
    DESSEM_DELTA_BLOCK_KEY,
    NOT_RUN_YET,
)
from wattsteer_ml.evaluation.matrix import MATRIX_RUN_BY_NAME
from wattsteer_ml.features import MaterialisedFeatureRows
from wattsteer_ml.lanes import Lane, is_artifact_id

#: The A/B is quarterly and this is the quarter it was first run in. A fixed
#: instant, because a calendar materialised from ``now()`` would make every
#: assertion below expire.
AS_OF = datetime(2026, 9, 9, 0, 0, tzinfo=UTC)

#: Unreachable on purpose. Every no-database test below points here rather than
#: at a stub, so what is exercised is the driver's own failure path.
NOWHERE = "postgres://nobody@127.0.0.1:1/none"

ARTIFACT_ID = "2026-09-09T00:00:00Z"


def request(root: Path, **overrides: Any) -> DessemAbRequest:
    return DessemAbRequest(
        as_of=AS_OF,
        root=root,
        database_url=NOWHERE,
        artifact_id=ARTIFACT_ID,
        **overrides,
    )


def seed_cards(root: Path) -> dict[str, Path]:
    """One minimal card per A/B lane, because the block is an *edit* of one.

    The driver mints no card — a ``dessem_delta`` block on a card nothing
    promoted would describe an artifact the product never served — so a test of
    the write path has to put one there.
    """
    paths: dict[str, Path] = {}
    for lane in AB_LANES:
        path = root / lane.directory_name / f"{ARTIFACT_ID}{CARD_SUFFIX}"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"artifact_id": ARTIFACT_ID}), encoding="utf-8")
        paths[lane.directory_name] = path
    return paths


# --- which folds, and where they come from -------------------------------------


def test_the_reportable_folds_are_derived_and_no_fold_id_is_written() -> None:
    """The spec names F5–F6; the driver names nothing.

    Both conditions are the calendar's arithmetic against the runs' own window
    starts: a base-fit block for every arm, and an earlier fold with one for
    every arm to pool the reliability curve over. The ids below are therefore an
    *output* of this test, not a constant in the module — asserted by reading
    the source, because a hardcoded ``F5`` would pass every numeric assertion
    here and still be the thing the box forbids.
    """
    calendar = materialize_fold_calendar(AS_OF.date())

    assert [fold.id for fold in reportable_folds(calendar)] == ["F4", "F5", "F6"]

    source = inspect.getsource(driver)
    body = source.split('"""', 2)[2]  # past the module docstring
    assert '"F5"' not in body
    assert '"F6"' not in body


def test_a_fold_no_common_arm_can_be_fitted_on_is_not_reportable() -> None:
    """F1–F3 are excluded, and for two different reasons that are not the same.

    F1 and F2: ``A-common`` and ``B-common`` open on 2025-05-23, which is inside
    those folds' calibration windows, so there is no base-fit block at all. F3:
    both have one, but no *earlier* fold does — and ``train_fold`` refuses to fit
    without a pooled out-of-fold curve, so the fold is unscoreable rather than
    merely short. Neither is a fault; both are folds the augmented feature set is
    too young to have.
    """
    calendar = materialize_fold_calendar(AS_OF.date())
    common = MATRIX_RUN_BY_NAME["B-common"]

    with pytest.raises(ValueError, match="no base-fit block"):
        calendar.fold("F2").blocks_for(common.window_start)
    assert calendar.fold("F3").base_fit_days_for(common.window_start) == 41
    assert "F3" not in [fold.id for fold in reportable_folds(calendar)]


def test_a_scoreable_fold_that_cannot_decide_is_still_reported() -> None:
    """F4 is fitted and reported; only the *verdict* excludes it.

    This is the acceptance box read the strict way. F4 gives the common-window
    arms 133 base-fit days against the calendar's 180, so it decides nothing —
    and it is still in the driver's sample, because
    :class:`~wattsteer_ml.evaluation.dessem_ab.SegmentRow` is what grades it and
    a row the driver never scored is a row a reader cannot see was excluded.
    """
    calendar = materialize_fold_calendar(AS_OF.date())
    minimum = calendar.rules.min_base_fit_days
    fold = calendar.fold("F4")

    assert fold.base_fit_days_for(MATRIX_RUN_BY_NAME["A-common"].window_start) < minimum
    assert not fold.is_decision_grade(
        MATRIX_RUN_BY_NAME["B-common"].window_start, minimum
    )
    assert "F4" in [fold.id for fold in reportable_folds(calendar)]
    for run_name in ("A-common", "B-common"):
        assert MATRIX_RUN_BY_NAME[run_name].decision_grade_folds(calendar) == (
            "F5",
            "F6",
        )


def test_the_next_quarter_enters_the_sample_without_a_code_change() -> None:
    """The last box. A calendar materialised a quarter later grades F7 itself."""
    later = materialize_fold_calendar(datetime(2026, 12, 1, tzinfo=UTC).date())

    assert [fold.id for fold in reportable_folds(later)] == ["F4", "F5", "F6", "F7"]
    assert MATRIX_RUN_BY_NAME["B-common"].decision_grade_folds(later) == (
        "F5",
        "F6",
        "F7",
    )


# --- the arm, and the lane it is read through ----------------------------------


def test_an_arm_that_disagrees_with_its_lane_is_refused() -> None:
    """The feature set and the gate are what the feature function is asked for.

    ``B-common`` read through the free-feature lane would be reported under a
    lane whose rows it never saw — and the two lanes are exactly what the block
    is written onto. The refusal is before any query, which is why no connection
    is needed to provoke it.
    """
    free_lane = Lane(
        feature_set="dessem_free_v1",
        gate_profile=AB_GATE_PROFILE,
        threshold_mw=float(SUBSYSTEM_THRESHOLD_MW),
    )

    with pytest.raises(retrain.RetrainError, match="B-common reads"):
        asyncio.run(
            retrain.read_lane_inputs(
                # Refused before the connection is ever used.
                None,
                free_lane,
                as_of=AS_OF,
                fold_id="F5",
                arm=MATRIX_RUN_BY_NAME["B-common"],
            )
        )


def test_the_two_free_arms_share_one_lane_and_the_augmented_one_does_not() -> None:
    """Why the arm cannot be recovered from the lane, in one assertion.

    A lane is ``(feature_set, gate_profile, threshold_mw)`` and a window is not
    part of it, so ``A-full`` and ``A-common`` are one lane and two arms. That is
    the whole reason ``read_lane_inputs`` grew an ``arm`` argument.
    """
    lanes = [
        Lane(
            feature_set=one.feature_set,
            gate_profile=AB_GATE_PROFILE,
            threshold_mw=float(SUBSYSTEM_THRESHOLD_MW),
        ).directory_name
        for one in AB_RUNS
    ]

    assert lanes[0] == lanes[1] != lanes[2]
    assert len(AB_LANES) == 2


def test_the_id_an_arm_is_fitted_under_is_one_a_card_accepts(tmp_path: Path) -> None:
    """The defect that had kept every arm unfitted, as one assertion.

    ``train_fold`` composes a :class:`~wattsteer_ml.training.bundle.ModelCard`,
    and a card's id is the stem of a bundle — ``is_artifact_id``, an ISO-8601
    UTC instant. The driver passed ``dessem-ab-<arm>-<fold>``, so every arm whose
    calibration succeeded died on ``BundleError`` instead of being scored. It was
    invisible for a whole ticket because it is reached only after a real fit on
    real rows, and because the *first* arm of the first fold refuses on the
    ingested database for a data reason and the driver stops there.

    Asserted against ``is_artifact_id`` — the rule the card checks — rather than
    against a literal, so a change to the rule moves this test with it.
    """
    arms = driver.DatabaseArms(request=request(tmp_path))

    assert is_artifact_id(arms.arm_artifact_id)
    # And it is the run's instant, so twelve unsaved fits share one id rather
    # than minting twelve nothing will ever look up.
    assert arms.arm_artifact_id == ARTIFACT_ID


# --- what an absent database gets you -----------------------------------------


def test_an_unreachable_database_is_not_run_yet_and_never_a_floor(
    tmp_path: Path,
) -> None:
    """The honest absence, on both cards, in the one sentence it always is.

    ``measured`` is false, ``dessem_source`` is ``unmeasured``, the reason is
    ticket 18's ``NOT_RUN_YET`` — "the three runs have not been scored" — and
    there is no ``contrasts`` key to be misread as a tie between the arms. The
    driver's own report carries the exception's sentence beside it, because the
    block's reason is deliberately the same every time and therefore cannot say
    which database failed.
    """
    cards = seed_cards(tmp_path)

    report = driver.run_dessem_ab_from_database(request(tmp_path))

    assert not report.is_measurement
    assert report.measured is None
    assert report.not_run is not None
    assert report.fold_ids == ("F4", "F5", "F6")
    assert report.fitted == ()
    assert len(report.cards) == len(AB_LANES)
    for path in cards.values():
        block = json.loads(path.read_text(encoding="utf-8"))[DESSEM_DELTA_BLOCK_KEY]
        assert block["measured"] is False
        assert block["dessem_source"] == "unmeasured"
        assert block["reason"] == NOT_RUN_YET
        assert "contrasts" not in block
        assert block["runs"] == ["A-full", "A-common", "B-common"]


def test_a_fold_one_arm_refuses_is_excluded_and_named_rather_than_ending_the_run(
    tmp_path: Path,
) -> None:
    """The third case the driver had no shape for, and the row it must not hide.

    Not an empty database and not a complete one: one arm that cannot be fitted
    on *some* folds. Measured on the first ingested database — ``A-full``'s pool
    admits no publishable three-class risk split on two of the three reportable
    folds while the third carries every arm — and a driver that aborted on the
    first refusal would have thrown away a decision-grade quarter over a quarter
    that decides nothing.

    So the refusal is per segment, and it is *returned* rather than dropped: a
    sample narrowed silently is the acceptance box satisfied by hiding a row.
    The stub here refuses one arm on one segment and returns nothing for the
    rest, which is all :func:`_scoreable_segments` reads — it asks whether an
    arm can be scored, not what it scored.
    """
    calendar = materialize_fold_calendar(AS_OF.date())
    segments = tuple(
        segment
        for fold in reportable_folds(calendar)
        for segment in stamp_fidelity(fold, None)
    )
    refused_on = segments[0].row_id

    def stub(run: Any, segment: Any) -> tuple[()]:
        if segment.row_id == refused_on and run.name == AB_RUNS[0].name:
            raise driver.NoArmDataError("this arm has no floor on this fold")
        return ()

    scoreable, refused = driver._scoreable_segments(stub, segments)

    assert [segment.row_id for segment in scoreable] == [
        segment.row_id for segment in segments[1:]
    ]
    assert list(refused) == [refused_on]
    # The arm that refused, and its own sentence — not a boolean.
    assert refused[refused_on][AB_RUNS[0].name].startswith("NoArmDataError:")
    assert set(refused[refused_on]) == {AB_RUNS[0].name}


def test_no_card_is_minted_where_none_exists(tmp_path: Path) -> None:
    """The block is an edit. A card this module wrote would name no artifact.

    Both lanes are accounted for in ``cards_absent`` with a reason each, and
    nothing is on the volume — a run that had minted two cards would have put a
    ``dessem_delta`` block on an artifact the product never served.
    """
    report = driver.run_dessem_ab_from_database(request(tmp_path))

    assert report.cards == ()
    assert len(report.cards_absent) == len(AB_LANES)
    assert all("no model card" in reason for reason in report.cards_absent)
    assert list(tmp_path.iterdir()) == []


def test_a_lane_with_no_promoted_artifact_is_refused_rather_than_guessed(
    tmp_path: Path,
) -> None:
    """Which card, when the operator did not say: the promoted one, or nothing."""
    unnamed = DessemAbRequest(
        as_of=AS_OF, root=tmp_path, database_url=NOWHERE, artifact_id=None
    )

    with pytest.raises(DessemAbRunError, match="no promoted artifact"):
        unnamed.card_artifact_id(AB_LANES[0])


def test_a_naive_instant_materialises_no_calendar(tmp_path: Path) -> None:
    with pytest.raises(DessemAbRunError, match="tz-aware"):
        DessemAbRequest(as_of=datetime(2026, 9, 9), root=tmp_path, database_url=NOWHERE)


# --- what the driver structurally cannot do ------------------------------------


def test_the_driver_saves_no_artifact_and_promotes_nothing() -> None:
    """Twelve experiment arms are not twelve candidates for the served lanes.

    ``save_artifact`` would put them in the two lanes' directories under ids
    nothing promoted, and an append to ``promotions.jsonl`` would make an
    experiment look like a decision. Neither is imported, and the block's own
    ``decides`` sentence says the same thing to a reader of the card.
    """
    body = inspect.getsource(driver).split('"""', 2)[2]

    assert "save_artifact" not in body
    assert "PromotionRecord" not in body
    assert "promotions.append" not in body
    # The log is *read*, to find which card each lane's block belongs on, and
    # that is the only relationship this module has with it.
    assert "PromotionLog.read" in body
    assert "record_dessem_delta" in body


def test_the_measured_stamp_has_exactly_one_caller_and_no_fixture_path() -> None:
    """A fixture dressed as a measurement is the failure this stamp exists for.

    :meth:`DessemProvenance.measured` is reached from one line, after every arm
    has come back from ``forecast_rows`` over rows read out of Postgres, and
    ``DessemProvenance.fixture`` is not reachable from this module at all.
    """
    body = inspect.getsource(driver).split('"""', 2)[2]

    assert body.count("DessemProvenance.measured(") == 1
    assert "DessemProvenance.fixture" not in body


def test_the_data_failures_are_named_and_a_surprise_is_not_one() -> None:
    """The absence is written over an empty table, never over an unknown fault.

    The caught set is the retrain's — the ways the data can say there is nothing
    to fit — plus this module's ``NoArmDataError`` for a segment with no settled
    label. A bug in the A/B's own arithmetic (``DessemAbError``) is deliberately
    not in it: writing "the three runs have not been scored" over one would be
    the worst outcome available here.
    """
    assert driver.NoArmDataError in driver.DATA_FAILURES
    assert retrain.RetrainError in driver.DATA_FAILURES
    names = {kind.__name__ for kind in driver.DATA_FAILURES}
    assert names == {
        "NoArmDataError",
        "CalibrationError",
        "RetrainError",
        "TrainingError",
    }
    assert "DessemAbError" not in names


# --- the process ---------------------------------------------------------------


def test_a_run_that_scored_nothing_exits_non_zero(tmp_path: Path) -> None:
    """An honest ``NOT_RUN_YET`` is still a run that did not answer the question."""
    seed_cards(tmp_path)

    code = driver.main(
        [
            "--root",
            str(tmp_path),
            "--database-url",
            NOWHERE,
            "--artifact-id",
            ARTIFACT_ID,
            "--as-of",
            "2026-09-09T00:00:00Z",
        ]
    )

    assert code == 1


def test_no_database_url_is_a_configuration_complaint(tmp_path: Path) -> None:
    assert driver.main(["--root", str(tmp_path), "--database-url", ""]) == 2


def test_there_is_no_flag_that_narrows_the_folds() -> None:
    """A ``--fold`` here could drop a decision-grade quarter silently.

    The holdout backfill has one because its unit of work *is* a named fold. The
    A/B's unit of work is the verdict, and a verdict over one of the two
    deciding quarters looks exactly like a verdict over both.
    """
    source = inspect.getsource(driver.main)

    assert "--fold" not in source
    assert "--as-of" in source


# --- the rows are read once per window -----------------------------------------


def test_the_windows_are_planned_per_feature_set_and_not_per_fit() -> None:
    """Nine ``(arm, fold)`` reads collapse to two, and the two are derived.

    This is the ticket's own finding about why the first run looked hung:
    ``feature_rows`` measures at 58.4 s per 17,376 rows and the driver called it
    once per fit. What makes two reads enough is arithmetic and not a guess —
    every fold of one arm opens on that arm's window start, and ``A-full``'s
    window start precedes ``A-common``'s at the same feature set — so the
    assertion is that the planned spans *contain* every block every arm will ask
    for, not that there happen to be two of them.
    """
    calendar = materialize_fold_calendar(AS_OF.date())
    folds = reportable_folds(calendar)
    windows = driver.plan_windows(folds)

    by_key = {window.key: window for window in windows}
    assert len(by_key) == len(windows)
    # One per feature set at the A/B's one gate and one threshold. Derived:
    # the two free-feature arms share a read because the feature function has
    # no window-start parameter to tell them apart.
    assert {key[0] for key in by_key} == {one.feature_set for one in AB_RUNS}

    asked = 0
    for matrix_run in AB_RUNS:
        window = by_key[
            (matrix_run.feature_set, AB_GATE_PROFILE, float(SUBSYSTEM_THRESHOLD_MW))
        ]
        for fold in folds:
            blocks = fold.blocks_for(matrix_run.window_start)
            assert window.target_from <= blocks.base_fit_start
            assert blocks.test_end <= window.target_to
            asked += 1
    # The saving, stated as the ratio it is rather than as a wall clock.
    assert asked > len(windows)


def test_a_materialised_window_is_sliced_exactly_as_a_direct_read_is() -> None:
    """``between`` is the ``target_date`` predicate and nothing else.

    Asserted on rows built here rather than read, because what is being pinned
    is the slicing rule — inclusive at both ends, order preserved, whole rows —
    and a database would only confirm it for the dates it happens to hold.
    """
    rows = tuple(
        {"target_date": date(2026, 7, 1) + timedelta(days=offset), "n": offset}
        for offset in range(10)
    )
    materialised = MaterialisedFeatureRows(
        target_from=date(2026, 7, 1),
        target_to=date(2026, 7, 10),
        gate_profile="gate_late",
        feature_set="dessem_free_v1",
        threshold_mw=5.0,
        rows=rows,
    )

    assert materialised.between(date(2026, 7, 3), date(2026, 7, 5)) == rows[2:5]
    assert materialised.between(date(2026, 7, 1), date(2026, 7, 10)) == rows
    assert materialised.covers(date(2026, 7, 2), date(2026, 7, 9))
    assert not materialised.covers(date(2026, 6, 30), date(2026, 7, 9))
    assert not materialised.covers(date(2026, 7, 2), date(2026, 7, 11))


class NoGoLive:
    """The only thing ``read_lane_inputs`` touches before it judges the rows.

    A stub and not a database, because what these two tests pin is that a
    materialised window is refused **before** anything is read or fitted — a
    check that only fired after a fold's worth of work would be a check that
    costs what it was meant to save.
    """

    async def fetchval(self, *_: Any) -> None:
        return None


def test_a_window_too_narrow_for_the_fold_is_refused_rather_than_scored_short() -> None:
    """A short read is a bug and a short database is a fact; they must differ.

    Containment is judged against the range the rows were *asked* for, so a
    caller that materialised a fortnight too few is refused even though the
    rows it holds would slice without complaint.
    """
    arm = MATRIX_RUN_BY_NAME["B-common"]
    lane = Lane(
        feature_set=arm.feature_set,
        gate_profile=AB_GATE_PROFILE,
        threshold_mw=float(SUBSYSTEM_THRESHOLD_MW),
    )
    blocks = (
        materialize_fold_calendar(AS_OF.date()).fold("F6").blocks_for(arm.window_start)
    )
    narrow = MaterialisedFeatureRows(
        target_from=blocks.base_fit_start,
        target_to=blocks.test_end - timedelta(days=14),
        gate_profile=arm.gate_profile,
        feature_set=arm.feature_set,
        threshold_mw=lane.threshold_mw,
        rows=(),
    )

    with pytest.raises(retrain.RetrainError, match="materialised rows were read for"):
        asyncio.run(
            retrain.read_lane_inputs(
                NoGoLive(),
                lane,
                as_of=AS_OF,
                fold_id="F6",
                arm=arm,
                rows=narrow,
            )
        )


def test_rows_read_for_another_feature_function_are_not_this_arm_s() -> None:
    """Sharing one read between two arms is only sound if they agree on it.

    ``A-full`` and ``A-common`` may share a window because the feature function
    takes no window start. ``B-common`` may not share theirs, and the refusal is
    at the point the rows are handed over rather than at the point a figure
    comes out of them.
    """
    arm = MATRIX_RUN_BY_NAME["B-common"]
    lane = Lane(
        feature_set=arm.feature_set,
        gate_profile=AB_GATE_PROFILE,
        threshold_mw=float(SUBSYSTEM_THRESHOLD_MW),
    )
    blocks = (
        materialize_fold_calendar(AS_OF.date()).fold("F6").blocks_for(arm.window_start)
    )
    wrong = MaterialisedFeatureRows(
        target_from=blocks.base_fit_start,
        target_to=blocks.test_end,
        gate_profile=arm.gate_profile,
        feature_set="dessem_free_v1",
        threshold_mw=lane.threshold_mw,
        rows=(),
    )

    with pytest.raises(retrain.RetrainError, match="materialised rows are"):
        asyncio.run(
            retrain.read_lane_inputs(
                NoGoLive(),
                lane,
                as_of=AS_OF,
                fold_id="F6",
                arm=arm,
                rows=wrong,
            )
        )


def test_a_probe_outside_the_materialised_window_compares_nothing() -> None:
    """The equivalence check refuses to pass vacuously."""
    materialised = MaterialisedFeatureRows(
        target_from=date(2026, 7, 1),
        target_to=date(2026, 7, 10),
        gate_profile="gate_late",
        feature_set="dessem_free_v1",
        threshold_mw=5.0,
        rows=(),
    )
    with pytest.raises(ValueError, match="compares nothing"):
        asyncio.run(
            materialised.agrees_with_a_direct_read(
                None,
                first=date(2026, 6, 1),
                last=date(2026, 7, 10),
            )
        )


def test_the_run_narrates_every_arm_and_fold_with_an_instant(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    """Ninety-three minutes of silence is indistinguishable from a hang.

    That is not a preference: it is what the first attempt at this run was
    killed for, and the fold it cost. So the narration is a property of the
    driver and asserted like one — on stderr, so the one JSON report on stdout
    stays parseable, and stamped, so a reader can tell a slow read from a
    stopped one.
    """
    seed_cards(tmp_path)
    driver.run_dessem_ab_from_database(request(tmp_path))

    captured = capsys.readouterr()
    lines = [line for line in captured.err.splitlines() if line.startswith("[")]
    assert lines
    assert all(line[1:21].endswith("Z") for line in lines)
    assert any("folds reportable" in line for line in lines)
    # stdout is the report a caller parses, and the narration is not on it.
    assert captured.out == ""

    # The unreachable database above gets as far as the fold list and no
    # further, so the lines a real run's *long* steps print are asserted where
    # they are written rather than by fitting twelve boosters in a unit test.
    # Source-level, because the property is "no step of this run is silent".
    for step in ("materialise", "fit"):
        assert "_progress(" in inspect.getsource(getattr(driver.DatabaseArms, step))
    assert "_progress(" in inspect.getsource(driver._scoreable_segments)


# --- against real Postgres -----------------------------------------------------


def test_each_arm_reads_its_own_window_against_real_postgres() -> None:
    """Three arms, one gate, three windows — read, or refused with a reason.

    The honest limit of an automated test is the read: an un-ingested database
    can fit nothing. What this asserts is that naming the arm reaches Postgres
    and comes back with *that arm's* base-fit block — ``A-full``'s opening
    2024-04-01 and the two common arms' opening 2025-05-23 — which is the one
    difference the A/B is measuring.
    """
    assert database_url()

    async def read(conn: Any) -> list[str]:
        seen: list[str] = []
        for arm in AB_RUNS:
            lane = Lane(
                feature_set=arm.feature_set,
                gate_profile=AB_GATE_PROFILE,
                threshold_mw=float(SUBSYSTEM_THRESHOLD_MW),
            )
            try:
                inputs = await retrain.read_lane_inputs(
                    conn, lane, as_of=AS_OF, fold_id="F5", arm=arm
                )
            except retrain.RetrainError as refusal:
                seen.append(f"refused: {refusal}")
                continue
            assert inputs.run == arm.name
            assert inputs.window_start == arm.window_start
            assert inputs.blocks.base_fit_start == arm.window_start
            assert inputs.fold.id == "F5"
            seen.append("read")
        return seen

    assert all(one.startswith(("read", "refused: ")) for one in run(read))


def test_an_un_ingested_database_produces_the_absence_and_not_a_verdict(
    tmp_path: Path,
) -> None:
    """The state this repository is actually in, asserted rather than assumed.

    The migrated database has no observations, so ``feature_rows`` returns its
    spine with no labels and the first booster has nothing to fit. What must come
    out of that is ``NOT_RUN_YET`` with the training refusal beside it — never a
    floor, and never a provenance of ``fold_evaluation``. The day the database is
    ingested this test is the one that changes: it will read ``measured``.
    """
    url = database_url()
    seed_cards(tmp_path)

    report = driver.run_dessem_ab_from_database(
        DessemAbRequest(
            as_of=AS_OF,
            root=tmp_path,
            database_url=url,
            artifact_id=ARTIFACT_ID,
        )
    )

    if report.is_measurement:  # an ingested database: the run answered
        assert report.measured is not None
        block = report.as_dict()[DESSEM_DELTA_BLOCK_KEY]
        assert block["dessem_source"] == "fold_evaluation"
        return
    assert report.not_run is not None
    for lane in AB_LANES:
        path = tmp_path / lane.directory_name / f"{ARTIFACT_ID}{CARD_SUFFIX}"
        block = json.loads(path.read_text(encoding="utf-8"))[DESSEM_DELTA_BLOCK_KEY]
        assert block["measured"] is False
        assert block["reason"] == NOT_RUN_YET


def test_the_materialised_window_is_what_a_direct_read_returns() -> None:
    """The one property materialising rests on, asked of the real function.

    ``feature_rows`` is a set-returning function in the API's migration tree and
    nothing in this service owns it. That a row is a function of its own target
    date and not of the range bounds it was asked for is therefore an assumption
    about somebody else's SQL — so it is read twice and compared whole, values
    and all, and not by count or by key.

    Skipped without a database, and honest on an un-ingested one: two empty
    reads are still two reads that agree, which is why the test also records how
    many rows it actually compared.
    """
    assert database_url()
    arm = MATRIX_RUN_BY_NAME["B-common"]
    calendar = materialize_fold_calendar(AS_OF.date())
    folds = reportable_folds(calendar)
    window = next(
        one for one in driver.plan_windows(folds) if one.feature_set == arm.feature_set
    )
    probe_last = window.target_to
    probe_first = max(
        window.target_from,
        probe_last - timedelta(days=driver.EQUIVALENCE_PROBE_DAYS - 1),
    )

    async def compare(conn: Any) -> tuple[bool, int]:
        materialised = await MaterialisedFeatureRows.of(conn, window.query())
        agrees = await materialised.agrees_with_a_direct_read(
            conn, first=probe_first, last=probe_last
        )
        return agrees, len(materialised.between(probe_first, probe_last))

    agrees, compared = run(compare)
    assert agrees, (
        f"{window.feature_set} rows differ between a read of "
        f"{window.target_from}..{window.target_to} sliced to "
        f"{probe_first}..{probe_last} and a direct read of the latter"
    )
    assert compared >= 0
