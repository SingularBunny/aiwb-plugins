// Shared by server.mjs and sync.mjs: settings from the environment, `openclaw` calls, prompt files.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskError, makeAllow, managedJobs, promptFile } from "./core.mjs";

export function config(env = process.env) {
  const tasksDir = env.WORKBENCH_TASKS_DIR || path.join(os.homedir(), ".openclaw", "workbench", "scheduled");
  return {
    opts: {
      allow: makeAllow(env.WORKBENCH_TASKS_ALLOW),
      tz: env.WORKBENCH_TASKS_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      agent: env.WORKBENCH_TASKS_AGENT || "main",
    },
    bin: env.OPENCLAW_BIN || "openclaw",
    promptPath: (id) => path.join(tasksDir, id, "SKILL.md"),
  };
}

/** `openclaw <argv>` with JSON output; an OpenClaw failure becomes a TaskError with its reason. */
export function openclaw(bin, argv) {
  // This Node's directory goes first in PATH: the OpenClaw installer's private Node has no `node`
  // in PATH for the `openclaw` shebang (same exit code 127 as with npm).
  const PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "");
  const r = spawnSync(bin, argv, { encoding: "utf8", stdio: "pipe", timeout: 60000, env: { ...process.env, PATH } });
  if (r.error?.code === "ENOENT") {
    throw new TaskError(`${bin} not found in PATH; add ~/.openclaw/bin: export PATH="$HOME/.openclaw/bin:$PATH" (or set OPENCLAW_BIN)`);
  }
  const out = r.stdout || "";
  const start = out.search(/^[{[]/m);
  let data = null;
  if (start >= 0) { try { data = JSON.parse(out.slice(start)); } catch { /* reported below */ } }
  if (r.status !== 0 || !data || data.ok === false) {
    const msg = data?.error?.message || (r.stderr || "").split("\n").filter((l) => l && !/deprecat/i.test(l)).at(-1)
      || (r.error ? String(r.error.message) : `exit code ${r.status}`);
    throw new TaskError(`openclaw ${argv.slice(0, 2).join(" ")}: ${msg}`);
  }
  return data;
}

export const listManaged = (bin, allow) => managedJobs(openclaw(bin, ["automations", "list", "--all", "--json"]), allow);

export function savePrompt(file, taskId, description, prompt) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, promptFile(taskId, description, prompt));
}
