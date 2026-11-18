// Group chat in an ordinary chat session: the pure parts, testable without the OpenClaw SDK.
// A chat keeps answering with its own model or bound agent (Hand off switches that one answerer). Members added
// with "Add to group chat" answer as separate participants when the user names them: "@Junie …" in the message, or
// the "Ask Junie" chip, which puts the mention into the composer. A member is an OpenClaw agent, an ACP agent or a
// model; its reply is written into the chat with its own author, so the chat shows its name and avatar and the
// chat's own model reads it as shared history.
import { createHash } from "node:crypto";

export const MEMBER_KINDS = ["agent", "acp", "model"];
const MEMBER_ID = { agent: /^[a-z0-9][a-z0-9_-]{0,63}$/i, acp: /^[a-z0-9][a-z0-9._-]{0,63}$/i, model: /^[^\s/]+\/\S{1,200}$/ };
const MAX_CONTEXT_MESSAGES = 30;
const MAX_CONTEXT_CHARS = 4000;

/** The canonical key of a Control UI chat ("main" → "agent:main:main"), its agent, and a short id for files. */
export function chatTarget(sessionKey) {
  const raw = String(sessionKey ?? "").trim();
  if (!raw || raw.length > 512) return null;
  const key = raw.startsWith("agent:") ? raw : `agent:main:${raw}`;
  const agentId = key.split(":")[1] || "main";
  return { sessionKey: key, agentId, id: createHash("sha256").update(key).digest("hex").slice(0, 12) };
}

/** A member as the Gateway accepts it, or null: { kind, id, name }. */
export function parseMember(value) {
  if (!value || typeof value !== "object") return null;
  const kind = MEMBER_KINDS.includes(value.kind) ? value.kind : null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!kind || !MEMBER_ID[kind].test(id)) return null;
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 64) : defaultName(kind, id);
  return { kind, id, name, key: `${kind}:${id}` };
}

export function defaultName(kind, id) {
  if (kind === "model") return id.split("/").pop();
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Names a member is addressed by: its name, its first word, its id (a model's id without the provider). */
function handles(member) {
  const short = member.kind === "model" ? member.id.split("/").pop() : member.id;
  return [member.name, member.name.split(/\s+/u)[0], short, member.id].map((h) => h.toLowerCase());
}

/** Members @mentioned in the text, in order, once each. */
export function parseChatMentions(text, members) {
  const found = [];
  for (const m of String(text ?? "").matchAll(/(?:^|[\s(])@([\p{L}\p{N}_.:/-]+(?: [\p{L}\p{N}_.-]+)?)/gu)) {
    const said = m[1].toLowerCase().replace(/[.,:;!?]+$/u, "");
    const first = said.split(" ")[0].replace(/[.,:;!?]+$/u, "");
    const member = members.find((c) => handles(c).includes(said)) ?? members.find((c) => handles(c).includes(first));
    if (member && !found.includes(member)) found.push(member);
  }
  return found;
}

function messageText(message) {
  const c = message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "";
  return typeof text === "string" ? text.trim() : "";
}

/** Who wrote a chat row, as other participants see it: "User", a member's name, or the reply's model. */
export function speakerOf(message) {
  if (message?.role === "user") return "User";
  const participant = message?.__openclaw?.participant;
  if (participant?.name) return participant.name;
  if (message?.provider === "acp" && message.model) return defaultName("acp", message.model);
  if (typeof message?.model === "string" && message.model && message.provider !== "openclaw") return message.model.split("/").pop();
  return "Assistant";
}

/**
 * What a member gets for its turn: who is in the chat (first turn only) and every message since its last turn,
 * each with its speaker, ending with the message that asks it. Its own earlier replies are in its own session.
 */
export function memberTurnMessage({ messages, member, members, since = 0, asked }) {
  const rows = (messages ?? []).filter((m) => (m?.role === "user" || m?.role === "assistant")
    && Number(m.timestamp ?? 0) > since && m?.__openclaw?.participant?.key !== member.key
    && !m?.__openclaw?.contextFreeCommand && messageText(m) && !(m.role === "user" && messageText(m).startsWith("/"))
    && !(m.role === "user" && messageText(m) === String(asked).trim()));        // the question itself ends the message
  const lines = rows.slice(-MAX_CONTEXT_MESSAGES).map((m) => `[${speakerOf(m)}]: ${messageText(m).slice(0, MAX_CONTEXT_CHARS)}`);
  const others = [...members.filter((m) => m.key !== member.key).map((m) => m.name), "the chat's own assistant"];
  const head = since === 0
    ? [`You are ${member.name} in a group chat with the user and: ${others.join(", ")}.`,
      "Messages are shown as [Speaker]: text. Answer the last message, which is addressed to you, from your role and",
      "knowledge; do not repeat what others said; address others by name when you answer them; be concise.", ""]
    : ["New messages in the group chat since your last reply:", ""];
  return [...head, ...lines, `[User]: ${asked}`].join("\n");
}

/** The last assistant text in session messages (string content or text parts). */
export function lastAssistantText(messages) {
  for (const m of [...(messages || [])].reverse()) {
    if (m?.role === "assistant" && messageText(m)) return messageText(m);
  }
  return "";
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** The provider and model a member's reply is recorded under, so the chat names it and models replay it. */
export function replyAuthor(member, runtime) {
  if (member.kind === "acp") return { provider: "acp", model: member.id };
  if (member.kind === "model") {
    const slash = member.id.indexOf("/");
    return { provider: member.id.slice(0, slash), model: member.id.slice(slash + 1) };
  }
  return runtime?.provider && runtime?.model
    ? { provider: runtime.provider, model: runtime.model }
    : { provider: "openclaw-agent", model: member.id };
}

export function userRow({ text, at, turnId, owner = false }) {
  // The owner's message reads like any message they send: same provenance and sender identity as chat.send writes.
  const sender = owner ? { senderIsOwner: true, senderId: "gateway-owner", senderIdentity: { type: "profile", id: "gateway-owner" } } : {};
  return { role: "user", content: [{ type: "text", text }], timestamp: at, idempotencyKey: `aiwb-group:${turnId}:user`,
    provenance: { kind: "external_user" }, __openclaw: sender };
}

/** A member's reply (or the reason it gave none) as a chat row carrying the member as its participant. */
export function replyRow({ member, text, error, at, turnId, runtime }) {
  return {
    role: "assistant",
    content: [{ type: "text", text: error ? `${member.name} did not answer: ${error}` : text }],
    timestamp: at,
    api: "openai-responses",
    ...replyAuthor(member, runtime),
    usage: ZERO_USAGE,
    stopReason: error ? "error" : "stop",
    ...(error ? { errorMessage: error } : {}),
    idempotencyKey: `aiwb-group:${turnId}`,
    __openclaw: { participant: { kind: member.kind, id: member.id, key: member.key, name: member.name } },
  };
}

/** The one-shot note for the chat's own model after a member replied. */
export function hostNote(member) {
  const what = member.kind === "acp" ? "an ACP agent" : member.kind === "model" ? `the model ${member.id}` : "another agent";
  return `[System: This chat is a group chat. ${member.name} (${what}) answered the user's last message; its reply is in ` +
    "the history. Replies are written by whoever answered; do not claim another participant's reply as your own.]";
}
