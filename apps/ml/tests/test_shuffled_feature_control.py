"""Permute one group's inputs, and watch its contribution collapse.

`docs/specs/diagnosis.md` seam 7 — the shuffled-feature control. It is the
diagnosis layer's twin of the forecaster's shuffled-label control and the
feature spec's gate ablation: a **generic detector**, which is to say a test
that catches a whole class of wrongness without knowing what right looks like.

**The construction.** One group's columns are permuted across the rows of the
fold — jointly, the same permutation for every column the group holds, so the
group's own joint distribution survives and only its association with the row is
destroyed. The background is then **redrawn from the permuted fold** and the day
is re-attributed. Those two are what make the collapse a property rather than a
hope: the permutation stays inside ``(subsystem, calendar_local_hour)``, which
is the cell the background is matched on, so afterwards the target's value for
that group is a draw from the same cell every background row is drawn from. The
two are exchangeable, replacing one with the other is — in expectation — no
change at all, and ``Φ_j`` has to fall toward zero. The other seven groups,
whose columns were never touched, have to keep their ranking.

That the permutation respects the cell is not decoration: a pooled shuffle
across the whole fold hands a 14:00 row a 03:00 row's values, which leaves it
atypical *of its cell*, and an attribution against a matched background is
obliged to report that as a contribution. Measured, it leaves several times the
residual and flips the sign. See :func:`permute_group_within_fold`.

**If permuting a group's inputs leaves its contribution intact, the attribution
is not reading the model.** That is the whole claim, and it needs to know
neither which group nor which model:
:func:`run_shuffled_feature_control` picks the group off the *baseline* ranking
— the one the day itself says is loudest — and never off a name.

Two of the tests here are the detector detecting. One runs the control on two
different synthetic models whose loudest group is different, and asserts it
finds each without being told. The other runs a deliberately broken control —
the fold and the background permuted, the attributed rows left as they were,
which is exactly the shape of an attribution reading inputs the model did not —
and asserts the detector **fails** it. A control that cannot fail is not a
control.

The synthetic runs are the default gate's: no network, no database, no model
artifact. :func:`test_the_control_holds_against_a_real_bundle` is the one that
needs six fitted boosters and 3.1M row evaluations, so it sits behind the
existing ``WATTSTEER_SCALE_TESTS`` gating alongside the publication-scale run —
`bun run ml:test:scale`. Why that run fits its own bundle rather than reaching
for the session's is the comment above it, and it is the one thing in this file
a reader should not skip.
"""

from __future__ import annotations

import math
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Any

import numpy as np
import numpy.typing as npt
import pytest

from attribution_fixtures import (
    FUNCTION_DEFINITION,
    block_of,
    feature_names_of,
    synthetic_map,
)
from conftest import FIXTURE_BACKGROUND_ROWS_PER_CELL
from feature_row_fixtures import THRESHOLD_MW, feature_rows
from wattsteer_ml.constants import Subsystem
from wattsteer_ml.diagnosis.attribution import ComposedExpectation, group_columns
from wattsteer_ml.diagnosis.composed_target import bundle_expectation
from wattsteer_ml.diagnosis.day_attribution import (
    DayAttribution,
    attribute_day,
    day_rows,
)
from wattsteer_ml.driver_groups import (
    DRIVER_GROUP_CODES,
    DriverGroupMap,
    GroupCode,
)
from wattsteer_ml.evaluation import HOURS_PER_DAY, Fold, FoldBlocks, RowKey
from wattsteer_ml.training import (
    FeatureBlock,
    HurdleBundle,
    OutOfFoldPool,
    train_fold,
)
from wattsteer_ml.training.background import (
    BACKGROUND_ROWS_PER_CELL,
    draw_matched_background,
)

#: How far the permuted group's ``|Φ|`` has to fall, as a fraction of what it
#: was. Not a measurement of anything: it is the line between "collapsed toward
#: zero" and "survived", placed where being wrong is conservative — a detector
#: that demands 99% would fail on the residual a finite permutation leaves
#: behind, and one that accepts 20% would pass an attribution that is barely
#: reading its inputs. What the tests record is the *measured* collapse, so a
#: run that only just clears this leaves the number behind to argue with.
COLLAPSE_FLOOR = 0.70

#: How much of the other seven groups' pairwise ordering has to survive, over
#: the 21 pairs. "Materially unchanged" cannot mean "identical": the permuted
#: group is still a player, so a model with any cross-group interaction moves
#: the others a little, and two groups a hair apart can legitimately swap. What
#: it cannot mean is a re-shuffle, which is what this floor refuses.
RANKING_CONCORDANCE_FLOOR = 0.85

