#!/usr/bin/env node
/**
 * Answers one question about the nightly run: is anyone still being told
 * anything?
 *
 * Every alert Muraqib sends is triggered by a test run that finished and
 * reported a result. That leaves a whole class of failure with no alert at
 * all, because the trigger itself never fires:
 *
 *   - the runner hard-kills the job on timeout-minutes, so the run ends
 *     "cancelled" and every downstream step is skipped
 *   - the schedule stops firing, which GitHub does silently on repos with no
 *     pushes for 60 days
 *   - a required secret expires and the job dies before the tests
 *   - someone disables the workflow and forgets
 *
 * In all four the dashboard is calm, the inbox is empty, and the app is
 * unwatched. That is worse than having no QA, because you believe you have
 * some. The host project running this template sat in the first case for over
 * two months, 60-plus consecutive cancelled nights, without one alert.
 *
 * The other half of the same problem is a check that has been red for a week.
 * It stops being an alert and becomes furniture: everyone has learned to
 * scroll past it. Both shapes are handled here, because both mean the guard
 * is no longer doing anything for you.
 *
 * This module is pure. It takes a list of runs and a clock, and returns a
 * verdict. The workflow does the fetching and the emailing.
 */

/** GitHub conclusions that mean the run actually finished and said something. */
const CONCLUSIVE = new Set(["success", "failure"]);

/**
 * Events that mean somebody, or a schedule, deliberately asked for this run.
 *
 * Runs triggered by a push or a pull request are a different animal, and
 * counting them here produces false alarms. A workflow with
 * `concurrency: cancel-in-progress: true`, which is a common and recommended
 * setup, cancels its own older runs every time someone pushes again. Those
 * cancellations are the feature working. Reading them as "the nightly went
 * quiet" would flag healthy repositories, and a check that cries wolf gets
 * muted, which is the exact failure this file exists to prevent.
 *
 * Found by running this against 40 public repositories with a nightly
 * Playwright job. One of them, openobserve, came back as an inconclusive
 * streak on 18 cancelled runs. Every one was a pull_request run cancelled by
 * its concurrency group, with durations from 28 seconds to 32 minutes, and
 * that workflow's cron was commented out. Nothing was wrong there at all.
 */
const DELIBERATE_EVENTS = new Set(["schedule", "workflow_dispatch"]);

/**
 * Events that are ordinary CI rather than a timer, and are excluded on purpose.
 * Separated from "unrecognized" so the two can be treated differently below.
 */
const CI_EVENTS = new Set(["push", "pull_request", "pull_request_target", "merge_group"]);

/**
 * Narrows a run list to the runs this check is actually about.
 *
 * Three cases, and the third one is why this is not a one-liner:
 *
 * 1. There are deliberate runs. Judge those.
 * 2. There are none, and everything left is ordinary CI. Then this workflow
 *    has not run on a timer recently at all, which is a real thing to say but
 *    a different thing from "the nightly went quiet". Falling back to judging
 *    the CI runs produced a false alarm on a repo whose job is deliberately
 *    skipped upstream and only meant to run on forks.
 * 3. There are none, and the events are simply not recognized. Fall back and
 *    judge everything, because reporting nothing at a project whose runs carry
 *    an unfamiliar event would be the worse error.
 */
export function deliberateRuns(runs) {
  const deliberate = runs.filter(run => !run.event || DELIBERATE_EVENTS.has(run.event));
  if (deliberate.length > 0) return deliberate;
  if (runs.every(run => CI_EVENTS.has(run.event))) return [];
  return runs;
}

export function isConclusive(run) {
  return CONCLUSIVE.has(run?.conclusion);
}

/**
 * @param {Array<{conclusion: string|null, created_at: string, html_url?: string}>} runs
 *        Nightly runs, newest first, as returned by the Actions API.
 * @param {object} opts
 * @param {Date|string|number} opts.now
 * @param {number} [opts.maxQuietHours=48] How long the nightly may go without
 *        producing any conclusive result before that is itself an incident.
 *        The default is two nights, so one skipped or flaky night is noise and
 *        two in a row is a signal.
 * @param {number} [opts.maxConsecutiveInconclusive=2] How many cancelled or
 *        timed-out runs in a row are tolerated before alerting, independent of
 *        the clock. Catches a fast cadence going quiet sooner than the hours
 *        rule would.
 * @param {number} [opts.maxConsecutiveFailures=7] How many failing nights in a
 *        row before the check counts as furniture rather than an alert.
 */
