import { afterAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import type { Database } from "../src/database/connection.js";
import { createDatabase } from "../src/database/connection.js";

// `canonical_read_go_live`, and the one property that cannot be asserted by
// reading it: that its row set is **derived** rather than listed.
//
// The view named eight reads at `0013` and nine after `0024`, all of them
// written out by hand — and `canonical_plant_registry` reads `plant_geo` under
// `canonical_as_of()` while appearing in none of them. Data-platform ticket 20
// replaced the union with a rule over the catalogue: every table a
// `canonical_*` view reads, transitively, that carries an `ingested_at` column.
// A tenth read added tomorrow therefore arrives with a go-live row and nobody
// has to remember to add one.
//
// This suite is the pin on that rule. Every test below either derives the
// expected set a second, independent way — through `information_schema`, whose
// dependency walk this repository did not write — or creates a read that did
// not exist when the test was written and asserts it is found. Nothing here
// enumerates the reads; the two tests that *name* a table name `plant_geo`,
// because that one is the finding the ticket exists for.
//
// Spin one up:
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:17-alpine
const TEST_DATABASE_URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * The same closure the shipped rule computes, walked over
 * `information_schema.view_table_usage` instead of `pg_depend`.
 *
 * The point of the duplication is that this repository wrote neither join:
 * `view_table_usage` is Postgres' own record of which tables a view reads, so a
 * mistake in the shipped recursion cannot be repeated identically here. The
 * transitive step is the one thing both have to do, because
 * `canonical_capacity_weight` reaches `plant_geo` through
 * `canonical_plant_registry` and a one-level walk would miss exactly the table
 * this ticket is about.
 */
const INDEPENDENT_CLOSURE = sql`
  with recursive reach as (
    select table_name as root, table_name as rel
    from information_schema.views
    where table_schema = 'public' and table_name like 'canonical\\_%'
    union
    select reach.root, usage.table_name
    from reach
    join information_schema.view_table_usage usage
      on usage.view_schema = 'public' and usage.view_name = reach.rel
  )
  select distinct
    replace(substring(reach.root from 11), '_', '-') as read,
    reach.rel as source_table
  from reach
  join information_schema.columns col
    on col.table_schema = 'public'
   and col.table_name = reach.rel
   and col.column_name = 'ingested_at'
  where reach.rel not in (
    select table_name from information_schema.views where table_schema = 'public'
  )
`;

interface Pair {
  read: string;
  source_table: string;
}

/** The SQLSTATE of a driver error, however deeply it is wrapped. */
const sqlStateOf = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^\d{5}$/.test(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

const pairs = async (db: Database, query: ReturnType<typeof sql>) => {
  const rows = [...(await db.execute<Pair>(query))];
  return rows.map((row) => `${row.read} <- ${row.source_table}`).sort();
};

suite("canonical_read_go_live, derived", () => {
  const handle = createDatabase(TEST_DATABASE_URL as string, 5);
  const { db } = handle;

  afterAll(() => handle.close());

  it("derives the same read/source pairs as Postgres' own dependency walk", async () => {
    const shipped = await pairs(
      db,
      sql`select distinct read, source_table from canonical_read_source()`,
    );
    const independent = await pairs(db, INDEPENDENT_CLOSURE);
    expect(shipped).toEqual(independent);
    // Non-vacuous, and specific about the one it was missing: the registry's
    // location source, reached transitively through the capacity weights.
    expect(shipped).toContain("plant-registry <- plant_geo");
    expect(shipped).toContain("capacity-weight <- plant_geo");
  });

  it("gives every read whose sources carry an ingestion axis a go-live row", async () => {
    // The completeness criterion, stated as the equality it is: the reads with
    // a row are exactly the reads the closure found a vintaged source for.
    const rows = [
      ...(await db.execute<{ read: string }>(
        sql`select read from canonical_read_go_live order by read`,
      )),
    ].map((row) => row.read);
    const expected = [
      ...(await db.execute<{ read: string }>(sql`
        with independent as (${INDEPENDENT_CLOSURE})
        select distinct read from independent order by read
      `)),
    ].map((row) => row.read);
    expect(rows).toEqual(expected);
    expect(rows.length).toBeGreaterThan(9);
  });

  it("has no row for a canonical read with no ingestion axis behind it", async () => {
    // "Shown not to need one", derived rather than argued.
    // `canonical_solar_centroid` reads `centroid_point`, a frozen geometry with
    // no `ingested_at`; `canonical_subsystem_state` reads `plant`, which has
    // none either. A NULL go-live means *this source has ingested nothing*, and
    // for a table with no ingestion axis at all that would be a false
    // statement, so the honest row is no row.
    const rows = [
      ...(await db.execute<{ read: string }>(sql`
        select read from canonical_read_go_live
        where read in ('solar-centroid', 'subsystem-state', 'read-go-live')
      `)),
    ];
    expect(rows).toEqual([]);
    // And those views really are canonical reads, so the absence is a decision
    // rather than a spelling mistake.
    const [present] = [
      ...(await db.execute<{ views: number }>(sql`
        select count(*)::int as views from information_schema.views
        where table_schema = 'public'
          and table_name in ('canonical_solar_centroid', 'canonical_subsystem_state')
      `)),
    ];
    expect(present?.views).toBe(2);
  });

  it("finds a read that did not exist when this test was written", async () => {
    // The acceptance criterion, and the only test here that could not be
    // written as an enumeration: a *tenth* read, created inside a transaction
    // that is rolled back, with no edit to any migration, view or list.
    let found: { read: string; go_live_at: string | null } | undefined;
    let sources: string[] = [];
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await scoped.execute(sql`
          create table dp20_probe_hour (
            probe_key text primary key,
            ingested_at timestamptz not null
          )
        `);
        await scoped.execute(sql`
          insert into dp20_probe_hour (probe_key, ingested_at) values
            ('a', '2026-03-01T00:00:00.000Z'),
            ('b', '2026-04-01T00:00:00.000Z')
        `);
        await scoped.execute(sql`
          create view canonical_dp20_probe as
            select probe_key, ingested_at from dp20_probe_hour
            where ingested_at <= canonical_as_of()
        `);
        found = [
          ...(await scoped.execute<{ read: string; go_live_at: string | null }>(sql`
            select read, go_live_at::text from canonical_read_go_live
            where read = 'dp20-probe'
          `)),
        ][0];
        sources = [
          ...(await scoped.execute<{ source_table: string }>(sql`
            select source_table from canonical_read_source() where read = 'dp20-probe'
          `)),
        ].map((row) => row.source_table);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    expect(sources).toEqual(["dp20_probe_hour"]);
    // The earliest `ingested_at`, which is what a go-live is.
    expect(found?.read).toBe("dp20-probe");
    expect(new Date(found?.go_live_at as string).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });

  it("takes the later go-live of a read with two sources, and NULL if either has none", async () => {
    // `docs/contracts/canonical-reads.md`'s weakest-link rule, at the grain the
    // derivation introduced: `plant-registry` has two vintaged sources and one
    // go-live, and it is the *later* one — or none at all, because a read one of
    // whose sources has ingested nothing has no honest go-live instant.
    let both: string | null | undefined;
    let empty: string | null | undefined;
    let key: string | undefined;
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await scoped.execute(sql`
          create table dp20_early (k text primary key, ingested_at timestamptz not null)
        `);
        await scoped.execute(sql`
          create table dp20_late (k text primary key, ingested_at timestamptz not null)
        `);
        await scoped.execute(sql`
          insert into dp20_early (k, ingested_at) values ('a', '2026-01-01T00:00:00.000Z')
        `);
        await scoped.execute(sql`
          insert into dp20_late (k, ingested_at) values ('a', '2026-06-01T00:00:00.000Z')
        `);
        await scoped.execute(sql`
          create table dp20_silent (k text primary key, ingested_at timestamptz not null)
        `);
        await scoped.execute(sql`
          create view canonical_dp20_pair as
            select e.k, e.ingested_at as early_at, l.ingested_at as late_at
            from dp20_early e
            join dp20_late l on l.k = e.k
            where e.ingested_at <= canonical_as_of()
        `);
        await scoped.execute(sql`
          create view canonical_dp20_quiet as
            select e.k from dp20_early e
            join dp20_silent s on s.k = e.k
            where e.ingested_at <= canonical_as_of()
        `);
        const rows = [
          ...(await scoped.execute<{ read: string; go_live_at: string | null }>(sql`
            select read, go_live_at::text from canonical_read_go_live
            where read in ('dp20-pair', 'dp20-quiet')
          `)),
        ];
        both = rows.find((row) => row.read === "dp20-pair")?.go_live_at;
        empty = rows.find((row) => row.read === "dp20-quiet")?.go_live_at;
        key = rows
          .map((row) => row.read)
          .sort()
          .join(",");
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    expect(key).toBe("dp20-pair,dp20-quiet");
    expect(new Date(both as string).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(empty).toBeNull();
  });

  it("refuses a table no canonical view reads under an ingestion axis", async () => {
    // `canonical_source_go_live` executes a dynamic `min(ingested_at)`, so it is
    // scoped to the tables the closure found rather than left as a general
    // primitive for reading any table in the schema.
    const outcome = await db
      .execute(sql`select canonical_source_go_live('ons_resource_version')`)
      .then(
        () => "resolved",
        (error: unknown) => sqlStateOf(error),
      );
    expect(outcome).toBe("22023");
  });
});
