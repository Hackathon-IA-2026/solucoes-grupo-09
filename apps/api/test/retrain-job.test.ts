import { describe, expect, it } from "bun:test";
import { Queue } from "bullmq";
import { createBullMqRunner } from "../src/jobs/bullmq.js";
import { FORECAST_PUBLICATIONS } from "../src/jobs/publication.js";
import {
  createRetrainer,
  RETRAIN_JOB_ID,
  RETRAIN_PATH,
  RETRAIN_PATTERN,
  RETRAIN_TIME_ZONE,
  RETRAIN_TIMEOUT_MS,
  retrainRunId,
} from "../src/jobs/retrain.js";
import {
  createWorkerDispatch,
  retrainScheduleForQueue,
  type WorkerTask,
} from "../src/jobs/worker-tasks.js";

/**
 * The weekly retrain's schedule — forecaster ticket 15,
 * `docs/specs/forecaster.md` seam 11.
 *
 * Forecaster 19 gated both lanes in one pass and left nothing calling it: "no
 * job in `apps/api/src/jobs/` retrains anything". This file is about the cron
 * entry that closes that, and about the two things a schedule owns that the
 * modelling service cannot: *which run this is*, and what a failure means.
 *
 * The one that is easy to get wrong is the run id. It is the artifact stem in
 * both lanes, and the modelling service short-circuits a lane that already
 * carries a decision line for it — so an id that moved between attempts would
 * turn one Friday into two artifacts, two cards and two decision lines, none of
 * them recognisable as retries of each other.
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

const report = (lanes: unknown[], promoted: string[] = []) =>
  JSON.stringify({
    at: "2026-09-04T03:10:00Z",
    lanes,
    promoted,
    resources: { wall_clock_seconds: 742.25, peak_rss_mb: 1912.4 },
  });

describe("which run this is", () => {
  it("floors the clock to the schedule's own instant, so a retry is a retry", () => {
    // Three attempts of one firing, minutes apart, as a backoff produces.
    const ids = [
      new Date("2026-09-04T03:10:00.004Z"),
      new Date("2026-09-04T03:12:41.900Z"),
      new Date("2026-09-04T04:31:07.000Z"),
    ].map(retrainRunId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe("2026-09-04T03:10:00Z");
  });

  it("is an ISO-8601 UTC stem to the second — an artifact id and not a date", () => {
    // The same shape `wattsteer_ml.lanes.is_artifact_id` admits. A stem it
    // refuses would be discovered on the far side, after the fits.
    expect(retrainRunId(new Date("2026-12-25T09:00:00Z"))).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it("belongs to the previous day when the clock is a hair early", () => {
    // Clock skew, or a queue that fired a moment before its own minute. The run
    // belongs to an instant that has happened, never to one that has not.
    expect(retrainRunId(new Date("2026-09-04T03:09:59.100Z"))).toBe(
      "2026-09-03T03:10:00Z",
    );
  });

  it("takes the payload's id when one is given, so a catch-up names its run", async () => {
    let asked: unknown = null;
    const service = serving(async (request) => {
      asked = await request.json();
      return new Response(report([]), {
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const retrain = createRetrainer({
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
        // A clock that would produce a different id, to prove it is not read.
        now: () => new Date("2027-01-01T03:10:00Z"),
      });
      const result = await retrain({ runId: "2026-09-04T03:10:00Z" }, () => {});
      expect(asked).toEqual({ run_id: "2026-09-04T03:10:00Z" });
      expect(result.runId).toBe("2026-09-04T03:10:00Z");
    } finally {
      service.stop();
    }
  });
});

describe("when it runs", () => {
  it("is weekly, in UTC, and finishes long before the morning publication", () => {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = RETRAIN_PATTERN.split(" ");
    expect(minute).toBe("10");
    expect(hour).toBe("3");
    // Weekly, on one named weekday, every month.
    expect(dayOfMonth).toBe("*");
    expect(month).toBe("*");
    expect(dayOfWeek).toBe("5");
    // UTC, unlike the publications: a publication instant is a civil fact about
    // the Brazilian grid, and a retrain is an internal job whose artifact stems
    // are UTC. `docs/specs/forecaster.md`'s own example stems put it here —
    // 2026-08-28T03:11:07Z and 2026-08-21T03:09:44Z, two Fridays a week apart.
    expect(RETRAIN_TIME_ZONE).toBe("Etc/UTC");
    expect(new Date("2026-08-28T03:11:07Z").getUTCDay()).toBe(5);

    // And it lands before the day's first publication, which is what makes a
    // Friday promotion serving by the morning gate rather than a day later.
    const fires = new Date("2026-09-04T03:10:00Z");
    const morning = FORECAST_PUBLICATIONS.find(
      (publication) => publication.payload.gateProfile === "gate_early",
    );
    const publishes = new Date("2026-09-04T09:10:00-03:00");
    expect(morning?.pattern).toBe("10 9 * * *");
    expect(fires.getTime()).toBeLessThan(publishes.getTime());
  });

  it("waits far longer than an interactive call, and says so in one place", () => {
    // Six LightGBM fits per lane over two and a half years of hourly rows for
    // four subsystems, twice, plus a 2,000-draw paired bootstrap. The gateway's
    // 5 s and the publication's 120 s are both sized for something else.
    expect(RETRAIN_TIMEOUT_MS).toBeGreaterThan(10 * 60_000);
  });

  it("registers one repeatable job with a stable id", () => {
    const schedules = retrainScheduleForQueue();
    expect(schedules.length).toBe(1);
    expect(schedules[0]?.id).toBe(RETRAIN_JOB_ID);
    expect(schedules[0]?.pattern).toBe(RETRAIN_PATTERN);
    expect(schedules[0]?.timeZone).toBe(RETRAIN_TIME_ZONE);
    // No run id on the schedule: a repeatable job registered once must not pin
    // an instant it will still be asking for a year later.
    expect(schedules[0]?.payload).toEqual({ kind: "retrain", payload: {} });
  });
});

describe("what comes back", () => {
  it("reports both lanes, the wall clock and the peak resident set", async () => {
    const service = serving(
      () =>
        new Response(
          report(
            [
              {
                lane: "dessem_free_v1__gate_early__thr5",
                gate_profile: "gate_early",
                status: "promoted",
                artifact_id: "2026-09-04T03:10:00Z",
                reason: "P(candidate better) = 0.94",
              },
              {
                lane: "dessem_free_v1__gate_late__thr5",
                gate_profile: "gate_late",
                status: "refused",
                artifact_id: null,
                reason: "coverage_p90 = 0.83 is outside [0.85, 0.97]",
              },
            ],
            ["dessem_free_v1__gate_early__thr5"],
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    try {
      const retrain = createRetrainer({
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
      });
      const result = await retrain({ runId: "2026-09-04T03:10:00Z" }, () => {});
      expect(result.lanes.map((lane) => lane.status)).toEqual(["promoted", "refused"]);
      expect(result.promoted).toEqual(["dessem_free_v1__gate_early__thr5"]);
      // The two numbers the ticket asks to be recorded, surfaced where a job log
      // can see them growing week over week.
      expect(result.wallClockSeconds).toBe(742.25);
      expect(result.peakRssMb).toBe(1912.4);
    } finally {
      service.stop();
    }
  });

  it("treats a refusal as a completed run, not a failure to retry", async () => {
    // The distinction the whole gate exists for. A refused candidate has a card
    // and a line; the incumbent goes on serving. Retrying that would refuse
    // again, at the cost of another forty minutes.
    const service = serving(
      () =>
        new Response(
          report([
            {
              lane: "dessem_free_v1__gate_late__thr5",
              gate_profile: "gate_late",
              status: "refused",
              artifact_id: null,
              reason: "F7 has 21 test days, under the 60 a bootstrap needs",
            },
          ]),
          { headers: { "content-type": "application/json" } },
        ),
    );
    try {
      const retrain = createRetrainer({
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
      });
      const result = await retrain({ runId: "2026-09-04T03:10:00Z" }, () => {});
      expect(result.promoted).toEqual([]);
      expect(result.lanes[0]?.status).toBe("refused");
    } finally {
      service.stop();
    }
  });

  it("rethrows the modelling service's own failure so the queue retries it", async () => {
    const service = serving(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "RETRAIN_IN_PROGRESS", message: "already in flight" },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      const retrain = createRetrainer({
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
      });
      const failure = await retrain({ runId: "2026-09-04T03:10:00Z" }, () => {}).catch(
        (error: unknown) => error,
      );
      // `RETRAIN_IN_PROGRESS` is deliberately not in `packages/core`'s closed
      // enum — no public route retrains — so it travels as `upstream_code`,
      // which is exactly what that field is for.
      expect((failure as { code?: string }).code).toBe("UPSTREAM_REJECTED");
      expect(
        (failure as { details?: Record<string, unknown> }).details?.upstream_code,
      ).toBe("RETRAIN_IN_PROGRESS");
    } finally {
      service.stop();
    }
  });

  it("reaches the modelling service on the worker-only path", async () => {
    let path: string | null = null;
    const service = serving((request) => {
      path = new URL(request.url).pathname;
      return new Response(report([]), {
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const dispatch = createWorkerDispatch({
        // The dispatcher's ingest half is never reached by a `retrain` task.
        db: null as never,
        retrain: { endpoint: { baseUrl: service.url, timeoutMs: 5000 } },
      });
      await dispatch(
        { kind: "retrain", payload: { runId: "2026-09-04T03:10:00Z" } },
        () => {},
      );
      expect(path).toBe(RETRAIN_PATH);
      expect(RETRAIN_PATH.startsWith("/internal/")).toBe(true);
    } finally {
      service.stop();
    }
  });
});

/**
 * The schedule on the real queue — gated on `WATTSTEER_TEST_REDIS_URL` like the
 * rest of the BullMQ suite, because "repeatable job" is a claim about BullMQ's
 * job scheduler and not about a literal in a table.
 *
 *   docker run -d -p 6390:6379 redis:7-alpine
 */
