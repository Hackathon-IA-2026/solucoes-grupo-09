/**
 * The hero stage's measured geometry, in one place.
 *
 * These four numbers are a single system: the stage is one viewport tall
 * less what sits above it, and the cards render only when the column
 * leaves a gutter wide enough to hold one. Both relationships are arithmetic
 * between constants that otherwise live in two `.tsx` files, so they are here
 * instead — a plain module the guard in `test/hero-stage.test.ts` can import
 * without pulling React Native into the test runner.
 *
 * Every value is measured rather than chosen. Where a number came off the
 * template it says so; where it came off our own static export, it says which
 * viewport it was read at.
 */

/**
 * The height of everything the landing page draws above the hero stage,
 * measured on the static export: `landing-nav` renders 65px tall (identical
 * at 400 and 1280 — it does not reflow), and the hero `Section` adds
 * `space.xxl` = 32px of top padding.
 *
 * The template's hero is the first child of its scroll view with nothing
 * above it, so `max(windowHeight, 620)` puts its whole stage inside one
 * viewport. Ours has this much chrome above it, so the same rule subtracts it
 * — otherwise the stage ends a nav's height below the fold.
 */
export const HERO_CHROME = 65 + 32;

/**
 * The template floors its hero at 620px, so a short window gets a composed
 * stage rather than a squeezed one. Held here as the floor on the *first
 * screenful*, which is the quantity the two apps have in common.
 */
export const MIN_FIRST_SCREEN = 620;

/** The stage's own floor, which is the above less the chrome above it. */
export const MIN_STAGE = MIN_FIRST_SCREEN - HERO_CHROME;

/** The hero column's maximum width — the text measure the stage centres. */
export const HERO_COLUMN_MAX = 760;

/** A floating card's width. */
export const CARD_WIDTH = 200;

/** A card's inset from the stage edge, as a percentage of the stage width. */
export const CARD_INSET_PERCENT = 1.5;

/**
 * Minimum hero width before any card renders.
 *
 * The template gates at 1240 against a 672px column. Ours is a 760px column,
 * so the arithmetic is redone rather than the constant copied — and it still
 * lands on 1240, because the gutter at that width, (1240 − 760) / 2 = 240px,
 * holds a 200px card inset 1.5% (18.6px) with 21px of air left before the
 * column's edge. `test/hero-stage.test.ts` recomputes exactly that, so moving
 * the column or widening a card fails rather than quietly overlapping.
 *
 * Below the gate the cards do not shrink or stack. They are decoration over a
 * fixture the readout already renders in full, and a card pushed into the
 * column would be a second, smaller copy of it.
 */
export const GUTTER_GATE = 1240;

/** Clearance the guard requires between a card's outer edge and the column. */
export const MIN_CARD_CLEARANCE = 16;
