import { test } from "node:test";
import assert from "node:assert/strict";
import { RESULTS_ARTIFACT, assessHeartbeat, assessTestsRan, newestConclusiveRun } from "./check-nightly-heartbeat.mjs";

const NOW = "2026-11-09T08:00:00Z";
const hoursAgo = h => new Date(Date.parse(NOW) - h * 36e5).toISOString();
const run = (conclusion, h, event = "schedule") => ({ conclusion, created_at: hoursAgo(h), html_url: `https://x/${h}`, event });

test("the night that happened: red at the install, and the heartbeat alone calls it healthy", () => {
  // Seven nights of this ran on the host project before anything spoke.
  const runs = Array.from({ length: 6 }, (_, i) => run("failure", 6 + 24 * i));
  assert.equal(assessHeartbeat(runs, { now: NOW }).ok, true, "this is the gap: conclusions alone cannot tell");

  const verdict = assessTestsRan(newestConclusiveRun(runs), {
    artifacts: ["playwright-report"],
    failedStep: "Install Playwright Chromium",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "tests-never-ran");
  assert.match(verdict.message, /Install Playwright Chromium/);
  assert.equal(verdict.lastRunUrl, "https://x/6");
});

test("a failed night that left test results is the alert path working", () => {
  const verdict = assessTestsRan(run("failure", 6), { artifacts: ["playwright-report", RESULTS_ARTIFACT] });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, "tests-ran");
});

test("a failed night with no artifacts at all did not run its tests", () => {
  assert.equal(assessTestsRan(run("failure", 6), { artifacts: [] }).code, "tests-never-ran");
});

test("without a failed step the message still says what happened and names none", () => {
  const verdict = assessTestsRan(run("failure", 6), { artifacts: [], failedStep: null });
  assert.equal(verdict.ok, false);
  assert.doesNotMatch(verdict.message, /first step that failed/);
});

test("artifacts that cannot be read fail closed, for a null list and for no answer at all", () => {
  assert.equal(assessTestsRan(run("failure", 6), { artifacts: null }).code, "results-unreadable");
  assert.equal(assessTestsRan(run("failure", 6), null).code, "results-unreadable");
  assert.equal(assessTestsRan(run("failure", 6), undefined).ok, false);
});

test("a green night has nothing to explain and never needs results", () => {
  const verdict = assessTestsRan(run("success", 6), null);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, "not-applicable");
});

test("no finished run at all is left to the heartbeat, not decided here", () => {
  assert.equal(assessTestsRan(null, null).ok, true);
});

test("the artifact name can be changed for a nightly that renamed it", () => {
  const renamed = { artifacts: ["my-results"] };
  assert.equal(assessTestsRan(run("failure", 6), renamed, { resultsArtifact: "my-results" }).ok, true);
  assert.equal(assessTestsRan(run("failure", 6), renamed).ok, false, "the default name must not match a renamed artifact");
  assert.equal(assessTestsRan(run("failure", 6), { artifacts: [RESULTS_ARTIFACT] }, { resultsArtifact: "my-results" }).ok, false);
});

test("only the exact artifact name counts, not a name that contains it", () => {
  const verdict = assessTestsRan(run("failure", 6), { artifacts: [`${RESULTS_ARTIFACT}-old`, `old-${RESULTS_ARTIFACT}`] });
  assert.equal(verdict.ok, false);
});

test("newestConclusiveRun picks the newest finished run whatever order the list is in", () => {
  const runs = [run("success", 50), run("failure", 6), run("success", 30)];
  assert.equal(newestConclusiveRun(runs).html_url, "https://x/6");
});

test("newestConclusiveRun skips a cancelled night and does not mutate its input", () => {
  const runs = [run("cancelled", 6), run("failure", 30), run("success", 54)];
  const copy = [...runs];
  assert.equal(newestConclusiveRun(runs).html_url, "https://x/30");
  assert.deepEqual(runs, copy);
});

test("newestConclusiveRun ignores push runs when scheduled ones exist", () => {
  const runs = [run("failure", 2, "push"), run("success", 30, "schedule")];
  assert.equal(newestConclusiveRun(runs).html_url, "https://x/30");
});

test("newestConclusiveRun has nothing to say about an empty list, an unreadable one or only cancelled runs", () => {
  assert.equal(newestConclusiveRun([]), null);
  assert.equal(newestConclusiveRun(null), null);
  assert.equal(newestConclusiveRun([run("cancelled", 6), run("cancelled", 30)]), null);
});
