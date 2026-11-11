// Core of the `scheduled-tasks` shim: the Claude Desktop task MCP server contract on top of
// `openclaw automations`. Pure functions, no network and no CLI:
// input validation, command arguments, mapping an OpenClaw job to the Claude Desktop shape.
//
// The contract is taken from real calls in a Claude Desktop export: list (86), update (59:
// taskId, enabled, fireAt, prompt, description, cronExpression), create (19), delete (8).
//
// Two safeguards: the shim sees and changes only jobs
// (1) whose name matches the profile allowlist and (2) that carry its declarationKey.
// OpenClaw system jobs (memory-core, heartbeat) and foreign jobs are out of its reach. It
// creates only agent runs (`--message`), never command jobs (`--command`).

export const KEY_PREFIX = "workbench-tasks:";

const TASK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class TaskError extends Error {}

/** Allowlist: "report-*,digest-weekly" → name predicate. Empty allows nothing. */
export function makeAllow(spec) {
  const pats = String(spec || "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]*") + "$"));
  return (name) => pats.some((re) => re.test(name));
}

/** OpenClaw job managed by the shim: its key and an allowlisted name. */
export function isManaged(job, allow) {
  return job.declarationKey === KEY_PREFIX + job.name && allow(job.name);
}

export function checkId(taskId, allow) {
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) {
    throw new TaskError(`taskId must be kebab-case (a-z, 0-9, -), got: ${JSON.stringify(taskId)}`);
  }
  if (!allow(taskId)) {
    throw new TaskError(`Task "${taskId}" is not in the shim allowlist (WORKBENCH_TASKS_ALLOW in the profile)`);
  }
}

function checkCron(expr) {
  if (typeof expr !== "string" || expr.trim().split(/\s+/).length !== 5) {
    throw new TaskError(`cronExpression must have five fields (min hour day month weekday), got: ${JSON.stringify(expr)}`);
  }
  return expr.trim();
}

/** fireAt is an ISO time with an offset or Z; OpenClaw gets UTC so the offset is not applied twice. */
function checkFireAt(value) {
  const ms = typeof value === "string" && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && /(Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw new TaskError(`fireAt must be an ISO time with an offset, e.g. 2026-08-09T17:30:00+03:00; got: ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}

/** Task file text, like ~/Claude/Scheduled/<id>/SKILL.md in Claude Desktop. */
export function promptFile(taskId, description, prompt) {
  const desc = String(description || "").replace(/\s*\n\s*/g, " ");
  return `---\nname: ${taskId}\ndescription: ${desc}\n---\n\n${prompt}\n`;
}

/** `openclaw automations add` arguments for create_scheduled_task. */
export function createArgs(input, { allow, tz, agent }) {
  const { taskId, prompt, description, cronExpression, fireAt } = input || {};
  checkId(taskId, allow);
  if (typeof prompt !== "string" || !prompt.trim()) throw new TaskError("prompt is required");
  if ((cronExpression == null) === (fireAt == null)) throw new TaskError("exactly one of cronExpression or fireAt is required");
  const argv = ["automations", "add", "--name", taskId, "--declaration-key", KEY_PREFIX + taskId,
    "--description", String(description || ""), "--session", "isolated", "--agent", agent,
    "--message", prompt, "--no-deliver", "--json"];
  if (cronExpression != null) argv.push("--cron", checkCron(cronExpression), "--tz", tz, "--exact");
  else argv.push("--at", checkFireAt(fireAt), "--keep-after-run");
  return argv;
}

/**
 * `openclaw automations edit` arguments for update_scheduled_task.
 * A new fireAt re-arms a one-time task even without enabled, matching Claude Desktop:
 * a task that moved another one-time task with just fireAt re-armed it, and it fired.
 * An explicit enabled: false wins.
 */
export function updateArgs(job, input, { allow, tz }) {
  const { taskId, prompt, description, cronExpression, fireAt, enabled } = input || {};
  checkId(taskId, allow);
  const argv = ["automations", "edit", job.id];
  const changed = [];
  if (description != null) { argv.push("--description", String(description)); changed.push("description"); }
  if (prompt != null) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new TaskError("prompt must not be empty");
    argv.push("--message", prompt); changed.push("prompt");
  }
  if (cronExpression != null && fireAt != null) throw new TaskError("cronExpression and fireAt cannot be set together");
  if (cronExpression != null) { argv.push("--cron", checkCron(cronExpression), "--tz", tz, "--exact"); changed.push("schedule"); }
  if (fireAt != null) { argv.push("--at", checkFireAt(fireAt), "--keep-after-run"); changed.push("schedule"); }
  const enable = enabled != null ? enabled : fireAt != null ? true : null;
  if (enable != null) {
    if (typeof enable !== "boolean") throw new TaskError("enabled must be true or false");
    argv.push(enable ? "--enable" : "--disable"); changed.push("enabled");
  }
  if (!changed.length) throw new TaskError("nothing to change: pass enabled, prompt, description, cronExpression or fireAt");
  argv.push("--json");
  return { argv, changed };
}

/** OpenClaw job → list_scheduled_tasks entry in the Claude Desktop shape. */
export function toTask(job, promptPath) {
  const s = job.schedule || {};
  const t = { taskId: job.name, description: job.description || "", path: promptPath(job.name) };
  if (s.kind === "cron") {
    t.schedule = `Cron: ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
    t.cronExpression = s.expr;
  } else if (s.kind === "at") {
    t.schedule = `One-time: ${s.at}`;
    t.fireAt = new Date(Date.parse(s.at)).toISOString();
  } else t.schedule = s.kind || "unknown";
  t.enabled = Boolean(job.enabled);
  const last = job.state?.lastRunAtMs;
  if (last) t.lastRunAt = new Date(last).toISOString();
  const next = job.state?.nextRunAtMs ?? job.nextRunAtMs;
  if (job.enabled && next) t.nextRunAt = new Date(next).toISOString();
  return t;
}

/** `automations list --all --json` result → managed jobs; an incomplete list is an error, not a truncation. */
export function managedJobs(listResult, allow) {
  if (!listResult || !Array.isArray(listResult.jobs)) throw new TaskError("OpenClaw returned the job list in an unexpected shape");
  if (listResult.hasMore) throw new TaskError("OpenClaw returned an incomplete job list (hasMore); the shim does not act on a truncated list");
  return listResult.jobs.filter((j) => isManaged(j, allow));
}

/**
 * Profile starter tasks → what to do. Existing ones are left alone: enabling and rescheduling
 * belong to the tasks themselves (one task may enable others) and the user; reinstalling does not
 * overwrite their decisions. Missing ones are created with enabled from the profile.
 * tasks: [{ taskId, description, prompt, cronExpression | fireAt, enabled }]
 */
export function syncPlan(tasks, managed, opts) {
  const have = new Set(managed.map((j) => j.name));
  return tasks.map((t) => {
    if (have.has(t.taskId)) return { taskId: t.taskId, action: "exists" };
    const argv = createArgs(t, opts);
    if (t.enabled === false) argv.splice(argv.indexOf("--json"), 0, "--disabled");
    return { taskId: t.taskId, action: "create", argv, task: t };
  });
}
