/**
 * The numbers the whole product agrees on, published once.
 *
 * Everything here is a **constant of the domain or a committed default**, not
 * configuration and not a fixture: a screen, the gateway and the modelling
 * service must all be quoting the same figure or the product contradicts
 * itself in public. `docs/specs/api-surface.md` is explicit that two of these
 * are deliberately *not* endpoints —
 *
 *  - `GET /v1/subsystems` would invite a fifth member of a four-member enum;
 *  - `GET /v1/reference-fleet` would let floor coverage and the forecaster's
 *    `Δ recovered_floor_mwh` be computed against different batteries, which is
 *    exactly what `docs/specs/replay.md` publishes one fleet to prevent.
 *
 * `REFERENCE_FLEET` is *echoed* in `GET /v1/meta` for diagnosability. Echoed,
 * never fetched in order to be used: a caller that reads it over HTTP is a
 * caller that can be served a different battery than the one the number it is
 * looking at was computed against.
 *
 * **Python reads these too.** Not by importing this file — it cannot — but
 * against `fixtures/published-constants/constants.json`, which
 * `packages/core/test/published-constants.test.ts` and
 * `apps/ml/tests/test_published_constants.py` both assert their own side
 * against. `apps/ml/src/wattsteer_ml/constants.py` is the Python definition and
 * the vector is what stops the two drifting.
 */

import type { SubsystemCode } from "./domain.js";

/** A subsystem and the names it is written with. */
export interface SubsystemMeta {
  code: SubsystemCode;
  /** ONS's own display name, untranslated (`docs/domain-model.md` naming rule 2). */
  onsDisplayName: string;
  /** Short label for tight chrome. */
  short: string;
}

/**
 * `Subsystem` — the enum, with ONS's display names.
 *
 * The order is the product's display order, north to south, and the screens
 * render the list in it. `docs/domain-model.md`'s table lists the same four in
 * a different order; a table in prose is not an ordering commitment, and a chip
 * row silently reshuffling is a user-visible change with no reason behind it.
 *
 * The display names are untranslated on purpose: they are ONS's own strings,
 * they appear verbatim in ONS's files, and translating "SUDESTE/CENTRO-OESTE"
 * would make a subsystem unsearchable against the source it came from.
 */
export const SUBSYSTEMS: readonly SubsystemMeta[] = [
  { code: "N", onsDisplayName: "NORTE", short: "N" },
  { code: "NE", onsDisplayName: "NORDESTE", short: "NE" },
  { code: "SE", onsDisplayName: "SUDESTE/CENTRO-OESTE", short: "SE/CO" },
  { code: "S", onsDisplayName: "SUL", short: "S" },
];

/** The four codes, in the same order. */
export const SUBSYSTEM_CODES: readonly SubsystemCode[] = SUBSYSTEMS.map((s) => s.code);

/** The names for one subsystem. Total, because the enum is closed. */
export function subsystemMeta(code: SubsystemCode): SubsystemMeta {
  const found = SUBSYSTEMS.find((s) => s.code === code);
  if (found === undefined) {
    throw new RangeError(`${code} is not a subsystem`);
  }
  return found;
}

/**
 * `curtailment_threshold_mw` at **subsystem** grain, MW.
 *
 * Committed as a default by `docs/domain-model.md` §8.3, configurable, and
 * stamped on every output that used it — because a threshold is what makes an
 * hour "curtailed" at all, and an unstamped number cannot be compared with
 * another one.
 */
export const SUBSYSTEM_THRESHOLD_MW = 5;

/** `curtailment_threshold_mw` at **reporting-entity** grain, MW. Same rules. */
export const REPORTING_ENTITY_THRESHOLD_MW = 1;

/**
 * `max_gap_hours` — how many sub-threshold hours an episode may contain.
 *
 * Zero: one hour below the threshold ends the episode. A non-zero default
 * would silently merge two episodes into one longer one and change every
 * duration the product reports.
 */
export const MAX_GAP_HOURS = 0;

/**
 * The single economic assumption WattSteer puts on screen, R$/MWh.
 *
 * MWh recovered and % avoided are the headline KPIs; money appears **only** as
 * a labelled scenario with its assumed rate visible, because curtailment
 * compensation and pricing are live regulatory questions rather than settled
 * ones. It is a scenario input, never a market price.
 *
 * It lives here rather than in `apps/web` because the optimizer needs it and
 * the optimizer is Python. `docs/specs/flex-optimizer.md` calls this "the
 * single place it is written down" — which was true of the web app and false
 * of the product: the value was readable by exactly one of the two languages
 * that quote it.
 *
 * There is deliberately no formatter beside it. Money is written by the web
 * app's locale-aware `formatBrl`; a second formatter pinned to `pt-BR` used to
 * sit next to the rate, and two formatters that disagree about one rate is the
 * inconsistency a single constant exists to prevent.
 */
export const BRL_PER_MWH = 180;

/** The reference fleet's battery. Fields as `docs/specs/flex-optimizer.md`. */
export interface ReferenceBattery {
  readonly assetType: "battery";
  readonly label: string;
  /** Inverter limit on charge and discharge, MW. */
  readonly maxPowerMw: number;
  readonly energyCapacityMwh: number;
  readonly roundTripEfficiency: number;
  /** Fraction of capacity at the start of the horizon. */
  readonly initialStateOfCharge: number;
}

