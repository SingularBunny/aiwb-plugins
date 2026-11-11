import assert from "node:assert/strict";
import test from "node:test";

import { KEY_PREFIX, TaskError, createArgs, makeAllow, managedJobs, toTask, updateArgs } from "../core.mjs";

const allow = makeAllow("report-*, digest-weekly");
const opts = { allow, tz: "Europe/Istanbul", agent: "main" };
const job = (name, extra = {}) => ({ id: `id-${name}`, name, declarationKey: KEY_PREFIX + name, enabled: false,
  schedule: { kind: "cron", expr: "0 7 * * 1-5", tz: "Europe/Istanbul" }, state: {}, ...extra });
const val = (argv, flag) => argv[argv.indexOf(flag) + 1];

test("allowlist: pattern and exact name; empty allows nothing", () => {
  assert.ok(allow("report-morning")); assert.ok(allow("digest-weekly"));
  assert.equal(allow("digest-daily"), false);
  assert.equal(allow("report-morning;rm"), false);        // * matches id characters only
  assert.equal(makeAllow("")("report-morning"), false);
});

test("OpenClaw system and foreign jobs are hidden from the shim", () => {
  const jobs = [job("report-morning"),
    { ...job("report-day"), declarationKey: undefined },               // not created by the shim
    { ...job("heartbeat-main"), declarationKey: "heartbeat:main" },  // system job
    job("other-report")];                                        // not allowlisted
  assert.deepEqual(managedJobs({ jobs, hasMore: false }, allow).map((j) => j.name), ["report-morning"]);
});

test("incomplete list is an error, not a decision on a truncated one", () => {
  assert.throws(() => managedJobs({ jobs: [], hasMore: true }, allow), /incomplete/);
});

test("create: cron in the profile time zone, agent run only, no outbound delivery", () => {
  const argv = createArgs({ taskId: "report-morning", prompt: "p", description: "d", cronExpression: "0 7 * * 1-5" }, opts);
  assert.equal(val(argv, "--declaration-key"), KEY_PREFIX + "report-morning");
  assert.equal(val(argv, "--tz"), "Europe/Istanbul");
  assert.equal(val(argv, "--message"), "p");
  assert.ok(argv.includes("--no-deliver"));
  assert.ok(!argv.some((a) => a.startsWith("--command") || a === "--script"));
});

test("create: fireAt with offset goes out as UTC; without offset is rejected", () => {
  const argv = createArgs({ taskId: "report-handoff", prompt: "p", fireAt: "2026-08-09T17:30:00+03:00" }, opts);
  assert.equal(val(argv, "--at"), "2026-08-09T14:30:00.000Z");
  assert.ok(argv.includes("--keep-after-run"));
  assert.throws(() => createArgs({ taskId: "report-x", prompt: "p", fireAt: "2026-08-09T17:30:00" }, opts), TaskError);
});

test("create: not allowlisted, bad id, both schedules or neither are rejected", () => {
  assert.throws(() => createArgs({ taskId: "digest-daily", prompt: "p", cronExpression: "0 10 * * 1-5" }, opts), /not in the shim allowlist/);
  assert.throws(() => createArgs({ taskId: "Morning Check", prompt: "p", cronExpression: "0 7 * * *" }, opts), /kebab-case/);
  assert.throws(() => createArgs({ taskId: "report-x", prompt: "p" }, opts), /exactly one/);
  assert.throws(() => createArgs({ taskId: "report-x", prompt: "p", cronExpression: "0 7 * *", fireAt: null }, opts), /five fields/);
});

test("update: a new fireAt re-arms a one-time task, as in Claude Desktop", () => {
  const j = job("report-handoff", { schedule: { kind: "at", at: "2026-10-18T14:30:00.000Z" } });
  const { argv } = updateArgs(j, { taskId: j.name, fireAt: "2026-10-25T17:30:00+03:00" }, opts);
  assert.ok(argv.includes("--enable"));
  const off = updateArgs(j, { taskId: j.name, fireAt: "2026-10-25T17:30:00+03:00", enabled: false }, opts).argv;
  assert.ok(off.includes("--disable") && !off.includes("--enable"));  // explicit enabled wins
});

test("update: enables by OpenClaw job id; empty change is rejected", () => {
  const { argv, changed } = updateArgs(job("report-day"), { taskId: "report-day", enabled: true }, opts);
  assert.deepEqual(argv.slice(0, 3), ["automations", "edit", "id-report-day"]);
  assert.deepEqual(changed, ["enabled"]);
  assert.throws(() => updateArgs(job("report-day"), { taskId: "report-day" }, opts), /nothing to change/);
});

test("toTask: Claude Desktop shape with taskId, enabled, cronExpression or fireAt, lastRunAt", () => {
  const t = toTask(job("report-morning", { enabled: true, state: { lastRunAtMs: Date.parse("2026-10-30T04:00:00Z"), nextRunAtMs: 1 } }), (id) => `/s/${id}/SKILL.md`);
  assert.equal(t.taskId, "report-morning"); assert.equal(t.enabled, true);
  assert.equal(t.cronExpression, "0 7 * * 1-5"); assert.equal(t.lastRunAt, "2026-10-30T04:00:00.000Z");
  assert.equal(t.path, "/s/report-morning/SKILL.md");
  const once = toTask(job("report-handoff", { schedule: { kind: "at", at: "2026-11-08T14:30:00.000Z" } }), () => "");
  assert.equal(once.fireAt, "2026-11-08T14:30:00.000Z"); assert.equal(once.cronExpression, undefined);
});

test("sync: creates only missing tasks, leaves existing ones; enabled: false creates it disabled", async () => {
  const { syncPlan } = await import("../core.mjs");
  const tasks = [
    { taskId: "report-planner", prompt: "p", cronExpression: "30 6 * * 1-5" },
    { taskId: "digest-weekly", prompt: "p", cronExpression: "0 8 * * 1-5", enabled: false },
  ];
  const plan = syncPlan(tasks, [job("report-planner", { enabled: false })], opts);
  assert.deepEqual(plan.map((p) => p.action), ["exists", "create"]);
  assert.equal(plan[0].argv, undefined);                 // a task the user disabled is not re-enabled
  assert.ok(plan[1].argv.includes("--disabled"));
  assert.throws(() => syncPlan([{ taskId: "other-x", prompt: "p", cronExpression: "0 9 * * *" }], [], opts), /not in the shim allowlist/);
});
