"""The matched background — what "typical" means, and why it cannot leak.

`docs/specs/diagnosis.md` seam 5. The attribution's value function replaces a
group of features with a *typical* one and asks what the composed expectation
does. "Typical" is only a statement if the rows it averages over are comparable
to the target, so the background is **matched**: every row drawn for a target at
``(subsystem s, local hour h)`` is itself a row at ``(s, h)``.

**Why the matching is the whole file.** ``μ_sub(subsystem, local_hour)`` is a
cell constant of the composition, and ``subsystem`` and ``calendar_local_hour``
are model inputs. A background that mixed hour 03 into hour 14's reference would
move the composed expectation for a reason that has nothing to do with the
group being replaced, and every number on the screen would still look plausible.
That is the failure this module is shaped to make unreachable.

**Matching is enforced by construction, in three places, and none of them is a
check run afterwards:**

1. :func:`draw_matched_background` **partitions before it draws.** Rows are
   bucketed by their own :class:`~wattsteer_ml.evaluation.RowKey`, and the
   sampler indexes into one bucket's positions. There is no code path here that
   samples from the pooled row set, so there is nothing for a seed, an off-by-one
   or a reshape to leak across.
2. :class:`BackgroundCell` **cannot hold a foreign row.** Its constructor
   refuses a key whose subsystem or local hour is not the cell's, so an
   unmatched cell does not exist as a value and no consumer has to re-check one.
3. :class:`MatchedBackground` is **addressed by cell and has no pooled matrix**.
   The only way to obtain rows is :meth:`MatchedBackground.cell`, which takes the
   coordinates and raises for a cell it does not hold. The attribution derives
   those coordinates from the target's own key, so a caller cannot hand the
   game a background for some other hour.

**Drawn once, with a stamped seed.** The spec puts ``B(s, h)`` in the artifact
bundle — 128 rows per cell, drawn once from the base-fit block — precisely so
that the attribution is reproducible from the artifact alone and is not a
function of when it ran. Until the forecaster's bundle carries one, this module
draws the same shape from a block, stamping the seed and the row count it used
onto the value; :attr:`MatchedBackground.source` records which of the two it is.
Nothing in the attribution module draws a background, and a structural test says
so.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType

import numpy as np
import numpy.typing as npt

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.training import FeatureBlock

#: ``|B(s, h)|`` — the rows per cell `docs/specs/diagnosis.md` names, and the
#: number the artifact's own sample is drawn at. 128 × 96 cells = 12,288 rows.
BACKGROUND_ROWS_PER_CELL = 128

#: What :attr:`MatchedBackground.source` says when the sample came out of the
#: artifact bundle, and what it says when it was drawn here from a block.
ARTIFACT_SOURCE = "artifact"
BASE_FIT_SOURCE = "base_fit"


class BackgroundError(ValueError):
    """The background is not a matched one. Raised at draw, never at attribution."""


class MissingBackgroundCellError(BackgroundError):
    """No background for this ``(subsystem, local_hour)``.

    A failure and never a fallback. Falling back to a neighbouring hour, or to
    the pooled rows, would silently redefine "typical" for that cell, and the
    attribution would still return eight plausible numbers.
    """

    def __init__(self, subsystem: Subsystem, local_hour: int) -> None:
        super().__init__(
            f"the background holds no cell for ({subsystem!r}, hour "
            f"{local_hour:02d}); a matched background is drawn per cell and "
            "there is no pooled sample to fall back to"
        )
        self.subsystem = subsystem
        self.local_hour = local_hour


@dataclass(frozen=True)
class CellKey:
    """A background cell's coordinates — the two things the sample is matched on."""

    subsystem: Subsystem
    local_hour: int

    def __post_init__(self) -> None:
        if self.subsystem not in SUBSYSTEM_CODES:
            raise BackgroundError(f"{self.subsystem!r} is not a subsystem")
        if not 0 <= self.local_hour < HOURS_PER_DAY:
            raise BackgroundError(
                f"local hour {self.local_hour!r} is outside the {HOURS_PER_DAY}-hour day"
            )

    @classmethod
    def of(cls, key: RowKey) -> CellKey:
        """The cell a scored row belongs to. The only way a row is bucketed."""
        return cls(subsystem=key.subsystem, local_hour=key.local_hour)


