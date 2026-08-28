import { test } from "node:test";
import assert from "node:assert/strict";
import { findExpressionSplices } from "./check-no-expression-splicing.mjs";

const VULNERABLE_YAML = `
name: Example
on: workflow_dispatch
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const summary = \`\${{ inputs.summary }}\` || "none";
            console.log(summary);
`;

const CLEAN_YAML = `
name: Example
on: workflow_dispatch
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        env:
          MURAQIB_SUMMARY: \${{ inputs.summary }}
        with:
          script: |
            const summary = process.env.MURAQIB_SUMMARY || "none";
            console.log(summary);
`;

const VULNERABLE_BASH = `
name: Example
on: workflow_dispatch
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - env:
          MURAQIB_SUMMARY: \${{ inputs.summary }}
        run: |
          echo "\${{ inputs.summary }}"
`;

const INVALID_YAML = `
name: Example
on: workflow_dispatch
jobs:
  fix
    runs-on: ubuntu-latest
`;

test("flags a script: body that splices a raw GitHub expression", () => {
  const findings = findExpressionSplices(VULNERABLE_YAML, "vulnerable.yml");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].parseError, null);
  assert.match(findings[0].path, /jobs\.fix\.steps\[0\]\.with\.script/);
  assert.match(findings[0].line, /\$\{\{ inputs\.summary \}\}/);
});

test("passes a script: body that only reads from env/process.env", () => {
  const findings = findExpressionSplices(CLEAN_YAML, "clean.yml");
  assert.equal(findings.length, 0);
});

test("flags a run: (bash) body that splices a raw GitHub expression, even alongside a correct env: usage", () => {
  const findings = findExpressionSplices(VULNERABLE_BASH, "vulnerable-bash.yml");
  assert.equal(findings.length, 1);
  assert.match(findings[0].path, /jobs\.fix\.steps\[0\]\.run/);
});

test("reports a YAML parse error as a finding instead of throwing", () => {
  const findings = findExpressionSplices(INVALID_YAML, "invalid.yml");
  assert.equal(findings.length, 1);
  assert.ok(findings[0].parseError, "expected a parseError message");
});

test("this repo's actual workflow files pass the check (regression guard)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = ".github/workflows";
  for (const file of readdirSync(dir).filter(f => f.endsWith(".yml"))) {
    const fullPath = join(dir, file);
    const findings = findExpressionSplices(readFileSync(fullPath, "utf8"), fullPath);
    assert.deepEqual(findings, [], `${fullPath} should have no expression-splice findings`);
  }
});
