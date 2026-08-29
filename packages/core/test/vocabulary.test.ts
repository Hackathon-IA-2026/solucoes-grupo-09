import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSubsystem,
  parseTechnology,
  type SubsystemCode,
  type Technology,
} from "../src/domain";

/**
 * Two vocabulary rules from `docs/domain-model.md` that the promotion of this
 * module out of `apps/web` had to preserve rather than lose. Both are the kind
 * of rule a rewrite drops silently, because nothing fails when they go — the
 * failure arrives later, as a number that is wrong in a direction nobody can
 * see.
 */

const SOURCE = readFileSync(join(import.meta.dir, "..", "src", "domain.ts"), "utf8");

describe("`SIN` is not a subsystem", () => {
  test("it is not representable in the type", () => {
    // The type-level assertion: uncommenting the annotation below is a compile
    // error, which `bun run typecheck` is what actually enforces.
    // const national: SubsystemCode = "SIN";
    const members: SubsystemCode[] = ["N", "NE", "S", "SE"];
    expect(members).toHaveLength(4);
    // @ts-expect-error — `SIN` is ONS's national aggregate row, not a member.
    const national: SubsystemCode = "SIN";
    expect(members).not.toContain(national);
  });

  test("it is not accepted from a query parameter either", () => {
    expect(parseSubsystem("SIN")).toBeNull();
    expect(parseSubsystem("N")).toBe("N");
  });
});

describe("a lead time is derived, so nothing here stores one", () => {
  test("no exported type carries a lead-time field", () => {
    // `valid_time − published_at` is computable by anyone holding a
    // `ForecastOrigin` and the hour it describes. A stored copy is a second
    // number that can disagree with the two instants it came from.
    //
    // Asserted against the identifiers rather than the prose, which says
    // "lead time" with a space precisely so this stays checkable.
    expect(SOURCE).not.toMatch(/leadTime|lead_time/);
  });
});

describe("the technology parameter's casing is decided, not implicit", () => {
  test("the canonical spelling is uppercase", () => {
    const wind: Technology = "WIND";
    expect(parseTechnology(wind)).toBe("WIND");
    expect(parseTechnology("SOLAR")).toBe("SOLAR");
  });

  test("a lowercase spelling is rejected rather than silently accepted", () => {
    // Deliberate strictness: these responses are public and shared-cacheable
    // with no `Authorization` to `Vary` on, so a case-insensitive parameter
    // would fragment one answer across several cache entries.
    expect(parseTechnology("wind")).toBeNull();
    expect(parseTechnology("Solar")).toBeNull();
    expect(parseTechnology(undefined)).toBeNull();
  });
});
