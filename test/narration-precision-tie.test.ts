import { describe, expect, it } from "bun:test";
import type { NarrationClause, UnitCode } from "@wattsteer/core/api";
import { NARRATION_DISPLAY } from "../apps/api/src/diagnosis/narration-canonical";
import { en } from "../apps/web/src/i18n/copy.en";
import { formattersFor } from "../apps/web/src/i18n/format";
import {
  formatNarrationValue,
  NARRATION_VALUE_NAMES,
} from "../apps/web/src/i18n/narration";

/**
 * The two tables keyed by field name, tied on decimals rather than by hand.
 *
 * The narration is split in two on purpose: the server emits `{key, values}`
 * clauses and the client formats every value through `Intl`, because a
 * server-assembled `text` would have already chosen between `412,0` and
 * `412.0` and turned a property of the reader into a property of the server.
 *
 * That split left two tables keyed by the same field names, matched by hand:
 *
 *  - `apps/api/src/diagnosis/narration-canonical.ts`'s `NARRATION_DISPLAY`,
 *    which rounds every float to a display precision **before** hashing, so
 *    the narration cache key is stable under recomputation jitter;
 *  - `apps/web/src/i18n/narration.ts`'s formatter table, which decides the
 *    digits a reader actually sees.
 *
 * **Membership is the wrong relation, in both directions**, and that is why
 * nobody had tied them. The server prices `day_energy_p10_mwh` and its two
 * siblings, which no clause carries and for which the client has no formatter
 * and should not. The client formats `target_date`, `date`, `top_reason` and
 * `subsystem_display_name`, which are strings the server is right not to round.
 * A subset assertion in either direction fails on correct code.
 *
 * The meaningful relation is **decimals**: for a name in both tables, the
 * digits the client displays are the precision the server hashed at. Asserting
 * that means invoking each formatter and counting the fraction digits it
 * emitted, which is complicated by percent formatters — they multiply by a
 * hundred, so a two-decimal fraction displays as a whole percentage — and by
 * unit suffixes. `NARRATION_DISPLAY` carries a `style` for exactly that reason,
 * so the two notations can be compared in one unit.
 *
 * The failure this catches is a quiet one, which is the argument for spending a
 * test on it: a rename or a decimals change on one side leaves the server
 * rounding a field nobody displays while a displayed one goes unrounded, and
 * the narration cache then misses forever at a cost nobody attributes to a
 * table entry. It has already caught one — `threshold_mw` was priced at one
 * decimal on the server while the client printed it at zero.
 */

/** English, so the fraction separator is `.` and the count is unambiguous. */
const f = formattersFor("en");

/**
 * A probe with more decimals than any field's precision.
 *
 * `Intl.NumberFormat` is configured with `minimumFractionDigits ===
 * maximumFractionDigits` throughout this product, so it emits exactly the
 * digits the formatter asked for and counting them is exact rather than a
 * guess about trailing zeros.
 */
const PLAIN_PROBE = 1.234_567_89;
/** The same, as a fraction: a percent formatter multiplies this by a hundred. */
const FRACTION_PROBE = 0.123_456_789;
/** A wall-clock hour on the grid's day. */
const HOUR_PROBE = 13;

/**
 * Names the server prices and the client does not format, each with its reason.
 *
 * Enumerated rather than skipped, so that a field *added* to one table without
 * the other is a failure. This is the half of the tie that membership can carry
 * once the exceptions are written down.
 */
const SERVER_ONLY: Readonly<Record<string, string>> = {
  day_energy_p10_mwh: "the day band; no clause carries it",
  day_energy_p50_mwh: "the day band; no clause carries it",
  day_energy_p90_mwh: "the day band; no clause carries it",
  stderr_mwh: "carried as attribution_stderr_mwh in the clause that states it",
};

/** Names the client formats and the server does not round: strings and lists. */
const CLIENT_ONLY: Readonly<Record<string, string>> = {
  subsystem_display_name: "ONS's proper noun, untranslated",
  target_date: "a civil date",
  date: "a civil date",
  top_reason: "a reason code",
  code: "a driver group code the catalogue holds a label for",
  unit: "notation appended to a reading, never a placeholder of its own",
  null_headline_features: "a list of feature codes, joined by Intl.ListFormat",
};

/**
 * Every unit a headline reading can arrive with.
 *
 * `observed` and `typical` are the one pair whose client decimals vary, and
 * they vary by `unit` — a property of the driver row rather than of the field —
 * so the server cannot price them per unit and does not try. The tie for them
 * is a bound plus the units it was checked over.
 */
