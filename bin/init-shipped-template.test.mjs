import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { retargetWorkflow } from "./muraqib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = join(here, "..", ".github", "workflows");

// The other tests build their own sample workflows, so none of them would
// notice a change to the files init actually copies. These run the real ones.

test("every shipped workflow that init retargets still matches its retarget strategy", () => {
  const names = ["muraqib-nightly.yml", "muraqib-watchdog.yml", "muraqib-claude-fix.yml", "auto-merge-guard.yml"];
  for (const name of names) {
    const source = readFileSync(join(WORKFLOWS, name), "utf8");
    assert.doesNotThrow(() => retargetWorkflow(source, "tools/muraqib", name), name);
  }
});

test("init --dir writes the shipped nightly into a subdirectory install with the runner still pinned", () => {
  const dir = mkdtempSync(join(tmpdir(), "muraqib-init-"));
  try {
    const result = spawnSync(process.execPath, [join(here, "muraqib.mjs"), "init", "--dir", "tools/muraqib"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const nightly = join(dir, ".github", "workflows", "muraqib-nightly.yml");
    assert.ok(existsSync(nightly), "init did not write the nightly workflow");
    const text = readFileSync(nightly, "utf8");
    assert.match(text, /working-directory: tools\/muraqib/);
    assert.match(text, /^ {4}runs-on: ubuntu-24\.04\r?$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
