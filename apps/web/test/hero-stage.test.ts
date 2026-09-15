import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CARD_INSET_PERCENT,
  CARD_WIDTH,
  GUTTER_GATE,
  HERO_CHROME,
  HERO_COLUMN_MAX,
  MIN_CARD_CLEARANCE,
  MIN_FIRST_SCREEN,
  MIN_STAGE,
} from "../src/components/landing/hero-metrics";

/**
 * The hero stage and its floating cards.
 *
 * Three things here are easy to break silently and expensive to notice:
 *
 *  1. The stage's height is an arithmetic relationship between the chrome
 *     above it and the first screenful it is supposed to fill. Change either
 *     end and the fold lands somewhere arbitrary.
 *  2. The cards live in the gutter beside a fixed-width column. Widen a card
 *     or the column and they overlap the headline — at one width only, which
 *     is exactly the width nobody screenshots.
 *  3. They render fixture figures at 30px in the first thing a visitor sees.
 *     An unlabelled one is the specific claim this product must not make, and
 *     it is a claim that would be made by *deleting* a line, not adding one.
 *
 * The geometry is checked against the constants; the rest is checked against
 * the source text, which is how `test/i18n.test.ts` already checks that a
 * dictionary key reaches a screen. A regex cannot render a component — but it
 * can prove the marker, the gate and the reduced-motion branch are still
 * written down, which is the failure mode each of these had.
 */

const SRC = (name: string): string =>
  readFileSync(join(import.meta.dir, "..", "src", "components", "landing", name), "utf8");

const HERO = SRC("hero.tsx");
const CARDS = SRC("hero-cards.tsx");
const CTA = SRC("cta-link.tsx");

