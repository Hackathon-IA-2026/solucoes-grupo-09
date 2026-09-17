/**
 * The band's measured coverage, and the prose that must never reach a reader.
 *
 * The gate has computed `coverage_p10_in_band` at every gate since it was
 * written, and no screen showed it. The Time Machine's accuracy panel even
 * names it — "the aggregate lives with the aggregate" — while the aggregate
 * lived nowhere.
 *
 * Two properties, and the second is the one worth a spec: the numbers are
 * stated, and `claim_note` is not. The contract calls that field auditor prose
 * in the same status as an error `message`, and a screen that printed it would
 * be showing a reader a sentence written for somebody auditing the card.
 */

import { expect, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

test.describe("did the band cover what it promises", () => {
  test.beforeEach(async ({ page }) => {
    await routeGateway(page, { forecast: true });
    await page.goto("/app/explain");
    await expect
      .poll(() => page.evaluate(() => document.body.textContent?.length ?? 0), {
        timeout: 20_000,
      })
      .toBeGreaterThan(400);
  });

  test("states both marginals, the target and the population", async ({ page }) => {
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).toMatch(/A faixa cobriu|Did the band cover/);
    // 95.5% lower, 91.9% upper, against a 90% target, over 3 541 curtailed
    // hours of fold F6. The population matters: over *every* hour the lower
    // statement is trivially true, because the composed P10 is zero wherever
    // the hour is unlikely to curtail at all.
    expect(body).toMatch(/95,5%|95\.5%/);
    expect(body).toMatch(/91,9%|91\.9%/);
    expect(body).toContain("F6");
    expect(body).toMatch(/3\.541|3,541/);
  });

  test("says it is a fold and not a day", async ({ page }) => {
    // The distinction the Time Machine's refusal depends on: a day lands
    // inside its band or outside it, and the fraction that land inside is a
    // property of many days.
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).toMatch(/sobre uma dobra inteira, não sobre um dia|over a whole fold/);
  });

  test("never renders the card's auditor prose", async ({ page }) => {
    /*
      `claim_note` is assembled for whoever is auditing the artifact: where the
      claim is withheld it opens with the refusal and carries the decomposition
      naming which factor is short. The contract puts it in the same status as
      an error `message` — never rendered to a user — and the fixture's value
      is a sentinel so this assertion cannot pass vacuously.
    */
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).not.toContain("Auditor prose");
  });
});
