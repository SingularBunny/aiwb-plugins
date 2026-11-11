#!/usr/bin/env node
// Claude Code memory → OpenClaw agent memory, one way. Claude Code keeps memory per working folder in
// ~/.claude/projects/<encoded cwd>/memory/ (a MEMORY.md index plus one *.md fact per file). Each such
// folder belongs to the project folder the "Projects" tree puts its chats in, and that folder belongs
// to an agent (config projects / defaultAgent, see projectAgents below). Facts are copied into the
// agent's <workspace>/memory/; the Claude Code index goes into the sync-owned <workspace>/memory/
// claude-code-index.md, never into the agent's root MEMORY.md (see the provenance note in README.md).
//
// Rules: nothing is deleted on the OpenClaw side; a target is written only if it does not exist or its
// current hash equals the hash this sync last wrote there (state file); anything else is a conflict
// that is reported and skipped. A target with an OpenClaw memory provenance record is never written.
//
//   node claude-bridge/memory-sync.js --dry-run [--config <openclaw.json>]   report only
//   node claude-bridge/memory-sync.js --apply   [--config <openclaw.json>]   one sync now
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LEGACY_ID, PLUGIN_ID, legacyStateFile, migrateStateFile, stateFile } from "./legacy.js";
import { redact, secretValues } from "./redact.js";

/** Sync-owned index of Claude Code memory in the agent workspace; links resolve next to the facts. */
export const INDEX_FILE = "memory/claude-code-index.md";
const INDEX_HEADER = "<!-- Written by the aiwb-claude-bridge memory sync from Claude Code memory. Edit the source in Claude Code: "
  + "once this file is edited here, the sync stops updating it. -->\n# Claude Code memory index\n";

