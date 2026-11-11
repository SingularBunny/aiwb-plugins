// Adoption of old Claude Desktop and Claude Code chats by project agents, in the Gateway: each tree chat
// without a session (a "Projects" catalog row without sessionKey) is imported from the Claude catalog
// with its full history (a catalog continuation takes only the last 200 records) and bound to the
// Claude CLI chat itself, without launching Claude CLI. Until November 2026 claude-code-catalog.mjs
// did this from the timer through `openclaw gateway call`; it still does with a Gateway that cannot.
//
// The plugin calls the Gateway methods in process (api.runtime.gateway.request). OpenClaw allows that
// only to bundled and trusted official plugins; the ai-workbench OpenClaw fork lets the operator grant
// a plugin exact methods: OPENCLAW_PLUGIN_GATEWAY_METHODS="aiwb-claude-bridge=<GATEWAY_METHODS>".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Gateway methods adoption calls; all of them must be granted. */
export const ADOPTION_METHODS = ["sessions.catalog.list", "sessions.catalog.import", "sessions.patch", "session.visibility.set"];
/** Gateway methods the tree reads the live turn status with (running.js); without the grant the
 *  spinner falls back to turn marks with a 30-minute limit. */
export const STATUS_METHODS = ["sessions.list"];
/** Everything the bridge calls in the Gateway: the grant the installer writes. */
export const GATEWAY_METHODS = [...ADOPTION_METHODS, ...STATUS_METHODS];
export const GRANT_ENV = "OPENCLAW_PLUGIN_GATEWAY_METHODS";
const IMPORT_TIMEOUT_MS = 10 * 60 * 1000;

/** Methods of `methods` (default: adoption) not granted to the plugin in the environment (the fork reads the same variable). */
export function missingGrants(pluginId, env = process.env, methods = ADOPTION_METHODS) {
  const granted = new Set();
  for (const entry of (env[GRANT_ENV] || "").split(";")) {
    const i = entry.indexOf("=");
    if (i > 0 && entry.slice(0, i).trim() === pluginId) for (const m of entry.slice(i + 1).split(",")) granted.add(m.trim());
  }
  return methods.filter((m) => !granted.has(m));
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
const writeJson = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };

/**
 * One adoption pass. Registry of adopted chats (registryFile): a chat is not adopted twice on its own,
 * so one deleted or archived in OpenClaw does not come back. It is also filled with the chats bound to
 * project agent sessions (adoptedChats(), archived ones included); readopt ("<id, id prefix or title>")
 * clears the mark and the chat is adopted again.
 *
 *   request(method, params, options) — a Gateway method (api.runtime.gateway.request);
 *   bind({ agentId, sessionKey, threadId, cwd }) → { sessionKey, sessionId, archived } (the plugin's bind);
 *   treeChats() → [{ cliSessionId, title }] — chats of the tree, for readopt by title.
 */
export async function adoptOnce({ request, bind, adoptedChats, treeChats, registryFile, projects = {}, defaultAgent = "main", readopt = [], log = () => {} }) {
  const registry = readJson(registryFile);
  const again = new Set(), unknown = [];
  if (readopt.length) {
    const titles = new Map(treeChats().map((c) => [c.cliSessionId, c.title]));
    const ids = [...new Set([...titles.keys(), ...Object.keys(registry)])];
    for (const v of readopt) {
      const hit = ids.filter((id) => id === v || id.startsWith(v) || titles.get(id) === v);
      if (!hit.length) unknown.push(v);
      for (const id of hit) { again.add(id); delete registry[id]; }
    }
  }
  for (const c of await adoptedChats()) {
    if (!again.has(c.threadId)) registry[c.threadId] ||= { agentId: c.agentId, sessionKey: c.sessionKey };
  }
  // Saved before listing: the catalog hides the chats in the registry.
  writeJson(registryFile, registry);

  const rows = [];
  let cursor;
  do {
    const r = await request("sessions.catalog.list", { catalogId: "projects", limitPerHost: 100, ...(cursor ? { cursors: { "gateway:local": cursor } } : {}) });
    const host = r?.catalogs?.[0]?.hosts?.[0];
    if (!host) throw new Error('"Projects" catalog unavailable');
    rows.push(...host.sessions);
    cursor = host.nextCursor;
  } while (cursor);

  const result = { adopted: 0, failed: 0, errors: [], readopt: [...again], unknown };
  for (const row of rows.filter((x) => !x.sessionKey)) {
    const agentId = projects[row.customGroup] || defaultAgent;
    try {
      // A session from a previous import is reused from the archive.
      const imp = await request("sessions.catalog.import",
        { catalogId: "claude", hostId: "gateway:local", threadId: row.threadId, agentId, displayName: row.name }, { timeoutMs: IMPORT_TIMEOUT_MS });
      const key = imp?.sessionKey;
      if (!key) throw new Error("import returned no session");
      const bound = await bind({ agentId, sessionKey: key, threadId: row.threadId, cwd: row.cwd });
      if (bound.archived) {
        await request("sessions.patch", { key, expectedSessionId: bound.sessionId, archived: false })
          .catch((e) => log(`unarchive ${key}: ${e?.message || e}`));
      }
      // The import creates a draft (visible only to its owner, a ghost in the sidebar); a project chat is shared.
      await request("session.visibility.set", { sessionKey: key, visibility: "shared" })
        .catch((e) => log(`share ${key}: ${e?.message || e}`));
      registry[row.threadId] = { agentId, sessionKey: key };
      result.adopted++;
    } catch (e) {
      result.failed++;
      result.errors.push(`${row.customGroup} · ${row.name}: ${e?.message || e}`);
    }
  }
  if (result.adopted) writeJson(registryFile, registry);
  return result;
}

/** Runs passes one at a time; a pass requested while one runs is coalesced into one more after it. */
export function serialRunner() {
  let chain = Promise.resolve(), queued = null;
  return {
    /** Runs fn after the current pass; returns its result. */
    run(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; },
    /** Queues fn unless a queued pass is already waiting. */
    request(fn) {
      if (queued) return queued;
      queued = chain.then(() => { queued = null; return fn(); });
      chain = queued.catch(() => {});
      return queued;
    },
  };
}
