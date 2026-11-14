#!/usr/bin/env node
/**
 * Fails if the nightly installs Playwright browsers on `ubuntu-latest`.
 *
 * `playwright install` downloads the browser build for the Ubuntu release it
 * finds, and a Playwright version has builds only for the releases it knew when
 * it shipped. `ubuntu-latest` is a label GitHub moves to each new Ubuntu LTS
 * (https://github.com/actions/runner-images/issues/14748), so a nightly that
 * installs a browser on it can end at the install step on the day the label
 * moves, before it runs one test. No alert that hangs off a test run can fire
 * then. On the night of 8 November 2026 the host project's nightly ended that
 * way on Ubuntu 26.04 with Playwright 1.60.0. The measurements are in
 * LESSONS.md, 2026-11-13.
 *
 * What it recognizes: a job with a step whose run body contains
 * `playwright install` (not `install-deps`, which only warns on a release
 * Playwright does not know), on a runner given as a literal label, a list of
 * labels, `labels:` inside an object, or `${{ matrix.key }}` with literal
 * values. A `runs-on` list that itself names `self-hosted` is the owner's own
 * machine and is left alone. A matrix value named `self-hosted` is not, because
 * each matrix leg runs on one label. Anything else it cannot read counts as a
 * problem, never as a pass, the same fail-closed rule as the other checks.
 *
 * What it does not see: a job that runs in a `container:` is skipped, because
 * its operating system comes from the image tag. A browser install behind an
 * npm script, done by an action, or done by a dependency's postinstall (such as
 * `playwright-chromium`), and a job that calls a reusable workflow, are not
 * seen. A matrix `exclude` is not applied, so a floating value that is
 * excluded is still reported.
 *
 * Run: node scripts/check-runner-pin.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const WORKFLOW_FILE = ".github/workflows/muraqib-nightly.yml";

/** The label GitHub moves to the newest Ubuntu LTS. */
const FLOATING_LABEL = /^ubuntu-latest$/i;

/** A run body that downloads Playwright browsers. `install-deps` alone does not. */
const BROWSER_INSTALL = /\bplaywright(?:-core)?(?:@\S{1,64})?\s+install(?!-deps\b)\b/;

const MATRIX_REFERENCE = /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every literal value a matrix key can take, or null when that cannot be known. */
function matrixValues(job, key) {
  const matrix = job.strategy?.matrix;
  if (!isPlainObject(matrix)) return null;

  const values = [];
  if (key in matrix) {
    if (!Array.isArray(matrix[key])) return null;
    values.push(...matrix[key]);
  }
  if (Array.isArray(matrix.include)) {
    for (const entry of matrix.include) {
      if (isPlainObject(entry) && key in entry) values.push(entry[key]);
    }
  } else if (matrix.include !== undefined) {
    return null;
  }

  const literal = values.every(value => typeof value === "string" && !value.includes("${{"));
  return values.length > 0 && literal ? values : null;
}

/** The runner labels a job asks for, or the reason they cannot be read. */
function runnerLabels(job) {
  const value = job["runs-on"];
  if (value === undefined || value === null) return { reason: "it has no runs-on" };

  let entries;
  if (Array.isArray(value)) {
    entries = value;
  } else if (isPlainObject(value)) {
    // A runner group with no labels is a pool of the owner's own machines.
    if (value.labels === undefined) return { labels: [], selfHosted: false };
    entries = Array.isArray(value.labels) ? value.labels : [value.labels];
  } else {
    entries = [value];
  }

  // Judged on what the file says, before any matrix is expanded. A list that
  // names self-hosted is one machine the owner chose. A matrix value of that
  // name is only one leg among others, and the other legs still need a look.
  const selfHosted = entries.some(entry => typeof entry === "string" && entry.trim().toLowerCase() === "self-hosted");

  const labels = [];
  for (const entry of entries) {
    if (typeof entry !== "string") return { reason: "its runs-on holds something that is not a label" };

    const reference = MATRIX_REFERENCE.exec(entry.trim());
    if (reference) {
      const values = matrixValues(job, reference[1]);
      if (!values) return { reason: `its runs-on is ${entry.trim()} and the matrix values cannot be listed` };
      labels.push(...values);
    } else if (entry.includes("${{")) {
      return { reason: `its runs-on is the expression ${entry.trim()}` };
    } else {
      labels.push(entry);
    }
  }
  return { labels, selfHosted };
}

