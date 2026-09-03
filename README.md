# muraqib

Arabic: مُراقِب, "the one who watches".

Nightly Playwright tests against your live app. When something breaks, Claude opens a PR with a fix. Once a week you get one email. And when the nightly itself stops working, you get told, which is the part most setups quietly skip.

MIT licensed. No hosted service, no monthly bill. It runs in your own GitHub Actions.

## Start here

Already have Muraqib, or any nightly Playwright setup, in a repo:

```bash
npx muraqib doctor
```

It reads your workflow and your Playwright config and tells you whether a slow night would fail loudly or just disappear. Takes about two seconds and installs nothing into your repo.

Starting fresh:

```bash
npx muraqib init
```

Copies the template in. It never overwrites a file you already have, and it prints what it kept. Use `--dry-run` first if you want to see the list, and `--dir tools/muraqib` to keep it out of your project root.

## The problem it solves

Solo founders cannot afford a QA team. Silent regressions can sit for weeks: a signup flow that broke on a dependency bump, a pricing page rendering NaN, a PDF export that 404s. Nobody files a ticket. The customer just leaves.

## How it works

```text
Nightly at 02:00 UTC   Playwright runs your flows against production
                       |
                       | tests fail
                       v
                       Claude reads the error, opens a PR with a fix
                       |
                       | CI passes on that PR
                       v
                       The PR waits for you (auto-merge is off by default)

Every Monday          One digest email with the week's pass and fail history

Every morning         A watchdog asks whether the nightly reported anything
                      at all, and emails you if it did not
```

## The part that is actually different

Every alert in a setup like this hangs off one thing: a test run that finished and reported. That leaves a whole category of failure with no alarm in it, because the trigger itself never fires.

A job hard-killed on `timeout-minutes` ends as "cancelled", not "failure", so every downstream step is skipped. GitHub silently stops schedules on repos with no pushes for 60 days. A secret expires and the job dies before the tests. Someone disables the workflow and forgets.

All four look identical from the outside. A run in the Actions tab every night, an empty inbox, and an app nobody is checking. That is worse than having no QA, because you have stopped looking yourself.

This is not hypothetical. It happened here, to this project, for over two months. See the track record below.

Two things now close it:

- `playwright.config.ts` sets `globalTimeout` below the job's `timeout-minutes`, so Playwright stops itself first and still writes a report. A slow suite fails loudly instead of vanishing. `npm run check:timeout-budget` fails the build if those two numbers ever drift back into the wrong order.
- `muraqib-watchdog.yml` runs daily and asks one question: has the nightly produced a pass or a fail recently. It shouts if the recent runs were all cancelled, if nothing has reported inside the window, or if the workflow has no runs at all. It also flags a check that has been red for a week straight, because at that point it has stopped being an alert and become furniture.

There is a third check for the same problem one layer out. A notification step that decides it cannot send, and returns success anyway, does not report either. `npx muraqib doctor` scans every workflow in the repo for steps that talk to a delivery service and flags the ones that can skip themselves quietly: an `if:` on a secret being non-empty, a shell `if [ -n "$KEY" ]` wrapper, a `github-script` sender that never calls `core.setFailed`, or a `curl` without `--fail` so an HTTP 401 still exits 0.

That check exists because of a second incident on the same day, found while testing the first fix. The host project had never had its `RESEND_API_KEY` set, and all three of its notification paths responded to that by doing nothing and going green. Twelve consecutive Mondays of a weekly digest that sent no digest. See [LESSONS.md](LESSONS.md).

The watchdog installs nothing. No dependencies, no npm step, just the Actions API and the fetch built into Node 20. Whatever watches the watchman needs fewer moving parts than the watchman.

## Setup

1. `npx muraqib init` in your repo.
2. `npm install --save-dev @playwright/test dotenv && npx playwright install chromium`
3. Edit `muraqib.config.ts`: `baseUrl`, `flows`, `alerting.emailTo` and `emailFrom`.
4. Add repo secrets so alerts can reach you. Either set works, and you can use both:
   - email: `RESEND_API_KEY`, `MURAQIB_EMAIL_TO`, `MURAQIB_EMAIL_FROM`
   - telegram: `MURAQIB_TELEGRAM_BOT_TOKEN`, `MURAQIB_TELEGRAM_CHAT_ID`

   Plus `ANTHROPIC_API_KEY` for the fix workflow. Telegram is offered because email is the channel most likely to be missing: it needs a provider account, a verified domain and a key, and skipping any of that leaves you with no alerting at all. That is not hypothetical, it is what happened here.
5. Write your Playwright specs in `tests/`, one file per flow in the config.
6. `npx muraqib doctor` to confirm the alert path is live.

## What is in here

