/**
 * The Time Machine dashboard's three new reads, stubbed around the contract's
 * own replay example.
 *
 * The replay is `12-replay.json` — NE, 2025-09-14, a joint band of 402–548–731
 * MWh and 612 MWh settled — so every figure below that describes *that* day is
 * the example's, and the dashboard can be checked against the numbers
 * `/app/replay` already shows. The other three subsystems, the early gate and
 * the national joint row are invented, and every one of them is a different
 * number, for the reason `optimization.test.ts` gives: a plausible fixture is
 * the one that hides a field read into the wrong slot.
 *
 * Each body is validated against its schema in `packages/core/schema` by
 * `apps/web/test/time-machine-fixtures.test.ts`, so a screenshot taken over
 * these stubs is a screenshot of a shape the gateway can actually send.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SPEC_EXAMPLES = join(
  // `process.cwd()`, for `gateway-fixtures.ts`'s reason: Playwright transpiles
  // this file to CommonJS, where `import.meta` is a syntax error, and both
  // runners start in `apps/web`.
  process.cwd(),
  "..",
  "..",
  "packages",
  "core",
  "fixtures",
  "spec-examples",
);

function specExample(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SPEC_EXAMPLES, file), "utf8"));
}

const REPLAY = specExample("12-replay.json") as {
  target_date: string;
  forecast_origin: Record<string, unknown>;
  actual: { data_version: string };
};

export const REVIEW_DATE = REPLAY.target_date;
const LANE = "dessem_free_v1__gate_late__thr5";
const LATE_ORIGIN = REPLAY.forecast_origin;
const EARLY_ORIGIN = {
  ...LATE_ORIGIN,
  published_at: "2025-09-13T12:00:00Z",
  gate_profile: "gate_early",
};
const BACKTEST_WROTE = "2026-09-18T03:58:12Z";

const row = (over: Record<string, unknown>) => ({
  replayable: true,
  refusal_code: null,
  provenance: "fold_holdout",
  vintage_fidelity: "revision_optimistic",
  forecast_origin: LATE_ORIGIN,
  day_total_unavailable_reason: null,
  settled_unavailable_reason: null,
  settled_hours: 24,
  ...over,
});

export const REPLAY_COMPARE = {
  target_date: REVIEW_DATE,
  lane: LANE,
  vintage_fidelity: "revision_optimistic",
  subsystems: [
    row({
      subsystem: "N",
      day_total: { p10: 41, p50: 96, p90: 188 },
      settled_total_mwh: 73,
      settled_data_version: "2",
      deviation_mwh: -23,
      placement: "inside",
    }),
    row({
      subsystem: "NE",
      day_total: { p10: 402, p50: 548, p90: 731 },
      settled_total_mwh: 612,
      settled_data_version: REPLAY.actual.data_version,
      deviation_mwh: 64,
      placement: "inside",
    }),
    row({
      subsystem: "SE",
      day_total: { p10: 7, p50: 29, p90: 66 },
      settled_total_mwh: 81,
      settled_data_version: "5",
      deviation_mwh: 52,
      placement: "above",
    }),
    row({
      subsystem: "S",
      day_total: { p10: 3, p50: 12, p90: 34 },
      settled_total_mwh: 2,
      settled_data_version: "1",
      deviation_mwh: -10,
      placement: "below",
    }),
  ],
  national: {
    vintage_fidelity: "revision_optimistic",
    day_total: { p10: 519, p50: 671, p90: 902 },
    day_total_unavailable_reason: null,
    settled_total_mwh: 768,
    settled_derivation: "sum_of_four",
    settled_unavailable_reason: null,
    deviation_mwh: 97,
    placement: "inside",
  },
};

const gate = (profile: "gate_early" | "gate_late") => ({
  lane: `dessem_free_v1__${profile}__thr5`,
  gate_profile: profile,
  vintage_fidelity: "revision_optimistic",
  replayable: true,
  refusal_code: null,
  provenance: "fold_holdout",
  forecast_origin: profile === "gate_late" ? LATE_ORIGIN : EARLY_ORIGIN,
  published_at_is_counterfactual: true,
  written_at: BACKTEST_WROTE,
  day_total:
    profile === "gate_late"
      ? { p10: 402, p50: 548, p90: 731 }
      : { p10: 455, p50: 603, p90: 818 },
  day_total_unavailable_reason: null,
  settled_total_mwh: 612,
  settled_unavailable_reason: null,
  settled_hours: 24,
  settled_data_version: REPLAY.actual.data_version,
  deviation_mwh: profile === "gate_late" ? 64 : 9,
  placement: "inside",
});

export const REPLAY_TIMELINE = {
  subsystem: "NE",
  target_date: REVIEW_DATE,
  vintage_fidelity: "revision_optimistic",
  gates: [gate("gate_early"), gate("gate_late")],
  settled: {
    settled_total_mwh: 612,
    settled_unavailable_reason: null,
    settled_hours: 24,
    data_version: REPLAY.actual.data_version,
    earliest_written_at: "2026-07-01T04:17:33Z",
    latest_written_at: "2026-08-02T22:05:10Z",
    entity_rows: 1128,
    restated_rows: 36,
  },
  events: [
    {
      kind: "forecast_published",
      at: "2025-09-13T12:00:00Z",
      lane: "dessem_free_v1__gate_early__thr5",
      gate_profile: "gate_early",
      counterfactual: true,
    },
    {
      kind: "forecast_published",
      at: "2025-09-13T22:00:00Z",
      lane: LANE,
      gate_profile: "gate_late",
      counterfactual: true,
    },
    {
      kind: "settled_written",
      at: "2026-07-01T04:17:33Z",
      rows: 1128,
      data_version: REPLAY.actual.data_version,
    },
    {
      kind: "settled_restated",
      at: "2026-08-02T22:05:10Z",
      rows: 36,
      data_version: REPLAY.actual.data_version,
    },
    {
      kind: "forecast_written",
      at: BACKTEST_WROTE,
      lane: "dessem_free_v1__gate_early__thr5",
      gate_profile: "gate_early",
      counterfactual: true,
    },
    {
      kind: "forecast_written",
      at: BACKTEST_WROTE,
      lane: LANE,
      gate_profile: "gate_late",
      counterfactual: true,
    },
  ],
};

const DIAGNOSIS = specExample("05-diagnosis-day-ahead.json") as {
  attribution: {
    drivers: Record<string, unknown>[];
    total_attributed_mwh: number;
    sum_abs_attributed_mwh: number;
    stderr_mwh: number;
    baseline_expected_mwh: number;
    day_expected_mwh: number;
    driver_group_version: string;
    driver_group_hash: string;
  };
};

export const REPLAY_ATTRIBUTION = {
  subsystem: "NE",
  target_date: REVIEW_DATE,
  lane: LANE,
  vintage_fidelity: "revision_optimistic",
  forecast_origin: LATE_ORIGIN,
  attribution: {
    target: "expected_mwh_day",
    total_attributed_mwh: DIAGNOSIS.attribution.total_attributed_mwh,
    sum_abs_attributed_mwh: DIAGNOSIS.attribution.sum_abs_attributed_mwh,
    stderr_mwh: DIAGNOSIS.attribution.stderr_mwh,
    baseline_expected_mwh: DIAGNOSIS.attribution.baseline_expected_mwh,
    day_expected_mwh: DIAGNOSIS.attribution.day_expected_mwh,
    driver_group_version: DIAGNOSIS.attribution.driver_group_version,
    driver_group_hash: DIAGNOSIS.attribution.driver_group_hash,
    governing_rule_action: null,
    rule_codes: [],
    drivers: DIAGNOSIS.attribution.drivers,
  },
  attribution_unavailable_reason: null,
};

export const SIMILAR_DAYS = {
  subsystem: "NE",
  target_date: REVIEW_DATE,
  lane: LANE,
  pool_from: "2025-03-18",
  pool_days: 171,
  features: [
    "dessem_demand_mw:mean",
    "dessem_wind_generation_mw:mean",
    "dessem_solar_generation_mw:mean",
    "dessem_mmgd_generation_mw:mean",
    "dessem_residual_load_mw:mean",
    "dessem_residual_load_mw:min",
  ],
  neighbours: [
    {
      target_date: "2025-08-30",
      distance: 0.41,
      observed_constrained_off_mwh: 588,
      hours: 24,
    },
    {
      target_date: "2025-09-06",
      distance: 0.57,
      observed_constrained_off_mwh: 703,
      hours: 24,
    },
    {
      target_date: "2025-07-19",
      distance: 0.83,
      observed_constrained_off_mwh: 441,
      hours: 24,
    },
  ],
};

/** ONS's programme beside the settled balance for the replayed day. */
export const GRID_CONTEXT = (() => {
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const validTime = new Date(Date.UTC(2025, 8, 14, hour + 3))
      .toISOString()
      .replace(".000", "");
    const solar =
      hour >= 7 && hour <= 17
        ? Math.round(900 * Math.sin(((hour - 6) / 12) * Math.PI))
        : 0;
    return {
      valid_time: validTime,
      programmed_load_mwh: 11_800 + hour * 37,
      observed_load_mwh: 11_620 + hour * 41,
      observed_wind_mwh: 9400 - hour * 53,
      observed_solar_mwh: solar * 7,
      observed_hydro_mwh: 2150 + hour * 3,
      observed_thermal_mwh: 610 - hour * 2,
      observed_net_exchange_mwh: 4300 + hour * 29,
      available_capacity_mw: 31_200 - hour * 11,
    };
  });
  return {
    subsystem: "NE",
    date: REVIEW_DATE,
    as_of: "2026-09-21T12:00:00Z",
    hours,
    day: {
      programmed_load_mwh: 293_415,
      observed_load_mwh: 290_214,
      deviation_mwh: -3201,
      deviation_unavailable_reason: null,
      hours_compared: 24,
    },
    corridors: [
      {
        from_subsystem: "NE",
        to_subsystem: "SE",
        verified_mwh: 101_870,
        programmed_mwh: 96_320,
        hours_settled: 24,
      },
      {
        from_subsystem: "N",
        to_subsystem: "NE",
        verified_mwh: 18_440,
        programmed_mwh: 21_050,
        hours_settled: 24,
      },
    ],
  };
})();

