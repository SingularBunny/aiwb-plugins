// Group chat of agents (research R-59 of the project; the pattern of LobeHub's group chat and AutoGen's GroupChat):
// one shared transcript, and before every agent turn a choice of who speaks next. An @mention of an agent wins;
// otherwise a manager model reads the members and the transcript and names the next agent, or the user when the
// question is answered. At most `maxTurns` agent turns follow one user message, so a group does not talk forever.
// Kept apart from the plugin so it is testable without the OpenClaw SDK.

/** Agents @mentioned in the text, in order, once each: by id ("@garden") or by name ("@Garden helper"). */
export function parseMentions(text, members) {
  const found = [];
  const lower = String(text ?? "").toLowerCase();
  const at = [...lower.matchAll(/@([\p{L}\p{N}_.-]+(?: [\p{L}\p{N}_.-]+)?)/gu)];
  for (const m of at) {
    const said = m[1];
    const agent = members.find((a) => a.id.toLowerCase() === said || a.id.toLowerCase() === said.split(" ")[0]
      || (a.name && (a.name.toLowerCase() === said || a.name.toLowerCase() === said.split(" ")[0])));
    if (agent && !found.includes(agent.id)) found.push(agent.id);
  }
  return found;
}

const who = (entry, members) => (entry.role === "user" ? "User" : members.find((a) => a.id === entry.agentId)?.name || entry.agentId);

/**
 * What an agent gets for its turn: who is in the group (first turn only) and every message since its own last one,
 * each with its speaker. Its own earlier replies are already in its session.
 */
export function turnMessage({ transcript, members, agentId, since }) {
  const me = members.find((a) => a.id === agentId);
  const others = members.filter((a) => a.id !== agentId).map((a) => a.name || a.id);
  const lines = transcript.slice(since).filter((e) => !(e.role === "agent" && e.agentId === agentId))
    .map((e) => `[${who(e, members)}]: ${e.text}`);
  const head = since === 0
    ? [`You are ${me?.name || agentId} in a group chat with the user and: ${others.join(", ") || "no other agents"}.`,
      "Messages are shown as [Speaker]: text. Add your own contribution from your role and knowledge; do not repeat",
      "what others said; address others by name when you answer them; be concise.", ""]
    : ["New messages in the group since your last reply:", ""];
  return [...head, ...lines].join("\n");
}

/** The manager prompt: the members with descriptions, the recent transcript, and the answer format. */
export function managerPrompt({ transcript, members, lastSpeaker, turnsLeft }) {
  const recent = transcript.slice(-12).map((e) => `[${who(e, members)}]: ${String(e.text).slice(0, 1200)}`);
  return [
    "You coordinate a group chat between a user and several agents. Decide who speaks next.",
    "",
    "Agents:",
    ...members.map((a) => `- ${a.id}: ${a.name || a.id}${a.description ? ` — ${a.description}` : ""}`),
    "",
    "Conversation so far (most recent last):",
    ...recent,
    "",
    `Agent turns left before the user speaks again: ${turnsLeft}.`,
    "Pick the one agent whose role best fits what is still open. Do not pick the agent that just spoke" +
      (lastSpeaker ? ` (${lastSpeaker})` : "") + " unless someone asked it directly.",
    "Pick USER when the user's question is answered, when an agent asked the user something, or when nothing useful is left to add.",
    'Answer with exactly one line: "NEXT: <agent id>" or "NEXT: USER".',
  ].join("\n");
}

/** The agent id the manager named, "USER", or null when the answer cannot be read. */
export function parseManagerChoice(text, members) {
  const m = /NEXT:\s*@?([\p{L}\p{N}_.-]+)/iu.exec(String(text ?? ""));
  if (!m) return null;
  const said = m[1].toLowerCase();
  if (said === "user") return "USER";
  return members.find((a) => a.id.toLowerCase() === said || (a.name || "").toLowerCase() === said)?.id ?? null;
}

/** The last assistant text in session messages (string content or text parts). */
export function lastAssistantText(messages) {
  for (const m of [...(messages || [])].reverse()) {
    if (m?.role !== "assistant") continue;
    const c = m.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "";
    if (text.trim()) return text.trim();
  }
  return "";
}

/**
 * Run the agent turns that follow one user message. pickByManager() → agent id | "USER" | null; runAgent(id) → reply
 * text (throws on failure); onTurn(entry) is called after every turn. Mentioned agents speak first, in order; then
 * the manager picks until it names the user, cannot answer, or the limit is reached.
 */
export async function runRound({ mentions, maxTurns, pickByManager, runAgent, onTurn, signal }) {
  const queue = [...mentions];
  let turns = 0;
  let last = null;
  while (turns < maxTurns) {
    signal?.throwIfAborted?.();
    const next = queue.length ? queue.shift() : await pickByManager(last, maxTurns - turns);
    if (!next || next === "USER") break;
    let entry;
    try {
      entry = { role: "agent", agentId: next, text: await runAgent(next), at: Date.now() };
    } catch (error) {
      entry = { role: "agent", agentId: next, text: "", error: String(error?.message || error).slice(0, 300), at: Date.now() };
    }
    await onTurn(entry);
    turns += 1;
    last = next;
  }
  return turns;
}
