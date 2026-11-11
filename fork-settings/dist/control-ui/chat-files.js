// Chat files page for the OpenClaw Control UI (native plugin view, hand-written, no build step).
// Edits the fork's OPENCLAW_ASSISTANT_MEDIA_ROOTS: folders whose files the chat previews and
// downloads (any type) in Full Access sessions, for all agents and per agent. Reads
// aiwb-fork-settings.chatFiles; a folder typed on the page is checked on the Gateway's disk with
// aiwb-fork-settings.checkFolder before it is added; the lists are saved through
// aiwb-fork-settings.set (operator.admin) after a confirmation that shows the resulting value.
import { badge, createDialogs, el, hint, message } from "./ui.js";

const PLUGIN_ID = "aiwb-fork-settings";
export const PAGE_ID = "chat-files";
const NAME = "OPENCLAW_ASSISTANT_MEDIA_ROOTS";
const METHODS = { overview: `${PLUGIN_ID}.chatFiles`, check: `${PLUGIN_ID}.checkFolder`, set: `${PLUGIN_ID}.set`, unset: `${PLUGIN_ID}.unset` };
export const ALL = "*";

/** A folder as typed, trimmed and without a trailing slash; null when its text alone is refused. */
export function normalizeFolder(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /[:;]/.test(text)) return null;
  if (!(text.startsWith("/") || text === "~" || text.startsWith("~/"))) return null;
  const trimmed = text.replace(/\/+$/, "");
  if (!trimmed || trimmed === "~") return null;
  return trimmed;
}

/** The value the lists would be saved as: `*` first, then agents; empty lists dropped ("" = unset). */
export function previewFolders(scopes) {
  const order = [ALL, ...Object.keys(scopes).filter((k) => k !== ALL)];
  return order.filter((k) => scopes[k]?.length).map((k) => `${k}=${scopes[k].join(":")}`).join(";");
}

/** Lists from the overview: { scope: [entry text] }. */
export function draftFromOverview(data) {
  const out = { [ALL]: [] };
  for (const [scope, list] of Object.entries(data?.scopes || {})) out[scope] = list.map((e) => e.entry);
  return out;
}

const STATUS_TONE = { ok: "ok", missing: "warn", "not-dir": "warn" };

