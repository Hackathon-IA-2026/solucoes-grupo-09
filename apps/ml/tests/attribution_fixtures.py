"""Synthetic games, contracts and backgrounds for the attribution tests.

**These are fixtures, not data.** Nothing here is a claim about the grid or
about a fitted model. What they exist for is the kind of test
`docs/specs/diagnosis.md` says this spec needs: an attribution has no ground
truth, so almost every assertion is an invariant of the *construction*, and the
cheapest way to pin a construction is a model whose exact answer can be written
down by hand.

Two of the helpers here compute things production code is forbidden to compute.
:func:`member_shapley` attributes to **individual features**, which seam 3
forbids anywhere in `wattsteer_ml.diagnosis`. That is deliberate and the spec
says so in as many words: seam 2 needs the forbidden quantity precisely in order
to demonstrate that grouped Shapley is not its sum, and seam 3's structural test
is scoped to the diagnosis module and not to its fixtures.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import numpy.typing as npt

from wattsteer_ml.constants import Subsystem
from wattsteer_ml.diagnosis.shapley import coalition_count, exact_shapley
from wattsteer_ml.driver_groups import (
    DRIVER_GROUP_CODES,
    DriverGroup,
    DriverGroupMap,
)
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.mixture import MagnitudeQuantiles, compose
from wattsteer_ml.training import FeatureBlock, FeatureColumn, FeatureContract
from wattsteer_ml.training.background import (
    BASE_FIT_SOURCE,
    BackgroundCell,
    MatchedBackground,
)

#: A fixture stand-in for ``pg_get_functiondef(feature_rows)``.
FUNCTION_DEFINITION = "CREATE FUNCTION feature_rows() RETURNS void AS $$ $$;"

#: The cell every fixture target and every fixture background row lives in.
FIXTURE_SUBSYSTEM: Subsystem = "NE"
FIXTURE_HOUR = 14
FIXTURE_DATE = date(2026, 3, 4)


def fixture_key(
    *,
    subsystem: Subsystem = FIXTURE_SUBSYSTEM,
    local_hour: int = FIXTURE_HOUR,
    target_date: date = FIXTURE_DATE,
) -> RowKey:
    return RowKey(target_date=target_date, local_hour=local_hour, subsystem=subsystem)


def synthetic_map(
    members: Sequence[tuple[str, ...]], *, version: int = 1
) -> DriverGroupMap:
    """An eight-group map over invented feature names, in code order.

    The real map is data and is tested by `test_driver_groups.py`. What the
    attribution tests need is a *partition*, small enough that the game it
    defines can be solved on paper, so they get one over names no feature list
    will ever carry.
    """
    if len(members) != len(DRIVER_GROUP_CODES):
        raise ValueError(f"a map is eight groups, got {len(members)}")
    groups = tuple(
        DriverGroup(
            code=code,
            label_code=f"driver.{code}",
            mechanism=f"fixture group {code}",
            headline_feature=names[0],
            unit="mwh",
            members=names,
        )
        for code, names in zip(DRIVER_GROUP_CODES, members, strict=True)
    )
    return DriverGroupMap(version=version, groups=groups, idea_drivers=())


def feature_names_of(group_map: DriverGroupMap) -> tuple[str, ...]:
    """Every member, in group order then declaration order — the column order."""
    return tuple(member for group in group_map.groups for member in group.members)


def contract_of(feature_names: Sequence[str]) -> FeatureContract:
    return FeatureContract(
        columns=tuple(
            FeatureColumn(name=name, dtype="numeric") for name in feature_names
        ),
        function_definition=FUNCTION_DEFINITION,
    )


def block_of(
    feature_names: Sequence[str],
    keys: Sequence[RowKey],
    matrix: npt.NDArray[np.float64],
    *,
    threshold_mw: float = 5.0,
) -> FeatureBlock:
    """A block with no labels — the attribution never reads one."""
    unlabelled = np.full(len(keys), np.nan, dtype=np.float64)
    return FeatureBlock(
        contract=contract_of(feature_names),
        keys=tuple(keys),
        matrix=np.asarray(matrix, dtype=np.float64),
        total_mwh=unlabelled,
        wind_mwh=unlabelled,
        has_curtailment=unlabelled,
        threshold_mw=threshold_mw,
    )


def cell_keys(
    rows: int,
    *,
    subsystem: Subsystem = FIXTURE_SUBSYSTEM,
    local_hour: int = FIXTURE_HOUR,
    first: date = date(2025, 1, 1),
) -> tuple[RowKey, ...]:
    """``rows`` distinct days at the same ``(subsystem, local_hour)``."""
    return tuple(
        RowKey(
            target_date=first + timedelta(days=offset),
            local_hour=local_hour,
            subsystem=subsystem,
        )
        for offset in range(rows)
    )


def background_of(
    feature_names: Sequence[str],
    matrix: npt.NDArray[np.float64],
    *,
    key: RowKey | None = None,
    seed: int = 7,
    source: str = BASE_FIT_SOURCE,
) -> MatchedBackground:
    """One cell's background, built directly rather than drawn.

    The sampler has its own tests; these need a background whose *values* are
    chosen, so the game's answer can be written down in closed form.
    """
    target = key if key is not None else fixture_key()
    rows = matrix.shape[0]
    cell = BackgroundCell(
        subsystem=target.subsystem,
        local_hour=target.local_hour,
        keys=cell_keys(rows, subsystem=target.subsystem, local_hour=target.local_hour),
        matrix=np.asarray(matrix, dtype=np.float64),
    )
    return MatchedBackground(
        feature_names=tuple(feature_names),
        rows_per_cell=rows,
        seed=seed,
        source=source,
        cells={cell.cell_key: cell},
    )


def full_factorial(columns: int) -> npt.NDArray[np.float64]:
    """The ``±1`` full factorial design over ``columns`` columns.

    Every column has mean zero and every product of *distinct* columns has mean
    zero, which is what makes a multilinear game's Shapley values expressible in
    closed form: the background's contribution to any monomial collapses to zero
    unless the coalition holds the whole monomial.
    """
    rows = 1 << columns
    design = np.empty((rows, columns), dtype=np.float64)
    for row in range(rows):
        for column in range(columns):
            design[row, column] = 1.0 if row & (1 << column) else -1.0
    return design


class RowFunction:
    """A ``g`` written per row, adapted to the attribution's protocol.

    The protocol takes the target's key alongside the matrix because ``μ_sub``
    is a term of the real composition. A synthetic ``g`` ignores it, and takes
    it anyway so that the fixtures exercise the same signature production does.
    """

    def __init__(self, evaluate: Callable[[npt.NDArray[np.float64]], float]) -> None:
        self._evaluate = evaluate
        self.calls = 0
        self.rows_seen = 0

    def __call__(
        self, key: RowKey, matrix: npt.NDArray[np.float64]
    ) -> npt.NDArray[np.float64]:
        self.calls += 1
        self.rows_seen += matrix.shape[0]
        return np.asarray([self._evaluate(row) for row in matrix], dtype=np.float64)


@dataclass(frozen=True)
class FixtureComposition:
    """``g`` built out of :func:`wattsteer_ml.mixture.compose` and nothing else.

    Seam 1 asks for local accuracy on *fixture models with no training
    involved*, including at ``p = 0``, at ``p = 1`` and at the isotonic clip
    endpoints. So the fixture's two stages are a linear score each, and the
    probability is whatever :attr:`occurrence` says it is — which lets a test
    pin ``p`` to an endpoint exactly rather than hoping a booster lands there.

    There is no arithmetic here that composes the two stages. The expectation is
    read off :class:`~wattsteer_ml.mixture.ComposedForecast`, which is the same
    call the served forecast makes.
    """

    #: ``x → p(x)``.
    occurrence: Callable[[npt.NDArray[np.float64]], float]
    #: Coefficients of the magnitude score, one per column.
    magnitude_weights: tuple[float, ...]
    sub_threshold_mean_mwh: float
    threshold_mw: float = 5.0

    def __call__(
        self, key: RowKey, matrix: npt.NDArray[np.float64]
    ) -> npt.NDArray[np.float64]:
        weights = np.asarray(self.magnitude_weights, dtype=np.float64)
        out = np.empty(matrix.shape[0], dtype=np.float64)
        for index, row in enumerate(matrix):
            score = float(np.dot(row, weights))
            centre = self.threshold_mw + abs(score)
            quantiles = MagnitudeQuantiles.from_boosters(
                q10=max(0.0, centre - 3.0), q50=centre, q90=centre + 5.0
            )
            out[index] = compose(
                occurrence_probability=self.occurrence(row),
                positive_quantiles=quantiles,
                positive_mean_mwh=centre + 1.0,
                sub_threshold_mean_mwh=self.sub_threshold_mean_mwh,
                threshold_mw=self.threshold_mw,
            ).expected_mwh
        return out


def member_shapley(
    *,
    key: RowKey,
    target_row: npt.NDArray[np.float64],
    background: npt.NDArray[np.float64],
    game: Callable[[RowKey, npt.NDArray[np.float64]], npt.NDArray[np.float64]],
) -> tuple[float, ...]:
    """Interventional Shapley values of the **individual features**.

    The quantity `docs/specs/diagnosis.md` seam 3 forbids production code from
    computing, computed here on purpose: seam 2 proves grouped Shapley is not
    the sum of these, and it cannot prove that without them.
    """
    players = target_row.shape[0]
    subsets = coalition_count(players)
    values: list[float] = []
    for mask in range(subsets):
        rows = background.copy()
        for player in range(players):
            if mask & (1 << player):
                rows[:, player] = target_row[player]
        values.append(float(np.mean(game(key, rows))))
    return exact_shapley(values, players=players)