| Path | What it does |
|---|---|
| `tests/` | Your Playwright specs |
| `muraqib.config.ts` | The only file you need to edit |
| `scripts/watchdog.mjs` | Asks whether the nightly can still reach you |
| `scripts/check-nightly-heartbeat.mjs` | The heartbeat rules, on their own, with tests |
| `scripts/check-timeout-budget.mjs` | Fails the build if a slow night could go silent |
| `scripts/check-sensitive-paths.mjs` | Backs the auto-merge guard, in code rather than a prompt |
| `.github/workflows/` | The nightly, the fix workflow, the guard and the watchdog |
| `tasks/registry.ts` | Handwritten automation tasks, no runtime AI, zero token cost |

## Auto-merge

Off by default. Claude opens a PR, CI runs against it, and it waits for you to review and merge like any other PR. This is deliberate: CI passing means the fix did not break the tests it can see, not that the fix is correct.

If you turn `autoMerge` on, two independent things keep it away from payment, auth, migration and secrets code:

1. The Claude fix prompt is instructed to leave those for manual review regardless of the setting. That is a text instruction a model reads.
2. `.github/workflows/auto-merge-guard.yml` checks the actual changed files on any PR with auto-merge enabled and force-disables it if a sensitive path matches. That is code, not a prompt.

Turning it on requires one manual step: add "Muraqib Auto-Merge Guard / guard" as a required status check in your branch protection rules for `main`. Without it the guard still runs and will comment, but GitHub's native auto-merge can complete before the guard job does. A required status check is what makes GitHub wait. Auto-merge without both the guard and that setting is not a safety net, it is just skipping review.

## A note on this repo's own Actions tab

The nightly, the watchdog and the fix workflow are disabled here, and that is deliberate rather than an oversight.

This repository has no app to watch. Its `muraqib.config.ts` points at a placeholder, so its nightly failed on every single run, 81 out of 81, and its watchdog would now report that streak as furniture every morning. Which is correct, and it is exactly the thing this project tells you not to live with, so leaving it running to look busy would be dishonest.

What runs here instead is `self-check.yml`: the tests for this template's own code, and the four checks that keep the failure modes above from coming back. `npx muraqib init` enables the monitoring workflows in your repository, where there is something to monitor.

Related: the nightly no longer triggers on a push to `main`. The project this template came from removed that trigger months ago, because every merge kicked off a full 25 to 45 minute Playwright run against production for no information the nightly schedule would not give a few hours later. That lesson had never made it back into the template.

And if `baseUrl` is still the shipped placeholder, the run now fails immediately and says so, rather than producing DNS and navigation errors that read like a broken tool. An unconfigured monitor is not a passing monitor.

## Track record

This section used to promise a public defect history and then not have one. Here is the real thing.

Running since 2 June 2026 against a live production app, 164 nightly runs so far. Four incidents are written up in full in [LESSONS.md](LESSONS.md), including what was wrong, how it was actually verified as fixed rather than assumed, and what regression check now stops it coming back. Every one of them is a bug in Muraqib itself, found by using it. Security-relevant fixes have their own changelog in [SECURITY.md](SECURITY.md).

The most recent one is the least flattering and the most useful. Of those 164 runs, 7 succeeded, 76 failed, and 81 were cancelled, the last 60-plus consecutively. The job's `timeout-minutes` was killing the suite at 20 minutes, and because a cancelled run fires no alert, nothing said a word for over two months. The guard had gone quiet and the quiet looked exactly like everything being fine.

Both of the checks described further up exist because of that, and `npx muraqib doctor` was written so anyone already running this can find the same problem in their own repo in one command instead of two months.

## Compared to a hosted service

Octomind offered a similar idea, nightly AI-assisted QA, as a hosted product from around $89 a month. They raised close to $5M and shut down in April 2026 after about three years. That is a fact about their business model and their runway, not proof that nobody wants this. Testing does not get less important as more code gets written by an agent instead of a person. If anything it is the other way round.

This is a different shape entirely. You install it, it runs in your GitHub Actions on your Claude key, and there is no monthly bill because there is no service to bill for. The tradeoff is honest too: you set it up yourself, a config file, four secrets and your own specs, instead of signing up and getting a dashboard.

If you want hosted, zero setup and support, this is not that. If you want the same core idea for nothing and are fine reading a README, this is free and the full defect history above is public.

## Design principles

- Tasks are always handwritten. No runtime AI generates or executes tasks. Writing a new handler is one-time Claude work. Running it costs zero tokens.
- One email a week, plus one on the night something actually breaks. Not one per failed test. Signal, not noise.
- Test failure text is data, not instructions. The Claude fix prompt labels error output as untrusted and never lets it decide the auto-merge outcome.
- Auto-merge is opt-in and scoped. Off by default, and even when on, payment, auth, migration and secrets changes always wait for a human.
- A check that cannot be read is treated as broken, not as fine. Every guard in here fails closed on input it cannot parse.

## If you are running this

I would genuinely like to know. Open an issue, or star the repo if it is doing something useful for you. Right now there is no way for me to tell whether this is helping anyone, and that makes it hard to know what to build next.

If it broke, that is even more useful. Open an issue with what happened.

MIT License.