#: Below this, in MWh, a group's day contribution is not something a permutation
#: could collapse — there is nothing there to collapse. The control refuses to
#: run rather than reporting a vacuous pass.
COLLAPSIBLE_FLOOR_MWH = 1e-6


@dataclass(frozen=True)
class ShuffledFeatureControl:
    """One permutation, and what it did to the ranking.

    Holds both rankings rather than a verdict, because the number is the point:
    a test that prints "False" tells whoever broke the attribution nothing, and
    every field here is recorded onto the run.
    """

    #: The group whose columns were permuted — chosen off the baseline ranking,
    #: never off a name.
    group: GroupCode
    #: ``|Φ|`` for that group, before and after, in MWh.
    baseline_abs_mwh: float
    permuted_abs_mwh: float
    #: The permuted day's own bootstrap error, for the reader who wants to know
    #: whether what is left is distinguishable from the background sampling.
    permuted_stderr_mwh: float
    #: The other seven groups, ranked by ``|Φ|``, before and after.
    baseline_others: tuple[GroupCode, ...]
    permuted_others: tuple[GroupCode, ...]
    permutation_seed: int

    def __post_init__(self) -> None:
        if self.baseline_abs_mwh < COLLAPSIBLE_FLOOR_MWH:
            raise ValueError(
                f"{self.group!r} carries |Φ| = {self.baseline_abs_mwh} MWh before the "
                "permutation; a group the model was not reading has nothing to "
                "collapse and a control on it would pass vacuously"
            )
        if sorted(self.baseline_others) != sorted(self.permuted_others):
            raise ValueError("the two runs ranked different groups")

    @property
    def collapse(self) -> float:
        """``1 − |Φ_after| / |Φ_before|``. One is a total collapse."""
        return 1.0 - self.permuted_abs_mwh / self.baseline_abs_mwh

    @property
    def others_concordance(self) -> float:
        """The fraction of the other seven's 21 orderings the permutation left alone.

        Kendall's concordance, written out rather than imported: seven groups is
        21 pairs, and a dependency for that would be a dependency for one line.
        """
        after = {code: rank for rank, code in enumerate(self.permuted_others)}
        pairs = 0
        concordant = 0
        for first in range(len(self.baseline_others)):
            for second in range(first + 1, len(self.baseline_others)):
                pairs += 1
                if (
                    after[self.baseline_others[first]]
                    < after[self.baseline_others[second]]
                ):
                    concordant += 1
        return concordant / pairs if pairs else 1.0

    @property
    def holds(self) -> bool:
        """The detector's verdict: the group collapsed and the others did not move."""
        return (
            self.collapse >= COLLAPSE_FLOOR
            and self.others_concordance >= RANKING_CONCORDANCE_FLOOR
        )

    def recorded(self) -> dict[str, Any]:
        """What the run leaves behind, whichever way the verdict went."""
        return {
            "group": self.group,
            "baseline_abs_mwh": self.baseline_abs_mwh,
            "permuted_abs_mwh": self.permuted_abs_mwh,
            "permuted_stderr_mwh": self.permuted_stderr_mwh,
            "collapse": self.collapse,
            "others_concordance": self.others_concordance,
            "permutation_seed": self.permutation_seed,
        }


