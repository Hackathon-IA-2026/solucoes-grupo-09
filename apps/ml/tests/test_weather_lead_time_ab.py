"""The weather lead-time A/B, and the place it insists on measuring.

`docs/specs/forecaster.md`, "The weather lead-time A/B". The ticket's title is
the whole requirement: *measured where the harm was predicted*. The research
predicts ``Δ qloss_mwh`` is the smaller effect and that the real harm lands in
``Δ coverage_p10``, ``Δ coverage_p90``, ``Δ interval_width_mean_mwh`` and
``Δ delta_lo``. So the property this file is mostly about is not an arithmetic
one: it is that an A/B **cannot be reported point-only**, and that a segment
which cannot produce coverage cannot produce a lead-time row at all.

**Everything here is fabricated, and every block written says so in capitals.**
The three columns are three :class:`~wattsteer_ml.evaluation.metrics.MetricsRow`
objects over composed bands — real mixture inversions over invented
probabilities — because the machinery under test is the comparison and not the
forecast. That is also why the archive columns are *worse in the interval and
better in the point metric* in :func:`columns`: it is the shape the research
predicts, arranged deliberately so that a comparison which only looked at
``qloss_mwh`` would draw the opposite conclusion and this file would catch it.

**The fold calendar is the real one.** ``F1`` is materialised from
`fold_calendar.yaml` rather than invented, so the row-identity assertion the
comparison rests on is being run against the calendar the rest of the matrix
uses.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation.collapse_report import FIXTURE_SOURCE, UNMEASURED_SOURCE
from wattsteer_ml.evaluation.folds import Fold, materialize_fold_calendar
from wattsteer_ml.evaluation.lead_time import (
    ARCHIVE_NOT_INGESTED,
    CADENCE,
    COLUMN_DEFINITIONS,
    COLUMNS,
    CONTROL_COLUMN,
    CORRELATION_VARIABLE,
    EXPERIMENT_FEATURE_SET,
    EXPERIMENT_GATE_PROFILE,
    FOLD_EVALUATION_SOURCE,
    LEAD_TIME_BLOCK_KEY,
    NOT_ACHIEVABLE_COLUMN,
    PER_POINT_R,
    REVISION_THRESHOLD,
    SERVED_COLUMN,
    WEATHER_SERIES_SOURCE,
    AggregateCorrelation,
    ArmColumn,
    CapacityWeights,
    ColumnDelta,
    LeadTimeColumn,
    LeadTimeError,
    LeadTimePenalty,
    LeadTimeProvenance,
    LeadTimeReport,
    capacity_weighted_aggregate,
    carry_forward,
    pearson_r,
    record_lead_time_penalty,
    unmeasured_for_want_of_an_archive,
)
from wattsteer_ml.evaluation.matrix import (
    MATRIX_RUN_BY_NAME,
    RowIdentityError,
    RowKey,
    ScoredFold,
    expected_test_rows,
)
from wattsteer_ml.evaluation.metrics import MetricsRow
from wattsteer_ml.evaluation.vintage import FoldSegment, stamp_fidelity
from wattsteer_ml.lanes import Lane
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.conformal import (
    NOMINAL_MISCOVERAGE,
    ConformalCorrection,
    ScoredHour,
)
from wattsteer_ml.training.hurdle import HourEstimates, compose_estimates

HOURS_PER_DAY = 24
THRESHOLD_MW = 5.0
AS_OF = datetime(2026, 8, 29, 4, 0, tzinfo=UTC)
RUN_LABEL = "lead-time-ab-2026-08-29"
ARTIFACT_ID = "2026-08-29T04:00:00Z"

LANE = Lane(
    feature_set=EXPERIMENT_FEATURE_SET,
    gate_profile=EXPERIMENT_GATE_PROFILE,
    threshold_mw=THRESHOLD_MW,
)

#: ``μ_sub`` as zeros: the sub-threshold mean moves the expectation without
#: moving a quantile, and nothing in this file reads the expectation.
FLAT_MU_SUB = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(HOURS_PER_DAY)) for _ in SUBSYSTEM_CODES)
)


def first_fold() -> Fold:
    """``F1`` of the real calendar, not an invented one."""
    return materialize_fold_calendar(date(2026, 8, 29)).folds[0]


def segment_of(fold: Fold) -> FoldSegment:
    """``F1`` stamped, with go-live after it — one unsplit revision-optimistic row."""
    segments = stamp_fidelity(fold, datetime(2026, 8, 1, tzinfo=UTC))
    assert len(segments) == 1
    return segments[0]


def hours_in(
    segment: FoldSegment,
    observations: Sequence[tuple[float, float, float, float, float]],
) -> tuple[ScoredHour, ...]:
    """Scored hours from ``(p, q10, q50, q90, observed)``, inside the segment.

    Composed through :func:`~wattsteer_ml.training.hurdle.compose_estimates`, so
    the bands the metrics are computed over are the bands the product builds.
    """
    keys: list[RowKey] = []
    day = segment.test_start
    while len(keys) < len(observations):
        for hour in range(HOURS_PER_DAY):
            for code in SUBSYSTEM_CODES:
                if len(keys) < len(observations):
                    keys.append(RowKey(target_date=day, local_hour=hour, subsystem=code))
        day += timedelta(days=1)
    composed = compose_estimates(
        keys,
        [
            HourEstimates(
                occurrence_probability=p,
                q10=q10,
                q50=q50,
                q90=q90,
                positive_mean_mwh=q50,
            )
            for p, q10, q50, q90, _ in observations
        ],
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=THRESHOLD_MW,
    )
    return tuple(
        ScoredHour(key=hour.key, forecast=hour.forecast, observed_mwh=observed)
        for hour, (_, _, _, _, observed) in zip(composed, observations, strict=True)
    )


def correction(fold: Fold, *, delta_lo: float, delta_hi: float) -> ConformalCorrection:
    return ConformalCorrection(
        delta_lo=delta_lo,
        delta_hi=delta_hi,
        calibration_rows=400,
        rank=361,
        miscoverage=NOMINAL_MISCOVERAGE,
        window_start=fold.calibration_start,
        window_end=fold.calibration_end,
    )


#: The served arm: a wide, well-covering band.
WIDE = [(0.95, 6.0, 20.0, 60.0, 22.0), (0.95, 6.0, 18.0, 55.0, 8.0)] * 12

#: The archive arms: **narrower** bands that under-cover, which is exactly the
#: shape the research predicts, and a *better* point score, which is exactly the
#: shape that would fool a point-only comparison.
NARROW = [(0.95, 14.0, 21.0, 30.0, 22.0), (0.95, 14.0, 19.0, 28.0, 8.0)] * 12

#: The not-achievable column: narrow *and* accurate, because evaluated on the
#: archive features it was trained on, the archive model looks better than it
#: can ever be in production. It is the flattering number the research exists to
#: prevent, and it is arranged here to flatter.
NARROWEST = [(0.95, 19.0, 22.0, 25.0, 22.0), (0.95, 6.0, 8.5, 11.0, 8.0)] * 12


def column(
    name: LeadTimeColumn,
    observations: Sequence[tuple[float, float, float, float, float]],
    *,
    fold: Fold,
    segment: FoldSegment,
    delta_lo: float,
    delta_hi: float,
    rows: Sequence[RowKey] | None = None,
) -> ArmColumn:
    scored = hours_in(segment, observations)
    return ArmColumn(
        column=name,
        metrics=MetricsRow.of(
            scored,
            run=COLUMN_DEFINITIONS[name].matrix_run or name,
            rung="lightgbm",
            rung_number=4,
            segment=segment,
            conformalised=True,
            correction=correction(fold, delta_lo=delta_lo, delta_hi=delta_hi),
        ),
        scored=ScoredFold.of(
            run=name,
            fold=fold,
            rows=(
                rows
                if rows is not None
                else expected_test_rows(segment.test_start, segment.test_end)
            ),
        ),
    )


def columns(fold: Fold, segment: FoldSegment) -> list[ArmColumn]:
    """The three columns, arranged as the research predicts them.

    The archive arms score *better* on ``qloss_mwh`` and *worse* on coverage and
    width. A comparison that only read the point metric would report an
    improvement from training on the archive, which is the exact conclusion this
    experiment exists to prevent.
    """
    return [
        column(
            SERVED_COLUMN, WIDE, fold=fold, segment=segment, delta_lo=2.0, delta_hi=3.0
        ),
        column(
            CONTROL_COLUMN,
            NARROW,
            fold=fold,
            segment=segment,
            delta_lo=5.5,
            delta_hi=6.0,
        ),
        column(
            NOT_ACHIEVABLE_COLUMN,
            NARROWEST,
            fold=fold,
            segment=segment,
            delta_lo=6.5,
            delta_hi=7.0,
        ),
    ]


def penalty() -> LeadTimePenalty:
    fold = first_fold()
    seg = segment_of(fold)
    return LeadTimePenalty.of(seg, columns(fold, seg))


def report(**kwargs: object) -> LeadTimeReport:
    return LeadTimeReport(
        provenance=LeadTimeProvenance.fixture(lane=LANE),
        penalties=(penalty(),),
        **kwargs,  # type: ignore[arg-type]
    )


# --- the shape of the experiment ---------------------------------------------


def test_the_two_arms_are_evaluated_on_identical_lead_matched_rows() -> None:
    """The first box: one evaluation set, asserted by digest and not by count.

    Every column carries a :class:`ScoredFold`, and
    :meth:`LeadTimePenalty.of` runs the matrix's own
    :func:`assert_identical_test_rows` over all three before differencing
    anything. The digest it returns is the penalty's, so a penalty cannot name a
    row set it did not check.
    """
    block = penalty()
    digests = {entry.scored.row_digest for entry in block.columns}
    assert len(digests) == 1
    assert block.row_digest == digests.pop()
    assert block.row_digest.startswith("sha256:")


def test_a_column_scored_on_other_rows_is_refused() -> None:
    """One missing hour, same count in every other respect. Caught by hash."""
    fold = first_fold()
    seg = segment_of(fold)
    full = expected_test_rows(seg.test_start, seg.test_end)
    shifted = (*full[1:], RowKey(seg.test_end + timedelta(days=1), 0, "NE"))
    three = columns(fold, seg)
    three[1] = column(
        CONTROL_COLUMN,
        NARROW,
        fold=fold,
        segment=seg,
        delta_lo=5.5,
        delta_hi=6.0,
        rows=shifted,
    )
    assert len(shifted) == len(full)
    with pytest.raises(RowIdentityError, match="different rows"):
        LeadTimePenalty.of(seg, three)


def test_the_third_column_is_reported_and_labelled_not_achievable() -> None:
    """The second box, both halves: the column exists and the label says so."""
    definition = COLUMN_DEFINITIONS[NOT_ACHIEVABLE_COLUMN]
    assert definition.achievable is False
    assert "NOT ACHIEVABLE" in definition.label
    assert definition.evaluates_on == "archive"
    entry = penalty().column(NOT_ACHIEVABLE_COLUMN).card_entry()
    assert entry["achievable"] is False
    assert entry["label"] == definition.label


def test_the_not_achievable_column_is_not_a_row_of_the_ab_matrix() -> None:
    """It is scored on features serving never provides, so it is not a run.

    :class:`~wattsteer_ml.evaluation.matrix.MatrixRun` has no field for what a
    run is evaluated on precisely so a run cannot hold a private view of what it
    is scored on. Widening it for this column would weaken that invariant for
    every other row of the matrix, so the column lives here instead.
    """
    assert COLUMN_DEFINITIONS[NOT_ACHIEVABLE_COLUMN].matrix_run is None
    for name in (SERVED_COLUMN, CONTROL_COLUMN):
        run = COLUMN_DEFINITIONS[name].matrix_run
        assert run is not None
        assert MATRIX_RUN_BY_NAME[run].weather_arm == COLUMN_DEFINITIONS[name].trains_on
        assert MATRIX_RUN_BY_NAME[run].gate_profile == EXPERIMENT_GATE_PROFILE
        assert MATRIX_RUN_BY_NAME[run].feature_set == EXPERIMENT_FEATURE_SET


def test_the_gap_between_the_two_archive_columns_is_stated() -> None:
    """The leak, in the product's own metric, as its own named delta.

    Both archive columns share a training source and differ only in what they
    were evaluated on, so their difference is the size of the leak and nothing
    else.
    """
    block = penalty()
    assert block.leak.of == NOT_ACHIEVABLE_COLUMN
    assert block.leak.against == CONTROL_COLUMN
    archive_to_archive = block.column(NOT_ACHIEVABLE_COLUMN).metrics
    archive_to_lead = block.column(CONTROL_COLUMN).metrics
    assert block.leak.delta_qloss_mwh == pytest.approx(
        archive_to_archive.qloss_mwh - archive_to_lead.qloss_mwh
    )
    assert block.card_entry()["leak"]["delta_qloss_mwh"] == block.leak.delta_qloss_mwh
    assert block.leak.delta_qloss_mwh < 0.0, (
        "the not-achievable column is the flattering one — that is what makes its "
        "distance from the control the size of the leak"
    )


def test_the_ab_answer_is_the_control_against_the_served_arm() -> None:
    """``harm`` is ``archive → lead-matched`` minus ``lead-matched``.

    Both evaluated on what serving provides, which is the entire point of the
    control's construction.
    """
    block = penalty()
    assert block.harm.of == CONTROL_COLUMN
    assert block.harm.against == SERVED_COLUMN
    for name in (block.harm.of, block.harm.against):
        assert COLUMN_DEFINITIONS[name].evaluates_on == "lead_matched"


# --- measured where the harm was predicted -----------------------------------


def test_the_interval_metrics_are_reported_per_arm_not_only_qloss() -> None:
    """The third box: every column publishes both coverages, width and both δ."""
    for entry in penalty().columns:
        published = entry.card_entry()
        for field in (
            "qloss_mwh",
            "coverage_p10",
            "coverage_p90",
            "interval_width_mean_mwh",
            "delta_lo",
            "delta_hi",
        ):
            assert isinstance(published[field], float), field


def test_a_delta_cannot_be_reported_without_its_interval_half() -> None:
    """The ticket's title, enforced by the type.

    :class:`ColumnDelta` has no constructor that omits :class:`IntervalHarm`, so
    an aggregate improvement cannot be published without the figures that say
    whether the harm the research named actually moved.
    """
    with pytest.raises(TypeError):
        ColumnDelta(  # type: ignore[call-arg]
            of=CONTROL_COLUMN, against=SERVED_COLUMN, delta_qloss_mwh=-0.4
        )


def test_a_point_only_improvement_does_not_read_as_no_harm() -> None:
    """The failure mode the whole ticket is about, in one assertion.

    The fixture's archive arm is *better* on ``qloss_mwh``. A comparison that
    stopped there would report training on the archive as an improvement. The
    interval half says the opposite, and the verdict is written from the
    interval half alone.
    """
    harm = penalty().harm
    assert harm.delta_qloss_mwh < 0.0, "the fixture's point metric flatters the archive"
    assert harm.interval.coverage_degraded
    assert harm.interval.intervals_narrowed
    assert harm.interval.needs_more_correction
    assert harm.interval.landed_here
    assert "landed where the research predicted" in harm.verdict


def test_delta_delta_lo_is_the_amount_the_interval_was_wrong_by() -> None:
    """The cleanest single expression of the effect, and its direction.

    Positive is the predicted direction: the archive arm needs *more* conformal
    correction, and the correction is literally the MWh by which the interval
    was wrong.
    """
    block = penalty()
    assert block.harm.interval.delta_delta_lo == pytest.approx(
        block.column(CONTROL_COLUMN).delta_lo - block.column(SERVED_COLUMN).delta_lo
    )
    assert block.harm.interval.delta_delta_lo > 0.0


def test_coverage_not_degrading_is_a_finding_and_not_a_pass() -> None:
    """If the errors-in-variables argument did not survive, the block says so.

    The ticket names this outcome as worth knowing rather than as a failure, so
    the verdict is a sentence either way and nothing here raises.
    """
    fold = first_fold()
    seg = segment_of(fold)
    three = columns(fold, seg)
    three[1] = column(
        CONTROL_COLUMN, WIDE, fold=fold, segment=seg, delta_lo=2.0, delta_hi=3.0
    )
    harm = LeadTimePenalty.of(seg, three).harm
    assert harm.interval.landed_here is False
    assert "did not survive the move to" in harm.verdict
    assert report().harm_landed_where_predicted == (seg.row_id,)


def test_a_segment_that_cannot_produce_coverage_produces_no_row() -> None:
    """No curtailed hour means the prediction under test is unmeasurable.

    A point-only row on such a segment would read as though the interval claim
    had been tested and found unmoved, which is the one misreading this module
    exists to prevent.
    """
    fold = first_fold()
    seg = segment_of(fold)
    quiet = [(0.02, 0.0, 0.0, 0.0, 0.0)] * 24
    three = columns(fold, seg)
    three[1] = column(
        CONTROL_COLUMN, quiet, fold=fold, segment=seg, delta_lo=5.5, delta_hi=6.0
    )
    assert three[1].metrics.coverage is None
    with pytest.raises(LeadTimeError, match="interval harm"):
        LeadTimePenalty.of(seg, three)


def test_an_unconformalised_column_is_not_one_of_the_arms() -> None:
    """No ``δ_lo`` means no ``Δ delta_lo``, and no comparison."""
    fold = first_fold()
    seg = segment_of(fold)
    bare = ArmColumn(
        column=CONTROL_COLUMN,
        metrics=MetricsRow.of(
            hours_in(seg, NARROW),
            run="A-full-archive",
            rung="lightgbm",
            rung_number=4,
            segment=seg,
        ),
        scored=ScoredFold.of(
            run=CONTROL_COLUMN,
            fold=fold,
            rows=expected_test_rows(seg.test_start, seg.test_end),
        ),
    )
    three = columns(fold, seg)
    three[1] = bare
    with pytest.raises(LeadTimeError, match="conformal delta_lo"):
        LeadTimePenalty.of(seg, three)


def test_a_comparison_missing_the_third_column_is_refused() -> None:
    """Two columns is an A/B without a leak size, and the spec asks for three."""
    fold = first_fold()
    seg = segment_of(fold)
    with pytest.raises(LeadTimeError, match=NOT_ACHIEVABLE_COLUMN):
        LeadTimePenalty.of(seg, columns(fold, seg)[:2])


# --- the second experiment: the capacity-weighted aggregate -------------------


def weights() -> CapacityWeights:
    return CapacityWeights(
        set_version="centroid_set_v1",
        scope="NE/wind",
        weights={"W1": 0.5, "W2": 0.3, "W3": 0.2},
    )


def test_the_aggregate_is_the_published_weight_vector_applied() -> None:
    """``Σ weight_c · value_c``, and nothing recomputed."""
    assert capacity_weighted_aggregate(
        {"W1": 10.0, "W2": 20.0, "W3": 30.0}, weights()
    ) == pytest.approx(0.5 * 10.0 + 0.3 * 20.0 + 0.2 * 30.0)


def test_a_partial_weight_vector_is_refused() -> None:
    """A scope's weights sum to 1; anything else is a different fleet."""
    with pytest.raises(LeadTimeError, match="partial vector"):
        CapacityWeights(
            set_version="centroid_set_v1", scope="NE/wind", weights={"W1": 0.5}
        )


