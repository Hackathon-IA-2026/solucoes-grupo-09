/**
 * Explain fixtures: driver attribution, narration, reliability curve, and the
 * observed restriction reasons — the last of which is the one panel on this
 * screen that is an *observation* rather than a model output, and is labelled
 * with the grain ONS reports it at.
 */

import { TARGET_DATE } from "./grid";
import type {
  Driver,
  ExplainFixture,
  ObservedReason,
  ReliabilityPoint,
  SubsystemCode,
  Technology,
} from "./types";

const NE_WIND_DRIVERS: Driver[] = [
  {
    code: "vre_load_ratio",
    label: "Renewable / load ratio",
    share: 0.31,
    direction: "raises",
    observed: "1.42",
    typical: "0.96",
  },
  {
    code: "export_headroom",
    label: "Export headroom to SE/CO",
    share: 0.25,
    direction: "raises",
    observed: "310 MW left",
    typical: "1,900 MW left",
  },
  {
    code: "load_level",
    label: "Overnight load level",
    share: 0.18,
    direction: "raises",
    observed: "8.1 GW",
    typical: "9.4 GW",
  },
  {
    code: "hub_wind_speed",
    label: "Hub-height wind speed",
    share: 0.14,
    direction: "raises",
    observed: "11.8 m/s",
    typical: "8.7 m/s",
  },
  {
    code: "day_of_week",
    label: "Saturday",
    share: 0.07,
    direction: "raises",
    observed: "weekend",
    typical: "weekday",
  },
  {
    code: "other",
    label: "Everything else",
    share: 0.05,
    direction: "lowers",
    observed: "—",
    typical: "—",
  },
];

const NE_SOLAR_DRIVERS: Driver[] = [
  {
    code: "midday_net_load",
    label: "Midday net load",
    share: 0.34,
    direction: "raises",
    observed: "3.2 GW",
    typical: "5.1 GW",
  },
  {
    code: "export_headroom",
    label: "Export headroom to SE/CO",
    share: 0.22,
    direction: "raises",
    observed: "480 MW left",
    typical: "1,900 MW left",
  },
  {
    code: "clear_sky_index",
    label: "Clear-sky index",
    share: 0.19,
    direction: "raises",
    observed: "0.94",
    typical: "0.78",
  },
  {
    code: "installed_pv",
    label: "PV commissioned in window",
    share: 0.12,
    direction: "raises",
    observed: "+1.4 GW YoY",
    typical: "+0.6 GW YoY",
  },
  {
    code: "hydro_flexibility",
    label: "Hydro down-ramp available",
    share: 0.08,
    direction: "lowers",
    observed: "2.1 GW",
    typical: "1.3 GW",
  },
  {
    code: "other",
    label: "Everything else",
    share: 0.05,
    direction: "lowers",
    observed: "—",
    typical: "—",
  },
];

const GENERIC_DRIVERS: Driver[] = [
  {
    code: "vre_load_ratio",
    label: "Renewable / load ratio",
    share: 0.29,
    direction: "raises",
    observed: "0.71",
    typical: "0.64",
  },
  {
    code: "load_level",
    label: "Load level",
    share: 0.24,
    direction: "lowers",
    observed: "12.6 GW",
    typical: "11.9 GW",
  },
  {
    code: "import_position",
    label: "Net import position",
    share: 0.21,
    direction: "lowers",
    observed: "importing",
    typical: "balanced",
  },
  {
    code: "clear_sky_index",
    label: "Clear-sky index",
    share: 0.14,
    direction: "raises",
    observed: "0.81",
    typical: "0.74",
  },
  {
    code: "day_of_week",
    label: "Saturday",
    share: 0.07,
    direction: "raises",
    observed: "weekend",
    typical: "weekday",
  },
  {
    code: "other",
    label: "Everything else",
    share: 0.05,
    direction: "lowers",
    observed: "—",
    typical: "—",
  },
];

/**
 * The reliability curve is a property of the *model*, not of the day, so it is
 * shared across subsystems in the fixture. Deliberately imperfect: the model
 * is over-confident in the top bins, which is what a real curve looks like and
 * what the screen has to be able to show without flinching.
 */
