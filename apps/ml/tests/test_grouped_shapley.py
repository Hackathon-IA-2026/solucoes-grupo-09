"""Eight signed numbers for one hour, and the three things that make them mean it.

`docs/specs/diagnosis.md` seams 1, 2 and 3. An attribution has no ground truth,
so every test here asserts an invariant of the *construction*:

- **Seam 1 — local accuracy, as arithmetic.** ``Σⱼ φⱼ == g(x) − v(∅)`` on
  fixture models with no training involved, for random feature vectors, for
  ``p = 0``, for ``p = 1`` and at the isotonic clip endpoints. This is the
  property that makes the shares mean something.
- **Seam 2 — the additive cross-check, which is where grouping is validated.**
  On a model additive across the group boundary, grouped Shapley **must equal**
  the sum of the member features' interventional Shapley values; on a model with
  a cross-group interaction it **must not**, and the gap is exactly what the
  interaction contributes. Together they pin down that the implementation solves
  the game it claims to solve, and they are what a future session that wants to
  "simplify" grouping into summation has to confront.
- **Seam 3 — sign honesty, and the structural test.** A group whose two members
  are ``+40`` and ``−35`` under a per-feature attribution does **not** get
  ``+5``; it gets whatever replacing the whole group with a typical one does.
  And no code path in the diagnosis module sums member-level values into a group
  value — asserted by reading the module, because this is the invariant most
  likely to be broken by a well-meaning optimisation.

Seam 2 computes member-level Shapley values *in these tests* (see
`attribution_fixtures.member_shapley`) precisely in order to prove grouped
Shapley is not their sum. That is not in tension with seam 3, which is scoped to
the diagnosis module and not to its fixtures: the test needs the forbidden
quantity so it can demonstrate the forbidden shortcut is wrong.
"""

from __future__ import annotations

import ast
import math
from collections.abc import Sequence
from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
import pytest

import wattsteer_ml.diagnosis as diagnosis_package
from attribution_fixtures import (
    FixtureComposition,
    RowFunction,
    background_of,
    feature_names_of,
    fixture_key,
    full_factorial,
    member_shapley,
    synthetic_map,
)
from feature_row_fixtures import feature_rows
from wattsteer_ml.diagnosis.attribution import (
    ATTRIBUTION_TARGET_HOUR,
    EXPLAINS_CODE,
    LOCAL_ACCURACY_TOLERANCE,
    AttributionError,
    EmptyPlayerError,
    attribute_hour,
    group_columns,
)
from wattsteer_ml.diagnosis.composed_target import bundle_expectation
from wattsteer_ml.diagnosis.shapley import (
    ShapleyError,
    coalition_count,
    coalition_weights,
    exact_shapley,
)
from wattsteer_ml.driver_groups import (
    DRIVER_GROUP_CODES,
    DRIVER_GROUP_MAP,
    GroupCode,
    UngroupedFeatureError,
)
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.training import FeatureBlock, TrainedFold
from wattsteer_ml.training.background import (
    BACKGROUND_ROWS_PER_CELL,
    draw_matched_background,
)
from wattsteer_ml.training.calibration import IsotonicCalibrator

# --- The eight-player fixture map --------------------------------------------
#
# Nine columns over the eight real group codes: the first group holds two
# members so that "grouped is not the sum of its members" has something to be
# about, and the remaining seven hold one each so the map is a total partition
# and every player exists.

MEMBERS: tuple[tuple[str, ...], ...] = (
    ("f1", "f2"),
    ("f3",),
    ("f4",),
    ("f5",),
    ("f6",),
    ("f7",),
    ("f8",),
    ("f9",),
)
FIXTURE_MAP = synthetic_map(MEMBERS)
FIXTURE_NAMES = feature_names_of(FIXTURE_MAP)
WIDTH = len(FIXTURE_NAMES)

