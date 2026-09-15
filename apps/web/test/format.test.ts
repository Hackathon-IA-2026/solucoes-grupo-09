import { describe, expect, it } from "bun:test";
import {
  fill,
  formatBrl,
  formatCompact,
  formatDate,
  formatDateTime,
  formatExact,
  formatHour,
  formatNumber,
  formatPercent,
  formatTag,
  GRID_TIME_ZONE,
} from "../src/i18n/format";

/**
 * The `/app` screens render values, and a value carries two locale decisions
 * that must not be conflated: how it is written follows the reader, but what
 * it means does not. These tests pin the second half, which is the half that
 * looks fine in development — on a Brazilian laptop, in Portuguese, every one
 * of these would pass by accident.
 */

describe("number formatting", () => {
  it("Portuguese groups with a period and separates decimals with a comma", () => {
    expect(formatNumber("pt", 1234.5, 1)).toBe("1.234,5");
    expect(formatNumber("en", 1234.5, 1)).toBe("1,234.5");
    expect(formatExact("pt", 12_500)).toBe("12.500");
    expect(formatExact("en", 12_500)).toBe("12,500");
  });

  it("`pt` means pt-BR, not bare Portuguese", () => {
    // Decimal comma, thousands period and R$ placement are pt-BR conventions;
    // bare `pt` would leave the region to the runtime's default.
    expect(formatTag("pt")).toBe("pt-BR");
    expect(formatTag("en")).toBe("en-US");
  });

  it("the compact form keeps its precision rules in both locales", () => {
    expect(formatCompact("pt", 12_500)).toBe("12,5k");
    expect(formatCompact("en", 12_500)).toBe("12.5k");
    expect(formatCompact("en", 4180)).toBe("4,180");
    expect(formatCompact("pt", 42.68)).toBe("42,7");
  });

  it("percentages follow the locale's decimal mark", () => {
    expect(formatPercent("pt", 0.459, 1)).toBe("45,9%");
    expect(formatPercent("en", 0.459, 1)).toBe("45.9%");
    expect(formatPercent("en", 0.89)).toBe("89%");
  });
});

describe("currency", () => {
  it("is always BRL, whichever language the reader is in", () => {
    // This is Brazilian-grid economics shown to an English reader, never a
    // conversion. Only the grouping and the symbol's placement move.
    for (const locale of ["pt", "en"] as const) {
      expect(formatBrl(locale, 26_000)).toContain("R$");
    }
    // `Intl` puts a non-breaking space after the symbol in pt-BR, which is
    // correct typography and invisible in a diff — normalise before comparing.
    const spaces = (value: string) => value.replace(/\u00a0/g, " ");
    expect(spaces(formatBrl("pt", 26_000))).toBe("R$ 26.000");
    expect(spaces(formatBrl("en", 26_000))).toBe("R$26,000");
  });
});

describe("time", () => {
  it("is Brasília's, not the viewer's", () => {
    expect(GRID_TIME_ZONE).toBe("America/Sao_Paulo");
    // 13:35 UTC is 10:35 in Brasília (UTC−3, no DST since 2019). A São Paulo
    // operator and a London analyst must be looking at the same grid hour, so
    // this must hold whatever `TZ` the process happens to be running under.
    for (const locale of ["pt", "en"] as const) {
      expect(formatDateTime(locale, "2026-08-28T13:35:00Z")).toContain("10:35");
    }
  });

  it("only the month name and the part order follow the locale", () => {
    expect(formatDate("pt", "2026-08-29")).toContain("ago");
    expect(formatDate("en", "2026-08-29")).toContain("Aug");
  });

  it("a bare civil date does not slip onto the previous day", () => {
    // A date-only string parses as UTC midnight, which is 21:00 the day before
    // in Brasília. Anchoring at midday is what stops "2026-08-29" rendering
    // as the 28th on the very screens that are about a specific grid day.
    expect(formatDate("en", "2026-08-29")).toContain("29");
    expect(formatDate("pt", "2026-08-29")).toContain("29");
  });

  it("a grid hour is written the same way in both locales", () => {
    expect(formatHour(3)).toBe("03:00");
    expect(formatHour(23)).toBe("23:00");
  });

  it("an unparseable instant is returned rather than rendered as Invalid Date", () => {
    expect(formatDateTime("pt", "not-a-date")).toBe("not-a-date");
  });
});

describe("placeholders", () => {
  it("fill substitutes values and leaves unknown names alone", () => {
    expect(fill("limiar {mw} MW", { mw: "5" })).toBe("limiar 5 MW");
    // A placeholder with no value is a bug in the caller, not a reason to
    // print an empty gap the reader cannot interpret.
    expect(fill("threshold {mw} MW", {})).toBe("threshold {mw} MW");
  });

  it("the same template fills in either locale's word order", () => {
    const en = "{subsystem} {technology}, {date}.";
    const pt = "{technology} em {subsystem}, {date}.";
    const values = { subsystem: "NORDESTE", technology: "eólica", date: "29" };
    expect(fill(en, values)).toBe("NORDESTE eólica, 29.");
    expect(fill(pt, values)).toBe("eólica em NORDESTE, 29.");
  });
});
