import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../src/database/connection.js";
import type { HoldoutBackfill } from "../src/forecast/backfill.js";
import {
  createHoldoutBackfiller,
  HOLDOUT_BACKFILL_JOB_ID,
  HOLDOUT_BACKFILL_PATH,
  HOLDOUT_BACKFILL_PATTERN,
  HOLDOUT_BACKFILL_TIME_ZONE,
  HOLDOUT_BACKFILL_TIMEOUT_MS,
} from "../src/jobs/holdout-backfill.js";
import { RETRAIN_PATTERN } from "../src/jobs/retrain.js";
import {
  createWorkerDispatch,
  holdoutBackfillScheduleForQueue,
  type WorkerTask,
} from "../src/jobs/worker-tasks.js";

/**
 * The job that makes a `fold_holdout` day answer with numbers — forecaster 23.
 *
 * `wattsteer_ml.evaluation.holdout` minted the publications and
 * `forecast/backfill.ts` wrote them, and **nothing ran either**: a repository
 * search for a caller found none, so `/v1/replay` refused
 * `REPLAY_FORECAST_UNAVAILABLE` on exactly the walk-forward test days it exists
 * to show. This file is about the caller, and about the two properties a queue
 * entry owns that neither side can:
 *
 * 1. **The write happens on this side.** The modelling service is read-only
 *    against Postgres; it returns the rows and the worker appends them, through
 *    the same parser the served publication goes through.
 * 2. **A run is one instant.** Every day of a fold is written under one
 *    `ingested_at`, so an `AsOf` between two runs sees one whole run and never
 *    half of each — which is the property that makes a superseded replay still
 *    reconstructible at its own as-of.
 *
 * The database is a spy here rather than Postgres: what a real one proves —
 * append-only vintages, the day-ahead guard, and a replayable day where a
 * refusal used to be — is proved in `database-holdout-forecast.test.ts` and
 * `database-holdout-replay.test.ts`, which are the DB-gated suites.
 */

/** A stand-in for the modelling service, over a real socket. */
const serving = (
  handler: (request: Request) => Response | Promise<Response>,
): { url: string; stop: () => void } => {
  const server = Bun.serve({ port: 0, fetch: handler });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => {
      server.stop(true);
    },
  };
};

/**
 * The two-step shape the route has now: a start that answers 202 and a status
 * read that carries the report.
 *
 * The route used to run the child inside the POST and answer with its report.
 * That did not survive the deployment's internal networking — measured
 * 2026-09-22, the call was cut at about 350 s while the child scored for
 * another ninety minutes — and because this route's product *is* its body, a
 * cut connection threw the rows away rather than merely losing a report. These
 * tests follow the handler into the new shape; what each one asserts is
 * unchanged.
 */
const twoStep =
  (
    answer: () => Response,
    onStart?: (body: unknown, path: string) => void,
  ): ((request: Request) => Promise<Response>) =>
  async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      onStart?.(await request.json(), path);
      return Response.json({ fold: "latest", status: "running" }, { status: 202 });
    }
    return answer();
  };

/** No real waiting: the loop's first sleep is otherwise two seconds per test. */
const promptly = { poll: { minMs: 0, maxMs: 0 }, sleep: async (): Promise<void> => {} };

/** The real payload the modelling service's own shared fit emits. */
const RUN = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "forecast", "holdout-backfill.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const report = (runs: unknown[], failures: unknown[] = []) =>
  JSON.stringify({
    fold_id: "F3",
    artifact_id: RUN.artifact_id,
    as_of: "2026-09-04T03:40:00Z",
    runs,
    failures,
  });

const json = (body: string) =>
  new Response(body, { headers: { "content-type": "application/json" } });

/** Records what was handed to the writer, without a database behind it. */
function spy() {
  const written: { backfill: HoldoutBackfill; ingestedAt?: Date }[] = [];
  return {
    written,
    write: async (
      _db: Database,
      backfill: HoldoutBackfill,
      options: { ingestedAt?: Date },
    ) => {
      written.push({ backfill, ...options });
      return {
        foldId: backfill.foldId,
        artifactId: backfill.artifactId,
        days: backfill.publications.length,
        hoursInserted: backfill.publications.length * 96,
        hoursRevised: 0,
        hoursUnchanged: 0,
        daysInserted: backfill.publications.length * 4,
        daysRevised: 0,
        daysUnchanged: 0,
        nationalInserted: backfill.publications.length,
        nationalRevised: 0,
        nationalUnchanged: 0,
      };
    },
  };
}