export function assessHeartbeat(runs, opts = {}) {
  const now = new Date(opts.now ?? Date.now());
  const maxQuietHours = opts.maxQuietHours ?? 48;
  const maxConsecutiveInconclusive = opts.maxConsecutiveInconclusive ?? 2;
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 7;

  if (!Array.isArray(runs)) {
    return {
      ok: false,
      code: "unreadable",
      message:
        "The watchdog could not read the nightly's run history. Treating that as unhealthy on purpose: a watchdog that cannot see is not evidence that everything is fine.",
    };
  }

  if (runs.length === 0) {
    return {
      ok: false,
      code: "never-ran",
      message:
        "The nightly workflow has no runs at all. Either it has never been triggered, or GitHub has disabled the schedule, which it does silently on repositories with no activity for 60 days. Open the Actions tab and run it once by hand to switch the schedule back on.",
    };
  }

  const deliberate = deliberateRuns([...runs]);
  if (deliberate.length === 0) {
    return {
      ok: false,
      code: "no-scheduled-runs",
      message: `All ${runs.length} recent runs of this workflow were triggered by a push or a pull request, none by a schedule or a manual dispatch. Nothing here runs on a timer, so there is no nightly to be quiet. If that is deliberate, point the watchdog at a different workflow.`,
      lastRunUrl: runs[0]?.html_url,
    };
  }

  const ordered = deliberate.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const lastConclusive = ordered.find(isConclusive);
  if (!lastConclusive) {
    return {
      ok: false,
      code: "no-conclusive-run",
      message: `None of the last ${ordered.length} nightly runs finished with a pass or fail. Every one was cancelled, timed out, or is still going. No alert can fire from a run that never reports, so the app has been unwatched for all of them.`,
      lastRunUrl: ordered[0].html_url,
    };
  }

  const quietHours = (now.getTime() - new Date(lastConclusive.created_at).getTime()) / 36e5;

  // The streak check runs before the clock check on purpose. When runs are
  // happening but none of them report, both rules are true at once, and
  // "your last three runs were cancelled" names the cause where "nothing has
  // reported in 54 hours" only names the symptom. The clock is the fallback
  // for the case with no runs to point at, such as a schedule GitHub has
  // quietly stopped firing.
  let inconclusiveStreak = 0;
  for (const run of ordered) {
    if (isConclusive(run)) break;
    inconclusiveStreak += 1;
  }
  if (inconclusiveStreak >= maxConsecutiveInconclusive) {
    return {
      ok: false,
      code: "inconclusive-streak",
      message: `The last ${inconclusiveStreak} nightly runs ended without a pass or fail, usually a cancel from the job's timeout-minutes. A cancelled run skips the fix workflow, the job failure and the email, so this is exactly the shape that goes unnoticed for months. Check whether the suite has outgrown its time budget.`,
      lastRunUrl: ordered[0].html_url,
      streak: inconclusiveStreak,
    };
  }

  if (quietHours > maxQuietHours) {
    return {
      ok: false,
      code: "stale",
      message: `The last nightly run to report anything was ${Math.floor(quietHours)} hours ago, past the ${maxQuietHours} hour limit. Since then the app has not been checked, and because nothing failed, nothing told you.`,
      lastRunUrl: lastConclusive.html_url,
      quietHours,
    };
  }

  // A cancelled night is not a pass, so one or two of them in the middle must
  // not reset this counter and buy another week of being ignored. But skipping
  // them without limit is wrong in the other direction: it would join failures
  // on either side of a two month silence and then report them as having
  // happened "in a row", which is simply not true. The message here makes a
  // factual claim, so the counter has to be able to back it up.
  //
  // The tolerance is the same one used for the head-of-list streak above. Past
  // it, the run of failures is genuinely broken by a gap and stops counting.
  let failureStreak = 0;
  let bridged = 0;
  for (const run of ordered) {
    if (!isConclusive(run)) {
      bridged += 1;
      if (bridged > maxConsecutiveInconclusive) break;
      continue;
    }
    if (run.conclusion !== "failure") break;
    bridged = 0;
    failureStreak += 1;
  }
  if (failureStreak >= maxConsecutiveFailures) {
    return {
      ok: false,
      code: "furniture",
      message: `The nightly has failed ${failureStreak} runs in a row. A check that stays red this long has stopped being an alert and has become part of the scenery. Either the failure is real and is being lived with, or the test is wrong and is training everyone to ignore the one thing that is supposed to interrupt them.`,
      lastRunUrl: ordered[0].html_url,
      streak: failureStreak,
    };
  }

  return {
    ok: true,
    code: "healthy",
    message: `The nightly reported ${lastConclusive.conclusion} ${Math.floor(quietHours)} hours ago. The alert path is live.`,
    lastRunUrl: lastConclusive.html_url,
  };
}

