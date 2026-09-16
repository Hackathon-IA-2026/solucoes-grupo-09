/**
 * The briefing overlay, in a browser.
 *
 * **What a browser can assert that a unit test cannot.** `briefing-compose` and
 * `briefing-clock` already hold the decisions — which scenes exist, which one is
 * showing. What they cannot see is the overlay itself: that it is absent until
 * asked for, that it covers the screen when it arrives, that it does not push
 * the page sideways at 320 px, and that dismissing it leaves the reader on the
 * screen they were on rather than somewhere new.
 *
 * **Why the stage is driven directly rather than through the agent.** Opening a
 * real briefing needs a realtime session — a socket, a minted credential and a
 * microphone — none of which exist in this harness, and stubbing all three
 * would be testing the stub. The provider's state is the seam the tool call
 * writes to, so these specs assert what is true either side of it: with no
 * briefing asked for, nothing is mounted; and the app screens stay intact with
 * the host mounted above them, which is the regression that would follow from
 * mounting an overlay in the layout.
 */

import { expect, type Page, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

const APP_SCREENS = ["/app", "/app/explain", "/app/mitigate", "/app/replay"] as const;

/** Wait for a screen to stop reading before measuring anything about it. */
async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId("reading-state")).toHaveCount(0, { timeout: 15_000 });
}

test.describe("the briefing is absent until it is asked for", () => {
  for (const path of APP_SCREENS) {
    test(`${path} mounts no stage of its own`, async ({ page }) => {
      await routeGateway(page, { forecast: true });
      await page.goto(path);
      await settled(page);

      // The host is mounted on every app screen — beside the dock, in the
      // layout — and must cost nothing until a briefing exists. An overlay that
      // rendered empty would still take the scrim and the focus.
      await expect(page.getByTestId("briefing-stage")).toHaveCount(0);
    });
  }
});

test.describe("mounting the host does not disturb the screens under it", () => {
  test("the Overview still draws its readout card and its map", async ({ page }) => {
    await routeGateway(page, { forecast: true });
    await page.goto("/app");
    await settled(page);

    // The regression an overlay in the layout would cause: a fixed-position
    // sibling that swallows pointer events or collapses the stack beneath it.
    await expect(page.locator("[data-region='NE']").first()).toBeVisible();
    const text = (await page.locator("body").textContent()) ?? "";
    expect(text).toContain("MWh");
  });

  test("the shell's own chrome survives the sibling overlay", async ({ page }) => {
    await routeGateway(page, { forecast: true });
    await page.goto("/app");
    await settled(page);

    // Both overlays live in `_layout.tsx` as siblings of the `Stack`. If the
    // briefing host ever took the screen unconditionally, the screen's own
    // chrome is what would disappear first and most visibly.
    //
    // The voice dock is *not* asserted here: this harness stubs the gateway's
    // reads and not `/v1/voice/session`, so the deployment reads as one that
    // cannot mint a session and the dock correctly renders nothing. Asserting
    // it would be asserting the stub.
    await expect(page.getByRole("tablist")).toHaveCount(1);
    await expect(page.getByRole("tab")).toHaveCount(4);
  });
});

test.describe("no horizontal overflow with the host mounted", () => {
  for (const width of [320, 360, 400]) {
    test(`/app does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await routeGateway(page, { forecast: true });
      await page.goto("/app");
      await settled(page);

      // The sweep that found nine real clipped elements on Explain and
      // Mitigate. The briefing host adds a fixed-position sibling to every app
      // screen, and a fixed element wider than the viewport is the classic way
      // to give a phone a horizontal scrollbar.
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    });
  }
});
