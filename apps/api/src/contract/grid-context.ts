import { sql } from "drizzle-orm";
import {
  canonicalCurtailmentByReportingEntity,
  canonicalProgrammedLoad,
  canonicalSystemContext,
  canonicalSystemExchange,
} from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import { readOnly } from "./read-only.js";
import { applyAxes } from "./scope.js";

/**
 * What ONS **planned** for a day, beside what the grid **did**.
 *
 * ## Why this read exists
 *
 * Every screen in this product shows a WattSteer number against a settled one.
 * That is one comparison, and a reviewer asking "is the model any good?" is
 * entitled to the other: the day-ahead programme ONS itself published, which is
 * the operational plan the grid was actually run towards. Read against it, a
 * curtailment forecast stops being a number with an outcome beside it and
 * becomes a number with an outcome *and an intention* beside it — and the
 * question "was this a bad forecast or an unusual day?" acquires evidence.
 *
 * ## Nothing here is a WattSteer figure
 *
 * Both series are ONS's. `canonical_programmed_load` is
 * `carga-energia-programada`, the genuine day-ahead load programme;
 * `canonical_system_context` is the settled energy balance. The only
 * arithmetic in this module is a subtraction between two series of the same
 * unit (MWh) at the same grain (the subsystem-hour), and it is the one
 * arithmetic that is safe here for the reason the national observed total is
 * safe: **measurements add exactly**.
 *
 * There is deliberately no comparison against `canonical_day_ahead_balance`.
 * DESSEM publishes instantaneous MW at a half-hourly grain and the settled
 * balance is hourly MWh; putting the two on one axis would need a conversion
 * this module is not the place to decide, and a chart that quietly integrates
 * power into energy is exactly the kind of wrong that looks right.
 *
 * ## An absence is never a zero, and here it is usually an absence
 *
 * The programme for a day is published on D−1 and the settlement lands hours
 * after the fact, so *most* hours this read covers have one side and not the
 * other. Every field is therefore nullable, and the day's deviation refuses to
 * exist unless both sides cover the same hours: a deviation over the four hours
 * that happen to overlap is a measurement of those four hours, and it would be
 * read as a measurement of the day.
 */

export interface ContextHourRow {
  validTime: Date;
  programmedLoadMwh: number | null;
  observedLoadMwh: number | null;
  observedWindMwh: number | null;
  observedSolarMwh: number | null;
  observedHydroMwh: number | null;
  observedThermalMwh: number | null;
  observedNetExchangeMwh: number | null;
  /**
   * ONS's `val_disponibilidade`, added across the subsystem's reporting
   * entities for this hour.
   *
   * A **power**. It adds across entities at one instant, which is what this is,
   * and never across hours — a day's "total availability" in MW is twenty-four
   * times a number with no meaning, which is why there is no day figure for it
   * below and why `canonical-views.ts` says the same thing where the column is
   * declared.
   */
  availableCapacityMw: number | null;
}

export type DeviationUnavailableReason =
  | "no_programme_published"
  | "day_not_settled"
  | "partial_overlap";

export interface ContextDayRow {
  programmedLoadMwh: number | null;
  observedLoadMwh: number | null;
  deviationMwh: number | null;
  deviationUnavailableReason: DeviationUnavailableReason | null;
  hoursCompared: number;
}

export interface CorridorDayRow {
  fromSubsystem: SubsystemCode;
  toSubsystem: SubsystemCode;
  verifiedMwh: number | null;
  programmedMwh: number | null;
  hoursSettled: number;
}

export interface GridContextObservation {
  subsystem: SubsystemCode;
  asOf: Date;
  hours: ContextHourRow[];
  day: ContextDayRow;
  corridors: CorridorDayRow[];
  /** The freshest ingestion instant behind the answer, for the ETag. */
  latestIngestedAt: Date | null;
}

