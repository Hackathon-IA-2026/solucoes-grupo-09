"""Which solver runs, and which are refused before they can run.

OR-Tools' `linear_solver` wrapper (`pywraplp`) reaches a dozen backends. Two of
them are permitted here, and two are refused by name rather than merely left off
the list, because both fail in ways a caller would never see:

* **`CBC` is refused at startup with a fatal error.** During the research it
  aborted the whole Python process — ``Check failed: … duplicate key`` in
  ``MPSolver::LookupVariableOrNull`` — on a duplicate variable name. In a worker
  that is a crash, not an exception. Its EPL-2.0 licence also adds obligation
  for zero benefit against SCIP and HiGHS, which are Apache-2.0 and MIT.
* **CP-SAT is not a configuration option at all.** It works over the integers,
  and the SOC balance with a fractional round-trip efficiency does not survive
  the trip: ``1000·soc[t] = 1000·soc[t−1] + 959·ch − 1043·dis`` is a
  *divisibility* constraint, not a balance. Measured, it returns ``OPTIMAL``
  over the mutilated feasible set with a dispatch worse by a factor of two —
  the failure is silent and the numbers still look like MWh.

`GLOP` is reachable only for the **LP relaxation**, which exists as a
cross-check in the test suite and is never the production path. It is a
separate allow-list so that no environment variable can put the shipped model
on a solver that cannot represent its binaries. `PDLP` is on neither list: the
research measured it getting steadily worse as the model grows (0.25 ms → 304 ms
where GLOP goes 0.25 → 4.6 ms), and OR-Tools' own advice is that it is for
problems where simplex hits memory limits.

The versions are read from the running library rather than hard-coded, so the
Apache-2.0 claim about SCIP ≥ 8.0.3 stays checkable from a response body.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import ortools
from ortools.linear_solver import pywraplp

from ..config import settings
from .errors import BackendNotPermittedError

#: Backends permitted for the shipped model, which has binaries.
MILP_BACKENDS: tuple[str, ...] = ("SCIP", "HIGHS")

#: Backends permitted for the LP relaxation of the same model. Test-only.
LP_BACKENDS: tuple[str, ...] = ("GLOP",)

#: Refused by name, with the reason, so a misconfiguration reads as a decision
#: someone already made rather than a typo in an allow-list.
REFUSED_BACKENDS: dict[str, str] = {
    "CBC": (
        "CBC aborts the whole process on a duplicate variable name, which in a "
        "worker is a crash and not an exception; and EPL-2.0 adds obligation "
        "for no benefit over SCIP (Apache-2.0) or HiGHS (MIT)."
    ),
    "SAT": (
        "CP-SAT works over the integers, where the state-of-charge balance "
        "becomes a divisibility constraint. It fails silently: OPTIMAL over a "
        "mutilated feasible set, with a dispatch worse by a factor of two."
    ),
}
REFUSED_BACKENDS["CP_SAT"] = REFUSED_BACKENDS["SAT"]
REFUSED_BACKENDS["CP-SAT"] = REFUSED_BACKENDS["SAT"]
REFUSED_BACKENDS["SAT_INTEGER_PROGRAMMING"] = REFUSED_BACKENDS["SAT"]
REFUSED_BACKENDS["CBC_MIXED_INTEGER_PROGRAMMING"] = REFUSED_BACKENDS["CBC"]

_VERSION = re.compile(r"(\d+(?:\.\d+)+)")


@dataclass(frozen=True)
class Versions:
    """What actually solved this, read at runtime."""

    ortools: str
    #: The backend's own banner, e.g. ``SCIP 10.0.0 [LP solver: SoPlex 8.0.0]``.
    backend: str
    #: The SCIP release parsed out of that banner; ``None`` on other backends.
    scip: str | None


def resolve_backend(name: str, *, integral: bool = True) -> str:
    """Normalise and check a configured backend id against the allow-list.

    ``integral=False`` selects the LP allow-list, which exists for the
    relaxation cross-check only.
    """
    wanted = name.strip().upper()
    if wanted in REFUSED_BACKENDS:
        raise BackendNotPermittedError(f"{wanted} is refused: {REFUSED_BACKENDS[wanted]}")
    permitted = MILP_BACKENDS if integral else LP_BACKENDS
    if wanted not in permitted:
        raise BackendNotPermittedError(
            f"{wanted} is not a permitted backend; choose one of {', '.join(permitted)}."
        )
    return wanted


def configured_milp_backend() -> str:
    """The deployment's MILP backend, refusing to resolve if it is not allowed.

    Called once at startup so a `CBC`-configured deploy dies at boot with the
    reason, rather than on whichever request first reaches the solver.
    """
    return resolve_backend(settings.milp_backend, integral=True)


def create_solver(backend: str) -> pywraplp.Solver:
    """An `MPSolver` on an already-resolved backend id."""
    solver = pywraplp.Solver.CreateSolver(backend)
    if solver is None:
        raise BackendNotPermittedError(
            f"{backend} is on the allow-list but this OR-Tools build does not ship it."
        )
    return solver


def versions(solver: pywraplp.Solver) -> Versions:
    """Library versions, from the running process and the live solver."""
    banner = str(solver.SolverVersion())
    scip: str | None = None
    if banner.upper().startswith("SCIP"):
        found = _VERSION.search(banner)
        scip = found.group(1) if found else None
    return Versions(ortools=str(ortools.__version__), backend=banner, scip=scip)
