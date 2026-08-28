#!/usr/bin/env node
/**
 * Core logic for the Auto-Merge Guard. Pulled out of the workflow YAML into
 * a real, testable script for one reason: the first version of this guard
 * shipped with its matching logic written twice — once as a JS RegExp in
 * the test suite, once as a POSIX ERE string handed to `grep -E` in the
 * workflow's bash step. The two dialects don't agree on syntax (e.g. `(`
 * needs escaping in POSIX ERE but not in JS), so a pattern that passed the
 * unit tests could behave differently, or fail to compile at all, in the
 * actual production run — and a `grep` invocation with a bad pattern can
 * fail in ways that look like "no match" rather than "error", i.e. fail
 * OPEN on exactly the input this guard exists to catch. This file is now
 * the only place the matching logic lives; both the workflow and the test
 * suite import it.
 *
 * Design choices, each closing a specific finding from review:
 * - A malformed custom pattern fails CLOSED (treated as a match, blocking
 *   auto-merge) rather than silently passing everything through.
 * - "auth" is in the default pattern; the first version omitted it despite
 *   documentation claiming auth changes were covered.
 * - This must run under `pull_request_target`, not `pull_request` — see
 *   the workflow file's own comment for why. This file has no opinion on
 *   that; it only computes a match, it doesn't decide how it's triggered.
 */

const DEFAULT_PATTERN_SOURCE =
  "(^|/)(migrations?|schema)(/|\\.)|stripe|payment|billing|\\.env($|\\.)|secrets?[._-]|auth|_core/index\\.ts|(^|/)\\.github/";

/**
 * Compiles the sensitive-path pattern. Returns { regex, error }. On a bad
 * custom pattern, `regex` is null and `error` is set — callers must treat
 * that as "block", never as "no findings".
 */
export function compileSensitivePattern(source) {
  const pattern = source && source.trim() ? source : DEFAULT_PATTERN_SOURCE;
  try {
    return { regex: new RegExp(pattern, "i"), error: null, source: pattern };
  } catch (err) {
    return { regex: null, error: err.message, source: pattern };
  }
}

/**
 * Given a compiled pattern and a list of changed file paths, returns the
 * subset that match. An empty file list (no-op PR, merge commit with no
 * diff) returns an empty array — that's a pass, not a failure.
 */
export function findSensitiveMatches(regex, changedFiles) {
  return changedFiles.filter(f => regex.test(f));
}

/**
 * Full decision for one PR: given the raw pattern source (possibly
 * user-supplied) and the changed file list, decides whether auto-merge
 * should be blocked, and why. Never throws — a compile failure is itself
 * a "block" outcome, not an exception the caller has to handle specially.
 */
export function evaluate(patternSource, changedFiles) {
  const { regex, error, source } = compileSensitivePattern(patternSource);
  if (error) {
    return {
      block: true,
      reason: `MURAQIB_SENSITIVE_PATHS ("${source}") is not a valid pattern: ${error}. Failing closed — treat this as a match rather than silently checking nothing.`,
      matches: [],
    };
  }
  const matches = findSensitiveMatches(regex, changedFiles);
  if (matches.length > 0) {
    return { block: true, reason: `Matched sensitive-path pattern: ${matches.join(", ")}`, matches };
  }
  return { block: false, reason: "No sensitive paths touched.", matches: [] };
}

async function main() {
  const { execFileSync } = await import("node:child_process");

  const prNumber = process.env.PR_NUMBER;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!prNumber || !repo) {
    console.error("PR_NUMBER and GITHUB_REPOSITORY must be set.");
    process.exit(1);
  }

  // Changed files via the API, not `git diff` on a checked-out ref — this
  // script runs under pull_request_target specifically so it never needs
  // to check out or execute anything from the PR's own (untrusted) branch.
  const filesJson = execFileSync("gh", ["api", `repos/${repo}/pulls/${prNumber}/files`, "--paginate", "--jq", "[.[].filename]"], {
    encoding: "utf8",
  });
  const changedFiles = JSON.parse(filesJson);
  console.log(`Changed files (${changedFiles.length}):`);
  changedFiles.forEach(f => console.log(`  ${f}`));

  const result = evaluate(process.env.MURAQIB_SENSITIVE_PATHS, changedFiles);
  console.log(result.reason);

  if (!result.block) {
    console.log("Auto-merge guard passes.");
    return;
  }

  console.error(`::error::${result.reason} — disabling auto-merge on PR #${prNumber}.`);

  // Avoid spamming a comment on every retrigger of the same failing PR —
  // check for an existing marker from this guard before posting another.
  const MARKER = "<!-- muraqib-auto-merge-guard -->";
  let alreadyCommented = false;
  try {
    const commentsJson = execFileSync("gh", ["api", `repos/${repo}/issues/${prNumber}/comments`, "--paginate", "--jq", "[.[].body]"], {
      encoding: "utf8",
    });
    alreadyCommented = JSON.parse(commentsJson).some(body => body.includes(MARKER));
  } catch {
    // If we can't check, err toward commenting once rather than staying silent.
  }

  try {
    execFileSync("gh", ["pr", "merge", prNumber, "--repo", repo, "--disable-auto"], { encoding: "utf8" });
    console.log(`Auto-merge disabled on PR #${prNumber}.`);
  } catch (err) {
    // Disabling can legitimately fail if the PR already merged before this
    // job ran (the race this guard can't fully close without being a
    // required status check — see SECURITY.md). Say so explicitly instead
    // of reporting success either way.
    console.error(`::error::Could not disable auto-merge (it may have already merged before this check ran): ${err.message}`);
  }

  if (!alreadyCommented) {
    const body = `${MARKER}\nAuto-merge Guard: this PR touches a path matching the sensitive-paths pattern (\`${result.matches.join(", ")}\`). Auto-merge has been disabled — manual review required.\n\nIf this guard is not configured as a **required status check** on this branch, GitHub's native auto-merge may already have completed before this comment posted; check the merge state above.`;
    execFileSync("gh", ["pr", "comment", prNumber, "--repo", repo, "--body", body]);
  }

  process.exit(1);
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