def test_an_aggregate_over_the_centroids_that_happened_to_be_present() -> None:
    """Refused: a subset mean aggregates a different region."""
    with pytest.raises(LeadTimeError, match="different fleet"):
        capacity_weighted_aggregate({"W1": 10.0, "W2": 20.0}, weights())


def test_the_aggregate_correlation_is_compared_against_the_per_point_bound() -> None:
    """The research's figure travels with the aggregate, on the card.

    ``r = 0.88`` per point is an *upper bound on the harm*; aggregation is
    expected to raise it, and the block says whether it did.
    """
    pairs = [(float(i), float(i) + (0.4 if i % 3 else -0.3)) for i in range(60)]
    measured = AggregateCorrelation.measured(
        pairs=pairs, variable=CORRELATION_VARIABLE, weights=weights()
    )
    assert measured.correlation_source == WEATHER_SERIES_SOURCE
    assert measured.is_measurement
    assert measured.per_point_r == PER_POINT_R
    assert measured.aggregate_r == pytest.approx(
        pearson_r([a for a, _ in pairs], [b for _, b in pairs])
    )
    assert measured.aggregation_raised_r
    assert measured.revises_the_gap_downward is (
        measured.aggregate_r > REVISION_THRESHOLD
    )
    assert measured.card_fields()["revision_threshold"] == REVISION_THRESHOLD


