/**
 * The day is one parameter, and both controls move it.
 *
 * The map's scope bar grew two arrows over `params.date`; the app bar stated
 * the same day as a label. That is one fact rendered twice, once as a control
 * and once as a caption, a few hundred pixels apart — a reader who found the
 * arrows had no reason to think the chip above was the same day, and one who
 * only saw the chip had no reason to think the day could move.
 *
 * Both carry arrows now, so what has to be held is that they are the *same*
 * day: the URL is the single copy, and a change made in either place is read
 * back by the other. Two controls over one parameter that drift apart is worse
 * than one control, because the screen then disagrees with itself in public.
 */

import { expect, type Page, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

const dayOf = (page: Page, id: string) => page.getByTestId(id).textContent();

test.describe("the day picker, in the app bar and on the map", () => {
  test.beforeEach(async ({ page }) => {
    await routeGateway(page, { forecast: true, serving: "promoted" });
    await page.goto("/app");
    await expect(page.getByTestId("app-bar-date")).toBeVisible({ timeout: 20_000 });
  });

  test("both controls read the same day", async ({ page }) => {
    expect(await dayOf(page, "app-bar-date")).toBe(await dayOf(page, "scope-bar-date"));
  });

  test("stepping back in the app bar moves the map's day too", async ({ page }) => {
    const before = await dayOf(page, "app-bar-date");
    // The app bar's own back arrow, by its accessible name rather than by
    // position: the two arrows are the same glyph and a positional locator
    // would pass just as happily on the wrong one.
    await page
      .getByRole("button", { name: /dia anterior|previous day/i })
      .first()
      .click();

    await expect(page.getByTestId("app-bar-date")).not.toHaveText(before ?? "");
    // The day is in the URL, which is what makes it one parameter rather than
    // two pieces of component state that happen to agree at first render.
    await expect(page).toHaveURL(/[?&]date=\d{4}-\d{2}-\d{2}/);
    expect(await dayOf(page, "app-bar-date")).toBe(await dayOf(page, "scope-bar-date"));
  });

  test("forward does not step past the day being forecast", async ({ page }) => {
    /*
      The guarantee, not the markup. `latestTargetDate` is *tomorrow*, the
      screen opens on it, and there is no day after it to show — an arrow that
      led there would reach four stated absences and teach a reader the control
      is broken.

      Asserted by pressing rather than by reading `aria-disabled`, because that
      attribute never reaches the DOM: measured on the export, the inert arrow
      renders at `opacity: 0.35` with attributes `aria-label, role, tabindex,
      class, style, type` — react-native-web drops both `aria-disabled` and
      `accessibilityState` on this `Pressable`. The control is correctly inert
      and announces nothing, which is worth knowing and is not what this test
      is for. What it holds is that the day does not move.
    */
    const before = await dayOf(page, "app-bar-date");
    const forward = page.getByRole("button", { name: /dia seguinte|next day/i });
    for (let step = 0; step < 3; step += 1) {
      await forward.click();
      await page.waitForTimeout(200);
    }
    expect(await dayOf(page, "app-bar-date")).toBe(before);
    expect(await dayOf(page, "scope-bar-date")).toBe(before);
  });
});
