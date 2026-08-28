/**
 * Playwright config, reads from muraqib.config.ts, no changes needed here.
 */

import { defineConfig, devices } from "@playwright/test";
import qaConfig from "./muraqib.config";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
    ["list"],
  ],
  use: {
    baseURL: qaConfig.baseUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    testIdAttribute: qaConfig.selectors.testIdAttribute || "data-testid",
    userAgent: `Muraqib/${qaConfig.projectName} Playwright`,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  outputDir: "./test-results",
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
});
