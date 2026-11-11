import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createArenaSource, loadArena, matchArena, nameTokens } from "../compare/arena.js";
import { familyOf, pickAnswerers, pickJudge, rankModels } from "../compare/candidates.js";
import { mergePrompt, parseChoice, selectConsensus, selectionPrompt } from "../compare/consensus.js";
import { METHODS, readSettings, registerCompare } from "../compare/register.js";
import ui, { continueMessage, resolveRoles } from "../compare/dist/control-ui/compare.js";

// Arena rows in the dataset's shape; names as Arena writes them.
const ARENA = [
  { model_name: "Claude Opus 9 (High)", organization: "anthropic", rating: 1510, rating_lower: 1504, rating_upper: 1516, rank: 3 },
  { model_name: "NVIDIA-Garden-3-Ultra-550B-A55B (NVFP4)", organization: "nvidia", rating: 1445, rank: 60 },
  { model_name: "NVIDIA-Garden-3.5-Super-VL-120B-A12B (NVFP4)", organization: "nvidia", rating: 1408, rank: 140 },
  { model_name: "Orchard 4 31B", organization: "google", rating: 1443, rank: 70 },
  { model_name: "Orchard 4 26B A4B", organization: "google", rating: 1434, rank: 90 },
  { model_name: "Quince 2 Small", organization: "quince-labs", rating: 1403, rank: 150 },
];
const row = (provider, id, extra = {}) => ({ provider, id, name: id, available: true, ...extra });
const CATALOG = [
  row("anthropic", "claude-opus-9", { reasoning: true, agentRuntime: { id: "claude-cli" } }),
  row("openrouter", "nvidia/garden-3-ultra-550b-a55b:free"),
  row("openrouter", "nvidia/garden-3.5-super-vl:free"),
  row("openrouter", "nvidia/garden-3-nano-30b-a3b:free"),
  row("openrouter", "google/orchard-4-31b-it:free"),
  row("openrouter", "google/orchard-4-26b-a4b-it:free"),
  row("openrouter", "quince-labs/quince-2-small:free"),
  row("openrouter", "plum/plum-1:free"),
  row("openrouter", "google/orchard-4-31b-it", { reasoning: true }),
  row("openrouter", "gone/model:free", { available: false }),
];

test("compare: Arena match by name parts, sizes kept whole, no neighbour's rating for an unlisted model", () => {
  assert.deepEqual(nameTokens("NVIDIA-Garden-3.5-Super-VL-120B-A12B (NVFP4)"), ["garden", "3", "5", "super", "vl", "120b", "a12b"]);
  assert.deepEqual(nameTokens("orchard-4-31b-it:free"), ["orchard", "4", "31b"]);
  const name = (id) => matchArena(id, ARENA)?.model_name ?? null;
  assert.equal(name("openrouter/google/orchard-4-31b-it:free"), "Orchard 4 31B");
  assert.equal(name("openrouter/google/orchard-4-26b-a4b-it:free"), "Orchard 4 26B A4B");
  assert.equal(name("openrouter/nvidia/garden-3-ultra-550b-a55b:free"), "NVIDIA-Garden-3-Ultra-550B-A55B (NVFP4)");
  assert.equal(name("openrouter/nvidia/garden-3.5-super-vl:free"), "NVIDIA-Garden-3.5-Super-VL-120B-A12B (NVFP4)");
  assert.equal(name("openrouter/nvidia/garden-3-nano-30b-a3b:free"), null);
  assert.equal(name("openrouter/plum/plum-1:free"), null);
});

test("compare: answerers are the top free models of different families, the judge the best of another family", () => {
  const ranked = rankModels(CATALOG, ARENA);
  assert.equal(ranked.some((m) => m.ref === "openrouter/gone/model:free"), false);
  assert.equal(ranked[0].ref, "anthropic/claude-opus-9");
  assert.equal(familyOf({ provider: "openrouter", id: "google/x" }), "google");
  const answerers = pickAnswerers(ranked, 3);
  assert.deepEqual(answerers.map((m) => m.ref), ["openrouter/nvidia/garden-3-ultra-550b-a55b:free",
    "openrouter/google/orchard-4-31b-it:free", "openrouter/quince-labs/quince-2-small:free"]);
  const judge = pickJudge(ranked, answerers);
  assert.equal(judge.ref, "anthropic/claude-opus-9");
  assert.equal(judge.runtime, "claude-cli");
  // A paid model rated higher is never picked automatically: the judge costs nothing per call.
  const withPaid = rankModels([...CATALOG, row("openrouter", "carbon/carbon-9", { reasoning: true })],
    [...ARENA, { model_name: "Carbon 9", organization: "carbon", rating: 1600, rank: 1 }]);
  assert.equal(withPaid[0].ref, "openrouter/carbon/carbon-9");
  assert.equal(pickJudge(withPaid, answerers).ref, "anthropic/claude-opus-9");
  // With no other family rated, there is no judge rather than one judging its own family.
  assert.equal(pickJudge(ranked.filter((m) => m.family !== "anthropic"), answerers), null);
});

