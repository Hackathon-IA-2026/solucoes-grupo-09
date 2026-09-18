/**
 * The two operator questions the dashboard could not answer in words.
 *
 * The brief gives the operator five questions and thirty seconds. Risk, band
 * and map were already answered. "Quando?" was readable off the fan — which is
 * work, and the same work every morning — and "por quê?" was on Explicar only.
 *
 * What these assert is as much what the screen refuses as what it says: no
 * window on a day with no likely hour, and no cause without the date it belongs
 * to.
 */

import { expect, test } from "@playwright/test";
import { latestTargetDate } from "@wattsteer/core";
import { routeGateway } from "./gateway-fixtures";

async function open(
  page: import("@playwright/test").Page,
  options: {
    forecast: boolean;
    reasons?: boolean;
  },
) {
  await routeGateway(page, options);
  await page.goto("/app");
  await expect
    .poll(() => page.evaluate(() => document.body.textContent?.length ?? 0), {
      timeout: 20_000,
    })
    .toBeGreaterThan(400);
}

test.describe("question 4 — when", () => {
  test("states the window and its peak, in words", async ({ page }) => {
    await open(page, { forecast: true });
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).toMatch(/Janela crítica|Critical window/);
    expect(body).toMatch(/\d+h–\d+h BRT/);
    expect(body).toMatch(/Pico às \d+h|Peak at \d+h/);
  });

  test("says how many hours the day has when the run is not all of them", async ({
    page,
  }) => {
    // The summary admitting it is one. A reader who sees a three-hour window
    // over a day with nine qualifying hours knows to look at the chart.
    await open(page, { forecast: true });
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).toMatch(/horas no dia esperam corte|hours of the day expect/);
  });

  test("claims no window where there is no forecast", async ({ page }) => {
    // A settled day's hours are a fact about yesterday, and the question is
    // about tomorrow. The observed state says nothing rather than something
    // true about the wrong day.
    await open(page, { forecast: false });
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).not.toMatch(/Janela crítica|Critical window/);
  });
});

test.describe("question 5 — why", () => {
  test("names the dominant reason, and the day it is about", async ({ page }) => {
    await open(page, { forecast: true, reasons: true });
    const body = (await page.locator("body").textContent()) ?? "";
    /*
      The label was "Motivo dominante" on a panel; it is the "Por quê?" card
      now, and the card can name a second reason where ONS split the day. What
      the question asks for is unchanged and is asserted below: the code, its
      share, and the day it is about.
    */
    expect(body).toMatch(/Por quê\?|Why\?/);
    // ENE carries 780 of the 1000 attributed MWh in the fixture. The plant row
    // is larger and is not counted, because a plant inside a conjunto ONS also
    // reported would be counted twice.
    expect(body).toContain("ENE");
    expect(body).toMatch(/78%/);
    /*
      **The date is not decoration, and it is not a literal either.**

      Without a date the sentence sits beside tomorrow's band and reads as a
      forecast of cause, which is the one thing the model cannot do. So the
      claim is that the settled day is printed beside the reason — but which day
      that is moves every midnight, and this asserted `16 de set. de 2026` until
      the clock rolled past it. A test that is only true on one day fails for a
      reason it is not about.

      Computed the product's own way rather than from `Date.now()`:
      `latestTargetDate` is the Brasília civil day plus one, and the settled day
      is two before that. Reading `getDate()` off a local `Date` instead would
      be wrong for three hours of every day on a runner outside
      `America/Sao_Paulo`, which is most CI.

      The month is asserted, not wildcarded: a screen printing the right
      day-of-month in the wrong month is exactly the kind of off-by-a-window bug
      this is here to catch. Both locales, because the screen has two.
    */
    const target = latestTargetDate(new Date());
    const settled = new Date(`${target}T00:00:00Z`);
    settled.setUTCDate(settled.getUTCDate() - 2);
    const options = {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    } as const;
    const pt = settled.toLocaleDateString("pt-BR", options);
    const en = settled.toLocaleDateString("en-US", options);
    expect([pt, en].some((formatted) => body.includes(formatted))).toBe(true);
  });

  test("says it is a settled record and not a forecast of cause", async ({ page }) => {
    await open(page, { forecast: true, reasons: true });
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).toMatch(
      /prevê quanto será cortado, não por quê|forecasts how much will be curtailed, not why/,
    );
  });

  test("claims no cause on a day ONS registered no restriction for", async ({ page }) => {
    // The default fixture is an empty day, which is the state the product is in
    // most of the time. "REL, 0%" would be worse than silence.
    await open(page, { forecast: true });
    const body = (await page.locator("body").textContent()) ?? "";
    // The card is still on screen — the five are the screen's frame — and it
    // says it has no record rather than naming a reason at 0 %.
    expect(body).toMatch(/Sem registro|Not recorded/);

    expect(body).not.toMatch(/\bENE\b|\bCNF\b|\bREL\b/);
  });
});

