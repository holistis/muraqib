# Lessons

Running log of things this project got wrong and fixed, and why. Kept separate from SECURITY.md because not everything here is a security issue — some of it is just "this broke in a way worth remembering."

## 2026-08-28 — three layered bugs in the same file, found while preparing for a wider release

**1. Script injection (CWE-94).** Failure text and workflow inputs were spliced via `${{ }}` directly into JS template literals and a bash string instead of `env:` variables. See SECURITY.md for the fix and the permanent regression check (`npm run check:workflows`).

**2. The YAML was invalid from the first commit, and nobody noticed for months.** A multi-line JS template literal was written without indentation inside a YAML block scalar (`script: |`), which requires every line to be indented at least as much as the block's first line. Generic YAML linters can miss this depending on how strict they are; the way it was actually confirmed was calling `gh workflow run` against the real workflow_dispatch API and reading the exact parse error GitHub returned. Lesson: for GitHub Actions workflows specifically, a YAML-valid file is not the same as a GitHub-Actions-valid file — when in doubt, trigger it for real (or at minimum lint with a tool that understands the Actions schema, not just generic YAML).

**3. Self-inflicted, caught immediately.** The comments explaining bug #1 literally contained the string `${{ }}` (empty) to describe the danger. GitHub's parser scans the *entire file* for `${{ ... }}` patterns, including inside comments in a script block, and tried to evaluate the empty one as a real expression. Lesson: never write the literal double-brace syntax in a comment inside a workflow file, even to explain what not to do. Describe it in words instead.

**How #2 was verified as actually fixed, not just "looks right":** `gh workflow run` reads a workflow's `workflow_dispatch` schema from the **default branch**, not the ref you pass — so a feature branch fix can't be end-to-end confirmed via API dispatch until it's merged. The fallback verification used here was (a) a real YAML parser confirming structural validity, and (b) a regex audit confirming every remaining `${{ ... }}` expression in the file resolves to a real, non-empty context reference (`inputs.*`, `secrets.*`, `steps.*.outputs.*`, `github.*`) rather than assuming "no parse error" means "no problem."

**Why this file exists:** the same failure-driven-improvement loop Muraqib applies to a host project's production code should apply to Muraqib's own development too. If you find something else, add it here.
