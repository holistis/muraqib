import { test } from "node:test";
import assert from "node:assert/strict";
import { findSkippableRequiredCheck } from "./check-required-check-not-skippable.mjs";

const JOB_LEVEL_IF_YAML = `
name: Example
on: pull_request_target
jobs:
  guard:
    if: github.event.pull_request.auto_merge != null
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo check
`;

const ALL_STEPS_CONDITIONAL_YAML = `
name: Example
on: pull_request_target
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        if: github.event.pull_request.auto_merge != null
      - run: echo check
        if: github.event.pull_request.auto_merge != null
`;

const FIXED_YAML = `
name: Example
on: pull_request_target
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - name: no-op
        if: github.event.pull_request.auto_merge == null
        run: echo "nothing to guard"
      - uses: actions/checkout@v4
        if: github.event.pull_request.auto_merge != null
      - run: echo check
        if: github.event.pull_request.auto_merge != null
`;

const NO_STEPS_YAML = `
name: Example
on: pull_request_target
jobs:
  guard:
    runs-on: ubuntu-latest
    steps: []
`;

const MISSING_JOB_YAML = `
name: Example
on: pull_request_target
jobs:
  something-else:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

const INVALID_YAML = `
name: Example
jobs:
  guard
    runs-on: ubuntu-latest
`;

test("flags a job-level if: on the guard job", () => {
  const problems = findSkippableRequiredCheck(JOB_LEVEL_IF_YAML, "job-level-if.yml");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /job-level "if:"/);
});

test("flags a guard job where every step carries an if: with no unconditional step", () => {
  const problems = findSkippableRequiredCheck(ALL_STEPS_CONDITIONAL_YAML, "all-conditional.yml");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /no unconditional step/);
});

test("passes a guard job with no job-level if: and an unconditional no-op step", () => {
  const problems = findSkippableRequiredCheck(FIXED_YAML, "fixed.yml");
  assert.deepEqual(problems, []);
});

test("flags a guard job with no steps", () => {
  const problems = findSkippableRequiredCheck(NO_STEPS_YAML, "no-steps.yml");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /no steps/);
});

test("flags a missing guard job", () => {
  const problems = findSkippableRequiredCheck(MISSING_JOB_YAML, "missing-job.yml");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /not found/);
});

test("reports a YAML parse error as a finding instead of throwing", () => {
  const problems = findSkippableRequiredCheck(INVALID_YAML, "invalid.yml");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /YAML parse error/);
});

test("this repo's actual auto-merge-guard.yml passes the check (regression guard)", async () => {
  const { readFileSync } = await import("node:fs");
  const path = ".github/workflows/auto-merge-guard.yml";
  const problems = findSkippableRequiredCheck(readFileSync(path, "utf8"), path);
  assert.deepEqual(problems, [], `${path} should have no skippable-required-check findings`);
});
