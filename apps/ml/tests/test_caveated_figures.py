"""The census of figures this service publishes *with* a caveat.

Forecaster 25 built the census of absences and named the family it could not
cover: the ``_NOT_A_READING`` sentences are neither ``unrunnable`` nor
``unrun`` — the figure **is** published, and it does not mean what its name
says. An absent figure cannot mislead anybody. A present one carrying a caveat
nobody reads is a number that will be quoted, and ``coverage_p10 = 1.0`` over
zero rows that state a lower bound was quoted for months as evidence that the
floor was perfect.

## The rule these are found by

Write the sentence a reader takes away from the published pair — *name* is
*value*. A figure is **caveated** when that sentence is false, or is true of
something other than what the name denotes, and only a sentence published
beside it makes it true.

That is deliberately narrower than "worth a footnote", and the narrowness is
what stops this becoming a roll of every note in the repository:

- ``_READS`` is a **definition**. It says what the figure is counted over when
  the figure is what it says; the take-away sentence was already true.
- ``_NOTHING_YET`` is an **absence** and belongs to forecaster 25's census, not
  this one — there is no published value to misread.
- ``_DECIDES_NOTHING`` is about **authority**: nothing may be promoted off this
  block. The number is still exactly what it claims to be.
- ``_SAMPLE_SIZE`` is about **precision**. A figure over 150 target days is a
  figure over 150 target days; the sentence is true and merely weak.

Three axes remain, and they are the axes to look along rather than a list:

1. **the inputs are not the thing** — the arithmetic ran over fabricated rows,
   so the figure is a statement about a fixture (``_NOT_A_READING``);
2. **the support is not the thing** — the figure is counted over rows that
   cannot falsify it, or is an identity restated (``coverage_p10`` over no
   stated row, ``share_p50_zero``);
3. **the population or the parameter is not the one the name carries** — so the
   figure is not the same quantity as the same-named figure beside it
   (``COMPARABILITY``, ``_MIXTURE_CAVEAT``, ``_REVISION_OPTIMISTIC_ONLY``,
   ``nominal_claim``).

## And nothing lists them

Same mechanism as :mod:`wattsteer_ml.declined`, for the same reason: a
hand-maintained roll of caveats would rot *faster* than a roll of absences,
because a caveat attaches to a number people actively use. A caveat sentence
**is** its own census entry — :class:`~wattsteer_ml.caveated.CaveatedFigure`
subclasses :class:`str`, so the sentence a card already carries is the object
the census reads, and no call site moved.

The assertions below are about that mechanism and about the distinction the
census exists to protect, never about the current membership.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from wattsteer_ml.admissibility import CROSS_GATE_DIFFERENCE_IS_NOT_QUALITY
from wattsteer_ml.app import app
from wattsteer_ml.caveated import CaveatedFigure, caveated_figures
from wattsteer_ml.declined import DeclinedFigure, declined_figures
from wattsteer_ml.evaluation.collapse import SHARE_P50_ZERO_IS_NOT_MODEL_QUALITY
from wattsteer_ml.evaluation.threshold_sweep import COMPARABILITY
from wattsteer_ml.training.conformal import (
    COVERAGE_P10_OVER_NO_STATED_ROW,
    COVERAGE_P90_OVER_NO_STATED_ROW,
    NOT_A_NINETY_PERCENT_BAND,
    UPPER_CORRECTION_BOUNDS_COVERAGE_P90,
)

SRC = Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml"

#: Every construction of one, wherever it is written. Unlike the declines scan
#: this is *not* anchored to the start of a line, because several of these are
#: declared as the values of a published mapping — ``COMPARABILITY`` is one
#: figure-to-sentence map and turning it into six module constants to satisfy a
#: regex would be a worse module. Anchoring is therefore replaced by counting:
#: a construction the walk cannot reach is a mismatch here.
CONSTRUCTION = re.compile(r"\bCaveatedFigure\(")


def constructions_in_source() -> int:
    """How many are built anywhere under ``wattsteer_ml``."""
    return sum(
        len(CONSTRUCTION.findall(path.read_text(encoding="utf-8")))
        for path in sorted(SRC.rglob("*.py"))
        if path.name != "caveated.py"
    )


def by_site() -> dict[tuple[str, str], dict[str, Any]]:
    """The census, keyed by where the constant is and what it is called.

    **The name alone is not an identity here, deliberately.** Six modules
    declare a ``_NOT_A_READING``, because six blocks are each arithmetic over
    their own fabricated inputs and each names its own figures; renaming them
    apart to make a bare string unique would invent six distinctions where
    there is one. So the pair is the identity, and it is also the grep.
    """
    return {(entry["declared_in"], entry["name"]): entry for entry in caveated_figures()}


# --- the mechanism ------------------------------------------------------------


def test_the_source_declares_some_caveated_figures() -> None:
    """The guard on the guard: a scan that matched nothing proves nothing."""
    assert constructions_in_source() >= 20


def test_the_set_is_assembled_from_the_constants_and_never_from_a_list() -> None:
    """As many entries as there are constructions, and no name invented.

    A caveat built inside a function is invisible to the walk and is caught
    here as a shortfall; an entry with no construction behind it would be a
    name the assembler made up.
    """
    assert len(by_site()) == constructions_in_source()


def test_every_entry_knows_where_it_is_declared() -> None:
    for (declared_in, _), entry in by_site().items():
        assert declared_in.endswith(".py")
        assert (SRC.parents[3] / declared_in).exists()
        assert entry["declared_in"] == declared_in


def test_a_new_caveat_appears_with_no_list_edited(
    request: pytest.FixtureRequest,
) -> None:
    """The acceptance box, demonstrated rather than argued.

    A caveat declared on a module that already exists is on the surface on the
    next request. Nothing in :mod:`wattsteer_ml.caveated` names it, nothing
    registers it, and no list anywhere was edited to make this pass.
    """
    from wattsteer_ml.evaluation import collapse

    request.addfinalizer(lambda: delattr(collapse, "A_FIGURE_THAT_LIES"))
    collapse.A_FIGURE_THAT_LIES = CaveatedFigure(  # type: ignore[attr-defined]
        "A caveat invented by a test, so that the surface can be watched "
        "acquiring one without a list being edited anywhere.",
        figure="a figure this test made up",
        misreading="that this test measured something",
        surface="this test only",
    )
    assert (
        "apps/ml/src/wattsteer_ml/evaluation/collapse.py",
        "A_FIGURE_THAT_LIES",
    ) in by_site()

    with TestClient(app) as client:
        body = client.get("/v1/meta").json()
    assert "A_FIGURE_THAT_LIES" in {entry["name"] for entry in body["caveats"]}


def test_a_caveat_inside_a_published_mapping_is_found() -> None:
    """``COMPARABILITY`` is one map of figure to sentence and stays one.

    The walk descends into a module-level mapping's values, so a caveat may be
    declared where it is *published* rather than where a regex would find it,
    and the census names it by the subscript a reader would grep for.
    """
    named = by_site()[
        (
            "apps/ml/src/wattsteer_ml/evaluation/threshold_sweep.py",
            'COMPARABILITY["pr_auc"]',
        )
    ]
    assert named["caveat"] == COMPARABILITY["pr_auc"]


def test_one_figure_may_carry_two_caveats() -> None:
    """``share_p50_zero`` has no model-quality content *and* does not survive a
    change of threshold. Two different false take-aways, two entries."""
    caveats = [
        entry
        for entry in caveated_figures()
        if "share_p50_zero" in entry["figure"] or "share_p50_zero" in entry["caveat"]
    ]
    assert len(caveats) >= 2


# --- the distinction that must survive ----------------------------------------


def test_a_caveat_is_not_a_decline_and_the_two_censuses_stay_apart() -> None:
    """Forecaster 25's ``kind`` gained no third member, and this is why.

    ``unrunnable`` and ``unrun`` are two answers to *does this figure exist*.
    A caveated figure answers ``yes`` to that question and then a second one
    the ``kind`` binary cannot ask. Putting it in the declines block would file
    a published number under a heading whose whole contract is absence — a
    reviewer reading ``declines`` would take ``coverage_p10`` to be withheld,
    when the defect is precisely that it is not.
    """
    for caveat in caveated_figures():
        assert not isinstance(caveat["caveat"], DeclinedFigure)
        assert "kind" not in caveat
    declines = {(entry["declared_in"], entry["name"]) for entry in declined_figures()}
    assert declines.isdisjoint(by_site())


def test_a_decline_cannot_be_republished_as_a_caveat() -> None:
    """Structural, not conventional: the constructor refuses the wrong family."""
    absence = DeclinedFigure(
        "A figure nobody has produced yet, in a sentence long enough to pass.",
        figure="a figure",
        kind="unrun",
        surface="nowhere",
    )
    with pytest.raises(ValueError, match="absence"):
        CaveatedFigure(
            absence,
            figure="a figure",
            misreading="that it was published",
            surface="nowhere",
        )


def test_a_caveat_cannot_be_declared_without_the_sentence_it_corrects() -> None:
    """The forced choice this census makes an author face.

    Writing down what the figure *would* be quoted as is the whole discipline:
    a caveat whose author could not say what the number reads as without it is
    a caveat whose author has not decided whether the number is misleading.
    """
    for field in ("figure", "misreading", "surface"):
        with pytest.raises(ValueError, match=field):
            CaveatedFigure(
                "A sentence that corrects something, at reviewable length.",
                **{
                    "figure": "a figure",
                    "misreading": "that it means something",
                    "surface": "somewhere",
                    field: "   ",
                },
            )


def test_the_misreading_may_not_be_the_caveat_restated() -> None:
    sentence = "A caveat that corrects something, at reviewable length."
    with pytest.raises(ValueError, match="restat"):
        CaveatedFigure(
            sentence,
            figure="a figure",
            misreading=sentence,
            surface="somewhere",
        )


# --- what each entry has to carry ---------------------------------------------


def test_each_entry_carries_the_figure_the_misreading_and_where_it_is_met() -> None:
    for entry in caveated_figures():
        assert set(entry) == {
            "name",
            "declared_in",
            "figure",
            "caveat",
            "misreading",
            "surface",
        }
        for key, value in entry.items():
            assert isinstance(value, str), key
            assert value.strip() != "", key
        assert len(entry["caveat"]) > 60


def test_nothing_on_the_surface_is_a_figure() -> None:
    """A census of numbers that mean something other than what they say is the
    last surface that could carry one of them."""
    for entry in caveated_figures():
        assert not any(isinstance(value, (int, float)) for value in entry.values())


def test_a_caveat_is_its_own_registry_entry_and_no_call_site_moved() -> None:
    """The seam. Every one of these is still the string it was.

    This is the hard constraint of the ticket as a test: a caveat that already
    reaches a consumer must keep reaching it, in the same field, in the same
    words. ``COMPARABILITY`` is still a ``dict[str, str]`` that ``dict()``
    copies, ``NOT_A_NINETY_PERCENT_BAND`` is still the string ``claim_note``
    joins, and every one of them is still what ``json.dumps`` writes.
    """
    import json

    for caveat in (
        NOT_A_NINETY_PERCENT_BAND,
        UPPER_CORRECTION_BOUNDS_COVERAGE_P90,
        COVERAGE_P10_OVER_NO_STATED_ROW,
        COVERAGE_P90_OVER_NO_STATED_ROW,
        SHARE_P50_ZERO_IS_NOT_MODEL_QUALITY,
        CROSS_GATE_DIFFERENCE_IS_NOT_QUALITY,
        COMPARABILITY["pr_auc"],
    ):
        assert isinstance(caveat, CaveatedFigure)
        assert isinstance(caveat, str)
        assert caveat == str(caveat)
        assert json.loads(json.dumps({"note": caveat}))["note"] == str(caveat)


def test_the_load_bearing_sentences_are_unchanged() -> None:
    """Three the ticket names by hand, because they already reach a consumer.

    ``NOT_A_NINETY_PERCENT_BAND`` must still refuse in its own words; only
    ``qloss_mwh`` may still be read across the sweep's arms; and the
    ``_NOT_A_READING`` prose must still shout.
    """
    assert "must not be described as one" in NOT_A_NINETY_PERCENT_BAND
    assert "comparable." in COMPARABILITY["qloss_mwh"]
    assert not isinstance(COMPARABILITY["qloss_mwh"], CaveatedFigure)
    assert set(COMPARABILITY) == {
        "prevalence",
        "positives_per_local_hour",
        "pr_auc",
        "qloss_mwh",
        "coverage_p10",
        "share_p50_zero",
    }
    shouted = [entry for entry in caveated_figures() if entry["name"] == "_NOT_A_READING"]
    assert len(shouted) == 6
    for entry in shouted:
        assert "NOT A MEASUREMENT OF THE GRID" in entry["caveat"]


# --- the route ----------------------------------------------------------------


def test_the_meta_route_can_show_every_caveat_that_exists() -> None:
    with TestClient(app) as client:
        body = client.get("/v1/meta").json()
    assert body["caveats"] == list(caveated_figures())
    assert len(body["caveats"]) >= 20


def test_the_route_reports_the_census_even_with_no_volume_and_no_database() -> None:
    """A property of this build, not of this deployment's state."""
    with TestClient(app) as client:
        body = client.get("/v1/meta").json()
    assert body["artifacts"]["count"] == 0
    assert len(body["caveats"]) >= 20
