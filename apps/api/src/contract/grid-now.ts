import { SUBSYSTEMS } from "@wattsteer/core/constants";
import { sql } from "drizzle-orm";
import {
  canonicalCurtailmentByReportingEntity,
  canonicalLatestCompleteSettledHour,
} from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import { readOnly } from "./read-only.js";
import { applyAxes, readGoLive } from "./scope.js";
import { type VintageFidelity, vintageFidelity } from "./vintage.js";

/**
 * The "right now" readout — observed, and nothing else.
 *
 * `GET /v1/grid/now` is the one product read that needs **no model**: it is
 * settled constrained-off, summed over the last 24 hours and over the latest
 * settled hour, per subsystem. That is what makes it the honest thing to put on
 * a landing page when no artifact is promoted, and it is why this module
 * imports nothing from the modelling side — there is nothing here for the ML
 * service to be unreachable *for*.
 *
 * It reads `canonical_curtailment_by_reporting_entity`, the canonical view, and
 * no base table. The view already owns the `AsOf` pick, the renames, the grain
 * and the unit resolution; re-querying `curtailment_report_hour` here would put
 * a second copy of all four in a product route, which is the drift
 * `src/database/canonical-views.ts` exists to prevent. The subsystem the sums
 * are grouped by is the one the view projects from `reporting_entity`, so this
 * module never learns that a reporting entity has a subsystem at all.
 *
 * ### The latest settled hour is the latest hour settled *everywhere*
 *
 * Defined as the greatest hour for which **all four** subsystems have a settled
 * row, not the greatest hour any subsystem has.
 *
 * The alternative — a national maximum — would leave a subsystem that had not
 * settled that hour yet with no number, and the only shapes available for it
 * are a zero or a lie. `docs/specs/api-surface.md`'s standing rule is that an
 * absence is never a zero, so the readout steps *back* to the hour that is
 * genuinely settled in all four instead. What that costs is freshness when one
 * subsystem lags; what it buys is that `latest_hour_constrained_off_mwh` is
 * always a sum over rows that exist, and that the four numbers on screen are
 * the same hour as each other. The lag is then reported rather than hidden,
 * which is the point of `lag_hours`.
 *
 * The 24-hour figure is a different kind of statement and is honest for a
 * different reason: it is the total over the hours that **were** observed in
 * the window, and an unobserved hour contributes nothing to a sum rather than
 * being asserted as a zero.
 */

/** The two scalars a split is, and never a band (`vocabulary rule 3`). */
export interface TechnologySplitMwh {
  windMwh: number;
  solarMwh: number;
}

/** One subsystem's observed constrained-off, at the two grains the readout has. */
export interface SubsystemNowObservation {
  subsystem: SubsystemCode;
  /** Total over the 24 hours ending with — and including — the latest settled hour. */
  last24hConstrainedOffMwh: number;
  latestHourConstrainedOffMwh: number;
  /** The 24-hour total, split by technology. The two add to it exactly. */
  split: TechnologySplitMwh;
}

/**
 * The national observed total, with its derivation named on the object.
 *
 * `SIN` is structurally unrepresentable as a `Subsystem` (`docs/domain-model.md`
 * §2), and this is the one place a national number legitimately exists:
 * **observations add exactly**, so the sum of the four is the national figure
 * rather than an estimate of it. `derived` is a field and not a comment so that
 * a reader cannot mistake it for an ONS `SIN` row.
 */
export interface NationalNowObservation {
  last24hConstrainedOffMwh: number;
  derived: "sum_of_four";
}

export interface GridNowObservation {
  /** The vintage cut this was read at: what WattSteer had learned by then. */
  asOf: Date;
  latestSettledHour: Date;
  /** `asOf − latestSettledHour`, in hours. Never negative, never a screen's clock. */
  lagHours: number;
  vintageFidelity: VintageFidelity;
  /** The half-open window the 24-hour figures were summed over. */
  window: { from: Date; to: Date };
  /** All four, in `SUBSYSTEMS` display order. */
  subsystems: SubsystemNowObservation[];
  national: NationalNowObservation;
  /**
   * The freshest ingestion instant behind the answer.
   *
   * Not part of the readout: it is what `api-surface.md`'s caching table makes
   * the ETag for this route, because the response moves with ingestion.
   */
  latestIngestedAt: Date;
}

/** How many hours the readout looks back, inclusive of the latest settled hour. */
const WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;

const number = (value: number | string | null): number =>
  value === null ? 0 : Number(value);

/** The aggregate row's shape. Indexed because `execute` takes a row record. */
interface AggregateRow {
  [column: string]: unknown;
  subsystem: SubsystemCode;
  last_24h_mwh: number | string | null;
  latest_hour_mwh: number | string | null;
  wind_mwh: number | string | null;
  solar_mwh: number | string | null;
  latest_ingested_at: string;
}

