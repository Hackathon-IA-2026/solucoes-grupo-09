"""One hour, eight signed numbers in MWh, and they add up exactly.

`docs/specs/diagnosis.md`, "Which model SHAP explains" and "Feature grouping".
For one ``(subsystem, valid_time)`` this module produces the eight driver
groups' contributions to the hour's **composed expected**
``constrained_off_mwh``, measured against a typical hour of the same cell.

**The attributed quantity is the composed expectation and nothing else.**

```
g(x) = E[Y | x] = p(x)·Ê[Y | Y > τ, x] + (1 − p(x))·μ_sub(s, h)
```

The occurrence probability explains half the model; the magnitude booster
answers a question the screen never asks; a composed quantile is piecewise, and
the Shapley values of a step function hand the whole hour to whichever feature
moved ``p`` across the branch. The expectation is the one published quantity
that is a genuine function of both hurdle stages, continuous in every feature,
denominated in the product's own unit and additive across hours.

**Composition happens before attribution, never after.** Attributing the two
stages separately and gluing them leaves a cross term
``(Σⱼ φ^p_j)(Σⱼ φ^m_j)`` that does not decompose per feature; every rule for
splitting it is invented and the rules disagree most on the interesting hours.
So ``g`` is attributed as **one function of one feature vector**, and ``g``
itself is evaluated through the forecaster's own composition — see
:mod:`wattsteer_ml.diagnosis.composed_target`. This module never composes
anything; it is handed a callable that does.

**The players are the eight groups, not the two hundred features.** A group's
contribution is a Shapley value of the group *as a player*, so there is no
aggregation step in which a sign could be lost, and there is no member-level
``φ`` anywhere in this package for a later optimisation to sum. Eight players is
256 coalitions, so the values are exact and the ranking carries no sampling
noise.

```
v(S) = (1/|B|) · Σ_{b ∈ B(s,h)} g( x[S] ⊕ b[S̄] )        for S ⊆ {1..8}
```

**Interventional, against the artifact's matched background.** The value
function asks "what does the model do when this group is replaced by a typical
one", which is the question the screen's observed-versus-typical framing already
asks. The background is drawn once, elsewhere, and stamped
(:mod:`wattsteer_ml.diagnosis.background`); this module receives one and cannot
draw one — it does not import the sampler.

**Offline, batched, once per publication.** 256 coalitions × 128 background rows
is 32,768 constructed rows for one instance, and every one of them is evaluated
in a single call. :attr:`HourAttribution.elapsed_seconds` records what that
cost, so the publication budget is argued about with a number.
"""

from __future__ import annotations

import math
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import numpy as np
import numpy.typing as npt

from wattsteer_ml.diagnosis.background import BackgroundCell, MatchedBackground
from wattsteer_ml.diagnosis.driver_groups import (
    DRIVER_GROUP_CODES,
    DRIVER_GROUP_MAP,
    DriverGroupMap,
    GroupCode,
)
from wattsteer_ml.diagnosis.shapley import (
    coalition_count,
    exact_shapley,
    local_accuracy_residual,
    shapley_operator,
)
from wattsteer_ml.evaluation import RowKey

#: What the payload says it attributed. `api-surface.md` spells the day grain
#: `"expected_mwh_day"`; this is the hour it is summed from.
ATTRIBUTION_TARGET_HOUR = "expected_mwh_hour"

#: The sentence the screen is required to carry, as a code rather than a string
#: — `i18n.md`'s rule is that the API returns codes and the client translates.
#: The attribution explains the **expected MWh**. It does not explain the P10,
#: the P90, the width of the band, or the day-level occurrence probability.
EXPLAINS_CODE = "diagnosis.explains_expectation_not_band"

#: How far ``Σⱼ φⱼ`` may sit from ``g(x) − v(∅)``, relative to the larger of the
#: two ends and 1 MWh. Local accuracy is exact in exact arithmetic; what is left
#: is the float addition of 256 coalition values, each itself a mean of 128
#: model outputs. The bound is the arithmetic's, not a judgement about how close
#: is close enough — a residual above it means some other function was
#: attributed, not that the sum drifted.
LOCAL_ACCURACY_TOLERANCE = 1e-9

#: ``direction`` on the wire. ``"mixed"`` exists too, and belongs to the client's
#: merged ``other`` row; a group is one player with one signed contribution and
#: can never be mixed.
Direction = Literal["raises", "lowers"]


class AttributionError(ValueError):
    """The attribution cannot be produced from what it was given."""


class LocalAccuracyError(AttributionError):
    """``Σⱼ φⱼ`` is not ``g(x) − v(∅)``.

    Raised at construction, so an attribution whose shares would not be shares
    of anything does not exist as a value.
    """


