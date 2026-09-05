"""The ticket-011 number, and the stamp that says what it is a measurement of.

`test_p50_collapse.py` asserts the arithmetic — ``Q_Y(q) = 0`` for ``q ≤ 1 − p``,
so P10 is zero exactly when ``p ≤ 0.90`` and P50 exactly when ``p ≤ 0.50``. This
file asserts the thing that arithmetic becomes once it is published as a figure a
posture decision is made on: which rows it was counted over, that a report cannot
claim rows it did not read, and that a report counted over fabricated bands says
so loudly enough that nobody reads it as a statement about the Brazilian grid.

**The connection is a stand-in**, exactly as in `test_planning_profile.py`: this
repository has no database-backed Python suite and this file does not open one.
What is asserted here is everything this side of the wire owns — which axes are
written, which values are bound, what a stored row becomes, and every shape of
absence that has to stay an absence rather than a zero. What a stand-in cannot
check is that the SQL is valid against the migrated schema, and no test in this
file pretends otherwise: `test_the_query_reads_the_canonical_view_and_pins_the
_origin_kind` checks the text, not the execution.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Self

import pytest

from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.evaluation.collapse import CollapseBlock, P50Collapse
from wattsteer_ml.evaluation.collapse_report import (
    COLLAPSE_BLOCK_KEY,
    FIXTURE_SOURCE,
    HOLDOUT_HOURS_SOURCE,
    HOLDOUT_HOURS_SQL,
    HOLDOUT_ORIGIN_KIND,
    UNMEASURED_SOURCE,
    CollapseProvenance,
    CollapseReport,
    CollapseReportError,
    UnmeasuredCollapse,
    measure_p50_collapse,
    read_holdout_hours,
    record_collapse_report,
)
from wattsteer_ml.evaluation.vintage import FoldSegment
from wattsteer_ml.lanes import Lane
from wattsteer_ml.publication import BACKFILLED_HOLDOUT_ORIGIN_KIND
from wattsteer_ml.training.bundle import SubThresholdMeans
from wattsteer_ml.training.hurdle import HourEstimates, HourForecast, compose_estimates

HOURS_PER_DAY = 24
THRESHOLD_MW = 5.0
AS_OF = datetime(2026, 8, 29, 4, 0, tzinfo=UTC)
RUN_LABEL = "fold-evaluation-2026-08-29"
ARTIFACT_ID = "2026-08-29T04:00:00Z"
LANE = Lane(
    feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=THRESHOLD_MW
)

FLAT_MU_SUB = SubThresholdMeans(
    values=tuple(tuple(0.0 for _ in range(HOURS_PER_DAY)) for _ in SUBSYSTEM_CODES)
)


def composed(
    probabilities: Sequence[float],
    *,
    day: date,
    subsystem: Subsystem = "NE",
    magnitude: float = 40.0,
) -> tuple[HourForecast, ...]:
    """One day of composed hours, through the service's one composition."""
    keys = [
        RowKey(target_date=day, local_hour=hour, subsystem=subsystem)
        for hour in range(len(probabilities))
    ]
    return compose_estimates(
        keys,
        [
            HourEstimates(
                occurrence_probability=p,
                q10=magnitude,
                q50=magnitude,
                q90=magnitude,
                positive_mean_mwh=magnitude,
            )
            for p in probabilities
        ],
        sub_threshold_means=FLAT_MU_SUB,
        threshold_mw=THRESHOLD_MW,
    )


def stored(
    probabilities: Sequence[float],
    *,
    day: date,
    subsystem: Subsystem = "NE",
    run_label: str = RUN_LABEL,
) -> list[dict[str, Any]]:
    """The same composed day, as ``canonical_forecast_hour`` hands it back.

    Composed rather than invented, so the rows carry the *composition's* zeroes
    and the read-back path can be compared against it rather than against three
    numbers a test made up.
    """
    return [
        {
            "subsystem": hour.key.subsystem,
            "target_date": hour.key.target_date,
            "local_hour": hour.key.local_hour,
            "occurrence_probability": hour.forecast.occurrence_probability,
            "p10_mwh": hour.forecast.band.p10,
            "p50_mwh": hour.forecast.band.p50,
            "p90_mwh": hour.forecast.band.p90,
            "run_label": run_label,
            "feature_set": LANE.feature_set,
            "gate_profile": LANE.gate_profile,
            "threshold_mw": THRESHOLD_MW,
        }
        for hour in composed(probabilities, day=day, subsystem=subsystem)
    ]


