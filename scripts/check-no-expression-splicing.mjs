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
 * repo's first commit — this check exists so it can't come back unnoticed,
 * including from a future AI-assisted edit.
 *
 * Run: node scripts/check-no-expression-splicing.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const WORKFLOWS_DIRS = [".github/workflows", "tools/muraqib/.github-workflows"];
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

let failed = false;

for (const dir of WORKFLOWS_DIRS) {
  let files;
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));
  } catch {
    continue; // dir may not exist in every checkout (e.g. host projects without the template copy)
  }

  for (const file of files) {
    const fullPath = join(dir, file);
    const content = readFileSync(fullPath, "utf8");
    const docs = parseAllDocuments(content, { prettyErrors: true });

    for (const doc of docs) {
      if (doc.errors.length) {
        console.error(`YAML PARSE ERROR in ${fullPath}:`);
        for (const err of doc.errors) console.error("  " + err.message);
        failed = true;
        continue;
      }
      const data = doc.toJS();
      const hits = [];
      collectScriptBodies(data, fullPath, hits);
      for (const hit of hits) {
        if (EXPRESSION.test(hit.body)) {
          const line = hit.body.split("\n").find(l => EXPRESSION.test(l));
          console.error(`SCRIPT-INJECTION RISK: ${hit.path}`);
          console.error(`  contains a literal \${{ }} expression inside the script/run body:`);
          console.error(`  ${line.trim()}`);
          console.error(`  Fix: pass the value via env: + process.env (or $VAR in bash) instead.`);
          failed = true;
        }
      }
    }
  }
}

if (failed) {
  console.error("\nFAILED: one or more workflow steps splice a GitHub expression directly into a script/run body.");
  process.exit(1);
} else {
  console.log("OK: no workflow step splices a GitHub expression directly into its script/run body.");
}
