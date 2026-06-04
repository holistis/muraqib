/**
 * Example test — replace with tests for your own app.
 *
 * Naming convention: one file per flow, matching the flow name in muraqib.config.ts.
 * Use data-testid attributes where possible (stable under refactors).
 */

import { test, expect } from "@playwright/test";

test.describe("public-pages", () => {
  test("homepage loads without errors", async ({ page }) => {
    await page.goto("/");
    await expect(page).not.toHaveTitle(/error|404|not found/i);
    await expect(page.locator("h1")).toBeVisible();
  });

  test("pricing page shows prices", async ({ page }) => {
    await page.goto("/pricing");
    // Make sure no price shows as undefined or NaN
    const body = await page.textContent("body");
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("NaN");
  });
});

test.describe("auth", () => {
  test("login page is reachable", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.locator("input[type=email]")).toBeVisible();
  });
});
