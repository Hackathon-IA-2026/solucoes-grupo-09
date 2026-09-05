import { describe, expect, it } from "bun:test";
import type {
  DiagnosisNarrationInput,
  Driver,
  NarrationClause,
  RuleFlag,
} from "@wattsteer/core/api";
import { NOTABLE_DRIVER_LIMIT, NOTABLE_SHARE_MIN } from "@wattsteer/core/driver-display";
import { explain, validate } from "@wattsteer/core/schema";
import { encodeWire } from "@wattsteer/core/wire";
import {
  NarrationTemplateError,
  narrationClauses,
  templateNarration,
} from "../src/diagnosis/index.js";

/**
 * The narration that is always there, and that never needed a model.
 *
 * Everything here is one closed document and nothing else: no database, no
 * cache, no network, no model. That is the property under test rather than a
 * convenience — `docs/specs/diagnosis.md` requires a complete narration when
 * the language model is down, when a rule withheld it and when the daily cap
 * is reached, and a test that needed anything beyond the payload would have
 * caught the template reaching for something an outage takes away.
 *
 * Four things this file is trying to make impossible:
 *
 *  1. **A paragraph assembled on the server.** Every value the template emits
 *     is a number or a code; nothing it produces has a space in it, so the
 *     decimal separator is still the reader's to choose.
 *  2. **A fired rule that goes unsaid.** The spec requires every `rule_flags`
 *     entry to be stated, so an unknown rule code fails loudly here rather
 *     than being silently dropped from the paragraph.
 *  3. **A number the template computed.** `top_two_share` and
 *     `total_attributed_mwh` are quoted from the document, never added up.
 *  4. **A group named that the screen does not show.** The display predicate
 *     is `packages/core`'s one predicate, so the paragraph and the bar chart
 *     cannot disagree about which groups exist.
 */

const SUM_ABS = 444;

const PHI: readonly [Driver["code"], number][] = [
  ["renewable_resource", 160],
  ["net_surplus", 96],
  ["export_stress", 64],
  ["demand_level", 48],
  ["ramp_shape", -32],
  ["calendar_season", -24],
  ["recent_history", 12],
  ["data_conditions", -8],
];

function groups(): Driver[] {
  return PHI.map(([code, phi], index) => ({
    code,
    labelCode: `driver.${code}`,
    phiMwh: phi,
    share: Math.abs(phi) / SUM_ABS,
    direction: phi >= 0 ? ("raises" as const) : ("lowers" as const),
    headlineFeature: "proxy_renewable_load_ratio",
    observed: 1.42,
    typical: 0.96,
    unit: "ratio" as const,
    hourDisagreement: 1 + index / 10,
    demoted: false,
  }));
}

function payload(
  overrides: Partial<DiagnosisNarrationInput> = {},
): DiagnosisNarrationInput {
  return {
    schemaVersion: "diagnosis.narration.v1",
    promptVersion: "2026-08-28.1",
    locale: "pt-BR",
    subsystem: "NE",
    subsystemDisplayName: "NORDESTE",
    targetDate: "2026-08-28",
    thresholdMw: 5,
    forecastOrigin: {
      runLabel: "dessem_free_v1__gate_late__thr5/2026-08-27T22:11:07Z",
      gateProfile: "gate_late",
      publishedAt: "2026-08-27T22:11:07.000Z",
    },
    vintageFidelity: "point_in_time",
    risk: { dayOccurrenceProbability: 0.87, riskClass: "high", hoursP50Nonzero: 9 },
    magnitude: {
      dayExpectedMwh: 412,
      baselineExpectedMwh: 96,
      dayEnergyP10Mwh: 0,
      dayEnergyP50Mwh: 370,
      dayEnergyP90Mwh: 980,
      peakPowerP50Mw: 118,
      peakHourLocal: 13,
    },
    attribution: {
      target: "expected_mwh_day",
      totalAttributedMwh: 316,
      sumAbsAttributedMwh: SUM_ABS,
      stderrMwh: 4.1,
      topTwoShare: (160 + 96) / SUM_ABS,
      groups: groups(),
    },
    ruleFlags: [],
    ...overrides,
  };
}

function keys(clauses: NarrationClause[]): string[] {
  return clauses.map((clause) => clause.key);
}

