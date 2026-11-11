// Shared memory text for the system prompt, kept apart from the plugin so it is testable without the OpenClaw SDK.
import { readFileSync } from "node:fs";
import path from "node:path";

const MAX_BYTES = 16 * 1024;

/** File text or null; over the limit it is truncated with a marker. */
function readSmall(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  text = text.trim();
  if (!text) return null;
  return Buffer.byteLength(text) > MAX_BYTES ? `${Buffer.from(text).subarray(0, MAX_BYTES).toString("utf8")}\n…[truncated]` : text;
}

/** System prompt addition: shared USER.md, the index, the write rule and the notification rule. */
export function sharedMemoryContext(dir) {
  const user = readSmall(path.join(dir, "USER.md"));
  const index = readSmall(path.join(dir, "MEMORY.md"));
  return [
    "# Shared memory (for all projects)",
    `Shared memory folder: ${dir}. It is one for all projects and all agents, like Claude Desktop memory.`,
    "Save here, not in your own memory, facts about the user (who they are, preferences, how to work with them) and rules",
    `that apply in all projects: one file per fact in ${path.join(dir, "memory")}/<name>.md and a link line in ${path.join(dir, "MEMORY.md")}.`,
    "Facts about a single project go in your own memory. For details of facts listed in the index, search memory (memory_search) or read the file.",
    ...(user ? ["", "## About the user (USER.md)", user] : []),
    ...(index ? ["", "## Shared memory index (MEMORY.md)", index] : []),
    "", ...EXEC_NOTICE_RULE,
  ].join("\n");
}

/**
 * Knowledge base folders of this agent: the folders for every agent ("*") and its own (config key = agent id).
 * Returns the system prompt section, or null when the agent has none.
 */
export function knowledgeContext(knowledge, agentId) {
  const dirs = [...new Set([...(knowledge?.["*"] ?? []), ...((agentId && knowledge?.[agentId]) || [])])];
  if (!dirs.length) return null;
  return [
    "# Knowledge base",
    `Knowledge base folders: ${dirs.join(", ")}.`,
    "Look things up there before answering from general knowledge: memory search (memory_search) finds the Markdown notes, or read the files.",
    "You may add to it: save new notes, summaries and conclusions there as Markdown files (.md), following the folder's existing",
    "structure, names and links; edit an existing note rather than creating a duplicate. Keep memory facts (about the user and how to",
    "work) in memory, not here.",
  ].join("\n");
}

// The turn triggered by OpenClaw's background command completion notice (`Exec completed …`, tools.exec.notifyOnExit)
// runs even when the agent already waited for the result and reported it: an agent on Claude CLI replies
// "the result is already above" as a redundant message. NO_REPLY is OpenClaw's silent reply; nothing goes to the chat.
export const EXEC_NOTICE_RULE = [
  "## Background command notifications",
  "A message \"Exec completed (…)\" is OpenClaw's notice that a command started earlier has finished.",
  "If its result is already covered in your reply above and adds nothing new, reply with exactly NO_REPLY, with no explanation.",
  "Reply with substance only if the command failed, the result is new or changes what you said, or the user is still waiting for it.",
];
