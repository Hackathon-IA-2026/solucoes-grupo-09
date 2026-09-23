/**
 * The Time Machine dashboard, `/app/time-machine`, over a real export.
 *
 * The replay is the contract's own example (NE, 2025-09-14: a band of
 * 402–548–731 and 612 settled), so every figure `/app/replay` shows for that
 * day must appear here too — the two screens read one replay, and a dashboard
 * that disagreed with the screen beside it would be the defect.
 *
 * The comparison, the timeline and the attribution are stubbed by
 * `time-machine-fixtures.ts`, whose bodies `time-machine-fixtures.test.ts`
 * holds to the schemas.
 *
 * `TIME_MACHINE_SHOTS=<dir>` also writes full-page screenshots of each state,
 * for a reviewer. Nothing is written without it.
 */

import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { pt as PT } from "../src/i18n/copy.pt";
import { routeGateway } from "./gateway-fixtures";

const PATH = "/app/time-machine?episode=2025-09-14-ne";
const SHOTS = process.env.TIME_MACHINE_SHOTS;

async function open(page: Page) {
  await routeGateway(page, {
    forecast: true,
    reasons: true,
    serving: "promoted",
    review: true,
  });
  await page.goto(PATH);
  await expect(page.getByTestId("kpi-forecast")).toBeVisible({ timeout: 20_000 });
  // The comparison and the timeline land after the replay; wait for both.
  await expect(page.getByText("768").first()).toBeVisible({ timeout: 20_000 });
}

async function shoot(page: Page, name: string) {
  if (SHOTS === undefined) {
    return;
  }
  // The shell scrolls inside its own container, so `fullPage` would capture one
  // viewport. The viewport is grown to the tallest scroll height on the page —
  // at the mock's 1600px on desktop — and the shot is taken of all of it.
  const mobile = test.info().project.name.startsWith("mobile");
  const width = mobile ? (page.viewportSize()?.width ?? 412) : 1600;
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(300);
  const height = await page.evaluate(() =>
    Math.max(...[...document.querySelectorAll("*")].map((node) => node.scrollHeight)),
  );
  await page.setViewportSize({ width, height: Math.min(height + 40, 16_000) });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `${name}-${test.info().project.name}.png`) });
}

test.describe("the Time Machine dashboard", () => {
  test("shows the replay's own figures, with the deviation's sign", async ({ page }) => {
    await open(page);
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).toContain("548");
    expect(body).toContain("612");
    expect(body).toMatch(/\+64/);
    // The national row: the joint band's P50 and the sum of four settled days.
    expect(body).toContain("671");
    expect(body).toContain("768");
    await shoot(page, "01-dashboard-pt");
  });

  test("the plan chart draws every settled hour, whatever the dispatch carries", async ({
    page,
  }) => {
    // The contract example carries one dispatch hour; the chart once sized its
    // slot from that and drew an empty figure. Twenty-four settled hours, all
    // above zero, are twenty-four bars on the plot.
    await open(page);
    const figure = page.locator(`[aria-label="${PT.app.replay.planVsExecutedFigure}"]`);
    await expect(figure).toHaveCount(1);
    const bars = await figure.locator("rect").evaluateAll(
      (nodes) =>
        nodes.filter((node) => {
          const box = (node as SVGGraphicsElement).getBBox();
          const svg = (node as SVGGraphicsElement).ownerSVGElement;
          const width = svg?.viewBox.baseVal.width ?? 0;
          return box.height > 0 && box.x + box.width <= width;
        }).length,
    );
    expect(bars).toBe(24);
  });

  test("a tab switch lands on the Overview's day, not on today", async ({ page }) => {
    // What `sharedParams` sends from the Overview after a reader walked back to
    // the 13th: a date and a region, and no episode. The newest replayable day
    // at or before the 13th is the 12th.
    await routeGateway(page, {
      forecast: true,
      reasons: true,
      serving: "promoted",
      review: true,
    });
    await page.goto("/app/time-machine?subsystem=NE&date=2025-09-13");
    await expect(page).toHaveURL(/episode=2025-09-12-ne/, { timeout: 20_000 });
  });

  test("a link that names a day keeps it", async ({ page }) => {
    await open(page);
    await page.waitForTimeout(500);
    expect(page.url()).toContain("episode=2025-09-14-ne");
  });

  test("grades no day with an accuracy and names no cause", async ({ page }) => {
    await open(page);
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).not.toMatch(/Acur[áa]cia:\s*\d/);
    expect(body).not.toMatch(/Accuracy:\s*\d/);
    expect(body).not.toMatch(/\bMAPE\b/);
    // The mock's "probable cause" tab and its confidence scores. The driver
    // bars' own disclaimer ("não é causa de nenhum MWh") is the product saying
    // the opposite, and is allowlisted for that reason.
    expect(body).not.toMatch(/causa prov[áa]vel|probable cause/i);
    expect(body).not.toMatch(/confian[çc]a da causa|ader[êe]ncia da evid/i);
  });

  test("each evidence tab controls its panel", async ({ page }) => {
    await open(page);
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(4);
    await page.getByTestId("time-machine-tab-analogues").click();
    await expect(page.getByText("703").first()).toBeVisible();
    await shoot(page, "02-tab-analogues");
    await page.getByTestId("time-machine-tab-reasons").click();
    await expect(page.getByText(/REL|CNF|ENE/).first()).toBeVisible();
    await shoot(page, "03-tab-reasons");
    await page.getByTestId("time-machine-tab-audit").click();
    await expect(
      page
        .getByRole("link")
        .filter({ hasText: /JSON|reexecução|replay/i })
        .first(),
    ).toBeVisible();
    await shoot(page, "04-tab-audit");
  });

  test("reads the same in English", async ({ page }) => {
    await open(page);
    // The key `entry.spec.ts` uses; the app reads it on the next load.
    await page.evaluate(() => window.localStorage.setItem("wattsteer.locale", "en"));
    await page.reload();
    await expect(page.getByTestId("kpi-forecast")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("768").first()).toBeVisible({ timeout: 20_000 });
    await shoot(page, "05-dashboard-en");
  });
});