def segment(
    fold_id: str = "F5",
    *,
    first: date = date(2025, 4, 1),
    last: date = date(2025, 4, 3),
    fidelity: VintageFidelity = "revision_optimistic",
    is_split: bool = False,
) -> FoldSegment:
    row_id = f"{fold_id}@{fidelity}" if is_split else fold_id
    return FoldSegment(
        fold_id=fold_id,
        row_id=row_id,
        fidelity=fidelity,
        test_start=first,
        test_end=last,
        is_split=is_split,
        fold_hash=f"sha256:{fold_id}",
    )


class FakeTransaction:
    def __init__(self, connection: FakeConnection) -> None:
        self._connection = connection

    async def __aenter__(self) -> Self:
        self._connection.calls.append(("begin", ()))
        return self

    async def __aexit__(self, *_: object) -> bool:
        self._connection.calls.append(("commit", ()))
        return False


class FakeConnection:
    """Records what was executed and hands back the rows it was primed with."""

    def __init__(self, batches: Sequence[list[dict[str, Any]]]) -> None:
        self._batches = list(batches)
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)

    async def execute(self, query: str, *args: Any) -> None:
        self.calls.append(("execute", (query, *args)))

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.calls.append(("fetch", (query, *args)))
        return self._batches.pop(0) if self._batches else []


def measure(
    batches: Sequence[list[dict[str, Any]]], *, segments: Sequence[FoldSegment]
) -> tuple[FakeConnection, CollapseReport | UnmeasuredCollapse]:
    connection = FakeConnection(batches)
    report = asyncio.run(
        measure_p50_collapse(connection, segments=list(segments), lane=LANE, as_of=AS_OF)
    )
    return connection, report


# --- the arithmetic, through the persisted path -------------------------------


def test_a_stored_band_counts_the_same_collapse_the_composition_produced() -> None:
    """The read-back path holds no second opinion about where the zeroes are.

    P10 is zero exactly when ``q ≤ 1 − p`` and so is P50 one notch weaker; the
    figures are counted off the *band*, so a reader of stored rows that rounded,
    re-derived or re-composed anything would move the breakpoint. The assertion
    is that the two counts are the same object's figures, not that they are
    close.
    """
    probabilities = [round(step / 100.0, 2) for step in range(24)]
    day = date(2025, 4, 1)
    connection = FakeConnection([stored(probabilities, day=day)])
    hours, run_label = asyncio.run(
        read_holdout_hours(connection, segment=segment(), lane=LANE, as_of=AS_OF)
    )
    assert run_label == RUN_LABEL
    from_rows = P50Collapse.of(hours, label="fold")
    from_composition = P50Collapse.of(composed(probabilities, day=day), label="fold")
    assert from_rows is not None and from_composition is not None
    assert from_rows == from_composition
    for hour in hours:
        p = hour.forecast.occurrence_probability
        assert (hour.forecast.band.p10 == 0.0) is (1.0 - p >= 0.10)
        assert (hour.forecast.band.p50 == 0.0) is (1.0 - p >= 0.50)


# --- the axes, the bound values and the population ----------------------------


def test_the_vintage_axis_is_written_before_the_bands_are_read() -> None:
    """A backtest run appends a vintage; the read is reproducible or it is not."""
    connection, _ = measure(
        [stored([0.2] * 24, day=date(2025, 4, 1))], segments=[segment()]
    )
    assert [call[0] for call in connection.calls] == [
        "begin",
        "execute",
        "fetch",
        "commit",
    ]
    axes = connection.calls[1][1]
    assert "set_config" in axes[0]
    assert axes[1] == AS_OF.isoformat()