def permute_group_within_fold(
    *,
    base_fit: FeatureBlock,
    keys: Sequence[RowKey],
    target_rows: npt.NDArray[np.float64],
    columns: Sequence[int],
    seed: int,
) -> tuple[FeatureBlock, npt.NDArray[np.float64]]:
    """One group's columns, permuted across the rows of the fold — within the cell.

    Three properties, and each of them is load-bearing.

    **The base-fit block and the target day are permuted together.** A
    permutation confined to 24 rows is barely a permutation, and one that left
    the background alone would compare a shuffled target against an unshuffled
    typical — which measures the shuffle, not the attribution.

    **The columns move as a block**, under one permutation, so the group's own
    joint distribution is exactly what it was and every row still holds a
    combination the fold actually contained. What is destroyed is the
    association between the group and the rest of the row, which is the only
    thing the attribution can be reading.

    **The permutation stays inside ``(subsystem, calendar_local_hour)``** —
    within the fold, and within the cell the background is matched on. This is
    where the collapse stops being an average and becomes a property: the
    permuted target's values are then draws from the *same cell* every background
    row is drawn from, target and background are exchangeable on that group, and
    ``φ_j → 0`` follows. A pooled shuffle across the whole fold breaks that.
    Handing a 14:00 row a 03:00 row's values leaves it atypical **of its cell**,
    and an attribution against a matched background is obliged to report that as
    a contribution — so what the pooled version measures is partly the mismatch
    it introduced. Measured, on the lane below: pooled leaves 183 to 390 MWh of a
    1689 MWh baseline and flips the sign on two seeds out of three, where
    cell-wise leaves 5 to 180 MWh and keeps it.

    Returns:
        The permuted base-fit block and the permuted target rows, in the order
        and shape they arrived in.
    """
    chosen = list(columns)
    pooled = np.vstack([base_fit.matrix, target_rows])
    cells = [(key.subsystem, key.local_hour) for key in (*base_fit.keys, *tuple(keys))]
    generator = np.random.default_rng(seed)
    for cell in sorted(set(cells)):
        rows = [index for index, one in enumerate(cells) if one == cell]
        order = [rows[position] for position in generator.permutation(len(rows))]
        pooled[np.ix_(rows, chosen)] = pooled[np.ix_(order, chosen)]
    split = base_fit.matrix.shape[0]
    return (
        replace(base_fit, matrix=np.ascontiguousarray(pooled[:split])),
        np.ascontiguousarray(pooled[split:]),
    )


def attribute_one_day(
    *,
    base_fit: FeatureBlock,
    keys: Sequence[RowKey],
    target_rows: npt.NDArray[np.float64],
    expectation: ComposedExpectation,
    group_map: DriverGroupMap,
    background_seed: int,
    rows_per_cell: int,
    stderr_resamples: int,
    stderr_seed: int,
) -> DayAttribution:
    """The whole pipeline from a fold: draw the background, attribute the day.

    The control re-runs *this*, not some cheaper inner part of it, because a
    permutation that did not reach the background would not be the spec's.
    """
    background = draw_matched_background(
        base_fit, seed=background_seed, rows_per_cell=rows_per_cell
    )
    return attribute_day(
        keys=keys,
        target_rows=target_rows,
        background=background,
        expectation=expectation,
        group_map=group_map,
        stderr_resamples=stderr_resamples,
        stderr_seed=stderr_seed,
    )


def _others(day: DayAttribution, group: GroupCode) -> tuple[GroupCode, ...]:
    """The other seven codes in ``|Φ|`` order — the ranking that must survive."""
    return tuple(one.code for one in day.contributions if one.code != group)


def run_shuffled_feature_control(
    *,
    base_fit: FeatureBlock,
    keys: Sequence[RowKey],
    target_rows: npt.NDArray[np.float64],
    expectation: ComposedExpectation,
    group_map: DriverGroupMap,
    background_seed: int = 20_260_829,
    rows_per_cell: int = BACKGROUND_ROWS_PER_CELL,
    permutation_seed: int = 5,
    stderr_resamples: int = 32,
    stderr_seed: int = 4,
) -> ShuffledFeatureControl:
    """Attribute the day, permute the loudest group, attribute it again.

    **Which group is not an argument.** It is read off the baseline ranking, so
    the control knows neither which group it is about to permute nor what model
    it is holding — which is what makes it a detector rather than an assertion
    about this fixture.
    """
    baseline = attribute_one_day(
        base_fit=base_fit,
        keys=keys,
        target_rows=target_rows,
        expectation=expectation,
        group_map=group_map,
        background_seed=background_seed,
        rows_per_cell=rows_per_cell,
        stderr_resamples=stderr_resamples,
        stderr_seed=stderr_seed,
    )
    group = baseline.contributions[0].code
    columns = group_columns(base_fit.contract.feature_names, group_map)[
        DRIVER_GROUP_CODES.index(group)
    ]
    permuted_fit, permuted_rows = permute_group_within_fold(
        base_fit=base_fit,
        keys=keys,
        target_rows=target_rows,
        columns=columns,
        seed=permutation_seed,
    )
    permuted = attribute_one_day(
        base_fit=permuted_fit,
        keys=keys,
        target_rows=permuted_rows,
        expectation=expectation,
        group_map=group_map,
        background_seed=background_seed,
        rows_per_cell=rows_per_cell,
        stderr_resamples=stderr_resamples,
        stderr_seed=stderr_seed,
    )
    return ShuffledFeatureControl(
        group=group,
        baseline_abs_mwh=abs(baseline.contribution(group).phi_mwh),
        permuted_abs_mwh=abs(permuted.contribution(group).phi_mwh),
        permuted_stderr_mwh=permuted.attribution_stderr_mwh,
        baseline_others=_others(baseline, group),
        permuted_others=_others(permuted, group),
        permutation_seed=permutation_seed,
    )


