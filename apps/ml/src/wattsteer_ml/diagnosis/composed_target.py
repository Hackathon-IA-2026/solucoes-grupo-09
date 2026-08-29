"""``g`` for a fitted bundle — the forecaster's composition, and no second copy.

`docs/specs/diagnosis.md`: "``g`` is evaluated by **importing the forecaster's
own composition function**, not by re-implementing the product. The explained
quantity and the served quantity cannot be allowed to drift apart."

So this module is an adapter and deliberately nothing more. It turns a
:class:`~wattsteer_ml.training.HurdleBundle` into the
:class:`~wattsteer_ml.diagnosis.attribution.ComposedExpectation` the attribution
calls, by encoding the constructed coalition rows as a
:class:`~wattsteer_ml.training.FeatureBlock` and handing them to
:func:`wattsteer_ml.training.expected_mwh_for_block` — which reaches
:func:`wattsteer_ml.mixture.compose` by the same three lines every served
forecast does. There is no arithmetic here: no probability is multiplied by a
magnitude in this file, and a test says so by reading it.

**Why the key travels with the matrix.** ``μ_sub(subsystem, local_hour)`` is a
term of the composition and is looked up from the row's key, so ``g`` is not a
function of the feature vector alone. Stamping every constructed row with the
*target's* key is truthful precisely because the background is matched: every
row in ``B(s, h)`` already carries that subsystem and that local hour, so
``x[S] ⊕ b[S̄]`` does too, whichever side of the split those two columns landed
on. This is the sense in which the spec's "``subsystem`` and
``calendar_local_hour`` are neutralised by construction" is a property of the
sampler rather than of a ``φ``.
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.training import FeatureBlock, HurdleBundle, expected_mwh_for_block


def bundle_expectation(bundle: HurdleBundle) -> _BundleExpectation:
    """``g`` for this bundle, ready to be handed to the attribution."""
    return _BundleExpectation(bundle)


class _BundleExpectation:
    """A callable ``(key, matrix) → E[Y | x]``, one entry per row.

    A class rather than a closure so that the bundle it is bound to is
    inspectable, and so the attribution's protocol is satisfied by a named type
    rather than by a lambda whose provenance a traceback would not show.
    """

    def __init__(self, bundle: HurdleBundle) -> None:
        self._bundle = bundle

    @property
    def bundle(self) -> HurdleBundle:
        return self._bundle

    def __call__(
        self, key: RowKey, matrix: npt.NDArray[np.float64]
    ) -> npt.NDArray[np.float64]:
        rows = matrix.shape[0]
        unlabelled = np.full(rows, np.nan, dtype=np.float64)
        block = FeatureBlock(
            contract=self._bundle.contract,
            keys=(key,) * rows,
            matrix=np.asarray(matrix, dtype=np.float64),
            # The coalition rows carry no label and are not meant to: they are
            # counterfactual vectors, not hours that happened.
            total_mwh=unlabelled,
            wind_mwh=unlabelled,
            has_curtailment=unlabelled,
            threshold_mw=self._bundle.threshold_mw,
        )
        return np.asarray(expected_mwh_for_block(self._bundle, block), dtype=np.float64)