const STATE_NAME = "memory-sync.json";
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const expandHome = (p) => (p === "~" ? os.homedir() : p?.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

/** Folder → agent, exactly as the Projects tree maps them (index.js uses the same function). */
export function projectAgents(cfg = {}) {
  const defaultAgent = cfg.defaultAgent || "main", defaultFolder = cfg.defaultFolder || "_no_space";
  const projects = cfg.projects || {};
  return { defaultAgent, defaultFolder, projects, agentOf: (folder) => projects[folder] || defaultAgent };
}

/** Tree folder of a Claude Code chat, as claude-code-catalog.mjs puts it: the first path segment under
 *  the tree root (the root itself → its own name); null outside the root — such chats are not in the tree. */
export function folderOf(cwd, root) {
  if (!cwd || !root) return null;
  if (cwd === root) return path.basename(root);
  if (!cwd.startsWith(root + path.sep)) return null;
  return path.relative(root, cwd).split(path.sep)[0] || null;
}

export const TEMP_DIRS = [...new Set([os.tmpdir(), "/tmp"])];

/** Real working folder of a Claude Code project folder: the encoded name is ambiguous (non-ASCII and
 *  "/" both become "-"), so it is read from the first "cwd" in its session files. */
export function resolveCwd(projectDir) {
  let names;
  try { names = readdirSync(projectDir).filter((n) => n.endsWith(".jsonl")).sort(); } catch { return null; }
  const buf = Buffer.alloc(256 * 1024);
  for (const n of names) {
    let fd;
    try {
      fd = openSync(path.join(projectDir, n), "r");
      const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
      const m = text.match(/"cwd":("(?:[^"\\]|\\.)*")/);
      if (m) return JSON.parse(m[1]);
    } catch { /* unreadable or cut mid-line — try the next one */ } finally { if (fd !== undefined) closeSync(fd); }
  }
  return null;
}

/** *.md files of a memory folder as Buffers, MEMORY.md included; subfolders and other files are ignored. */
export function readMemoryDir(dir) {
  const out = {};
  for (const n of readdirSync(dir).sort()) {
    if (!n.endsWith(".md")) continue;
    const p = path.join(dir, n);
    try { if (statSync(p).isFile()) out[n] = readFileSync(p); } catch { /* vanished */ }
  }
  return out;
}

/** Memory files with secrets replaced by ‹secret› (exact values from .env files, then patterns). */
export function redactFiles(files, values = [], onCount = () => {}) {
  return Object.fromEntries(Object.entries(files).map(([name, buf]) => {
    const { text, count } = redact(buf.toString("utf8"), values);
    onCount(count);
    return [name, count ? Buffer.from(text) : buf];
  }));
}

/** Claude Code memory folders with their tree folder and agent; skipped ones carry the reason. */
export function discoverSources({ claudeProjectsDir, root, agentOf, tempDirs = TEMP_DIRS }) {
  const isTempPath = (p) => tempDirs.some((t) => p === t || p.startsWith(t + path.sep));
  const sources = [], skipped = [];
  let dirs = [];
  try { dirs = readdirSync(claudeProjectsDir).sort(); } catch { return { sources, skipped }; }
  for (const d of dirs) {
    const memoryDir = path.join(claudeProjectsDir, d, "memory");
    try { if (!statSync(memoryDir).isDirectory()) continue; } catch { continue; }
    if (d.startsWith("-tmp-")) { skipped.push({ dir: d, reason: "temporary folder" }); continue; }
    const cwd = resolveCwd(path.join(claudeProjectsDir, d));
    if (!cwd) { skipped.push({ dir: d, reason: "working folder unknown (no session file)" }); continue; }
    if (isTempPath(cwd)) { skipped.push({ dir: d, cwd, reason: "temporary folder" }); continue; }
    const folder = folderOf(cwd, root);
    if (!folder) { skipped.push({ dir: d, cwd, reason: "not in the Projects tree" }); continue; }
    sources.push({ dir: d, cwd, folder, agentId: agentOf(folder), memoryDir });
  }
  return { sources, skipped };
}

/** The agent's index of Claude Code memory: the source MEMORY.md as is (links are relative to memory/,
 *  where this file lives), one section per tree folder when several folders feed the same agent. */
export function buildIndex(entries) {
  const withIndex = entries.filter((e) => e.index != null).sort((a, b) => a.folder.localeCompare(b.folder));
  if (!withIndex.length) return null;
  const body = withIndex.map((e) => `\n## ${e.folder}\n\n${e.index.toString("utf8").trim()}\n`).join("");
  return Buffer.from(INDEX_HEADER + body);
}

/**
 * The sync plan, without touching the disk: every input comes as data or a reader.
 * sources: [{ folder, agentId, files: { name: Buffer } }] (files include MEMORY.md);
 * workspaces: { agentId: absolute workspace | undefined }; state: { targets: { absPath: hash } };
 * readTarget(absPath) → Buffer | null; provenance(workspace, rel) → true (recorded) | false | null (unknown).
 * Result: { actions: [{ agentId, rel, target, kind, reason?, data?, hash?, from }] }, kind ∈
 * create | update | unchanged | conflict.
 */
export function planSync({ sources, workspaces, state, readTarget, provenance }) {
  const last = state?.targets || {};
  const wanted = new Map();          // target → { agentId, rel, data, from[], clash }
  const actions = [];
  const byAgent = new Map();
  for (const s of sources) {
    if (!byAgent.has(s.agentId)) byAgent.set(s.agentId, []);
    byAgent.get(s.agentId).push(s);
  }
  for (const [agentId, list] of [...byAgent].sort(([a], [b]) => a.localeCompare(b))) {
    const ws = workspaces[agentId];
    if (!ws) {
      for (const s of list) actions.push({ agentId, rel: "-", target: null, kind: "conflict", reason: "agent has no workspace in the OpenClaw config", from: [s.folder] });
      continue;
    }
    const want = (rel, data, folder) => {
      const target = path.join(ws, ...rel.split("/"));
      const w = wanted.get(target);
      if (!w) wanted.set(target, { agentId, ws, rel, data, from: [folder] });
      else { w.from.push(folder); if (!w.data.equals(data)) w.clash = true; }
    };
    for (const s of list) {
      for (const [name, data] of Object.entries(s.files)) {
        if (name === "MEMORY.md") continue;
        if (`memory/${name}` === INDEX_FILE) { actions.push({ agentId, rel: `memory/${name}`, target: null, kind: "conflict", reason: "name reserved for the sync index", from: [s.folder] }); continue; }
        want(`memory/${name}`, data, s.folder);
      }
    }
    const index = buildIndex(list.map((s) => ({ folder: s.folder, index: s.files["MEMORY.md"] })));
    if (index) want(INDEX_FILE, index, list.map((s) => s.folder).sort().join(", "));
  }
  for (const [target, w] of wanted) {
    const base = { agentId: w.agentId, rel: w.rel, target, from: w.from };
    if (w.clash) { actions.push({ ...base, kind: "conflict", reason: `different files in Claude Code folders ${w.from.join(", ")}` }); continue; }
    const hash = sha256(w.data);
    const current = readTarget(target);
    const currentHash = current && sha256(current);
    if (currentHash === hash) { actions.push({ ...base, kind: "unchanged", hash }); continue; }
    if (!current && last[target]) { actions.push({ ...base, kind: "conflict", reason: "deleted on the OpenClaw side after the last sync" }); continue; }
    if (current && last[target] !== currentHash) {
      actions.push({ ...base, kind: "conflict", reason: last[target] ? "edited on the OpenClaw side since the last sync" : "differs and was never synced" });
      continue;
    }
    const recorded = provenance(w.ws, w.rel);
    if (recorded !== false) {
      actions.push({ ...base, kind: "conflict", reason: recorded ? "agent-written (OpenClaw memory provenance record)" : "memory provenance store unreadable" });
      continue;
    }
    actions.push({ ...base, kind: current ? "update" : "create", data: w.data, hash });
  }
  actions.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.rel.localeCompare(b.rel));
  return { actions };
}