def test_the_lane_is_bound_and_the_origin_kind_is_not_a_parameter() -> None:
    """The population is a constant in the SQL text; the lane is three values.

    A caller that could widen ``origin_kind`` could pool a fold's held-out days
    with days the product actually published, and publish one share over two
    populations under the name of one.
    """
    connection, _ = measure(
        [stored([0.2] * 24, day=date(2025, 4, 1))], segments=[segment()]
    )
    query, *values = connection.calls[2][1]
    assert values == [
        date(2025, 4, 1),
        date(2025, 4, 3),
        LANE.feature_set,
        LANE.gate_profile,
        THRESHOLD_MW,
    ]
    assert HOLDOUT_ORIGIN_KIND in query
    assert "'served'" not in query


def test_the_query_reads_the_canonical_view_and_pins_the_origin_kind() -> None:
    """One view, one population, and the constant pinned to publication's."""
    assert HOLDOUT_ORIGIN_KIND == BACKFILLED_HOLDOUT_ORIGIN_KIND
    assert f"origin_kind = '{HOLDOUT_ORIGIN_KIND}'" in HOLDOUT_HOURS_SQL
    assert "from canonical_forecast_hour" in HOLDOUT_HOURS_SQL
    assert "curtailment_forecast_hour" not in HOLDOUT_HOURS_SQL


def test_two_backtest_runs_in_one_segment_are_refused_rather_than_pooled() -> None:
    """Two artifacts' bands are two populations wearing one run's name."""
    rows = stored([0.9] * 24, day=date(2025, 4, 1)) + stored(
        [0.1] * 24, day=date(2025, 4, 2), run_label="a-second-run"
    )
    with pytest.raises(CollapseReportError, match="more than one backtest run"):
        measure([rows], segments=[segment()])


# --- what an empty database gets ----------------------------------------------


def test_no_held_out_band_is_reported_as_unmeasured_and_never_as_a_share() -> None:
    """The environment this ticket was implemented in, and its honest output.

    A zero share would say the posture never collapses and a one would say it
    always does. Both are readings of an empty table.
    """
    _, report = measure([[]], segments=[segment()])
    assert isinstance(report, UnmeasuredCollapse)
    assert report.is_measurement is False
    block = report.card_block()[COLLAPSE_BLOCK_KEY]
    assert block["measured"] is False
    assert block["collapse_source"] == UNMEASURED_SOURCE
    assert "not a share of zero" in block["reads"]
    assert not [key for key in block if key.startswith("share_")]
    assert "folds" not in block


def test_a_partial_day_yields_no_figure_rather_than_a_collapse() -> None:
    """Six served hours is not a day a plan was ever built for."""
    _, report = measure([stored([0.1] * 6, day=date(2025, 4, 1))], segments=[segment()])
    assert isinstance(report, UnmeasuredCollapse)


def test_a_report_with_no_segment_is_a_caller_mistake_and_not_an_empty_table() -> None:
    with pytest.raises(CollapseReportError, match="no fold segment"):
        measure([], segments=[])


def test_an_absent_measurement_is_written_onto_the_card_rather_than_omitted(
    tmp_path: Path,
) -> None:
    """A missing block and "this could not be measured yet" look identical.

    Only one of them is true of an environment with no backfilled holdout rows,
    and the difference is the whole reason this block exists.
    """
    lane_directory = tmp_path / LANE.directory_name
    lane_directory.mkdir()
    card_path = lane_directory / f"{ARTIFACT_ID}{CARD_SUFFIX}"
    card_path.write_text(json.dumps({"artifact_id": ARTIFACT_ID}) + "\n")
    _, report = measure([[]], segments=[segment()])
    written = record_collapse_report(report, root=tmp_path, artifact_id=ARTIFACT_ID)
    card = json.loads(written.read_text())
    assert card["artifact_id"] == ARTIFACT_ID
    assert card[COLLAPSE_BLOCK_KEY]["measured"] is False
    assert card[COLLAPSE_BLOCK_KEY]["collapse_source"] == UNMEASURED_SOURCE


# --- the stamp ----------------------------------------------------------------


