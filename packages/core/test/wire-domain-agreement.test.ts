import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBSYSTEM_CODES } from "../src/constants.js";
import type { Band as DomainBand, SubsystemCode, Technology } from "../src/domain.js";
import { TECHNOLOGIES } from "../src/domain.js";
import { readSchemas } from "../src/schema.js";
import type {
  Band as WireBand,
  Subsystem as WireSubsystem,
  Technology as WireTechnology,
} from "../src/types.generated.js";

/**
 * The generated wire contract and the hand-written domain module agree, and
 * neither is allowed to become a second definition of the other.
 *
 * `@wattsteer/core` deliberately exports both: `src/domain.ts` is the app's
 * algebra over the vocabulary (`Figure`, `band()`, `producerLabel`), and
 * `@wattsteer/core/api` is the schema's view of the same nouns. They share
 * names — `Band`, `Subsystem`, `Technology` — and the whole reason the module
 * was promoted out of `apps/web` was that two definitions of a domain type is
 * not duplication to be tidied later, it is a contradiction.
 *
 * The seam survives because the overlaps are asserted rather than assumed:
 * structurally, at compile time, and against the published golden vector.
 */

describe("the wire's nouns and the domain's nouns are the same nouns", () => {
  test("a wire Band is a domain Band and back, checked by the compiler", () => {
    // `bun run typecheck` is what enforces this; the runtime assertion below
    // only keeps the test honest about having run.
    const wire: WireBand = { p10: 1, p50: 2, p90: 3 };
    const domain: DomainBand = wire;
    const backAgain: WireBand = domain;
    expect(backAgain).toEqual(wire);
  });

  test("a wire Subsystem is a domain SubsystemCode and back", () => {
    const wire: WireSubsystem = "NE";
    const domain: SubsystemCode = wire;
    const backAgain: WireSubsystem = domain;
    expect(backAgain).toBe("NE");
    // @ts-expect-error — `SIN` is ONS's national aggregate, not a fifth member.
    const national: WireSubsystem = "SIN";
    expect(SUBSYSTEM_CODES).not.toContain(national as SubsystemCode);
  });

  test("a wire Technology is a domain Technology, uppercase on both sides", () => {
    const wire: WireTechnology = "WIND";
    const domain: Technology = wire;
    expect(TECHNOLOGIES).toContain(domain);
    // @ts-expect-error — case-sensitively: `wind` is a 422, not a synonym.
    const lower: WireTechnology = "wind";
    expect(TECHNOLOGIES).not.toContain(lower as Technology);
  });
});

describe("the schema, the constants module and the published vector agree", () => {
  const defs = (
    readSchemas().get("common.schema.json") as {
      $defs: Record<string, { enum?: string[] }>;
    }
  ).$defs;
  const vector = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "fixtures", "published-constants", "constants.json"),
      "utf8",
    ),
  ) as { subsystems: Array<{ code: string }>; technologies: string[] };

  test("the subsystem enum is the same four in all three", () => {
    // Three places name the four subsystems: the schema (which Python reads),
    // `constants.ts` (which the gateway and the web app read) and the vector
    // (which is how the Python constants module is pinned). Two agreeing and
    // one drifting is the failure this asserts away.
    expect([...(defs.subsystem?.enum ?? [])].sort()).toEqual([...SUBSYSTEM_CODES].sort());
    expect([...(defs.subsystem?.enum ?? [])].sort()).toEqual(
      vector.subsystems.map((entry) => entry.code).sort(),
    );
  });

  test("the technology enum is uppercase in all three", () => {
    expect(defs.technology?.enum).toEqual([...TECHNOLOGIES]);
    expect(defs.technology?.enum).toEqual(vector.technologies);
  });
});

describe("nothing in a request path reads the schema directory", () => {
  test("no other module under src/ imports src/schema.ts", () => {
    // `apps/api/Dockerfile` copies `packages/core/src` and not
    // `packages/core/schema`. An import from a route handler would pass
    // typecheck, pass `bun test`, and die in the container on first request —
    // a failure mode with no local reproduction, which is the worst kind.
    const src = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    for (const file of readdirSync(src)) {
      if (!file.endsWith(".ts") || file === "schema.ts") {
        continue;
      }
      if (/from\s+["']\.\/schema\.js["']/.test(readFileSync(join(src, file), "utf8"))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the package index does not re-export it either", () => {
    const index = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(index).not.toMatch(/export \* from "\.\/schema\.js"/);
  });
});
