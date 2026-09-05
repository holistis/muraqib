import { test } from "node:test";
import assert from "node:assert/strict";
import { main, sendAlert } from "./watchdog.mjs";

/**
 * Tests for the watchdog's wiring.
 *
 * Why this file only appeared on 2026-09-03. The watchdog's decision lives in
 * assessHeartbeat, and that was already covered by 96 tests. The wiring around
 * it was not, and nothing in the repo touched watchdog.mjs at all: the file
 * exported nothing, so there was nothing to test. A mutation run made that
 * visible. Disabling sendAlert entirely left every check in the repo green.
 *
 * That is the worst place in this codebase to have no coverage. The watchdog is
 * the component whose whole job is to notice when everything else has gone
 * quiet, and it was the one component nothing was watching.
 *
 * The first test below is the important one. The try/catch around main() was
 * added on 2026-09-03 because its absence was a bug: a network error while
 * fetching skipped straight past sendAlert, so the watchdog could stop watching
 * without saying so. That is the same shape as the failure it exists to catch,
 * one layer out. Without this test, that regression could come back unnoticed.
 */

const NOW = "2026-09-03T06:00:00Z";
const hoursAgo = h => new Date(Date.parse(NOW) - h * 36e5).toISOString();
const run = (conclusion, h) => ({ conclusion, created_at: hoursAgo(h), html_url: `https://x/${h}` });

/** Collects alerts instead of sending them. */
function alertCollector() {
  const sent = [];
  return { sent, alert: async (subject, body) => void sent.push({ subject, body }) };
}

const ENV = { GITHUB_REPOSITORY: "holistis/muraqib" };
const clock = () => Date.parse(NOW);

/**
 * main() reports through process.exitCode rather than throwing, so each test
 * has to save and restore it. Leaking a 1 here would fail the whole run for
 * reasons that have nothing to do with the assertions.
 */
async function runMain(overrides) {
  const previous = process.exitCode;
  process.exitCode = undefined;
  await main({ env: ENV, now: clock, ...overrides });
  const exitCode = process.exitCode;
  process.exitCode = previous;
  return exitCode;
}

test("a failure while fetching does not skip the alert", async () => {
  const { sent, alert } = alertCollector();
  const fetchRuns = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  };

  const exitCode = await runMain({ fetchRuns, alert });

  assert.equal(sent.length, 1, "its own crash is exactly when the watchdog must speak");
  assert.match(sent[0].subject, /crashed/);
  assert.match(sent[0].body, /ENOTFOUND/);
  assert.equal(exitCode, 1, "a crashed watchdog must fail the job too");
});

test("an unhealthy heartbeat sends an alert and fails the job", async () => {
  const { sent, alert } = alertCollector();
  // The shape that actually happened: every night hard-killed by the job
  // timeout, so no run ever reported a conclusion to alert on.
  const runs = Array.from({ length: 30 }, (_, i) => run("cancelled", 24 * (i + 1)));

  const exitCode = await runMain({ fetchRuns: async () => ({ runs, note: null }), alert });

  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /not watching/);
  assert.equal(exitCode, 1);
});

test("a healthy heartbeat sends nothing and leaves the job green", async () => {
  const { sent, alert } = alertCollector();
  const runs = [run("success", 2), run("failure", 26), run("success", 50)];

  const exitCode = await runMain({ fetchRuns: async () => ({ runs, note: null }), alert });

  assert.equal(sent.length, 0, "a healthy night is not a reason to wake anyone");
  assert.notEqual(exitCode, 1);
});

test("an unreadable run history counts as unhealthy, not as silence", async () => {
  const { sent, alert } = alertCollector();
  // A watchdog that cannot see must never report all-clear.
  const exitCode = await runMain({ fetchRuns: async () => ({ runs: null, note: null }), alert });

  assert.equal(sent.length, 1);
  assert.equal(exitCode, 1);
});

/**
 * Tests for sendAlert itself. These were missing after the first round: the
 * tests above inject a fake alert, so the code that actually talks to Resend
 * and Telegram was never exercised. A mutation run confirmed the gap on
 * 2026-09-03, by disabling sendAlert and watching everything stay green.
 *
 * That is exactly where a real bug lived before. The failure notification had
 * its from and to addresses hardcoded instead of read from the configured
 * secrets, so that specific email had never worked for anyone since the first
 * commit. Untested delivery code is not a theoretical risk here.
 */

function fakeChannel(name, response) {
  const sent = [];
  return {
    sent,
    channel: {
      name,
      config: env => ({ key: env[`${name.toUpperCase()}_KEY`] }),
      configured: c => Boolean(c.key),
      missing: `${name.toUpperCase()}_KEY`,
      send: async (c, subject, body) => {
        sent.push({ subject, body });
        if (response instanceof Error) throw response;
        return response;
      },
      describe: () => "somewhere",
    },
  };
}

function fakeLog() {
  const lines = [];
  return { lines, log: { log: m => lines.push(["log", m]), error: m => lines.push(["error", m]) } };
}

const found = (lines, kind, pattern) => lines.some(([k, m]) => k === kind && pattern.test(m));

test("with no channel configured, nothing is sent but it is said out loud", async () => {
  const { channel, sent } = fakeChannel("email", { ok: true });
  const { lines, log } = fakeLog();

  await sendAlert("subject", "body", { channels: [channel], env: {}, log });

  assert.equal(sent.length, 0);
  assert.ok(
    found(lines, "error", /no notification channel is configured/),
    "an unconfigured channel has to be visible, not silent"
  );
});

test("a channel returning an error status does not pass as delivered", async () => {
  const { channel, sent } = fakeChannel("email", { ok: false, status: 401 });
  const { lines, log } = fakeLog();

  await sendAlert("subject", "body", { channels: [channel], env: { EMAIL_KEY: "x" }, log });

  assert.equal(sent.length, 1, "it should at least have tried");
  assert.ok(found(lines, "error", /returned 401/), "a 401 must not read as a delivered alert");
});

test("a channel that throws does not stop the other channels", async () => {
  const broken = fakeChannel("email", new Error("socket hang up"));
  const working = fakeChannel("telegram", { ok: true });
  const { lines, log } = fakeLog();

  await sendAlert("subject", "body", {
    channels: [broken.channel, working.channel],
    env: { EMAIL_KEY: "x", TELEGRAM_KEY: "y" },
    log,
  });

  assert.equal(working.sent.length, 1, "the second channel still gets its turn");
  assert.ok(found(lines, "error", /threw while sending/));
});

test("a successful send is reported", async () => {
  const { channel } = fakeChannel("email", { ok: true });
  const { lines, log } = fakeLog();

  await sendAlert("subject", "body", { channels: [channel], env: { EMAIL_KEY: "x" }, log });

  assert.ok(found(lines, "log", /Alert sent via email/));
});
