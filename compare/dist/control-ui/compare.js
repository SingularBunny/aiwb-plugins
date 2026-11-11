// Multi-model page for the OpenClaw Control UI (native plugin view, hand-written, no build step).
// Roles: which models answer (auto: the top free models of different families by Arena rating, or a manual
// list), the judge that picks the most consistent answer, the merger, the default model. The models come from
// models.list (every provider OpenClaw has); the ranking from aiwb-compare.rank. "Try it" asks the answering
// models and shows the answers side by side, with "Pick the most consistent" and "Merge".

const PLUGIN_ID = "aiwb-compare";
const PAGE_ID = "multi-model";
const M = { state: `${PLUGIN_ID}.state`, rank: `${PLUGIN_ID}.rank`, settings: `${PLUGIN_ID}.settings`,
  ask: `${PLUGIN_ID}.ask`, select: `${PLUGIN_ID}.select`, merge: `${PLUGIN_ID}.merge` };

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
const hint = (...t) => el("p", { class: "aiwb-compare__hint" }, ...t);
const message = (tone, ...t) => el("p", { class: `aiwb-compare__message tone-${tone}`, role: tone === "danger" ? "alert" : "status" }, ...t);

/** The models a role resolves to: "auto" takes the suggestion. */
export function resolveRoles(settings, suggested) {
  const pick = (role, fallback) => (role?.ref && role.ref !== "auto" ? role : fallback ? { ref: fallback.ref, runtime: fallback.runtime } : null);
  const answerers = settings.answerers.mode === "manual" && settings.answerers.models.length
    ? settings.answerers.models : (suggested?.answerers || []).map((m) => ({ ref: m.ref, runtime: m.runtime }));
  const judge = pick(settings.judge, suggested?.judge);
  return { answerers, judge, merger: pick(settings.merger, judge), defaultModel: pick(settings.defaultModel, judge) };
}

