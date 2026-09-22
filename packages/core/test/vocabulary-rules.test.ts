import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSchemas, SCHEMA_DIR, validate } from "../src/schema.js";

/**
 * The nine vocabulary rules, each with a failing case.
 *
 * `docs/specs/api-surface.md` writes them as nine sentences and says of each
 * that it exists "because something has already got it wrong once". A sentence
 * in a spec prevents nothing; what prevents a recurrence is a document that the
 * schema **refuses**. So every rule below is asserted twice — a shape that
 * passes, and the nearly-identical shape that broke it, which must fail.
 *
 * The positive half matters as much as the negative one. A rule enforced by a
 * schema so strict that nothing valid passes is indistinguishable from a rule
 * enforced by accident.
 */

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(SCHEMA_DIR, "..", "fixtures", "spec-examples", name), "utf8"),
  ) as Record<string, unknown>;

/** A deep clone, so a mutation for one case cannot leak into the next. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const forecast = () => clone(fixture("04-forecast-day-ahead.json"));
const outlook = () => clone(fixture("02-grid-outlook.json"));
const replay = () => clone(fixture("12-replay.json"));
const result = () => clone(fixture("11-optimization-result.json"));
const diagnosis = () => clone(fixture("05-diagnosis-day-ahead.json"));

describe("rule 1 — a band is one shared reference, findable by grep", () => {
  const BAND_REF = "common.schema.json#/$defs/band";

  it("every band on the surface is that reference and not a copy of it", () => {
    // The rule's whole value is the grep. An inlined `{p10, p50, p90}` would
    // validate identically and would be invisible to the next person asking
    // "where are all the bands", which is the question this rule exists to
    // make answerable.
    const offenders: string[] = [];
    for (const [file, schema] of readSchemas()) {
      const walk = (node: unknown, path: string): void => {
        if (Array.isArray(node)) {
          node.forEach((item, index) => {
            walk(item, `${path}[${index}]`);
          });
          return;
        }
        if (typeof node !== "object" || node === null) {
          return;
        }
        const record = node as Record<string, unknown>;
        const properties = record.properties as Record<string, unknown> | undefined;
        // A band is three *numbers* under those three names. `scored` in the
        // optimizer and replay contracts is also keyed `p10/p50/p90` and is
        // not a band — it is one four-field object per realisation, and
        // summing two of those is meaningful where summing two bands is not.
        // The distinction is the member type, so that is what is checked.
        const isBandLiteral =
          properties !== undefined &&
          ["p10", "p50", "p90"].every(
            (key) =>
              (properties[key] as { type?: string } | undefined)?.type === "number",
          );
        if (isBandLiteral && path !== "$defs.band") {
          offenders.push(`${file}:${path}`);
        }
        for (const [key, value] of Object.entries(record)) {
          walk(value, path === "" ? key : `${path}.${key}`);
        }
      };
      walk(schema, "");
    }
    expect(offenders).toEqual([]);
  });

  it("the reference is used, and used widely", () => {
    const uses = [...readSchemas().values()].reduce(
      (total, schema) => total + JSON.stringify(schema).split(BAND_REF).length - 1,
      0,
    );
    expect(uses).toBeGreaterThan(5);
  });

  it("a band with p10 > p50 fails, which JSON Schema alone cannot say", () => {
    expect(validate(BAND_REF, { p10: 1, p50: 2, p90: 3 }).valid).toBe(true);
    expect(validate(BAND_REF, { p10: 5, p50: 2, p90: 3 }).valid).toBe(false);
    expect(validate(BAND_REF, { p10: 1, p50: 4, p90: 3 }).valid).toBe(false);
  });
});

describe("rule 2 — an expectation is never inside a band object", () => {
  it("the day expectation is a sibling of the day band", () => {
    const body = forecast();
    expect(body.day_expected_mwh).toBeDefined();
    expect(validate("forecast-day-ahead.schema.json", body).valid).toBe(true);
  });

  it("moving it inside the band fails validation", () => {
    const body = forecast();
    const band = body.day_energy_mwh as Record<string, unknown>;
    band.expected_mwh = body.day_expected_mwh;
    // For a mixture the expectation exceeds the P50 whenever p < 0.5, so a
    // reader who found it inside the band would reasonably take it for a
    // quantile. The band is closed so that it cannot get in.
    expect(validate("forecast-day-ahead.schema.json", body).valid).toBe(false);
  });

  it("a band may not be relabelled as its own centre either", () => {
    const body = forecast();
    const band = body.day_energy_mwh as Record<string, unknown>;
    band.p50 = body.day_expected_mwh;
    delete body.day_expected_mwh;
    expect(validate("forecast-day-ahead.schema.json", body).valid).toBe(false);
  });
});

describe("rule 3 — a technology split is two scalars", () => {
  it("two numbers pass", () => {
    expect(
      validate("common.schema.json#/$defs/technology_split", {
        wind_mwh: 2410.0,
        solar_mwh: 550.0,
      }).valid,
    ).toBe(true);
  });

  it("a quantile under the split fails", () => {
    // The forecaster publishes no per-technology band; the schema is what stops
    // a screen rendering one anyway.
    expect(
      validate("common.schema.json#/$defs/technology_split", {
        wind_mwh: { p10: 1, p50: 2, p90: 3 },
        solar_mwh: 550.0,
      }).valid,
    ).toBe(false);
  });

  it("an extra property under the split fails", () => {
    expect(
      validate("common.schema.json#/$defs/technology_split", {
        wind_mwh: 2410.0,
        solar_mwh: 550.0,
        p50: 2960.0,
      }).valid,
    ).toBe(false);
  });
});

describe("rule 4 — avoidability is number | null and the null is meaningful", () => {
  it("null passes", () => {
    const body = result();
    body.avoidability = null;
    expect(validate("optimization-result.schema.json", body).valid).toBe(true);
  });

  it("the key may not simply be absent", () => {
    // The distinction the rule protects is null against zero, and both are
    // destroyed by the field going missing: an absent ratio reads as "not
    // applicable" on every screen that forgets to check.
    const body = result();
    delete body.avoidability;
    expect(validate("optimization-result.schema.json", body).valid).toBe(false);
  });

  it("a string is not a way of saying undefined", () => {
    const body = result();
    body.avoidability = "undefined";
    expect(validate("optimization-result.schema.json", body).valid).toBe(false);
  });
});

describe("rule 5 — lead time is absent", () => {
  it("no schema anywhere names one", () => {
    // `valid_time − published_at`, computable by anyone holding a
    // `ForecastOrigin` and the hour it describes. A stored copy is a second
    // number that can disagree with the two instants it came from.
    const offenders: string[] = [];
    for (const [file, schema] of readSchemas()) {
      const text = JSON.stringify(schema);
      // Property names only: the prose is allowed to say "lead time".
      for (const match of text.matchAll(/"(lead_time[a-z_]*|leadTime[A-Za-z]*)"\s*:/g)) {
        offenders.push(`${file}:${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("rule 6 — SIN is not a subsystem value anywhere", () => {
  it("the enum has exactly the four", () => {
    const common = readSchemas().get("common.schema.json") as Record<string, unknown>;
    const defs = common.$defs as Record<string, { enum: string[] }>;
    expect(defs.subsystem.enum).toEqual(["N", "NE", "S", "SE"]);
  });

  it("a SIN subsystem fails", () => {
    expect(validate("common.schema.json#/$defs/subsystem", "SIN").valid).toBe(false);
    const body = outlook();
    const subsystems = body.subsystems as Record<string, unknown>[];
    const first = subsystems[0] as Record<string, unknown>;
    first.subsystem = "SIN";
    expect(validate("grid-outlook.schema.json", body).valid).toBe(false);
  });

  it("a national figure lives under `national`, with its derivation named", () => {
    // The observed national total is legitimate — observations add exactly —
    // and it says how it was built rather than pretending to be an ONS row.
    const now = clone(fixture("03-grid-now.json"));
    expect((now.national as Record<string, unknown>).derived).toBe("sum_of_four");
    (now.national as Record<string, unknown>).derived = "sin_row";
    expect(validate("grid-now.schema.json", now).valid).toBe(false);
  });

  it("a national forecast band may not be published without a reason", () => {
    // Medians do not add and neither do quantiles, so until the path ensemble
    // shares a draw index across subsystems the band is null and says why.
    const body = outlook();
    const national = body.national as Record<string, unknown>;
    expect(national.band).toBeNull();
    expect(national.band_unavailable_reason).toBe("no_joint_ensemble");
    national.band_unavailable_reason = null;
    expect(validate("grid-outlook.schema.json", body).valid).toBe(false);
  });
});

describe("rule 7 — reason codes are the identifier and the gloss is not returned", () => {
  it("the code passes and an English gloss does not", () => {
    expect(validate("common.schema.json#/$defs/reason_code", "ENE").valid).toBe(true);
    expect(
      validate("common.schema.json#/$defs/reason_code", "Energetic (oversupply)").valid,
    ).toBe(false);
  });

  it("no schema carries a translated label beside a code", () => {
    // `label_code` is a `t()` key and is allowed; `label`, `reason_label` and
    // `description_en` would be English travelling through the data layer,
    // which is how a bilingual product goes monolingual again.
    const offenders: string[] = [];
    for (const [file, schema] of readSchemas()) {
      for (const match of JSON.stringify(schema).matchAll(
        /"(reason_label|risk_label|driver_label|[a-z_]*_label_en|[a-z_]*_en)"\s*:/g,
      )) {
        offenders.push(`${file}:${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("an observed reason row rejects a gloss field", () => {
    const row = {
      grain: "conjunto",
      entity_code: "CJ-0042",
      entity_label: "CONJUNTO ALVORADA",
      reason: "ENE",
      origin: "SIS",
      constrained_off_mwh: 41.2,
      description: null,
      cause_mixed: false,
    };
    expect(validate("curtailment.schema.json#/$defs/reason_row", row).valid).toBe(true);
    expect(
      validate("curtailment.schema.json#/$defs/reason_row", {
        ...row,
        reason_label: "Energetic (oversupply)",
      }).valid,
    ).toBe(false);
  });
});

describe("rule 8 — threshold_mw is on every object it applies to", () => {
  const REQUIRED_ON: [string, string][] = [
    ["grid-outlook.schema.json", "the day-ahead outlook"],
    ["forecast-day-ahead.schema.json", "the day-ahead forecast"],
    ["diagnosis.schema.json", "the diagnosis"],
    ["optimization-result.schema.json", "every optimization result"],
    ["replay.schema.json", "every replay"],
    ["replay-observed-only.schema.json", "the observed-only view of a pre-F1 day"],
  ];

  for (const [file, what] of REQUIRED_ON) {
    it(`${what} requires it`, () => {
      const schema = readSchemas().get(file) as { required: string[] };
      expect(schema.required).toContain("threshold_mw");
    });
  }

  it("the whole-grid episode list requires a subsystem on every row", () => {
    /*
      **The one constraint the whole-grid answer rests on.**

      `GET /v1/curtailment/episodes` takes an optional `subsystem`; omitted, it
      returns all four and the envelope's `subsystem` is absent. So the row's is
      the only place the subsystem is ever stated, and if it were merely
      *usually* present, a response saying nothing about where any of its
      episodes happened would be schema-valid — the screen that filters them by
      region would compare against `undefined`, silently render an empty list,
      and print "no hour went above the threshold in this subsystem", which is
      a finding about the grid drawn from a missing key.

      The argument is the one the test below makes about `threshold_mw`: an
      unstamped figure cannot be compared with another one.
    */
    const common = readSchemas().get("common.schema.json") as {
      $defs: Record<string, { required: string[] }>;
    };
    expect(common.$defs.episode?.required).toContain("subsystem");
    // And the envelope's is optional, which is what makes the row's load-bearing.
    const curtailment = readSchemas().get("curtailment.schema.json") as {
      $defs: Record<string, { required: string[] }>;
    };
    expect(curtailment.$defs.episodes?.required).not.toContain("subsystem");
  });

  it("every episode carries it, and its max_gap_hours too", () => {
    const episode = readSchemas().get("common.schema.json") as {
      $defs: Record<string, { required: string[] }>;
    };
    expect(episode.$defs.episode?.required).toContain("threshold_mw");
    expect(episode.$defs.episode?.required).toContain("max_gap_hours");
  });

  it("an episode without it fails", () => {
    const body = replay();
    const episodes = body.episodes as Record<string, unknown>[];
    expect(validate("replay.schema.json", body).valid).toBe(true);
    delete episodes[0]?.threshold_mw;
    // An unstamped duration cannot be compared with another one, which is why
    // this is structural rather than a convention the writer remembers.
    expect(validate("replay.schema.json", body).valid).toBe(false);
  });
});

