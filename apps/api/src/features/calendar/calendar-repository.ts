/**
 * Loading the calendar — once per version, and never over an existing one.
 *
 * The same immutability discipline as `centroid-set-repository.ts`, for the
 * same class of reason. A centroid set may not move because weather has already
 * been ingested at its points; a calendar version may not move because features
 * have already been *trained* on its days. If a `holidays` upgrade moved
 * Carnival by a day and the loader silently overwrote `br_calendar_v1`, then
 * every past feature row would quietly restate the next time anyone rebuilt,
 * the deployed model would keep scoring against the old geometry of the year,
 * and nothing in the system would report it.
 *
 * So there are three outcomes, and only three:
 *
 * - **Not loaded yet** — write the generation row and its days.
 * - **Loaded, identical digest** — this is the acceptance condition the spec
 *   asks for ("regenerating at the pinned version reproduces the stored table
 *   exactly"), so it succeeds and writes nothing.
 * - **Loaded, different digest** — refuse, and say what to do instead: cut
 *   `br_calendar_v2`, which is a new feature-set version and a retrain. A
 *   non-empty diff over past dates is a retrain trigger; that is the whole
 *   reason this is data.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../../database/connection.js";
import { featureCalendarDay, featureCalendarGeneration } from "../../database/schema.js";
import { BadInputError } from "../../errors.js";
import {
  CALENDAR_VERSION,
  type CalendarArtifact,
  calendarDigest,
  loadCalendarArtifact,
} from "./calendar.js";

/**
 * A loaded calendar version cannot be restated.
 *
 * Named after what it refuses rather than folded into a bare `BadInputError`,
 * exactly as `CentroidSetImmutableError` is: the two refusals are the same
 * refusal one layer apart, and a caller catching one should be able to see that.
 */
export class CalendarImmutableError extends BadInputError {
  constructor(message: string) {
    super(message);
    this.name = "CalendarImmutableError";
  }
}

export interface LoadCalendarResult {
  version: string;
  /** False when the stored calendar already matched — the acceptance condition. */
  loaded: boolean;
  digest: string;
  dayCount: number;
}

interface GenerationRow {
  version: string;
  generator: string;
  digest: string;
  day_from: string;
  day_to: string;
  day_count: number;
}

/** What is stored under a version, or null if that version was never loaded. */
export async function readCalendarGeneration(
  db: Database,
  version: string = CALENDAR_VERSION,
): Promise<GenerationRow | null> {
  const [row] = await db.execute<GenerationRow & Record<string, unknown>>(
    sql`select * from feature_calendar_generation where version = ${version}`,
  );
  return row ?? null;
}

/**
 * The digest of what is actually in the table, recomputed from the rows.
 *
 * Not the stored `digest` column — that is the claim, and this is the
 * measurement. The two are compared by `database-calendar.test.ts`, which is
 * how "the table is the artifact" stops being an assumption about the loader.
 */
export async function storedCalendarDigest(
  db: Database,
  version: string = CALENDAR_VERSION,
): Promise<string> {
  const rows = await db.execute<{
    day: string;
    uf: string;
    name: string;
    category: "public" | "optional";
  }>(sql`
    select to_char(day, 'YYYY-MM-DD') as day, uf, name, category
    from feature_calendar_day
    where calendar_version = ${version}
    order by day, uf, category, name
  `);
  return calendarDigest([...rows]);
}

/** Write a calendar version, or confirm the stored one is unchanged. */
export async function loadCalendar(
  db: Database,
  artifact: CalendarArtifact = loadCalendarArtifact(),
): Promise<LoadCalendarResult> {
  const digest = calendarDigest(artifact.days);
  const existing = await readCalendarGeneration(db, artifact.version);

  if (existing) {
    if (existing.digest === digest) {
      return {
        version: artifact.version,
        loaded: false,
        digest,
        dayCount: existing.day_count,
      };
    }
    throw new CalendarImmutableError(
      `${artifact.version} is already loaded with a different calendar ` +
        `(stored ${existing.digest.slice(0, 19)}, generated ${digest.slice(0, 19)}). ` +
        "A calendar version is immutable once loaded: features have been built " +
        "from those days, and a moveable feast that moved restates them all. " +
        "Review the diff — if it touches a past date it is a retrain trigger — " +
        "and load it as a new version rather than over this one.",
    );
  }

  await db.transaction(async (tx) => {
    await tx.insert(featureCalendarGeneration).values({
      version: artifact.version,
      generator: artifact.generator,
      digest,
      dayFrom: artifact.dayFrom,
      dayTo: artifact.dayTo,
      dayCount: artifact.days.length,
    });
    // Chunked because the artifact carries a decade of days across 27 states and
    // a single statement's parameter count is finite.
    const CHUNK = 500;
    for (let index = 0; index < artifact.days.length; index += CHUNK) {
      await tx.insert(featureCalendarDay).values(
        artifact.days.slice(index, index + CHUNK).map((day) => ({
          calendarVersion: artifact.version,
          day: day.day,
          uf: day.uf,
          name: day.name,
          category: day.category,
        })),
      );
    }
  });

  return {
    version: artifact.version,
    loaded: true,
    digest,
    dayCount: artifact.days.length,
  };
}
