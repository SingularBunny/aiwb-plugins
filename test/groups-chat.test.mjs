import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CHAT_METHODS, registerChatGroups } from "../groups/chat.js";
import { chatTarget, memberTurnMessage, parseChatMentions, parseMember, replyRow } from "../groups/chat-turns.js";

const JUNIE = parseMember({ kind: "acp", id: "junie" });
const GEMMA = parseMember({ kind: "model", id: "openrouter/google/gemma-3-27b-it:free", name: "Gemma" });
const GARDEN = parseMember({ kind: "agent", id: "garden", name: "Gardener" });
const MEMBERS = [JUNIE, GEMMA, GARDEN];

test("group chat: members are an OpenClaw agent, an ACP agent or a model; anything else is refused", () => {
  assert.deepEqual(JUNIE, { kind: "acp", id: "junie", name: "Junie", key: "acp:junie" });
  assert.equal(GEMMA.key, "model:openrouter/google/gemma-3-27b-it:free");
  assert.equal(parseMember({ kind: "model", id: "no-provider" }), null);
  assert.equal(parseMember({ kind: "robot", id: "x" }), null);
  assert.equal(parseMember({ kind: "agent", id: "../etc" }), null);
  assert.deepEqual(chatTarget("main"), { sessionKey: "agent:main:main", agentId: "main", id: chatTarget("agent:main:main").id });
  assert.equal(chatTarget("agent:garden:chat-1").agentId, "garden");
});

test("group chat: @mentions pick the next speakers by name, first word, id or a model's short id, in order", () => {
  assert.deepEqual(parseChatMentions("@gardener and @Junie, what do you think?", MEMBERS), [GARDEN, JUNIE]);
  assert.deepEqual(parseChatMentions("@junie: review it. @JUNIE again", MEMBERS), [JUNIE]);
  assert.deepEqual(parseChatMentions("@gemma-3-27b-it:free hi", MEMBERS), [GEMMA]);
  assert.deepEqual(parseChatMentions("@Gemma what about pears?", MEMBERS), [GEMMA]);
  assert.deepEqual(parseChatMentions("mail me at a@junie.dev or @nobody", MEMBERS), []);
  assert.deepEqual(parseChatMentions("no mentions", MEMBERS), []);
});

test("group chat: a member gets who is here once, then what others said since its turn, ending with the question", () => {
  const messages = [
    { role: "user", content: "Plan the patch", timestamp: 1 },
    { role: "assistant", provider: "anthropic", model: "claude-opus-4-6", content: [{ type: "text", text: "Step one." }], timestamp: 2 },
    { role: "assistant", provider: "acp", model: "junie", content: "Old Junie reply", timestamp: 3, __openclaw: { participant: { key: "acp:junie", name: "Junie" } } },
    { role: "assistant", provider: "openrouter", model: "google/gemma", content: "Gemma says hi", timestamp: 4, __openclaw: { participant: { key: GEMMA.key, name: "Gemma" } } },
    { role: "user", content: "/status", timestamp: 5 },
    { role: "user", content: "@Junie review it", timestamp: 6 },
  ];
  const first = memberTurnMessage({ messages, member: JUNIE, members: MEMBERS, asked: "@Junie review it" });
  assert.ok(first.startsWith("You are Junie in a group chat with the user and: Gemma, Gardener, the chat's own assistant."));
  assert.ok(first.includes("[User]: Plan the patch\n[claude-opus-4-6]: Step one.\n[Gemma]: Gemma says hi\n[User]: @Junie review it"));
  assert.ok(!first.includes("Old Junie reply") && !first.includes("/status"));
  assert.equal(first.match(/@Junie review it/g).length, 1);
  const later = memberTurnMessage({ messages, member: JUNIE, members: MEMBERS, since: 3, asked: "@Junie review it" });
  assert.equal(later, "New messages in the group chat since your last reply:\n\n[Gemma]: Gemma says hi\n[User]: @Junie review it");
});

test("group chat: a reply row names its member as author, so the chat shows it and models replay it", () => {
  const acp = replyRow({ member: JUNIE, text: "Fine", at: 9, turnId: "t1" });
  assert.deepEqual([acp.provider, acp.model, acp.stopReason, acp.__openclaw.participant.key], ["acp", "junie", "stop", "acp:junie"]);
  const model = replyRow({ member: GEMMA, text: "Hi", at: 9, turnId: "t2" });
  assert.deepEqual([model.provider, model.model], ["openrouter", "google/gemma-3-27b-it:free"]);
  const agent = replyRow({ member: GARDEN, text: "Prune", at: 9, turnId: "t3", runtime: { provider: "ollama", model: "qwen3" } });
  assert.deepEqual([agent.provider, agent.model, agent.__openclaw.participant.name], ["ollama", "qwen3", "Gardener"]);
  const failed = replyRow({ member: JUNIE, error: "stopped", at: 9, turnId: "t4" });
  assert.deepEqual([failed.stopReason, failed.errorMessage, failed.content[0].text], ["error", "stopped", "Junie did not answer: stopped"]);
});

