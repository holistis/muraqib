# Lessons

Running log of things this project got wrong and fixed, and why. Kept separate from SECURITY.md because not everything here is a security issue. Some of it is just "this broke in a way worth remembering."

## 2026-09-03 (same day, found while testing the fix): none of the notification paths could ever have sent anything

The watchdog above was deployed to the host project and run for real, to prove it worked. It gave the correct alarm. But its own log carried a second line nobody had asked about:

```
NOTE: no RESEND_API_KEY / MURAQIB_EMAIL_TO / MURAQIB_EMAIL_FROM, so no email was sent.
```

`RESEND_API_KEY` had never been set on that repository. Only two secrets existed there, both for the test account. So on top of a nightly that could not report, there was no way to email anyone about it even if it had.

**Every notification path handled that by doing nothing and reporting success.** Three of them, written at different times, all reaching for the same instinct:

| Where | What it did with a missing key |
|---|---|
| weekly digest | `console.log('key not found'); return;` job green |
| fix workflow | `if: env.RESEND_API_KEY != ''` on the send step, step SKIPPED, job green |
| auto-rollback | `if [ -n "$RESEND_API_KEY" ]; then ... fi`, nothing sent, job green |

The digest log from 31 August says it in plain text: "RESEND_API_KEY niet gevonden, email overgeslagen". Twelve consecutive green Mondays since 15 June. Zero emails.

None of the curl calls used `--fail` either, so even with a valid key an HTTP 401 from the provider would exit 0. A rejected message and a delivered one were indistinguishable.

**And one that had never run at all.** The rollback alert built its JSON with a heredoc whose `EOF` terminator was indented. For `<<EOF` the delimiter must sit at column zero, so the heredoc never closed and bash reported a parse error. That step only runs during a real rollback, so it would have fallen over on precisely the day it was needed, and until that day it looked fine. Rewritten with `jq -n`, which also fixed `$ALERT_TO` and the commit hash going into the JSON unescaped, something SECURITY.md already forbids.

**Why this is the same bug as the one above, not a new one.** A nightly hard-killed by a runner timeout cannot report, so nothing fires. A notification step that decides it cannot send and returns success does not report either. Both leave a green dashboard and an empty inbox. The first hides a failure to run; the second hides a failure to tell. Neither is distinguishable from a healthy system, which is the whole property that makes them dangerous.

**What changed:** `scripts/check-alerting-not-silent.mjs` (+ 12 tests, wired into `self-check.yml` and into `npx muraqib doctor`). It scans every workflow for steps that talk to a delivery service and flags three shapes: a step-level `if:` on a secret being non-empty, a shell `if [ -n "$KEY" ]` wrapper, and a `github-script` sender that never calls `core.setFailed` and never throws, so it has no way to fail at all. It also flags a `curl` to such a host without `--fail` or `--fail-with-body`.

Run against the host project's real workflow files, before and after, it finds all five problems in the broken versions and none in the fixed ones. It also found a fourth path nobody had looked at, a Telegram alert on the weekly database backup with the same wrapper, which no human had noticed in either review pass.

It also found the same bug in this template's own `muraqib-claude-fix.yml`, which means every project that used this repo as a starting point shipped with a notification step that skips itself in silence.

**Lesson:** for any step whose entire purpose is to tell a person something, "I could not send" and "I sent it" must not have the same exit code. Optional notifications are the trap: making a send conditional on its own credentials being present feels tidy and defensive, and it converts a missing secret from a loud setup error into a permanent, invisible one.

## 2026-09-03: the nightly had been cancelled every night for two months and nothing said a word

The project this template was built for stopped being watched somewhere in late June. Nobody noticed until today, and nobody could have, because the failure mode removed its own alarm.

**What the run history showed.** 164 nightly runs on the host project: 7 success, 76 failure, 81 cancelled. The last 60-plus consecutive runs were all cancelled. Every one of them stopped at almost exactly 20 minutes and 18 seconds.

**The cause is one number against another.** The job carried `timeout-minutes: 20`. The Playwright defaults in this template are `workers: 1`, `fullyParallel: false`, and one retry on CI, chosen deliberately to be gentle on a production app. That combination is roughly eight to ten seconds per test, so a suite crossing about 150 tests crosses 20 minutes. The host project's suite had grown to 24 spec files and around 150 tests. From the night it crossed that line, the runner killed the job mid-run, every night, forever.

**Why it was silent is the part worth remembering.** A runner timeout is a kill, not a failure. GitHub records the run's conclusion as `cancelled`. The tests step never gets to write `tests_failed=true`, so:

- the Claude fix workflow is never dispatched
- the "fail job if tests failed" step is skipped, so the job does not go red
- no email goes out

The Actions tab shows a run every night. The inbox is quiet. Everything looks like a system that is working and finding nothing wrong. That is strictly worse than having no QA at all, because you have stopped looking yourself.

