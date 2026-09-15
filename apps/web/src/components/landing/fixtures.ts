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
 * - **Nothing quantile-shaped sums, including the medians.** The national
 *   figure is the *expectation*, because `E[·]` is the only quantity here
 *   that adds exactly: subsystem expectations sum to the national one and
 *   hourly expectations sum to the day. The subsystem P50s do not sum to it,
 *   the hourly P10s sum well below the daily P10 and the hourly P90s well
 *   above the daily P90 — the median of a sum is the sum of the medians only
 *   for comonotone components, which four subsystems are not. The readout
 *   says this out loud rather than hoping nobody adds up the column.
 * - Energy is MWh (`docs/domain-model.md` §1: energy is stored, power is
 *   derived), and the only MW figures here are asset ratings.
 * - Every forecast carries a `ForecastOrigin`; the replay actual does not,
 *   because it is an observation and cannot have one.
 * - Reasons are omitted entirely. They exist only at reporting-entity grain
 *   and the landing page has no room to name the grain properly, so it
 *   shows none rather than showing one at the wrong grain.
 */

import {
  type Band,
  type BandUnavailableReason,
  band,
  type DisplayDriverCode,
  type Figure,
  type ForecastOrigin,
  observed,
  REFERENCE_FLEET,
  type SignedDriverDirection,
  type SubsystemCode,
} from "@wattsteer/core";
import type { Copy, Formatters } from "@/i18n";
import { fill } from "@/i18n/format";
import type { RiskClass } from "@/lib/fixtures";

export type { BandUnavailableReason, ForecastOrigin, SubsystemCode };

/**
 * The landing panel's drivers are the **product's** drivers.
 *
 * This union used to be its own: five feature names plus `other`, called a
 * marketing illustration here and "the grain the Diagnosis engine reports"
 * eighty lines below. Both cannot be true, and `packages/core/src/domain.ts`
 * settles it — the eight groups are the players in the Shapley game, and no
 * model ever produced an attribution for a single feature. A landing page that
 * draws one bar per feature advertises an attribution the engine refuses to
 * compute, beside a heading calling these the product's own panels.
 *
 * So the codes are `DisplayDriverCode`: the closed eight plus the client's
 * merged remainder, which is exactly what the Explain screen draws. The words
 * come from `copy.app.drivers` for the same reason — one dictionary of driver
 * names, so the two surfaces cannot drift apart again.
 */
export interface LandingDriver {
  code: DisplayDriverCode;
  /**
   * Share of the attributed *movement*, 0..1 — the same quantity the product
   * screen's `Driver.share` carries, named the same way.
   */
  share: number;
  /**
   * Always signed on this panel. `"mixed"` is a member of the union because
   * the product's merged `other` row can report it; this illustration has no
   * merge step, so nothing here produces it.
   */
  direction: SignedDriverDirection;
}

export interface SubsystemOutlook {
  code: SubsystemCode;
  /** ONS's display name, untranslated by naming rule 2. */
  displayName: string;
  /** Occurrence probability. A probability is a point estimate; it has no band. */
  probability: number;
  /** Magnitude, which does. */
  energy: Figure;
  /**
   * `day_expected_mwh` — `E[Y]`, a sibling of the band and never its centre.
   * For a hurdle mixture it exceeds the P50 whenever `p < 0.5`, which is why
   * it is stored rather than derived from the quantiles.
   */
  expectedMwh: number;
  /** `risk_class` — the binned probability, as the API returns it. */
  riskClass: RiskClass;
}

/**
 * The national readout: an expectation, a tally, and an explicitly absent band.
 *
 * The shape is `/v1/grid/outlook`'s `national` object. A union rather than
 * four independent fields, because the invariant that matters is that a
 * missing band always arrives with the reason it is missing — a `null` band
 * beside a `null` reason is the state where the UI has nothing to say and
 * says nothing, and it is unrepresentable here.
 */
export type NationalOutlook = {
  /** `expected_mwh`. Adds exactly across subsystems, which is the whole point. */
  expectedMwh: number;
  /** `risk_class_counts` — how many subsystems sit in each bin. */
  riskClassCounts: Record<RiskClass, number>;
} & (
  | { band: Band; bandUnavailableReason: null }
  | { band: null; bandUnavailableReason: BandUnavailableReason }
);

