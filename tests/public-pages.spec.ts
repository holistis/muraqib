/**
 * Matches the "public-pages" flow in muraqib.config.ts: a smoke check that
 * public routes return real content, not a 404, a 500, or a page with a
 * silently broken price. Adapt the routes and selectors below to your app,
 * the pattern (goto, check title, check for obviously-wrong text) is the
 * part worth keeping.
 */

import { test, expect } from "@playwright/test";

test.describe("public-pages", () => {
  test("homepage loads without errors", async ({ page }) => {
    await page.goto("/");
    await expect(page).not.toHaveTitle(/error|404|not found/i);
    await expect(page.locator("h1")).toBeVisible();
  });

  test("pricing page shows real prices, not a broken template", async ({ page }) => {
    await page.goto("/pricing");
    // A silently broken price template is the exact kind of regression that
    // never crashes anything and never gets caught by "does it load".
    const body = await page.textContent("body");
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("NaN");
  });

  // TODO: add one test per public route that actually matters to you (an
  // /about page, a /docs page, whatever a broken link there would embarrass
  // you for). Copy the homepage test above and change the path and the
  // thing you check for.
});
