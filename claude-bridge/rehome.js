// Re-homing chats adopted into the default agent before their folder had an agent of its own.
//
// Adoption gives a tree chat to projects[<folder>] or, without a project, to defaultAgent (adopt.js). A chat
// adopted while its folder had no agent yet (the folder was not in `projects`, or its agent was not created)
// stays with the default agent after the folder gets one: the registry keeps it from being adopted again.
// Once the folder's agent exists:
//   - a chat nobody has written in since adoption ("untouched", see isUntouched) moves there by itself, in the
//     adoption pass: the default agent's session is archived, the same Claude Code chat is imported into the
//     folder's agent with its full history and bound there, as adoption does;
//   - a chat used in the default agent stays. The Control UI offers "Move to project <folder>…" in its menu
//     (dist/control-ui/bridge.js, from offers()), which is the drag-and-drop move (move.js,
//     sessions.catalog.move): the conversation the session continues now, with the turns made there.
// Both keep the title, the pin and the read state, and record the chat in the registry under the new
// session, so adoption never brings back a second copy. Archived and deleted sessions are left alone.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { LEGACY_ID, PLUGIN_ID } from "./legacy.js";

const IMPORT_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_ROW = "s:";

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
const writeJson = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };

/** Source chat mark of an adopted session; sessions adopted before the rename carry it under the old id. */
export const sourceMark = (entry) => entry?.pluginExtensions?.[PLUGIN_ID]?.sourceThreadId ?? entry?.pluginExtensions?.[LEGACY_ID]?.sourceThreadId;

/** What a move takes along to the new session besides the history: the title, the pin and the read state.
 *  The title given at import is displayName; a rename in OpenClaw sets label. */
export const CARRIED = ["label", "pinnedAt", "lastReadAt", "markedUnreadAt"];
export function carryOf(entry) {
  const out = {};
  for (const k of CARRIED) if (entry?.[k] !== undefined && entry?.[k] !== null) out[k] = entry[k];
  return out;
}

/**
 * Turn traces in a session entry. A user or channel message stamps lastInteractionAt; the first turn of a
 * session generation sessionStartedAt and systemSent; a run lastRunId; a completed run lastActivityAt; /new and
 * /reset rotate the sessionId and keep previousSessionId. An import writes none of them, and neither do
 * rename, pin, read, share, archive or the activity summary.
 */
export const TURN_TRACES = ["lastInteractionAt", "lastActivityAt", "sessionStartedAt", "systemSent", "lastRunId", "previousSessionId"];

/**
 * Whether nobody has written in an adopted chat since adoption: no turn traces, and the Claude CLI binding is
 * still the one adoption wrote (the source chat itself; the first Claude CLI turn moves it to its fork).
 */
export function isUntouched(entry, threadId = sourceMark(entry)) {
  if (!threadId) return false;
  if (TURN_TRACES.some((k) => entry?.[k] !== undefined && entry?.[k] !== null && entry?.[k] !== false)) return false;
  return entry?.cliSessionBindings?.["claude-cli"]?.sessionId === threadId;
}

/** Agent ids the config defines (agents.entries as an object or a list, or agents.list); none means main only. */
export function configuredAgents(config) {
  const agents = config?.agents, ids = new Set();
  const add = (id) => { if (typeof id === "string" && id.trim()) ids.add(id.trim().toLowerCase()); };
  for (const v of [agents?.entries, agents?.list]) {
    if (Array.isArray(v)) for (const e of v) add(e?.id);
    else if (v && typeof v === "object") for (const [k, e] of Object.entries(v)) add(e?.id ?? k);
  }
  if (!ids.size) ids.add("main");
  return ids;
}

/**
 * Chats of the default agent whose folder now has an agent: { auto, offers }. `auto` are the untouched
 * ones, moved by the pass; `offers` are all of them (an untouched chat the pass could not move keeps the
 * menu item too). Each: { sessionKey, agentId, threadId, folder, targetAgentId, cwd, untouched, entry }.
 *
 *   entries — [{ agentId, sessionKey, entry }] of the project agents; projects — folder → agent;
 *   agentExists(id) — whether the agent is configured; running(sessionKey) — a turn in progress.
 */