#: The group the two interacting members share, and the group the third sits in.
PAIR_GROUP = DRIVER_GROUP_CODES[0]
THIRD_GROUP = DRIVER_GROUP_CODES[1]


def _factorial_background() -> npt.NDArray[np.float64]:
    """Eight rows, ``±1`` on the three live columns and zero on the rest.

    Every column's mean is zero and every product of distinct columns averages
    to zero, which collapses a multilinear game's coalition values to closed
    form: ``v(S)`` is the sum of the monomials ``S`` holds entirely.
    """
    design = np.zeros((8, WIDTH), dtype=np.float64)
    design[:, :3] = full_factorial(3)
    return design


def _target(*values: float) -> npt.NDArray[np.float64]:
    row = np.zeros(WIDTH, dtype=np.float64)
    row[: len(values)] = values
    return row


# --- The Shapley engine, on its own -------------------------------------------


def test_the_weights_of_each_coalition_size_average_over_orderings() -> None:
    """``Σ_{S ⊆ N\\{j}} w(|S|) == 1`` — the identity that makes φ an average."""
    for players in (1, 2, 5, 8):
        weights = coalition_weights(players)
        total = math.fsum(
            math.comb(players - 1, size) * weights[size] for size in range(players)
        )
        assert total == pytest.approx(1.0, abs=1e-15)


def test_eight_players_is_two_hundred_and_fifty_six_coalitions() -> None:
    """Exact, not sampled — which is what removes noise from the ranking."""
    assert coalition_count(len(DRIVER_GROUP_CODES)) == 256


def test_a_game_with_a_hole_in_it_has_no_shapley_value() -> None:
    with pytest.raises(ShapleyError, match="coalitions"):
        exact_shapley([0.0] * 255, players=8)
    with pytest.raises(ShapleyError, match="v\\("):
        exact_shapley([0.0] * 3 + [float("nan")], players=2)


def test_a_dummy_player_gets_zero_and_equals_get_the_same() -> None:
    """The two axioms a wrong enumeration breaks first."""
    values = [0.0, 3.0, 3.0, 6.0]  # v(S) = 3·|S ∩ {0,1}|, player order irrelevant
    phi = exact_shapley(values, players=2)
    assert phi[0] == pytest.approx(3.0)
    assert phi[1] == pytest.approx(3.0)


# --- Seam 1 — local accuracy, as arithmetic ------------------------------------


def _local_accuracy_case(
    occurrence: Any, *, seed: int
) -> tuple[float, float, tuple[float, ...]]:
    generator = np.random.default_rng(seed)
    background = background_of(FIXTURE_NAMES, generator.normal(size=(12, WIDTH)) * 2.0)
    target_row = generator.normal(size=WIDTH) * 2.0
    expectation = FixtureComposition(
        occurrence=occurrence,
        magnitude_weights=tuple(generator.normal(size=WIDTH) * 3.0),
        sub_threshold_mean_mwh=1.5,
    )
    attribution = attribute_hour(
        key=fixture_key(),
        target_row=target_row,
        background=background,
        expectation=expectation,
        group_map=FIXTURE_MAP,
    )
    return (
        attribution.expected_mwh,
        attribution.baseline_expected_mwh,
        tuple(one.phi_mwh for one in attribution.contributions),
    )


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
def test_the_eight_contributions_sum_to_the_movement_for_random_vectors(
    seed: int,
) -> None:
    """Seam 1, on a ``g`` that is `mixture.compose` and nothing else."""
    expected, baseline, phi = _local_accuracy_case(
        lambda row: 1.0 / (1.0 + math.exp(-float(np.sum(row[:4])))), seed=seed
    )
    assert math.fsum(phi) == pytest.approx(expected - baseline, abs=1e-9)


