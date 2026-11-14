// Continuing an OpenClaw chat in Claude Code in a terminal, and back. A session bound to Claude CLI
// (cliSessionBindings["claude-cli"]) is an ordinary Claude Code conversation in
// ~/.claude/projects/<cwd as slug>/<id>.jsonl: `claude --resume <id>` in its working folder continues it
// where OpenClaw stopped, also when OpenClaw does not run. Claude Code's /resume list hides conversations
// started by OpenClaw (entrypoint sdk-cli), and shows the chat they were imported from under the same title,
// so the commands are kept in a plain file (CHATS_FILE) and offered from the chat's menu.
// While Claude Code has the conversation open in a terminal, OpenClaw refuses its turns: both would append
// to the same file. Pure helpers, kept apart from the plugin wiring in index.js.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";

export const CHATS_FILE = "claude-chats.md";
/** A terminal record this recent counts as the terminal still working, when its process is not visible. */
export const RECENT_TERMINAL_MS = 2 * 60 * 1000;

/** Claude Code's project folder name for a working folder: every character but ASCII letters and digits → "-". */
export const projectSlug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/** The conversation file, or null; looked up in other project folders when the slug guess misses. */
export function transcriptPath(claudeProjectsDir, cwd, sessionId) {
  const guess = path.join(claudeProjectsDir, projectSlug(cwd), `${sessionId}.jsonl`);
  if (existsSync(guess)) return guess;
  let dirs = [];
  try { dirs = readdirSync(claudeProjectsDir); } catch { return null; }
  for (const d of dirs) {
    const file = path.join(claudeProjectsDir, d, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

const quote = (s) => (/^[A-Za-z0-9_./~-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/** The shell command that continues the conversation in Claude Code. */
export const terminalCommand = (cwd, sessionId) => `cd ${quote(cwd)} && claude --resume ${sessionId}`;

/** What a session continues in Claude Code: { sessionId, cwd } or null for a session not bound to Claude CLI. */
export function boundConversation(entry) {
  const sessionId = entry?.cliSessionBindings?.["claude-cli"]?.sessionId;
  const cwd = entry?.spawnedCwd;
  return sessionId && cwd && path.isAbsolute(cwd) ? { sessionId, cwd } : null;
}

/** The last records of a file, read from its end (conversation files reach tens of MB). */
function lastRecords(file, bytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const length = Math.min(bytes, size);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8").split("\n").slice(size > length ? 1 : 0).flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
    });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Interactive Claude Code processes with this conversation open: `claude --resume <id>` without --print
 *  (OpenClaw's own processes run with -p / --print and stream-json input). */
export function terminalProcesses(sessionId, procDir = "/proc") {
  let pids = [];
  try { pids = readdirSync(procDir).filter((p) => /^\d+$/.test(p)); } catch { return []; }
  const found = [];
  for (const pid of pids) {
    let argv;
    try { argv = readFileSync(path.join(procDir, pid, "cmdline"), "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (!argv.includes(sessionId) || !argv.some((a) => /(^|\/)claude(\.exe)?$/.test(a) || /claude-code/.test(a))) continue;
    if (argv.some((a) => a === "-p" || a === "--print" || a.startsWith("--input-format") || a.startsWith("--output-format"))) continue;
    found.push(Number(pid));
  }
  return found;
}

/** Whether Claude Code in a terminal is working on the conversation: its process is running, or its last
 *  record was written interactively (entrypoint cli) within RECENT_TERMINAL_MS. */
export function terminalActivity({ sessionId, transcript, now = Date.now(), procDir }) {
  const pids = terminalProcesses(sessionId, procDir);
  if (pids.length) return { active: true, why: `claude process ${pids.join(", ")}` };
  if (!transcript) return { active: false };
  const last = lastRecords(transcript).filter((r) => r.entrypoint).at(-1);
  const at = last?.timestamp ? Date.parse(last.timestamp) : NaN;
  if (last?.entrypoint === "cli" && now - at < RECENT_TERMINAL_MS) return { active: true, why: "a terminal turn just now" };
  return { active: false };
}

export const TERMINAL_BUSY_REPLY = (command) => [
  "This chat is open in Claude Code in a terminal, so OpenClaw does not continue it now: both would write to the same conversation.",
  "Finish there (leave Claude Code), then send your message again. The turns made in the terminal will be in this chat.",
  `Terminal: \`${command}\``,
].join("\n\n");

/** The chats file: every chat that continues a Claude Code conversation, by project folder, newest first,
 *  with the command that opens it in a terminal. rows: { title, folder, cwd, sessionId, updatedAt }. */
export function chatsMarkdown(rows, now = new Date()) {
  const byFolder = new Map();
  for (const r of [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
    if (!byFolder.has(r.folder)) byFolder.set(r.folder, []);
    byFolder.get(r.folder).push(r);
  }
  const cell = (s) => String(s ?? "").replaceAll("|", "/").replaceAll("\n", " ");
  const lines = ["# OpenClaw chats in Claude Code", "",
    "Each chat below is a Claude Code conversation. Run its command in a terminal to continue it where OpenClaw",
    "stopped — also when OpenClaw is not running. Claude Code's /resume list does not show these conversations.",
    `Updated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC by aiwb-claude-bridge.`];
  for (const [folder, list] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("", `## ${folder}`, "", "| Chat | Last turn | Command |", "|---|---|---|");
    for (const r of list) {
      const when = r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0, 16).replace("T", " ") : "";
      lines.push(`| ${cell(r.title)} | ${when} | \`${terminalCommand(r.cwd, r.sessionId)}\` |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Writes the file only when its text changed (the timestamp line aside); atomic. */
export function writeChatsFile(file, text) {
  const body = (t) => t.replace(/^Updated .*$/m, "");
  try { if (body(readFileSync(file, "utf8")) === body(text)) return false; } catch { /* no file yet */ }
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
  return true;
}
