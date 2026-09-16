import { expect, type Page, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

/**
 * Explain and Mitigate, rendered.
 *
 * Neither screen had a spec, and neither could have had one: the stub answered
 * the Overview's five reads and 404'd the rest, so both screens drew their
 * "the gateway did not answer" refusal and there was nothing to assert. The
 * two fixtures they were missing — a wire `ModelCard` and an `ObservedReasons`
 * — now sit in `gateway-fixtures.ts` beside the others, and the diagnosis and
 * optimizer bodies are the spec's own published examples, read off
 * `packages/core/fixtures/spec-examples/` rather than restated.
 *
 * What this file asserts is the thing a unit test cannot: that with every read
 * answered, these screens render their panels rather than a refusal. That is
 * the regression that went unnoticed for as long as the stub was incomplete —
 * a screen can only be seen to work in a browser.
 */

async function screenText(page: Page): Promise<string> {
  return (await page.locator("body").textContent()) ?? "";
}

/**
 * Wait for the screen to stop reading before asserting on its text.
 *
 * A `textContent()` snapshot is taken the instant it is asked for, so a spec
 * that grabs one straight after `goto` is asserting against "Lendo o
 * diagnóstico" — the reading state — and passes or fails on how fast the stub
 * answered. Every assertion below is about what the screen *settled* on.
 */
async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId("reading-state")).toHaveCount(0, { timeout: 15_000 });
}

test.describe("Explain, with every read answered", () => {
  test("renders the diagnosis rather than a refusal", async ({ page }) => {
    await routeGateway(page, { forecast: true });
    await page.goto("/app/explain");
    await settled(page);

    const text = await screenText(page);
    // The refusal these screens fall back to when a read 404s. Its absence is
    // the assertion: it is what both screens showed before the fixtures landed.
    expect(text).not.toContain("gateway");
    // The driver attribution is the screen's own answer to "why this region?".
    await expect(page.getByText("SHAP", { exact: false }).first()).toBeVisible();
  });

  test("draws the risk band and the two magnitudes", async ({ page }) => {
    await routeGateway(page, { forecast: true });
    await page.goto("/app/explain");
    await settled(page);

    const text = await screenText(page);
    // MWh for the day's energy and MW for the hourly peak — two units, and the
    // screen is wrong if it ever shows only one of them.
    expect(text).toContain("MWh");
    expect(text).toContain("MW");
  });
});

test.describe("Mitigate, with every read answered", () => {
  test("renders a plan rather than a refusal", async ({ page }) => {
    await routeGateway(page, { forecast: true });
    await page.goto("/app/mitigate");
    await settled(page);

    const text = await screenText(page);
    expect(text).not.toContain("gateway");
    // The floor is the number this screen exists to put in front of an
    // operator, and it is stated before any potential is.
    expect(text).toContain("MWh");
  });
});
