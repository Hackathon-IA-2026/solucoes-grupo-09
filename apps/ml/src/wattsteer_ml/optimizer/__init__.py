"""The flex optimizer: a curtailment profile and a fleet in, a dispatch out.

`docs/specs/flex-optimizer.md` is the decision authority and
`docs/research/optimizer-formulation.md` is the evidence it decides from. The
module split follows the spec's own seams:

* :mod:`.horizon` — the 24 local civil hours, derived from the IANA zone.
* :mod:`.fleet` — the `FlexibilityAsset` variants as the model sees them.
* :mod:`.backend` — which solver runs, and which are refused before they can.
* :mod:`.milp` — the model of the research's §2, built and solved.
* :mod:`.simulator` — the execution rule, and every KPI derived from it.

:mod:`.simulator` is deliberately separate from :mod:`.milp`: the objective
value carries a throughput penalty, is not a physical quantity, and must never
become a number on a screen. Every KPI is re-derived from physics against a
named realisation, by the one function the live path, Replay and the backtest
all import.
"""

from __future__ import annotations

from .backend import (
    LP_BACKENDS,
    MILP_BACKENDS,
    REFUSED_BACKENDS,
    Versions,
    configured_milp_backend,
    resolve_backend,
)
from .errors import BackendNotPermittedError, OptimizerBugError, SolverNotOptimalError
from .fleet import Availability, Battery, available_between, reference_battery
from .horizon import GRID_ZONE, HORIZON_HOURS, PERIOD_HOURS, Horizon, local_day
from .milp import (
    SHIPPED,
    BatteryDispatch,
    DispatchPlan,
    HourlyDispatch,
    ModelOptions,
    SolverReport,
    solve,
)
from .simulator import (
    TOLERANCE_MWH,
    ExecutedHour,
    Schedule,
    ScoredBand,
    ScoredRealisation,
    score_band,
    simulate,
)

__all__ = [
    "GRID_ZONE",
    "HORIZON_HOURS",
    "LP_BACKENDS",
    "MILP_BACKENDS",
    "PERIOD_HOURS",
    "REFUSED_BACKENDS",
    "SHIPPED",
    "TOLERANCE_MWH",
    "Availability",
    "BackendNotPermittedError",
    "Battery",
    "BatteryDispatch",
    "DispatchPlan",
    "ExecutedHour",
    "Horizon",
    "HourlyDispatch",
    "ModelOptions",
    "OptimizerBugError",
    "Schedule",
    "ScoredBand",
    "ScoredRealisation",
    "SolverNotOptimalError",
    "SolverReport",
    "Versions",
    "available_between",
    "configured_milp_backend",
    "local_day",
    "reference_battery",
    "resolve_backend",
    "score_band",
    "simulate",
    "solve",
]
