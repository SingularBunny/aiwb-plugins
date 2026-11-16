import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { carryOf, configuredAgents, isUntouched, rehomeChat, rehomeOnce, rehomePlan } from "../claude-bridge/rehome.js";
import { moveLabel, rehomeAction } from "../claude-bridge/dist/control-ui/bridge.js";

const T1 = "11111111-0000-4000-8000-000000000001", T2 = "22222222-0000-4000-8000-000000000002";
const mark = (threadId) => ({ "aiwb-claude-bridge": { sourceThreadId: threadId } });
// A session entry as adoption leaves it: import, binding to the source chat, shared; no turn yet.
const adopted = (threadId, cwd, extra = {}) => ({
  sessionId: `sid-${threadId.slice(0, 4)}`, updatedAt: 1, createdAt: 1, displayName: "Pruning", visibility: "shared",
  cliSessionBindings: { "claude-cli": { sessionId: threadId, forceReuse: true, forkNextResume: true } },
  spawnedCwd: cwd, pluginExtensions: mark(threadId), ...extra,
});
const key = (agent, t) => `agent:${agent}:catalog-import:${t.slice(0, 8)}`;

test("rehome: untouched means no turn traces and the binding adoption wrote", () => {
  const e = adopted(T1, "/d/Сад");
  assert.equal(isUntouched(e), true);
  // Rename, pin, read state, archive marks, activity summary: metadata, not turns.
  assert.equal(isUntouched({ ...e, label: "Renamed", pinnedAt: 5, lastReadAt: 6, markedUnreadAt: 7, activitySummary: { text: "x" }, systemSent: false }), true);
  for (const trace of ["lastInteractionAt", "lastActivityAt", "sessionStartedAt", "lastRunId", "previousSessionId"]) {
    assert.equal(isUntouched({ ...e, [trace]: 1 }), false, trace);
  }
  assert.equal(isUntouched({ ...e, systemSent: true }), false);
  // The first Claude CLI turn moves the binding to its fork.
  assert.equal(isUntouched({ ...e, cliSessionBindings: { "claude-cli": { sessionId: "fork-1" } } }), false);
  assert.equal(isUntouched({ ...e, cliSessionBindings: undefined }), false);
  assert.equal(isUntouched({ ...e, pluginExtensions: {} }), false);
  // Sessions adopted under the old plugin name are recognized too.
  assert.equal(isUntouched({ ...e, pluginExtensions: { "aiwb-projects": { sourceThreadId: T1 } } }), true);
});

test("rehome: configured agents from agents.entries, agents.list, or main alone", () => {
  assert.deepEqual([...configuredAgents({ agents: { entries: { main: {}, sad: { cwd: "/x" } } } })], ["main", "sad"]);
  assert.deepEqual([...configuredAgents({ agents: { list: [{ id: "main" }, { id: "Sad" }] } })], ["main", "sad"]);
  assert.deepEqual([...configuredAgents({})], ["main"]);
});

test("rehome plan: default agent's chats of a folder whose agent exists; untouched move, used ones are offered", () => {
  const entries = [
    { agentId: "main", sessionKey: key("main", T1), entry: adopted(T1, "/d/Сад") },
    { agentId: "main", sessionKey: key("main", T2), entry: adopted(T2, "/d/Сад", { lastInteractionAt: 9, cliSessionBindings: { "claude-cli": { sessionId: "fork-2" } } }) },
    // Archived (or deleted: not listed) chats stay as they are.
    { agentId: "main", sessionKey: "agent:main:catalog-import:arch", entry: adopted("33", "/d/Сад", { archivedAt: 5 }) },
    // A folder without a project, a project whose agent is not created yet, a chat of another agent.
    { agentId: "main", sessionKey: "agent:main:catalog-import:plain", entry: adopted("44", "/d/_no_space") },
    { agentId: "main", sessionKey: "agent:main:catalog-import:early", entry: adopted("55", "/d/Огород") },
    { agentId: "sad", sessionKey: "agent:sad:catalog-import:own", entry: adopted("66", "/d/Сад") },
    // Not an adopted chat: the main chat and a new chat of main.
    { agentId: "main", sessionKey: "agent:main:main", entry: { sessionId: "m", spawnedCwd: "/d/Сад" } },
    { agentId: "main", sessionKey: "agent:main:dashboard:x", entry: adopted("77", "/d/Сад") },
  ];
  const plan = rehomePlan({ entries, defaultAgent: "main", projects: { "Сад": "sad", "Огород": "ogorod", _no_space: "main" },
    agentExists: (id) => id === "sad" || id === "main" });
  assert.deepEqual(plan.auto.map((o) => o.sessionKey), [key("main", T1)]);
  assert.deepEqual(plan.offers.map((o) => [o.sessionKey, o.folder, o.targetAgentId, o.untouched]),
    [[key("main", T1), "Сад", "sad", true], [key("main", T2), "Сад", "sad", false]]);
  assert.equal(plan.auto[0].threadId, T1);
  assert.equal(plan.auto[0].cwd, "/d/Сад");
  // A turn in progress: neither moved nor offered now.
  assert.equal(rehomePlan({ entries, projects: { "Сад": "sad" }, running: (k) => k === key("main", T1) }).auto.length, 0);
});

