/**
 * The W mark's geometry. **No React, no react-native — deliberately.**
 *
 * This is the only copy of the logo. `components/brand.tsx` draws it and
 * `apps/web/scripts/generate-assets.ts` renders every favicon, PWA, app and OG
 * asset from it, so the component and the generated PNGs cannot drift apart.
 * The mark it replaced was a stroked "Z" that lived twice — once as a path in a
 * component, once as a checked-in master PNG — which is the arrangement that
 * lets two logos exist at once.
 *
 * It is a separate module from the component, and that is the load-bearing part
 * rather than tidiness: the asset generator is a plain script, and importing the
 * component's module would pull `react-native` into it, which does not parse
 * outside the Metro bundler. A geometry module with no framework import is what
 * lets one definition serve both.
 *
 * Geometry, so a future edit knows what is structural:
 *
 * - Both strokes share one direction vector, `(28, 66)`. The detached stroke is
 *   the W's first arm and is parallel to the second by construction, not by eye.
 * - The notch apex `(60.2, 60.2)` is *solved*, not placed: it is where the
 *   second arm's right edge meets the arrowhead's left edge. Move either edge
 *   and the apex must be recomputed or the notch stops being a clean wedge.
 * - The bottom vertex `(56, 88)` is shared by the second arm and the arrowhead,
 *   which is what makes the lower half read as one pointed form.
 *
 * Fills, not strokes: the shape has no constant width, and a stroked path could
 * not express the arrowhead widening toward the top.
 */

/** The two closed paths, on a 100×100 canvas. */
export const WATTSTEER_MARK_PATHS = [
  // The detached first arm.
  "M4 22 L20 22 L31.8 49.7 L15.8 49.7 Z",
  // The second arm, the notch, and the arrowhead — one closed path.
  "M28 22 L44 22 L60.2 60.2 L66 22 L96 22 L56 88 Z",
] as const;

/** The mark's bounding box inside that canvas. */
export const WATTSTEER_MARK_BOX = { x: 4, y: 22, width: 92, height: 66 } as const;

/**
 * Fit the mark into a square of `size`, occupying `inset` of its width.
 *
 * The mark is wider than it is tall, so width is what binds and the result is
 * centred on the other axis. Returned as an SVG transform string, which is the
 * one form both renderers accept.
 */
export function wattSteerMarkTransform(size: number, inset = 0.62): string {
  const scale = (size * inset) / WATTSTEER_MARK_BOX.width;
  const x = (size - WATTSTEER_MARK_BOX.width * scale) / 2 - WATTSTEER_MARK_BOX.x * scale;
  const y = (size - WATTSTEER_MARK_BOX.height * scale) / 2 - WATTSTEER_MARK_BOX.y * scale;
  return `translate(${x}, ${y}) scale(${scale})`;
}