const REDIS = process.env.WATTSTEER_TEST_REDIS_URL;
const redisSuite = REDIS ? describe : describe.skip;

redisSuite("the retrain schedule on the existing Redis", () => {
  const QUEUE = "wattsteer-jobs-retrain-test";

  it("registers once, idempotently, with its pattern and its zone", async () => {
    const runner = createBullMqRunner<WorkerTask, unknown>(
      async () => undefined,
      REDIS as string,
      { startWorker: false, queueName: QUEUE },
    );
    const queue = new Queue(QUEUE, { connection: { url: REDIS as string } });
    try {
      // Twice, as two replicas booting at once would.
      for (let pass = 0; pass < 2; pass++) {
        for (const schedule of retrainScheduleForQueue()) {
          await runner.schedule(schedule);
        }
      }
      const registered = (await queue.getJobSchedulers()).filter(
        (scheduler) => String(scheduler.key ?? scheduler.id) === RETRAIN_JOB_ID,
      );
      expect(registered.length).toBe(1);
      expect(registered[0]?.pattern).toBe(RETRAIN_PATTERN);
      expect(registered[0]?.tz).toBe(RETRAIN_TIME_ZONE);
    } finally {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
      await runner.close();
    }
  });
});

describe("a failure says what it measured, not what it was configured with", () => {
  it("names the elapsed time beside the ceiling on an aborted call", async () => {
    /*
      `OPTIMIZER_TIMEOUT` is what `ml-proxy` raises for *any* aborted fetch —
      including one aborted because this container was replaced mid-request,
      which a deploy does routinely. The message used to assert "did not finish
      inside 40 minutes" whatever had actually happened, and on 2026-09-15 that
      sentence sent an operator looking for a forty-minute run that had lasted
      two seconds.

      A log line stating a duration it did not measure is worse than one stating
      none: it is a confident wrong answer to the first question anybody asks.

      Here the abort is genuine and fast — a server that never answers, against
      a 50 ms endpoint ceiling — which is the *shape* of the deploy case: an
      `OPTIMIZER_TIMEOUT` nowhere near forty minutes.
    */
    const stalled = serving(
      () => new Promise<Response>(() => {}) as unknown as Promise<Response>,
    );
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (entry: unknown) => {
      warnings.push(String(entry));
    };
    try {
      await createRetrainer({
        endpoint: { baseUrl: stalled.url, timeoutMs: 50 },
      })({}, () => {}).catch(() => undefined);
    } finally {
      console.warn = realWarn;
      stalled.stop();
    }
    const line = warnings.join("\n");
    // The ceiling is still named — it is what a real timeout would mean.
    expect(line).toContain(`${RETRAIN_TIMEOUT_MS / 60_000} minutes`);
    // And the measured elapsed time beside it, which is what tells a redeploy
    // from a genuine overrun at a glance.
    expect(line).toMatch(/aborted after \d+s/);
    // The old sentence asserted the ceiling as fact. It must not come back.
    expect(line).not.toContain("did not finish inside");
  });
});
