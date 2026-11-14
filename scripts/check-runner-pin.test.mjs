import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectRunners } from "./check-runner-pin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const INSTALL = "npx playwright install --with-deps chromium";

const problemsOf = (yaml, opts) => inspectRunners(yaml, opts).problems;

const nightly = ({ runsOn = "ubuntu-24.04", install = INSTALL, jobExtra = "", extraJobs = "" } = {}) => `
name: Muraqib Nightly
on:
  schedule:
    - cron: "0 2 * * *"
jobs:
  test:
    runs-on: ${runsOn}
${jobExtra}    steps:
      - uses: actions/checkout@v4
      - run: ${install}
      - run: npx playwright test
${extraJobs}`;

const matrixWorkflow = ({ axis = "[ubuntu-24.04, ubuntu-22.04]", include = "", runsOn = "${{ matrix.os }}" } = {}) => `
name: Muraqib Nightly
on: workflow_dispatch
jobs:
  test:
    strategy:
      matrix:
        os: ${axis}
${include}    runs-on: ${runsOn}
    steps:
      - run: ${INSTALL}
`;

const shippedTemplate = () => readFileSync(join(here, "..", ".github", "workflows", "muraqib-nightly.yml"), "utf8");

test("catches the setup that failed in production: a floating label on the browser install", () => {
  const { problems, installingJobs } = inspectRunners(nightly({ runsOn: "ubuntu-latest" }));
  assert.equal(installingJobs, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0].label, /job "test"/);
  assert.match(problems[0].message, /ubuntu-latest/);
  assert.match(problems[0].message, /ubuntu-24\.04/);
});

test("a pinned runner passes, and the job is counted so a pass is not vacuous", () => {
  const { problems, installingJobs } = inspectRunners(nightly({ runsOn: "ubuntu-24.04" }));
  assert.deepEqual(problems, []);
  assert.equal(installingJobs, 1);
});

test("the label is matched whatever the casing and spacing in the file", () => {
  assert.equal(problemsOf(nightly({ runsOn: "Ubuntu-Latest" })).length, 1);
  assert.equal(problemsOf(nightly({ runsOn: '"ubuntu-latest"' })).length, 1);
});

test("a job that never installs a browser is not this check's business", () => {
  const { problems, installingJobs } = inspectRunners(nightly({ runsOn: "ubuntu-latest", install: "npm ci" }));
  assert.deepEqual(problems, []);
  assert.equal(installingJobs, 0);
});

test("install-deps alone is not a browser install: on a release Playwright does not know it only warns", () => {
  const { problems, installingJobs } = inspectRunners(
    nightly({ runsOn: "ubuntu-latest", install: "npx playwright install-deps chromium" })
  );
  assert.deepEqual(problems, []);
  assert.equal(installingJobs, 0);
});

test("a job inside a container takes its operating system from the image, not the runner", () => {
  const { problems, installingJobs } = inspectRunners(
    nightly({ runsOn: "ubuntu-latest", jobExtra: "    container: mcr.microsoft.com/playwright:v1.64.1-noble\n" })
  );
  assert.deepEqual(problems, []);
  assert.equal(installingJobs, 0);
});

test("every spelling of the install command is recognized", () => {
  const spellings = [
    "npx playwright install chromium",
    "npx playwright install",
    "npx playwright@1.64.1 install --with-deps",
    "yarn playwright install",
    "pnpm exec playwright install --with-deps",
    "python -m playwright install chromium",
    "./node_modules/.bin/playwright install",
  ];
  for (const install of spellings) {
    assert.equal(problemsOf(nightly({ runsOn: "ubuntu-latest", install })).length, 1, install);
  }
});

test("an install in the middle of a multi-line run body is found", () => {
  const yaml = `
name: Muraqib Nightly
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
          npm ci
          npx playwright install --with-deps chromium
          echo done
`;
  assert.equal(problemsOf(yaml).length, 1);
});

test("the words appearing in a comment or a step name are not an install", () => {
  const yaml = `
name: Muraqib Nightly
on: workflow_dispatch
jobs:
  test:
    # runs on ubuntu-latest in the old setup
    runs-on: ubuntu-24.04
    steps:
      - name: Install Playwright Chromium on ubuntu-latest
        run: ${INSTALL}
`;
  assert.deepEqual(problemsOf(yaml), []);
});

test("a floating label in a list is caught, a self-hosted pool is not", () => {
  assert.equal(problemsOf(nightly({ runsOn: "[ubuntu-latest]" })).length, 1);
  assert.equal(problemsOf(nightly({ runsOn: "[self-hosted, linux]" })).length, 0);
});

test("a list that names self-hosted is the owner's machine even with an ubuntu-latest label on it", () => {
  const { problems, installingJobs } = inspectRunners(nightly({ runsOn: "[self-hosted, ubuntu-latest]" }));
  assert.deepEqual(problems, []);
  assert.equal(installingJobs, 1);
});

test("a matrix leg on ubuntu-latest is still reported when another leg is self-hosted", () => {
  assert.equal(problemsOf(matrixWorkflow({ axis: "[self-hosted, ubuntu-latest]" })).length, 1);
  assert.equal(problemsOf(matrixWorkflow({ axis: "[ubuntu-latest, self-hosted]" })).length, 1);
  assert.equal(problemsOf(matrixWorkflow({ axis: '["self-hosted", "ubuntu-latest"]' })).length, 1);
  const include = "        include:\n          - os: ubuntu-latest\n";
  assert.equal(problemsOf(matrixWorkflow({ axis: "[self-hosted]", include })).length, 1);
});

