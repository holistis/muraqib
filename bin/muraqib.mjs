#!/usr/bin/env node
/**
 * muraqib CLI.
 *
 *   npx muraqib init [--dir <path>] [--dry-run]
 *   npx muraqib doctor [--dir <path>]
 *
 * `init` copies the template into a repo. `doctor` inspects a repo that
 * already has Muraqib and reports the ways its nightly could stop reaching a
 * person, which is the failure mode that cost this project two silent months
 * (see LESSONS.md).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { findTimeoutBudgetProblems } from "../scripts/check-timeout-budget.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;

/** Files that live wherever the user decides to put Muraqib. */
const PORTABLE_FILES = [
  "muraqib.config.ts",
  "playwright.config.ts",
  "scripts/check-sensitive-paths.mjs",
  "scripts/check-nightly-heartbeat.mjs",
  "scripts/watchdog.mjs",
];

/**
 * Starting points, not files to keep in sync. They only go in when there are
 * no specs at all yet.
 *
 * Copying an example spec into a repo that already has real ones adds a test
 * written against a fictional app to a monitor pointed at a real one. It fails
 * on the first night, and it fails for a reason the owner did not cause and
 * cannot fix by changing their own code. Running init a second time to pick up
 * a new workflow should never hand someone a broken nightly as the price.
 */
const EXAMPLE_SPECS = [
  "tests/auth.spec.ts",
  "tests/checkout.spec.ts",
  "tests/public-pages.spec.ts",
];

/** True when the target already has Playwright specs of its own. */
function hasExistingSpecs(testsDir) {
  if (!existsSync(testsDir)) return false;
  return readdirSync(testsDir).some(entry => entry.endsWith(".spec.ts") || entry.endsWith(".spec.js"));
}

/**
 * Finds a workflow already installed under any filename, by reading its
 * `name:` rather than trusting the path.
 *
 * Filenames drift. A host project may well have renamed auto-merge-guard.yml
 * to muraqib-auto-merge-guard.yml to keep its workflow list tidy, and a
 * filename-only check would then install a second copy of the same guard
 * beside it. Two guards on the same PR is not twice as safe, it is one
 * confusing duplicate status check and a second workflow nobody remembers
 * agreeing to.
 */