export function rehomePlan({ entries, defaultAgent = "main", projects = {}, agentExists = () => true, running = () => false }) {
  const offers = [];
  for (const { agentId, sessionKey, entry } of entries) {
    if (agentId !== defaultAgent || entry?.archivedAt !== undefined || !sessionKey?.startsWith(`agent:${agentId}:catalog-import:`)) continue;
    const threadId = sourceMark(entry);
    if (!threadId || typeof entry.spawnedCwd !== "string" || !entry.spawnedCwd) continue;
    const folder = path.basename(entry.spawnedCwd);
    const targetAgentId = Object.hasOwn(projects, folder) ? projects[folder] : undefined;
    if (!targetAgentId || targetAgentId === agentId || !agentExists(targetAgentId) || running(sessionKey)) continue;
    offers.push({ sessionKey, agentId, threadId, folder, targetAgentId, cwd: entry.spawnedCwd, untouched: isUntouched(entry, threadId), entry });
  }
  return { auto: offers.filter((o) => o.untouched), offers };
}

/**
 * Moves one untouched chat (an `auto` item of rehomePlan) to its folder's agent.
 *
 *   request(method, params, options) — a Gateway method; bind({ agentId, sessionKey, threadId, cwd, carry })
 *   → { sessionId, archived } (binds the import session, always rewriting);
 *   setArchived({ agentId, sessionKey, archived, expect }) — archives or restores a session in its agent's
 *   store; `expect(entry)` throws if the session changed (index.js: the plugin runtime's session store, since
 *   the Gateway lets a plugin patch only sessions it created, and a catalog import is not one); registryFile — adopted chats;
 *   related — every chat bound to the old session (they stay adopted, by the new one).
 * The old session is archived first, only if it is still untouched; otherwise nothing changes and the chat
 * keeps the menu item. If the import or the binding fails, the old session is restored. Returns { from, sessionKey, threadId } (threadId: the new tree row).
 */
export async function rehomeChat({ item, request, bind, setArchived, registryFile, related = [], log = () => {} }) {
  const { sessionKey: from, agentId: fromAgent, entry, threadId, targetAgentId: agentId, cwd } = item;
  // Checked again in the same store write: a turn may have started since the plan.
  const expect = (current) => {
    if (!current || current.archivedAt !== undefined) throw new Error("the session is gone or archived");
    if (current.sessionId !== entry?.sessionId || !isUntouched(current, threadId)) throw new Error("the chat was used since the plan");
  };
  await setArchived({ agentId: fromAgent, sessionKey: from, archived: true, expect });
  let sessionKey;
  try {
    const title = entry?.displayName || entry?.label;
    const imp = await request("sessions.catalog.import",
      { catalogId: "claude", hostId: "gateway:local", threadId, agentId, ...(title ? { displayName: title } : {}) }, { timeoutMs: IMPORT_TIMEOUT_MS });
    sessionKey = imp?.sessionKey;
    if (!sessionKey) throw new Error("import returned no session");
    const bound = await bind({ agentId, sessionKey, threadId, cwd, carry: carryOf(entry) });
    if (bound?.archived) await setArchived({ agentId, sessionKey, archived: false });
  } catch (e) {
    await setArchived({ agentId: fromAgent, sessionKey: from, archived: false })
      .catch((u) => log(`restore ${from}: ${u?.message || u}`));
    throw e;
  }
  // The import creates a draft (a ghost in the sidebar); the adopted chat was shared.
  await request("session.visibility.set", { sessionKey, visibility: "shared" })
    .catch((e) => log(`share ${sessionKey}: ${e?.message || e}`));
  const registry = readJson(registryFile);
  for (const id of new Set([threadId, ...related])) registry[id] = { agentId, sessionKey };
  writeJson(registryFile, registry);
  return { from, sessionKey, threadId: `${SESSION_ROW}${sessionKey}` };
}

/** Moves every `auto` chat of a plan; a failure is reported and the chat stays, with the menu item. */
export async function rehomeOnce({ plan, relatedOf = () => [], ...rest }) {
  const result = { moved: [], failed: 0, errors: [] };
  for (const item of plan.auto) {
    try {
      result.moved.push(await rehomeChat({ ...rest, item, related: relatedOf(item.entry) }));
    } catch (e) {
      result.failed++;
      result.errors.push(`${item.folder} · ${item.entry?.displayName || item.sessionKey}: ${e?.message || e}`);
    }
  }
  return result;
}
