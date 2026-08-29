"""The allow-list, and the two backends refused by name rather than omitted.

Both refusals defend against a *silent* failure, which is why they are tested
rather than trusted: `CBC` aborts the whole process, and CP-SAT returns
`OPTIMAL` over a feasible set the integers mutilated.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from wattsteer_ml.app import app
from wattsteer_ml.optimizer import (
    LP_BACKENDS,
    MILP_BACKENDS,
    BackendNotPermittedError,
    configured_milp_backend,
    resolve_backend,
)
from wattsteer_ml.optimizer.backend import create_solver, versions


def test_scip_is_the_default_and_highs_is_permitted() -> None:
    assert MILP_BACKENDS == ("SCIP", "HIGHS")
    assert configured_milp_backend() == "SCIP"


@pytest.mark.parametrize("spelling", ["scip", " ScIp ", "HIGHS", "highs"])
def test_the_allow_list_is_case_and_whitespace_insensitive(spelling: str) -> None:
    assert resolve_backend(spelling) in MILP_BACKENDS


def test_cbc_is_refused_with_the_reason_and_not_merely_omitted() -> None:
    """It aborted the whole Python process on a duplicate variable name.

    In a worker that is a crash and not an exception, so the refusal has to
    happen while resolving configuration — before any model exists.
    """
    with pytest.raises(BackendNotPermittedError, match="aborts the whole process"):
        resolve_backend("CBC")


def test_cbc_fails_at_startup_rather_than_on_the_first_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("wattsteer_ml.optimizer.backend.settings.milp_backend", "CBC")
    with pytest.raises(BackendNotPermittedError):
        configured_milp_backend()


def test_a_cbc_configured_deploy_does_not_come_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The refusal is wired into the lifespan, so the process dies at boot.

    Not on the first request that reaches the solver: by then the worker is
    serving traffic it will abort in the middle of.
    """
    monkeypatch.setattr("wattsteer_ml.optimizer.backend.settings.milp_backend", "CBC")
    with pytest.raises(BackendNotPermittedError), TestClient(app):
        pass  # pragma: no cover — the context manager raises on entry


def test_the_service_comes_up_on_a_permitted_backend() -> None:
    with TestClient(app) as booted:
        assert booted.get("/health").status_code == 200


@pytest.mark.parametrize(
    "spelling", ["SAT", "CP_SAT", "cp-sat", "sat_integer_programming"]
)
def test_cp_sat_is_not_a_configuration_option_at_all(spelling: str) -> None:
    """Not "slower" or "worse" — structurally wrong, and wrong quietly.

    The state-of-charge balance over the integers is a divisibility constraint;
    the solver then proves optimality over a mutilated feasible set and returns
    a dispatch worse by a factor of two, with the status still reading OPTIMAL.
    """
    with pytest.raises(BackendNotPermittedError, match="divisibility"):
        resolve_backend(spelling)


@pytest.mark.parametrize("spelling", ["GLOP", "CLP", "PDLP", "GUROBI", "", "SCIPP"])
def test_a_backend_that_cannot_hold_the_binaries_is_not_a_milp_backend(
    spelling: str,
) -> None:
    with pytest.raises(BackendNotPermittedError):
        resolve_backend(spelling, integral=True)


def test_the_lp_allow_list_is_separate_so_no_env_var_can_reach_it() -> None:
    """The relaxation is a cross-check in tests, never the production path."""
    assert LP_BACKENDS == ("GLOP",)
    assert resolve_backend("GLOP", integral=False) == "GLOP"
    # PDLP got steadily worse as the model grew in the research's measurements.
    with pytest.raises(BackendNotPermittedError):
        resolve_backend("PDLP", integral=False)
    with pytest.raises(BackendNotPermittedError):
        resolve_backend("SCIP", integral=False)


def test_the_versions_are_read_at_runtime_and_not_hard_coded() -> None:
    """The Apache-2.0 claim about SCIP >= 8.0.3 has to stay checkable."""
    found = versions(create_solver("SCIP"))
    assert found.ortools[0].isdigit()
    assert found.backend.upper().startswith("SCIP")
    assert found.scip is not None
    major = int(found.scip.split(".")[0])
    assert major >= 8, "SCIP below 8.0.3 is under the old academic licence"


def test_a_non_scip_backend_reports_no_scip_version() -> None:
    assert versions(create_solver("GLOP")).scip is None