@pytest.mark.parametrize("probability", [0.0, 1.0])
def test_local_accuracy_holds_at_both_ends_of_the_occurrence_probability(
    probability: float,
) -> None:
    """``p = 0`` and ``p = 1``, where the mixture degenerates to one branch.

    At ``p = 0`` the expectation is ``μ_sub`` for every row and every ``φ`` is
    zero — an hour with nothing to explain, which the arithmetic must survive
    rather than divide by. At ``p = 1`` it is the conditional mean alone.
    """
    expected, baseline, phi = _local_accuracy_case(lambda row: probability, seed=9)
    assert math.fsum(phi) == pytest.approx(expected - baseline, abs=1e-9)
    if probability == 0.0:
        assert expected == baseline
        assert all(value == pytest.approx(0.0, abs=1e-12) for value in phi)


def test_local_accuracy_holds_at_the_isotonic_clip_endpoints() -> None:
    """``p`` pinned to ``1/(2n)`` and ``1 − 1/(2n)``, the only values it can reach.

    The calibrator clips both endpoints away, so the served probability lives on
    a closed interval whose ends are a function of the calibration window's row
    count. A ``g`` that is a step between those two ends is the least smooth
    function the attribution will ever see, and efficiency does not care.
    """
    calibrator = IsotonicCalibrator(
        knots_x=(0.0, 1.0),
        knots_y=(0.0, 1.0),
        clip_lo=1 / 128,
        clip_hi=127 / 128,
        fitted_rows=64,
    )

    def occurrence(row: npt.NDArray[np.float64]) -> float:
        return calibrator(1.0 if float(np.sum(row[:3])) > 0.0 else 0.0)

    expected, baseline, phi = _local_accuracy_case(occurrence, seed=17)
    assert math.fsum(phi) == pytest.approx(expected - baseline, abs=1e-9)


def test_an_attribution_whose_sum_is_not_the_movement_cannot_be_constructed() -> None:
    """Local accuracy is checked at construction, not by the tests alone."""
    from wattsteer_ml.diagnosis.attribution import (
        GroupContribution,
        HourAttribution,
        LocalAccuracyError,
    )

    contributions = tuple(
        GroupContribution(
            code=code,
            label_code=f"driver.{code}",
            phi_mwh=1.0,
            share=1.0 / len(DRIVER_GROUP_CODES),
            direction="raises",
        )
        for code in DRIVER_GROUP_CODES
    )
    with pytest.raises(LocalAccuracyError):
        HourAttribution(
            key=fixture_key(),
            target=ATTRIBUTION_TARGET_HOUR,
            contributions=contributions,
            baseline_expected_mwh=0.0,
            expected_mwh=100.0,  # the eight sum to 8, not to 100
            local_accuracy_residual_mwh=0.0,
            background_rows=8,
            background_seed=1,
            background_source="base_fit",
            coalitions=256,
            elapsed_seconds=0.0,
            driver_group_version="1",
            driver_group_hash="sha256:0",
        )


# --- Seam 2 — the additive cross-check ----------------------------------------


def _grouped_and_member(
    game: RowFunction, target_row: npt.NDArray[np.float64]
) -> tuple[dict[GroupCode, float], tuple[float, ...]]:
    background = _factorial_background()
    attribution = attribute_hour(
        key=fixture_key(),
        target_row=target_row,
        background=background_of(FIXTURE_NAMES, background),
        expectation=game,
        group_map=FIXTURE_MAP,
    )
    grouped = {one.code: one.phi_mwh for one in attribution.contributions}
    members = member_shapley(
        key=fixture_key(),
        target_row=target_row,
        background=background,
        game=game,
    )
    return grouped, members


