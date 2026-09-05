"""Two lanes, early and late: two experiments, gated apart, superseding once.

`docs/specs/forecaster.md`, "And the third option, which dissolves the trade",
and forecaster ticket 19. Five things are asserted here and they are the
ticket's five boxes:

1. each gate profile is a lane in its own right, with its own promotion history
   and its own incumbent;
2. both are gated on one schedule and **independently** — one lane's refusal,
   raise or empty retrain cannot stop the other promoting;
3. the evening publication supersedes the morning one as a newer vintage of the
   same valid hours, overwriting no row;
4. every published payload names the lane that produced it and when;
5. the two are never presented as comparable-but-one-is-worse.

**The fifth is the one that needed building.** The early lane is not a
worse-tuned copy of the late one: `docs/specs/feature-engineering.md` stamps the
ONS day-ahead programme at D−1 15:00 BRT, six hours after ``gate_early``, so
twelve of set A's seventy-eight model inputs are structurally NULL there — the
whole ``programmed_*`` family and the ``proxy_*`` residual-load family that
subtracts from it. Nothing here asserts an accuracy figure; every assertion is
about which attributes each lane may see and how that fact travels.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from conftest import FUNCTION_DEFINITION
from database_harness import run
from feature_row_fixtures import feature_rows
from wattsteer_ml.admissibility import (
    WITHHELD_REASONS,
    AdmissibilityError,
    LaneContrast,
    WithheldAtGateError,
    assert_nothing_withheld_was_seen,
    lane_vector,
    vector_for,
)
from wattsteer_ml.evaluation import Fold, FoldBlocks
from wattsteer_ml.evaluation.gate import (
    ContractDriftError,
    GateCheck,
    GateDecision,
    NoCandidate,
    PairedBootstrap,
)
from wattsteer_ml.evaluation.ladder import EXCEEDANCE_FEATURE
from wattsteer_ml.evaluation.serving_lanes import (
    EARLY_LANE,
    LATE_LANE,
    SERVING_LANES,
    LaneOutcome,
    ServingLanesError,
    ServingLanesReport,
    run_serving_lanes,
)
from wattsteer_ml.features import BRASILIA
from wattsteer_ml.lanes import Lane
from wattsteer_ml.model_inputs import MODEL_INPUTS
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionLog, PromotionRecord
from wattsteer_ml.promotions import append as append_decision
from wattsteer_ml.publication import (
    SERVED_ORIGIN_KIND,
    ForecastPublication,
    build_publication,
)
from wattsteer_ml.training import (
    LoadedArtifact,
    OutOfFoldPool,
    TrainedFold,
    train_fold,
)

NOW = datetime(2026, 9, 5, 3, 0, tzinfo=UTC)

#: The two lane directory names as `apps/api/src/jobs/publication.ts` spells
#: them. Read out of the TypeScript rather than restated: the worker's cron
#: entries name the lanes this module names, and a rename on one side that the
#: other did not follow is a lane nobody publishes into.
PUBLICATION_JOBS = (
    Path(__file__).resolve().parents[2] / "api" / "src" / "jobs" / "publication.ts"
)


def _published_lanes() -> dict[str, str]:
    text = PUBLICATION_JOBS.read_text(encoding="utf-8")
    block = re.search(r"PUBLICATION_LANES[^{]*\{(.*?)\}", text, re.DOTALL)
    assert block is not None, f"{PUBLICATION_JOBS} no longer declares PUBLICATION_LANES"
    return dict(re.findall(r'(gate_\w+):\s*"([^"]+)"', block.group(1)))


# --- box 1: two lanes, two promotion histories, two incumbents ---------------


def test_the_two_served_lanes_are_the_two_the_worker_publishes_into() -> None:
    """One spelling of each lane, checked against the cron entries that use it."""
    assert [lane.directory_name for lane in SERVING_LANES] == [
        "dessem_free_v1__gate_early__thr5",
        "dessem_free_v1__gate_late__thr5",
    ]
    published = _published_lanes()
    assert published == {lane.gate_profile: lane.directory_name for lane in SERVING_LANES}


def test_the_two_lanes_differ_in_nothing_but_the_gate() -> None:
    """One feature set, one threshold, two gates.

    Which is what makes the DESSEM question a question about the evening view
    alone: `dessem_augmented_v1` can only ever compete for `gate_late`, so the
    early view exists either way and a wrong DESSEM call is recoverable.
    """
    assert EARLY_LANE.feature_set == LATE_LANE.feature_set == "dessem_free_v1"
    assert EARLY_LANE.threshold_mw == LATE_LANE.threshold_mw == 5
    assert (EARLY_LANE.gate_profile, LATE_LANE.gate_profile) == (
        "gate_early",
        "gate_late",
    )
    assert EARLY_LANE != LATE_LANE


def test_each_lane_keeps_its_own_incumbent_in_one_log(tmp_path: Path) -> None:
    """One append-only file, two histories, and no crossing between them."""
    log = tmp_path / PROMOTION_LOG_FILENAME
    for lane, artifact in (
        (EARLY_LANE, "2026-09-01T09:10:00Z"),
        (LATE_LANE, "2026-09-01T19:10:00Z"),
        (EARLY_LANE, "2026-09-08T09:10:00Z"),
    ):
        append_decision(
            log,
            PromotionRecord(
                artifact_id=artifact,
                lane=lane,
                decision="promote",
                reason="bootstrap P = 0.94",
                at=NOW,
            ),
        )
    read = PromotionLog.read(log)
    assert read.promoted(EARLY_LANE) == "2026-09-08T09:10:00Z"
    assert read.promoted(LATE_LANE) == "2026-09-01T19:10:00Z"
    assert len(read.for_lane(EARLY_LANE)) == 2
    assert len(read.for_lane(LATE_LANE)) == 1
    assert set(read.lanes()) == {EARLY_LANE, LATE_LANE}


def test_a_rollback_in_one_lane_leaves_the_other_incumbent_where_it_was(
    tmp_path: Path,
) -> None:
    """A rollback is an append, and an append names exactly one lane."""
    log = tmp_path / PROMOTION_LOG_FILENAME
    for lane, artifact in (
        (EARLY_LANE, "2026-09-01T09:10:00Z"),
        (LATE_LANE, "2026-09-01T19:10:00Z"),
        (LATE_LANE, "2026-09-08T19:10:00Z"),
    ):
        append_decision(
            log,
            PromotionRecord(
                artifact_id=artifact,
                lane=lane,
                decision="promote",
                reason="bootstrap P = 0.94",
                at=NOW,
            ),
        )
    append_decision(
        log,
        PromotionRecord(
            artifact_id="2026-09-01T19:10:00Z",
            lane=LATE_LANE,
            decision="promote",
            reason="rollback of 2026-09-08T19:10:00Z",
            at=NOW,
            evidence={"rollback": True},
        ),
    )
    read = PromotionLog.read(log)
    assert read.promoted(LATE_LANE) == "2026-09-01T19:10:00Z"
    assert read.promoted(EARLY_LANE) == "2026-09-01T09:10:00Z"
    # Nothing was removed: the bad promotion is still readable.
    assert [record.artifact_id for record in read.for_lane(LATE_LANE)] == [
        "2026-09-01T19:10:00Z",
        "2026-09-08T19:10:00Z",
        "2026-09-01T19:10:00Z",
    ]


# --- box 2: one schedule, independent decisions ------------------------------


def _decision(lane: Lane, *, promote: bool) -> GateDecision:
    bootstrap = PairedBootstrap(
        kind="incumbent",
        days=90,
        hours=90 * 24,
        draws=2_000,
        seed=1,
        probability=0.95 if promote else 0.4,
        ties=0,
        candidate_qloss_mwh=1.0,
        comparator_qloss_mwh=2.0,
    )
    return GateDecision(
        artifact_id="2026-09-05T03:00:00Z",
        lane=lane,
        decision="promote" if promote else "refuse",
        reason="bootstrap P = 0.950" if promote else "bootstrap P = 0.400",
        at=NOW,
        checks=(
            GateCheck(name="paired_block_bootstrap", passed=promote, detail="as built"),
        ),
        comparator="incumbent",
        bootstrap=bootstrap,
    )


def test_one_lanes_refusal_does_not_block_the_others_promotion() -> None:
    """The whole point of two lanes: the morning view is not held hostage."""

    def gate_one(lane: Lane) -> GateDecision:
        return _decision(lane, promote=lane == EARLY_LANE)

    report = run_serving_lanes(gate_one, at=NOW)
    assert report.promoted == (EARLY_LANE,)
    assert report.for_lane(EARLY_LANE).status == "promoted"
    assert report.for_lane(LATE_LANE).status == "refused"


def test_a_lane_that_raises_does_not_stop_the_other() -> None:
    """Including the one raise the gate makes on purpose.

    `ContractDriftError` is raised *after* the refusal has been appended, so by
    the time this module sees it the evidence is already on the volume. What
    must not happen is the morning lane never running because the evening one
    found drift.
    """

    def gate_one(lane: Lane) -> GateDecision:
        if lane == EARLY_LANE:
            raise ContractDriftError("the live feature_rows definition moved")
        return _decision(lane, promote=True)

    report = run_serving_lanes(gate_one, at=NOW)
    early = report.for_lane(EARLY_LANE)
    assert early.status == "failed"
    assert early.failure is not None
    assert early.failure.startswith("ContractDriftError: ")
    assert report.promoted == (LATE_LANE,)


def test_a_lane_with_no_candidate_is_not_a_refusal_and_blocks_nothing() -> None:
    """A retrain that produced no artifact appends nothing and says why."""

    def gate_one(lane: Lane) -> GateDecision | NoCandidate:
        if lane == LATE_LANE:
            return NoCandidate.from_training_failure(
                ValueError("no split of the pool satisfies the rule"),
                lane=lane,
                at=NOW,
            )
        return _decision(lane, promote=True)

    report = run_serving_lanes(gate_one, at=NOW)
    late = report.for_lane(LATE_LANE)
    assert late.status == "no_candidate"
    assert late.no_candidate is not None
    assert late.as_dict()["artifact_id"] is None
    assert late.no_candidate.as_dict()["appended_to_promotion_log"] is False
    assert report.promoted == (EARLY_LANE,)


def test_every_lane_asked_for_takes_exactly_one_turn() -> None:
    """A batch that abandoned a lane cannot be reported as a batch of both."""

    def gate_one(lane: Lane) -> GateDecision:
        return _decision(lane, promote=True)

    report = run_serving_lanes(gate_one, at=NOW)
    assert [outcome.lane for outcome in report.outcomes] == list(SERVING_LANES)
    with pytest.raises(ServingLanesError, match="was asked for twice"):
        run_serving_lanes(gate_one, at=NOW, lanes=(EARLY_LANE, EARLY_LANE))


def test_an_outcome_cannot_be_filed_under_the_wrong_lane() -> None:
    with pytest.raises(ServingLanesError, match="the decision filed here is about"):
        LaneOutcome(
            lane=EARLY_LANE,
            vector=lane_vector(EARLY_LANE),
            status="promoted",
            decision=_decision(LATE_LANE, promote=True),
        )


def test_an_outcome_carries_exactly_the_evidence_its_status_names() -> None:
    with pytest.raises(ServingLanesError, match="carries 'failure' and nothing else"):
        LaneOutcome(
            lane=EARLY_LANE,
            vector=lane_vector(EARLY_LANE),
            status="failed",
            decision=_decision(EARLY_LANE, promote=True),
        )


# --- box 5: the two are different experiments, and every surface says so -----


def test_the_early_gate_withholds_the_programme_and_its_proxies() -> None:
    """Twelve of set A's seventy-eight inputs, and they are these twelve."""
    early = vector_for(feature_set="dessem_free_v1", gate_profile="gate_early")
    assert early.input_count == 78
    assert len(early.admitted) == 66
    assert early.withheld_names == (
        "programmed_load_mwh",
        "programmed_load_ramp_1h",
        "programmed_load_mean_3h",
        "programmed_load_daily_min_mwh",
        "programmed_load_rank_in_day",
        "proxy_residual_load_mwh",
        "proxy_residual_load_ratio",
        "proxy_renewable_load_ratio",
        "proxy_vre_surplus_mwh",
        "proxy_residual_load_ramp_1h",
        "proxy_residual_load_min_of_day",
        "proxy_residual_load_rank_in_day",
    )


