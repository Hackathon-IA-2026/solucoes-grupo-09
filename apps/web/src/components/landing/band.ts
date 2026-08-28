/**
 * Band helpers for the landing page.
 *
 * The types and the `Figure` algebra live in `@/lib/domain` — they are the
 * whole web app's vocabulary, not this page's. What stays here is the
 * page-specific *rendering*: an exact, thousands-grouped figure, because the
 * landing page shows a handful of large numbers and has room for the precision
 * that the dense product screens do not.
 */

export {
  type Band,
  band,
  centre,
  type Figure,
  observed,
  spread,
  upper,
} from "@/lib/domain";

import type { Band } from "@/lib/domain";

/**
 * Exact, thousands-grouped: "12,500".
 *
 * Named for its rendering, not its unit: `charts/band-figure.tsx` has a
 * compact formatter for the same quantity, and two functions called
 * `formatMwh` that disagree on the same input is a wrong number waiting to
 * happen.
 */
export function formatMwhExact(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** "2,640–6,320" — an en dash, never a hyphen, and never a minus sign. */
export function formatRange(band_: Band): string {
  return `${formatMwhExact(band_.p10)}–${formatMwhExact(band_.p90)}`;
}

/** Percentage with one decimal, for shares and reductions. */
export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Whole-number percentage, for probabilities. */
export function formatProbability(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Where a band sits on a 0..`max` track, as three 0..1 fractions. Shared by
 * the horizontal rail and the fan chart so a band cannot be positioned two
 * different ways on the same page.
 */
export function railFractions(
  band_: Band,
  max: number,
): { start: number; mid: number; end: number } {
  const safeMax = max > 0 ? max : 1;
  const clamp = (value: number): number => Math.max(0, Math.min(1, value / safeMax));
  return { start: clamp(band_.p10), mid: clamp(band_.p50), end: clamp(band_.p90) };
}