class EmptyPlayerError(AttributionError):
    """A driver group has no column in this contract.

    A player who cannot move is a bar that is structurally zero, and a screen
    that renders it as "this had no effect today" would be saying something the
    model never said. The fix is a feature list that carries the group, or a map
    edit — never a silently absent player.
    """


class ComposedExpectation(Protocol):
    """``g`` — the composed expectation of a block of rows, in MWh.

    A protocol rather than a function type because the **key is an argument**.
    ``μ_sub(subsystem, local_hour)`` is a term of the composition, so evaluating
    ``g`` needs the cell as well as the row; taking it here means the pairing is
    made by :func:`attribute_hour` from the target's own key and is not something
    a call site can bind wrongly. It is truthful for a constructed coalition row
    because the background is matched: every row in the cell already carries that
    subsystem and that local hour, whichever side of the split those columns fell
    on.
    """

    def __call__(
        self, key: RowKey, matrix: npt.NDArray[np.float64]
    ) -> npt.NDArray[np.float64]:
        """One expectation per row of ``matrix``, in ``matrix`` order."""
        ...


@dataclass(frozen=True)
class GroupContribution:
    """One player's signed contribution, and its share of the movement."""

    code: GroupCode
    label_code: str
    #: ``φ_j`` in MWh. Signed: the model's expectation for this hour sits this
    #: much higher (or lower) than a typical hour's *because this group is what
    #: it is rather than typical* — a statement about the model, never about the
    #: grid.
    phi_mwh: float
    #: ``|φ_j| / Σ_k |φ_k|`` **over all eight groups** — not over the rows the
    #: screen ends up displaying, which was circular, since the display cut is
    #: itself applied to ``share``. Shares therefore sum to 1 and an hour whose
    #: drivers cancel still produces a full bar chart.
    share: float
    direction: Direction

    def __post_init__(self) -> None:
        if not math.isfinite(self.phi_mwh):
            raise AttributionError(f"φ for {self.code!r} is {self.phi_mwh!r}")
        if not 0.0 <= self.share <= 1.0:
            raise AttributionError(f"share for {self.code!r} is {self.share!r}")
        expected: Direction = "lowers" if self.phi_mwh < 0.0 else "raises"
        if self.direction != expected:
            raise AttributionError(
                f"{self.code!r} carries φ = {self.phi_mwh} and direction "
                f"{self.direction!r}; the sign is not a separate decision"
            )

    def to_payload(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "label_code": self.label_code,
            "phi_mwh": self.phi_mwh,
            "share": self.share,
            "direction": self.direction,
        }


