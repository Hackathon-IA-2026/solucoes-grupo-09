import { describe, expect, it } from "bun:test";
import {
  fill,
  formatBrl,
  formatBrlThousands,
  formatCompact,
  formatDate,
  formatDateShort,
  formatDateTime,
  formatExact,
  formatHour,
  formatNumber,
  formatPercent,
  formatPercentPoints,
  formattersFor,
  withUnit,
} from "../src/i18n/format";
import { LOCALES } from "../src/i18n/locale";

/**
 * The formatters, which every figure on every screen passes through.
 *
 * The module was at 59% of functions. What is worth pinning is not that
 * `Intl` works — it is the handful of decisions layered on top of it, each of
 * which is a rule a reader depends on and an edit could silently reverse:
 *
 *  - Compact notation has **three regimes** with thresholds, and the wrong
 *    branch is a plausible-looking number of the wrong magnitude.
 *  - A bare `YYYY-MM-DD` is anchored at **midday UTC** before being read in
 *    Brasília. Anchor it at midnight and every civil date on the product moves
 *    to the previous day — a defect that renders perfectly.
 *  - Times are Brasília's **whatever clock the reader is on**, because a grid
 *    hour is a Brazilian hour.
 *  - `fill` leaves an unknown placeholder alone rather than printing
 *    `undefined` into a sentence.
 */

describe("compact notation has three regimes, and the thresholds are the rule", () => {
  it("below 100 keeps a decimal, because the difference matters there", () => {
    expect(formatCompact("en", 12.4)).toBe("12.4");
    expect(formatCompact("pt", 12.4)).toBe("12,4");
  });

  it("100 and above rounds to whole units", () => {
    expect(formatCompact("en", 480.6)).toBe("481");
    expect(formatCompact("en", 99.9)).not.toBe("100");
  });

  it("10,000 and above switches to thousands with one decimal", () => {
    expect(formatCompact("en", 12_500)).toBe("12.5k");
    expect(formatCompact("pt", 12_500)).toBe("12,5k");
    // And not one unit below the threshold — an off-by-one here prints "9.99k"
    // where the screen has room for the exact figure.
    expect(formatCompact("en", 9999)).not.toContain("k");
  });

  it("the regimes are symmetric for negative values", () => {
    // `Math.abs` gates every branch; dropping it would put a large negative on
    // the decimal path and print it at the wrong precision.
    expect(formatCompact("en", -12_500)).toContain("k");
    expect(formatCompact("en", -12.4)).toBe("-12.4");
  });

  it("exact is grouped and never abbreviated", () => {
    expect(formatExact("en", 12_500)).toBe("12,500");
    expect(formatExact("pt", 12_500)).toBe("12.500");
    // The reason both renderers exist: one fits a tight row, one is checkable.
    expect(formatExact("en", 12_500)).not.toBe(formatCompact("en", 12_500));
  });
});

describe("a bare civil date is anchored at midday, so it cannot slip a day", () => {
  it("renders the date it was given, not the one before it", () => {
    // Brasília is UTC−3. Anchored at midnight UTC, `2026-09-16` reads as the
    // 15th locally — a defect that renders perfectly and is wrong on every
    // screen at once.
    for (const locale of LOCALES) {
      expect(formatDate(locale, "2026-09-16")).toContain("16");
      expect(formatDate(locale, "2026-09-16")).not.toContain("15");
    }
  });

  it("the first of a month is the hardest case, and survives", () => {
    expect(formatDate("en", "2026-09-01")).toContain("Sep");
    expect(formatDate("en", "2026-09-01")).toContain("1");
    expect(formatDate("en", "2026-01-01")).toContain("2026");
  });

  it("the short form drops the year and keeps the day", () => {
    expect(formatDateShort("en", "2026-09-16")).toContain("16");
    expect(formatDateShort("en", "2026-09-16")).not.toContain("2026");
  });

  it("an unparseable date is returned as it arrived, not as `Invalid Date`", () => {
    expect(formatDate("en", "not-a-date")).toBe("not-a-date");
    expect(formatDateShort("pt", "")).toBe("");
    expect(formatDateTime("en", "nonsense")).toBe("nonsense");
  });
});

