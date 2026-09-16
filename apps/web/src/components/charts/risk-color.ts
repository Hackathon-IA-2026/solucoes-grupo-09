/**
 * The three-step risk palette — one colour language for the chip and the map.
 *
 * Split out of `risk-class.tsx` so that file exports only components. The
 * reasoning for *why* risk is three bins and not a gradient lives in that
 * file's header and belongs there, beside the chip a reader is looking at; what
 * is here is the mapping those arguments produce.
 *
 * Exported rather than re-derived in the map: a map that picked its own red
 * would be a second colour language for the same three bins, and the argument
 * against a ramp would then hold for the chip and not for the regions.
 * `fg` is the readable-on-dark hue; `bg` is the same hue at 15 %.
 *
 * A plain function of the palette rather than a hook, because the map resolves
 * four of these inside one render pass and a hook cannot be called in a loop.
 */

import type { Palette } from "@wattsteer/ui";
import type { RiskClass } from "@/lib/fixtures";

/**
 * The three-step risk palette, exported because the subsystem map colours its
 * four regions with it.
 *
 * Exported rather than re-derived there: a map that picked its own red would
 * be a second colour language for the same three bins, and the argument in
 * this file's header — no ramp, no traffic light, lime reserved for the
 * product's positive accent — would hold for the chip and not for the map.
 * `fg` is the readable-on-dark hue; `bg` is the same hue at 15 %.
 *
 * (That header is now `risk-class.tsx`'s, one file over: the argument belongs
 * beside the chip a reader is looking at, and this is the mapping it produces.)
 */
export function riskColor(colors: Palette, klass: RiskClass): { fg: string; bg: string } {
  if (klass === "high") {
    return { fg: colors.onDangerSoft, bg: colors.dangerSoft };
  }
  if (klass === "elevated") {
    return { fg: colors.onWarningSoft, bg: colors.warningSoft };
  }
  return { fg: colors.inkMuted, bg: colors.surfaceSunken };
}
