/**
 * Matches the "checkout" flow in muraqib.config.ts: pricing page loads, the
 * call-to-action is visible, no undefined/NaN prices. Marked critical on
 * purpose, this is the flow where a silent bug costs actual revenue, not
 * just a bad user experience.
 *
 * This file deliberately starts small (a pricing-page sanity check you get
 * for free) rather than a full payment flow, because a full checkout test
 * needs decisions only you can make: which test card, which environment,
 * whether to actually submit a payment (never against production). The
 * template below shows the shape, uncomment and adapt it once you've made
 * those decisions, do not run it against a real payment provider in
 * production without a dedicated test mode.
 */

import { test, expect } from "@playwright/test";

test.describe("checkout", () => {
  test("pricing page loads with a visible call to action", async ({ page }) => {
    await page.goto("/pricing");
    const body = await page.textContent("body");
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("NaN");
    // TODO: replace this selector with your actual CTA (data-testid preferred).
    await expect(page.getByRole("button", { name: /subscribe|buy|get started/i }).first()).toBeVisible();
  });

  // TODO: uncomment and adapt once you've decided on a test-mode payment
  // provider and a dedicated test environment, never production.
  //
  // test("a test user can complete checkout with a test card", async ({ page }) => {
  //   test.skip(!process.env.QA_STRIPE_TEST_MODE, "Requires a payment provider in test mode.");
  //   await page.goto("/pricing");
  //   await page.getByRole("button", { name: /subscribe|buy|get started/i }).first().click();
  //   // Fill in your provider's test-card fields here, e.g. Stripe's
  //   // documented test card number 4242 4242 4242 4242.
  //   await expect(page).toHaveURL(/success|thank-you|confirmation/);
  // });
});
