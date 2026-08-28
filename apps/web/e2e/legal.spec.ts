import { expect, type Page, test } from "@playwright/test";

/**
 * Footer (CTA + legal links) and the /terms + /privacy legal pages. Mirrors
 * the edtech legal spec shape but against our design-system components and
 * testIDs. No API is needed — none of these flows call the backend.
 */

function headingCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('h1, h2, h3, [role="heading"]').length,
  );
}

test.describe("site footer", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("renders the CTA and legal links on the landing page", async ({ page }) => {
    await expect(page.getByTestId("site-footer")).toBeVisible();
    await expect(page.getByTestId("footer-cta-button")).toBeVisible();
    await expect(page.getByTestId("footer-privacy-link")).toBeVisible();
    await expect(page.getByTestId("footer-terms-link")).toBeVisible();
  });

  test("privacy link navigates to /privacy", async ({ page }) => {
    await page.getByTestId("footer-privacy-link").click();
    await expect(page).toHaveURL(/\/privacy/);
    await expect(page.getByTestId("legal.content.container")).toBeVisible();
  });

  test("terms link navigates to /terms", async ({ page }) => {
    await page.getByTestId("footer-terms-link").click();
    await expect(page).toHaveURL(/\/terms/);
    await expect(page.getByTestId("legal.content.container")).toBeVisible();
  });
});

for (const path of ["/terms", "/privacy"] as const) {
  test.describe(`legal page ${path}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(path);
    });

    test("renders the content area and a page heading", async ({ page }) => {
      await expect(page.getByTestId("legal.content.container")).toBeVisible();
      expect(await headingCount(page)).toBeGreaterThan(0);
    });

    test("renders the TOC navigation with multiple items", async ({ page }) => {
      const nav = page.getByTestId("legal.sidebar.navigation").first();
      await expect(nav).toBeVisible();
      const items = nav.locator('[data-testid^="legal.sidebar.item."]');
      expect(await items.count()).toBeGreaterThan(1);
    });

    test("clicking a TOC item scrolls to its section", async ({ page }) => {
      const items = page
        .getByTestId("legal.sidebar.navigation")
        .first()
        .locator('[data-testid^="legal.sidebar.item."]');
      await expect(items.first()).toBeVisible({ timeout: 10_000 });

      // Pick a later item so the scroll is observable.
      const target = items.last();
      const testId = await target.getAttribute("data-testid");
      expect(testId).toBeTruthy();
      const sectionId = (testId ?? "").replace("legal.sidebar.item.", "");

      await target.click();
      await expect(page.getByTestId(`legal.content.section.${sectionId}`)).toBeVisible({
        timeout: 10_000,
      });
    });

    test("the home link returns to the landing page", async ({ page }) => {
      await page.getByTestId("legal-home-link").click();
      await expect(page).toHaveURL(/\/(index\.html)?(\?.*)?$/);
      await expect(page.getByTestId("url-input")).toBeVisible();
    });

    test("desktop TOC sidebar is present on desktop, hidden on mobile", async ({
      page,
    }) => {
      const container = page.getByTestId("legal.sidebar.container");
      if ((page.viewportSize()?.width ?? 0) >= 1024) {
        await expect(container).toBeVisible();
      } else {
        await expect(container).toBeHidden();
      }
    });
  });
}
