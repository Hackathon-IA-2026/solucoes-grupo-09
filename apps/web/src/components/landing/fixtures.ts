/**
 * Deterministic sample data for the landing page.
 *
 * There is no API yet, and there is no honest way to render a "live national
 * readout" without one — so the page renders a fixture and says so, loudly,
 * in the readout itself. When `/forecast` exists this module is the only
 * thing that has to change shape: the components consume `Figure`s and the
 * types below, not JSON.
 *
 * Every number is chosen to be *internally consistent under the domain
 * model*, which is the part that would otherwise embarrass us later:
 *
 * - Subsystem P50s sum to the national P50, and nothing else sums. The hourly
 *   P10s sum well below the daily P10 and the hourly P90s well above the
 *   daily P90, because quantiles are not additive. The readout says this out
 *   loud rather than hoping nobody adds up the column.
 * - Energy is MWh (`docs/domain-model.md` §1: energy is stored, power is
 *   derived), and the only MW figures here are asset ratings.
 * - Every forecast carries a `ForecastOrigin`; the replay actual does not,
 *   because it is an observation and cannot have one.
 * - Reasons are omitted entirely. They exist only at reporting-entity grain
 *   and the landing page has no room to name the grain properly, so it
 *   shows none rather than showing one at the wrong grain.
 */

import type { Copy, Formatters } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  band,
  type DriverDirection,
  type Figure,
  type ForecastOrigin,
  observed,
  type SubsystemCode,
} from "@/lib/domain";

export type { ForecastOrigin, SubsystemCode };

/**
 * The landing page's own driver vocabulary.
 *
 * Separate from `lib/domain`'s `DriverCode`, which is the *product's* set: this
 * panel is a marketing illustration of IDEA.md §43 and names features the
 * Diagnosis engine does not have. Sharing one union would force the product's
 * dictionary to carry labels for features it never attributes to.
 */
export type LandingDriverCode =
  | "renewable_load_ratio"
  | "ne_se_export_utilisation"
  | "residual_load"
  | "solar_ramp_1h"
  | "is_weekend"
  | "other";

export interface LandingDriver {
  code: LandingDriverCode;
  /** Share of the attributed magnitude, 0..1. */
  share: number;
  direction: DriverDirection;
}

export interface SubsystemOutlook {
  code: SubsystemCode;
  /** ONS's display name, untranslated by naming rule 2. */
  displayName: string;
  /** Occurrence probability. A probability is a point estimate; it has no band. */
  probability: number;
  /** Magnitude, which does. */
  energy: Figure;
}

export interface HourlyBand {
  hour: number;
  p10: number;
  p50: number;
  p90: number;
}

export type MitigationStepKey = "no_action" | "battery" | "battery_and_load";

export interface MitigationStep {
  /** The step's identity. Its words, and its asset detail, are copy. */
  key: MitigationStepKey;
  /** Curtailment remaining after this step. */
  remaining: Figure;
  /** Energy this step recovers against the no-action baseline. */
  recovered: Figure | null;
}

/** The day the fixture describes. Fixed, so the page is byte-stable per build. */
export const FORECAST_DAY = "2026-08-29";

/**
 * The 12Z run supersedes the 00Z run of the same day. Because the run
 * initialisation time is itself the `published_at`, that supersession needs
 * no special case — it is simply a newer vintage of the same valid hours.
 */
export const FORECAST_ORIGIN: ForecastOrigin = {
  producer: "open_meteo",
  runLabel: "D−1 12Z",
  publishedAt: "2026-08-28T12:00Z",
};

/** National = the derived sum over four subsystems. Never an ONS `SIN` row. */
export const NATIONAL_ENERGY: Figure = band(2640, 4180, 6320);

export const SUBSYSTEMS: readonly SubsystemOutlook[] = [
  {
    code: "NE",
    displayName: "NORDESTE",
    probability: 0.89,
    energy: band(1720, 2780, 4260),
  },
  {
    code: "N",
    displayName: "NORTE",
    probability: 0.31,
    energy: band(120, 610, 1180),
  },
  {
    code: "SE",
    displayName: "SUDESTE/CENTRO-OESTE",
    probability: 0.17,
    energy: band(40, 520, 1090),
  },
  {
    code: "S",
    displayName: "SUL",
    probability: 0.08,
    energy: band(0, 270, 690),
  },
];

/**
 * National hourly profile, `valid_time` start-labelled in Brasília civil time
 * (the axis a Brazilian operator reads; storage is UTC).
 */
