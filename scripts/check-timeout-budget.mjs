#!/usr/bin/env node
/**
 * Fails if the nightly run can be hard-killed by the runner before Playwright
 * has a chance to stop itself and report.
 *
 * Why this matters: a job's `timeout-minutes` is a kill, not a failure. When
 * the runner hits it, the test process is stopped mid-flight, Playwright
 * writes no report, and GitHub records the run's conclusion as "cancelled"
 * rather than "failure". Every step that keys off the tests step reporting
 * failure is then skipped: no Claude fix workflow, no failing job, no email.
 * The run is indistinguishable from a night where nothing happened.
 *
 * This repo shipped that exact bug in its first commit and it went unnoticed
 * for months on the project running it. The template's defaults (workers: 1,
 * fullyParallel: false, one CI retry) put a suite of a few hundred tests over
 * a 20 minute job timeout, so from the night the suite crossed that line, the
 * nightly was cancelled every single night. 81 of 164 runs on the host project
 * ended "cancelled", 60-plus of them consecutively, and because a cancelled
 * run fires no alert, nobody was told once.
 *
 * The fix is ordering, not a bigger number: playwright.config.ts sets
 * globalTimeout below the job's timeout-minutes, so Playwright stops itself
 * first, exits non-zero, and still writes results.json. A slow suite then
 * reads as a loud failure instead of silence. This check exists so those two
 * numbers can never drift back into the wrong order unnoticed.
 *
 * Run: node scripts/check-timeout-budget.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const WORKFLOW_FILE = ".github/workflows/muraqib-nightly.yml";
const CONFIG_FILE = "playwright.config.ts";
const JOB_NAME = "test";

/**
 * Minutes that must remain between globalTimeout and the job's timeout-minutes.
 *
 * The test run is not the only thing inside the job. Checkout, npm install,
 * a cold `playwright install --with-deps chromium`, and the two artifact
 * uploads all sit around it, and the uploads specifically run after the tests
 * finish. If globalTimeout were set right up against the job timeout, a slow
 * browser install at the start would eat the margin and the runner would kill
 * the job during the upload, losing the report that makes the failure
 * actionable. Five minutes is the floor, not a recommendation.
 */
const REQUIRED_BUFFER_MINUTES = 5;

/**
 * Pulls the globalTimeout, in minutes, out of the Playwright config source.
 *
 * Deliberately narrow. It recognizes exactly the shape this repo uses,
 * a named constant with a numeric default, multiplied out to milliseconds:
 *
 *   const GLOBAL_TIMEOUT_MINUTES = Number(process.env.X ?? 35);
 *   ...
 *   globalTimeout: GLOBAL_TIMEOUT_MINUTES * 60 * 1000,
 *
 * Anything else returns null, which the caller treats as a failure rather
 * than as "probably fine". A checker whose whole job is to prove an ordering
 * must not pass a file it could not actually read. That is the same
 * fail-closed rule the sensitive-paths guard follows for an unparseable
 * pattern.
 */
export function readGlobalTimeoutMinutes(configSource) {
  const usage = /globalTimeout\s*:\s*([A-Za-z_$][\w$]*)\s*\*\s*60\s*\*\s*1000/.exec(configSource);
  if (!usage) return null;
  const constName = usage[1];

  // Regex literals, not `new RegExp` with an interpolated name: building a
  // pattern from a string means every backslash has to survive one extra
  // round of escaping, and a single lost one silently turns \s into a literal
  // "s" that still compiles and then never matches. Scan every declaration
  // and compare the captured name instead.
  const declarations = configSource.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*Number\(\s*process\.env\.[A-Za-z_][\w]*\s*\?\?\s*(\d+(?:\.\d+)?)\s*\)/g
  );
  for (const declaration of declarations) {
    if (declaration[1] !== constName) continue;
    const minutes = Number(declaration[2]);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  }
  return null;
}

/**
 * Reads the job's timeout-minutes. Returns null when it is absent or is not a
 * plain positive number, for instance when it is written as an expression the
 * runner resolves at run time. Both cases are unprovable here, so both fail.
 */
export function readJobTimeoutMinutes(workflowYaml, jobName) {
  const doc = parseDocument(workflowYaml);
  const value = doc.getIn(["jobs", jobName, "timeout-minutes"]);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function findTimeoutBudgetProblems(workflowYaml, configSource, opts = {}) {
  const workflowPath = opts.workflowPath || WORKFLOW_FILE;
  const configPath = opts.configPath || CONFIG_FILE;
  const jobName = opts.jobName || JOB_NAME;
  const buffer = opts.requiredBufferMinutes ?? REQUIRED_BUFFER_MINUTES;
  const problems = [];

  const jobTimeout = readJobTimeoutMinutes(workflowYaml, jobName);
  if (jobTimeout === null) {
    problems.push({
      label: `${workflowPath} job "${jobName}"`,
      message:
        "no plain numeric timeout-minutes found. Without one the job inherits GitHub's 6 hour default, so a hung suite burns six hours of runner time and still ends as a cancel rather than a failure. Set an explicit number above globalTimeout.",
    });
  }

  const globalTimeout = readGlobalTimeoutMinutes(configSource);
  if (globalTimeout === null) {
    problems.push({
      label: configPath,
      message:
        "no globalTimeout in the recognized form `globalTimeout: SOME_CONST * 60 * 1000`, with SOME_CONST declared as `Number(process.env.X ?? <number>)`. Either it is missing, in which case a slow suite runs until the runner kills it and reports nothing, or it is written in a shape this check cannot verify, which is treated the same way on purpose.",
    });
  }

  if (jobTimeout === null || globalTimeout === null) return problems;

  if (globalTimeout >= jobTimeout) {
    problems.push({
      label: `${configPath} vs ${workflowPath}`,
      message: `globalTimeout is ${globalTimeout} min and the job's timeout-minutes is ${jobTimeout} min. The runner would kill the job before Playwright ever stops itself, so an over-running suite reports "cancelled" with no report and fires no alert. globalTimeout must be lower.`,
    });
    return problems;
  }

  if (jobTimeout - globalTimeout < buffer) {
    problems.push({
      label: `${configPath} vs ${workflowPath}`,
      message: `only ${jobTimeout - globalTimeout} min between globalTimeout (${globalTimeout}) and the job timeout (${jobTimeout}). At least ${buffer} min is required so the install steps before the run and the artifact uploads after it cannot push the job into a hard kill, which would throw away the report that makes the failure actionable.`,
    });
  }

  return problems;
}

function main() {
  const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

  let workflowYaml;
  let configSource;
  try {
    workflowYaml = readFileSync(join(repoRoot, WORKFLOW_FILE), "utf8");
    configSource = readFileSync(join(repoRoot, CONFIG_FILE), "utf8");
  } catch (err) {
    console.error(`FAILED: could not read a file this check needs. ${err.message}`);
    process.exit(1);
  }

  const problems = findTimeoutBudgetProblems(workflowYaml, configSource);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`SILENT-CANCEL RISK: ${problem.label}`);
      console.error(`  ${problem.message}`);
    }
    process.exit(1);
  }

  const globalTimeout = readGlobalTimeoutMinutes(configSource);
  const jobTimeout = readJobTimeoutMinutes(workflowYaml, JOB_NAME);
  console.log(
    `OK: Playwright stops itself at ${globalTimeout} min, ${jobTimeout - globalTimeout} min before the runner's ${jobTimeout} min kill, so an over-running suite fails loudly instead of going silent.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
