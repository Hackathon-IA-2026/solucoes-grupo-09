import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /** Apply pending migrations from the `drizzle/` folder. */
  migrate(): Promise<void>;
  /** Round-trip a trivial query — used by the readiness probe. */
  ping(): Promise<boolean>;
  /** Close the connection pool. */
  close(): Promise<void>;
}

/** Create a Drizzle/postgres handle for a given URL (used by the app and tests). */
export function createDatabase(url: string, max = 10): DatabaseHandle {
  const client = postgres(url, { max });
  const db = drizzle(client, { schema });
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
