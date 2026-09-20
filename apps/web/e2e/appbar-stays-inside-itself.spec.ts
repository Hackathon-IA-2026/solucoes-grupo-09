import { expect, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

/**
 * **Nothing in the app bar is drawn outside the group it belongs to.**
 *
 * Written after a defect a phone found and every existing guard missed. At
 * 390px the header's right-hand group — the target day and the language
 * switch — was allotted 14.9px beside a 323px left group, because its
 * `flexBasis: 0` told the wrapping row it wanted no width of its own. Its
 * children are 253px and react-native-web defaults `flexShrink` to 0
 * (ADR-0001), so they were laid out over the badge that says **no model is
 * promoted**: the one element on the chrome that states the deployment's
 * condition, covered by a date.
 *
 * ### Why the sibling guard did not catch it
 *
 * `no-horizontal-overflow.spec.ts` asserts exactly the property that was
 * broken — content wider than its box with `overflow-x: visible` — and it runs
 * at 320, 360 and 400. It passed because **`/v1/meta` is not stubbed**: with
 * the read refused, the badge renders nothing like its longest state, the left
 * group is narrow, and the right group fits. The screen that shipped had a
 * 197px badge in it.
 *
 * So this spec stubs the serving state the deployment is actually in, and
 * asserts containment rather than page overflow: a child outside its parent's
 * box is the shape of *this* failure, and it survives a layout where some
 * ancestor scrolls.
 *
 * 390 and 400 are the widths that broke; 320 and 360 wrapped already and are
 * here so a fix that helps one and hurts the other is visible.
 */

/** The phone widths the header is written against, and the two that failed. */
const WIDTHS = [320, 360, 390, 400];

/** Groups, by the `data-` marker `app-shell.tsx` puts on each one. */
const GROUPS = ["appbar-left", "appbar-right", "appbar-nav"] as const;

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

    test("no app bar group is drawn outside its own box", async ({ page }) => {
      // The state production is in: observed reads answer, the forecast ones
      // refuse, and nothing is promoted — which is what makes the badge say so
      // at its longest.
      await routeGateway(page, { forecast: false, serving: "nothingPromoted" });
      await page.goto("/app");
      await expect
        .poll(() => page.evaluate(() => document.body.textContent?.length ?? 0), {
          timeout: 20_000,
        })
        .toBeGreaterThan(200);

      const escaped = await page.evaluate((groups) => {
        const out: string[] = [];
        for (const group of groups) {
          const root = document.querySelector<HTMLElement>(`[data-${group}]`);
          if (root === null) {
            // A marker that stopped being emitted is a guard that stopped
            // guarding, so say which one rather than passing vacuously.
            out.push(`${group}: not in the document`);
            continue;
          }
          // A group that scrolls is a group doing its job: the screen toggle
          // is a horizontal `ScrollView`, its pills are 306px in a 280px box at
          // 320px, and the reader has a gesture that brings them back. The
          // failure this spec is about is content with nowhere to go, which is
          // `overflow-x: visible` — the same distinction
          // `no-horizontal-overflow.spec.ts` draws, for the same reason.
          const overflowX = getComputedStyle(root).overflowX;
          if (overflowX === "auto" || overflowX === "scroll") {
            continue;
          }
          const box = root.getBoundingClientRect();
          for (const child of root.querySelectorAll<HTMLElement>(":scope > *")) {
            const rect = child.getBoundingClientRect();
            // A pixel of slack: sub-pixel layout rounds, and a half-pixel of
            // border is not a reader's problem.
            if (rect.left < box.left - 1 || rect.right > box.right + 1) {
              out.push(
                `${group}: a child spans ${Math.round(rect.left)}–${Math.round(
                  rect.right,
                )} in a box of ${Math.round(box.left)}–${Math.round(box.right)} — ${(
                  child.textContent ?? ""
                ).slice(0, 40)}`,
              );
            }
          }
        }
        return out;
      }, GROUPS);

      expect({ width, escaped }).toEqual({ width, escaped: [] });
    });
  });
}
