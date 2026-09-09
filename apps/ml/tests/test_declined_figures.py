"""The census of figures this service declines to state.

The discipline these tests hold is not "the eight absences are listed" — it is
that **nothing lists them**. A hand-maintained roll of named absences goes
stale the first time somebody adds one, which is the failure this repository
has already had twice: three artefacts claiming three different row counts, and
a "does not exist yet" comment repeated in five places after the thing existed.

So the set is assembled by walking this package and collecting every
:class:`~wattsteer_ml.declined.DeclinedFigure` a module holds, and the
assertions below are about that mechanism rather than about its current
membership:

- the registry and a **source scan** for ``= DeclinedFigure(`` agree, which is
  what catches a constant declared somewhere the walk cannot see it;
- a constant that appears at runtime appears on the route, with no list edited
  anywhere in between — demonstrated, not asserted in prose;
- the scan finds something, so that neither of the two can pass vacuously; and
- **"unrunnable" and "unrun" stay two sentences.** Forecaster 16 says a thing
  cannot be built; forecaster 18 chose ``NOT_RUN_YET`` precisely so it would not
  read like that, and forecaster 24 followed 18. A single "unavailable" bucket
  would destroy exactly the information those tickets were written to create.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from wattsteer_ml.app import app
from wattsteer_ml.constants import Subsystem
from wattsteer_ml.declined import (
    DECLINE_KINDS,
    DeclinedFigure,
    declined_figures,
)
from wattsteer_ml.evaluation.collapse_report import (
    COLLAPSE_BLOCK_KEY,
    NO_HELDOUT_BAND_TO_COUNT,
    UnmeasuredCollapse,
)
from wattsteer_ml.evaluation.dessem_ab import (
    DESSEM_ARMS_NOT_SCORED,
    DESSEM_DELTA_BLOCK_KEY,
    NO_DECIDING_FOLD,
    NOT_RUN_YET,
    UnmeasuredDessemDelta,
)
from wattsteer_ml.evaluation.lead_time import (
    ARCHIVE_FEATURES_HAVE_NO_SHAPE,
    COLUMN_DEFINITIONS,
    CORRELATION_NOT_RUN_YET,
    LEAD_TIME_BLOCK_KEY,
    LEAD_TIME_COLUMNS_NOT_SCORED,
    NOT_ACHIEVABLE_COLUMN,
    UnmeasuredLeadTime,
)
from wattsteer_ml.evaluation.planning_arms import (
    NO_HELDOUT_BAND_FOR_ARMS,
    PLANNING_ARMS_BLOCK_KEY,
    UnmeasuredPlanningArms,
)
from wattsteer_ml.evaluation.threshold_sweep import (
    SWEEP_ARMS_NOT_SCORED,
    THRESHOLD_SWEEP_BLOCK_KEY,
    UnmeasuredThresholdSweep,
)
from wattsteer_ml.evaluation.transformer_benchmark import (
    BENCHMARK_ARMS_NOT_SCORED,
    NO_TFT_IMPLEMENTATION,
    NO_TRAINING_COST_MEASURED,
    TRANSFORMER_BENCHMARK_BLOCK_KEY,
    UnmeasuredTransformerBenchmark,
)
from wattsteer_ml.lanes import Lane
from wattsteer_ml.replay.floor_guardrail import (
    CANDIDATE_HAS_NO_COMPLETE_DAY,
    CANDIDATE_SUBSYSTEM_NOT_MEASURED,
    COLD_START_DETAIL,
    INCUMBENT_SUBSYSTEM_HAS_NO_FLOOR,
    NEITHER_SIDE_HAS_A_COMPLETE_DAY,
    FloorCoverage,
    FloorCoverageProvenance,
    SubsystemFloorCoverage,
    compare_floor_coverage,
)
from wattsteer_ml.training.bundle import (
    NO_CURTAILED_HOUR_TO_COVER,
    NO_SETTLED_DAY_TO_SCORE,
)
from wattsteer_ml.training.conformal import MARGINAL_COVERAGE_NOT_RUN_YET

SRC = Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml"

#: A module-level declaration, as it is written. The scan is deliberately
#: anchored to the start of a line: a `DeclinedFigure` built inside a function
#: is invisible to the registry's walk, and this is what makes that a failure
#: here rather than a silent omission from the surface.
DECLARATION = re.compile(r"^([A-Z][A-Z0-9_]*) = DeclinedFigure\(", re.MULTILINE)


def declared_in_source() -> dict[str, str]:
    """Every ``NAME = DeclinedFigure(`` in this package, by module path."""
    found: dict[str, str] = {}
    for path in sorted(SRC.rglob("*.py")):
        if path.name == "declined.py":
            continue
        text = path.read_text(encoding="utf-8")
        for match in DECLARATION.finditer(text):
            found[match.group(1)] = str(path.relative_to(SRC.parents[1]))
    return found


def by_name() -> dict[str, dict[str, Any]]:
    return {entry["name"]: entry for entry in declined_figures()}


# --- the mechanism ------------------------------------------------------------


def test_the_source_declares_some_declined_figures() -> None:
    """The guard on the guard.

    A scan that matched nothing would make every claim below vacuously true,
    which is precisely how a derived count stops being a count.
    """
    assert len(declared_in_source()) >= 7


def test_the_set_is_assembled_from_the_constants_and_never_from_a_list() -> None:
    """The registry is the modules' contents, so no roll can go stale.

    Both halves fail. A constant the walk cannot reach — declared inside a
    function, or in a module nothing imports — is missing from the registry and
    caught here; a registry entry with no declaration behind it would be a name
    invented in the assembler.
    """
    assert sorted(by_name()) == sorted(declared_in_source())


def test_every_entry_knows_where_it_is_declared() -> None:
    source = declared_in_source()
    for name, entry in by_name().items():
        assert entry["declared_in"].endswith(".py")
        assert Path(entry["declared_in"]).name == Path(source[name]).name


def test_a_new_reason_appears_with_no_list_edited(
    request: pytest.FixtureRequest,
) -> None:
    """The acceptance box, demonstrated rather than argued.

    A reason declared on a module that already exists is on the surface on the
    next request. Nothing in :mod:`wattsteer_ml.declined` names it, and nothing
    had to be told about it.
    """
    from wattsteer_ml.evaluation import dessem_ab

    request.addfinalizer(lambda: delattr(dessem_ab, "A_NINTH_ABSENCE"))
    dessem_ab.A_NINTH_ABSENCE = DeclinedFigure(  # type: ignore[attr-defined]
        "A figure invented by a test, so that the surface can be watched "
        "acquiring one without a list being edited.",
        figure="a ninth absence",
        kind="unrun",
        surface="this test only",
    )
    assert "A_NINTH_ABSENCE" in by_name()

    with TestClient(app) as client:
        body = client.get("/v1/meta").json()
    assert "A_NINTH_ABSENCE" in {entry["name"] for entry in body["declines"]}


# --- the distinction that must survive ----------------------------------------


def test_unrunnable_and_unrun_are_two_sentences_and_stay_two() -> None:
    """Forecaster 16 against forecaster 18, as data rather than as prose.

    A refactor that collapsed the two into one "unavailable" bucket would pass
    every other assertion in this file. This one is what it would have to
    delete.
    """
    kinds = {name: entry["kind"] for name, entry in by_name().items()}
    assert kinds["ARCHIVE_FEATURES_HAVE_NO_SHAPE"] == "unrunnable"
    assert kinds["NO_TFT_IMPLEMENTATION"] == "unrunnable"
    assert kinds["NOT_RUN_YET"] == "unrun"
    assert kinds["CORRELATION_NOT_RUN_YET"] == "unrun"
    assert kinds["MARGINAL_COVERAGE_NOT_RUN_YET"] == "unrun"
    assert kinds["ARCHIVE_FEATURES_HAVE_NO_SHAPE"] != kinds["CORRELATION_NOT_RUN_YET"]
    assert len(set(kinds.values())) == 2


def test_a_reason_cannot_be_declared_without_choosing_one() -> None:
    with pytest.raises(ValueError, match="unrunnable"):
        DeclinedFigure(
            "A sentence with no verdict on whether the thing can be run.",
            figure="a figure",
            kind="unavailable",  # type: ignore[arg-type]
            surface="nowhere",
        )


def test_every_kind_on_the_surface_is_one_of_the_two() -> None:
    for entry in declined_figures():
        assert entry["kind"] in DECLINE_KINDS


# --- what each entry has to carry ---------------------------------------------


def test_each_entry_carries_its_reason_the_figure_and_where_it_is_met() -> None:
    for entry in declined_figures():
        assert set(entry) == {
            "name",
            "declared_in",
            "figure",
            "kind",
            "reason",
            "surface",
        }
        for key, value in entry.items():
            assert isinstance(value, str), key
            assert value.strip() != "", key
        assert len(entry["reason"]) > 60


def test_nothing_on_the_surface_is_a_figure() -> None:
    """The rule that produced these reasons, applied to the census of them.

    Every field is prose. There is no number anywhere on this surface, so
    there is nothing on it a reader could mistake for a measurement — which a
    list of withheld measurements is the last place that could afford.
    """
    for entry in declined_figures():
        assert not any(isinstance(value, (int, float)) for value in entry.values())


def test_a_reason_is_its_own_registry_entry() -> None:
    """The seam: the constant did not move, so no call site had to.

    Every one of these is still the string it was — ``==`` against a card
    field, ``in`` against a claim note — and carries the census fields as well.
    """
    for reason in (
        ARCHIVE_FEATURES_HAVE_NO_SHAPE,
        CORRELATION_NOT_RUN_YET,
        MARGINAL_COVERAGE_NOT_RUN_YET,
        NO_TFT_IMPLEMENTATION,
        NOT_RUN_YET,
        COLD_START_DETAIL,
        NO_TRAINING_COST_MEASURED,
    ):
        assert isinstance(reason, DeclinedFigure)
        assert isinstance(reason, str)
        assert reason == str(reason)


def test_the_eight_the_ticket_names_are_all_here_except_the_gateways() -> None:
    """Seven of the eight. The eighth is the gateway's and is asserted there.

    ``band_unavailable_reason: "no_joint_ensemble"`` is produced by
    `apps/api/src/api/grid.ts` off a `packages/core` schema enum, and this
    service never spells it — so it is declared where it is produced and
    `packages/core/test/declines.test.ts` is what keeps that half honest.
    """
    assert set(by_name()) >= {
        "ARCHIVE_FEATURES_HAVE_NO_SHAPE",
        "CORRELATION_NOT_RUN_YET",
        "MARGINAL_COVERAGE_NOT_RUN_YET",
        "NO_TFT_IMPLEMENTATION",
        "NOT_RUN_YET",
        "COLD_START_DETAIL",
        "NO_TRAINING_COST_MEASURED",
    }


# --- the route ----------------------------------------------------------------


def test_the_meta_route_can_show_every_reason_that_exists() -> None:
    """The acceptance box, from the outside.

    A reason the surface cannot render is a reason nobody can find, which is
    the whole defect this ticket exists to close.
    """
    with TestClient(app) as client:
        body = client.get("/v1/meta").json()
    assert {entry["name"] for entry in body["declines"]} == set(by_name())
    assert body["declines"] == list(declined_figures())


def test_the_route_reports_the_census_even_with_no_volume_and_no_database() -> None:
    """It is a property of this build, not of this deployment's state.

    The lanes go empty when nothing is mounted. What the system declines to
    state does not, because it is a fact about the code that answered.
    """
    with TestClient(app) as client:
        body = client.get("/v1/meta").json()
    assert body["artifacts"]["count"] == 0
    assert len(body["declines"]) >= 7


# --- forecaster 27: the family that was private -------------------------------

#: The absences `.scratch/forecaster/issues/27` names, and the kind each one
#: had to be given. **This is the ticket, not a registry** — nothing reads it
#: but the two assertions below, and a fourteenth absence declared tomorrow
#: reaches `/v1/meta` without appearing here (see
#: :func:`test_a_new_reason_appears_with_no_list_edited`).
#:
#: The kinds are the argument each one turned on:
#:
#: - The lead-time block's ``reads`` and the benchmark's are ``unrunnable``,
#:   because they say *why* in their own sentences — no expressible archive
#:   feature row, and no TFT implementation — and they are the companions of
#:   ``ARCHIVE_FEATURES_HAVE_NO_SHAPE`` and ``NO_TFT_IMPLEMENTATION``, which
#:   forecaster 25 put in that kind.
#: - The DESSEM, sweep, planning-arm and collapse blocks are ``unrun``: the arms
#:   and their data exist and nobody has scored them, which is forecaster 18's
#:   position and the reason ``NOT_RUN_YET`` is worded as it is.
#: - Every absence on a *fold* is ``unrunnable``: a fold whose test period holds
#:   no curtailed hour, and a deciding segment with no complete settled day, are
#:   absences no rerun of that fold could fill. ``COLD_START_DETAIL`` — "this
#:   lane has promoted nothing" — is forecaster 25's own precedent for reading
#:   a structural absence that way rather than as "not yet".
FORECASTER_27_ABSENCES = {
    "LEAD_TIME_COLUMNS_NOT_SCORED": "unrunnable",
    "DESSEM_ARMS_NOT_SCORED": "unrun",
    "NO_DECIDING_FOLD": "unrun",
    "BENCHMARK_ARMS_NOT_SCORED": "unrunnable",
    "SWEEP_ARMS_NOT_SCORED": "unrun",
    "NO_HELDOUT_BAND_FOR_ARMS": "unrun",
    "NO_HELDOUT_BAND_TO_COUNT": "unrun",
    "NO_CURTAILED_HOUR_TO_COVER": "unrunnable",
    "NO_SETTLED_DAY_TO_SCORE": "unrunnable",
    "NEITHER_SIDE_HAS_A_COMPLETE_DAY": "unrunnable",
    "CANDIDATE_HAS_NO_COMPLETE_DAY": "unrunnable",
    "INCUMBENT_SUBSYSTEM_HAS_NO_FLOOR": "unrunnable",
    "CANDIDATE_SUBSYSTEM_NOT_MEASURED": "unrunnable",
}


def test_the_family_that_was_private_is_named_and_on_the_census() -> None:
    """Forecaster 25 reported these and could not see them; now the walk can.

    Six ``_NOTHING_YET`` constants, ``_NO_DECIDING_FOLD``, two inline sentences
    in ``training/bundle.py`` and four in ``replay/floor_guardrail.py``. The
    underscore was the whole of the defect: :func:`declined_figures` would have
    collected a private constant, but the source scan above only recognises a
    declaration in the repository's own convention, so the two disagreeing is
    what turned an invisible reason into a failing test rather than a shorter
    surface.
    """
    assert set(by_name()) >= set(FORECASTER_27_ABSENCES)


def test_each_of_them_chose_a_kind_and_the_choice_is_the_ticket_s() -> None:
    kinds = {name: entry["kind"] for name, entry in by_name().items()}
    assert {name: kinds[name] for name in FORECASTER_27_ABSENCES} == (
        FORECASTER_27_ABSENCES
    )


def test_naming_them_did_not_stretch_the_binary() -> None:
    """Thirteen more absences and still two kinds. The point of the test above.

    ``NOT_ACHIEVABLE_COLUMN`` is the one the ticket named that fits neither, and
    it is not here: see below.
    """
    assert len({entry["kind"] for entry in declined_figures()}) == 2


# --- the seam, on every one of them -------------------------------------------


def test_no_call_site_changed_behaviour_on_the_blocks_now_named() -> None:
    """The property forecaster 25 built the ``str`` subclass for, exercised.

    Not "``DeclinedFigure`` is a ``str``" — that is one ``isinstance`` — but
    every card field, wire field and guardrail detail these thirteen are
    actually read on, rendered and compared the way its readers compare it:
    ``==`` against the constant, ``in`` against the sentence, and through
    :func:`json.dumps`, which is how all of them reach a volume.
    """
    lane = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
    at = datetime(2026, 6, 1, 3, 0, tzinfo=UTC)
    blocks: tuple[tuple[dict[str, Any], str, str, DeclinedFigure], ...] = (
        (
            UnmeasuredLeadTime(lane=lane, as_of=at, reason="x").card_block(),
            LEAD_TIME_BLOCK_KEY,
            "reads",
            LEAD_TIME_COLUMNS_NOT_SCORED,
        ),
        (
            UnmeasuredDessemDelta(lane=lane, at=at, reason="x").card_block(),
            DESSEM_DELTA_BLOCK_KEY,
            "reads",
            DESSEM_ARMS_NOT_SCORED,
        ),
        (
            UnmeasuredTransformerBenchmark(at=at, reason="x").card_block(),
            TRANSFORMER_BENCHMARK_BLOCK_KEY,
            "reads",
            BENCHMARK_ARMS_NOT_SCORED,
        ),
        (
            UnmeasuredThresholdSweep(at=at, reason="x").card_block(),
            THRESHOLD_SWEEP_BLOCK_KEY,
            "reads",
            SWEEP_ARMS_NOT_SCORED,
        ),
        (
            UnmeasuredPlanningArms(lane=lane, as_of=at, reason="x").card_block(),
            PLANNING_ARMS_BLOCK_KEY,
            "reads",
            NO_HELDOUT_BAND_FOR_ARMS,
        ),
        (
            UnmeasuredCollapse(lane=lane, as_of=at, reason="x").card_block(),
            COLLAPSE_BLOCK_KEY,
            "reads",
            NO_HELDOUT_BAND_TO_COUNT,
        ),
    )
    for block, key, field, reason in blocks:
        assert block[key][field] == reason
        assert reason in json.dumps(block, ensure_ascii=False)
        assert json.loads(json.dumps(block))[key][field] == reason
        assert isinstance(block[key][field], str)


def test_the_no_verdict_wire_field_is_the_constant_it_always_was() -> None:
    """``no_verdict_reason`` has its own field on the ``dessem_delta`` block.

    Named rather than inline, and the field is read by identity — so the
    equality that mattered is the one asserted here.
    """
    assert str(NO_DECIDING_FOLD) == NO_DECIDING_FOLD
    assert "no verdict was taken" in NO_DECIDING_FOLD
    assert json.loads(json.dumps({"no_verdict_reason": NO_DECIDING_FOLD})) == {
        "no_verdict_reason": str(NO_DECIDING_FOLD)
    }


def test_the_two_bundle_sentences_still_read_as_the_card_s_readers_read_them() -> None:
    """``coverage_absent_reason`` and ``day_grain_absent_reason``, verbatim.

    These two were fully anonymous — inline sentences in a card dictionary with
    no constant to grep for. Both are asserted by substring elsewhere in this
    suite (``test_conformal_quantiles.py``) and by the gateway
    (``apps/api/test/model-card.test.ts``), which is exactly the kind of reader
    the ``str`` subclass exists to leave alone.
    """
    assert "no curtailed hour" in NO_CURTAILED_HOUR_TO_COVER
    assert "twenty-four hours are all settled" in NO_SETTLED_DAY_TO_SCORE
    for reason in (NO_CURTAILED_HOUR_TO_COVER, NO_SETTLED_DAY_TO_SCORE):
        assert json.loads(json.dumps({"reason": reason})) == {"reason": str(reason)}


def _coverage(subsystem: Subsystem) -> FloorCoverage:
    """One subsystem with a complete day, and the rest absent."""
    return FloorCoverage(
        row_id="F6",
        fidelity="point_in_time",
        by_subsystem=(
            SubsystemFloorCoverage(subsystem=subsystem, days=2, days_floor_met=2),
        ),
        days_excluded_incomplete=0,
    )


def test_the_four_guardrail_details_are_named_and_still_the_same_sentences() -> None:
    """The absences the guardrail reports, on the fields the gate writes.

    ``detail`` reaches the promotion log line and the artifact card as prose, so
    the assertion is on the rendered value and not on the constant.
    """
    lane = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
    provenance = FloorCoverageProvenance.fixture(lane=lane)
    neither = compare_floor_coverage(
        candidate=None, incumbent=None, provenance=provenance
    )
    assert neither.detail == NEITHER_SIDE_HAS_A_COMPLETE_DAY
    assert neither.as_dict()["detail"] == str(NEITHER_SIDE_HAS_A_COMPLETE_DAY)

    ours_absent = compare_floor_coverage(
        candidate=None, incumbent=_coverage("SE"), provenance=provenance
    )
    assert ours_absent.detail == CANDIDATE_HAS_NO_COMPLETE_DAY

    split = compare_floor_coverage(
        candidate=_coverage("S"), incumbent=_coverage("SE"), provenance=provenance
    )
    by_subsystem = {entry.subsystem: entry for entry in split.by_subsystem}
    assert by_subsystem["S"].detail == INCUMBENT_SUBSYSTEM_HAS_NO_FLOOR
    assert by_subsystem["S"].verdict == "not_applicable"
    assert CANDIDATE_SUBSYSTEM_NOT_MEASURED in by_subsystem["SE"].detail
    assert by_subsystem["SE"].verdict == "vetoed"
    assert json.loads(json.dumps(split.as_dict()))["by_subsystem"][0]["detail"]


def test_every_name_the_ticket_gave_is_still_a_string_and_a_declined_figure() -> None:
    for name in FORECASTER_27_ABSENCES:
        entry = by_name()[name]
        assert isinstance(entry["reason"], str)
        assert len(entry["reason"]) > 60


# --- and the one that fits neither kind ---------------------------------------


def test_the_not_achievable_column_stays_out_and_is_not_an_absence() -> None:
    """Reported rather than withheld, so it is forecaster 28's and not this one's.

    ``NOT_ACHIEVABLE_COLUMN`` is identity-shaped like ``no_joint_ensemble`` and
    the ticket lists it, but it withholds nothing: ``archive_to_archive``
    publishes a full metrics row, on purpose, because the gap between it and the
    control *is* the size of the leak in the product's own metric. What it
    carries is a caveat on a present number — ``achievable=False`` and a label
    reading NOT ACHIEVABLE — which is the ``_NOT_A_READING`` category forecaster
    25 kept out and forecaster 28 exists for. Giving it a ``kind`` would have
    had to mean "published and must not be read as achievable", which is
    neither ``unrunnable`` nor ``unrun``.

    There is a second, mechanical reason it could not have been forced: it is a
    ``LeadTimeColumn`` — a ``Literal`` used as a key of ``COLUMN_DEFINITIONS``
    and matched by ``pytest.raises`` — and its value is the identity
    ``archive_to_archive``, not a reason sentence a census could show.
    """
    assert not isinstance(NOT_ACHIEVABLE_COLUMN, DeclinedFigure)
    assert NOT_ACHIEVABLE_COLUMN not in by_name()
    assert COLUMN_DEFINITIONS[NOT_ACHIEVABLE_COLUMN].achievable is False
    assert "NOT ACHIEVABLE" in COLUMN_DEFINITIONS[NOT_ACHIEVABLE_COLUMN].label


def test_the_not_a_reading_family_stays_out_of_this_census() -> None:
    """Forecaster 28's subject, and the acceptance box that says so.

    A published figure that means nothing is a caveat, not an absence: the
    block's numbers are there, and the sentence is about what they are
    arithmetic over. Asserted by rule — no module-level constant in this
    package holds one of these sentences as a ``DeclinedFigure`` — rather than
    by naming the four modules that have one.
    """
    for entry in declined_figures():
        assert "NOT A MEASUREMENT OF THE GRID" not in entry["reason"]
