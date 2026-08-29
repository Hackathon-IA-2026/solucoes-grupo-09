"""Feature rows → a matrix, with nothing imputed and nothing recomputed.

Two rules from `docs/specs/forecaster.md` decide everything in this module.

**"No imputation is performed at any point in the served path."** A NULL here
becomes ``NaN`` and stays one: LightGBM routes missing values down their own
branch, and the feature spec makes unavailability *meaningful* — "a lag that
does not clear `actuals_cutoff` is NULL precisely because it was not knowable".
A median fill would replace that signal with a plausible number and the model
would never know the difference. There is therefore no fill value in this file,
not even behind a flag, and :mod:`tests.test_design_matrix` asserts it against
the module's own source.

**The labels are read, never re-derived.** ``y_has_curtailment`` and
``y_magnitude_mwh`` are columns of `feature_row`, computed inside the feature
function from the ``threshold_mw`` argument it was given. Recomputing
``total > τ`` on this side would be a second place the threshold is applied, and
`docs/domain-model.md` §8.3 is precise that a magnitude and the threshold that
produced it travel together. So the threshold is *read off the rows* and checked
for agreement; it is never taken from :mod:`wattsteer_ml.constants` here.

The row's identity — ``(target_date, local_hour, subsystem)`` — comes from
:class:`~wattsteer_ml.evaluation.RowKey`, which already owns the one correct
derivation of a Brazilian local hour from a UTC instant.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

import numpy as np
import numpy.typing as npt

from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.lanes import Lane
from wattsteer_ml.training.contract import (
    FeatureContract,
    FeatureContractError,
    feature_column_names,
)

#: Columns this module reads off a row besides the features themselves.
TOTAL_COLUMN = "y_constrained_off_total_mwh"
WIND_COLUMN = "y_constrained_off_wind_mwh"
HAS_CURTAILMENT_COLUMN = "y_has_curtailment"
MAGNITUDE_COLUMN = "y_magnitude_mwh"


class DesignError(ValueError):
    """The rows cannot be turned into the matrix the contract describes."""


@dataclass(frozen=True)
class RowStamp:
    """What a set of feature rows agrees about itself.

    A lane is a triple and a training call must produce exactly one; rows that
    disagree are two lanes' rows in one list, which is the accident that would
    otherwise train a model whose card names one gate and whose data is another.
    """

    lane: Lane
    #: ``curtailment_threshold_mw`` as the rows carry it. ``τ = threshold × 1 h``.
    threshold_mw: float
    first_target_date: date
    last_target_date: date

    @classmethod
    def of(cls, rows: Sequence[Mapping[str, Any]]) -> RowStamp:
        if not rows:
            raise DesignError("no feature rows to stamp")
        stamps = {
            (row["feature_set"], row["gate_profile"], float(row["threshold_mw"]))
            for row in rows
        }
        if len(stamps) != 1:
            raise DesignError(
                f"feature rows from {len(stamps)} lanes were passed together: "
                f"{sorted(stamps)!r}"
            )
        feature_set, gate_profile, threshold_mw = stamps.pop()
        dates = [row["target_date"] for row in rows]
        return cls(
            lane=Lane(
                feature_set=feature_set,
                gate_profile=gate_profile,
                threshold_mw=threshold_mw,
            ),
            threshold_mw=threshold_mw,
            first_target_date=min(dates),
            last_target_date=max(dates),
        )


@dataclass(frozen=True)
class FeatureBlock:
    """One block of rows as the boosters see it: a matrix, keys and labels.

    Frozen and produced whole. Slicing goes through :meth:`select`, which
    carries the contract and the keys along, so a subset of rows cannot end up
    described by a different feature list than the one it was encoded under.
    """

    contract: FeatureContract
    keys: tuple[RowKey, ...]
    #: ``n × k`` float64, ``NaN`` wherever the database returned NULL.
    matrix: npt.NDArray[np.float64]
    #: ``y_constrained_off_total_mwh``. ``NaN`` where the row is unlabelled —
    #: the label block returned nothing for that (subsystem, hour) at all.
    total_mwh: npt.NDArray[np.float64]
    #: ``y_constrained_off_wind_mwh``, for the share regressor's target.
    wind_mwh: npt.NDArray[np.float64]
    #: ``y_has_curtailment`` as read: 1, 0 or ``NaN`` for unlabelled.
    has_curtailment: npt.NDArray[np.float64]
    threshold_mw: float

    def __post_init__(self) -> None:
        rows = len(self.keys)
        expected = (rows, len(self.contract.columns))
        if self.matrix.shape != expected:
            raise DesignError(
                f"the design matrix is {self.matrix.shape} but the contract and "
                f"keys say {expected}"
            )
        for name in ("total_mwh", "wind_mwh", "has_curtailment"):
            vector: npt.NDArray[np.float64] = getattr(self, name)
            if vector.shape != (rows,):
                raise DesignError(f"{name} is {vector.shape} for {rows} rows")

    def __len__(self) -> int:
        return len(self.keys)

    @property
    def labelled(self) -> npt.NDArray[np.bool_]:
        """Rows the settled label block had an answer for."""
        return ~np.isnan(self.total_mwh)

    @property
    def positive(self) -> npt.NDArray[np.bool_]:
        """Rows above ``τ``, as the feature function itself decided."""
        return np.asarray(self.has_curtailment == 1.0, dtype=np.bool_)

    def select(self, mask: npt.NDArray[np.bool_]) -> FeatureBlock:
        """The sub-block ``mask`` picks out, contract and keys intact."""
        if mask.shape != (len(self.keys),):
            raise DesignError(f"a mask of {mask.shape} does not select {len(self)} rows")
        chosen = tuple(
            key for key, keep in zip(self.keys, mask.tolist(), strict=True) if keep
        )
        return FeatureBlock(
            contract=self.contract,
            keys=chosen,
            matrix=self.matrix[mask],
            total_mwh=self.total_mwh[mask],
            wind_mwh=self.wind_mwh[mask],
            has_curtailment=self.has_curtailment[mask],
            threshold_mw=self.threshold_mw,
        )

    @classmethod
    def of(
        cls,
        rows: Sequence[Mapping[str, Any]],
        contract: FeatureContract,
        *,
        threshold_mw: float,
    ) -> FeatureBlock:
        """Encode rows against a contract that already exists.

        The contract is an argument rather than a derivation because serving and
        scoring must encode against the *bundle's* contract, not against
        whatever today's rows happen to look like. A row whose feature columns
        differ from the contract's is refused here, which is the cheap local
        version of the gate's third check.
        """
        names = contract.feature_names
        matrix = np.full((len(rows), len(names)), np.nan, dtype=np.float64)
        levels = {
            column.name: {
                level: float(index) for index, level in enumerate(column.levels)
            }
            for column in contract.columns
            if column.levels
        }
        for position, row in enumerate(rows):
            if feature_column_names(row) != names:
                raise FeatureContractError(
                    f"row {position} carries {feature_column_names(row)!r}, but the "
                    f"contract is {names!r}"
                )
            for index, name in enumerate(names):
                matrix[position, index] = _encode(name, row[name], levels.get(name))
        return cls(
            contract=contract,
            keys=tuple(RowKey.from_feature_row(row) for row in rows),
            matrix=matrix,
            total_mwh=_column_vector(rows, TOTAL_COLUMN),
            wind_mwh=_column_vector(rows, WIND_COLUMN),
            has_curtailment=_column_vector(rows, HAS_CURTAILMENT_COLUMN),
            threshold_mw=threshold_mw,
        )


def _encode(name: str, value: Any, levels: Mapping[str, float] | None) -> float:
    """One cell. NULL stays NULL; there is no other outcome for an absence."""
    if value is None:
        return math.nan
    if levels is not None:
        try:
            return levels[str(value)]
        except KeyError:
            raise DesignError(
                f"{value!r} is not one of {name}'s levels {sorted(levels)!r}; a "
                "categorical the contract has never seen is an error, not a new "
                "category — the encoding would differ between fit and serve"
            ) from None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, int | float):
        return float(value)
    raise DesignError(f"feature {name!r} carries {type(value).__name__}")


def _column_vector(
    rows: Sequence[Mapping[str, Any]], column: str
) -> npt.NDArray[np.float64]:
    """A label column as float64, ``NaN`` where the database said NULL."""
    vector = np.full(len(rows), np.nan, dtype=np.float64)
    for index, row in enumerate(rows):
        value = row.get(column)
        if value is None:
            continue
        vector[index] = 1.0 if value is True else 0.0 if value is False else float(value)
    return vector