test("compare: the choice is made twice in two orders; different picks mean no agreement", async () => {
  assert.equal(parseChoice("The most consistent response is Response 2. They agree…", 3), 1);
  assert.equal(parseChoice("The most consistent response is Response 7", 3), null);
  assert.equal(parseChoice("I cannot tell", 3), null);
  const prompt = selectionPrompt("Q?", ["a", "b"]);
  assert.ok(prompt.includes("Response 1:\na") && prompt.includes("Response 2:\nb") && prompt.includes("not the longest"));
  // A judge that always names the content "b" wherever it is: agreement on answer 1 (0-based).
  const byContent = async (p) => `The most consistent response is Response ${p.indexOf("Response 1:\nb") >= 0 ? 1 : 2}`;
  const agreed = await selectConsensus({ question: "Q?", answers: ["a", "b"], complete: byContent });
  assert.deepEqual([agreed.choice, agreed.agreed, agreed.picks], [1, true, [1, 1]]);
  // A judge that always names the first position: the two orders pick different answers.
  const byPosition = async () => "The most consistent response is Response 1";
  const split = await selectConsensus({ question: "Q?", answers: ["a", "b", "c"], complete: byPosition });
  assert.deepEqual([split.choice, split.agreed, split.picks], [null, false, [0, 2]]);
  assert.ok(mergePrompt("Q?", ["a", "b"]).includes("Answer 2:\nb"));
});

test("compare: settings fall back to defaults; roles resolve auto to the suggestion", () => {
  const s = readSettings({ answerers: { mode: "manual", count: 99, models: [{ ref: "openrouter/x/y:free" }, { ref: "bad ref" }] }, judge: "nope", maxTokens: 5 });
  assert.deepEqual(s.answerers, { mode: "manual", count: 3, models: [{ ref: "openrouter/x/y:free", runtime: null }] });
  assert.deepEqual(s.judge, { ref: "auto", runtime: null });
  assert.equal(s.maxTokens, 2048);
  const suggested = { answerers: [{ ref: "a/1", runtime: null }, { ref: "b/2", runtime: null }], judge: { ref: "c/3", runtime: "claude-cli" } };
  const auto = resolveRoles(readSettings({}), suggested);
  assert.deepEqual(auto.answerers.map((m) => m.ref), ["a/1", "b/2"]);
  assert.deepEqual([auto.judge.ref, auto.merger.ref, auto.defaultModel.ref], ["c/3", "c/3", "c/3"]);
  assert.deepEqual(resolveRoles(s, suggested).answerers.map((m) => m.ref), ["openrouter/x/y:free"]);
});

test("compare: Arena snapshot is cached; a failed refresh serves the saved one marked stale", async () => {
  const cacheFile = path.join(mkdtempSync(path.join(os.tmpdir(), "arena-")), "arena.json");
  const page = { rows: ARENA.map((r) => ({ row: { ...r, category: "overall", leaderboard_publish_date: "2026-11-09" } })) };
  const fresh = await loadArena({ cacheFile, fetchJson: async () => page, now: 1000 });
  assert.deepEqual([fresh.rows.length, fresh.date, fresh.stale], [6, "2026-11-09", false]);
  assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).rows.length, 6);
  const failing = async () => { throw new Error("HTTP 500"); };
  const cached = await loadArena({ cacheFile, fetchJson: failing, now: 2000 });
  assert.equal(cached.stale, false);                       // within a day: no fetch at all
  const stale = await loadArena({ cacheFile, fetchJson: failing, now: 2000 + 2 * 86_400_000 });
  assert.deepEqual([stale.rows.length, stale.stale, stale.error], [6, true, "HTTP 500"]);
  const none = await loadArena({ cacheFile: `${cacheFile}.missing`, fetchJson: failing, now: 1 });
  assert.deepEqual([none.rows.length, none.stale], [0, true]);
});

