import { describe, expect, it } from "bun:test";
import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core/constants";
import { GRID_TIME_ZONE } from "@wattsteer/core/scenario-validation";
import type { Database } from "../src/database/connection.js";
import { PUBLICATION_LANES } from "../src/jobs/publication.js";
import {
  BACKTEST_PATH,
  createReplayRefresher,
  FEATURED_DAYS_PATH,
  REPLAY_REFRESH_JOB_PREFIX,
  REPLAY_REFRESH_PATTERN,
  replayRefreshTargets,
} from "../src/jobs/replay-refresh.js";
import {
  createWorkerDispatch,
  replayRefreshSchedulesForQueue,
} from "../src/jobs/worker-tasks.js";

/**
 * The caller the two Replay caches were missing — replay 07 and replay 08.
 *
 * Both endpoints were built, both were covered by the modelling service's own
 * tests, and **nothing called either**: no `WorkerTask` member, no dispatcher
 * branch, no schedule, no cron in any file. So `GET /v1/replay/days` served the
 * `pending` payload that names this very job in its response body, and
 * `GET /v1/backtest` served its own, on every deployed instance, for as long as
 * both endpoints had existed. `docs/specs/api-surface.md` meanwhile tabulated
 * `refresh-featured-days | 30 3 * * *` as though the cron ran.
 *
 * Four properties are asserted here, and each is one half of that defect:
 *
 * 1. The task kind reaches the dispatcher and both routes are actually POSTed.
 * 2. The schedule exists, at the pattern and in the zone the spec's table
 *    publishes, so the spec row is now a claim about a file.
 * 3. The fan-out is derived from the two published constants, so a fifth
 *    subsystem or a third served lane is covered without an edit here.
 * 4. A stated absence finishes the run and an outage retries it — the retrain's
 *    distinction, because a pre-go-live lane must not become a backoff storm
 *    and a broken modelling service must not look like a completed refresh.
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const PAYLOAD = { subsystem: "NE", lane: PUBLICATION_LANES.gate_late } as const;

describe("the nightly Replay recompute", () => {
  it("fills both caches for one (subsystem, lane) in one task", async () => {
    const asked: { path: string; body: unknown }[] = [];
    const service = serving(async (request) => {
      const path = new URL(request.url).pathname;
      asked.push({ path, body: await request.json() });
      return json({ computation_id: `sha256:${path.slice(-4)}` });
    });
    try {
      const refresh = createReplayRefresher({
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
      });

      const result = await refresh(PAYLOAD, () => {});

      expect(asked.map((one) => one.path)).toEqual([FEATURED_DAYS_PATH, BACKTEST_PATH]);
      // The same subsystem and the same lane at both routes — a shortlist of
      // one night's rows beside an aggregate of another's would be two answers.
      expect(asked[0]?.body).toEqual({ subsystem: "NE", lane: PAYLOAD.lane });
      expect(asked[1]?.body).toEqual({ subsystem: "NE", lane: PAYLOAD.lane });
      expect(result.outcomes.every((one) => one.filled)).toBe(true);
      expect(result.outcomes.map((one) => one.cache)).toEqual([
        "featured_days",
        "backtest",
      ]);
    } finally {
      service.stop();
    }
  });

  it("reaches the modelling service through the worker's dispatcher", async () => {
    // The half that was missing: the endpoint was never unreachable, it was
    // never *reached*. A task kind with no branch is an endpoint with no caller.
    const paths: string[] = [];
    const service = serving((request) => {
      paths.push(new URL(request.url).pathname);
      return json({ computation_id: "sha256:beef" });
    });
    try {
      const dispatch = createWorkerDispatch({
        db: {} as Database,
        replayRefresh: { endpoint: { baseUrl: service.url, timeoutMs: 5000 } },
      });

      const out = await dispatch(
        { kind: "refresh_replay_caches", payload: PAYLOAD },
        () => {},
      );

      expect(out.kind).toBe("refresh_replay_caches");
      expect(paths).toEqual([FEATURED_DAYS_PATH, BACKTEST_PATH]);
    } finally {
      service.stop();
    }
  });

  it("records a stated absence and finishes, rather than retrying it nightly", async () => {
    // `REPLAY_FORECAST_UNAVAILABLE` means the window holds no replayable day
    // for this pair — true before go-live and of any lane nothing has
    // backfilled. It does not improve by being asked again at 03:31, and the
    // second cache is still attempted: a lane with no featured day can still
    // have a fold with a backtest row.
    const service = serving((request) => {
      const path = new URL(request.url).pathname;
      if (path === FEATURED_DAYS_PATH) {
        return json(
          { error: { code: "REPLAY_FORECAST_UNAVAILABLE", message: "no day" } },
          404,
        );
      }
      return json({ computation_id: "sha256:cafe" });
    });
    try {
      const refresh = createReplayRefresher({
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
      });

      const result = await refresh(PAYLOAD, () => {});

      const featured = result.outcomes[0];
      expect(featured?.filled).toBe(false);
      expect(featured?.filled === false && featured.reason).toContain(
        "REPLAY_FORECAST_UNAVAILABLE",
      );
      expect(result.outcomes[1]?.filled).toBe(true);
    } finally {
      service.stop();
    }
  });

  it("throws on an outage, so the queue's backoff retries the run", async () => {
    // The other side of the same decision. A refresh that swallowed a 503 would
    // report a completed run over caches that are still empty, which is the
    // exact shape of the defect this module exists to end.
    const service = serving(() =>
      json({ error: { code: "DATA_UNAVAILABLE", message: "no postgres" } }, 503),
    );
    try {
      const refresh = createReplayRefresher({
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
      });

      await expect(refresh(PAYLOAD, () => {})).rejects.toThrow();
    } finally {
      service.stop();
    }
  });
});

describe("the schedule", () => {
  it("is registered at the pattern and zone the spec's table publishes", () => {
    const schedules = replayRefreshSchedulesForQueue();

    expect(schedules.length).toBeGreaterThan(0);
    for (const schedule of schedules) {
      expect(schedule.pattern).toBe(REPLAY_REFRESH_PATTERN);
      expect(schedule.timeZone).toBe(GRID_TIME_ZONE);
      expect(schedule.id.startsWith(`${REPLAY_REFRESH_JOB_PREFIX}:`)).toBe(true);
      expect(schedule.payload.kind).toBe("refresh_replay_caches");
    }
    // `docs/specs/api-surface.md:323` — the row that described a cron existing
    // in no file until this schedule did.
    expect(REPLAY_REFRESH_PATTERN).toBe("30 3 * * *");
  });

  it("covers every subsystem × every served lane, derived and not listed", () => {
    const lanes = Object.values(PUBLICATION_LANES);
    const targets = replayRefreshTargets();

    expect(targets).toHaveLength(SUBSYSTEM_DISPLAY_ORDER.length * lanes.length);
    for (const subsystem of SUBSYSTEM_DISPLAY_ORDER) {
      for (const lane of lanes) {
        expect(
          targets.some((one) => one.subsystem === subsystem && one.lane === lane),
        ).toBe(true);
      }
    }
    // Stable ids, so N worker replicas converge on one schedule apiece.
    const ids = replayRefreshSchedulesForQueue().map((one) => one.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
