import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";

/**
 * The applied ledger still matches the migration files.
 *
 * **Migrations here are applied out of band.** Nothing in `apps/api/Dockerfile`
 * runs `db:migrate` — the `CMD` starts the server — so the ledger in a live
 * database is written by a human or a job, not by the deploy that depends on
 * it. `drizzle-snapshot.test.ts` holds the *source* side of this (a plain
 * `generate` emits nothing, so the schema and the files agree). Nothing held
 * the database side.
 *
 * It has already gone wrong once: a ledger with **53 rows for 52 files**, the
 * extra one carrying an empty hash. Drizzle decides what to apply by comparing
 * the journal against that table, so a corrupt ledger either skips a migration
 * the schema needs or re-applies one it has already run, and both fail later
 * and somewhere else — the first as a missing relation at request time, which
 * is the failure `readiness-knows-the-schema.test.ts` exists to catch one layer
 * up.
 *
 * Four properties, and the second is the one that was actually violated:
 *
 *  1. one ledger row per journal entry,
 *  2. **every hash is non-empty**,
 *  3. each row's hash is the SHA-256 of that entry's `.sql` file, byte for
 *     byte — which is what makes this a check on the *content* rather than the
 *     count, and would catch a file edited after it was applied,
 *  4. rows were applied in journal order.
 *
 * Gated on a real Postgres like the rest of the database suite: the `test:db`
 * script supplies `WATTSTEER_TEST_DATABASE_URL` and migrates first, and a plain
 * `bun test` skips this file.
 */

const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

const DRIZZLE_DIR = join(import.meta.dir, "..", "drizzle");

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

function journal(): readonly JournalEntry[] {
  const raw = readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

/** What drizzle stores: the SHA-256 of the migration file's bytes. */
function hashOf(tag: string): string {
  return createHash("sha256")
    .update(readFileSync(join(DRIZZLE_DIR, `${tag}.sql`)))
    .digest("hex");
}

suite("the migration ledger matches the files on disk", () => {
  const open = () => createDatabase(URL as string);

  async function ledger() {
    const { db, close } = open();
    try {
      return await db.execute<{ id: number; hash: string; created_at: string }>(sql`
        select id, hash, created_at
        from drizzle.__drizzle_migrations
        order by id
      `);
    } finally {
      await close();
    }
  }

  it("has one row per journal entry", async () => {
    const rows = await ledger();
    const entries = journal();
    // Non-vacuity: a journal that had somehow read empty would make this pass
    // against an empty ledger.
    expect(entries.length).toBeGreaterThan(0);
    expect(rows.length).toBe(entries.length);
  });

  it("carries no empty hash", async () => {
    /*
      The corruption that actually happened. An empty-hash row matches no
      migration, so drizzle cannot tell which file it stands for — and it is
      invisible to a count check if it arrives alongside a deleted row.
    */
    const rows = await ledger();
    for (const row of rows) {
      expect(row.hash?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("every row is the SHA-256 of its own migration file", async () => {
    /*
      The content check. A count check passes on a ledger whose rows are all
      present and all wrong; this one does not.

      It fires for two different reasons and the message says so, because the
      remedies are opposite. Against a **local** database it usually means the
      database is older than the files — a migration applied from a branch
      where it still differed, which a later `db:migrate` will not correct
      because the row already exists and drizzle skips it. Recreating the test
      database is the fix. Against **production** it means a migration file was
      edited after it was applied, and the file is what is wrong.

      Found on this check's first run: the shared local database carried an
      earlier `0048`, while a freshly migrated one matched all 52.
    */
    const rows = await ledger();
    const entries = journal();
    const mismatched = entries
      .map((entry, index) => ({ entry, row: rows[index] }))
      .filter(({ entry, row }) => row?.hash !== hashOf(entry.tag))
      .map(({ entry }) => entry.tag);
    expect(
      mismatched,
      mismatched.length === 0
        ? ""
        : `ledger disagrees with ${mismatched.join(", ")}. If this is a local ` +
            "database it is older than the files — recreate it, because " +
            "db:migrate will not rewrite a row that already exists. If it is " +
            "production, the migration file was edited after it was applied.",
    ).toEqual([]);
  });

  it("was applied in journal order", async () => {
    /*
      **Increasing, not contiguous.** The first version of this assertion
      required `id === idx + 1`, and production disproved it: its ledger runs
      1–51 and then 53, because repairing the 53-rows-for-52-files corruption
      deleted a row and the sequence does not go back. Nothing is wrong with
      that database — drizzle matches on hash, not on id — and an assertion that
      failed on it would have been the test wrong rather than the ledger.

      What actually has to hold is that the rows are in the journal's order, so
      the positional pairing the hash check above depends on is sound. Strictly
      increasing ids and non-decreasing timestamps say exactly that and nothing
      more.
    */
    const rows = await ledger();
    const ids = rows.map((row) => row.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);

    const applied = rows.map((row) => Number(row.created_at));
    expect([...applied].sort((a, b) => a - b)).toEqual(applied);
  });
});
