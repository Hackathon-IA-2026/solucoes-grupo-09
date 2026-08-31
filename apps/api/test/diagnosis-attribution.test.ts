import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attributionDigest,
  DRIVER_GROUP_CODES,
  parseAttributionPublication,
} from "../src/diagnosis/index.js";
import { groupingHasChanged } from "../src/diagnosis/reads.js";
import {
  attributionOf,
  attributionPayload,
  GROUP_HASH,
  rowsOf,
} from "./support/attribution-payload.js";

/**
 * What the write path refuses, and the one thing it will not let a rule do.
 *
 * No database here: every assertion below is about the *payload*, and a payload
 * that reaches Postgres has already passed all of them. The Postgres suite
 * (`database-diagnosis.test.ts`) proves the storage and the round trip; this
 * one proves that the numbers a stored attribution carries are the ones the
 * model computed.
 *
 * The load-bearing case is `withhold`. `docs/specs/api-surface.md` originally
 * had a withheld diagnosis return `drivers: []`; that violated the one-way
 * valve and has been corrected in both specs. A parser that accepted an empty
 * ranking whenever a `withhold` rule was present would quietly restore the old
 * behaviour, so the eight-group check here is unconditional and is asserted
 * with the rule fired, not without it.
 */
describe("the published attribution · what the writer refuses", () => {
  it("accepts the modelling service's own shape", () => {
    const parsed = parseAttributionPublication(attributionPayload());
    expect(parsed.artifactId).toBe("2024-05-06T03:11:07Z");
    expect(parsed.publishedAt.toISOString()).toBe("2024-05-06T22:00:00.000Z");
    expect(parsed.gateProfile).toBe("gate_late");
    expect(parsed.originKind).toBe("served");

    const [attribution] = parsed.attributions;
    expect(attribution?.drivers).toHaveLength(2 * DRIVER_GROUP_CODES.length);
    expect(attribution?.driverGroupHash).toBe(GROUP_HASH);
    expect(attribution?.backgroundSource).toBe("base_fit");
    expect(attribution?.governingRuleAction).toBeNull();
    // The day's ranking, in order, with the peak hour's kept beside it.
    const day = attribution?.drivers.filter((one) => one.grain === "day") ?? [];
    expect(day.map((one) => one.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(day[0]?.driverGroup).toBe("net_surplus");
  });

  it("keeps every driver when a rule withholds the narration", () => {
    // The valve: `withhold` suppresses the model's paragraph and the template
    // renders instead. It is not a licence to return an empty ranking.
    const withheld = parseAttributionPublication(
      attributionPayload({
        ruleFlags: [
          {
            code: "attribution_is_noise",
            action: "withhold",
            facts: { sum_abs_attributed_mwh: 404, stderr_mwh: 300 },
          },
        ],
      }),
    );
    const quiet = parseAttributionPublication(attributionPayload());
    const [after] = withheld.attributions;
    const [before] = quiet.attributions;

    expect(after?.drivers).toEqual(before?.drivers ?? []);
    expect(after?.dayExpectedMwh).toBe(before?.dayExpectedMwh as number);
    expect(after?.governingRuleAction).toBe("withhold");
  });

  it("resolves two conflicting rules to the strictest action", () => {
    const parsed = parseAttributionPublication(
      attributionPayload({
        ruleFlags: [
          { code: "stale_inputs", action: "annotate", facts: { age_hours: 12 } },
          { code: "nothing_to_explain", action: "withhold", facts: {} },
        ],
      }),
    );
    expect(parsed.attributions[0]?.governingRuleAction).toBe("withhold");
    expect(parsed.attributions[0]?.ruleFlags).toHaveLength(2);
  });

  it("refuses an action a rule is not allowed to take", () => {
    const rewritten = attributionPayload({
      ruleFlags: [{ code: "fix_the_number", action: "override", facts: {} }],
    });
    expect(() => parseAttributionPublication(rewritten)).toThrow(
      /annotate, demote or withhold/,
    );
  });

  it("refuses a ranking that is short a driver group", () => {
    const short = attributionPayload({
      mutate: (payload) => {
        const attribution = attributionOf(payload);
        attribution.groups = rowsOf(attribution.groups).slice(0, 7);
      },
    });
    expect(() => parseAttributionPublication(short)).toThrow(/may never delete a driver/);
  });

  it("refuses a ranking that is short a driver group even when withholding", () => {
    // The regression this file exists for.
    const short = attributionPayload({
      ruleFlags: [{ code: "attribution_is_noise", action: "withhold", facts: {} }],
      mutate: (payload) => {
        attributionOf(payload).groups = [];
      },
    });
    expect(() => parseAttributionPublication(short)).toThrow(/may never delete a driver/);
  });

  it("refuses shares taken over the displayed rows rather than all eight", () => {
    // What a share over the top three looks like from the outside: each bar is
    // individually plausible and the eight no longer sum to one.
    const circular = attributionPayload({
      mutate: (payload) => {
        const groups = rowsOf(attributionOf(payload).groups);
        const top = groups.slice(0, 3);
        const denominator = top.reduce(
          (total, group) => total + Math.abs(group.phi_mwh as number),
          0,
        );
        for (const group of groups) {
          group.share = Math.abs(group.phi_mwh as number) / denominator;
        }
      },
    });
    expect(() => parseAttributionPublication(circular)).toThrow(
      /over all eight groups|shares sum to/,
    );
  });

  it("refuses eight contributions that do not decompose the day's movement", () => {
    const wrong = attributionPayload({
      mutate: (payload) => {
        attributionOf(payload).day_expected_mwh = 500;
      },
    });
    expect(() => parseAttributionPublication(wrong)).toThrow(/day_expected_mwh/);
  });

  it("refuses a direction that disagrees with its own contribution", () => {
    const flipped = attributionPayload({
      mutate: (payload) => {
        const groups = rowsOf(attributionOf(payload).groups);
        const negative = groups.find((group) => (group.phi_mwh as number) < 0);
        if (negative) {
          negative.direction = "raises";
        }
      },
    });
    expect(() => parseAttributionPublication(flipped)).toThrow(
      /the sign is not a separate decision/,
    );
  });

  it("refuses an attribution of anything but the day's expected MWh", () => {
    const band = attributionPayload({
      mutate: (payload) => {
        attributionOf(payload).target = "day_energy_p90";
      },
    });
    expect(() => parseAttributionPublication(band)).toThrow(/expected_mwh_day/);
  });

  it("refuses a day that was summed from fewer than twenty-four hours", () => {
    const short = attributionPayload({
      mutate: (payload) => {
        attributionOf(payload).hours_attributed = 23;
      },
    });
    expect(() => parseAttributionPublication(short)).toThrow(/civil day/);
  });

  it("refuses a disagreement figure on the peak hour", () => {
    // One hour has nothing to disagree with, and a number there would be read
    // as one.
    const invented = attributionPayload({
      mutate: (payload) => {
        const peak = rowsOf(attributionOf(payload).peak_hour_groups);
        if (peak[0]) {
          peak[0].hour_disagreement = 1.4;
        }
      },
    });
    expect(() => parseAttributionPublication(invented)).toThrow(
      /nothing to disagree with/,
    );
  });

  it("defaults nothing: a missing figure is a refusal, never a zero", () => {
    const missing = attributionPayload({
      mutate: (payload) => {
        attributionOf(payload).stderr_mwh = undefined;
      },
    });
    expect(() => parseAttributionPublication(missing)).toThrow(/stderr_mwh/);
  });

  it("refuses a producer that does not produce WattSteer attributions", () => {
    const wrong = attributionPayload({
      mutate: (payload) => {
        (payload.forecast_origin as Record<string, unknown>).producer = "open_meteo";
      },
    });
    expect(() => parseAttributionPublication(wrong)).toThrow(/wattsteer/);
  });

  it("digests the grouping and the background as values, not as metadata", () => {
    // A re-publication under a new map, or against a different background, is a
    // different explanation of the same day. A digest blind to either would
    // decline to record it and the older row would stand as the current answer.
    const base = parseAttributionPublication(attributionPayload());
    const regrouped = parseAttributionPublication(
      attributionPayload({ driverGroupHash: "sha256:beef" }),
    );
    const redrawn = parseAttributionPublication(
      attributionPayload({ backgroundSource: "artifact" }),
    );
    const digest = (one: typeof base) =>
      attributionDigest(one, one.attributions[0] as never);

    expect(digest(regrouped)).not.toBe(digest(base));
    expect(digest(redrawn)).not.toBe(digest(base));
    expect(digest(parseAttributionPublication(attributionPayload()))).toBe(digest(base));
  });

  it("parses a payload the modelling service actually emitted", () => {
    /**
     * The cross-language seam. `test/fixtures/diagnosis/attribution.json` is a
     * real payload, produced by `wattsteer_ml.diagnosis.publication` and checked
     * in, so this parser is tested against the shape Python emits rather than
     * against the shape this file imagines it emits. The Python side asserts the
     * vector is still what it produces; this side asserts it is still what the
     * gateway accepts. Neither can drift without one of the two failing.
     */
    const vector = JSON.parse(
      readFileSync(
        join(import.meta.dir, "fixtures", "diagnosis", "attribution.json"),
        "utf8",
      ),
    );
    const parsed = parseAttributionPublication(vector);
    const [attribution] = parsed.attributions;
    expect(attribution?.hoursAttributed).toBe(24);
    expect(attribution?.drivers.filter((one) => one.grain === "day")).toHaveLength(8);
    expect(attribution?.drivers.filter((one) => one.grain === "peak_hour")).toHaveLength(
      8,
    );
    expect(attribution?.driverGroupHash.startsWith("sha256:")).toBe(true);
    expect(attribution?.backgroundSource).toBe("base_fit");
    expect(attribution?.governingRuleAction).toBeNull();
  });

  it("recognises a stored attribution whose grouping has since moved", () => {
    expect(groupingHasChanged({ driverGroupHash: GROUP_HASH }, GROUP_HASH)).toBe(false);
    expect(groupingHasChanged({ driverGroupHash: GROUP_HASH }, "sha256:beef")).toBe(true);
  });
});
