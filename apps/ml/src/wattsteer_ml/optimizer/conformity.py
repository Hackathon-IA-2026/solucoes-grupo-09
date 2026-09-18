"""NT DOP 0022 §5.1.2's ordem de corte, as a check the plan has to pass.

## What the rule is, and what it is not

The submódulo 5.1.2 of ONS's NT DOP 0022 fixes the **order in which generation
is curtailed** when a constraint has to be relieved:

    I    hydro that can be held back without spilling
    II   thermal outside merit order
    III  hydro that can only be held back by spilling
    IV   renewables — wind and solar

It is a rule about *ONS's* dispatch decision. WattSteer does not take that
decision and must not appear to: nothing in this repository schedules a
generator. The fleet this optimizer dispatches is batteries and shiftable
loads, and the energy it acts on is what ONS has already curtailed.

So the compliance claim is narrow, and it is the narrowness that makes it
checkable: **the plan acts only on category IV, and never on I–III.** A plan
that absorbed more energy in an hour than that hour's renewable constrained-off
would be proposing that something else had been curtailed instead — which is
either a claim about categories I–III or an arithmetic error, and neither may
reach a screen.

## Why it is a published statement and not a comment

A specialist review asked for the ordem de corte to be respected, and the honest
answer — *we never touch it* — is worth nothing to a reader who cannot see it
checked. So the check runs on every plan, its result is part of the published
contract, and a plan that fails it is refused rather than rendered with a
caveat. `conformity.holds` is therefore always `True` in a served response; it
is in the contract because a field that can only be true by construction is the
one a reviewer can rely on, and because the day the fleet grows a generator this
is the test that will fail.

## The tolerance, and why there is one

Absorption is a solver's float. The comparison allows one part in a million of
the hour's curtailment, which is far below the 5 MW publication threshold and
far above anything CBC's simplex will drift by; a violation that matters is
orders of magnitude larger, because it means an hour was absorbed that had no
curtailment in it at all.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

#: The four categories, in the order the note fixes them.
CutCategory = Literal[
    "hydro_without_spill",
    "thermal_outside_merit",
    "hydro_with_spill",
    "renewable",
]

CUT_ORDER: tuple[CutCategory, ...] = (
    "hydro_without_spill",
    "thermal_outside_merit",
    "hydro_with_spill",
    "renewable",
)

#: The one category a WattSteer plan acts on. Wind and solar constrained-off is
#: what the forecaster predicts, what ONS publishes per subsystem and
#: technology, and the last rung of the order — which is why absorbing it
#: displaces nothing above it.
ACTS_ON: CutCategory = "renewable"

RULE = "NT DOP 0022 §5.1.2"

#: One part in a million of the hour's curtailment. See the module docstring.
_TOLERANCE = 1e-6


class ConformityError(Exception):
    """A plan that would act outside category IV. Never rendered; refused."""

    def __init__(self, hours: Sequence[int], detail: str) -> None:
        super().__init__(detail)
        self.hours = tuple(hours)
        self.detail = detail


@dataclass(frozen=True)
class ConformityStatement:
    """What the response says about the order, for a reader who has to audit it."""

    rule: str
    order: tuple[CutCategory, ...]
    acts_on: CutCategory
    holds: bool
    #: How many hours were compared. A statement over zero hours is not a pass,
    #: and saying so is cheaper than a reviewer having to ask.
    hours_checked: int

    def as_dict(self) -> dict[str, object]:
        return {
            "rule": self.rule,
            "order": list(self.order),
            "acts_on": self.acts_on,
            "holds": self.holds,
            "hours_checked": self.hours_checked,
        }


def check(
    *,
    absorbed_mwh: Sequence[float],
    curtailment_mwh: Sequence[float],
) -> ConformityStatement:
    """Verify the plan stays inside category IV, hour by hour.

    `absorbed_mwh` is the schedule's absorption and `curtailment_mwh` the
    renewable constrained-off profile it was planned against — the same series,
    index for index, that the MILP's (C4) bounds absorption by. The check is
    therefore a *restatement* of a constraint the model already carries, run on
    the solved values rather than trusted from the build, which is the only
    version of it that can fail.
    """
    if len(absorbed_mwh) != len(curtailment_mwh):
        raise ConformityError(
            (),
            f"{len(absorbed_mwh)} scheduled hours against "
            f"{len(curtailment_mwh)} curtailment hours",
        )
    offending = [
        hour
        for hour, (absorbed, curtailed) in enumerate(
            zip(absorbed_mwh, curtailment_mwh, strict=True)
        )
        if absorbed > curtailed + max(abs(curtailed) * _TOLERANCE, _TOLERANCE)
    ]
    if offending:
        raise ConformityError(
            offending,
            "the plan absorbs more than the renewable curtailment in hour(s) "
            + ", ".join(str(hour) for hour in offending)
            + f", which would place it outside category IV of {RULE}",
        )
    return ConformityStatement(
        rule=RULE,
        order=CUT_ORDER,
        acts_on=ACTS_ON,
        holds=True,
        hours_checked=len(absorbed_mwh),
    )