def test_a_measured_report_names_the_view_the_run_and_the_instant() -> None:
    connection, report = measure(
        [stored([0.95] * 24, day=date(2025, 4, 1))], segments=[segment()]
    )
    assert isinstance(report, CollapseReport)
    assert report.provenance.is_measurement is True
    block = report.card_block()[COLLAPSE_BLOCK_KEY]
    assert block["measured"] is True
    assert block["collapse_source"] == HOLDOUT_HOURS_SOURCE
    assert block["run_label"] == RUN_LABEL
    assert block["as_of"] == AS_OF.isoformat()
    assert block["lane"] == LANE.directory_name
    assert connection.calls[2][0] == "fetch"


def test_a_fixture_report_says_it_is_not_a_measurement_of_the_grid() -> None:
    """The failure this stamp exists to prevent, asserted as a property.

    The six figures are computable from any set of bands, and a fixture-derived
    ``share_of_days_with_no_non_zero_p50_hour`` is a plausible decimal that
    reads exactly like a statement about the Brazilian system.
    """
    hours = composed([0.05] * 24, day=date(2025, 4, 1))
    collapse = CollapseBlock.of(hours)
    assert collapse is not None
    report = CollapseReport.of(
        [(segment(), collapse)], provenance=CollapseProvenance.fixture(lane=LANE)
    )
    block = report.card_block()[COLLAPSE_BLOCK_KEY]
    assert report.provenance.is_measurement is False
    assert block["measured"] is False
    assert block["collapse_source"] == FIXTURE_SOURCE
    assert block["run_label"] is None and block["as_of"] is None
    assert "NOT A MEASUREMENT OF THE GRID" in block["reads"]
    assert HOLDOUT_HOURS_SOURCE in block["reads"]
    figures = block["folds"][0]["p50_collapse"]
    assert figures["share_of_days_with_no_non_zero_p50_hour"] == 1.0


# --- per fold and per subsystem, with the vintage on every row ----------------


def test_the_block_is_published_per_fold_segment_and_per_subsystem() -> None:
    """The six figures, at both grains, under names that need no harness."""
    days = [date(2025, 4, 1), date(2025, 4, 2), date(2025, 4, 3)]
    rows = [
        row
        for day in days
        for row in stored([0.95] * 4 + [0.6] * 6 + [0.05] * 14, day=day, subsystem="NE")
        + stored([0.05] * 24, day=day, subsystem="S")
    ]
    _, report = measure([rows], segments=[segment()])
    assert isinstance(report, CollapseReport)
    assert report.subsystems_reported == ("NE", "S")
    entry = report.card_block()[COLLAPSE_BLOCK_KEY]["folds"][0]
    assert entry["row_id"] == "F5"
    assert entry["vintage_fidelity"] == "revision_optimistic"
    pooled = entry["p50_collapse"]
    assert pooled["share_of_days_with_no_non_zero_p50_hour"] == pytest.approx(0.5)
    assert pooled["share_of_hours_with_p50_zero"] == pytest.approx(38 / 48)
    assert pooled["share_with_p10_zero"] == pytest.approx(44 / 48)
    assert set(pooled["hours_per_day_p_ge_50"]) == {"mean", "p25", "p75"}
    assert set(pooled["hours_per_day_p_ge_90"]) == {"mean", "p25", "p75"}
    by_label = {cell["label"]: cell for cell in entry["p50_collapse_by_subsystem"]}
    assert by_label["NE"]["share_of_days_with_no_non_zero_p50_hour"] == 0.0
    assert by_label["S"]["share_of_days_with_no_non_zero_p50_hour"] == 1.0
    assert by_label["NE"]["hours_per_day_p_ge_50"]["mean"] == pytest.approx(10.0)
    assert by_label["NE"]["hours_per_day_p_ge_90"]["mean"] == pytest.approx(4.0)


