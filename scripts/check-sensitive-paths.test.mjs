import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./check-sensitive-paths.mjs";

test("blocks on common sensitive paths, default pattern", () => {
  for (const file of [
    "server/migrations/0007_add_users.sql",
    "server/_core/schema.ts",
    "server/routes/stripe-webhook.ts",
    ".env.production",
    "server/_core/index.ts",
    "server/lib/secrets.ts",
    "server/middleware/auth.ts", // the original pattern omitted "auth" entirely despite claiming to cover it
    ".github/workflows/auto-merge-guard.yml", // modifying the guard itself must trip the guard
  ]) {
    const result = evaluate(undefined, [file]);
    assert.equal(result.block, true, `expected a block for ${file}`);
  }
});

test("passes on unrelated files", () => {
  const result = evaluate(undefined, ["tests/_helpers/selectors.ts", "README.md", "tests/landing-page-loads.spec.ts"]);
  assert.equal(result.block, false);
});

test("empty diff (no-op PR) passes, not an error", () => {
  const result = evaluate(undefined, []);
  assert.equal(result.block, false);
});

test("a custom pattern that is invalid regex syntax fails CLOSED, not open", () => {
  // Unbalanced paren — this exact style of hand-written mistake is what a
  // grep -E invocation could silently swallow as "matches nothing" instead
  // of erroring; here it must be treated as a block regardless of the file list.
  const result = evaluate("stripe|payment(", ["totally-unrelated-file.md"]);
  assert.equal(result.block, true);
  assert.match(result.reason, /not a valid pattern/);
});

test("a valid custom pattern overrides the default", () => {
  const result = evaluate("only-this-exact-thing", ["server/lib/secrets.ts"]);
  assert.equal(result.block, false, "the default pattern's secrets match should not apply once overridden");

  const result2 = evaluate("only-this-exact-thing", ["config/only-this-exact-thing.json"]);
  assert.equal(result2.block, true);
});

test("non-ASCII filenames are matched correctly (JS RegExp is unicode-aware, unlike a locale-dependent grep -E)", () => {
  const result = evaluate(undefined, ["server/migrations/007_gebruikersnaam_wijzigen.sql"]);
  assert.equal(result.block, true);
});

test("matching is case-insensitive", () => {
  const result = evaluate(undefined, ["STRIPE_WEBHOOK.TS"]);
  assert.equal(result.block, true);
});
