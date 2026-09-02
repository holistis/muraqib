#!/usr/bin/env node
/**
 * Runs the heartbeat check against this repo's nightly workflow and shouts if
 * the guard has gone quiet.
 *
 * Everything it needs comes from the environment, nothing is spliced in from a
 * workflow expression. That is deliberate: this repo shipped a script
 * injection in its first commit by interpolating ${} expressions straight into
 * a script body, and the rule since then is that untrusted values arrive as
 * env vars or not at all (see SECURITY.md).
 *
 * Env:
 *   GITHUB_TOKEN         required, needs actions:read
 *   GITHUB_REPOSITORY    required, "owner/name", set by Actions
 *   GITHUB_API_URL       optional, set by Actions, for GitHub Enterprise
 *   MURAQIB_NIGHTLY_WORKFLOW  optional, default "muraqib-nightly.yml"
 *   RESEND_API_KEY       optional, without it the job still fails loudly
 *   MURAQIB_EMAIL_TO     optional, required for email
 *   MURAQIB_EMAIL_FROM   optional, required for email
 *   MURAQIB_MAX_QUIET_HOURS / _MAX_CANCELS / _MAX_FAILURES  optional overrides
 */
import { assessHeartbeat } from "./check-nightly-heartbeat.mjs";

const RUNS_TO_INSPECT = 30;

// These throw rather than calling process.exit directly. Exiting from inside
// an async call stack leaves libuv handles mid-flight, which on Windows aborts
// the process with a raw assertion instead of the intended exit code. Throwing
// lets the single catch at the bottom print one clear line and exit once.
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. The watchdog cannot check anything without it, and reporting all-clear here would be a lie.`);
  }
  return value;
}

function optionalNumber(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} is set to "${raw}", which is not a positive number. Refusing to fall back to a default, because a typo in a threshold would silently widen the window this check exists to keep narrow.`);
  }
  return value;
}

async function fetchNightlyRuns() {
  const repo = required("GITHUB_REPOSITORY");
  const token = required("GITHUB_TOKEN");
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const workflow = process.env.MURAQIB_NIGHTLY_WORKFLOW || "muraqib-nightly.yml";

  const url = `${api}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${RUNS_TO_INSPECT}`;
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });

  if (response.status === 404) {
    // Not the same as "no runs". The workflow file itself is gone or renamed,
    // which means the nightly is not running at all and nobody was told.
    return { runs: null, note: `No workflow named ${workflow} exists in ${repo}.` };
  }
  if (!response.ok) {
    return { runs: null, note: `GitHub returned ${response.status} for the workflow's run history.` };
  }

  const body = await response.json();
  return { runs: Array.isArray(body.workflow_runs) ? body.workflow_runs : null };
}

async function sendEmail(subject, body) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.MURAQIB_EMAIL_TO;
  const from = process.env.MURAQIB_EMAIL_FROM;

  if (!key || !to || !from) {
    console.error("NOTE: no RESEND_API_KEY / MURAQIB_EMAIL_TO / MURAQIB_EMAIL_FROM, so no email was sent. The job still fails below, so this is visible in Actions either way.");
    return;
  }

  // Plain text, not HTML. The body carries strings that came back from the
  // GitHub API, and text/plain gives them nowhere to be interpreted.
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to, subject, text: body }),
  });

  if (!response.ok) {
    console.error(`NOTE: Resend returned ${response.status}, the alert email did not go out.`);
    return;
  }
  console.log(`Alert email sent to ${to}.`);
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || "this repo";
  const { runs, note } = await fetchNightlyRuns();

  const verdict = assessHeartbeat(runs, {
    now: Date.now(),
    maxQuietHours: optionalNumber("MURAQIB_MAX_QUIET_HOURS"),
    maxConsecutiveInconclusive: optionalNumber("MURAQIB_MAX_CANCELS"),
    maxConsecutiveFailures: optionalNumber("MURAQIB_MAX_FAILURES"),
  });

  if (verdict.ok) {
    console.log(`OK: ${verdict.message}`);
    return;
  }

  const lines = [
    `Muraqib's nightly check on ${repo} is not reaching you.`,
    "",
    verdict.message,
    note ? `\n${note}` : "",
    verdict.lastRunUrl ? `\nMost recent run: ${verdict.lastRunUrl}` : "",
    "",
    "This email exists because the nightly's own alerts cannot fire in this state. Nothing is claiming your app is broken. The point is that nothing would be able to tell you if it were.",
  ].filter(Boolean);

  const body = lines.join("\n");
  console.error(`WATCHDOG: ${verdict.code}`);
  console.error(body);

  await sendEmail(`Muraqib is not watching ${repo}`, body);
  process.exitCode = 1;
}

main().catch(err => {
  console.error(`FAILED: ${err.message}`);
  process.exitCode = 1;
});
