"""The rows a published attribution becomes, and the valve they hold open.

`docs/specs/diagnosis.md`, "Persistence, so Replay can read it". The payload is
the whole of what this module produces — the worker writes it — so what is
asserted here is what a stored row *says*:

- **all eight groups, at both grains, whatever any rule did.** The one-way valve
  is that a rule may annotate, demote or withhold and may never change a number
  or delete a driver, and a ``withhold`` publication that came out short a bar
  would make that unfalsifiable a day later;
- **the shares are shares of all eight**, so they sum to 1 — never of the rows
  the screen displays, which is circular;
- **the map and the background that produced the row are named on it**, because
  `run_label` moves on retrains that changed nothing and does not move when the
  grouping or the background changes underneath a promoted bundle.
"""

from __future__ import annotations

import inspect
import json
import math
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
import pytest

from attribution_fixtures import (
    RowFunction,
    feature_names_of,
    full_factorial,
    synthetic_map,
)
from wattsteer_ml.constants import Subsystem
from wattsteer_ml.diagnosis import publication
from wattsteer_ml.diagnosis.day_attribution import DayAttribution, attribute_day
from wattsteer_ml.diagnosis.publication import (
    AttributionPublicationError,
    AttributionRow,
    FiredRule,
    build_attribution_publication,
    headline_readings,
)
from wattsteer_ml.diagnosis.rules import SHIPPING_RULE_CODES
from wattsteer_ml.driver_groups import DRIVER_GROUP_CODES
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.training.background import (
    ARTIFACT_SOURCE,
    BASE_FIT_SOURCE,
    BackgroundCell,
    CellKey,
    MatchedBackground,
)

FIXTURE_MAP = synthetic_map(tuple((f"f{index}",) for index in range(8)))
FIXTURE_NAMES = feature_names_of(FIXTURE_MAP)
WIDTH = len(FIXTURE_NAMES)
SUBSYSTEM: Subsystem = "NE"
TARGET_DATE = date(2026, 3, 4)
#: `gate_at('2026-03-04', 'gate_late')` — D−1 19:00 Brasília.
GATE = datetime(2026, 3, 3, 22, 0, tzinfo=UTC)

#: The payload this module emits, checked in for the gateway to parse.
VECTOR = (
    Path(__file__).resolve().parents[2]
    / "api"
    / "test"
    / "fixtures"
    / "diagnosis"
    / "attribution.json"
)


def _background(*, seed: int = 7) -> MatchedBackground:
    """The same eight-row cell at all 24 local hours."""
    matrix = np.zeros((8, WIDTH), dtype=np.float64)
    matrix[:, :3] = full_factorial(3)
    cells = {}
    for local_hour in range(HOURS_PER_DAY):
        keys = tuple(
            RowKey(
                target_date=date(2025, 1, 1) + timedelta(days=offset),
                local_hour=local_hour,
                subsystem=SUBSYSTEM,
            )
            for offset in range(matrix.shape[0])
        )
        cells[CellKey(subsystem=SUBSYSTEM, local_hour=local_hour)] = BackgroundCell(
            subsystem=SUBSYSTEM,
            local_hour=local_hour,
            keys=keys,
            matrix=matrix.copy(),
        )
    return MatchedBackground(
        feature_names=FIXTURE_NAMES,
        rows_per_cell=matrix.shape[0],
        seed=seed,
        source=BASE_FIT_SOURCE,
        cells=cells,
    )


def _keys() -> tuple[RowKey, ...]:
    return tuple(
        RowKey(target_date=TARGET_DATE, local_hour=hour, subsystem=SUBSYSTEM)
        for hour in range(HOURS_PER_DAY)
    )


def _targets() -> npt.NDArray[np.float64]:
    rows = np.zeros((HOURS_PER_DAY, WIDTH), dtype=np.float64)
    for hour in range(HOURS_PER_DAY):
        rows[hour, 0] = 3.0 if hour >= 12 else -1.0
        rows[hour, 1] = 1.0 if hour % 2 == 0 else -1.0
        rows[hour, 2] = float(hour % 3)
        rows[hour, 3] = 2.0
        rows[hour, 4] = float(hour % 2)
    return rows


def _game() -> RowFunction:
    return RowFunction(
        lambda row: (
            4.0 * float(row[0])
            + 2.0 * float(row[1])
            + float(row[2]) * float(row[3])
            - float(row[4])
        )
    )


def _day() -> DayAttribution:
    return attribute_day(
        keys=_keys(),
        target_rows=_targets(),
        background=_background(),
        expectation=_game(),
        group_map=FIXTURE_MAP,
        stderr_resamples=32,
        stderr_seed=4,
    )


