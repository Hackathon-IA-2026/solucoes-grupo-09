import { expect, type Page, test } from "@playwright/test";

/**
 * The landing nav's scrolling, against the real exported `dist/`.
 *
 * This suite exists because of a defect neither the unit tests nor a single
 * page load could see: **a section id was not unique**. Following the deck
 * link to `/pitch` and then the link home pushed a *second* landing screen on
 * top of the first, which stayed mounted, so the document held two elements
 * for every section id. The scroll code resolved its target with a
 * document-wide `getElementById`, got the stale copy — laid out at
 * `{top: 0, height: 0}` — and scrolled to 0 while still writing `#engines` to
 * the URL. Every nav item, every time, with nothing thrown and nothing logged.
 *
 * Two independent fixes, and one test each below:
 *
 * 1. The lookup is scoped to the hook's own scroll container, so a duplicate
 *    id elsewhere in the document cannot misdirect it. Guarded by injecting a
 *    second element for each id — the guard would pass against the bug if it
 *    only ever had one copy on the page, so it makes two.
 * 2. "Home" is `dismissTo`, so returning pops back to the landing screen in
 *    the stack instead of stacking another copy of it. Guarded by walking the
 *    exact path a reader walked and counting what is mounted at the end.
 *
 * The rest of the file is the behaviour that was already working and that
 * neither fix may cost: a cold load on a fragment, a plain click, and
 * back/forward.
 */

/** Ids on the landing page, which are also what the nav's hrefs point at. */
const SECTIONS = ["forecast", "engines", "showcase", "provenance", "deck"] as const;

/**
 * The landing page scrolls inside a `ScrollView`, not the document, so
 * `window.scrollY` is 0 at every position on the page. Found from the hero
 * rather than by selector, because the scroller is react-native-web's own
 * element and carries no test id.
 */
function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    let node = document.querySelector('[data-testid="landing-hero"]')?.parentElement;
    while (node) {
      const overflow = getComputedStyle(node).overflowY;
      if (
        node.scrollHeight > node.clientHeight + 50 &&
        (overflow === "auto" || overflow === "scroll")
      ) {
        return Math.round(node.scrollTop);
      }
      node = node.parentElement;
    }
    return -1;
  });
}

/** How many elements carry a given section id. One, or the page is duplicated. */
function idCount(page: Page, id: string): Promise<number> {
  return page.evaluate(
    (target) => document.querySelectorAll(`[id="${target}"]`).length,
    id,
  );
}

/**
 * The nav row collapses below 860 px — a phone gets the wordmark and the
 * language switch and no section links at all — so a click on a nav item has
 * nothing to click there. Declared per describe rather than once for the file,
 * because the cold load on a fragment is a claim about every viewport.
 */
const WIDE_ENOUGH_FOR_THE_NAV = 900;

test.describe("the landing nav scrolls to a section", () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < WIDE_ENOUGH_FOR_THE_NAV,
    "the nav row is only rendered on a wide viewport",
  );

  test("after returning from the deck — the reported path, end to end", async ({
    page,
  }) => {
    await page.goto("/pt/");
    await expect(page.getByTestId("landing-hero")).toBeVisible();

    // 1. A nav click on a page loaded cold: the baseline that always worked.
    await page.locator('[data-testid="landing-nav"] a[href="#engines"]').click();
    await expect(page).toHaveURL(/#engines$/);
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);

    // 2. Out to the deck, 3. and back by the link on it.
    await page.getByTestId("footer-pitch-link").click();
    await expect(page.getByTestId("pitch-screen")).toBeVisible();
    await page.getByTestId("pitch-home-link").click();
    await expect(page).toHaveURL(/\/pt\/?$/);

    // The landing page is mounted once, not twice — counted before anything is
    // asserted to be visible, because with two copies the first one is the
    // stale one and "not visible" would be a confusing way to report this.
    await expect.poll(() => page.getByTestId("landing-hero").count()).toBe(1);
    for (const id of SECTIONS) {
      expect([id, await idCount(page, id)]).toEqual([id, 1]);
    }
    await expect(page.getByTestId("landing-hero")).toBeVisible();

    // 4. And the nav still scrolls — the symptom the reader reported.
    await page.locator('[data-testid="landing-nav"] a[href="#provenance"]').click();
    await expect(page).toHaveURL(/#provenance$/);
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(2000);
  });

  test("even when a second element on the page carries the same id", async ({ page }) => {
    await page.goto("/pt/");
    await expect(page.getByTestId("landing-hero")).toBeVisible();

    // A stand-in for the duplicate mount, placed *before* the real sections in
    // tree order and outside the scroll container — which is exactly where the
    // stale landing screen sat, and is what `getElementById` would answer
    // with. Any future route that renders these sections brings this shape
    // back, so the guard is on the lookup rather than on the navigation.
    await page.evaluate(
      (ids) => {
        const stale = document.createElement("div");
        stale.setAttribute("data-stale-copy", "");
        for (const id of ids) {
          const section = document.createElement("div");
          section.id = id;
          section.style.height = "0px";
          stale.appendChild(section);
        }
        document.body.insertBefore(stale, document.body.firstChild);
      },
      SECTIONS as unknown as string[],
    );

    // Non-vacuous by construction: the ids really are ambiguous now.
    for (const id of SECTIONS) {
      expect([id, await idCount(page, id)]).toEqual([id, 2]);
    }

    await page.locator('[data-testid="landing-nav"] a[href="#provenance"]').click();
    await expect(page).toHaveURL(/#provenance$/);
    // The stale element is 0 px tall at the top of the document, so resolving
    // the id document-wide computes an offset of 0 and this stays at 0.
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(2000);
  });
});

test.describe("the behaviour the fixes may not cost", () => {
  test("a cold load on a fragment lands on the section", async ({ page }) => {
    await page.goto("/pt/#engines");
    await expect(page.getByTestId("landing-engines")).toBeVisible();
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);
  });

  test("back returns to the top and forward returns to the section", async ({
    page,
    viewport,
  }) => {
    test.skip(
      (viewport?.width ?? 0) < WIDE_ENOUGH_FOR_THE_NAV,
      "the nav row is only rendered on a wide viewport",
    );
    await page.goto("/pt/");
    await page.locator('[data-testid="landing-nav"] a[href="#showcase"]').click();
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);

    await page.goBack();
    await expect(page).toHaveURL(/\/pt\/$/);
    await expect.poll(() => scrollTop(page)).toBeLessThan(100);

    await page.goForward();
    await expect(page).toHaveURL(/#showcase$/);
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);
  });
});
