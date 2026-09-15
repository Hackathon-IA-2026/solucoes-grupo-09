/**
 * Locale-aware value formatting — the half of i18n that is not copy.
 *
 * The landing page could get away without this: it renders prose. The `/app`
 * screens cannot, because they render *values*, and a value carries two
 * separate locale decisions that must not be conflated:
 *
 * 1. **How a number is written** follows the reader. `pt-BR` groups with a
 *    period and separates decimals with a comma; `en-US` does the opposite.
 *    This is the reader's convention and it switches with the UI locale.
 * 2. **What the number means** does not follow the reader. Currency is always
 *    **BRL** — this is Brazilian-grid economics shown to an English reader,
 *    never a conversion — and every timestamp is always **`America/Sao_Paulo`**,
 *    because a grid hour is a Brazilian hour. A São Paulo operator and a
 *    London analyst looking at the same screen must be looking at the same
 *    hour, so the viewer's own timezone is never consulted.
 *
 * Deliberately free of React and of react-native, like `locale.ts`, so the
 * rules can be unit-tested without the RN runtime. `useFormat()` in
 * `./index.tsx` binds these to the active locale for components.
 *
 * Units (`MW`, `MWh`, `GW`) are appended as literal suffixes rather than
 * through `Intl.NumberFormat`'s `style: "unit"`: ECMA-402's sanctioned unit
 * list is a fixed CLDR set that does not carry megawatt-hours, and these
 * symbols are untranslated in both locales anyway.
 */

import type { Locale } from "./locale";

export type { Locale } from "./locale";

/**
 * The BCP-47 tag `Intl` is keyed off.
 *
 * Not `languageTag()`: that one answers "what goes in `<html lang>`", where
 * bare `en` is right. Formatting needs a *region*, because decimal-comma and
 * `R$` placement are pt-BR conventions rather than shared Portuguese ones, and
 * bare `en` leaves the grouping convention to the runtime's default locale.
 */
export function formatTag(locale: Locale): string {
  return locale === "pt" ? "pt-BR" : "en-US";
}

/** The grid's timezone. Fixed, never the viewer's. */
export const GRID_TIME_ZONE = "America/Sao_Paulo";

/** The abbreviation stamped next to a wall-clock time, untranslated. */
export const GRID_TIME_ZONE_LABEL = "BRT";