@dataclass(frozen=True)
class HourAttribution:
    """Eight signed contributions for one hour, and the arithmetic that binds them.

    Local accuracy is checked **here**, at construction, rather than in a test:
    the shares are shares of ``Σ_k |φ_k|``, and if the eight numbers do not add
    up to ``g(x) − v(∅)`` then they are not a decomposition of anything and the
    bar chart is a picture of nothing.
    """

    key: RowKey
    #: What was attributed. Always :data:`ATTRIBUTION_TARGET_HOUR` — the field
    #: exists so the wire says it rather than the reader assuming it.
    target: str
    #: All eight, ranked by ``|share|``. The display cut is the client's.
    contributions: tuple[GroupContribution, ...]
    #: ``v(∅)`` — a typical hour *h* in this subsystem, in MWh.
    baseline_expected_mwh: float
    #: ``g(x) = v(N)`` — this hour's composed expectation, in MWh.
    expected_mwh: float
    #: ``Σⱼ φⱼ − (g(x) − v(∅))``, published rather than swallowed.
    local_accuracy_residual_mwh: float
    #: ``|B(s, h)|`` the value function averaged over.
    background_rows: int
    #: The seed and the provenance of that background, so the attribution is
    #: reproducible from the artifact alone.
    background_seed: int
    background_source: str
    #: ``2⁸``. Recorded because "exact, not sampled" is a claim the payload can
    #: carry rather than one a reader has to take on trust.
    coalitions: int
    #: Wall clock for this one instance, seconds.
    elapsed_seconds: float
    driver_group_version: str
    driver_group_hash: str
    #: ``v(S)`` before it was averaged — one row per coalition, one column per
    #: background row — retained only when the caller asked for it, and never on
    #: the wire. :func:`resample_phi` is its only reader: a bootstrap over the
    #: background is a re-weighting of *these* numbers, and redrawing the cell to
    #: evaluate ``g`` again would spend 200× the model evaluations to arrive at
    #: the same block. Excluded from equality and from ``repr`` because a
    #: 32,768-entry array is neither a comparable value nor a readable one.
    coalition_rows: npt.NDArray[np.float64] | None = field(
        default=None, repr=False, compare=False
    )

    def __post_init__(self) -> None:
        codes = tuple(one.code for one in self.contributions)
        if codes != DRIVER_GROUP_CODES and sorted(codes) != sorted(DRIVER_GROUP_CODES):
            raise AttributionError(
                f"an attribution is all eight groups exactly once, got {codes!r}"
            )
        movement = self.expected_mwh - self.baseline_expected_mwh
        attributed = math.fsum(one.phi_mwh for one in self.contributions)
        scale = max(1.0, abs(self.expected_mwh), abs(self.baseline_expected_mwh))
        if abs(attributed - movement) > LOCAL_ACCURACY_TOLERANCE * scale:
            raise LocalAccuracyError(
                f"the eight contributions sum to {attributed} and "
                f"g(x) − v(∅) is {movement}; a residual of "
                f"{attributed - movement} is above the arithmetic's own "
                f"{LOCAL_ACCURACY_TOLERANCE} × {scale}"
            )
        if self.coalition_rows is not None and self.coalition_rows.shape != (
            self.coalitions,
            self.background_rows,
        ):
            raise AttributionError(
                f"the retained block is {self.coalition_rows.shape} and the game was "
                f"{self.coalitions} coalitions over {self.background_rows} rows"
            )

    @property
    def total_attributed_mwh(self) -> float:
        """``Σⱼ φⱼ`` — equal to ``g(x) − v(∅)``, which is why it is not stored."""
        return math.fsum(one.phi_mwh for one in self.contributions)

    @property
    def sum_abs_attributed_mwh(self) -> float:
        """``Σⱼ |φⱼ|`` — the shares' denominator, and the movement's size."""
        return math.fsum(abs(one.phi_mwh) for one in self.contributions)

    def contribution(self, code: GroupCode) -> GroupContribution:
        """One group's row. The code set is closed, so this cannot miss."""
        for one in self.contributions:
            if one.code == code:
                return one
        raise AttributionError(f"unknown group code {code!r}")

    def to_payload(self) -> dict[str, Any]:
        """The attribution half of the diagnosis response, as codes and numbers.

        ``explains`` is not decoration. `docs/specs/diagnosis.md` requires the
        screen to say, once, that the bars explain the **expected MWh** and not
        the P10, the P90, the band's width or the day's occurrence probability —
        and a disclaimer that lives only in a spec is one nobody ships.
        """
        return {
            "target": self.target,
            "explains": EXPLAINS_CODE,
            "subsystem": self.key.subsystem,
            "target_date": self.key.target_date.isoformat(),
            "local_hour": self.key.local_hour,
            "baseline_expected_mwh": self.baseline_expected_mwh,
            "expected_mwh": self.expected_mwh,
            "total_attributed_mwh": self.total_attributed_mwh,
            "sum_abs_attributed_mwh": self.sum_abs_attributed_mwh,
            "driver_group_version": self.driver_group_version,
            "driver_group_hash": self.driver_group_hash,
            "drivers": [one.to_payload() for one in self.contributions],
        }

    def timing_fields(self) -> dict[str, Any]:
        """What the publication run records about what this instance cost."""
        return {
            "elapsed_seconds": self.elapsed_seconds,
            "coalitions": self.coalitions,
            "background_rows": self.background_rows,
            "background_seed": self.background_seed,
            "background_source": self.background_source,
            "row_evaluations": self.coalitions * self.background_rows,
            "local_accuracy_residual_mwh": self.local_accuracy_residual_mwh,
        }


def group_columns(
    feature_names: Sequence[str], group_map: DriverGroupMap = DRIVER_GROUP_MAP
) -> tuple[tuple[int, ...], ...]:
    """Each player's column positions, in :data:`DRIVER_GROUP_CODES` order.

    Every column is placed, because :meth:`DriverGroupMap.group_of` raises for a
    name no group lists — there is no catch-all to fall into, and a feature
    added upstream that nobody grouped stops the attribution here rather than
    landing quietly in ``data_conditions``.

    Raises:
        EmptyPlayerError: if some group has no column in this contract.
        UngroupedFeatureError: if some column is in no group.
    """
    columns: dict[GroupCode, list[int]] = {code: [] for code in DRIVER_GROUP_CODES}
    for index, name in enumerate(feature_names):
        columns[group_map.group_of(name)].append(index)
    empty = tuple(code for code in DRIVER_GROUP_CODES if not columns[code])
    if empty:
        raise EmptyPlayerError(
            f"these groups have no feature in this contract: {', '.join(empty)}. "
            "A player who cannot move is a bar that is structurally zero"
        )
    return tuple(tuple(columns[code]) for code in DRIVER_GROUP_CODES)


