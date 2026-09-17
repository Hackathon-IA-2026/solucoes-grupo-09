/**
 * The cinematic console: a map that owns the window, figures over it, and the
 * day running underneath.
 *
 * Three properties, and each of them was wrong once before it was right.
 *
 *  1. **The timeline is on the screen.** A layout whose whole argument is "the
 *     map and the time axis are one view" fails completely if the axis is below
 *     the fold — measured at 1074px inside a 1000px viewport, twice, for two
 *     different reasons.
 *  2. **The map is a map at phone width.** Height-bounding is right where the
 *     screen is a stage and wrong where it is a document: applied to both, it
 *     rendered Brazil 103px wide.
 *  3. **The dock's corner is clear.** `VoiceDock` is `fixed` over the bottom
 *     right and is not moving; the timeline stops short of it, or the last two
 *     hours of the day sit under "Pergunte ao WattSteer".
 */

import { expect, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

async function open(page: import("@playwright/test").Page) {
  await routeGateway(page, { forecast: false });
  await page.goto("/app/console");
  await expect(page.getByRole("slider")).toHaveCount(1, { timeout: 20_000 });
}

test.describe("the scene fits the window", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test("the timeline is above the fold, not below it", async ({ page }) => {
    await open(page);
    const box = await page.getByRole("slider").boundingBox();
    expect(box).not.toBeNull();
    expect((box as { y: number }).y).toBeLessThan(1000);
  });

  test("and it stops before the voice dock", async ({ page }) => {
    await open(page);
    const slider = await page.getByRole("slider").boundingBox();
    const dock = await page.getByTestId("voice-dock").boundingBox();
    // The dock renders only where a session can be minted; where it does, the
    // timeline must not run under it.
    if (dock !== null && slider !== null) {
      expect(slider.x + slider.width).toBeLessThanOrEqual(dock.x + 1);
    }
  });

  test("all four regions are painted and clickable", async ({ page }) => {
    await open(page);
    await expect(page.locator("[data-region]")).toHaveCount(4);
  });
});

test.describe("at phone width it is a document again", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the map is a map, not a thumbnail", async ({ page }) => {
    await open(page);
    // The svg that *holds the regions*, not the first on the page — that one is
    // the 22px mark in the header, and asserting against it passes the day the
    // map disappears entirely.
    const map = await page
      .locator("svg")
      .filter({ has: page.locator("[data-region]") })
      .first()
      .boundingBox();
    expect(map).not.toBeNull();
    // 103px was the bug. Anything under about half the column is one again.
    expect((map as { width: number }).width).toBeGreaterThan(200);
  });

  test("and nothing scrolls sideways", async ({ page }) => {
    await open(page);
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
  });
});

test.describe("the timeline is a slider, and behaves like one", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test("arrow keys move the hour and announce it", async ({ page }) => {
    await open(page);
    const slider = page.getByRole("slider");
    const before = await slider.getAttribute("aria-valuenow");
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(slider).not.toHaveAttribute("aria-valuenow", before ?? "0");
    // The value text is what a screen reader reads, and an hour with no figure
    // beside it is a position without a meaning.
    expect(await slider.getAttribute("aria-valuetext")).toMatch(/MWh/);
  });

  test("Home and End reach the ends of the day", async ({ page }) => {
    await open(page);
    const slider = page.getByRole("slider");
    await slider.focus();
    await page.keyboard.press("End");
    const max = await slider.getAttribute("aria-valuemax");
    await expect(slider).toHaveAttribute("aria-valuenow", max ?? "");
    await page.keyboard.press("Home");
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
  });
});
