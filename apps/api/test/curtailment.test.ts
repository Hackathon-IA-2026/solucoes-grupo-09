import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createCurtailmentRoutes } from "../src/api/curtailment.js";
import { app } from "../src/api/index.js";
import { errorHandler } from "../src/api/plugins/errors.js";

/**
 * The claims about `/v1/curtailment/*` that need no database.
 *
 * The structural ones are the ones worth having, and they are the same two
 * `grid-now.test.ts` makes for the same reason: these routes **have no path to
 * the modelling service**, which is why they serve with `apps/ml` down and
 * nothing promoted, and they **have no path to a base table**, which is what
 * keeps the canonical views the single definition of a canonical read. Both are
 * asserted over the source with comments stripped, because a rule a docstring
 * can satisfy is not a rule.
 *
 * The rest are the ticket's refusals — the 400-day cap, and the absence of a
 * `plant` parameter — which are properties of the request and need no rows.
 */

const SOURCE = join(import.meta.dir, "..", "src");

/** Source with block and line comments removed — prose may not satisfy a rule. */
function code(relative: string): string {
  return (
    readFileSync(join(SOURCE, relative), "utf8")
      // Line comments FIRST, then block comments. The reverse order is silently
      // wrong where a `//` comment contains a `/*` — `api/grid.ts:280` and
      // `api/plants.ts:261` are the two real instances, and `grid-now.test.ts`
      // carries the control. Neither module read here has such a line today, so
      // the two orders agree on them; this is the correct order regardless, and
      // costs nothing.
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
  );
}

const ROUTE = code("api/curtailment.ts");
const READ = code("contract/curtailment-observed.ts");

/** A window inside the cap, so a refusal is about the parameter under test. */
const FROM = "2026-05-01T00:00:00.000Z";
const TO = "2026-05-08T00:00:00.000Z";

const withoutDb = new Elysia()
  .use(errorHandler)
  .use(createCurtailmentRoutes({ db: undefined }));

const get = (path: string) => withoutDb.handle(new Request(`http://localhost${path}`));

const codeOf = async (response: Response): Promise<string> => {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
};