/** Applies a plan: writes creates and updates (atomically), returns the new state. Unchanged targets are
 *  recorded too, so a later source change can update them. Never deletes anything. */
export function applyPlan(plan, state, { write = atomicWrite } = {}) {
  const targets = { ...(state?.targets || {}) };
  const errors = [];
  for (const a of plan.actions) {
    if (a.kind === "unchanged") targets[a.target] = a.hash;
    if (a.kind !== "create" && a.kind !== "update") continue;
    try { write(a.target, a.data); targets[a.target] = a.hash; } catch (e) { errors.push({ ...a, error: String(e?.message || e) }); }
  }
  return { state: { version: 1, targets }, errors };
}

function atomicWrite(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  // The temporary name does not end in .md, so memory indexing ignores it.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.aiwb-sync.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** Lines of the sync index that the agent's own MEMORY.md does not link yet: what goes into the prompt. */
export function indexForPrompt(indexText, rootMemoryText = "") {
  const linked = new Set([...String(rootMemoryText).matchAll(/\]\((?:memory\/)?([^)\s/]+\.md)\)/g)].map((m) => m[1]));
  const out = [];
  let section = null;
  for (const line of String(indexText || "").split("\n")) {
    if (/^<!--.*-->$/.test(line) || /^# /.test(line)) continue;
    if (/^## /.test(line)) { section = line; continue; }
    const m = line.match(/\]\(([^)\s/]+\.md)\)/);
    if (!line.trim() || (m && linked.has(m[1]))) continue;
    if (section) { out.push("", section); section = null; }
    out.push(m ? line.replace(/\]\(([^)\s/]+\.md)\)/g, "](memory/$1)") : line);
  }
  return out.join("\n").trim();
}

/** OpenClaw memory provenance (core:memory-artifact-provenance, OpenClaw state database): a recorded
 *  file was written by the agent through OpenClaw, and an outside write would make the agent's next
 *  write of it untrusted. Returns provenance(workspace, rel) → true | false | null (unknown). */
export async function provenanceReader(stateDir) {
  const db = path.join(stateDir, "state", "openclaw.sqlite");
  if (!existsSync(db)) return () => false;
  let rows;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      rows = conn.prepare("SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND (expires_at IS NULL OR expires_at > ?)")
        .all("core:memory-artifact-provenance", "workspace-files", Date.now());
    } finally { conn.close(); }
  } catch { return () => null; }
  const recorded = new Set();
  for (const { value_json } of rows) {
    try { const v = JSON.parse(value_json); recorded.add(`${v.workspaceKey}:${v.relativePath}`); } catch { /* skip */ }
  }
  const keyOf = (ws) => { let p = path.resolve(ws); try { p = realpathSync.native(p); } catch { /* missing */ } return sha256(p); };
  return (ws, rel) => recorded.has(`${keyOf(ws)}:${rel}`);
}

const readState = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { version: 1, targets: {} }; } };
const readOrNull = (file) => { try { return readFileSync(file); } catch { return null; } };

/** Everything the sync needs from the OpenClaw config and the plugin config. */
export function syncSettings(config, { stateDir, home = os.homedir(), pluginConfig } = {}) {
  // Before the installer moves the config to the new plugin id, it is still under the old one.
  const plugin = pluginConfig || config?.plugins?.entries?.[PLUGIN_ID]?.config || config?.plugins?.entries?.[LEGACY_ID]?.config || {};
  const ms = plugin.memorySync || {};
  const entries = config?.agents?.entries || {};
  const workspaces = Object.fromEntries((Array.isArray(entries) ? entries.map((e) => [e.id, e]) : Object.entries(entries))
    .map(([id, e]) => [id, e?.workspace ? path.resolve(expandHome(e.workspace)) : undefined]));
  return {
    // Without the tree root there is nothing to map Claude Code memory to: the sync stays off.
    enabled: ms.enabled === true && Boolean(ms.root),
    root: ms.root ? path.resolve(expandHome(ms.root)) : null,
    claudeProjectsDir: path.resolve(expandHome(ms.claudeProjectsDir || path.join(home, ".claude", "projects"))),
    stateFile: stateFile(path.join(stateDir, "workbench"), STATE_NAME),
    secretsFiles: (ms.secretsFiles || ["~/.openclaw/.env"]).map((f) => path.resolve(expandHome(f))),
    stateDir, workspaces, ...projectAgents(plugin),
  };
}

