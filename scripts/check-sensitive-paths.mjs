#!/usr/bin/env node
/**
 * Core logic for the Auto-Merge Guard. Pulled out of the workflow YAML into
 * a real, testable script for one reason: the first version of this guard
 * shipped with its matching logic written twice, once as a JS RegExp in
 * the test suite, once as a POSIX ERE string handed to `grep -E` in the
 * workflow's bash step. The two dialects don't agree on syntax (e.g. `(`
 * needs escaping in POSIX ERE but not in JS), so a pattern that passed the
 * unit tests could behave differently, or fail to compile at all, in the
 * actual production run, and a `grep` invocation with a bad pattern can
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
 * - This must run under `pull_request_target`, not `pull_request`, see
 *   the workflow file's own comment for why. This file has no opinion on
 *   that; it only computes a match, it doesn't decide how it's triggered.
 * - Duplicate-notification dedup is a label, not a comment-body marker
 *   scan. Two genuinely concurrent runs (a double-click on "enable
 *   auto-merge", a redelivered webhook) could both see "not yet notified"
 *   in the old comment-scan design before either one posted, producing two
 *   comments. GitHub's label set is idempotent (adding an already-present
 *   label is a true no-op, never a duplicate), so checking and setting a
 *   label instead removes that failure mode for the label itself. The
 *   read-then-act sequence around it is not made fully atomic by this, a
 *   truly simultaneous pair of runs can still both read "label absent"
 *   before either adds it, but the window shrinks from "however many
 *   comments this PR has ever had" to one small labels-list request. This
 *   was never a security issue either way: the disable-auto-merge action
 *   above already tolerates being called twice, the only failure mode was
 *   a cosmetic duplicate comment.
 * - The comment is posted BEFORE the label is set, not after. An earlier
 *   version of this fix did it the other way round, and adversarial review
 *   caught a real regression: if the label-add succeeded but the comment
 *   call then failed, the label was already committed, so every later run
 *   would see "already notified" and skip the comment forever, silence
 *   instead of the original bug's occasional duplicate. Posting the
 *   comment first means the only way to fail is the one this file already
 *   accepts elsewhere: retry produces at worst a duplicate, never silence.
 */

const DEFAULT_PATTERN_SOURCE =
  "(^|/)(migrations?|schema)(/|\\.)|stripe|payment|billing|\\.env($|\\.)|(^|[/._-])secrets?(/|[._-]|$)|auth|_core/index\\.ts|(^|/)\\.github/";

/**
 * Compiles the sensitive-path pattern. Returns { regex, error }. On a bad
 * custom pattern, `regex` is null and `error` is set: callers must treat
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
 * diff) returns an empty array. That's a pass, not a failure.
 */
export function findSensitiveMatches(regex, changedFiles) {
  return changedFiles.filter(f => regex.test(f));
}

/**
 * Full decision for one PR: given the raw pattern source (possibly
 * user-supplied) and the changed file list, decides whether auto-merge
 * should be blocked, and why. Never throws: a compile failure is itself
 * a "block" outcome, not an exception the caller has to handle specially.
 */
export function evaluate(patternSource, changedFiles) {
  const { regex, error, source } = compileSensitivePattern(patternSource);
  if (error) {
    return {
      block: true,
      reason: `MURAQIB_SENSITIVE_PATHS ("${source}") is not a valid pattern: ${error}. Failing closed, treat this as a match rather than silently checking nothing.`,
      matches: [],
    };
  }
  const matches = findSensitiveMatches(regex, changedFiles);
  if (matches.length > 0) {
    return { block: true, reason: `Matched sensitive-path pattern: ${matches.join(", ")}`, matches };
  }
  return { block: false, reason: "No sensitive paths touched.", matches: [] };
}

/**
 * Parses the raw stdout of `gh api ... --paginate` (deliberately WITHOUT
 * --jq). A prior version added `--jq "[.[].filename]"` to that call, which
 * broke on any response spanning more than one page: gh applies --jq
 * per-page before merging, so a multi-page response becomes several
 * concatenated JSON array literals ("[...][...]"), not one valid document.
 * JSON.parse throws, and the whole script (including the part that would
 * disable auto-merge) crashes before ever evaluating the PR. Reproduced
 * against real large PRs before fixing.
 *
 * Without --jq, gh's own pagination logic merges multi-page array
 * responses into a single array, but this still defensively flattens in
 * case a future gh version, or an endpoint that behaves differently,
 * returns one array per page instead. Better to handle both shapes than
 * to reintroduce the same class of crash somewhere else.
 */
export function parsePaginatedArrayOutput(rawOutput) {
  let parsed = JSON.parse(rawOutput);
  if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
    parsed = parsed.flat();
  }
  return parsed;
}

/**
 * Extracts every path worth checking from the GitHub "list PR files" API
 * response: the current filename, and for a renamed file, the path it was
 * renamed FROM too. A rename with no content change would otherwise never
 * appear under its old, possibly-sensitive name.
 */
