/**
 * The colour language for **settled** figures, and the argument for why it is
 * not the risk language.
 *
 * `risk-class.tsx` refuses a continuous ramp, for a reason written out at
 * length there: a marker sliding smoothly along a gradient claims the model can
 * tell 31 % from 33 %, and it cannot. So forecast risk is three named, wide,
 * ordered bins in three hues — muted, amber, red — and never a ramp.
 *
 * **That argument inverts exactly here, and the inversion is the design.**
 * These are megawatt-hours the ONS has already settled. They are not a model's
 * opinion about a day that has not happened; they are a measurement, exact to
 * the decimal the publisher printed, and there is no resolution to over-claim.
 * A continuous ramp is the honest encoding of a measured quantity for the same
 * reason it is a dishonest encoding of a binned probability. So:
 *
 *  - **Forecast** → three discrete hues, no ramp, a three-step glyph, a class
 *    in words. Colour says *which bin*.
 *  - **Observed** → one hue, continuously ramped by share of the largest
 *    settled figure on the map, with the figure itself printed on the region.
 *    Colour says *how much*, and the number says exactly how much.
 *
 * Two maps drawn in these two languages cannot be mistaken for each other: they
 * differ in hue family, in whether the scale is stepped or smooth, and in what
 * is printed inside each region. `test/observed-overview.test.ts` holds the
 * first of those as a standing assertion — **no fill this module can produce is
 * a colour `riskColor` can produce, at any share** — so the two palettes cannot
 * drift into each other by somebody editing a token.
 *
 * **Why `info` and not the accent.** Lime is the product's positive accent and
 * marks *the selected thing* on this screen, in all three places a selection is
 * visible; painting the whole map in it would put the selection mark and the
 * magnitude scale in one hue. Cyan is used nowhere else on the Overview, which
 * is what makes "the map has gone cyan" a legible statement in itself.
 */

import type { Palette } from "@wattsteer/ui";

/** `#RRGGBB` → three channels. The palette's solid tokens are all hex. */
function channels(colour: string): [number, number, number] {
  const value = Number.parseInt(colour.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(channel: number): string {
  return Math.round(Math.max(0, Math.min(255, channel)))
    .toString(16)
    .padStart(2, "0");
}

/** `from` at `1 - t`, `to` at `t`, per channel. Both must be `#RRGGBB`. */
export function mix(from: string, to: string, t: number): string {
  const a = channels(from);
  const b = channels(to);
  const at = Math.max(0, Math.min(1, t));
  return `#${a.map((channel, i) => toHex(channel + (b[i] - channel) * at)).join("")}`;
}

/**
 * The floor of the ramp.
 *
 * A region that settled at zero still has to look **painted**, or it is
 * indistinguishable from a region the response did not carry — which is the
 * zero-for-absence confusion this product refuses everywhere else. So the ramp
 * runs from a visible tint rather than from the land colour itself.
 */
const FLOOR = 0.18;

/**
 * The fill for a region holding `share` of the largest settled figure on the
 * map. Linear in the share, deliberately: a gamma would make small figures
 * easier to see and would also mean equal colour steps were not equal
 * megawatt-hours, and the whole claim of this scale is that it is measuring.
 */
export function observedFill(share: number, colors: Palette): string {
  return mix(colors.surfaceSunken, colors.info, FLOOR + (1 - FLOOR) * clamp01(share));
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** The swatches of the legend, low to high. Five reads as a scale; three does not. */
export const LEGEND_STOPS = [0, 0.25, 0.5, 0.75, 1] as const;
