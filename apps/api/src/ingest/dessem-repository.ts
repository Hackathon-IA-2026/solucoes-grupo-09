import { sql } from "drizzle-orm";
import { readGoLive, withAxes } from "../contract/scope.js";
import { type VintageFidelity, vintageFidelity } from "../contract/vintage.js";
import { canonicalDayAheadBalance } from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import { dessemBalanceHalfHour } from "../database/schema.js";
import { PayloadRefusedError } from "../errors.js";
import type { SubsystemCode } from "./normalise.js";
import type { DessemBalanceHalfHour } from "./types.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Bitemporal persistence for the DESSEM day-ahead balance — the platform's
 * first bulk-file **`Forecast`**.
 *
 * The append-and-version algorithm is the shared one (`versioned-write.ts`);
 * what is specific here is the third time axis. Everything else in the platform
 * stores a fact ONS asserted *after* the instant it describes, so the pair
 * (`published_at`, `ingested_at`) is a vintage and nothing more. Here
 * `published_at` also carries information about the *future*: it is the
 * evening-of-D−1 file creation, which is what makes `published_at ≤ gate` a
 * genuine point-in-time filter even over backfilled history, where filtering on
 * `ingested_at` would filter nothing at all
 * (`docs/specs/feature-engineering.md`).
 *
 * So this module refuses to write a row that is not shaped like a forecast, and
 * its read exposes `lead_time` as a derived value rather than a column.
 */

/**
 * Digest of a DESSEM row's stored values, and nothing else.
 *
 * **The day's shortfall is part of the value tuple, and it is encoded sparsely
 * on purpose.** A reference day that ONS first published 46 patamares short
 * and later published whole is a real restatement of those 46 half hours: the
 * numbers may be identical but what the row *says about its day* is not, and
 * if the digest ignored that, the 46 keys would come back `unchanged`, keep
 * `reference_day_patamares = 46` forever and be filtered out of the read while
 * the two new half hours sailed through — a two-row answer for a whole day,
 * which is exactly the quiet wrongness this column exists to prevent.
 *
 * So the shortfall joins the tuple, but only when there is one. A whole day
 * appends nothing, so its digest is byte-identical to the digest this platform
 * has already stored for 70,080 rows: admitting partial days does not restate
 * a single existing row, and the next forced sweep still reports them
 * `unchanged` (data-platform 29).
 */
export function dessemBalanceDigest(row: DessemBalanceHalfHour): string {
  const shortfall = row.referenceDayHalfHours - row.referenceDayPatamares;
  return digestValues([
    row.subsystem,
    row.validTime.toISOString(),
    // The run label is part of the value tuple, not of the vintage: a *different
    // reference day* producing the same half hour would be a different forecast,
    // not a restatement of this one.
    row.referenceDay,
    row.demandMw,
    row.hydroGenerationMw,
    row.smallHydroGenerationMw,
    row.thermalGenerationMw,
    row.smallThermalGenerationMw,
    row.windGenerationMw,
    row.solarGenerationMw,
    row.mmgdGenerationMw,
    row.pumpingConsumptionMw,
    ...(shortfall > 0 ? [`short:${row.referenceDayPatamares}`] : []),
  ]);
}

const SPEC: VersionedTableSpec<
  DessemBalanceHalfHour,
  typeof dessemBalanceHalfHour.$inferInsert