/** One pass: discover, plan, and (unless dryRun) write. Returns the plan with skipped sources. */
export async function syncOnce(settings, { dryRun = false } = {}) {
  const { sources, skipped } = discoverSources(settings);
  const values = (settings.secretsFiles || []).flatMap((f) => { try { return secretValues(readFileSync(f, "utf8")); } catch { return []; } });
  let redacted = 0;
  const withFiles = sources.map((s) => ({ ...s, files: redactFiles(readMemoryDir(s.memoryDir), values, (n) => { redacted += n; }) }));
  // State kept under the old plugin name moves to the new one on a real pass; a dry run only reads it.
  const dir = path.dirname(settings.stateFile);
  if (!dryRun) migrateStateFile(dir, STATE_NAME);
  const state = readState(dryRun && !existsSync(settings.stateFile) ? legacyStateFile(dir, STATE_NAME) : settings.stateFile);
  const provenance = await provenanceReader(settings.stateDir);
  const plan = planSync({ sources: withFiles, workspaces: settings.workspaces, state, readTarget: readOrNull, provenance });
  const result = { ...plan, redacted, sources: withFiles.map(({ files, ...s }) => ({ ...s, files: Object.keys(files).length })), skipped, errors: [] };
  if (dryRun) return result;
  const applied = applyPlan(plan, state);
  mkdirSync(path.dirname(settings.stateFile), { recursive: true });
  writeFileSync(settings.stateFile, JSON.stringify(applied.state, null, 2) + "\n");
  result.errors = applied.errors;
  return result;
}

/** Human-readable report: counts per agent, then every conflict and error. */
export function formatReport(result, { dryRun = false } = {}) {
  const lines = [];
  for (const s of result.sources) lines.push(`  source ${s.folder} → ${s.agentId}  (${s.files} files)`);
  for (const s of result.skipped) lines.push(`  skipped ${s.dir}${s.cwd ? ` (${s.cwd})` : ""}: ${s.reason}`);
  const agents = [...new Set(result.actions.map((a) => a.agentId))];
  lines.push("", dryRun ? "Would sync (dry run, nothing written):" : "Synced:");
  if (result.redacted) lines.push(`  secrets replaced with ‹secret› before copying: ${result.redacted}`);
  for (const id of agents) {
    const n = (k) => result.actions.filter((a) => a.agentId === id && a.kind === k).length;
    lines.push(`  ${id.padEnd(10)} create ${n("create")}, update ${n("update")}, unchanged ${n("unchanged")}, conflict ${n("conflict")}`);
  }
  const changes = result.actions.filter((a) => a.kind === "create" || a.kind === "update");
  if (changes.length) lines.push("", "Changes:", ...changes.map((a) => `  ${a.kind.padEnd(6)} ${a.agentId}: ${a.rel}  ← ${a.from.join(", ")}`));
  const conflicts = result.actions.filter((a) => a.kind === "conflict");
  if (conflicts.length) lines.push("", "Conflicts (skipped):", ...conflicts.map((a) => `  ${a.agentId}: ${a.rel}  ← ${a.from.join(", ")}: ${a.reason}`));
  if (result.errors.length) lines.push("", "Errors:", ...result.errors.map((a) => `  ${a.agentId}: ${a.rel}: ${a.error}`));
  return lines.join("\n");
}

async function main(argv) {
  const has = (f) => argv.includes(f);
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const dryRun = has("--dry-run");
  if (!dryRun && !has("--apply")) {
    console.error("Usage: node claude-bridge/memory-sync.js --dry-run | --apply [--config <openclaw.json>]");
    process.exit(2);
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  const configFile = opt("--config") || process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
  let config;
  try { config = JSON.parse(readFileSync(configFile, "utf8")); } catch (e) { console.error(`Cannot read the OpenClaw config ${configFile}: ${e.message}`); process.exit(1); }
  const settings = syncSettings(config, { stateDir });
  console.log(`Claude Code memory: ${settings.claudeProjectsDir}\nProjects tree root: ${settings.root}\nState: ${settings.stateFile}`
    + `\nLive sync: ${settings.enabled ? "enabled" : "disabled"} (plugins.entries.aiwb-claude-bridge.config.memorySync.enabled)\n`);
  const result = await syncOnce(settings, { dryRun });
  console.log(formatReport(result, { dryRun }));
  if (result.errors.length) process.exitCode = 1;
}

// No top-level await: the Gateway loads the plugin with require(), which rejects an ESM graph that has one.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e?.stack || e); process.exit(1); });
}
