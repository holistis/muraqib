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
 *   RESEND_API_KEY       optional, one of two ways to be told
 *   MURAQIB_EMAIL_TO     optional, required for email
 *   MURAQIB_EMAIL_FROM   optional, required for email
 *   MURAQIB_TELEGRAM_BOT_TOKEN  optional, the other way
 *   MURAQIB_TELEGRAM_CHAT_ID    optional, required for telegram
 *   MURAQIB_MAX_QUIET_HOURS / _MAX_CANCELS / _MAX_FAILURES  optional overrides
 */
import { assessHeartbeat } from "./check-nightly-heartbeat.mjs";
import { pathToFileURL } from "node:url";

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

function optionalNumber(name, env = process.env) {
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

/**
 * Where an alert can go, in the order they are tried.
 *
 * Email is the obvious channel and it is also the one most likely to be
 * missing: it needs a provider account, a verified sending domain, and a key
 * that has to be set before anything can ever arrive. A project that skipped
 * that setup has no alerting at all, and the two month silence this whole
 * feature exists because of ran on exactly that: a repo whose RESEND_API_KEY
 * had never been set.
 *
 * A bot token and a chat id are a lower bar, and plenty of projects already
 * have one for something else. Supporting both means the alert reaches
 * somebody through whichever channel is already configured, rather than
 * depending on the one that needs the most setup.
 */
export const CHANNELS = [
  {
    name: "email",
    config: (env = process.env) => ({
      key: env.RESEND_API_KEY,
      to: env.MURAQIB_EMAIL_TO,
      from: env.MURAQIB_EMAIL_FROM,
    }),
    configured: c => Boolean(c.key && c.to && c.from),
    missing: "RESEND_API_KEY, MURAQIB_EMAIL_TO and MURAQIB_EMAIL_FROM",
    send: (c, subject, body) =>
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${c.key}`, "content-type": "application/json" },
        // Plain text, not HTML. The body carries strings that came back from
        // the GitHub API, and text/plain gives them nowhere to be interpreted.
        body: JSON.stringify({ from: c.from, to: c.to, subject, text: body }),
      }),
    describe: c => c.to,
  },
  {
    name: "telegram",
    config: (env = process.env) => ({
      token: env.MURAQIB_TELEGRAM_BOT_TOKEN,
      chatId: env.MURAQIB_TELEGRAM_CHAT_ID,
    }),
    configured: c => Boolean(c.token && c.chatId),
    missing: "MURAQIB_TELEGRAM_BOT_TOKEN and MURAQIB_TELEGRAM_CHAT_ID",
    send: (c, subject, body) =>
      // JSON rather than form encoding: the body is multi-line and contains
      // URLs, and a form-encoded payload would need escaping that is easy to
      // get subtly wrong.
      fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: c.chatId, text: `${subject}

${body}`, disable_web_page_preview: true }),
      }),
    describe: c => `chat ${c.chatId}`,
  },
];

/**
 * Sends through every configured channel and reports what happened.
 *
 * Returns nothing and throws nothing on a delivery failure on purpose: the
 * caller already fails the job because the nightly is unhealthy. What matters
 * here is that a channel which was configured and then did not deliver leaves
 * a line in the log, rather than looking the same as a channel nobody set up.
 */
export async function sendAlert(subject, body, { channels = CHANNELS, env = process.env, log = console } = {}) {
  const configured = channels.map(channel => ({ channel, config: channel.config(env) })).filter(
    ({ channel, config }) => channel.configured(config)
  );

  if (configured.length === 0) {
    log.error(
      `NOTE: no notification channel is configured, so nothing was sent. Set either ${channels.map(c => c.missing).join(", or ")}. The job still fails below, so this stays visible in Actions either way.`
    );
    return;
  }

  for (const { channel, config } of configured) {
    try {
      const response = await channel.send(config, subject, body);
      if (!response.ok) {
        log.error(`NOTE: ${channel.name} returned ${response.status}, that alert did not go out.`);
        continue;
      }
      log.log(`Alert sent via ${channel.name} to ${channel.describe(config)}.`);
    } catch (err) {
      log.error(`NOTE: ${channel.name} threw while sending: ${err.message}`);
    }
  }
}

/**
 * The watchdog's decision lives in assessHeartbeat and that is tested. The
 * wiring around it was not, and that was the gap: the safety net below was
 * added on 2026-09-03 because its absence was a bug, and nothing checked
 * that it was still there. A mutation run confirmed it, by disabling
 * sendAlert entirely and watching every check in the repo stay green.
 *
 * So the three outer edges are injectable now. The defaults are the real
 * ones, which means nothing changes in production.
 */
export async function main({
  fetchRuns = fetchNightlyRuns,
  alert = sendAlert,
  env = process.env,
  // The watchdog reasons about time, so the clock belongs in the signature
  // rather than hiding inside the body. Otherwise the behaviour cannot be
  // tested without faking the system clock.
  now = () => Date.now(),
} = {}) {
  const repo = env.GITHUB_REPOSITORY || "this repo";

  // Found 2026-09-03: everything from here down used to run with no try/catch
  // of its own, so a thrown error (a network failure or a timeout on the fetch
  // in fetchNightlyRuns, or anything else unexpected) skipped straight past
  // sendAlert() to the top-level main().catch() below, which only logs to the
  // Actions log and sets exitCode. That fails the job, which is visible in
  // Actions, but never reaches a person through the channels this whole script
  // exists to guarantee, exactly the failure mode it was built to catch one
  // layer out. A watchdog that can silently stop watching because of its own
  // bug is the same shape of bug as the one it watches for.
  try {
    const { runs, note } = await fetchRuns();

    const verdict = assessHeartbeat(runs, {
      now: now(),
      maxQuietHours: optionalNumber("MURAQIB_MAX_QUIET_HOURS", env),
      maxConsecutiveInconclusive: optionalNumber("MURAQIB_MAX_CANCELS", env),
      maxConsecutiveFailures: optionalNumber("MURAQIB_MAX_FAILURES", env),
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

    await alert(`Muraqib is not watching ${repo}`, body);
    process.exitCode = 1;
  } catch (err) {
    const body = [
      `The watchdog itself failed while checking ${repo}, before it could reach a verdict: ${err.message}`,
      "",
      "This is not a claim that your app is broken or healthy. It is the watchdog crashing, which is exactly the state where you most need to hear from it.",
    ].join("\n");
    console.error(`WATCHDOG: crashed`);
    console.error(body);
    await alert(`Muraqib's watchdog crashed while checking ${repo}`, body);
    process.exitCode = 1;
  }
}

// Only run when this file was invoked directly. Without this gate,
// importing the module in a test would start the real watchdog, network
// request and live alert included.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly || process.env.MURAQIB_WATCHDOG_FORCE_RUN === "1") {
  main().catch(err => {
    // Reachable only if sendAlert() itself throws synchronously in a way the
    // catch above didn't already handle, or main() throws before entering the
    // try block. Kept as the last-resort backstop, see the comment at the top
    // on why this uses exitCode not exit().
    console.error(`FAILED: ${err.message}`);
    process.exitCode = 1;
  });
}
