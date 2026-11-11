#!/usr/bin/env node
// `scheduled-tasks` MCP server: the same tools as Claude Desktop, on top of
// `openclaw automations`. Skills written for Claude Desktop (list → update/create)
// work unchanged. Transport: stdio, line-delimited JSON-RPC
// (MCP spec, "stdio"); no SDK and no dependencies.
//
// Environment (written by the installer from the profile):
//   WORKBENCH_TASKS_ALLOW  task names that may be managed: "report-*,digest-weekly"; empty means none
//   WORKBENCH_TASKS_TZ     cron time zone ("local time" in Claude Desktop); defaults to the system zone
//   WORKBENCH_TASKS_AGENT  OpenClaw agent for runs; defaults to main
//   WORKBENCH_TASKS_DIR    where <id>/SKILL.md prompt files live; defaults to ~/.openclaw/workbench/scheduled
//   OPENCLAW_BIN           path to openclaw; defaults to PATH lookup
import readline from "node:readline";

import { config, listManaged, openclaw as run, savePrompt as save } from "./cli.mjs";
import { TaskError, checkId, createArgs, toTask, updateArgs } from "./core.mjs";

const { opts, bin, promptPath } = config();
const openclaw = (argv) => run(bin, argv);
const list = () => listManaged(bin, opts.allow);
const find = (taskId) => list().find((j) => j.name === taskId);
const savePrompt = (taskId, description, prompt) => save(promptPath(taskId), taskId, description, prompt);

const TOOLS = {
  list_scheduled_tasks: {
    description: "List scheduled tasks managed by this workbench: taskId, description, schedule, enabled, lastRunAt.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List scheduled tasks", readOnlyHint: true, openWorldHint: false },
    run: () => JSON.stringify(list().map((j) => toTask(j, promptPath)), null, 2),
  },
  create_scheduled_task: {
    description: "Create a scheduled task: a recurring cronExpression (local time zone) or a one-time fireAt (ISO 8601). The prompt runs as an isolated agent turn.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "kebab-case id" },
        description: { type: "string" },
        prompt: { type: "string" },
        cronExpression: { type: "string", description: "5-field cron in local time, e.g. '0 7 * * 1-5'" },
        fireAt: { type: "string", description: "ISO 8601 with offset, e.g. 2026-08-09T17:30:00+03:00" },
      },
      required: ["taskId", "prompt"],
    },
    annotations: { title: "Create scheduled task", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (a) => {
      const argv = createArgs(a, opts);
      if (find(a.taskId)) throw new TaskError(`Scheduled task "${a.taskId}" already exists — use update_scheduled_task`);
      openclaw(argv);
      savePrompt(a.taskId, a.description, a.prompt);
      return `Scheduled task "${a.taskId}" created.\n\n**Task file:** ${promptPath(a.taskId)}\n**Schedule:** ${a.cronExpression ? `cron ${a.cronExpression} (${opts.tz})` : `one-time ${a.fireAt}`}`;
    },
  },
  update_scheduled_task: {
    description: "Update a scheduled task: enabled, prompt, description, cronExpression or fireAt. A new fireAt re-arms a one-time task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" }, enabled: { type: "boolean" }, prompt: { type: "string" },
        description: { type: "string" }, cronExpression: { type: "string" }, fireAt: { type: "string" },
      },
      required: ["taskId"],
    },
    annotations: { title: "Update scheduled task", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (a) => {
      const job = find(a.taskId);
      if (!job) throw new TaskError(`Scheduled task "${a.taskId}" not found — create it with create_scheduled_task`);
      const { argv, changed } = updateArgs(job, a, opts);
      openclaw(argv);
      if (a.prompt != null || a.description != null) savePrompt(a.taskId, a.description ?? job.description, a.prompt ?? job.payload?.message ?? "");
      return `Scheduled task "${a.taskId}" updated: ${changed.join(", ")}.`;
    },
  },
  delete_scheduled_task: {
    description: "Delete a scheduled task. Its prompt file is left in place.",
    inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    annotations: { title: "Delete scheduled task", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (a) => {
      checkId(a.taskId, opts.allow);
      const job = find(a.taskId);
      if (!job) throw new TaskError(`Scheduled task "${a.taskId}" not found`);
      openclaw(["automations", "rm", job.id, "--json"]);
      return `Scheduled task "${a.taskId}" deleted. Its SKILL.md file was left in place at ${promptPath(a.taskId)}.`;
    },
  },
};

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "scheduled-tasks", version: "0.1.0" } });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) });
  }
  if (method === "tools/call") {
    const tool = TOOLS[params?.name];
    if (!tool) return error(id, -32602, `unknown tool: ${params?.name}`);
    try {
      return reply(id, { content: [{ type: "text", text: tool.run(params.arguments || {}) }] });
    } catch (e) {
      // A tool error is a reply to the model (isError), not a protocol failure: the model sees the reason.
      return reply(id, { content: [{ type: "text", text: e instanceof TaskError ? e.message : `internal error: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) return error(id, -32601, `method not found: ${method}`);
  // Notifications (notifications/initialized etc.) need no reply.
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return error(null, -32700, "parse error"); }
  handle(msg);
});
