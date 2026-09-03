#!/usr/bin/env node
/**
 * Points Muraqib's own, repo-agnostic workflow checkers at someone else's
 * public repository, read-only.
 *
 * SUPERSEDED FOR TEMPLATE-INJECTION DETECTION, kept here as a documented
 * finding, not deleted: findExpressionSplices flags every literal `${{ }}`
 * in a run/script body with no regard for whether the referenced value is
 * actually attacker-controllable (a PR title) or safe (a matrix entry, a
 * commit SHA, a workflow_dispatch input that requires write access to
 * trigger at all). Run against 8 large external repos on 2026-09-03 this
 * produced 154 hits, almost all noise on manual inspection.
 *
 * The real answer, found the same day: `zizmor` (pip install zizmor,
 * https://github.com/zizmorcore/zizmor) is a maintained, purpose-built
 * GitHub Actions security scanner already trusted in production by teams
 * like Grafana Labs. It does the same static detection but with real
 * severity/confidence scoring per finding. Use it directly:
 *
 *   pip install zizmor
 *   GH_TOKEN=$(gh auth token) zizmor --format json owner/repo > out.json
 *
 * Even zizmor's High/High findings are NOT confirmed bugs — it does
 * single-step pattern matching, not cross-file taint tracking, so it
 * cannot tell whether a flagged input ever actually receives attacker
 * text. That reachability check has to be done by hand per finding
 * (trace every call site with `gh api search/code`, confirm whether the
 * flagged value is ever set from free text vs. a hardcoded string) before
 * anything is reported. Verified against 18 zizmor High/High findings
 * across microsoft/playwright, vercel/next.js, denoland/deno, oven-sh/bun
 * and nodejs/node on 2026-09-03: 18/18 turned out to be hardcoded,
 * non-attacker-controllable values once traced — a correct, evidence-based
 * "no bug here" on all of them, not a missed finding. Large, well-funded
 * projects with their own security teams are a poor hunting ground for
 * this exact class of bug for that reason; the obvious cases are usually
 * already covered.
 *
 * What THIS file's findExpressionSplices/findSilentAlertingProblems still
 * offer, that zizmor doesn't: they were written for and are tuned to
 * Muraqib's own two other bug classes (a notification step that fails
 * silently instead of loudly, and the specific nested-describe() counting
 * bug) — genuinely repo-agnostic checks, just for a narrower thing than
 * "any script injection". Kept for that purpose, not as the injection
 * detector.
 *
 * Hard boundary, unchanged and still correct: this file only ever reads a
 * workflow file's TEXT via the GitHub API. It never clones, installs, or
 * runs a single line of the target repo's code. zizmor itself follows the
 * same boundary — it's a static analyzer, not a code runner.
 *
 * Run: node scripts/scan-external-repo.mjs owner/repo [owner/repo ...]
 */
import { findExpressionSplices } from "./check-no-expression-splicing.mjs";
import { findSilentAlertingProblems } from "./check-alerting-not-silent.mjs";
// findSkippableRequiredCheck is deliberately NOT reused here: it hardcodes
// JOB_NAME = "guard", written for Muraqib's own auto-merge-guard.yml. Pointed
// at an arbitrary external repo it reports "job \"guard\" not found" on every
// single file, which is noise, not a finding. Caught this against Muraqib's
// own repo (a known-clean baseline) before it ever touched a real target,
// 2026-09-03. Generalizing it to take a job name, or to work out which job is
// a required check via the branch-protection API, is real follow-up work,
// not something to fake here.

const GITHUB_API = "https://api.github.com";

function authHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function ghJson(path) {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return res.json();
}

/** Lists .github/workflows/*.yml|*.yaml for a repo, empty array if the dir doesn't exist. */
async function listWorkflowFiles(owner, repo) {
  const entries = await ghJson(`/repos/${owner}/${repo}/contents/.github/workflows`);
  if (entries === null) return [];
  return entries.filter(e => e.type === "file" && /\.ya?ml$/.test(e.name));
}

/** Fetches one file's raw text content via its download_url. Text only, never executed. */
async function fetchFileText(downloadUrl) {
  const res = await fetch(downloadUrl, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fetch ${downloadUrl} -> ${res.status}`);
  return res.text();
}

async function scanRepo(fullName) {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`Expected owner/repo, got "${fullName}"`);

  const files = await listWorkflowFiles(owner, repo);
  const workflows = [];
  for (const f of files) {
    const source = await fetchFileText(f.download_url);
    workflows.push({ name: `.github/workflows/${f.name}`, source, htmlUrl: f.html_url });
  }

  const hypotheses = [];

  for (const wf of workflows) {
    // Loop 6/8 (Attack Surface / Pattern Recognition), applied as static text checks.
    for (const hit of findExpressionSplices(wf.source, wf.name)) {
      hypotheses.push({ repo: fullName, file: wf.name, url: wf.htmlUrl, check: "expression-splicing", ...hit });
    }
  }

  // findSilentAlertingProblems wants the whole set of workflows at once (a
  // notification pattern can span steps), matching how check-alerting-not-silent.mjs
  // calls it on Muraqib's own files.
  for (const hit of findSilentAlertingProblems(workflows.map(w => ({ name: w.name, source: w.source })))) {
    const wf = workflows.find(w => w.name === (hit.label || "").split(",")[0].split(" step")[0]);
    hypotheses.push({ repo: fullName, file: hit.label, url: wf?.htmlUrl, check: "silent-alerting", ...hit });
  }

  return { repo: fullName, workflowCount: workflows.length, hypotheses };
}

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("Usage: node scripts/scan-external-repo.mjs owner/repo [owner/repo ...]");
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const target of targets) {
    process.stderr.write(`scanning ${target} ... `);
    try {
      const result = await scanRepo(target);
      process.stderr.write(`${result.workflowCount} workflow file(s), ${result.hypotheses.length} raw hit(s)\n`);
      results.push(result);
    } catch (e) {
      process.stderr.write(`FAILED: ${e.message}\n`);
      results.push({ repo: target, error: e.message, hypotheses: [] });
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

main();