# --- A synthetic fold, and a model that reads one group loudest ---------------
#
# Nine columns over the eight real group codes, the first group holding two
# members so that a permutation has to move a group's columns *together* for the
# fixture to say anything. The same shape `test_grouped_shapley.py` uses.

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
FIXTURE_SUBSYSTEM: Subsystem = "NE"
FIXTURE_DATE = date(2026, 3, 4)

#: Days of synthetic base fit. Each is 24 rows in one cell, so this is also the
#: number of rows every background cell is drawn from.
BASE_FIT_DAYS = 40
#: Small enough that the whole file is an inner-loop test, large enough that the
#: mean over the cell is a mean rather than a coincidence. The real background
#: is 128 (`BACKGROUND_ROWS_PER_CELL`) and the gated run below uses it.
FIXTURE_ROWS_PER_CELL = 16


class WeightedGame:
    """``g`` as a weighted sum with one cross-group interaction, vectorised.

    A synthetic game rather than a composition: seam 7 is about whether the
    attribution reads *its inputs*, and the fixtures that pin the composition
    live in `test_grouped_shapley.py`. Vectorised because the control runs the
    24-hour enumeration four times over.

    The interaction is deliberate. Without it the model would be additive across
    every group boundary, permuting one group could not move another's ``φ`` at
    all, and "the other groups' ranking is materially unchanged" would be true
    by construction instead of measured.
    """

    def __init__(
        self, weights: Sequence[float], *, interaction: tuple[int, int], strength: float
    ) -> None:
        self._weights = np.asarray(weights, dtype=np.float64)
        self._interaction = interaction
        self._strength = strength

    def __call__(
        self, key: RowKey, matrix: npt.NDArray[np.float64]
    ) -> npt.NDArray[np.float64]:
        first, second = self._interaction
        interaction = self._strength * matrix[:, first] * matrix[:, second]
        return np.asarray(matrix @ self._weights + interaction, dtype=np.float64)


def _fold_keys(days: int, *, first: date) -> tuple[RowKey, ...]:
    return tuple(
        RowKey(
            target_date=first + timedelta(days=offset),
            local_hour=hour,
            subsystem=FIXTURE_SUBSYSTEM,
        )
        for offset in range(days)
        for hour in range(HOURS_PER_DAY)
    )


def _synthetic_fold(*, seed: int) -> FeatureBlock:
    """``BASE_FIT_DAYS`` whole days at one subsystem, drawn from one distribution."""
    keys = _fold_keys(BASE_FIT_DAYS, first=date(2025, 1, 1))
    generator = np.random.default_rng(seed)
    matrix = generator.normal(size=(len(keys), WIDTH))
    return block_of(FIXTURE_NAMES, keys, matrix)


def _synthetic_day(*, seed: int, loud: Sequence[int]) -> npt.NDArray[np.float64]:
    """A target day whose ``loud`` columns sit well away from typical.

    A day on which the model reads that group loudly, which is the only kind of
    day a collapse can be measured on: a group whose values were typical anyway
    has a ``Φ`` near zero already, and shuffling it would prove nothing.
    """
    generator = np.random.default_rng(seed)
    rows = generator.normal(size=(HOURS_PER_DAY, WIDTH))
    rows[:, list(loud)] += 3.0
    return rows


def _synthetic_keys() -> tuple[RowKey, ...]:
    return tuple(
        RowKey(target_date=FIXTURE_DATE, local_hour=hour, subsystem=FIXTURE_SUBSYSTEM)
        for hour in range(HOURS_PER_DAY)
    )


def _control_on(
    *,
    weights: Sequence[float],
    loud: Sequence[int],
    permutation_seed: int = 5,
) -> ShuffledFeatureControl:
    return run_shuffled_feature_control(
        base_fit=_synthetic_fold(seed=11),
        keys=_synthetic_keys(),
        target_rows=_synthetic_day(seed=12, loud=loud),
        expectation=WeightedGame(weights, interaction=(0, 2), strength=1.5),
        group_map=FIXTURE_MAP,
        background_seed=99,
        rows_per_cell=FIXTURE_ROWS_PER_CELL,
        permutation_seed=permutation_seed,
    )