describe("times are Brasília's, whatever clock the reader is on", () => {
  it("an instant is rendered in grid time, not in the runtime's zone", () => {
    // 03:00 UTC is midnight in Brasília. If this ever prints 03, the product is
    // reporting the reader's clock as the grid's.
    const rendered = formatDateTime("en", "2026-09-16T03:00:00Z");
    expect(rendered).toContain("00:00");
    expect(rendered).not.toContain("03:00");
  });

  it("is 24-hour, because a grid hour is never am/pm", () => {
    const evening = formatDateTime("en", "2026-09-16T23:00:00Z");
    expect(evening).toContain("20:00");
    expect(evening.toLowerCase()).not.toContain("pm");
  });

  it("the hour label is locale-invariant by design", () => {
    expect(formatHour(3)).toBe("03:00");
    expect(formatHour(23)).toBe("23:00");
    expect(formatHour(0)).toBe("00:00");
  });
});

describe("percentages", () => {
  it("a fraction becomes a percentage in both locales", () => {
    expect(formatPercent("en", 0.42)).toContain("42");
    expect(formatPercent("pt", 0.42)).toContain("42");
  });

  it("percent *points* take a number already in points, not a fraction", () => {
    // The two are one multiplication apart, and confusing them is a figure
    // wrong by a factor of a hundred that still looks like a percentage.
    expect(formatPercentPoints("en", 42)).toContain("42");
    expect(formatPercentPoints("en", 42)).not.toContain("4200");
  });
});

describe("`fill` never prints a hole into a sentence", () => {
  it("substitutes what it was given", () => {
    expect(fill("risk {level} at {when}", { level: "high", when: "03:00" })).toBe(
      "risk high at 03:00",
    );
  });

  it("leaves an unmatched placeholder alone rather than printing `undefined`", () => {
    // A missing key is a copy bug; rendering `undefined` into a sentence turns
    // it into a reader-facing one.
    const out = fill("risk {level} at {when}", { level: "high" });
    expect(out).not.toContain("undefined");
    expect(out).toContain("{when}");
  });

  it("numbers are accepted and stringified", () => {
    expect(fill("{n} MWh", { n: 480 })).toBe("480 MWh");
  });

  it("a template with no placeholders is returned unchanged", () => {
    expect(fill("no holes here", { a: "b" })).toBe("no holes here");
  });
});

