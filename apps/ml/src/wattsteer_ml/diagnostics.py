"""Plumbing shared by the read-only diagnostic drivers, and only by them.

`p50_bias_run` and `p10_calibration_run` both fit `train_fold` on early folds
whose pool is too small for the risk-class rule to find edges
(`RiskBinsUndeterminedError`), which is correct behaviour for a retrain: a
class edge nobody measured is not a fallback. Neither diagnostic's rail reads
the edges — the P50 rail counts crossings of a served median, the P10 rail
counts crossings of a served floor, and both are computed straight off the
composed band — so refusing to fit those folds at all would just make the
diagnostic blind on them.

`tolerating_undetermined_risk_bins` is the patch that lets a diagnostic go on
anyway, scoped to the `with` block and restored in a `finally`. Nothing in the
retrain path imports it, and it was one module's private helper before the
second diagnostic needed the same thing — two copies of a monkeypatch that
must stay in sync with `RiskBinDecision`'s shape is exactly the drift this
repository's conventions warn about, so it moved here instead.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from wattsteer_ml.training import calibration as calibration_module
from wattsteer_ml.training.calibration import (
    RiskBinDecision,
    RiskBins,
    RiskBinsUndeterminedError,
)

#: Edges used only when the real rule finds none and the caller asked to go on.
#: Arbitrary on purpose: neither diagnostic reads a risk class, and a report
#: field says every time that these were used in place of a measured edge.
PLACEHOLDER_RISK_BINS = RiskBins.from_edges(0.3, 0.7)


@contextmanager
def tolerating_undetermined_risk_bins(enabled: bool) -> Iterator[list[str]]:
    """Let ``train_fold`` finish on a pool the risk-class rule cannot split.

    ``calibrate`` derives the three named risk classes from the pooled
    out-of-fold predictions and **refuses** when no split satisfies the rule,
    which is the right behaviour for a retrain. On the earliest reportable
    folds it refuses, so a diagnostic driver that goes through the same fit
    could not score them and could not say whether a bias is a property of the
    model or of the live edge alone.

    When ``enabled``, the derivation is wrapped for the ``with`` block to
    return a placeholder decision and to record the refusal it swallowed;
    ``enabled=False`` passes the real refusal straight through, which is what
    a retrain must see. The patch is restored in a ``finally`` regardless.
    """
    swallowed: list[str] = []
    if not enabled:
        yield swallowed
        return
    original = calibration_module.derive_risk_bins

    def tolerant(predictions: Any, **kwargs: Any) -> RiskBinDecision:
        try:
            return original(predictions, **kwargs)
        except RiskBinsUndeterminedError as undetermined:
            swallowed.append(str(undetermined))
            return RiskBinDecision(
                bins=PLACEHOLDER_RISK_BINS,
                changed=False,
                reason=("diagnostic placeholder: the rule found no edges on this pool"),
                incumbent=None,
                check=calibration_module._check(predictions, PLACEHOLDER_RISK_BINS),
            )

    calibration_module.derive_risk_bins = tolerant
    try:
        yield swallowed
    finally:
        calibration_module.derive_risk_bins = original


__all__ = ["PLACEHOLDER_RISK_BINS", "tolerating_undetermined_risk_bins"]
