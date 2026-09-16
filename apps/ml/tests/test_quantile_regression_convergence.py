"""Rung 2 does not take an unconverged iterate as its baseline.

``_quantile_regression`` has always documented a fallback: when the IRLS does
not converge, use least squares rather than compose a band nobody can read. The
fallback was reachable only from an exception or a non-finite coefficient —
and ``statsmodels`` signals *neither* of its actual failures that way.

The iteration cap and a detected convergence cycle are both raised with
``warnings.warn`` and nothing else: no exception, no flag on the result, and
finite coefficients read off whatever the last iterate happened to be. So for
the case that actually occurs, the documented fallback never fired. The real
suite had been printing ``IterationLimitWarning: Maximum number of iterations
(1000) reached`` from ``tests/test_baseline_ladder.py`` and
``tests/test_shuffled_label_control.py`` throughout a run that reported 1,817
passes.

That matters because rung 2 is a **baseline a candidate model is scored against
before promotion**. "Whatever the solver held at iteration 1000" is not a number
a promotion decision may quietly stand on.

The fake below is deliberate rather than a contrived design that happens not to
converge: the property under test is "the warning is what we act on", and a
fixture tuned until statsmodels gives up would be testing statsmodels' solver
instead, and would drift the first time it changed.
"""

from __future__ import annotations

import warnings
from typing import Any

import numpy as np
import pytest
from statsmodels.tools.sm_exceptions import ConvergenceWarning, IterationLimitWarning

from wattsteer_ml.evaluation import ladder

# A design with an exact least-squares answer, so the fallback is identifiable.
EXOGENOUS = np.array([[1.0, 0.0], [1.0, 1.0], [1.0, 2.0], [1.0, 3.0]])
ENDOGENOUS = np.array([1.0, 3.0, 5.0, 7.0])
# Nothing a fit of the rows above would ever return.
SENTINEL = np.array([99.0, -99.0])


class _Warns:
    """A ``QuantReg`` stand-in that converges badly and says so only in a warning."""

    def __init__(self, category: type[Warning], message: str) -> None:
        self._category = category
        self._message = message

    def __call__(self, endogenous: Any, exogenous: Any) -> _Warns:
        return self

    def fit(self, q: float) -> Any:
        warnings.warn(self._message, self._category, stacklevel=2)
        return type("Result", (), {"params": SENTINEL})()


def _expected_least_squares() -> np.ndarray:
    solution, *_ = np.linalg.lstsq(EXOGENOUS, ENDOGENOUS, rcond=None)
    return np.asarray(solution, dtype=np.float64).reshape(-1)


@pytest.mark.parametrize(
    "category",
    [IterationLimitWarning, ConvergenceWarning],
    ids=["iteration-limit", "convergence-cycle"],
)
def test_a_warned_non_convergence_falls_back_to_least_squares(
    monkeypatch: pytest.MonkeyPatch, category: type[Warning]
) -> None:
    monkeypatch.setattr(ladder.sm, "QuantReg", _Warns(category, "did not converge"))
    parameters = ladder._quantile_regression(EXOGENOUS, ENDOGENOUS, 0.1)
    # Non-vacuity: the fake's own answer is finite and would have been returned
    # by the previous implementation, which checked only for exceptions and NaN.
    assert np.all(np.isfinite(SENTINEL))
    assert not np.allclose(parameters, SENTINEL)
    assert np.allclose(parameters, _expected_least_squares())


def test_a_converged_fit_is_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    """The fallback must not fire on every fit — only on a warned one."""

    class _Quiet:
        def __call__(self, endogenous: Any, exogenous: Any) -> _Quiet:
            return self

        def fit(self, q: float) -> Any:
            return type("Result", (), {"params": SENTINEL})()

    monkeypatch.setattr(ladder.sm, "QuantReg", _Quiet())
    parameters = ladder._quantile_regression(EXOGENOUS, ENDOGENOUS, 0.1)
    assert np.allclose(parameters, SENTINEL)


def test_an_unrelated_warning_is_not_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Catching two categories must not silence a third.

    The fit runs inside ``catch_warnings(record=True)``, which captures
    everything raised under it. A warning this function does not act on has to
    come back out, or a future deprecation from ``statsmodels`` disappears here.
    """
    monkeypatch.setattr(
        ladder.sm, "QuantReg", _Warns(DeprecationWarning, "something else entirely")
    )
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        parameters = ladder._quantile_regression(EXOGENOUS, ENDOGENOUS, 0.1)
    assert [w.category for w in caught] == [DeprecationWarning]
    # And an unrelated warning is not a non-convergence, so the fit stands.
    assert np.allclose(parameters, SENTINEL)
