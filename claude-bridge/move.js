// Moving a chat of the "Projects" tree to another project folder (OpenClaw fork: sessions.catalog.move),
// as Claude Desktop moves a chat between projects: afterwards the chat belongs to the target project's
// agent (its instructions, files and memory) and keeps its history.
//
// OpenClaw cannot hand a session to another agent, and a Claude CLI chat is resumed only from the
// Claude Code project folder of its working folder (~/.claude/projects/<encoded cwd>/<id>.jsonl). So a
// move is an adoption into the target agent:
//   1. the chat's Claude Code conversation (the one its session continues now, or the tree chat itself)
//      is copied into the Claude Code project folder of the target working folder as a new conversation:
//      a new id, the records' sessionId rewritten to it, the source file unchanged. A new id because the
//      conversations OpenClaw runs (entrypoint sdk-cli: every chat started in OpenClaw, and every adopted
//      chat after its first turn) are hidden from the Claude catalog by claude-code-catalog.mjs (marked
//      archived in the tree metadata), and the catalog cannot import a hidden conversation;
//   2. the copy is imported into the target agent with its full history (sessions.catalog.import, "claude");
//   3. the import session is bound to the copy in the target working folder: the next turn resumes it
//      there and continues the copy itself (no fork: the copy belongs to this session alone);
//   4. once the import session is shared (no longer a draft), the session the chat had in the source agent
//      is archived (not deleted; "Restore" brings it back) by the Gateway, as the operator who moved the chat
//      (the move result names it). Not shared yet: the source stays, and both are done on a later pass.
// A chat not adopted yet has no source session: it is adopted straight into the target agent.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readJson, writeJson } from "./state-file.js";
import path from "node:path";
import { carryOf } from "./rehome.js";
import { isCronKey, isMainKey } from "./session-keys.js";
import { addPending, shareSession } from "./visibility.js";

const IMPORT_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_ROW = "s:";

/** Claude Code project folder of a working folder: every character but ASCII letters and digits is "-". */
export const claudeProjectDir = (projectsDir, cwd) => path.join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, "-"));

const fail = (message, code = "INVALID_REQUEST") => Object.assign(new Error(message), { code });

/** Copies a Claude Code transcript as conversation `to`: records of conversation `from` get the new id. */
export function copyConversation(file, target, from, to) {
  const lines = readFileSync(file, "utf8").split("\n").map((line) => {
    if (!line.includes(from)) return line;
    try {
      const r = JSON.parse(line);
      if (r?.sessionId !== from) return line;
      r.sessionId = to;
      return JSON.stringify(r);
    } catch { return line; }
  });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, lines.join("\n"), { flag: "wx" });
}

/**
 * Moves one tree row to the folder `group`.
 *
 *   row — the catalog row: { threadId, sessionKey?, name, customGroup, cwd? };
 *   source — for a session row, { agentId, sessionKey, entry } of its session;
 *   claudeChat(entry) → { claudeId, chatId, related[] } — the Claude Code conversation the session
 *     continues, the tree chat it came from, and every chat bound to it (index.js knows the marks);
 *   request(method, params, options) — a Gateway method; bind({ agentId, sessionKey, threadId,
 *   sourceThreadId, cwd }) → { sessionId, archived } (binds the import session, always rewriting);
 *   transcriptFile(id) → path of the Claude Code transcript, or null;
 *   folderCwd(group) → working folder of a tree folder; agentOf(group) → its agent;
 *   running(sessionKey) → whether a turn is in progress; registryFile — adopted chats (adopt.js);
 *   newId() → id of the copied conversation (a UUID, as Claude Code names its conversations);
 *   pendingFile — sessions not shared yet (visibility.js), retried with the source's archive later;
 *   callerShares — the Gateway shares the new session as the operator who moved the chat (OpenClaw fork:
 *     sessions.catalog.move passes it). OpenClaw 2026.11.6 checks the operator's authority when sharing,
 *     which a plugin request made inside the operator's request does not carry, so the plugin's own
 *     share fails there. The move then returns `share` and the Gateway archives the source after it.
 * Returns { threadId, sessionKey } of the row in the target folder, `archive` — the source session the
 * Gateway archives, only when the new session is shared — and `warning` when it is not (shown in the UI).
 */
