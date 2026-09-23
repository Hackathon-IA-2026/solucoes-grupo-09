/**
 * The four subsystems over one **settled civil day** — the day-axis twin of
 * `grid-now.ts`.
 *
 * **Why a second read rather than a `date` on the first.** `GET /v1/grid/now`
 * answers "the last 24 settled hours as of now", and its window is *found*: it
 * reads the latest hour every subsystem has settled and counts back from there.
 * A `now` that takes a day is a contradiction, and bolting one on would leave
 * `latest_settled_hour` and `lag_hours` — the two fields that make `now` mean
 * anything — describing a clock the caller did not ask about.
 *
 * So this is the same four figures over a window the caller *states*. It keeps
 * what a day can answer, drops what only "now" can, and adds the one thing a
 * day has that a rolling window does not: how much of it has settled.
 *
 * **An empty day is a 200.** A day that settled with no curtailment in a
 * subsystem is a measurement, not an absence — `honesty.md` — so the figure is
 * a zero and `peakHourMwh` is `null` beside a stated reason, which is the pair
 * the schema makes unrepresentable as a bare null. A day with no settled hour
 * at all is a different sentence and this read says so with `settledHours: 0`,
 * leaving the screen to tell the two apart rather than guessing here.
 *
 * Everything else is `grid-now.ts`'s, deliberately: the same canonical view,
 * the same `applyAxes` inside the same `readOnly`, the same national total
 * carrying `sum_of_four` on the object because observations add exactly and the
 * addition is stated rather than assumed.
 */

import { SUBSYSTEMS } from "@wattsteer/core/constants";
import { sql } from "drizzle-orm";
import { canonicalCurtailmentByReportingEntity } from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import { readOnly } from "./read-only.js";
import { applyAxes, readGoLive } from "./scope.js";
import { type VintageFidelity, vintageFidelity } from "./vintage.js";

export interface SubsystemDayObservation {
  subsystem: SubsystemCode;
  constrainedOffMwh: number;
  /** `null` where the day settled with no curtailment here. Never a zero. */
  peakHourMwh: number | null;
  split: { windMwh: number; solarMwh: number };
}

export interface GridDayObservation {
  asOf: Date;
  dataVersion: string;
  vintageFidelity: VintageFidelity;
  /** How many of the day's 24 hours have any settled row. */
  settledHours: number;
  /** All four, in `SUBSYSTEMS` display order. */
  subsystems: SubsystemDayObservation[];
  nationalConstrainedOffMwh: number;
}

interface DayRow {
  [column: string]: unknown;
  subsystem: string;
  day_mwh: number | string | null;
  peak_hour_mwh: number | string | null;
  wind_mwh: number | string | null;
  solar_mwh: number | string | null;
  max_data_version: number | string | null;
}

const number = (value: number | string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

export async function readGridDay(
  db: Database,
  query: { asOf: Date; from: Date; to: Date },
): Promise<GridDayObservation> {
  return readOnly(db, async (tx) => {
    // The vintage axis on the transaction, not in the query: the view reads
    // `canonical_as_of()` and raises 22023 when it is unset, and there is no
    // path through this function that reaches it without this line.
    await applyAxes(tx, { asOf: query.asOf });

    /*
      The peak hour is `max` over a per-hour sum, so the hour is summed across
      technologies and reporting entities *before* it competes with the other
      hours — an inner grouping rather than `max(constrained_off_mwh)`, which
      would return the largest single entity-technology row and call it the
      hour. The distinction is the whole of what "the day's largest hour" means.
    */
    const rows = await tx.execute<DayRow>(sql`
      with hourly as (
        select
          subsystem,
          valid_time,
          sum(constrained_off_mwh) as hour_mwh,
          sum(constrained_off_mwh) filter (where technology = 'WIND') as wind_mwh,
          sum(constrained_off_mwh) filter (where technology = 'SOLAR') as solar_mwh,
          max(data_version) as max_data_version
        from ${canonicalCurtailmentByReportingEntity}
        where valid_time >= ${query.from.toISOString()}::timestamptz
          and valid_time < ${query.to.toISOString()}::timestamptz
        group by subsystem, valid_time
      )
      select
        subsystem,
        sum(hour_mwh) as day_mwh,
        max(hour_mwh) as peak_hour_mwh,
        sum(wind_mwh) as wind_mwh,
        sum(solar_mwh) as solar_mwh,
        max(max_data_version) as max_data_version
      from hourly
      group by subsystem
    `);

    const bySubsystem = new Map<string, DayRow>();
    for (const row of [...rows]) {
      bySubsystem.set(row.subsystem, row);
    }

    /*
      How much of the day exists, counted over the *distinct hours any
      subsystem settled* rather than per subsystem. A subsystem that curtailed
      nothing all day has no rows and would drag a per-subsystem count to zero
      on a day that is in fact closed — which is the difference between "the
      day has not settled" and "this subsystem settled nothing", and they are
      not the same sentence.
    */
    const hours = await tx.execute<{ settled_hours: number | string }>(sql`
      select count(distinct valid_time)::int as settled_hours
      from ${canonicalCurtailmentByReportingEntity}
      where valid_time >= ${query.from.toISOString()}::timestamptz
        and valid_time < ${query.to.toISOString()}::timestamptz
    `);
    const [counted] = [...hours];

    const subsystems: SubsystemDayObservation[] = [];
    let version = 0;
    for (const { code } of SUBSYSTEMS) {
      const row = bySubsystem.get(code);
      version = Math.max(version, number(row?.max_data_version));
      subsystems.push({
        subsystem: code,
        constrainedOffMwh: number(row?.day_mwh),
        // `null` and not zero, and only where there is no row at all: a
        // subsystem that settled hours with zero in them has a zero peak,
        // which is a measurement. `honesty.md`.
        peakHourMwh: row === undefined ? null : number(row.peak_hour_mwh),
        split: { windMwh: number(row?.wind_mwh), solarMwh: number(row?.solar_mwh) },
      });
    }

    const goLiveAt = await readGoLive(tx, "curtailment-by-reporting-entity");

    return {
      asOf: query.asOf,
      dataVersion: String(version),
      // The window's *start* decides the fidelity, per `vintage.ts`: one
      // pre-go-live hour makes the whole day a restatement of ONS's current
      // belief rather than what was knowable at the time.
      vintageFidelity: vintageFidelity(query.from, goLiveAt),
      settledHours: Number(counted?.settled_hours ?? 0),
      subsystems,
      // Observations add exactly. This is the addition, stated.
      nationalConstrainedOffMwh: subsystems.reduce(
        (total, entry) => total + entry.constrainedOffMwh,
        0,
      ),
    };
  });
}