def test_an_aggregate_on_another_variable_is_not_comparable() -> None:
    """The per-point figure is a ``wind_speed_120m`` figure and says so.

    `docs/research/weather-lead-time.md` is explicit that the
    ``shortwave_radiation`` correlation is flattering and dominated by the
    day/night cycle, so publishing an aggregate on a different variable beside
    ``r = 0.88`` would be an apples-to-nights comparison.
    """
    with pytest.raises(LeadTimeError, match="not comparable"):
        AggregateCorrelation.measured(
            pairs=[(1.0, 2.0), (2.0, 3.0), (3.0, 5.0)],
            variable="shortwave_radiation",
            weights=weights(),
        )


def test_a_correlation_against_a_constant_series_is_refused() -> None:
    """``0.0`` would read as 'unrelated' rather than 'did not vary'."""
    with pytest.raises(LeadTimeError, match="constant series"):
        pearson_r([1.0, 1.0, 1.0], [1.0, 2.0, 3.0])


def test_a_fixture_correlation_cannot_claim_to_be_measured() -> None:
    """The stamp, on the figure whose origin decides what it may retire."""
    invented = AggregateCorrelation.fixture(
        scope="NE/wind", set_version="centroid_set_v1", points=60, aggregate_r=0.97
    )
    assert invented.correlation_source == FIXTURE_SOURCE
    assert invented.is_measurement is False
    assert invented.revises_the_gap_downward is True
    assert invented.card_fields()["measured"] is False