function withFlags(...flags: RuleFlag[]): NarrationClause[] {
  return narrationClauses(payload({ ruleFlags: flags }));
}

describe("the deterministic narration is a plan, not a paragraph", () => {
  it("says every one of the spec's required things, from the payload alone", () => {
    const clauses = narrationClauses(payload());
    // The risk class, the day against the baseline, the top two groups with
    // their directions and their readings, and the pre-computed top-two share.
    expect(keys(clauses)).toEqual([
      "risk_high",
      "magnitude",
      "peak",
      "driver_raises",
      "driver_raises",
      "top_two_share",
    ]);
  });

  it("names the risk class as its own clause rather than a filled-in word", () => {
    const classes = ["low", "elevated", "high"] as const;
    const named = classes.map(
      (riskClass) =>
        keys(
          narrationClauses(
            payload({
              risk: {
                dayOccurrenceProbability: 0.2,
                riskClass,
                hoursP50Nonzero: 0,
              },
            }),
          ),
        )[0],
    );
    expect(named).toEqual(["risk_low", "risk_elevated", "risk_high"]);
  });

  it("carries no string a reader could read: every value is a number or a code", () => {
    const clauses = narrationClauses(
      payload({
        ruleFlags: [
          {
            code: "stale_inputs",
            severity: "annotate",
            facts: {
              weather_run_age_hours: 12,
              weather_centroid_coverage: 0.8,
              null_headline_features: ["dessem_export_utilisation"],
            },
          },
        ],
      }),
    );
    const strings = clauses.flatMap((clause) =>
      Object.values(clause.values).flatMap((value) =>
        Array.isArray(value)
          ? value.map(String)
          : typeof value === "string"
            ? [value]
            : [],
      ),
    );
    expect(strings.length).toBeGreaterThan(0);
    for (const value of strings) {
      // A code has no whitespace; prose does. The same discriminator the
      // payload's own `assertCodesOnly` turns on, one layer downstream.
      expect(value).not.toMatch(/\s/);
    }
  });

  it("quotes the pre-computed figures instead of adding anything up", () => {
    const one = payload();
    const clauses = narrationClauses(one);
    const share = clauses.find((clause) => clause.key === "top_two_share");
    const magnitude = clauses.find((clause) => clause.key === "magnitude");
    expect(share?.values.top_two_share).toBe(one.attribution.topTwoShare);
    expect(magnitude?.values.total_attributed_mwh).toBe(
      one.attribution.totalAttributedMwh,
    );
  });

  it("says which way the model moved, and nothing about the grid", () => {
    const lowering = groups().map((group) => ({
      ...group,
      direction: "lowers" as const,
    }));
    const clauses = narrationClauses(
      payload({ attribution: { ...payload().attribution, groups: lowering } }),
    );
    expect(keys(clauses).filter((key) => key.startsWith("driver_"))).toEqual([
      "driver_lowers",
      "driver_lowers",
    ]);
  });
});

describe("the display cut is shared and the merge is not", () => {
  it("only names groups the screen shows", () => {
    // Two groups above the cut, six below it: the paragraph names the two and
    // never reaches for a third, because there is no third on the screen.
    const thin = groups().map((group, index) => ({
      ...group,
      share: index < 2 ? 0.45 : NOTABLE_SHARE_MIN / 2,
    }));
    const clauses = narrationClauses(
      payload({ attribution: { ...payload().attribution, groups: thin } }),
    );
    expect(keys(clauses).filter((key) => key.startsWith("driver_"))).toHaveLength(2);
  });

  it("says a displayed group acted in both directions when its hours disagree", () => {
    const split = groups().map((group, index) =>
      index === 0 ? { ...group, hourDisagreement: 2.4 } : group,
    );
    const clauses = narrationClauses(
      payload({ attribution: { ...payload().attribution, groups: split } }),
    );
    const both = clauses.find((clause) => clause.key === "hour_disagreement");
    expect(both?.values.code).toBe("renewable_resource");
    expect(both?.values.hour_disagreement).toBe(2.4);
  });

  it("does not report a both-directions group the screen never displays", () => {
    // Below the share cut and beyond the row cap: still eight groups on the
    // wire, and still not a group the paragraph may name.
    const hidden = groups().map((group, index) =>
      index < NOTABLE_DRIVER_LIMIT
        ? group
        : { ...group, share: NOTABLE_SHARE_MIN / 2, hourDisagreement: 9 },
    );
    const clauses = narrationClauses(
      payload({ attribution: { ...payload().attribution, groups: hidden } }),
    );
    expect(keys(clauses)).not.toContain("hour_disagreement");
  });

  it("never emits `other` or `mixed`: neither exists on this side", () => {
    const clauses = narrationClauses(payload());
    const all = JSON.stringify(clauses);
    expect(all).not.toContain("mixed");
    expect(all).not.toContain('"other"');
  });
});