def test_on_an_additive_model_grouped_shapley_is_the_sum_of_its_members() -> None:
    """``g = Σ_j f_j(x_group_j)``: the two coincide, and must.

    ``f_j`` is deliberately non-linear inside the group — ``5·x₁·x₂`` is an
    interaction between two members of the *same* group — because "additive"
    here means additive **across the group boundary**, which is the only
    condition under which the sum is defensible.
    """
    game = RowFunction(
        lambda row: 38.0 * row[0] - 37.0 * row[1] + 5.0 * row[0] * row[1] + 11.0 * row[2]
    )
    target_row = _target(1.0, 1.0, 1.0)
    grouped, members = _grouped_and_member(game, target_row)
    assert grouped[PAIR_GROUP] == pytest.approx(members[0] + members[1], abs=1e-12)
    assert grouped[THIRD_GROUP] == pytest.approx(members[2], abs=1e-12)


def test_on_a_cross_group_interaction_it_is_not_and_the_gap_is_the_interaction() -> None:
    """``g`` with ``λ·x₁·x₂·x₃``, two of the three inside one group.

    Against a ``±1`` background whose cross-column means are all zero, the term's
    Shapley values are on paper. In the **member** game the three features share
    it equally, so the two inside the group carry ``2λX/3``. In the **group**
    game there are two relevant players, so the group carries ``λX/2``. The gap
    is therefore exactly ``λX/6`` — it comes from the interaction term and from
    nowhere else, which the ``λ = 0`` case pins.
    """
    target_row = _target(1.0, 1.0, 1.0)
    coefficient = 6.0
    interaction = RowFunction(
        lambda row: 38.0 * row[0] - 37.0 * row[1] + coefficient * row[0] * row[1] * row[2]
    )
    grouped, members = _grouped_and_member(interaction, target_row)
    summed = members[0] + members[1]
    assert grouped[PAIR_GROUP] != pytest.approx(summed, abs=1e-6)
    product = float(np.prod(target_row[:3]))
    assert summed - grouped[PAIR_GROUP] == pytest.approx(
        coefficient * product / 6.0, abs=1e-12
    )

    additive = RowFunction(lambda row: 38.0 * row[0] - 37.0 * row[1])
    flat_grouped, flat_members = _grouped_and_member(additive, target_row)
    assert flat_members[0] + flat_members[1] - flat_grouped[PAIR_GROUP] == (
        pytest.approx(0.0, abs=1e-12)
    )


# --- Seam 3 — sign honesty ----------------------------------------------------


def test_a_group_of_plus_forty_and_minus_thirty_five_is_not_plus_five() -> None:
    """The spec's own construction, with the arithmetic arranged to hit it.

    ``38·x₁ − 37·x₂ + 6·x₁x₂x₃`` at ``x = (1, 1, 1)`` gives member values of
    ``+40`` and ``−35``. Their sum is ``+5``. The group's own ``φ`` — what
    replacing the *whole group* with a typical one does — is ``+4``, and it is
    the published number. There is no aggregation step here in which a sign
    could be lost, because there is no aggregation step.
    """
    target_row = _target(1.0, 1.0, 1.0)
    game = RowFunction(
        lambda row: 38.0 * row[0] - 37.0 * row[1] + 6.0 * row[0] * row[1] * row[2]
    )
    grouped, members = _grouped_and_member(game, target_row)
    assert members[0] == pytest.approx(40.0, abs=1e-12)
    assert members[1] == pytest.approx(-35.0, abs=1e-12)
    assert members[0] + members[1] == pytest.approx(5.0, abs=1e-12)
    assert grouped[PAIR_GROUP] == pytest.approx(4.0, abs=1e-12)
    assert grouped[THIRD_GROUP] == pytest.approx(3.0, abs=1e-12)


DIAGNOSIS_SOURCES: tuple[Path, ...] = tuple(
    sorted(Path(str(diagnosis_package.__file__)).parent.glob("*.py"))
)

#: Spellings of "a group's value, obtained by summing its members'". None of
#: them may appear anywhere in the diagnosis module. They are not spellings any
#: honest code in this package would reach for, which is what makes the check
#: cheap enough to keep.
FORBIDDEN_FRAGMENTS: tuple[str, ...] = (
    "member_phi",
    "feature_phi",
    "phi_by_feature",
    "phi_per_feature",
    "per_feature_phi",
    "member_shapley",
    "feature_shapley",
    "phi_of_member",
    "sum_member",
    "member_values",
    "feature_contributions",
)

