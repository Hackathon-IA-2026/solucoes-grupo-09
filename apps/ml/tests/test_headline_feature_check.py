"""The headline-feature check, on models whose largest mover is known by hand.

`docs/specs/diagnosis.md` asks the card for a block "recording, per group,
whether the declared headline feature was the largest mean-``|φ|`` member on the
newest fold". A verdict has no ground truth on a fitted model, so every test
here is taken on a synthetic ``g`` where the answer can be written down: a
linear score whose coefficients *are* the ranking, over a background of zeros
whose column means are therefore zero.

The pair that matters is
:func:`test_the_declared_headline_is_confirmed_when_it_is_the_largest_mover` and
:func:`test_a_headline_that_is_not_the_largest_mover_is_a_mismatch`. They are
the same model and the same map with two coefficients exchanged, so between
them they show the check can say either thing — a check that could only ever
return ``confirmed`` would pass every test written the first way.
"""

from __future__ import annotations

import ast
from collections.abc import Callable, Sequence
from dataclasses import replace
from pathlib import Path

import numpy as np
import numpy.typing as npt
import pytest

import wattsteer_ml.diagnosis as diagnosis_package
from attribution_fixtures import background_of, block_of, fixture_key, synthetic_map
from wattsteer_ml.driver_groups import DRIVER_GROUP_CODES, DriverGroupMap
from wattsteer_ml.training import FeatureBlock
from wattsteer_ml.training.headline_check import (
    HEADLINE_VERDICTS,
    HeadlineCheckError,
    HeadlineFeatureCheck,
    check_headline_features,
)

#: Two members per group, sixteen columns. Two is the smallest number that lets
#: a group's declared headline lose, which is the property under test.
MEMBERS: tuple[tuple[str, ...], ...] = tuple(
    (f"{code}_a", f"{code}_b") for code in DRIVER_GROUP_CODES
)

FIXTURE_MAP: DriverGroupMap = synthetic_map(MEMBERS)

#: :func:`synthetic_map` declares each group's *first* member as its headline,
#: so ``*_a`` is the declaration everywhere and ``*_b`` is the challenger.
NAMES: tuple[str, ...] = tuple(name for group in MEMBERS for name in group)

BACKGROUND_ROWS = 8


class BlockFunction:
    """A ``g`` written per row, in the shape the check takes it.

    Counts its calls and the rows it saw, so a test can assert the check
    actually evaluated a model rather than concluding from nothing.
    """

    def __init__(self, evaluate: Callable[[npt.NDArray[np.float64]], float]) -> None:
        self._evaluate = evaluate
        self.calls = 0
        self.rows_seen = 0

    def __call__(self, block: FeatureBlock) -> Sequence[float]:
        self.calls += 1
        self.rows_seen += len(block.matrix)
        return [self._evaluate(row) for row in block.matrix]


def linear(weights: Sequence[float]) -> BlockFunction:
    """``g(x) = Σ wⱼ xⱼ``.

    Over a zero background and a target of ones, ``φ_m = w_m`` exactly — the
    one-player game's value is ``g`` with column ``m`` moved from ``0`` to ``1``
    and everything else left at the background — so the coefficients are the
    mean-``|φ|`` ranking and no arithmetic in the test reproduces the check's.
    """
    coefficients = np.asarray(weights, dtype=np.float64)
    return BlockFunction(lambda row: float(coefficients @ row))


def run(
    expectation: BlockFunction,
    *,
    names: Sequence[str] = NAMES,
    group_map: DriverGroupMap = FIXTURE_MAP,
    target: npt.NDArray[np.float64] | None = None,
    background_rows: int = BACKGROUND_ROWS,
) -> HeadlineFeatureCheck:
    """One check, over one target of ones against a background of zeros."""
    key = fixture_key()
    ones = np.ones((1, len(names)), dtype=np.float64) if target is None else target
    return check_headline_features(
        block=block_of(names, (key,), ones),
        background=background_of(
            names, np.zeros((background_rows, len(names)), dtype=np.float64), key=key
        ),
        expectation=expectation,
        group_map=group_map,
        fold_id="F-fixture",
    )


def verdicts(check: HeadlineFeatureCheck) -> dict[str, str]:
    return {group.code: group.verdict for group in check.groups}


# --- the two halves of the same fixture ---------------------------------------