describe("every rule that fired is stated", () => {
  it("states the two withholding rules with the facts they fired on", () => {
    const clauses = withFlags(
      {
        code: "nothing_to_explain",
        severity: "withhold",
        facts: {
          day_occurrence_probability: 0.02,
          lowest_risk_bin_edge: 0.35,
          hours_p50_nonzero: 0,
        },
      },
      {
        code: "attribution_is_noise",
        severity: "withhold",
        facts: { sum_abs_attributed_mwh: 6.2, attribution_stderr_mwh: 4.1 },
      },
    );
    expect(keys(clauses)).toContain("flag_nothing_to_explain");
    expect(keys(clauses)).toContain("flag_attribution_is_noise");
  });

  it("states stale_inputs once per degradation that actually happened", () => {
    const partial = withFlags({
      code: "stale_inputs",
      severity: "annotate",
      facts: {
        weather_run_age_hours: null,
        weather_centroid_coverage: 0.8,
        null_headline_features: [],
      },
    });
    expect(keys(partial).filter((key) => key.startsWith("flag_stale"))).toEqual([
      "flag_stale_inputs_coverage",
    ]);

    const all = withFlags({
      code: "stale_inputs",
      severity: "annotate",
      facts: {
        weather_run_age_hours: 12,
        weather_centroid_coverage: 0.8,
        null_headline_features: ["dessem_export_utilisation"],
      },
    });
    expect(keys(all).filter((key) => key.startsWith("flag_stale"))).toEqual([
      "flag_stale_inputs_run_age",
      "flag_stale_inputs_coverage",
      "flag_stale_inputs_headline",
    ]);
  });

  it("states the settled reason mix the outage rule reported", () => {
    const clauses = withFlags({
      code: "unmodelled_outage_regime",
      severity: "annotate",
      facts: {
        settled_date: "2026-08-27",
        top_reason: "REL",
        top_reason_share: 0.62,
      },
    });
    const flag = clauses.find((one) => one.key === "flag_unmodelled_outage_regime");
    expect(flag?.values).toEqual({
      date: "2026-08-27",
      top_reason: "REL",
      top_reason_share: 0.62,
    });
  });

  it("refuses to render a rule nobody has written a sentence for", () => {
    expect(() =>
      withFlags({ code: "corridor_saturated", severity: "annotate", facts: {} }),
    ).toThrow(NarrationTemplateError);
  });

  it("refuses a rule flag missing the facts its sentence quotes", () => {
    expect(() =>
      withFlags({
        code: "attribution_is_noise",
        severity: "withhold",
        facts: { sum_abs_attributed_mwh: 6.2 },
      }),
    ).toThrow(/cannot invent one/);
  });

  it("refuses a stale_inputs firing that records none of its degradations", () => {
    expect(() =>
      withFlags({
        code: "stale_inputs",
        severity: "annotate",
        facts: {
          weather_run_age_hours: null,
          weather_centroid_coverage: null,
          null_headline_features: [],
        },
      }),
    ).toThrow(/records nothing/);
  });
});

describe("the narration the endpoint returns", () => {
  it("is a valid `NarrationFromTemplate` against the published contract", () => {
    const narration = templateNarration(payload());
    expect(narration.source).toBe("template");
    expect(narration.locale).toBe("pt-BR");
    expect(narration.promptVersion).toBe("2026-08-28.1");
    const wire = encodeWire("NarrationFromTemplate", narration);
    const result = validate("diagnosis.schema.json#/$defs/narration_from_template", wire);
    expect(explain(result)).toBe("");
    expect(result.valid).toBe(true);
  });

  it("carries no `text`, because the words are the client's", () => {
    expect(templateNarration(payload())).not.toHaveProperty("text");
  });
});