test("compare: Arena rows are paged until the overall category ends; reads never wait for the network", async () => {
  const cacheFile = path.join(mkdtempSync(path.join(os.tmpdir(), "arena-")), "arena.json");
  const r = (name, category) => ({ row: { model_name: name, organization: "x", rating: 1400, category, leaderboard_publish_date: "2026-11-09" } });
  const pages = [
    { rows: Array.from({ length: 100 }, (_, i) => r(`m${i}`, "overall")) },
    { rows: [...Array.from({ length: 21 }, (_, i) => r(`n${i}`, "overall")), ...Array.from({ length: 79 }, (_, i) => r(`c${i}`, "chinese"))] },
    { rows: Array.from({ length: 100 }, (_, i) => r(`z${i}`, "chinese")) },
  ];
  const asked = [];
  const fetchJson = async (url) => { const offset = Number(new URL(url).searchParams.get("offset")); asked.push(offset); return pages[offset / 100]; };
  const got = await loadArena({ cacheFile, fetchJson, now: 1 });
  assert.equal(got.rows.length, 121);
  assert.deepEqual(asked, [0, 100]);                        // stopped where "overall" ended
  // The source answers at once from the cache and refreshes a day-old one in the background.
  let release;
  const slow = () => new Promise((resolve) => { release = () => resolve(pages[0]); });
  let clock = 1 + 2 * 86_400_000;
  const source = createArenaSource({ cacheFile, fetchJson: slow, now: () => clock });
  const read = source.read();
  assert.deepEqual([read.rows.length, read.stale, read.loading], [121, true, true]);
  const empty = createArenaSource({ cacheFile: `${cacheFile}.none`, fetchJson: async () => { throw new Error("down"); } }).read();
  assert.deepEqual([empty.rows.length, empty.stale], [0, true]);
  release?.();
});

