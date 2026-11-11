#!/usr/bin/env node
// Starter scheduled tasks from the profile → `openclaw automations`. Requires
// a running Gateway. Creates missing tasks, leaves existing ones alone (core.mjs, syncPlan).
//
//   node mcp/scheduled-tasks/sync.mjs --profile <dir> [--dry-run]
//
// In the profile: export const TASKS = { allow: ["report-*"], tz: "Europe/Istanbul", agent?: "main",
//   jobs: [{ taskId, prompt: "tasks/<id>.md", cronExpression | fireAt, enabled? }] }.
// The prompt file is like ~/Claude/Scheduled/<id>/SKILL.md: a header with description, then the text.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { config, listManaged, openclaw, savePrompt } from "./cli.mjs";
import { TaskError, makeAllow, syncPlan } from "./core.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const profileRoot = opt("--profile") || process.env.WORKBENCH_PROFILE;
if (!profileRoot) { console.error("--profile <dir> or WORKBENCH_PROFILE is required"); process.exit(1); }
const file = path.join(path.resolve(profileRoot), "profile.mjs");
if (!existsSync(file)) { console.error(`Profile not found: ${file}`); process.exit(1); }
const { TASKS } = await import(pathToFileURL(file).href);
if (!TASKS?.jobs?.length) { console.log("The profile has no scheduled tasks."); process.exit(0); }

/** Header `---\nname: …\ndescription: …\n---` and the prompt text. */
function readPrompt(rel) {
  const text = readFileSync(path.join(path.resolve(profileRoot), rel), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const description = m?.[1].match(/^description:\s*(.*)$/m)?.[1].trim() || "";
  return { description, prompt: (m ? m[2] : text).trim() };
}

const base = config({ ...process.env, WORKBENCH_TASKS_ALLOW: TASKS.allow.join(","),
  WORKBENCH_TASKS_TZ: TASKS.tz, ...(TASKS.agent ? { WORKBENCH_TASKS_AGENT: TASKS.agent } : {}) });
const opts = { ...base.opts, allow: makeAllow(TASKS.allow.join(",")) };
const tasks = TASKS.jobs.map((j) => ({ ...j, ...readPrompt(j.prompt) }));

let failed = 0;
try {
  const plan = syncPlan(tasks, listManaged(base.bin, opts.allow), opts);
  for (const p of plan) {
    if (p.action === "exists") { console.log(`  task ${p.taskId.padEnd(24)} exists, leaving as is`); continue; }
    const when = p.task.cronExpression ? `cron ${p.task.cronExpression} (${opts.tz})` : `one-time ${p.task.fireAt}`;
    const state = p.task.enabled === false ? "disabled" : "enabled";
    if (args.includes("--dry-run")) { console.log(`  task ${p.taskId.padEnd(24)} would create ${state}: ${when}`); continue; }
    try {
      openclaw(base.bin, p.argv);
      savePrompt(base.promptPath(p.taskId), p.taskId, p.task.description, p.task.prompt);
      console.log(`  task ${p.taskId.padEnd(24)} created ${state}: ${when}`);
    } catch (e) { failed++; console.log(`✗ task ${p.taskId}: ${e.message}`); }
  }
} catch (e) {
  console.error(e instanceof TaskError ? `✗ ${e.message}` : e);
  process.exit(1);
}
process.exit(failed ? 1 : 0);
