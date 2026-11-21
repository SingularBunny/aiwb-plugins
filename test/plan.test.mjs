import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EDIT_REFUSAL, EXIT_TOOL, METHODS, PlanSessions, planCommand, planSessionKey, planToolDecision, registerPlanMethods,
} from "../plan/plan-mode.js";

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

test("plan: the Control UI toggle reads and flips the same state as /plan, under either key form", async () => {
  const sessions = new PlanSessions(fresh());
  const methods = new Map();
  registerPlanMethods({ registerGatewayMethod: (name, handler, opts) => methods.set(name, { handler, opts }) }, sessions);
  assert.equal(methods.get(METHODS.status).opts.scope, "operator.read");
  assert.equal(methods.get(METHODS.set).opts.scope, "operator.write");
  const call = async (name, params) => {
    let answer;
    await methods.get(name).handler({ params, respond: (...args) => { answer = args; } });
    return answer;
  };
  assert.deepEqual((await call(METHODS.status, { sessionKey: "agent:main:chat" }))[1], { on: false, since: null });
  const set = await call(METHODS.set, { sessionKey: "agent:main:chat", on: true });
  assert.equal(set[0], true);
  assert.equal(set[1].on, true);
  assert.ok(sessions.has("agent:main:chat"));
  assert.equal(planCommand(sessions, "agent:main:chat", "status"), "Plan mode is on.");
  assert.equal((await call(METHODS.status, { sessionKey: "chat", agentId: "main" }))[1].on, true);
  planCommand(sessions, "agent:main:chat", "off");
  assert.equal((await call(METHODS.status, { sessionKey: "agent:main:chat" }))[1].on, false);
  assert.equal((await call(METHODS.set, { sessionKey: "agent:main:chat" }))[0], false);
  assert.equal((await call(METHODS.set, { sessionKey: "agent:main:chat", on: "yes" }))[0], false);
  assert.equal((await call(METHODS.status, {}))[0], false);
  assert.equal((await call(METHODS.status, { sessionKey: "agent:main:chat", extra: 1 }))[0], false);
});

test("plan: the short key forms name the chat the command sees", () => {
  assert.equal(planSessionKey("main"), "agent:main:main");
  assert.equal(planSessionKey("main", "Work"), "agent:work:main");
  assert.equal(planSessionKey("dashboard:abc", "main"), "agent:main:dashboard:abc");
  assert.equal(planSessionKey("agent:Main:dashboard:abc"), "agent:main:dashboard:abc");
  assert.equal(planSessionKey("  "), undefined);
});

test("plan: the composer button reads the chat's plan mode, flips it and reads again after a finished turn", async () => {
  const { default: ui } = await import("../plan/dist/control-ui/plan.js");
  const calls = [];
  let on = false;
  let invalidations = 0;
  const actions = new Map();
  const listeners = new Map();
  const host = {
    locale: "en",
    connection: { connected: true, canWrite: true },
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "aiwb-plan.set") on = params.on;
      return { on };
    },
    onEvent: (event, listener) => listeners.set(event, listener),
    ui: { placements: ["composer-controls"], registerAction: (action) => actions.set(action.id, action), invalidate: () => { invalidations += 1; } },
  };
  ui.activate(host);
  const button = actions.get("plan-mode");
  assert.equal(button.placement, "composer-controls");
  const chat = { sessionKey: "agent:main:chat", agentId: "main" };
  assert.equal(button.resolve(chat).disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(button.resolve(chat), { label: "Plan: off", disabled: false });
  await button.run(chat);
  assert.deepEqual(calls.at(-1), ["aiwb-plan.set", { sessionKey: "agent:main:chat", agentId: "main", on: true }]);
  assert.equal(button.resolve(chat).label, "Plan: on");
  on = false;
  listeners.get("chat")({ sessionKey: "agent:main:chat", state: "final" });
  button.resolve(chat);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button.resolve(chat).label, "Plan: off");
  assert.ok(invalidations > 0);
  assert.equal(button.resolve({}).hidden, true);
});

test("plan: no button where the host has no composer-controls placement", async () => {
  const { default: ui } = await import("../plan/dist/control-ui/plan.js");
  const actions = [];
  ui.activate({ locale: "en", request: async () => ({}), onEvent: () => {}, ui: { registerAction: (a) => actions.push(a), invalidate: () => {} } });
  assert.equal(actions.length, 0);
});

test("plan mode: a long plan and a long command fit the Gateway's approval limits", () => {
  const sessions = new PlanSessions(fresh());
  sessions.set("agent:main:chat", true);
  const decide = (toolName, params) => planToolDecision(sessions, { toolName, params, sessionKey: "agent:main:chat" });
  const plan = decide(EXIT_TOOL, { plan: "1. Step\n".repeat(200) }).requireApproval;
  assert.ok(plan.description.length <= 512);
  assert.ok(plan.description.startsWith("1. Step"));
  const exec = decide("exec", { command: "echo ".repeat(300) }).requireApproval;
  assert.ok(exec.description.length <= 512);
});
