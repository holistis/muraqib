/**
 * Matches the "auth" flow in muraqib.config.ts: a login flow test, user
 * lands on the dashboard after signing in. Marked critical in the config
 * on purpose, a broken login is the fastest way to lose every user at
 * once, and the kind of regression a deploy can introduce without anyone
 * noticing until a customer complains.
 *
 * This needs a test account that exists on every environment this runs
 * against. Do not use a real user's credentials. Store them as GitHub
 * secrets (e.g. QA_TEST_EMAIL, QA_TEST_PASSWORD), never hardcoded here.
 */

import { test, expect } from "@playwright/test";

test.describe("auth", () => {
  test("login page is reachable", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.locator("input[type=email]")).toBeVisible();
  });

  test("a real user can sign in and land on the dashboard", async ({ page }) => {
    const email = process.env.QA_TEST_EMAIL;
    const password = process.env.QA_TEST_PASSWORD;
    test.skip(!email || !password, "Set QA_TEST_EMAIL and QA_TEST_PASSWORD as GitHub secrets to enable this test.");

    await page.goto("/sign-in");
    // TODO: replace these selectors with your own. data-testid is preferred
    // (see muraqib.config.ts selectors.preferTestId), a plain input[type]
    // selector is the fallback used here so this test runs out of the box.
    await page.locator("input[type=email]").fill(email!);
    await page.locator("input[type=password]").fill(password!);
    await page.getByRole("button", { name: /sign in|log in/i }).click();

    // TODO: replace with whatever actually proves a successful login on
    // your app, a URL change, a visible username, a dashboard heading.
    await expect(page).toHaveURL(/dashboard|app|home/);
  });
});
