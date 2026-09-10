"""Is each group's declared headline feature the one doing the work?

`docs/specs/diagnosis.md`, "Two additions to the forecaster's artifact", asks
the card for a block "recording, per group, whether the declared headline
feature was the largest mean-``|φ|`` member on the newest fold", and the section
above it settles what happens when the answer is no: "a mismatch is a **card
warning, never an automatic relabel** — a driver whose subtitle changes weekly
is worse than one that is second-best". Forecaster 31 builds it. The spec is
the authority for why the check exists and nothing here restates it.

**Why the group has a declared headline at all.** A group has no single value,
so the Explain screen shows one member's ``observed`` and ``typical`` beside the
bar. The declaration is a product decision in the YAML and this module never
edits it: :class:`HeadlineFeatureCheck` has no method that returns a map and the
card's block is strings and numbers. A relabel is a line somebody types.

**The member game, and why it is exactly solvable.** For member ``m``:

    ``φ_m = v({m}) − v(∅)``

with both terms averaged over the target's own matched background cell and every
other column held at the target — ``v(S)``'s columns come from the target and
``S̄``'s from the background, the same orientation
:func:`~wattsteer_ml.diagnosis.attribution.attribute_hour` uses. That is the
Shapley value of the cooperative game whose single player is ``m``: with
``n = 1`` the only coalition weight is ``1``, so the difference *is* ``φ`` and
not an approximation of it. Solving the game whose players are a group's twenty
or thirty members is not on the table — that is what grouping exists to avoid,
and :data:`~wattsteer_ml.diagnosis.shapley.MAX_ENUMERATED_PLAYERS` refuses it.

**What this is not.** It is not a member's value in the group's eight-player
game, and the two are different numbers whenever the model is not additive
across the member boundary — which is the whole content of the spec's seam 2.
Nothing here sums these values, nothing compares their sum to a ``Φ``, and no
value computed here reaches an attribution, a share or a rank: the only
consumer is :meth:`HeadlineFeatureCheck.card_fields`.

**Why the module is in ``training/`` and not in ``diagnosis/``.** Two reasons
that point the same way. The card is the artifact's and the artifact is
``training/``'s, as forecaster 30 established when ``MatchedBackground`` moved
here. And seam 3's structural guard — ``test_grouped_shapley.py``'s fragment
scan and AST walk over ``diagnosis/*.py`` — forbids the vocabulary this module
needs anywhere in that package. Living outside it is the honest answer;
satisfying the scan by choosing coy names inside it would have been the
dishonest one. Two guards keep that from being a loophole:
``test_headline_feature_check.py`` asserts that no module in ``diagnosis``
imports this one, and that the numbers reach the card and nothing else.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import numpy.typing as npt

from wattsteer_ml.driver_groups import (
    DRIVER_GROUP_CODES,
    DriverGroup,
    DriverGroupMap,
    GroupCode,
)
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.training.background import CellKey, MatchedBackground
from wattsteer_ml.training.design import FeatureBlock

#: How many of the newest fold's rows the check is taken over. The mean in
#: "largest mean-``|φ|`` member" is over these.
#:
#: A constant of the run, drawn with :data:`HEADLINE_CHECK_SEED`, both stamped on
#: the card beside the verdicts — the same discipline
#: :data:`~wattsteer_ml.training.background.BACKGROUND_SEED` follows, and for the
#: same reason: a verdict nobody can reproduce is a sentence, not a measurement.
#: The cost is ``(k + 1) × |B(s, h)|`` model evaluations per target, one batched
#: call each, so 24 targets at the spec's 128-row cells and ``k = 99`` is about
#: 307,000 row evaluations — seconds, once per retrain.
HEADLINE_CHECK_TARGETS = 24

#: The seed the targets are drawn with. Stamped, not derived.
HEADLINE_CHECK_SEED = 20_260_910

#: What the check can conclude about one group. Closed, and every member is
#: reachable — ``test_headline_feature_check.py`` asserts that rather than
#: trusting this comment.
#:
#: - ``confirmed`` — the declared headline had the largest mean ``|φ|``.
#: - ``mismatch`` — another member did. A card warning and nothing else.
#: - ``no_movement`` — every member's mean ``|φ|`` is exactly zero, so
#:   "largest" has no referent. Reported rather than resolved: naming a winner
#:   among ties would be an invented ranking.
#: - ``headline_not_in_contract`` — the declared headline is not a column of
#:   this artifact's feature contract, so it has no ``φ`` to be largest.
#: - ``no_member_in_contract`` — no member of the group is a column of this
#:   contract, which is what a fixture contract produces for most groups.
#:
#: The last three are verdicts and not skipped groups on purpose: a card that
#: omitted a group it could not evaluate would leave a reader to assume the
#: seven it reported were the eight.
HeadlineVerdict = Literal[
    "confirmed",
    "mismatch",
    "no_movement",
    "headline_not_in_contract",
    "no_member_in_contract",
]

HEADLINE_VERDICTS: tuple[HeadlineVerdict, ...] = (
    "confirmed",
    "mismatch",
    "no_movement",
    "headline_not_in_contract",
    "no_member_in_contract",
)

#: ``g`` over a block already encoded against the bundle's contract — in
#: practice :func:`~wattsteer_ml.training.hurdle.expected_mwh_for_block` with
#: its bundle already applied. Taken as an argument rather than reached for, so
#: that this module holds no composition and the tests can hand it a synthetic
#: model with a known largest mover.
BlockExpectation = Callable[[FeatureBlock], Sequence[float]]


class HeadlineCheckError(ValueError):
    """The check was asked for on inputs that cannot produce one.

    Raised rather than answered. A check over no targets, or over a map with no
    groups, would come back all-``confirmed`` — the shape of a passing result
    with nothing behind it, which is the failure this repo has shipped before.
    """


@dataclass(frozen=True)
class GroupHeadlineCheck:
    """One group's verdict, and the two numbers it was taken from.

    A number is ``None`` when there was nothing to measure it over — the two
    ``*_not_in_contract`` verdicts — and a real ``0.0`` under ``no_movement``,
    where the model was evaluated and did not move. The two are different facts
    and the verdict beside them says which, so a reader never has to decide
    whether a zero is a measurement.

    ``largest_member`` is ``None`` for every verdict but ``confirmed`` and
    ``mismatch``, including ``no_movement``: naming a winner among equal zeros
    would be an invented ranking.
    """

    code: GroupCode
    #: The member the YAML declares. Echoed so the card is readable without the
    #: YAML beside it.
    headline_feature: str
    verdict: HeadlineVerdict
    #: The member that actually had the largest mean ``|φ|``. Equal to
    #: :attr:`headline_feature` when the verdict is ``confirmed``.
    largest_member: str | None
    headline_mean_abs_phi_mwh: float | None
    largest_mean_abs_phi_mwh: float | None
    #: How many of the group's members are columns of this contract.
    members_in_contract: int

    def __post_init__(self) -> None:
        if self.verdict == "confirmed" and self.largest_member != self.headline_feature:
            raise HeadlineCheckError(
                f"{self.code}: confirmed but the largest member is "
                f"{self.largest_member!r} and the headline is "
                f"{self.headline_feature!r}"
            )
        if self.verdict == "mismatch" and self.largest_member == self.headline_feature:
            raise HeadlineCheckError(
                f"{self.code}: a mismatch whose largest member is the headline"
            )

    def to_card(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "headline_feature": self.headline_feature,
            "verdict": self.verdict,
            "largest_member": self.largest_member,
            "headline_mean_abs_phi_mwh": self.headline_mean_abs_phi_mwh,
            "largest_mean_abs_phi_mwh": self.largest_mean_abs_phi_mwh,
            "members_in_contract": str(self.members_in_contract),
        }


@dataclass(frozen=True)
class HeadlineFeatureCheck:
    """The card's third driver field, and the two identity fields beside it.

    It carries the :class:`~wattsteer_ml.driver_groups.DriverGroupMap` it ranked
    under, and :meth:`card_fields` takes ``driver_group_version`` and
    ``driver_group_hash`` from it. So the partition the card claims and the
    partition the verdicts were taken over are one value: a card cannot report a
    ``confirmed`` under one map and a hash from another.
    """

    group_map: DriverGroupMap
    groups: tuple[GroupHeadlineCheck, ...]
    #: How many fold rows the mean was taken over, and how many member columns
    #: were evaluated. On the card, because a verdict over nothing is the defect
    #: this block would otherwise hide.
    targets: int
    members_evaluated: int
    seed: int
    fold_id: str

    def __post_init__(self) -> None:
        codes = tuple(group.code for group in self.groups)
        if sorted(codes) != sorted(DRIVER_GROUP_CODES):
            raise HeadlineCheckError(
                f"the check must cover all eight groups exactly once, got {codes!r}"
            )
        if self.targets <= 0 or self.members_evaluated <= 0:
            raise HeadlineCheckError(
                f"the check evaluated {self.targets} targets and "
                f"{self.members_evaluated} member columns; an empty evaluation is "
                "not a confirmation"
            )

    @property
    def mismatched(self) -> tuple[GroupCode, ...]:
        """The groups whose declared headline was not the largest mover."""
        return tuple(one.code for one in self.groups if one.verdict == "mismatch")

    def card_fields(self) -> dict[str, Any]:
        """The three fields the diagnosis spec asks the forecaster's card for.

        The two identity fields come from
        :meth:`~wattsteer_ml.driver_groups.DriverGroupMap.card_fields` and are
        not spelled again here: the hash is derived from the map's content and
        this repo has been bitten by a value restated beside the thing it
        describes.
        """
        return {
            **self.group_map.card_fields(),
            "headline_feature_check": {
                "fold_id": self.fold_id,
                "targets": str(self.targets),
                "seed": str(self.seed),
                "members_evaluated": str(self.members_evaluated),
                # Collected as well as attached, so the one number an operator
                # wants — did anything drift this week — is not a scan of eight
                # rows. Empty is the ordinary case and an empty list is not an
                # absence here: every group has a verdict beside it.
                "mismatches": [str(code) for code in self.mismatched],
                "groups": [group.to_card() for group in self.groups],
            },
        }


def check_headline_features(
    *,
    block: FeatureBlock,
    background: MatchedBackground,
    expectation: BlockExpectation,
    group_map: DriverGroupMap,
    fold_id: str,
    targets: int = HEADLINE_CHECK_TARGETS,
    seed: int = HEADLINE_CHECK_SEED,
) -> HeadlineFeatureCheck:
    """Rank each group's members by mean ``|φ|`` and check the declaration.

    Args:
        block: the newest fold's rows, encoded against the bundle's contract.
            The targets are drawn from these — the fold the card is about, not
            the window the boosters were fitted on.
        background: ``B(s, h)`` from the artifact. Each target is measured
            against its own cell, so the ``|φ|`` a member is ranked by is the
            same kind of quantity the bar beside it is.
        expectation: ``g``. See :data:`BlockExpectation`.
        group_map: the eight players and their declared headlines.
        fold_id: stamped on the block, so a verdict is traceable to the fold it
            was taken on.
        targets: how many rows to average over.
        seed: the draw. Stamped on the card.

    Raises:
        HeadlineCheckError: no group, no target row, or no member of any group
            in this contract — each of which would produce a block of
            ``confirmed`` verdicts with nothing behind them.
    """
    if not group_map.groups:
        raise HeadlineCheckError("a map with no group has no headline to check")
    if targets <= 0:
        raise HeadlineCheckError(f"{targets} targets is not a mean over anything")
    if len(block.matrix) == 0:
        raise HeadlineCheckError(
            f"{fold_id}: the fold's rows are empty, so there is nothing to rank "
            "the members over"
        )
    names = block.contract.feature_names
    if tuple(names) != tuple(background.feature_names):
        raise HeadlineCheckError(
            "the fold block and the background were encoded under different "
            "feature lists; a column position means nothing across two of them"
        )

    index_of = {name: position for position, name in enumerate(names)}
    #: Every column the map places that this contract actually has. The union
    #: over groups, so one batched call per target covers all eight.
    ranked_columns = tuple(
        sorted(
            {
                index_of[member]
                for group in group_map.groups
                for member in group.members
                if member in index_of
            }
        )
    )
    if not ranked_columns:
        raise HeadlineCheckError(
            "no member of any driver group is a column of this feature "
            "contract, so there is nothing to rank"
        )

    chosen = _targets(block, background, count=targets, seed=seed)
    if not chosen:
        raise HeadlineCheckError(
            f"{fold_id}: no fold row falls in a cell the background covers, so "
            "no member can be measured against a typical one"
        )

    totals = {column: 0.0 for column in ranked_columns}
    for key, row in chosen:
        for column, value in _row_effects(
            key=key,
            target_row=row,
            background=background,
            block=block,
            columns=ranked_columns,
            expectation=expectation,
        ).items():
            totals[column] += abs(value)
    mean_abs = {column: totals[column] / len(chosen) for column in ranked_columns}

    verdicts = tuple(
        _verdict_for(group_map.group(code), mean_abs=mean_abs, index_of=index_of)
        for code in DRIVER_GROUP_CODES
    )
    return HeadlineFeatureCheck(
        group_map=group_map,
        groups=verdicts,
        targets=len(chosen),
        members_evaluated=len(ranked_columns),
        seed=seed,
        fold_id=fold_id,
    )


def _verdict_for(
    group: DriverGroup, *, mean_abs: dict[int, float], index_of: dict[str, int]
) -> GroupHeadlineCheck:
    """One group's verdict, over the members this contract has."""
    present = tuple(member for member in group.members if member in index_of)
    if not present:
        return GroupHeadlineCheck(
            code=group.code,
            headline_feature=group.headline_feature,
            verdict="no_member_in_contract",
            largest_member=None,
            headline_mean_abs_phi_mwh=None,
            largest_mean_abs_phi_mwh=None,
            members_in_contract=0,
        )
    if group.headline_feature not in index_of:
        return GroupHeadlineCheck(
            code=group.code,
            headline_feature=group.headline_feature,
            verdict="headline_not_in_contract",
            largest_member=None,
            headline_mean_abs_phi_mwh=None,
            largest_mean_abs_phi_mwh=None,
            members_in_contract=len(present),
        )
    # Ties broken by name, so the ranking is a function of the numbers and the
    # spelling and never of dictionary order.
    largest = max(present, key=lambda member: (mean_abs[index_of[member]], member))
    largest_value = mean_abs[index_of[largest]]
    headline_value = mean_abs[index_of[group.headline_feature]]
    if largest_value == 0.0:
        return GroupHeadlineCheck(
            code=group.code,
            headline_feature=group.headline_feature,
            verdict="no_movement",
            largest_member=None,
            headline_mean_abs_phi_mwh=headline_value,
            largest_mean_abs_phi_mwh=largest_value,
            members_in_contract=len(present),
        )
    confirmed = largest == group.headline_feature
    return GroupHeadlineCheck(
        code=group.code,
        headline_feature=group.headline_feature,
        verdict="confirmed" if confirmed else "mismatch",
        largest_member=largest,
        headline_mean_abs_phi_mwh=headline_value,
        largest_mean_abs_phi_mwh=largest_value,
        members_in_contract=len(present),
    )


