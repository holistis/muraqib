# muraqib — zero-maintenance QA for solo SaaS founders

**Arabic: مُراقِب — "the guardian, the watchful one"**

Muraqib is a nightly QA system built for one-person software teams. It runs Playwright tests against your live app every night, lets Claude fix failing tests automatically, and sends you one weekly summary email. You only hear about it on Monday morning.

## The problem it solves

Solo founders can't afford a QA team. But silent regressions — a broken signup flow, a payment page that 404s, a broken PDF export — are invisible until a customer complains. Muraqib watches while you sleep.

## How it works

```
Nightly (2am) → Playwright runs all tests against production
               ↓ if tests fail
               Claude reads the error, diagnoses it, opens a PR with the fix
               ↓ if fix passes CI
               PR waits for manual review by default — see "Auto-merge" below
               ↓ always
               Weekly digest email every Monday with pass/fail history
```

## Stack

- **Playwright** — browser automation + test runner
- **GitHub Actions** — nightly cron, dispatches the Claude fix workflow on failure
- **Claude Code Action** — reads failing test output, writes the fix, opens a PR
- **Resend** — failure/weekly digest email

## What's in this repo

| Path | What it does |
|---|---|
| `tests/` | Playwright test specs (you write these for your app) |
| `tasks/` | Handwritten automation tasks |
| `tasks/registry.ts` | Maps task names to handlers — no runtime AI, zero token cost |
| `task-runner.ts` | CLI: `npm run task -- <name> --flags` |
| `lib/selfHeal.ts` | Reference implementation of the Claude fix-prompt builder |
| `.github/workflows/` | The nightly runner + the Claude auto-fix workflow, already wired |

## Setup

1. Use this repo as a template (or clone it) into your own project.
2. Edit `muraqib.config.ts`: set `baseUrl`, `projectName`, `flows`, and `alerting.emailTo`/`emailFrom`.
3. Add secrets in your repo settings: `ANTHROPIC_API_KEY`, `RESEND_API_KEY`.
4. Write your Playwright specs in `tests/`, matching the `file` name in each flow.
5. Leave `claudeIntegration.autoMerge` at its default (`false`) until you've read the "Auto-merge" section below.

## Auto-merge

Default is off. Claude opens a PR, CI runs against it, and it waits for you to review and merge — same as any other PR. This is deliberate: CI passing means the fix didn't break the tests it can see, not that the fix is correct.

If you turn `autoMerge` on, it only takes effect for PRs that don't touch anything payment-, auth-, database-migration-, or secrets-related — the Claude fix prompt is instructed to leave those for manual review regardless of the setting. Turning it on also requires branch protection with required status checks on `main`; auto-merge without that is not a safety net, it's just skipping review.

## Design principles

- **Tasks are always handwritten** — no runtime AI generates or executes tasks. Writing a new handler is one-time Claude work. Running it costs 0 tokens.
- **You get one email per week**, plus one on the night something actually breaks — not one per failed test. Signal, not noise.
- **Test failure text is data, not instructions** — the Claude fix prompt explicitly labels error output as untrusted, and never lets it decide the auto-merge outcome.
- **Auto-merge is opt-in and scoped** — off by default, and even when on, payment/auth/migration/secrets changes always wait for a human.

MIT License.