def attribute_hour(
    *,
    key: RowKey,
    target_row: npt.NDArray[np.float64],
    background: MatchedBackground,
    expectation: ComposedExpectation,
    group_map: DriverGroupMap = DRIVER_GROUP_MAP,
    retain_coalition_rows: bool = False,
) -> HourAttribution:
    """The eight contributions for one ``(subsystem, valid_time)``.

    The background cell is derived from ``key`` — the caller supplies the whole
    matched background and never a cell, so a target cannot be attributed
    against some other hour's typical.

    Args:
        key: the target row's identity. Its subsystem and local hour select the
            background cell and reach ``expectation`` as the composition's cell.
        target_row: ``x``, one row encoded against ``background``'s contract.
        background: ``B``, drawn once and stamped. This function does not draw
            one and does not import the sampler.
        expectation: ``g``, evaluating the forecaster's composition over a block
            of rows.
        group_map: the eight players.
        retain_coalition_rows: keep ``v(S)`` per background row on the result, so
            a bootstrap over the background can re-weight the evaluations this
            call already paid for. Off by default: the block is 32,768 floats
            and only the day attribution has a use for it.

    Returns:
        Eight signed contributions in MWh, ranked by ``|share|``, with local
        accuracy already asserted.
    """
    started = time.perf_counter()

    if target_row.ndim != 1:
        raise AttributionError(
            f"the target is one row, got shape {target_row.shape}; the day sum is "
            "over instances and not over a matrix"
        )
    if target_row.shape[0] != len(background.feature_names):
        raise AttributionError(
            f"the target row is {target_row.shape[0]} columns and the background "
            f"was encoded under {len(background.feature_names)}"
        )

    cell = background.cell_for(key)
    columns = group_columns(background.feature_names, group_map)
    per_row = _coalition_rows(
        key=key,
        target_row=target_row,
        cell=cell,
        columns=columns,
        expectation=expectation,
    )
    values = tuple(float(value) for value in per_row.mean(axis=1))
    phi = exact_shapley(values, players=len(DRIVER_GROUP_CODES))
    residual = local_accuracy_residual(phi, values, players=len(DRIVER_GROUP_CODES))

    denominator = math.fsum(abs(one) for one in phi)
    contributions = tuple(
        GroupContribution(
            code=code,
            label_code=group_map.group(code).label_code,
            phi_mwh=value,
            # An hour where every group's φ is exactly zero has no movement to
            # take shares of. Zero is the only honest answer; 1/8 each would
            # draw eight equal bars under a chart title that says "share of the
            # movement" when there was none.
            share=(abs(value) / denominator if denominator > 0.0 else 0.0),
            direction="lowers" if value < 0.0 else "raises",
        )
        for code, value in zip(DRIVER_GROUP_CODES, phi, strict=True)
    )

    return HourAttribution(
        key=key,
        target=ATTRIBUTION_TARGET_HOUR,
        contributions=tuple(
            sorted(contributions, key=lambda one: (-one.share, one.code))
        ),
        baseline_expected_mwh=values[0],
        expected_mwh=values[-1],
        local_accuracy_residual_mwh=residual,
        background_rows=len(cell),
        background_seed=background.seed,
        background_source=background.source,
        coalitions=len(values),
        elapsed_seconds=time.perf_counter() - started,
        driver_group_version=str(group_map.version),
        driver_group_hash=group_map.driver_group_hash,
        coalition_rows=per_row if retain_coalition_rows else None,
    )


@dataclass(frozen=True)
class HourResample:
    """One hour's game, re-solved under redraws of its own background cell.

    ``v(∅)`` and ``φ`` come from the **same** draws, because the spec's bootstrap
    resamples the background once per replicate and recomputes both — a baseline
    bootstrapped independently of the ranking would describe a day nobody could
    have seen.
    """

    #: ``(resamples, players)`` — ``φ`` per replicate, in
    #: :data:`~wattsteer_ml.diagnosis.driver_groups.DRIVER_GROUP_CODES` order.
    phi_mwh: npt.NDArray[np.float64]
    #: ``(resamples,)`` — ``v(∅)`` per replicate, in MWh.
    baseline_expected_mwh: npt.NDArray[np.float64]