def test_the_declared_headline_is_confirmed_when_it_is_the_largest_mover() -> None:
    """``*_a`` weighted above ``*_b`` in every group, and the map declares ``*_a``."""
    check = run(linear([2.0, 1.0] * len(DRIVER_GROUP_CODES)))
    assert set(verdicts(check).values()) == {"confirmed"}
    assert check.mismatched == ()
    for group in check.groups:
        assert group.largest_member == group.headline_feature
        assert group.headline_mean_abs_phi_mwh == pytest.approx(2.0)
        assert group.largest_mean_abs_phi_mwh == pytest.approx(2.0)


def test_a_headline_that_is_not_the_largest_mover_is_a_mismatch() -> None:
    """The same model with one group's two coefficients exchanged.

    One group, so the assertion is also that the other seven are undisturbed —
    a check that returned ``mismatch`` for everything would pass a test that
    only looked at the group it broke.
    """
    weights = [2.0, 1.0] * len(DRIVER_GROUP_CODES)
    weights[4], weights[5] = 1.0, 3.0  # the third group, `net_surplus`
    check = run(linear(weights))
    assert verdicts(check)["net_surplus"] == "mismatch"
    assert check.mismatched == ("net_surplus",)
    assert {
        code: verdict
        for code, verdict in verdicts(check).items()
        if code != "net_surplus"
    } == {code: "confirmed" for code in DRIVER_GROUP_CODES if code != "net_surplus"}

    surplus = next(one for one in check.groups if one.code == "net_surplus")
    assert surplus.headline_feature == "net_surplus_a"
    assert surplus.largest_member == "net_surplus_b"
    assert surplus.headline_mean_abs_phi_mwh == pytest.approx(1.0)
    assert surplus.largest_mean_abs_phi_mwh == pytest.approx(3.0)


def test_a_mismatch_changes_nothing_but_the_verdict() -> None:
    """ "A card warning, never an automatic relabel" — asserted, not intended.

    The map the check ranked under is the map it came in with, member for
    member, and the mismatched group still declares the headline it declared.
    """
    weights = [2.0, 1.0] * len(DRIVER_GROUP_CODES)
    weights[4], weights[5] = 1.0, 3.0
    check = run(linear(weights))
    assert check.mismatched == ("net_surplus",)
    assert check.group_map is FIXTURE_MAP
    assert check.group_map.groups == FIXTURE_MAP.groups
    assert FIXTURE_MAP.group("net_surplus").headline_feature == "net_surplus_a"
    # And the type has no way of saying otherwise: nothing on the check returns
    # a map, a group or a member ordering that a caller could adopt.
    assert not [
        name
        for name in dir(check)
        if not name.startswith("_") and "relabel" in name.lower()
    ]


# --- the three verdicts that are absences ------------------------------------


def test_a_model_that_moves_for_nothing_is_no_movement_and_not_a_confirmation() -> None:
    """Every member's mean ``|φ|`` is exactly zero, so "largest" has no referent.

    The trap this closes: ``max`` over eight equal zeros returns *something*,
    and reporting it would be an invented ranking published as a verdict.
    """
    check = run(BlockFunction(lambda row: 41.0))
    assert set(verdicts(check).values()) == {"no_movement"}
    assert check.mismatched == ()
    for group in check.groups:
        assert group.largest_member is None
        assert group.headline_mean_abs_phi_mwh == 0.0


def test_a_group_with_no_member_in_this_contract_is_a_verdict() -> None:
    """A fixture contract's ordinary case, and never a silent `confirmed`."""
    dropped = tuple(name for name in NAMES if not name.startswith("export_stress"))
    check = run(
        linear([1.0] * len(dropped)), names=dropped, background_rows=BACKGROUND_ROWS
    )
    assert verdicts(check)["export_stress"] == "no_member_in_contract"
    export = next(one for one in check.groups if one.code == "export_stress")
    assert export.members_in_contract == 0
    assert export.headline_mean_abs_phi_mwh is None
    assert export.largest_mean_abs_phi_mwh is None


def test_a_headline_absent_from_this_contract_is_its_own_verdict() -> None:
    """The group is measurable and its declaration is not. Distinguished."""
    dropped = tuple(name for name in NAMES if name != "ramp_shape_a")
    check = run(linear([1.0] * len(dropped)), names=dropped)
    assert verdicts(check)["ramp_shape"] == "headline_not_in_contract"
    ramp = next(one for one in check.groups if one.code == "ramp_shape")
    assert ramp.headline_feature == "ramp_shape_a"
    assert ramp.members_in_contract == 1
    assert ramp.largest_member is None


