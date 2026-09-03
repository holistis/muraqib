/**
 * Playwright config, reads from muraqib.config.ts, no changes needed here.
 */

import { defineConfig, devices } from "@playwright/test";
import qaConfig from "./muraqib.config";

/**
 * How long the whole run may take before Playwright stops itself.
 *
 * This exists because of a specific failure mode. The nightly job carries a
 * runner-level `timeout-minutes`. That is a hard kill: the process is stopped
 * mid-test, Playwright writes no report, GitHub records the run as "cancelled"
 * rather than "failure", and every downstream step is skipped because they all
 * key off the tests step reporting failure. No fix PR, no failing job, no
 * email. The guardian goes quiet exactly when it has something to say, and
 * stays quiet every night after that.
 *
 * globalTimeout makes Playwright stop itself first. It exits non-zero, the
 * reporters still write results.json, and the whole downstream chain fires
 * normally, so a suite that got too slow reads as a loud failure instead of
 * silence.
 *
 * It MUST stay below the job's timeout-minutes in muraqib-nightly.yml, with
 * enough room left for the install and upload steps around it.
 * scripts/check-timeout-budget.mjs fails the build if that ever drifts.
 */
const GLOBAL_TIMEOUT_MINUTES = Number(process.env.MURAQIB_GLOBAL_TIMEOUT_MIN ?? 35);

/**
 * The value muraqib.config.ts ships with. If it is still here, nothing has been
 * pointed at a real app yet.
 *
 * Left alone, a run against this placeholder fails with DNS and navigation
 * errors that say nothing about the actual problem, and someone new reasonably
 * reads that as "the tool is broken" rather than "I have not finished setup".
 * Worse, it is a red nightly from day one, and a check that is red from day one
 * is furniture before it has ever been useful.
 *
 * Failing here instead, with the reason, keeps that loud and correct. Not
 * skipping: an unconfigured monitor is not a passing monitor.
 */
const PLACEHOLDER_BASE_URL = "https://your-app.com";
if (qaConfig.baseUrl === PLACEHOLDER_BASE_URL) {
  throw new Error(
    `muraqib.config.ts still points baseUrl at ${PLACEHOLDER_BASE_URL}. Set it to your live app, or set QA_BASE_URL in the environment. Until then nothing is being checked, and this fails rather than passing so that stays obvious.`
  );
}

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
  globalTimeout: GLOBAL_TIMEOUT_MINUTES * 60 * 1000,
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
});