#: ``f1`` and ``f2`` are the first group's two members; the weights fall away
#: after them, so on a day that is loud in both, the first group is the loudest
#: driver.
FIRST_GROUP_WEIGHTS = (6.0, 5.0, 1.0, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2)
#: The same fold and the same day, read by a model that cares about ``f5``
#: instead — the sole member of the fourth group.
FOURTH_GROUP_WEIGHTS = (0.5, 0.4, 0.5, 0.4, 8.0, 0.5, 0.4, 0.3, 0.2)
#: The columns the fixture day sits well away from typical on: both of the first
#: group's members and the fourth group's one. A day loud on all three lets the
#: two models above disagree about which group led it without changing the day.
LOUD_COLUMNS = (0, 1, 4)


# --- Seam 7 — the shuffled-feature control ------------------------------------


def test_permuting_a_groups_columns_collapses_its_day_contribution(
    record_property: Any,
) -> None:
    """Seam 7 itself, on a synthetic model with no artifact anywhere near it."""
    control = _control_on(weights=FIRST_GROUP_WEIGHTS, loud=LOUD_COLUMNS)
    for name, value in control.recorded().items():
        record_property(f"shuffled_control_{name}", value)

    assert control.group == DRIVER_GROUP_CODES[0]
    assert control.collapse >= COLLAPSE_FLOOR
    assert control.permuted_abs_mwh < control.baseline_abs_mwh


def test_the_other_groups_ranking_survives_the_permutation() -> None:
    """The second half of the control, and the half that makes it a control.

    A collapse on its own is also what a broken attribution that has stopped
    reading anything would produce. What says the permutation did one thing
    rather than everything is that the seven groups nobody touched came back in
    the order they left in.
    """
    control = _control_on(weights=FIRST_GROUP_WEIGHTS, loud=LOUD_COLUMNS)
    assert control.others_concordance >= RANKING_CONCORDANCE_FLOOR
    assert control.holds


def test_the_control_does_not_need_to_know_which_group(record_property: Any) -> None:
    """The same fold and the same day, read by a model that reads a different group.

    Nothing about the control changes between these two runs except the model it
    is handed, and it finds the loudest group in each — because it reads the
    group off the baseline ranking rather than off a name. This is the sense in
    which seam 7 "does not need to know which group or which model".
    """
    first = _control_on(weights=FIRST_GROUP_WEIGHTS, loud=LOUD_COLUMNS)
    fourth = _control_on(weights=FOURTH_GROUP_WEIGHTS, loud=LOUD_COLUMNS)
    record_property("shuffled_control_first_group", first.group)
    record_property("shuffled_control_fourth_group", fourth.group)

    assert first.group == DRIVER_GROUP_CODES[0]
    assert fourth.group == DRIVER_GROUP_CODES[3]
    assert first.holds
    assert fourth.holds


@pytest.mark.parametrize("permutation_seed", [1, 2, 3, 4, 5])
def test_the_collapse_is_the_permutations_and_not_one_seeds(
    permutation_seed: int,
) -> None:
    """A control that only holds under one shuffle is a coincidence, not a detector."""
    control = _control_on(
        weights=FIRST_GROUP_WEIGHTS, loud=LOUD_COLUMNS, permutation_seed=permutation_seed
    )
    assert control.holds


def test_an_attribution_that_ignores_the_permutation_fails_the_control() -> None:
    """The detector detecting. A control that cannot fail is not a control.

    The fold is permuted and the background is redrawn from it, and then the
    *original* rows are attributed against it — the shape of an attribution
    reading inputs that are not the ones the model was given. Its ``Φ`` for the
    permuted group survives, the collapse does not happen, and the control says
    so. This is the failure seam 7 exists to catch, staged.
    """
    base_fit = _synthetic_fold(seed=11)
    keys = _synthetic_keys()
    target_rows = _synthetic_day(seed=12, loud=LOUD_COLUMNS)
    expectation = WeightedGame(FIRST_GROUP_WEIGHTS, interaction=(0, 2), strength=1.5)
    shared: dict[str, Any] = {
        "keys": keys,
        "expectation": expectation,
        "group_map": FIXTURE_MAP,
        "background_seed": 99,
        "rows_per_cell": FIXTURE_ROWS_PER_CELL,
        "stderr_resamples": 32,
        "stderr_seed": 4,
    }
    baseline = attribute_one_day(base_fit=base_fit, target_rows=target_rows, **shared)
    group = baseline.contributions[0].code
    columns = group_columns(base_fit.contract.feature_names, FIXTURE_MAP)[
        DRIVER_GROUP_CODES.index(group)
    ]
    permuted_fit, _ = permute_group_within_fold(
        base_fit=base_fit, keys=keys, target_rows=target_rows, columns=columns, seed=5
    )
    # The permutation reached the fold and the background; the attributed rows
    # are the ones it did not reach.
    stale = attribute_one_day(base_fit=permuted_fit, target_rows=target_rows, **shared)

    control = ShuffledFeatureControl(
        group=group,
        baseline_abs_mwh=abs(baseline.contribution(group).phi_mwh),
        permuted_abs_mwh=abs(stale.contribution(group).phi_mwh),
        permuted_stderr_mwh=stale.attribution_stderr_mwh,
        baseline_others=_others(baseline, group),
        permuted_others=_others(stale, group),
        permutation_seed=5,
    )
    assert control.collapse < COLLAPSE_FLOOR
    assert not control.holds