describe("curtailment · the boundary, structurally", () => {
  it("reaches the modelling service nowhere", () => {
    for (const source of [ROUTE, READ]) {
      expect(source).not.toContain("ml-proxy");
      expect(source).not.toContain("mlUrl");
      expect(source).not.toContain("fetch(");
    }
  });

  it("reads the canonical view and never a base table", () => {
    expect(READ).toContain("canonicalCurtailmentByReportingEntity");
    for (const table of [
      "curtailment_report_hour",
      "reporting_entity ",
      "plant_detail_hour",
    ]) {
      expect(READ).not.toContain(table);
      expect(ROUTE).not.toContain(table);
    }
  });

  it("sets the vintage axis on every one of the three reads", () => {
    // `canonical_as_of()` raises 22023 when unset. Three reads, three writes of
    // the axis — a read that forgot it would fail loudly rather than quietly
    // answering with the latest version of every row.
    expect(READ.match(/applyAxes\(tx,/g)?.length).toBe(3);
  });

  it("computes episodes on read and stores nothing at episode grain", () => {
    // The function is the whole implementation: there is no insert, no table
    // and no cache of episodes anywhere on this path.
    expect(READ).toContain("canonical_curtailment_episodes(");
    for (const forbidden of ["insert into", "INSERT INTO", "pgTable"]) {
      expect(READ).not.toContain(forbidden);
    }
  });

  it("translates through the one translator rather than by rule", () => {
    expect(ROUTE).toContain("encodeWire");
    expect(ROUTE).not.toContain('from "../contract/wire.js"');
  });

  it("takes the threshold and the gap from the shared constants", () => {
    // A route that wrote `5` here would be a second place the threshold lives,
    // which is exactly what stamping it on every episode exists to prevent.
    expect(ROUTE).toContain("SUBSYSTEM_THRESHOLD_MW");
    expect(ROUTE).toContain("MAX_GAP_HOURS");
  });

  it("returns no gloss for a reason code", () => {
    // Vocabulary rule 7: the identifier travels, the English wording is a
    // `t()` key in the web app. None of the four codes' glosses appear here.
    for (const gloss of [
      "Grid unavailability",
      "Reliability",
      "Energetic",
      "Oversupply",
    ]) {
      expect(ROUTE).not.toContain(gloss);
      expect(READ).not.toContain(gloss);
    }
  });
});

describe("curtailment · the routes", () => {
  it("are registered on the app under /v1", () => {
    const routes = app.routes.map((route) => `${route.method} ${route.path}`);
    expect(routes).toContain("GET /v1/curtailment/hours");
    expect(routes).toContain("GET /v1/curtailment/episodes");
    expect(routes).toContain("GET /v1/curtailment/reasons");
  });

  it("has no plant parameter on the reasons route", () => {
    // Deriving a plant's reason from its conjunto's is an allocation, and v1
    // computes none — so there is nothing for a `plant=` to mean.
    const reasons = app.routes.find((route) => route.path === "/v1/curtailment/reasons");
    expect(reasons).toBeDefined();
    expect(ROUTE).not.toContain("plant:");
    expect(ROUTE).not.toContain("query.plant");
  });

  it("refuses a range beyond 400 days with the range code", async () => {
    const response = await get(
      "/v1/curtailment/hours?subsystem=NE&from=2024-01-01T00:00:00Z&to=2025-12-01T00:00:00Z",
    );
    expect(response.status).toBe(422);
    expect(await codeOf(response)).toBe("DATE_RANGE_TOO_LARGE");
  });

  it("accepts a range of exactly 400 days", async () => {
    // The cap is inclusive; 400 days is inside it and gets as far as the
    // database check, which is the next thing to fail here.
    const response = await get(
      "/v1/curtailment/hours?subsystem=NE&from=2025-01-01T00:00:00Z&to=2026-02-05T00:00:00Z",
    );
    expect(await codeOf(response)).toBe("DATA_UNAVAILABLE");
  });

  it("refuses an inverted or empty window rather than answering it", async () => {
    const response = await get(
      `/v1/curtailment/hours?subsystem=NE&from=${TO}&to=${FROM}`,
    );
    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe("BAD_INPUT");
  });

  it("refuses a threshold that is not a positive number", async () => {
    const response = await get(
      `/v1/curtailment/episodes?subsystem=NE&from=${FROM}&to=${TO}&threshold_mw=0`,
    );
    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe("BAD_INPUT");
  });

  it("refuses a fractional gap tolerance", async () => {
    const response = await get(
      `/v1/curtailment/episodes?subsystem=NE&from=${FROM}&to=${TO}&max_gap_hours=1.5`,
    );
    expect(response.status).toBe(400);
  });

  it("refuses an instant where a civil date belongs", async () => {
    const response = await get(
      "/v1/curtailment/reasons?subsystem=NE&date=2026-05-03T00:00:00Z",
    );
    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe("BAD_INPUT");
  });

  it("refuses a subsystem outside the closed enum, before the handler runs", async () => {
    // `SIN` is structurally unrepresentable as a Subsystem; the framework
    // refuses it rather than the route inventing a fifth member.
    const response = await get(
      `/v1/curtailment/hours?subsystem=SIN&from=${FROM}&to=${TO}`,
    );
    expect(response.status).toBe(422);
  });

  it("refuses lowercase technology rather than treating it as a synonym", async () => {
    const response = await get(
      `/v1/curtailment/hours?subsystem=NE&from=${FROM}&to=${TO}&technology=wind`,
    );
    expect(response.status).toBe(422);
  });

  it("answers an unconfigured database as an absence of data", async () => {
    for (const path of [
      `/v1/curtailment/hours?subsystem=NE&from=${FROM}&to=${TO}`,
      `/v1/curtailment/episodes?subsystem=NE&from=${FROM}&to=${TO}`,
      "/v1/curtailment/reasons?subsystem=NE&date=2026-05-03",
    ]) {
      const response = await get(path);
      expect(response.status).toBe(503);
      expect(await codeOf(response)).toBe("DATA_UNAVAILABLE");
    }
  });
});