test("rehome: archive the old session, import into the folder agent, bind with title, pin and read state, register", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aiwb-rehome-"));
  try {
    const registryFile = path.join(dir, "workbench", "adopted.json");
    const entry = adopted(T1, "/d/Сад", { label: "My pruning", pinnedAt: 11, lastReadAt: 12 });
    const item = rehomePlan({ entries: [{ agentId: "main", sessionKey: key("main", T1), entry }], projects: { "Сад": "sad" } }).auto[0];
    const calls = [], bound = [], archives = [];
    let failImport = false, current = entry;
    const request = async (method, params) => {
      calls.push([method, params]);
      if (method === "sessions.catalog.import") {
        if (failImport) throw new Error("source gone");
        return { sessionKey: key(params.agentId, params.threadId) };
      }
      return {};
    };
    // The store write: the check runs against the entry as it is now.
    const setArchived = async ({ agentId, sessionKey, archived, expect }) => { expect?.(current); archives.push([agentId, sessionKey, archived]); };
    const bind = async (p) => { bound.push(p); return { sessionId: "new-sid", archived: true }; };
    const base = { item, request, bind, setArchived, registryFile };

    const moved = await rehomeChat({ ...base, related: [T1, "fork-0"] });
    assert.deepEqual(moved, { from: key("main", T1), sessionKey: key("sad", T1), threadId: `s:${key("sad", T1)}` });
    // The old session is archived (it stays restorable), a reused archived import in the target restored.
    assert.deepEqual(archives, [["main", key("main", T1), true], ["sad", key("sad", T1), false]]);
    assert.deepEqual(calls.map(([m]) => m), ["sessions.catalog.import", "session.visibility.set"]);
    assert.deepEqual(calls[0][1], { catalogId: "claude", hostId: "gateway:local", threadId: T1, agentId: "sad", displayName: "Pruning" });
    assert.deepEqual(bound, [{ agentId: "sad", sessionKey: key("sad", T1), threadId: T1, cwd: "/d/Сад",
      carry: { label: "My pruning", pinnedAt: 11, lastReadAt: 12 } }]);
    // Adopting again finds the chat in the registry under the new session: no second copy.
    const reg = JSON.parse(readFileSync(registryFile, "utf8"));
    assert.deepEqual(reg, { [T1]: { agentId: "sad", sessionKey: key("sad", T1) }, "fork-0": { agentId: "sad", sessionKey: key("sad", T1) } });

    // The import fails: the old session is restored and the registry is unchanged.
    calls.length = 0; archives.length = 0; failImport = true;
    writeFileSync(registryFile, "{}");
    await assert.rejects(rehomeChat(base), /source gone/);
    assert.deepEqual(archives, [["main", key("main", T1), true], ["main", key("main", T1), false]]);
    assert.equal(readFileSync(registryFile, "utf8"), "{}");

    // A turn started after the plan: the store write refuses, nothing is imported; the pass reports it.
    calls.length = 0; archives.length = 0; failImport = false;
    current = { ...entry, lastInteractionAt: 99 };
    const result = await rehomeOnce({ plan: { auto: [item] }, ...base, relatedOf: () => [] });
    assert.deepEqual([result.moved.length, result.failed], [0, 1]);
    assert.match(result.errors[0], /Сад · Pruning: the chat was used since the plan/);
    assert.ok(!calls.some(([m]) => m === "sessions.catalog.import"));
    current = { ...entry, archivedAt: 5 };
    await assert.rejects(rehomeChat(base), /gone or archived/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rehome: what a move carries", () => {
  assert.deepEqual(carryOf({ displayName: "x", label: "y", pinnedAt: 1, lastReadAt: 2, markedUnreadAt: null, updatedAt: 3 }),
    { label: "y", pinnedAt: 1, lastReadAt: 2 });
  assert.deepEqual(carryOf(undefined), {});
});

test("rehome menu item: only on offered chats, with the folder; confirmed, it moves the chat and opens it", async () => {
  assert.equal(moveLabel("en-US", "Сад"), "Move to project Сад…");
  assert.equal(moveLabel("ru", "Сад"), "Перенести в проект Сад…");
  assert.equal(moveLabel("ru-RU", "Сад"), "Перенести в проект Сад…");
  const used = key("main", T2);
  const requests = [], opened = [], listeners = {};
  let invalidated = 0;
  const host = {
    locale: "en",
    request: async (method, params) => {
      requests.push([method, params]);
      if (method === "aiwb-claude-bridge.rehome.offers") return { offers: [{ sessionKey: used, folder: "Сад", agentId: "sad", untouched: false }] };
      if (method === "sessions.catalog.move") return { ok: true, threadId: "s:agent:sad:catalog-import:copy", sessionKey: "agent:sad:catalog-import:copy" };
      throw new Error(method);
    },
    onEvent: (event, fn) => { listeners[event] = fn; return () => delete listeners[event]; },
    sessions: { normalizeKey: (k) => k, open: (s) => opened.push(s) },
    ui: { invalidate: () => invalidated++ },
  };
  const answers = [false, true];
  const rehome = rehomeAction(host, { confirm: async () => answers.shift() });
  try {
    assert.deepEqual(rehome.action.resolve({ sessionKey: used }), { hidden: true });   // not fetched yet
    await rehome.refresh();
    assert.ok(invalidated >= 1);
    assert.deepEqual(rehome.action.resolve({ sessionKey: used }), { label: "Move to project Сад…" });
    assert.deepEqual(rehome.action.resolve({ sessionKey: "agent:main:main" }), { hidden: true });
    assert.ok(listeners["sessions.changed"] && listeners["plugin.aiwb-claude-bridge.session-catalog-changed"]);

    // Cancelled: nothing moves.
    await rehome.action.run({ sessionKey: used, session: { displayName: "Watering" } });
    assert.ok(!requests.some(([m]) => m === "sessions.catalog.move"));
    // Confirmed: the drag-and-drop move to the folder, then the moved chat opens; the item goes away.
    await rehome.action.run({ sessionKey: used, session: { displayName: "Watering" } });
    assert.deepEqual(requests.find(([m]) => m === "sessions.catalog.move")[1],
      { catalogId: "projects", hostId: "gateway:local", threadId: `s:${used}`, group: "Сад" });
    assert.deepEqual(opened, [{ sessionKey: "agent:sad:catalog-import:copy", agentId: "sad" }]);
    assert.deepEqual(rehome.action.resolve({ sessionKey: used }), { hidden: true });
    await assert.rejects(rehome.action.run({ sessionKey: used }), /no longer offered/);
  } finally { rehome.dispose(); }
});

test("move button and drag-and-drop: the moved chat keeps the pin and read state of its old session", async () => {
  const { moveChat, claudeProjectDir } = await import("../claude-bridge/move.js");
  const fs = await import("node:fs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "aiwb-move-carry-"));
  try {
    const projectsDir = path.join(dir, "projects"), garden = path.join(dir, "desk", "Сад");
    fs.mkdirSync(garden, { recursive: true });
    const src = path.join(dir, "fork-2.jsonl");
    writeFileSync(src, '{"type":"user","sessionId":"fork-2"}\n');
    const bound = [];
    const source = { agentId: "main", sessionKey: key("main", T2), entry: adopted(T2, "/d/_no_space", { pinnedAt: 21, lastReadAt: 22, lastInteractionAt: 9 }) };
    await moveChat({
      row: { threadId: `s:${source.sessionKey}`, sessionKey: source.sessionKey, name: "Pruning", customGroup: "_no_space" }, source, group: "Сад",
      claudeChat: () => ({ claudeId: "fork-2", chatId: T2, related: [T2, "fork-2"] }),
      request: async (method, params) => (method === "sessions.catalog.import" ? { sessionKey: key(params.agentId, params.threadId) } : {}),
      bind: async (p) => { bound.push(p); return { sessionId: "n", archived: false }; },
      transcriptFile: () => src, folderCwd: () => garden, agentOf: () => "sad", projectsDir,
      registryFile: path.join(dir, "adopted.json"), newId: () => "33333333-copy",
    });
    assert.deepEqual(bound[0].carry, { pinnedAt: 21, lastReadAt: 22 });
    assert.ok(fs.existsSync(path.join(claudeProjectDir(projectsDir, garden), "33333333-copy.jsonl")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