def test_the_late_gate_withholds_nothing_from_either_set() -> None:
    """Which is why both A/Bs are decided there."""
    for feature_set in ("dessem_free_v1", "dessem_augmented_v1"):
        late = vector_for(feature_set=feature_set, gate_profile="gate_late")
        assert late.withheld == ()
        assert len(late.admitted) == late.input_count


def test_the_two_reasons_a_column_is_withheld_are_kept_apart() -> None:
    """DESSEM's absence is structural; the programme's is a publication instant.

    `docs/specs/feature-engineering.md`: "the two reasons are different". One of
    them could be settled by an earlier observed publication and the other never
    can, so folding them together would send a reader looking for a fix to the
    half that has none.
    """
    early = vector_for(feature_set="dessem_augmented_v1", gate_profile="gate_early")
    structural = early.withheld_for("structural")
    lagged = early.withheld_for("publication_lag")
    assert len(early.withheld) == 34
    assert len(structural) == 22
    assert len(lagged) == 12
    assert all(name.startswith("dessem_") for name in structural)
    assert all(name.startswith(("programmed_", "proxy_")) for name in lagged)
    assert "15:00 BRT" in WITHHELD_REASONS["publication_lag"]
    assert "11:53 BRT" in WITHHELD_REASONS["publication_lag"]


