import { expect, type Page, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

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
function _query(page: Page): string {
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
const _WIND = /^(Eólica|Wind)$/;

test.describe("the selection bar writes a URL it can read back", () => {
  /*
    **There are no technology pills any more, and the parameter is still real.**

    The toggle came out of the chrome because its effect was three phone screens
    below it — measured, the pills at y=197 and the panel they re-weight at
    y=2719 — so a reader pressed `Solar`, the page did exactly as asked, and
    nothing they could see changed. The voice agent still sets it, and
    `context.ts` still reports it, so the round trip this test was written for
    is worth keeping. It is driven through the URL now, which is the surface
    that still has it, and asserted where the effect actually lands.
  */
  test("the technology parameter survives its own round trip", async ({ page }) => {
    // The rest of this file asserts chrome, which renders without data. This
    // one asserts a panel, so it needs figures to draw.
    await routeGateway(page, { forecast: true });
    await page.goto("/app?technology=solar");
    // The emphasis is the whole of what the parameter buys: one fleet bold and
    // named `em destaque`, the other dimmed. Both are always drawn.
    await expect(page.getByText(/Solar · (em destaque|emphasised)/)).toBeVisible();
    await expect(page.getByText(/(Eólica|Wind) · (em destaque|emphasised)/)).toHaveCount(
      0,
    );

    await page.goto("/app?technology=wind");
    await expect(
      page.getByText(/(Eólica|Wind) · (em destaque|emphasised)/),
    ).toBeVisible();
    await expect(page.getByText(/Solar · (em destaque|emphasised)/)).toHaveCount(0);

    // The casing this test was written against: `parseAppParams` reads the
    // lowercase spelling only, so `SOLAR` in a copied address must not silently
    // become a selection nobody made.
    await page.goto("/app?technology=SOLAR");
    await expect(
      page.getByText(/(Eólica|Wind) · (em destaque|emphasised)/),
    ).toBeVisible();
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

test.describe("a deep link is the selection", () => {
  test("a cold load honours every parameter, not just the route", async ({ page }) => {
    /*
      The URL is this product's only persistence — `params.ts` says so, and
      Mitigate and Time Machine both tell the reader on screen that "the address
      bar is the scenario" and "this link is the entire state". A cold load
      honoured none of it: `/app?subsystem=S` rendered NE.

      The cause was not parsing. The hook computed `S` correctly on the client's
      first render; the export had prerendered the HTML with the defaults, and
      **React's hydration does not correct an attribute mismatch** — it keeps the
      server markup. Worse, every later render then compared `S` to `S` in
      React's own tree and patched nothing, so the DOM and the app disagreed for
      the life of the page, silently. Forcing a re-render does not fix it; only
      making the first client render agree with the server, and changing on the
      second, does.
    */
    const checked = async () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[role="radio"]')]
          .filter((el) => el.getAttribute("aria-checked") === "true")
          .map((el) => el.getAttribute("aria-label"))
          .filter((label) => label !== null && !/Portugu|English/.test(label)),
      );

    await page.goto("/app?subsystem=S&run=00Z&technology=solar");
    // Two radios, not three: `technology` is still in the URL and still read,
    // but it no longer has pills in the chrome.
    await expect.poll(checked).toEqual(["S", "00Z"]);

    // Non-vacuity: the defaults must still be the defaults, or the assertion
    // above would hold of a page that simply echoed whatever it was asked for.
    await page.goto("/app");
    await expect.poll(checked).toEqual(["NE", "12Z"]);
  });
});
