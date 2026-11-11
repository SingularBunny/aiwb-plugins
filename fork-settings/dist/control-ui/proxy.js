// Proxy page for the OpenClaw Control UI (native plugin view, hand-written, no build step). The
// entry also registers the Chat files page (chat-files.js).
// Reads aiwb-fork-settings.proxy; route and CLI backend lists are edited locally and saved through
// aiwb-fork-settings.set (operator.admin) after a confirmation that shows the resulting value. Proxy
// URLs never reach the page: the address is scheme://host:port, a URL target of a rule is `url:<n>`
// and the Gateway puts the stored URL back on save. The check (aiwb-fork-settings.proxyCheck,
// operator.admin) requests each host directly and through the managed proxy.
import { mountChatFilesPage, PAGE_ID as CHAT_FILES_PAGE_ID } from "./chat-files.js";
import { badge, createDialogs, el, hint, message } from "./ui.js";

const PLUGIN_ID = "aiwb-fork-settings";
const PAGE_ID = "proxy";
const METHODS = { proxy: `${PLUGIN_ID}.proxy`, set: `${PLUGIN_ID}.set`, check: `${PLUGIN_ID}.proxyCheck` };
const ROUTES = "OPENCLAW_PROXY_ROUTES";
const BACKENDS = "OPENCLAW_CLI_BACKEND_PROXY";
const HOST_SUFFIX = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const BACKEND_ID = /^[a-z0-9][a-z0-9._-]*$/;
const ERRORS = {
  timeout: "timeout", refused: "connection refused", dns: "DNS failure", reset: "connection reset",
  unreachable: "network unreachable", tls: "TLS error", proxy: "proxy refused", error: "error",
};

/** Host suffix as the fork normalizes it, or null. */
export function normalizeHost(raw) {
  const value = String(raw ?? "").trim().toLowerCase().replace(/^\*?\./, "").replace(/\.$/, "");
  return HOST_SUFFIX.test(value) ? value : null;
}

/** The value a list would be saved as, with URL targets shown as <proxy URL>. Mirrors proxy.js composeRules. */
export function previewValue(kind, draft) {
  const shown = (t) => (t === "proxy" || t === "direct" ? t : "<proxy URL>");
  const groups = new Map();
  for (const e of draft.entries) {
    if (!groups.has(e.target)) groups.set(e.target, []);
    groups.get(e.target).push(e.key);
  }
  const rules = kind === "routes"
    ? [...groups].map(([t, keys]) => `${keys.join(",")}=${shown(t)}`)
    : [...groups].flatMap(([t, keys]) => keys.map((k) => `${k}=${shown(t)}`));
  if (kind === "routes" && draft.fallback) rules.push(`*=${shown(draft.fallback)}`);
  return rules.join(";");
}

const cloneDraft = (editor) => ({ entries: (editor?.entries || []).map((e) => ({ ...e })), fallback: editor?.fallback ?? null });
const sameDraft = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const targetLabel = (t) => (t === "proxy" ? "proxy" : t === "direct" ? "direct" : `<proxy URL #${Number(String(t).slice(4)) + 1}>`);

