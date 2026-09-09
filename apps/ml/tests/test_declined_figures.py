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

import re
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from wattsteer_ml.app import app
from wattsteer_ml.declined import (
    DECLINE_KINDS,
    DeclinedFigure,
    declined_figures,
)
from wattsteer_ml.evaluation.dessem_ab import NOT_RUN_YET
from wattsteer_ml.evaluation.lead_time import (
    ARCHIVE_FEATURES_HAVE_NO_SHAPE,
    CORRELATION_NOT_RUN_YET,
)
from wattsteer_ml.evaluation.transformer_benchmark import (
    NO_TFT_IMPLEMENTATION,
    NO_TRAINING_COST_MEASURED,
)
from wattsteer_ml.replay.floor_guardrail import COLD_START_DETAIL
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
