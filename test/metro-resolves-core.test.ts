import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `packages/core` must stay importable from the web bundle.
 *
 * This exists because it broke once and nothing noticed for several merges.
 * `apps/api` compiles under `moduleResolution: "NodeNext"`, which *requires*
 * the `.js` extension on every relative import inside `packages/core`.
 * TypeScript resolves `./causality.js` to `./causality.ts`; **Metro does not**,
 * so `expo export` died on `Unable to resolve module ./causality.js` while
 * `typecheck`, `lint` and every test stayed green — the failure is invisible to
 * all three, and only a real bundle catches it.
 *
 * `apps/web/metro.config.js` restores the TypeScript rule for the bundler. The
 * assertions below are the cheap standing guard: they cost milliseconds and run
 * in the default suite, where `bun run web:export` costs ninety seconds and so
 * gets skipped exactly when it matters. They do not replace running the export
 * before shipping a change to either package — they catch the specific way this
 * has already been broken.
 */
const ROOT = join(import.meta.dir, "..");
const CORE_SRC = join(ROOT, "packages/core/src");

describe("the web bundle can resolve @wattsteer/core", () => {
  it("has a metro config that rewrites the NodeNext extension", () => {
    const config = join(ROOT, "apps/web/metro.config.js");
    expect(existsSync(config)).toBe(true);
    const text = readFileSync(config, "utf8");
    // Both halves matter: the watch folder, because the package is a symlink
    // outside the project root, and the `.js` rewrite itself.
    expect(text).toContain("watchFolders");
    expect(text).toMatch(/\.js/);
  });

  it("the web image receives the metro config, not just the repository", () => {
    // The gap this guard admitted to having. It checked the config's contents
    // and never that the Docker build copies it, so `apps/web/Dockerfile`
    // shipped without `metro.config.js` and `expo export` died inside the
    // image on the exact error the docstring above describes — while the
    // export ran fine locally, where the file is simply present. Contents and
    // delivery are two claims and this file now makes both.
    const dockerfile = readFileSync(join(ROOT, "apps/web/Dockerfile"), "utf8");
    const copies = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("COPY ") && !line.includes("--from="));
    // Non-vacuous: the Dockerfile was read and it does copy things.
    expect(copies.length).toBeGreaterThan(3);
    expect(copies.some((line) => line.includes("apps/web/metro.config.js"))).toBe(true);
  });

  it("every `.js` specifier in core's barrel names a real `.ts` file", () => {
    // The barrel is what the web app imports, and the one file whose bad
    // specifier takes the whole bundle down.
    const barrel = readFileSync(join(CORE_SRC, "index.ts"), "utf8");
    const specifiers = [...barrel.matchAll(/from "\.\/([\w-]+)\.js"/g)].map(
      (match) => match[1] as string,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    const missing = specifiers.filter(
      (name) => !existsSync(join(CORE_SRC, `${name}.ts`)),
    );
    expect(missing).toEqual([]);
  });

  it("no module in core is an orphan", () => {
    // Not "everything is exported" — `casing` and `sha256` are internal helpers
    // that other core modules import, and forcing them into the barrel would
    // widen the public API to satisfy a test. The real defect is a module
    // reachable from *neither* the barrel nor another module: dead on both
    // sides of the wire, and invisible until someone wonders why editing it
    // changes nothing.
    const files = readdirSync(CORE_SRC).filter(
      (name) => name.endsWith(".ts") && name !== "index.ts",
    );
    // The listing has to have found the package, or `orphans` is `[]` because
    // there was nothing to be an orphan. Measured: narrowing the suffix to one
    // no file carries left all three tests in this file green. The two names
    // are the modules the exclusions below mention by hand, so a listing that
    // stopped reaching them would retire those exclusions silently too.
    expect(files.length).toBeGreaterThan(10);
    for (const name of ["types.generated.ts", "schema.ts"]) {
      expect(files).toContain(name);
    }
    const barrel = readFileSync(join(CORE_SRC, "index.ts"), "utf8");
    const sources = files.map((name) => readFileSync(join(CORE_SRC, name), "utf8"));
    const orphans = files
      .map((name) => name.replace(/\.ts$/, ""))
      .filter((name) => {
        if (barrel.includes(`from "./${name}.js"`)) {
          return false;
        }
        const specifier = `from "./${name}.js"`;
        return !sources.some((text) => text.includes(specifier));
      })
      // Reached by subpath export rather than by import: the generated wire
      // types (whose names would collide with the domain algebra's) and the
      // schema loader (which reads from disk, and the API image ships `src/`).
      .filter((name) => name !== "types.generated" && name !== "schema");
    expect(orphans).toEqual([]);
  });
});
