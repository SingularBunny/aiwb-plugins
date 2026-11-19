// Sharing imported sessions (session.visibility.set "shared"). A catalog import starts as a draft, visible
// only to its owner (the ghost mark in the sidebar), until it is shared. Right after an import the Gateway
// may not have the session's storage ready yet ("Session access facts are unavailable; retry after session
// storage is ready"): such errors are retried with backoff, and a session still not shared goes to a
// pending list in the plugin's state, retried on every adoption pass (at Gateway start and on the timer).
//
// A move (move.js) archives the source chat only once its copy in the target agent is shared: a pending
// entry carries that archive, done when the share succeeds, so a moved chat is never left a hidden draft
// next to an archived source, nor archived while its copy is still a draft.
import { readJson, writeJson } from "./state-file.js";

/** Waits between share attempts: 0.5 + 1 + 2 + 4 + 8 = 15.5 s, six attempts. */
export const SHARE_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a Gateway error is worth retrying: storage not ready, or the Gateway unavailable for now. */
export function isRetryable(e) {
  const text = `${e?.code ?? ""} ${e?.message ?? e ?? ""}`;
  return /unavailable|retry after|not ready|timed? ?out|ECONNRESET/i.test(text);
}

/**
 * Shares one session; retryable errors are retried after each of `delays`.
 * Returns { ok: true } or { ok: false, retryable, error, attempts }.
 */
export async function shareSession({ request, sessionKey, delays = SHARE_DELAYS_MS, sleep = sleepMs }) {
  for (let attempt = 1; ; attempt++) {
    try {
      await request("session.visibility.set", { sessionKey, visibility: "shared" });
      return { ok: true, attempts: attempt };
    } catch (e) {
      const retryable = isRetryable(e);
      if (!retryable || attempt > delays.length) return { ok: false, retryable, error: e?.message || String(e), attempts: attempt };
      await sleep(delays[attempt - 1]);
    }
  }
}


export const readPending = (file) => readJson(file);

/**
 * Adds a session to the pending list: sessionKey → { agentId, since, error, archive? }, where `archive`
 * is { agentId, key, expectedSessionId?, movedAt } — the source session a move archives once this one is shared.
 */
export function addPending(file, { sessionKey, agentId, error, archive, now = Date.now() }) {
  const pending = readJson(file);
  pending[sessionKey] = { agentId, since: pending[sessionKey]?.since ?? now, error, ...(archive ? { archive } : {}) };
  writeJson(file, pending);
}

/**
 * One retry of the pending list. Each session gets one share attempt (no backoff: the next pass retries);
 * once shared, the source a move left behind is archived through archive(entry.archive). An entry is dropped
 * when done, or when the share fails for good (not retryable), with a warning.
 *
 *   request(method, params) — a Gateway method; archive({ agentId, key, expectedSessionId, movedAt }) —
 *   archives the source session (throws if it cannot; the entry stays and the archive is retried).
 * Returns { shared: [sessionKey], archived: [key], dropped: [sessionKey], left: n }.
 */
export async function retryPending({ file, request, archive, log = () => {}, warn = log }) {
  const pending = readJson(file);
  const keys = Object.keys(pending);
  const result = { shared: [], archived: [], dropped: [], left: 0 };
  if (!keys.length) return result;
  for (const sessionKey of keys) {
    const entry = pending[sessionKey];
    if (!entry.shared) {
      const r = await shareSession({ request, sessionKey, delays: [] });
      if (!r.ok) {
        if (r.retryable) { entry.error = r.error; continue; }
        warn(`chat ${sessionKey} stays a draft: session.visibility.set failed: ${r.error}`
          + (entry.archive ? `; the source chat ${entry.archive.key} is kept` : ""));
        delete pending[sessionKey];
        result.dropped.push(sessionKey);
        continue;
      }
      entry.shared = true;
      result.shared.push(sessionKey);
      log(`shared pending chat ${sessionKey}`);
    }
    if (entry.archive) {
      try {
        await archive(entry.archive);
        result.archived.push(entry.archive.key);
      } catch (e) {
        entry.error = `archive ${entry.archive.key}: ${e?.message || e}`;
        if (e?.code === "NOT_FOUND" || e?.keep) {
          warn(`moved chat ${sessionKey} is shared; the source chat ${entry.archive.key} is kept: ${e?.message || e}`);
          delete pending[sessionKey];
          result.dropped.push(sessionKey);
        }
        continue;
      }
    }
    delete pending[sessionKey];
  }
  result.left = Object.keys(pending).length;
  writeJson(file, pending);
  return result;
}
