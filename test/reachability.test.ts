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

import { describe, expect, test } from "bun:test";
import {
  allSources,
  configKeys,
  describeOrphan,
  dispatchedKinds,
  ingestionSourceMembers,
  isTestFile,
  mountedRoutes,
  orphanUnits,
  plannedKinds,
  producibleSources,
  routeObjects,
  type Source,
  sourceAt,
  stripCode,
  taskKinds,
  unreadConfigKeys,
  wiredUnits,
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

/** A `Source` built from text, so a check can be fed a mutated corpus. */
function synthetic(file: string, text: string): Source {
  return { file, text, code: stripCode(text) };
}

describe("the stripper does not eat its own input", () => {
  test("a line comment containing a block-open costs nothing", () => {
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

  test("a block comment naming a symbol does not count as a reference", () => {
    const stripped = stripCode("/** createFooIngestor is nice. */\nconst x = 1;\n");
    expect(stripped).not.toContain("createFooIngestor");
    expect(stripped).toContain("const x = 1;");
  });

  test("a `//` inside a string literal is not a comment, and strings survive", () => {
    const stripped = stripCode('const u = "https://x/y"; const v = 2;\n');
    expect(stripped).toContain('"https://x/y"');
    expect(stripped).toContain("const v = 2;");
  });
});

describe("the corpus is discovered, and it is not empty", () => {
  test("the walk finds the product, the app and the packages", () => {
    expect(SRC.length).toBeGreaterThanOrEqual(150);
    for (const root of ["apps/api/src/", "apps/web/src/", "packages/core/src/"]) {
      expect(SRC.some((one) => one.file.startsWith(root))).toBe(true);
    }
  });

  test("tests are separated from the product, and both exist", () => {
    expect(ALL.filter((one) => isTestFile(one.file)).length).toBeGreaterThanOrEqual(20);
    expect(SRC.every((one) => !isTestFile(one.file))).toBe(true);
  });
});

describe("every wired unit has a call site", () => {
  test("the convention governs a real population", () => {
    // The non-vacuity floor. If the repo renamed its factories tomorrow this
    // drops to zero and fails here rather than passing green over nothing.
    expect(UNITS.length).toBeGreaterThanOrEqual(15);
    expect(UNITS.some((one) => one.name.endsWith("Ingestor"))).toBe(true);
    expect(UNITS.some((one) => one.name.endsWith("Routes"))).toBe(true);
  });

  test("no ingestor or route factory is reachable from nothing", () => {
    expect(orphanUnits(UNITS).map(describeOrphan)).toEqual([]);
  });

  test("ticket 03's defect is red — an ingestor named only by its barrel", () => {
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

  test("a factory the dispatcher constructs is not an orphan", () => {
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

  test("an empty corpus throws rather than reporting no orphans", () => {
    // The vacuity trap this repo has fallen into four times: `[] === []`. The
    // verdict function itself refuses, so the failure lands at the assertion
    // the suite actually runs and not only at a floor beside it.
    expect(wiredUnits([]).length).toBe(0);
    expect(() => orphanUnits(wiredUnits([]))).toThrow(/governing nothing/);
  });

  test("a corpus the stripper has emptied throws too", () => {
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

  test("the union is non-empty and covers both grains", () => {
    expect(kinds.length).toBeGreaterThanOrEqual(10);
    expect(kinds).toContain("constrained_off");
    expect(kinds).toContain("constrained_off_detail");
  });

  test("every kind reaches a dispatcher branch", () => {
    const dispatched = new Set(dispatchedKinds(DISPATCH.code));
    expect(kinds.filter((kind) => !dispatched.has(kind))).toEqual([]);
  });

  test("the exhaustive default counts, so `plant_registry` is not accused", () => {
    // The false positive this check is built to avoid: there is no
    // `case "plant_registry":` anywhere in the dispatcher.
    expect(DISPATCH.code).not.toContain('case "plant_registry":');
    expect(dispatchedKinds(DISPATCH.code)).toContain("plant_registry");
  });

  test("every kind is planned by planRefresh", () => {
    const planned = new Set(plannedKinds(REFRESH.code));
    expect(kinds.filter((kind) => !planned.has(kind))).toEqual([]);
  });

  test("a kind added to the union and to nothing else is red twice", () => {
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

  test("deleting the plant-grain plan line turns the plan check red", () => {
    const withoutDetail = REFRESH.code.replaceAll(
      'kind: "constrained_off_detail"',
      'kind: "x"',
    );
    const planned = new Set(plannedKinds(withoutDetail));
    expect(kinds.filter((kind) => !planned.has(kind))).toEqual([
      "constrained_off_detail",
    ]);
  });

  test("an empty tasks file throws rather than reporting zero unreached kinds", () => {
    expect(() => taskKinds("")).toThrow(/IngestTask/);
  });
});

describe("every ingestion_source member can be produced", () => {
  const members = ingestionSourceMembers(SCHEMA.code);
  const kinds = taskKinds(TASKS.code);

  test("the enum is non-empty and holds both plant-grain members", () => {
    expect(members.length).toBeGreaterThanOrEqual(13);
    expect(members).toContain("constrained_off_wind_detail");
    expect(members).toContain("constrained_off_solar_detail");
  });

  test("`sourceOf` can return every one of them", () => {
    const producible = new Set(producibleSources(TASKS.code, kinds));
    expect(members.filter((member) => !producible.has(member))).toEqual([]);
  });

  test("data-platform 15's defect is red — a member in the enum and in no plan", () => {
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

  test("an empty schema throws rather than reporting an empty enum", () => {
    expect(() => ingestionSourceMembers("")).toThrow(/ingestion_source/);
  });
});

describe("every route object is mounted", () => {
  const objects = routeObjects(SRC);
  const mounted = new Set(mountedRoutes(API_INDEX.code));

  test("the route surface is non-empty and discovered by shape", () => {
    expect(objects.length).toBeGreaterThanOrEqual(10);
    expect(objects.map((one) => one.name)).toContain("canonicalReads");
    expect(objects.map((one) => one.name)).toContain("replayRoutes");
  });

  test("nothing defines a surface the app does not compose", () => {
    expect(
      objects.filter((one) => !mounted.has(one.name)).map((one) => one.file),
    ).toEqual([]);
  });

  test("unmounting one turns it red", () => {
    const without = new Set(
      mountedRoutes(API_INDEX.code.replace(".use(replayRoutes)", "")),
    );
    expect(
      objects.filter((one) => !without.has(one.name)).map((one) => one.name),
    ).toEqual(["replayRoutes"]);
  });

  test("a new route module mounted nowhere is red the day it is written", () => {
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

  test("an empty index mounts nothing, and that is a failure not a pass", () => {
    expect(mountedRoutes("")).toEqual([]);
    expect(
      objects.filter((one) => !new Set(mountedRoutes("")).has(one.name)).length,
    ).toBe(objects.length);
  });
});

describe("every config key is read", () => {
  const keys = configKeys(CONFIG.code);

  test("the key set is non-empty", () => {
    expect(keys.length).toBeGreaterThanOrEqual(25);
    expect(keys).toContain("databaseUrl");
  });

  test("no flag is read nowhere", () => {
    expect(unreadConfigKeys(keys, SRC)).toEqual([]);
  });

  test("a key nothing reads is red", () => {
    expect(unreadConfigKeys([...keys, "aFlagNobodyReads"], SRC)).toEqual([
      "aFlagNobodyReads",
    ]);
  });

  test("an empty config throws rather than reporting zero unread keys", () => {
    expect(() => configKeys("")).toThrow(/config\.ts/);
  });

  test("an empty corpus makes every key unread, rather than none", () => {
    expect(unreadConfigKeys(keys, []).length).toBe(keys.length);
  });
});