export interface HourlyBand {
  hour: number;
  p10: number;
  p50: number;
  p90: number;
  /** `expected_mwh` at hour grain. These sum to the day; the quantiles do not. */
  expectedMwh: number;
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
 * The origin of *this* forecast.
 *
 * The producer is `wattsteer`: a curtailment forecast is WattSteer's artifact,
 * and `run_label` is that artifact's version. `open_meteo` produced the
 * **weather** run the artifact consumed, which is a second fact and therefore
 * a second field. Stamping the weather provider as the producer of the
 * forecast — which this fixture used to do — names the wrong artifact in the
 * one line on the page whose job is provenance.
 *
 * The 12Z weather run supersedes the 00Z run of the same day, and that
 * supersession needs no special case: a run's initialisation time is its
 * publication time, so it is simply a newer vintage of the same valid hours.
 *
 * Typed to *require* `weatherRunLabel`, because this panel names both
 * artifacts and a missing weather run would print a dangling clause.
 */
export const FORECAST_ORIGIN: ForecastOrigin & { weatherRunLabel: string } = {
  producer: "wattsteer",
  runLabel: "hurdle-v0.4",
  publishedAt: "2026-08-28T13:35Z",
  weatherRunLabel: "D−1 12Z",
};

/**
 * The national outlook — an expectation, not a band.
 *
 * The hero used to render `band(2640, 4180, 6320)`, whose P50 was the
 * componentwise sum of the four subsystem P50s. That number had no engine
 * behind it: the median of a sum is the sum of the medians only when the
 * components are comonotone, and four subsystems' curtailment is not. The
 * P10 and P90 were worse still — quantiles of a sum need a joint
 * distribution, which the per-subsystem path ensembles do not give.
 *
 * `expected_mwh` is what survives aggregation. Expectations add exactly, with
 * no assumption whatever about the dependence between subsystems, so the sum
 * of the four `day_expected_mwh` values below is a fact rather than a
 * convention. `band` is `null` and carries the reason it is null, until
 * ticket 009 shares the drawn day-row index across subsystems and the joint
 * band falls out of the existing 500 draws.
 *
 * Note that 4,580 exceeds the sum of the medians (4,180): for a hurdle
 * mixture `E[Y] > P50` whenever `p < 0.5`, which is three of these four
 * subsystems.
 */
export const NATIONAL: NationalOutlook = {
  expectedMwh: 4580.0,
  riskClassCounts: { low: 2, elevated: 1, high: 1 },
  band: null,
  bandUnavailableReason: "no_joint_ensemble",
};

export const SUBSYSTEMS: readonly SubsystemOutlook[] = [
  {
    code: "NE",
    displayName: "NORDESTE",
    probability: 0.89,
    energy: band(1720, 2780, 4260),
    expectedMwh: 2960.0,
    riskClass: "high",
  },
  {
    code: "N",
    displayName: "NORTE",
    probability: 0.31,
    energy: band(120, 610, 1180),
    expectedMwh: 700.0,
    riskClass: "elevated",
  },
  {
    code: "SE",
    displayName: "SUDESTE/CENTRO-OESTE",
    probability: 0.17,
    energy: band(40, 520, 1090),
    expectedMwh: 590.0,
    riskClass: "low",
  },
  {
    code: "S",
    displayName: "SUL",
    probability: 0.08,
    energy: band(0, 270, 690),
    expectedMwh: 330.0,
    riskClass: "low",
  },
];

/**
 * National hourly profile, `valid_time` start-labelled in Brasília civil time
 * (the axis a Brazilian operator reads; storage is UTC).
 *
 * Each hour carries its expectation beside its band, and those expectations
 * sum to `NATIONAL.expectedMwh` exactly — the same additivity argument that
 * holds across subsystems holds across hours. The hourly quantiles sum to
 * nothing at all, which is why the day figure is never read off this table.
 */
export const HOURLY_PROFILE: readonly HourlyBand[] = [
  { hour: 0, p10: 20, p50: 60, p90: 130, expectedMwh: 65.7 },
  { hour: 1, p10: 18, p50: 55, p90: 120, expectedMwh: 60.3 },
  { hour: 2, p10: 15, p50: 50, p90: 110, expectedMwh: 54.8 },
  { hour: 3, p10: 12, p50: 45, p90: 100, expectedMwh: 49.3 },
  { hour: 4, p10: 10, p50: 40, p90: 92, expectedMwh: 43.8 },
  { hour: 5, p10: 8, p50: 35, p90: 84, expectedMwh: 38.3 },
  { hour: 6, p10: 6, p50: 30, p90: 74, expectedMwh: 32.9 },
  { hour: 7, p10: 10, p50: 45, p90: 105, expectedMwh: 49.3 },
  { hour: 8, p10: 28, p50: 90, p90: 190, expectedMwh: 98.6 },
  { hour: 9, p10: 70, p50: 170, p90: 330, expectedMwh: 186.3 },
  { hour: 10, p10: 140, p50: 280, p90: 520, expectedMwh: 306.8 },
  { hour: 11, p10: 210, p50: 380, p90: 690, expectedMwh: 416.4 },
  { hour: 12, p10: 260, p50: 450, p90: 830, expectedMwh: 493.1 },
  { hour: 13, p10: 280, p50: 490, p90: 890, expectedMwh: 536.9 },
  { hour: 14, p10: 250, p50: 440, p90: 810, expectedMwh: 482.1 },
  { hour: 15, p10: 190, p50: 360, p90: 670, expectedMwh: 394.4 },
  { hour: 16, p10: 120, p50: 250, p90: 470, expectedMwh: 273.9 },
  { hour: 17, p10: 60, p50: 150, p90: 300, expectedMwh: 164.4 },
  { hour: 18, p10: 40, p50: 110, p90: 230, expectedMwh: 120.5 },
  { hour: 19, p10: 50, p50: 130, p90: 270, expectedMwh: 142.4 },
  { hour: 20, p10: 65, p50: 160, p90: 320, expectedMwh: 175.3 },
  { hour: 21, p10: 60, p50: 150, p90: 300, expectedMwh: 164.4 },
  { hour: 22, p10: 45, p50: 120, p90: 250, expectedMwh: 131.5 },
  { hour: 23, p10: 30, p50: 90, p90: 190, expectedMwh: 98.6 },
];

/**
 * An illustrative ranking, at the grain the Diagnosis engine actually reports.
 *
 * Five of the eight groups and the merged remainder — the shape a response
 * takes once the client's display rule has collapsed everything below the cut.
 * The shares are a fixture; the codes are not.
 */
export const DRIVERS: readonly LandingDriver[] = [
  {
    code: "renewable_resource",
    share: 0.31,
    direction: "raises",
  },
  {
    code: "export_stress",
    share: 0.25,
    direction: "raises",
  },
  {
    code: "net_surplus",
    share: 0.18,
    direction: "raises",
  },
  {
    code: "ramp_shape",
    share: 0.14,
    direction: "raises",
  },
  {
    code: "calendar_season",
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
 * The scenario the mitigation panel illustrates — the published
 * `REFERENCE_FLEET`, read rather than restated.
 *
 * Held as numbers rather than as the sentence "100 MW / 300 MWh, round-trip
 * 92%": that sentence is copy in one language and an en-US decimal besides,
 * and the same four numbers read correctly in both locales.
 *
 * The landing page quoting a different fleet than the Mitigate screen defaults
 * to would be two answers to "what does WattSteer assume", on two pages of one
 * product, so both spend the same constant.
 */
export const LANDING_SCENARIO = {
  batteryPowerMw: REFERENCE_FLEET.battery.maxPowerMw,
  batteryEnergyMwh: REFERENCE_FLEET.battery.energyCapacityMwh,
  roundTripEfficiency: REFERENCE_FLEET.battery.roundTripEfficiency,
  loadShiftMw: REFERENCE_FLEET.shiftableLoad.maxShiftMw,
  shiftWindowHours: REFERENCE_FLEET.shiftableLoad.shiftWindowHours,
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
export { BRL_PER_MWH } from "@wattsteer/core";

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