describe("the bundled formatters agree with the standalone ones", () => {
  /*
    **Every method, not a sample of three.**

    `formattersFor` is what the product actually calls — `useFormat()` is a
    memoised call to it and adds nothing — so the bound closures are the code
    path every figure on every screen goes through. The standalone functions
    below were all tested and eight of the eleven bindings were not, which
    leaves the one mistake this shape invites completely uncovered: a binding
    that passes the wrong locale, or the wrong argument, on one method. The
    result is a single figure formatted in the other convention, on a screen
    where every other number is right — the hardest kind to notice and the
    easiest to make, because the file is eleven near-identical lines.

    Each row is asserted against its standalone counterpart rather than a
    literal, so this stays a statement about the *binding* and does not become a
    second, drifting copy of what each formatter should produce.
  */
  it("`formattersFor` binds every method to the locale it was given", () => {
    for (const locale of LOCALES) {
      const f = formattersFor(locale);
      expect(f.locale).toBe(locale);
      expect(f.number(1234.5, 1)).toBe(formatNumber(locale, 1234.5, 1));
      expect(f.compact(12_500)).toBe(formatCompact(locale, 12_500));
      expect(f.exact(12_500)).toBe(formatExact(locale, 12_500));
      expect(f.percent(0.425)).toBe(formatPercent(locale, 0.425));
      expect(f.percentPoints(42.5, 1)).toBe(formatPercentPoints(locale, 42.5, 1));
      expect(f.brl(26_400)).toBe(formatBrl(locale, 26_400));
      expect(f.brlThousands(26_400)).toBe(formatBrlThousands(locale, 26_400));
      expect(f.date("2026-09-16")).toBe(formatDate(locale, "2026-09-16"));
      expect(f.dateShort("2026-09-16")).toBe(formatDateShort(locale, "2026-09-16"));
      expect(f.dateTime("2026-09-16T03:00:00Z")).toBe(
        formatDateTime(locale, "2026-09-16T03:00:00Z"),
      );
      expect(f.hour(3)).toBe(formatHour(3));
    }
  });

  it("the optional fraction digits reach the bound call", () => {
    // Non-vacuity for the two methods that take a second argument: a binding
    // that dropped it would still match its counterpart above if that were
    // called with the default too.
    const f = formattersFor("pt");
    expect(f.number(1234.5, 1)).not.toBe(f.number(1234.5));
    expect(f.percentPoints(42.5, 1)).not.toBe(f.percentPoints(42.5));
  });

  it("the two locales disagree, or the comparison above proves nothing", () => {
    // Non-vacuity for the loop: if `formattersFor` ignored its argument, every
    // assertion above would still hold — both sides would be wrong together.
    const [pt, en] = [formattersFor("pt"), formattersFor("en")];
    expect(pt.number(1234.5, 1)).not.toBe(en.number(1234.5, 1));
    expect(pt.date("2026-09-16")).not.toBe(en.date("2026-09-16"));
  });

  it("the bound money and clock carry the invariants, not the reader's locale", () => {
    // The two things that deliberately do not follow the reader, asserted
    // through the binding because that is what a screen holds.
    for (const locale of LOCALES) {
      const f = formattersFor(locale);
      expect(f.brl(1234)).toContain("R$");
      // 03:00 UTC is 00:00 in São Paulo. A formatter that used the runner's
      // timezone would answer something else here.
      expect(f.dateTime("2026-09-16T03:00:00Z")).toContain("00:00");
    }
  });
});

describe("`withUnit` appends verbatim", () => {
  it("keeps one space and does not reformat the number", () => {
    expect(withUnit("1.234,5", "MWh")).toBe("1.234,5 MWh");
  });
});

describe("money is always BRL, whatever the reader's locale", () => {
  it("both locales render the Brazilian currency, not the reader's", () => {
    // "The currency is a property of the Brazilian grid, not of the reader."
    // An `en` reader gets R$, not $ — a locale-driven currency would silently
    // relabel a real number as a different amount of money.
    for (const locale of LOCALES) {
      expect(formatBrl(locale, 1234)).toContain("R$");
      expect(formatBrl(locale, 1234)).not.toMatch(/US\$|€|\bUSD\b/);
    }
  });

  it("only the grouping and the symbol's placement follow the locale", () => {
    const en = formatBrl("en", 1_234_567);
    const pt = formatBrl("pt", 1_234_567);
    // Same amount, different rendering — and the difference is real, or one of
    // the two locales is being formatted as the other.
    expect(en).not.toBe(pt);
    expect(en).toContain("1,234,567");
    expect(pt).toContain("1.234.567");
  });

  it("defaults to whole reais, and takes cents when asked", () => {
    expect(formatBrl("pt", 12.34)).not.toContain(",34");
    expect(formatBrl("pt", 12.34, 2)).toContain(",34");
  });

  it("the thousands headline divides before formatting, not after", () => {
    // `R$ 26k` and not `R$ 26.000k`. Dividing after would multiply the headline
    // by a thousand while still looking like a plausible currency figure.
    expect(formatBrlThousands("pt", 26_000)).toContain("26");
    expect(formatBrlThousands("pt", 26_000)).not.toContain("26.000");
    expect(formatBrlThousands("pt", 26_000).endsWith("k")).toBe(true);
  });
});
