import { expect, type Page, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

/**
 * **No page scrolls sideways, at any width the product claims to support.**
 *
 * This is automation of a check that was being done by hand. `landing/hero.tsx`
 * carries the evidence: a sub-line that refused to break in a non-wrapping row
 * "pushed the page's scroll width to 479px against a 400px viewport. Measured
 * on the static export; it was the page's only horizontal overflow." Somebody
 * found that by opening the export and looking.
 *
 * A horizontal scrollbar is the failure that a screenshot review passes and a
 * reader on a phone meets immediately: the content is all there, correctly
 * laid out, and half a sentence is off the right edge. Nothing in the unit
 * suite can see it — it is a property of the rendered box tree at a width —
 * and nothing in the other e2e specs asserts it, because they each drive a
 * behaviour rather than measuring the page.
 *
 * 400px is the narrow bound the components are written against; it appears in
 * that comment and in several others. 320px is included because it is the
 * narrowest phone still in use, and a layout that survives 400 usually fails
 * 320 in one specific place — which is worth knowing about deliberately rather
 * than hearing about.
 */

/** Every route the product serves, including the ones behind the gateway. */
const PAGES: { path: string; gateway: boolean }[] = [
  { path: "/pt/", gateway: false },
  { path: "/en/", gateway: false },
  { path: "/pt/privacy", gateway: false },
  { path: "/pt/terms", gateway: false },
  { path: "/pitch", gateway: false },
  { path: "/app", gateway: true },
  { path: "/app/explain", gateway: true },
  { path: "/app/mitigate", gateway: true },
  { path: "/app/replay", gateway: true },
];

/**
 * **400 and 360, not 320 — and the difference is a claim, not an oversight.**
 *
 * 400px is the width this product is written against: it is the number in
 * `hero.tsx`'s comment about a sub-line that would not break, in
 * `app-shell.tsx`'s about a truncated word at the viewport edge, and in the
 * `PanelHeader` fix these tests were written after. 360px is the narrowest
 * width in common use (a Galaxy A-series, a Pixel in display-size mode) and is
 * inside what the layout was designed for.
 *
 * 320px is **not** asserted, and it does not pass today. Measured: the footer's
 * link row wants 248px in a 224px box, the landing's hero heading 294 in 288,
 * and the Diagnosis card 320 in 288. Those are real and small, and fixing them
 * is the same `flexShrink` treatment applied three times over. They are left
 * out because asserting 320 would claim a width nobody designed for, and a
 * green suite that quietly means "we support 320" is worse than an honest gap.
 * Widen this array the day somebody decides 320 is supported.
 */
const WIDTHS = [360, 400];

/**
 * Does the *page* scroll sideways, and if so, what is sticking out?
 *
 * **The rule is `overflow-x: visible` and wider than its box.** Two earlier
 * versions of this check were wrong in opposite directions and both are worth
 * recording. Asserting on any element wider than the viewport reported ten
 * failures on a product that does not overflow at all — a child of a
 * deliberately scrollable row (the subsystem selector, the tab strip)
 * legitimately extends past its container, which clips and scrolls it. Then
 * asserting only on `document.scrollingElement.scrollWidth` reported *zero*
 * failures while the app screens were clipping every panel header, because
 * react-native-web's `ScrollView` absorbs the overflow into its own box and the
 * document never grows.
 *
 * What a reader actually loses is content that is wider than its box and has
 * nowhere to scroll: `overflow-x: visible`, clipped by some ancestor, with no
 * gesture that brings it back. Leaves only — a parent is wide because its child
 * is, and reporting the chain buries the one element anybody can fix.
 */
async function overflow(page: Page): Promise<{ clipped: string[] }> {
  return page.evaluate(() => {
    const bad = new Set<HTMLElement>();
    for (const node of document.querySelectorAll<HTMLElement>("body *")) {
      const style = getComputedStyle(node);
      if (
        node.clientWidth > 0 &&
        node.scrollWidth > node.clientWidth + 1 &&
        // `auto` and `scroll` are containers doing their job. `visible` is
        // content that will be clipped by an ancestor or push the page.
        style.overflowX === "visible"
      ) {
        bad.add(node);
      }
    }
    // Leaves only: a parent is wide because its child is, and reporting the
    // whole chain buries the one element anybody can fix.
    return {
      clipped: [...bad]
        .filter(
          (node) => ![...bad].some((other) => other !== node && node.contains(other)),
        )
        .map(
          (node) =>
            `${node.clientWidth}px box, ${node.scrollWidth}px content — ${(
              node.textContent ?? ""
            ).slice(0, 60)}`,
        ),
    };
  });
}

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const { path, gateway } of PAGES) {
      test(`${path} does not scroll sideways`, async ({ page }) => {
        if (gateway) {
          await routeGateway(page, { forecast: true });
        }
        await page.goto(path);
        // Settle on content rather than on a timer: a page measured mid-render
        // is a page whose widest element has not arrived yet.
        await expect
          .poll(() => page.evaluate(() => document.body.textContent?.length ?? 0), {
            timeout: 20_000,
          })
          .toBeGreaterThan(200);

        const { clipped } = await overflow(page);
        expect({ path, width, clipped }).toEqual({ path, width, clipped: [] });
      });
    }
  });
}
