"""The planning envelope, named — an *internal* parameter and never a request field.

`docs/specs/flex-optimizer.md` §"The `E[Y]` arm is carried alongside" decides two
things at once, and this module is the second of them:

1. **The product plans on P50 and promises the P10 edge**, and the user is never
   asked. There is no request body key, no query parameter and no scenario field
   that can select a basis — flex-optimizer 04 asserts it of the published
   contract, 07 asserts it of this service, and 08 removed the prototype's
   toggle from the Mitigate screen.
2. **A second planning arm against `E[Y]` has to be buildable anyway**, because
   the execution rule makes over-planning nearly free — an asset charges the
   scheduled amount or what is actually being curtailed, whichever is smaller —
   while a plan that is blind in an hour cannot act in it at all. P50 therefore
   sits on the cautious side of an asymmetry it was not chosen for, and
   `E[Y] > P50` exactly when `p < 0.5`: the expectation is non-zero in precisely
   the hours where the P50 plan goes blind. `forecaster.md`'s fold evaluation
   scores that arm through this package's simulator, *unchanged*, and publishes
   both arms' `recovered_floor_mwh`.

**Why the envelope is an object and not a string.** The whole risk of making the
basis a parameter is that a parameter is one refactor away from being a field. A
`PlanningEnvelope` cannot be decoded from JSON, cannot be spelled by a query
string and cannot be produced by anything a request touches: reaching the `E[Y]`
arm means importing this module and calling
:meth:`PlanningEnvelope.expectation` in Python. A `basis="expected"` keyword
would have been smuggleable out of a ``dict[str, Any]`` in one line and mypy
would not have minded, because everything out of that dict is ``Any``.

**Why the expectation is not a fourth quantile.** `E[Y]` is a genuine
expectation and adds across hours legitimately, which is exactly what the
hour-wise quantile envelopes do not do. It therefore travels beside the band and
never inside it — the published forecast contract already carries it as
``expected_mwh``, a sibling of ``p10``/``p50``/``p90`` — and
:data:`PlanningBasis` names it ``"expected"`` for the same reason. The published
`OptimizationResult` enum stays ``p10``/``p50``/``p90`` and always reads
``"p50"``: the arm is measurement, not a product option, and nothing here widens
what the endpoint can say.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

#: The envelopes a plan can be built against. Two, not four: P10 collapses at a
#: hurdle forecaster — (C5) forbids charging in every hour whose occurrence is
#: uncertain, so the "conservative plan" is the do-nothing plan — and P90 is not
#: a planning basis anyone has proposed. Widening this is a change to
#: `docs/specs/flex-optimizer.md`'s posture, not a change to a type.
PlanningBasis = Literal["p50", "expected"]


@dataclass(frozen=True)
class PlanningEnvelope:
    """One named 24-hour profile, and the only way to ask the builder for an arm.

    :attr:`basis` is carried *with* the numbers rather than beside them, so a
    plan cannot record an envelope it was not built on. That is what makes the
    two arms comparable: they differ in this object and in nothing else, and
    `planning_basis` on the resulting plan is read off the input rather than
    asserted by a caller.
    """

    basis: PlanningBasis
    #: ``curt[t]``, the curtailment offered to absorb in each local hour.
    offered_mwh: tuple[float, ...]

    @classmethod
    def p50(cls, values: Sequence[float]) -> PlanningEnvelope:
        """The shipped basis. Every public path builds this one and only this one."""
        return cls("p50", tuple(float(value) for value in values))

    @classmethod
    def expectation(cls, values: Sequence[float]) -> PlanningEnvelope:
        """`E[Y]`, the measurement arm. No request can reach this constructor."""
        return cls("expected", tuple(float(value) for value in values))


__all__ = ["PlanningBasis", "PlanningEnvelope"]
