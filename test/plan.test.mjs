import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EDIT_REFUSAL, EXIT_TOOL, PlanSessions, planCommand, planToolDecision } from "../plan/plan-mode.js";

const fresh = () => path.join(mkdtempSync(path.join(os.tmpdir(), "plan-")), "workbench", "plan-mode.json");

test("plan: /plan turns plan mode on, off and reports it; a restart keeps it", () => {
  const file = fresh();
  const sessions = new PlanSessions(file);
  assert.match(planCommand(sessions, "agent:main:chat", ""), /Plan mode is on/);
  assert.equal(planCommand(sessions, "agent:main:chat", "status"), "Plan mode is on.");
  assert.ok(new PlanSessions(file).has("agent:main:chat"));
  assert.match(planCommand(sessions, "agent:main:chat", "off"), /Plan mode is off/);
  assert.ok(!new PlanSessions(file).has("agent:main:chat"));
  assert.equal(planCommand(sessions, "agent:main:chat", "maybe"), "Usage: /plan [on|off|status]");
  assert.match(planCommand(sessions, undefined, "on"), /chat session only/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
});

test("plan: while planning, edits are refused and commands and subagents ask; other chats are untouched", () => {
  const sessions = new PlanSessions(fresh());
  sessions.set("agent:main:chat", true);
  const decide = (toolName, params = {}, sessionKey = "agent:main:chat") => planToolDecision(sessions, { toolName, params, sessionKey });
  for (const tool of ["write", "edit", "apply_patch"]) assert.deepEqual(decide(tool), { block: true, blockReason: EDIT_REFUSAL });
  const exec = decide("exec", { command: "ls -la" }).requireApproval;
  assert.equal(exec.description, "ls -la");
  assert.deepEqual(exec.allowedDecisions, ["allow-once", "deny"]);
  assert.match(decide("sessions_spawn", { task: "Survey the tests" }).requireApproval.title, /subagent/);
  for (const tool of ["process", "browser", "message", "cron", "sessions_send"]) assert.ok(decide(tool, { action: "x" }).requireApproval, tool);
  assert.equal(decide("message", { action: "send", to: "a" }).requireApproval.description, '{"action":"send","to":"a"}');
  assert.equal(decide("read"), undefined);
  assert.equal(decide("write", {}, "agent:main:other"), undefined);
});

test("plan: approving the plan ends plan mode; declining keeps it; an empty plan is refused", async () => {
  const sessions = new PlanSessions(fresh());
  sessions.set("agent:main:chat", true);
  const decide = (params) => planToolDecision(sessions, { toolName: "exit_plan_mode", params, sessionKey: "agent:main:chat" });
  assert.equal(decide({ plan: "  " }).block, true);
  const approval = decide({ plan: "1. Read\n2. Change" }).requireApproval;
  assert.equal(approval.description, "1. Read\n2. Change");
  await approval.onResolution("deny");
  assert.ok(sessions.has("agent:main:chat"));
  await approval.onResolution("allow-once");
  assert.ok(!sessions.has("agent:main:chat"));
  assert.equal(decide({ plan: "again" }), undefined);
});

test("plan: the manifest declares exit_plan_mode, or the Gateway refuses to register it", () => {
  const manifest = JSON.parse(readFileSync(new URL("../plan/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.contracts?.tools, [EXIT_TOOL]);
});
