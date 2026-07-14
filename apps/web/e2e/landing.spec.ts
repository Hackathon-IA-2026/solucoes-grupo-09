import { expect, test } from "@playwright/test";

const PLAY_URL = "https://play.google.com/store/apps/details?id=com.spotify.music";

// Point the built bundle at the mock API (runtime override — the bundle's
// build-time EXPO_PUBLIC_API_URL must never be trusted by tests).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { __ZALYTIX_API_URL__?: string }).__ZALYTIX_API_URL__ =
      "http://localhost:3210";
  });
});

test.describe("hero", () => {
  test("renders SEO content and the scrape capsule", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Review Scraper — Free CSV Export \| Zalytix/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Turn any app's reviews into",
    );
    await expect(page.getByTestId("scrape-button")).toBeVisible();
    await expect(page.getByTestId("hero-logo")).toBeVisible();
    // Above-the-fold product preview: floating mini charts flank the hero on
    // wide screens (desktop project is 1280px; hidden on mobile).
    if ((page.viewportSize()?.width ?? 0) >= 1240) {
      await expect(page.getByTestId("hero-widgets")).toBeVisible();
      await expect(
        page.getByTestId("hero-widgets").getByText("Review volume"),
      ).toBeVisible();
      await expect(
        page.getByTestId("hero-widgets").getByText("Average rating"),
      ).toBeVisible();
    }
    const jsonLd = page.locator('script[type="application/ld+json"]');
    // WebApplication + Organization + WebSite, one object per script.
    await expect(jsonLd).toHaveCount(3);
  });

  test("social/OG tags and static assets ship", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      /og\.png$/,
    );
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
      "content",
      /og\.png$/,
    );
    for (const path of ["/og.png", "/robots.txt", "/sitemap.xml", "/favicon.ico"]) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
    }
  });

  test("showcase renders interactive dashboard components on sample data", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("showcase")).toContainText("Every scrape ends in");
    await expect(page.getByText("Live preview · sample data")).toBeVisible();
    // Real components, real interactivity: heatmap + timeline render sample analytics.
    await expect(page.getByTestId("showcase")).toContainText("When reviews land");
    await expect(page.getByTestId("showcase")).toContainText("Review volume");
    await expect(page.getByTestId("showcase")).toContainText("reviews analyzed");
    // The footer CTA scrolls back to the input.
    await page.getByTestId("footer-cta-button").click();
    await expect(page.getByTestId("url-input")).toBeInViewport({ timeout: 5000 });
  });

  test("sample chips fill the input", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Use Google Play sample link" }).click();
    await expect(page.getByTestId("url-input")).toHaveValue(PLAY_URL);
  });
});

test.describe("input validation", () => {
  test("gibberish gets a specific error once typing settles", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill("definitely not an app link");
    await expect(page.getByTestId("input-error")).toContainText("couldn't recognize", {
      timeout: 3000,
    });
  });

  test("a store URL missing its id gets targeted guidance", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill("https://apps.apple.com/us/app/instagram");
    await expect(page.getByTestId("input-error")).toContainText("missing the app id", {
      timeout: 3000,
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
    // The detected-store chip (distinct from the "Google Play" sample button).
    await expect(page.getByLabel("Google Play", { exact: true })).toBeVisible();
    await expect(page.getByTestId("app-preview")).toContainText("Spotify", {
      timeout: 5000,
    });
  });
});

