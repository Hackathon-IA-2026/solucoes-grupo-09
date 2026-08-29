"""Exact Shapley values over a small player set, by full enumeration.

`docs/specs/diagnosis.md`, "How ``g`` is attributed". This module is the
cooperative game and nothing else: it is handed the value of every coalition and
it returns one number per player.

```
φ_j = Σ_{S ⊆ N\\{j}}  (|S|! · (n − |S| − 1)! / n!) · [ v(S ∪ {j}) − v(S) ]
```

**Exact, because eight players is 256 coalitions.** Sampling estimators exist
because ``2ⁿ`` is unaffordable at ``n = 200``; at ``n = 8`` it is a rounding
error in the cost of the model evaluations that produce ``v``. So the *ranking*
this service publishes carries no Monte-Carlo noise, and the only residual error
is the background sample's.

**This module has no idea what a feature is.** It sees players, coalitions
addressed by bitmask, and floats — and that is deliberate rather than tidy. The
players in this game are the eight driver groups, and a module that could not
name a feature if it wanted to is a module that cannot sum member-level values
into a group's. `docs/specs/diagnosis.md` seam 3 asserts exactly that, by
reading this file.

**Summation is :func:`math.fsum` throughout.** Local accuracy — ``Σⱼ φⱼ =
v(N) − v(∅)`` — is what makes the published shares mean anything, and it is
asserted rather than hoped for by the caller. Pairwise summation of 256
weighted differences in naive order would leave a residual an order of magnitude
larger than the one the arithmetic actually requires.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

#: Above this the enumeration stops being free and somebody is using this module
#: for a game it was not built for. Eight players is the design; the bound is
#: generous and is a guard rail, not a parameter to raise.
MAX_ENUMERATED_PLAYERS = 16


class ShapleyError(ValueError):
    """The coalition values are not a game over the stated players."""


def coalition_count(players: int) -> int:
    """``2ⁿ`` — how many coalition values a game over ``players`` players needs."""
    _check_players(players)
    return 1 << players


def coalition_weights(players: int) -> tuple[float, ...]:
    """``|S|! · (n − |S| − 1)! / n!``, indexed by ``|S|``.

    One entry per coalition *size* rather than per coalition, because the
    Shapley weight depends on nothing else. Exposed so a test can assert the
    weights sum over the ``C(n−1, |S|)`` coalitions of each size to one, which is
    the identity that makes the value an average over orderings.
    """
    _check_players(players)
    total = math.factorial(players)
    return tuple(
        math.factorial(size) * math.factorial(players - size - 1) / total
        for size in range(players)
    )


def exact_shapley(
    coalition_values: Sequence[float], *, players: int
) -> tuple[float, ...]:
    """``φ`` for every player, from the value of every coalition.

    Args:
        coalition_values: ``v(S)`` indexed by the bitmask of ``S`` — bit ``j``
            set means player ``j`` is in the coalition. Length ``2ⁿ``, so
            ``coalition_values[0]`` is ``v(∅)`` and ``coalition_values[-1]`` is
            ``v(N)``.
        players: ``n``.

    Returns:
        ``φ₀ … φₙ₋₁``, in player order.

    Raises:
        ShapleyError: if the values are not a complete game over ``n`` players,
            or if any of them is not finite. A game with a hole in it has no
            Shapley value, and filling the hole is not this module's decision.
    """
    expected = coalition_count(players)
    if len(coalition_values) != expected:
        raise ShapleyError(
            f"a game over {players} players has {expected} coalitions and "
            f"{len(coalition_values)} values were supplied"
        )
    for mask, value in enumerate(coalition_values):
        if not math.isfinite(value):
            raise ShapleyError(f"v({mask:0{players}b}) is {value!r}")

    weights = coalition_weights(players)
    phi: list[float] = []
    for player in range(players):
        bit = 1 << player
        terms = [
            weights[_popcount(mask)]
            * (coalition_values[mask | bit] - coalition_values[mask])
            for mask in range(expected)
            if not mask & bit
        ]
        phi.append(math.fsum(terms))
    return tuple(phi)


def shapley_operator(players: int) -> tuple[tuple[float, ...], ...]:
    """The same game as :func:`exact_shapley`, written as the linear map it is.

    ``φ = M · v``, with ``M`` of shape ``n × 2ⁿ``. Shapley values are linear in
    the value function — the identity the whole day sum rests on — so a game
    over a fixed player set *is* a matrix, and re-solving it for hundreds of
    bootstrap redraws of the background is one matrix product instead of
    hundreds of enumerations.

    Coefficients, read straight off the definition: ``v(T)`` enters ``φ_j``
    with ``+w(|T| − 1)`` when ``j ∈ T`` (it is the ``S ∪ {j}`` end of some
    marginal contribution) and with ``−w(|T|)`` when ``j ∉ T``.

    **This is not the published path.** :func:`exact_shapley` is the definition
    and the only function whose output reaches a payload: it sums with
    :func:`math.fsum`, which is what makes local accuracy assertable at the
    arithmetic's own level. A caller that wants a *spread* over resampled value
    functions does not need the last bit and cannot afford the enumeration, and
    gets this instead. A test pins the two against each other.

    Returns:
        ``M`` as rows, one per player, in player order.
    """
    weights = coalition_weights(players)
    subsets = coalition_count(players)
    rows: list[tuple[float, ...]] = []
    for player in range(players):
        bit = 1 << player
        row: list[float] = []
        for mask in range(subsets):
            size = _popcount(mask)
            row.append(weights[size - 1] if mask & bit else -weights[size])
        rows.append(tuple(row))
    return tuple(rows)


def local_accuracy_residual(
    phi: Sequence[float], coalition_values: Sequence[float], *, players: int
) -> float:
    """``Σⱼ φⱼ − (v(N) − v(∅))`` — zero in exact arithmetic, tiny in floats.

    Returned rather than asserted so the caller decides what to do with it and
    so the number itself can be published: an attribution whose residual is not
    at the level of the arithmetic is an attribution of some other function.
    """
    if len(phi) != players:
        raise ShapleyError(f"{len(phi)} values for {players} players")
    total = coalition_values[coalition_count(players) - 1] - coalition_values[0]
    return math.fsum(phi) - total


def _popcount(mask: int) -> int:
    return bin(mask).count("1")


def _check_players(players: int) -> None:
    if players <= 0:
        raise ShapleyError(f"a game needs players, got {players!r}")
    if players > MAX_ENUMERATED_PLAYERS:
        raise ShapleyError(
            f"{players} players is {1 << players} coalitions; full enumeration is "
            f"the whole point of grouping and it stops being free above "
            f"{MAX_ENUMERATED_PLAYERS}"
        )