/**
 * Looks at every job that installs Playwright browsers on the runner itself.
 * Returns the problems found and how many jobs it looked at, so a caller can
 * tell "all pinned" from "there was nothing to look at".
 */
export function inspectRunners(workflowYaml, opts = {}) {
  const workflowPath = opts.workflowPath || WORKFLOW_FILE;
  const problems = [];
  let installingJobs = 0;

  const doc = parseDocument(workflowYaml);
  if (doc.errors.length > 0) {
    const first = doc.errors[0].message.split("\n")[0];
    problems.push({
      label: workflowPath,
      message: `could not be parsed as YAML (${first}), so its runner could not be checked.`,
    });
    return { problems, installingJobs };
  }

  let parsed;
  try {
    parsed = doc.toJS();
  } catch (err) {
    problems.push({
      label: workflowPath,
      message: `could not be read (${err.message.split("\n")[0]}), so its runner could not be checked.`,
    });
    return { problems, installingJobs };
  }

  const jobs = isPlainObject(parsed) ? parsed.jobs : undefined;
  if (!isPlainObject(jobs) || Object.keys(jobs).length === 0) {
    problems.push({ label: workflowPath, message: "has no jobs this check can read, so its runner could not be checked." });
    return { problems, installingJobs };
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!isPlainObject(job) || !Array.isArray(job.steps)) continue;
    if (job.container !== undefined) continue;

    const installs = job.steps.some(
      step => isPlainObject(step) && typeof step.run === "string" && BROWSER_INSTALL.test(step.run)
    );
    if (!installs) continue;
    installingJobs += 1;

    const label = `${workflowPath} job "${jobName}"`;
    const runner = runnerLabels(job);
    if (runner.reason) {
      problems.push({
        label,
        message: `installs Playwright browsers but ${runner.reason}, so this check cannot tell whether the machine can change under it. Use a literal label such as ubuntu-24.04, or a matrix whose values are literal labels.`,
      });
      continue;
    }

    // A list that itself names self-hosted is a machine its owner chose, whatever else it says.
    if (runner.selfHosted) continue;

    const floating = runner.labels.find(candidate => FLOATING_LABEL.test(candidate.trim()));
    if (floating !== undefined) {
      problems.push({
        label,
        message: `installs Playwright browsers on ${floating}. GitHub moves that label to each new Ubuntu LTS, and a Playwright version that does not support the new release yet fails at the install step ("Playwright does not support chromium on ubuntu26.04-x64"), so the nightly ends before its first test. Pin the runner, for example runs-on: ubuntu-24.04, and change the pin together with a Playwright upgrade. The incident and the measurements: https://github.com/holistis/muraqib/blob/main/LESSONS.md (2026-11-13).`,
      });
    }
  }

  return { problems, installingJobs };
}

function main() {
  const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

  let workflowYaml;
  try {
    workflowYaml = readFileSync(join(repoRoot, WORKFLOW_FILE), "utf8");
  } catch (err) {
    console.error(`FAILED: could not read a file this check needs. ${err.message}`);
    process.exit(1);
  }

  const { problems, installingJobs } = inspectRunners(workflowYaml);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`FLOATING-RUNNER RISK: ${problem.label}`);
      console.error(`  ${problem.message}`);
    }
    process.exit(1);
  }

  if (installingJobs === 0) {
    console.error(
      `FAILED: no job in ${WORKFLOW_FILE} installs Playwright browsers, so there was nothing to check. If the install moved behind a script, this check has to learn that shape before it can vouch for the file.`
    );
    process.exit(1);
  }

  console.log(`OK: ${installingJobs} job(s) install Playwright browsers and every one runs on a pinned runner.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
