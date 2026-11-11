// Gateway side of Groups: group storage, the members, and running a round of agent turns after a user message.
// Separate from index.js so tests can register it against a fake api without the OpenClaw SDK.
//
// Each agent answers with a full turn of its own (instructions, memory, tools, model) in its own session for the
// group, agent:<id>:aiwb-group-<group id>, through api.runtime.subagent.run; the manager picks the next speaker
// with api.runtime.subagent.complete on the manager agent (main by default), a tool-free completion.
// A round runs in the background; the page polls aiwb-groups.get.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { lastAssistantText, managerPrompt, parseManagerChoice, parseMentions, runRound, turnMessage } from "./orchestrate.js";

export const PLUGIN_ID = "aiwb-groups";
export const TAB_ID = "groups";
export const METHODS = {
  agents: `${PLUGIN_ID}.agents`, list: `${PLUGIN_ID}.list`, get: `${PLUGIN_ID}.get`,
  save: `${PLUGIN_ID}.save`, remove: `${PLUGIN_ID}.remove`, send: `${PLUGIN_ID}.send`, stop: `${PLUGIN_ID}.stop`,
};
const GROUP_ID = /^[a-z0-9]{12}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_TEXT = 32_000;
const TURN_TIMEOUT_MS = 15 * 60_000;

class InputError extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID_REQUEST";
  }
}

function failure(respond, error) {
  respond(false, undefined, { code: error?.code === "INVALID_REQUEST" ? "INVALID_REQUEST" : "UNAVAILABLE",
    message: String(error?.message || error).slice(0, 500) });
}