def resample_hour(
    attribution: HourAttribution,
    *,
    resamples: int,
    generator: np.random.Generator,
) -> HourResample:
    """This hour's game under ``resamples`` redraws of its own background cell.

    The bootstrap `docs/specs/diagnosis.md` asks for resamples ``B(s, h)`` **with
    replacement** and recomputes the game. Redrawing the cell does not change
    ``g``, and ``g`` has already been evaluated on every one of the
    ``2ⁿ × |B|`` constructed rows, so a redraw is a re-weighting of
    :attr:`HourAttribution.coalition_rows` — which is why the whole bootstrap
    costs one matrix product rather than 200 × 32,768 model evaluations.

    Two matrix products, in fact, and the second is the game itself:
    :func:`~wattsteer_ml.diagnosis.shapley.shapley_operator` is
    :func:`~wattsteer_ml.diagnosis.shapley.exact_shapley` written as the linear
    map it is, so the 200 replicate games are solved at once. The published
    ``φ`` is never one of these — it comes from ``exact_shapley`` and its
    :func:`math.fsum`, and local accuracy is asserted against it. These are a
    spread, and a spread does not need the last bit.

    Args:
        attribution: an hour attributed with ``retain_coalition_rows=True``.
        resamples: ``B`` in the bootstrap, the spec's 200.
        generator: seeded by the caller, so the standard error is reproducible
            from the artifact and the day.

    Returns:
        ``φ`` and ``v(∅)`` per replicate, from the same draws.

    Raises:
        AttributionError: if the hour did not retain its block. A bootstrap that
            silently returned zeros would publish "this ranking is certain".
    """
    if resamples <= 0:
        raise AttributionError(f"a bootstrap is resamples, got {resamples!r}")
    per_row = attribution.coalition_rows
    if per_row is None:
        raise AttributionError(
            f"the attribution for {attribution.key.line!r} kept no coalition block; "
            "a bootstrap over the background resamples the evaluations the "
            "attribution already paid for and cannot be run after they are gone"
        )
    rows = per_row.shape[1]
    draws = generator.integers(0, rows, size=(resamples, rows))
    # One column per replicate, holding how many times each background row was
    # drawn into it. ``v_b(S)`` is then the weighted mean the resample defines,
    # and the whole bootstrap is `(2ⁿ × |B|) · (|B| × B)`.
    counts = np.zeros((rows, resamples), dtype=np.float64)
    for replicate in range(resamples):
        counts[:, replicate] = np.bincount(draws[replicate], minlength=rows)
    values = (per_row @ counts) / float(rows)
    operator = np.asarray(shapley_operator(len(DRIVER_GROUP_CODES)), dtype=np.float64)
    return HourResample(
        phi_mwh=np.ascontiguousarray((operator @ values).T),
        # ``v(∅)`` is coalition zero — the row where no group was replaced by the
        # target's, which is what "a typical hour" means.
        baseline_expected_mwh=np.ascontiguousarray(values[0]),
    )


def _coalition_rows(
    *,
    key: RowKey,
    target_row: npt.NDArray[np.float64],
    cell: BackgroundCell,
    columns: tuple[tuple[int, ...], ...],
    expectation: ComposedExpectation,
) -> npt.NDArray[np.float64]:
    """``v(S)`` for every ``S``, per background row, from one batched call to ``g``.

    The 256 coalitions are materialised as one ``(256 · |B|) × k`` block and
    handed to ``g`` in a single call, because the cost of this attribution is
    model evaluations and a per-coalition call would pay LightGBM's per-batch
    overhead 256 times for the same 32,768 rows.

    Each coalition's block starts as a copy of the background and has ``S``'s
    columns overwritten from the target — ``x[S] ⊕ b[S̄]``, in that order, so a
    column the coalition does not name is never touched and cannot be half
    replaced.

    The means are taken by the caller. The block is returned unaveraged because
    the bootstrap needs the rows the mean was taken over, and averaging here
    would mean paying for the evaluations twice to get them back.
    """
    players = len(columns)
    subsets = coalition_count(players)
    rows = len(cell)
    width = cell.matrix.shape[1]

    stacked = np.tile(cell.matrix, (subsets, 1))
    for mask in range(subsets):
        start = mask * rows
        stop = start + rows
        for player in range(players):
            if mask & (1 << player):
                chosen = list(columns[player])
                stacked[start:stop, chosen] = target_row[chosen]

    evaluated = expectation(key, stacked)
    if evaluated.shape != (subsets * rows,):
        raise AttributionError(
            f"g returned {evaluated.shape} for {subsets * rows} rows of {width} columns"
        )
    return np.asarray(evaluated, dtype=np.float64).reshape(subsets, rows)
