import { describe, expect, it } from "bun:test";
import { dark } from "../../../packages/ui/src/tokens";
import { riskColor } from "../src/components/charts/risk-color";

/**
 * **Every text colour this product paints, against every surface it paints it
 * on, measured against WCAG AA.**
 *
 * This exists because the automated route could not do it. `e2e/accessibility.
 * spec.ts` runs `axe-core` over the rendered screens and catches the structural
 * ARIA rules exactly; its `color-contrast` rule is switched off there, and the
 * reason is written in that file — axe resolves a foreground by walking
 * ancestors for a non-transparent background, and a react-native-web tree is
 * transparent nearly all the way up. It reported the Overview's national panel
 * at **1.01:1**, near-black on near-black. Screenshotting that exact element and
 * reading its pixels put the text at luminance **247 on a background of 27** —
 * about 15:1, and plainly legible. Two false positives on one screen is enough
 * to make a gate untrustworthy.
 *
 * Measuring the tokens instead is not a consolation prize; it is strictly more
 * than axe could see:
 *
 *  - It covers **every state**, not the one that happened to render. The defect
 *    this file was written after was the `low` risk chip's probability at
 *    `opacity: 0.8` — **4.35:1**, under the 4.5 floor — while `elevated` (5.95)
 *    and `high` (4.94) passed. A screen showing one chip at a time exposes one
 *    third of that rule to any renderer-based check.
 *  - It covers pairs no fixture produces.
 *  - It fails at the moment a token moves, in a unit run, rather than after a
 *    build and a browser.
 *
 * **What it cannot see**, stated so nobody reads more into a green run than is
 * there: it checks the pairs named below. A component that invents a colour
 * outside the palette, or composites two tokens in a way this table does not
 * name, is invisible here. The palette is small and the list is exhaustive over
 * it today; a new token is a new row, and nothing enforces that but review.
 */

type Rgb = readonly [number, number, number];

/** `#rrggbb` or `rgba(r, g, b, a)` — the two notations the palette uses. */
function parse(colour: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (hex !== null) {
    const value = hex[1] as string;
    return {
      rgb: [
        Number.parseInt(value.slice(0, 2), 16),
        Number.parseInt(value.slice(2, 4), 16),
        Number.parseInt(value.slice(4, 6), 16),
      ],
      alpha: 1,
    };
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(colour.trim());
  if (rgba === null) {
    throw new Error(`unparseable colour: ${colour}`);
  }
  const parts = (rgba[1] as string).split(",").map((each) => Number.parseFloat(each));
  const [r = 0, g = 0, b = 0, a = 1] = parts;
  return { rgb: [r, g, b], alpha: a };
}

/** `colour` composited over `under`. A tint is only a colour once it lands. */
function over(colour: string, under: Rgb): Rgb {
  const { rgb, alpha } = parse(colour);
  return [
    rgb[0] * alpha + under[0] * (1 - alpha),
    rgb[1] * alpha + under[1] * (1 - alpha),
    rgb[2] * alpha + under[2] * (1 - alpha),
  ];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.039_28 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 §1.4.3's ratio, to two decimals so a failure prints a number. */
function ratio(foreground: Rgb, background: Rgb): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Everything is painted over the page's own ground eventually. */
const CANVAS = over(dark.canvas, [0, 0, 0]);

/** AA: 4.5 for body text, 3.0 for large (≥18.66px bold, or ≥24px). */
const BODY = 4.5;
const LARGE = 3;

const SURFACES: readonly { name: string; token: string }[] = [
  { name: "canvas", token: dark.canvas },
  { name: "canvasTint", token: dark.canvasTint },
  { name: "surface", token: dark.surface },
  { name: "surfaceSunken", token: dark.surfaceSunken },
];

describe("every ink reads on every surface", () => {
  for (const surface of SURFACES) {
    const background = over(surface.token, CANVAS);
    for (const ink of ["ink", "inkMuted", "inkFaint"] as const) {
      it(`${ink} on ${surface.name} clears AA for body text`, () => {
        const measured = ratio(over(dark[ink], background), background);
        expect({
          pair: `${ink}/${surface.name}`,
          ok: measured >= BODY,
          measured,
        }).toEqual({
          pair: `${ink}/${surface.name}`,
          ok: true,
          measured,
        });
      });
    }
  }
});

describe("the accent colours read where they are used as text", () => {
  /**
   * `onAccent` is the ink *on* the accent fill — a primary button's label — and
   * the only pair here whose background is not a surface.
   */
  it("onAccent on accent clears AA", () => {
    const background = over(dark.accent, CANVAS);
    expect(ratio(over(dark.onAccent, background), background)).toBeGreaterThanOrEqual(
      BODY,
    );
  });

  /**
   * `info` is the cyan the observed vocabulary is written in — the window
   * stamps under every settled figure. Small text, so the body floor applies.
   */
  for (const surface of SURFACES) {
    const background = over(surface.token, CANVAS);
    it(`info on ${surface.name} clears AA`, () => {
      expect(ratio(over(dark.info, background), background)).toBeGreaterThanOrEqual(BODY);
    });
  }
});

describe("the risk chip reads in all three of its states", () => {
  /**
   * The defect this file was written after. The chip draws its class word and
   * its rounded probability in `fg` on `bg`, and only one of the three is on
   * screen at a time — so a renderer-based check sees a third of the rule.
   */
  for (const klass of ["low", "elevated", "high"] as const) {
    it(`the ${klass} chip clears AA`, () => {
      const pair = riskColor(dark, klass);
      const background = over(pair.bg, CANVAS);
      const measured = ratio(over(pair.fg, background), background);
      expect({ klass, ok: measured >= BODY, measured }).toEqual({
        klass,
        ok: true,
        measured,
      });
    });
  }

  /**
   * **Non-vacuity, and the exact defect that shipped.** The probability used to
   * carry `opacity: 0.8`, which took the `low` chip to 4.35. This asserts the
   * measurement rather than trusting the fix: the faded variant must fail the
   * body floor, or the table above is proving nothing about opacity at all.
   */
  it("the fade that shipped would still fail, which is why it is gone", () => {
    const pair = riskColor(dark, "low");
    const background = over(pair.bg, CANVAS);
    const faded = over(pair.fg, background).map(
      (channel, index) => channel * 0.8 + background[index] * 0.2,
    ) as unknown as Rgb;
    const measured = ratio(faded, background);
    expect({ faded: measured, belowFloor: measured < BODY }).toEqual({
      faded: measured,
      belowFloor: true,
    });
  });
});

describe("large text is held to the large-text floor, and it is a lower one", () => {
  it("the 40px figures clear AA-large on every surface", () => {
    for (const surface of SURFACES) {
      const background = over(surface.token, CANVAS);
      expect({
        surface: surface.name,
        ok: ratio(over(dark.ink, background), background) >= LARGE,
      }).toEqual({ surface: surface.name, ok: true });
    }
  });
});