// detach(run): keeps a round admitted after the send request has answered. The Gateway refuses agent work that is
// not part of an admitted request ("Gateway is temporarily unavailable"); index.js passes the SDK's
// runDetachedWebhookWork, which reserves its own admission when called while the request is still admitted.
export function registerGroups(api, { stateDir, now = () => Date.now(), detach = (run) => run(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const dir = path.join(stateDir, "workbench", "groups");
  const file = (id) => path.join(dir, `${id}.json`);
  const load = (id) => {
    if (!GROUP_ID.test(String(id))) throw new InputError("unknown group");
    try { return JSON.parse(readFileSync(file(id), "utf8")); } catch { throw new InputError("unknown group"); }
  };
  const store = (g) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file(g.id)}.tmp`, JSON.stringify(g, null, 1), { mode: 0o600 });
    renameSync(`${file(g.id)}.tmp`, file(g.id));
  };
  const running = new Map();                                   // group id → AbortController

  /** Configured agents: id, name, a short description from the identity. */
  function configuredAgents() {
    const entries = api.runtime?.config?.current?.()?.agents?.entries || {};
    const ids = [...new Set(["main", ...Object.keys(entries)])];
    return ids.map((id) => ({ id, name: entries[id]?.identity?.name || (id === "main" ? "Main" : id),
      description: entries[id]?.identity?.description || entries[id]?.description || "" }));
  }
  const view = (g) => ({ ...g, running: running.has(g.id) });

  async function agentTurn(group, agentId, members) {
    const sessionKey = `agent:${agentId}:aiwb-group-${group.id}`;
    const since = group.cursors?.[agentId] ?? 0;
    const message = turnMessage({ transcript: group.transcript, members, agentId, since });
    // The reply is the new assistant message in the agent's group session. waitForRun only shortens the wait: an
    // observation started from background work can be cancelled ("agent.wait observation cancelled") while the run
    // itself goes on and answers, so the session is what counts.
    const assistants = async () => {
      const { messages } = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 50 });
      return (messages || []).filter((m) => m?.role === "assistant");
    };
    const before = (await assistants()).length;
    const { runId } = await api.runtime.subagent.run({ sessionKey, message, deliver: false });
    const deadline = now() + TURN_TIMEOUT_MS;
    let observing = true;
    while (now() < deadline) {
      if (running.get(group.id)?.signal.aborted) throw new Error("stopped");
      let status = null;
      if (observing) {
        try {
          const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 30_000 });
          status = result?.status ?? null;
          if (status === "error" || status === "timeout") throw new Error(`the agent's turn ended: ${status}${result?.error ? ` (${result.error})` : ""}`);
        } catch (error) {
          if (/turn ended/.test(String(error?.message))) throw error;
          observing = false;                                   // fall back to watching the session
        }
      } else {
        await sleep(3000);
      }
      const now_ = await assistants();
      if (now_.length > before) {
        const text = lastAssistantText(now_.slice(before));
        if (text) return text;
      }
      if (status === "ok") throw new Error("the agent gave no text reply");
    }
    throw new Error("the agent did not answer in 15 minutes");
  }

  async function round(group, userText) {
    const controller = new AbortController();
    running.set(group.id, controller);
    try {
      const members = configuredAgents().filter((a) => group.agents.includes(a.id));
      const mentions = parseMentions(userText, members);
      await runRound({
        mentions, maxTurns: group.maxTurns, signal: controller.signal,
        pickByManager: async (last, turnsLeft) => {
          const { text } = await api.runtime.subagent.complete({ agentId: group.manager || "main", timeoutMs: 120_000,
            message: managerPrompt({ transcript: group.transcript, members, lastSpeaker: last, turnsLeft }) });
          return parseManagerChoice(text, members);
        },
        runAgent: async (agentId) => {
          const reply = await agentTurn(group, agentId, members);
          group.cursors = { ...group.cursors, [agentId]: group.transcript.length + 1 };
          return reply;
        },
        onTurn: async (entry) => {
          group.transcript.push(entry);
          group.updatedAt = now();
          store(group);
        },
      });
    } catch (error) {
      group.transcript.push({ role: "system", text: `The round stopped: ${String(error?.message || error).slice(0, 300)}`, at: now() });
      store(group);
    } finally {
      running.delete(group.id);
    }
  }

  api.registerGatewayMethod(METHODS.agents, async ({ respond }) => {
    try { respond(true, { agents: configuredAgents() }, undefined); } catch (error) { failure(respond, error); }
  }, { scope: "operator.read" });

  api.registerGatewayMethod(METHODS.list, async ({ respond }) => {
    try {
      let names = [];
      try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
      const groups = names.map((f) => { try { return JSON.parse(readFileSync(path.join(dir, f), "utf8")); } catch { return null; } })
        .filter(Boolean).map((g) => ({ id: g.id, name: g.name, agents: g.agents, messages: g.transcript.length, updatedAt: g.updatedAt, running: running.has(g.id) }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      respond(true, { groups }, undefined);
    } catch (error) { failure(respond, error); }
  }, { scope: "operator.read" });

  api.registerGatewayMethod(METHODS.get, async ({ params, respond }) => {
    try { respond(true, { group: view(load(params?.id)) }, undefined); } catch (error) { failure(respond, error); }
  }, { scope: "operator.read" });

  // Create (no id) or change name, members, manager, turn limit.
  api.registerGatewayMethod(METHODS.save, async ({ params, respond }) => {
    try {
      const known = new Set(configuredAgents().map((a) => a.id));
      const agents = Array.isArray(params?.agents) ? [...new Set(params.agents)].filter((a) => AGENT_ID.test(a) && known.has(a)) : [];
      if (agents.length < 2) throw new InputError("a group needs at least two configured agents");
      if (agents.length > 8) throw new InputError("a group has at most 8 agents");
      const name = String(params.name ?? "").trim().slice(0, 80) || agents.join(", ");
      const manager = params.manager && known.has(params.manager) ? params.manager : "main";
      const maxTurns = Number.isInteger(params.maxTurns) && params.maxTurns >= 1 && params.maxTurns <= 6 ? params.maxTurns : 3;
      const group = params.id ? load(params.id) : { id: randomBytes(6).toString("hex"), transcript: [], cursors: {}, createdAt: now() };
      Object.assign(group, { name, agents, manager, maxTurns, updatedAt: now() });
      store(group);
      respond(true, { group: view(group) }, undefined);
    } catch (error) { failure(respond, error); }
  }, { scope: "operator.write" });

  api.registerGatewayMethod(METHODS.remove, async ({ params, respond }) => {
    try {
      const group = load(params?.id);
      if (running.has(group.id)) throw new InputError("the group is answering; stop it first");
      rmSync(file(group.id), { force: true });
      respond(true, { removed: group.id }, undefined);
    } catch (error) { failure(respond, error); }
  }, { scope: "operator.write" });

  // A user message: stored at once, the agent round runs in the background.
  api.registerGatewayMethod(METHODS.send, async ({ params, respond }) => {
    try {
      const group = load(params?.id);
      if (running.has(group.id)) throw new InputError("the group is still answering");
      const text = String(params?.text ?? "").trim();
      if (!text) throw new InputError("text is required");
      if (text.length > MAX_TEXT) throw new InputError(`text is longer than ${MAX_TEXT} characters`);
      group.transcript.push({ role: "user", text, at: now() });
      group.updatedAt = now();
      store(group);
      void detach(() => round(group, text)).catch(() => {});
      respond(true, { group: view(group) }, undefined);
    } catch (error) { failure(respond, error); }
  }, { scope: "operator.write" });

  api.registerGatewayMethod(METHODS.stop, async ({ params, respond }) => {
    try {
      const group = load(params?.id);
      running.get(group.id)?.abort();
      respond(true, { stopping: running.has(group.id) }, undefined);
    } catch (error) { failure(respond, error); }
  }, { scope: "operator.write" });

  const controls = api.session?.controls?.registerControlUiDescriptor ? api.session.controls : api;
  controls.registerControlUiDescriptor?.({
    surface: "tab", id: TAB_ID, slug: TAB_ID, label: "Groups",
    description: "Several agents in one conversation; a manager picks who speaks next",
    icon: "users", group: "agent", requiredScopes: ["operator.read"],
  });
  return { configuredAgents, running };
}
