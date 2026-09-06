import { describe, expect, it } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The migration metadata must describe the schema this repo actually has.
 *
 * Every migration since `0016` has been written by hand — drizzle-kit emits
 * tables and views, not the function and composite-type DDL this schema needs
 * — and the habit that grew around that was to copy the previous snapshot
 * forward with a fresh `id`/`prevId`. That is silent: the snapshot chain stays
 * internally consistent while drifting away from `src/database/schema.ts`, and
 * the drift only surfaces the day somebody runs a plain `drizzle-kit generate`
 * and it offers to re-create five tables that already exist in production.
 *
 * It went unnoticed from `0033` to `0038`. The columns were right the whole
 * time on every table that existed at `0033`, so a spot check for a recently
 * added column said the snapshots were fine.
 *
 * So the invariant is asserted rather than remembered: generate against the
 * committed metadata, in a throwaway copy, and require that drizzle-kit finds
 * nothing to do. When it does find something, the head snapshot is stale —
 * regenerate it as `apps/api/README.md` describes, never by copying.
 */
describe("drizzle migration metadata", () => {
  it("is in sync with the schema: a plain generate emits nothing", () => {
    const api = resolve(import.meta.dir, "..");
    const work = mkdtempSync(join(tmpdir(), "wattsteer-drizzle-"));
    try {
      cpSync(join(api, "drizzle"), join(work, "drizzle"), { recursive: true });
      const before = readdirSync(join(work, "drizzle", "meta")).sort();
      const journalBefore = readFileSync(
        join(work, "drizzle", "meta", "_journal.json"),
        "utf8",
      );

      // drizzle-kit resolves its config's imports from the config's own
      // directory, and `out` from the cwd — so the throwaway copy needs the
      // workspace's modules on hand and is generated into from inside itself.
      symlinkSync(resolve(api, "../../node_modules"), join(work, "node_modules"));
      writeFileSync(
        join(work, "drizzle.config.ts"),
        `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: ${JSON.stringify([
    join(api, "src/database/schema.ts"),
    join(api, "src/database/canonical-views.ts"),
  ])},
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: "" },
  casing: "snake_case",
});
`,
      );

      const run = Bun.spawnSync(["bunx", "drizzle-kit", "generate"], {
        cwd: work,
        env: { ...process.env, DATABASE_URL: "" },
      });
      expect(run.stderr.toString()).toBe("");
      expect(run.exitCode).toBe(0);

      const sql = readdirSync(join(work, "drizzle")).filter((f) => f.endsWith(".sql"));
      const committed = readdirSync(join(api, "drizzle")).filter((f) =>
        f.endsWith(".sql"),
      );
      expect(sql.sort()).toEqual(committed.sort());
      expect(readdirSync(join(work, "drizzle", "meta")).sort()).toEqual(before);
      expect(readFileSync(join(work, "drizzle", "meta", "_journal.json"), "utf8")).toBe(
        journalBefore,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
