import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /** Apply pending migrations from the `drizzle/` folder. */
  migrate: () => Promise<void>;
  /** Round-trip a trivial query — used by the readiness probe. */
  ping: () => Promise<boolean>;
  /** Close the connection pool. */
  close: () => Promise<void>;
}

/**
 * How long a single statement may run before Postgres cancels it.
 *
 * **A connection-pool property, not a query one.** The pool is ten connections
 * wide and every read on this surface is a request-scoped `select`; without a
 * timeout, one query that plans badly holds its connection until it finishes or
 * the client goes away, and ten of those leave `/ready`'s own `select 1` with
 * nowhere to run — the instance reports unhealthy and is pulled from rotation
 * while the queries carry on.
 *
 * Thirty seconds is far beyond any read here (the slowest measured is the
 * canonical training window at well under a second) and far short of the
 * indefinite it replaces. A statement that needs longer than this is a
 * statement that has gone wrong, and cancelling it is the correct answer.
 */
const STATEMENT_TIMEOUT_MS = 30_000;

/**
 * How long a connection may sit idle *inside a transaction* before it is closed.
 *
 * The narrower hazard, and the more insidious one: a transaction that opens and
 * then waits — on an await that never settles, on a caller that vanished — holds
 * its connection *and* its locks for as long as the process lives, and
 * `statement_timeout` never fires because no statement is running. Ten seconds
 * is longer than any transaction here legitimately takes; `training-window`'s
 * seven serial reads are the longest and they do not pause between them.
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

/** Create a Drizzle/postgres handle for a given URL (used by the app and tests). */
export function createDatabase(url: string, max = 10): DatabaseHandle {
  const client = postgres(url, {
    max,
    // Set on the connection rather than per query, so a read added next month
    // is bounded by construction rather than by its author remembering.
    connection: {
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
  });
  // `casing` must match drizzle.config.ts, or the runtime will quote camelCase
  // column names that the migration created as snake_case.
  const db = drizzle(client, { schema, casing: "snake_case" });
  return {
    db,
    migrate: () => migrate(db, { migrationsFolder: "drizzle" }),
    ping: async () => {
      try {
        await client`select 1`;
        return true;
      } catch {
        return false;
      }
    },
    close: () => client.end({ timeout: 5 }),
  };
}

/** Process-wide handle, or `undefined` when DATABASE_URL isn't configured. */
export const database: DatabaseHandle | undefined = config.databaseUrl
  ? createDatabase(config.databaseUrl)
  : undefined;
