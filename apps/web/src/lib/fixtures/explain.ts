/**
 * Explain fixtures: driver attribution, narration inputs, and the observed
 * restriction reasons — the last of which is the one panel on this screen that
 * is an *observation* rather than a model output, and is labelled with the
 * grain ONS reports it at.
 *
 * Nothing in here is copy. A driver is a `code`, a `φ`, a headline feature and
 * two readings of it; the words live in `src/i18n/copy.*.ts`, keyed by that
 * code. The three exceptions are all deliberate:
 *
 *  - `entityLabel` is an ONS identifier (`CJU_MAPLN`), not a name we chose.
 *  - `headlineFeature` is a feature name from the model's own artifact
 *    (`proxy_renewable_load_ratio`), which is the same kind of identifier —
 *    and the narration already puts feature names in front of a reader, in
 *    both locales, for the same reason.
 *  - `description` is `dsc_restricao` verbatim from ONS — displayable
 *    evidence, never a vocabulary. It arrives in Portuguese because ONS wrote
 *    it in Portuguese, and translating a source record would be inventing one.
 *
 * **All eight groups, ranked, every time.** The `share >= 0.03` cut, the
 * six-row cap and the merge into `other` are the client's display rule and
 * live in `lib/driver-rows.ts`. A fixture that returned six rows would have
 * hidden the merge — and with it the only row that can read `"mixed"`.
 */

