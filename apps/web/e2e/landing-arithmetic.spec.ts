import { expect, type Page, test } from "@playwright/test";

/**
 * The landing page's arithmetic, read off the rendered page in both locales.
 *
 * This suite exists because of a defect that every unit test on the fixture
 * passed: `landing-band.test.ts` already asserted that the four subsystem
 * expectations sum exactly to the national one, and they did — but
 * `expectedMwh` was never rendered, so the column a visitor actually saw was
 * four P50s (2,780 · 610 · 520 · 270 → 4,180) beneath a headline of 4,580 that
 * the prose beside it called an exact sum. The page invited an investor to add
 * a column of medians and find the page's own thesis wrong. A fixture test
 * cannot see that, because the defect was entirely in what was drawn.
 *
 * So the assertion is made where the reader makes it: parse the numbers out of
 * the DOM and do the addition.
 *
 * The rails in the showcase are checked here too, for the same reason — their
 * shared median was 4,180, i.e. the sum of the medians in the column above,
 * which `docs/specs/api-surface.md` §"The national readout" forbids
 * constructing. `landing-band.test.ts` holds the constant apart from the
 * fixture; this holds apart what is on the screen.
 */

const SUBSYSTEMS = ["NE", "N", "SE", "S"] as const;

/**
 * Every figure in a string, as numbers.
 *
 * Both locales group thousands — "2.960" in pt, "2,960" in en — and neither
 * uses a decimal on this page, so the separator is dropped rather than
 * interpreted. Interpreting it would make the parser locale-aware and give
 * this test a second thing to get wrong.
 */
function figures(text: string): number[] {
  return [...text.matchAll(/\d[\d.,]*/g)].map((m) => Number(m[0].replace(/[.,]/g, "")));
}

/**
 * The first figure printed after `label`.
 *
 * `after` is added to the index because a label can itself contain digits:
 * slicing from "P50" leaves "P50 2.780 …", whose first figure is 50.
 */
function figureAfter(text: string, label: string): number {
  const at = text.indexOf(label);
  expect(at, `"${label}" is not on the page`).toBeGreaterThanOrEqual(0);
  const found = figures(text.slice(at + label.length))[0];
  expect(found).toBeGreaterThan(0);
  return found;
}

/**
 * `textContent`, not `innerText`: react-native-web renders each run of text as
 * its own element, so the two differ only in the whitespace between runs, and
 * nothing here reads whitespace.
 */
async function textOf(page: Page, testID: string): Promise<string> {
  const text = await page.locator(`[data-testid="${testID}"]`).textContent();
  expect(text).not.toBeNull();
  return text ?? "";
}

for (const locale of ["pt", "en"] as const) {
  const expectedLabel = locale === "pt" ? "Valor esperado" : "Expected value";

  test(`/${locale}/ — the subsystem expectations add up to the national figure`, async ({
    page,
  }) => {
    await page.goto(`/${locale}/`);
    await expect(page.locator('[data-testid="hero-readout"]')).toBeVisible();

    // The headline: the national block leads the readout and names itself an
    // expectation before printing one.
    const national = figureAfter(await textOf(page, "hero-readout"), expectedLabel);
    expect(national).toBe(4580);

    let sum = 0;
    for (const code of SUBSYSTEMS) {
      // The defect in one assertion: the row has to print its expectation, and
      // print it under that name, or there is nothing on the page that adds.
      sum += figureAfter(await textOf(page, `subsystem-${code}`), expectedLabel);
    }
    expect(sum).toBe(national);
  });

  test(`/${locale}/ — the centre of each band says which quantile it is`, async ({
    page,
  }) => {
    await page.goto(`/${locale}/`);
    await expect(page.locator('[data-testid="hero-readout"]')).toBeVisible();
    for (const code of SUBSYSTEMS) {
      // An unlabelled centre figure is what made the column look addable: it
      // read as "the number for this subsystem" rather than as one quantile.
      const text = await textOf(page, `subsystem-${code}`);
      expect(text).toContain("P50");
      expect(text).toContain("P10–P90");
    }
  });

  test(`/${locale}/ — the band explainer does not illustrate with the summed medians`, async ({
    page,
  }) => {
    await page.goto(`/${locale}/`);
    await expect(page.locator('[data-testid="hero-readout"]')).toBeVisible();

    let sumOfMedians = 0;
    for (const code of SUBSYSTEMS) {
      sumOfMedians += figureAfter(await textOf(page, `subsystem-${code}`), "P50");
    }
    expect(sumOfMedians).toBe(4180);

    await page.locator('[data-testid="band-explainer"]').scrollIntoViewIfNeeded();
    const explainer = await textOf(page, "band-explainer");
    expect(explainer.length).toBeGreaterThan(0);
    for (const figure of figures(explainer)) {
      expect(figure).not.toBe(sumOfMedians);
    }
  });
}
