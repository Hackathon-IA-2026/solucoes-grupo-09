import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBSYSTEM_DISPLAY_ORDER } from "../src/constants.js";
import type {
  DisplayDriverCode,
  Band as DomainBand,
  DriverDirection as DomainDirection,
  DriverCode as DomainDriverCode,
  TechnologySplit as DomainSplit,
  SignedDriverDirection,
  SubsystemCode,
  Technology,
} from "../src/domain.js";
import { directionOf, splitFor, splitOther, TECHNOLOGIES } from "../src/domain.js";
import { readSchemas } from "../src/schema.js";
import type {
  Band as WireBand,
  DriverDirection as WireDirection,
  DriverCode as WireDriverCode,
  TechnologySplit as WireSplit,
  Subsystem as WireSubsystem,
  Technology as WireTechnology,
} from "../src/types.generated.js";

/**
 * The eight, written out rather than derived from either side.
 *
 * A list read off one of the two types would agree with that type by
 * construction. The whole point is that a third party names them.
 */
const WIRE_DRIVER_CODES: readonly WireDriverCode[] = [
  "renewable_resource",
  "demand_level",
  "net_surplus",
  "export_stress",
  "ramp_shape",
  "calendar_season",
  "recent_history",
  "data_conditions",
];

const DISPLAY_CODES: readonly DisplayDriverCode[] = [...WIRE_DRIVER_CODES, "other"];

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
  it("a wire Band is a domain Band and back, checked by the compiler", () => {
    // `bun run typecheck` is what enforces this; the runtime assertion below
    // only keeps the test honest about having run.
    const wire: WireBand = { p10: 1, p50: 2, p90: 3 };
    const domain: DomainBand = wire;
    const backAgain: WireBand = domain;
    expect(backAgain).toEqual(wire);
  });

  it("a wire Subsystem is a domain SubsystemCode and back", () => {
    const wire: WireSubsystem = "NE";
    const domain: SubsystemCode = wire;
    const backAgain: WireSubsystem = domain;
    expect(backAgain).toBe("NE");
    // @ts-expect-error — `SIN` is ONS's national aggregate, not a fifth member.
    const national: WireSubsystem = "SIN";
    expect(SUBSYSTEM_DISPLAY_ORDER).not.toContain(national as SubsystemCode);
  });

  it("a wire Technology is a domain Technology, uppercase on both sides", () => {
    const wire: WireTechnology = "WIND";
    const domain: Technology = wire;
    expect(TECHNOLOGIES).toContain(domain);
    // @ts-expect-error — case-sensitively: `wind` is a 422, not a synonym.
    const lower: WireTechnology = "wind";
    expect(TECHNOLOGIES).not.toContain(lower as Technology);
  });

  it("a wire TechnologySplit is a domain TechnologySplit and back", () => {
    const wire: WireSplit = { windMwh: 1200, solarMwh: 340 };
    const domain: DomainSplit = wire;
    const backAgain: WireSplit = domain;
    expect(backAgain).toEqual(wire);
    expect(splitFor(domain, "WIND")).toBe(1200);
    expect(splitFor(domain, "SOLAR")).toBe(340);
    expect(splitOther(domain, "WIND")).toBe(340);
  });

  it("neither side of the split has anywhere to put a quantile", () => {
    // The type-level half of `vocabulary-rules.test.ts`'s schema assertion: a
    // split is two scalars, so a client cannot carry a band through it even by
    // accident, and no chart can be handed one to draw.
    // @ts-expect-error — there is no per-technology band to publish.
    const banded: DomainSplit = { windMwh: { p10: 1, p50: 2, p90: 3 }, solarMwh: 0 };
    expect(typeof (banded as unknown as { windMwh: unknown }).windMwh).toBe("object");
  });

  it("a wire DriverCode is a domain DriverCode and back — the same eight", () => {
    // The change `api-surface.md` calls "a contract change nobody flagged":
    // the domain's driver codes used to be twelve prototype *feature* names
    // (`vre_load_ratio`, `hub_wind_speed`, …) while the wire's were the eight
    // groups of the driver-group map. Two definitions of the closed set the
    // dictionaries are keyed by — which is exactly the contradiction this file
    // exists to prevent, and it survived because nothing compared them.
    for (const wire of WIRE_DRIVER_CODES) {
      const domain: DomainDriverCode = wire;
      const backAgain: WireDriverCode = domain;
      expect(backAgain).toBe(wire);
    }
    // @ts-expect-error — a feature name is not a group. The game is played by
    // groups, and no model ever produced a `φ` for one feature.
    const feature: DomainDriverCode = "hub_wind_speed";
    expect(WIRE_DRIVER_CODES).not.toContain(feature as WireDriverCode);
    // @ts-expect-error — `other` is the client's merged remainder. It is not a
    // group, it never travels, and only `DisplayDriverCode` admits it.
    const merged: WireDriverCode = "other";
    expect(DISPLAY_CODES).toContain(merged as DisplayDriverCode);
  });

  it("a wire Driver's direction is a domain direction, and neither is mixed", () => {
    // `"mixed"` is a member of the domain's `DriverDirection` because the
    // merged `other` row reports it — and it is unreachable from anything the
    // wire can produce, because `Driver.direction` is the signed pair. A
    // grouped Shapley value is one number, so each of the eight has a sign;
    // only a sum of several can have cancelled.
    const wire: WireDirection = "raises";
    const signed: SignedDriverDirection = wire;
    const displayed: DomainDirection = signed;
    expect(displayed).toBe("raises");
    // @ts-expect-error — the wire has no third direction to send.
    const fromTheWire: WireDirection = "mixed";
    expect(fromTheWire as string).toBe("mixed");
    // @ts-expect-error — and no signed contribution can carry it either.
    const onAGroup: SignedDriverDirection = "mixed";
    expect(onAGroup as string).toBe("mixed");
    expect(directionOf(128)).toBe("raises");
    expect(directionOf(-16)).toBe("lowers");
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

  it("the subsystem enum is the same four in all three", () => {
    // Three places name the four subsystems: the schema (which Python reads),
    // `constants.ts` (which the gateway and the web app read) and the vector
    // (which is how the Python constants module is pinned). Two agreeing and
    // one drifting is the failure this asserts away.
    expect([...(defs.subsystem?.enum ?? [])].sort()).toEqual(
      [...SUBSYSTEM_DISPLAY_ORDER].sort(),
    );
    expect([...(defs.subsystem?.enum ?? [])].sort()).toEqual(
      vector.subsystems.map((entry) => entry.code).sort(),
    );
  });

  it("the technology enum is uppercase in all three", () => {
    expect(defs.technology?.enum).toEqual([...TECHNOLOGIES]);
    expect(defs.technology?.enum).toEqual(vector.technologies);
  });
});