**The deeper mistake, and it is an architecture one, not a config one.** Every alert path in this project hung off a single trigger: a test run that finished and reported. Nothing watched the trigger. So the entire class of "the run never reported" was invisible by construction, and the timeout was only one member of that class. GitHub silently disables schedules on repositories with no pushes for 60 days. An expired secret kills the job before the tests. Someone disables a workflow and forgets. All four look identical from the inside: calm dashboard, empty inbox, unwatched app.

**What changed:**

1. `playwright.config.ts` now sets `globalTimeout` below the job's `timeout-minutes`. Playwright stops itself first, exits non-zero, and still writes `results.json`, so an over-running suite reads as a loud failure with a full report instead of a silent cancel. The ordering is the fix, not the bigger number.
2. `scripts/check-timeout-budget.mjs` (+ tests, wired into `self-check.yml`) fails the build if `globalTimeout` is missing, is not below the job timeout, or does not leave at least five minutes for the install and upload steps around the run. It also fails closed on any `globalTimeout` shape it cannot parse back to a number of minutes, on the same principle the sensitive-paths guard uses for an unparseable pattern: a checker that cannot read the file must not pass it.
3. `scripts/check-nightly-heartbeat.mjs` and `.github/workflows/muraqib-watchdog.yml` close the class rather than the instance. Once a day the watchdog asks whether the nightly has produced any conclusive result recently, and shouts if the last runs were all inconclusive, if nothing has reported inside the quiet window, or if the workflow has no runs at all. Fed the host project's real run history it returns the alarm this repo needed two months ago.
4. The same watchdog also flags a check that has been red for seven runs straight. A permanently failing test has stopped being an alert and has become furniture, which is the same outcome as silence by a different route.

**The watchdog installs nothing on purpose.** No dependencies, no `npm install` step, just the Actions API and the `fetch` built into Node 20. Whatever watches the watchman has to have fewer moving parts than the watchman, or you have only added another thing that can go quiet without telling you.

**Lesson, stated plainly so it transfers:** an alerting system built on one trigger has exactly one bug that disables all of it, and that bug will not announce itself. For any check that is supposed to interrupt a person, ask separately from "does it catch problems": what does it look like when this check stops running, and who finds out. If the honest answer is "it looks like everything is fine", the check is not finished.

## 2026-08-28: three layered bugs in the same file, found while preparing for a wider release

**1. Script injection (CWE-94).** Failure text and workflow inputs were spliced via `${{ }}` directly into JS template literals and a bash string instead of `env:` variables. See SECURITY.md for the fix and the permanent regression check (`npm run check:workflows`).

**2. The YAML was invalid from the first commit, and nobody noticed for months.** A multi-line JS template literal was written without indentation inside a YAML block scalar (`script: |`), which requires every line to be indented at least as much as the block's first line. Generic YAML linters can miss this depending on how strict they are; the way it was actually confirmed was calling `gh workflow run` against the real workflow_dispatch API and reading the exact parse error GitHub returned. Lesson: for GitHub Actions workflows specifically, a YAML-valid file is not the same as a GitHub-Actions-valid file. When in doubt, trigger it for real (or at minimum lint with a tool that understands the Actions schema, not just generic YAML).

**3. Self-inflicted, caught immediately.** The comments explaining bug #1 literally contained the string `${{ }}` (empty) to describe the danger. GitHub's parser scans the *entire file* for `${{ ... }}` patterns, including inside comments in a script block, and tried to evaluate the empty one as a real expression. Lesson: never write the literal double-brace syntax in a comment inside a workflow file, even to explain what not to do. Describe it in words instead.

**How #2 was verified as actually fixed, not just "looks right":** `gh workflow run` reads a workflow's `workflow_dispatch` schema from the **default branch**, not the ref you pass. So a feature branch fix can't be end-to-end confirmed via API dispatch until it's merged. The fallback verification used here was (a) a real YAML parser confirming structural validity, and (b) a regex audit confirming every remaining `${{ ... }}` expression in the file resolves to a real, non-empty context reference (`inputs.*`, `secrets.*`, `steps.*.outputs.*`, `github.*`) rather than assuming "no parse error" means "no problem."

**4. The nightly job's missing `actions:write` permission (#1), a real, independently-diagnosed PR, closed as superseded rather than merged separately.** PR #1 correctly identified and fixed the exact same permissions gap that's part of this batch of fixes. Closed instead of merged alongside #2 because both touched the same lines in `muraqib-nightly.yml`. Merging both would have conflicted. Credit for that diagnosis stands even though the code landed via a different PR.

**5. The regression check itself shipped with no test, and one phantom path.** `scripts/check-no-expression-splicing.mjs` was added to guard against bug #1 coming back, but had zero automated tests of its own. The only evidence it worked was prose in a commit message, which doesn't run in CI. Fixed with `scripts/check-no-expression-splicing.test.mjs` (`npm run test:scripts`, wired into `self-check.yml`). Separately, both the checker's `WORKFLOWS_DIRS` and `CONTRIBUTING.md` referenced `tools/muraqib/.github-workflows/`, a path that has never existed anywhere in this repo's history. Copied by habit from a different project's folder layout. Removed. Lesson: when reusing a snippet of your own code across projects, verify the reused path actually exists in *this* project, don't assume.

