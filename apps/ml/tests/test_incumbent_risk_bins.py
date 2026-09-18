"""The incumbent edges handed to the rule are edges, not the decision about them.

Every weekly retrain of a lane with a promoted artifact died here:

    AttributeError: 'RiskBinDecision' object has no attribute 'classify'

`calibration.risk_bins` is a `RiskBinDecision` — the edges *plus* whether they
moved, why, the incumbent they were held against, and the check that decided it.
`derive_risk_bins` takes the edges. `_incumbent_risk_bins` returned the whole
decision, and it type-checked only because the function was annotated `Any`.

Nothing caught it because nothing tested that function: the integration around
it needs a promoted artifact on a volume, so the defect only ever appeared at
03:10 on a Friday. These are the assertions that do not need one.
"""

from __future__ import annotations

import inspect

import pytest

from out_of_fold_fixtures import pool_of
from wattsteer_ml import retrain
from wattsteer_ml.training.calibration import (
    OutOfFoldPrediction,
    RiskBinDecision,
    RiskBins,
    derive_risk_bins,
)


def _calibrated() -> list[OutOfFoldPrediction]:
    """A pool the rule can split: calibrated, and spread across the grid.

    Twenty probability levels, sixty rows each, with exactly `round(p × 60)` of
    them above the threshold — so a bucket's observed frequency tracks its mean
    prediction and condition (a) holds wherever the edges fall.
    """
    rows: list[tuple[float, bool]] = []
    for level in range(20):
        probability = round((level * 5 + 2.5) / 100.0, 4)
        positives = round(probability * 60)
        rows.extend((probability, index < positives) for index in range(60))
    return list(pool_of(rows).predictions)


def test_the_helper_is_annotated_with_the_type_the_rule_accepts() -> None:
    # `Any` is what let the wrong object through, so the annotation is half the
    # fix and this is the half of the guard that costs nothing to run.
    annotation = inspect.signature(retrain._incumbent_risk_bins).return_annotation
    assert "RiskBins" in str(annotation)
    assert "Any" not in str(annotation)


def test_the_rule_accepts_what_the_helper_returns() -> None:
    incumbent = RiskBins.from_edges(0.25, 0.60)
    decision = derive_risk_bins(_calibrated(), incumbent=incumbent)
    assert isinstance(decision, RiskBinDecision)
    assert isinstance(decision.bins, RiskBins)
    # `.bins` is what the helper now hands back, and it round-trips.
    assert isinstance(
        derive_risk_bins(_calibrated(), incumbent=decision.bins), RiskBinDecision
    )


def test_the_rule_refuses_the_decision_it_used_to_be_handed() -> None:
    """The exact shape production died on, asserted so it cannot come back.

    A `RiskBinDecision` has no `classify`, so `_check` raises the moment it
    tries to bucket the first prediction. Asserted on the error rather than on
    the type: the type is what was wrong, and a test that only restates the
    annotation proves nothing about the call.
    """
    decision = derive_risk_bins(_calibrated(), incumbent=RiskBins.from_edges(0.25, 0.60))
    with pytest.raises(AttributeError, match="classify"):
        derive_risk_bins(_calibrated(), incumbent=decision)  # type: ignore[arg-type]
