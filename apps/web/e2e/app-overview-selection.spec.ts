import { expect, type Page, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

/**
 * Selecting a region on Visão da rede is not navigating away from it.
 *
 * The defect: a click on the Brazil map or on a subsystem row called
 * `router.push("/app/explain")`. One gesture, two plausible meanings — *show me
 * this region here* and *go explain this region* — and it silently did the
 * second, so the four panels on that screen (24-hour profile, wind and solar,
 * day energy, peak power) could only be re-pointed from the menu at the top.
 * A reader clicked a region expecting those panels to change and was taken off
 * the screen instead.
 *
 * None of that is visible to a unit test: the handler was one line, it was
 * correct on its own terms, and what was wrong was which of two meanings the
 * product had assigned to a click. So it is asserted the way a reader
 * experiences it — click, and check what moved and what did not.
 *
 * Both states are driven, because the screen has two and only one of them is
 * the one production is in. With nothing promoted the map and the rows are
 * drawn from settled data rather than withheld, so the selection has the same
 * two ends in both states — and the assertions below are about *selecting*,
 * which must behave identically whichever numbers the regions carry.
 */

/** `textContent`, not `innerText`: react-native-web splits every run of text. */
async function textOf(page: Page, testID: string): Promise<string> {
  const text = await page.locator(`[data-testid="${testID}"]`).textContent();
  expect(text).not.toBeNull();
  return text ?? "";
}

/** A region on the map, by the `data-region` the map stamps on its path. */
function region(page: Page, code: string) {
  return page.locator(`[data-region="${code}"]`);
}

/**
 * The whole screen's text, for asserting what the panel headers say.
 *
 * `textContent`, so runs of text are concatenated without the whitespace
 * `innerText` would insert — which is why the window below is read as "the
 * heading is followed closely by the region's name" rather than as an exact
 * string.
 */
async function screenText(page: Page): Promise<string> {
  return (await page.locator("body").textContent()) ?? "";
}

test.describe("a click on the map selects, and does not navigate", () => {
  test.beforeEach(async ({ page }) => {
    await routeGateway(page, { forecast: true });
  });

  test("picking a region re-points the screen without leaving it", async ({ page }) => {
    await page.goto("/app");
    await expect(page.locator('[data-testid="selected-region"]')).toBeVisible();
    // NE is `parseAppParams`'s default, so the screen starts there.
    expect(await textOf(page, "selected-region-name")).toContain("NORDESTE");

    await region(page, "S").click();

    // The three things that together are "selected, not navigated":
    await expect(page).toHaveURL(/\/app(\?|$)/);
    await expect(page).toHaveURL(/[?&]subsystem=S(&|$)/);
    expect(new URL(page.url()).pathname).not.toContain("explain");
    await expect(page.locator('[data-testid="selected-region-name"]')).toHaveText(/SUL/);
  });

  test("the panels below say whose numbers they are, and change with the pick", async ({
    page,
  }) => {
    // The header naming is what makes a silent change visible at all: four
    // panels that never said who they were about could be re-pointed under a
    // reader with nothing on screen to attribute it to.
    await page.goto("/app");
    await expect(page.locator('[data-testid="selected-region"]')).toBeVisible();
    const before = await screenText(page);
    expect(before).toContain("NORDESTE");

    await region(page, "N").click();
    await expect(page.locator('[data-testid="selected-region-name"]')).toHaveText(
      /NORTE/,
    );
    const after = await screenText(page);
    // Every one of the four panel headings names the region now.
    for (const heading of ["Eólica e solar", "Energia cortada, dia inteiro", "Pico"]) {
      const at = after.indexOf(heading);
      expect(at, `"${heading}" is on the screen`).toBeGreaterThanOrEqual(0);
      expect(after.slice(at, at + 90)).toContain("NORTE");
    }
  });

  test("Explain is a control with a name on it, and it takes you to the section", async ({
    page,
  }) => {
    await page.goto("/app");
    await expect(page.locator('[data-testid="selected-region"]')).toBeVisible();
    await region(page, "SE").click();
    await expect(page.locator('[data-testid="selected-region-name"]')).toHaveText(
      /SUDESTE/,
    );

    /*
      **It used to push `/app/explain`, and Explicar is a section of this page
      now.** The distinction this file is about is unchanged and is the reason
      the control still exists: a click on the map *selects*, and only a control
      with "Explicar" written on it takes the reader to the explanation. What
      changed is that the explanation is six hundred pixels down rather than one
      document away, so the control scrolls instead of navigating — and the
      reader keeps the map that raised the question.
    */
    await page.locator('[data-testid="selected-region-explain"]').click();
    await expect(page).toHaveURL(/\/app(\?|$)/);
    // The selection still travels with it, which was always the point.
    await expect(page).toHaveURL(/[?&]subsystem=SE(&|$)/);
    await expect(page.locator("#explain")).toBeVisible();
  });

  test("arrow keys walk the four regions and move the selection live", async ({
    page,
  }) => {
    await page.goto("/app");
    await expect(page.locator('[data-testid="selected-region"]')).toBeVisible();

    // Focus the map rather than tab through the chrome to reach it: what is
    // under test is the arrow key, not the tab order. NE is the default
    // selection, and the step is from the *selection* — a step from whichever
    // region happened to hold focus would make the same key do different things
    // depending on how the reader got there.
    await region(page, "NE").focus();

    // Display order is N · NE · SE · S, and forward is down the list.
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/[?&]subsystem=SE(&|$)/);
    await expect(page.locator('[data-testid="selected-region-name"]')).toHaveText(
      /SUDESTE/,
    );
    // Focus follows the selection, or the visible marker and the live selection
    // disagree — which is the confusion this screen is being fixed for. It is
    // also what lets the *next* arrow press be handled at all.
    await expect(region(page, "SE")).toBeFocused();

    await page.keyboard.press("ArrowLeft");
    await expect(page).toHaveURL(/[?&]subsystem=NE(&|$)/);
    await expect(region(page, "NE")).toBeFocused();

    await page.keyboard.press("ArrowUp");
    await expect(page).toHaveURL(/[?&]subsystem=N(&|$)/);
    await expect(region(page, "N")).toBeFocused();

    // It is a ring: one step back from the first region is the last one.
    await page.keyboard.press("ArrowUp");
    await expect(page).toHaveURL(/[?&]subsystem=S(&|$)/);
    await expect(region(page, "S")).toBeFocused();
    await expect(page.locator('[data-testid="selected-region-name"]')).toHaveText(/SUL/);
  });
});

