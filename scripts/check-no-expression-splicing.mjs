#!/usr/bin/env node
/**
 * Fails if any workflow step's script/run body contains a literal `${{ }}`
 * GitHub Actions expression.
 *
 * Why this matters: GitHub textually substitutes `${{ ... }}` with its
 * resolved value BEFORE the script or shell command runs. If that expression
 * sits inside a script/run body instead of an `env:` block, untrusted text
 * (a backtick, `${...}`, a quote, `$(...)`) inside the resolved value can
 * break out of the surrounding string and execute as code, with whatever
 * permissions that step's token has (CWE-94). This exact bug shipped in this
 * repo's first commit. This check exists so it can't come back unnoticed,
 * including from a future AI-assisted edit.
 *
 * Run: node scripts/check-no-expression-splicing.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";

const WORKFLOWS_DIRS = [".github/workflows"];
const EXPRESSION = /\$\{\{/;

function collectScriptBodies(node, path, out) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectScriptBodies(item, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if ((key === "script" || key === "run") && typeof value === "string") {
        out.push({ path: `${path}.${key}`, body: value });
      } else {
        collectScriptBodies(value, `${path}.${key}`, out);
      }
    }
  }
}

/**
 * Pure function, exported for the test suite: given a workflow file's raw
 * YAML text, returns a list of { path, body, line } findings where a
 * script/run body contains a literal ${{ }} expression. Empty array = clean.
 */
export function findExpressionSplices(content, label = "<inline>") {
  const findings = [];
  const docs = parseAllDocuments(content, { prettyErrors: true });

  for (const doc of docs) {
    if (doc.errors.length) {
      findings.push({ path: label, body: null, line: null, parseError: doc.errors.map(e => e.message).join("; ") });
      continue;
    }
    const data = doc.toJS();
    const hits = [];
    collectScriptBodies(data, label, hits);
    for (const hit of hits) {
      if (EXPRESSION.test(hit.body)) {
        const line = hit.body.split("\n").find(l => EXPRESSION.test(l));
        findings.push({ path: hit.path, body: hit.body, line: line.trim(), parseError: null });
      }
    }
  }
  return findings;
}

function main() {
  // Resolve relative to this script's own location, not process.cwd(). A
  // check that silently scans zero files and still prints "OK" is worse than
  // no check at all, and cwd-dependence is exactly how that happens (e.g. run
  // from scripts/ instead of the repo root, or from a monorepo subpackage).
  const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

  let filesScanned = 0;
  let injectionCount = 0;
  let parseErrorCount = 0;

  for (const dir of WORKFLOWS_DIRS) {
    const absDir = join(repoRoot, dir);
    let files;
    try {
      files = readdirSync(absDir).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));
    } catch {
      continue; // dir may not exist in every checkout
    }

    for (const file of files) {
      const fullPath = join(absDir, file);
      const content = readFileSync(fullPath, "utf8");
      const findings = findExpressionSplices(content, fullPath);
      filesScanned++;

      for (const finding of findings) {
        if (finding.parseError) {
          console.error(`YAML PARSE ERROR in ${fullPath}:`);
          console.error("  " + finding.parseError);
          parseErrorCount++;
        } else {
          console.error(`SCRIPT-INJECTION RISK: ${finding.path}`);
          console.error(`  contains a literal \${{ }} expression inside the script/run body:`);
          console.error(`  ${finding.line}`);
          console.error(`  Fix: pass the value via env: + process.env (or $VAR in bash) instead.`);
          injectionCount++;
        }
      }
    }
  }

  if (filesScanned === 0) {
    console.error(`FAILED: found 0 workflow files to check in ${WORKFLOWS_DIRS.join(", ")} (resolved against ${repoRoot}). A check that scans nothing and reports OK is worse than no check. Fix the path or the invocation.`);
    process.exit(1);
  }

  if (parseErrorCount > 0 || injectionCount > 0) {
    if (parseErrorCount > 0) console.error(`\n${parseErrorCount} file(s) failed to parse as YAML. Fix the syntax error(s) above.`);
    if (injectionCount > 0) console.error(`\n${injectionCount} workflow step(s) splice a GitHub expression directly into a script/run body. See fix(es) above.`);
    process.exit(1);
  }

  console.log(`OK: checked ${filesScanned} workflow file(s), no expression-splicing found.`);
}

// Only run as a CLI when invoked directly, not when imported by the test suite.
// pathToFileURL handles both relative and absolute argv[1] correctly. The
// naive `file://${process.argv[1]}` string-concat this replaced silently
// never matched (argv[1] is often relative, e.g. "scripts/check-...mjs"),
// so main() never ran and the script exited 0 having checked nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