const RELIABILITY: ReliabilityPoint[] = [
  { binCentre: 0.05, observedFrequency: 0.03, hourCount: 4180 },
  { binCentre: 0.15, observedFrequency: 0.12, hourCount: 1960 },
  { binCentre: 0.25, observedFrequency: 0.27, hourCount: 1240 },
  { binCentre: 0.35, observedFrequency: 0.33, hourCount: 890 },
  { binCentre: 0.45, observedFrequency: 0.47, hourCount: 704 },
  { binCentre: 0.55, observedFrequency: 0.52, hourCount: 611 },
  { binCentre: 0.65, observedFrequency: 0.6, hourCount: 588 },
  { binCentre: 0.75, observedFrequency: 0.68, hourCount: 542 },
  { binCentre: 0.85, observedFrequency: 0.77, hourCount: 497 },
  { binCentre: 0.95, observedFrequency: 0.88, hourCount: 431 },
];

/**
 * Observed reasons. Note the mix of grains: three conjuntos, whose reason
 * belongs to the settlement unit and may never be pushed down to a member
 * plant, and one Tipo II-B plant which *is* its own reporting entity and whose
 * reason is therefore genuinely observed at plant grain.
 */
const NE_REASONS: ObservedReason[] = [
  {
    grain: "conjunto",
    entityLabel: "CJU_MAPLN",
    reason: "ENE",
    origin: "SIS",
    constrainedOffMwh: 214.8,
    description: null,
  },
  {
    grain: "conjunto",
    entityLabel: "CJU_ACAU",
    reason: "REL",
    origin: "LOC",
    constrainedOffMwh: 141.2,
    description: "LT 230 kV Açu II / Mossoró C1 indisponível — SGI 2026-44119",
  },
  {
    grain: "conjunto",
    entityLabel: "CJU_CSSA",
    reason: "CNF",
    origin: "SIS",
    constrainedOffMwh: 96.4,
    description: "Controle de reserva de potência operativa",
  },
  {
    grain: "self_reporting_plant",
    entityLabel: "Ventos de São Tomé XI (Tipo II-B)",
    reason: "ENE",
    origin: "SIS",
    constrainedOffMwh: 18.7,
    description: null,
  },
];

const GENERIC_REASONS: ObservedReason[] = [
  {
    grain: "conjunto",
    entityLabel: "CJU_ITAPE",
    reason: "REL",
    origin: "LOC",
    constrainedOffMwh: 42.1,
    description: "Manutenção programada — SE Itaperuna 138 kV",
  },
  {
    grain: "conjunto",
    entityLabel: "CJU_JAIB",
    reason: "ENE",
    origin: "SIS",
    constrainedOffMwh: 27.9,
    description: null,
  },
];

function narrationFor(
  subsystem: SubsystemCode,
  technology: Technology,
  drivers: Driver[],
): string {
  const top = drivers[0];
  const second = drivers[1];
  const where = subsystem === "NE" ? "NORDESTE" : subsystem;
  return (
    `The model puts ${where} ${technology} curtailment above the 5 MW threshold ` +
    `for most of the day. The largest single contribution is ${top.label.toLowerCase()} ` +
    `(${top.observed} against a typical ${top.typical}), followed by ` +
    `${second.label.toLowerCase()}. Those two together account for ` +
    `${Math.round((top.share + second.share) * 100)}% of the attributed magnitude. ` +
    `The band is wide in the shoulder hours because the occurrence classifier is ` +
    `near an even chance there — read the P10 as "it may not clear the threshold ` +
    `at all", not as a small number.`
  );
}

export function buildExplain(
  subsystem: SubsystemCode,
  technology: Technology,
): ExplainFixture {
  const drivers =
    subsystem === "NE" && technology === "WIND"
      ? NE_WIND_DRIVERS
      : subsystem === "NE"
        ? NE_SOLAR_DRIVERS
        : GENERIC_DRIVERS;
  return {
    subsystem,
    technology,
    targetDate: TARGET_DATE,
    drivers,
    narration: narrationFor(subsystem, technology, drivers),
    reliability: RELIABILITY,
    reliabilitySampleHours: RELIABILITY.reduce((acc, p) => acc + p.hourCount, 0),
    reliabilityWindow: "2024-04-01 → 2026-08-27",
    // The whole reliability window predates ingestion go-live, so it is scored
    // against ONS's *current* restatement of the past.
    reliabilityFidelity: "revision_optimistic",
    observedReasons: subsystem === "NE" ? NE_REASONS : GENERIC_REASONS,
    observedReasonsDate: "2026-08-27",
  };
}