/** A plain number: `1.234,5` in Portuguese, `1,234.5` in English. */
export function formatNumber(locale: Locale, value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat(formatTag(locale), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * Compact, for the dense product screens: `12,5k` / `12.5k`, `4180`, `42,7`.
 *
 * The product screens pack many figures into tight rows, where an exact
 * grouped number costs the width the band strip needs. `landing/band.ts` has
 * the exact renderer for the same quantity and says why they differ.
 */
export function formatCompact(locale: Locale, value: number): string {
  if (Math.abs(value) >= 10_000) {
    return `${formatNumber(locale, value / 1000, 1)}k`;
  }
  return Math.abs(value) >= 100
    ? formatNumber(locale, Math.round(value), 0)
    : formatNumber(locale, value, 1);
}

/** Exact and thousands-grouped: `12.500` / `12,500`. */
export function formatExact(locale: Locale, value: number): string {
  return formatNumber(locale, Math.round(value), 0);
}

/** A share written as a percentage. `fraction` is 0..1. */
export function formatPercent(
  locale: Locale,
  fraction: number,
  fractionDigits = 0,
): string {
  return `${formatNumber(locale, fraction * 100, fractionDigits)}%`;
}

/** A value already expressed in percentage points. */
export function formatPercentPoints(
  locale: Locale,
  points: number,
  fractionDigits = 0,
): string {
  return `${formatNumber(locale, points, fractionDigits)}%`;
}

/**
 * Money. **Always BRL**, whatever the reader's locale — the currency is a
 * property of the Brazilian grid, not of the reader. Only the grouping and the
 * symbol's placement follow the locale.
 */
export function formatBrl(locale: Locale, value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat(formatTag(locale), {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/** Money in thousands, for a headline figure: `R$ 26 mil` reads as `R$ 26k`. */
export function formatBrlThousands(locale: Locale, value: number): string {
  return `${formatBrl(locale, value / 1000)}k`;
}

function parts(
  locale: Locale,
  iso: string,
  options: Intl.DateTimeFormatOptions,
): string | null {
  const date = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(formatTag(locale), {
    timeZone: GRID_TIME_ZONE,
    ...options,
  }).format(date);
}

/**
 * A civil date: `29 de ago. de 2026` / `Aug 29, 2026`.
 *
 * Accepts either an ISO instant or a bare `YYYY-MM-DD` civil date. A bare date
 * is anchored at midday UTC before being read in Brasília time, so the
 * timezone shift can never move it onto the previous day.
 */
export function formatDate(locale: Locale, iso: string): string {
  return parts(locale, iso, { day: "numeric", month: "short", year: "numeric" }) ?? iso;
}

/** A date without its year, for a run of days inside one. */
export function formatDateShort(locale: Locale, iso: string): string {
  return parts(locale, iso, { day: "numeric", month: "short" }) ?? iso;
}

/**
 * A timestamp in Brasília time, 24-hour, whatever the reader's own clock says.
 * The `BRT` suffix is the caller's to add — see `GRID_TIME_ZONE_LABEL`.
 */
export function formatDateTime(locale: Locale, iso: string): string {
  return (
    parts(locale, iso, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) ?? iso
  );
}

/** A wall-clock hour on the grid's day: `03:00`. Locale-invariant by design. */
export function formatHour(hourLocal: number): string {
  return `${String(hourLocal).padStart(2, "0")}:00`;
}

/** `1.234,5 MWh` — the number formatted, the unit appended verbatim. */
export function withUnit(value: string, unit: string): string {
  return `${value} ${unit}`;
}

/**
 * Every formatter above, bound to one locale.
 *
 * The interface and the factory live here rather than beside `useFormat()`
 * because two callers now need them and only one of them is a component: the
 * deterministic narration in `./narration.ts` formats a paragraph's worth of
 * values and must be testable without mounting a provider. `useFormat()` is a
 * memoised call to this and adds nothing else, so there is one binding of a
 * locale to a formatter rather than two that agree today.
 *
 * The two things that do **not** vary are baked into the functions above:
 * currency is always BRL and every timestamp is `America/Sao_Paulo`.
 */
export interface Formatters {
  locale: Locale;
  number: (value: number, fractionDigits?: number) => string;
  compact: (value: number) => string;
  exact: (value: number) => string;
  percent: (fraction: number, fractionDigits?: number) => string;
  percentPoints: (points: number, fractionDigits?: number) => string;
  brl: (value: number, fractionDigits?: number) => string;
  brlThousands: (value: number) => string;
  date: (iso: string) => string;
  dateShort: (iso: string) => string;
  dateTime: (iso: string) => string;
  hour: (hourLocal: number) => string;
}

export function formattersFor(locale: Locale): Formatters {
  return {
    locale,
    number: (value, fractionDigits) => formatNumber(locale, value, fractionDigits),
    compact: (value) => formatCompact(locale, value),
    exact: (value) => formatExact(locale, value),
    percent: (fraction, fractionDigits) =>
      formatPercent(locale, fraction, fractionDigits),
    percentPoints: (points, fractionDigits) =>
      formatPercentPoints(locale, points, fractionDigits),
    brl: (value, fractionDigits) => formatBrl(locale, value, fractionDigits),
    brlThousands: (value) => formatBrlThousands(locale, value),
    date: (iso) => formatDate(locale, iso),
    dateShort: (iso) => formatDateShort(locale, iso),
    dateTime: (iso) => formatDateTime(locale, iso),
    hour: formatHour,
  };
}

/**
 * Fill `{name}` placeholders in a dictionary string.
 *
 * The dictionary's standing rule is that no prose is interpolated inside JSX,
 * so a translator always gets whole clauses. The `/app` screens need one
 * concession to that: a sentence like "risk for {date}, by subsystem" has a
 * value in the middle of it, and that value is not copy — it is a number or a
 * date formatted by the functions above. Splitting the sentence in two would
 * hand a translator two fragments and, worse, would pin the value's position
 * to English word order, which Portuguese does not share.
 *
 * So values are interpolated and prose never is: every placeholder here is
 * filled with something that came out of a formatter or out of the domain
 * (a subsystem's ONS name, a reason code), never with another sentence.
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
