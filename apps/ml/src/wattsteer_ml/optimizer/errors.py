"""The two ways the optimizer refuses to answer, kept apart on purpose.

`docs/specs/flex-optimizer.md` maps them to different HTTP statuses, and the
distinction is the whole reason `INFEASIBLE` is a `500`:

* :class:`OptimizerBugError` — WattSteer got something wrong. The do-nothing
  dispatch (every charge, discharge and absorb at zero) satisfies every
  constraint in the model, so a validated scenario is feasible *by
  construction*. If the solver says otherwise, or an invariant the builder
  asserts about its own coefficients fails, that is our fault and never the
  caller's.
* :class:`BackendNotPermittedError` — the deployment is misconfigured. Raised while
  resolving ``WATTSTEER_ML_MILP_BACKEND``, before any model exists, because
  the refusals it enforces (`CBC`, `CP-SAT`) are refusals to *start*.
"""

from __future__ import annotations


class OptimizerBugError(RuntimeError):
    """An invariant WattSteer owns did not hold. Never a bad request."""


class SolverNotOptimalError(OptimizerBugError):
    """The solve finished at a status other than ``OPTIMAL``.

    Carries the status name so the transport layer (ticket 06) can map
    ``FEASIBLE`` to `503`, ``NOT_SOLVED`` to `504` and the rest to `500`
    without re-deriving it. Nothing renders a non-optimal result: a `FEASIBLE`
    MILP means the gap was not closed, so the Avoidability Score would be a
    lower bound, and there is no honest way to put a lower bound in a box
    labelled with a percentage.
    """

    def __init__(self, status: str, backend: str) -> None:
        super().__init__(
            f"{backend} returned {status}; only OPTIMAL is a renderable result."
        )
        self.status = status
        self.backend = backend


class BackendNotPermittedError(ValueError):
    """The configured solver backend is not on the allow-list."""
