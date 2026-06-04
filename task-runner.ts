/**
 * Muraqib Task Runner
 *
 * Runs a typed task from the registry. No text-guessing, no second AI model:
 * you (or Claude Code) explicitly choose the task and pass parameters as --flags.
 * Muraqib provides the hands; Claude Code is the brain.
 *
 * Usage:
 *   npm run task -- --list
 *   npm run task -- post-linkedin --text="Today I shipped..."
 *   npm run task -- set-env --key=MY_KEY --value=abc123
 */

import { connectBrowser, closeBrowser } from "./lib/browser";
import { tasks, findTask } from "./tasks/registry";
import { config as loadDotenv } from "dotenv";
import * as path from "path";

loadDotenv({ path: path.join(__dirname, ".env") });

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = "true";
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printList(): void {
  console.log("\nMuraqib tasks:\n");
  for (const t of tasks) {
    const tag = t.needsBrowser ? "[browser]" : "[cli]    ";
    console.log(`  ${tag} ${t.name.padEnd(14)} ${t.summary}`);
    for (const p of t.params) {
      const req = p.required ? "required" : "optional";
      console.log(`               --${p.name} (${req}): ${p.description}`);
    }
    console.log("");
  }
}

function printResult(result: unknown): void {
  if (result !== undefined && result !== null) {
    console.log("\n=== Result ===");
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    console.log("==============\n");
  }
  console.log("✓ Task completed");
}

async function run(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.list || positional[0] === "list" || positional.length === 0) {
    printList();
    return;
  }

  const task = findTask(positional[0]);
  if (!task) {
    console.error(`Unknown task: "${positional[0]}". Run 'npm run task -- --list' to see all tasks.`);
    process.exit(1);
  }

  const missing = task.params.filter(p => p.required && (flags[p.name] === undefined || flags[p.name] === ""));
  if (missing.length > 0) {
    console.error(`Task "${task.name}" is missing: ${missing.map(p => "--" + p.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n[Muraqib] Running task: ${task.name}\n`);

  if (!task.needsBrowser) {
    printResult(await task.run(flags, null));
    return;
  }

  const session = await connectBrowser(false);
  try {
    printResult(await task.run(flags, session.page));
  } catch (err: any) {
    console.error("✗ Task failed:", err?.message || err);
    process.exit(1);
  } finally {
    await closeBrowser(session);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
