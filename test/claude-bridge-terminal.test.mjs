import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { boundConversation, chatsMarkdown, projectSlug, terminalActivity, terminalCommand, terminalProcesses, transcriptPath, writeChatsFile }
  from "../claude-bridge/terminal.js";

const fresh = () => mkdtempSync(path.join(os.tmpdir(), "bridge-term-"));
const ID = "227a3cab-19f7-4a6b-824f-4bc9e5feb9ae";

test("terminal: the conversation file is found by Claude Code's folder slug, or in another project folder", () => {
  assert.equal(projectSlug("/home/u/claude-desktop/_no_space"), "-home-u-claude-desktop--no-space");
  assert.equal(projectSlug("/home/u/claude-desktop/Сад"), "-home-u-claude-desktop----");
  const root = fresh();
  mkdirSync(path.join(root, "-w-garden"));
  writeFileSync(path.join(root, "-w-garden", `${ID}.jsonl`), "");
  assert.equal(transcriptPath(root, "/w/garden", ID), path.join(root, "-w-garden", `${ID}.jsonl`));
  assert.equal(transcriptPath(root, "/w/moved", ID), path.join(root, "-w-garden", `${ID}.jsonl`));
  assert.equal(transcriptPath(root, "/w/garden", "missing"), null);
});

test("terminal: the command resumes the bound conversation in its folder; unbound sessions have none", () => {
  assert.equal(terminalCommand("/w/garden", ID), `cd /w/garden && claude --resume ${ID}`);
  assert.equal(terminalCommand("/w/Сад и огород", ID), `cd '/w/Сад и огород' && claude --resume ${ID}`);
  assert.deepEqual(boundConversation({ cliSessionBindings: { "claude-cli": { sessionId: ID } }, spawnedCwd: "/w/garden" }), { sessionId: ID, cwd: "/w/garden" });
  assert.equal(boundConversation({ spawnedCwd: "/w/garden" }), null);
  assert.equal(boundConversation({ cliSessionBindings: { "claude-cli": { sessionId: ID } } }), null);
});

test("terminal: a chat started in OpenClaw has no spawnedCwd, its folder comes from the conversation file", () => {
  const root = fresh();
  mkdirSync(path.join(root, "-w-garden"));
  writeFileSync(path.join(root, "-w-garden", `${ID}.jsonl`),
    `${JSON.stringify({ type: "queue-operation" })}\n${JSON.stringify({ type: "user", cwd: "/w/garden", sessionId: ID })}\n`);
  assert.deepEqual(boundConversation({ cliSessionBindings: { "claude-cli": { sessionId: ID } } }, root), { sessionId: ID, cwd: "/w/garden" });
  assert.equal(boundConversation({ cliSessionBindings: { "claude-cli": { sessionId: "missing" } } }, root), null);
});

test("terminal: an interactive claude process with the conversation counts, OpenClaw's own --print process does not", () => {
  const proc = fresh();
  const add = (pid, argv) => { mkdirSync(path.join(proc, pid)); writeFileSync(path.join(proc, pid, "cmdline"), argv.join("\0") + "\0"); };
  add("100", ["/usr/bin/claude", "-p", "--input-format", "stream-json", "--resume", ID]);
  add("200", ["node", "/opt/claude-code/cli.js", "--resume", "other"]);
  assert.deepEqual(terminalProcesses(ID, proc), []);
  add("300", ["claude", "--resume", ID]);
  assert.deepEqual(terminalProcesses(ID, proc), [300]);
});

test("terminal: a fresh interactive record keeps the chat busy; an old one or OpenClaw's own does not", () => {
  const dir = fresh();
  const file = path.join(dir, "t.jsonl");
  const now = Date.parse("2026-11-14T12:00:00Z");
  const rec = (entrypoint, at) => JSON.stringify({ type: "assistant", entrypoint, timestamp: new Date(at).toISOString() });
  const busy = (lines) => { writeFileSync(file, lines.join("\n") + "\n"); return terminalActivity({ sessionId: ID, transcript: file, now, procDir: dir }).active; };
  assert.equal(busy([rec("sdk-cli", now - 60e3), rec("cli", now - 30e3)]), true);
  assert.equal(busy([rec("cli", now - 30 * 60e3)]), false);
  assert.equal(busy([rec("cli", now - 60e3), rec("sdk-cli", now - 10e3)]), false);
  assert.equal(terminalActivity({ sessionId: ID, transcript: null, procDir: dir }).active, false);
});

test("terminal: the chats file lists each folder's chats, newest first, with their commands; unchanged text is not rewritten", () => {
  const rows = [
    { title: "Old | one", folder: "garden", cwd: "/w/garden", sessionId: "a", updatedAt: Date.parse("2026-11-01T10:00:00Z") },
    { title: "New", folder: "garden", cwd: "/w/garden", sessionId: "b", updatedAt: Date.parse("2026-11-14T10:00:00Z") },
    { title: "Plans", folder: "attic", cwd: "/w/attic", sessionId: "c" },
  ];
  const text = chatsMarkdown(rows, new Date("2026-11-14T12:00:00Z"));
  assert.ok(text.indexOf("## attic") < text.indexOf("## garden"));
  assert.ok(text.indexOf("| New |") < text.indexOf("| Old / one |"));
  assert.ok(text.includes("`cd /w/garden && claude --resume b`"));
  const file = path.join(fresh(), "chats.md");
  assert.equal(writeChatsFile(file, text), true);
  assert.equal(writeChatsFile(file, chatsMarkdown(rows, new Date("2026-11-14T13:00:00Z"))), false);
  assert.ok(readFileSync(file, "utf8").includes("12:00"));
});
