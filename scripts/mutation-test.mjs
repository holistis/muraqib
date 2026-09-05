#!/usr/bin/env node
/**
 * Asks one question about every check in this repo: can it actually fail?
 *
 * A check that cannot go red is worse than no check at all. It costs the same
 * to run, it looks the same in the Actions tab, and it buys you confidence it
 * has not earned. This repo shipped two of them. Both were found by the run
 * below, not by reading the code, and neither had ever produced a red result.
 *
 * How it works. For each case: introduce the exact defect the check claims to
 * catch, run the check, then put the file back. Three measurements per case,
 * not one:
 *
 *   before   the check must be GREEN. If it was already red, the rest of the
 *            measurement says nothing about the mutation.
 *   during   the check must be RED. This is the actual claim.
 *   after    the check must be GREEN again. If not, the harness broke
 *            something and the middle measurement is worthless.
 *
 * Only a case that passes all three counts as ALIVE.
 *
 * That third measurement is not paranoia. The first run of this harness
 * produced three invalid cases and one wrong verdict, every one of them caused
 * by the harness rather than by the checks: two search strings used LF against
 * CRLF files, one anchor did not exist, and one revert threw away an
 * uncommitted fix. An exercise about detectors that cannot fire is a good place
 * to remember that the detector you just wrote is also a detector.
 *
 * Run it against a clean tree: `npm run mutation-test`. Anything uncommitted is
 * skipped rather than silently reverted.
 *
 * Credit where it is due: the idea came from FarzamHabibi, who ran it against
 * the eleven gates in his own pipeline and found four that could never fire.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRLF = "\r\n";
const LF = "\n";

const run = command => {
  try {
    execSync(command, { cwd: REPO, stdio: "pipe", timeout: 240000 });
    return true;
  } catch {
    return false;
  }
};

const read = file => {
  const raw = readFileSync(join(REPO, file), "utf8");
  return { crlf: raw.includes(CRLF), text: raw.split(CRLF).join(LF) };
};

const write = (file, text, crlf) => writeFileSync(join(REPO, file), crlf ? text.split(LF).join(CRLF) : text);

const restore = file => execSync(`git checkout -- ${JSON.stringify(file)}`, { cwd: REPO, stdio: "pipe" });

const isClean = file => {
  try {
    execSync(`git diff --quiet -- ${JSON.stringify(file)}`, { cwd: REPO, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

const swap = (needle, replacement) => text => (text.includes(needle) ? text.replace(needle, replacement) : null);

const CRASH_ALERT = "    await alert(`Muraqib's watchdog crashed while checking ${repo}`, body);";
const UNHEALTHY_ALERT = "    await alert(`Muraqib is not watching ${repo}`, body);";
const SEND_ALERT_BODY = "  const configured = channels.map(channel => ({ channel, config: channel.config(env) })).filter(";

const CASES = [
  {
    name: "expression splicing",
    claim: "a GitHub expression inline in a run body, i.e. code injection",
    command: "npm run --silent check:workflows",
    file: ".github/workflows/self-check.yml",
    mutate: swap("      - run: npm ci", '      - run: echo "${{ github.event.head_commit.message }}"\n      - run: npm ci'),
  },
  {
    name: "required check can be skipped",
    claim: "a job-level if on the guard, letting it report SKIPPED",
    command: "npm run --silent check:required-checks",
    file: ".github/workflows/auto-merge-guard.yml",
    mutate: swap("  guard:\n", "  guard:\n    if: github.actor == 'dependabot[bot]'\n"),
  },
  {
    name: "nightly timeout budget",
    claim: "globalTimeout not safely below the job timeout, so a silent kill",
    command: "npm run --silent check:timeout-budget",
    file: ".github/workflows/muraqib-nightly.yml",
    mutate: swap("timeout-minutes: 45", "timeout-minutes: 20"),
  },
  {
    name: "alerting: step skips itself",
    claim: "a step that does nothing when a secret is empty and still goes green",
    command: "npm run --silent check:alerting",
    file: ".github/workflows/muraqib-claude-fix.yml",
    mutate(text) {
      const lines = text.split(LF);
      const curl = lines.findIndex(l => l.includes("api.resend.com/emails") && l.includes("curl"));
      if (curl === -1) return null;
      for (let i = curl; i >= 0; i--) {
        const indent = /^(\s+)- name: /.exec(lines[i]);
        if (indent) {
          lines.splice(i + 1, 0, `${indent[1]}  if: env.RESEND_API_KEY != ''`);
          return lines.join(LF);
        }
      }
      return null;
    },
  },
  {
    name: "alerting: curl without --fail",
    claim: "a curl with no --fail, so an HTTP 401 passes as a delivered alert",
    command: "npm run --silent check:alerting",
    file: ".github/workflows/muraqib-claude-fix.yml",
    mutate: swap(
      "curl -sS --fail-with-body -X POST https://api.resend.com/emails",
      "curl -sS -X POST https://api.resend.com/emails"
    ),
  },
  {
    name: "sensitive paths fail closed",
    claim: "an unparseable pattern must block, not quietly match nothing",
    command: "npm run --silent test:scripts",
    file: "scripts/check-sensitive-paths.mjs",
    mutate: swap("    return {\n      block: true,", "    return {\n      block: false,"),
  },
  {
    name: "nightly heartbeat",
    claim: "notices that nothing conclusive has been reported for too long",
    command: "npm run --silent test:scripts",
    file: "scripts/check-nightly-heartbeat.mjs",
    mutate: swap(
      'const CONCLUSIVE = new Set(["success", "failure"]);',
      'const CONCLUSIVE = new Set(["success", "failure", "cancelled"]);'
    ),
  },
  {
    name: "watchdog: safety net on its own crash",
    claim: "a failure while fetching must not skip the alert",
    command: "npm run --silent test:scripts",
    file: "scripts/watchdog.mjs",
    mutate: swap(CRASH_ALERT, "    // mutated: crash alert disabled"),
  },
  {
    name: "watchdog: alert on unhealthy heartbeat",
    claim: "an unhealthy heartbeat must produce an alert",
    command: "npm run --silent test:scripts",
    file: "scripts/watchdog.mjs",
    mutate: swap(UNHEALTHY_ALERT, "    // mutated: alert disabled"),
  },
  {
    name: "watchdog: sendAlert itself",
    claim: "the code that actually delivers, not just the code that decides to",
    command: "npm run --silent test:scripts",
    file: "scripts/watchdog.mjs",
    mutate: swap(SEND_ALERT_BODY, `  return; // mutated: sends nothing\n${SEND_ALERT_BODY}`),
  },
];

const results = [];

for (const testCase of CASES) {
  if (!isClean(testCase.file)) {
    console.log(`${testCase.name.padEnd(40)}SKIPPED: ${testCase.file} has uncommitted changes`);
    results.push({ name: testCase.name, verdict: "SKIPPED" });
    continue;
  }

  const original = read(testCase.file);
  const before = run(testCase.command);

  let mutated = null;
  try {
    mutated = testCase.mutate(original.text);
  } catch {
    mutated = null;
  }
  const applied = typeof mutated === "string" && mutated !== original.text;

  let during = null;
  let changedOnDisk = false;
  if (applied) {
    write(testCase.file, mutated, original.crlf);
    changedOnDisk = !isClean(testCase.file);
    during = run(testCase.command);
  }

  restore(testCase.file);
  const revertedCleanly = isClean(testCase.file);
  const after = run(testCase.command);

  let verdict;
  if (!applied) verdict = "INVALID: mutation not applied";
  else if (!changedOnDisk) verdict = "INVALID: file on disk unchanged";
  else if (!before) verdict = "INVALID: already red before the mutation";
  else if (!revertedCleanly || !after) verdict = "INVALID: did not revert cleanly";
  else if (during) verdict = "DEAD: stayed green with the defect in place";
  else verdict = "ALIVE";

  results.push({ name: testCase.name, claim: testCase.claim, file: testCase.file, verdict });

  console.log(
    testCase.name.padEnd(40) +
      `before=${before ? "green" : "red"}`.padEnd(14) +
      `during=${during === null ? "n/a" : during ? "green" : "red"}`.padEnd(15) +
      `after=${after ? "green" : "red"}`.padEnd(13) +
      verdict
  );
}

const alive = results.filter(r => r.verdict === "ALIVE").length;
const dead = results.filter(r => r.verdict.startsWith("DEAD")).length;
const invalid = results.filter(r => r.verdict.startsWith("INVALID")).length;
const skipped = results.filter(r => r.verdict === "SKIPPED").length;

console.log("");
console.log(`alive ${alive}  dead ${dead}  invalid ${invalid}  skipped ${skipped}`);

if (dead > 0) {
  console.error("");
  console.error("A check that cannot fail is not a check. Fix it or delete it, but do not ship it.");
  process.exitCode = 1;
}
if (invalid > 0 || skipped > 0) {
  console.error("");
  console.error("Some cases did not produce a usable measurement. Treat that as unknown, not as pass.");
  process.exitCode = 1;
}
