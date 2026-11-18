// Gateway side of group chats in ordinary chat sessions (see chat-turns.js). The Control UI of the ai-workbench
// OpenClaw fork calls these methods from its "Add to group chat" button and when a message names a member.
//
// A member answers a full turn of its own: an OpenClaw agent in its session agent:<id>:aiwb-chat-<chat id>, a model
// as the chat's agent on that model in agent:<agent>:aiwb-chat-<chat id>-<hash>, an ACP agent in its own persistent
// ACP session (created on its first turn). The reply arrives through the agent_end hook (the fork fires it for ACP
// turns too) and is written into the chat as a row authored by the member.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chatTarget, hostNote, lastAssistantText, memberTurnMessage, parseChatMentions, parseMember, replyRow, userRow }
  from "./chat-turns.js";

export const CHAT_METHODS = {
  get: "aiwb-groups.chat.get", add: "aiwb-groups.chat.add", remove: "aiwb-groups.chat.remove",
  ask: "aiwb-groups.chat.ask", stop: "aiwb-groups.chat.stop",
};
const MAX_MEMBERS = 8;
const MAX_TEXT = 32_000;
const TURN_TIMEOUT_MS = 15 * 60_000;

class InputError extends Error {
  constructor(message) { super(message); this.code = "INVALID_REQUEST"; }
}
const fail = (respond, error) => respond(false, undefined, {
  code: error?.code === "INVALID_REQUEST" ? "INVALID_REQUEST" : "UNAVAILABLE", message: String(error?.message || error).slice(0, 500) });

/** ACP agents a member may be: acp.allowedAgents, else acp.defaultAgent; none when ACP is off (as Hand off). */
export function allowedAcpAgents(acp) {
  if (acp?.enabled === false) return [];
  const allowed = Array.isArray(acp?.allowedAgents) ? acp.allowedAgents.filter((a) => typeof a === "string" && a.trim()) : [];
  return [...new Set(allowed.length ? allowed : acp?.defaultAgent ? [acp.defaultAgent] : [])];
}

/** Reads and writes chat rows through the OpenClaw session transcript (the same writer bundled plugins use). */
export function sessionTranscript(api) {
  return {
    async read(sessionKey) {
      return (await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 200 }))?.messages ?? [];
    },
    async append(target, message) {
      const { appendSessionTranscriptMessageByIdentityStrict } = await import("openclaw/plugin-sdk/session-transcript-runtime");
      const config = api.runtime.config.current();
      const session = api.runtime.agent.session;
      const storePath = session.resolveStorePath(config.session?.store, { agentId: target.agentId });
      const entry = await session.getSessionEntryAsync({ agentId: target.agentId, sessionKey: target.sessionKey, storePath });
      if (!entry?.sessionId) throw new Error("the chat has no session yet; send it a message first");
      const result = await appendSessionTranscriptMessageByIdentityStrict({ config, agentId: target.agentId,
        sessionKey: target.sessionKey, sessionId: entry.sessionId, storePath, idempotencyLookup: "scan", updateMode: "inline", message });
      if (result.kind === "rejected") throw new Error(`the chat did not accept the row: ${result.reason}`);
    },
  };
}

/** A persistent ACP session for an ACP member, as `/acp spawn <agent>` creates one (without binding it). */
async function initAcpSessionDefault(api, { sessionKey, agentId, agent }) {
  const { getAcpSessionManager } = await import("openclaw/plugin-sdk/acp-runtime");
  await getAcpSessionManager().initializeSession({ cfg: api.runtime.config.current(), sessionKey, agentId, agent, mode: "persistent" });
}

