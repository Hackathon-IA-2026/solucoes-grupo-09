import { afterAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";

// Every source `canonical_read_go_live` reads carries an index that leads on
// `ingested_at`, so the view's `min(ingested_at)` per source is an index probe.
//
// The view is recomputed on every call, and the Time Machine calls it on every
// replay. On the AWS instance on 26/09, with constrained-off loaded from
// 2021-10, `min(ingested_at)` took 70 s on plant_detail_hour (3.6 M rows) and
// 8 s on curtailment_report_hour, and every replay timed out at the gateway's
// 5 s. The `*_as_of` indexes already held `ingested_at`, last, where a `min`
// cannot use it. A source added later without the index would bring that back
// with no test noticing, which is what this is for.
//
// Gated like the other database suites: `test:db` supplies the URL.
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

suite("the go-live reads (real Postgres)", () => {
  const handle = createDatabase(URL as string, 2);
  const { db } = handle;
  afterAll(() => handle.close());

  it("finds an index leading on ingested_at for every source of canonical_read_go_live", async () => {
    const rows = await db.execute<{ source_table: string; leading: boolean }>(sql`
      select s.source_table,
             exists (
               select 1
               from pg_index i
               join pg_class t on t.oid = i.indrelid
               join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
               where t.relname = s.source_table and a.attname = 'ingested_at'
             ) as leading
      from (select distinct source_table from canonical_read_source()) s
      order by s.source_table
    `);
    const tables = [...rows];
    // Not vacuous: the view reads a known set of sources, and an empty
    // catalogue would make every "has an index" check pass.
    expect(tables.length).toBeGreaterThan(10);
    expect(tables.filter((row) => !row.leading).map((row) => row.source_table)).toEqual(
      [],
    );
  });
});
