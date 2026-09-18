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

/**
 * The chips are on the map now, not on a bar above it.
 *
 * `/app` stopped rendering the selection bar when the same four subsystems and
 * the same two runs became chips beside the map they steer. They are buttons
 * with `aria-pressed` rather than radios with `aria-checked` — a toggle in a
 * group of toggles, which is what `ScopeBar` draws — so this drives that. What
 * the file asserts is unchanged: pressing a control writes a URL, and the URL
 * reads back.
 *
 * `/app/replay` still has a bar, and its own spec still drives radios.
 */
async function press(page: Page, name: string | RegExp): Promise<void> {
  await page
    .getByRole("button", { name, exact: typeof name === "string" })
    .first()
    .click();
}

/**
 * Asserted rather than returned, so it retries: after a reload the chips render
 * before the bundle has read the query string, and a one-shot read races it.
 */
async function expectChecked(
  page: Page,
  name: string | RegExp,
  value: boolean,
): Promise<void> {
  const pill = page
    .getByRole("button", { name, exact: typeof name === "string" })
    .first();
  await expect(pill).toHaveAttribute("aria-pressed", String(value));
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
    // every control the selection has, not the one that failed: the next control
    // added gets the same assertion for free, which is what the technology chip
    // did not have.
    //
    // The chips are drawn from the forecast rows, so the gateway has to answer
    // before they exist — the bar they replaced rendered without data.
    await routeGateway(page, { forecast: true });
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
    /*
      Narrowed to the selection's own chips by label. The map's controls are all
      toggles — scope and the 2D/3D layer are pressed too — and this test is
      about the two parameters the URL carries, not about every button on the
      screen. The pattern is written inline because `evaluate` runs in the page
      and cannot close over a constant from this file.
    */
    const checked = async () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[role="button"][aria-pressed="true"]')]
          .map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "")
          .filter((label) => /^(N|NE|SE\/CO|S|00Z|12Z)$/.test(label)),
      );

    // The chips are drawn from the forecast rows, so the gateway has to answer
    // before they exist — the bar they replaced rendered without data.
    await routeGateway(page, { forecast: true });
    await page.goto("/app?subsystem=S&run=00Z&technology=solar");
    /*
      Two chips, not three: `technology` is still in the URL and still read, but
      it no longer has a control anywhere in the chrome.

      `S` is marked because the link named it. A link that names a region is
      somebody pointing at one, so the map opens in its regional scope — which
      is the only reading under which the mark and the `SIN Geral` chip beside
      it can both be true.
    */
    await expect.poll(checked).toEqual(["S", "00Z"]);

    /*
      Non-vacuity, and the region is deliberately absent from it.

      A plain visit opens on the whole grid, where marking one of the four would
      contradict the scope chip saying all of them. So the run keeps its default
      and no region claims to be chosen — which is also what makes the assertion
      above mean something: the page is reading the link rather than echoing
      whatever it is handed.
    */
    await page.goto("/app");
    await expect.poll(checked).toEqual(["12Z"]);
  });
});
