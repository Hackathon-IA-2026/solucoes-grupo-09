import { describe, expect, it } from "bun:test";
import type { NarrationClause, NarrationFromTemplate } from "@wattsteer/core/api";
import { en } from "../src/i18n/copy.en";
import { pt } from "../src/i18n/copy.pt";
import { formattersFor } from "../src/i18n/format";
import { LOCALES } from "../src/i18n/locale";
import {
  NARRATION_VALUE_NAMES,
  renderNarration,
  renderNarrationClause,
} from "../src/i18n/narration";

/**
 * The deterministic narration, said in the reader's own notation.
 *
 * The server sends a plan — `t()` keys and their values — precisely so that
 * the decimal separator is decided here. These tests pin the two halves of
 * that: the catalogue has a sentence for every clause the contract allows, and
 * every value the server can send has a formatter, so nothing reaches a
 * paragraph through `String(value)` with the server's punctuation still on it.
 */

const dictionaries = { pt, en } as const;

function clause(key: NarrationClause["key"], values: NarrationClause["values"]) {
  return { key, values };
}

/** One of every clause, with the values its sentence quotes. */
const EVERY_CLAUSE: NarrationClause[] = [
  clause("risk_low", risk()),
  clause("risk_elevated", risk()),
  clause("risk_high", risk()),
  clause("magnitude", {
    day_expected_mwh: 412,
    baseline_expected_mwh: 96,
    total_attributed_mwh: 316,
  }),
  clause("peak", { peak_power_p50_mw: 118, peak_hour_local: 13 }),
  clause("driver_raises", driver()),
  clause("driver_lowers", driver()),
  clause("top_two_share", { top_two_share: 0.56 }),
  clause("hour_disagreement", { code: "export_stress", hour_disagreement: 2.4 }),
  clause("flag_nothing_to_explain", {
    day_occurrence_probability: 0.02,
    lowest_risk_bin_edge: 0.35,
    hours_p50_nonzero: 0,
  }),
  clause("flag_attribution_is_noise", {
    sum_abs_attributed_mwh: 6.2,
    attribution_stderr_mwh: 4.1,
  }),
  clause("flag_stale_inputs_run_age", { weather_run_age_hours: 12 }),
  clause("flag_stale_inputs_coverage", { weather_centroid_coverage: 0.8 }),
  clause("flag_stale_inputs_headline", {
    null_headline_features: ["dessem_export_utilisation", "programmed_load_mwh"],
  }),
  clause("flag_unmodelled_outage_regime", {
    date: "2026-08-27",
    top_reason: "REL",
    top_reason_share: 0.62,
  }),
];

function risk(): NarrationClause["values"] {
  return {
    subsystem_display_name: "NORDESTE",
    target_date: "2026-08-28",
    threshold_mw: 5,
    day_occurrence_probability: 0.87,
    hours_p50_nonzero: 9,
  };
}

function driver(): NarrationClause["values"] {
  return {
    code: "net_surplus",
    share: 0.31,
    phi_mwh: 128,
    observed: 1.42,
    typical: 0.96,
    unit: "ratio",
  };
}

describe("the catalogue can say every sentence the contract allows", () => {
  for (const locale of LOCALES) {
    it(`${locale} renders every clause with no placeholder left behind`, () => {
      const copy = dictionaries[locale];
      const f = formattersFor(locale);
      for (const one of EVERY_CLAUSE) {
        const sentence = renderNarrationClause(one, copy, f);
        expect(sentence.length).toBeGreaterThan(0);
        // An unfilled `{placeholder}` is the failure this catches: the string
        // renders, and the reader sees a brace.
        expect(sentence).not.toMatch(/[{}]/);
      }
    });
  }

  it("every value the server can send has a formatter", () => {
    const sent = new Set(EVERY_CLAUSE.flatMap((one) => Object.keys(one.values)));
    for (const name of sent) {
      expect(NARRATION_VALUE_NAMES).toContain(name);
    }
  });

  it("a value with no formatter fails loudly rather than printing itself", () => {
    expect(() =>
      renderNarrationClause(
        clause("top_two_share", { invented_field: 1 }),
        en,
        formattersFor("en"),
      ),
    ).toThrow(/no formatter/);
  });
});

describe("numbers are formatted in the reader's locale, not the server's", () => {
  const one = clause("magnitude", {
    day_expected_mwh: 1412.5,
    baseline_expected_mwh: 96,
    total_attributed_mwh: 1316.5,
  });

  it("Portuguese writes the decimal comma and groups with a period", () => {
    expect(renderNarrationClause(one, pt, formattersFor("pt"))).toContain("1.412,5 MWh");
  });

  it("English writes the decimal point and groups with a comma", () => {
    expect(renderNarrationClause(one, en, formattersFor("en"))).toContain("1,412.5 MWh");
  });

  it("a driver group is named by its label, and its code never reaches a reader", () => {
    const sentence = renderNarrationClause(
      clause("driver_raises", driver()),
      pt,
      formattersFor("pt"),
    );
    expect(sentence).toContain(pt.app.drivers.groups.net_surplus);
    expect(sentence).not.toContain("net_surplus");
  });

  it("a share is a percentage and an hour is a wall clock", () => {
    const sentence = renderNarrationClause(
      clause("peak", { peak_power_p50_mw: 118, peak_hour_local: 13 }),
      en,
      formattersFor("en"),
    );
    expect(sentence).toContain("13:00");
    expect(sentence).toContain("118.0 MW");
  });
});

describe("the panel renders whichever surface produced the paragraph", () => {
  const template: NarrationFromTemplate = {
    source: "template",
    locale: "pt-BR",
    promptVersion: "2026-08-28.1",
    clauses: [
      clause("risk_high", risk()),
      clause("top_two_share", { top_two_share: 0.56 }),
    ],
  };

  it("a template becomes one paragraph, its clauses in order", () => {
    const paragraph = renderNarration(template, pt, formattersFor("pt"));
    expect(paragraph.split("\n")).toHaveLength(1);
    expect(paragraph.indexOf("NORDESTE")).toBeLessThan(paragraph.indexOf("56%"));
  });

  it("a model narration is returned as it arrived", () => {
    const text = "O modelo elevou a previsão em 316,0 MWh.";
    expect(
      renderNarration(
        { source: "model", text, locale: "pt-BR", promptVersion: "2026-08-28.1" },
        pt,
        formattersFor("pt"),
      ),
    ).toBe(text);
  });
});
