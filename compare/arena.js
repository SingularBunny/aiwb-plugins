// Arena (formerly LMArena) text ratings for ranking models: the official leaderboard dataset on Hugging Face
// (lmarena-ai/leaderboard-dataset, config "text", split "latest", category "overall"), read through the
// Hugging Face datasets server. The server is not always up, so the last good snapshot is cached on disk
// and used while a refresh fails; with no snapshot at all, ranking falls back to the catalog's own order.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ARENA_DATASET = "lmarena-ai/leaderboard-dataset";
// The rows endpoint, not filter: filter answered 500 for hours on 11.11.2026 while rows worked. The latest split
// lists the categories one after another, "overall" first, so paging stops at the first page without it.
const ROWS_URL = "https://datasets-server.huggingface.co/rows";
const PAGE = 100;
export const REFRESH_MS = 24 * 3600_000;

// Name parts that say nothing about which model it is: packaging, quantization, effort level, vendor prefixes.
const NOISE = new Set(["it", "instruct", "chat", "preview", "free", "nvfp4", "fp8", "fp4", "bf16", "high", "low", "medium",
  "thinking", "latest", "exp", "experimental", "nvidia", "google", "meta", "the", "model", "hf", "gguf", "v"]);

/** Name → the parts that identify the model: lowercase letters and digits, split at every boundary, noise dropped. */
export function nameTokens(name) {
  const keep = (t) => t && !NOISE.has(t);
  return String(name ?? "").toLowerCase()
    .replace(/:[a-z]+$/, "")                       // OpenRouter variants (":free")
    .split(/[^a-z0-9]+/).filter(keep)
    // "v1" → "1", but sizes stay whole: "a12b", "550b".
    .flatMap((t) => t.split(/(?<=[a-z])(?=[0-9])(?![0-9]*[bkm]$)/)).filter(keep);
}

/**
 * The Arena row for a catalog model id ("openrouter/google/gemma-4-31b-it:free"), or null. Every identifying part
 * of the id's own name (the last path segment) must appear in the Arena name; among several matches the one with
 * the fewest extra parts wins, then the higher rating. A model Arena does not list gets null, never a neighbour's rating.
 */
export function matchArena(modelId, rows) {
  const want = nameTokens(String(modelId).split("/").pop());
  if (!want.length) return null;
  let best = null;
  for (const row of rows) {
    const have = nameTokens(row.model_name);
    if (!want.every((t) => have.includes(t))) continue;
    const extra = have.filter((t) => !want.includes(t)).length;
    if (!best || extra < best.extra || (extra === best.extra && row.rating > best.row.rating)) best = { row, extra };
  }
  // Too many unexplained parts means another model of the same line (a 120B variant of a 30B id, say).
  return best && best.extra <= 2 ? best.row : null;
}

function readCache(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * Current overall ratings: { rows: [{ model_name, organization, rating, rating_lower, rating_upper, rank }], date,
 * fetchedAt, stale, error }. Refreshes at most once a day; on failure returns the cached snapshot marked stale.
 */
export async function loadArena({ cacheFile, fetchJson, now = Date.now(), force = false }) {
  return refreshArena({ cacheFile, fetchJson, now, force });
}

/**
 * Non-blocking read for Gateway methods: the cached snapshot at once (stale: true while a refresh runs), and one
 * refresh in the background when it is older than a day or asked for. With no snapshot yet: empty rows, loading.
 */
export function createArenaSource({ cacheFile, fetchJson, now = () => Date.now() }) {
  let running = null;
  const refresh = (force) => {
    running ??= refreshArena({ cacheFile, fetchJson, now: now(), force }).finally(() => { running = null; });
    return running;
  };
  return {
    read({ force = false } = {}) {
      const cached = readCache(cacheFile);
      const due = force || !cached || now() - cached.fetchedAt >= REFRESH_MS;
      if (due) void refresh(force).catch(() => {});
      if (!cached) return { rows: [], date: null, fetchedAt: null, stale: true, loading: Boolean(running), error: null };
      return { ...cached, stale: due, loading: Boolean(running) };
    },
    refresh,
  };
}

async function refreshArena({ cacheFile, fetchJson, now, force }) {
  const cached = readCache(cacheFile);
  if (cached && !force && now - cached.fetchedAt < REFRESH_MS) return { ...cached, stale: false };
  try {
    const rows = [];
    for (let offset = 0; offset < 5000; offset += PAGE) {
      const url = `${ROWS_URL}?dataset=${encodeURIComponent(ARENA_DATASET)}&config=text&split=latest&offset=${offset}&length=${PAGE}`;
      const page = await fetchJson(url);
      const all = (page.rows || []).map((r) => r.row);
      const got = all.filter((r) => r.category === "overall");
      rows.push(...got.map(({ model_name, organization, rating, rating_lower, rating_upper, rank, leaderboard_publish_date }) =>
        ({ model_name, organization, rating, rating_lower, rating_upper, rank, date: leaderboard_publish_date })));
      if (all.length < PAGE || (rows.length && got.length < all.length)) break;
    }
    if (!rows.length) throw new Error("the dataset returned no rows");
    const fresh = { rows, date: rows[0].date, fetchedAt: now };
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(`${cacheFile}.tmp`, JSON.stringify(fresh));
    renameSync(`${cacheFile}.tmp`, cacheFile);
    return { ...fresh, stale: false };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    return cached ? { ...cached, stale: true, error: message } : { rows: [], date: null, fetchedAt: null, stale: true, error: message };
  }
}

/** fetch → JSON with a few retries: the datasets server answers 5xx now and then. */
export function retryingFetchJson(fetchImpl = fetch, { tries = 3, delayMs = 1500 } = {}) {
  return async (url) => {
    let last;
    for (let i = 0; i < tries; i += 1) {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        if (res.ok) return await res.json();
        last = new Error(`HTTP ${res.status}`);
      } catch (error) {
        last = error;
      }
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
    throw last;
  };
}