def test_a_lane_vector_partitions_every_model_input_and_loses_none() -> None:
    ordered = tuple(
        item.column_name for item in MODEL_INPUTS.inputs_for("dessem_free_v1")
    )
    early = vector_for(feature_set="dessem_free_v1", gate_profile="gate_early")
    assert set(early.admitted) | set(early.withheld_names) == set(ordered)
    assert early.input_count == len(ordered)
    # Attribute order is the composite type's, which is the order feature_hash
    # is taken in; nothing here reorders it.
    assert early.admitted == tuple(
        name for name in ordered if name not in set(early.withheld_names)
    )


def test_an_unknown_gate_profile_admits_nothing_rather_than_everything() -> None:
    with pytest.raises(AdmissibilityError, match="is not a gate profile"):
        vector_for(feature_set="dessem_free_v1", gate_profile="gate_midday")


def test_an_unknown_feature_set_says_which_sets_exist() -> None:
    with pytest.raises(Exception, match="is not a feature set"):
        vector_for(feature_set="dessem_speculative_v9", gate_profile="gate_late")


def test_the_census_says_the_morning_lane_is_a_different_experiment() -> None:
    """The headline the card carries, in as many words."""
    early = lane_vector(EARLY_LANE)
    assert "different experiment" in early.headline
    assert "worse-tuned" in early.headline
    fields = early.card_fields()
    assert fields["admitted"] == 66
    assert fields["model_inputs"] == 78
    assert set(fields["withheld_reasons"]) == {"publication_lag"}