export function findInstalledWorkflow(workflowsDir, workflowName, readDir = readdirSync, readFile = readFileSync) {
  if (!existsSync(workflowsDir)) return null;
  for (const entry of readDir(workflowsDir)) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const source = readFile(join(workflowsDir, entry), "utf8");
    const declared = /^name:\s*(.+?)\s*$/m.exec(source);
    if (declared && declared[1].replace(/^["']|["']$/g, "") === workflowName) return entry;
  }
  return null;
}

/** The `name:` each shipped workflow declares, used for the check above. */
export function declaredWorkflowName(source) {
  const match = /^name:\s*(.+?)\s*$/m.exec(source);
  return match ? match[1].replace(/^["']|["']$/g, "") : null;
}

/** Files GitHub insists live at the repo root, whatever else you do. */
const WORKFLOW_FILES = [
  ".github/workflows/muraqib-nightly.yml",
  ".github/workflows/muraqib-claude-fix.yml",
  ".github/workflows/muraqib-watchdog.yml",
  ".github/workflows/auto-merge-guard.yml",
];

export function parseArgs(argv) {
  // The command is the first bare word, not simply argv[0]. Reading position 0
  // as the command means "muraqib --help" parses the flag as a command name
  // and reports it as unknown, which is a rude thing to do to someone asking
  // for help.
  const args = { command: undefined, dir: ".", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") args.dir = argv[++i] ?? ".";
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.command = "help";
    else if (argv[i].startsWith("-")) throw new Error(`Unknown flag ${argv[i]}. Run "npx muraqib --help".`);
    else if (args.command === undefined) args.command = argv[i];
  }
  if (args.dir !== ".") {
    // Normalize to a forward-slash relative path. It ends up inside YAML that
    // runs on a Linux runner, so a Windows-style path written here would be
    // copied through and break there rather than on the machine that typed it.
    args.dir = args.dir.split(/[\\/]+/).filter(part => part && part !== ".").join("/");
    if (args.dir === "") args.dir = ".";
  }
  return args;
}

/**
 * How each workflow is pointed at a Muraqib that does not live at the repo
 * root. GitHub only reads workflows from .github/workflows at the root, so
 * once the code moves into a subdirectory the workflow and the code it runs
 * are no longer in the same place.
 *
 * The obvious move is a job-level `defaults.run.working-directory` on all of
 * them, and for three of the four that is right: every run step sits after the
 * checkout and genuinely needs to be inside the Muraqib directory, because
 * npm and npx resolve against the current directory.
 *
 * auto-merge-guard is the exception, and it is not a stylistic one. Its first
 * step is a plain echo that runs BEFORE the checkout, on purpose: it reports
 * success on PRs where auto-merge is off, so the job always ends with a real
 * conclusion instead of SKIPPED (see check-required-check-not-skippable.mjs
 * and the 2026-08-29 entry in LESSONS.md). A job default would point that echo
 * at a directory that does not exist yet, the step would fail, and since this
 * job is meant to be a required status check, it would block every pull
 * request in the host repo. So the guard gets its one command path rewritten
 * instead, and no defaults block.
 */
const RETARGET_STRATEGY = {
  "muraqib-nightly.yml": "working-directory",
  "muraqib-watchdog.yml": "working-directory",
  "muraqib-claude-fix.yml": "working-directory",
  "auto-merge-guard.yml": "command-path",
};

export function retargetWorkflow(source, dir, workflowFileName) {
  if (dir === ".") return source;

  const strategy = RETARGET_STRATEGY[workflowFileName];
  if (!strategy) {
    throw new Error(
      `No retarget strategy for ${workflowFileName}. Add one to RETARGET_STRATEGY rather than guessing, because guessing wrong here silently breaks a workflow in someone else's repo.`
    );
  }

  // Line endings are matched as \r?\n throughout. These files come out of a
  // git checkout, and on Windows core.autocrlf hands them over as CRLF. A
  // pattern that assumes LF quietly matches nothing there, and init would then
  // write a workflow that points at the wrong directory without saying a word.
  // Which is the same failure shape this whole release is about, so it gets
  // the same treatment: match both, then verify the edit actually landed.
  let out;

  if (strategy === "working-directory") {
    out = source.replace(
      /(\r?\n)( {2}[A-Za-z0-9_-]+:\r?\n {4}runs-on: [^\r\n]+)(\r?\n)/,
      (_match, before, jobHeader, after) =>
        `${before}${jobHeader}${after}    defaults:${after}      run:${after}        working-directory: ${dir}${after}`
    );
    if (!out.includes(`working-directory: ${dir}`)) {
      throw new Error(
        `Could not find the job header in ${workflowFileName} to add a working directory to. Refusing to write a workflow that would silently run in the wrong place. Please open an issue with your workflow file.`
      );
    }
    return out;
  }

  // command-path: leave the job alone, fix only the script's own location.
  out = source.replace(/run: node scripts\//g, `run: node ${posix.join(dir, "scripts")}/`);
  if (out === source) {
    throw new Error(
      `Expected a "node scripts/..." command in ${workflowFileName} to retarget, and found none. Refusing to write a workflow whose script path would not resolve.`
    );
  }
  return out;
}

function init(args) {
  const target = process.cwd();
  const results = [];

  const localPath = file => join(target, args.dir === "." ? file : join(args.dir, file));
  const specsAlreadyHere = hasExistingSpecs(localPath("tests"));

  for (const file of PORTABLE_FILES) {
    const to = localPath(file);
    if (existsSync(to)) {
      results.push({ path: to, status: "kept" });
      continue;
    }
    if (!args.dryRun) {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(join(PACKAGE_ROOT, file)));
    }
    results.push({ path: to, status: args.dryRun ? "would-write" : "written" });
  }

  for (const file of EXAMPLE_SPECS) {
    const to = localPath(file);
    if (specsAlreadyHere) {
      results.push({ path: to, status: "skipped-example" });
      continue;
    }
    if (existsSync(to)) {
      results.push({ path: to, status: "kept" });
      continue;
    }
    if (!args.dryRun) {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(join(PACKAGE_ROOT, file)));
    }
    results.push({ path: to, status: args.dryRun ? "would-write" : "written" });
  }

  const workflowsDir = join(target, ".github/workflows");
  for (const file of WORKFLOW_FILES) {
    const to = join(target, file);
    const source = readFileSync(join(PACKAGE_ROOT, file), "utf8");

    const installedAs = findInstalledWorkflow(workflowsDir, declaredWorkflowName(source));
    if (installedAs) {
      results.push({ path: join(workflowsDir, installedAs), status: "kept" });
      continue;
    }
    if (existsSync(to)) {
      results.push({ path: to, status: "kept" });
      continue;
    }

    const retargeted = retargetWorkflow(source, args.dir, file.split("/").pop());
    if (!args.dryRun) {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, retargeted);
    }
    results.push({ path: to, status: args.dryRun ? "would-write" : "written" });
  }

  const kept = results.filter(r => r.status === "kept");
  const skipped = results.filter(r => r.status === "skipped-example");
  const LABELS = {
    kept: "kept      ",
    "skipped-example": "skipped   ",
  };
  const SUFFIXES = {
    kept: "  (already there, left alone)",
    "skipped-example": "  (you already have specs)",
  };
  for (const r of results) {
    const label = LABELS[r.status] ?? (args.dryRun ? "would write" : "wrote     ");
    console.log(`  ${label} ${relative(target, r.path) || r.path}${SUFFIXES[r.status] ?? ""}`);
  }

  console.log("");
  if (kept.length > 0) {
    console.log(`${kept.length} file(s) already existed and were left exactly as they were.`);
  }
  if (skipped.length > 0) {
    console.log(
      `${skipped.length} example spec(s) skipped. This repo already has its own, and dropping an example written against a fictional app into a monitor pointed at a real one would just fail every night for no reason.`
    );
  }
  if (kept.length > 0 || skipped.length > 0) console.log("");
  if (args.dryRun) {
    console.log("Dry run, nothing was written. Drop --dry-run to apply.");
    return;
  }

  const prefix = args.dir === "." ? "" : `${args.dir}/`;
  const cd = args.dir === "." ? "" : `cd ${args.dir} && `;
  console.log("Next:");
  console.log(`  1. ${cd}npm install --save-dev @playwright/test dotenv && npx playwright install chromium`);
  console.log(`  2. Edit ${prefix}muraqib.config.ts: baseUrl, flows, alerting.`);
  console.log("  3. Add repo secrets: ANTHROPIC_API_KEY, RESEND_API_KEY, MURAQIB_EMAIL_TO, MURAQIB_EMAIL_FROM.");
  console.log(`  4. Write your specs in ${prefix}tests/, one file per flow.`);
  console.log("  5. npx muraqib doctor");
}

function findFirst(target, candidates) {
  for (const candidate of candidates) {
    const full = join(target, candidate);
    if (existsSync(full)) return { path: full, relative: candidate };
  }
  return null;
}

function doctor(args) {
  const target = process.cwd();
  const base = args.dir === "." ? "" : `${args.dir}/`;
  const problems = [];
  const passed = [];

  const workflow = findFirst(target, [".github/workflows/muraqib-nightly.yml"]);
  const config = findFirst(target, [
    `${base}playwright.config.ts`,
    `${base}playwright.config.js`,
    "playwright.config.ts",
    "playwright.config.js",
  ]);

  if (!workflow) {
    problems.push({
      title: "Nothing is running on a schedule",
      detail:
        '.github/workflows/muraqib-nightly.yml is missing, so no test run happens without someone starting it. Run "npx muraqib init".',
    });
  }
  if (!config) {
    problems.push({
      title: "No Playwright config found",
      detail: `Looked in ${base || "the repo root"}. Pass --dir if Muraqib lives somewhere else in this repo.`,
    });
  }

  if (workflow && config) {
    const budget = findTimeoutBudgetProblems(
      readFileSync(workflow.path, "utf8"),
      readFileSync(config.path, "utf8"),
      { workflowPath: workflow.relative, configPath: config.relative }
    );
    if (budget.length === 0) {
      passed.push("A slow suite fails loudly. Playwright stops itself before the runner can kill the job.");
    }
    for (const problem of budget) {
      problems.push({
        title: "A slow night would go silent instead of failing",
        detail: `${problem.label}: ${problem.message}`,
      });
    }
  }

  if (findFirst(target, [".github/workflows/muraqib-watchdog.yml"])) {
    passed.push("A nightly that stops reporting altogether will still reach you. The watchdog is installed.");
  } else {
    problems.push({
      title: "Nothing is watching the watchman",
      detail:
        'There is no muraqib-watchdog.yml. Every Muraqib alert hangs off a test run that finished and reported, so on the day the run itself stops happening, no alert can fire and the silence is indistinguishable from everything being fine. Run "npx muraqib init" again to add it, your existing files are left alone.',
    });
  }

  console.log(`muraqib doctor ${VERSION}`);
  console.log("");

  for (const problem of problems) {
    console.log(`PROBLEM  ${problem.title}`);
    console.log(`         ${problem.detail}`);
    console.log("");
  }
  for (const note of passed) console.log(`OK       ${note}`);

  if (problems.length > 0) {
    console.log("");
    console.log(`${problems.length} problem(s). Each one means a night where your app is not checked and you are not told.`);
    process.exitCode = 1;
  }
}

function help() {
  console.log(`muraqib ${VERSION}

  npx muraqib init [--dir <path>] [--dry-run]
      Copy the template into this repo. Never overwrites a file you already
      have. --dir puts the code in a subdirectory and points the workflows
      at it.

  npx muraqib doctor [--dir <path>]
      Check an existing install for the ways its nightly can stop reaching
      you. Exits non-zero when it finds any, so it works as a CI step.

https://github.com/holistis/muraqib`);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  if (args.command === "init") return init(args);
  if (args.command === "doctor") return doctor(args);
  if (args.command === "help" || !args.command) return help();

  console.error(`Unknown command "${args.command}". Run "npx muraqib --help".`);
  process.exitCode = 1;
}

// Only run as a CLI when invoked directly, so the tests can import the helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
