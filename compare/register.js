// Gateway side of Multi-model: settings, ranking, asking several models, choosing the common answer, merging.
// Separate from index.js so tests can register it against a fake api without the OpenClaw SDK.
//
// Models are called through api.runtime.llm.complete with an explicit model, which the operator allows with
// plugins.entries.aiwb-compare.llm.allowModelOverride (the installer sets it). A model whose catalog row runs on
// a CLI (Claude by subscription: agentRuntime "claude-cli") is called in the isolated agent runtime mode, the
// others directly through their provider.
import path from "node:path";

import { createArenaSource, retryingFetchJson } from "./arena.js";
import { pickAnswerers, pickJudge, rankModels } from "./candidates.js";
import { mergePrompt, selectConsensus } from "./consensus.js";

export const PLUGIN_ID = "aiwb-compare";
export const TAB_ID = "multi-model";
export const METHODS = {
  state: `${PLUGIN_ID}.state`,
  rank: `${PLUGIN_ID}.rank`,
  settings: `${PLUGIN_ID}.settings`,
  ask: `${PLUGIN_ID}.ask`,
  select: `${PLUGIN_ID}.select`,
  merge: `${PLUGIN_ID}.merge`,
};
const REF = /^[a-z0-9][a-z0-9._-]*\/[^\s]{1,200}$/i;
const MAX_QUESTION = 32_000;
const MAX_ANSWER = 64_000;

class InputError extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID_REQUEST";
  }
}

/** Settings with defaults; anything malformed falls back to the default. */
export function readSettings(config = {}) {
  const refOrAuto = (v) => (v === "auto" || (typeof v === "string" && REF.test(v)) ? v : "auto");
  const role = (v) => (v && typeof v === "object" ? { ref: refOrAuto(v.ref), runtime: typeof v.runtime === "string" ? v.runtime : null } : { ref: refOrAuto(v), runtime: null });
  const answerers = config.answerers && typeof config.answerers === "object" ? config.answerers : {};
  const count = Number.isInteger(answerers.count) && answerers.count >= 2 && answerers.count <= 6 ? answerers.count : 3;
  return {
    answerers: {
      mode: answerers.mode === "manual" ? "manual" : "auto",
      count,
      models: Array.isArray(answerers.models) ? answerers.models.filter((m) => m && REF.test(m.ref)).slice(0, 6)
        .map((m) => ({ ref: m.ref, runtime: typeof m.runtime === "string" ? m.runtime : null })) : [],
    },
    judge: role(config.judge),
    merger: role(config.merger),
    defaultModel: role(config.defaultModel),
    freeProviders: Array.isArray(config.freeProviders) ? config.freeProviders.filter((p) => typeof p === "string") : [],
    maxTokens: Number.isInteger(config.maxTokens) && config.maxTokens >= 256 && config.maxTokens <= 32_000 ? config.maxTokens : 2048,
  };
}

const text = (v, max, name) => {
  if (typeof v !== "string" || !v.trim()) throw new InputError(`${name} is required`);
  if (v.length > max) throw new InputError(`${name} is longer than ${max} characters`);
  return v;
};
const model = (m, name) => {
  if (!m || typeof m.ref !== "string" || !REF.test(m.ref)) throw new InputError(`${name}: a model as provider/id`);
  return { ref: m.ref, runtime: typeof m.runtime === "string" ? m.runtime : null };
};

function failure(respond, error) {
  respond(false, undefined, { code: error?.code === "INVALID_REQUEST" ? "INVALID_REQUEST" : "UNAVAILABLE",
    message: String(error?.message || error).slice(0, 500) });
}

