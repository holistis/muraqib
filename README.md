# muraqib — zero-maintenance QA for solo SaaS founders

**Arabic: مُراقِب — "the guardian, the watchful one"**

Muraqib is a nightly QA system built for one-person software teams. It runs Playwright tests against your live app every night, lets Claude fix failing tests automatically, and sends you one weekly summary email. You only hear about it on Monday morning.

## The problem it solves

Solo founders can't afford a QA team. But silent regressions — a broken signup flow, a payment page that 404s, a broken PDF export — are invisible until a customer complains. Muraqib watches while you sleep.

## How it works

```
Nightly (2am) → Playwright runs all tests against production
               ↓ if tests fail
               Claude reads the error + diffs + fixes the test (or flags it if it's a real bug)
               ↓ if fix passes CI
               Auto-merge to main
               ↓ always
               Weekly digest email every Monday with pass/fail history
```

## Stack

- **Playwright** — browser automation + test runner
- - **GitHub Actions** — nightly cron, auto-merge on green CI
  - - **Claude API** — reads failing test output, writes the fix
    - - **Resend** — weekly digest email
     
      - ## What's in this repo
     
      - | Path | What it does |
      - |---|---|
      - | `tests/` | Playwright test specs (you write these for your app) |
      - | `tasks/` | Handwritten automation tasks |
      - | `tasks/registry.ts` | Maps task names to handlers — no runtime AI, zero token cost |
      - | `task-runner.ts` | CLI: `npm run task -- <name> --flags` |
      - | `lib/selfHeal.ts` | Claude-powered auto-fix for failing tests |
      - | `.github-workflows/` | Copy to `.github/workflows/` in your repo |
     
      - ## Setup
     
      - 1. Copy `tests/` and `tasks/` structure to your project
        2. 2. Copy `.github-workflows/*.yml` to `.github/workflows/`
           3. 3. Add secrets: `ANTHROPIC_API_KEY`, `RESEND_API_KEY`
              4. 4. Enable "Allow auto-merge" in GitHub repo settings
                 5. 5. Add branch protection on main with required status checks
                   
                    6. ## Design principles
                   
                    7. - **Tasks are always handwritten** — no runtime AI generates or executes tasks. Writing a new handler is one-time Claude work. Running it costs 0 tokens.
                       - - **You get one email per week** — not one per failed test. Signal, not noise.
                         - - **Auto-fix only merges on green CI** — Claude's fix has to pass the same tests before it touches main.
                          
                           - MIT License.