function mountComparePage(container, context) {
  let ctx = context;
  const host = context.host;
  let state = null;
  let ranking = null;
  let draft = null;
  let error = "";
  let notice = "";
  let busy = "";
  let trial = null;
  let disposed = false;
  let showAll = false;
  const page = el("section", { class: "aiwb-compare" });
  container.append(page);
  const canAdmin = () => Boolean(host.connection?.connected && host.connection?.canAdmin);
  const canWrite = () => Boolean(host.connection?.connected);

  async function refresh(force = false) {
    if (!host.connection?.connected) { error = "Not connected to the Gateway."; render(); return; }
    busy = "loading";
    render();
    try {
      state = await host.request(M.state, {});
      const catalog = await host.request("models.list", { view: "all" });
      ranking = await host.request(M.rank, { models: catalog.models || [], refresh: force });
      if (!draft) draft = structuredClone(state.settings);
      error = "";
    } catch (failure) {
      error = `Not loaded: ${failure?.message || failure}`;
    } finally {
      busy = "";
    }
    if (!disposed) render();
  }

  const modelLabel = (ref) => {
    const m = ranking?.ranked.find((r) => r.ref === ref);
    return m ? `${m.name}${m.free ? " · free" : ""}${m.rating ? ` · Arena ${m.rating}` : ""}` : ref;
  };
  const runtimeOf = (ref) => ranking?.ranked.find((r) => r.ref === ref)?.runtime ?? null;

  function roleSelect(label, key, autoText) {
    const value = draft[key]?.ref || "auto";
    const select = el("select", { "aria-label": label, disabled: !canAdmin(), onchange: () => {
      draft[key] = select.value === "auto" ? { ref: "auto", runtime: null } : { ref: select.value, runtime: runtimeOf(select.value) };
      render();
    } },
    el("option", { value: "auto", selected: value === "auto" }, `auto — ${autoText}`),
    (ranking?.ranked || []).map((m) => el("option", { value: m.ref, selected: m.ref === value }, `${m.ref}${m.free ? " (free)" : ""}${m.rating ? ` — ${m.rating}` : ""}`)));
    return el("label", { class: "aiwb-compare__field" }, el("span", {}, label), select);
  }

  function rolesSection() {
    if (!draft || !ranking) return null;
    const roles = resolveRoles(draft, ranking.suggested);
    const manual = draft.answerers.mode === "manual";
    const count = el("select", { "aria-label": "How many", disabled: !canAdmin(), onchange: () => { draft.answerers.count = Number(count.value); render(); } },
      [2, 3, 4, 5, 6].map((n) => el("option", { value: String(n), selected: n === draft.answerers.count }, String(n))));
    const mode = el("select", { "aria-label": "Answering models", disabled: !canAdmin(), onchange: () => { draft.answerers.mode = mode.value; render(); } },
      el("option", { value: "auto", selected: !manual }, "auto — top free models, one per family"),
      el("option", { value: "manual", selected: manual }, "manual — the models ticked in the table below"));
    const changed = JSON.stringify(draft) !== JSON.stringify(state.settings);
    return el("section", { class: "aiwb-compare__section" },
      el("h2", {}, "Roles"),
      el("div", { class: "aiwb-compare__grid" },
        el("label", { class: "aiwb-compare__field" }, el("span", {}, "Answering models"), mode),
        manual ? null : el("label", { class: "aiwb-compare__field" }, el("span", {}, "How many"), count),
        roleSelect("Judge (picks the most consistent answer)", "judge",
          ranking.suggested.judge ? `${ranking.suggested.judge.ref}: strongest rated model of another family` : "none found"),
        roleSelect("Merger (writes one answer from all)", "merger", "the judge"),
        roleSelect("Default model", "defaultModel", "the judge")),
      el("p", { class: "aiwb-compare__now" }, "Now: ",
        roles.answerers.length ? roles.answerers.map((m) => modelLabel(m.ref)).join(", ") : "no answering models", " → judge ",
        roles.judge ? modelLabel(roles.judge.ref) : "none"),
      hint(`A question costs ${roles.answerers.length} model call${roles.answerers.length === 1 ? "" : "s"}; picking the most consistent answer adds 2 judge calls (two orders), merging 1 call of the merger.`),
      canAdmin()
        ? el("div", { class: "aiwb-compare__actions" },
          el("button", { type: "button", class: "btn primary", disabled: !changed || Boolean(busy), onclick: save }, "Save"),
          el("button", { type: "button", class: "btn", disabled: !changed || Boolean(busy), onclick: () => { draft = structuredClone(state.settings); render(); } }, "Revert"))
        : hint("Saving roles needs an operator.admin connection."));
  }

  async function save() {
    busy = "saving";
    render();
    try {
      const r = await host.request(M.settings, { settings: draft });
      state.settings = r.settings;
      draft = structuredClone(r.settings);
      notice = "Roles saved.";
      await refresh();
    } catch (failure) {
      error = `Not saved: ${failure?.message || failure}`;
    } finally {
      busy = "";
      render();
    }
  }

  function candidatesSection() {
    if (!ranking) return null;
    const roles = resolveRoles(draft, ranking.suggested);
    const answering = new Set(roles.answerers.map((m) => m.ref));
    const manual = draft.answerers.mode === "manual";
    const rows = ranking.ranked.filter((m) => showAll || m.free || answering.has(m.ref) || m.ref === roles.judge?.ref).slice(0, showAll ? 400 : 60);
    const a = ranking.arena;
    return el("section", { class: "aiwb-compare__section" },
      el("div", { class: "aiwb-compare__section-head" },
        el("h2", {}, showAll ? "All models" : "Free models"),
        el("label", { class: "aiwb-compare__hint" }, el("input", { type: "checkbox", checked: showAll, onchange: (e) => { showAll = e.target.checked; render(); } }), " all models"),
        el("button", { type: "button", class: "btn btn--sm", disabled: Boolean(busy), onclick: () => refresh(true) }, "Refresh rating")),
      a.count
        ? hint(`Arena text rating of ${a.date} (${a.count} models)${a.stale ? " — refresh failed, using the saved snapshot" : ""}. Models Arena does not list have no rating and come after.`)
        : message("warn", `No Arena rating${a.error ? ` (${a.error})` : ""}: models are in catalog order.`),
      el("table", { class: "aiwb-compare__table" },
        el("thead", {}, el("tr", {}, [manual ? "Use" : "", "Model", "Family", "Arena", "Role"].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.map((m) => el("tr", {},
          el("td", {}, manual ? el("input", { type: "checkbox", disabled: !canAdmin(), checked: draft.answerers.models.some((x) => x.ref === m.ref),
            "aria-label": `Use ${m.ref}`, onchange: (e) => {
              const list = draft.answerers.models.filter((x) => x.ref !== m.ref);
              if (e.target.checked && list.length < 6) list.push({ ref: m.ref, runtime: m.runtime });
              draft.answerers.models = list;
              render();
            } }) : ""),
          el("td", {}, el("code", {}, m.ref), m.free ? el("span", { class: "aiwb-compare__badge" }, "free") : null,
            m.failed ? el("span", { class: "aiwb-compare__badge tone-warn", title: m.failed }, "failed recently") : null),
          el("td", {}, m.family),
          el("td", { class: "aiwb-compare__num", title: m.arenaName ? `${m.arenaName}${m.ratingRange ? `, ${m.ratingRange[0]}–${m.ratingRange[1]}` : ""}` : "" }, m.rating ?? "—"),
          el("td", {}, answering.has(m.ref) ? "answers" : m.ref === roles.judge?.ref ? "judge" : ""))))));
  }

  async function ask(question) {
    const roles = resolveRoles(draft, ranking.suggested);
    if (!roles.answerers.length) { error = "No answering models."; render(); return; }
    trial = { question, answers: roles.answerers.map((m) => ({ ref: m.ref, pending: true })), select: null, merge: null };
    busy = "asking";
    render();
    try {
      // The rest of the free ranking replaces a model that fails (region-blocked, rate-limited), one per family.
      const familyOf = (ref) => ranking.ranked.find((m) => m.ref === ref)?.family ?? null;
      const fallbacks = ranking.ranked.filter((m) => m.free && !m.failed && !roles.answerers.some((a) => a.ref === m.ref))
        .map((m) => ({ ref: m.ref, runtime: m.runtime, family: m.family }));
      const r = await host.request(M.ask, { question, models: roles.answerers.map((m) => ({ ...m, family: familyOf(m.ref) })), fallbacks });
      trial.answers = r.answers;
    } catch (failure) {
      error = `Not asked: ${failure?.message || failure}`;
    } finally {
      busy = "";
      render();
    }
  }

  const okAnswers = () => (trial?.answers || []).filter((a) => a.ok);

  async function pick() {
    const roles = resolveRoles(draft, ranking.suggested);
    if (!roles.judge) { error = "No judge."; render(); return; }
    busy = "selecting";
    render();
    try {
      const good = okAnswers();
      const r = await host.request(M.select, { question: trial.question, answers: good.map((a) => a.text), judge: roles.judge });
      trial.select = { ...r, refs: good.map((a) => a.ref) };
    } catch (failure) {
      error = `Not picked: ${failure?.message || failure}`;
    } finally {
      busy = "";
      render();
    }
  }

  async function merge() {
    const roles = resolveRoles(draft, ranking.suggested);
    busy = "merging";
    render();
    try {
      trial.merge = await host.request(M.merge, { question: trial.question, answers: okAnswers().map((a) => a.text), model: roles.merger });
    } catch (failure) {
      error = `Not merged: ${failure?.message || failure}`;
    } finally {
      busy = "";
      render();
    }
  }

  const redact = (t) => (typeof host.redact === "function" ? host.redact(t) : t);

  function trySection() {
    if (!ranking) return null;
    const box = el("textarea", { class: "aiwb-compare__question", rows: 3, placeholder: "A question for every answering model", "aria-label": "Question" }, trial?.question || "");
    const chosen = trial?.select?.agreed ? trial.select.refs[trial.select.choice] : null;
    return el("section", { class: "aiwb-compare__section" },
      el("h2", {}, "Try it"),
      box,
      el("div", { class: "aiwb-compare__actions" },
        el("button", { type: "button", class: "btn primary", disabled: Boolean(busy) || !canWrite(), onclick: () => box.value.trim() && ask(box.value.trim()) },
          busy === "asking" ? "Asking…" : "Ask the models"),
        trial && okAnswers().length >= 2 ? [
          el("button", { type: "button", class: "btn", disabled: Boolean(busy), onclick: pick }, busy === "selecting" ? "Picking…" : "Pick the most consistent"),
          el("button", { type: "button", class: "btn", disabled: Boolean(busy), onclick: merge }, busy === "merging" ? "Merging…" : "Merge (synthesis)"),
        ] : null),
      trial ? el("div", { class: "aiwb-compare__answers" }, trial.answers.map((a) => el("article", { class: `aiwb-compare__answer${a.ref === chosen ? " is-chosen" : ""}` },
        el("h3", {}, modelLabel(a.ref), a.ref === chosen ? el("span", { class: "aiwb-compare__badge tone-ok" }, "most consistent") : null),
        a.pending ? hint("waiting…") : a.ok ? el("pre", { class: "aiwb-compare__text" }, redact(a.text)) : message("danger", a.error || "failed"),
        a.ok ? hint(`${Math.round(a.ms / 100) / 10} s`, a.replaced ? ` · instead of ${a.replaced.map((x) => `${x.ref} (${x.error})`).join(", ")}` : "") : null))) : null,
      trial?.select ? el("div", { class: "aiwb-compare__verdict" },
        trial.select.agreed
          ? message("ok", `Most consistent: ${modelLabel(chosen)} — the judge picked it in both orders.`)
          : message("warn", "No clear agreement: the judge picked different answers in the two orders",
            trial.select.picks.some((p) => p === null) ? " (or named none)" : "", "."),
        el("details", {}, el("summary", {}, `Judge notes (${trial.select.judge})`), trial.select.notes.map((n) => el("pre", { class: "aiwb-compare__text" }, redact(n))))) : null,
      trial?.merge ? el("article", { class: "aiwb-compare__answer is-merged" },
        el("h3", {}, `Merged by ${modelLabel(trial.merge.model)}`, el("span", { class: "aiwb-compare__badge" }, "synthesis")),
        el("pre", { class: "aiwb-compare__text" }, redact(trial.merge.text))) : null);
  }

  function render() {
    if (disposed) return;
    page.replaceChildren(
      el("header", { class: "aiwb-compare__header" },
        el("div", {}, el("h1", {}, "Multi-model"),
          hint("Several models answer the same question; a judge of another family picks the most consistent answer, or one model merges them.")),
        el("button", { type: "button", class: "btn", disabled: Boolean(busy), onclick: () => refresh() }, busy === "loading" ? "Loading…" : "Refresh")),
      error ? message("danger", error) : null,
      notice ? message("ok", notice) : null,
      rolesSection(), trySection(), candidatesSection());
  }

  const unsubscribe = host.subscribe?.(() => { if (!disposed && host.connection?.connected && !ranking) void refresh(); });
  render();
  void refresh();
  return {
    update(next) {
      const was = ctx.presented;
      ctx = next;
      if (ctx.presented && !was && !busy) void refresh();
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      page.remove();
    },
  };
}

export default {
  id: PLUGIN_ID,
  activate(host) {
    const dispose = host.ui.registerPage({ id: PAGE_ID, label: "Multi-model", mount: mountComparePage });
    return () => dispose?.();
  },
};

export { mountComparePage };