export async function moveChat({ row, source, group, claudeChat, request, bind, transcriptFile, folderCwd, agentOf,
  projectsDir, running = () => false, registryFile, pendingFile, newId = randomUUID, now = Date.now, shareDelays, sleep,
  callerShares = false, log = () => {}, warn = log }) {
  if (!row) throw fail("no such chat in the tree", "NOT_FOUND");
  if (row.customGroup === group) throw fail(`the chat is already in ${group}`);
  if (source && isMainKey(source.sessionKey)) throw fail("the main chat of a project stays with its agent");
  if (source && isCronKey(source.sessionKey)) throw fail("an automation runs in its agent; change the agent of the job instead");
  if (source && running(source.sessionKey)) throw fail("the chat is answering now; move it when the turn ends");
  const cwd = folderCwd(group);
  if (!cwd || !existsSync(cwd)) throw fail(`no working folder for ${group}`);
  const agentId = agentOf(group);

  const { claudeId, chatId, related = [] } = source ? claudeChat(source.entry) : { claudeId: row.threadId, chatId: row.threadId };
  if (!claudeId) throw fail("this chat has no Claude Code conversation to move");
  const file = transcriptFile(claudeId);
  if (!file) throw fail(`no Claude Code transcript ${claudeId}`, "NOT_FOUND");

  // 1. A copy of the conversation where Claude CLI of the target folder finds it, under a new id.
  const copyId = newId();
  copyConversation(file, path.join(claudeProjectDir(projectsDir, cwd), `${copyId}.jsonl`), claudeId, copyId);

  // 2. History into the target agent.
  const copy = path.join(claudeProjectDir(projectsDir, cwd), `${copyId}.jsonl`);
  let sessionKey;
  try {
    const imp = await request("sessions.catalog.import",
      { catalogId: "claude", hostId: "gateway:local", threadId: copyId, agentId, displayName: row.name }, { timeoutMs: IMPORT_TIMEOUT_MS });
    sessionKey = imp?.sessionKey;
    if (!sessionKey) throw fail("import returned no session", "UNAVAILABLE");
  } catch (e) {
    rmSync(copy, { force: true });   // nothing refers to the copy yet
    throw e;
  }

  // 3. Continue it in the target folder, with the source session's title, pin and read state.
  const carry = carryOf(source?.entry);
  const bound = await bind({ agentId, sessionKey, threadId: copyId, sourceThreadId: chatId, cwd, ...(Object.keys(carry).length ? { carry } : {}) });
  if (bound.archived) {
    await request("sessions.patch", { key: sessionKey, expectedSessionId: bound.sessionId, archived: false })
      .catch((e) => log(`unarchive ${sessionKey}: ${e?.message || e}`));
  }
  // An imported session starts as a draft (the ghost mark in the sidebar) until it is shared. Right after the
  // import the Gateway may not have its storage ready: retried with backoff (visibility.js).
  if (callerShares && pendingFile) {
    // Should the Gateway's share fail, the next adoption pass shares it (idempotent when it succeeded).
    addPending(pendingFile, { sessionKey, agentId, error: "shared by the Gateway as the caller", now: now() });
  }
  const shared = callerShares
    ? { ok: true }
    : await shareSession({ request, sessionKey, ...(shareDelays ? { delays: shareDelays } : {}), ...(sleep ? { sleep } : {}) });

  // 4. The source session goes to the archive, only once the copy is shared: never two diverging copies with
  // one hidden. The Gateway does it (OpenClaw fork, sessions.catalog.move) as the operator who moved the chat:
  // a plugin may patch only sessions it created.
  const sourceArchive = source && source.sessionKey !== sessionKey
    ? { key: source.sessionKey, ...(source.entry?.sessionId ? { expectedSessionId: source.entry.sessionId } : {}) }
    : undefined;
  let archive = sourceArchive, warning;
  if (!shared.ok) {
    archive = undefined;
    if (shared.retryable && pendingFile) {
      // Shared on a later adoption pass, which then archives the source (index.js, the bridge's session store).
      const movedAt = now();
      addPending(pendingFile, { sessionKey, agentId, error: shared.error, now: movedAt,
        ...(sourceArchive ? { archive: { agentId: source.agentId, ...sourceArchive, movedAt } } : {}) });
      warn(`moved chat ${sessionKey} is not shared yet (session.visibility.set failed ${shared.attempts} times: ${shared.error}); `
        + `retried on the next adoption pass${sourceArchive ? `, the source chat ${sourceArchive.key} is archived after that` : ""}`);
      warning = `Moved, but the new chat is still a draft (${shared.error}). It is shared on the next adoption pass, within 10 minutes`
        + (sourceArchive ? "; the old chat stays until then." : ".");
    } else {
      warn(`moved chat ${sessionKey} stays a draft: session.visibility.set failed ${shared.attempts} times: ${shared.error}`
        + (sourceArchive ? `; the source chat ${sourceArchive.key} is kept` : ""));
      warning = `Moved, but the new chat stays a draft (${shared.error})`
        + (sourceArchive ? "; the old chat is kept. Share the new one or archive the old one by hand." : ".");
    }
  }

  // The chat and everything bound to the source session stay adopted: the tree must not show them again
  // in the old folder, and adoption must not bring them back to the old agent.
  const registry = readJson(registryFile);
  for (const id of new Set([chatId, claudeId, copyId, ...related])) registry[id] = { agentId, sessionKey };
  writeJson(registryFile, registry);
  return { threadId: `${SESSION_ROW}${sessionKey}`, sessionKey, ...(callerShares ? { share: { key: sessionKey } } : {}),
    ...(archive ? { archive } : {}), ...(warning ? { warning } : {}) };
}
