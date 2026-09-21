"""The retrain `0039` left owing: measured, not asserted in prose.

Forecaster ticket 26. `0039_the_gate_over_a_backfill.sql` repaired the feature
gate's `as_of`, so every historical feature row now carries weather where before
`feature_weather_block` returned nothing for a historical date. The repair
restated `feature_rows`, and it put the fix's conjunct **inside** that function
on purpose, so `feature_hash` would move — a weatherless model must not go on
serving against rows that now carry weather. Every artifact fitted before it is
therefore bound to a vector the database no longer produces, and both serving
lanes owe a retrain.

`0039` says the hot-swap gate refuses those artifacts. That sentence is prose,
and this file is the measurement. Three things, and the third is the one the
build keeps finding missing:

1. **The refusal happens at the check that owns it.** Check 3 is the feature
   contract; a refusal that arrived from check 1, check 4 or an exception on the
   way would satisfy "was refused" while proving nothing about the hash.
2. **The refusal names the mismatch.** Both hashes, on the log line and in the
   raised error, so an operator reading `promotions.jsonl` learns *which* two
   hashes disagreed rather than that something did.
3. **The refusal is caused by the hash and by nothing else.** The control is
   the same candidate, the same incumbent, the same fixture hours, with the
   live hash swapped in — and it must promote. Without that pair, a green
   refusal test is compatible with a fixture that could never have promoted for
   an unrelated reason, which is the vacuous-guard shape this repository has
   now hit four times.

The **real** hashes — the pre-`0039` `feature_rows` body against the live one,
both read out of Postgres with `pg_get_functiondef` — are
`test_database_retrain_debt.py`. This file drives the same gate on fixture
hashes so the default suite still owns the decision procedure.

Retraining itself is **out of scope and cannot be done here**: it needs ingested
canonical rows — weather runs, ONS constrained-off actuals, a fleet — that no
environment in this repository has. The debt is therefore something this ticket
makes provable and visible; clearing it is a scheduled run against a populated
database.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from conftest import AS_OF, FUNCTION_DEFINITION
from test_hot_swap_gate import (
    CANDIDATE_ID,
    INCUMBENT_ID,
    LANE,
    LIVE_HASH,
    NOW,
    STALE_HASH,
    candidate,
    clean_smoke,
    incumbent,
    keys,
    lane_directory,
    metrics_row,
    run,
    scored,
)
from wattsteer_ml import artifacts
from wattsteer_ml.artifacts import ARTIFACT_SUFFIX, CARD_SUFFIX
from wattsteer_ml.config import settings
from wattsteer_ml.evaluation import (
    Fold,
    FoldBlocks,
    materialize_fold_calendar,
    stamp_fidelity,
)
from wattsteer_ml.evaluation.gate import (
    Comparator,
    ContractDriftError,
    GateDecision,
    record_decision,
    run_gate,
)
from wattsteer_ml.evaluation.ladder import FoldRows
from wattsteer_ml.lanes import Lane
from wattsteer_ml.promotions import (
    PROMOTION_LOG_FILENAME,
    PromotionLog,
    PromotionRecord,
    append,
)
from wattsteer_ml.retrain import LaneInputs, RetrainRequest, _incumbent
from wattsteer_ml.training import TrainedFold
from wattsteer_ml.training.bundle import (
    CONTRACT_FAULT_KEY,
    GATE_BLOCK_KEY,
    read_card,
    save_artifact,
    write_card,
)

#: The check that owns the feature contract. Third of the seven, and the whole
#: subject of this file: `docs/specs/forecaster.md` orders the checks and says
#: "all must pass", so which one stopped a candidate is the finding.
CONTRACT_CHECK = "feature_contract"

#: The two checks that run before it. Both must have *passed* in the refusal
#: this file measures, or the refusal is not evidence about the hash.
CHECKS_BEFORE = ("lane_identity", "estimator_allow_list")


# --- 1 & 2: refused by check 3, naming the mismatch ---------------------------


def stale_decision() -> GateDecision:
    """The post-`0039` first run: a live candidate, an incumbent left behind.

    The shape the migration actually produces. The candidate is trained *after*
    the migration, so it carries the live hash; the incumbent on the volume was
    fitted before it and carries the departed one. Check 3 compares both against
    the live function and refuses on either.
    """
    return run(candidate(), incumbent(feature_hash=STALE_HASH))


def test_a_pre_0039_incumbent_is_refused_at_the_contract_check() -> None:
    """Refused, and refused *there* — the checks before it having passed.

    "Was refused" is not the claim. A candidate can be refused by check 1 for
    sitting in another lane and by check 4 for a short fold, and either would
    leave a refusal on the volume that says nothing about `feature_rows`.
    """
    decision = stale_decision()
    assert not decision.promotes
    names = [check.name for check in decision.checks]
    assert names == [*CHECKS_BEFORE, CONTRACT_CHECK], (
        "the gate must stop at check 3 — a refusal from a later check would mean "
        "the contract check passed"
    )
    assert all(check.passed for check in decision.checks[:-1])
    assert not decision.checks[-1].passed


def test_the_refusal_names_both_hashes_rather_than_that_something_moved() -> None:
    """The mismatch, spelt out: the live hash, the candidate's, the incumbent's.

    An operator reading `promotions.jsonl` after `0039` has one question — which
    two hashes disagree — and a reason that says "the feature contract changed"
    does not answer it.
    """
    decision = stale_decision()
    check = decision.checks[-1]
    assert check.name == CONTRACT_CHECK
    assert check.values == {
        "live_feature_hash": LIVE_HASH,
        "candidate_feature_hash": LIVE_HASH,
        "incumbent_feature_hash": STALE_HASH,
    }
    assert LIVE_HASH in decision.reason
    assert STALE_HASH in decision.reason

    drift = decision.contract_drift
    assert drift is not None
    assert drift.live == LIVE_HASH
    assert drift.incumbent == STALE_HASH
    assert drift.incumbent_artifact_id == INCUMBENT_ID


def test_the_debt_is_the_incumbents_even_when_the_candidate_matches() -> None:
    """`0039`'s exact situation, and why the candidate's own hash is not enough.

    The first post-migration run trains a candidate against the repaired SQL, so
    the candidate is *fine*. The gate still refuses, because the incumbent it
    would be compared against was fitted in a feature space the database no
    longer produces — a bootstrap between the two would be a comparison of two
    different vectors reported as one number.
    """
    decision = stale_decision()
    drift = decision.contract_drift
    assert drift is not None
    assert drift.candidate == drift.live, "the candidate is not the stale one here"
    assert drift.incumbent != drift.live
    assert drift.fault


# --- 3: the control. The hash is the cause, and nothing else ------------------


def test_the_same_pair_promotes_once_the_incumbent_carries_the_live_hash() -> None:
    """The assertion that makes the three above evidence rather than a green dot.

    Identical candidate, identical fixture hours, identical smoke, identical
    `now` — one field moved back to the live hash. If this did not promote, the
    refusal above would be compatible with a fixture that could never have
    promoted for a reason nobody had noticed.
    """
    refused = stale_decision()
    promoted = run(candidate(), incumbent(feature_hash=LIVE_HASH))
    assert not refused.promotes
    assert promoted.promotes
    assert [check.name for check in promoted.checks][:3] == [
        *CHECKS_BEFORE,
        CONTRACT_CHECK,
    ]
    assert all(check.passed for check in promoted.checks)


def test_nothing_tolerates_the_stale_hash_when_no_candidate_could_replace_it(
    tmp_path: Path,
) -> None:
    """The trap `0039` names: the refusal must not soften to keep serving.

    A lane whose *only* artifact is the pre-`0039` incumbent is a lane that
    answers nothing. That is the correct behaviour and the point of putting the
    conjunct inside `feature_rows`, so it is asserted here rather than left to
    be re-litigated: the gate refuses, the promotion log gains a refusal and no
    promotion, and the incumbent is marked invalid on its own card.
    """
    lane_directory(tmp_path)
    lane_directory(tmp_path, artifact_id=INCUMBENT_ID)
    with pytest.raises(ContractDriftError) as raised:
        run_gate(
            candidate(),
            incumbent(feature_hash=STALE_HASH),
            root=tmp_path,
            live_feature_hash=LIVE_HASH,
            smoke=clean_smoke(),
            now=NOW,
            draws=50,
        )
    assert LIVE_HASH in str(raised.value)
    assert STALE_HASH in str(raised.value)

    log = PromotionLog.read(tmp_path / PROMOTION_LOG_FILENAME)
    assert [record.decision for record in log.records] == ["refuse"]
    assert log.promoted(LANE) is None

    card = read_card(tmp_path / LANE.directory_name / f"{INCUMBENT_ID}{CARD_SUFFIX}")
    assert card[GATE_BLOCK_KEY][CONTRACT_FAULT_KEY]


# --- 4: the self-recovering cold start ---------------------------------------
#
# Forecaster 15 made `_incumbent` treat an incumbent that refuses to load as a
# cold start, so the run *after* the contract refusal measures against rung 1
# and can promote. That is the difference between a debt that clears itself on
# the next scheduled run and one that pages somebody, and `0039` is the first
# migration to exercise it. Two tests: the loading half, then the deciding half.


def lane_inputs(
    *,
    lane: Lane,
    fold: Fold,
    blocks: FoldBlocks,
    rows: Sequence[Mapping[str, Any]],
) -> LaneInputs:
    """A `LaneInputs` for one fold, as `read_lane_inputs` would have built it.

    Built by hand rather than read from Postgres because what is under test is
    `_incumbent`'s three-way answer, which reads four of these fields. The fold
    and its blocks are the shared calendar's own — `conftest` materialises F1 at
    the live edge — so the segment the swap is decided on is a real one.
    """
    return LaneInputs(
        lane=lane,
        run="A-full",
        window_start=blocks.base_fit_start,
        calendar=materialize_fold_calendar(AS_OF),
        fold=fold,
        blocks=blocks,
        segments=stamp_fidelity(fold, None),
        prior=(),
        function_definition=FUNCTION_DEFINITION,
        rows_by_fold={fold.id: tuple(rows)},
        serving_rows=(),
        serving_day=blocks.test_end,
    )


@pytest.fixture
def incumbent_volume(
    trained: TrainedFold,
    fold: Fold,
    blocks: FoldBlocks,
    rows: Sequence[Mapping[str, Any]],
    tmp_path: Path,
) -> Iterator[tuple[Path, LaneInputs, FoldRows]]:
    """One promoted artifact on a scratch volume, and the inputs to re-score it.

    The bundle is the session-wide real fit, saved through `save_artifact` and
    promoted through the real promotion log, so `_incumbent` resolves it exactly
    as a weekly run would.
    """
    lane = trained.bundle.lane
    save_artifact(trained.bundle, trained.card, root=tmp_path)
    append(
        tmp_path / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=trained.card.artifact_id,
            lane=lane,
            decision="promote",
            reason="the pre-0039 promotion this ticket is about",
            at=NOW,
        ),
    )
    fold_rows = FoldRows.of(
        rows, fold=fold, blocks=blocks, function_definition=FUNCTION_DEFINITION
    )
    yield (
        tmp_path,
        lane_inputs(lane=lane, fold=fold, blocks=blocks, rows=rows),
        fold_rows,
    )


def mark_invalid(root: Path, lane: Lane, artifact_id: str) -> None:
    """Exactly what the gate's check 3 writes when it refuses on drift."""
    path = root / lane.directory_name / f"{artifact_id}{CARD_SUFFIX}"
    card = read_card(path)
    block = dict(card.get(GATE_BLOCK_KEY) or {})
    block[CONTRACT_FAULT_KEY] = (
        "the live feature_rows definition hashes to sha256:live, and this "
        "artifact carries sha256:stale"
    )
    write_card(path, {**card, GATE_BLOCK_KEY: block})