> = {
  table: dessemBalanceHalfHour,
  tableName: "dessem_balance_half_hour",
  keyColumns: ["subsystem", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) => `${row.subsystem}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: dessemBalanceDigest,
  toInsert: (row, version, vintage) => ({
    subsystem: row.subsystem,
    validTime: row.validTime,
    forecastProducer: "ons_dessem" as const,
    runLabel: row.referenceDay,
    demandMw: row.demandMw,
    hydroGenerationMw: row.hydroGenerationMw,
    smallHydroGenerationMw: row.smallHydroGenerationMw,
    thermalGenerationMw: row.thermalGenerationMw,
    smallThermalGenerationMw: row.smallThermalGenerationMw,
    windGenerationMw: row.windGenerationMw,
    solarGenerationMw: row.solarGenerationMw,
    mmgdGenerationMw: row.mmgdGenerationMw,
    pumpingConsumptionMw: row.pumpingConsumptionMw,
    // How short the day was, stated. `canonical_day_ahead_balance` answers
    // whole days unless asked otherwise, and this pair is what it asks.
    referenceDayPatamares: row.referenceDayPatamares,
    referenceDayHalfHours: row.referenceDayHalfHours,
    dataVersion: version.dataVersion,
    // The file's `Last-Modified`: ONS stamps no DESSEM row individually, so the
    // coarsest honest answer is the file, and the precision column says so.
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

export interface DessemBalanceWrite extends VintageStamp {
  rows: DessemBalanceHalfHour[];
  /**
   * CKAN's `created` for the resource these rows came from — when the
   * reference day's file **first** entered the catalogue.
   *
   * Never written and never compared against. It exists so that a day refused
   * for `forecast_integrity` can say *which* of two upstream facts produced
   * it, because the remedies are opposite and data-platform 21 got the split
   * wrong by 59 days for want of this one stamp:
   *
   * - `created` is itself after the reference day → ONS never catalogued a
   *   day-ahead vintage of this day. There is nothing to recover, ever.
   * - `created` is before the day and `published_at` after it → a day-ahead
   *   vintage existed and ONS overwrote it. The instant is recoverable; the
   *   values are not, and they are what the gate would be admitting.
   */
  firstPublishedAt?: Date | null;
}

export type DessemBalanceWriteResult = VersionedWriteResult;

/**
 * Which upstream fact produced a `forecast_integrity` refusal, in ONS's own
 * timestamps — a sentence appended to the refusal, never a decision.
 *
 * Two things fail this check and they are not the same thing. Measured over
 * the whole published history in data-platform 25: **59 of 70** refused days
 * had no catalogue entry at all until after the day had passed — ONS fills
 * gaps in batches, ten missing days at a time, with the days either side of
 * each gap published on their own D−1 evening. The remaining **11** were
 * published on time and the file later overwritten. Only the second kind ever
 * had a day-ahead vintage, and neither kind can be loaded from the bytes in
 * hand, which is why this changes the sentence and not the verdict.
 */
export function upstreamCause(
  validTime: Date,
  firstPublishedAt: Date | null | undefined,
): string {
  if (!firstPublishedAt) {
    return "The catalogue records no first-publication instant for this resource.";
  }
  if (firstPublishedAt.getTime() >= validTime.getTime()) {
    return (
      `ONS first catalogued this file at ${firstPublishedAt.toISOString()}, itself at ` +
      "or after that half hour: the day was published late for the first time, so no " +
      "day-ahead vintage of it was ever offered and none can be recovered."
    );
  }
  return (
    `ONS first catalogued this file at ${firstPublishedAt.toISOString()}, before that ` +
    "half hour, and overwrote it afterwards: a day-ahead vintage existed, but the bytes " +
    "in hand are the rewrite. Stamping them with the earlier instant would admit values " +
    "through a gate that could not have seen them."
  );
}

/**
 * Append the DESSEM rows whose values actually changed. Idempotent.
 *
 * The forecast shape is checked here, before the first insert, rather than left
 * to the table's check constraint. Both exist on purpose: the constraint is the
 * guarantee, and this is the *diagnosis* — a violation reaching Postgres would
 * surface as a constraint name and a row, where the real question is which
 * reference day was published too late and by how much.
 *
 * The day's coverage is checked the same way and for the same reason. One write
 * is one reference day, so every row of it must agree on how much of that day
 * ONS published; rows that disagree would put a day in the table that is
 * partial and whole at once, and the canonical read's whole-day filter would
 * then answer with whichever half of it happened to say 48.
 */
export async function writeDessemBalance(
  db: Database,
  write: DessemBalanceWrite,
): Promise<DessemBalanceWriteResult> {
  const { rows, firstPublishedAt, ...vintage } = write;
  const coverage = new Map<string, string>();
  for (const row of rows) {
    const stated = `${row.referenceDayPatamares}/${row.referenceDayHalfHours}`;
    const first = coverage.get(row.referenceDay);
    if (first === undefined) {
      coverage.set(row.referenceDay, stated);
    } else if (first !== stated) {
      throw new PayloadRefusedError(
        "coverage",
        `DESSEM reference day ${row.referenceDay} is written with rows that disagree ` +
          `about its coverage: ${first} patamares on one row and ${stated} on the ` +
          `${row.validTime.toISOString()} half hour. How much of a day was published ` +
          "is a fact about the day, so every row of it carries the same pair.",
      );
    }
    if (row.validTime.getTime() <= vintage.publishedAt.getTime()) {
      throw new PayloadRefusedError(
        "forecast_integrity",
        `DESSEM reference day ${row.referenceDay} was published at ` +
          `${vintage.publishedAt.toISOString()}, at or after the ` +
          `${row.validTime.toISOString()} half hour it describes. A row with ` +
          "published_at ≥ valid_time is an observation, and this table holds " +
          `forecasts. ${upstreamCause(row.validTime, firstPublishedAt)}`,
      );
    }
  }
  return writeVersioned(db, SPEC, rows, vintage);
}

/** One row of a DESSEM as-of read, with its origin and its derived lead time. */
export interface DessemBalanceAsOfRow extends DessemBalanceHalfHour {
  dataVersion: number;
  forecastProducer: "ons_dessem" | "open_meteo" | "wattsteer";
  publishedAt: Date;
  ingestedAt: Date;
  /**
   * `valid_time − published_at`, in minutes.
   *
   * Derived on read and never stored (`docs/domain-model.md` §4): a stored lead
   * time could disagree with the two timestamps it is computed from.
   */
  leadTimeMinutes: number;
}

export interface DessemBalanceAsOfResult {
  rows: DessemBalanceAsOfRow[];
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

export interface DessemBalanceAsOfQuery {
  asOf: Date;
  from: Date;
  to: Date;
  subsystem?: SubsystemCode;
  /**
   * The gate. Forecast-sourced features are cut on `published_at ≤ gate`, not
   * on `ingested_at` — over backfilled history every row was ingested at
   * go-live, so `AsOf` alone filters nothing, while this genuinely reproduces
   * what was knowable (`docs/specs/feature-engineering.md`).
   */
  publishedAtOrBefore?: Date;
  /**
   * Answer with reference days ONS published short, as well as whole ones.
   *
   * Absent is the read every caller gets today: whole reference days only, the
   * same rows this read answered before partial days were storable at all. A
   * caller that sets it is told how short each day is —
   * `referenceDayPatamares` against `referenceDayHalfHours` on every row —
   * because a partial day is only safe to use by someone who knows it is one
   * (data-platform 29).
   */
  includePartialReferenceDays?: boolean;
}

const MS_PER_MINUTE = 60_000;

/**
 * `AsOf(t)` over the DESSEM balance, optionally cut at a gate.
 *
 * `DISTINCT ON (subsystem, valid_time)` ordered by descending `ingested_at`
 * returns exactly one row per business key or none — the same read as every
 * other fact table, because a forecast's *vintage* behaves like anything else's.
 */
export async function readDessemBalanceAsOf(
  db: Database,
  query: DessemBalanceAsOfQuery,
): Promise<DessemBalanceAsOfResult> {
  const subsystemFilter = query.subsystem
    ? sql`and subsystem = ${query.subsystem}`
    : sql``;

  // The gate is an *axis*, not a filter: `canonical_day_ahead_balance` applies
  // it before choosing a version, because the row wanted is the latest ingested
  // one among those published by the gate — not the latest ingested one,
  // discarded if it turned out to have been published late.
  const axes = {
    asOf: query.asOf,
    publishedAtOrBefore: query.publishedAtOrBefore,
    partialReferenceDays: query.includePartialReferenceDays,
  };

  return withAxes(db, axes, async (tx) => {
    const rows = await tx.execute<{
      subsystem: SubsystemCode;
      valid_time: string;
      forecast_producer: DessemBalanceAsOfRow["forecastProducer"];
      run_label: string;
      data_version: number;
      demand_mw: number;
      hydro_generation_mw: number;
      small_hydro_generation_mw: number;
      thermal_generation_mw: number;
      small_thermal_generation_mw: number;
      wind_generation_mw: number;
      solar_generation_mw: number;
      mmgd_generation_mw: number;
      pumping_consumption_mw: number;
      published_at: string;
      ingested_at: string;
      reference_day_patamares: number;
      reference_day_half_hours: number;
    }>(sql`
      select * from ${canonicalDayAheadBalance}
      where valid_time >= ${query.from.toISOString()}::timestamptz
        and valid_time < ${query.to.toISOString()}::timestamptz
        ${subsystemFilter}
      order by subsystem, valid_time
    `);

    const goLiveAt = await readGoLive(tx, "day-ahead-balance");

    return {
      rows: [...rows].map((row) => {
        const validTime = new Date(row.valid_time);
        const publishedAt = new Date(row.published_at);
        return {
          subsystem: row.subsystem,
          validTime,
          referenceDay: row.run_label,
          forecastProducer: row.forecast_producer,
          demandMw: Number(row.demand_mw),
          hydroGenerationMw: Number(row.hydro_generation_mw),
          smallHydroGenerationMw: Number(row.small_hydro_generation_mw),
          thermalGenerationMw: Number(row.thermal_generation_mw),
          smallThermalGenerationMw: Number(row.small_thermal_generation_mw),
          windGenerationMw: Number(row.wind_generation_mw),
          solarGenerationMw: Number(row.solar_generation_mw),
          mmgdGenerationMw: Number(row.mmgd_generation_mw),
          pumpingConsumptionMw: Number(row.pumping_consumption_mw),
          referenceDayPatamares: Number(row.reference_day_patamares),
          referenceDayHalfHours: Number(row.reference_day_half_hours),
          dataVersion: row.data_version,
          publishedAt,
          ingestedAt: new Date(row.ingested_at),
          leadTimeMinutes: Math.round(
            (validTime.getTime() - publishedAt.getTime()) / MS_PER_MINUTE,
          ),
        };
      }),
      vintageFidelity: vintageFidelity(query.from, goLiveAt),
      goLiveAt,
    };
  });
}
