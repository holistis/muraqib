import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findTimeoutBudgetProblems,
  readGlobalTimeoutMinutes,
  readJobTimeoutMinutes,
} from "./check-timeout-budget.mjs";

const workflowWithTimeout = minutes => `
name: Muraqib Nightly
on:
  schedule:
    - cron: "0 2 * * *"
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: ${minutes}
    steps:
      - uses: actions/checkout@v4
      - run: npx playwright test
`;

const WORKFLOW_WITHOUT_TIMEOUT = `
name: Muraqib Nightly
on:
  schedule:
    - cron: "0 2 * * *"
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx playwright test
`;

const configWithGlobalTimeout = minutes => `
import { defineConfig } from "@playwright/test";
const GLOBAL_TIMEOUT_MINUTES = Number(process.env.MURAQIB_GLOBAL_TIMEOUT_MIN ?? ${minutes});
export default defineConfig({
  testDir: "./tests",
  globalTimeout: GLOBAL_TIMEOUT_MINUTES * 60 * 1000,
  timeout: 60 * 1000,
});
`;

// The shape this repo actually shipped: no globalTimeout at all, so the only
// limit on the run is the runner's kill.
const CONFIG_WITHOUT_GLOBAL_TIMEOUT = `
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  fullyParallel: false,
  timeout: 60 * 1000,
});
`;

test("catches the bug that actually shipped: a job timeout with no globalTimeout behind it", () => {
  const problems = findTimeoutBudgetProblems(
    workflowWithTimeout(20),
    CONFIG_WITHOUT_GLOBAL_TIMEOUT
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /globalTimeout/);
});

test("passes when Playwright stops itself well before the runner does", () => {
  const problems = findTimeoutBudgetProblems(
    workflowWithTimeout(45),
    configWithGlobalTimeout(35)
  );
  assert.deepEqual(problems, []);
});

test("catches the two numbers in the wrong order", () => {
  const problems = findTimeoutBudgetProblems(
    workflowWithTimeout(45),
    configWithGlobalTimeout(50)
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /must be lower/);
});

test("catches equal values, where the runner still wins the race", () => {
  const problems = findTimeoutBudgetProblems(
    workflowWithTimeout(45),
    configWithGlobalTimeout(45)
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /must be lower/);
});

test("catches a gap too small for the install and upload steps around the run", () => {
  const problems = findTimeoutBudgetProblems(
    workflowWithTimeout(45),
    configWithGlobalTimeout(43)
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /At least 5 min is required/);
});

test("accepts a gap exactly at the required buffer", () => {
  const problems = findTimeoutBudgetProblems(
    workflowWithTimeout(40),
    configWithGlobalTimeout(35)
  );
  assert.deepEqual(problems, []);
});

test("a missing timeout-minutes is a problem, not a pass", () => {
  const problems = findTimeoutBudgetProblems(
    WORKFLOW_WITHOUT_TIMEOUT,
    configWithGlobalTimeout(35)
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /timeout-minutes/);
});

test("reports both sides when both are missing", () => {
  const problems = findTimeoutBudgetProblems(
    WORKFLOW_WITHOUT_TIMEOUT,
    CONFIG_WITHOUT_GLOBAL_TIMEOUT
  );
  assert.equal(problems.length, 2);
});

test("fails closed on a globalTimeout shape it cannot verify", () => {
  // A raw millisecond literal is perfectly valid Playwright, but this checker
  // cannot tie it back to a declared number of minutes. Guessing would defeat
  // the point of the check, so an unreadable shape is treated as unsafe.
  const opaque = `
    import { defineConfig } from "@playwright/test";
    export default defineConfig({ globalTimeout: 2100000 });
  `;
  assert.equal(readGlobalTimeoutMinutes(opaque), null);
  assert.equal(findTimeoutBudgetProblems(workflowWithTimeout(45), opaque).length, 1);
});

test("fails closed when globalTimeout points at a constant declared some other way", () => {
  const indirect = `
    import { defineConfig } from "@playwright/test";
    const GLOBAL_TIMEOUT_MINUTES = someHelper();
    export default defineConfig({ globalTimeout: GLOBAL_TIMEOUT_MINUTES * 60 * 1000 });
  `;
  assert.equal(readGlobalTimeoutMinutes(indirect), null);
});

test("does not confuse a similarly named constant for the one in use", () => {
  const decoy = `
    import { defineConfig } from "@playwright/test";
    const OTHER_TIMEOUT_MINUTES = Number(process.env.SOMETHING ?? 5);
    const GLOBAL_TIMEOUT_MINUTES = Number(process.env.MURAQIB_GLOBAL_TIMEOUT_MIN ?? 35);
    export default defineConfig({ globalTimeout: GLOBAL_TIMEOUT_MINUTES * 60 * 1000 });
  `;
  assert.equal(readGlobalTimeoutMinutes(decoy), 35);
});

test("rejects a non-numeric or non-positive job timeout instead of coercing it", () => {
  assert.equal(readJobTimeoutMinutes(workflowWithTimeout(0), "test"), null);
  const expression = `
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: "\${{ vars.TIMEOUT }}"
`;
  assert.equal(readJobTimeoutMinutes(expression, "test"), null);
});