## 2026-08-29: a security feature that would not have worked, caught before it was ever pushed

Built `auto-merge-guard.yml` as a code-based backstop against auto-merging payment/auth/migration changes. Ran it through adversarial + edge-case review (as its own dedicated pass, not folded into a general read-through) before pushing anywhere, and both reviewers independently found it fundamentally broken:

- **Trigger type is a security decision, not a formality.** It used `on: pull_request`, which reads the workflow *definition* from the PR's own branch. A PR that weakens the guard (empties its pattern, disables the job) in the same diff as a sensitive-path change would be checked against its own already-neutered copy. That exactly defeats the point. `pull_request_target` reads the workflow from the base branch instead, which the PR can't touch. Lesson: any check whose entire purpose is "the PR author can't influence this" must use `pull_request_target`, and must never check out or execute the PR's own code once it does (this version computes changed files via the API instead of `git diff` on a checked-out ref, specifically to stay safe under that trigger).
- **A safety check that runs asynchronously is not a safety check unless something makes the platform wait for it.** The guard's own job can't stop GitHub's native auto-merge from completing before the job finishes. Only a required status check in branch protection does that. Documented as a mandatory setup step, not an implementation detail.
- **Testing the wrong copy of the logic is worse than not testing it.** The first version's unit tests exercised a JS `RegExp` hand-copied from a `grep -E` (POSIX ERE) string actually used in the workflow's bash step. The two dialects don't always agree, so green tests didn't guarantee the production code behaved the same way. Fixed by moving all matching logic into one script (`scripts/check-sensitive-paths.mjs`) that both the workflow and the tests import. There is now exactly one copy of the logic to get right.
- **A malformed input should fail closed, not open.** An invalid custom `MURAQIB_SENSITIVE_PATHS` pattern used to let `grep` silently treat everything as "no match": the worst possible failure mode for a guard. Now an unparseable pattern is treated as an automatic block.
- **A claim in the documentation is a testable claim.** The pattern was described as covering "payment, auth, database-migration, or secrets" but the regex itself never mentioned "auth." Caught by a reviewer checking the code against the doc, not by reading either one alone.

None of this shipped to any repo before it was caught. That is the whole point of running the review as a dedicated step before pushing, not after.

## 2026-08-29: turning on the guard's own required setup step broke every other PR

`auto-merge-guard.yml` had documented, since it was written, that it only actually blocks a merge if added as a required status check in branch protection. That setup step was finally done today. Minutes later, a plain docs-only PR (#11) stayed stuck in a blocked state even though every real check on it had already passed.

- **A job-level `if:` and a required status check do not mix.** The guard job's condition (`if: github.event.pull_request.auto_merge != null`) lived at the job level. On any PR without auto-merge enabled, that makes the entire check run report conclusion SKIPPED, not success. GitHub's required-status-checks feature does not treat a skipped check as satisfying the requirement, it leaves the PR permanently blocked from merging. So the setup step the guard's own documentation asked for turned it into a lock on every normal PR, not just the auto-merge race it was built to close. Fixed by moving the condition down to individual steps instead: a no-op step reports success when auto-merge is off, the real checkout and check steps run unchanged when it's on. The job now always finishes with a real success/failure conclusion.
- **This project already had the exact lesson that would have caught this, and didn't apply it to itself.** "The regression check itself shipped with no test" (2026-08-28, #5 above) is a different bug but the identical failure mode: a fix went out with only a live-repro description in a commit message, no automated guard against it recurring. `scripts/check-required-check-not-skippable.mjs` (+ tests, wired into `self-check.yml`) closes that gap for this bug specifically. Lesson restated because it clearly didn't stick the first time: a lesson written down after one bug has to be actively re-applied to the next one, not just filed away.
- **A helper function's safety claim needs its own adversarial test, not just a comment.** The regression checker includes `isLikelyComplementOf`, meant to recognize when two steps' `if:` conditions are exact logical opposites (e.g. `<expr> == null` / `<expr> != null`) so the checker can confirm something always runs. The first version was a naive textual swap of `==`/`!=`, and adversarial review found it wrongly clears a compound condition like `a==b && c!=d` paired with `a!=b && c==d` as "complementary" when it is not (both can be false simultaneously, so neither step runs, which is exactly the bug this file exists to catch), and wrongly accepts `===`/`!==` as valid GitHub Actions operators, which they are not. Fixed by making the helper bail out to "not proven safe" on any compound (`&&`, `||`) or strict-equality condition, with adversarial test cases added for both. This repo's real workflow only ever used the simple shape the helper handles correctly, so nothing here was actually exploitable today, but the helper's own doc comment overclaimed general safety it did not have.

**Why this file exists:** the same failure-driven-improvement loop Muraqib applies to a host project's production code should apply to Muraqib's own development too. If you find something else, add it here.
