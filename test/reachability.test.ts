/**
 * The polarity half of api-surface 30.
 *
 * `reachability.ts` says what is derivable and why the general rule is not.
 * This file establishes the two properties api-surface 25 demands of every
 * standing guard — **it can fail**, and **its inputs are not empty** — and it
 * establishes them by mutating real repository text and watching each check go
 * red, not by asserting that it would.
 *
 * The mutations are the defects this repository has actually shipped:
 * ticket 03's ingestor wired to nothing, data-platform 15's enum member with no
 * plan, and a route defined and mounted nowhere.
 */

import { describe, expect, it } from "bun:test";
import {
  allSources,
  configKeys,
  describeOrphan,
  dispatchedKinds,
  enqueuedWorkerKinds,
  ingestionSourceMembers,
  isTestFile,
  mlInternalRoutes,
  mountedRoutes,
  orphanUnits,
  plannedKinds,
  producibleSources,
  routeObjects,
  type Source,
  scheduleProducers,
  sourceAt,
  stripCode,
  taskKinds,
  textAt,
  uncalledMlRoutes,
  undeclaredWorkerKinds,
  unreachedWorkerKinds,
  unreadConfigKeys,
  wiredUnits,
  workerDispatchedKinds,
  workerTaskDelegates,
  workerTaskKinds,
} from "./reachability";

const ALL = allSources();
const SRC = ALL.filter((one) => !isTestFile(one.file));
const UNITS = wiredUnits(ALL);

const TASKS = sourceAt("apps/api/src/ingest/tasks.ts");
const DISPATCH = sourceAt("apps/api/src/ingest/dispatch.ts");
const REFRESH = sourceAt("apps/api/src/ingest/refresh.ts");
const SCHEMA = sourceAt("apps/api/src/database/schema.ts");
const API_INDEX = sourceAt("apps/api/src/api/index.ts");
const CONFIG = sourceAt("apps/api/src/config.ts");
const WORKER_TASKS = sourceAt("apps/api/src/jobs/worker-tasks.ts");
const WORKER = sourceAt("apps/api/src/worker.ts");
/** Raw, not stripped: `stripCode` is a TypeScript stripper and this is Python. */
const ML_APP = textAt("apps/ml/src/wattsteer_ml/app.py");

/** A `Source` built from text, so a check can be fed a mutated corpus. */
function synthetic(file: string, text: string): Source {
  return { file, text, code: stripCode(text) };
}