function fakeApi({ config }) {
  const methods = {};
  const hooks = {};
  const calls = [];
  const notes = [];
  const api = {
    on: (name, handler) => { hooks[name] = handler; },
    registerGatewayMethod: (name, handler, opts) => { methods[name] = { handler, scope: opts.scope }; },
    session: { workflow: { enqueueNextTurnInjection: async (note) => { notes.push(note); return { enqueued: true }; } } },
    runtime: {
      config: { current: () => config },
      subagent: {
        run: async (params) => {
          calls.push(params);
          // The fork fires agent_end at the end of an ACP turn, with the ACP agent as provider "acp".
          const acp = params.sessionKey.includes(":acp:");
          setTimeout(() => hooks.agent_end(
            params.message.includes("FAIL") ? { success: false, error: "ACP_TURN_FAILED", messages: [] }
              : { success: true, messages: [{ role: "user", content: params.message }, { role: "assistant", content: [{ type: "text", text: `answer ${calls.length}` }] }] },
            { sessionKey: params.sessionKey, ...(acp ? { modelProviderId: "acp", modelId: "junie" } : { modelProviderId: "ollama", modelId: "qwen3" }) }), 1);
          return { runId: `r${calls.length}` };
        },
      },
    },
  };
  const call = (name, params) => new Promise((resolve) => methods[name].handler({ params, respond: (ok, payload, error) => resolve({ ok, payload, error }) }));
  return { api, methods, calls, notes, call };
}

