import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, parsePaginatedArrayOutput, extractCheckablePaths } from "./check-sensitive-paths.mjs";

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

test("a bare secrets/ directory is flagged, not just secrets.* files", () => {
  // The original pattern (secrets?[._-]) required "secrets" to be followed
  // immediately by ".", "_" or "-" — a plain directory boundary ("/") slid
  // through undetected. Verified against the real API shape before fixing.
  for (const file of ["k8s/secrets/prod.yaml", "infra/secrets/README.md", "secrets/api-key.txt"]) {
    assert.equal(evaluate(undefined, [file]).block, true, `expected a block for ${file}`);
  }
});

test("parsePaginatedArrayOutput: single-page gh --paginate output (the normal case)", () => {
  const raw = JSON.stringify([{ filename: "a.ts" }, { filename: "b.ts" }]);
  assert.deepEqual(parsePaginatedArrayOutput(raw), [{ filename: "a.ts" }, { filename: "b.ts" }]);
});

test("parsePaginatedArrayOutput: defensively flattens an array-of-page-arrays, in case a future gh version ever emits one", () => {
  // This is the shape that a `--jq` filter applied per-page used to produce
  // (each page's filtered result is valid JSON on its own, but the
  // concatenation of several isn't) — the fix removes --jq entirely, but
  // this defensive flatten means a similarly-shaped response from any
  // other source still parses instead of throwing.
  const raw = JSON.stringify([[{ filename: "a.ts" }], [{ filename: "b.ts" }]]);
  assert.deepEqual(parsePaginatedArrayOutput(raw), [{ filename: "a.ts" }, { filename: "b.ts" }]);
});

test("parsePaginatedArrayOutput throws (not silently returns []) on genuinely malformed JSON", () => {
  // A crash here still exits main() non-zero, which — on a repo that has
  // correctly configured this guard as a required status check — still
  // blocks the merge as a failed check, just without a clear reason. Not
  // ideal, but not a silent fail-open either. Documented, not hidden.
  assert.throws(() => parsePaginatedArrayOutput("[{ not valid json"));
});

test("extractCheckablePaths includes a renamed file's OLD path, not just its new one", () => {
  const prFiles = [
    { filename: "server/lib/config.ts", previous_filename: "server/lib/secrets.ts", status: "renamed" },
    { filename: "README.md" },
  ];
  const paths = extractCheckablePaths(prFiles);
  assert.ok(paths.includes("server/lib/config.ts"));
  assert.ok(paths.includes("server/lib/secrets.ts"), "a rename with no content change must still be checked under its old, possibly-sensitive name");
  assert.ok(paths.includes("README.md"));
});

test("end to end: a large (multi-page-shaped), partly-renamed file list is still evaluated correctly", () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `tests/spec-${i}.ts` }));
  const page2 = [
    { filename: "server/lib/config.ts", previous_filename: "server/lib/secrets.ts" },
    ...Array.from({ length: 50 }, (_, i) => ({ filename: `tests/spec-${100 + i}.ts` })),
  ];
  const raw = JSON.stringify([page1, page2]); // simulates the multi-page-array shape defensively handled above
  const prFiles = parsePaginatedArrayOutput(raw);
  assert.equal(prFiles.length, 151);
  const paths = extractCheckablePaths(prFiles);
  const result = evaluate(undefined, paths);
  assert.equal(result.block, true, "the renamed-from secrets.ts path must still trip the guard even 151 files into the list");
});