export function mountChatFilesPage(container, context) {
  let ctx = context;
  const host = context.host;
  let data = null;
  let draft = null;
  let origin = "";
  let error = "";
  let notice = "";
  let loading = false;
  let saving = false;
  let disposed = false;
  let agent = "";
  const inputs = {};
  const checks = {};
  const page = el("section", { class: "aiwb-proxy aiwb-chat-files" });
  const overlay = el("div");
  container.append(page, overlay);
  const dialogs = createDialogs(host, overlay);
  const clock = new Intl.DateTimeFormat(host.locale || undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const canAdmin = () => Boolean(host.connection?.connected && host.connection?.canAdmin);
  const dirty = () => Boolean(draft && previewFolders(draft) !== origin);
  const statusOf = (scope, entry) => (data?.scopes?.[scope] || []).find((e) => e.entry === entry);

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
      data = await host.request(METHODS.overview, {});
      if (!dirty()) {
        draft = draftFromOverview(data);
        origin = previewFolders(draft);
      }
      if (!agent) agent = data.agents?.[0]?.id || "";
      if (error.startsWith("Chat files data")) error = "";
    } catch (failure) {
      error = `Chat files data unavailable: ${failure?.message || failure}`;
    } finally {
      loading = false;
    }
    render();
  }

  async function add(scope, raw) {
    const folder = normalizeFolder(raw);
    if (!folder) {
      checks[scope] = { ok: false, text: "Enter an absolute path or one starting with ~/ (not / or ~, no \":\" or \";\")" };
      render();
      return;
    }
    if ((draft[scope] || []).includes(folder)) {
      checks[scope] = { ok: false, text: `${folder} is already listed` };
      render();
      return;
    }
    checks[scope] = { pending: true, text: "Checking on the Gateway…" };
    render();
    try {
      const result = await host.request(METHODS.check, { path: folder });
      if (!result.ok) {
        checks[scope] = { ok: false, text: `${folder}: ${result.text}` };
      } else {
        (draft[scope] ??= []).push(folder);
        checks[scope] = { ok: true, text: `${folder}: ${result.text}${result.realPath && result.realPath !== result.path ? ` (${result.realPath})` : ""}` };
        inputs[scope] = "";
      }
    } catch (failure) {
      checks[scope] = { ok: false, text: `Check failed: ${failure?.message || failure}` };
    }
    render();
  }

  function remove(scope, entry) {
    draft[scope] = (draft[scope] || []).filter((e) => e !== entry);
    render();
  }

  async function save() {
    if (!canAdmin() || saving || !draft) return;
    const value = Object.fromEntries(Object.entries(draft).filter(([, list]) => list.length));
    const empty = Object.keys(value).length === 0;
    saving = true;
    error = "";
    notice = "";
    render();
    try {
      const preview = await host.request(empty ? METHODS.unset : METHODS.set, { name: NAME, ...(empty ? {} : { value }), dryRun: true });
      const body = el("div", { class: "aiwb-proxy__confirm" },
        el("p", {}, empty ? "All lists are empty: the setting is removed and the chat serves only the session's folders (images from anywhere)." : "The setting will be written to env.vars:"),
        empty ? null : el("pre", { class: "aiwb-proxy__code" }, `${NAME}=${preview.stored}`),
        (preview.problems || []).length ? message("warn", "Skipped by OpenClaw until they exist as folders: ",
          preview.problems.map((p) => `${p.entry} (${p.text})`).join(", ")) : null,
        preview.overriddenByEnvironment ? message("warn", "A value from the process environment or ~/.openclaw/.env wins over env.vars; this change has no effect until it is removed there.") : null,
        preview.installerNote ? message("warn", preview.installerNote) : null,
        hint("The Gateway reloads env.vars; the next file preview or download uses the new folders."));
      saving = false;
      render();
      if (!(await dialogs.confirm("Save chat file folders", body)) || disposed) return;
      saving = true;
      render();
      const done = await host.request(empty ? METHODS.unset : METHODS.set, { name: NAME, ...(empty ? {} : { value }) });
      notice = `Saved: ${done.unset ? `${NAME} removed` : `${NAME}=${done.stored}`}.${done.installerNote ? ` ${done.installerNote}.` : ""}`;
      draft = null;
    } catch (failure) {
      error = `Not saved: ${failure?.message || failure}`;
    } finally {
      saving = false;
    }
    await refresh();
  }

  function header() {
    const updated = data ? `Updated ${clock.format(new Date(data.generatedAt))}` : "";
    return el("header", { class: "aiwb-proxy__header" },
      el("div", {}, el("h1", {}, "Chat files"),
        hint("Folders whose files the chat previews and downloads, any file type, in Full Access sessions. A chat uses the folders for all agents plus its own agent's. Outside them the chat shows images only.")),
      el("div", { class: "aiwb-proxy__toolbar" },
        el("span", { class: "aiwb-proxy__hint", "aria-live": "polite" }, loading ? "Refreshing…" : updated),
        el("button", { type: "button", class: "btn", disabled: loading, onclick: refresh }, "Refresh")));
  }

  function messages() {
    const out = [];
    if (error) out.push(message("danger", error));
    if (notice) out.push(message("ok", notice));
    if (data && !canAdmin()) out.push(hint("Adding folders and saving need an operator.admin connection; this one can only view."));
    if (data && !data.fork) out.push(message("warn", `This OpenClaw is not the fork: ${NAME} changes nothing.`));
    if (data?.installer?.rewrites) {
      out.push(message("warn", "The installer key ", el("code", {}, "WORKBENCH_CHAT_FILE_FOLDERS"),
        " in ~/.openclaw/.env sets the folders on each install: edits made here are overwritten by the next install unless the .env key (and per-project chatFileFolders) are updated too."));
    }
    if (data?.overriddenByEnvironment) out.push(message("warn", "The process environment or ~/.openclaw/.env holds a different value, which wins over env.vars."));
    if (data?.badScopes?.length) out.push(message("warn", `The stored value has rules OpenClaw ignores (${data.badScopes.join(", ")}); saving drops them.`));
    return out;
  }

  function folderList(scope) {
    const list = draft?.[scope] || [];
    const rows = list.map((entry) => {
      const status = statusOf(scope, entry);
      return el("tr", {},
        el("td", {}, el("code", {}, entry)),
        el("td", {}, status ? badge(status.text, STATUS_TONE[status.status] || "danger", status.realPath) : badge("new", "muted")),
        el("td", {}, el("div", { class: "aiwb-proxy__cell-actions" }, canAdmin()
          ? el("button", { type: "button", class: "btn btn--sm", "aria-label": `Remove ${entry}`, onclick: () => remove(scope, entry) }, "Remove") : null)));
    });
    const input = el("input", { type: "text", class: "aiwb-proxy__input aiwb-proxy__input--wide", value: inputs[scope] || "",
      placeholder: "folder, e.g. ~/Downloads or /srv/shared", "aria-label": "Folder to add", disabled: !canAdmin(),
      oninput: (event) => { inputs[scope] = event.target.value; } });
    const check = checks[scope];
    const suggestions = scope === ALL ? (data?.suggestions || []).filter((s) => !list.includes(s)) : [];
    return [
      el("table", { class: "aiwb-proxy__table" },
        el("thead", {}, el("tr", {}, ["Folder", "On the Gateway", ""].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: "3", class: "aiwb-proxy__hint" }, "No folders.")))),
      canAdmin() ? el("form", { class: "aiwb-proxy__add", onsubmit: (event) => { event.preventDefault(); void add(scope, input.value); } }, input,
        el("button", { type: "submit", class: "btn btn--sm", disabled: Boolean(check?.pending) }, "Add")) : null,
      check ? message(check.pending ? "muted" : check.ok ? "ok" : "danger", check.text) : null,
      canAdmin() && suggestions.length ? el("div", { class: "aiwb-proxy__keys" }, "Suggested: ",
        suggestions.map((s) => el("button", { type: "button", class: "btn btn--sm", onclick: () => add(scope, s) }, `+ ${s}`))) : null,
    ];
  }

  function allSection() {
    if (!draft) return null;
    return el("section", { class: "aiwb-proxy__section" },
      el("div", { class: "aiwb-proxy__section-head" }, el("h2", {}, "All agents"), el("span", { class: "aiwb-proxy__hint" }, el("code", {}, NAME), ` · from ${data?.source || "default"}`)),
      ...folderList(ALL));
  }

  function agentSection() {
    if (!draft || !data) return null;
    const known = data.agents || [];
    const ids = [...new Set([...known.map((a) => a.id), ...Object.keys(draft).filter((k) => k !== ALL)])];
    if (agent && !ids.includes(agent)) ids.push(agent);
    const label = (id) => {
      const entry = known.find((a) => a.id === id);
      const count = (draft[id] || []).length;
      return `${entry?.name ? `${entry.name} (${id})` : id}${entry ? "" : " — not configured"}${count ? ` · ${count}` : ""}`;
    };
    const picker = el("select", { "aria-label": "Agent", onchange: () => { agent = picker.value; render(); } },
      ids.map((id) => el("option", { value: id, selected: id === agent }, label(id))));
    return el("section", { class: "aiwb-proxy__section" },
      el("div", { class: "aiwb-proxy__section-head" }, el("h2", {}, "Per agent"), ids.length ? picker : null),
      hint("Extra folders for one agent's chats only, like a project's folders. Other agents do not get them."),
      ids.length && agent ? folderList(agent) : hint("No agents configured."));
  }

  function effectiveSection() {
    if (!data) return null;
    const scopes = Object.entries(data.effective || {});
    return el("section", { class: "aiwb-proxy__section" },
      el("h2", {}, "In effect now"),
      scopes.length
        ? el("table", { class: "aiwb-proxy__table" },
          el("thead", {}, el("tr", {}, ["For", "Folders (real paths)"].map((h) => el("th", {}, h)))),
          el("tbody", {}, scopes.map(([scope, list]) => el("tr", {}, el("td", {}, scope === ALL ? "all agents" : el("code", {}, scope)),
            el("td", {}, list.map((p) => el("div", {}, el("code", {}, p))))))))
        : hint("No extra folders: the chat serves the session's own folders, and images from anywhere."),
      el("p", { class: "aiwb-proxy__hint" }, "Stored: ", el("code", {}, data.stored || "(unset)"),
        dirty() ? [" · after save: ", el("code", {}, previewFolders(draft) || "(unset)")] : null),
      canAdmin() ? el("div", { class: "aiwb-proxy__actions" },
        el("button", { type: "button", class: "btn", disabled: !dirty(), onclick: () => { draft = null; void refresh(); } }, "Discard changes"),
        el("button", { type: "button", class: "btn primary", disabled: !dirty() || saving, onclick: save }, "Save…")) : null,
      hint("Applies to Full Access chats on this Gateway. Workspace-only chats, remote and cloud sessions are unaffected; agent tools keep their own file access."));
  }

  function render() {
    if (disposed) return;
    const parts = [header(), ...messages(), !data && !error ? hint("Loading…") : null, allSection(), agentSection(), effectiveSection()];
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
      if (ctx.presented && !wasPresented && !dirty()) void refresh();
    },
    dispose() {
      disposed = true;
      dialogs.close();
      unsubscribe?.();
      page.remove();
      overlay.remove();
    },
  };
}
