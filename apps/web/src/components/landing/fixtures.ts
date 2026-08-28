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

import { band, type Figure, observed } from "./band";

/** `docs/domain-model.md` §2 — four members, and `SIN` is not one of them. */
export type SubsystemCode = "N" | "NE" | "S" | "SE";

export interface ForecastOrigin {
  producer: string;
  runLabel: string;
  /** Run initialisation — the `published_at` of every row it produced. */
  publishedAt: string;
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

export interface Driver {
  /** English label; the underlying feature name is an identifier, not copy. */
  label: string;
  /** Normalised SHAP contribution, 0..1, summing to 1 across the list. */
  contribution: number;
}

export interface MitigationStep {
  label: string;
  /** Asset description — scenario input, never an inventory. */
  detail: string | null;
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
  producer: "ECMWF IFS HRES via Open-Meteo",
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
export const DRIVERS: readonly Driver[] = [
  { label: "Renewable / load ratio", contribution: 0.31 },
  { label: "Export stress, NE → SE", contribution: 0.25 },
  { label: "Low residual load", contribution: 0.18 },
  { label: "Solar ramp", contribution: 0.14 },
  { label: "Weekend", contribution: 0.07 },
  { label: "Other features", contribution: 0.05 },
];

export const MITIGATION: readonly MitigationStep[] = [
  {
    label: "No action",
    detail: null,
    remaining: band(520, 786, 1120),
    recovered: null,
  },
  {
    label: "+ Battery",
    detail: "100 MW / 300 MWh, round-trip 92%",
    remaining: band(340, 524, 760),
    recovered: band(150, 262, 390),
  },
  {
    label: "+ Flexible load",
    detail: "70 MW shiftable, 3 h window",
    remaining: band(230, 361, 530),
    recovered: band(270, 425, 620),
  },
];

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