def _row(
    *,
    rule_flags: Sequence[FiredRule] = (),
    rules_evaluated: Sequence[str] = SHIPPING_RULE_CODES,
    demoted: frozenset[str] = frozenset(),
) -> AttributionRow:
    """A published row of the fixture day.

    ``rules_evaluated`` defaults to the four shipping codes rather than to
    ``()`` and that is deliberate: the default has to be the *honest* state —
    the rules ran and, on this fixture, nothing fired — because a default of
    ``()`` is the skipped-publish-path lie the row now refuses. Every test
    below that passes no ``rule_flags`` is asserting "the rules ran and were
    quiet", which is a different sentence from "nobody asked them".
    """
    day = _day()
    return AttributionRow(
        attribution=day,
        readings=headline_readings(
            day,
            keys=_keys(),
            target_rows=_targets(),
            background=_background(),
            group_map=FIXTURE_MAP,
        ),
        rule_flags=tuple(rule_flags),
        rules_evaluated=tuple(rules_evaluated),
        demoted=frozenset(demoted),  # type: ignore[arg-type]
    )


def _publication(**kwargs: Any) -> dict[str, Any]:
    return build_attribution_publication(
        [_row(**kwargs)],
        lane="dessem_free_v1__gate_late__thr5",
        feature_set="dessem_free_v1",
        gate_profile="gate_late",
        artifact_id="2026-03-03T03:11:07Z",
        target_date=TARGET_DATE,
        published_at=GATE,
        threshold_mw=5.0,
        correction_regime="conformal_v1_partial_upper",
    ).as_payload()


# --- What a published row carries ---------------------------------------------


def test_the_payload_carries_both_rankings_in_full() -> None:
    """Eight day contributions and the peak hour's own eight, beside them."""
    payload = _publication()
    (attribution,) = payload["attributions"]

    assert attribution["target"] == "expected_mwh_day"
    assert attribution["hours_attributed"] == HOURS_PER_DAY
    for block in ("groups", "peak_hour_groups"):
        codes = [one["code"] for one in attribution[block]]
        assert sorted(codes) == sorted(DRIVER_GROUP_CODES)
        assert [one["rank"] for one in attribution[block]] == list(range(1, 9))
    # The day's ranking is the headline; the peak hour is a second block on the
    # same publication and never a replacement for it.
    assert attribution["peak_hour_local"] in range(HOURS_PER_DAY)
    assert attribution["peak_hour_expected_mwh"] == pytest.approx(
        _day().peak_hour.expected_mwh
    )


def test_the_shares_are_shares_of_all_eight_groups() -> None:
    """Not of the displayed rows: the display cut is applied to the share."""
    (attribution,) = _publication()["attributions"]
    for block in ("groups", "peak_hour_groups"):
        shares = [one["share"] for one in attribution[block]]
        assert math.fsum(shares) == pytest.approx(1.0, abs=1e-12)
        denominator = math.fsum(abs(one["phi_mwh"]) for one in attribution[block])
        for one in attribution[block]:
            assert one["share"] == pytest.approx(abs(one["phi_mwh"]) / denominator)


def test_the_row_names_the_map_and_the_background_that_produced_it() -> None:
    """`run_label` answers neither question, which is why both are columns.

    An artifact id changes on every retrain, including retrains that changed
    nothing about the grouping or the background, and does not change at all
    when either changes under a bundle that is still promoted.
    """
    (attribution,) = _publication()["attributions"]
    assert attribution["driver_group_hash"] == FIXTURE_MAP.driver_group_hash
    assert attribution["driver_group_version"] == str(FIXTURE_MAP.version)
    assert attribution["background_source"] == BASE_FIT_SOURCE
    assert attribution["background_seed"] == 7
    assert attribution["background_rows"] == 8
    assert attribution["coalitions"] == 1 << len(DRIVER_GROUP_CODES)
    assert attribution["stderr_resamples"] == 32
    assert attribution["stderr_seed"] == 4


def test_a_day_measured_against_another_background_is_a_different_row() -> None:
    """The `correction_regime` argument, applied to "typical".

    Same lane, same day, same artifact, a different background: the two rows
    differ in the one column that says so, and a reader can tell them apart
    without re-running anything.
    """
    day = _day()
    other = attribute_day(
        keys=_keys(),
        target_rows=_targets(),
        background=_background(seed=11),
        expectation=_game(),
        group_map=FIXTURE_MAP,
        stderr_resamples=32,
        stderr_seed=4,
    )
    assert day.background_seed != other.background_seed
    assert day.background_source == other.background_source