#: A defined name that pairs an attribution with a sub-group grain is the shape
#: of the mistake, whatever it is spelled.
_PHI_TOKENS = ("phi", "shapley", "contribution", "attribut")
_SUB_GROUP_TOKENS = ("member", "feature", "column")


def test_the_diagnosis_module_never_sums_member_level_values_into_a_group_value() -> None:
    """Seam 3's structural half, in the spirit of "nothing sums two bands".

    Two readings of the same file. The first is a vocabulary scan; the second
    walks the syntax tree, so a name that pairs an attribution with a sub-group
    grain fails however it is spelled. The exception is the honest one:
    :func:`group_columns` maps *columns* onto players, which is how the group
    becomes an atomic player in the first place, and it returns positions rather
    than values.
    """
    allowed = {"group_columns", "columns", "_SUB_GROUP_TOKENS"}
    for path in DIAGNOSIS_SOURCES:
        source = path.read_text(encoding="utf-8")
        for fragment in FORBIDDEN_FRAGMENTS:
            assert fragment not in source, f"{path.name} says {fragment!r}"
        for node in ast.walk(ast.parse(source)):
            names: list[str] = []
            if isinstance(node, ast.FunctionDef | ast.ClassDef):
                names.append(node.name)
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                names.append(node.id)
            for name in names:
                if name in allowed:
                    continue
                lowered = name.lower()
                paired = any(token in lowered for token in _PHI_TOKENS) and any(
                    token in lowered for token in _SUB_GROUP_TOKENS
                )
                assert not paired, f"{path.name} defines {name!r}"


def test_the_game_module_could_not_name_a_feature_if_it_wanted_to() -> None:
    """The players are groups, and the module that solves the game knows only players.

    A cooperative game over eight players cannot sum member-level values because
    it has never been told what a member is. Asserted by reading the file: no
    identifier in `shapley.py` mentions a feature or a member.
    """
    source = (Path(str(diagnosis_package.__file__)).parent / "shapley.py").read_text(
        encoding="utf-8"
    )
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.FunctionDef | ast.ClassDef):
            assert "feature" not in node.name.lower()
            assert "member" not in node.name.lower()
        if isinstance(node, ast.arg):
            assert "feature" not in node.arg.lower()
            assert "member" not in node.arg.lower()


def test_the_players_are_always_the_eight_groups() -> None:
    """The game is only ever solved over the group codes, never over columns."""
    attribution_source = (
        Path(str(diagnosis_package.__file__)).parent / "attribution.py"
    ).read_text(encoding="utf-8")
    assert "exact_shapley(values, players=len(DRIVER_GROUP_CODES))" in attribution_source
    for path in DIAGNOSIS_SOURCES:
        if path.name in {"attribution.py", "shapley.py", "__init__.py"}:
            continue
        assert "exact_shapley" not in path.read_text(encoding="utf-8")


def test_the_attribution_does_not_draw_its_own_background() -> None:
    """ "The background is the artifact's, not one drawn at attribution time."

    A module that cannot reach the sampler cannot draw at attribution time, so
    the property is an import graph rather than a convention.
    """
    source = (Path(str(diagnosis_package.__file__)).parent / "attribution.py").read_text(
        encoding="utf-8"
    )
    assert "draw_matched_background" not in source


