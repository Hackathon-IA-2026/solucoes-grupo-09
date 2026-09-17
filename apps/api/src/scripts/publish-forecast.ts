/**
 * Publish one day-ahead forecast, now, outside the schedule.
 *
 * ## The situation this exists for
 *
 * The two publications are repeatable jobs that fire ten minutes after their
 * gate, and that is right: `api-surface.md` decides the forecast is a row a
 * schedule wrote, not an inference a page view triggered. But a gate is a
 * moment, and a promotion is not aligned to it. On 2026-09-16 the gate_early
 * job ran at 12:10 UTC and correctly found nothing promoted; the retrain
 * promoted `dessem_free_v1__gate_early__thr5` nine hours later, at 21:26. The
 * lane was serving and the product had no forecast to serve from it until the
 * next morning — a whole day of `FORECAST_UNAVAILABLE` with a promoted model
 * sitting behind it, and no way to close the gap but to wait.
 *
 * So: a catch-up runner. It is the same publisher the job uses, with the same
 * persistence and the same refusals, run once against a date you name.
 *
 * ## Why re-running is safe
 *
 * `publication.ts` states it: `unchanged` is the re-run case — every digest
 * matched, so the transaction wrote no row and did not inflate `data_version`.
 * That is what makes a redelivery, a manual re-submit and a catch-up run safe,
 * and it is why this script does not need a "are you sure".
 *
 * What it cannot do is publish a row stamped with anything but its gate. The
 * publisher refuses a `published_at` that is not the gate instant for that
 * date, because a row stamped otherwise makes `forecast_origin` a lie — so a
 * catch-up publishes *late*, never *differently*.
 *
 * ## Running it
 *
 *     bun run src/scripts/publish-forecast.ts gate_early [2026-09-18]
 *
 * From inside the deployment, where `WATTSTEER_ML_URL` and `DATABASE_URL`
 * resolve — `railway ssh --service worker`. The date is optional and defaults
 * to tomorrow in Brasília, which is what the schedules ask for.
 */

import { config } from "../config.js";
import { createDatabase } from "../database/connection.js";
import { createForecastPublisher, PUBLICATION_LANES } from "../jobs/publication.js";

const [profile, targetDate] = process.argv.slice(2);

if (profile !== "gate_early" && profile !== "gate_late") {
  console.error("usage: publish-forecast.ts <gate_early|gate_late> [YYYY-MM-DD]");
  process.exit(2);
}
if (!config.databaseUrl) {
  console.error("DATABASE_URL is unset — this writes rows and needs the real one.");
  process.exit(2);
}
if (!config.mlUrl) {
  console.error("WATTSTEER_ML_URL is unset — there is nothing to ask for a forecast.");
  process.exit(2);
}

const database = createDatabase(config.databaseUrl);
const publish = createForecastPublisher({ db: database.db });
const startedAt = Date.now();

try {
  const result = await publish(
    {
      gateProfile: profile,
      lane: PUBLICATION_LANES[profile],
      ...(targetDate === undefined ? {} : { targetDate }),
    },
    // The job reports progress to the queue; there is no queue here.
    () => {},
  );
  console.log(JSON.stringify(result, null, 2));
  console.log(`⏱  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
} catch (cause) {
  // Printed rather than rethrown, because the interesting refusals —
  // `MODEL_UNAVAILABLE` with the lane state in its details, `FORECAST_UNAVAILABLE`
  // with the gate instant — are the answer an operator ran this to get.
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
} finally {
  await database.close();
}