describe("the hero stage is one screenful", () => {
  it("adds back to the template's 620px floor", () => {
    // The template floors its hero — which has nothing above it — at 620.
    // Ours carries `HERO_CHROME` of nav and section padding above the stage,
    // so the stage's own floor has to be the difference or the first screen
    // is 620 plus a nav, which is not the same layout.
    expect(MIN_STAGE + HERO_CHROME).toBe(MIN_FIRST_SCREEN);
    expect(MIN_STAGE).toBeGreaterThan(0);
  });

  it("sizes itself in viewport units on web rather than at hydration", () => {
    // A JS-measured height renders 523px into the static export and then
    // grows at hydration, shoving the readout down the page: layout shift on
    // the largest element above the fold. `dvh` resolves at first paint.
    expect(HERO).toContain("100dvh");
    expect(HERO).toMatch(
      /max\(\$\{MIN_STAGE\}px, calc\(100dvh - \$\{HERO_CHROME\}px\)\)/,
    );
  });

  it("clips the stage, so a rotated card cannot widen the page", () => {
    // The cards are rotated up to 5°, absolutely positioned, and inset from
    // the stage edge by a percentage. Without `overflow: hidden` a corner
    // pushes the document's scroll width past the viewport at the widths just
    // above the gate — horizontal scroll on a landing page, from decoration.
    expect(HERO).toMatch(/stage: \{[\s\S]*?overflow: "hidden"/);
  });
});

describe("the eyebrow pill is a pill, not a status light", () => {
  it("carries the mark rather than a filled dot", () => {
    // The 6px accent-filled circle that used to sit here is the shape a live
    // indicator uses, at the top of a page whose readout is a fixture and
    // says so two panels below — the one element in the hero a visitor could
    // read as a connection state. It is replaced by the mark the template
    // puts on its own kicker pill, at the same 14px in the same accent role.
    expect(HERO).toContain("<SparklesIcon size={14} color={colors.accent} />");
    expect(HERO).not.toMatch(/dot: \{/);
    expect(HERO).not.toContain("styles.dot");
  });

  it("keeps the label on one line", () => {
    // 314px of room at 400px (400 less 20px gutters either side, less 24px of
    // pill padding, less the 14px mark and its 8px gap). A wrapped eyebrow is
    // a rounded paragraph, and it pushes the headline down the fold. The
    // dictionary budget in `test/i18n.test.ts` keeps the copy clear of this;
    // this is the floor under a future string that is not.
    const pill = /styles\.eyebrow,[\s\S]*?<\/View>/.exec(HERO)?.[0] ?? "";
    expect(pill).toMatch(/numberOfLines=\{1\}/);
  });
});

describe("the floating cards stay out of the hero column", () => {
  it("only renders where the gutter can hold a card", () => {
    // Redone rather than copied from the template, whose column is narrower.
    const gutter = (GUTTER_GATE - HERO_COLUMN_MAX) / 2;
    const inset = (GUTTER_GATE * CARD_INSET_PERCENT) / 100;
    expect(gutter - inset - CARD_WIDTH).toBeGreaterThanOrEqual(MIN_CARD_CLEARANCE);
  });

  it("is gated in the hero rather than hiding itself", () => {
    // The gate has to be the parent's, because the cards are absolutely
    // positioned inside the stage: a card that rendered and then hid itself
    // would still have been laid out in a gutter that does not exist.
    expect(HERO).toContain("width >= GUTTER_GATE ? <HeroCards /> : null");
  });

  it("is decoration: untouchable and out of the accessibility tree", () => {
    // Every figure on these cards is also in the readout below, where the
    // sample badge and the footnote are adjacent to it in the reading order.
    // Announcing them twice would read the fixture out without its caveat.
    expect(CARDS).toContain("aria-hidden={true}");
    expect(CARDS).toMatch(/pointerEvents: "none"/);
  });
});

describe("nothing floating in the hero is presented as live", () => {
  it("every card carries the readout's own sample badge", () => {
    // One `SampleMark`, rendered by every card, from the same dictionary key
    // the readout's badge uses — so a rename cannot leave the cards saying
    // something softer than the panel beneath them.
    expect(CARDS).toContain("copy.readout.sampleBadge");
    const cards = [...CARDS.matchAll(/<Panel style=\{styles\.card\}>/g)].length;
    const marks = [...CARDS.matchAll(/<SampleMark \/>/g)].length;
    expect(cards).toBeGreaterThan(0);
    expect(marks).toBe(cards);
  });

  it("takes every figure from the landing fixture, not from a literal", () => {
    // A second source of numbers on this page is how the two would drift into
    // disagreeing about the same forecast. The cards read `./fixtures`, the
    // same module the readout renders.
    expect(CARDS).toMatch(
      /import \{ HOURLY_PROFILE, NATIONAL, SUBSYSTEMS \} from "\.\/fixtures"/,
    );
    // And every large figure a card prints is a locale-formatted read off one
    // of those constants, never a number typed into the JSX. A hardcoded
    // "2,780" would render correctly in English and be an order of magnitude
    // out in Portuguese, on a page served from `/pt/` as its own file.
    // Checked per figure, not in aggregate: a count of formatter calls across
    // the whole file stays satisfied when one card's big number is replaced
    // by a literal and another card happens to format two.
    const figures = [
      ...CARDS.matchAll(/<Text style=\{\[styles\.figure[\s\S]*?<\/Text>/g),
    ].map((match) => match[0]);
    expect(figures.length).toBeGreaterThan(0);
    expect(
      figures.filter(
        (block) => !/format\w+\(locale, (?:NATIONAL|figure|outlook)\./.test(block),
      ),
    ).toEqual([]);
  });
});

describe("motion in the hero is optional", () => {
  it("stops the float loop under prefers-reduced-motion", () => {
    expect(CARDS).toContain("useReducedMotion");
    expect(CARDS).toMatch(/if \(reducedMotion\) \{\s*progress\.setValue\(0\);\s*return;/);
  });

  it("drops the CTA's press scale under prefers-reduced-motion", () => {
    // The scale is decoration: the focus ring and the pointer cursor carry
    // the affordance without it, so it comes off rather than being animated
    // faster.
    expect(CTA).toContain("useReducedMotion");
    expect(CTA).toContain("scale: pressed && !reducedMotion ? 0.95 : 1");
  });
});

describe("the primary CTA keeps the pill geometry it shares with PillButton", () => {
  const PILL = readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "packages",
      "ui",
      "src",
      "components",
      "pill.tsx",
    ),
    "utf8",
  );

  it("matches the pill it sits beside, number for number", () => {
    // `CtaLink` is a `PillButton` that is an anchor. The two render on one
    // line in the hero, so a 1px difference in either padding shows as a step
    // in the row — and the pair was drifting already (the CTA had no
    // `flexShrink`, so at 400px it collapsed and broke its label in half
    // inside the rounded shape).
    // Matched as a whole style line, not as a substring: every one of these
    // property names is also discussed in `cta-link.tsx`'s own header, and a
    // bare `includes` would go on passing off the prose after the style that
    // mentions it had been deleted.
    for (const property of [
      "borderRadius: radius.pill,",
      "borderWidth: 1,",
      "paddingHorizontal: 16,",
      "paddingVertical: 10,",
      "gap: 6,",
      "flexShrink: 0,",
      'justifyContent: "center",',
    ]) {
      const line = new RegExp(
        `^\\s+${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m",
      );
      expect([property, line.test(CTA)]).toEqual([property, true]);
      expect([property, line.test(PILL)]).toEqual([property, true]);
    }
    // The press scale, which is the pill's only motion.
    expect(CTA).toMatch(/transform: \[\{ scale: pressed[^\]]*0\.95/);
    expect(PILL).toMatch(/transform: \[\{ scale: pressed[^\]]*0\.95/);
  });

  it("keeps the label on one line", () => {
    expect(CTA).toMatch(/^\s+numberOfLines=\{1\}$/m);
  });

  it("never hands a style function to the element `Link asChild` clones", () => {
    // The defect this whole file was opened on. `Link asChild` renders Radix's
    // `Slot`, which merges `style` by spreading — `{ ...slotStyle, ...childStyle }`
    // — and spreading a function yields `{}`. A `style={(state) => …}` on the
    // `Pressable` is therefore dropped in full, with no warning and no type
    // error, and the anchor ships with no padding, border, radius or fill: the
    // page's primary call to action rendered as bare lime text and an arrow.
    //
    // So the `Pressable` takes a plain object, and every state-dependent style
    // lives on the inner `View` fed by children-as-function.
    const pressable = /<Pressable[\s\S]*?>/.exec(CTA)?.[0] ?? "";
    expect(pressable).not.toMatch(/style=\{\(/);
    expect(pressable).toMatch(/style=\{\{ flexShrink: 0 \}\}/);
    // And the pill really is driven by interaction state, not frozen flat.
    expect(CTA).toMatch(/\{\(state\) => \{/);
    expect(CTA).toContain("hovered");
    expect(CTA).toContain("focused");
  });
});