test("group chat plugin: add members, ask an ACP member by mention, its reply lands in the chat as Junie", async () => {
  const config = { acp: { allowedAgents: ["junie"] } };
  const { api, methods, calls, notes, call } = fakeApi({ config });
  const rows = [{ role: "user", content: "Plan the patch", timestamp: 1 }, { role: "assistant", provider: "anthropic", model: "opus", content: "Step one.", timestamp: 2 }];
  const appended = [];
  const acpSessions = [];
  let clock = 100;
  const { running } = registerChatGroups(api, {
    stateDir: mkdtempSync(path.join(os.tmpdir(), "groups-chat-")),
    now: () => ++clock,
    configuredAgents: () => [{ id: "main", name: "Main" }, { id: "garden", name: "Gardener" }],
    transcript: { read: async () => rows, append: async (target, row) => { appended.push([target.sessionKey, row]); rows.push(row); } },
    initAcpSession: async (params) => { acpSessions.push(params); },
  });
  assert.deepEqual(Object.fromEntries(Object.entries(methods).map(([k, v]) => [k.split(".").pop(), v.scope])),
    { get: "operator.read", add: "operator.write", remove: "operator.write", ask: "operator.write", stop: "operator.write" });

  const empty = (await call(CHAT_METHODS.get, { sessionKey: "main" })).payload;
  assert.deepEqual([empty.members, empty.candidates.agents.map((a) => a.id), empty.candidates.acpAgents], [[], ["garden"], ["junie"]]);
  assert.equal((await call(CHAT_METHODS.add, { sessionKey: "main", member: { kind: "acp", id: "codex" } })).error.code, "INVALID_REQUEST");
  assert.equal((await call(CHAT_METHODS.add, { sessionKey: "main", member: { kind: "agent", id: "main" } })).error.code, "INVALID_REQUEST");
  assert.equal((await call(CHAT_METHODS.add, { sessionKey: "main", member: { kind: "agent", id: "ghost" } })).error.code, "INVALID_REQUEST");
  await call(CHAT_METHODS.add, { sessionKey: "main", member: { kind: "acp", id: "junie" } });
  await call(CHAT_METHODS.add, { sessionKey: "main", member: { kind: "model", id: "openrouter/google/gemma", name: "Gemma" } });
  const added = (await call(CHAT_METHODS.add, { sessionKey: "agent:main:main", member: { kind: "agent", id: "garden" } })).payload;
  assert.deepEqual(added.members.map((m) => m.key), ["acp:junie", "model:openrouter/google/gemma", "agent:garden"]);

  assert.equal((await call(CHAT_METHODS.ask, { sessionKey: "main", text: "no one named" })).error.code, "INVALID_REQUEST");
  const asked = await call(CHAT_METHODS.ask, { sessionKey: "main", text: "@Junie review the plan" });
  assert.equal(asked.ok, true);
  assert.equal(asked.payload.running, "acp:junie");
  assert.equal((await call(CHAT_METHODS.ask, { sessionKey: "main", text: "@Gemma too" })).error.message, "Junie is still answering");
  for (let i = 0; i < 50 && running.size; i++) await new Promise((r) => setTimeout(r, 5));

  // The ACP session was created once, unbound, for the chat's own agent; the turn ran in it.
  assert.equal(acpSessions.length, 1);
  assert.match(acpSessions[0].sessionKey, /^agent:main:acp:[0-9a-f-]{36}$/);
  assert.deepEqual([acpSessions[0].agentId, acpSessions[0].agent], ["main", "junie"]);
  assert.equal(calls[0].sessionKey, acpSessions[0].sessionKey);
  assert.ok(calls[0].message.startsWith("You are Junie in a group chat") && calls[0].message.endsWith("[User]: @Junie review the plan"));
  assert.deepEqual(appended.map(([key, row]) => [key, row.role, row.provider ?? null, row.model ?? null]),
    [["agent:main:main", "user", null, null], ["agent:main:main", "assistant", "acp", "junie"]]);
  assert.equal(appended[1][1].content[0].text, "answer 1");
  assert.equal(appended[1][1].__openclaw.participant.key, "acp:junie");
  assert.ok(notes[0].text.includes("Junie (an ACP agent) answered") && notes[0].sessionKey === "agent:main:main");

  // A second question to Junie reuses its session and gets only what is new; a model member runs on its model.
  await call(CHAT_METHODS.ask, { sessionKey: "main", member: "acp:junie", text: "And now?" });
  for (let i = 0; i < 50 && running.size; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(acpSessions.length, 1);
  assert.ok(calls[1].message.startsWith("New messages in the group chat since your last reply:"));
  await call(CHAT_METHODS.ask, { sessionKey: "main", text: "@Gemma your view?" });
  for (let i = 0; i < 50 && running.size; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([calls[2].provider, calls[2].model], ["openrouter", "google/gemma"]);
  assert.match(calls[2].sessionKey, /^agent:main:aiwb-chat-[0-9a-f]{12}-[0-9a-f]{8}$/);
  assert.ok(calls[2].message.includes("[Junie]: answer 2"));
  assert.deepEqual([rows.at(-1).provider, rows.at(-1).model], ["openrouter", "google/gemma"]);

  // An OpenClaw agent answers in its own session and is recorded with the model that served it; a failure is a row.
  const gardenAsk = await call(CHAT_METHODS.ask, { sessionKey: "main", text: "@Gardener FAIL please" });
  assert.equal(gardenAsk.ok, true, JSON.stringify(gardenAsk.error));
  for (let i = 0; i < 50 && running.size; i++) await new Promise((r) => setTimeout(r, 5));
  assert.match(calls[3].sessionKey, /^agent:garden:aiwb-chat-[0-9a-f]{12}$/);
  assert.deepEqual([rows.at(-1).stopReason, rows.at(-1).errorMessage], ["error", "ACP_TURN_FAILED"]);
  assert.equal(notes.length, 3);                                // no note after a failed turn

  const removed = (await call(CHAT_METHODS.remove, { sessionKey: "main", member: "model:openrouter/google/gemma" })).payload;
  assert.deepEqual(removed.members.map((m) => m.key), ["acp:junie", "agent:garden"]);
});

test("group chat plugin: Stop ends a member's turn that is still running", async () => {
  const { api, call } = fakeApi({ config: { acp: { allowedAgents: ["junie"] } } });
  api.runtime.subagent.run = async () => ({ runId: "never-ends" });
  const rows = [];
  const { running } = registerChatGroups(api, {
    stateDir: mkdtempSync(path.join(os.tmpdir(), "groups-chat-")),
    transcript: { read: async () => rows, append: async (_t, row) => { rows.push(row); } },
    initAcpSession: async () => {},
  });
  await call(CHAT_METHODS.add, { sessionKey: "main", member: { kind: "acp", id: "junie" } });
  await call(CHAT_METHODS.ask, { sessionKey: "main", text: "@junie long task" });
  assert.equal((await call(CHAT_METHODS.stop, { sessionKey: "main" })).payload.stopping, true);
  for (let i = 0; i < 50 && running.size; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(rows.at(-1).errorMessage, "stopped");
});
