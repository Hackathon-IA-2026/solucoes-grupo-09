import { config } from "../config.js";
import { createDatabase } from "../database/connection.js";
import {
  CALENDAR_VERSION,
  loadCalendar,
  loadCalendarArtifact,
} from "../features/index.js";

/**
 * Load the materialised Brazilian holiday calendar.
 *
 *     bun run src/scripts/load-calendar.ts
 *     bun run src/scripts/load-calendar.ts --version br_calendar_v2
 *
 * The artifact is produced by `apps/ml/src/wattsteer_ml/calendar_generator.py`
 * at the pinned `holidays` version and checked into
 * `packages/core/fixtures/calendar/`. This script only writes it — no holiday
 * rule is computed on this side, because a second implementation of "when is
 * Corpus Christi" would be a second calendar.
 *
 * Running it twice is safe and is the acceptance condition rather than a
 * no-op worth apologising for: an unchanged calendar reports `unchanged` and
 * writes nothing. A **changed** one under an existing version is refused —
 * review the diff, and if it touches a past date it is a retrain trigger and
 * belongs under a new version.
 */

const args = process.argv.slice(2);
const index = args.indexOf("--version");
const version = index >= 0 ? args[index + 1] : CALENDAR_VERSION;

if (!config.databaseUrl) {
  console.error("DATABASE_URL is required — the calendar is loaded into it");
  process.exit(1);
}

const database = createDatabase(config.databaseUrl);
try {
  const artifact = loadCalendarArtifact(version);
  const result = await loadCalendar(database.db, artifact);
  console.log(
    `${result.version} (${artifact.generator}): ${result.dayCount} days ` +
      `${artifact.dayFrom}..${artifact.dayTo}, ${result.digest} — ` +
      `${result.loaded ? "loaded" : "unchanged, already stored"}`,
  );
} finally {
  await database.close();
}
