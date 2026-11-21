import { test } from "node:test";
import assert from "node:assert/strict";

import plugin, {
  automationChatJobId,
  jobsDeliveringToChat,
  mergeRuns,
} from "../automation-chat/dist/control-ui/automation-chat.js";

test("automation chat: the owner job of an automation chat, nothing for other chats", () => {
  assert.equal(automationChatJobId("agent:ops:cron:job-1"), "job-1");
  assert.equal(automationChatJobId("agent:ops:cron:job-1:run:abc"), "job-1");
  assert.equal(automationChatJobId("agent:ops:main"), null);
});

test("automation chat: jobs that deliver into the chat, owner first", () => {
  const jobs = [
    { id: "watch", name: "b watcher", sessionTarget: "current", sessionKey: "Agent:Ops:Cron:Owner" },
    { id: "other", name: "a other", sessionTarget: "isolated" },
    { id: "follow", name: "a follow-up", sessionTarget: "session:agent:ops:cron:owner" },
    { id: "owner", name: "z owner", sessionTarget: "isolated" },
  ];
  assert.deepEqual(jobsDeliveringToChat("agent:ops:cron:owner", jobs).map((job) => job.id), ["owner", "follow", "watch"]);
});

test("automation chat: runs of several jobs, newest first", () => {
  const merged = mergeRuns([[{ jobId: "a", ts: 10 }, { jobId: "a", ts: 30 }], [{ jobId: "b", runAtMs: 20 }]]);
  assert.deepEqual(merged.map((entry) => entry.jobId), ["a", "b", "a"]);
});

test("automation chat: adds nothing on a build without the run viewer for plugins", () => {
  const registered = [];
  plugin.activate({ locale: "en", components: {}, ui: { registerAction: (a) => registered.push(a), registerPanel: (p) => registered.push(p) } });
  assert.equal(registered.length, 0);
});

test("automation chat: Run now in automation chats for admins; the Runs panel only in automation chats", () => {
  const actions = new Map();
  const panels = new Map();
  const requests = [];
  const host = {
    locale: "en",
    connection: { connected: true, canRead: true, canAdmin: true },
    components: { mountCronRun: () => ({ dispose() {} }) },
    sessions: { selectedKey: "agent:main:main" },
    subscribe: () => () => {},
    onEvent: () => () => {},
    request: async (method) => {
      requests.push(method);
      return method === "cron.list"
        ? { jobs: [
          { id: "owner", name: "Owner", state: { lastRunStatus: "error" } },
          { id: "watch", name: "Watch", sessionTarget: "session:agent:ops:main", state: {} },
          { id: "hb", name: "heartbeat-ops", sessionTarget: "session:agent:ops:quiet", payload: { skipIfScratchEmpty: true }, state: {} },
        ], hasMore: false }
        : {};
    },
    ui: {
      invalidate: () => {},
      openPanel: () => {},
      registerAction: (action) => actions.set(action.id, action),
      registerPanel: (panel) => panels.set(panel.id, panel),
    },
  };
  plugin.activate(host);
  const run = actions.get("run-now");
  assert.equal(run.placement, "header");
  assert.equal(run.resolve({ sessionKey: "agent:main:main" }).hidden, true);
  // The jobs are read once, then the button names the owner's state.
  assert.equal(run.resolve({ sessionKey: "agent:ops:cron:owner" }).hidden, true);
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.deepEqual(run.resolve({ sessionKey: "agent:ops:cron:owner" }), { label: "Run again" });
    const panel = panels.get("runs");
    assert.equal(panel.icon, "calendarClock");
    assert.equal(panel.available({ sessionKey: "agent:ops:cron:owner" }), true);
    // An ordinary chat that a job set up from it delivers into gets Runs and Run now; other chats do not.
    assert.equal(panel.available({ sessionKey: "agent:ops:main" }), true);
    assert.deepEqual(run.resolve({ sessionKey: "agent:ops:main" }), { label: "Run now" });
    assert.equal(panel.available({ sessionKey: "agent:ops:other" }), false);
    // A heartbeat waking a chat is not its automation: no Runs, no Run now.
    assert.equal(panel.available({ sessionKey: "agent:ops:quiet" }), false);
    assert.equal(run.resolve({ sessionKey: "agent:ops:quiet" }).hidden, true);
    assert.equal(run.resolve({ sessionKey: "agent:ops:other" }).hidden, true);
    host.connection.canAdmin = false;
    assert.equal(run.resolve({ sessionKey: "agent:ops:cron:owner" }).hidden, true);
  });
});