def test_a_group_the_model_never_read_has_nothing_to_collapse() -> None:
    """A vacuous pass is refused rather than reported.

    ``1 − 0/0`` is not a collapse, and a control that reported one on a group the
    model was not reading would be the most reassuring test in the suite and the
    emptiest.
    """
    with pytest.raises(ValueError, match="nothing to collapse"):
        ShuffledFeatureControl(
            group=DRIVER_GROUP_CODES[0],
            baseline_abs_mwh=0.0,
            permuted_abs_mwh=0.0,
            permuted_stderr_mwh=0.0,
            baseline_others=DRIVER_GROUP_CODES[1:],
            permuted_others=DRIVER_GROUP_CODES[1:],
            permutation_seed=5,
        )


def test_the_permutation_moves_the_group_and_nothing_else() -> None:
    """The columns nobody named come back bit-identical, and the group's do not.

    Two properties in one reading. The untouched columns are the reason the
    other seven groups' ranking is allowed to be evidence of anything; the
    permuted ones moving *together* is what keeps the group a group — a
    per-column shuffle would break the joint distribution and the collapse would
    then be measuring an impossible row rather than a broken association.
    """
    base_fit = _synthetic_fold(seed=11)
    target_rows = _synthetic_day(seed=12, loud=LOUD_COLUMNS)
    columns = group_columns(base_fit.contract.feature_names, FIXTURE_MAP)[0]
    assert columns == (0, 1)

    permuted_fit, permuted_rows = permute_group_within_fold(
        base_fit=base_fit,
        keys=_synthetic_keys(),
        target_rows=target_rows,
        columns=columns,
        seed=5,
    )
    untouched = [index for index in range(WIDTH) if index not in columns]
    assert np.array_equal(
        permuted_fit.matrix[:, untouched], base_fit.matrix[:, untouched]
    )
    assert np.array_equal(permuted_rows[:, untouched], target_rows[:, untouched])
    assert not np.array_equal(
        permuted_rows[:, list(columns)], target_rows[:, list(columns)]
    )

    # The pool is the same multiset of (f1, f2) pairs, moved around: every
    # permuted pair is a pair some row of the fold actually held.
    before = np.vstack([base_fit.matrix, target_rows])[:, list(columns)]
    after = np.vstack([permuted_fit.matrix, permuted_rows])[:, list(columns)]
    assert np.array_equal(before[np.lexsort(before.T)], after[np.lexsort(after.T)])


def test_the_control_leaves_the_attribution_alone() -> None:
    """Permuting is something the *test* does to a fold, never to an attribution.

    Seam 7 permutes inputs and re-runs the whole pipeline. It does not reach
    into a ``DayAttribution`` and adjust a number, and it could not: the value is
    frozen and its constructor re-checks local accuracy. Asserted so that a
    later "faster" control — one that scaled a ``Φ`` down instead of re-running
    the day — has something to fail.
    """
    day = attribute_one_day(
        base_fit=_synthetic_fold(seed=11),
        keys=_synthetic_keys(),
        target_rows=_synthetic_day(seed=12, loud=LOUD_COLUMNS),
        expectation=WeightedGame(FIRST_GROUP_WEIGHTS, interaction=(0, 2), strength=1.5),
        group_map=FIXTURE_MAP,
        background_seed=99,
        rows_per_cell=FIXTURE_ROWS_PER_CELL,
        stderr_resamples=32,
        stderr_seed=4,
    )
    with pytest.raises(Exception, match="cannot assign to field"):
        day.contributions[0].phi_mwh = 0.0  # type: ignore[misc]
    assert math.isclose(
        day.total_attributed_mwh,
        day.day_expected_mwh - day.baseline_expected_mwh,
        abs_tol=1e-6,
    )


