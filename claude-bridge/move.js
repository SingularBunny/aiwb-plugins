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
//   4. the session the chat had in the source agent is archived (not deleted; "Restore" brings it back) by
//      the Gateway, as the operator who moved the chat (the move result names it).
// A chat not adopted yet has no source session: it is adopted straight into the target agent.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isCronKey, isMainKey } from "./session-keys.js";

const IMPORT_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_ROW = "s:";
const SHARE_ATTEMPTS = 3;
const SHARE_RETRY_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Claude Code project folder of a working folder: every character but ASCII letters and digits is "-". */
export const claudeProjectDir = (projectsDir, cwd) => path.join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, "-"));

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
const writeJson = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
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
 *   newId() → id of the copied conversation (a UUID, as Claude Code names its conversations).
 * Returns { threadId, sessionKey } of the row in the target folder, and `archive` — the source session
 * the Gateway archives.
 */
export async function moveChat({ row, source, group, claudeChat, request, bind, transcriptFile, folderCwd, agentOf,
  projectsDir, running = () => false, registryFile, newId = randomUUID, log = () => {}, warn = log }) {
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

  // 3. Continue it in the target folder.
  const bound = await bind({ agentId, sessionKey, threadId: copyId, sourceThreadId: chatId, cwd });
  if (bound.archived) {
    await request("sessions.patch", { key: sessionKey, expectedSessionId: bound.sessionId, archived: false })
      .catch((e) => log(`unarchive ${sessionKey}: ${e?.message || e}`));
  }
  // An imported session starts as a draft (the ghost mark in the sidebar) until it is shared. A failed
  // share left a moved chat as a draft once, with the error visible only in debug logs: retry, then warn.
  for (let attempt = 1; ; attempt++) {
    try {
      await request("session.visibility.set", { sessionKey, visibility: "shared" });
      break;
    } catch (e) {
      if (attempt >= SHARE_ATTEMPTS) {
        warn(`moved chat ${sessionKey} stays a draft: session.visibility.set failed ${attempt} times: ${e?.message || e}`);
        break;
      }
      await sleep(SHARE_RETRY_MS * attempt);
    }
  }

  // 4. The source session goes to the archive. The Gateway does it (OpenClaw fork, sessions.catalog.move)
  // as the operator who moved the chat: a plugin may patch only sessions it created.
  const archive = source && source.sessionKey !== sessionKey
    ? { key: source.sessionKey, ...(source.entry?.sessionId ? { expectedSessionId: source.entry.sessionId } : {}) }
    : undefined;

  // The chat and everything bound to the source session stay adopted: the tree must not show them again
  // in the old folder, and adoption must not bring them back to the old agent.
  const registry = readJson(registryFile);
  for (const id of new Set([chatId, claudeId, copyId, ...related])) registry[id] = { agentId, sessionKey };
  writeJson(registryFile, registry);
  return { threadId: `${SESSION_ROW}${sessionKey}`, sessionKey, ...(archive ? { archive } : {}) };
}