/**
 * The replay itself, with the dispatch a real one carries: all twenty-four
 * hours.
 *
 * `12-replay.json` illustrates the dispatch with one hour (13:00), which is
 * enough for the contract and too little for a chart of the day. The hours
 * below keep the example's own totals — the executed absorption sums to its
 * `avoided_energy_mwh` of 281 — and absorb only inside the settled episode
 * (09:00–17:00), clipped below what was scheduled, which is the execution
 * rule's shape on a day the forecast ran high at the edges.
 */
const SCHEDULED = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 35, 40, 40, 40, 40, 40, 35, 20, 0, 0, 0, 0, 0, 0,
];
const EXECUTED = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 30, 35, 35, 35, 35, 35, 36, 25, 0, 0, 0, 0, 0, 0,
];

/*
  Literal state-of-charge figures, typed in rather than accumulated: a fixture
  that charged a battery hour by hour would be a second implementation of the
  execution rule, which `test/one-execution-rule.test.ts` exists to forbid —
  and caught here the first time this was written as a loop.
*/
const STORED = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 45, 81, 117, 153, 189, 225, 256, 274, 274, 274, 274, 274,
  274, 274,
];

const dispatchDay = (absorbed: readonly number[]) =>
  absorbed.map((mwh, hour) => ({
    hour_local: hour,
    offered_mwh: mwh,
    battery_charge_mw: mwh,
    battery_discharge_mw: 0,
    state_of_charge_mwh: STORED[hour] ?? 0,
    load_shift_up_mw: 0,
    load_shift_down_mw: 0,
    absorbed_mwh: mwh,
  }));

export const REPLAY_FULL_DAY = {
  ...specExample("12-replay.json"),
  dispatch: dispatchDay(SCHEDULED),
  executed: dispatchDay(EXECUTED),
};

/**
 * The replayable calendar, cut to three NE days around the example's.
 *
 * Only what `offeredDays` reads — a date and a verdict per day — because the
 * screen asks it one question: which days can be opened.
 */
export const REPLAY_DAYS = {
  subsystem: "NE",
  lane: LANE,
  days: [
    { date: "2025-09-10", replayable: true },
    { date: "2025-09-12", replayable: true },
    { date: REVIEW_DATE, replayable: true },
  ],
};

/** The reads the dashboard adds, by pathname prefix. */
export const REVIEW_BY_PREFIX: readonly [string, unknown][] = [
  ["/v1/replay/days", REPLAY_DAYS],
  ["/v1/replay/compare/", REPLAY_COMPARE],
  ["/v1/replay/timeline/", REPLAY_TIMELINE],
  ["/v1/replay/attribution/", REPLAY_ATTRIBUTION],
  ["/v1/similar-days", SIMILAR_DAYS],
  ["/v1/grid/context", GRID_CONTEXT],
];