describe("rule 9 — vintage_fidelity is on every object carrying a metric", () => {
  const REQUIRED_ON = [
    "grid-outlook.schema.json",
    "grid-now.schema.json",
    "forecast-day-ahead.schema.json",
    "diagnosis.schema.json",
    "optimization-result.schema.json",
    "replay.schema.json",
    "replay-observed-only.schema.json",
    "replay-compare.schema.json",
    "replay-timeline.schema.json",
    "replay-attribution.schema.json",
  ];

  for (const file of REQUIRED_ON) {
    it(`${file} requires it`, () => {
      const schema = readSchemas().get(file) as { required: string[] };
      expect(schema.required).toContain("vintage_fidelity");
    });
  }

  it("a response without it fails", () => {
    const body = diagnosis();
    expect(validate("diagnosis.schema.json", body).valid).toBe(true);
    delete body.vintage_fidelity;
    expect(validate("diagnosis.schema.json", body).valid).toBe(false);
  });

  it("it stays top level on a replay rather than moving under `integrity`", () => {
    // A field whose whole purpose is that shared names do not shift meaning
    // must not shift position either. The replay-only vintage *detail* lives
    // under `integrity`; the verdict does not.
    const body = replay();
    const integrity = body.integrity as Record<string, unknown>;
    integrity.vintage_fidelity = body.vintage_fidelity;
    delete body.vintage_fidelity;
    expect(validate("replay.schema.json", body).valid).toBe(false);
  });

  it("nothing invents a third fidelity to average two into", () => {
    expect(validate("common.schema.json#/$defs/vintage_fidelity", "mixed").valid).toBe(
      false,
    );
    expect(
      validate("common.schema.json#/$defs/vintage_fidelity", "point_in_time").valid,
    ).toBe(true);
  });
});