# --- The one-way valve ---------------------------------------------------------


def test_withholding_leaves_every_driver_untouched() -> None:
    """`withhold` acts on the narration. It never reaches the ranking.

    The api-surface spec originally had a withheld diagnosis return
    ``drivers: []``; that violated the valve and has been corrected. This is the
    assertion that keeps it corrected: the same publication with and without the
    rule produces byte-identical driver blocks.
    """
    quiet = _publication()
    withheld = _publication(
        rule_flags=[
            FiredRule(
                code="attribution_is_noise",
                action="withhold",
                facts={"sum_abs_attributed_mwh": 0.4, "stderr_mwh": 0.9},
            )
        ]
    )
    (before,) = quiet["attributions"]
    (after,) = withheld["attributions"]

    assert after["groups"] == before["groups"]
    assert after["peak_hour_groups"] == before["peak_hour_groups"]
    assert after["day_expected_mwh"] == before["day_expected_mwh"]
    assert after["baseline_expected_mwh"] == before["baseline_expected_mwh"]
    assert after["stderr_mwh"] == before["stderr_mwh"]
    # Only the narration-facing fields differ.
    assert after["governing_rule_action"] == "withhold"
    assert before["governing_rule_action"] is None
    assert after["rule_flags"] == [
        {
            "code": "attribution_is_noise",
            "action": "withhold",
            "facts": {"sum_abs_attributed_mwh": 0.4, "stderr_mwh": 0.9},
        }
    ]


def test_demoting_marks_a_bar_and_keeps_its_number() -> None:
    """A `demote` moves a bar below the fold; it never removes it."""
    (attribution,) = _publication(demoted=frozenset({"net_surplus"}))["attributions"]
    marked = [one for one in attribution["groups"] if one["demoted"]]
    assert [one["code"] for one in marked] == ["net_surplus"]
    assert len(attribution["groups"]) == len(DRIVER_GROUP_CODES)
    (kept,) = marked
    assert kept["phi_mwh"] == pytest.approx(_day().contribution("net_surplus").phi_mwh)


def test_the_strictest_fired_action_governs() -> None:
    """`withhold` > `demote` > `annotate`, so two rules cannot both have it."""
    (attribution,) = _publication(
        rule_flags=[
            FiredRule(code="stale_inputs", action="annotate", facts={"age_hours": 12}),
            FiredRule(code="nothing_to_explain", action="withhold"),
        ]
    )["attributions"]
    assert attribution["governing_rule_action"] == "withhold"
    assert [one["code"] for one in attribution["rule_flags"]] == [
        "stale_inputs",
        "nothing_to_explain",
    ]


def test_a_fourth_action_is_not_a_rule() -> None:
    with pytest.raises(AttributionPublicationError, match="annotate, demote or"):
        FiredRule(code="rewrite_everything", action="rewrite")  # type: ignore[arg-type]


# --- observed and typical ------------------------------------------------------


def test_the_pair_beside_a_bar_is_its_headline_feature_read_two_ways() -> None:
    """Day: the mean over 24 rows against the mean over 24 cells. Peak: the hour."""
    day = _day()
    readings = headline_readings(
        day,
        keys=_keys(),
        target_rows=_targets(),
        background=_background(),
        group_map=FIXTURE_MAP,
    )
    targets = _targets()
    for index, code in enumerate(DRIVER_GROUP_CODES):
        reading = readings[("day", code)]
        assert reading.feature == f"f{index}"
        assert reading.observed == pytest.approx(float(np.mean(targets[:, index])))
        # The fixture background is symmetric on its first three columns and zero
        # on the rest, so "typical" is zero everywhere — which is the point: it
        # is the background's mean and never the day's.
        assert reading.typical == pytest.approx(0.0)
        peak = readings[("peak_hour", code)]
        assert peak.observed == pytest.approx(float(targets[day.peak_hour_local, index]))