def test_the_late_lanes_census_claims_no_handicap() -> None:
    late = lane_vector(LATE_LANE)
    assert late.card_fields()["withheld"] == []
    assert late.card_fields()["withheld_reasons"] == {}
    assert "all 78 model inputs are available" in late.headline


def test_a_contrast_is_between_two_gates_and_never_one() -> None:
    early = lane_vector(EARLY_LANE)
    late = lane_vector(LATE_LANE)
    with pytest.raises(AdmissibilityError, match="both of these are gate_late"):
        LaneContrast(early=late, late=late)
    with pytest.raises(AdmissibilityError, match="the early side of a contrast"):
        LaneContrast(early=late, late=early)


def test_the_contrast_names_what_the_evening_view_has_and_the_morning_does_not() -> None:
    contrast = LaneContrast(early=lane_vector(EARLY_LANE), late=lane_vector(LATE_LANE))
    assert len(contrast.withheld_from_early) == 12
    assert contrast.same_experiment is False
    payload = contrast.as_dict()
    assert payload["same_experiment"] is False
    assert "two experiments, not one model published twice" in payload["note"]
    assert "not a statement about either model's quality" in payload["note"]


def test_the_report_cannot_hand_over_both_lanes_without_the_contrast() -> None:
    """The only shape that holds both lanes carries why they are not one."""

    def gate_one(lane: Lane) -> GateDecision:
        return _decision(lane, promote=True)

    payload = run_serving_lanes(gate_one, at=NOW).as_dict()
    assert payload["contrast"]["same_experiment"] is False
    assert len(payload["contrast"]["withheld_from_early"]) == 12
    assert [entry["experiment"]["admitted"] for entry in payload["lanes"]] == [66, 78]