/** Postgres hands back numerics as strings; `null` stays `null`. */
const numeric = (value: number | string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

interface HourRow {
  [column: string]: unknown;
  valid_time: string;
  programmed_load_mwh: number | string | null;
  observed_load_mwh: number | string | null;
  observed_wind_mwh: number | string | null;
  observed_solar_mwh: number | string | null;
  observed_hydro_mwh: number | string | null;
  observed_thermal_mwh: number | string | null;
  observed_net_exchange_mwh: number | string | null;
  available_capacity_mw: number | string | null;
  latest_ingested_at: string | null;
}

interface CorridorRow {
  [column: string]: unknown;
  from_subsystem: SubsystemCode;
  to_subsystem: SubsystemCode;
  verified_mwh: number | string | null;
  programmed_mwh: number | string | null;
  hours_settled: number | string;
  latest_ingested_at: string | null;
}

/**
 * The day's three figures, from the hours.
 *
 * Kept out of the query because the interesting part is not the sum — it is the
 * four ways it may refuse to exist, and a `case` expression in SQL is a worse
 * place to read them than a function is.
 */
export function summariseDay(hours: readonly ContextHourRow[]): ContextDayRow {
  const programmed = hours.filter((hour) => hour.programmedLoadMwh !== null);
  const observed = hours.filter((hour) => hour.observedLoadMwh !== null);
  const both = hours.filter(
    (hour) => hour.programmedLoadMwh !== null && hour.observedLoadMwh !== null,
  );
  const sum = (
    rows: readonly ContextHourRow[],
    pick: (hour: ContextHourRow) => number | null,
  ): number | null =>
    rows.length === 0 ? null : rows.reduce((total, hour) => total + (pick(hour) ?? 0), 0);

  const programmedTotal = sum(programmed, (hour) => hour.programmedLoadMwh);
  const observedTotal = sum(observed, (hour) => hour.observedLoadMwh);

  const reason: DeviationUnavailableReason | null =
    programmed.length === 0
      ? "no_programme_published"
      : observed.length === 0
        ? "day_not_settled"
        : // Both sides exist and describe different hours. Naming it separately
          // is the point: "we have no programme" and "we have a programme for
          // hours you have no settlement for" are different states, and only
          // the second is worth waiting out.
          both.length < programmed.length || both.length < observed.length
          ? "partial_overlap"
          : null;

  return {
    programmedLoadMwh: programmedTotal,
    observedLoadMwh: observedTotal,
    deviationMwh:
      reason !== null || programmedTotal === null || observedTotal === null
        ? null
        : observedTotal - programmedTotal,
    deviationUnavailableReason: reason,
    hoursCompared: both.length,
  };
}

export async function readGridContext(
  db: Database,
  query: { asOf: Date; subsystem: SubsystemCode; from: Date; to: Date },
): Promise<GridContextObservation> {
  return readOnly(db, async (tx) => {
    // The vintage axis, on the transaction: the views read `canonical_as_of()`
    // and raise 22023 when it is unset.
    await applyAxes(tx, { asOf: query.asOf });

    // A full outer join, because either side may be the one that exists. An
    // inner join here would silently answer "no programme was published" with
    // "the day is not settled", which are the two states this read is for.
    const hours = await tx.execute<HourRow>(sql`
      select
        coalesce(programme.valid_time, settled.valid_time) as valid_time,
        programme.programmed_load_mwh as programmed_load_mwh,
        settled.load_mwh as observed_load_mwh,
        settled.wind_generation_mwh as observed_wind_mwh,
        settled.solar_generation_mwh as observed_solar_mwh,
        settled.hydro_generation_mwh as observed_hydro_mwh,
        settled.thermal_generation_mwh as observed_thermal_mwh,
        settled.net_exchange_mwh as observed_net_exchange_mwh,
        capacity.available_capacity_mw as available_capacity_mw,
        greatest(programme.ingested_at, settled.ingested_at) as latest_ingested_at
      from (
        select valid_time, programmed_load_mwh, ingested_at
        from ${canonicalProgrammedLoad}
        where subsystem = ${query.subsystem}
          and valid_time >= ${query.from.toISOString()}::timestamptz
          and valid_time < ${query.to.toISOString()}::timestamptz
      ) as programme
      full outer join (
        select valid_time, load_mwh, wind_generation_mwh, solar_generation_mwh,
               hydro_generation_mwh, thermal_generation_mwh, net_exchange_mwh,
               ingested_at
        from ${canonicalSystemContext}
        where subsystem = ${query.subsystem}
          and valid_time >= ${query.from.toISOString()}::timestamptz
          and valid_time < ${query.to.toISOString()}::timestamptz
      ) as settled on settled.valid_time = programme.valid_time
      -- Availability is reported per entity and per technology; the
      -- subsystem's is their sum WITHIN an hour, because a power adds at an
      -- instant. A sum over a column that is NULL for every entity returns
      -- NULL, which is the answer wanted: "nobody reported it" and "zero
      -- megawatts available" are different facts and only one is ever true.
      --
      -- Left-joined rather than part of the full outer join above: an hour with
      -- an availability report and neither a programme nor a settlement is not
      -- an hour this read has anything to say about.
      left join (
        select valid_time, sum(available_capacity_mw) as available_capacity_mw
        from ${canonicalCurtailmentByReportingEntity}
        where subsystem = ${query.subsystem}
          and valid_time >= ${query.from.toISOString()}::timestamptz
          and valid_time < ${query.to.toISOString()}::timestamptz
        group by valid_time
      ) as capacity
        on capacity.valid_time = coalesce(programme.valid_time, settled.valid_time)
      order by 1
    `);

    // Either end of the link: orientation is canonical on the table (`from <
    // to`), so a subsystem asking about its corridors asks about both columns.
    const corridors = await tx.execute<CorridorRow>(sql`
      select
        from_subsystem,
        to_subsystem,
        sum(verified_exchange_mwh) as verified_mwh,
        sum(programmed_exchange_mwh) as programmed_mwh,
        count(*)::int as hours_settled,
        max(ingested_at) as latest_ingested_at
      from ${canonicalSystemExchange}
      where (from_subsystem = ${query.subsystem} or to_subsystem = ${query.subsystem})
        and valid_time >= ${query.from.toISOString()}::timestamptz
        and valid_time < ${query.to.toISOString()}::timestamptz
      group by from_subsystem, to_subsystem
      order by from_subsystem, to_subsystem
    `);

    let latestIngestedAt: Date | null = null;
    const note = (raw: string | null): void => {
      if (raw === null) {
        return;
      }
      const at = new Date(raw);
      if (latestIngestedAt === null || at.getTime() > latestIngestedAt.getTime()) {
        latestIngestedAt = at;
      }
    };

    const rows: ContextHourRow[] = [...hours].map((row) => {
      note(row.latest_ingested_at);
      return {
        validTime: new Date(row.valid_time),
        programmedLoadMwh: numeric(row.programmed_load_mwh),
        observedLoadMwh: numeric(row.observed_load_mwh),
        observedWindMwh: numeric(row.observed_wind_mwh),
        observedSolarMwh: numeric(row.observed_solar_mwh),
        observedHydroMwh: numeric(row.observed_hydro_mwh),
        observedThermalMwh: numeric(row.observed_thermal_mwh),
        observedNetExchangeMwh: numeric(row.observed_net_exchange_mwh),
        availableCapacityMw: numeric(row.available_capacity_mw),
      };
    });

    const links: CorridorDayRow[] = [...corridors].map((row) => {
      note(row.latest_ingested_at);
      return {
        fromSubsystem: row.from_subsystem,
        toSubsystem: row.to_subsystem,
        verifiedMwh: numeric(row.verified_mwh),
        programmedMwh: numeric(row.programmed_mwh),
        hoursSettled: Number(row.hours_settled),
      };
    });

    return {
      subsystem: query.subsystem,
      asOf: query.asOf,
      hours: rows,
      day: summariseDay(rows),
      corridors: links,
      latestIngestedAt,
    };
  });
}