def test_an_absent_reading_does_not_depend_on_where_the_background_came_from() -> None:
    """The absence is a property of the *rows*, not of the sample's provenance.

    This matters because ``B(s, h)`` has two homes. Today it is drawn at publish
    time from the artifact's base-fit block and stamped ``base_fit``; forecaster
    30 freezes it into the bundle and stamps ``artifact``, and
    ``background_source`` is the field that keeps the two distinguishable on
    every published row. A frozen sample makes the NULL *worse*, not better: a
    lane whose base-fit window held one weather gap freezes it, so under the old
    contract every publication from that artifact refused for its whole life
    rather than only the days with gaps.

    So the representation has to work on both paths, and here it is asserted to:
    the same NaN produces the same ``null_in_background`` under either label, and
    the label itself is untouched — a reading's absence must never be readable
    as a statement about provenance, or an operator would chase the wrong repair.
    """
    day = _day()
    for source in (BASE_FIT_SOURCE, ARTIFACT_SOURCE):
        background = _background()
        # One NULL, in one cell, in `net_surplus`'s headline column — exactly
        # what a weather block that did not land looks like once it is a matrix.
        cell = background.cell(SUBSYSTEM, 0)
        holed = cell.matrix.copy()
        holed[0, 2] = np.nan
        cells = dict(background.cells)
        cells[CellKey(subsystem=SUBSYSTEM, local_hour=0)] = BackgroundCell(
            subsystem=SUBSYSTEM, local_hour=0, keys=cell.keys, matrix=holed
        )
        gapped = MatchedBackground(
            feature_names=background.feature_names,
            rows_per_cell=background.rows_per_cell,
            seed=background.seed,
            source=source,
            cells=cells,
        )
        readings = headline_readings(
            day,
            keys=_keys(),
            target_rows=_targets(),
            background=gapped,
            group_map=FIXTURE_MAP,
        )
        # `f2` is the third group's headline feature, and the day-grain typical
        # pools all 24 cells — so the one hole reaches it.
        holed_reading = readings[("day", DRIVER_GROUP_CODES[2])]
        assert holed_reading.typical is None
        assert holed_reading.typical_absent_reason == "null_in_background"
        # The day's own side is intact: the absence is per half, and this NULL is
        # in the background and not in the day.
        assert holed_reading.observed is not None
        assert holed_reading.observed_absent_reason is None
        # And the peak hour is hour-specific: the hole is in local hour 0, so a
        # peak elsewhere still has a typical. Which hour is the peak is the
        # attribution's business, so both branches are stated rather than assumed.
        peak = readings[("peak_hour", DRIVER_GROUP_CODES[2])]
        if day.peak_hour_local == 0:
            assert peak.typical is None
        else:
            assert peak.typical is not None
        # Every other group is untouched by a hole in one column.
        for index, code in enumerate(DRIVER_GROUP_CODES):
            if index == 2:
                continue
            assert readings[("day", code)].typical is not None
            assert readings[("day", code)].typical_absent_reason is None
        # The label is a fact about the sample and this function never touches it.
        assert gapped.source == source


def test_a_headline_feature_outside_the_contract_stops_the_publication() -> None:
    """The pair beside the bar would otherwise be some other feature's."""
    day = _day()
    stranger = synthetic_map(tuple((f"g{index}",) for index in range(8)))
    with pytest.raises(AttributionPublicationError, match="headline feature"):
        headline_readings(
            day,
            keys=_keys(),
            target_rows=_targets(),
            background=_background(),
            group_map=stranger,
        )


def test_a_bar_with_no_reading_is_refused() -> None:
    day = _day()
    readings = headline_readings(
        day,
        keys=_keys(),
        target_rows=_targets(),
        background=_background(),
        group_map=FIXTURE_MAP,
    )
    del readings[("day", "net_surplus")]
    with pytest.raises(AttributionPublicationError, match="no day reading"):
        AttributionRow(
            attribution=day,
            readings=readings,
            rule_flags=(),
            rules_evaluated=SHIPPING_RULE_CODES,
        )


# --- The rules provably ran -----------------------------------------------------
#
# `.scratch/api-surface/issues/10-forecast-publication.md`, "A third thing this
# ticket will own": the valve is enforced four ways inside `apply_rules` and
# none of them says the rules were *called*. `rule_flags` defaulted to `()`, so
# a publish path that skipped them assembled a valid, empty-flagged row.
#
# These are written as a pair on purpose. The first is the non-vacuity half —
# the quiet day is publishable, so the refusal below is a refusal of the
# skipped path and not of every empty flag list.


def test_a_quiet_day_publishes_with_an_empty_flag_list() -> None:
    """Nothing fired is the common case and is not the refused one."""
    payload = _publication()
    (attribution,) = payload["attributions"]
    assert attribution["rule_flags"] == []
    assert attribution["governing_rule_action"] is None
    # And it says so: the roll call is on the row, so "quiet" is a reading of
    # evidence rather than an absence of it.
    assert attribution["rules_evaluated"] == list(SHIPPING_RULE_CODES)