export function extractCheckablePaths(prFilesApiResponse) {
  const paths = [];
  for (const file of prFilesApiResponse) {
    if (file.filename) paths.push(file.filename);
    if (file.previous_filename) paths.push(file.previous_filename);
  }
  return paths;
}

/**
 * Pure function, exported for the test suite: does this label list already
 * contain the guard's dedup label? Labels are a GitHub REST API's array of
 * `{name, ...}` objects, matched here by name only.
 */
export function hasGuardLabel(labels, labelName) {
  return labels.some(l => l && l.name === labelName);
}

/**
 * Pure sequencing function, exported for the test suite: `postComment` must
 * run, and complete, before `addLabel` is even attempted, and a throw from
 * `addLabel` must never mask a successful `postComment` (swallowed here,
 * not propagated). A throw from `postComment` itself must propagate to the
 * caller and must prevent `addLabel` from running at all.
 *
 * This exists because an earlier version of this file got the order
 * backwards (label first, comment second): if the label-add succeeded but
 * the comment then failed, the label persisted server-side, so every later
 * run would see "already notified" and skip the comment forever. Comment
 * first means the worst case on any failure is a duplicate comment on
 * retry, never permanent silence. See the module docstring.
 */
export function notifyOncePerPR(postComment, addLabel) {
  postComment();
  try {
    addLabel();
  } catch {
    // Labeling is a best-effort dedup aid; the comment above already ran.
  }
}

async function main() {
  const { execFileSync } = await import("node:child_process");

  const prNumber = process.env.PR_NUMBER;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!prNumber || !repo) {
    console.error("PR_NUMBER and GITHUB_REPOSITORY must be set.");
    process.exit(1);
  }

  // Changed files via the API, not `git diff` on a checked-out ref. This
  // script runs under pull_request_target specifically so it never needs
  // to check out or execute anything from the PR's own (untrusted) branch.
  const rawOutput = execFileSync("gh", ["api", `repos/${repo}/pulls/${prNumber}/files`, "--paginate"], {
    encoding: "utf8",
  });
  const prFiles = parsePaginatedArrayOutput(rawOutput);
  const changedFiles = extractCheckablePaths(prFiles);
  console.log(`Changed files (${changedFiles.length}, including pre-rename names):`);
  changedFiles.forEach(f => console.log(`  ${f}`));

  const result = evaluate(process.env.MURAQIB_SENSITIVE_PATHS, changedFiles);
  console.log(result.reason);

  if (!result.block) {
    console.log("Auto-merge guard passes.");
    return;
  }

  console.error(`::error::${result.reason} Disabling auto-merge on PR #${prNumber}.`);

  // Avoid spamming a comment on every retrigger of the same failing PR: a
  // label, not a comment-body marker scan, decides whether this guard has
  // already notified on this PR. See the module docstring for why a label
  // is safer against two concurrent runs than scanning comment history.
  const MARKER = "<!-- muraqib-auto-merge-guard -->";
  const LABEL = "muraqib-guard-blocked";
  let alreadyNotified = false;
  try {
    const rawLabels = execFileSync("gh", ["api", `repos/${repo}/issues/${prNumber}/labels`, "--paginate"], {
      encoding: "utf8",
    });
    const labels = parsePaginatedArrayOutput(rawLabels);
    alreadyNotified = hasGuardLabel(labels, LABEL);
  } catch {
    // If we can't check, err toward notifying once rather than staying silent.
  }

  try {
    execFileSync("gh", ["pr", "merge", prNumber, "--repo", repo, "--disable-auto"], { encoding: "utf8" });
    console.log(`Auto-merge disabled on PR #${prNumber}.`);
  } catch (err) {
    // Disabling can legitimately fail if the PR already merged before this
    // job ran (the race this guard can't fully close without being a
    // required status check, see SECURITY.md). Say so explicitly instead
    // of reporting success either way.
    console.error(`::error::Could not disable auto-merge (it may have already merged before this check ran): ${err.message}`);
  }

  if (!alreadyNotified) {
    const body = `${MARKER}\nAuto-merge Guard: this PR touches a path matching the sensitive-paths pattern (\`${result.matches.join(", ")}\`). Auto-merge has been disabled, manual review required.\n\nIf this guard is not configured as a required status check on this branch, GitHub's native auto-merge may already have completed before this comment posted; check the merge state above.`;
    notifyOncePerPR(
      () => execFileSync("gh", ["pr", "comment", prNumber, "--repo", repo, "--body", body]),
      // Adding a label GitHub hasn't seen before creates it automatically
      // (confirmed empirically against a real GitHub Actions run using
      // only pull-requests: write, no issues: write needed), and adding an
      // already-present label is a genuine no-op, never a duplicate. That
      // test PR was same-repo, not a fork: GitHub only downgrades
      // GITHUB_TOKEN to read-only on `pull_request` from a fork, a rule
      // that never applies to `pull_request_target` (the whole reason this
      // guard uses it), so the same-repo test result transfers here.
      () => execFileSync("gh", ["api", "-X", "POST", `repos/${repo}/issues/${prNumber}/labels`, "-f", `labels[]=${LABEL}`], {
        encoding: "utf8",
      })
    );
  }

  process.exit(1);
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