def test_the_diagnosis_module_holds_no_composition_of_its_own() -> None:
    """``g`` is the forecaster's composition, reached by import and by nothing else.

    The mirror of `test_hurdle_training.py`'s check. Nothing here imports
    :mod:`wattsteer_ml.mixture`: the one route to an expectation is
    :func:`wattsteer_ml.training.expected_mwh_for_block`, which reaches
    :func:`wattsteer_ml.mixture.compose` by the same three lines every served
    forecast does. A second composition here would let the explained quantity
    and the served quantity drift apart while both kept working.
    """
    for path in DIAGNOSIS_SOURCES:
        source = path.read_text(encoding="utf-8")
        assert "from wattsteer_ml.mixture" not in source
        assert "import wattsteer_ml.mixture" not in source
        for reimplementation in (
            "1.0 - p",
            "occurrence_probability *",
            "* positive_mean",
        ):
            assert reimplementation not in source
    adapter = (
        Path(str(diagnosis_package.__file__)).parent / "composed_target.py"
    ).read_text(encoding="utf-8")
    assert "expected_mwh_for_block" in adapter


# --- The players, the shares and the payload ----------------------------------


def test_both_real_feature_sets_give_every_group_a_column() -> None:
    """A player who cannot move is a bar that is structurally zero."""
    from wattsteer_ml.driver_groups import load_model_inputs

    for names in load_model_inputs().values():
        columns = group_columns(names, DRIVER_GROUP_MAP)
        assert len(columns) == len(DRIVER_GROUP_CODES)
        assert all(columns)
        assert sum(len(one) for one in columns) == len(names)


def test_a_group_with_no_column_in_this_contract_is_refused() -> None:
    with pytest.raises(EmptyPlayerError):
        group_columns(("f1", "f2", "f3"), FIXTURE_MAP)


def test_a_feature_no_group_lists_stops_the_attribution() -> None:
    """No catch-all. The fix is a line in the YAML, not a fallback."""
    with pytest.raises(UngroupedFeatureError):
        group_columns((*FIXTURE_NAMES, "f_from_the_future"), FIXTURE_MAP)


def test_the_shares_are_over_all_eight_groups_and_sum_to_one() -> None:
    """Not over the displayed rows, which was circular: the cut is applied to share."""
    game = RowFunction(
        lambda row: 38.0 * row[0] - 37.0 * row[1] + 6.0 * row[0] * row[1] * row[2]
    )
    attribution = attribute_hour(
        key=fixture_key(),
        target_row=_target(1.0, 1.0, 1.0),
        background=background_of(FIXTURE_NAMES, _factorial_background()),
        expectation=game,
        group_map=FIXTURE_MAP,
    )
    assert len(attribution.contributions) == len(DRIVER_GROUP_CODES)
    assert math.fsum(one.share for one in attribution.contributions) == pytest.approx(
        1.0, abs=1e-12
    )
    denominator = attribution.sum_abs_attributed_mwh
    for one in attribution.contributions:
        assert one.share == pytest.approx(abs(one.phi_mwh) / denominator, abs=1e-15)
    ranked = [one.share for one in attribution.contributions]
    assert ranked == sorted(ranked, reverse=True)
    assert attribution.contribution(PAIR_GROUP).direction == "raises"
    assert attribution.contribution(THIRD_GROUP).direction == "raises"


def test_an_hour_with_no_movement_takes_shares_of_nothing() -> None:
    """Eight equal bars under "share of the movement" would be a picture of nothing."""
    attribution = attribute_hour(
        key=fixture_key(),
        target_row=_target(1.0, 1.0, 1.0),
        background=background_of(FIXTURE_NAMES, _factorial_background()),
        expectation=RowFunction(lambda row: 12.0),
        group_map=FIXTURE_MAP,
    )
    assert all(one.phi_mwh == 0.0 for one in attribution.contributions)
    assert all(one.share == 0.0 for one in attribution.contributions)
    assert attribution.expected_mwh == attribution.baseline_expected_mwh == 12.0


def test_the_direction_is_the_sign_and_not_a_separate_decision() -> None:
    from wattsteer_ml.diagnosis.attribution import GroupContribution

    with pytest.raises(AttributionError, match="the sign is not a separate decision"):
        GroupContribution(
            code="net_surplus",
            label_code="driver.net_surplus",
            phi_mwh=-4.0,
            share=0.5,
            direction="raises",
        )