const db = {} as Database;

describe("the fold's held-out days reach Postgres", () => {
  it("asks the modelling service for a fold and writes what comes back", async () => {
    let asked: unknown = null;
    let path = "";
    const service = serving(
      twoStep(
        () => json(report([RUN])),
        (body, at) => {
          path = at;
          asked = body;
        },
      ),
    );
    const writer = spy();
    try {
      const backfill = createHoldoutBackfiller({
        db,
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
        ...promptly,
        write: writer.write,
        now: () => new Date("2026-09-04T03:41:00.000Z"),
      });

      const result = await backfill({ foldId: "F3" }, () => {});

      expect(path).toBe(HOLDOUT_BACKFILL_PATH);
      expect(asked).toEqual({ fold_id: "F3" });
      expect(result.foldId).toBe("F3");
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]?.days).toBe((RUN.publications as unknown[]).length);
      expect(writer.written).toHaveLength(1);
      expect(writer.written[0]?.backfill.artifactId).toBe(RUN.artifact_id);
    } finally {
      service.stop();
    }
  });

  it("stamps one ingestion instant on the whole run, never one per day", async () => {
    // The vintage axis. Two days of one backfill written at two instants would
    // make an `AsOf` between them see half a run, and a replay pinned there
    // would reconstruct a fold that never existed.
    const service = serving(twoStep(() => json(report([RUN, RUN]))));
    const writer = spy();
    try {
      const backfill = createHoldoutBackfiller({
        db,
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
        ...promptly,
        write: writer.write,
        now: () => new Date("2026-09-04T03:41:00.000Z"),
      });

      await backfill({}, () => {});

      const instants = writer.written.map((one) => one.ingestedAt?.toISOString());
      expect(new Set(instants).size).toBe(1);
      expect(instants[0]).toBe("2026-09-04T03:41:00.000Z");
    } finally {
      service.stop();
    }
  });

  it("omits the fold id when none is asked for, so the service picks", async () => {
    // The scheduled run backfills the newest frozen fold, and *which* fold that
    // is depends on the calendar — which lives on the modelling service. A
    // gateway that computed it would be a second fold calendar.
    let asked: unknown = null;
    const service = serving(
      twoStep(
        () => json(report([RUN])),
        (body) => {
          asked = body;
        },
      ),
    );
    try {
      const backfill = createHoldoutBackfiller({
        db,
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
        ...promptly,
        write: spy().write,
      });
      await backfill({}, () => {});
      expect(asked).toEqual({});
    } finally {
      service.stop();
    }
  });

  it("attaches to a run already in flight rather than failing on its 409", async () => {
    // The defect this shape exists to remove, from the queue's side. A worker
    // that was replaced — or a job redelivered — meets a child that is already
    // scoring the fold, and `HOLDOUT_BACKFILL_IN_PROGRESS` is the service
    // saying "it is started, go and poll it". Read as a failure, the queue
    // retried into the same 409 for as long as the child ran, and the rows it
    // was computing were never collected by anyone.
    let polled = 0;
    const service = serving(async (request: Request): Promise<Response> => {
      if (request.method === "POST") {
        return Response.json(
          {
            error: {
              code: "HOLDOUT_BACKFILL_IN_PROGRESS",
              message: "already being backfilled",
            },
          },
          { status: 409 },
        );
      }
      polled += 1;
      return json(report([RUN]));
    });
    const writer = spy();
    try {
      const backfill = createHoldoutBackfiller({
        db,
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
        ...promptly,
        write: writer.write,
      });

      const result = await backfill({ foldId: "F3" }, () => {});

      expect(polled).toBeGreaterThan(0);
      expect(result.runs).toHaveLength(1);
      expect(writer.written).toHaveLength(1);
    } finally {
      service.stop();
    }
  });

  it("polls the status route until the run stops running", async () => {
    // A long single request is what this replaced, so the property worth
    // holding is that the handler *waits by asking*: the first status read says
    // `running` and carries no rows, and the job must not treat that as an
    // empty fold.
    let reads = 0;
    const service = serving(
      twoStep(() => {
        reads += 1;
        return reads < 3
          ? Response.json({ fold: "F3", status: "running", elapsed_seconds: 1 })
          : json(report([RUN]));
      }),
    );
    const writer = spy();
    try {
      const backfill = createHoldoutBackfiller({
        db,
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
        ...promptly,
        write: writer.write,
      });

      const result = await backfill({ foldId: "F3" }, () => {});

      expect(reads).toBe(3);
      expect(result.runs).toHaveLength(1);
    } finally {
      service.stop();
    }
  });

  it("refuses a run that claims to be anything but a reconstruction", async () => {
    // The envelope check is `parseHoldoutBackfill`'s, and this asserts the job
    // goes through it rather than around it: a counterfactual `published_at`
    // under the served discriminator is the one row this whole ticket exists to
    // make unwritable.
    const forged = { ...structuredClone(RUN), origin_kind: "served" };
    const service = serving(twoStep(() => json(report([forged]))));
    const writer = spy();
    try {
      const backfill = createHoldoutBackfiller({
        db,
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
        ...promptly,
        write: writer.write,
      });

      expect(backfill({}, () => {})).rejects.toThrow(/backfill/);
      await Bun.sleep(10);
      expect(writer.written).toHaveLength(0);
    } finally {
      service.stop();
    }
  });

  it("names a lane the modelling service could not score, and writes the other", async () => {
    // One lane's fault is a line, not the run. The morning view is the fallback
    // that makes a wrong evening call recoverable, and a backfill that dropped
    // the whole fold because one lane had no rows would take it away.
    const service = serving(
      twoStep(() =>
        json(
          report(
            [RUN],
            [{ lane: "dessem_free_v1__gate_early__thr5", reason: "no rows" }],
          ),
        ),
      ),
    );
    try {
      const backfill = createHoldoutBackfiller({
        db,
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
        ...promptly,
        write: spy().write,
      });

      const result = await backfill({}, () => {});

      expect(result.runs).toHaveLength(1);
      expect(result.failures).toEqual([
        { lane: "dessem_free_v1__gate_early__thr5", reason: "no rows" },
      ]);
    } finally {
      service.stop();
    }
  });
});

