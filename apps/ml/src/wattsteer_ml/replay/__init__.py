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
- :mod:`~wattsteer_ml.replay.inputs` — the four a *single* replayed day needs,
  also in one transaction: the pinned band, its day-grain companion, the settled
  hours and the episodes drawn over them. Reproducibility is a property of the
  cut, so there is one cut.
- :mod:`~wattsteer_ml.replay.scoring` — the scoring half: one MILP on the pinned
  D−1 P50, four realisations through the optimizer's *imported* simulator, the
  floor that was promised, and the fenced perfect-foresight bound.
- :mod:`~wattsteer_ml.replay.premium` — the vintage caveat measured in Replay's
  own currency: one plan, two vintages of the same day's actuals, and the mean
  difference in recovered MWh. `null` until ONS has restated days WattSteer
  holds both vintages of, and never a zero standing in for that.
- :mod:`~wattsteer_ml.replay.result` — that, as the published contract, and the
  observed-only contract a pre-F1 day gets instead: the day, its episodes and
  the bound, with no recovery number anywhere on it.

The two halves stay in different modules because `replay.md` splits them at the
seam that matters: "the forecast is precomputed; the dispatch is computed on
demand". Nothing in the scoring half loads an artifact, builds a feature row or
calls a forecast — a replay never runs a model, so changing the fleet re-plans
and never re-forecasts.
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
from wattsteer_ml.replay.premium import (
    PREMIUM_NOTE,
    SETTLEMENT_LAG_HOURS,
    DayVintages,
    RevisionPremium,
    published_premium,
    revision_premium,
)
from wattsteer_ml.replay.result import (
    ReplayEpisode,
    observed_only_result,
    replay_result,
)
from wattsteer_ml.replay.scoring import (
    PERFECT_FORESIGHT,
    SCORED_ON,
    ForecastHour,
    ObservedDay,
    ObservedOnlyView,
    PerfectForesight,
    PerfectForesightBound,
    PinnedForecast,
    PinnedOrigin,
    ReplayPostureError,
    ReplayScores,
    plan_at_the_gate,
    same_profile,
    score_observed_only,
    score_replay,
)

__all__ = [
    "HOURS_PER_DAY",
    "PERFECT_FORESIGHT",
    "PREMIUM_NOTE",
    "PROVENANCE_BY_ORIGIN_KIND",
    "SCORED_ON",
    "SETTLEMENT_LAG_HOURS",
    "VINTAGE_AFFECTS",
    "VINTAGE_EXEMPT",
    "VINTAGE_READS",
    "ArtifactWindows",
    "CardWindowError",
    "DayEvidence",
    "DayVintages",
    "ForecastHour",
    "HeldOutBy",
    "ObservedDay",
    "ObservedOnlyView",
    "PerfectForesight",
    "PerfectForesightBound",
    "PinnedForecast",
    "PinnedOrigin",
    "ReplayCalendar",
    "ReplayDay",
    "ReplayEpisode",
    "ReplayPostureError",
    "ReplayRefused",
    "ReplayScores",
    "RevisionPremium",
    "assert_held_out",
    "build_calendar",
    "card_path",
    "day_fidelity",
    "integrity_violation",
    "latest_replayable_date",
    "observed_only_result",
    "plan_at_the_gate",
    "published_premium",
    "read_windows",
    "refusal_counts",
    "replay_result",
    "resolve_day",
    "revision_premium",
    "same_profile",
    "score_observed_only",
    "score_replay",
    "windows_from_card",
]
