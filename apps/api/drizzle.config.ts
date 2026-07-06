import { defineConfig } from "drizzle-kit";

// DATABASE_URL is read from .env (Bun/drizzle-kit load it). Used by
// `bun run db:generate` (create migrations) and `bun run db:migrate` (apply).
export default defineConfig({
  schema: "./src/database/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  casing: "snake_case",
});
