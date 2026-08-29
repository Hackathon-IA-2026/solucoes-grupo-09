/**
 * Explain fixtures: driver attribution, narration inputs, reliability curve,
 * and the observed restriction reasons — the last of which is the one panel on
 * this screen that is an *observation* rather than a model output, and is
 * labelled with the grain ONS reports it at.
 *
 * Nothing in here is copy. A driver is a `code` and two readings; the words
 * live in `src/i18n/copy.*.ts`, keyed by that code. The two exceptions are
 * both deliberate:
 *
 *  - `entityLabel` is an ONS identifier (`CJU_MAPLN`), not a name we chose.
 *  - `description` is `dsc_restricao` verbatim from ONS — displayable
 *    evidence, never a vocabulary. It arrives in Portuguese because ONS wrote
 *    it in Portuguese, and translating a source record would be inventing one.
 */

import { TARGET_DATE } from "./grid";
import type {
  AttributedDriver,
  ExplainFixture,
  ObservedReason,
  ReliabilityPoint,
  SubsystemCode,
  Technology,
} from "./types";

/** A quantity reading, written by the reader's locale rather than by us. */
function quantity(
  value: number,
  decimals = 0,
  unit?: string,
  signed?: boolean,
): AttributedDriver["observed"] {
  return { kind: "quantity", value, decimals, unit, signed };
}

const NE_WIND_DRIVERS: AttributedDriver[] = [
  {
    code: "vre_load_ratio",
    share: 0.31,
    direction: "raises",
    observed: quantity(1.42, 2),
    typical: quantity(0.96, 2),
  },
  {
    code: "export_headroom",
    share: 0.25,
    direction: "raises",
    observed: quantity(310, 0, "MW"),
    typical: quantity(1900, 0, "MW"),
  },
  {
    code: "overnight_load_level",
    share: 0.18,
    direction: "raises",
    observed: quantity(8.1, 1, "GW"),
    typical: quantity(9.4, 1, "GW"),
  },
  {
    code: "hub_wind_speed",
    share: 0.14,
    direction: "raises",
    observed: quantity(11.8, 1, "m/s"),
    typical: quantity(8.7, 1, "m/s"),
  },
  {
    code: "day_of_week",
    share: 0.07,
    direction: "raises",
    observed: { kind: "term", term: "weekend" },
    typical: { kind: "term", term: "weekday" },
  },
  {
    code: "other",
    share: 0.05,
    direction: "lowers",
    observed: { kind: "none" },
    typical: { kind: "none" },
  },
];

const NE_SOLAR_DRIVERS: AttributedDriver[] = [
  {
    code: "midday_net_load",
    share: 0.34,
    direction: "raises",
    observed: quantity(3.2, 1, "GW"),
    typical: quantity(5.1, 1, "GW"),
  },
  {
    code: "export_headroom",
    share: 0.22,
    direction: "raises",
    observed: quantity(480, 0, "MW"),
    typical: quantity(1900, 0, "MW"),
  },
  {
    code: "clear_sky_index",
    share: 0.19,
    direction: "raises",
    observed: quantity(0.94, 2),
    typical: quantity(0.78, 2),
  },
  {
    code: "installed_pv",
    share: 0.12,
    direction: "raises",
    observed: quantity(1.4, 1, "GW", true),
    typical: quantity(0.6, 1, "GW", true),
  },
  {
    code: "hydro_flexibility",
    share: 0.08,
    direction: "lowers",
    observed: quantity(2.1, 1, "GW"),
    typical: quantity(1.3, 1, "GW"),
  },
  {
    code: "other",
    share: 0.05,
    direction: "lowers",
    observed: { kind: "none" },
    typical: { kind: "none" },
  },
];

const GENERIC_DRIVERS: AttributedDriver[] = [
  {
    code: "vre_load_ratio",
    share: 0.29,
    direction: "raises",
    observed: quantity(0.71, 2),
    typical: quantity(0.64, 2),
  },
  {
    code: "load_level",
    share: 0.24,
    direction: "lowers",
    observed: quantity(12.6, 1, "GW"),
    typical: quantity(11.9, 1, "GW"),
  },
  {
    code: "import_position",
    share: 0.21,
    direction: "lowers",
    observed: { kind: "term", term: "importing" },
    typical: { kind: "term", term: "balanced" },
  },
  {
    code: "clear_sky_index",
    share: 0.14,
    direction: "raises",
    observed: quantity(0.81, 2),
    typical: quantity(0.74, 2),
  },
  {
    code: "day_of_week",
    share: 0.07,
    direction: "raises",
    observed: { kind: "term", term: "weekend" },
    typical: { kind: "term", term: "weekday" },
  },
  {
    code: "other",
    share: 0.05,
    direction: "lowers",
    observed: { kind: "none" },
    typical: { kind: "none" },
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
    // The two drivers the narration is about, and how much of the attributed
    // magnitude they carry between them. The sentence itself is the screen's
    // to compose, per locale — see `ExplainFixture.narration`.
    narrationTopShare: drivers[0].share + drivers[1].share,
    reliability: RELIABILITY,
    reliabilitySampleHours: RELIABILITY.reduce((acc, p) => acc + p.hourCount, 0),
    reliabilityWindowFrom: "2024-04-01",
    reliabilityWindowTo: "2026-08-27",
    // The whole reliability window predates ingestion go-live, so it is scored
    // against ONS's *current* restatement of the past.
    reliabilityFidelity: "revision_optimistic",
    observedReasons: subsystem === "NE" ? NE_REASONS : GENERIC_REASONS,
    observedReasonsDate: "2026-08-27",
  };
}
