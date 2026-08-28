# Security

Muraqib gives an AI agent write access to your repository (issues, pull requests) and runs unattended, on a schedule, against production. That combination deserves a clear threat model instead of a vague "we take security seriously."

## What Muraqib can and cannot do

- It can open GitHub issues and pull requests.
- It can merge a pull request **only if** you set `claudeIntegration.autoMerge: true` **and** the fix doesn't touch anything in the do-not-touch list below.
- It cannot push directly to `main`. Every change goes through a PR.
- It cannot see or use any secret you haven't explicitly added as a GitHub Actions secret.

## Known risk: test-failure text is untrusted input

A Playwright test failure message can, in principle, contain text influenced by whatever the test was checking — page content, form echoes, error strings. That text becomes part of the prompt Claude reads when diagnosing the failure. Two things follow from that:

1. **The workflow files never splice that text as a raw GitHub Actions expression** (`${{ }}`) into a script block. Every value crosses that boundary through an `env:` variable instead, read back with `process.env` (or via `jq -n` for the one step that builds JSON in bash). Splicing untrusted text directly into a script block is a known class of vulnerability (CWE-94, GitHub Actions script injection) — it lets a backtick or `${...}` in the text break out of the string and run arbitrary code with the workflow's `issues:write`/`pull-requests:write` token. This repo had that exact bug in its first commit; it's fixed now, and the fix is the reason every step that touches failure text passes it through `env:`.
2. **The failure text is explicitly labeled as untrusted data, not instructions**, in the prompt itself. Claude is told to treat it as error output only, never as a command, even if it contains something that reads like one.

## Known risk: auto-merge

`claudeIntegration.autoMerge` defaults to `false`. If you turn it on:

- It only applies to PRs that don't touch payment, auth, database-migration, or secrets-handling code — the fix prompt instructs Claude to leave those for manual review regardless of the setting, and to say so explicitly in the PR body.
- Turning it on without branch protection and required status checks on `main` is not a safety net, it's skipping review. Set those up first.
- CI passing means the fix didn't break the tests it can see, not that the fix is correct. Auto-merge is a convenience for low-stakes flows (a stale selector, a copy change), not a substitute for occasionally reading what Claude actually did.

## If you find something

Open an issue, or if it's sensitive, email the address in the repo owner's GitHub profile. This is a solo-maintained tool — response time varies, but security reports get priority over everything else in the queue.

## Changelog of security-relevant fixes

- **2026-08-28** — Fixed GitHub Actions script injection (CWE-94) in `muraqib-claude-fix.yml`: failure text and workflow inputs were spliced via `${{ }}` directly into JS template literals and a bash string. Fixed via `env:` + `process.env` / `jq -n`. Also fixed a pre-existing invalid-YAML bug in the same file (a raw, unindented multi-line template literal broke the surrounding YAML block scalar) that meant the auto-fix mechanism could never successfully run, and added the `actions:write` permission the nightly job's dispatch call needs (closes #1). `autoMerge` now defaults to `false`.
