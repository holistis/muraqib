#!/usr/bin/env node
/**
 * Fails if the auto-merge-guard's `guard` job can report conclusion SKIPPED.
 *
 * Why this matters: a job-level `if:` that evaluates false makes the whole
 * check run report SKIPPED. GitHub's required-status-checks feature does not
 * treat a skipped check as satisfying the requirement, so a job configured
 * as a required check (this repo's "Muraqib Auto-Merge Guard / guard", see
 * main's branch protection rules) with a job-level `if:` permanently blocks
 * every PR that doesn't hit the `if:`'s true branch, not just the
 * auto-merge PRs it exists to gate. This repo shipped that exact bug on
 * 2026-08-29: PR #11 (a plain docs change, no auto-merge involved) stayed
 * BLOCKED across 6 polls with every real check already passing, because
 * `guard` reported SKIPPED. The fix moves the condition to individual
 * steps instead, so the job always finishes with a real success/failure
 * conclusion whether or not auto-merge is enabled on the PR. This check
 * exists so the job-level version can't come back unnoticed.
 *
 * Run: node scripts/check-required-check-not-skippable.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const WORKFLOW_FILE = ".github/workflows/auto-merge-guard.yml";
const JOB_NAME = "guard";

/**
 * Crude complement check: true if swapping every `==` for `!=` (and vice
 * versa) in `a` produces exactly `b`, ignoring whitespace differences. This
 * only recognizes the specific shape this repo actually uses (a pair of
 * steps gated on `<expr> == null` / `<expr> != null`), not general logical
 * negation. Good enough to prove "something always runs" for that shape;
 * anything cleverer than that still falls through to the human-review flag.
 */
function isLikelyComplementOf(a, b) {
  const normalize = s => s.replace(/\s+/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  const swapped = na.replace(/==|!=/g, m => (m === "==" ? "!=" : "=="));
  return swapped === nb;
}

/**
 * Pure function, exported for the test suite: given the workflow file's raw
 * YAML text, returns a list of problems (empty array = clean).
 */
export function findSkippableRequiredCheck(content, label = "<inline>") {
  const doc = parseDocument(content, { prettyErrors: true });
  if (doc.errors.length) {
    return [{ label, message: `YAML parse error: ${doc.errors.map(e => e.message).join("; ")}` }];
  }

  const data = doc.toJS();
  const job = data?.jobs?.[JOB_NAME];
  if (!job) {
    return [{ label, message: `job "${JOB_NAME}" not found` }];
  }

  const problems = [];

  if (Object.prototype.hasOwnProperty.call(job, "if")) {
    problems.push({
      label,
      message: `job "${JOB_NAME}" has a job-level "if:" (${JSON.stringify(job.if)}). This makes the check run report SKIPPED instead of success/failure whenever the condition is false. Move the condition to individual steps instead.`,
    });
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (steps.length === 0) {
    problems.push({ label, message: `job "${JOB_NAME}" has no steps to check` });
  } else {
    const hasUnconditionalStep = steps.some(step => !Object.prototype.hasOwnProperty.call(step, "if"));
    const conditions = steps.map(step => step.if).filter(cond => typeof cond === "string");
    const hasComplementaryPair = conditions.some((a, i) =>
      conditions.some((b, j) => i !== j && isLikelyComplementOf(a, b))
    );

    if (!hasUnconditionalStep && !hasComplementaryPair) {
      // Neither an unconditional step nor a recognized complementary pair
      // (e.g. `<expr> == null` alongside `<expr> != null`) was found. That
      // does not prove the job WILL skip, only that this check cannot prove
      // it won't. Flag it so a human verifies by hand.
      problems.push({
        label,
        message: `job "${JOB_NAME}" has no unconditional step and no recognized complementary if: pair. Every step is conditionally gated in a way this check cannot prove is exhaustive. Verify by hand that at least one step always runs, otherwise the job can still report SKIPPED.`,
      });
    }
  }

  return problems;
}

function main() {
  const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
  const fullPath = join(repoRoot, WORKFLOW_FILE);

  let content;
  try {
    content = readFileSync(fullPath, "utf8");
  } catch {
    console.error(`FAILED: could not read ${fullPath}. Fix the path or the invocation.`);
    process.exit(1);
  }

  const problems = findSkippableRequiredCheck(content, fullPath);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`SKIPPABLE-REQUIRED-CHECK RISK: ${problem.label}`);
      console.error(`  ${problem.message}`);
    }
    process.exit(1);
  }

  console.log(`OK: "${JOB_NAME}" job in ${WORKFLOW_FILE} has no job-level "if:" and has an unconditional step, so it always reports a real success/failure conclusion.`);
}

// Only run as a CLI when invoked directly, not when imported by the test suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