def test_a_row_that_names_no_evaluated_rules_is_refused() -> None:
    """The skipped publish path, reintroduced as the one-field diff it is."""
    with pytest.raises(AttributionPublicationError, match="names no rules as evaluated"):
        _row(rules_evaluated=())


def test_a_fired_rule_outside_the_roll_call_is_refused() -> None:
    """Flags from one run beside a roll call copied from another."""
    fired = FiredRule(code="stale_inputs", action="annotate", facts={})
    with pytest.raises(AttributionPublicationError, match="not in this row's roll call"):
        _row(rule_flags=(fired,), rules_evaluated=("nothing_to_explain",))


def test_a_roll_call_that_names_a_rule_twice_is_refused() -> None:
    with pytest.raises(AttributionPublicationError, match="appears twice in the roll"):
        _row(rules_evaluated=("stale_inputs", "stale_inputs"))


# --- The publication's own shape ------------------------------------------------


def test_a_subsystem_is_explained_once_per_publication() -> None:
    with pytest.raises(AttributionPublicationError, match="appears twice"):
        build_attribution_publication(
            [_row(), _row()],
            lane="dessem_free_v1__gate_late__thr5",
            feature_set="dessem_free_v1",
            gate_profile="gate_late",
            artifact_id="2026-03-03T03:11:07Z",
            target_date=TARGET_DATE,
            published_at=GATE,
            threshold_mw=5.0,
            correction_regime="conformal_v1_partial_upper",
        )


def test_an_empty_publication_is_refused_rather_than_written() -> None:
    with pytest.raises(AttributionPublicationError, match="is not one"):
        build_attribution_publication(
            [],
            lane="dessem_free_v1__gate_late__thr5",
            feature_set="dessem_free_v1",
            gate_profile="gate_late",
            artifact_id="2026-03-03T03:11:07Z",
            target_date=TARGET_DATE,
            published_at=GATE,
            threshold_mw=5.0,
            correction_regime="conformal_v1_partial_upper",
        )


def test_a_day_that_is_not_the_publications_day_is_refused() -> None:
    with pytest.raises(AttributionPublicationError, match="arrived in a publication"):
        build_attribution_publication(
            [_row()],
            lane="dessem_free_v1__gate_late__thr5",
            feature_set="dessem_free_v1",
            gate_profile="gate_late",
            artifact_id="2026-03-03T03:11:07Z",
            target_date=TARGET_DATE + timedelta(days=1),
            published_at=GATE,
            threshold_mw=5.0,
            correction_regime="conformal_v1_partial_upper",
        )


def test_the_origin_is_a_record_published_at_the_gate() -> None:
    """`origin_kind` is written rather than defaulted, and the instant is the gate."""
    payload = _publication()
    assert payload["forecast_origin"] == {
        "producer": "wattsteer",
        "run_label": "2026-03-03T03:11:07Z",
        "published_at": GATE.isoformat(),
        "origin_kind": "served",
        "gate_profile": "gate_late",
    }
    assert payload["subsystems"] == [SUBSYSTEM]
    assert payload["correction_regime"] == "conformal_v1_partial_upper"


# --- The seam: this module returns rows, and the worker writes them -----------


def test_the_modelling_service_writes_nothing() -> None:
    """Structural, not a promise.

    `docs/specs/api-surface.md` puts the write on the worker because the ML
    service is read-only against Postgres and because every write belongs to the
    service that owns the Drizzle schema. A publication module that grew an
    ``INSERT`` would satisfy every other test in this file.
    """
    source = inspect.getsource(publication)
    for statement in ("insert into", "INSERT INTO", "execute(", "conn."):
        assert statement not in source


def test_the_checked_in_vector_is_still_the_shape_this_module_emits() -> None:
    """The other half of the cross-language seam.

    ``apps/api/test/fixtures/diagnosis/attribution.json`` is a payload this
    module produced, checked in so the gateway's parser can be tested against
    the real thing. Keys — not values: a renamed or dropped key is exactly the
    drift that would otherwise reach production as a ``null``.

    Regenerate it when this assertion fails *and* the new shape is intended.
    """
    vector = json.loads(VECTOR.read_text(encoding="utf-8"))
    payload = _publication()
    assert set(payload) == set(vector)
    assert set(payload["forecast_origin"]) == set(vector["forecast_origin"])
    assert set(payload["attributions"][0]) == set(vector["attributions"][0])
    for block in ("groups", "peak_hour_groups"):
        assert set(payload["attributions"][0][block][0]) == set(
            vector["attributions"][0][block][0]
        )