const UNITS: readonly UnitCode[] = [
  "mwh",
  "mw",
  "pct",
  "hours",
  "brl",
  "count",
  "m_s",
  "ratio",
];

/** The one pair the bound applies to instead of the equality. */
const UNIT_VARYING = new Set(["observed", "typical"]);

function clauseFor(unit: UnitCode): NarrationClause {
  // `top_two_share` is a real key; the clause is only ever read for its `unit`.
  return { key: "top_two_share", values: { unit } };
}

/** The digits after the decimal separator in a formatted value. */
function fractionDigits(formatted: string): number {
  const match = /\.(\d+)/.exec(formatted);
  return match === null ? 0 : match[1].length;
}

function display(name: string, value: number, unit: UnitCode = "ratio"): string {
  return formatNarrationValue(name, value, clauseFor(unit), en, f);
}

describe("the two precision tables agree on decimals", () => {
  const shared = Object.keys(NARRATION_DISPLAY).filter((name) =>
    NARRATION_VALUE_NAMES.includes(name),
  );

  it("shares enough names for the check to mean something", () => {
    // A tie that silently stops matching anything passes forever.
    expect(shared.length).toBeGreaterThan(15);
  });

  for (const name of Object.keys(NARRATION_DISPLAY)) {
    if (!NARRATION_VALUE_NAMES.includes(name) || UNIT_VARYING.has(name)) {
      continue;
    }
    const { decimals, style } = NARRATION_DISPLAY[name];

    it(`${name}: the client prints the digits the server hashed at`, () => {
      if (style === "hour") {
        // An hour index has no decimals by construction, and the client writes
        // it as a wall clock rather than as a number.
        expect(decimals).toBe(0);
        expect(display(name, HOUR_PROBE)).toMatch(/^\d{2}:00$/);
        return;
      }
      if (style === "percent") {
        // `decimals` is the precision of the **fraction**; the client shows the
        // percentage, which is two digits further left.
        expect(fractionDigits(display(name, FRACTION_PROBE))).toBe(
          Math.max(decimals - 2, 0),
        );
        expect(display(name, FRACTION_PROBE)).toContain("%");
        return;
      }
      expect(fractionDigits(display(name, PLAIN_PROBE))).toBe(decimals);
    });
  }

  it("bounds the one pair whose client decimals vary by unit", () => {
    for (const name of UNIT_VARYING) {
      const { decimals, style } = NARRATION_DISPLAY[name];
      expect(style).toBe("plain");
      const perUnit = UNITS.map((unit) =>
        fractionDigits(display(name, PLAIN_PROBE, unit)),
      );
      // Never more than the server rounded to: a digit the reader can see must
      // never be a digit the cache key threw away.
      for (const digits of perUnit) {
        expect(digits).toBeLessThanOrEqual(decimals);
      }
      // And the server's precision is not idly generous: some unit uses it.
      expect(Math.max(...perUnit)).toBe(decimals);
    }
  });
});

describe("neither table quietly grows a field the other has not heard of", () => {
  it("accounts for every name the server prices and the client does not format", () => {
    const unexplained = Object.keys(NARRATION_DISPLAY).filter(
      (name) => !NARRATION_VALUE_NAMES.includes(name) && SERVER_ONLY[name] === undefined,
    );
    expect(unexplained).toEqual([]);
  });

  it("accounts for every name the client formats and the server does not price", () => {
    const unexplained = NARRATION_VALUE_NAMES.filter(
      (name) => NARRATION_DISPLAY[name] === undefined && CLIENT_ONLY[name] === undefined,
    );
    expect(unexplained).toEqual([]);
  });

  it("keeps no exception for a field that has since been retired", () => {
    // The allowlist-rot rule the causality boundary already applies to its own
    // exceptions: an entry whose field no longer exists has to fail, or the
    // list stops describing the code.
    for (const name of Object.keys(SERVER_ONLY)) {
      expect(NARRATION_DISPLAY[name]).toBeDefined();
      expect(NARRATION_VALUE_NAMES).not.toContain(name);
    }
    for (const name of Object.keys(CLIENT_ONLY)) {
      expect(NARRATION_VALUE_NAMES).toContain(name);
      expect(NARRATION_DISPLAY[name]).toBeUndefined();
    }
  });
});
