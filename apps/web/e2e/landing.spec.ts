import { expect, test } from "@playwright/test";

const PLAY_URL = "https://play.google.com/store/apps/details?id=com.spotify.music";

test.describe("landing page", () => {
  test("renders SEO content and the scrape card", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Noviq — Scrape App Store & Google Play reviews/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Every app review",
    );
    await expect(page.getByTestId("scrape-button")).toBeVisible();
    // Structured data ships in the static HTML.
    const jsonLd = page.locator('script[type="application/ld+json"]');
    // One script per schema: WebApplication + FAQPage.
    await expect(jsonLd).toHaveCount(2);
  });

  test("FAQ is keyboard-operable", async ({ page }) => {
    await page.goto("/");
    const question = page
      .getByRole("button")
      .filter({ hasText: "Is this legal?" })
      .first();
    await question.scrollIntoViewIfNeeded();
    await question.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/public store pages anyone can open/)).toBeVisible();
  });

  test("social/OG tags including the share image are prerendered", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      /og\.png$/,
    );
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
      "content",
      /og\.png$/,
    );
    // The referenced assets actually ship in the export.
    for (const path of ["/og.png", "/robots.txt", "/sitemap.xml", "/favicon.ico"]) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
    }
  });

  test("marketing sections are present and FAQ expands", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("From link to dataset in three steps")).toBeVisible();
    await expect(
      page.getByText("Built for people who live in review data"),
    ).toBeVisible();
    const question = page.getByText("Is this legal?", { exact: true });
    await question.scrollIntoViewIfNeeded();
    await question.click();
    await expect(page.getByText(/public store pages anyone can open/)).toBeVisible();
  });
});

test.describe("input validation", () => {
  test("gibberish gets a specific error once typing settles", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill("definitely not an app link");
    await expect(page.getByTestId("input-error")).toContainText("couldn't recognize", {
      timeout: 3_000,
    });
  });

  test("a store URL missing its id gets targeted guidance", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill("https://apps.apple.com/us/app/instagram");
    await expect(page.getByTestId("input-error")).toContainText("missing the app id", {
      timeout: 3_000,
    });
  });

  test("submitting empty input prompts for a link", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("scrape-button").click();
    await expect(page.getByTestId("input-error")).toContainText("Paste an App Store");
  });

  test("a valid link shows the detected store and app preview", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill(PLAY_URL);
    await expect(page.getByText("Google Play", { exact: true })).toBeVisible();
    await expect(page.getByTestId("app-preview")).toContainText("Spotify", {
      timeout: 5_000,
    });
  });
});

test.describe("scrape flow", () => {
  test("happy path: progress states, results, export, reset", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill(PLAY_URL);
    await page.getByTestId("scrape-button").click();

    // Visible system status while the job runs.
    await expect(page.getByTestId("progress-panel")).toBeVisible();
    await expect(page.getByTestId("progress-panel")).toContainText("com.spotify.music");

    // Results arrive after the scripted waiting → active → completed polls.
    await expect(page.getByTestId("results-panel")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("results-panel")).toContainText("3 reviews scraped");
    await expect(
      page.getByText("Love the playlists, hate the shuffle. Five stars anyway."),
    ).toBeVisible();
    await expect(page.getByText("Developer response · May 29, 2026")).toBeVisible();

    // CSV export triggers a real browser download with the right name…
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-csv").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("noviq-reviews-com.spotify.music-us.csv");
    // …and a visible success confirmation (micro-interaction feedback).
    await expect(page.getByTestId("export-toast")).toContainText(
      "Saved noviq-reviews-com.spotify.music-us.csv",
    );

    // Reset returns to a fresh scrape card.
    await page.getByTestId("new-scrape").click();
    await expect(page.getByTestId("scrape-card")).toBeVisible();
    await expect(page.getByTestId("url-input")).toHaveValue("");
  });

  test("cancel returns to the form", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill(PLAY_URL);
    await page.getByTestId("scrape-button").click();
    await expect(page.getByTestId("progress-panel")).toBeVisible();
    await page.getByTestId("cancel-button").click();
    await expect(page.getByTestId("scrape-card")).toBeVisible();
  });

  test("a rejected submit surfaces the API error", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill("com.e2e.reject");
    await page.getByTestId("scrape-button").click();
    await expect(page.getByTestId("error-banner")).toContainText(
      "rejected by the store",
      {
        timeout: 10_000,
      },
    );
    // Dismiss recovers to the form.
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("scrape-card")).toBeVisible();
  });

  test("a failed job surfaces the job error", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill("com.e2e.fail");
    await page.getByTestId("scrape-button").click();
    await expect(page.getByTestId("error-banner")).toContainText("blocked this scrape", {
      timeout: 15_000,
    });
  });
});
