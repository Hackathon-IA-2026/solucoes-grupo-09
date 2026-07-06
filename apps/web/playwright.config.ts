import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the real exported bundle (dist/) and a scripted mock API on the
 * dev API's default port. Run `bun run export` first (or let CI do it).
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
      command: "MOCK_API_PORT=3210 bun e2e/mock-api.ts",
      url: "http://localhost:3210/health",
      reuseExistingServer: false,
    },
    {
      command: "bun e2e/serve-dist.ts",
      url: "http://localhost:4173",
      reuseExistingServer: false,
    },
  ],
});
