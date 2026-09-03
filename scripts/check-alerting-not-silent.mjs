#!/usr/bin/env node
/**
 * Finds notification steps that do nothing, quietly, and let the job go green.
 *
 * This is the same failure as a nightly cancelled by a job timeout, one layer
 * out. There the run could not report, so no alert fired. Here the alert step
 * runs, decides it cannot send, and returns success anyway. Both leave you with
 * a calm dashboard and an empty inbox, and both are indistinguishable from
 * everything being fine.
 *
 * It was found by running the watchdog against a real project. RESEND_API_KEY
 * had never been set on that repo, and all three of its notification paths
 * handled that by silently skipping:
 *
 *   weekly digest    console.log('key not found'); return;   job green
 *   fix workflow     if: env.RESEND_API_KEY != ''            step skipped, job green
 *   auto-rollback    if [ -n "$RESEND_API_KEY" ]; then ...   nothing sent, job green
 *
 * Twelve green Mondays in a row, no email ever sent, and no way to tell from
 * the outside. On top of that none of the curl calls used --fail, so even with
 * a valid key an HTTP 401 from the provider would still exit 0.
 *
 * The rule this enforces: a step whose whole purpose is to tell a human
 * something must fail when it cannot. The work it is reporting on can still
 * succeed. Losing the report must not be silent.
 *
 * Run: node scripts/check-alerting-not-silent.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKFLOWS_DIR = ".github/workflows";

/**
 * Hosts that exist to deliver a message to a person. Not exhaustive, and not
 * meant to be: this check only claims to cover the delivery services a project
 * is likely to reach for, and says nothing about the ones it does not know.
 */
const NOTIFICATION_HOSTS = [
  "api.resend.com",
  "hooks.slack.com",
  "slack.com/api/chat.postMessage",
  "api.telegram.org",
  "api.sendgrid.com",
  "api.mailgun.net",
  "api.postmarkapp.com",
  "discord.com/api/webhooks",
  "api.pushover.net",
  "events.pagerduty.com",
];

/** curl flags that make an HTTP error status a non-zero exit. */
const CURL_FAILS_LOUDLY = /(^|\s)(--fail-with-body|--fail\b|-[a-zA-Z]*f[a-zA-Z]*\s)/;

export function mentionsNotificationHost(line) {
  return NOTIFICATION_HOSTS.some(host => line.includes(host));
}

/**
 * A step-level `if:` that tests a secret or token for emptiness. When it is
 * false the step reports SKIPPED, the job stays green, and nothing was sent.
 */
const SKIP_IF_SECRET_EMPTY = /^\s*if:\s*.*\b(?:env|secrets)\.[A-Za-z_][A-Za-z0-9_]*\s*(?:!=\s*''|!=\s*""|==\s*''|==\s*"")/;

/** The shell version of the same idea: if [ -n "$KEY" ]; then send; fi */
const SHELL_GUARD_ON_SECRET = /if\s+\[\s+-n\s+"?\$\{?[A-Za-z_][A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET|_WEBHOOK|_URL|_API_KEY)\}?"?\s+\]/;

/**
 * Splits a workflow into steps by their `- name:` or `- uses:`/`- run:` lines,
 * so a finding can be attributed to the step it belongs to.
 *
 * Deliberately crude. It is only used to decide which lines belong together,
 * never to decide whether something is safe, so a mis-split produces a slightly
 * worse message rather than a missed problem.
 */
export function splitIntoSteps(source) {
  const lines = source.split(/\r?\n/);
  const steps = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s+(name|uses|run|id):/.test(line)) {
      if (current) steps.push(current);
      current = { startLine: i + 1, name: null, lines: [] };
      const named = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
      if (named) current.name = named[1].replace(/^["']|["']$/g, "");
    }
    if (current) current.lines.push(line);
  }
  if (current) steps.push(current);
  return steps;
}

export function findSilentAlertingProblems(workflows) {
  const problems = [];

  for (const { name: file, source } of workflows) {
    for (const step of splitIntoSteps(source)) {
      const body = step.lines.join("\n");
      if (!step.lines.some(mentionsNotificationHost)) continue;

      const label = `${file}${step.name ? ` step "${step.name}"` : `, line ${step.startLine}`}`;

      const gate = step.lines.find(line => SKIP_IF_SECRET_EMPTY.test(line));
      if (gate) {
        problems.push({
          label,
          message: `this step only runs when a secret is set (\`${gate.trim()}\`). On any repo where that secret is missing or expired, the step reports SKIPPED, the job still goes green, and nobody is told anything. Run the step unconditionally and fail it when the secret is absent, so a broken alerting path is visible instead of invisible.`,
        });
      }

      const shellGate = SHELL_GUARD_ON_SECRET.exec(body);
      if (shellGate) {
        problems.push({
          label,
          message: `the send is wrapped in \`${shellGate[0].trim()}\`, so a missing secret means the command never runs and the step still succeeds. Invert it: exit non-zero when the secret is absent, after whatever real work this job does has already completed.`,
        });
      }

      for (const line of step.lines) {
        if (!/\bcurl\b/.test(line)) continue;
        // The flags may sit on continuation lines, so judge the whole step.
        if (!CURL_FAILS_LOUDLY.test(body)) {
          problems.push({
            label,
            message:
              "this curl has no --fail or --fail-with-body, so an HTTP 401, 403 or 429 from the notification provider still exits 0. A rejected message then looks exactly like a delivered one. Add --fail-with-body.",
          });
        }
        break;
      }

      // A github-script step has exactly two ways to report a problem:
      // core.setFailed, or throwing. One that sends a notification and does
      // neither cannot fail at all, so every delivery problem it meets ends as
      // a console line in a green run. That is what turned twelve consecutive
      // Mondays of the weekly digest into green runs that sent nothing: the
      // missing-key branch logged and returned.
      if (/uses:\s*actions\/github-script/.test(body) && !/core\.setFailed|throw\s/.test(body)) {
        problems.push({
          label,
          message:
            "this github-script step sends a notification but never calls core.setFailed and never throws, so it has no way to report a delivery failure. Whatever goes wrong becomes a console line in a green run. Call core.setFailed on a missing key and on a non-ok response.",
        });
      }
    }
  }

  return problems;
}

export function readWorkflows(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(entry => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .map(entry => ({ name: `${WORKFLOWS_DIR}/${entry}`, source: readFileSync(join(dir, entry), "utf8") }));
}

function main() {
  const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
  const workflows = readWorkflows(join(repoRoot, WORKFLOWS_DIR));

  const problems = findSilentAlertingProblems(workflows);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`SILENT-ALERT RISK: ${problem.label}`);
      console.error(`  ${problem.message}`);
    }
    process.exit(1);
  }

  console.log(`OK: checked ${workflows.length} workflow file(s), every notification step fails loudly when it cannot deliver.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