def test_the_payload_says_it_explains_the_expectation_and_not_the_band() -> None:
    """`docs/specs/diagnosis.md`: said on the screen, and not only in the spec."""
    attribution = attribute_hour(
        key=fixture_key(),
        target_row=_target(1.0, 1.0, 1.0),
        background=background_of(FIXTURE_NAMES, _factorial_background()),
        expectation=RowFunction(lambda row: 3.0 * row[0] + row[2]),
        group_map=FIXTURE_MAP,
    )
    payload = attribution.to_payload()
    assert payload["target"] == ATTRIBUTION_TARGET_HOUR == "expected_mwh_hour"
    assert payload["explains"] == EXPLAINS_CODE
    assert "band" not in payload
    assert "p10" not in payload and "p90" not in payload
    assert [driver["code"] for driver in payload["drivers"]] == [
        one.code for one in attribution.contributions
    ]
    assert payload["total_attributed_mwh"] == pytest.approx(
        payload["expected_mwh"] - payload["baseline_expected_mwh"], abs=1e-9
    )
    assert payload["driver_group_hash"] == FIXTURE_MAP.driver_group_hash


def test_the_target_is_attributed_against_its_own_cell_and_no_other() -> None:
    """The caller hands over the whole background; the cell comes from the key."""
    from wattsteer_ml.training.background import MissingBackgroundCellError

    background = background_of(FIXTURE_NAMES, _factorial_background(), key=fixture_key())
    elsewhere = RowKey(target_date=fixture_key().target_date, local_hour=3, subsystem="S")
    with pytest.raises(MissingBackgroundCellError):
        attribute_hour(
            key=elsewhere,
            target_row=_target(1.0, 1.0, 1.0),
            background=background,
            expectation=RowFunction(lambda row: float(row[0])),
            group_map=FIXTURE_MAP,
        )


def test_the_whole_enumeration_is_evaluated_in_one_batched_call() -> None:
    """32,768 constructed rows, one call — offline, batched, once per publication."""
    game = RowFunction(lambda row: float(row[0]) + float(row[2]))
    attribute_hour(
        key=fixture_key(),
        target_row=_target(1.0, 1.0, 1.0),
        background=background_of(FIXTURE_NAMES, _factorial_background()),
        expectation=game,
        group_map=FIXTURE_MAP,
    )
    assert game.calls == 1
    assert game.rows_seen == 256 * 8


def test_a_target_that_is_not_one_row_is_refused() -> None:
    with pytest.raises(AttributionError, match="the target is one row"):
        attribute_hour(
            key=fixture_key(),
            target_row=np.zeros((2, WIDTH), dtype=np.float64),
            background=background_of(FIXTURE_NAMES, _factorial_background()),
            expectation=RowFunction(lambda row: 0.0),
            group_map=FIXTURE_MAP,
        )


# --- One hour, against a real fitted bundle -----------------------------------


def _bundle_group_map(feature_names: Sequence[str]) -> Any:
    """An eight-group map over the columns the fixture contract actually has.

    The feature builder has landed a fraction of the feature table so far — the
    fixture rows mirror what exists rather than inventing what does not — so the
    real map's eight groups do not all have a column in it, and
    :func:`group_columns` refuses a player who cannot move. The wall-clock this
    file records is a measurement of the *enumeration*: 256 coalitions × 128
    background rows through six real boosters and the real composition. Which
    column sits in which group does not change what that costs, so the map here
    is the fixture contract's own columns dealt across the eight real codes.
    """
    names = list(feature_names)
    buckets: list[list[str]] = [[] for _ in DRIVER_GROUP_CODES]
    for index, name in enumerate(names):
        buckets[index % len(DRIVER_GROUP_CODES)].append(name)
    return synthetic_map(tuple(tuple(bucket) for bucket in buckets))


