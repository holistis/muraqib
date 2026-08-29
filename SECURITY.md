# Security

Muraqib gives an AI agent write access to your repository (issues, pull requests) and runs unattended, on a schedule, against production. That combination deserves a clear threat model instead of a vague "we take security seriously."

## What Muraqib can and cannot do

- It can open GitHub issues and pull requests.
- It can merge a pull request **only if** you set `claudeIntegration.autoMerge: true` **and** the fix doesn't touch anything in the do-not-touch list below.
- It cannot push directly to `main`. Every change goes through a PR.
- It cannot see or use any secret you haven't explicitly added as a GitHub Actions secret.

## Known risk: test-failure text is untrusted input

A Playwright test failure message can, in principle, contain text influenced by whatever the test was checking: page content, form echoes, error strings. That text becomes part of the prompt Claude reads when diagnosing the failure. Two things follow from that:

1. **The workflow files never splice that text as a raw GitHub Actions expression** (`${{ }}`) into a script block. Every value crosses that boundary through an `env:` variable instead, read back with `process.env` (or via `jq -n` for the one step that builds JSON in bash). Splicing untrusted text directly into a script block is a known class of vulnerability (CWE-94, GitHub Actions script injection). It lets a backtick or `${...}` in the text break out of the string and run arbitrary code with the workflow's `issues:write`/`pull-requests:write` token. This repo had that exact bug in its first commit; it's fixed now, and the fix is the reason every step that touches failure text passes it through `env:`.
2. **The failure text is explicitly labeled as untrusted data, not instructions**, in the prompt itself. Claude is told to treat it as error output only, never as a command, even if it contains something that reads like one.

## Known risk: auto-merge

`claudeIntegration.autoMerge` defaults to `false`. If you turn it on:

- The fix prompt instructs Claude to leave payment, auth, database-migration, and secrets-handling changes for manual review regardless of the setting, and to say so explicitly in the PR body. That is a text instruction a model reads: useful, but not a hard guarantee.
- `.github/workflows/auto-merge-guard.yml` is the second, code-based line of defense: it runs under `pull_request_target` (not `pull_request`) specifically so a PR can't evade the guard by editing the guard itself in the same diff. `pull_request_target` always reads the workflow definition from the base branch, never from the PR's own ref. It checks the real changed files (via the GitHub API, never by checking out the PR's code) against a pattern customizable via the `MURAQIB_SENSITIVE_PATHS` repo variable, and force-disables auto-merge plus comments if it matches. An invalid custom pattern fails **closed** (treated as a match) rather than silently checking nothing. It also errs toward false positives on purpose: a harmless file merely named after a sensitive topic (`tests/payment-flow.spec.ts`) still gets flagged, because a few minutes of manual review costs less than missing a real one.
- **This guard only actually blocks the merge if it's added as a required status check** on `main`'s branch protection rules (name: "Muraqib Auto-Merge Guard / guard"). Without that, it's a race: the guard runs asynchronously after the PR event, and GitHub's native auto-merge can complete before the guard job finishes, in which case the guard's `--disable-auto` call fails because there is nothing left to disable. It will say so in its log rather than falsely reporting success. Turning auto-merge on without both the guard *and* that required-status-check setting is not a safety net, it's just skipping review. This repo's own `main` branch has that required status check configured (since 2026-08-29). A fork or clone starts without it and needs to add it separately, GitHub does not carry branch protection rules across a fork.
- CI passing means the fix didn't break the tests it can see, not that the fix is correct. Auto-merge is a convenience for low-stakes flows (a stale selector, a copy change), not a substitute for occasionally reading what Claude actually did.

## Known limitation: every PR on this repo currently needs an admin merge

Three unrelated third-party GitHub Apps installed on this account (Render, Railway, Claude) each register a check suite on every push here but never complete it (0 check runs, status stuck `queued` indefinitely). That is a property of those apps' own webhook handling for this repo, not something this project's workflows control. Once a required status check exists on `main` (see above), GitHub's mergeability computation reports the PR as `BLOCKED` regardless of whether the *required* check passed, because those other, unrelated check suites never resolve.

GitHub has a repo-scoped fix for this (`PATCH /repos/{owner}/{repo}/check-suites/preferences`, disabling `auto_trigger_checks` per app for just this repo, without touching that app's real functionality or its access to other repos), but that endpoint rejects the OAuth-flow token this environment authenticates with, it needs a classic personal access token instead. Not yet applied.

Until it is, merging a normal PR here needs `gh pr merge --admin` (safe: `enforce_admins` is `false`, and the required check itself, not this workaround, is still what actually gates a sensitive-path or auto-merge PR). A `BLOCKED` mergeStateStatus with the required check showing green is this issue, not a sign the guard is broken again.

## If you find something

Open an issue, or if it's sensitive, email the address in the repo owner's GitHub profile. This is a solo-maintained tool, response time varies, but security reports get priority over everything else in the queue.

## Changelog of security-relevant fixes

- **2026-08-28**: Fixed GitHub Actions script injection (CWE-94) in `muraqib-claude-fix.yml`: failure text and workflow inputs were spliced via `${{ }}` directly into JS template literals and a bash string. Fixed via `env:` + `process.env` / `jq -n`. Also fixed a pre-existing invalid-YAML bug in the same file (a raw, unindented multi-line template literal broke the surrounding YAML block scalar) that meant the auto-fix mechanism could never successfully run, and added the `actions:write` permission the nightly job's dispatch call needs (closes #1). `autoMerge` now defaults to `false`. Separately, the auto-fix issue's "Failed tests" section was always empty (Playwright nests an extra `suites` layer per `test.describe()` that the extraction missed). Fixed and verified with a reproduction.
- **2026-08-29**: Added `auto-merge-guard.yml`: a code-based check, independent of the fix prompt's text instructions, that inspects the actual changed files on any PR with auto-merge enabled and disables it if a sensitive path is touched. First version used `pull_request` and a `grep -E` pattern duplicated by hand into a separate JS test. Adversarial review caught that `pull_request` lets a PR evade the guard by weakening it in the same diff (fixed with `pull_request_target`), that the two pattern dialects could silently disagree (fixed by moving all matching logic into one tested script, `scripts/check-sensitive-paths.mjs`), that an invalid custom pattern failed open (fixed to fail closed), and that "auth" was missing from a pattern that claimed to cover it (added). Rebuilt and re-tested before merging, not patched in place.
- **2026-08-29**: Configured "Muraqib Auto-Merge Guard / guard" as a required status check on `main`, the setup step `auto-merge-guard.yml` had documented as mandatory since it was written. That immediately blocked every normal PR from merging, not just the auto-merge race it was meant to close: the guard job's `if:` lived at job level, which made the check run report SKIPPED (not success) on any PR without auto-merge, and GitHub's required-status-checks feature does not treat a skipped check as satisfying the requirement. Fixed by moving the condition to individual steps instead, so the job always finishes with a real success/failure conclusion. Added `scripts/check-required-check-not-skippable.mjs` as a regression guard, wired into `self-check.yml`. See `LESSONS.md` for the full incident, including a follow-up fix to that new checker's own complement-detection logic after adversarial review found it could wrongly clear a compound condition as safe.