def test_a_one_lane_report_refuses_to_produce_a_contrast() -> None:
    report = ServingLanesReport(
        at=NOW,
        outcomes=(LaneOutcome.of(LATE_LANE, _decision(LATE_LANE, promote=True)),),
    )
    with pytest.raises(ServingLanesError, match="needs both gate profiles"):
        report.contrast()


# --- the leak the ticket is shaped by ----------------------------------------


def test_a_withheld_attribute_carrying_a_value_at_the_early_gate_is_refused() -> None:
    """The leak, at the one moment it is detectable.

    A `gate_early` artifact whose `programmed_load_mwh` column is populated has
    been fitted on a number it will not have at 09:00.
    """
    rates = {name: 1.0 for name in lane_vector(EARLY_LANE).withheld_names}
    assert assert_nothing_withheld_was_seen(EARLY_LANE, rates) == tuple(rates)
    rates["programmed_load_mwh"] = 0.0
    with pytest.raises(WithheldAtGateError, match="programmed_load_mwh") as raised:
        assert_nothing_withheld_was_seen(EARLY_LANE, rates)
    assert raised.value.columns == ("programmed_load_mwh",)


def test_one_value_in_one_row_is_enough_to_refuse() -> None:
    """The question is not how much, it is at all."""
    rates = {name: 1.0 for name in lane_vector(EARLY_LANE).withheld_names}
    rates["proxy_residual_load_mwh"] = 0.999
    with pytest.raises(WithheldAtGateError):
        assert_nothing_withheld_was_seen(EARLY_LANE, rates)


def test_the_late_lane_has_nothing_to_withhold_and_so_nothing_to_check() -> None:
    assert assert_nothing_withheld_was_seen(LATE_LANE, {"programmed_load_mwh": 0.0}) == ()


def test_a_withheld_name_the_rows_do_not_carry_is_skipped_not_assumed() -> None:
    """The fixtures mirror part of the composite type; a check over a column
    they do not have would be asserting a fact about the migration tree from
    inside a unit test."""
    assert assert_nothing_withheld_was_seen(EARLY_LANE, {}) == ()


# --- the cold start, re-checked ----------------------------------------------


def test_rung_ones_occurrence_feature_is_now_a_model_input() -> None:
    """Forecaster 13 found a cold start promoting nothing, and why.

    Rung 1's occurrence head reads
    ``observed_constrained_off_same_hour_exceedance_7d``, which the migration
    tree did not emit — so an empty lane had no bar to clear.
    Feature-engineering 14 landed it as the 112th attribute of ``feature_row``
    (`apps/api/drizzle/0036_the_same_hour_exceedance.sql`), and the generated
    model-input artifact now carries it for both feature sets and at both gates.
    The cold start is therefore re-checkable — against a migrated database.
    """
    assert MODEL_INPUTS.feature_row_attributes == 112
    for feature_set in ("dessem_free_v1", "dessem_augmented_v1"):
        entry = next(
            item
            for item in MODEL_INPUTS.inputs_for(feature_set)
            if item.column_name == EXCEEDANCE_FEATURE
        )
        assert entry.available_at_gate_early is True
        assert entry.class_label == "K"
    # It is a lagged actual behind `actuals_cutoff`, so the morning lane has it
    # too: the early lane's handicap is the programme, not its own history.
    assert EXCEEDANCE_FEATURE in lane_vector(EARLY_LANE).admitted


# --- boxes 3 and 4: a newer vintage of the same hours, and it says whose ------


#: Which gate a fixture row is stamped at, and the local hour of that gate.
#: `apps/api/drizzle/0016_the_feature_gate.sql`'s ``gate_at`` is the authority;
#: this restates only the two hours, so that a fixture can be re-stamped without
#: a database.
GATE_HOURS = {"gate_early": 9, "gate_late": 19}