describe("the stripper does not eat its own input", () => {
  it("a line comment containing a block-open costs nothing", () => {
    // api-surface 25's third defect, on the file it was found in: `api/grid.ts`
    // has a `//` comment containing `/*`, and a scanner that removed block
    // comments first deleted a hundred lines of route code from there on.
    const grid = sourceAt("apps/api/src/api/grid.ts");
    expect(/\/\/[^\n]*\/\*/.test(grid.text)).toBe(true);
    const offender = /\/\/[^\n]*\/\*/.exec(grid.text) as RegExpExecArray;
    const after = grid.text.slice(offender.index);
    // Everything the route declares after that line is still visible.
    const routesAfter = [...after.matchAll(/\.(get|post)\(\s*"([^"]+)"/g)];
    expect(routesAfter.length).toBeGreaterThanOrEqual(1);
    for (const route of routesAfter) {
      expect(grid.code).toContain(route[2] as string);
    }
    expect(grid.code.length).toBe(grid.text.length);
  });

  it("a block comment naming a symbol does not count as a reference", () => {
    const stripped = stripCode("/** createFooIngestor is nice. */\nconst x = 1;\n");
    expect(stripped).not.toContain("createFooIngestor");
    expect(stripped).toContain("const x = 1;");
  });

  it("a `//` inside a string literal is not a comment, and strings survive", () => {
    const stripped = stripCode('const u = "https://x/y"; const v = 2;\n');
    expect(stripped).toContain('"https://x/y"');
    expect(stripped).toContain("const v = 2;");
  });
});

describe("the corpus is discovered, and it is not empty", () => {
  it("the walk finds the product, the app and the packages", () => {
    expect(SRC.length).toBeGreaterThanOrEqual(150);
    for (const root of ["apps/api/src/", "apps/web/src/", "packages/core/src/"]) {
      expect(SRC.some((one) => one.file.startsWith(root))).toBe(true);
    }
  });

  it("tests are separated from the product, and both exist", () => {
    expect(ALL.filter((one) => isTestFile(one.file)).length).toBeGreaterThanOrEqual(20);
    expect(SRC.every((one) => !isTestFile(one.file))).toBe(true);
  });
});

describe("every wired unit has a call site", () => {
  it("the convention governs a real population", () => {
    // The non-vacuity floor. If the repo renamed its factories tomorrow this
    // drops to zero and fails here rather than passing green over nothing.
    expect(UNITS.length).toBeGreaterThanOrEqual(15);
    expect(UNITS.some((one) => one.name.endsWith("Ingestor"))).toBe(true);
    expect(UNITS.some((one) => one.name.endsWith("Routes"))).toBe(true);
  });

  it("no ingestor or route factory is reachable from nothing", () => {
    expect(orphanUnits(UNITS).map(describeOrphan)).toEqual([]);
  });

  it("ticket 03's defect is red — an ingestor named only by its barrel", () => {
    const corpus: Source[] = [
      synthetic(
        "apps/api/src/ingest/constrained-off-detail-job.ts",
        "export function createConstrainedOffDetailIngestor() {\n  return 1;\n}\n",
      ),
      synthetic(
        "apps/api/src/ingest/index.ts",
        'export { createConstrainedOffDetailIngestor } from "./constrained-off-detail-job.js";\n',
      ),
      synthetic(
        "apps/api/test/ons-constrained-off-detail.test.ts",
        'import { createConstrainedOffDetailIngestor } from "../src/ingest/index.js";\n',
      ),
      synthetic(
        "apps/api/src/ingest/dispatch.ts",
        "export function createIngestDispatcher() {\n  return 1;\n}\n",
      ),
    ];
    const orphans = orphanUnits(wiredUnits(corpus));
    expect(orphans.map((one) => one.name)).toEqual([
      "createConstrainedOffDetailIngestor",
    ]);
    // The barrel is not mistaken for a caller, and the test file is counted
    // without being mistaken for one either.
    expect(orphans[0]?.tests.length).toBe(1);
  });

  it("a factory the dispatcher constructs is not an orphan", () => {
    const corpus: Source[] = [
      synthetic(
        "apps/api/src/ingest/foo-job.ts",
        "export function createFooIngestor() {\n  return 1;\n}\n",
      ),
      synthetic(
        "apps/api/src/ingest/index.ts",
        'export { createFooIngestor } from "./foo-job.js";\n',
      ),
      synthetic(
        "apps/api/src/ingest/dispatch.ts",
        'import { createFooIngestor } from "./foo-job.js";\nconst foo = createFooIngestor();\n',
      ),
    ];
    expect(orphanUnits(wiredUnits(corpus))).toEqual([]);
  });

  it("an empty corpus throws rather than reporting no orphans", () => {
    // The vacuity trap this repo has fallen into four times: `[] === []`. The
    // verdict function itself refuses, so the failure lands at the assertion
    // the suite actually runs and not only at a floor beside it.
    expect(wiredUnits([]).length).toBe(0);
    expect(() => orphanUnits(wiredUnits([]))).toThrow(/governing nothing/);
  });

  it("a corpus the stripper has emptied throws too", () => {
    // The nastier version of the same thing: the walk found files, and the
    // scanner deleted the code out of them. api-surface 25's defect 3, as an
    // input rather than as a story.
    const eaten = SRC.map((one) => ({ ...one, code: "" }));
    expect(eaten.length).toBeGreaterThan(0);
    expect(() => orphanUnits(wiredUnits(eaten))).toThrow(/governing nothing/);
  });
});

describe("the ingest queue reaches every kind it declares", () => {
  const kinds = taskKinds(TASKS.code);

  it("the union is non-empty and covers both grains", () => {
    expect(kinds.length).toBeGreaterThanOrEqual(10);
    expect(kinds).toContain("constrained_off");
    expect(kinds).toContain("constrained_off_detail");
  });

  it("every kind reaches a dispatcher branch", () => {
    const dispatched = new Set(dispatchedKinds(DISPATCH.code));
    expect(kinds.filter((kind) => !dispatched.has(kind))).toEqual([]);
  });

  it("the exhaustive default counts, so `plant_registry` is not accused", () => {
    // The false positive this check is built to avoid: there is no
    // `case "plant_registry":` anywhere in the dispatcher.
    expect(DISPATCH.code).not.toContain('case "plant_registry":');
    expect(dispatchedKinds(DISPATCH.code)).toContain("plant_registry");
  });

  it("every kind is planned by planRefresh", () => {
    const planned = new Set(plannedKinds(REFRESH.code));
    expect(kinds.filter((kind) => !planned.has(kind))).toEqual([]);
  });

  it("a kind added to the union and to nothing else is red twice", () => {
    // Added to the real union, exactly as a new source would arrive.
    const drifted = TASKS.code.replace(
      '| { kind: "weather"; payload: IngestWeatherPayload };',
      '| { kind: "weather"; payload: IngestWeatherPayload }\n  | { kind: "brand_new_source"; payload: IngestWeatherPayload };',
    );
    expect(drifted).not.toBe(TASKS.code);
    const mutated = taskKinds(drifted);
    expect(mutated).toContain("brand_new_source");
    const dispatched = new Set(dispatchedKinds(DISPATCH.code));
    const planned = new Set(plannedKinds(REFRESH.code));
    expect(mutated.filter((kind) => !dispatched.has(kind))).toEqual(["brand_new_source"]);
    expect(mutated.filter((kind) => !planned.has(kind))).toEqual(["brand_new_source"]);
  });

  it("deleting the plant-grain plan line turns the plan check red", () => {
    const withoutDetail = REFRESH.code.replaceAll(
      'kind: "constrained_off_detail"',
      'kind: "x"',
    );
    const planned = new Set(plannedKinds(withoutDetail));
    expect(kinds.filter((kind) => !planned.has(kind))).toEqual([
      "constrained_off_detail",
    ]);
  });

  it("an empty tasks file throws rather than reporting zero unreached kinds", () => {
    expect(() => taskKinds("")).toThrow(/IngestTask/);
  });
});

describe("every ingestion_source member can be produced", () => {
  const members = ingestionSourceMembers(SCHEMA.code);
  const kinds = taskKinds(TASKS.code);

  it("the enum is non-empty and holds both plant-grain members", () => {
    expect(members.length).toBeGreaterThanOrEqual(13);
    expect(members).toContain("constrained_off_wind_detail");
    expect(members).toContain("constrained_off_solar_detail");
  });

  it("`sourceOf` can return every one of them", () => {
    const producible = new Set(producibleSources(TASKS.code, kinds));
    expect(members.filter((member) => !producible.has(member))).toEqual([]);
  });

  it("data-platform 15's defect is red — a member in the enum and in no plan", () => {
    const drifted = SCHEMA.code.replace(
      '"weather",\n]);',
      '"weather",\n  "a_source_with_no_plan",\n]);',
    );
    const mutated = ingestionSourceMembers(drifted);
    expect(mutated).toContain("a_source_with_no_plan");
    const producible = new Set(producibleSources(TASKS.code, kinds));
    expect(mutated.filter((member) => !producible.has(member))).toEqual([
      "a_source_with_no_plan",
    ]);
  });

  it("an empty schema throws rather than reporting an empty enum", () => {
    expect(() => ingestionSourceMembers("")).toThrow(/ingestion_source/);
  });
});

describe("every route object is mounted", () => {
  const objects = routeObjects(SRC);
  const mounted = new Set(mountedRoutes(API_INDEX.code));

  it("the route surface is non-empty and discovered by shape", () => {
    expect(objects.length).toBeGreaterThanOrEqual(10);
    expect(objects.map((one) => one.name)).toContain("canonicalReads");
    expect(objects.map((one) => one.name)).toContain("replayRoutes");
  });

  it("nothing defines a surface the app does not compose", () => {
    expect(
      objects.filter((one) => !mounted.has(one.name)).map((one) => one.file),
    ).toEqual([]);
  });

  it("unmounting one turns it red", () => {
    const without = new Set(
      mountedRoutes(API_INDEX.code.replace(".use(replayRoutes)", "")),
    );
    expect(
      objects.filter((one) => !without.has(one.name)).map((one) => one.name),
    ).toEqual(["replayRoutes"]);
  });

  it("a new route module mounted nowhere is red the day it is written", () => {
    const corpus = [
      ...SRC,
      synthetic(
        "apps/api/src/api/tariffs.ts",
        'export const tariffRoutes = new Elysia().get("/v1/tariffs", () => 1);\n',
      ),
    ];
    const fresh = routeObjects(corpus).filter((one) => !mounted.has(one.name));
    expect(fresh.map((one) => one.name)).toEqual(["tariffRoutes"]);
  });

  it("an empty index mounts nothing, and that is a failure not a pass", () => {
    expect(mountedRoutes("")).toEqual([]);
    expect(
      objects.filter((one) => !new Set(mountedRoutes("")).has(one.name)).length,
    ).toBe(objects.length);
  });
});

describe("every config key is read", () => {
  const keys = configKeys(CONFIG.code);

  it("the key set is non-empty", () => {
    expect(keys.length).toBeGreaterThanOrEqual(25);
    expect(keys).toContain("databaseUrl");
  });

  it("no flag is read nowhere", () => {
    expect(unreadConfigKeys(keys, SRC)).toEqual([]);
  });

  it("a key nothing reads is red", () => {
    expect(unreadConfigKeys([...keys, "aFlagNobodyReads"], SRC)).toEqual([
      "aFlagNobodyReads",
    ]);
  });

  it("an empty config throws rather than reporting zero unread keys", () => {
    expect(() => configKeys("")).toThrow(/config\.ts/);
  });

  it("an empty corpus makes every key unread, rather than none", () => {
    expect(unreadConfigKeys(keys, []).length).toBe(keys.length);
  });
});

/* ------------------------------------------------------------ worker tasks */

/**
 * The sixth check, proved the only way a retroactive claim can be proved: by
 * putting replay 07/08 back the way they were, one half at a time.
 *
 * The wiring agent that closed those two orphans said in its own handover that
 * this guard had not caught them and could not have — `createReplayRefresher`
 * is not a `create*Ingestor` or `create*Routes`, and `WorkerTask` kinds were
 * checked by nothing. Three mutations reconstruct the three shapes the defect
 * can take, each against real repository text.
 */
describe("every WorkerTask kind is dispatched and enqueued", () => {
  const kinds = workerTaskKinds(WORKER_TASKS.code);
  const dispatched = workerDispatchedKinds(WORKER_TASKS.code);
  const producers = scheduleProducers(SRC);
  const enqueued = enqueuedWorkerKinds(producers, SRC);

  it("the union, the dispatcher and the schedules are all non-empty", () => {
    // The non-vacuity floor beside the verdict, not instead of it: the verdict
    // functions themselves refuse an empty input, which is what the tests
    // below prove.
    expect(kinds.length).toBeGreaterThanOrEqual(5);
    expect(kinds).toContain("refresh_replay_caches");
    expect(dispatched.length).toBeGreaterThanOrEqual(5);
    expect(producers.length).toBeGreaterThanOrEqual(4);
    expect(enqueued.length).toBeGreaterThanOrEqual(5);
  });

  it("the ingest union is folded in and delegated, not branched on", () => {
    // `QueueTask`'s kinds are check 2's business. What has to be true here is
    // that the fall-through exists at all: without it half the union reaches
    // nothing and no `kind:` member would be missing.
    expect(workerTaskDelegates(WORKER_TASKS.code)).toEqual(["QueueTask"]);
    expect(WORKER_TASKS.code).toMatch(/return ingest\(task, report\);/);
  });

  it("no declared kind is unreached", () => {
    expect(unreachedWorkerKinds(kinds, dispatched, enqueued)).toEqual([]);
  });

  it("no branch or schedule exists for a kind the union does not declare", () => {
    expect(
      undeclaredWorkerKinds(
        kinds,
        dispatched,
        producers.flatMap((one) => one.kinds),
      ),
    ).toEqual([]);
  });

  it("`publish_diagnosis` is chained, not scheduled — and that is not a failure", () => {
    // The false positive this check exists not to produce. `publish_diagnosis`
    // is the one row of `docs/specs/api-surface.md`'s job table whose trigger
    // is "on completion of each" rather than a cron, and a check demanding a
    // schedule for every kind would fire on correct code and be deleted.
    expect(producers.flatMap((one) => one.kinds)).not.toContain("publish_diagnosis");
    expect(enqueued).toContain("publish_diagnosis");
    expect(WORKER_TASKS.code).toContain('submit({ kind: "publish_diagnosis"');
  });

  it("the three inline-literal ingest schedules count as enqueued", () => {
    // The third mechanism: `worker.ts` registers these with no producer
    // function at all, so a producer-only reading would miss them.
    for (const kind of ["refresh_sweep", "retention", "centroid_drift"]) {
      expect(enqueued).toContain(kind);
    }
  });

  it("replay 07/08, mutation 1: the union member removed while the wiring stays", () => {
    const drifted = WORKER_TASKS.code.replace(
      '  | { kind: "holdout_backfill"; payload: HoldoutBackfillPayload }\n' +
        '  | { kind: "refresh_replay_caches"; payload: ReplayRefreshPayload };',
      '  | { kind: "holdout_backfill"; payload: HoldoutBackfillPayload };',
    );
    expect(drifted).not.toBe(WORKER_TASKS.code);
    const mutatedKinds = workerTaskKinds(drifted);
    expect(mutatedKinds).not.toContain("refresh_replay_caches");
    // Red, and from both halves: the branch and the schedule go on existing
    // for a kind the type no longer admits.
    expect(
      undeclaredWorkerKinds(
        mutatedKinds,
        workerDispatchedKinds(drifted),
        producers.flatMap((one) => one.kinds),
      ),
    ).toEqual([{ kind: "refresh_replay_caches", from: ["dispatch", "schedule"] }]);
  });

  it("replay 07/08, mutation 2: the dispatcher branch removed", () => {
    const drifted = WORKER_TASKS.code.replace(
      /\n {4}if \(task\.kind === "refresh_replay_caches"\) \{[\s\S]*?\n {4}\}/,
      "",
    );
    expect(drifted).not.toBe(WORKER_TASKS.code);
    const mutated = workerDispatchedKinds(drifted);
    expect(mutated).not.toContain("refresh_replay_caches");
    expect(unreachedWorkerKinds(kinds, mutated, enqueued)).toEqual([
      { kind: "refresh_replay_caches", missing: ["dispatch"] },
    ]);
  });

  it("replay 07/08, mutation 3: the schedule registration removed from worker.ts", () => {
    // The exact state the ticket describes: the producer still exists in
    // `worker-tasks.ts`, and nothing loops over it. A check that only asked
    // whether a producer existed would read this green.
    const unregistered = synthetic(
      WORKER.file,
      WORKER.text.replaceAll("replayRefreshSchedulesForQueue", "someOtherThing"),
    );
    const corpus = SRC.map((one) => (one.file === WORKER.file ? unregistered : one));
    expect(corpus).not.toEqual(SRC);
    const mutated = enqueuedWorkerKinds(scheduleProducers(corpus), corpus);
    expect(mutated).not.toContain("refresh_replay_caches");
    expect(unreachedWorkerKinds(kinds, dispatched, mutated)).toEqual([
      { kind: "refresh_replay_caches", missing: ["enqueue"] },
    ]);
  });

  it("a kind added to the union and to nothing else is red on both halves", () => {
    const drifted = WORKER_TASKS.code.replace(
      '  | { kind: "refresh_replay_caches"; payload: ReplayRefreshPayload };',
      '  | { kind: "refresh_replay_caches"; payload: ReplayRefreshPayload }\n' +
        '  | { kind: "recompute_something"; payload: ReplayRefreshPayload };',
    );
    expect(drifted).not.toBe(WORKER_TASKS.code);
    expect(unreachedWorkerKinds(workerTaskKinds(drifted), dispatched, enqueued)).toEqual([
      { kind: "recompute_something", missing: ["dispatch", "enqueue"] },
    ]);
  });

  it("a comment naming a kind does not wire it", () => {
    // The `createArchiveFetch` bug class, on this check: an earlier revision of
    // the sweep read a docstring's usage example as a call site.
    const corpus = [
      synthetic(
        "apps/api/src/worker.ts",
        '// someday: submit({ kind: "recompute_something", payload: {} });\n',
      ),
    ];
    expect(enqueuedWorkerKinds(producers, corpus)).not.toContain("recompute_something");
  });

  it("a `//` containing a block-open does not hide a real enqueue after it", () => {
    // The other direction, and the defect that broke two previous guards:
    // `apps/api/src/api/grid.ts:280` is a line comment containing `/*`. A
    // stripper that removed block comments first would eat everything after it
    // and report the enqueue below as absent.
    const offender = /^.*\/\/[^\n]*\/\*.*$/m.exec(
      sourceAt("apps/api/src/api/grid.ts").text,
    ) as RegExpExecArray;
    const corpus = [
      synthetic(
        "apps/api/src/worker.ts",
        `${offender[0]}\nawait runner.submit({ kind: "recompute_something", payload: {} });\n`,
      ),
    ];
    expect(enqueuedWorkerKinds(producers, corpus)).toContain("recompute_something");
  });

  it("an empty union, dispatcher or schedule set throws rather than passing", () => {
    expect(() => workerTaskKinds("")).toThrow(/WorkerTask/);
    expect(() => workerTaskKinds("export type WorkerTask = QueueTask;\n")).toThrow(
      /governing nothing/,
    );
    expect(() => workerDispatchedKinds("")).toThrow(/createWorkerDispatch/);
    expect(() =>
      workerDispatchedKinds(
        "export function createWorkerDispatch(deps) {\n  return ingest;\n}\n",
      ),
    ).toThrow(/empty dispatcher/);
    expect(() => scheduleProducers([])).toThrow(/no schedule/);
    expect(() => scheduleProducers(SRC.map((one) => ({ ...one, code: "" })))).toThrow(
      /no schedule/,
    );
    expect(() => unreachedWorkerKinds([], dispatched, enqueued)).toThrow(
      /governing nothing/,
    );
    expect(() => unreachedWorkerKinds(kinds, [], enqueued)).toThrow(/empty dispatcher/);
    expect(() => unreachedWorkerKinds(kinds, dispatched, [])).toThrow(/empty queue/);
    expect(() => undeclaredWorkerKinds([], dispatched, [])).toThrow(/governing nothing/);
  });
});

/**
 * The half the sixth check structurally cannot cover, from the other side.
 *
 * Replay 07/08 were not *half*-wired: they had no `WorkerTask` member, no
 * branch and no schedule, so there was no declared shape for a reachability
 * check over TypeScript to find unreachable. What did exist was the pair of
 * `/internal/` routes on the modelling service. That is the population this
 * reads, and it is the one that would have gone red on the day replay 07
 * merged.
 */
describe("every /internal route on the modelling service has a caller", () => {
  const routes = mlInternalRoutes(ML_APP);

  it("the population is the modelling service's own decorators", () => {
    expect(routes.length).toBeGreaterThanOrEqual(6);
    expect(routes).toContain("/internal/replay/featured-days");
    expect(routes).toContain("/internal/replay/backtest");
  });

  it("nothing on that surface is unreachable from the worker", () => {
    expect(uncalledMlRoutes(routes, SRC)).toEqual([]);
  });

  it("replay 07/08 as they actually were: the route with no TypeScript at all", () => {
    // `jobs/replay-refresh.ts` is the caller. Without it — the state before it
    // was written — both routes are named by nothing but their own tests.
    const corpus = SRC.filter(
      (one) => one.file !== "apps/api/src/jobs/replay-refresh.ts",
    );
    expect(corpus.length).toBe(SRC.length - 1);
    expect(uncalledMlRoutes(routes, corpus)).toEqual([
      "/internal/replay/featured-days",
      "/internal/replay/backtest",
    ]);
  });

  it("a comment naming the route is not a caller", () => {
    // `replay-refresh.ts`'s own header names both paths in prose, which is
    // exactly the shape that made an earlier sweep call `createArchiveFetch`
    // reached. Only the stripped code counts.
    const commentOnly = [
      synthetic(
        "apps/api/src/jobs/replay-refresh.ts",
        "/** Calls `POST /internal/replay/backtest` some day. */\nexport const x = 1;\n",
      ),
    ];
    expect(uncalledMlRoutes(["/internal/replay/backtest"], commentOnly)).toEqual([
      "/internal/replay/backtest",
    ]);
  });

  it("an empty app or an empty corpus is a failure, not a pass", () => {
    expect(() => mlInternalRoutes("")).toThrow(/reading nothing/);
    expect(() => mlInternalRoutes('# @app.post("/internal/ghost")\n')).toThrow(
      /reading nothing/,
    );
    expect(uncalledMlRoutes(routes, []).length).toBe(routes.length);
  });
});