/**
 * Read the observed "right now".
 *
 * `null` when no hour is settled in all four subsystems under this `asOf` —
 * which is an absence and is answered as one (`DATA_UNAVAILABLE`), never as
 * four zeroes and a made-up hour.
 */
export async function readGridNow(
  db: Database,
  query: { asOf: Date },
): Promise<GridNowObservation | null> {
  return readOnly(db, async (tx) => {
    // The vintage axis, on the transaction rather than in the query: the view
    // reads `canonical_as_of()`, which raises 22023 when it is unset. There is
    // no path through this function that reaches the view without it.
    await applyAxes(tx, { asOf: query.asOf });

    // One canonical read, and the reason it is a view rather than the grouping
    // that used to be written out here is in `canonical-views.ts`: grouping the
    // deduplicated fact view by `valid_time` forced a sort of the entire table
    // — 8.4-9.7 s deployed, on the first call the Overview makes — because that
    // view's `DISTINCT ON` ordering has no index behind it. The view reads
    // `curtailment_report_hour_time` backwards and stops at the first hour with
    // every subsystem in it. Same answer, proven equivalent at three `as_of`
    // cuts and against superseding versions; 1.3 ms instead of 1,026 ms on a
    // reproduction at 864,000 rows.
    const settled = await tx.execute<{ valid_time: string }>(sql`
      select valid_time from ${canonicalLatestCompleteSettledHour}
    `);
    const [latest] = [...settled];
    if (latest === undefined) {
      return null;
    }

    const latestSettledHour = new Date(latest.valid_time);
    const to = new Date(latestSettledHour.getTime() + HOUR_MS);
    const from = new Date(to.getTime() - WINDOW_HOURS * HOUR_MS);

    const aggregates = await tx.execute<AggregateRow>(sql`
      select
        subsystem,
        sum(constrained_off_mwh) as last_24h_mwh,
        sum(constrained_off_mwh)
          filter (where valid_time = ${latestSettledHour.toISOString()}::timestamptz)
          as latest_hour_mwh,
        sum(constrained_off_mwh) filter (where technology = 'WIND') as wind_mwh,
        sum(constrained_off_mwh) filter (where technology = 'SOLAR') as solar_mwh,
        max(ingested_at) as latest_ingested_at
      from ${canonicalCurtailmentByReportingEntity}
      where valid_time >= ${from.toISOString()}::timestamptz
        and valid_time < ${to.toISOString()}::timestamptz
      group by subsystem
    `);

    const bySubsystem = new Map<string, AggregateRow>();
    for (const row of [...aggregates]) {
      bySubsystem.set(row.subsystem, row);
    }

    const subsystems: SubsystemNowObservation[] = [];
    let latestIngestedAt = new Date(0);
    for (const { code } of SUBSYSTEMS) {
      const row = bySubsystem.get(code);
      if (row === undefined) {
        // Unreachable given the `having` clause above — every subsystem has a
        // row at the latest settled hour, and that hour is inside the window.
        // If it ever happens, it is an absence and is answered as one rather
        // than papered over with a zero.
        return null;
      }
      const ingested = new Date(row.latest_ingested_at);
      if (ingested.getTime() > latestIngestedAt.getTime()) {
        latestIngestedAt = ingested;
      }
      subsystems.push({
        subsystem: code,
        last24hConstrainedOffMwh: number(row.last_24h_mwh),
        latestHourConstrainedOffMwh: number(row.latest_hour_mwh),
        split: { windMwh: number(row.wind_mwh), solarMwh: number(row.solar_mwh) },
      });
    }

    const goLiveAt = await readGoLive(tx, "curtailment-by-reporting-entity");

    return {
      asOf: query.asOf,
      latestSettledHour,
      // Clamped at zero because the schema says so and because a negative lag
      // is not a sentence anyone can read. One decimal: the readout is a
      // headline, not an interval arithmetic.
      lagHours:
        Math.round(
          Math.max(0, (query.asOf.getTime() - latestSettledHour.getTime()) / HOUR_MS) *
            10,
        ) / 10,
      // The window's *start* decides the fidelity, per `vintage.ts`: one
      // pre-go-live hour makes the whole 24 a restatement of ONS's current
      // belief rather than what was knowable at the time.
      vintageFidelity: vintageFidelity(from, goLiveAt),
      window: { from, to },
      subsystems,
      national: {
        // Observations add exactly. This is the addition, stated.
        last24hConstrainedOffMwh: subsystems.reduce(
          (total, entry) => total + entry.last24hConstrainedOffMwh,
          0,
        ),
        derived: "sum_of_four",
      },
      latestIngestedAt,
    };
  });
}
