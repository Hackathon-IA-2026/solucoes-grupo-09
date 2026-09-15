import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the real exported bundle (`dist/`). Run `bun run export` first
 * (or let `bun run test:e2e` do it).
 *
 * A second `webServer` entry used to start `e2e/mock-api.ts` on the dev API's
 * port. That file is not in the tree — it went with the rebrand commit — so
 * every run of this config died with `Module not found` before a single test
 * executed, which is how a suite stops being a guard without anyone noticing.
 * Removed rather than restored: neither spec here calls the backend (the legal
 * pages and the entry screen are static), so there is nothing for a mock to
 * answer. A spec that needs one should bring its own server back with it.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "bun e2e/serve-dist.ts",
      url: "http://localhost:4173",
      reuseExistingServer: false,
    },
  ],
});