describe("timestamps — two representations, and no third", () => {
  it("an instant must carry an explicit Z", () => {
    expect(
      validate("common.schema.json#/$defs/utc_instant", "2026-08-29T03:00:00Z").valid,
    ).toBe(true);
    // An offset-carrying local timestamp is the third representation the
    // domain model's interval convention exists to prevent.
    expect(
      validate("common.schema.json#/$defs/utc_instant", "2026-08-29T00:00:00-03:00")
        .valid,
    ).toBe(false);
    expect(
      validate("common.schema.json#/$defs/utc_instant", "2026-08-29T03:00:00").valid,
    ).toBe(false);
  });

  it("a civil date is a date and not an instant", () => {
    expect(validate("common.schema.json#/$defs/civil_date", "2026-08-29").valid).toBe(
      true,
    );
    expect(
      validate("common.schema.json#/$defs/civil_date", "2026-08-29T03:00:00Z").valid,
    ).toBe(false);
  });

  it("hour_local is 0-23 in Brasilia", () => {
    expect(validate("common.schema.json#/$defs/hour_local", 23).valid).toBe(true);
    expect(validate("common.schema.json#/$defs/hour_local", 24).valid).toBe(false);
    expect(validate("common.schema.json#/$defs/hour_local", -1).valid).toBe(false);
  });
});

describe("no response envelope", () => {
  it("a successful response is the resource, not `{data, meta}`", () => {
    // Adding a wrapper would buy nothing — pagination is needed on exactly two
    // routes and carries its own cursor — and would put a second shape between
    // every screen and every number.
    for (const file of [
      "grid-outlook.schema.json",
      "grid-now.schema.json",
      "forecast-day-ahead.schema.json",
      "diagnosis.schema.json",
    ]) {
      const schema = readSchemas().get(file) as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties)).not.toContain("data");
      expect(Object.keys(schema.properties)).not.toContain("meta");
    }
  });

  it("the error envelope is the single exception, and it is closed", () => {
    const schema = readSchemas().get("error.schema.json") as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties)).toEqual(["error"]);
    expect(schema.additionalProperties).toBe(false);
  });
});
