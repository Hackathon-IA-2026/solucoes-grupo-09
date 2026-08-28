/**
 * The uncertainty band, as a type.
 *
 * WattSteer's headline numbers are quantiles, not point estimates: the
 * forecaster emits P10/P50/P90 (IDEA.md §14, and the whole reason the
 * weather lead-time research cared about dispersion). Every stat card and
 * gauge in `reference/` is built for one figure and has nowhere to put a
 * band, which is exactly how a band gets quietly dropped — someone reaches
 * for the card that exists, passes `p50`, and the range is gone with no
 * diff to notice.
 *
 * So the landing page does not render numbers. It renders `Figure`s, and a
 * `Figure` is a sum type:
 *
 *   - `band`     — a forecast. Carries all three quantiles, and the
 *                  components that draw it always draw the width.
 *   - `observed` — a measured actual. Has no band *because there is nothing
 *                  to be uncertain about*, and says so on screen.
 *
 * There is no third variant, so there is no way to render a forecast as a
 * lone number: the type system, not discipline, is what keeps the band on
 * the page. This mirrors the domain model's own approach — illegal states
 * unrepresentable rather than merely discouraged.
 */

export interface Band {
  /** 10th percentile — the low end of the forecast interval. */
  p10: number;
  /** Median. The figure a single-number UI would have shown alone. */
  p50: number;
  /** 90th percentile. */
  p90: number;
}

export type Figure =
  | { readonly kind: "band"; readonly band: Band }
  | { readonly kind: "observed"; readonly value: number };

/** A forecast figure. Ordering is asserted, not assumed. */
export function band(p10: number, p50: number, p90: number): Figure {
  if (!(p10 <= p50 && p50 <= p90)) {
    throw new RangeError(`Band quantiles out of order: ${p10}, ${p50}, ${p90}`);
  }
  return { kind: "band", band: { p10, p50, p90 } };
}

/** A measured actual — no band, and the UI says why. */
export function observed(value: number): Figure {
  return { kind: "observed", value };
}

/** The figure a chart axis or a bar length should be scaled by. */
export function centre(figure: Figure): number {
  return figure.kind === "band" ? figure.band.p50 : figure.value;
}

/** The widest value a figure reaches — what an axis has to make room for. */
export function upper(figure: Figure): number {
  return figure.kind === "band" ? figure.band.p90 : figure.value;
}

/**
 * Interval width relative to the median: `(p90 − p10) / p50`. A plain-language
 * handle on how much the forecast actually knows, and the thing a reader
 * loses entirely when only the median is shown.
 */
export function spread(band_: Band): number {
  return band_.p50 === 0 ? 0 : (band_.p90 - band_.p10) / band_.p50;
}

/** Integer MWh with thousands separators. `Intl` takes this over per locale. */
export function formatMwh(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** "2,640–6,320" — an en dash, never a hyphen, and never a minus sign. */
export function formatRange(band_: Band): string {
  return `${formatMwh(band_.p10)}–${formatMwh(band_.p90)}`;
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
