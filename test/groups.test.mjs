import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { lastAssistantText, managerPrompt, parseManagerChoice, parseMentions, runRound, turnMessage } from "../groups/orchestrate.js";
import { METHODS, registerGroups } from "../groups/register.js";

const MEMBERS = [
  { id: "main", name: "Main" },
  { id: "garden", name: "Gardener", description: "plants and soil" },
  { id: "orchard", name: "Orchard keeper", description: "fruit trees" },
];

test("groups: mentions by id or name, once each, in order; unknown names ignored", () => {
  assert.deepEqual(parseMentions("@orchard and @Gardener, then @orchard again, @nobody", MEMBERS), ["orchard", "garden"]);
  assert.deepEqual(parseMentions("no mentions here", MEMBERS), []);
  assert.deepEqual(parseMentions("@Orchard keeper what about pears?", MEMBERS), ["orchard"]);
});

test("groups: an agent gets the members once, then only what others said since its last turn", () => {
  const transcript = [
    { role: "user", text: "When to prune?" },
    { role: "agent", agentId: "garden", text: "In late winter." },
    { role: "agent", agentId: "orchard", text: "Pears too." },
    { role: "user", text: "And plums?" },
  ];
  const first = turnMessage({ transcript, members: MEMBERS, agentId: "garden", since: 0 });
  assert.ok(first.startsWith("You are Gardener in a group chat with the user and: Main, Orchard keeper."));
  assert.ok(first.includes("[User]: When to prune?") && first.includes("[Orchard keeper]: Pears too."));
  assert.ok(!first.includes("In late winter."));                 // its own reply is in its own session
  const later = turnMessage({ transcript, members: MEMBERS, agentId: "garden", since: 2 });
  assert.equal(later, "New messages in the group since your last reply:\n\n[Orchard keeper]: Pears too.\n[User]: And plums?");
});

test("groups: the manager names an agent or the user; anything else is unreadable", () => {
  const prompt = managerPrompt({ transcript: [{ role: "user", text: "Hi" }], members: MEMBERS, lastSpeaker: "garden", turnsLeft: 2 });
  assert.ok(prompt.includes("- garden: Gardener — plants and soil") && prompt.includes("just spoke (garden)") && prompt.includes("turns left before the user speaks again: 2"));
  assert.equal(parseManagerChoice("NEXT: orchard", MEMBERS), "orchard");
  assert.equal(parseManagerChoice("Thinking… NEXT: @Gardener", MEMBERS), "garden");
  assert.equal(parseManagerChoice("NEXT: USER", MEMBERS), "USER");
  assert.equal(parseManagerChoice("NEXT: stranger", MEMBERS), null);
  assert.equal(parseManagerChoice("orchard", MEMBERS), null);
  assert.equal(lastAssistantText([{ role: "assistant", content: [{ type: "text", text: "old" }] }, { role: "user", content: "q" },
    { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "new" }] }]), "new");
});

test("groups: a round — mentioned agents first, then the manager, stopped by the user pick or the limit", async () => {
  const spoke = [];
  const turns = await runRound({ mentions: ["orchard"], maxTurns: 3,
    pickByManager: async (last) => (last === "orchard" ? "garden" : "USER"),
    runAgent: async (id) => `reply of ${id}`, onTurn: async (e) => spoke.push(e.agentId) });
  assert.deepEqual([turns, spoke], [2, ["orchard", "garden"]]);
  // The limit holds even when the manager never picks the user; a failed turn is recorded and counts.
  const spoke2 = [];
  const limited = await runRound({ mentions: [], maxTurns: 3, pickByManager: async () => "garden",
    runAgent: async () => { throw new Error("busy"); }, onTurn: async (e) => spoke2.push(e.error) });
  assert.deepEqual([limited, spoke2], [3, ["busy", "busy", "busy"]]);
  // An unreadable manager answer ends the round.
  assert.equal(await runRound({ mentions: [], maxTurns: 3, pickByManager: async () => null, runAgent: async () => "x", onTurn: async () => {} }), 0);
});

