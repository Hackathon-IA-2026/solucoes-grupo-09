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

import { expect, type Page, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

test.describe("the Time Machine says whether the forecast held", () => {
  test.beforeEach(async ({ page }) => {
    /*
      `serving: "promoted"` is a precondition now, not decoration: the screen
      reads the lane to pin from `/v1/meta` rather than carrying a constant,
      so a replay is unreachable without one. Left unstubbed, this file was
      asserting the numbers against a deployment that could not name a lane.
    */
    await routeGateway(page, { forecast: true, serving: "promoted" });
    /*
      `/app/time-machine` since the old screen was removed. The figures are the
      same contract example — a band of 402-548-731 against a settlement of 612
      — and they were always shown by both, so this spec keeps its coverage
      rather than being deleted with the route it happened to drive.
    */
    await page.goto("/app/time-machine");
    /*
      Wait for the *replay*, not for a character count.

      A length threshold was met by the screen's chrome and its refusal copy
      long before any figure arrived, and since the lane comes from `/v1/meta`
      there is one more round trip than there was: the page now goes chrome →
      lane → calendar → replay, and 400 characters are on screen after the
      first of those. Both readings are real — this file failed on a different
      assertion on each of two consecutive runs, which is what a wait that
      resolves too early looks like.

      `548` is the fixture's forecast median, the first figure that exists only
      once the replay itself has landed.
    */
    await expect(page.getByText("548").first()).toBeVisible({ timeout: 20_000 });
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

  /*
    Where the two sentences below live on the dashboard.

    The old screen printed the placement sentence and the coverage paragraph as
    running prose. The dashboard states the verdict on the deviation card's face
    — "Dentro da faixa" — and keeps the full sentence and its refusal word for
    word behind that card's ⓘ, which is the same move `ProvenanceStrip` makes
    with the honesty paragraphs: the claim stays on screen, the argument is one
    press away. So the claim is asserted on the face and the argument is
    asserted after the press, rather than either being dropped.

    The hint's accessible name is the card's own title, which is how `KpiCard`
    builds it.
  */
  async function openDeviationHint(page: Page): Promise<string> {
    await page.getByTestId("kpi-deviation").getByRole("button").first().click();
    await expect(page.getByText(/P10–P90/).first()).toBeVisible({ timeout: 10_000 });
    return (await page.locator("body").textContent()) ?? "";
  }

  test("it says which side of the band the day fell on", async ({ page }) => {
    const face = (await page.locator("body").textContent()) ?? "";
    expect(face).toMatch(/Dentro da faixa|Inside the band/);
    const body = await openDeviationHint(page);
    expect(body).toMatch(/dentro da faixa P10–P90|inside the P10–P90 band/);
    expect(body).toMatch(/402/);
    expect(body).toMatch(/731/);
  });

  test("and does not grade it, or invent an accuracy percentage", async ({ page }) => {
    /*
      The refusal, asserted where a reader would see it. A P10–P90 band is meant
      to be missed about one day in five, so a screen that scored every day
      would teach a reader to want a band too wide to act on — and a percentage
      derived from one day would be a statistic with a familiar shape and no
      meaning.

      `coverage_p10_in_band` is named on screen rather than computed there,
      because the fraction of days inside is a property of a fold and the gate
      already measures it.

      The grading check reads the *whole* page and not the hint, because a grade
      appearing anywhere is the defect — it is the one assertion here that must
      not be scoped to where the good sentence is.
    */
    const body = await openDeviationHint(page);
    expect(body).toMatch(/um dia a cada cinco|one day in five/);
    expect(body).toContain("coverage_p10_in_band");
    expect(body).not.toMatch(/Acur[áa]cia:\s*\d/);
  });
});
