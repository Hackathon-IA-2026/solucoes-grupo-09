import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

/**
 * **Zero WCAG violations, on every screen, checked by a real engine.**
 *
 * Lighthouse already runs a subset of these rules and the Overview scored 91 on
 * accessibility for a long time without anyone knowing which four things were
 * wrong. This file runs `axe-core` itself, against the same stubbed gateway the
 * selection specs use, so the screens under test are the screens with data on
 * them — the map only exists once a subsystem has a figure, and three of the
 * four defects this file was written against were on elements that do not
 * render on an empty page.
 *
 * **WCAG only, deliberately.** `runOnly` is `wcag2a` and `wcag2aa`: those are
 * obligations. axe's `best-practice` pack is advice, and one of its rules —
 * `region`, which wants every node inside a landmark — fires 30-odd times on a
 * react-native-web tree for reasons that are about how RNW nests `View`s rather
 * than about anything a reader experiences. Folding advice into the same
 * assertion as an obligation is how an obligation gets waived.
 *
 * The four it was written against, all found on the Overview and all fixed:
 *
 *  - `aria-allowed-attr` / `aria-prohibited-attr` — the map's four region
 *    `<path>`s carried `aria-label` and `aria-pressed` with no `role`, which an
 *    SVG path does not have implicitly.
 *  - `aria-required-children` — the episodes table's body rows declared
 *    `role="row"` over children with no `role="cell"`.
 *  - `color-contrast` — the `low` risk chip's probability at `opacity: 0.8`
 *    measured 4.35:1 against a 4.5 floor. The other two chips passed, which is
 *    how it hid.
 *  - `nested-interactive` — the selected row was a `<button>` containing the
 *    Explain `<button>`.
 */

const AXE_SOURCE = readFileSync(
  join(dirname(require.resolve("axe-core/package.json")), "axe.min.js"),
  "utf8",
);

/**
 * Bundled rather than fetched from a CDN. A suite that needs the network to
 * decide whether the product is accessible fails on a train, and a green run on
 * a train would then mean nothing.
 */
async function violations(page: Page): Promise<{ id: string; nodes: number }[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async () => {
    const run = (
      window as unknown as {
        axe: {
          run: (
            c: unknown,
            o: unknown,
          ) => Promise<{ violations: { id: string; nodes: unknown[] }[] }>;
        };
      }
    ).axe.run;
    const result = await run(document, {
      runOnly: ["wcag2a", "wcag2aa"],
      /*
        **`color-contrast` off here, and measured properly elsewhere.**

        axe resolves a foreground by compositing down through ancestors until it
        finds a non-transparent background. A react-native-web tree is
        transparent nearly all the way up, and axe committed to an answer rather
        than reporting incomplete: it put the Overview's national panel at
        **1.01:1**, near-black on near-black. Screenshotting that exact element
        and reading its pixels put the text at luminance **247 on a background
        of 27** — about 15:1, and plainly legible. Two false positives on one
        screen is enough to make a gate untrustworthy, and an untrustworthy gate
        gets switched off entirely rather than narrowed.

        So it is narrowed. `test/contrast.test.ts` measures every ink against
        every surface from the tokens themselves, which is strictly more than
        axe could see from one render: it caught `inkFaint` on `surfaceSunken`
        at 4.23 — a pair no fixture on these screens happens to produce — and it
        checks all three risk chips rather than whichever one is on screen.
      */
      rules: { "color-contrast": { enabled: false } },
    });
    return result.violations.map((each) => ({ id: each.id, nodes: each.nodes.length }));
  });
}

/**
 * The screens, and **what each one is actually showing** when audited.
 *
 * `routeGateway` serves the observed reads and the forecast reads. It does not
 * serve `/v1/diagnosis/day-ahead`, `POST /v1/optimize` or `POST /v1/replay`, so
 * Explain, Mitigar and the Time Machine render their **refusal** state here.
 * That is stated rather than glossed because it bounds what this file proves —
 * and it is not a weak state to prove things about: nothing is promoted in
 * production, so a refusal is what a real reader meets on three of these four
 * screens today.
 *
 * `minChars` is the floor that stops the audit going quietly vacuous. axe finds
 * no violations on an empty page, so a screen that stopped rendering would turn
 * its assertion green rather than red. The numbers are the measured content
 * minus a margin, not round guesses.
 */