import { TARGET_DATE } from "./grid";
import type {
  AttributedDriver,
  ExplainFixture,
  ObservedReason,
  SubsystemCode,
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

/**
 * Nordeste: a large, one-sided day, with a remainder that cancels.
 *
 * Seven groups clear `share >= 0.03` and the cap is six, so `recent_history`
 * falls into the remainder beside `data_conditions` — and they push opposite
 * ways. `Σ|φ| = 24` against `|Σφ| = 8`, so `24 > 1.5 × 8` and the merged row
 * refuses to claim a direction. This is the fixture that exercises `"mixed"`,
 * and it is the only place in the product where the word can appear.
 *
 * `calendar_season` is the categorical one: its declared headline feature is
 * `calendar_is_weekend`, which has no number to print, so it reads as a term.
 */
const NE_DRIVERS: AttributedDriver[] = [
  {
    code: "net_surplus",
    phiMwh: 128,
    share: 0.31,
    direction: "raises",
    headlineFeature: "proxy_renewable_load_ratio",
    observed: quantity(1.42, 2),
    typical: quantity(0.96, 2),
    hourDisagreement: 1.1,
    demoted: false,
  },
  {
    code: "renewable_resource",
    phiMwh: 91,
    share: 0.22,
    direction: "raises",
    headlineFeature: "weather_expected_wind_mwh",
    observed: quantity(4310, 0, "MWh"),
    typical: quantity(3120, 0, "MWh"),
    hourDisagreement: 0.4,
    demoted: false,
  },
  {
    code: "demand_level",
    phiMwh: -58,
    share: 0.14,
    direction: "lowers",
    headlineFeature: "programmed_load_mwh",
    observed: quantity(12.6, 1, "GWh"),
    typical: quantity(11.9, 1, "GWh"),
    hourDisagreement: 0.5,
    demoted: false,
  },
  {
    code: "export_stress",
    phiMwh: 45,
    share: 0.11,
    direction: "raises",
    headlineFeature: "observed_export_utilisation_mean_24h_to_cutoff",
    observed: quantity(0.94, 2),
    typical: quantity(0.71, 2),
    hourDisagreement: 0.6,
    // A `demote` rule fired on this group. It is still ranked here, still
    // counted in the shares and its `φ` is untouched — a rule may never change
    // any of those, and may never delete a driver — so the flag travels with
    // the row and `lib/driver-rows.ts` puts it below the fold.
    demoted: true,
  },
  {
    // The group whose hours disagree: it raises the forecast on the morning
    // ramp and lowers it on the evening one, and nets out to +37.
    code: "ramp_shape",
    phiMwh: 37,
    share: 0.09,
    direction: "raises",
    headlineFeature: "weather_expected_vre_ramp_1h",
    observed: quantity(1.4, 1, "GW", true),
    typical: quantity(0.6, 1, "GW", true),
    hourDisagreement: 2.4,
    demoted: false,
  },
  {
    code: "calendar_season",
    phiMwh: 29,
    share: 0.07,
    direction: "raises",
    headlineFeature: "calendar_is_weekend",
    observed: { kind: "term", term: "weekend" },
    typical: { kind: "term", term: "weekday" },
    hourDisagreement: 0.2,
    demoted: false,
  },
  {
    code: "recent_history",
    phiMwh: -16,
    share: 0.04,
    direction: "lowers",
    headlineFeature: "observed_constrained_off_total_7d_mwh",
    observed: quantity(1840, 0, "MWh"),
    typical: quantity(2310, 0, "MWh"),
    hourDisagreement: 0.9,
    demoted: false,
  },
  {
    code: "data_conditions",
    phiMwh: 8,
    share: 0.02,
    direction: "raises",
    headlineFeature: "weather_centroid_coverage",
    observed: quantity(0.86, 2),
    typical: quantity(0.99, 2),
    hourDisagreement: 0.3,
    demoted: false,
  },
];

/**
 * The quieter subsystems: a smaller day, and a remainder that agrees with
 * itself.
 *
 * All eight clear the share cut here, so the cap is what merges the last two —
 * and both lower the forecast, so `Σ|φ| = |Σφ| = 19` and the merged row keeps
 * its sign. The contrast with `NE_DRIVERS` is the point: `"mixed"` is a
 * property of a particular remainder, not a label the merge always applies.
 */
const GENERIC_DRIVERS: AttributedDriver[] = [
  {
    code: "net_surplus",
    phiMwh: 71,
    share: 0.26,
    direction: "raises",
    headlineFeature: "proxy_renewable_load_ratio",
    observed: quantity(0.71, 2),
    typical: quantity(0.64, 2),
    hourDisagreement: 0.8,
    demoted: false,
  },
  {
    code: "demand_level",
    phiMwh: -55,
    share: 0.2,
    direction: "lowers",
    headlineFeature: "programmed_load_mwh",
    observed: quantity(9.4, 1, "GWh"),
    typical: quantity(8.1, 1, "GWh"),
    hourDisagreement: 0.6,
    demoted: false,
  },
  {
    code: "renewable_resource",
    phiMwh: 46,
    share: 0.17,
    direction: "raises",
    headlineFeature: "weather_expected_wind_mwh",
    observed: quantity(1180, 0, "MWh"),
    typical: quantity(940, 0, "MWh"),
    hourDisagreement: 0.5,
    demoted: false,
  },
  {
    code: "export_stress",
    phiMwh: -35,
    share: 0.13,
    direction: "lowers",
    headlineFeature: "observed_export_utilisation_mean_24h_to_cutoff",
    observed: { kind: "term", term: "importing" },
    typical: { kind: "term", term: "balanced" },
    hourDisagreement: 0.4,
    demoted: false,
  },
  {
    code: "calendar_season",
    phiMwh: 27,
    share: 0.1,
    direction: "raises",
    headlineFeature: "calendar_is_weekend",
    observed: { kind: "term", term: "weekend" },
    typical: { kind: "term", term: "weekday" },
    hourDisagreement: 0.2,
    demoted: false,
  },
  {
    code: "ramp_shape",
    phiMwh: -19,
    share: 0.07,
    direction: "lowers",
    headlineFeature: "weather_expected_vre_ramp_1h",
    observed: quantity(0.4, 1, "GW", true),
    typical: quantity(0.7, 1, "GW", true),
    hourDisagreement: 2.1,
    demoted: false,
  },
  {
    code: "recent_history",
    phiMwh: -11,
    share: 0.04,
    direction: "lowers",
    headlineFeature: "observed_constrained_off_total_7d_mwh",
    observed: quantity(160, 0, "MWh"),
    typical: quantity(240, 0, "MWh"),
    hourDisagreement: 0.3,
    demoted: false,
  },
  {
    code: "data_conditions",
    phiMwh: -8,
    share: 0.03,
    direction: "lowers",
    headlineFeature: "weather_centroid_coverage",
    observed: quantity(0.98, 2),
    typical: quantity(0.99, 2),
    hourDisagreement: 0.2,
    demoted: false,
  },
];

/*
 * The reliability curve used to live here. It is a property of the *model* and
 * not of the day, so it moved to `fixtures/model-card.ts` when
 * `docs/specs/api-surface.md` §9 gave it its own endpoint: this object is the
 * per-day payload, and a curve that changes weekly does not belong on a daily
 * cache key.
 */

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

/**
 * One attribution per subsystem-day.
 *
 * No technology argument, because there is no per-technology head to explain.
 * This used to be `buildExplain(subsystem, technology)` and returned a
 * different ranking for NE wind than for NE solar — two explanations of one
 * prediction, which is one more than the model can produce.
 */
export function buildExplain(subsystem: SubsystemCode): ExplainFixture {
  const drivers = subsystem === "NE" ? NE_DRIVERS : GENERIC_DRIVERS;
  return {
    subsystem,
    targetDate: TARGET_DATE,
    drivers,
    // The two groups the narration is about, and how much of the attributed
    // movement they carry between them. The sentence itself is the screen's to
    // compose, per locale — see `ExplainFixture.narration`.
    narrationTopShare: drivers[0].share + drivers[1].share,
    observedReasons: subsystem === "NE" ? NE_REASONS : GENERIC_REASONS,
    observedReasonsDate: "2026-08-27",
  };
}