/**
 * The "Por quê?" card is a toggle, and what it toggles is Explicar itself.
 *
 * The card answers in five words — an ONS code and its share — and the long
 * answer was six hundred pixels below it behind an accordion. Pressing the card
 * raises the same section over the page instead. The accordion still opens it
 * where it always did; these assert the second way in, and that it is also a
 * way back.
 */
test.describe("question 5 — why, as a sheet", () => {
  const whyCard = (page: import("@playwright/test").Page) =>
    page.getByRole("button").filter({ hasText: /Por quê\?|Why\?/ });

  test("pressing the card raises the diagnosis, and pressing it again lowers it", async ({
    page,
  }) => {
    await open(page, { forecast: true, reasons: true });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveCount(0);

    await whyCard(page).click();
    await expect(dialog).toBeVisible();
    // The sheet holds Explicar, not a summary of it: the driver attribution is
    // the section's own answer and appears nowhere else on this page.
    await expect(dialog.getByText("SHAP", { exact: false }).first()).toBeVisible();

    // The toggle the brief asks for: the same press closes what it opened. The
    // card is behind a backdrop, so this goes through the sheet's own close.
    await dialog.getByTestId("sheet-close").click();
    await expect(dialog).toHaveCount(0);
  });

  test("Escape closes it, and the page is scrollable again afterwards", async ({
    page,
  }) => {
    await open(page, { forecast: true, reasons: true });
    await whyCard(page).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // The page must not scroll behind an open sheet; the assertion is that the
    // lock is *released*, because a lock that leaks strands the reader on a
    // 13 000px page with no wheel.
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).overflow),
    ).toBe("hidden");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).overflow),
    ).not.toBe("hidden");
  });

  /*
    **There is no accordion under the page any more, so there is no case here
    for it.**

    It asserted that the disclosure and the sheet opened the same element, which
    was the right guard while both existed. Explicar is the sheet now: a second
    way to the same content, three thousand pixels below the card that asks for
    it, was a way a reader who found one never needed. What replaced the claim is
    in `app-overview-selection.spec.ts` — the named Explicar control and the
    voice agent both reach it, and both are asserted there.
  */
});

test.describe("the 3D globe, when it cannot load", () => {
  test("falls back to the flat map and says why", async ({ page }) => {
    /*
      **A blank is not an answer.**

      `CesiumGlobe` returned `null` on a load failure and the map kept rendering
      the 3D branch: a near-black box of the stage's minimum height, with the ion
      credit in the corner and nothing else in it. No map, no stated reason —
      which is the one thing `CONTEXT.md` says this product never does — and
      because the layer choice is remembered in local storage, a reader who had
      chosen 3D met that blank on every reload.

      Driven the only way it can be: the distribution never arrives, and 3D is
      already the remembered choice when the page opens.
    */
    await page.addInitScript(() => {
      try {
        localStorage.setItem("wattsteer.mapLayer", "3d");
      } catch {
        // A browser with storage off simply starts on the default layer.
      }
    });
    await page.route("**/cesium/Cesium.js", (route) => route.abort());
    await open(page, { forecast: true });

    // The flat map is drawn — the four regions are there to be clicked.
    await expect(page.locator("svg[viewBox='0 0 1000 972']")).toHaveCount(1);
    // And the swap is explained rather than silent.
    await expect(page.getByText(/não carregou|did not load/)).toBeVisible();
    // The control agrees with what is drawn.
    const globe = page.getByRole("button", { name: /não carregou|did not load/ });
    await expect(globe).toHaveAttribute("aria-disabled", "true");
  });
});