def test_one_hour_of_a_real_bundle_produces_eight_signed_numbers_in_mwh(
    trained: TrainedFold, record_property: Any
) -> None:
    """The tracer bullet: one ``(subsystem, valid_time)``, eight numbers, they add up.

    Everything real except the grouping: the bundle's six boosters, its isotonic
    map, its conformal correction, its ``μ_sub`` table and
    :func:`wattsteer_ml.mixture.compose` — reached through
    :func:`wattsteer_ml.training.expected_mwh_for_block`, so the explained
    quantity is the served one.

    The wall clock for this one instance is recorded rather than asserted. A
    threshold here would be a claim about this machine; the number is what lets
    the publication budget — 96 instances per lane — be argued about.
    """
    bundle = trained.bundle
    names = bundle.contract.feature_names
    group_map = _bundle_group_map(names)

    # The conftest fold's base-fit window is thirty days, which is thirty rows
    # per cell — a background a quarter of the size the spec ships. The recorded
    # wall clock has to be the real one, so the fixture window is widened to the
    # 160 days a 128-row cell needs. Nothing else about the instance changes:
    # the rows are the same generator's, encoded against the same contract.
    background_rows = feature_rows(
        first=trained.blocks.base_fit_end - timedelta(days=159),
        last=trained.blocks.base_fit_end,
    )
    base_fit = FeatureBlock.of(
        background_rows, bundle.contract, threshold_mw=bundle.threshold_mw
    )
    assert min(_cell_sizes(base_fit)) >= BACKGROUND_ROWS_PER_CELL
    background = draw_matched_background(
        base_fit, seed=20_260_829, rows_per_cell=BACKGROUND_ROWS_PER_CELL
    )

    target_rows = feature_rows(
        first=trained.blocks.test_start, last=trained.blocks.test_start
    )
    target_block = FeatureBlock.of(
        target_rows, bundle.contract, threshold_mw=bundle.threshold_mw
    )
    index = next(
        position
        for position, key in enumerate(target_block.keys)
        if key.subsystem == "NE" and key.local_hour == 14
    )

    attribution = attribute_hour(
        key=target_block.keys[index],
        target_row=target_block.matrix[index],
        background=background,
        expectation=bundle_expectation(bundle),
        group_map=group_map,
    )

    assert len(attribution.contributions) == 8
    assert attribution.coalitions == 256
    assert attribution.background_rows == BACKGROUND_ROWS_PER_CELL == 128
    assert attribution.background_seed == 20_260_829
    movement = attribution.expected_mwh - attribution.baseline_expected_mwh
    assert math.fsum(one.phi_mwh for one in attribution.contributions) == pytest.approx(
        movement, abs=LOCAL_ACCURACY_TOLERANCE * max(1.0, abs(attribution.expected_mwh))
    )
    assert attribution.expected_mwh >= 0.0
    assert attribution.baseline_expected_mwh >= 0.0
    assert any(one.phi_mwh != 0.0 for one in attribution.contributions)
    assert attribution.elapsed_seconds > 0.0

    timing = attribution.timing_fields()
    record_property("diagnosis_attribution_seconds", timing["elapsed_seconds"])
    record_property("diagnosis_attribution_row_evaluations", timing["row_evaluations"])
    print(
        f"\nattribution: one instance, {timing['coalitions']} coalitions × "
        f"{timing['background_rows']} background rows = "
        f"{timing['row_evaluations']} row evaluations in "
        f"{timing['elapsed_seconds']:.2f} s"
    )


def _cell_sizes(block: FeatureBlock) -> list[int]:
    counts: dict[tuple[str, int], int] = {}
    for key in block.keys:
        cell = (key.subsystem, key.local_hour)
        counts[cell] = counts.get(cell, 0) + 1
    return list(counts.values())
