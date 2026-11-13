import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "bin", "muraqib.mjs");
const TITLE = "The machine under the nightly can change without you choosing it";

const nightly = runsOn => `name: Muraqib Nightly
on:
  schedule:
    - cron: "0 2 * * *"
jobs:
  test:
    runs-on: ${runsOn}
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
`;

const WATCHDOG = `name: Muraqib Watchdog
on: workflow_dispatch
jobs:
  heartbeat:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;

const CONFIG = `const GLOBAL_TIMEOUT_MINUTES = Number(process.env.MURAQIB_GLOBAL_TIMEOUT_MIN ?? 35);
export default { globalTimeout: GLOBAL_TIMEOUT_MINUTES * 60 * 1000 };
`;

function doctorIn(files) {
  const dir = mkdtempSync(join(tmpdir(), "muraqib-doctor-"));
  try {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return spawnSync(process.execPath, [CLI, "doctor"], { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const repo = runsOn => ({
  ".github/workflows/muraqib-nightly.yml": nightly(runsOn),
  ".github/workflows/muraqib-watchdog.yml": WATCHDOG,
  "playwright.config.ts": CONFIG,
});

test("doctor reports a nightly that installs browsers on ubuntu-latest, and exits non-zero", () => {
  const result = doctorIn(repo("ubuntu-latest"));
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stdout.includes(`PROBLEM  ${TITLE}`), result.stdout);
  assert.ok(result.stdout.includes("ubuntu-latest"), result.stdout);
});

test("doctor is quiet about the runner once it is pinned, and says so", () => {
  const result = doctorIn(repo("ubuntu-24.04"));
  assert.ok(!result.stdout.includes(TITLE), result.stdout);
  assert.ok(result.stdout.includes("OK       Every browser install this check could see runs on a pinned runner"), result.stdout);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("doctor does not claim a pinned runner when it could not read one", () => {
  const result = doctorIn(repo("${{ inputs.runner }}"));
  assert.ok(result.stdout.includes(`PROBLEM  ${TITLE}`), result.stdout);
  assert.ok(!result.stdout.includes("OK       Every browser install this check could see runs on a pinned runner"), result.stdout);
});