def _targets(
    block: FeatureBlock,
    background: MatchedBackground,
    *,
    count: int,
    seed: int,
) -> tuple[tuple[RowKey, npt.NDArray[np.float64]], ...]:
    """A seeded, order-independent sample of the fold's rows.

    Drawn without replacement over the row positions the background has a cell
    for, then sorted by position, so the sample is a function of the seed and
    the block and not of the order the rows were handed over in.
    """
    eligible = [
        position
        for position, key in enumerate(block.keys)
        if CellKey(subsystem=key.subsystem, local_hour=key.local_hour) in background.cells
    ]
    if not eligible:
        return ()
    generator = np.random.default_rng(seed)
    taken = (
        eligible
        if len(eligible) <= count
        else sorted(
            int(one) for one in generator.choice(eligible, size=count, replace=False)
        )
    )
    return tuple(
        (block.keys[position], np.asarray(block.matrix[position], dtype=np.float64))
        for position in taken
    )


def _row_effects(
    *,
    key: RowKey,
    target_row: npt.NDArray[np.float64],
    background: MatchedBackground,
    block: FeatureBlock,
    columns: tuple[int, ...],
    expectation: BlockExpectation,
) -> dict[int, float]:
    """``v({m}) − v(∅)`` for every column, from one batched call to ``g``.

    ``1 + |columns|`` blocks of ``|B(s, h)|`` rows: the background as drawn,
    and then one copy per column with that single column overwritten from the
    target. The whole thing goes to ``g`` in one call for the reason
    :func:`~wattsteer_ml.diagnosis.attribution._coalition_rows` gives — the cost
    here is model evaluations, and a per-column call would pay LightGBM's
    per-batch overhead ``k`` times for the same rows.

    Every constructed row carries the *target's* key, which is truthful because
    the background is matched: every row of ``B(s, h)`` already has that
    subsystem and that local hour, so ``μ_sub`` is looked up for the cell the
    row belongs to either way. Same argument as
    :mod:`wattsteer_ml.diagnosis.composed_target`.
    """
    cell = background.cell_for(key)
    rows = len(cell.keys)
    stacked = np.tile(cell.matrix, (1 + len(columns), 1))
    for offset, column in enumerate(columns, start=1):
        start = offset * rows
        stacked[start : start + rows, column] = target_row[column]

    unlabelled = np.full(len(stacked), np.nan, dtype=np.float64)
    evaluated = np.asarray(
        expectation(
            FeatureBlock(
                contract=block.contract,
                keys=(key,) * len(stacked),
                matrix=stacked,
                # Counterfactual vectors, not hours that happened.
                total_mwh=unlabelled,
                wind_mwh=unlabelled,
                has_curtailment=unlabelled,
                threshold_mw=block.threshold_mw,
            )
        ),
        dtype=np.float64,
    )
    if evaluated.shape != (len(stacked),):
        raise HeadlineCheckError(
            f"g returned {evaluated.shape} for {len(stacked)} constructed rows"
        )
    per_block = evaluated.reshape(1 + len(columns), rows)
    empty = float(np.mean(per_block[0]))
    return {
        column: math.fsum((float(np.mean(per_block[offset])), -empty))
        for offset, column in enumerate(columns, start=1)
    }
