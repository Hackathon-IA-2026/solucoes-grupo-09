/**
 * The Time Machine answers "did the forecast hold?", and the branch that
 * answers it had no browser coverage at all.
 *
 * `/v1/replay` was not stubbed, so every spec that opened this screen was
 * asserting the *refusal* while believing it had a replay. The whole `Replayed`
 * branch — the accuracy panel, the floor, the avoidability, the plan against
 * the executed — rendered in no test. Adding the read to `gateway-fixtures.ts`
 * is most of what this file is; the assertions are the reason to.
 *
 * The numbers come from `12-replay.json`, the same example `packages/core`
 * validates the contract against: a band of 402–548–731 and a settlement of
 * 612. A day that landed inside its band, which is the case worth asserting
 * because it is the one a reader sees most.
 */

import { expect, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

test.describe("the Time Machine says whether the forecast held", () => {
  test.beforeEach(async ({ page }) => {
    await routeGateway(page, { forecast: true });
    await page.goto("/app/replay");
    await expect
      .poll(() => page.evaluate(() => document.body.textContent?.length ?? 0), {
        timeout: 20_000,
      })
      .toBeGreaterThan(400);
  });

  test("the three figures are the contract's, and the error keeps its sign", async ({
    page,
  }) => {
    const body = (await page.locator("body").textContent()) ?? "";
    // 548 forecast, 612 settled, +64 error. The `+` is asserted because an
    // absolute error would hide that the product under-forecast this day, and
    // under-forecasting costs a generator the chance to act.
    expect(body).toContain("548");
    expect(body).toContain("612");
    expect(body).toMatch(/\+64/);
  });

  test("it says which side of the band the day fell on", async ({ page }) => {
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).toMatch(/dentro da faixa P10–P90|inside the P10–P90 band/);
    expect(body).toMatch(/402/);
    expect(body).toMatch(/731/);
  });

  test("and does not grade it, or invent an accuracy percentage", async ({ page }) => {
    const body = (await page.locator("body").textContent()) ?? "";
    /*
      The refusal, asserted where a reader would see it. A P10–P90 band is meant
      to be missed about one day in five, so a screen that scored every day
      would teach a reader to want a band too wide to act on — and a percentage
      derived from one day would be a statistic with a familiar shape and no
      meaning.

      `coverage_p10_in_band` is named on screen rather than computed there,
      because the fraction of days inside is a property of a fold and the gate
      already measures it.
    */
    expect(body).toMatch(/um dia a cada cinco|one day in five/);
    expect(body).toContain("coverage_p10_in_band");
    expect(body).not.toMatch(/Acur[áa]cia:\s*\d/);
  });
});
