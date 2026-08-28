import { test } from "node:test";
import assert from "node:assert/strict";

// Kept in sync by hand with the default pattern in auto-merge-guard.yml —
// there's no shared-source-of-truth mechanism between bash and this test,
// so if you change one, change the other and re-run this file.
const DEFAULT_PATTERN = new RegExp(
  "(^|/)(migrations?|schema)(/|\\.)|stripe|payment|billing|\\.env($|\\.)|secrets?[._-]|_core/index\\.ts",
  "i"
);

function matches(path) {
  return DEFAULT_PATTERN.test(path);
}

test("flags common sensitive paths", () => {
  for (const path of [
    "server/migrations/0007_add_users.sql",
    "server/_core/schema.ts",
    "server/routes/stripe-webhook.ts",
    ".env.production",
    "server/_core/index.ts",
    "server/lib/secrets.ts",
    "SECRETS.md", // case-insensitive on purpose — a "secrets" match shouldn't depend on casing
  ]) {
    assert.equal(matches(path), true, `expected a match for ${path}`);
  }
});

test("does not flag unrelated files", () => {
  for (const path of ["tests/_helpers/selectors.ts", "README.md", "tests/auth.spec.ts", "lib/alerts.ts"]) {
    assert.equal(matches(path), false, `expected no match for ${path}`);
  }
});

test("known trade-off: a harmless file merely named after a sensitive topic still matches, on purpose", () => {
  // tests/payment-flow.spec.ts has nothing to do with real payment code, but
  // the guard can't tell that from a filename alone. It matches anyway,
  // which just means "wait for manual review" — a false positive here costs
  // a few minutes of review, not a broken build, so the guard is tuned to
  // over-flag rather than risk missing a real payment/auth change.
  assert.equal(matches("tests/payment-flow.spec.ts"), true);
  assert.equal(matches("content/pricing-and-billing.md"), true);
});
