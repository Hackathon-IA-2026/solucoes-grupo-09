import { expect, test } from "@playwright/test";

/**
 * The entry experience, against the real exported `dist/`.
 *
 * The unit suite (`test/entry-screen.test.ts`) reads source. This reads what a
 * browser actually receives, which is the only place three of these claims can
 * be checked at all: that the chooser is gone from the shipped HTML, that the
 * redirect fires before hydration, and that the stored choice beats the
 * browser's own language.
 */

test.describe("the loading screen at /", () => {
  test("ships the brand, the subtitle, and no language chooser", async ({ page }) => {
    // The redirect fires before hydration, so read the HTML the server sends
    // rather than the page it turns into.
    const html = await (await page.request.get("/")).text();

    expect(html).toContain("WattSteer");
    // Portuguese, because nothing has been chosen and nothing was asked.
    expect(html).toContain(
      "Inteligência de curtailment para a rede elétrica brasileira.",
    );
    // The chooser listed both taglines and a link per locale. Its two tells:
    expect(html).not.toContain("Curtailment intelligence for the Brazilian grid.");
    expect(html).not.toContain("Português (Brasil)");
    expect(html).not.toContain('href="/en/"');

    expect(html).toMatch(/name="robots"\s+content="noindex,follow"/);
    // Crawl equity still reaches English — through the alternates, not a link.
    expect(html).toContain('hreflang="x-default" href="https://wattsteer.com/pt/"');
    expect(html).toContain('href="https://wattsteer.com/en/"');
  });

  test("the no-JS way out is in the HTML, hidden, and one link", async ({ page }) => {
    const html = await (await page.request.get("/")).text();
    expect(html).toContain("data-noscript-only");
    expect(html).toContain("[data-noscript-only]{display:flex!important}");
    expect(html).toContain('href="/pt/"');
    // One link, not two: a chooser reintroduced by the back door is still a
    // chooser.
    expect((html.match(/href="\/(pt|en)\//g) ?? []).length).toBe(1);
  });

  test("sends a visitor who has never chosen to Portuguese", async ({ browser }) => {
    // A browser that asks for neither of our locales. Playwright's default
    // context is `en-US`, which would have made this test assert the English
    // branch while claiming to test the default — so the locale is stated.
    const context = await browser.newContext({ locale: "de-DE" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/pt\/$/);
    await expect(page.getByTestId("landing-hero")).toBeVisible();
    await context.close();
  });

  test("sends an English browser to /pt/ too, and that is the decision", async ({
    browser,
  }) => {
    /*
      This asserted `/en/` and had been failing for as long as the decision it
      contradicts has been in force. `+html.tsx` states it in the redirect's own
      comment: *"the reader's own languages are deliberately not consulted — a
      Brazilian product defaults to Portuguese"*. `navigator.languages` was
      removed on purpose; the only thing that carries a reader to English is
      having chosen it, which `language-switch.tsx` writes to
      `wattsteer.locale` and the next test covers.

      Kept rather than deleted, and inverted rather than loosened: the claim
      worth making is that the default is *insensitive* to the browser's
      locale, and an `en-US` context is the sharpest way to make it. A test
      deleted here would have left nothing asserting that at all.
    */
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/pt\/$/);
    await context.close();
  });

  test("a stored choice outranks the default, whatever the browser says", async ({
    browser,
  }) => {
    // The other half, and the reason the default can be this blunt: a reader
    // who switched to English is carried by their own choice, not by a guess
    // about their browser.
    const context = await browser.newContext({ locale: "pt-BR" });
    const page = await context.newPage();
    await page.goto("/pt/");
    await page.evaluate(() => localStorage.setItem("wattsteer.locale", "en"));
    await page.goto("/");
    await expect(page).toHaveURL(/\/en\/$/);
    await context.close();
  });

  test("never shows the reader a chooser on the way", async ({ page }) => {
    // The redirect is in `<head>`, before the bundle loads. If it had been
    // left to the route's effect, `domcontentloaded` would land on `/` and
    // this would see the loading screen instead of the landing page.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/(pt|en)\/$/);
  });

  test("replaces rather than pushes, so Back does not trap", async ({ browser }) => {
    const context = await browser.newContext({ locale: "de-DE" });
    const page = await context.newPage();
    await page.goto("/pt/terms");
    await page.goto("/");
    await expect(page).toHaveURL(/\/pt\/$/);
    await page.goBack();
    // Pushed, Back would land on `/` and be bounced forward again — the
    // visitor could not leave.
    await expect(page).toHaveURL(/\/pt\/terms/);
    await context.close();
  });

  test("robots.txt still allows /", async ({ page }) => {
    const robots = await (await page.request.get("/robots.txt")).text();
    expect(robots).toContain("Allow: /");
    // Anchored, because the file's own comment explains *why* there is no
    // `Disallow` and therefore contains the word.
    expect(robots).not.toMatch(/^Disallow:/m);
  });
});

test.describe("a chosen language persists", () => {
  test("a stored choice beats the browser's own language", async ({ browser }) => {
    const context = await browser.newContext({ locale: "pt-BR" });
    const page = await context.newPage();
    await page.goto("/en/");
    // Switch to English the way a reader does, then come back to `/`.
    await page.getByTestId("nav-language-switch").getByTestId("locale-en").click();
    await page.goto("/");
    await expect(page).toHaveURL(/\/en\/$/);
    await context.close();
  });

  test("the wordmark keeps an English reader in English", async ({ browser }) => {
    const context = await browser.newContext({ locale: "pt-BR" });
    const page = await context.newPage();
    await page.goto("/en/terms");
    await page.getByTestId("legal-home-link").click();
    await expect(page).toHaveURL(/\/en\/?$/);
    // …and from the landing page's own wordmark, which is the click the
    // brief named. It must not round-trip through `/`.
    await page.getByTestId("nav-home-link").click();
    await expect(page).toHaveURL(/\/en\/?$/);
    await context.close();
  });

  test("the /app chrome returns to the locale it is being read in", async ({
    browser,
  }) => {
    const context = await browser.newContext({ locale: "pt-BR" });
    const page = await context.newPage();
    await page.goto("/en/");
    await page.getByTestId("nav-language-switch").getByTestId("locale-en").click();
    await page.goto("/app");
    await page.getByTestId("app-home-link").click();
    await expect(page).toHaveURL(/\/en\/?$/);
    await context.close();
  });
});
