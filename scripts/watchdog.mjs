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
const CHANNELS = [
  {
    name: "email",
    config: () => ({
      key: process.env.RESEND_API_KEY,
      to: process.env.MURAQIB_EMAIL_TO,
      from: process.env.MURAQIB_EMAIL_FROM,
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
    config: () => ({
      token: process.env.MURAQIB_TELEGRAM_BOT_TOKEN,
      chatId: process.env.MURAQIB_TELEGRAM_CHAT_ID,
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
async function sendAlert(subject, body) {
  const configured = CHANNELS.map(channel => ({ channel, config: channel.config() })).filter(
    ({ channel, config }) => channel.configured(config)
  );

  if (configured.length === 0) {
    console.error(
      `NOTE: no notification channel is configured, so nothing was sent. Set either ${CHANNELS.map(c => c.missing).join(", or ")}. The job still fails below, so this stays visible in Actions either way.`
    );
    return;
  }

  for (const { channel, config } of configured) {
    try {
      const response = await channel.send(config, subject, body);
      if (!response.ok) {
        console.error(`NOTE: ${channel.name} returned ${response.status}, that alert did not go out.`);
        continue;
      }
      console.log(`Alert sent via ${channel.name} to ${channel.describe(config)}.`);
    } catch (err) {
      console.error(`NOTE: ${channel.name} threw while sending: ${err.message}`);
    }
  }
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

  await sendAlert(`Muraqib is not watching ${repo}`, body);
  process.exitCode = 1;
}

main().catch(err => {
  console.error(`FAILED: ${err.message}`);
  process.exitCode = 1;
});