# --- provenance, and the card ------------------------------------------------


def test_the_source_cannot_be_set_by_a_caller_that_ran_nothing() -> None:
    """The fifth stamp, with the discipline of the other four."""
    assert LeadTimeProvenance.fixture(lane=LANE).lead_time_source == FIXTURE_SOURCE
    assert LeadTimeProvenance.fixture(lane=LANE).is_measurement is False
    measured = LeadTimeProvenance.measured(
        lane=LANE,
        fold_calendar_hash="sha256:" + "b" * 64,
        as_of=AS_OF,
        run_label=RUN_LABEL,
    )
    assert measured.lead_time_source == FOLD_EVALUATION_SOURCE
    assert measured.is_measurement


def test_the_experiment_refuses_a_lane_the_spec_did_not_name() -> None:
    """One feature set, one gate. `docs/specs/forecaster.md` fixes both."""
    with pytest.raises(LeadTimeError, match="gate_late"):
        LeadTimeProvenance.fixture(
            lane=Lane(
                feature_set=EXPERIMENT_FEATURE_SET,
                gate_profile="gate_early",
                threshold_mw=THRESHOLD_MW,
            )
        )
    with pytest.raises(LeadTimeError, match="dessem_free_v1"):
        LeadTimeProvenance.fixture(
            lane=Lane(
                feature_set="dessem_augmented_v1",
                gate_profile=EXPERIMENT_GATE_PROFILE,
                threshold_mw=THRESHOLD_MW,
            )
        )


