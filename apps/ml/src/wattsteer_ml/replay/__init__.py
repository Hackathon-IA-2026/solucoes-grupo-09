"""Replay — a read mode, and this package is the half that says *which days*.

`docs/domain-model.md` is the naming authority and it is emphatic: **`Replay` is
a read mode, not a table**, and `Backtest` is the distinct noun for the
aggregate. Nothing here persists a replay, and there is no ``ReplayRun`` to
find: what is persisted is the forecast rows, which replay 01 already writes,
and this package reads them back and judges them.

- :mod:`~wattsteer_ml.replay.calendar` — the predicate, the typed refusals and
  the read-time held-out assertion. Pure: no Postgres, no volume, no clock but
  the one handed in.
- :mod:`~wattsteer_ml.replay.cards` — the artifact card's two recorded windows,
  which is what the assertion asserts *against*.
- :mod:`~wattsteer_ml.replay.reads` — the two queries, over the whole window in
  one transaction.

The scoring half — the MILP, the four simulator passes, the floor — is a later
ticket. It is not here and this package imports nothing that could do it, which
is the shape `replay.md` asks for: "the forecast is precomputed; the dispatch is
computed on demand", and the two halves do not share a module.
"""

from wattsteer_ml.replay.calendar import (
    HOURS_PER_DAY,
    PROVENANCE_BY_ORIGIN_KIND,
    VINTAGE_AFFECTS,
    VINTAGE_EXEMPT,
    VINTAGE_READS,
    DayEvidence,
    HeldOutBy,
    ReplayCalendar,
    ReplayDay,
    ReplayRefused,
    assert_held_out,
    build_calendar,
    day_fidelity,
    integrity_violation,
    latest_replayable_date,
    refusal_counts,
    resolve_day,
)
from wattsteer_ml.replay.cards import (
    ArtifactWindows,
    CardWindowError,
    card_path,
    read_windows,
    windows_from_card,
)

__all__ = [
    "HOURS_PER_DAY",
    "PROVENANCE_BY_ORIGIN_KIND",
    "VINTAGE_AFFECTS",
    "VINTAGE_EXEMPT",
    "VINTAGE_READS",
    "ArtifactWindows",
    "CardWindowError",
    "DayEvidence",
    "HeldOutBy",
    "ReplayCalendar",
    "ReplayDay",
    "ReplayRefused",
    "assert_held_out",
    "build_calendar",
    "card_path",
    "day_fidelity",
    "integrity_violation",
    "latest_replayable_date",
    "read_windows",
    "refusal_counts",
    "resolve_day",
    "windows_from_card",
]
