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
- :mod:`~wattsteer_ml.evaluation.planning_arms` — the second planning arm: a
  plan against P50 and a plan against `E[Y]`, built on the same days from the
  same artifact with the same published fleet, scored by the optimizer's one
  simulator, and both arms' `recovered_floor_mwh` published side by side. v1
  still serves the P50 plan.
- :mod:`~wattsteer_ml.evaluation.ladder` — the five rungs, on identical folds.
- :mod:`~wattsteer_ml.evaluation.holdout` — `docs/specs/replay.md`'s one
  storage requirement: the out-of-fold forecasts, kept rather than
  discarded, and stamped `backfilled_holdout` so they cannot be served.
- :mod:`~wattsteer_ml.evaluation.shuffled_label` — seam 6: the same ladder run
  on labels permuted within a fold's date range, which must score at chance.
- :mod:`~wattsteer_ml.evaluation.gate` — the hot-swap gate: the paired block
  bootstrap that decides, the constants that only veto, and the one line
  appended either way.
- :mod:`~wattsteer_ml.evaluation.lead_time` — the weather lead-time A/B: the
  same model trained on archive weather and on lead-matched weather, both
  evaluated on the lead-matched features serving provides, reported with the
  interval metrics and not only `qloss_mwh` — which is where the research
  predicted the harm — plus the archive-on-archive column that sizes the leak.
  Run once per fold calendar, never on the weekly retrain.
- :mod:`~wattsteer_ml.evaluation.threshold_sweep` — the 1 / 5 / 10 MW sweep,
  three arms on identical rows, published rather than acted on: the six figures
  per threshold and per fold, the two move-forcing prevalence conditions
  evaluated rather than left to a reader, and the two figures that move with the
  mixture's breakpoint rather than with the model, said so beside them.
- :mod:`~wattsteer_ml.evaluation.serving_lanes` — the two served lanes, the
  morning view and the evening view, gated on one schedule and independently:
  one lane's refusal does not block the other's promotion, and the report
  carries the attribute census that says the two are different experiments.

**The last eight are imported as submodules, not re-exported here.** They read
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
