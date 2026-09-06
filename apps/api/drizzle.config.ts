import { defineConfig } from "drizzle-kit";

// DATABASE_URL is read from .env (Bun/drizzle-kit load it). Used by
// `bun run db:generate` (create migrations) and `bun run db:migrate` (apply).
//
// Migrations here are hand-written (`--custom`) because this schema needs
// function and composite-type DDL that drizzle-kit does not emit — but the
// snapshots under `drizzle/meta/` must still be *generated*, never copied
// forward. `apps/api/README.md` ("Schema and migrations") is the procedure;
// `test/drizzle-snapshot.test.ts` fails if the head snapshot drifts.
export default defineConfig({
  schema: ["./src/database/schema.ts", "./src/database/canonical-views.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  casing: "snake_case",
});
