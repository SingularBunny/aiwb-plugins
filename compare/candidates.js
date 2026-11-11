// Which models answer and which judges (research R-55): answerers are the top free models of different families
// by their Arena rating, judge the strongest available model of a family no answerer is from (judges favour their
// own family; only the strongest models agree well with people). Free models change every week, so nothing is
// hard-coded: the list comes from the live catalog (models.list) and the current Arena snapshot.
import { matchArena } from "./arena.js";

/** "provider/id" of a catalog row. */
export const refOf = (m) => `${m.provider}/${m.id}`;

/** Model family: the organisation in an aggregator id ("google/gemma-…" on OpenRouter), else the provider. */
export function familyOf(m, arenaRow) {
  if (arenaRow?.organization) return String(arenaRow.organization).toLowerCase();
  const parts = String(m.id).split("/");
  return (parts.length > 1 ? parts[0] : m.provider).toLowerCase();
}

/** Free: an OpenRouter ":free" variant, or a model of a provider the operator marked free (local Ollama, say). */
export const isFree = (m, freeProviders = []) => /:free$/.test(m.id) || freeProviders.includes(m.provider);

/**
 * Catalog rows with their Arena rating, best first: rated models by rating, then unrated ones with the catalog's
 * recommended ones first. Unavailable rows are dropped.
 */
export function rankModels(models, arenaRows, { freeProviders = [] } = {}) {
  return models.filter((m) => m.available !== false).map((m) => {
    const row = matchArena(refOf(m), arenaRows);
    return { ref: refOf(m), name: m.name || m.id, provider: m.provider, family: familyOf(m, row), free: isFree(m, freeProviders),
      reasoning: Boolean(m.reasoning), runtime: m.agentRuntime?.id || null,
      rating: row ? Math.round(row.rating) : null, ratingRange: row?.rating_lower ? [Math.round(row.rating_lower), Math.round(row.rating_upper)] : null,
      arenaName: row?.model_name || null, recommended: Boolean(m.recommended) };
  }).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || Number(b.recommended) - Number(a.recommended) || a.ref.localeCompare(b.ref));
}

/** The top `count` free models, one per family. */
export function pickAnswerers(ranked, count = 3) {
  const out = [];
  for (const m of ranked) {
    if (!m.free || m.failed || out.some((o) => o.family === m.family)) continue;
    out.push(m);
    if (out.length >= count) break;
  }
  return out;
}

/** The judge: the best rated reasoning model, else the best rated one, of a family none of the answerers is from. */
export function pickJudge(ranked, answerers) {
  const families = new Set(answerers.map((a) => a.family));
  const others = ranked.filter((m) => !families.has(m.family) && m.rating !== null);
  return others.find((m) => m.reasoning) || others[0] || null;
}
