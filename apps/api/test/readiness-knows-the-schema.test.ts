import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { canonicalViewNames } from "../src/database/canonical-views.js";
import { createDatabase } from "../src/database/connection.js";

/**
 * **Readiness has to know whether the schema arrived, not just whether the
 * database answered.**
 *
 * This repo applies migrations out of band. Nothing in `apps/api/Dockerfile`
 * runs `db:migrate` — the `CMD` starts the server — so a deploy can reach
 * production ahead of the schema it needs, and a process in that state pings
 * perfectly well and then 500s every request that touches a missing view.
 *
 * It is not hypothetical. `0051` adds `canonical_latest_complete_settled_hour`
 * and `GET /v1/grid/now` selects from it, so shipping the API first would take
 * down the first call the Overview makes.
 *
 * Two claims, and the second is the one that matters:
 *
 *  1. The expected set is **derived from the schema module**, so a view added
 *     tomorrow is covered on the line it is declared rather than when somebody
 *     remembers a list.
 *  2. Dropping a view is **detected**. A guard that only ever runs against a
 *     correct database proves that a correct database is correct.
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** The view `0051` added — dropped and restored below, so pick a leaf. */
const PROBE = "canonical_latest_complete_settled_hour";

async function missing(db: ReturnType<typeof createDatabase>["db"]): Promise<string[]> {
  const rows = await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.views where table_schema = 'public'
  `);
  const present = new Set([...rows].map((row) => row.table_name));
  return canonicalViewNames().filter((name) => !present.has(name));
}

suite("readiness knows whether the migrations ran", () => {
  it("names every canonical view, read from the schema rather than a list", () => {
    const names = canonicalViewNames();
    // Non-vacuity on the derivation itself: an empty list would make the
    // detection test below pass for the wrong reason.
    expect(names.length).toBeGreaterThanOrEqual(15);
    expect(names).toContain(PROBE);
    expect(names).toContain("canonical_curtailment_by_reporting_entity");
    // Sorted and unique, so a failure prints a stable, diffable set.
    expect([...new Set(names)]).toEqual([...names]);
  });

  it("a migrated database is missing nothing", async () => {
    const handle = createDatabase(URL as string, 2);
    try {
      expect(await missing(handle.db)).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it("dropping a view is detected, and the view is named", async () => {
    const handle = createDatabase(URL as string, 2);
    const definition = await handle.db.execute<{ def: string }>(
      sql`select pg_get_viewdef(${PROBE}::regclass, true) as def`,
    );
    const body = [...definition][0]?.def;
    expect(typeof body).toBe("string");
    try {
      await handle.db.execute(sql.raw(`drop view ${PROBE}`));
      expect(await missing(handle.db)).toEqual([PROBE]);
    } finally {
      // Restored from the database's own definition, so the test cannot leave
      // a schema behind that differs from the one the migration wrote.
      await handle.db.execute(sql.raw(`create or replace view ${PROBE} as ${body}`));
      const after = await missing(handle.db);
      await handle.close();
      expect(after).toEqual([]);
    }
  });
});