function mountProxyPage(container, context) {
  let ctx = context;
  const host = context.host;
  let data = null;
  let error = "";
  let notice = "";
  let loading = false;
  let saving = false;
  let checking = false;
  let check = null;
  let checkError = "";
  let extraHosts = "";
  let disposed = false;
  const drafts = { [ROUTES]: null, [BACKENDS]: null };
  const page = el("section", { class: "aiwb-proxy" });
  const overlay = el("div");
  container.append(page, overlay);
  const clock = new Intl.DateTimeFormat(host.locale || undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const canAdmin = () => Boolean(host.connection?.connected && host.connection?.canAdmin);
  const editorOf = (name) => (name === ROUTES ? data?.routes?.editor : data?.backends?.editor);
  const dirty = (name) => Boolean(drafts[name] && !sameDraft({ entries: drafts[name].entries, fallback: drafts[name].fallback }, drafts[name].origin));
  const freshDraft = (editor) => ({ ...cloneDraft(editor), revision: editor.revision, origin: cloneDraft(editor) });

  const dialogs = createDialogs(host, overlay);
  const closeDialog = dialogs.close;
  const confirm = dialogs.confirm;

  async function refresh() {
    if (disposed || loading) return;
    if (!host.connection?.connected) {
      error = "Not connected to the Gateway.";
      render();
      return;
    }
    loading = true;
    render();
    try {
      data = await host.request(METHODS.proxy, {});
      for (const name of [ROUTES, BACKENDS]) {
        // Keep unsaved edits; start from the stored value otherwise.
        if (!dirty(name)) drafts[name] = freshDraft(editorOf(name));
      }
      if (error.startsWith("Proxy data")) error = "";
    } catch (failure) {
      error = `Proxy data unavailable: ${failure?.message || failure}`;
    } finally {
      loading = false;
    }
    render();
  }

  const draftBody = (name) => ({ entries: drafts[name].entries.map(({ key, target }) => ({ key, target })), fallback: name === ROUTES ? drafts[name].fallback : null });

  async function save(name) {
    if (!canAdmin() || saving) return;
    const kind = name === ROUTES ? "routes" : "backends";
    const params = { name, rules: draftBody(name), revision: drafts[name].revision };
    saving = true;
    error = "";
    notice = "";
    render();
    try {
      const preview = await host.request(METHODS.set, { ...params, dryRun: true });
      const result = preview.unset ? `${name} is removed` : `${name}=${preview.stored}`;
      const body = el("div", { class: "aiwb-proxy__confirm" },
        el("p", {}, preview.unset
          ? (kind === "routes" ? "The list is empty: the setting is removed and everything goes through the proxy (upstream)." : "The list is empty: the setting is removed; backends follow their API host route.")
          : "The setting will be written to env.vars:"),
        el("pre", { class: "aiwb-proxy__code" }, result),
        preview.overriddenByEnvironment ? message("warn", "A value from the process environment or ~/.openclaw/.env wins over env.vars; this change has no effect until it is removed there.") : null,
        preview.installerNote ? message("warn", preview.installerNote) : null,
        hint("The Gateway reloads env.vars; the fork reads the value on its next request."));
      saving = false;
      render();
      if (!(await confirm(`Save ${kind === "routes" ? "proxy routes" : "CLI backend proxy"}`, body)) || disposed) return;
      saving = true;
      render();
      const done = await host.request(METHODS.set, params);
      notice = `Saved: ${done.unset ? `${name} removed` : `${name}=${done.stored}`}.${done.installerNote ? ` ${done.installerNote}.` : ""}`;
      drafts[name] = null;
    } catch (failure) {
      error = `Not saved: ${failure?.message || failure}`;
    } finally {
      saving = false;
    }
    await refresh();
  }

  async function runCheck() {
    if (!canAdmin() || checking) return;
    const hosts = extraHosts.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
    const bad = hosts.find((h) => !normalizeHost(h));
    if (bad) {
      checkError = `Not a host name: ${bad}`;
      render();
      return;
    }
    checking = true;
    checkError = "";
    render();
    try {
      check = await host.request(METHODS.check, { hosts });
    } catch (failure) {
      checkError = `Check failed: ${failure?.message || failure}`;
    } finally {
      checking = false;
    }
    render();
  }

  function addRoute(hostName, target) {
    const key = normalizeHost(hostName);
    const draft = drafts[ROUTES];
    if (!key || !draft) return false;
    const existing = draft.entries.find((e) => e.key === key);
    if (existing) existing.target = target;
    else draft.entries.push({ key, target });
    render();
    return true;
  }

  function header() {
    const updated = data ? `Updated ${clock.format(new Date(data.generatedAt))}` : "";
    return el("header", { class: "aiwb-proxy__header" },
      el("div", {}, el("h1", {}, "Proxy"),
        hint("OpenClaw's managed proxy, which hosts use it (fork routes), the proxy of CLI agent backends, and a reachability check.")),
      el("div", { class: "aiwb-proxy__toolbar" },
        el("span", { class: "aiwb-proxy__hint", "aria-live": "polite" }, loading ? "Refreshing…" : updated),
        el("button", { type: "button", class: "btn", disabled: loading, onclick: refresh }, "Refresh")));
  }

  function messages() {
    const out = [];
    if (error) out.push(message("danger", error));
    if (notice) out.push(message("ok", notice));
    if (data && !canAdmin()) out.push(hint("Saving and the check need an operator.admin connection; this one can only view."));
    if (data && !data.fork) out.push(message("warn", "This OpenClaw is not the fork: OPENCLAW_PROXY_ROUTES and OPENCLAW_CLI_BACKEND_PROXY change nothing, all OpenClaw traffic goes through the proxy."));
    if (data?.installer?.rewritesRoutes) {
      out.push(message("warn", "The installer key ", el("code", {}, "WORKBENCH_PROXY_HOSTS"), " (or ", el("code", {}, "WORKBENCH_PROXY_ROUTES"),
        ") in ~/.openclaw/.env sets the routes on each install: edits made here are overwritten by the next install unless the .env key is updated too."));
    }
    return out;
  }

  function row(label, ...value) {
    return el("tr", {}, el("th", { scope: "row" }, label), el("td", {}, ...value));
  }

  function proxySection() {
    const p = data?.proxy;
    if (!p) return null;
    const r = data.routes;
    const routeBadge = r.state === "active" ? badge("active", "ok")
      : r.state === "invalid" ? badge("invalid", "danger", r.reason) : badge("unset", "muted");
    const effect = r.effect === "proxy-inactive"
      ? "The managed proxy is not active in this Gateway: OpenClaw connects directly and the routes have no effect."
      : r.effect === "routes" ? "The routes below decide which hosts use the proxy."
      : r.state === "invalid" ? `The fork ignores the routes (${r.reason}) and sends everything through the proxy.`
      : "No routes: everything goes through the proxy (upstream).";
    return el("section", { class: "aiwb-proxy__section" },
      el("h2", {}, "Managed proxy"),
      el("table", { class: "aiwb-proxy__table aiwb-proxy__facts" }, el("tbody", {},
        row("Address", p.address ? el("code", {}, p.address) : "not configured", p.source ? el("span", { class: "aiwb-proxy__hint" }, ` from ${p.source}`) : null),
        row("Enabled", p.enabled ? badge("yes", "ok") : badge("no", "muted", p.configured ? "proxy.enabled is false" : "no proxy URL")),
        row("Active in this Gateway", p.active ? badge("yes", "ok") : badge("no", p.enabled ? "warn" : "muted", p.enabled ? "enabled but not active: restart the Gateway after a proxy change" : undefined)),
        row("Fork routes", routeBadge, r.reason ? el("span", { class: "aiwb-proxy__hint" }, ` ${r.reason}`) : null),
        row("Loopback", p.loopbackMode),
        p.customCa ? row("Proxy CA", "custom CA file") : null)),
      hint(effect));
  }

  function targetSelect(value, onchange, { urls, allowNone, label }) {
    const options = ["proxy", "direct", ...urls];
    if (value && !options.includes(value)) options.push(value);
    const select = el("select", { "aria-label": label, disabled: !canAdmin(), onchange: () => onchange(select.value || null) },
      allowNone ? el("option", { value: "", selected: !value }, "proxy (no * rule, upstream)") : null,
      options.map((t) => el("option", { value: t, selected: t === value }, targetLabel(t))));
    return select;
  }

  function editorSection(name) {
    const kind = name === ROUTES ? "routes" : "backends";
    const editor = editorOf(name);
    const draft = drafts[name];
    if (!editor || !draft) return null;
    const urls = [...new Set([...draft.entries.map((e) => e.target), draft.fallback].filter((t) => t && t.startsWith("url:")))];
    const changedOnServer = draft.revision !== editor.revision;
    const rows = draft.entries.map((entry, i) => el("tr", {},
      el("td", {}, el("code", {}, entry.key)),
      el("td", {}, targetSelect(entry.target, (t) => { entry.target = t; render(); }, { urls, label: `Target of ${entry.key}` })),
      el("td", {}, el("div", { class: "aiwb-proxy__cell-actions" }, canAdmin()
        ? el("button", { type: "button", class: "btn btn--sm", onclick: () => { draft.entries.splice(i, 1); render(); } }, "Remove") : null))));
    const input = el("input", { type: "text", class: "aiwb-proxy__input", placeholder: kind === "routes" ? "host, e.g. openai.com" : "backend id, e.g. claude-cli",
      "aria-label": kind === "routes" ? "Host suffix" : "Backend id", disabled: !canAdmin() });
    let newTarget = kind === "routes" ? "proxy" : "direct";
    const add = (event) => {
      event?.preventDefault?.();
      const raw = input.value.trim().toLowerCase();
      const key = kind === "routes" ? normalizeHost(raw) : BACKEND_ID.test(raw) ? raw : null;
      if (!key) {
        input.setCustomValidity(kind === "routes" ? "Enter a host name such as openai.com (it covers subdomains)" : "Enter a backend id such as claude-cli");
        input.reportValidity();
        return;
      }
      if (draft.entries.some((e) => e.key === key)) {
        input.setCustomValidity(`${key} is already listed`);
        input.reportValidity();
        return;
      }
      draft.entries.push({ key, target: newTarget });
      render();
    };
    input.addEventListener("input", () => input.setCustomValidity(""));
    const addForm = canAdmin() ? el("form", { class: "aiwb-proxy__add", onsubmit: add }, input,
      targetSelect(newTarget, (t) => { newTarget = t; }, { urls: [], label: "Target of the new entry" }),
      el("button", { type: "submit", class: "btn btn--sm" }, "Add")) : null;
    const isDirty = dirty(name);
    return el("section", { class: "aiwb-proxy__section" },
      el("div", { class: "aiwb-proxy__section-head" },
        el("h2", {}, kind === "routes" ? "Proxy routes" : "CLI backend proxy"),
        el("span", { class: "aiwb-proxy__hint" }, el("code", {}, name), ` · from ${editor.source}`)),
      kind === "routes"
        ? hint("Hosts listed with proxy (and their subdomains) go through the managed proxy; the most specific suffix wins. The rule for everything else is the * rule.")
        : hint("Proxy environment of CLI agent backend children per backend id. A backend without an entry follows the route of its API host."),
      editor.error ? message("warn", `The stored value is invalid (${editor.error}); the fork ignores it. Saving replaces it.`) : null,
      editor.overriddenByEnvironment ? message("warn", "The process environment or ~/.openclaw/.env holds a different value, which wins over env.vars.") : null,
      changedOnServer ? message("warn", "The stored value changed since editing began; discard to load it.") : null,
      el("table", { class: "aiwb-proxy__table" },
        el("thead", {}, el("tr", {}, [kind === "routes" ? "Host suffix" : "Backend", "Target", ""].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: "3", class: "aiwb-proxy__hint" }, "No entries.")))),
      addForm,
      kind === "routes" ? el("label", { class: "aiwb-proxy__fallback" }, "Everything else (*): ",
        targetSelect(draft.fallback, (t) => { draft.fallback = t; render(); }, { urls, allowNone: true, label: "Target of every other host" })) : null,
      el("p", { class: "aiwb-proxy__hint" }, "Stored: ", el("code", {}, editor.raw || "(unset)"),
        isDirty ? [" · after save: ", el("code", {}, previewValue(kind, draft) || "(unset)")] : null),
      canAdmin() ? el("div", { class: "aiwb-proxy__actions" },
        el("button", { type: "button", class: "btn", disabled: !isDirty && !changedOnServer, onclick: () => { drafts[name] = null; void refresh(); } }, "Discard changes"),
        el("button", { type: "button", class: "btn primary", disabled: !isDirty || saving || changedOnServer, onclick: () => save(name) }, "Save…")) : null);
  }

  function backendsEffective() {
    const b = data?.backends;
    if (!b) return null;
    const what = (e) => (e.effective === "direct" ? badge("direct", "info")
      : e.effective === "url" ? badge("own proxy URL", "info")
      : e.effective === "proxy" ? badge("Gateway proxy", "ok")
      : badge("Gateway proxy env", "muted", "inherits HTTP(S)_PROXY of the Gateway: the managed proxy when active"));
    const by = (e) => (e.by === "explicit" ? "entry below" : e.by === "route" ? `route of ${e.host}` : e.host ? `${e.host} (no active routes)` : "default");
    return el("div", {},
      b.state === "invalid" ? message("warn", `The fork ignores ${BACKENDS}: ${b.reason}.`) : null,
      el("table", { class: "aiwb-proxy__table" },
        el("thead", {}, el("tr", {}, ["Backend", "In effect", "Decided by"].map((h) => el("th", {}, h)))),
        el("tbody", {}, b.effective.map((e) => el("tr", {}, el("td", {}, el("code", {}, e.id)), el("td", {}, what(e)), el("td", {}, by(e)))))),
      hint("Claude CLI agents load user settings, so proxy keys in Claude Code's settings.json (below) override what is set here."));
  }

  function result(r) {
    if (!r) return "—";
    if (r.skipped) return el("span", { class: "aiwb-proxy__hint" }, r.skipped);
    if (Number.isInteger(r.status)) return [badge(`HTTP ${r.status}`, r.status === 403 || r.status === 451 ? "warn" : "ok"), ` ${r.ms} ms`];
    const extra = r.proxyStatus ? ` ${r.proxyStatus}` : "";
    return [badge(`${ERRORS[r.error] || r.error}${extra}`, "danger", r.code), ` ${r.ms} ms`];
  }

  function checkSection() {
    if (!data) return null;
    const input = el("input", { type: "text", class: "aiwb-proxy__input aiwb-proxy__input--wide", value: extraHosts, disabled: !canAdmin(),
      placeholder: "more hosts, comma-separated (optional)", "aria-label": "More hosts to check",
      oninput: (event) => { extraHosts = event.target.value; } });
    const rows = (check?.results || []).map((r) => el("tr", {},
      el("td", {}, el("code", {}, r.host), r.from === "default" ? null : badge(r.from === "routes" ? "listed" : "added", "muted")),
      el("td", {}, r.route),
      el("td", {}, result(r.direct)),
      el("td", {}, result(r.proxy)),
      el("td", {}, r.hint ? el("span", { class: `aiwb-proxy__hint-text tone-${r.hint.code === "add-to-proxy" || r.hint.code === "route-direct" ? "warn" : "muted"}` }, r.hint.text) : "",
        r.hint?.code === "add-to-proxy" && canAdmin() && drafts[ROUTES]
          ? el("button", { type: "button", class: "btn btn--sm", onclick: () => addRoute(r.host, "proxy") }, "Add to list") : null,
        r.hint?.code === "route-direct" && canAdmin() && drafts[ROUTES]
          ? el("button", { type: "button", class: "btn btn--sm", onclick: () => addRoute(r.host, "direct") }, "List as direct") : null)));
    return el("section", { class: "aiwb-proxy__section" },
      el("div", { class: "aiwb-proxy__section-head" }, el("h2", {}, "Check"),
        check ? el("span", { class: "aiwb-proxy__hint" }, `Checked ${clock.format(new Date(check.checkedAt))}`) : null),
      hint(`HTTPS HEAD to https://<host>/ directly (no proxy) and through the managed proxy, 8 s timeout, for the listed hosts and common providers (${(data.checkDefaults || []).join(", ")}). Any HTTP status means reachable; 403 or 451 may be a region block.`),
      canAdmin() ? el("form", { class: "aiwb-proxy__add", onsubmit: (event) => { event.preventDefault(); void runCheck(); } }, input,
        el("button", { type: "submit", class: "btn primary", disabled: checking }, checking ? "Checking…" : "Check")) : null,
      checkError ? message("danger", checkError) : null,
      rows.length ? el("table", { class: "aiwb-proxy__table" },
        el("thead", {}, el("tr", {}, ["Host", "Route now", "Direct", "Via proxy", "Hint"].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows)) : null,
      rows.length ? hint("“Add to list” changes the list above; save it to apply.") : null);
  }

  function claudeSection() {
    const c = data?.claudeCode;
    if (!c) return null;
    return el("section", { class: "aiwb-proxy__section" },
      el("h2", {}, "Claude Code"),
      hint("Claude Code's own proxy lives in the env block of ", el("code", {}, c.file),
        " (the installer key WORKBENCH_CLAUDE_CODE_PROXY writes it) and is not edited here. Only whether each key is set is shown."),
      !c.found ? hint("The file does not exist.") : c.error ? message("warn", `The file is ${c.error}.`) : null,
      el("div", { class: "aiwb-proxy__keys" }, Object.entries(c.keys).map(([k, set]) =>
        el("span", {}, el("code", {}, k), set ? badge("set", "ok") : badge("not set", "muted")))));
  }

  function render() {
    if (disposed) return;
    const parts = [header(), ...messages(),
      !data && !error ? hint("Loading…") : null,
      proxySection(), editorSection(ROUTES),
      data ? el("section", { class: "aiwb-proxy__section" }, el("h2", {}, "CLI backends in effect"), backendsEffective()) : null,
      editorSection(BACKENDS), checkSection(), claudeSection()];
    page.replaceChildren(...parts.flat().filter(Boolean));
  }

  const accessKey = () => `${Boolean(host.connection?.connected)}:${canAdmin()}`;
  let lastAccess = accessKey();
  const unsubscribe = host.subscribe?.(() => {
    const next = accessKey();
    if (disposed || next === lastAccess) return;
    lastAccess = next;
    if (host.connection?.connected && !data) void refresh();
    else render();
  });
  render();
  void refresh();
  return {
    update(next) {
      const wasPresented = ctx.presented;
      ctx = next;
      if (ctx.presented && !wasPresented && !dirty(ROUTES) && !dirty(BACKENDS)) void refresh();
    },
    dispose() {
      disposed = true;
      closeDialog();
      unsubscribe?.();
      page.remove();
      overlay.remove();
    },
  };
}

export default {
  id: PLUGIN_ID,
  activate(host) {
    const pages = [
      host.ui.registerPage({ id: PAGE_ID, label: "Proxy", mount: mountProxyPage }),
      host.ui.registerPage({ id: CHAT_FILES_PAGE_ID, label: "Chat files", mount: mountChatFilesPage }),
    ];
    return () => pages.forEach((dispose) => dispose?.());
  },
};

export { mountProxyPage };