def _at_gate(
    rows: Sequence[dict[str, Any]], *, gate_profile: str
) -> list[dict[str, Any]]:
    """The same rows, stamped at the other gate.

    The fixture mirrors the composite type as of `0019` and carries none of the
    programme or proxy columns, so a re-stamp is the whole of the difference a
    fixture can express — it cannot *withhold* a column it never had. That is
    stated rather than worked around: the census tests above are what assert
    which columns each gate withholds, and these two assert what a publication
    at each gate looks like.
    """
    hour = GATE_HOURS[gate_profile]
    restamped: list[dict[str, Any]] = []
    for row in rows:
        gate_at = datetime.combine(
            row["target_date"] - timedelta(days=1), time(hour=hour), tzinfo=BRASILIA
        ).astimezone(UTC)
        restamped.append({**row, "gate_profile": gate_profile, "gate_at": gate_at})
    return restamped


@pytest.fixture(scope="module")
def morning(
    rows: Sequence[dict[str, Any]], fold: Fold, blocks: FoldBlocks, pool: OutOfFoldPool
) -> TrainedFold:
    """A second artifact, fitted for the morning lane. Not a re-badged evening one.

    ``train_fold`` reads the lane off the rows' own stamps, so re-stamping the
    training rows at ``gate_early`` is what makes this a `gate_early` artifact —
    and `build_publication` refuses a bundle whose lane is not the publication's,
    which is what makes it necessary rather than tidy.
    """
    return train_fold(
        _at_gate(rows, gate_profile="gate_early"),
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
        pool=pool,
        artifact_id="2026-08-29T09:10:00Z",
        created_at=None,
    )


@pytest.fixture(scope="module")
def target_day(trained: TrainedFold) -> date:
    return trained.blocks.test_end + timedelta(days=1)


def _loaded(fitted: TrainedFold) -> LoadedArtifact:
    return LoadedArtifact(
        artifact_id=fitted.card.artifact_id,
        bundle=fitted.bundle,
        card=fitted.card.to_dict(),
    )


@pytest.fixture(scope="module")
def two_vintages(
    target_day: date, morning: TrainedFold, trained: TrainedFold
) -> tuple[ForecastPublication, ForecastPublication]:
    rows = feature_rows(first=target_day, last=target_day)
    return (
        build_publication(
            _at_gate(rows, gate_profile="gate_early"),
            lane=EARLY_LANE,
            loaded=_loaded(morning),
            target_date=target_day,
            origin_kind=SERVED_ORIGIN_KIND,
        ),
        build_publication(
            _at_gate(rows, gate_profile="gate_late"),
            lane=LATE_LANE,
            loaded=_loaded(trained),
            target_date=target_day,
            origin_kind=SERVED_ORIGIN_KIND,
        ),
    )


def test_the_two_artifacts_are_two_lanes_and_two_cards(
    morning: TrainedFold, trained: TrainedFold
) -> None:
    """Box 1, end to end: each gate profile has a card of its own.

    And the two cards do not read as one model published twice — each carries
    the census of what its own gate lets it see, beside the
    ``unpopulated_features`` list that cannot tell a gate's NULL from an
    ingestion's.
    """
    assert morning.bundle.lane == EARLY_LANE
    assert trained.bundle.lane == LATE_LANE
    early = morning.card.to_dict()["lane"]
    late = trained.card.to_dict()["lane"]
    assert isinstance(early, dict) and isinstance(late, dict)
    assert early["directory"] == EARLY_LANE.directory_name
    assert late["directory"] == LATE_LANE.directory_name
    assert early["experiment"]["admitted"] == 66
    assert late["experiment"]["admitted"] == 78
    assert "different experiment" in early["experiment"]["headline"]
    assert late["experiment"]["withheld"] == []


def test_the_evening_publication_is_a_newer_vintage_of_the_same_valid_hours(
    two_vintages: tuple[ForecastPublication, ForecastPublication],
) -> None:
    """Same day, same hours, two instants — no row is overwritten.

    The database's own primary key is the guarantee: `gate_profile` is a key
    column of `curtailment_forecast_hour`
    (`apps/api/drizzle/0034_the_published_forecast.sql`), so the evening rows
    land beside the morning ones rather than on top of them. What is asserted
    here is the half this service owns: the two publications name the same valid
    hours and different publication instants, in the right order.
    """
    morning, evening = two_vintages
    assert morning.target_date == evening.target_date
    assert [hour.valid_time for hour in morning.hours] == [
        hour.valid_time for hour in evening.hours
    ]
    assert morning.published_at < evening.published_at
    assert evening.published_at - morning.published_at == timedelta(hours=10)
    assert morning.published_at < min(hour.valid_time for hour in morning.hours)