describe("nothing in a request path reads the schema directory", () => {
  it("no other module under src/ imports src/schema.ts", () => {
    // `apps/api/Dockerfile` copies `packages/core/src` and not
    // `packages/core/schema`. An import from a route handler would pass
    // typecheck, pass `bun test`, and die in the container on first request —
    // a failure mode with no local reproduction, which is the worst kind.
    const src = join(import.meta.dir, "..", "src");
    const listing = readdirSync(src).filter(
      (file) => file.endsWith(".ts") && file !== "schema.ts",
    );
    const offenders = listing.filter((file) =>
      /from\s+["']\.\/schema\.js["']/.test(readFileSync(join(src, file), "utf8")),
    );
    expect(offenders).toEqual([]);
    // The listing has to have found the package, or the empty result above is
    // a statement about nothing. Measured: narrowing the suffix to one no file
    // carries left all 11 tests in this file green — and this check's whole
    // subject is a failure with no local reproduction, so it is the last one
    // that should be reporting clean for want of input.
    expect(listing.length).toBeGreaterThan(10);
    expect(listing).toContain("index.ts");
    expect(listing).toContain("wire.ts");
  });

  it("the package index does not re-export it either", () => {
    const index = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(index).not.toMatch(/export \* from "\.\/schema\.js"/);
  });
});