def test_before_the_mark_the_incumbent_is_a_real_comparator(
    incumbent_volume: tuple[Path, LaneInputs, FoldRows],
) -> None:
    """The first run: the incumbent loads, so the gate has something to refuse.

    Stated so the next test's cold start is a *change* rather than the only
    state this volume was ever in — a `_incumbent` that returned `None` for
    every volume would pass that test while proving nothing.
    """
    root, inputs, fold_rows = incumbent_volume
    request = RetrainRequest(
        run_id="2026-06-01T03:00:00Z",
        as_of=NOW,
        root=root,
        database_url="postgres://unused",
    )
    artifact_id, comparator = _incumbent(inputs, request=request, fold_rows=fold_rows)
    assert artifact_id is not None
    assert comparator is not None
    assert comparator.kind == "incumbent"
    assert comparator.feature_hash is not None


def test_an_incumbent_marked_invalid_by_check_three_is_a_cold_start(
    incumbent_volume: tuple[Path, LaneInputs, FoldRows],
) -> None:
    """The second run: the lane is cold, so it measures against rung 1.

    Without this the lane is stuck — every week refusing against an incumbent it
    cannot read, and no candidate ever compared against anything. The artifact
    id is still returned, because the retrain block records *which* artifact was
    the incumbent even when it could not be scored.
    """
    root, inputs, fold_rows = incumbent_volume
    request = RetrainRequest(
        run_id="2026-06-01T03:00:00Z",
        as_of=NOW,
        root=root,
        database_url="postgres://unused",
    )
    promoted = PromotionLog.read(root / PROMOTION_LOG_FILENAME).promoted(inputs.lane)
    assert promoted is not None
    mark_invalid(root, inputs.lane, promoted)

    artifact_id, comparator = _incumbent(inputs, request=request, fold_rows=fold_rows)
    assert artifact_id == promoted, "the log still names it; it just cannot be scored"
    assert comparator is None, (
        "an incumbent nothing may serve is not a comparator; the candidate is "
        "measured against rung 1 instead"
    )