def test_a_fixture_block_says_so_in_capitals() -> None:
    """The block a reader must not take for a statement about the grid."""
    block = report().card_block()[LEAD_TIME_BLOCK_KEY]
    assert block["measured"] is False
    assert block["lead_time_source"] == FIXTURE_SOURCE
    assert "NOT A MEASUREMENT OF THE GRID" in block["reads"]
    assert block["not_achievable_column"] == NOT_ACHIEVABLE_COLUMN
    assert block["cadence"] == CADENCE
    assert [entry["column"] for entry in block["folds"][0]["columns"]] == list(COLUMNS)


def test_the_block_lands_on_the_card_under_the_spec_s_key(tmp_path: Path) -> None:
    """The fifth box: a named experiment on the card, not a log line.

    `docs/specs/forecaster.md`'s model card lists ``lead_time_penalty`` under
    Experiments, and this is that key.
    """
    lane_dir = tmp_path / LANE.directory_name
    lane_dir.mkdir(parents=True)
    card = lane_dir / f"{ARTIFACT_ID}.card.json"
    card.write_text(json.dumps({"artifact_id": ARTIFACT_ID}), encoding="utf-8")
    written = record_lead_time_penalty(report(), root=tmp_path, artifact_id=ARTIFACT_ID)
    published = json.loads(written.read_text(encoding="utf-8"))
    assert published["artifact_id"] == ARTIFACT_ID
    assert LEAD_TIME_BLOCK_KEY in published