export function registerChatGroups(api, { stateDir, now = () => Date.now(), transcript = sessionTranscript(api),
  initAcpSession = (params) => initAcpSessionDefault(api, params), configuredAgents = () => [], detach = (run) => run() } = {}) {
  const dir = path.join(stateDir, "workbench", "groups", "chats");
  const file = (target) => path.join(dir, `${target.id}.json`);
  const load = (target) => {
    try { return JSON.parse(readFileSync(file(target), "utf8")); } catch { return { sessionKey: target.sessionKey, members: [], cursors: {} }; }
  };
  const store = (target, chat) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file(target)}.tmp`, JSON.stringify(chat, null, 1), { mode: 0o600 });
    renameSync(`${file(target)}.tmp`, file(target));
  };
  // OpenClaw registers a plugin more than once; a hook or method may land in another registration than the one that
  // started a turn, so the running turns and the reply waiters are shared by the whole process.
  const running = (globalThis[Symbol.for("aiwb-groups.chat-running")] ??= new Map());   // chat id → { member, controller }
  const waiting = (globalThis[Symbol.for("aiwb-groups.chat-waiting")] ??= new Map());
  api.on("agent_end", (event, ctx) => {
    const waiter = ctx?.sessionKey && waiting.get(ctx.sessionKey);
    if (!waiter) return;
    waiting.delete(ctx.sessionKey);
    if (event?.success === false) waiter.reject(new Error(event.error ? String(event.error).slice(0, 300) : "the turn failed"));
    else waiter.resolve({ text: lastAssistantText(event?.messages || []),
      runtime: ctx.modelProviderId && ctx.modelId ? { provider: ctx.modelProviderId, model: ctx.modelId } : undefined });
  });

  const targetOf = (params) => {
    const target = chatTarget(params?.sessionKey);
    if (!target) throw new InputError("sessionKey is required");
    return target;
  };
  const view = (target, chat) => {
    const config = api.runtime.config.current();
    return { sessionKey: target.sessionKey, members: chat.members.map(({ kind, id, name, key }) => ({ kind, id, name, key })),
      running: running.get(target.id)?.member.key ?? null,
      candidates: { agents: configuredAgents().filter((a) => a.id !== target.agentId), acpAgents: allowedAcpAgents(config.acp) } };
  };

  async function memberSession(target, chat, member) {
    if (member.kind === "agent") return `agent:${member.id}:aiwb-chat-${target.id}`;
    if (member.kind === "model") return `agent:${target.agentId}:aiwb-chat-${target.id}-${createHash("sha256").update(member.id).digest("hex").slice(0, 8)}`;
    if (!allowedAcpAgents(api.runtime.config.current().acp).includes(member.id)) throw new InputError(`ACP agent ${member.id} is not allowed (acp.allowedAgents)`);
    if (!member.acpSessionKey) {
      const sessionKey = `agent:${target.agentId}:acp:${randomUUID()}`;
      await initAcpSession({ sessionKey, agentId: target.agentId, agent: member.id });
      member.acpSessionKey = sessionKey;
      store(target, chat);
    }
    return member.acpSessionKey;
  }

  /** Starts the member's turn while the request is admitted; `reply` settles when it ends (awaited in the background). */
  async function startTurn(target, chat, member, message, signal) {
    const sessionKey = await memberSession(target, chat, member);
    let timer;
    const reply = new Promise((resolve, reject) => {
      waiting.set(sessionKey, { resolve, reject });
      timer = setTimeout(() => reject(new Error(`no answer in ${TURN_TIMEOUT_MS / 60_000} minutes`)), TURN_TIMEOUT_MS);
      signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    });
    reply.catch(() => {}).finally(() => { clearTimeout(timer); waiting.delete(sessionKey); });
    const slash = member.id.indexOf("/");
    try {
      await api.runtime.subagent.run({ sessionKey, message, deliver: false, idempotencyKey: randomUUID(),
        ...(member.kind === "model" ? { provider: member.id.slice(0, slash), model: member.id.slice(slash + 1) } : {}) });
    } catch (error) {
      waiting.get(sessionKey)?.reject(error);
    }
    return { reply };
  }

  async function finishTurn(target, chat, member, turnId, reply) {
    let row;
    try {
      const { text, runtime } = await reply;
      if (!text) throw new Error("the turn ended without a text reply");
      row = replyRow({ member, text, at: now(), turnId, runtime });
    } catch (error) {
      row = replyRow({ member, error: String(error?.message || error).slice(0, 300), at: now(), turnId });
    }
    try {
      await transcript.append(target, row);
      chat.cursors = { ...chat.cursors, [member.key]: row.timestamp };
      store(target, chat);
      if (!row.errorMessage) {
        await api.session?.workflow?.enqueueNextTurnInjection?.({ sessionKey: target.sessionKey, text: hostNote(member),
          idempotencyKey: `aiwb-group:${turnId}`, placement: "prepend_context", ttlMs: 24 * 60 * 60 * 1000 }).catch(() => {});
      }
    } catch (error) {
      api.logger?.warn?.(`aiwb-groups: reply of ${member.key} not written: ${error?.message || error}`);
    } finally {
      running.delete(target.id);
    }
  }

  // An admin-scoped Control UI client is the owner, as the Gateway's own chat.send decides it.
  const isOwnerClient = (client) => Array.isArray(client?.connect?.scopes) && client.connect.scopes.includes("operator.admin");

  const method = (name, scope, handler) => api.registerGatewayMethod(name, async ({ params, respond, client }) => {
    try { respond(true, await handler(params ?? {}, client), undefined); } catch (error) { fail(respond, error); }
  }, { scope });

  method(CHAT_METHODS.get, "operator.read", async (params) => {
    const target = targetOf(params);
    return view(target, load(target));
  });

  method(CHAT_METHODS.add, "operator.write", async (params) => {
    const target = targetOf(params);
    const configured = configuredAgents().find((a) => params.member?.kind === "agent" && a.id === params.member?.id);
    const member = parseMember(configured && !params.member.name ? { ...params.member, name: configured.name } : params.member);
    if (!member) throw new InputError("member is { kind: agent | acp | model, id, name? }");
    const config = api.runtime.config.current();
    if (member.kind === "agent" && !configured) throw new InputError(`unknown agent ${member.id}`);
    if (member.kind === "agent" && member.id === target.agentId) throw new InputError("the chat's own agent already answers here");
    if (member.kind === "acp" && !allowedAcpAgents(config.acp).includes(member.id)) throw new InputError(`ACP agent ${member.id} is not allowed (acp.allowedAgents)`);
    const chat = load(target);
    if (chat.members.some((m) => m.key === member.key)) return view(target, chat);
    if (chat.members.length >= MAX_MEMBERS) throw new InputError(`a group chat has at most ${MAX_MEMBERS} members`);
    chat.members.push(member);
    store(target, chat);
    return view(target, chat);
  });

  method(CHAT_METHODS.remove, "operator.write", async (params) => {
    const target = targetOf(params);
    const chat = load(target);
    if (running.get(target.id)?.member.key === params.member) throw new InputError("that member is answering; stop it first");
    chat.members = chat.members.filter((m) => m.key !== params.member);
    store(target, chat);
    return view(target, chat);
  });

  // The user's message to one member: written into the chat now; the member answers in the background.
  method(CHAT_METHODS.ask, "operator.write", async (params, client) => {
    const target = targetOf(params);
    const chat = load(target);
    const text = String(params.text ?? "").trim();
    if (!text) throw new InputError("text is required");
    if (text.length > MAX_TEXT) throw new InputError(`text is longer than ${MAX_TEXT} characters`);
    const member = chat.members.find((m) => m.key === params.member) ?? parseChatMentions(text, chat.members)[0];
    if (!member) throw new InputError("name a member of this group chat");
    if (running.has(target.id)) throw new InputError(`${running.get(target.id).member.name} is still answering`);
    const controller = new AbortController();
    running.set(target.id, { member, controller });
    try {
      let history = [];
      try { history = await transcript.read(target.sessionKey); } catch { /* the member gets the question alone */ }
      const turnId = randomUUID();
      await memberSession(target, chat, member);                // an ACP member's session exists before the question is written
      if (params.record !== false) await transcript.append(target, userRow({ text, at: now(), turnId, owner: isOwnerClient(client) }));
      const message = memberTurnMessage({ messages: history, member, members: chat.members, since: chat.cursors?.[member.key] ?? 0, asked: text });
      const { reply } = await startTurn(target, chat, member, message, controller.signal);
      void detach(() => finishTurn(target, chat, member, turnId, reply)).catch(() => {});
      return { ...view(target, chat), turnId };
    } catch (error) {
      running.delete(target.id);
      throw error;
    }
  });

  method(CHAT_METHODS.stop, "operator.write", async (params) => {
    const target = targetOf(params);
    running.get(target.id)?.controller.abort();
    return { stopping: running.has(target.id) };
  });

  return { running, waiting };
}