def test_the_second_run_reaches_a_promotion_against_rung_one(tmp_path: Path) -> None:
    """The cold start still promotes after `0039`, so the debt clears itself.

    A cold start is `Comparator.cold_start`, whose `feature_hash` is `None` —
    and check 3 passes a `None` incumbent deliberately: there is no incumbent to
    be in the wrong feature space. So the run after the contract refusal reaches
    check 5 against rung 1 and can promote, with no human in the loop.
    """
    baseline = Comparator.cold_start(
        row=metrics_row(qloss=9.0), hours=tuple(scored(keys(), offset_mwh=9.0))
    )
    assert baseline.feature_hash is None
    decision = run(candidate(), baseline)
    assert decision.promotes
    contract = next(check for check in decision.checks if check.name == CONTRACT_CHECK)
    assert contract.passed
    assert decision.comparator == "same_hour_7d", (
        "the spelling on the promotion log line: rung 1, the 7-day same-hour "
        "baseline, which is what a cold start is measured against"
    )


# --- 5: where the debt is visible --------------------------------------------
#
# `/v1/meta` is the endpoint an operator reaches for when something is wrong
# with the volume, and until this ticket it reported a lane whose promoted
# artifact had been marked invalid as plain `promoted`. Nothing on the wire said
# the lane could not answer; the next promotion attempt would have found out.
#
# The four lane states are `docs/specs/forecaster.md`'s and are not touched:
# `packages/core`'s `LANE_STATES` carries three of them and a fifth would be a
# spec change. The debt is a separate fact about the promoted artifact's card.