test("groups plugin: save, send, and a background round through subagent runs in per-group sessions", async () => {
  const methods = {};
  const calls = [];
  const sessions = {};
  const api = {
    registerGatewayMethod: (name, handler, opts) => { methods[name] = { handler, scope: opts.scope }; },
    registerControlUiDescriptor: () => {},
    runtime: {
      config: { current: () => ({ agents: { entries: { garden: { identity: { name: "Gardener" } }, orchard: {} } } }) },
      subagent: {
        complete: async ({ agentId }) => { calls.push(["manager", agentId]); return { text: calls.some((c) => c[0] === "run" && c[1].includes(":orchard:")) ? "NEXT: USER" : "NEXT: orchard" }; },
        run: async ({ sessionKey, message }) => {
          calls.push(["run", sessionKey, message.split("\n")[0]]);
          const agent = sessionKey.split(":")[1];
          sessions[sessionKey] = [...(sessions[sessionKey] || []), { role: "user", content: message }, { role: "assistant", content: `answer from ${agent}` }];
          return { runId: `r-${agent}` };
        },
        // The observation is cancelled for one agent, as it is for background work; its reply still counts.
        waitForRun: async ({ runId }) => { if (runId === "r-orchard") throw new Error("agent.wait observation cancelled"); return { status: "ok" }; },
        getSessionMessages: async ({ sessionKey }) => ({ messages: sessions[sessionKey] || [] }),
      },
    },
  };
  registerGroups(api, { stateDir: mkdtempSync(path.join(os.tmpdir(), "groups-")), sleep: async () => {} });
  const call = (name, params) => new Promise((resolve) => methods[name].handler({ params, respond: (ok, payload, error) => resolve({ ok, payload, error }) }));
  assert.deepEqual(Object.fromEntries(Object.entries(methods).map(([k, v]) => [k.split(".").pop(), v.scope])),
    { agents: "operator.read", list: "operator.read", get: "operator.read", save: "operator.write", remove: "operator.write", send: "operator.write", stop: "operator.write" });
  assert.deepEqual((await call(METHODS.agents, {})).payload.agents.map((a) => a.id), ["main", "garden", "orchard"]);
  assert.equal((await call(METHODS.save, { agents: ["garden"] })).error.code, "INVALID_REQUEST");      // fewer than two
  assert.equal((await call(METHODS.save, { agents: ["garden", "ghost"] })).error.code, "INVALID_REQUEST");
  const saved = await call(METHODS.save, { name: "Fruit", agents: ["garden", "orchard"], maxTurns: 2 });
  const id = saved.payload.group.id;
  assert.deepEqual([saved.payload.group.manager, saved.payload.group.maxTurns], ["main", 2]);

  const sent = await call(METHODS.send, { id, text: "@garden when to prune?" });
  assert.equal(sent.ok, true);
  for (let i = 0; i < 50 && (await call(METHODS.get, { id })).payload.group.running; i++) await new Promise((r) => setTimeout(r, 5));
  const group = (await call(METHODS.get, { id })).payload.group;
  assert.deepEqual(group.transcript.map((m) => [m.role, m.agentId ?? null, m.text]),
    [["user", null, "@garden when to prune?"], ["agent", "garden", "answer from garden"], ["agent", "orchard", "answer from orchard"]]);
  assert.deepEqual(calls.filter((c) => c[0] === "run").map((c) => c[1]), [`agent:garden:aiwb-group-${id}`, `agent:orchard:aiwb-group-${id}`]);
  assert.ok(calls.some((c) => c[0] === "manager" && c[1] === "main"));
  // The limit (2) stopped the round before the manager could be asked again.
  assert.equal(calls.filter((c) => c[0] === "manager").length, 1);
  assert.equal((await call(METHODS.list, {})).payload.groups[0].messages, 3);
  assert.equal((await call(METHODS.get, { id: "../etc" })).error.code, "INVALID_REQUEST");
  assert.equal((await call(METHODS.remove, { id })).ok, true);
});
