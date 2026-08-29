"""The shiftable load's (D1)–(D5): Zerrahn & Schill's double-indexed DSM block.

§2.4 of `docs/research/optimizer-formulation.md`, built as it is published. It
is a separate module from :mod:`.milp` because it is a separate decision: the
whole point of the block is that a second `FlexibilityAsset` variant is *a new
constraint block and one more term in the coupling sum* (C1), and nothing else
— not the common fields, not the transport, not the result shape, not the
simulator, not the KPI definitions. `EV`, `DataCentre`, `Electrolyzer` and
`HVAC` are meant to land the same way, and that claim is easier to keep honest
when the block it is a claim about has its own file.

**The double index is the formulation, not decoration.** ``do[a,t,t']`` is the
down-shift in hour ``t'`` that compensates the up-shift of hour ``t``, and it
exists only for ``|t − t'| ≤ L_a``. The naive single-index model — one
``down[a,t]`` series and a daily-energy equality — balances the same total while
letting a down-shift land arbitrarily far from the up-shift it is supposed to
compensate. Zerrahn & Schill call that **undue recovery** and show it *"may
ultimately result in a serious overestimation of longer-term load shifts"*.
Tagging each down-shift to its up-shift is what makes ``shift_window_hours``
mean what an operator reads it to mean.

**Daily energy is conserved by construction and is not a constraint.** (D1) is
an equality per up-shift hour, and every ``do`` variable this module creates has
*both* its indices inside the horizon — the window is clipped at the edges of
the day rather than wrapped or extended. Summing (D1) over ``t`` therefore gives
``Σ_t up[t] = Σ_t' down[t']`` exactly, with no daily-energy row anywhere in the
model. `docs/specs/flex-optimizer.md` is emphatic that adding one would be
redundant against (D1) and would make an infeasible model far harder to
diagnose. What ``daily_energy_mwh`` buys instead is the one physical check the
formulation cannot make for itself — a load cannot be shed by more power than it
draws — and that check is validation's, re-asserted at the model boundary.

**No binaries.** (D4) is the load-side analogue of the battery's (B7)–(B8) and
is a plain linear inequality: it permits partial simultaneity up to
``max(C̄up, C̄do)`` in aggregate, which is physically right for a process made of
many small units. (D5), the recovery time, is integer-free for the same reason
and is emitted **only** when an asset supplies ``recovery_time_hours``.

**Shift losses (their eq. 7′) are not implemented.** A shiftable load in v1 is
lossless: what it moves, it gives back. Adding ``shift_efficiency`` later is a
coefficient on the left of (D1) and nothing else — which is also why the
simulator can say a shifted load contributes nothing to ``round_trip_loss_mwh``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .fleet import ShiftableLoad
from .horizon import Horizon

#: Below this a solved shift counts as no shift at all, for the purpose of
#: reporting which up-shift a down-shift compensated. Solver noise, not a
#: threshold anyone configures.
_ZERO_MW = 1e-9


@dataclass(frozen=True)
class Compensation:
    """One ``do[a,t,t']`` that came back non-zero: which hour paid which back.

    The double index is the honest part of the formulation, so it is carried out
    of the solve rather than summed away. Without it, "a down-shift never lands
    more than ``L`` hours from the up-shift it compensates" is a property no
    test can read — and a property no test can read is one that stops holding
    quietly.
    """

    #: ``t`` — the hour that consumed early.
    up_hour: int
    #: ``t'`` — the hour that gave it back.
    down_hour: int
    mwh: float

    @property
    def distance_hours(self) -> int:
        """``|t − t'|``. Never above the load's ``shift_window_hours``."""
        return abs(self.up_hour - self.down_hour)


@dataclass(frozen=True)
class LoadDispatch:
    """One shiftable load's scheduled day, extracted into plain floats."""

    key: str
    label: str
    #: ``up[a,t]``, MW.
    shift_up_mw: tuple[float, ...]
    #: ``Σ_t do[a,t,t']``, MW — everything given back in hour ``t'``.
    shift_down_mw: tuple[float, ...]
    #: The non-zero ``do[a,t,t']`` themselves, tagged as the model tags them.
    compensations: tuple[Compensation, ...]

    @property
    def shifted_mwh(self) -> float:
        """``Σ_t up[a,t]·Δt`` — the energy that moved."""
        return sum(self.shift_up_mw)

    @property
    def returned_mwh(self) -> float:
        """``Σ_t' down[a,t']·Δt``. Equal to :attr:`shifted_mwh` by (D1)."""
        return sum(self.shift_down_mw)


@dataclass(frozen=True)
class LoadBlock:
    """One load's variables, held until the values are copied out of the solve."""

    load: ShiftableLoad
    up: tuple[Any, ...]
    #: ``do[a,t,t']`` keyed by ``(t, t')``. Sparse: only ``|t − t'| ≤ L``.
    down: dict[tuple[int, int], Any]

    def net_shift(self, solver: Any, hour: int) -> Any:
        """``up[a,t] − Σ_t' do[a,t',t]`` — this load's term in (C1).

        The sum is over the *first* index: what hour ``t`` gives back is every
        down-shift scheduled in ``t``, whichever up-shift each compensates.
        """
        given_back = [
            variable
            for (_, down_hour), variable in self.down.items()
            if down_hour == hour
        ]
        return self.up[hour] - solver.Sum(given_back)


def window(load: ShiftableLoad, hour: int, horizon: Horizon) -> range:
    """``[t − L_a, t + L_a]`` intersected with the horizon.

    Clipped rather than wrapped. A window that ran off the end of the day would
    either compensate an up-shift on a day this horizon does not cover or —
    worse — wrap round to hour 0 and give the energy back before it was taken.
    Clipping is what makes ``Σ up = Σ down`` hold *within the day*, which is the
    whole content of "shifted never quietly means avoided".
    """
    span = load.shift_window_hours
    last = hour + span
    if last > len(horizon) - 1:
        last = len(horizon) - 1
    first = hour - span
    if first < 0:
        first = 0
    return range(first, last + 1)


def build_loads(
    solver: Any,
    named: Any,
    loads: Sequence[ShiftableLoad],
    horizon: Horizon,
) -> tuple[LoadBlock, ...]:
    """(D1)–(D4) per load, plus (D5) for the loads that asked for it."""
    blocks: list[LoadBlock] = []
    for load in loads:
        tag = load.key
        up: list[Any] = []
        down: dict[tuple[int, int], Any] = {}
        for hour in horizon.hours:
            # (D2): the bound *is* the constraint, as (B4)/(B5) are for the
            # battery. Outside the availability window the bound is zero, so the
            # variable exists at every index and is pinned rather than special-
            # cased — and (D1) there reads 0 = 0.
            open_now = load.availability.covers(hour)
            up.append(
                solver.NumVar(
                    0.0,
                    load.up_limit_mw if open_now else 0.0,
                    named("up", tag, f"t{hour:02d}"),
                )
            )
        for hour in horizon.hours:
            for other in window(load, hour, horizon):
                # A shift is real only if the process is running at both ends of
                # it: the hour that consumes early, and the hour that gives back.
                both_open = load.availability.covers(hour) and load.availability.covers(
                    other
                )
                down[hour, other] = solver.NumVar(
                    0.0,
                    load.down_limit_mw if both_open else 0.0,
                    named("do", tag, f"t{hour:02d}", f"t{other:02d}"),
                )
        for hour in horizon.hours:
            # (D1). Every upward shift is compensated by downward shifts in due
            # time — before it, after it, or both — and this equality is the
            # entirety of the load's energy conservation.
            compensating = [down[hour, other] for other in window(load, hour, horizon)]
            solver.Add(up[hour] == solver.Sum(compensating))
        for hour in horizon.hours:
            given_back = solver.Sum(
                [down[other, hour] for other in window(load, hour, horizon)]
            )
            # (D3). Implied by (D4) while C̄up = C̄do — the asset schema carries
            # one `max_shift_mw` — and emitted anyway: it is the published
            # formulation, and it is what still holds the down-shift down if an
            # asymmetric pair is ever added.
            solver.Add(given_back <= load.down_limit_mw)
            # (D4). The load-side analogue of (B7)–(B8), and the reason the load
            # needs no binaries at all.
            solver.Add(up[hour] + given_back <= load.simultaneity_limit_mw)
        _build_recovery(solver, load, horizon, up)
        blocks.append(LoadBlock(load=load, up=tuple(up), down=down))
    return tuple(blocks)


def _build_recovery(
    solver: Any, load: ShiftableLoad, horizon: Horizon, up: list[Any]
) -> None:
    """(D5), emitted only for a load that supplies ``recovery_time_hours``.

    A freezer that cannot cycle every ``L`` hours: the cumulative upward shift
    over any ``R`` consecutive hours may not exceed the upward energy of one DSM
    cycle, ``C̄up·L``. Integer-free, and absent from the model *entirely* when
    the asset does not ask for it — which is a property the suite reads off the
    model's own constraint count rather than off this comment.
    """
    recovery = load.recovery_time_hours
    if recovery is None:
        return
    for hour in horizon.hours:
        last = hour + recovery
        if last > len(horizon):
            last = len(horizon)
        solver.Add(
            solver.Sum([up[index] for index in range(hour, last)])
            <= load.cycle_energy_mwh
        )


def extract_loads(
    blocks: Sequence[LoadBlock], horizon: Horizon
) -> tuple[LoadDispatch, ...]:
    """Copy every solution value out while the solver is still alive."""
    dispatches: list[LoadDispatch] = []
    for block in blocks:
        solved = {
            pair: float(variable.solution_value())
            for pair, variable in block.down.items()
        }
        dispatches.append(
            LoadDispatch(
                key=block.load.key,
                label=block.load.label,
                shift_up_mw=tuple(
                    float(variable.solution_value()) for variable in block.up
                ),
                shift_down_mw=tuple(
                    sum(
                        value
                        for (_, down_hour), value in solved.items()
                        if down_hour == hour
                    )
                    for hour in horizon.hours
                ),
                compensations=tuple(
                    Compensation(up_hour=up_hour, down_hour=down_hour, mwh=value)
                    for (up_hour, down_hour), value in sorted(solved.items())
                    if value > _ZERO_MW
                ),
            )
        )
    return tuple(dispatches)


__all__ = [
    "Compensation",
    "LoadBlock",
    "LoadDispatch",
    "build_loads",
    "extract_loads",
    "window",
]
