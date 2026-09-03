import { test } from "node:test";
import assert from "node:assert/strict";
import { findSilentAlertingProblems, splitIntoSteps, mentionsNotificationHost } from "./check-alerting-not-silent.mjs";

const wf = (name, source) => [{ name, source }];

// The three shapes below are the ones that actually shipped and stayed green
// for months on a real repo whose RESEND_API_KEY was never set.

const STEP_LEVEL_IF = `
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - name: Send failure notification via Resend
        if: env.RESEND_API_KEY != ''
        env:
          RESEND_API_KEY: \${{ secrets.RESEND_API_KEY }}
        run: |
          curl -sS --fail-with-body -X POST https://api.resend.com/emails -d "$payload"
`;

const SHELL_GUARD = `
jobs:
  rollback:
    runs-on: ubuntu-latest
    steps:
      - name: Email alert on rollback
        env:
          RESEND_API_KEY: \${{ secrets.RESEND_API_KEY }}
        run: |
          if [ -n "$RESEND_API_KEY" ]; then
            curl -sS --fail-with-body -X POST https://api.resend.com/emails -d "$payload"
          fi
`;

const GITHUB_SCRIPT_RETURN = `
jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - name: Weekly digest
        uses: actions/github-script@v7
        env:
          RESEND_API_KEY: \${{ secrets.RESEND_API_KEY }}
        with:
          script: |
            const apiKey = process.env.RESEND_API_KEY;
            if (!apiKey) {
              console.log('RESEND_API_KEY not found, email skipped');
              return;
            }
            await fetch('https://api.resend.com/emails', { method: 'POST' });
`;

const FIXED = `
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - name: Send failure notification via Resend
        env:
          RESEND_API_KEY: \${{ secrets.RESEND_API_KEY }}
        run: |
          if [ -z "$RESEND_API_KEY" ]; then
            echo "RESEND_API_KEY is not set, so no notification could be sent."
            exit 1
          fi
          curl -sS --fail-with-body -X POST https://api.resend.com/emails -d "$payload"
`;

test("catches a notification step gated on a secret being set", () => {
  const problems = findSilentAlertingProblems(wf("fix.yml", STEP_LEVEL_IF));
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /reports SKIPPED/);
  assert.match(problems[0].label, /step "Send failure notification via Resend"/);
});

test("catches the shell version of the same guard", () => {
  const problems = findSilentAlertingProblems(wf("rollback.yml", SHELL_GUARD));
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /the step still succeeds/);
});

test("catches a github-script sender that can never fail", () => {
  // This is the one that produced twelve consecutive green Mondays with no
  // email sent. Logging and returning is not reporting.
  const problems = findSilentAlertingProblems(wf("digest.yml", GITHUB_SCRIPT_RETURN));
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /never calls core\.setFailed and never throws/);
});

test("a github-script sender that calls core.setFailed passes", () => {
  const fixed = GITHUB_SCRIPT_RETURN.replace("return;", "core.setFailed('no key'); return;");
  assert.deepEqual(findSilentAlertingProblems(wf("digest.yml", fixed)), []);
});

test("a github-script sender that throws also passes", () => {
  const thrown = GITHUB_SCRIPT_RETURN.replace("return;", "throw new Error('no key');");
  assert.deepEqual(findSilentAlertingProblems(wf("digest.yml", thrown)), []);
});

test("catches a curl that treats an HTTP error as success", () => {
  const noFail = FIXED.replace("curl -sS --fail-with-body", "curl -s");
  const problems = findSilentAlertingProblems(wf("fix.yml", noFail));
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /401, 403 or 429/);
});

test("--fail on a continuation line still counts", () => {
  // The flags often sit several lines below the curl itself, so the whole step
  // is judged rather than the one line the word curl appears on.
  const multiline = `
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - name: Notify
        run: |
          curl -sS -X POST https://api.resend.com/emails \\
            --fail-with-body \\
            -d "$payload"
`;
  assert.deepEqual(findSilentAlertingProblems(wf("fix.yml", multiline)), []);
});

test("the fixed shape is clean", () => {
  assert.deepEqual(findSilentAlertingProblems(wf("fix.yml", FIXED)), []);
});

test("steps that send nothing are not judged", () => {
  // A build step gated on a secret is a normal thing to do. This check is only
  // about steps whose entire purpose is to reach a person.
  const build = `
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Publish
        if: env.NPM_TOKEN != ''
        run: npm publish
`;
  assert.deepEqual(findSilentAlertingProblems(wf("ci.yml", build)), []);
});

test("recognizes the delivery services it claims to cover", () => {
  assert.equal(mentionsNotificationHost("curl https://hooks.slack.com/services/x"), true);
  assert.equal(mentionsNotificationHost("curl https://api.telegram.org/botX/sendMessage"), true);
  assert.equal(mentionsNotificationHost("curl https://discord.com/api/webhooks/1/2"), true);
  assert.equal(mentionsNotificationHost("curl https://example.com/thing"), false);
});

test("steps are attributed by name, and unnamed ones by line", () => {
  const steps = splitIntoSteps(STEP_LEVEL_IF);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].name, "Send failure notification via Resend");

  const unnamed = findSilentAlertingProblems(
    wf("x.yml", "jobs:\n  a:\n    steps:\n      - run: curl -s https://api.resend.com/emails\n")
  );
  assert.equal(unnamed.length, 1);
  assert.match(unnamed[0].label, /line \d+/);
});

test("more than one problem in a single step is reported separately", () => {
  const both = STEP_LEVEL_IF.replace("curl -sS --fail-with-body", "curl -s");
  const problems = findSilentAlertingProblems(wf("fix.yml", both));
  assert.equal(problems.length, 2);
});
