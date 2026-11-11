// Claude Desktop & Code bridge (aiwb-claude-bridge): brings Claude Desktop and Claude Code into OpenClaw.
// The "Projects" catalog groups chats by project folder, as in Claude Desktop. A project folder holds
// old Claude Desktop and Claude Code chats (from the metadata written by
// migrate/claude-desktop/claude-code-catalog.mjs) and the sessions of that project's agent. A session
// opens on click (the row carries sessionKey); an old chat adopted by its project agent (adopt.js: import
// with full history plus binding, in the Gateway; with a Gateway that does not allow it,
// claude-code-catalog.mjs does the same through the aiwb-claude-bridge.bind method) also opens as that
// agent's session and continues in the same Claude CLI chat.
//
// Config: plugins.entries.aiwb-claude-bridge.config = { projects: { "<folder>": "<agent id>" },
//   defaultAgent: "main", defaultFolder: "_no_space", adoption: { enabled }, memorySync: { enabled, root,
//   claudeProjectsDir } } — the agent for folders without a project, the folder for that agent's new
//   sessions, adoption of old chats in the Gateway (default on), and the one-way copy of Claude Code
//   memory into the agents' memory (memory-sync.js, README.md). Chats move between project folders by
//   drag-and-drop (move.js; OpenClaw fork: sessions.catalog.move).
import { existsSync, mkdirSync, readdirSync, readFileSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { listSessionCatalogEntries } from "openclaw/plugin-sdk/session-catalog";

import { adoptOnce, missingGrants, serialRunner } from "./adopt.js";
import { LEGACY_ID, PLUGIN_ID, migrateStateFile, stateFile } from "./legacy.js";
import { INDEX_FILE, formatReport, indexForPrompt, projectAgents, syncOnce, syncSettings } from "./memory-sync.js";
import { moveChat } from "./move.js";
import { publishHost } from "./catalog-host.js";
import { applyReorder, readOrder, sortRows, writeOrder } from "./order.js";
import { isRunning, liveRunningReader, markRun, readRuns, runSetTracker } from "./running.js";
import { isMainKey, isTreeSessionKey } from "./session-keys.js";

const CATALOG_ID = "projects";
const HOST_ID = "gateway:local";
const PAGE_LIMIT = 1000;                        // rows per catalog page: the whole tree at once
const SESSION_ROW = "s:";                       // session row: threadId = s:<sessionKey>
const overlayDir = () => path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions", "ai-workbench", "claude-desktop");
const stateDir = () => process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
/** Adopted chats (maintained by adopt.js, or claude-code-catalog.mjs): chat id → { agentId, sessionKey }. */
const workbenchDir = () => path.join(stateDir(), "workbench");
export const adoptedFile = () => stateFile(workbenchDir(), "adopted.json");
function adoptedChats() {
  try { return JSON.parse(readFileSync(adoptedFile(), "utf8")); } catch { return {}; }
}

/** Sessions with a turn in progress (maintained by plugin hooks): session key → start time. */
export const runningFile = () => stateFile(workbenchDir(), "running.json");
/** The user's drag-and-drop order of folders and chats (OpenClaw fork: sessions.catalog.reorder). */
export const orderFile = () => stateFile(workbenchDir(), "order.json");
/** State files that move from the old plugin name (legacy.js) when the plugin starts. */
export const STATE_FILES = ["adopted.json", "running.json", "order.json", "memory-sync.json"];
const runningRuns = () => readRuns(runningFile());

/** Tree chats: metadata written by claude-code-catalog.mjs; archived ones are skipped. */
function treeChats() {
  const dir = overlayDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const n of readdirSync(dir)) {
    if (!/^local_.*\.json$/.test(n)) continue;
    try {
      const e = JSON.parse(readFileSync(path.join(dir, n), "utf8"));
      if (!e.isArchived && e.cliSessionId && e.cwd) out.push(e);
    } catch { /* broken file — treat as missing */ }
  }
  return out;
}