test.describe("with nothing promoted, a reader can still say which region", () => {
  test.beforeEach(async ({ page }) => {
    await routeGateway(page, { forecast: false });
  });

  test("the map is there, drawn from settled data, and the selection is not lost", async ({
    page,
  }) => {
    await page.goto("/app");
    await expect(page.locator('[data-testid="selected-region"]')).toBeVisible();
    // The map renders — it did not, before, because it was wired to the
    // forecast and there is none. It is the *observed* map now, and
    // `app-observed-overview.spec.ts` is what holds the two apart.
    await expect(region(page, "NE")).toHaveCount(1);
    // And the screen still names the pick, and still says which figures are
    // missing rather than quietly substituting one kind of number for another.
    expect(await textOf(page, "selected-region-name")).toContain("NORDESTE");
    expect(await textOf(page, "selected-region")).toMatch(
      /Nenhum número de previsão|No forecast figures/,
    );
  });

  test("the settled rows take a selection, which they used only to display", async ({
    page,
  }) => {
    await page.goto("/app");
    await expect(page.locator('[data-testid="selected-region"]')).toBeVisible();

    await page.getByRole("button", { name: /SUL/ }).first().click();
    await expect(page).toHaveURL(/[?&]subsystem=S(&|$)/);
    await expect(page).toHaveURL(/\/app(\?|$)/);
    await expect(page.locator('[data-testid="selected-region-name"]')).toHaveText(/SUL/);
  });

  test("Explain still carries the region, to the section on this page", async ({
    page,
  }) => {
    await page.goto("/app");
    await expect(page.locator('[data-testid="selected-region-explain"]')).toBeVisible();
    await page.locator('[data-testid="selected-region-explain"]').click();
    await expect(page).toHaveURL(/\/app(\?|$)/);
    await expect(page).toHaveURL(/[?&]subsystem=NE(&|$)/);
    await expect(page.locator("#explain")).toBeVisible();
  });
});
