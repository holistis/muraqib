import { test } from "node:test";
import assert from "node:assert/strict";
import { assessHeartbeat, isConclusive } from "./check-nightly-heartbeat.mjs";

const NOW = "2026-09-03T06:00:00Z";
const hoursAgo = h => new Date(Date.parse(NOW) - h * 36e5).toISOString();
const run = (conclusion, h) => ({ conclusion, created_at: hoursAgo(h), html_url: `https://x/${h}` });

test("the incident that actually happened: every run cancelled, never one alert", () => {
  // The shape pulled from the host project: two months of nightly runs, all
  // hard-killed by the job timeout, so not one of them could fire anything.
  const runs = Array.from({ length: 30 }, (_, i) => run("cancelled", 24 * (i + 1)));
  const verdict = assessHeartbeat(runs, { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "no-conclusive-run");
});

test("a nightly that reported last night is healthy", () => {
  const verdict = assessHeartbeat([run("success", 6), run("success", 30)], { now: NOW });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, "healthy");
});

test("a red last night is still healthy, because the alert path worked", () => {
  // Failing tests are the system doing its job. The watchdog only cares
  // whether anything can still reach a person.
  const verdict = assessHeartbeat([run("failure", 6), run("success", 30)], { now: NOW });
  assert.equal(verdict.ok, true);
});

test("one cancelled night is noise, not an incident", () => {
  const verdict = assessHeartbeat([run("cancelled", 6), run("success", 30)], { now: NOW });
  assert.equal(verdict.ok, true);
});

test("two cancelled nights in a row is the incident", () => {
  const runs = [run("cancelled", 6), run("cancelled", 30), run("success", 54)];
  const verdict = assessHeartbeat(runs, { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "inconclusive-streak");
  assert.equal(verdict.streak, 2);
});

test("silence past the quiet limit is caught even without a cancel streak", () => {
  // The schedule simply stopped firing, which GitHub does on its own after
  // 60 days without pushes. There is nothing to see in the run list at all,
  // which is precisely why a clock has to be part of the check.
  const verdict = assessHeartbeat([run("success", 100)], { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "stale");
  assert.ok(verdict.quietHours > 48);
});

test("a check red for a week has become furniture", () => {
  const runs = Array.from({ length: 7 }, (_, i) => run("failure", 6 + 24 * i));
  const verdict = assessHeartbeat(runs, { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "furniture");
  assert.equal(verdict.streak, 7);
});

test("six red nights is still a live alert, not furniture", () => {
  const runs = Array.from({ length: 6 }, (_, i) => run("failure", 6 + 24 * i));
  assert.equal(assessHeartbeat(runs, { now: NOW }).ok, true);
});

test("a cancel in the middle does not hide an ongoing failure streak", () => {
  // A cancelled night is not a pass, so it must not reset the counter and
  // buy another week of being ignored.
  const runs = [
    run("failure", 6),
    run("failure", 30),
    run("cancelled", 54),
    run("failure", 78),
    run("failure", 102),
    run("failure", 126),
    run("failure", 150),
    run("failure", 174),
  ];
  const verdict = assessHeartbeat(runs, { now: NOW });
  assert.equal(verdict.code, "furniture");
  assert.equal(verdict.streak, 7);
});

test("a long silence breaks the streak instead of being bridged", () => {
  // The real history that prompted this: a burst of failures in June, then two
  // months of cancelled runs, then one fresh failure. Skipping inconclusive
  // runs without limit would splice those together and report "failed 8 runs in
  // a row", which never happened. The message states a fact, so the counter has
  // to be able to stand behind it.
  const runs = [
    run("failure", 6),
    ...Array.from({ length: 20 }, (_, i) => run("cancelled", 30 + 24 * i)),
    ...Array.from({ length: 7 }, (_, i) => run("failure", 520 + 24 * i)),
  ];
  const verdict = assessHeartbeat(runs, { now: NOW });
  // The head of the list is a real report, so the alert path is live. The old
  // failures on the far side of the gap are history, not a current streak.
  assert.equal(verdict.ok, true);
});

test("a short gap is still bridged, so a stale check cannot hide behind one cancel", () => {
  const runs = [
    run("failure", 6),
    run("cancelled", 30),
    ...Array.from({ length: 6 }, (_, i) => run("failure", 54 + 24 * i)),
  ];
  const verdict = assessHeartbeat(runs, { now: NOW });
  assert.equal(verdict.code, "furniture");
  assert.equal(verdict.streak, 7);
});

test("no runs at all is reported as never-ran, not as healthy", () => {
  const verdict = assessHeartbeat([], { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "never-ran");
});

test("an unreadable history fails closed", () => {
  // A watchdog that cannot see must never report all-clear. That is the same
  // rule the sensitive-paths guard follows for an unparseable pattern.
  assert.equal(assessHeartbeat(null, { now: NOW }).ok, false);
  assert.equal(assessHeartbeat(undefined, { now: NOW }).code, "unreadable");
});

test("a run still in progress counts as inconclusive, not as a pass", () => {
  assert.equal(isConclusive({ conclusion: null }), false);
  assert.equal(isConclusive({ conclusion: "timed_out" }), false);
  assert.equal(isConclusive({ conclusion: "skipped" }), false);
  assert.equal(isConclusive({ conclusion: "success" }), true);
  assert.equal(isConclusive({ conclusion: "failure" }), true);
});

test("input arriving out of order is sorted before it is judged", () => {
  const runs = [run("cancelled", 54), run("success", 6), run("cancelled", 30)];
  assert.equal(assessHeartbeat(runs, { now: NOW }).ok, true);
});

test("thresholds are tunable for a project that does not run nightly", () => {
  const runs = [run("success", 100)];
  assert.equal(assessHeartbeat(runs, { now: NOW, maxQuietHours: 168 }).ok, true);
});