export function registerCompare(api, { stateDir, fetchJson = retryingFetchJson(), now = () => Date.now() } = {}) {
  const arenaSource = createArenaSource({ cacheFile: path.join(stateDir, "workbench", "arena-text.json"), fetchJson, now });
  const arenaInfo = (a) => ({ date: a.date, stale: a.stale, loading: Boolean(a.loading), error: a.error ?? null, count: a.rows.length });
  const settings = () => readSettings(api.runtime?.config?.current?.()?.plugins?.entries?.[PLUGIN_ID]?.config || api.pluginConfig || {});

  /** One model call; a CLI-backed model goes through the isolated agent runtime. */
  async function complete(m, prompt, purpose, signal) {
    const s = settings();
    const isolated = Boolean(m.runtime && /cli$|harness/.test(m.runtime));
    const started = now();
    const result = await api.runtime.llm.complete({
      model: m.ref, purpose: `${PLUGIN_ID}.${purpose}`, maxTokens: s.maxTokens, signal,
      messages: [{ role: "user", content: prompt }],
      ...(isolated ? { execution: { mode: "isolated-agent-runtime", timeoutMs: 180_000 } } : {}),
    });
    const answer = String(result.text ?? "");
    // A provider error (403 region, 429 rate limit) comes back as an empty completion, not a thrown error.
    if (!answer.trim()) {
      // stop reason "stop" with no text: the model finished but put everything in its reasoning (seen with a free
      // Nemotron on 11.11.2026), which would happen again; another reason is a provider error (region, rate limit).
      const reasoningOnly = result.stopReason === "stop";
      throw Object.assign(new Error(reasoningOnly ? "the model returned only reasoning, no answer text"
        : `no answer${result.stopReason ? ` (stop reason: ${result.stopReason})` : ""}; see the Gateway log for the provider's error`),
      { code: reasoningOnly ? "REASONING_ONLY" : "EMPTY" });
    }
    return { text: answer, ms: now() - started, usage: result.usage ?? null, model: result.responseModel || result.model };
  }

  // Models that failed recently (region-blocked, rate-limited): not suggested again for a while.
  const failures = new Map();
  // A rate limit or a passing provider error may be gone in half an hour; a model that answers only in its
  // reasoning does so every time, so it rests a day.
  const FAILURE_MS = 30 * 60_000;
  const REASONING_ONLY_MS = 24 * 3600_000;
  const fresh = (f) => f && now() - f.at < (f.code === "REASONING_ONLY" ? REASONING_ONLY_MS : FAILURE_MS) ? f : null;
  // A provider fails as a whole when two of its models fail in one ask (no credit, a bad key): then all its models rest.
  const providerOf = (ref) => ref.split("/")[0];
  const recentFailure = (ref) => fresh(failures.get(ref)) || fresh(failures.get(`provider:${providerOf(ref)}`));

  api.registerGatewayMethod(METHODS.state, async ({ respond }) => {
    try {
      respond(true, { settings: settings(), arena: arenaInfo(arenaSource.read()) }, undefined);
    } catch (error) {
      failure(respond, error);
    }
  }, { scope: "operator.read" });

  // The page sends the catalog rows it got from models.list; the ranking and the suggested roles come back.
  api.registerGatewayMethod(METHODS.rank, async ({ params, respond }) => {
    try {
      if (!Array.isArray(params?.models)) throw new InputError("models: the rows of models.list");
      const arena = arenaSource.read({ force: params.refresh === true });
      const s = settings();
      const ranked = rankModels(params.models.slice(0, 2000), arena.rows, { freeProviders: s.freeProviders })
        .map((m) => { const f = recentFailure(m.ref); return f ? { ...m, failed: f.error } : m; });
      const answerers = pickAnswerers(ranked, s.answerers.count);
      respond(true, { ranked, suggested: { answerers, judge: pickJudge(ranked, answerers) },
        arena: arenaInfo(arena) }, undefined);
    } catch (error) {
      failure(respond, error);
    }
  }, { scope: "operator.read" });

  api.registerGatewayMethod(METHODS.settings, async ({ params, respond }) => {
    try {
      const next = readSettings(params?.settings || {});
      await api.runtime.config.mutateConfigFile({ afterWrite: { mode: "auto" }, mutate: (draft) => {
        draft.plugins ??= {};
        draft.plugins.entries ??= {};
        draft.plugins.entries[PLUGIN_ID] ??= {};
        draft.plugins.entries[PLUGIN_ID].config = next;
      } });
      api.logger?.info?.(`${PLUGIN_ID}: settings saved`);
      respond(true, { settings: next }, undefined);
    } catch (error) {
      failure(respond, error);
    }
  }, { scope: "operator.admin" });

  // Ask: every model at once; one model failing does not fail the others. A failed model is replaced by the next
  // fallback (the page sends the rest of the ranking) of a family no answer comes from yet; the reply names both.
  api.registerGatewayMethod(METHODS.ask, async ({ params, respond }) => {
    try {
      const question = text(params?.question, MAX_QUESTION, "question");
      if (!Array.isArray(params?.models) || params.models.length < 1 || params.models.length > 6) throw new InputError("models: 1 to 6 models");
      const models = params.models.map((m, i) => ({ ...model(m, `models[${i}]`), family: typeof m.family === "string" ? m.family : null }));
      const fallbacks = (Array.isArray(params.fallbacks) ? params.fallbacks.slice(0, 40) : [])
        .map((m, i) => ({ ...model(m, `fallbacks[${i}]`), family: typeof m.family === "string" ? m.family : null }));
      const taken = new Set(models.map((m) => m.family).filter(Boolean));
      const used = new Set(models.map((m) => m.ref));
      const failedHere = new Map();                       // provider → models of it that failed in this ask
      const providerDown = (ref) => (failedHere.get(providerOf(ref))?.size ?? 0) >= 2;
      const nextFallback = () => {
        const f = fallbacks.find((c) => !used.has(c.ref) && !recentFailure(c.ref) && !providerDown(c.ref) && !(c.family && taken.has(c.family)));
        if (f) { used.add(f.ref); if (f.family) taken.add(f.family); }
        return f;
      };
      const attempt = async (m) => {
        try {
          return { ref: m.ref, ok: true, ...(await complete(m, question, "answer")) };
        } catch (error) {
          const message = String(error?.message || error).slice(0, 300);
          failures.set(m.ref, { at: now(), error: message, code: error?.code ?? null });
          const provider = providerOf(m.ref);
          // OpenRouter routes to many independent providers: its models fail one by one (a rate limit here, a region
          // block there), so two failures say nothing about the rest of it.
          if (error?.code !== "REASONING_ONLY" && provider !== "openrouter") {
            const set = failedHere.get(provider) ?? new Set();
            set.add(m.ref);
            failedHere.set(provider, set);
            if (set.size >= 2) failures.set(`provider:${provider}`, { at: now(), error: `${set.size} of its models failed: ${message}`, code: "PROVIDER" });
          }
          return { ref: m.ref, ok: false, error: message, code: error?.code ?? null };
        }
      };
      const answers = await Promise.all(models.map(async (m) => {
        const tried = [];
        let current = m;
        for (let i = 0; current && i < 4; i += 1) {
          const r = await attempt(current);
          if (r.ok) return { ...r, ...(tried.length ? { replaced: tried } : {}) };
          tried.push({ ref: r.ref, error: r.error });
          current = nextFallback();
        }
        return { ref: m.ref, ok: false, error: tried.map((t) => `${t.ref}: ${t.error}`).join("; "), tried };
      }));
      respond(true, { question, answers }, undefined);
    } catch (error) {
      failure(respond, error);
    }
  }, { scope: "operator.write" });

  api.registerGatewayMethod(METHODS.select, async ({ params, respond }) => {
    try {
      const question = text(params?.question, MAX_QUESTION, "question");
      if (!Array.isArray(params?.answers) || params.answers.length < 2 || params.answers.length > 6) throw new InputError("answers: 2 to 6 answers");
      const answers = params.answers.map((a, i) => text(a, MAX_ANSWER, `answers[${i}]`));
      const judge = model(params.judge, "judge");
      const result = await selectConsensus({ question, answers, complete: async (prompt) => (await complete(judge, prompt, "select")).text });
      respond(true, { ...result, judge: judge.ref }, undefined);
    } catch (error) {
      failure(respond, error);
    }
  }, { scope: "operator.write" });

  api.registerGatewayMethod(METHODS.merge, async ({ params, respond }) => {
    try {
      const question = text(params?.question, MAX_QUESTION, "question");
      if (!Array.isArray(params?.answers) || params.answers.length < 2 || params.answers.length > 6) throw new InputError("answers: 2 to 6 answers");
      const answers = params.answers.map((a, i) => text(a, MAX_ANSWER, `answers[${i}]`));
      const merger = model(params.model, "model");
      const merged = await complete(merger, mergePrompt(question, answers), "merge");
      respond(true, { text: merged.text, model: merger.ref, ms: merged.ms }, undefined);
    } catch (error) {
      failure(respond, error);
    }
  }, { scope: "operator.write" });

  const controls = api.session?.controls?.registerControlUiDescriptor ? api.session.controls : api;
  controls.registerControlUiDescriptor?.({
    surface: "tab", id: TAB_ID, slug: TAB_ID, label: "Multi-model",
    description: "Ask several models at once, pick the most consistent answer or merge them; roles and models",
    icon: "layers", group: "control", requiredScopes: ["operator.read"],
  });
  return { settings, arenaSource };
}