# --- The same control, against a real fitted bundle ---------------------------
#
# **Why this run fits its own bundle.** The obvious thing to do here is to reach
# for the session's ``trained`` bundle, and the first draft did. It cannot work,
# and the reason is worth writing down rather than rediscovering: in
# `feature_row_fixtures.py` the label is a function of the **subsystem and the
# hour**, and of nothing else that varies. The background is matched on exactly
# those two, so it has already conditioned away every signal that corpus
# contains, and what is left for an attribution to read inside a cell is the
# boosters' noise. Permuting the loudest group of *that* attribution moved
# ``|Φ|`` from 17.0 MWh to 23.0, 1.8, 5.3 and 9.7 MWh on four permutation seeds
# — up, on one of them — which is what a permutation does to a quantity that was
# never signal. A collapse asserted on the lucky seed would have been a green
# tick over nothing.
#
# So the fixture rows are relabelled here so that the label depends on something
# that **varies inside the cell** — the temperature anomaly, ``temperature``
# against the ``22 + 8·cos(zenith)`` the generator draws it around — and the six
# boosters are fitted on that. Everything the control then exercises is real:
# real LightGBM boosters, the real isotonic map, the real conformal correction,
# the real ``μ_sub`` table and `wattsteer_ml.mixture.compose`, reached through
# `expected_mwh_for_block` so that the quantity whose collapse is measured is the
# served one. What is fixture is what was always fixture: the rows.


#: The one feature the relabelled lane's model can read, and so the one whose
#: group the control ends up permuting. It varies inside
#: ``(subsystem, calendar_local_hour)``, which is what makes it visible to an
#: attribution taken against a background matched on those two.
TEMPERATURE = "weather_temperature_2m"

#: How far above its cell's typical the fixture target day sits, in °C — under
#: three of the generator's own standard deviations. A day the model reads as
#: *unusual*, because a day it reads as typical has no contribution for a
#: permutation to collapse and the control would be measuring nothing. The same
#: thing ``LOUD_COLUMNS`` does for the synthetic runs, in the units the fixture
#: generator uses.
HOT_DAY_ANOMALY_C = 4.0


def _typical_temperature(row: Mapping[str, Any]) -> float:
    """The mean `feature_row_fixtures` draws this row's temperature around."""
    return 22.0 + 8.0 * float(row["solar_zenith_cos"])