/** The reference fleet's shiftable load. */
export interface ReferenceShiftableLoad {
  readonly assetType: "shiftable_load";
  readonly label: string;
  /** Connection limit, MW. */
  readonly maxPowerMw: number;
  /** The shiftable portion, MW. Never above `maxPowerMw` or the flat baseline. */
  readonly maxShiftMw: number;
  /** `L` — the window within which a shift must be compensated, hours. */
  readonly shiftWindowHours: number;
  /** A validation input, not a constraint: it fixes the flat baseline. */
  readonly dailyEnergyMwh: number;
}

export interface ReferenceFleet {
  readonly battery: ReferenceBattery;
  readonly shiftableLoad: ReferenceShiftableLoad;
}

/**
 * `REFERENCE_FLEET` — one published battery and one published flexible load.
 *
 * Floor coverage, the forecaster's `Δ recovered_floor_mwh`, the featured-days
 * list and the weekly hot-swap guardrail are all measured against a fleet, and
 * they are only comparable with each other if it is the *same* fleet. So it is
 * one constant in one place, stamped on every aggregate that used it.
 *
 * **The sizes, and why they are not either of the two obvious repairs.** The
 * prototype's default paired 70 MW of shift with 1,200 MWh/day — a 50 MW flat
 * baseline — which `docs/specs/flex-optimizer.md` rejects outright as
 * `SHIFT_EXCEEDS_BASELINE` (a load cannot shed more power than it draws). Both
 * single-field repairs sit on the validity boundary: 70 MW against 1,700 is
 * 98.8 % of the cap and 50 MW against 1,200 is exactly 100 % of it. A constant
 * this many numbers are compared against must not be one rounding away from a
 * `422`, so the energy comes from one repair and the shift from the other,
 * leaving it at 71 % of the cap with headroom and inventing nothing.
 */
export const REFERENCE_FLEET: ReferenceFleet = {
  battery: {
    assetType: "battery",
    label: "Battery",
    maxPowerMw: 100,
    energyCapacityMwh: 300,
    roundTripEfficiency: 0.92,
    initialStateOfCharge: 0.2,
  },
  shiftableLoad: {
    assetType: "shiftable_load",
    label: "Flexible load",
    maxPowerMw: 70,
    maxShiftMw: 50,
    shiftWindowHours: 3,
    dailyEnergyMwh: 1700,
  },
};

/**
 * Where WattSteer's data comes from, and under what licence — published once,
 * as **data**.
 *
 * `docs/specs/api-surface.md` puts this block on `GET /v1/meta`, and
 * `GET /v1/plants` carries the same object because ODbL §4.6 obliges the
 * machine-readable copy of the Derivative Database to say what it is: a
 * recipient who holds the download and not the meta endpoint is still a
 * recipient. One constant rather than two literals is the whole point — an
 * attribution that lived inside each route is an attribution a route can be
 * refactored out of.
 *
 * It is data rather than copy for the reason `docs/specs/i18n.md` gives: the
 * §4.3 notice is bilingual, and a bilingual sentence is assembled by the client
 * from translated strings around these **untranslated** identifiers. `ODbL-1.0`
 * is not a word that gets a Portuguese spelling.
 *
 * The wire shape is `SourceAttribution` in `meta.schema.json`, which stays the
 * authority; `plant-registry.schema.json` `$ref`s it rather than declaring a
 * second one.
 */
export interface SourceAttributionEntry {
  name: string;
  /** SPDX-style, untranslated. The client builds the sentence around it. */
  licence: string;
  url: string;
  /** True where WattSteer's own table is a Derivative Database of this source. */
  derivativeDatabase?: boolean;
  /** Where ODbL §4.6's machine-readable access is discharged. */
  machineReadableAt?: string;
}

/**
 * ONS is CC-BY; ANEEL SIGA is ODbL, and SIGA is the one that carries
 * share-alike.
 *
 * Only SIGA gets `derivativeDatabase` and `machineReadableAt`: the distinction
 * is the whole of `docs/research/plant-registry.md` §7, and flattening the three
 * sources under one licence would either over-claim against ONS or understate
 * the obligation ANEEL's licence actually imposes.
 */
export const SOURCE_ATTRIBUTION: Readonly<Record<string, SourceAttributionEntry>> = {
  ons: {
    name: "ONS Dados Abertos",
    licence: "CC-BY-4.0",
    url: "https://dados.ons.org.br/",
  },
  aneel_siga: {
    name: "ANEEL SIGA — Sistema de Informações de Geração",
    licence: "ODbL-1.0",
    url: "https://dadosabertos.aneel.gov.br/dataset/siga-sistema-de-informacoes-de-geracao-da-aneel",
    derivativeDatabase: true,
    machineReadableAt: "/v1/plants",
  },
  open_meteo: {
    name: "Open-Meteo",
    licence: "CC-BY-4.0",
    url: "https://open-meteo.com/",
  },
};

/** The licence text ANEEL's dataset — and WattSteer's derivative — is under. */
export const ODBL_LICENCE_URL = "https://opendatacommons.org/licenses/odbl/1-0/";

/**
 * ODbL §4.6(b): where the *alterations* are published.
 *
 * The licence offers two ways to discharge §4.6 — a copy of the whole
 * Derivative Database, or a file describing the alterations. WattSteer offers
 * both: this document is the algorithm (the `ceg_core` derivation, the
 * coordinate validation, the ONS join, the as-of capacity reconstruction), and
 * `/v1/plants` is the database.
 */
export const ODBL_ALTERATIONS_AT = "docs/research/plant-registry.md#7";