describe("the schedule", () => {
  it("is one repeatable job, after the retrain that produces the fold", () => {
    const schedules = holdoutBackfillScheduleForQueue();

    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.id).toBe(HOLDOUT_BACKFILL_JOB_ID);
    expect(schedules[0]?.timeZone).toBe(HOLDOUT_BACKFILL_TIME_ZONE);
    // The same Friday, later in the hour: the retrain is what mints the fold
    // artifacts, and a backfill that raced it would score a fold whose
    // predecessor's rows were still being read.
    const minuteOf = (pattern: string) => Number(pattern.split(" ")[0]);
    expect(schedules[0]?.pattern.split(" ").slice(1)).toEqual(
      RETRAIN_PATTERN.split(" ").slice(1),
    );
    expect(minuteOf(HOLDOUT_BACKFILL_PATTERN)).toBeGreaterThan(minuteOf(RETRAIN_PATTERN));
    expect(schedules[0]?.payload).toEqual({ kind: "holdout_backfill", payload: {} });
  });

  it("waits long enough for a fold to be fitted", () => {
    // A fold is six LightGBM fits over two and a half years of hourly rows for
    // four subsystems, twice. Five seconds is the interactive budget and would
    // report a working backfill as an outage every week.
    expect(HOLDOUT_BACKFILL_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("is a task the worker's one dispatcher carries", async () => {
    const service = serving(() => json(report([RUN])));
    try {
      const dispatch = createWorkerDispatch({
        db,
        holdoutBackfill: {
          endpoint: { baseUrl: service.url, timeoutMs: 5000 },
          ...promptly,
          write: spy().write,
        },
      } as Parameters<typeof createWorkerDispatch>[0]);

      const task: WorkerTask = { kind: "holdout_backfill", payload: {} };
      const outcome = await dispatch(task, () => {});

      expect(outcome.kind).toBe("holdout_backfill");
    } finally {
      service.stop();
    }
  });
});