@dataclass(frozen=True)
class BackgroundCell:
    """``B(s, h)`` — the rows one target's coalitions are built against.

    The constructor is where the matching stops being an intention: a row whose
    key is not this cell's is refused, so there is no such thing as a cell that
    leaked. :attr:`keys` is kept beside :attr:`matrix` for exactly that reason —
    a bare matrix could not be checked against anything.
    """

    subsystem: Subsystem
    local_hour: int
    #: The drawn rows' identities, in matrix order.
    keys: tuple[RowKey, ...]
    #: ``|B| × k`` float64, encoded against the same contract as the target.
    matrix: npt.NDArray[np.float64]

    def __post_init__(self) -> None:
        if self.matrix.ndim != 2:
            raise BackgroundError(
                f"a background cell is a row block, got shape {self.matrix.shape}"
            )
        if self.matrix.shape[0] != len(self.keys):
            raise BackgroundError(
                f"the cell holds {self.matrix.shape[0]} rows and {len(self.keys)} keys"
            )
        if not self.keys:
            raise BackgroundError(
                f"({self.subsystem!r}, hour {self.local_hour:02d}) drew no rows; an "
                "empty cell has no typical hour to be typical of"
            )
        for key in self.keys:
            if key.subsystem != self.subsystem or key.local_hour != self.local_hour:
                raise BackgroundError(
                    f"({key.subsystem!r}, hour {key.local_hour:02d}) was drawn into "
                    f"the ({self.subsystem!r}, hour {self.local_hour:02d}) cell; a "
                    "background row shares its target's subsystem and local hour"
                )

    def __len__(self) -> int:
        return len(self.keys)

    @property
    def cell_key(self) -> CellKey:
        return CellKey(subsystem=self.subsystem, local_hour=self.local_hour)

    def holds(self, key: RowKey) -> bool:
        """Whether a target row belongs to this cell.

        Used by the attribution to say *which* cell it evaluated against, not to
        decide whether the cell is usable — an unusable cell cannot be built.
        """
        return key.subsystem == self.subsystem and key.local_hour == self.local_hour


@dataclass(frozen=True)
class MatchedBackground:
    """Every cell's sample, addressed by cell and by nothing else.

    There is deliberately no ``matrix`` on this type and no iteration order over
    rows. The pooled rows are not a quantity this design has any use for, and
    the cheapest way to keep the sampler honest is to give the leak nowhere to
    come from.
    """

    #: The contract's ordered feature names the matrix columns are encoded under.
    #: Carried so the attribution can refuse a background drawn under a
    #: different feature list rather than silently attributing the wrong columns.
    feature_names: tuple[str, ...]
    #: The rows each cell was drawn at.
    rows_per_cell: int
    #: The seed the draw was stamped with. Part of what makes an attribution
    #: reproducible from the artifact alone.
    seed: int
    #: :data:`ARTIFACT_SOURCE` or :data:`BASE_FIT_SOURCE`.
    source: str
    cells: Mapping[CellKey, BackgroundCell] = field(repr=False)

    def __post_init__(self) -> None:
        if not self.feature_names:
            raise BackgroundError("a background encoded under no features is not one")
        if self.rows_per_cell <= 0:
            raise BackgroundError(
                f"rows_per_cell is {self.rows_per_cell!r}; a background is rows"
            )
        if not self.cells:
            raise BackgroundError("a background with no cells has no typical hour")
        width = len(self.feature_names)
        for cell_key, cell in self.cells.items():
            if cell.cell_key != cell_key:
                raise BackgroundError(
                    f"the cell filed under {cell_key!r} is {cell.cell_key!r}"
                )
            if cell.matrix.shape[1] != width:
                raise BackgroundError(
                    f"cell {cell_key!r} is {cell.matrix.shape[1]} columns wide and "
                    f"the contract names {width}"
                )
            if len(cell) != self.rows_per_cell:
                raise BackgroundError(
                    f"cell {cell_key!r} holds {len(cell)} rows and the sample was "
                    f"drawn at {self.rows_per_cell}; an uneven background weights "
                    "some hours' typical more than others"
                )
        object.__setattr__(self, "cells", MappingProxyType(dict(self.cells)))

    def cell(self, subsystem: Subsystem, local_hour: int) -> BackgroundCell:
        """The one cell a target at these coordinates is compared against."""
        cell_key = CellKey(subsystem=subsystem, local_hour=local_hour)
        try:
            return self.cells[cell_key]
        except KeyError:
            raise MissingBackgroundCellError(subsystem, local_hour) from None

    def cell_for(self, key: RowKey) -> BackgroundCell:
        """The cell of a scored row, derived from the row's own key.

        The attribution's only entry point into this type. It takes the target's
        key rather than a cell so that the pairing of target and background is
        made here, from the target's identity, and is not something a call site
        can get wrong.
        """
        return self.cell(key.subsystem, key.local_hour)

    def card_fields(self) -> dict[str, str]:
        """What the model card records about the sample the attribution used."""
        return {
            "background_rows_per_cell": str(self.rows_per_cell),
            "background_seed": str(self.seed),
            "background_source": self.source,
            "background_cells": str(len(self.cells)),
        }


