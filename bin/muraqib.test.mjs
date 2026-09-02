import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, retargetWorkflow, findInstalledWorkflow, declaredWorkflowName } from "./muraqib.mjs";

const JOB_WITH_RUNS = [
  "name: Muraqib Nightly",
  "on:",
  "  schedule:",
  '    - cron: "0 2 * * *"',
  "",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 45",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: npm install",
  "",
].join("\n");

const GUARD = [
  "name: Muraqib Auto-Merge Guard",
  "on: pull_request_target",
  "",
  "jobs:",
  "  guard:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: Report no-op when auto-merge is not enabled",
  "        if: github.event.pull_request.auto_merge == null",
  '        run: echo "nothing to guard"',
  "      - uses: actions/checkout@v4",
  "      - run: node scripts/check-sensitive-paths.mjs",
  "",
].join("\n");

test("a root install is left byte for byte alone", () => {
  assert.equal(retargetWorkflow(JOB_WITH_RUNS, ".", "muraqib-nightly.yml"), JOB_WITH_RUNS);
});

test("a subdirectory install gets a working directory on the job", () => {
  const out = retargetWorkflow(JOB_WITH_RUNS, "tools/muraqib", "muraqib-nightly.yml");
  assert.match(out, /defaults:\n {6}run:\n {8}working-directory: tools\/muraqib/);
  // The job's own keys must survive intact, not be pushed out by the insert.
  assert.match(out, /timeout-minutes: 45/);
  assert.match(out, /runs-on: ubuntu-latest/);
});

test("CRLF input is retargeted too, not silently skipped", () => {
  // These files arrive from a git checkout, and on Windows core.autocrlf
  // hands them over as CRLF. A pattern written for LF matches nothing there,
  // and init would then write a workflow pointing at the wrong directory
  // without a word of warning. That happened while building this command.
  const crlf = JOB_WITH_RUNS.replace(/\n/g, "\r\n");
  const out = retargetWorkflow(crlf, "tools/muraqib", "muraqib-nightly.yml");
  assert.ok(out.includes("working-directory: tools/muraqib"));
  assert.ok(out.includes("\r\n"), "existing CRLF endings should be preserved, not converted");
});

test("the auto-merge guard gets its command path fixed and no working directory", () => {
  // A job default would apply to the echo step that deliberately runs before
  // the checkout, so it would fail on a directory that does not exist yet.
  // That job is meant to be a required status check, so failing it would
  // block every pull request in the host repo, not just auto-merge ones.
  const out = retargetWorkflow(GUARD, "tools/muraqib", "auto-merge-guard.yml");
  assert.ok(!out.includes("working-directory"));
  assert.ok(out.includes("run: node tools/muraqib/scripts/check-sensitive-paths.mjs"));
  assert.ok(out.includes('run: echo "nothing to guard"'));
});

test("an unknown workflow name is refused rather than guessed at", () => {
  assert.throws(
    () => retargetWorkflow(JOB_WITH_RUNS, "tools/muraqib", "something-new.yml"),
    /No retarget strategy/
  );
});

test("a workflow that does not match its strategy throws instead of writing a broken file", () => {
  assert.throws(
    () => retargetWorkflow("name: x\non: push\n", "tools/muraqib", "muraqib-nightly.yml"),
    /Refusing to write/
  );
  assert.throws(
    () => retargetWorkflow("name: x\non: push\n", "tools/muraqib", "auto-merge-guard.yml"),
    /Refusing to write/
  );
});

test("--help is help, wherever it appears", () => {
  assert.equal(parseArgs(["--help"]).command, "help");
  assert.equal(parseArgs(["-h"]).command, "help");
  assert.equal(parseArgs(["init", "--help"]).command, "help");
});

test("the command is the first bare word, not simply the first argument", () => {
  assert.equal(parseArgs(["--dry-run", "init"]).command, "init");
  assert.equal(parseArgs(["init", "--dry-run"]).dryRun, true);
});

test("a Windows-shaped --dir is normalized for the Linux runner that reads it", () => {
  assert.equal(parseArgs(["init", "--dir", "tools\\muraqib"]).dir, "tools/muraqib");
  assert.equal(parseArgs(["init", "--dir", "./tools//muraqib/"]).dir, "tools/muraqib");
  assert.equal(parseArgs(["init", "--dir", "."]).dir, ".");
  assert.equal(parseArgs(["init", "--dir", "./"]).dir, ".");
});

test("an unknown flag is reported rather than ignored", () => {
  assert.throws(() => parseArgs(["init", "--force"]), /Unknown flag/);
});

test("no arguments falls through to help, not to an accidental install", () => {
  assert.equal(parseArgs([]).command, undefined);
});

test("reads the name a workflow declares, quoted or not", () => {
  assert.equal(declaredWorkflowName(["name: Muraqib Nightly", "on: push", ""].join("\n")), "Muraqib Nightly");
  assert.equal(declaredWorkflowName(['name: "Muraqib Nightly"', ""].join("\n")), "Muraqib Nightly");
  assert.equal(declaredWorkflowName(["# name: commented out", "on: push", ""].join("\n")), null);
});

test("an already-installed workflow is found under a renamed file", () => {
  // A host project may well rename auto-merge-guard.yml to something tidier.
  // Matching on filename alone would then install a second copy of the same
  // guard next to it, which is not twice as safe, just one confusing extra
  // required status check on every PR. This case is real: it is exactly what
  // the project this template was built for had done.
  const contents = {
    "ci.yml": "name: CI\non: push\n",
    "muraqib-auto-merge-guard.yml": "name: Muraqib Auto-Merge Guard\non: pull_request_target\n",
  };
  const found = findInstalledWorkflow(
    ".github/workflows",
    "Muraqib Auto-Merge Guard",
    () => Object.keys(contents),
    path => contents[path.split(/[\\/]/).pop()]
  );
  assert.equal(found, "muraqib-auto-merge-guard.yml");
});

test("a workflow that is genuinely absent reports absent", () => {
  const found = findInstalledWorkflow(
    ".github/workflows",
    "Muraqib Watchdog",
    () => ["ci.yml"],
    () => "name: CI\non: push\n"
  );
  assert.equal(found, null);
});

test("non-yaml files in the workflows directory are ignored", () => {
  // A README in .github/workflows that happens to start with a name: line
  // must not be mistaken for an installed workflow.
  const found = findInstalledWorkflow(
    ".github/workflows",
    "Muraqib Watchdog",
    () => ["README.md"],
    () => "name: Muraqib Watchdog\n"
  );
  assert.equal(found, null);
});
