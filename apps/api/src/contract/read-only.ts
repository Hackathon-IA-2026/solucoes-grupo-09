import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";

/**
 * The contract's read-only boundary.
 *
 * The ownership rule is `docs/specs/data-platform.md`'s: the Elysia API and its
 * worker own ingestion, the Drizzle schema and every migration; the modelling
 * side **reads only** and never migrates. `apps/ml` already enforces its half
 * in code — its pool opens every connection with
 * `default_transaction_read_only = on` — and this is the same guarantee on this
 * side of the boundary, for the surface the modelling side consumes.
 *
 * It is a transaction rather than a convention because a convention is checked
 * by a reviewer and a transaction is checked by Postgres. Anything that reaches
 * a `INSERT`, `UPDATE`, `DELETE` or `CREATE` from inside a canonical read gets
 * `25006 read_only_sql_transaction` and fails, including a future contributor's
 * well-meant "just record that this was queried".
 *
 * Wrapping every read in one transaction has a second, quieter benefit that is
 * worth the round trip on its own: a contract read that composes several
 * repository reads sees **one** snapshot. Without it, a composition spanning an
 * ingest commit could return a curtailment series from before the write and a
 * weather series from after it, and report a single `asOf` over the pair.
 */
export async function readOnly<T>(
  db: Database,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // `SET TRANSACTION` must precede the first query of the transaction, which
    // is why this is the statement immediately after BEGIN and not a pool-level
    // setting: the pool is shared with the ingestion worker, which writes.
    await tx.execute(sql`set transaction read only`);
    // The repository reads are typed against the pool handle. A transaction is
    // the same interface with a narrower lifetime — `execute` and the query
    // builders are identical — and Drizzle models the two as separate classes,
    // so the assertion is where that modelling choice is absorbed rather than
    // pushed onto every read signature.
    return run(tx as unknown as Database);
  });
}
