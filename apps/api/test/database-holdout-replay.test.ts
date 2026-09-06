import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { readOnly } from "../src/contract/read-only.js";
import { applyAxes } from "../src/contract/scope.js";
import { createDatabase } from "../src/database/connection.js";
import { readForecastDayAhead, readLatestPublished } from "../src/forecast/reads.js";
import { createHoldoutBackfiller } from "../src/jobs/holdout-backfill.js";

/**
 * A `fold_holdout` day answers with numbers — forecaster ticket 23, end to end.
 *
 * The ticket's complaint was that **nothing wrote** a `backfilled_holdout` row:
 * the minting existed in `wattsteer_ml.evaluation.holdout`, the writer existed
 * in `forecast/backfill.ts`, and no caller of either existed anywhere. So
 * `GET /v1/replay` refused `REPLAY_FORECAST_UNAVAILABLE` on exactly the
 * walk-forward test days it exists to show, and the guard in `forecast/reads.ts`
 * governed nothing, because there was never a row for it to exclude.
 *
 * This suite runs the **production write path** — the queue's handler, over a
 * socket to a stand-in modelling service, into real Postgres — and then asks the
 * two questions the ticket asks, each of the code that actually decides it:
 *
 * 1. **The replay clause passes.** `PUBLISHED_DAYS_SQL` is read out of
 *    `apps/ml/src/wattsteer_ml/replay/reads.py` rather than retyped, and run
 *    here verbatim. That statement returning nothing *is*
 *    `REPLAY_FORECAST_UNAVAILABLE` — `replay/calendar.py` refuses on
 *    `evidence.origin_kind is None` — so running the real one is the difference
 *    between proving the refusal is gone and asserting that a paraphrase of it
 *    would have been.
 * 2. **The live-route guard now excludes something.** The same day, through
 *    `readForecastDayAhead`, is still absent. Before this writer ran, that
 *    assertion was vacuous: nothing in the table could have been returned. Here
 *    the row is demonstrably present — the replay clause just found it — and the
 *    day-ahead read still says no.
 *
 * Gated exactly like the other database suites: `WATTSTEER_TEST_DATABASE_URL`
 * supplies the URL and the default `bun test` skips this file.
 *
 * Spin one up:
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** The real backtest payload, from the modelling service's own shared fit. */
const RUN = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "forecast", "holdout-backfill.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const FOLD_ID = RUN.fold_id as string;
const ARTIFACT_ID = RUN.artifact_id as string;
const TARGET_DATE = (
  (RUN.publications as Record<string, unknown>[])[0] as Record<string, unknown>
).target_date as string;

/**
 * The modelling service's own `PUBLISHED_DAYS_SQL`, read off its source.
 *
 * Not a copy. A copy would drift the first time the ordering rule changed —
 * "a record outranks a reconstruction" is a decision that lives in that
 * statement — and this suite would go on passing against a query the product no
 * longer runs. Extracting it means a rename fails here loudly instead.
 */
function publishedDaysSql(): string {
  const source = readFileSync(
    join(import.meta.dir, "..", "..", "ml", "src", "wattsteer_ml", "replay", "reads.py"),
    "utf8",
  );
  const match = source.match(/PUBLISHED_DAYS_SQL = """([\s\S]*?)"""/);
  if (!match?.[1]) {
    throw new Error(
      "PUBLISHED_DAYS_SQL is no longer a triple-quoted constant in " +
        "wattsteer_ml/replay/reads.py; this suite reads the real statement " +
        "rather than a copy of it, so the extraction has to be repaired",
    );
  }
  return match[1];
}

/** A stand-in for the modelling service, over a real socket. */
const serving = (body: string): { url: string; stop: () => void } => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => {
      server.stop(true);
    },
  };
};

const report = JSON.stringify({
  fold_id: FOLD_ID,
  artifact_id: ARTIFACT_ID,
  as_of: "2026-09-04T03:40:00Z",
  runs: [RUN],
  failures: [],
});

const FIRST_RUN = new Date("2026-09-04T03:41:00.000Z");
const SECOND_RUN = new Date("2026-09-11T03:41:00.000Z");
const LATER = new Date("2030-01-01T00:00:00.000Z");