/** The artifact the nightly uploads when its tests left results behind. */
export const RESULTS_ARTIFACT = "test-results-json";

/**
 * The newest nightly run that finished with a pass or a fail, among the runs a
 * timer or a person asked for. This is the run a morning check should judge.
 */
export function newestConclusiveRun(runs) {
  if (!Array.isArray(runs)) return null;
  const ordered = deliberateRuns([...runs]).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  return ordered.find(isConclusive) ?? null;
}

/**
 * A red night only means "the alert path worked" when the tests ran and left
 * results behind. assessHeartbeat treats every failure that way. That holds for
 * failing tests and is wrong for a job that dies before them: an install that
 * finds no browser build for the runner, an expired secret, a failed checkout.
 * Those nights end red without one test running, so the fix workflow and its
 * email, which hang off a finished test run, never fire. assessHeartbeat counts
 * such a night as one that reported and stays quiet until the failures reach
 * seven in a row (see LESSONS.md, 2026-11-13).
 *
 * The evidence is the results artifact the nightly uploads after its tests, as
 * the template does. A failed run without it did not finish its tests. A
 * nightly that uploads its results under another name has to say so
 * (MURAQIB_RESULTS_ARTIFACT, read in watchdog.mjs), or every failed night looks
 * like this.
 *
 * @param {{conclusion: string|null, html_url?: string}|null} run
 *        The newest conclusive run, from newestConclusiveRun.
 * @param {{artifacts: string[]|null, failedStep?: string|null}|null} results
 *        What the Actions API says about that run: the names of its artifacts
 *        that have not expired, and the first step that failed. Null artifacts
 *        means the API could not be read.
 * @param {object} [opts]
 * @param {string} [opts.resultsArtifact] Defaults to RESULTS_ARTIFACT.
 */
export function assessTestsRan(run, results, opts = {}) {
  const resultsArtifact = opts.resultsArtifact || RESULTS_ARTIFACT;

  if (!run || run.conclusion !== "failure") {
    return {
      ok: true,
      code: "not-applicable",
      message: "The newest finished nightly run did not fail, so there is nothing to check about its tests.",
    };
  }

  if (!results || !Array.isArray(results.artifacts)) {
    return {
      ok: false,
      code: "results-unreadable",
      message:
        "The newest finished nightly run failed, and the watchdog could not read its artifacts to tell whether the tests ran. Treating that as unhealthy on purpose: a failed night that cannot be told apart from one where no test ran is not evidence that anything was checked.",
      lastRunUrl: run.html_url,
    };
  }

  if (results.artifacts.includes(resultsArtifact)) {
    return {
      ok: true,
      code: "tests-ran",
      message: `The newest finished nightly run failed after its tests ran and left ${resultsArtifact}, so the test-failure alerts had their chance.`,
      lastRunUrl: run.html_url,
    };
  }

  const step = results.failedStep ? ` The first step that failed was "${results.failedStep}".` : "";
  return {
    ok: false,
    code: "tests-never-ran",
    message: `The newest finished nightly run failed without leaving ${resultsArtifact}, so it ended before its tests finished.${step} Every alert that hangs off a finished test run, the fix workflow and the email that comes with it, stayed quiet for this run, so nothing has told you that your app was not checked that night. If your nightly uploads its test results under another name, set MURAQIB_RESULTS_ARTIFACT to that name, otherwise every failed night looks like this.`,
    lastRunUrl: run.html_url,
  };
}
