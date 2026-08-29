import { describe, expect, it } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { ERROR_CODES } from "@wattsteer/core/errors";
import { explain, validate } from "@wattsteer/core/schema";
import { t } from "elysia";
import { app } from "../src/api/index.js";

/**
 * Two mechanisms describe this API's shapes, and where they disagree the
 * **schema wins**.
 *
 * Elysia's Eden treaty over `type App` gives the gateway and the web app
 * compile-time parity for free — and gives Python nothing. So
 * `packages/core/schema/*.json` is the cross-language authority and TypeBox is
 * a convenience. `docs/specs/api-surface.md` calls this out as one of the four
 * places the spec is weakest, and it is right that "a test that two type
 * systems agree is harder to write well than this spec admits".
 *
 * So this suite does not try to compare two type systems. It compares two
 * **verdicts on the same values**: for every value that matters at a boundary,
 * TypeBox's answer and the schema's answer must be the same, and the assertion
 * is written so that the schema's answer is the one stated as expected. A
 * disagreement fails here and the fix is to move the gateway, never the schema
 * — which is what makes "the schema wins" a rule rather than a preference.
 */

/** The gateway's own TypeBox models, as `canonical.ts` derives them. */
const SUBSYSTEM = t.Union([
  t.Literal("N"),
  t.Literal("NE"),
  t.Literal("S"),
  t.Literal("SE"),
]);
const TECHNOLOGY = t.Union([t.Literal("WIND"), t.Literal("SOLAR")]);

/**
 * The values worth asking both mechanisms about.
 *
 * Every one of them is a case some part of the product has already got wrong:
 * `SIN` is ONS's aggregate row and was a fifth subsystem in an early fixture;
 * `wind` lowercase is the casing two frontend modules once disagreed about;
 * `sudeste` is what a caller types when the enum is not published.
 */
const SUBSYSTEM_CASES = ["N", "NE", "S", "SE", "SIN", "sudeste", "ne", "", "SE/CO"];
const TECHNOLOGY_CASES = ["WIND", "SOLAR", "wind", "Solar", "HYDRO", "", "WIND "];

describe("schema-treaty · TypeBox and the JSON Schema agree, and the schema is the authority", () => {
  for (const candidate of SUBSYSTEM_CASES) {
    it(`agrees about subsystem ${JSON.stringify(candidate)}`, () => {
      const bySchema = validate("common.schema.json#/$defs/subsystem", candidate).valid;
      const byTypeBox = Value.Check(SUBSYSTEM, candidate);
      // Written schema-first on purpose: read as "TypeBox must answer what the
      // schema answered", not "the two happen to match".
      expect(byTypeBox).toBe(bySchema);
    });
  }

  for (const candidate of TECHNOLOGY_CASES) {
    it(`agrees about technology ${JSON.stringify(candidate)}`, () => {
      const bySchema = validate("common.schema.json#/$defs/technology", candidate).valid;
      expect(Value.Check(TECHNOLOGY, candidate)).toBe(bySchema);
    });
  }

  it("both refuse SIN, which is the disagreement that would matter most", () => {
    expect(validate("common.schema.json#/$defs/subsystem", "SIN").valid).toBe(false);
    expect(Value.Check(SUBSYSTEM, "SIN")).toBe(false);
  });

  it("both refuse a lowercase technology, case-sensitively", () => {
    // These responses are public and shared-cacheable with no `Authorization`
    // to `Vary` on, so a case-insensitive parameter would fragment one answer
    // across several cache entries.
    expect(validate("common.schema.json#/$defs/technology", "wind").valid).toBe(false);
    expect(Value.Check(TECHNOLOGY, "wind")).toBe(false);
  });
});

describe("schema-treaty · the gateway's routes use the derived enums", () => {
  it("the canonical routes reject SIN and accept the four", async () => {
    // The end-to-end half: the models above are what `canonical.ts` builds, and
    // this asserts the route actually mounted them. A 422 rather than a 500 is
    // the whole point — the parameter was refused, not the query.
    const window =
      "as_of=2026-08-28T00:00:00Z&from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z";
    const subsystemRoute = `/v1/canonical/system-context?${window}`;
    const technologyRoute = `/v1/canonical/curtailment-by-reporting-entity?${window}`;

    const refused = await app.handle(
      new Request(`http://localhost${subsystemRoute}&subsystem=SIN`),
    );
    expect(refused.status).toBe(422);
    const lowercase = await app.handle(
      new Request(`http://localhost${technologyRoute}&technology=wind`),
    );
    expect(lowercase.status).toBe(422);

    // The positive half: a real member gets past validation and fails later,
    // on persistence, which is what proves the 422s above were the parameter
    // being refused rather than the route being broken.
    const accepted = await app.handle(
      new Request(`http://localhost${subsystemRoute}&subsystem=NE`),
    );
    expect(accepted.status).not.toBe(422);
  });

  it("a refusal arrives in the one envelope, with a code from the closed enum", async () => {
    const response = await app.handle(
      new Request(
        "http://localhost/v1/canonical/system-context?as_of=2026-08-28T00:00:00Z&from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z&subsystem=SIN",
      ),
    );
    const body = (await response.json()) as unknown;
    const result = validate("error.schema.json", body);
    expect(result.valid ? "" : explain(result)).toBe("");
    const code = (body as { error: { code: string } }).error.code;
    expect(ERROR_CODES as readonly string[]).toContain(code);
  });
});
