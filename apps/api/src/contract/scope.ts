import { sql } from "drizzle-orm";
import { canonicalReadGoLive } from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import type { CanonicalReadName } from "./manifest.js";

/**
 * The read axes, on their way into the database.
 *
 * A view cannot take an argument, so the canonical views read their axes from
 * session settings (`drizzle/0012_canonical_read_axes.sql`). This module is the
 * only place on the TypeScript side that writes them; `apps/ml` has the exact
 * mirror of it in `wattsteer_ml/canonical_reads.py`, and between them that is
 * the whole of the coupling between the two languages and the contract.
 *
 * Three properties are worth stating, because each one closes a way of getting
 * this wrong quietly:
 *
 * 1. **Every axis is written on every call**, absent ones as the empty string.
 *    The settings live on a pooled connection, and a read that only wrote the
 *    axes it cared about would inherit the previous read's gate — an answer
 *    that is wrong in a way no test of that read alone could see.
 * 2. **`set_config(..., true)` is transaction-local**, so the axes cannot
 *    outlive the transaction that set them and cannot leak back into the pool.
 *    That is also why `applyAxes` must be called inside one: `withAxes` opens a
 *    transaction for callers that are not already in one.
 * 3. **There is no default `as_of`.** `canonical_as_of()` raises `22023` when
 *    the setting is missing rather than falling back to `now()`, so forgetting
 *    the axis is a loud failure and never a latest-version read wearing an
 *    as-of read's clothes.
 */
export interface ReadAxes {
  /** Vintage cut: what WattSteer had learned by this instant. Never optional. */
  asOf: Date;
  /** Fleet date for a registry read. Truncated to a UTC day by the database. */
  fleetDate?: Date;
  /** The day-ahead forecast gate. Cuts on publication, not on ingestion. */
  publishedAtOrBefore?: Date;
  /** Restrict the weather read to one run cycle. Absent is the normal read. */
  weatherRunCycle?: "00Z" | "12Z";
}

/** An absent axis is written as the empty string, which the SQL side reads as null. */
const axis = (value: Date | string | undefined): string =>
  value === undefined ? "" : typeof value === "string" ? value : value.toISOString();

/**
 * Write the axes for the statements that follow, for this transaction only.
 *
 * Must be called inside a transaction — see property 2 above. One statement
 * rather than four, because four round trips per canonical read would be paid
 * seven times over by `readTrainingWindow`.
 */
export async function applyAxes(tx: Database, axes: ReadAxes): Promise<void> {
  await tx.execute(sql`
    select
      set_config('wattsteer.as_of', ${axis(axes.asOf)}, true),
      set_config('wattsteer.fleet_date', ${axis(axes.fleetDate)}, true),
      set_config('wattsteer.published_at_or_before',
                 ${axis(axes.publishedAtOrBefore)}, true),
      set_config('wattsteer.weather_run_cycle', ${axis(axes.weatherRunCycle)}, true)
  `);
}

/**
 * Open a transaction, write the axes into it, and run a read.
 *
 * For callers that hold a pool handle rather than a transaction — the ingest
 * repositories' as-of reads, and the feature builders that call them. The
 * canonical contract does not use this: `readOnly` already opens its
 * transaction, and one snapshot per answer is part of what it promises.
 */
export async function withAxes<T>(
  db: Database,
  axes: ReadAxes,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    await applyAxes(scoped, axes);
    return run(scoped);
  });
}

/**
 * WattSteer's own go-live for one read — the earliest instant anything was
 * ingested for its source.
 *
 * The single input the fidelity rule takes from the database, and the only
 * reason `canonical_read_go_live` exists. The rule itself stays a pure function
 * in each language (`vintage.ts`, `wattsteer_ml/canonical.py`), bound by the
 * golden vectors: pushing an inequality over two instants into SQL would buy
 * nothing and would cost the one part of this contract that is testable without
 * a database.
 *
 * Deliberately not filtered by the `as_of` axis — go-live is a fact about
 * WattSteer's history, not about the cut being asked for, and filtering it
 * would make a sufficiently early `as_of` report a live source as having
 * ingested nothing. It is also the one canonical view that needs no axis set.
 */
export async function readGoLive(
  tx: Database,
  read: CanonicalReadName,
): Promise<Date | null> {
  const rows = await tx.execute<{ go_live_at: string | null }>(
    sql`select go_live_at from ${canonicalReadGoLive} where read = ${read}`,
  );
  const [row] = [...rows];
  return row?.go_live_at ? new Date(row.go_live_at) : null;
}
