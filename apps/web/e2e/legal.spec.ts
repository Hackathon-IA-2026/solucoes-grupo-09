import { expect, type Page, test } from "@playwright/test";

/**
 * Footer (CTA + legal links), the legal pages, and the language gate — all
 * against the locale-prefixed route tree.
 *
 * Every path here carries a locale prefix, which is the point: after
 * `docs/specs/i18n.md`'s route tree there is no unprefixed `/privacy`, and the
 * tests are what catch a `Link href="/privacy"` that was never made
 * locale-aware. No API is needed — none of these flows call the backend.
 */

const LOCALES = ["pt", "en"] as const;

function headingCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('h1, h2, h3, [role="heading"]').length,
  );
}

test.describe("the language gate at /", () => {
  test("ships real links to both locale roots", async ({ page }) => {
    // The gate's own redirect fires before hydration, so read the HTML the
    // server actually sends rather than the page it turns into. This is the
    // JavaScript-disabled contract: two working links, no script required.
    const response = await page.request.get("/");
    const html = await response.text();
    expect(html).toContain('href="/pt/"');
    expect(html).toContain('href="/en/"');
    // noindex,follow — no unique content to rank, but crawl equity should
    // still reach the two locale roots.
    expect(html).toMatch(/name="robots"\s+content="noindex,follow"/);
    expect(html).toContain('hreflang="x-default" href="https://wattsteer.com/pt/"');
  });

  test("robots.txt still allows the gate", async ({ page }) => {
    const robots = await (await page.request.get("/robots.txt")).text();
    expect(robots).toContain("Allow: /");
    expect(robots).not.toContain("Disallow");
  });

  test("sends a first-time visitor to the default locale", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/pt\/$/);
  });

  test("sends an English browser to /en/", async ({ browser }) => {
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/en\/$/);
    await context.close();
  });

  test("honours a stored preference over the browser's language", async ({ browser }) => {
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    await page.goto("/pt/");
    await page.evaluate(() => localStorage.setItem("wattsteer.locale", "pt"));
    await page.goto("/");
    await expect(page).toHaveURL(/\/pt\/$/);
    await context.close();
  });

  test("replaces rather than pushes, so Back does not trap", async ({ page }) => {
    await page.goto("/pt/terms");
    await page.goto("/");
    await expect(page).toHaveURL(/\/pt\/$/);
    await page.goBack();
    // If the gate had been pushed, Back would land on it and bounce forward
    // again — the visitor would be unable to leave.
    await expect(page).toHaveURL(/\/pt\/terms/);
  });
});

for (const locale of LOCALES) {
  test.describe(`site footer (${locale})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/${locale}/`);
    });

    test("renders the CTA and legal links on the landing page", async ({ page }) => {
      await expect(page.getByTestId("site-footer")).toBeVisible();
      await expect(page.getByTestId("footer-cta-button")).toBeVisible();
      await expect(page.getByTestId("footer-privacy-link")).toBeVisible();
      await expect(page.getByTestId("footer-terms-link")).toBeVisible();
    });

    test("privacy link stays inside this locale", async ({ page }) => {
      await page.getByTestId("footer-privacy-link").click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/privacy`));
      await expect(page.getByTestId("legal.content.container")).toBeVisible();
    });

    test("terms link stays inside this locale", async ({ page }) => {
      await page.getByTestId("footer-terms-link").click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/terms`));
      await expect(page.getByTestId("legal.content.container")).toBeVisible();
    });
  });
}

for (const locale of LOCALES) {
  const other = locale === "pt" ? "en" : "pt";

  for (const page_ of ["/terms", "/privacy"] as const) {
    const path = `/${locale}${page_}`;

    test.describe(`legal page ${path}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.goto(path);
      });

      test("renders the content area and a page heading", async ({ page }) => {
        await expect(page.getByTestId("legal.content.container")).toBeVisible();
        expect(await headingCount(page)).toBeGreaterThan(0);
      });

      test("declares its own canonical and both hreflang alternates", async ({
        page,
      }) => {
        const canonical = page.locator('link[rel="canonical"]');
        await expect(canonical).toHaveAttribute("href", `https://wattsteer.com${path}`);
        for (const tag of ["pt-BR", "en", "x-default"]) {
          await expect(
            page.locator(`link[rel="alternate"][hreflang="${tag}"]`),
          ).toHaveCount(1);
        }
      });

      test("declares the right document language", async ({ page }) => {
        // The one thing `+html.tsx` cannot do on its own — see
        // scripts/localize-export.ts.
        await expect(page.locator("html")).toHaveAttribute(
          "lang",
          locale === "pt" ? "pt-BR" : "en",
        );
      });

      test("the language switch crosses to the same page in the other locale", async ({
        page,
      }) => {
        await page
          .getByTestId("legal-language-switch")
          .getByTestId(`locale-${other}`)
          .click();
        await expect(page).toHaveURL(new RegExp(`/${other}${page_}`));
        await expect(page.getByTestId("legal.content.container")).toBeVisible();
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

      test("the home link returns to this locale's landing page", async ({ page }) => {
        await page.getByTestId("legal-home-link").click();
        await expect(page).toHaveURL(new RegExp(`/${locale}/?$`));
        await expect(page.getByTestId("landing-hero")).toBeVisible();
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
}
