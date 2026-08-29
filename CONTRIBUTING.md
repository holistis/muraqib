# Contributing

This is a solo-maintained project. Contributions are welcome, but keep these in mind:

## Before opening a PR

- Run `npm run check:workflows` and `npm run check:required-checks` if you touch anything under `.github/workflows/`. The first fails the build on GitHub-expression script injection; the second fails it if a job that's (or could become) a required status check carries a job-level `if:`, which makes it report SKIPPED instead of pass/fail. See `SECURITY.md` for why both matter.
- Keep the diff small and focused. One fix or one feature per PR.
- If you add a new task handler under `tasks/`, add one entry to `tasks/registry.ts`, `task-runner.ts` should never need to change.

## What belongs here vs. what doesn't

This repo is the generic framework: the nightly runner, the Claude auto-fix workflow, the task-runner, and a couple of example specs/tasks to show the pattern. Project-specific tests, task handlers, and config values belong in the project that adopts this template, not in a PR against this repo.

## Reporting a security issue

See `SECURITY.md`.