def test_every_verdict_in_the_closed_set_is_reachable() -> None:
    """The census, so a verdict nobody can produce is a failure and not a comment.

    Each of the five is produced here by a construction, not asserted to exist.
    """
    confirmed = run(linear([2.0, 1.0] * len(DRIVER_GROUP_CODES)))
    swapped = [2.0, 1.0] * len(DRIVER_GROUP_CODES)
    swapped[4], swapped[5] = 1.0, 3.0
    mismatched = run(linear(swapped))
    flat = run(BlockFunction(lambda row: 41.0))
    no_member = run(
        linear([1.0] * (len(NAMES) - 2)),
        names=tuple(n for n in NAMES if not n.startswith("export_stress")),
    )
    no_headline = run(
        linear([1.0] * (len(NAMES) - 1)),
        names=tuple(n for n in NAMES if n != "ramp_shape_a"),
    )
    produced = {
        verdict
        for check in (confirmed, mismatched, flat, no_member, no_headline)
        for verdict in verdicts(check).values()
    }
    assert produced == set(HEADLINE_VERDICTS)


# --- an empty evaluation is not a confirmation --------------------------------


def test_a_check_over_no_fold_row_is_refused() -> None:
    """The bug this repo has shipped: a guard whose input is empty passing."""
    key = fixture_key()
    with pytest.raises(HeadlineCheckError, match="empty"):
        check_headline_features(
            block=block_of(NAMES, (), np.zeros((0, len(NAMES)), dtype=np.float64)),
            background=background_of(
                NAMES, np.zeros((BACKGROUND_ROWS, len(NAMES)), dtype=np.float64), key=key
            ),
            expectation=linear([1.0] * len(NAMES)),
            group_map=FIXTURE_MAP,
            fold_id="F-fixture",
        )


def test_a_check_over_no_member_of_any_group_is_refused() -> None:
    """A contract that shares no column with the map ranks nothing."""
    strangers = tuple(f"unplaced_{index}" for index in range(4))
    with pytest.raises(HeadlineCheckError, match="nothing to rank"):
        run(linear([1.0] * len(strangers)), names=strangers)


def test_a_check_over_zero_targets_is_refused() -> None:
    key = fixture_key()
    with pytest.raises(HeadlineCheckError, match="not a mean"):
        check_headline_features(
            block=block_of(NAMES, (key,), np.ones((1, len(NAMES)), dtype=np.float64)),
            background=background_of(
                NAMES, np.zeros((BACKGROUND_ROWS, len(NAMES)), dtype=np.float64), key=key
            ),
            expectation=linear([1.0] * len(NAMES)),
            group_map=FIXTURE_MAP,
            fold_id="F-fixture",
            targets=0,
        )


def test_a_fold_row_in_no_background_cell_is_refused_and_not_averaged_over() -> None:
    """The sample is matched, so a target with no cell has no typical at all."""
    key = fixture_key()
    elsewhere = fixture_key(subsystem="S", local_hour=3)
    with pytest.raises(HeadlineCheckError, match="no fold row"):
        check_headline_features(
            block=block_of(
                NAMES, (elsewhere,), np.ones((1, len(NAMES)), dtype=np.float64)
            ),
            background=background_of(
                NAMES, np.zeros((BACKGROUND_ROWS, len(NAMES)), dtype=np.float64), key=key
            ),
            expectation=linear([1.0] * len(NAMES)),
            group_map=FIXTURE_MAP,
            fold_id="F-fixture",
        )


def test_a_check_cannot_be_constructed_over_nothing() -> None:
    """The value type refuses it too, so no future caller can assemble one."""
    confirmed = run(linear([2.0, 1.0] * len(DRIVER_GROUP_CODES)))
    with pytest.raises(HeadlineCheckError, match="not a confirmation"):
        replace(confirmed, targets=0)
    with pytest.raises(HeadlineCheckError, match="not a confirmation"):
        replace(confirmed, members_evaluated=0)


def test_the_check_reports_what_it_actually_evaluated() -> None:
    """The counts are measured off the run, and they reach the card.

    Held against the model's own call counters, so a check that concluded from
    zero evaluations could not report a number that agreed with them.
    """
    expectation = linear([2.0, 1.0] * len(DRIVER_GROUP_CODES))
    check = run(expectation)
    assert check.targets == 1
    assert check.members_evaluated == len(NAMES)
    # One batched call per target, `1 + k` blocks of `|B|` rows in it.
    assert expectation.calls == check.targets
    assert expectation.rows_seen == check.targets * (len(NAMES) + 1) * BACKGROUND_ROWS
    block = check.card_fields()["headline_feature_check"]
    assert block["targets"] == "1"
    assert block["members_evaluated"] == str(len(NAMES))
    assert int(block["members_evaluated"]) > 0