test("a list that names self-hosted stays the owner's machine when a matrix value fills one slot", () => {
  const { problems, installingJobs } = inspectRunners(
    matrixWorkflow({ axis: "[ubuntu-latest]", runsOn: '[self-hosted, "${{ matrix.os }}"]' })
  );
  assert.deepEqual(problems, []);
  assert.equal(installingJobs, 1);
});

test("a long run of playwright@ does not stall the install pattern", () => {
  const body = "playwright@".repeat(30000);
  const yaml = `jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: |\n          ${body}\n`;
  const started = Date.now();
  inspectRunners(yaml);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
});

test("labels inside an object are read, a bare runner group is the owner's own pool", () => {
  assert.equal(problemsOf(nightly({ runsOn: "{ group: big-runners, labels: [ubuntu-latest] }" })).length, 1);
  assert.equal(problemsOf(nightly({ runsOn: "{ group: big-runners }" })).length, 0);
});

test("a matrix is resolved: one floating value is enough to fail it", () => {
  assert.equal(problemsOf(matrixWorkflow({ axis: "[ubuntu-24.04, ubuntu-latest]" })).length, 1);
  assert.equal(problemsOf(matrixWorkflow({ axis: "[ubuntu-24.04, ubuntu-22.04]" })).length, 0);
});

test("a floating label that arrives through include is not missed", () => {
  const include = "        include:\n          - os: ubuntu-latest\n";
  assert.equal(problemsOf(matrixWorkflow({ axis: "[ubuntu-24.04]", include })).length, 1);
});

test("a matrix exclude is not applied, so an excluded floating value is still reported", () => {
  const include = "        exclude:\n          - os: ubuntu-latest\n";
  assert.equal(problemsOf(matrixWorkflow({ axis: "[ubuntu-24.04, ubuntu-latest]", include })).length, 1);
});

test("a matrix the check cannot list fails closed instead of passing", () => {
  assert.equal(problemsOf(matrixWorkflow({ axis: "${{ fromJSON(vars.OS_LIST) }}" })).length, 1);
  assert.equal(problemsOf(matrixWorkflow({ runsOn: "${{ matrix.missing }}" })).length, 1);
});

test("an expression in runs-on fails closed", () => {
  const problems = problemsOf(nightly({ runsOn: "${{ inputs.runner }}" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /cannot tell/);
});

test("an installing job with no runs-on fails closed", () => {
  const yaml = `
name: Muraqib Nightly
on: workflow_dispatch
jobs:
  test:
    steps:
      - run: ${INSTALL}
`;
  assert.equal(problemsOf(yaml).length, 1);
});

test("two jobs, one floating: only that one is reported, and both are counted", () => {
  const extraJobs = `  second:
    runs-on: ubuntu-latest
    steps:
      - run: ${INSTALL}
`;
  const { problems, installingJobs } = inspectRunners(nightly({ runsOn: "ubuntu-24.04", extraJobs }));
  assert.equal(installingJobs, 2);
  assert.equal(problems.length, 1);
  assert.match(problems[0].label, /job "second"/);
});

test("both jobs floating: both are reported", () => {
  const extraJobs = `  second:
    runs-on: ubuntu-latest
    steps:
      - run: ${INSTALL}
`;
  assert.equal(problemsOf(nightly({ runsOn: "ubuntu-latest", extraJobs })).length, 2);
});

test("a file it cannot parse, an empty file and a file with no jobs all fail closed", () => {
  assert.equal(problemsOf("jobs:\n  test:\n    runs-on: [unclosed\n").length, 1);
  assert.equal(problemsOf("").length, 1);
  assert.equal(problemsOf("name: Muraqib Nightly\non: workflow_dispatch\n").length, 1);
  assert.equal(problemsOf("jobs: {}\n").length, 1);
});

test("a truncated file does not pass", () => {
  const full = nightly({ runsOn: "ubuntu-latest" });
  const truncated = full.slice(0, full.indexOf("steps:") + 4);
  assert.notEqual(problemsOf(truncated).length, 0);
});

test("the workflow path in the report is the one the caller passed", () => {
  const [problem] = problemsOf(nightly({ runsOn: "ubuntu-latest" }), { workflowPath: "ci/nightly.yml" });
  assert.match(problem.label, /^ci\/nightly\.yml job "test"$/);
});

test("the template shipped in this repo is pinned, and it does install a browser", () => {
  const { problems, installingJobs } = inspectRunners(shippedTemplate());
  assert.deepEqual(problems, []);
  assert.ok(installingJobs >= 1, "the template must install a browser, otherwise this test proves nothing");
});

test("the same template with the label put back is caught", () => {
  const source = shippedTemplate();
  const mutated = source.replace(/^(\s+)runs-on: ubuntu-24\.04\r?$/m, "$1runs-on: ubuntu-latest");
  assert.notEqual(mutated, source, "the mutation must change the file");
  assert.equal(problemsOf(mutated).length, 1);
});
