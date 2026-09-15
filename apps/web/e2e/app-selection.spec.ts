import { expect, type Page, test } from "@playwright/test";

/**
 * The selection bar writes a URL it can read back.
 *
 * `params.ts` holds this as a property — whatever a control writes must parse
 * back to what it meant — and that is where the rule belongs. What a unit test
 * cannot reach is the *wiring*: the `Tecnologia` chip's defect was not in the
 * translation, it was that `useAppParams().setParams` cast a domain value into
 * the query string instead of calling the translator at all. Pressing Solar put
 * `technology=SOLAR` in the address bar, `parseAppParams` reads only `solar`,
 * and the reader landed back on Wind with nothing thrown and the pill snapping
 * back — while the panel below promised that "escolher uma tecnologia ali em
 * cima destaca um destes dois números".
 *
 * So this presses the real pills in a real browser and reads the real URL. A
 * reintroduced cast fails here and passes every unit test in the suite.
 *
 * The pills are radios (`accessibilityRole="radio"`, `aria-checked`), which is
 * what makes "and it stayed selected" assertable without a screenshot.
 */

/** `?` and the query, as the address bar shows it. */
function query(page: Page): string {
  return new URL(page.url()).search;
}

async function press(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole("radio", { name, exact: typeof name === "string" }).click();
}

/**
 * Asserted rather than returned, so it retries: after a reload the bar renders
 * before the bundle has read the query string, and a one-shot read races it.
 */
async function expectChecked(
  page: Page,
  name: string | RegExp,
  value: boolean,
): Promise<void> {
  const pill = page.getByRole("radio", { name, exact: typeof name === "string" });
  await expect(pill).toHaveAttribute("aria-checked", String(value));
}

/**
 * The technology pills are the only ones whose labels are translated, and the
 * screen picks its locale from the browser. "Solar" is the same word in both
 * dictionaries; the wind pill is matched against either.
 */
const WIND = /^(Eólica|Wind)$/;

test.describe("the selection bar writes a URL it can read back", () => {
  test("the technology chip survives its own round trip", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByRole("radio", { name: "Solar", exact: true })).toBeVisible();

    await press(page, "Solar");
    // The URL spelling, in the address bar a reader may copy. `SOLAR` here is
    // the whole defect: `parseAppParams` does not read it.
    await expect(page).toHaveURL(/[?&]technology=solar(&|$)/);
    expect(query(page)).not.toContain("technology=SOLAR");
    // And the selection the app read back out of that URL is the one pressed.
    await expectChecked(page, "Solar", true);
    await expectChecked(page, WIND, false);

    await press(page, WIND);
    await expect(page).toHaveURL(/[?&]technology=wind(&|$)/);
    await expectChecked(page, WIND, true);
    await expectChecked(page, "Solar", false);
  });

  /*
    There is no reload assertion here, and the absence is deliberate.

    A cold load of the exported bundle honours *no* query parameter at all:
    `/app?subsystem=S`, `/app?run=00Z` and `/app?technology=solar` each render
    the defaults, measured in chromium against `dist/`. That is a separate and
    larger defect — the address bar is this product's only persistence, so a
    pasted link restores nothing — and it is not the chip's: it swallows every
    control equally, and swapping `useLocalSearchParams` for
    `useGlobalSearchParams` here does not move it. Asserting the reload would
    have made this file fail for a reason it is not about, and asserting the
    broken behaviour would have pinned it. Reported instead.
  */

  test("the subsystem and run chips round-trip too", async ({ page }) => {
    // Neither was broken. They are here because the guard is meant to cover
    // every control on the bar, not the one that failed: the next control added
    // gets the same assertion for free, which is what the technology chip did
    // not have.
    await page.goto("/app");

    await press(page, "S");
    await expect(page).toHaveURL(/[?&]subsystem=S(&|$)/);
    await expectChecked(page, "S", true);

    await press(page, "00Z");
    await expect(page).toHaveURL(/[?&]run=00Z(&|$)/);
    await expectChecked(page, "00Z", true);
    // `router.setParams` merges, so naming one field must not drop the others.
    await expectChecked(page, "S", true);
  });
});
