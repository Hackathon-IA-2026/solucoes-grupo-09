import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createGridRoutes } from "../src/api/grid.js";
import { app } from "../src/api/index.js";
import { errorHandler } from "../src/api/plugins/errors.js";

/**
 * The claims about `/v1/grid/day` that need no database.
 *
 * The behaviour — four subsystems over a named day, the peak hour, the derived
 * national total — is proven against real Postgres in
 * `database-grid-day.test.ts`, which `bun run check` skips. What is here is
 * what the gate can hold: that the route exists, that it parses its axis
 * **before** it reaches for the database, and that its one honest departure
 * from `/v1/grid/now` is in the code rather than only in the spec.
 */

const SOURCE = join(import.meta.dir, "..", "src");

/** Source with line comments stripped first — see `grid-now.test.ts` on why. */
function code(relative: string): string {
  return readFileSync(join(SOURCE, relative), "utf8")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const ROUTE = code("api/grid.ts");
const READ = code("contract/grid-day.ts");
const withoutDb = new Elysia().use(errorHandler).use(createGridRoutes({ db: undefined }));
const get = (path: string) => withoutDb.handle(new Request(`http://localhost${path}`));

describe("grid/day · the route", () => {
  it("is registered on the app under /v1", () => {
    const routes = app.routes.map((route) => `${route.method} ${route.path}`);
    expect(routes).toContain("GET /v1/grid/day");
  });

  it("refuses a malformed date before it reaches for the database", async () => {
    /*
      The order `api-routes.md` fixes and `/v1/grid/context` shipped inverted: a
      bad request is a 400, not "the service is down". With no database
      configured, a route that reached for it first would answer 503 here — so
      this test is only meaningful *because* `db` is undefined.
    */
    const response = await get("/v1/grid/day?date=not-a-date");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_INPUT");
  });

  it("refuses an instant where a civil date belongs", async () => {
    const response = await get("/v1/grid/day?date=2026-09-22T00:00:00Z");
    expect(response.status).toBe(400);
  });

  it("answers an unconfigured database as an absence of data", async () => {
    const response = await get("/v1/grid/day?date=2026-09-22");
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DATA_UNAVAILABLE");
  });

  it("requires the date, which is the whole of what it adds to `now`", async () => {
    const response = await get("/v1/grid/day");
    expect(response.status).toBe(422);
  });
});

describe("grid/day · the boundary, structurally", () => {
  it("reaches the modelling service nowhere", () => {
    // Observed, and therefore servable with `apps/ml` down and nothing
    // promoted — the property the whole observed half of the product rests on.
    for (const forbidden of ["mlUrl", "postMl", "ml-proxy"]) {
      expect(READ).not.toContain(forbidden);
    }
  });

  it("reads the canonical view and never a base table", () => {
    // ADR-0005. The view owns the as-of pick, the renames, the grain and the
    // units; a base table in a product read is a second copy of all four.
    expect(READ).toContain("canonicalCurtailmentByReportingEntity");
    for (const forbidden of ["curtailment_report_hour", "pgTable", "insert into"]) {
      expect(READ).not.toContain(forbidden);
    }
  });

  it("sets the vintage axis rather than bypassing it", () => {
    // `canonical_as_of()` raises 22023 when unset, inside the transaction
    // `readOnly` opens. Both reads in this function are inside that one.
    expect(READ).toContain("readOnly(db, async (tx)");
    expect(READ).toContain("applyAxes(tx, { asOf: query.asOf })");
  });

  it("sums the hour before it takes the largest, or the peak is one entity's", () => {
    /*
      The inner grouping is the whole of what "the day's largest hour" means.
      `max(constrained_off_mwh)` over the view would return the largest single
      (entity, technology) row and print it as the hour — a number that is
      always smaller than the truth and looks entirely plausible.
    */
    expect(READ).toContain("with hourly as (");
    expect(READ).toContain("max(hour_mwh) as peak_hour_mwh");
    expect(READ).not.toContain("max(constrained_off_mwh)");
  });

  it("does not refuse an empty day, which is what separates it from `now`", () => {
    /*
      `/v1/grid/now` throws `DATA_UNAVAILABLE` when no hour is settled in all
      four subsystems, and is right to: an invented "now" under four zeroes
      reads as *no curtailment anywhere*. A named day cannot make that mistake —
      the caller said which day — and refusing here would make "tomorrow" and "a
      quiet Sunday" the same answer.

      Scoped to the handler's own slice, not the file: `/v1/grid/now` is in it
      and its refusal is correct. Non-vacuity is the two markers below.
    */
    const handler = ROUTE.slice(
      ROUTE.indexOf('"/v1/grid/day"'),
      ROUTE.indexOf('"/v1/grid/context"'),
    );
    expect(handler).toContain("readGridDay");
    expect(handler).toContain("civilDayWindow(");
    /*
      Exactly one `DATA_UNAVAILABLE`, and it is the unconfigured-database
      guard every route here carries. `not.toContain` was the first spelling
      and it failed on that guard — which is the assertion being too blunt
      rather than the route being wrong, and the count is what distinguishes
      "this route has no absence branch of its own" from "this route says
      nothing about absences at all".
    */
    expect(handler.match(/DATA_UNAVAILABLE/g) ?? []).toHaveLength(1);
    expect(handler).toContain("if (!deps.db)");
  });

  it("states the peak's absence with a reason rather than a bare null", () => {
    // `honesty.md`: a null without a typed reason is unrepresentable, and the
    // schema requires the pair. A zero here would say the subsystem settled
    // hours that happened to be empty, which is a different measurement.
    expect(ROUTE).toContain("peakHourUnavailableReason:");
    expect(ROUTE).toContain('"no_settled_curtailment"');
  });
});