@pytest.fixture
def volume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    root = tmp_path / "models"
    root.mkdir()
    monkeypatch.setattr(settings, "artifact_dir", root)
    yield root


def write_artifact(
    root: Path, lane: Lane, artifact_id: str, *, card: Mapping[str, Any] | None = None
) -> None:
    directory = root / lane.directory_name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{artifact_id}{ARTIFACT_SUFFIX}").write_bytes(b"bundle")
    (directory / f"{artifact_id}{CARD_SUFFIX}").write_text(
        json.dumps({} if card is None else card, indent=2) + "\n", encoding="utf-8"
    )


def promote(root: Path, lane: Lane, artifact_id: str) -> None:
    append(
        root / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=artifact_id,
            lane=lane,
            decision="promote",
            reason="promoted before 0039",
            at=NOW,
        ),
    )


def refuse(root: Path, lane: Lane, artifact_id: str, reason: str) -> None:
    append(
        root / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=artifact_id,
            lane=lane,
            decision="refuse",
            reason=reason,
            at=NOW,
        ),
    )


FAULT = (
    "the live feature_rows definition hashes to sha256:live, and this artifact "
    "carries sha256:stale"
)
FAULTED_CARD = {GATE_BLOCK_KEY: {CONTRACT_FAULT_KEY: FAULT}}


def test_a_promoted_artifact_marked_invalid_leaves_the_lane_unusable(
    volume: Path,
) -> None:
    """The `0039` lane, as the volume reports it.

    `promoted` stays what the promotion log says — the log is the authority for
    which artifact a lane may serve and `0039` revoked nothing — and the debt is
    reported beside it. Both are true at once and neither is inferable from the
    other.
    """
    write_artifact(volume, LANE, INCUMBENT_ID, card=FAULTED_CARD)
    promote(volume, LANE, INCUMBENT_ID)

    view = artifacts.inspect().view(LANE)
    assert view.state == "promoted"
    assert view.promoted == INCUMBENT_ID
    assert view.contract_fault == FAULT
    assert view.retrain_owed
    assert not view.usable
    reason = view.unusable_reason
    assert reason is not None
    assert INCUMBENT_ID in reason
    assert FAULT in reason
    assert "retrain" in reason