suite("a fold_holdout day, written by the job and read as a replay", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  const service = serving(report);

  /** The queue's handler, exactly as `createWorkerDispatch` builds it. */
  const backfill = (now: Date) =>
    createHoldoutBackfiller({
      db,
      endpoint: { baseUrl: service.url, timeoutMs: 30_000 },
      now: () => now,
    });

  const truncate = async () => {
    await db.execute(sql`truncate table curtailment_forecast_hour`);
    await db.execute(sql`truncate table curtailment_forecast_day`);
  };

  beforeAll(truncate);
  beforeEach(truncate);
  afterAll(async () => {
    await truncate();
    service.stop();
    await handle.close();
  });

  /**
   * The replay's own day query, at one `as_of`.
   *
   * Through `applyAxes` and the canonical view, because that is how the
   * modelling service asks it: `read_calendar_evidence` opens a transaction,
   * writes the axes, and runs this statement. A read that forgot the pin would
   * raise rather than answer, which is the property that makes this a faithful
   * stand-in for the Python caller.
   */
  const replayDays = (asOf: Date) =>
    readOnly(db, async (tx) => {
      await applyAxes(tx, { asOf });
      const rows = await tx.execute<{
        target_date: string;
        origin_kind: string;
        run_label: string;
        feature_set: string;
        gate_profile: string;
      }>(
        sql.raw(
          publishedDaysSql().replace(/\$1|\$2|\$3/g, (token) =>
            token === "$1" ? "'NE'" : `'${TARGET_DATE}'`,
          ),
        ),
      );
      return [...rows];
    });

  it("turns REPLAY_FORECAST_UNAVAILABLE into a resolved fold_holdout day", async () => {
    // The refusal, first — and it is the *absence of a row*, which is exactly
    // what `replay/calendar.py` refuses on. Without this half the test below
    // would prove only that a row can be read, not that it could not be before.
    expect(await replayDays(LATER)).toEqual([]);

    const result = await backfill(FIRST_RUN)({ foldId: FOLD_ID }, () => {});
    expect(result.foldId).toBe(FOLD_ID);
    expect(result.runs[0]?.days).toBe((RUN.publications as unknown[]).length);

    const resolved = await replayDays(LATER);
    expect(resolved).toHaveLength(1);
    // `origin_kind` is what `PROVENANCE_BY_ORIGIN_KIND` maps to `fold_holdout`,
    // and `run_label` is what `windows_for(artifact_id)` reads the card by — so
    // the row names which artifact and which window held the day out.
    expect(resolved[0]?.origin_kind).toBe("backfilled_holdout");
    expect(resolved[0]?.run_label).toBe(ARTIFACT_ID);
    expect(String(resolved[0]?.target_date).slice(0, 10)).toBe(TARGET_DATE);
  });

  it("leaves the day-ahead guard excluding a row that is really there", async () => {
    await backfill(FIRST_RUN)({ foldId: FOLD_ID }, () => {});

    // Present: the replay clause found it a moment ago and finds it here.
    expect(await replayDays(LATER)).toHaveLength(1);

    // Absent from the live route, at every shape it accepts.
    for (const subsystem of ["N", "NE", "S", "SE"] as const) {
      for (const gateProfile of ["gate_early", "gate_late"] as const) {
        expect(
          await readForecastDayAhead(db, {
            subsystem,
            targetDate: TARGET_DATE,
            gateProfile,
            asOf: LATER,
          }),
        ).toBeNull();
      }
    }
    // And `/v1/meta` does not list a reconstruction as something published.
    expect(await readLatestPublished(db, { asOf: LATER })).toEqual([]);
  });

  it("re-scoring the same fold appends a vintage and never a duplicate", async () => {
    await backfill(FIRST_RUN)({ foldId: FOLD_ID }, () => {});
    const second = await backfill(SECOND_RUN)({ foldId: FOLD_ID }, () => {});

    // The artifact id is the fold's, not the run's, so the second pass writes
    // the same `run_label` — which is what makes it a newer vintage of one
    // reconstruction rather than a second, unrankable one beside it.
    expect(second.runs[0]?.artifactId).toBe(ARTIFACT_ID);
    const labels = await db.execute<{ run_label: string; versions: number }>(sql`
      select run_label, count(distinct data_version)::int as versions
      from curtailment_forecast_day
      where origin_kind = 'backfilled_holdout'::forecast_origin_kind
      group by run_label
    `);
    expect([...labels]).toEqual([{ run_label: ARTIFACT_ID, versions: 1 }]);

    // Identical numbers, so the second run is `unchanged` rather than a
    // second `data_version` of the same figures — append-only does not mean
    // append-always, and a bumped version with equal values would make the
    // vintage axis meaningless.
    expect(second.runs[0]?.hoursRevised).toBe(0);
    expect(second.runs[0]?.hoursInserted).toBe(0);
    expect(second.runs[0]?.hoursUnchanged).toBeGreaterThan(0);

    // And the replay still resolves exactly one day, not two.
    expect(await replayDays(LATER)).toHaveLength(1);
  });
});