export const HOURLY_PROFILE: readonly HourlyBand[] = [
  { hour: 0, p10: 20, p50: 60, p90: 130 },
  { hour: 1, p10: 18, p50: 55, p90: 120 },
  { hour: 2, p10: 15, p50: 50, p90: 110 },
  { hour: 3, p10: 12, p50: 45, p90: 100 },
  { hour: 4, p10: 10, p50: 40, p90: 92 },
  { hour: 5, p10: 8, p50: 35, p90: 84 },
  { hour: 6, p10: 6, p50: 30, p90: 74 },
  { hour: 7, p10: 10, p50: 45, p90: 105 },
  { hour: 8, p10: 28, p50: 90, p90: 190 },
  { hour: 9, p10: 70, p50: 170, p90: 330 },
  { hour: 10, p10: 140, p50: 280, p90: 520 },
  { hour: 11, p10: 210, p50: 380, p90: 690 },
  { hour: 12, p10: 260, p50: 450, p90: 830 },
  { hour: 13, p10: 280, p50: 490, p90: 890 },
  { hour: 14, p10: 250, p50: 440, p90: 810 },
  { hour: 15, p10: 190, p50: 360, p90: 670 },
  { hour: 16, p10: 120, p50: 250, p90: 470 },
  { hour: 17, p10: 60, p50: 150, p90: 300 },
  { hour: 18, p10: 40, p50: 110, p90: 230 },
  { hour: 19, p10: 50, p50: 130, p90: 270 },
  { hour: 20, p10: 65, p50: 160, p90: 320 },
  { hour: 21, p10: 60, p50: 150, p90: 300 },
  { hour: 22, p10: 45, p50: 120, p90: 250 },
  { hour: 23, p10: 30, p50: 90, p90: 190 },
];

/** IDEA.md §43's driver list, at the grain the Diagnosis engine reports. */
export const DRIVERS: readonly LandingDriver[] = [
  {
    code: "renewable_load_ratio",
    share: 0.31,
    direction: "raises",
  },
  {
    code: "ne_se_export_utilisation",
    share: 0.25,
    direction: "raises",
  },
  {
    code: "residual_load",
    share: 0.18,
    direction: "raises",
  },
  {
    code: "solar_ramp_1h",
    share: 0.14,
    direction: "raises",
  },
  {
    code: "is_weekend",
    share: 0.07,
    direction: "raises",
  },
  {
    code: "other",
    share: 0.05,
    direction: "raises",
  },
];

/**
 * The scenario the mitigation panel illustrates.
 *
 * Held as numbers rather than as the sentence "100 MW / 300 MWh, round-trip
 * 92%": that sentence is copy in one language and an en-US decimal besides,
 * and the same four numbers read correctly in both locales.
 */
export const LANDING_SCENARIO = {
  batteryPowerMw: 100,
  batteryEnergyMwh: 300,
  roundTripEfficiency: 0.92,
  loadShiftMw: 70,
  shiftWindowHours: 3,
};

export const MITIGATION: readonly MitigationStep[] = [
  {
    key: "no_action",
    remaining: band(520, 786, 1120),
    recovered: null,
  },
  {
    key: "battery",
    remaining: band(340, 524, 760),
    recovered: band(150, 262, 390),
  },
  {
    key: "battery_and_load",
    remaining: band(230, 361, 530),
    recovered: band(270, 425, 620),
  },
];

/** The step's name, in the reader's language. */
export function stepLabel(copy: Copy, key: MitigationStepKey): string {
  if (key === "no_action") {
    return copy.showcase.mitigate.baselineLabel;
  }
  return key === "battery"
    ? copy.showcase.mitigate.stepBattery
    : copy.showcase.mitigate.stepLoad;
}

/**
 * The asset line under a step — the parameters, written out. `null` for the
 * baseline, which has no assets to describe.
 */
export function stepDetail(
  copy: Copy,
  f: Formatters,
  key: MitigationStepKey,
): string | null {
  if (key === "no_action") {
    return null;
  }
  if (key === "battery") {
    return fill(copy.showcase.mitigate.detailBattery, {
      power: f.number(LANDING_SCENARIO.batteryPowerMw),
      energy: f.number(LANDING_SCENARIO.batteryEnergyMwh),
      efficiency: f.percent(LANDING_SCENARIO.roundTripEfficiency),
    });
  }
  return fill(copy.showcase.mitigate.detailLoad, {
    shift: f.number(LANDING_SCENARIO.loadShiftMw),
    window: f.number(LANDING_SCENARIO.shiftWindowHours),
  });
}

/** Assumed energy value for the labelled economic scenario. Visible on screen. */
export { SCENARIO_BRL_PER_MWH } from "@/lib/economics";

export interface ReplayEvent {
  /** The historical day replayed. */
  day: string;
  subsystem: string;
  /** Measured. An observation, so it has no band and no `ForecastOrigin`. */
  actual: Figure;
  /** Counterfactual: what the optimizer's dispatch would have left. */
  optimized: Figure;
  recovered: Figure;
  reduction: number;
  /** `VintageFidelity` — product-visible, per the domain model. */
  vintageFidelity: "point_in_time" | "revision_optimistic";
}

export const REPLAY: ReplayEvent = {
  day: "2025-11-14",
  subsystem: "NORDESTE",
  actual: observed(612),
  optimized: band(268, 331, 402),
  recovered: band(210, 281, 344),
  reduction: 0.459,
  vintageFidelity: "revision_optimistic",
};