def test_an_unrun_experiment_is_written_too(tmp_path: Path) -> None:
    """A missing block and 'the control arm has no data source' look alike.

    They must not: only one of them is true of this repository, and the reason
    is a named constant so two cards compare as two states rather than two
    phrasings.
    """
    lane_dir = tmp_path / LANE.directory_name
    lane_dir.mkdir(parents=True)
    (lane_dir / f"{ARTIFACT_ID}.card.json").write_text("{}", encoding="utf-8")
    absent = unmeasured_for_want_of_an_archive(lane=LANE, as_of=AS_OF)
    written = record_lead_time_penalty(absent, root=tmp_path, artifact_id=ARTIFACT_ID)
    block = json.loads(written.read_text(encoding="utf-8"))[LEAD_TIME_BLOCK_KEY]
    assert block["measured"] is False
    assert block["lead_time_source"] == UNMEASURED_SOURCE
    assert block["reason"] == ARCHIVE_NOT_INGESTED
    assert "not a finding of no harm" in block["reads"]
    assert block["aggregate_correlation"] is None
    assert absent.is_measurement is False


def test_the_correlation_travels_even_when_the_ab_could_not_run() -> None:
    """Two experiments, two sources. One needs training and one needs none."""
    invented = AggregateCorrelation.fixture(
        scope="NE/wind", set_version="centroid_set_v1", points=60, aggregate_r=0.97
    )
    absent = unmeasured_for_want_of_an_archive(
        lane=LANE, as_of=AS_OF, correlation=invented
    )
    block = absent.card_block()[LEAD_TIME_BLOCK_KEY]
    assert block["measured"] is False
    assert block["aggregate_correlation"]["aggregate_r"] == pytest.approx(0.97)
    assert block["aggregate_correlation"]["measured"] is False


