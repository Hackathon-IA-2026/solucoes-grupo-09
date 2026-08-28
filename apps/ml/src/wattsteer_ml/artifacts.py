"""The model-artifact store.

The charting decision: the Python service retrains weekly from Postgres, writes
the artifact and its metrics to a Railway volume, and hot-swaps only if the
backtest gate passes. This module is the volume's half of that — it knows where
artifacts live and what is there, and nothing else. Training writes into it in a
later ticket.

The directory is a *mount point*, so its state is diagnostic information rather
than an invariant: it can be missing (volume not attached), present and empty
(attached, nothing trained yet), or present and read-only (attached wrong).
`/v1/meta` reports which, because "the forecast is stale" and "the volume did
not mount" look identical from the outside otherwise.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .config import settings

#: Suffix used for serialised models. One place, so the retrain job and the
#: loader cannot disagree about it.
ARTIFACT_SUFFIX = ".joblib"


@dataclass(frozen=True)
class ArtifactStore:
    """A view of the artifact directory at one moment."""

    path: Path
    mounted: bool
    writable: bool
    artifacts: tuple[str, ...]

    @property
    def current(self) -> str | None:
        """The newest artifact by name, or `None` when nothing is trained.

        Names sort meaningfully because the retrain job stamps them with an
        ISO-8601 UTC timestamp; there is no "latest" symlink to go stale.
        """
        return self.artifacts[-1] if self.artifacts else None


def inspect() -> ArtifactStore:
    """Describe the artifact directory without creating or mutating anything."""
    path = settings.artifact_dir
    if not path.is_dir():
        return ArtifactStore(path=path, mounted=False, writable=False, artifacts=())
    names = sorted(p.name for p in path.iterdir() if p.suffix == ARTIFACT_SUFFIX)
    return ArtifactStore(
        path=path,
        mounted=True,
        writable=os.access(path, os.W_OK),
        artifacts=tuple(names),
    )