# --- the three card fields ----------------------------------------------------


def test_the_card_fields_are_the_three_the_spec_asks_for() -> None:
    """And the two identity fields come from the map, not from a second spelling."""
    fields = run(linear([2.0, 1.0] * len(DRIVER_GROUP_CODES))).card_fields()
    assert set(fields) == {
        "driver_group_version",
        "driver_group_hash",
        "headline_feature_check",
    }
    assert fields["driver_group_hash"] == FIXTURE_MAP.driver_group_hash
    assert fields["driver_group_version"] == str(FIXTURE_MAP.version)


def test_the_card_block_carries_one_entry_per_group_and_the_mismatches_beside() -> None:
    weights = [2.0, 1.0] * len(DRIVER_GROUP_CODES)
    weights[4], weights[5] = 1.0, 3.0
    block = run(linear(weights)).card_fields()["headline_feature_check"]
    assert [one["code"] for one in block["groups"]] == list(DRIVER_GROUP_CODES)
    assert block["mismatches"] == ["net_surplus"]
    for entry in block["groups"]:
        assert entry["verdict"] in HEADLINE_VERDICTS
        assert entry["headline_feature"]
    assert block["fold_id"] == "F-fixture"
    assert int(block["seed"]) > 0


def test_the_verdict_and_the_two_numbers_cannot_disagree() -> None:
    """The value type refuses a confirmation whose largest member is someone else."""
    confirmed = run(linear([2.0, 1.0] * len(DRIVER_GROUP_CODES)))
    first = confirmed.groups[0]
    with pytest.raises(HeadlineCheckError, match="confirmed but the largest"):
        type(first)(
            code=first.code,
            headline_feature=first.headline_feature,
            verdict="confirmed",
            largest_member="somebody_else",
            headline_mean_abs_phi_mwh=1.0,
            largest_mean_abs_phi_mwh=2.0,
            members_in_contract=2,
        )
    with pytest.raises(HeadlineCheckError, match="whose largest member is the headline"):
        type(first)(
            code=first.code,
            headline_feature=first.headline_feature,
            verdict="mismatch",
            largest_member=first.headline_feature,
            headline_mean_abs_phi_mwh=1.0,
            largest_mean_abs_phi_mwh=1.0,
            members_in_contract=2,
        )


# --- seam 3 is not narrowed by this module's existence -----------------------

DIAGNOSIS_SOURCES: tuple[Path, ...] = tuple(
    sorted(Path(str(diagnosis_package.__file__)).parent.glob("*.py"))
)


def test_no_module_in_the_diagnosis_package_can_reach_this_check() -> None:
    """The check lives outside seam 3's scope, so seam 3 keeps its whole scope.

    ``test_grouped_shapley.py`` scans ``diagnosis/*.py`` for member-level
    attribution vocabulary. This module holds exactly that quantity and lives in
    ``training/`` for the reason its docstring gives — which would be a loophole
    if the diagnosis package could import it and use the numbers. It cannot, and
    that is asserted on the import graph rather than left as a convention.

    Not vacuous: the walk asserts it visited every diagnosis source and that
    those sources do import *something* from ``wattsteer_ml.training``, so a
    rename that made the scan match nothing fails here.
    """
    assert len(DIAGNOSIS_SOURCES) > 5
    training_importers = 0
    for path in DIAGNOSIS_SOURCES:
        source = path.read_text(encoding="utf-8")
        assert "headline_check" not in source, path.name
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.ImportFrom) and node.module:
                assert node.module != "wattsteer_ml.training.headline_check", path.name
                if node.module.startswith("wattsteer_ml.training"):
                    training_importers += 1
    assert training_importers > 0


def test_the_check_never_reaches_the_game_the_eight_groups_play() -> None:
    """It solves one-player games and says so; it does not touch `exact_shapley`.

    A member value that reached :func:`exact_shapley` would be a member sitting
    in a coalition with the eight groups, which is the one thing seam 3 is
    about.
    """
    source = (
        Path(str(__import__("wattsteer_ml.training.headline_check").__file__)).parent
        / "training"
        / "headline_check.py"
    ).read_text(encoding="utf-8")
    assert "exact_shapley" not in source
    assert "coalition_count" not in source
    # And it does not compose either: `g` arrives as an argument.
    assert "from wattsteer_ml.mixture" not in source
    assert "expected_mwh_for_block" not in source.replace(
        ":func:`~wattsteer_ml.training.hurdle.expected_mwh_for_block`", ""
    )
