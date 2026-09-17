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
    expect(body).toMatch(/Motivo dominante|Dominant reason/);
    // ENE carries 780 of the 1000 attributed MWh in the fixture. The plant row
    // is larger and is not counted, because a plant inside a conjunto ONS also
    // reported would be counted twice.
    expect(body).toContain("ENE");
    expect(body).toMatch(/78%/);
    // The date is not decoration. Without it the sentence sits beside
    // tomorrow's band and reads as a forecast of cause, which is the one thing
    // the model cannot do.
    expect(body).toMatch(/16 de set\. de 2026|Sep 16, 2026/);
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
    expect(body).not.toMatch(/Motivo dominante|Dominant reason/);
  });
});