def test_a_morning_and_an_evening_answer_can_never_be_confused(
    two_vintages: tuple[ForecastPublication, ForecastPublication],
) -> None:
    """Every payload names its lane, its gate and its instant.

    The lane is the triple, so `feature_set` + `gate_profile` + `threshold_mw`
    on the payload determine it even where the directory name is not printed —
    and the directory name is printed too.
    """
    for publication, lane in zip(two_vintages, (EARLY_LANE, LATE_LANE), strict=True):
        payload = publication.as_payload()
        assert payload["lane"] == lane.directory_name
        assert payload["gate_profile"] == lane.gate_profile
        assert payload["feature_set"] == lane.feature_set
        assert payload["threshold_mw"] == lane.threshold_mw
        origin = payload["forecast_origin"]
        assert isinstance(origin, dict)
        assert origin["gate_profile"] == lane.gate_profile
        assert origin["run_label"] == publication.artifact_id
        assert origin["published_at"] == publication.published_at.isoformat()
        assert (
            Lane(
                feature_set=str(payload["feature_set"]),
                gate_profile=str(payload["gate_profile"]),
                threshold_mw=float(str(payload["threshold_mw"])),
            )
            == lane
        )


# --- against a migrated database ---------------------------------------------
#
# The facts above that came out of a generated file, checked against the thing
# that generated it. `database_harness.py` has the recipe; without
# `WATTSTEER_TEST_DATABASE_URL` these skip.


def test_the_census_agrees_with_the_live_feature_dictionary() -> None:
    """The artifact is `feature_set_model_inputs(set)` serialised — so say so.

    Every number this module publishes — 78 inputs, 66 admitted at the early
    gate, 12 withheld — comes from a file on disk. This is the test that binds
    the file to the catalogue it claims to be a copy of, name by name and flag
    by flag, so a regenerated artifact that lost the gate column fails here
    rather than quietly widening what the morning lane may see.
    """

    async def check(conn: asyncpg.Connection[Any]) -> None:
        for feature_set in ("dessem_free_v1", "dessem_augmented_v1"):
            rows = await conn.fetch(
                "select column_name, available_at_gate_early "
                "from feature_set_model_inputs($1)",
                feature_set,
            )
            live = [(row["column_name"], row["available_at_gate_early"]) for row in rows]
            assert live == [
                (item.column_name, item.available_at_gate_early)
                for item in MODEL_INPUTS.inputs_for(feature_set)
            ]

    run(check)


def test_the_live_dictionary_withholds_exactly_what_the_early_lane_does() -> None:
    async def check(conn: asyncpg.Connection[Any]) -> None:
        rows = await conn.fetch(
            "select column_name from feature_set_model_inputs($1) "
            "where not available_at_gate_early",
            EARLY_LANE.feature_set,
        )
        assert tuple(row["column_name"] for row in rows) == (
            lane_vector(EARLY_LANE).withheld_names
        )

    run(check)


def test_rung_ones_occurrence_feature_is_in_the_live_feature_row() -> None:
    """Forecaster 13's cold start, re-checked against the migration tree.

    `cold_start_baseline` raises `MissingBaselineFeatureError` when the contract
    does not carry `observed_constrained_off_same_hour_exceedance_7d`, and that
    was the state of the live feature function when forecaster 13 landed — so an
    empty lane promoted nothing. `0036_the_same_hour_exceedance.sql` added it as
    the 112th attribute. This asserts the column is on `feature_row` now, which
    is the fact that caveat turned on; whether a cold start *promotes* is still a
    question about data, and no test here answers it.
    """

    async def check(conn: asyncpg.Connection[Any]) -> None:
        attributes = await conn.fetch(
            # `feature_row` is a composite type, so its attributes hang off
            # `pg_type.typrelid` rather than off the type's own oid.
            "select attname from pg_attribute "
            "where attrelid = (select typrelid from pg_type "
            "where oid = 'feature_row'::regtype) "
            "and attnum > 0 and not attisdropped order by attnum"
        )
        names = [row["attname"] for row in attributes]
        assert EXCEEDANCE_FEATURE in names
        assert len(names) == MODEL_INPUTS.feature_row_attributes

    run(check)