const SCREENS: {
  path: string;
  ready: string;
  minChars: number;
  forecast?: boolean;
}[] = [
  // The map is the readiness signal, not `load`: it is the last thing to
  // arrive and half the rules this file was written against are about
  // elements inside it.
  { path: "/app", ready: "[data-region]", minChars: 600 },
  /*
    **The same page with nothing published, which is the state production is
    actually in and the one this file was not auditing.**

    Every screen here ran with `forecast: true`, so the observed stack — a
    different map, different rows, different panels — was never audited at all.
    A `nested-interactive` violation lived on it: the observed row is a button
    and carried an Explain button inside it, which is one of the four defects
    named at the top of this file, returned through the path the audit did not
    walk. Auditing the happy path only is how a suite reports green on the state
    no reader is in.
  */
  { path: "/app", ready: "[data-region]", minChars: 600, forecast: false },
  { path: "/app/explain", ready: "text=/./", minChars: 300 },
  { path: "/app/mitigate", ready: "text=/./", minChars: 600 },
  { path: "/app/replay", ready: "text=/./", minChars: 500 },
  { path: "/app/time-machine", ready: "text=/./", minChars: 500 },
];

/*
  **Every audit runs under `prefers-reduced-motion: reduce`, and that is a
  correctness requirement rather than a convenience.**

  `FadeIn` animates entrance opacity from 0, and axe computes contrast from the
  *composited* colour. Run mid-animation it reads a near-white heading at
  opacity 0.02 as `#151518` on `#131316` — a 1.01:1 "violation" against text
  that is, a third of a second later, perfectly legible. Measured: two nodes on
  the Overview, both inside panels that had begun fading but not finished.

  That is not a WCAG failure — transient animation states are not what 1.4.3 is
  about — but it is a genuine flake, and a suite that fails at random gets
  deleted. Reduced motion makes `FadeIn` set its progress to 1 on mount, so the
  audit sees the settled presentation deterministically. It also happens to be a
  presentation a real reader can select, which makes it the right one to hold to
  the standard.
*/
/*
  Through `contextOptions`, which is where this version puts it. Written as a
  bare `test.use({ reducedMotion })` it is not an option Playwright's types know
  at all — so the setting this block exists for was never reaching the browser,
  and the flake described above was only being hidden by FadeIn usually winning
  the race. The typecheck that would have said so was red at another package.
*/
test.use({ contextOptions: { reducedMotion: "reduce" } });

for (const screen of SCREENS) {
  const forecast = screen.forecast ?? true;
  test(`${screen.path} has no WCAG A or AA violations${
    forecast ? "" : " with nothing promoted"
  }`, async ({ page }) => {
    await routeGateway(page, { forecast });
    await page.goto(screen.path);
    await page.locator(screen.ready).first().waitFor({ timeout: 20_000 });
    /*
      **The settle condition and the floor are the same assertion.**

      These screens fetch, then refuse or render, and axe run against a spinner
      finds nothing wrong with a spinner — so the audit has to wait. It waits by
      polling for the content it requires rather than by sleeping: a fixed wait
      is too short on a slow machine and wasted on a fast one, and `networkidle`
      is a proxy for "done" that a background poll would keep false forever.

      The floor is also what stops this file going quietly vacuous. axe finds no
      violations on an empty page, so a screen that stopped rendering would turn
      its assertion green instead of red. The numbers are measured content minus
      a margin, not round guesses.
    */
    await expect
      .poll(() => page.evaluate(() => document.body.textContent?.length ?? 0), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(screen.minChars);
    expect(await violations(page)).toEqual([]);
  });
}

test("the landing page has no WCAG A or AA violations", async ({ page }) => {
  await page.goto("/pt/");
  // The landing page is the largest document the site serves, and the same
  // poll is both its settle and its non-vacuity floor.
  await expect
    .poll(() => page.evaluate(() => document.body.textContent?.length ?? 0), {
      timeout: 20_000,
    })
    .toBeGreaterThan(2000);
  expect(await violations(page)).toEqual([]);
});

/**
 * The same audit with the "Por quê?" sheet open.
 *
 * A dialog is the one presentation where the audit above proves nothing: it is
 * portalled out of the page and does not exist in the document until a reader
 * presses the card, so every rule this file holds the Overview to was, for the
 * sheet, unchecked. The two that matter here are the two a modal gets wrong —
 * `aria-dialog-name`, because a dialog with no accessible name is a dialog a
 * screen reader announces as nothing, and `nested-interactive`, which is why
 * the card's caveat mark stayed outside the card's own button.
 */
test("the Explain sheet has no WCAG A or AA violations", async ({ page }) => {
  await routeGateway(page, { forecast: true });
  await page.goto("/app");
  await page.locator("[data-region]").first().waitFor({ timeout: 20_000 });
  await page
    .getByRole("button")
    .filter({ hasText: /Por quê\?|Why\?/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The floor, as above: an empty dialog would pass vacuously, and this one is
  // the whole Explicar section.
  await expect
    .poll(() => dialog.textContent().then((text) => text?.length ?? 0), {
      timeout: 20_000,
    })
    .toBeGreaterThan(300);
  expect(await violations(page)).toEqual([]);
});