def test_a_revision_optimistic_only_block_carries_its_caveat() -> None:
    """F1 predates go-live, so the weather decision may not rest on this block."""
    block = report().card_block()[LEAD_TIME_BLOCK_KEY]
    assert block["vintage_fidelities"] == ["revision_optimistic"]
    assert "may not carry the weather decision" in block["vintage_caveat"]


def test_two_segments_of_different_vintages_are_not_pooled() -> None:
    """A report is rows, never an average, for the reason the metrics table is."""
    block = penalty()
    with pytest.raises(LeadTimeError, match="reported twice"):
        LeadTimeReport(
            provenance=LeadTimeProvenance.fixture(lane=LANE),
            penalties=(block, block),
        )


# --- once, not on every retrain ----------------------------------------------


def test_the_weekly_retrain_cannot_reach_this_module() -> None:
    """The last box, as an import-graph property rather than a convention.

    `docs/specs/forecaster.md` runs this experiment once across all six folds and
    **not on every retrain**. The retrain driver is
    :mod:`~wattsteer_ml.evaluation.serving_lanes` and the thing it calls per lane
    is the gate; neither reaches this module, and a future import would fail
    here rather than quietly add three trainings per fold to a weekly job.
    """
    root = Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml"
    for module in ("evaluation/serving_lanes.py", "evaluation/gate.py"):
        source = (root / module).read_text(encoding="utf-8")
        code = "\n".join(
            line for line in source.splitlines() if not line.lstrip().startswith("#")
        )
        assert "import lead_time" not in code, module
        assert "lead_time import" not in code, module


def test_the_block_travels_with_the_lane_instead_of_being_recomputed() -> None:
    """A weekly artifact still publishes the figure without re-running it.

    :func:`carry_forward` copies the previous card's block, which is why the
    block names the fold calendar hash it was measured against: a reader can see
    it predates the current calendar, and a retrain cannot silently refresh it.
    """
    previous = {"artifact_id": "older", **report().card_block()}
    carried = carry_forward(previous)
    assert carried is not None
    assert carried[LEAD_TIME_BLOCK_KEY] == previous[LEAD_TIME_BLOCK_KEY]
    assert carry_forward({"artifact_id": "older"}) is None
