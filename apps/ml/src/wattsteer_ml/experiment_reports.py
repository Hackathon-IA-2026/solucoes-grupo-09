"""Where an experiment's report is kept, so a run that was printed is not lost.

The DESSEM A/B and the threshold sweep are one-off processes that answer a
question and exit; their only output used to be one line of JSON on stdout, so a
report survived exactly as long as somebody piped it somewhere. The arms'
*artifacts* were saved, the *comparison between them* was not.

    <artifact root>/experiments/<kind>/<as_of stem>.json

**Beside the models, and never among the lanes.** The volume already holds the
models and the decision log, so a second store would be a second mount to lose.
:data:`EXPERIMENTS_DIRNAME` is the one name under the root that is not a lane,
and :func:`wattsteer_ml.artifacts.inspect` skips it by that constant — without
that, `/v1/meta` would list it under ``unrecognised`` on every deployment that
had ever run an experiment.

**This is not the promotion log and nothing reads it back to decide anything.**
It is a record. Nothing here appends to ``promotions.jsonl``, and no serving or
gate path opens this directory; the two drivers' own headers hold the same line.

**A report is written whether or not it measured anything.** ``NOT_RUN_YET`` is
an honest absence, and the run that recorded it is the evidence the question was
asked. Exit codes stay the drivers' own.

**A failed write is a sentence on stderr and not a failed run.** The fits are the
expensive part and they have already happened; a read-only volume must not turn
a finished experiment into an exception. The report is still on stdout.

**The stem is the run's ``--as-of``**, the same instant the arms are saved
under, so the report and its arms' artifacts share a name. Re-running one
instant replaces the file, by an atomic rename so a reader never sees half of it.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from .lanes import format_instant

#: The one directory under the artifact root that is not a lane.
EXPERIMENTS_DIRNAME = "experiments"

ExperimentKind = Literal["dessem_ab", "threshold_sweep", "p50_bias"]


def report_path(root: Path, kind: ExperimentKind, as_of: datetime) -> Path:
    """Where the report for ``kind`` at ``as_of`` lives, without touching disk."""
    return root / EXPERIMENTS_DIRNAME / kind / f"{format_instant(as_of)}.json"


def save_report(
    root: Path, kind: ExperimentKind, as_of: datetime, report: Mapping[str, Any]
) -> Path | None:
    """Write ``report`` and return its path, or ``None`` when it could not be kept."""
    path = report_path(root, kind, as_of)
    partial = path.with_name(f"{path.name}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        partial.write_text(json.dumps(report), encoding="utf-8")
        os.replace(partial, path)
    except OSError as failure:
        print(
            json.dumps({"warning": f"{kind} report was not saved to {path}: {failure}"}),
            file=sys.stderr,
        )
        return None
    return path


__all__ = ["EXPERIMENTS_DIRNAME", "ExperimentKind", "report_path", "save_report"]
