// Turn-in-progress state of the Projects tree rows.
//
// The source of truth is the Gateway's live session status: `sessions.list` with `activeOnly` returns
// the sessions with work running now (row status "running"), however long the turn lasts. A Claude CLI
// turn calls before_model_resolve once, so a mark written there cannot tell how long the turn goes on;
// a time-to-live on it dropped the spinner of turns longer than 30 minutes (09.11.2026).
//
// Marks (running.json: session key → time the turn started) stay as a fast hint and as the change
// signal: hooks write them at turn start and remove them at agent_end, a file watcher tells the sidebar
// to re-read the catalog. Every write is a full catalog re-read in every connected Control UI, so a
// write happens only when the set of marked sessions changes, not on every model call of a turn.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Without the Gateway's live status (method not granted, no Gateway in this process): marks older
 *  than this are ignored, so a missed turn end does not keep the spinner forever. */
export const RUN_TTL_MS = 30 * 60 * 1000;
/** With the live status: a fresh mark alone shows the spinner while the Gateway does not list the
 *  turn yet (turn start); after that the Gateway's status decides. */
export const RUN_HINT_MS = 2 * 60 * 1000;
/** Marks whose end never reached the plugin (scheduled runs end without agent_end) are dropped from
 *  the file at the next write after this long. A running turn keeps its mark until agent_end. */
export const MARK_PRUNE_MS = 24 * 60 * 60 * 1000;
/** Live status is cached this long: the sidebar reads the catalog in bursts. */
export const LIVE_CACHE_MS = 2000;
/** A failed live status read (not granted, Gateway busy) is not retried for this long. */
export const LIVE_RETRY_MS = 30 * 1000;

export function readRuns(file) {
  try {
    const all = JSON.parse(readFileSync(file, "utf8"));
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch { return {}; }
}

const keptRuns = (runs, now) =>
  Object.fromEntries(Object.entries(runs).filter(([, at]) => typeof at === "number" && now - at < MARK_PRUNE_MS));

/**
 * Marks or unmarks a session. Writes the file only when the set of marked sessions changes; returns
 * true when it wrote. A mark keeps its turn start time while the turn goes on.
 */
export function markRun(file, key, on, now = Date.now()) {
  const runs = readRuns(file);
  const kept = keptRuns(runs, now);
  const pruned = Object.keys(kept).length !== Object.keys(runs).length;
  const had = Object.prototype.hasOwnProperty.call(kept, key);
  if (!pruned && had === on) return false;
  if (on) { if (!had) kept[key] = now; } else delete kept[key];
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(kept));
    return true;
  } catch { return false; /* not writable — no fast hint */ }
}

/** Change detector for the watcher: true when the set of marked sessions differs from the last call. */
export function runSetTracker(file) {
  let last = null;
  return (now = Date.now()) => {
    const next = Object.keys(keptRuns(readRuns(file), now)).sort().join("\n");
    if (next === last) return false;
    last = next;
    return true;
  };
}

/**
 * Live running sessions from the Gateway: request(method, params) is api.runtime.gateway.request,
 * agentIds() the agents whose sessions the tree shows (one call each: with several agents
 * sessions.list needs an explicit agent). Automation sessions are asked too: they are rows of their
 * agent's folder (session-keys.js), and without the live status their spinner went out after
 * RUN_HINT_MS of a longer run. Resolves to a Set of session keys, or null when the status cannot be
 * read (the caller then falls back to marks with RUN_TTL_MS).
 */
export function liveRunningReader({ request, agentIds, now = Date.now, log = () => {} }) {
  let cached = null; // { at, value: Promise<Set|null> }
  const read = async () => {
    const ids = [...new Set(agentIds())];
    const results = await Promise.all(ids.map((agentId) => request("sessions.list", {
      agentId, activeOnly: true, rowMode: "compact", limit: 200, excludeSubagents: true,
    })));
    const running = new Set();
    for (const result of results) {
      for (const row of Array.isArray(result?.sessions) ? result.sessions : []) {
        if (row?.status === "running" && typeof row.key === "string") running.add(row.key);
      }
    }
    return running;
  };
  return () => {
    const t = now();
    if (cached && t - cached.at < (cached.failed ? LIVE_RETRY_MS : LIVE_CACHE_MS)) return cached.value;
    const entry = { at: t, failed: false, value: null };
    entry.value = read().catch((e) => {
      entry.failed = true;
      log(`live status unavailable: ${e?.message || e}`);
      return null;
    });
    cached = entry;
    return entry.value;
  };
}

/** Whether a row shows the spinner: the Gateway's live status, else the marks. */
export function isRunning(key, { runs, live, now = Date.now() }) {
  const at = runs[key];
  const marked = typeof at === "number";
  if (live) return live.has(key) || (marked && now - at < RUN_HINT_MS);
  return marked && now - at < RUN_TTL_MS;
}