const claudeProjectsDir = () => path.join(os.homedir(), ".claude", "projects");
const expandHome = (p) => (p === "~" ? os.homedir() : p?.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

/** Claude Code transcript file by id, in the project folders under ~/.claude/projects. */
function transcriptFile(id) {
  const root = claudeProjectsDir();
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    const f = path.join(root, d, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : "";

/** Claude Code transcript → catalog items, in file order. */
function transcriptItems(file) {
  const items = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if ((r.type !== "user" && r.type !== "assistant") || r.isSidechain || r.isMeta) continue;
    const content = r.message?.content;
    const base = { timestamp: r.timestamp, ...(r.message?.model ? { model: r.message.model } : {}) };
    if (r.type === "user") {
      if (Array.isArray(content)) {
        for (const [i, c] of content.entries()) {
          if (c?.type === "tool_result") items.push({ id: `${r.uuid}:${i}`, type: "toolResult", text: textOf(c.content).slice(0, 4000), ...base });
          else if (c?.type === "text" && c.text) items.push({ id: `${r.uuid}:${i}`, type: "userMessage", text: c.text, ...base });
        }
      } else if (content) items.push({ id: r.uuid, type: "userMessage", text: String(content), ...base });
      continue;
    }
    for (const [i, c] of (Array.isArray(content) ? content : []).entries()) {
      if (c?.type === "text" && c.text) items.push({ id: `${r.uuid}:${i}`, type: "agentMessage", text: c.text, ...base });
      else if (c?.type === "tool_use") items.push({ id: `${r.uuid}:${i}`, type: "toolCall", text: `${c.name}\n\n${JSON.stringify(c.input).slice(0, 2000)}`, ...base });
    }
  }
  return items;
}

/** Source chat mark of an adopted session; sessions adopted before the rename carry it under the old id. */
const sourceMark = (entry) => entry?.pluginExtensions?.[PLUGIN_ID]?.sourceThreadId ?? entry?.pluginExtensions?.[LEGACY_ID]?.sourceThreadId;
/** Claude Code chats bound to an OpenClaw session: its Claude CLI session and, for one adopted
 *  from the Claude catalog, the source chat. */
const boundChats = (entry) => [entry?.cliSessionBindings?.["claude-cli"]?.sessionId,
  entry?.pluginExtensions?.anthropic?.sessionCatalog?.sourceThreadId, sourceMark(entry)].filter(Boolean);
/** What a move takes from a session: the Claude Code conversation it continues now, the tree chat it
 *  came from, and every chat bound to it. */
const claudeChat = (entry) => {
  const claudeId = entry?.cliSessionBindings?.["claude-cli"]?.sessionId
    ?? entry?.pluginExtensions?.anthropic?.sessionCatalog?.sourceThreadId ?? sourceMark(entry);
  return { claudeId, chatId: sourceMark(entry) ?? entry?.pluginExtensions?.anthropic?.sessionCatalog?.sourceThreadId ?? claudeId,
    related: boundChats(entry) };
};

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Claude Desktop & Code bridge",
  description: "Brings Claude Desktop and Claude Code into OpenClaw: chats by project folder, old chats continued in agents, live run status, drag-and-drop order, live import of Claude Code memory",
  register(api) {
    // State files of the plugin under its old name move to the new one (never overwriting a newer file).
    for (const name of STATE_FILES) migrateStateFile(workbenchDir(), name);
    const cfg = api.pluginConfig || {};
    // Folder → agent; a folder without a project goes to the default agent, whose new sessions go to defaultFolder.
    const { defaultAgent, defaultFolder, projects, agentOf } = projectAgents(cfg);
    const order = Array.isArray(cfg.order) ? cfg.order : [];
    // Project agent sessions, one agent at a time: with several agents OpenClaw requires an explicit
    // agent and then returns only that agent's sessions.
    const projectEntries = (config) => [...new Set(groupOfAgent.keys())].flatMap((agentId) =>
      listSessionCatalogEntries({ config, runtime: api.runtime, agentId }).filter((e) => e.agentId === agentId));
    // A new agent session goes to the agent's folder; an adopted chat keeps its source folder.
    const groupOfAgent = new Map([[defaultAgent, defaultFolder]]);
    for (const [folder, agent] of Object.entries(projects)) if (!groupOfAgent.has(agent)) groupOfAgent.set(agent, folder);
    // Working folder of a tree folder: the agent's own folder, else <memorySync.root>/<folder>, where
    // claude-code-catalog.mjs takes the folders of the tree from.
    // No root configured: tree folders have no working folder of their own (only agents' own cwd).
    const treeRoot = cfg.memorySync?.root ? path.resolve(expandHome(cfg.memorySync.root)) : null;
    const folderCwd = (config, folder) => {
      const entries = config?.agents?.entries || {};
      const own = (Array.isArray(entries) ? entries.find((e) => e?.id === agentOf(folder)) : entries[agentOf(folder)])?.cwd;
      const cwd = own && path.resolve(expandHome(own));
      return cwd && path.basename(cwd) === folder ? cwd : treeRoot ? path.join(treeRoot, folder) : undefined;
    };
    const groupOf = (agentId, entry) => {
      const own = entry.spawnedCwd && path.basename(entry.spawnedCwd);
      return own && agentOf(own) === agentId ? own : groupOfAgent.get(agentId);
    };

    // Turn in progress: in OpenClaw 2026.10.10 a catalog row shows the spinner only if its status is
    // running; live session state is not passed to it. Turns are marked by hooks (requires
    // plugins.entries.aiwb-claude-bridge.hooks.allowConversationAccess; the plugin does not read messages).
    // Marks live in a file: OpenClaw serves hooks and the catalog from different plugin instances
    // (in-memory marks of one instance are not visible to the catalog).
    // The sidebar re-reads the catalog on its own only now and then; the service below tells it
    // to re-read right away when a mark changes (OpenClaw fork: plugin.<id>.session-catalog-changed).
    // Whether a turn runs is the Gateway's live session status (running.js, `sessions.list` through the
    // fork grant): a Claude CLI turn calls before_model_resolve once, however long it lasts. The marks
    // are the fast hint at turn start and the change signal; without the grant they decide alone, for at
    // most 30 minutes. The file is written only when the set of marked sessions changes.
    const debug = process.env.AIWB_CLAUDE_BRIDGE_DEBUG === "1";
    const log = (m) => { if (debug) api.logger?.info?.(`${PLUGIN_ID} ${m} pid=${process.pid}`); };
    const mark = (key, on) => markRun(runningFile(), key, on);
    const liveRunning = liveRunningReader({
      request: (method, params) => {
        if (!api.runtime.gateway?.request) throw new Error("no Gateway request in this process");
        return api.runtime.gateway.request(method, params);
      },
      agentIds: () => [...groupOfAgent.keys()],
      log,
    });
    const runningNow = async () => {
      const runs = runningRuns(), live = await liveRunning(), now = Date.now();
      return (key) => isRunning(key, { runs, live, now });
    };
    const started = (hook) => (_event, ctx) => { log(`run ${hook} start ${ctx?.sessionKey ?? "-"}`); if (ctx?.sessionKey) mark(ctx.sessionKey, true); };
    const ended = (hook) => (_event, ctx) => { log(`run ${hook} end ${ctx?.sessionKey ?? "-"}`); if (ctx?.sessionKey) mark(ctx.sessionKey, false); };
    api.on("before_model_resolve", started("before_model_resolve"));
    api.on("agent_end", ended("agent_end"));

    // Turn start or end → connected Control UIs re-read the catalog now. The marks file is the signal:
    // hooks and this service may live in different plugin instances.
    let watcher, timer;
    api.registerService({
      id: `${PLUGIN_ID}-status`,
      start(ctx) {
        if (!ctx.gatewayEvents) return;
        const file = runningFile();
        const emit = () => { try { ctx.gatewayEvents.emit("session-catalog-changed", {}, { scope: "operator.read" }); } catch { /* service stopped */ } };
        try { mkdirSync(path.dirname(file), { recursive: true }); } catch { return; }
        // Emit only when the set of running sessions differs from the last emit (a renewal of a long
        // turn's mark, or a write by an older plugin build, changes nothing on screen).
        const changed = runSetTracker(file);
        changed();
        watcher = watch(path.dirname(file), (_kind, name) => {
          if (name !== path.basename(file)) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!changed()) return;
            emit();
            // Once more after the live status settled: at agent_end the Gateway may still list the
            // turn as running for a moment, and the first re-read would keep its spinner.
            timer = setTimeout(emit, 3000);
          }, 300);
        });
      },
      stop() { clearTimeout(timer); watcher?.close(); watcher = undefined; },
    });

    // Claude Code memory → agent memory, one way (memory-sync.js). Off unless memorySync.enabled: the
    // owner reviews `node claude-bridge/memory-sync.js --dry-run` first. Session files are written all the
    // time, so only the memory folders are watched (plus the projects folder for new ones), with a
    // periodic pass for memory folders that appear inside existing project folders.
    if (cfg.memorySync?.enabled === true) {
      const DEBOUNCE_MS = 2000, RESCAN_MS = 10 * 60 * 1000;
      const watchers = new Map();
      let syncTimer, rescanTimer, running = false, again = false, settings;
      const sync = async () => {
        if (running) { again = true; return; }
        running = true;
        try {
          const result = await syncOnce(settings);
          watchMemoryFolders(result.sources.map((s) => s.memoryDir));
          const changed = result.actions.some((a) => a.kind === "create" || a.kind === "update");
          const conflicts = result.actions.filter((a) => a.kind === "conflict").length;
          if (changed || result.errors.length || debug) api.logger?.info?.(`${PLUGIN_ID} memory sync:\n${formatReport(result)}`);
          else if (conflicts) log(`memory sync: ${conflicts} conflicts skipped`);
        } catch (e) {
          api.logger?.warn?.(`${PLUGIN_ID} memory sync failed: ${e?.message || e}`);
        } finally {
          running = false;
          if (again) { again = false; schedule(); }
        }
      };
      const schedule = () => { clearTimeout(syncTimer); syncTimer = setTimeout(sync, DEBOUNCE_MS); };
      const watchDir = (dir) => {
        if (watchers.has(dir)) return;
        try { watchers.set(dir, watch(dir, schedule).on("error", () => { watchers.get(dir)?.close(); watchers.delete(dir); })); } catch { /* gone */ }
      };
      const watchMemoryFolders = (dirs) => { for (const d of dirs) watchDir(d); };
      api.registerService({
        id: `${PLUGIN_ID}-memory-sync`,
        start(ctx) {
          settings = syncSettings(ctx.config, { stateDir: ctx.stateDir || stateDir(), pluginConfig: cfg });
          // New project folders show up in the projects folder itself; their memory folder is picked up by the pass.
          watchDir(settings.claudeProjectsDir);
          rescanTimer = setInterval(schedule, RESCAN_MS);
          schedule();
        },
        stop() {
          clearTimeout(syncTimer); clearInterval(rescanTimer);
          for (const w of watchers.values()) w.close();
          watchers.clear();
        },
      });
      // The sync index is not the agent's root MEMORY.md, so OpenClaw does not put it into the context:
      // its lines that the agent's own index does not link yet are added here (requires
      // plugins.entries.aiwb-claude-bridge.hooks.allowPromptInjection). Not for scheduled runs and subagents,
      // which do not get root memory either.
      api.on("before_prompt_build", (_event, ctx) => {
        if (!ctx?.workspaceDir || /:cron:|:subagent:/.test(ctx.sessionKey || "")) return undefined;
        let index;
        try { index = readFileSync(path.join(ctx.workspaceDir, ...INDEX_FILE.split("/")), "utf8"); } catch { return undefined; }
        let own = "";
        try { own = readFileSync(path.join(ctx.workspaceDir, "MEMORY.md"), "utf8"); } catch { /* none */ }
        const lines = indexForPrompt(index, own);
        if (!lines) return undefined;
        return { appendSystemContext: ["# Memory from Claude Code (this project)",
          `Facts carried over from Claude Code memory of this project; details in ${INDEX_FILE.split("/")[0]}/<file>.md of your workspace (or memory_search).`,
          "", lines].join("\n") };
      });
    }

    const provider = {
      id: CATALOG_ID,
      label: "Projects",
      async list(params) {
        const entries = params.sessionEntries?.entriesForCatalog?.() ?? [];
        const running = await runningNow();
        log(`list marks=${Object.keys(runningRuns()).length}`);
        // Project agent sessions: each is a row in its folder, automations included (session-keys.js);
        // a tree chat bound to a session is shown as that session, not as a second row.
        // Bindings are collected from all sessions, scheduled runs included: their Claude CLI
        // transcripts also land in the project folder (agents.entries.<id>.cwd) but are not tree chats.
        // Archived sessions don't count: a chat bound only to an archived session stays a tree row.
        const bound = new Set(entries.filter(({ entry }) => entry.archivedAt === undefined).flatMap(({ entry }) => boundChats(entry)));
        const rows = [];
        for (const { agentId, sessionKey, entry } of entries) {
          const group = groupOf(agentId, entry);
          if (!group || entry.archivedAt !== undefined || !isTreeSessionKey(sessionKey)) continue;
          rows.push({
            threadId: `${SESSION_ROW}${sessionKey}`, sessionKey,
            name: entry.displayName || entry.label || (sessionKey.endsWith(":main") ? `${group}: main chat` : sessionKey),
            customGroup: group, status: running(sessionKey) ? "running" : "stored",
            ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
            ...(entry.updatedAt ? { updatedAt: entry.updatedAt, recencyAt: entry.updatedAt } : {}),
            // A project's main chat is protected by OpenClaw (no archive or delete); other sessions can
            // be archived from the row menu (provider.archive) or, open in their agent, as any session.
            source: "openclaw", archived: false, canContinue: true, canArchive: !isMainKey(sessionKey),
          });
        }
        // An adopted chat appears only as its session row: if the session is archived or deleted, the
        // chat is gone from the tree too; "Restore" in OpenClaw brings it back; re-adopt with the
        // aiwb-claude-bridge.readopt method (claude-code-catalog.mjs --readopt).
        const adopted = adoptedChats();
        for (const c of treeChats()) {
          if (bound.has(c.cliSessionId) || adopted[c.cliSessionId]) continue;
          rows.push({
            threadId: c.cliSessionId, name: c.title, cwd: c.cwd, customGroup: path.basename(c.cwd), status: "stored",
            ...(c.createdAt ? { createdAt: c.createdAt } : {}),
            ...(c.lastActivityAt ? { updatedAt: c.lastActivityAt, recencyAt: c.lastActivityAt } : {}),
            source: "claude-cli", modelProvider: "anthropic", archived: false, canContinue: true, canArchive: false,
          });
        }
        // The sidebar keeps the list order: folders by first appearance, chats as listed. Folders follow
        // the user's drag-and-drop order, then config.order, then alphabetical; chats follow order.js.
        rows.splice(0, rows.length, ...sortRows(rows, readOrder(orderFile()), order));
        // The sidebar asks for 40 rows per page, but it groups them into folders: a partial page shows
        // partial folders and counts. The tree is small, so every page holds up to PAGE_LIMIT rows.
        const offset = Number(params.cursors?.[HOST_ID]) || 0;
        const limit = PAGE_LIMIT;
        const page = rows.slice(offset, offset + limit);
        // The host also goes out through onHost (catalog-host.js): a refresh answered from the
        // Gateway's cache gets it as soon as it is ready.
        return [publishHost(params, {
          hostId: HOST_ID, label: "Projects", kind: "gateway", connected: true, sessions: page,
          ...(offset + page.length < rows.length ? { nextCursor: String(offset + page.length) } : {}),
        })];
      },
      async read(params) {
        if (params.threadId.startsWith(SESSION_ROW)) return { hostId: HOST_ID, threadId: params.threadId, items: [] };
        const file = transcriptFile(params.threadId);
        if (!file) throw new Error(`no transcript ${params.threadId}`);
        const all = transcriptItems(file);
        const end = params.cursor ? Number(params.cursor) : all.length;
        const start = Math.max(0, end - Math.max(1, Math.min(params.limit || 50, 50)));
        return {
          hostId: HOST_ID, threadId: params.threadId,
          items: all.slice(start, end).reverse(),
          ...(start > 0 ? { nextCursor: String(start) } : {}),
        };
      },
      async continueSession(params) {
        if (params.threadId.startsWith(SESSION_ROW)) return { sessionKey: params.threadId.slice(SESSION_ROW.length) };
        // Old chats are adopted by the project agent through the Claude catalog import (adopt.js or
        // claude-code-catalog.mjs; only the Claude catalog creates Claude CLI sessions); here we just
        // find the adopted session.
        const config = api.runtime.config.current();
        const found = projectEntries(config)
          .find((e) => groupOfAgent.has(e.agentId) && boundChats(e.entry).includes(params.threadId));
        if (!found) throw new Error("Chat is not adopted by the project agent yet — it will be within minutes (or run migrate/claude-desktop/claude-code-catalog.mjs)");
        return { sessionKey: found.sessionKey };
      },
    };
    // "Delete session" in the row menu of a session row: archived (not deleted; "Restore" brings it back) by
    // the Gateway as the operator (OpenClaw fork: a plugin may patch only sessions it created). Old chats not
    // adopted yet are not sessions and stay as they are.
    provider.archive = async ({ threadId }) => {
      if (!threadId.startsWith(SESSION_ROW)) throw Object.assign(new Error("only OpenClaw sessions can be archived here"), { code: "INVALID_REQUEST" });
      const sessionKey = threadId.slice(SESSION_ROW.length);
      if (isMainKey(sessionKey)) throw Object.assign(new Error("the main chat of a project cannot be archived"), { code: "INVALID_REQUEST" });
      const found = projectEntries(api.runtime.config.current()).find((e) => e.sessionKey === sessionKey);
      if (!found) throw Object.assign(new Error(`no session ${sessionKey}`), { code: "NOT_FOUND" });
      return { ok: true, archive: { key: sessionKey, ...(found.entry.sessionId ? { expectedSessionId: found.entry.sessionId } : {}) } };
    };
    // Drag-and-drop in the tree (OpenClaw fork): the full new order of folders or of one folder's chats.
    provider.reorder = async ({ target }) => {
      writeOrder(orderFile(), applyReorder(readOrder(orderFile()), target));
      return { ok: true };
    };
    // A chat dropped on another project folder moves to that project's agent (move.js). Runs between
    // adoption passes: both import into agents and write the registry of adopted chats.
    provider.move = async ({ threadId, group, threadIds }) => {
      const blocker = await adoptionBlocker();
      if (blocker) throw Object.assign(new Error(`moving chats needs adoption in the Gateway: ${blocker}`), { code: "UNAVAILABLE" });
      return await passes.run(async () => {
        const config = api.runtime.config.current();
        let row, source;
        if (threadId.startsWith(SESSION_ROW)) {
          const sessionKey = threadId.slice(SESSION_ROW.length);
          const found = projectEntries(config).find((e) => e.sessionKey === sessionKey && e.entry.archivedAt === undefined);
          if (found) {
            const group = groupOf(found.agentId, found.entry);
            row = { threadId, sessionKey, customGroup: group, name: found.entry.displayName || found.entry.label || sessionKey };
            source = found;
          }
        } else {
          const c = treeChats().find((t) => t.cliSessionId === threadId);
          if (c && !adoptedChats()[threadId]) row = { threadId, name: c.title, cwd: c.cwd, customGroup: path.basename(c.cwd) };
        }
        const moved = await moveChat({
          row, source, group, claudeChat, bind: (p) => bindChat({ ...p, rebind: true, fork: false }),
          request: (method, params, options) => api.runtime.gateway.request(method, params, options),
          transcriptFile, folderCwd: (folder) => folderCwd(config, folder), agentOf, projectsDir: claudeProjectsDir(),
          running: await runningNow(),
          registryFile: adoptedFile(), log, warn: (m) => api.logger?.warn?.(`${PLUGIN_ID} ${m}`),
        });
        // The moved chat takes the place it was dropped at.
        if (threadIds?.length) {
          const placed = threadIds.map((t) => (t === threadId ? moved.threadId : t));
          writeOrder(orderFile(), applyReorder(readOrder(orderFile()), { kind: "sessions", group, threadIds: placed }));
        }
        api.logger?.info?.(`${PLUGIN_ID} moved "${row?.name}" from ${row?.customGroup} to ${group} (${moved.sessionKey})`);
        return { ok: true, ...moved };
      });
    };
    api.registerSessionCatalog(provider);

    // All chats bound to a project agent session: adopted ones (mark, source chat, current fork) and
    // transcripts of its new chats — so nothing deleted comes back either way. Archived sessions included.
    const adoptedList = () => {
      const chats = [];
      for (const { agentId, sessionKey, entry } of projectEntries(api.runtime.config.current())) {
        if (!groupOfAgent.has(agentId) || /:cron:|:subagent:/.test(sessionKey)) continue;
        for (const threadId of new Set(boundChats(entry))) chats.push({ threadId, agentId, sessionKey, archived: entry.archivedAt !== undefined });
      }
      return chats;
    };

    // Binds an import session to its source Claude Code chat: it continues in the same Claude CLI chat
    // (the first turn forks, the source file is unchanged), in its working folder. Only import sessions
    // of project agents. The source chat mark is stored in the session itself: after the first turn the
    // binding moves to the fork, but the chat must stay recognizable. A session already bound to this
    // chat is left as is.
    // A move binds to the conversation the chat continues (threadId) and keeps the tree chat it came
    // from (sourceThreadId) as the mark; it always rewrites the binding (rebind): the folder changes.
    // A moved chat continues its own copy of the conversation, so its first turn need not fork (fork: false).
    const bindChat = async ({ agentId, sessionKey, threadId, cwd, sourceThreadId = threadId, rebind = false, fork = true } = {}) => {
      if (!groupOfAgent.has(agentId) || typeof sessionKey !== "string" || !sessionKey.startsWith(`agent:${agentId}:catalog-import:`)
        || !/^[A-Za-z0-9._-]+$/.test(threadId || "") || !/^[A-Za-z0-9._-]+$/.test(sourceThreadId || "")
        || typeof cwd !== "string" || !path.isAbsolute(cwd)) {
        throw Object.assign(new Error("project agent, import session, chat id and absolute folder are required"), { code: "INVALID_REQUEST" });
      }
      const entry = await api.runtime.agent.session.patchSessionEntry({
        agentId, sessionKey,
        update: (e) => !rebind && sourceMark(e) === sourceThreadId ? null : ({
          cliSessionBindings: { ...e.cliSessionBindings, "claude-cli": { sessionId: threadId, forceReuse: true, forkNextResume: fork } },
          spawnedCwd: cwd,
          pluginExtensions: { ...e.pluginExtensions, [PLUGIN_ID]: { sourceThreadId } },
        }),
      }) ?? await api.runtime.agent.session.getSessionEntryAsync({ agentId, sessionKey });
      if (!entry) throw Object.assign(new Error(`no session ${sessionKey}`), { code: "NOT_FOUND" });
      return { sessionKey, sessionId: entry.sessionId, archived: entry.archivedAt !== undefined };
    };

    // claude-code-catalog.mjs (adopting itself, with a Gateway without the grant) adds these chats to
    // the adopted list and binds the sessions it imports.
    api.registerGatewayMethod(`${PLUGIN_ID}.adopted`, async ({ respond }) => {
      respond(true, { chats: adoptedList() }, undefined);
    }, { scope: "operator.read" });

    api.registerGatewayMethod(`${PLUGIN_ID}.bind`, async ({ params, respond }) => {
      try {
        const { agentId, sessionKey, threadId, cwd } = params || {};
        respond(true, await bindChat({ agentId, sessionKey, threadId, cwd }), undefined);
      } catch (e) {
        respond(false, undefined, { code: e?.code || "UNAVAILABLE", message: e?.message || String(e) });
      }
    }, { scope: "operator.admin" });

    // Adoption in the Gateway (adopt.js): at start, every ADOPT_MS, and soon after the tree metadata
    // changes (claude-code-catalog.mjs rewrites it from the timer). Passes never overlap. Needs the
    // operator grant of the Gateway methods (OpenClaw fork, OPENCLAW_PLUGIN_GATEWAY_METHODS); without it
    // the plugin reports adoption as unavailable and claude-code-catalog.mjs adopts as before.
    const ADOPT_MS = 10 * 60 * 1000, ADOPT_START_MS = 30 * 1000, ADOPT_DEBOUNCE_MS = 5000;
    const adoptionOn = cfg.adoption?.enabled !== false;
    const passes = serialRunner();
    /** Why adoption cannot run in this Gateway, or null. Probes the grant with a read-only call. */
    const adoptionBlocker = async () => {
      if (!adoptionOn) return "turned off (adoption.enabled = false)";
      const missing = missingGrants(PLUGIN_ID);
      if (missing.length) return `Gateway methods not granted: ${missing.join(", ")} (OPENCLAW_PLUGIN_GATEWAY_METHODS)`;
      if (!(await api.runtime.gateway?.isAvailable?.())) return "no Gateway in this process";
      try { await api.runtime.gateway.request("sessions.catalog.list", { catalogId: CATALOG_ID, limitPerHost: 1 }); } catch (e) { return e?.message || String(e); }
      return null;
    };
    const adoptPass = (readopt = []) => adoptOnce({
      request: (method, params, options) => api.runtime.gateway.request(method, params, options),
      bind: bindChat, adoptedChats: adoptedList, treeChats, registryFile: adoptedFile(),
      projects, defaultAgent, readopt, log,
    });
    const report = (result) => {
      if (result.adopted || result.failed || debug) {
        api.logger?.info?.(`${PLUGIN_ID} adoption by agents: adopted ${result.adopted}, errors ${result.failed}`
          + result.errors.map((e) => `\n  ✗ ${e}`).join(""));
      }
    };

    // Whether adoption runs here: claude-code-catalog.mjs then leaves it to the plugin.
    api.registerGatewayMethod(`${PLUGIN_ID}.adoption`, async ({ respond }) => {
      const blocker = await adoptionBlocker();
      respond(true, { inGateway: !blocker, ...(blocker ? { reason: blocker } : {}) }, undefined);
    }, { scope: "operator.read" });

    // Adopt again chats deleted or archived after adoption: { chats: ["<id, id prefix or title>", …] }.
    api.registerGatewayMethod(`${PLUGIN_ID}.readopt`, async ({ params, respond }) => {
      const chats = [params?.chats ?? params?.chat].flat().filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim());
      if (!chats.length) { respond(false, undefined, { code: "INVALID_REQUEST", message: "chats: chat ids or titles are required" }); return; }
      const blocker = await adoptionBlocker();
      if (blocker) { respond(false, undefined, { code: "UNAVAILABLE", message: `adoption in the Gateway is unavailable: ${blocker}` }); return; }
      try {
        const result = await passes.run(() => adoptPass(chats));
        report(result);
        respond(true, result, undefined);
      } catch (e) {
        respond(false, undefined, { code: "UNAVAILABLE", message: e?.message || String(e) });
      }
    }, { scope: "operator.admin" });

    if (adoptionOn) {
      let adoptTimer, startTimer, debounce, treeWatcher, stopped = false, warned = false;
      const pass = () => passes.request(async () => {
        if (stopped) return;
        const blocker = await adoptionBlocker();
        if (blocker) {
          if (!warned) api.logger?.warn?.(`${PLUGIN_ID} adoption by agents left to claude-code-catalog.mjs: ${blocker}`);
          warned = true;
          return;
        }
        warned = false;
        report(await adoptPass());
      }).catch((e) => api.logger?.warn?.(`${PLUGIN_ID} adoption by agents failed: ${e?.message || e}`));
      api.registerService({
        id: `${PLUGIN_ID}-adoption`,
        start() {
          stopped = false;
          startTimer = setTimeout(pass, ADOPT_START_MS);
          adoptTimer = setInterval(pass, ADOPT_MS);
          try {
            treeWatcher = watch(overlayDir(), () => { clearTimeout(debounce); debounce = setTimeout(pass, ADOPT_DEBOUNCE_MS); })
              .on("error", () => { treeWatcher?.close(); treeWatcher = undefined; });
          } catch { /* no tree yet: the periodic pass picks it up */ }
        },
        stop() {
          stopped = true;
          clearTimeout(startTimer); clearInterval(adoptTimer); clearTimeout(debounce);
          treeWatcher?.close(); treeWatcher = undefined;
        },
      });
    }
  },
});