test.describe("scrape flow", () => {
  test("happy path: live progress, dashboard, export, reset", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill(PLAY_URL);
    await page.getByTestId("scrape-button").click();

    // Live status under the capsule while the job runs.
    await expect(page.getByTestId("scrape-progress")).toBeVisible();
    // Determinate progress once the backend reports counts.
    await expect(page.getByTestId("scrape-progress")).toContainText("of 100 reviews", {
      timeout: 10_000,
    });

    // The dashboard replaces the hero on completion.
    await expect(page.getByTestId("results-panel")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("results-panel")).toContainText(
      "Spotify: Music and Podcasts",
    );
    await expect(page.getByTestId("results-panel")).toContainText("Scraped results for");
    await expect(page.getByTestId("results-panel")).toContainText("Scraped reviews");
    await expect(page.getByTestId("results-panel")).toContainText("3 of 3 shown");

    // Crawled store-wide metadata renders in the identity line + breakdown.
    await expect(page.getByTestId("results-panel")).toContainText(
      "1,000,000,000+ installs",
    );
    await expect(page.getByText(/store-wide distribution marker/)).toBeVisible();
    // Google reviewer avatar (crawled) replaces the initials circle.
    await expect(page.getByTestId("review-avatar").first()).toBeVisible();

    // The redesigned analytics blocks render from the real reviews.
    await expect(page.getByTestId("timeline-panel")).toContainText("Review volume");
    await expect(page.getByTestId("heatmap-panel")).toContainText("When reviews land");
    await expect(page.getByTestId("sentiment-panel")).toContainText("reviews analyzed");
    await expect(page.getByText("% love it")).toBeVisible();
    await expect(
      page.getByText("Love the playlists, hate the shuffle. Five stars anyway."),
    ).toBeVisible();
    await expect(page.getByText("3 reviews processed")).toBeVisible();

    // CSV export triggers a real download with the right name…
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-csv").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("zalytix-reviews-com.spotify.music-us.csv");
    // …and a visible success confirmation.
    await expect(page.getByTestId("export-toast")).toContainText(
      "Saved zalytix-reviews-com.spotify.music-us.csv",
    );

    // The centered header logo links back home.
    await expect(page.getByTestId("nav-home")).toBeVisible();

    // Reset returns to a fresh hero.
    await page.getByTestId("new-scrape").click();
    await expect(page.getByTestId("scrape-button")).toBeVisible();
    await expect(page.getByTestId("url-input")).toHaveValue("");
  });

  test("the header logo returns to the hero", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill(PLAY_URL);
    await page.getByTestId("scrape-button").click();
    await expect(page.getByTestId("results-panel")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("nav-home").click();
    await expect(page.getByTestId("scrape-button")).toBeVisible();
    await expect(page.getByTestId("hero-logo")).toBeVisible();
  });

  test("view pills filter the dashboard sections", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill(PLAY_URL);
    await page.getByTestId("scrape-button").click();
    await expect(page.getByTestId("results-panel")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("view-reviews").click();
    await expect(page.getByTestId("timeline-panel")).not.toBeVisible();
    await expect(page.getByTestId("results-panel")).toContainText("Scraped reviews");

    await page.getByTestId("view-trends").click();
    await expect(page.getByTestId("timeline-panel")).toBeVisible();
    await expect(page.getByTestId("results-panel")).not.toContainText("Scraped reviews");

    await page.getByTestId("view-all").click();
    await expect(page.getByTestId("timeline-panel")).toBeVisible();
    await expect(page.getByTestId("results-panel")).toContainText("Scraped reviews");
  });

  test("timeline range toggle and heatmap dimension toggle work", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill(PLAY_URL);
    await page.getByTestId("scrape-button").click();
    await expect(page.getByTestId("results-panel")).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId("timeline-panel")).toContainText("Last 12 months");
    await page.getByRole("radio", { name: "Monthly" }).click();
    await expect(page.getByTestId("timeline-panel")).toContainText("Last 6 months");

    await expect(page.getByTestId("heatmap-panel")).toContainText("Reviews");
    await page
      .getByTestId("heatmap-panel")
      .getByRole("button", { name: "Reviews" })
      .click();
    await expect(page.getByTestId("heatmap-panel")).toContainText("Ratings");
  });

  test("review feed filters work", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill(PLAY_URL);
    await page.getByTestId("scrape-button").click();
    await expect(page.getByTestId("results-panel")).toBeVisible({ timeout: 15_000 });

    // Filter to replied-only: exactly one mock review has a dev response.
    await page.getByRole("radio", { name: "Filter Replied" }).click();
    await expect(page.getByTestId("results-panel")).toContainText("1 of 3 shown");
    await expect(page.getByText("Thanks for the report — fixed in 9.0.1!")).toBeVisible();

    // Search narrows further.
    await page.getByRole("radio", { name: "Filter All" }).click();
    await page.getByLabel("Search reviews").fill("offline");
    await expect(page.getByTestId("results-panel")).toContainText("1 of 3 shown");
  });

  test("cancel returns to the idle hero", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill(PLAY_URL);
    await page.getByTestId("scrape-button").click();
    await expect(page.getByTestId("scrape-progress")).toBeVisible();
    await page.getByTestId("cancel-button").click();
    await expect(page.getByTestId("scrape-progress")).not.toBeVisible();
    await expect(page.getByTestId("scrape-button")).toBeVisible();
  });

  test("a rejected submit surfaces the API error", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("url-input").fill("com.e2e.reject");
    await page.getByTestId("scrape-button").click();
    await expect(page.getByTestId("error-banner")).toContainText(
      "rejected by the store",
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("error-banner")).not.toBeVisible();
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