def draw_matched_background(
    block: FeatureBlock,
    *,
    seed: int,
    rows_per_cell: int = BACKGROUND_ROWS_PER_CELL,
    source: str = BASE_FIT_SOURCE,
) -> MatchedBackground:
    """Draw ``B(s, h)`` for every cell the block covers — partitioned, then sampled.

    The order of those two verbs is the design. Rows are bucketed by their own
    key first, and the draw happens inside a bucket, so the sampler has no
    access to a row from another cell at the moment it chooses. The alternative
    — sample, then filter, or sample and check — leaves a window in which a
    wrong row exists, and the checks that close it are the ones a later
    optimisation removes.

    Each cell's generator is seeded from ``(seed, subsystem, local_hour)``, so a
    cell's sample depends on the stamped seed and on its own coordinates and not
    on how many cells were drawn before it or in what order.

    Args:
        block: the base-fit block, encoded against the artifact's contract.
        seed: the stamped seed, recorded on the result.
        rows_per_cell: ``|B|``. Defaults to the spec's 128.
        source: what to record about where the sample came from.

    Raises:
        BackgroundError: if any cell the block covers has fewer rows than
            ``rows_per_cell``. Drawing a short cell — or drawing it with
            replacement — would make one hour's "typical" thinner than
            another's, and nothing downstream would say so.
    """
    if rows_per_cell <= 0:
        raise BackgroundError(f"rows_per_cell is {rows_per_cell!r}; a background is rows")

    positions: dict[CellKey, list[int]] = {}
    for index, key in enumerate(block.keys):
        positions.setdefault(CellKey.of(key), []).append(index)

    cells: dict[CellKey, BackgroundCell] = {}
    for cell_key, unordered in positions.items():
        # Sorted by row *identity*, not by arrival order. `RowKey` is ordered so
        # that a row set has one canonical spelling, and the sample inherits it:
        # a block that came back from the query in another order — the query's
        # order is not something this service reproduces — draws the same cell.
        candidates = sorted(unordered, key=lambda index: block.keys[index])
        if len(candidates) < rows_per_cell:
            raise BackgroundError(
                f"cell {cell_key.subsystem!r} hour {cell_key.local_hour:02d} has "
                f"{len(candidates)} rows in the block and the sample is drawn at "
                f"{rows_per_cell}; a short cell is a thinner 'typical' than every "
                "other hour's, and the screen would not say so"
            )
        generator = np.random.default_rng(
            [seed, SUBSYSTEM_CODES.index(cell_key.subsystem), cell_key.local_hour]
        )
        chosen = sorted(
            int(position)
            for position in generator.choice(
                len(candidates), size=rows_per_cell, replace=False
            )
        )
        rows = [candidates[position] for position in chosen]
        cells[cell_key] = BackgroundCell(
            subsystem=cell_key.subsystem,
            local_hour=cell_key.local_hour,
            keys=tuple(block.keys[row] for row in rows),
            matrix=np.ascontiguousarray(block.matrix[rows, :]),
        )

    return MatchedBackground(
        feature_names=block.contract.feature_names,
        rows_per_cell=rows_per_cell,
        seed=seed,
        source=source,
        cells=cells,
    )