test("compare plugin: scopes, parallel asking with one failure, CLI models through the isolated runtime", async () => {
  const methods = {};
  const calls = [];
  const api = {
    pluginConfig: {},
    registerGatewayMethod: (name, handler, opts) => { methods[name] = { handler, scope: opts.scope }; },
    registerControlUiDescriptor: () => {},
    runtime: {
      config: { current: () => ({}), mutateConfigFile: async ({ mutate }) => { const d = {}; mutate(d); calls.push(["config", d]); } },
      llm: { complete: async (p) => {
        calls.push(["llm", p.model, p.execution?.mode ?? "direct"]);
        if (p.model === "openrouter/bad/model:free") throw Object.assign(new Error("rate limited"), { code: "LLM_COMPLETION_FAILED" });
        if (p.model.startsWith("paid/")) return { text: "", stopReason: "error", model: p.model };
        if (p.model === "openrouter/empty/model:free") return { text: "", stopReason: "error", model: p.model };
        if (p.model === "openrouter/thinker/model:free") return { text: "", stopReason: "stop", model: p.model };
        if (p.purpose.endsWith(".select")) return { text: "The most consistent response is Response 1", model: p.model };
        return { text: `answer of ${p.model}`, model: p.model };
      } },
    },
  };
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "cmp-"));
  registerCompare(api, { stateDir, fetchJson: async () => ({ rows: [] }) });
  const call = (name, params) => new Promise((resolve) => methods[name].handler({ params, respond: (ok, payload, error) => resolve({ ok, payload, error }) }));
  assert.deepEqual(Object.fromEntries(Object.entries(methods).map(([k, v]) => [k.split(".").pop(), v.scope])),
    { state: "operator.read", rank: "operator.read", settings: "operator.admin", ask: "operator.write", select: "operator.write", merge: "operator.write" });

  const asked = await call(METHODS.ask, { question: "Why is the sky blue?", models: [{ ref: "openrouter/a/one:free" }, { ref: "openrouter/bad/model:free" }] });
  assert.equal(asked.ok, true);
  assert.deepEqual(asked.payload.answers.map((a) => [a.ref, a.ok]), [["openrouter/a/one:free", true], ["openrouter/bad/model:free", false]]);
  assert.match(asked.payload.answers[1].error, /rate limited/);
  // A failed model is replaced by the next fallback of a family not answering yet; an empty completion is a failure.
  const replaced = await call(METHODS.ask, { question: "Q", models: [{ ref: "openrouter/a/one:free", family: "a" }, { ref: "openrouter/bad/model:free", family: "bad" }],
    fallbacks: [{ ref: "openrouter/a/two:free", family: "a" }, { ref: "openrouter/empty/model:free", family: "empty" }, { ref: "openrouter/c/three:free", family: "c" }] });
  assert.deepEqual(replaced.payload.answers.map((a) => [a.ref, a.ok]), [["openrouter/a/one:free", true], ["openrouter/c/three:free", true]]);
  assert.deepEqual(replaced.payload.answers[1].replaced.map((x) => x.ref), ["openrouter/bad/model:free", "openrouter/empty/model:free"]);
  assert.match(replaced.payload.answers[1].replaced[1].error, /no answer \(stop reason: error\)/);
  // Failed models are marked in the ranking and not suggested again for a while.
  const ranked = await call(METHODS.rank, { models: [{ provider: "openrouter", id: "bad/model:free", available: true }, { provider: "openrouter", id: "c/three:free", available: true }] });
  assert.ok(ranked.payload.ranked.find((m) => m.ref === "openrouter/bad/model:free").failed);
  assert.deepEqual(ranked.payload.suggested.answerers.map((m) => m.ref), ["openrouter/c/three:free"]);
  // Two models of one provider failing in one ask: its other models are skipped, and it rests as a whole.
  const down = await call(METHODS.ask, { question: "Q", models: [{ ref: "paid/x1", family: "x" }, { ref: "paid/y1", family: "y" }],
    fallbacks: [{ ref: "paid/z1", family: "z" }, { ref: "openrouter/w/ok:free", family: "w" }] });
  assert.deepEqual(down.payload.answers.map((a) => [a.ref, a.ok]).sort(), [["openrouter/w/ok:free", true], ["paid/y1", false]].sort());
  assert.ok(!calls.some((c) => c[1] === "paid/z1"), "a provider that failed twice is not tried again");
  const reranked = await call(METHODS.rank, { models: [{ provider: "paid", id: "z1", available: true }] });
  assert.ok(reranked.payload.ranked[0].failed);
  const thinker = await call(METHODS.ask, { question: "Q", models: [{ ref: "openrouter/thinker/model:free" }] });
  assert.match(thinker.payload.answers[0].error, /only reasoning/);

  const picked = await call(METHODS.select, { question: "Q?", answers: ["x", "y"], judge: { ref: "anthropic/claude-opus-9", runtime: "claude-cli" } });
  assert.equal(picked.ok, true);
  assert.equal(picked.payload.agreed, false);              // "Response 1" in both orders is two different answers
  assert.ok(calls.filter((c) => c[0] === "llm" && c[1] === "anthropic/claude-opus-9").every((c) => c[2] === "isolated-agent-runtime"));
  assert.ok(calls.filter((c) => c[0] === "llm" && c[1].startsWith("openrouter/")).every((c) => c[2] === "direct"));

  for (const bad of [{ question: "", models: [{ ref: "a/b" }] }, { question: "q", models: [] }, { question: "q", models: [{ ref: "no-slash" }] }]) {
    const r = await call(METHODS.ask, bad);
    assert.equal(r.error.code, "INVALID_REQUEST", JSON.stringify(bad));
  }
  const saved = await call(METHODS.settings, { settings: { answerers: { mode: "auto", count: 4 }, judge: "anthropic/claude-opus-9" } });
  assert.equal(saved.ok, true);
  const written = calls.find((c) => c[0] === "config")[1].plugins.entries["aiwb-compare"].config;
  assert.deepEqual([written.answerers.count, written.judge.ref], [4, "anthropic/claude-opus-9"]);
});

test("compare UI: a page, a session panel and a composer action that opens the panel for that chat", () => {
  const registered = { pages: [], panels: [], actions: [] };
  const opened = [];
  const host = { ui: {
    registerPage: (p) => { registered.pages.push(p.id); return () => {}; },
    registerPanel: (p) => { registered.panels.push(p.id); return () => {}; },
    registerAction: (a) => { registered.actions.push(a); return () => {}; },
    openPanel: (id, session) => opened.push([id, session]),
  } };
  const dispose = ui.activate(host);
  assert.deepEqual([registered.pages, registered.panels], [["multi-model"], ["multi-model"]]);
  const [action] = registered.actions;
  assert.deepEqual([action.id, action.placement, action.label], ["ask-several", "composer", "Several models"]);
  action.run({ sessionKey: "agent:garden:main", agentId: "garden", host });
  assert.deepEqual(opened, [["multi-model", { sessionKey: "agent:garden:main", agentId: "garden" }]]);
  dispose();
  // The message that carries the chosen answer into the chat names the question, the kind and the model.
  assert.equal(continueMessage("Why?", "Most consistent answer", "groq/x", "Because."),
    'I asked several models: "Why?"\n\nMost consistent answer (groq/x):\n\nBecause.');
});
