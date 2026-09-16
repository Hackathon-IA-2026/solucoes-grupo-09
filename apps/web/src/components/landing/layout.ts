/**
 * The landing page's two shared layout numbers.
 *
 * Split out of `section.tsx` so that file exports only components. Both were
 * already shared across files — `landing-nav.tsx` and `site-footer.tsx` import
 * `PAGE_MAX`, and the whole reason it exists is that three files writing the
 * same width by hand is three chances to stop lining up — so a module of their
 * own is where they were heading anyway.
 */

import { layout, space } from "@wattsteer/ui";

/**
 * The page gutter, shared by the nav, every section and the footer.
 *
 * It used to be written out as `layout.page + 128` in three files, which is
 * three chances for the header, the sections and the footer to stop lining up
 * with each other — and nothing would have failed. One constant, imported by
 * all three, means the left edge of the wordmark and the left edge of the
 * footer's links are the same number by construction.
 *
 * The `+ 128` is gone: `layout.page` *is* 1280 now. The landing page and the
 * app screens had been built against two different widths, so the site
 * narrowed by 128 px the moment a reader left the marketing page. This alias
 * stays because the landing imports it in three places and the name says what
 * it is for, but it no longer holds a number of its own.
 */
export const PAGE_MAX = layout.page;

/**
 * Vertical air above and below a section.
 *
 * `space.huge` top and bottom puts 144 px between two adjacent sections, which
 * is right on a desktop page 5,264 px tall and wrong on a phone page 8,493 px
 * tall (both measured on the exported build). Narrow drops to `space.xxxl`, so
 * the between-sections gap is 96 px there — still the largest gap on the page
 * by a factor of four, which is what the rhythm needs it to be.
 */
export function sectionPad(wide: boolean): number {
  return wide ? space.huge : space.xxxl;
}