def test_a_straddling_fold_is_reported_as_two_rows_and_never_as_one() -> None:
    """`docs/specs/forecaster.md`: averaging is how a caveat disappears."""
    early = segment("F6", first=date(2025, 4, 1), last=date(2025, 4, 2), is_split=True)
    late = segment(
        "F6",
        first=date(2025, 4, 3),
        last=date(2025, 4, 4),
        fidelity="point_in_time",
        is_split=True,
    )
    batches = [
        stored([0.1] * 24, day=date(2025, 4, 1)),
        stored([0.95] * 24, day=date(2025, 4, 3)),
    ]
    _, report = measure(batches, segments=[early, late])
    assert isinstance(report, CollapseReport)
    rows = report.card_block()[COLLAPSE_BLOCK_KEY]["folds"]
    assert [row["row_id"] for row in rows] == [
        "F6@revision_optimistic",
        "F6@point_in_time",
    ]
    assert [row["vintage_fidelity"] for row in rows] == [
        "revision_optimistic",
        "point_in_time",
    ]
    assert rows[0]["p50_collapse"]["share_of_days_with_no_non_zero_p50_hour"] == 1.0
    assert rows[1]["p50_collapse"]["share_of_days_with_no_non_zero_p50_hour"] == 0.0
    block = report.card_block()[COLLAPSE_BLOCK_KEY]
    assert block["vintage_fidelities"] == ["revision_optimistic", "point_in_time"]
    assert "vintage_caveat" not in block


def test_a_block_with_no_point_in_time_segment_says_it_cannot_decide_alone() -> None:
    """ "A revision-optimistic fold cannot carry the decision alone" — as a field.

    The caveat travels with the number rather than being recoverable by whoever
    remembers which quarter the ingestion went live in.
    """
    _, report = measure([stored([0.05] * 24, day=date(2025, 4, 1))], segments=[segment()])
    assert isinstance(report, CollapseReport)
    block = report.card_block()[COLLAPSE_BLOCK_KEY]
    assert block["vintage_fidelities"] == ["revision_optimistic"]
    assert "may not carry the posture decision on its own" in block["vintage_caveat"]


def test_half_a_split_fold_cannot_be_published_alone() -> None:
    """Its twin carries the other vintage, and one half is not the fold."""
    collapse = CollapseBlock.of(composed([0.1] * 24, day=date(2025, 4, 1)))
    assert collapse is not None
    half = segment("F6", is_split=True)
    with pytest.raises(ValueError, match="other half is missing"):
        CollapseReport.of(
            [(half, collapse)], provenance=CollapseProvenance.fixture(lane=LANE)
        )


def test_one_segment_reported_twice_is_a_day_counted_twice() -> None:
    collapse = CollapseBlock.of(composed([0.1] * 24, day=date(2025, 4, 1)))
    assert collapse is not None
    with pytest.raises(CollapseReportError, match="reported twice"):
        CollapseReport.of(
            [(segment(), collapse), (segment(), collapse)],
            provenance=CollapseProvenance.fixture(lane=LANE),
        )


# --- the second entry point ---------------------------------------------------


def test_a_scored_row_that_measured_nothing_is_dropped_and_never_zeroed() -> None:
    """One arithmetic, two entry points, and the same rule about absence.

    A fold-evaluation run that fitted models publishes the block from the rows it
    already counted, rather than re-counting them here.
    """

    class Row:
        def __init__(self, seg: FoldSegment, block: CollapseBlock | None) -> None:
            self.segment = seg
            self.collapse = block

    collapse = CollapseBlock.of(composed([0.1] * 24, day=date(2025, 4, 1)))
    assert collapse is not None
    report = CollapseReport.from_scored_rows(
        [Row(segment("F4"), collapse), Row(segment("F5"), None)],
        provenance=CollapseProvenance.fixture(lane=LANE),
    )
    assert [row.segment.fold_id for row in report.rows] == ["F4"]


def test_the_figures_are_evidence_and_carry_no_verdict() -> None:
    """The ticket produces the evidence; it does not decide.

    Asserted as a property of the published block: there is no threshold here to
    tune into the answer somebody wanted, and no boolean saying the posture
    collapsed.
    """
    days = [date(2025, 4, 1) + timedelta(days=offset) for offset in range(3)]
    rows = [row for day in days for row in stored([0.05] * 24, day=day)]
    _, report = measure([rows], segments=[segment()])
    assert isinstance(report, CollapseReport)
    block = report.card_block()[COLLAPSE_BLOCK_KEY]
    published = {*block, *block["folds"][0], *block["folds"][0]["p50_collapse"]}
    assert not [key for key in published if "collapsed" in key or "verdict" in key]
    assert block["folds"][0]["p50_collapse"][
        "share_of_days_with_no_non_zero_p50_hour"
    ] == pytest.approx(1.0)