def temperature_driven(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The same rows, relabelled so the label depends on the temperature anomaly.

    ``y_constrained_off_total_mwh = max(0, τ + 25 · anomaly)``, with the wind and
    solar split and the two derived label columns kept consistent with it, so the
    occurrence classifier and the magnitude boosters are fitted on a lane where
    something inside the background's own cell moves the answer. Unlabelled hours
    stay unlabelled and a NULL temperature reads as no anomaly — the boosters
    have to handle both, and this file is not the place to hide that.
    """
    relabelled: list[dict[str, Any]] = []
    for row in rows:
        one = dict(row)
        if one["y_constrained_off_total_mwh"] is None:
            relabelled.append(one)
            continue
        temperature = one[TEMPERATURE]
        anomaly = (
            0.0 if temperature is None else float(temperature) - _typical_temperature(one)
        )
        total = max(0.0, THRESHOLD_MW + 25.0 * anomaly)
        wind_fraction = 0.85 if int(one["calendar_local_hour"]) < 6 else 0.2
        one["y_constrained_off_total_mwh"] = total
        one["y_constrained_off_wind_mwh"] = total * wind_fraction
        one["y_constrained_off_solar_mwh"] = total * (1.0 - wind_fraction)
        one["y_has_curtailment"] = total > THRESHOLD_MW
        one["y_magnitude_mwh"] = total if total > THRESHOLD_MW else None
        relabelled.append(one)
    return relabelled


def hot_day(rows: Sequence[Mapping[str, Any]], *, degrees: float) -> list[dict[str, Any]]:
    """The same rows with every hour's temperature set that far above typical."""
    return [{**row, TEMPERATURE: _typical_temperature(row) + degrees} for row in rows]


def _temperature_group_map(feature_names: Sequence[str]) -> DriverGroupMap:
    """Eight players, the first of which is the temperature and nothing else.

    The rest of the contract is dealt round-robin across the other seven — the
    same stopgap `test_grouped_shapley.py` and `test_day_attribution.py` use,
    because the feature builder has landed a fraction of the feature table and
    the real map's eight groups do not all have a column here, and
    :func:`group_columns` refuses a player who cannot move. What this map adds is
    that the one feature the lane's model can read is a **player on its own**,
    which is what gives the permutation a group to be about.
    """
    buckets: list[list[str]] = [[TEMPERATURE]]
    buckets += [[] for _ in DRIVER_GROUP_CODES[1:]]
    others = [name for name in feature_names if name != TEMPERATURE]
    for index, name in enumerate(others):
        buckets[1 + index % (len(DRIVER_GROUP_CODES) - 1)].append(name)
    return synthetic_map(tuple(tuple(bucket) for bucket in buckets))


@dataclass(frozen=True)
class TemperatureLane:
    """One fitted bundle and one day of it, ready to be attributed."""

    bundle: HurdleBundle
    group_map: DriverGroupMap
    base_fit: FeatureBlock
    keys: tuple[RowKey, ...]
    target_rows: npt.NDArray[np.float64]


@pytest.fixture(scope="module")
def temperature_lane(
    fold: Fold, blocks: FoldBlocks, pool: OutOfFoldPool
) -> TemperatureLane:
    """Six boosters fitted on the relabelled lane, and one unusually hot day.

    Module-scoped: the fit is the expensive half and the control is run against
    it more than once.
    """
    trained = train_fold(
        temperature_driven(
            feature_rows(first=blocks.base_fit_start, last=blocks.test_end)
        ),
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
        pool=pool,
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
        artifact_id="2026-08-29T04:00:00Z",
        created_at=None,
    )
    bundle = trained.bundle
    # The conftest fold's base-fit window is thirty days, which is thirty rows
    # per cell — a quarter of the sample the spec ships. The window is widened to
    # the 160 days a 128-row cell needs, exactly as the publication-scale run
    # does. The background carries no label, so it is not relabelled.
    base_fit = FeatureBlock.of(
        feature_rows(
            first=blocks.base_fit_end - timedelta(days=159), last=blocks.base_fit_end
        ),
        bundle.contract,
        threshold_mw=bundle.threshold_mw,
    )
    target_date = blocks.test_start
    target_block = FeatureBlock.of(
        hot_day(
            feature_rows(first=target_date, last=target_date),
            degrees=HOT_DAY_ANOMALY_C,
        ),
        bundle.contract,
        threshold_mw=bundle.threshold_mw,
    )
    keys, target_rows = day_rows(
        target_block.keys,
        target_block.matrix,
        subsystem="NE",
        target_date=target_date,
    )
    return TemperatureLane(
        bundle=bundle,
        group_map=_temperature_group_map(bundle.contract.feature_names),
        base_fit=base_fit,
        keys=keys,
        target_rows=target_rows,
    )


@pytest.mark.skipif(
    not os.environ.get("WATTSTEER_SCALE_TESTS"),
    reason=(
        "Seam 7 against a real fitted bundle: six boosters, then four whole-day "
        "attributions at the spec's 128-row background — 3.1M row evaluations "
        "through the real composition. The spec runs it under the existing "
        "env-var gating for the same reason the publication-scale run is gated: "
        "the default gate is fixture- and synthetic-data-driven with no fitted "
        "model in it, and the synthetic control above already exercises every "
        "line of the detector. Run it with WATTSTEER_SCALE_TESTS=1, or "
        "`bun run ml:test:scale`."
    ),
)
@pytest.mark.parametrize("permutation_seed", [2, 5])
def test_the_control_holds_against_a_real_bundle(
    temperature_lane: TemperatureLane, permutation_seed: int, record_property: Any
) -> None:
    """Seam 7, end to end, through six fitted boosters and the real composition.

    The background is the 128-row cell the spec ships, drawn from the base-fit
    block and redrawn from the permuted one. Two permutation seeds, because a
    control that holds under one shuffle nobody checked a second of is a
    coincidence with a green tick on it.

    Everything the run measured is recorded, whichever way it went: a detector
    whose margin nobody can see is one nobody will trust the next time it fires.
    """
    control = run_shuffled_feature_control(
        base_fit=temperature_lane.base_fit,
        keys=temperature_lane.keys,
        target_rows=temperature_lane.target_rows,
        expectation=bundle_expectation(temperature_lane.bundle),
        group_map=temperature_lane.group_map,
        rows_per_cell=BACKGROUND_ROWS_PER_CELL,
        permutation_seed=permutation_seed,
    )
    for name, value in control.recorded().items():
        record_property(f"shuffled_control_{name}", value)

    # The group the day itself said was loudest, not one this test named — and on
    # this lane it is the one feature the model had anything to read.
    assert control.group == DRIVER_GROUP_CODES[0]
    assert control.collapse >= COLLAPSE_FLOOR
    assert control.others_concordance >= RANKING_CONCORDANCE_FLOOR
    assert control.holds
