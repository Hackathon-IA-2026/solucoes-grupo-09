"""Fold evaluation — the walk-forward harness, and the discipline it enforces.

`docs/specs/forecaster.md`, "The fold-evaluation protocol", is the spec. The
name is deliberate: this package scores model quality on held-out folds and
produces `qloss_mwh`. It is **not** a Backtest. `docs/domain-model.md` gives
that noun to the aggregate of many Replays consumed by the hot-swap gate. Two
harnesses, two outputs, two names.

- :mod:`~wattsteer_ml.evaluation.folds` — the calendar, as versioned data.
- :mod:`~wattsteer_ml.evaluation.vintage` — the `VintageFidelity` stamp, and
  the split at ingestion go-live that is never averaged away.
- :mod:`~wattsteer_ml.evaluation.matrix` — the runs, and the row-identity
  assertion that makes them a comparison rather than four numbers.
- :mod:`~wattsteer_ml.evaluation.collapse` — the ticket-011 block: whether a
  P50-planned day has any hour to act in.
- :mod:`~wattsteer_ml.evaluation.collapse_report` — the same block published per
  fold segment, counted over the **persisted** held-out bands, and stamped with
  what produced it so a fixture-derived share cannot be read as the grid's.
- :mod:`~wattsteer_ml.evaluation.metrics` — the metrics table, and `qloss_mwh`.
- :mod:`~wattsteer_ml.evaluation.ladder` — the five rungs, on identical folds.
- :mod:`~wattsteer_ml.evaluation.holdout` — `docs/specs/replay.md`'s one
  storage requirement: the out-of-fold forecasts, kept rather than
  discarded, and stamped `backfilled_holdout` so they cannot be served.
- :mod:`~wattsteer_ml.evaluation.gate` — the hot-swap gate: the paired block
  bootstrap that decides, the constants that only veto, and the one line
  appended either way.

**The last four are imported as submodules, not re-exported here.** They read
:mod:`wattsteer_ml.training`, which reads this package; re-exporting them would
close the cycle and make `import wattsteer_ml.evaluation` depend on LightGBM
being installed. `from wattsteer_ml.evaluation.metrics import MetricsRow` is the
spelling, and it is deliberate rather than an oversight.
"""

from wattsteer_ml.evaluation.collapse import (
    POOLED_LABEL,
    CollapseBlock,
    CollapseError,
    HoursPerDay,
    P50Collapse,
    ServedBand,
    ServedHour,
)
from wattsteer_ml.evaluation.folds import (
    FOLD_CALENDAR_PATH,
    FOLD_CALENDAR_RULES,
    Fold,
    FoldBlocks,
    FoldCalendar,
    FoldCalendarError,
    FoldCalendarRules,
    FoldOrderError,
    FoldWindowError,
    PinnedFold,
    assert_folds_in_order,
    load_fold_calendar_rules,
    materialize_fold_calendar,
)
from wattsteer_ml.evaluation.matrix import (
    HOURS_PER_DAY,
    MATRIX_RUN_BY_NAME,
    MATRIX_RUNS,
    MatrixRun,
    RowIdentityError,
    RowKey,
    ScoredFold,
    WeatherArm,
    assert_identical_test_rows,
    expected_test_rows,
    row_set_digest,
)
from wattsteer_ml.evaluation.vintage import (
    ROW_ID_SEPARATOR,
    FoldSegment,
    MixedFidelityError,
    assert_no_averaged_rows,
    earliest_valid_instant,
    first_point_in_time_date,
    pooled_fidelity,
    stamp_calendar,
    stamp_fidelity,
)

__all__ = [
    "FOLD_CALENDAR_PATH",
    "FOLD_CALENDAR_RULES",
    "HOURS_PER_DAY",
    "MATRIX_RUNS",
    "MATRIX_RUN_BY_NAME",
    "POOLED_LABEL",
    "ROW_ID_SEPARATOR",
    "CollapseBlock",
    "CollapseError",
    "Fold",
    "FoldBlocks",
    "FoldCalendar",
    "FoldCalendarError",
    "FoldCalendarRules",
    "FoldOrderError",
    "FoldSegment",
    "FoldWindowError",
    "HoursPerDay",
    "MatrixRun",
    "MixedFidelityError",
    "P50Collapse",
    "PinnedFold",
    "RowIdentityError",
    "RowKey",
    "ScoredFold",
    "ServedBand",
    "ServedHour",
    "WeatherArm",
    "assert_folds_in_order",
    "assert_identical_test_rows",
    "assert_no_averaged_rows",
    "earliest_valid_instant",
    "expected_test_rows",
    "first_point_in_time_date",
    "load_fold_calendar_rules",
    "materialize_fold_calendar",
    "pooled_fidelity",
    "row_set_digest",
    "stamp_calendar",
    "stamp_fidelity",
]