def test_a_lane_serving_a_sound_artifact_owes_nothing(volume: Path) -> None:
    """The control: a card with no fault leaves no debt and no sentence."""
    write_artifact(volume, LANE, INCUMBENT_ID)
    promote(volume, LANE, INCUMBENT_ID)

    view = artifacts.inspect().view(LANE)
    assert view.contract_fault is None
    assert not view.retrain_owed
    assert view.usable
    assert view.unusable_reason is None


def test_a_freshness_refusal_is_not_a_retrain_debt(volume: Path) -> None:
    """`freshness_and_coverage` refusals are the gate working, and must read so.

    Check 4's sixty-test-day floor and the quarterly live edge mean a candidate
    can only be promoted in roughly the last third of each quarter, so runs of
    these refusals are expected. A lane statement that read as an alarm during
    those weeks would train an operator to ignore the one that is not.
    """
    write_artifact(volume, LANE, CANDIDATE_ID)
    refuse(
        volume,
        LANE,
        CANDIDATE_ID,
        "freshness_and_coverage: the evaluation fold has 7 test days, under 60",
    )

    view = artifacts.inspect().view(LANE)
    assert view.state == "present_unpromoted"
    assert not view.retrain_owed, "nothing here is owed to a moved feature contract"
    assert not view.usable
    reason = view.unusable_reason
    assert reason is not None
    assert "freshness_and_coverage" in reason
    assert "expected" in reason


def test_a_guardrail_refusal_gets_no_quarterly_excuse(volume: Path) -> None:
    """The other half of the sentence above: only check 4 gets that caveat.

    A guardrail veto is not a calendar artefact, and appending "this is expected"
    to one would be the softening this ticket exists to refuse.
    """
    write_artifact(volume, LANE, CANDIDATE_ID)
    refuse(volume, LANE, CANDIDATE_ID, "guardrails: ece 0.08 exceeds 0.05")

    view = artifacts.inspect().view(LANE)
    assert not view.retrain_owed
    reason = view.unusable_reason
    assert reason is not None
    assert "ece" in reason
    assert "expected" not in reason


def test_an_untrained_lane_says_so_rather_than_owing_a_retrain(volume: Path) -> None:
    write_artifact(volume, LANE, INCUMBENT_ID)
    view = artifacts.inspect().view(LANE)
    assert view.state == "present_unpromoted"
    assert not view.retrain_owed
    assert view.unusable_reason is not None

    empty = artifacts.inspect().view(
        Lane(feature_set="dessem_free_v1", gate_profile="gate_early", threshold_mw=5)
    )
    assert empty.state == "no_artifact"
    assert not empty.retrain_owed
    assert empty.unusable_reason is not None
    assert "trained" in empty.unusable_reason


def test_an_unreadable_card_is_a_reported_fault_and_never_a_silent_pass(
    volume: Path,
) -> None:
    """`inspect()` never raises, so a truncated card arrives as a debt.

    A card the volume cannot parse is a card whose contract fault cannot be
    ruled out, and the safe reading of "cannot tell" on a serving volume is that
    the lane is not usable — not that it is.
    """
    write_artifact(volume, LANE, INCUMBENT_ID)
    promote(volume, LANE, INCUMBENT_ID)
    (volume / LANE.directory_name / f"{INCUMBENT_ID}{CARD_SUFFIX}").write_text(
        '{"identity":', encoding="utf-8"
    )

    view = artifacts.inspect().view(LANE)
    assert not view.usable
    assert view.card_error is not None
    assert "card" in view.card_error
    assert view.contract_fault is None, (
        "a card that would not parse states no contract fault; reading one out "
        "of it would be a guess"
    )
    assert not view.retrain_owed, (
        "the repair here is the volume's. Calling it a retrain debt would make "
        "`retrain_owed` mean 'not serving', which is the one thing it must not"
    )
    reason = view.unusable_reason
    assert reason is not None
    assert "repaired" in reason


def test_the_debt_reaches_the_meta_endpoint(volume: Path) -> None:
    """Where a human sees it. `/v1/meta` carries the three fields verbatim."""
    from fastapi.testclient import TestClient

    from wattsteer_ml.app import app

    write_artifact(volume, LANE, INCUMBENT_ID, card=FAULTED_CARD)
    promote(volume, LANE, INCUMBENT_ID)

    with TestClient(app) as client:
        body = client.get("/v1/meta").json()
    reported = {lane["lane"]: lane for lane in body["artifacts"]["lanes"]}
    lane = reported[LANE.directory_name]
    assert lane["state"] == "promoted"
    assert lane["retrain_owed"] is True
    assert lane["usable"] is False
    assert lane["contract_fault"] == FAULT
    assert FAULT in lane["unusable_reason"]


