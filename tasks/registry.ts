/**
 * Muraqib task registry.
 *
 * Each task is self-describing: name, summary, whether it needs a browser,
 * and which parameters it accepts. The task runner reads this registry and
 * never has to guess from free text.
 *
 * Adding a task = one entry below + a handler file in tasks/.
 * task-runner.ts never needs to change.
 *
 * Philosophy:
 *   Tasks are ALWAYS handwritten, never AI-generated at runtime.
 *   Writing a new handler is a one-time Claude Code session.
 *   Running it costs 0 tokens, 0 dollars.
 */

import type { Page } from "playwright";

export interface TaskParam {
  name: string;
  required: boolean;
  description: string;
}

export interface TaskDef {
  /** CLI name, e.g. "post-linkedin" → npm run task -- post-linkedin --text=... */
  name: string;
  /** One line: what this task does (shown in --list). */
  summary: string;
  /** true = needs a Playwright browser page; false = pure CLI/API. */
  needsBrowser: boolean;
  params: TaskParam[];
  run: (args: Record<string, string>, page: Page | null) => Promise<unknown>;
}

function requireArg(args: Record<string, string>, key: string): string {
  const v = args[key];
  if (v === undefined || v === "") throw new Error(`Missing parameter --${key}`);
  return v;
}

/**
 * Add your own tasks here. Each task needs a handler file in tasks/.
 * See tasks/example-task.ts for a minimal template.
 */
export const tasks: TaskDef[] = [
  // Example browser task, replace with your own
  // {
  //   name: "post-linkedin",
  //   summary: "Post text (+ optional image) to LinkedIn.",
  //   needsBrowser: true,
  //   params: [
  //     { name: "text", required: true, description: "Post text" },
  //     { name: "imageUrl", required: false, description: "Image URL" },
  //   ],
  //   run: (args, page) => linkedinPost(page!, { text: requireArg(args, "text"), imageUrl: args.imageUrl }),
  // },

  // Example CLI task, replace with your own
  // {
  //   name: "set-env",
  //   summary: "Set an environment variable on your hosting provider.",
  //   needsBrowser: false,
  //   params: [
  //     { name: "key", required: true, description: "Variable name" },
  //     { name: "value", required: true, description: "Variable value" },
  //   ],
  //   run: (args) => setEnvVar({ key: requireArg(args, "key"), value: requireArg(args, "value") }),
  // },
];

export function findTask(name: string): TaskDef | undefined {
  return tasks.find(t => t.name === name.toLowerCase());
}