def test_the_gates_own_refusal_is_what_makes_the_lane_report_the_debt(
    volume: Path,
) -> None:
    """End to end, on one volume: check 3 runs, and `/v1/meta` changes.

    The two halves of this ticket joined up. Nothing here writes a
    `contract_fault` by hand — `run_gate` does, as part of refusing — and the
    lane's report before and after is the visibility the ticket asks for.
    """
    write_artifact(volume, LANE, INCUMBENT_ID)
    write_artifact(volume, LANE, CANDIDATE_ID)
    promote(volume, LANE, INCUMBENT_ID)
    assert artifacts.inspect().view(LANE).usable

    with pytest.raises(ContractDriftError):
        run_gate(
            candidate(),
            incumbent(feature_hash=STALE_HASH),
            root=volume,
            live_feature_hash=LIVE_HASH,
            smoke=clean_smoke(),
            now=NOW,
            draws=50,
        )

    view = artifacts.inspect().view(LANE)
    assert view.retrain_owed
    assert view.contract_fault is not None
    assert STALE_HASH in view.contract_fault
    assert LIVE_HASH in view.contract_fault


def test_recording_a_decision_alone_leaves_no_debt(volume: Path) -> None:
    """A refusal that is *not* a contract drift must not mark anything.

    `record_decision` writes the gate block on every decision, and the debt is
    read out of the same block. So the two have to be distinguishable: a lane
    refused by a guardrail owes no retrain, and reporting one would be the false
    alarm this file's freshness test is also about.
    """
    write_artifact(volume, LANE, CANDIDATE_ID)
    write_artifact(volume, LANE, INCUMBENT_ID)
    promote(volume, LANE, INCUMBENT_ID)
    decision = run(candidate(row=None), incumbent())
    record_decision(decision, root=volume)

    view = artifacts.inspect().view(LANE)
    assert not view.retrain_owed
    assert view.contract_fault is None


def test_an_incumbent_that_loads_but_cannot_be_scored_is_also_cold(
    incumbent_volume: tuple[Path, LaneInputs, FoldRows],
) -> None:
    """The deadlock a dropped feature column produces, and the reason the guard
    covers scoring rather than loading alone.

    The third case above — "the promoted artifact refuses to load" — assumes the
    gate has already stamped a contract fault on its card. But the fault is only
    written by a gate that *finishes*, and a migration that drops a feature
    column invalidates the incumbent the moment it is applied. So on the first
    run after such a migration the artifact still loads cleanly, and
    `forecast_rows` raises `FeatureContractError` instead — outside the old
    guard, killing the run before any gate could record anything. Every retrain
    then failed identically, for ever, which is precisely the stuck lane the
    docstring says this must not become.

    Measured on 21/09/2026, after `0055` dropped
    `observed_constrained_off_lag_48h` on the deployed database: the rows came
    back with 99 columns and the incumbent's contract wanted 100, and two
    consecutive weekly-shaped runs died on it.

    Here the rows are handed to `_incumbent` with one feature column removed,
    which is what the database now does. An incumbent that cannot be scored is
    exactly as unusable as one that cannot be loaded, so the answer is the same:
    the artifact is named, the comparator is `None`, and the candidate is
    measured against rung 1.
    """
    root, inputs, fold_rows = incumbent_volume
    dropped = "observed_constrained_off_lag_168h"
    thinned = [
        {key: value for key, value in row.items() if key != dropped}
        for row in fold_rows.rows
    ]
    assert dropped in fold_rows.rows[0], "the fixture must carry the column being dropped"
    short = FoldRows.of(
        thinned,
        fold=inputs.fold,
        blocks=inputs.blocks,
        function_definition=FUNCTION_DEFINITION,
    )
    request = RetrainRequest(
        run_id="2026-06-01T03:00:00Z",
        as_of=NOW,
        root=root,
        database_url="postgres://unused",
    )

    artifact_id, comparator = _incumbent(inputs, request=request, fold_rows=short)

    # Named, so the run can still say which artifact it could not read...
    assert artifact_id is not None
    # ...and cold, so the candidate is measured against rung 1 rather than the
    # run dying where it used to.
    assert comparator is None
