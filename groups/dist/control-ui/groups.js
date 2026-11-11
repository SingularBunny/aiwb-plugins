// Groups page for the OpenClaw Control UI (native plugin view, hand-written, no build step): the list of groups,
// a form to create or change one (members, manager, turn limit), and the conversation with its input. While the
// agents answer, the page re-reads the group every 2 seconds.

const PLUGIN_ID = "aiwb-groups";
const PAGE_ID = "groups";
const M = { agents: `${PLUGIN_ID}.agents`, list: `${PLUGIN_ID}.list`, get: `${PLUGIN_ID}.get`, save: `${PLUGIN_ID}.save`,
  remove: `${PLUGIN_ID}.remove`, send: `${PLUGIN_ID}.send`, stop: `${PLUGIN_ID}.stop` };

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
const hint = (...t) => el("p", { class: "aiwb-groups__hint" }, ...t);
const message = (tone, ...t) => el("p", { class: `aiwb-groups__message tone-${tone}`, role: tone === "danger" ? "alert" : "status" }, ...t);

function mountGroupsPage(container, context) {
  let ctx = context;
  const host = context.host;
  let agents = [];
  let groups = [];
  let current = null;
  let editing = null;                                          // { id?, name, agents:Set, manager, maxTurns }
  let error = "";
  let busy = false;
  let disposed = false;
  let timer = null;
  const page = el("section", { class: "aiwb-groups" });
  container.append(page);
  const nameOf = (id) => agents.find((a) => a.id === id)?.name || id;
  const redact = (t) => (typeof host.redact === "function" ? host.redact(t) : t);

  async function call(method, params, failText) {
    try {
      return await host.request(method, params);
    } catch (failure) {
      error = `${failText}: ${failure?.message || failure}`;
      render();
      return null;
    }
  }

  async function refresh() {
    if (!host.connection?.connected) { error = "Not connected to the Gateway."; render(); return; }
    const [r, l] = await Promise.all([call(M.agents, {}, "Agents not loaded"), call(M.list, {}, "Groups not loaded")]);
    if (r) agents = r.agents;
    if (l) groups = l.groups;
    if (current) await reload();
    else render();
  }

  async function reload() {
    const r = await call(M.get, { id: current.id }, "Group not loaded");
    if (r) current = r.group;
    render();
    clearTimeout(timer);
    if (!disposed && current?.running) timer = setTimeout(reload, 2000);
    else if (current && !current.running) void call(M.list, {}, "Groups not loaded").then((l) => { if (l) { groups = l.groups; render(); } });
  }

  async function open(id) {
    editing = null;
    error = "";
    current = { id };
    await reload();
  }

  function startEdit(group) {
    editing = group ? { id: group.id, name: group.name, agents: new Set(group.agents), manager: group.manager || "main", maxTurns: group.maxTurns || 3 }
      : { name: "", agents: new Set(), manager: "main", maxTurns: 3 };
    render();
  }

  async function save() {
    busy = true;
    render();
    const r = await call(M.save, { ...(editing.id ? { id: editing.id } : {}), name: editing.name, agents: [...editing.agents],
      manager: editing.manager, maxTurns: editing.maxTurns }, "Not saved");
    busy = false;
    if (r) { editing = null; current = r.group; await refresh(); } else render();
  }

  async function send(text) {
    busy = true;
    error = "";
    render();
    const r = await call(M.send, { id: current.id, text }, "Not sent");
    busy = false;
    if (r) { current = r.group; await reload(); } else render();
  }

  function listSection() {
    return el("aside", { class: "aiwb-groups__list" },
      el("div", { class: "aiwb-groups__list-head" }, el("h2", {}, "Groups"),
        el("button", { type: "button", class: "btn btn--sm", onclick: () => startEdit(null) }, "New group")),
      groups.length ? el("ul", {}, groups.map((g) => el("li", {},
        el("button", { type: "button", class: `aiwb-groups__item${current?.id === g.id ? " is-current" : ""}`, onclick: () => open(g.id) },
          el("strong", {}, g.name), el("span", { class: "aiwb-groups__hint" }, `${g.agents.map(nameOf).join(", ")} · ${g.messages} messages${g.running ? " · answering…" : ""}`)))))
        : hint("No groups yet."));
  }

  function editSection() {
    const e = editing;
    const nameBox = el("input", { type: "text", value: e.name, placeholder: "Name (optional)", "aria-label": "Group name",
      oninput: () => { e.name = nameBox.value; } });
    const manager = el("select", { "aria-label": "Manager", onchange: () => { e.manager = manager.value; } },
      agents.map((a) => el("option", { value: a.id, selected: a.id === e.manager }, `${a.name} (${a.id})`)));
    const turns = el("select", { "aria-label": "Agent turns per message", onchange: () => { e.maxTurns = Number(turns.value); } },
      [1, 2, 3, 4, 5, 6].map((n) => el("option", { value: String(n), selected: n === e.maxTurns }, String(n))));
    return el("section", { class: "aiwb-groups__panel" },
      el("h2", {}, e.id ? "Change group" : "New group"),
      nameBox,
      el("fieldset", { class: "aiwb-groups__members" }, el("legend", {}, "Members (2–8 agents)"),
        agents.map((a) => el("label", {}, el("input", { type: "checkbox", checked: e.agents.has(a.id), onchange: (ev) => {
          if (ev.target.checked) e.agents.add(a.id); else e.agents.delete(a.id);
          render();
        } }), ` ${a.name} `, el("code", {}, a.id)))),
      el("label", { class: "aiwb-groups__field" }, el("span", {}, "Manager (picks who speaks next)"), manager),
      el("label", { class: "aiwb-groups__field" }, el("span", {}, "Agent turns after each of your messages"), turns),
      hint("Each agent answers with its own model, instructions, memory and tools, in its own session for this group. Mention an agent (@id) to have it answer first."),
      el("div", { class: "aiwb-groups__actions" },
        el("button", { type: "button", class: "btn", onclick: () => { editing = null; render(); } }, "Cancel"),
        el("button", { type: "button", class: "btn primary", disabled: busy || e.agents.size < 2, onclick: save }, "Save")));
  }

  function chatSection() {
    if (!current?.transcript) return el("section", { class: "aiwb-groups__panel" }, hint("Pick a group or create one."));
    const box = el("textarea", { rows: 3, class: "aiwb-groups__input", placeholder: "Message to the group (@id to address an agent)", "aria-label": "Message" });
    box.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && box.value.trim()) { ev.preventDefault(); void send(box.value.trim()); }
    });
    const members = current.agents.map((id) => `${nameOf(id)} (@${id})`).join(", ");
    return el("section", { class: "aiwb-groups__panel" },
      el("div", { class: "aiwb-groups__list-head" }, el("h2", {}, current.name),
        el("div", { class: "aiwb-groups__actions" },
          el("button", { type: "button", class: "btn btn--sm", onclick: () => startEdit(current) }, "Change"),
          current.running ? el("button", { type: "button", class: "btn btn--sm danger", onclick: () => call(M.stop, { id: current.id }, "Not stopped") }, "Stop") : null)),
      hint(`${members} · manager ${nameOf(current.manager)} · up to ${current.maxTurns} agent turns per message`),
      el("div", { class: "aiwb-groups__transcript" }, current.transcript.map((m) => el("article", { class: `aiwb-groups__msg is-${m.role}${m.error ? " is-error" : ""}` },
        el("h3", {}, m.role === "user" ? "You" : m.role === "system" ? "Group" : nameOf(m.agentId)),
        m.error ? message("danger", `No reply: ${m.error}`) : el("div", { class: "aiwb-groups__text" }, redact(m.text))))),
      current.running ? hint("The agents are answering…") : null,
      el("div", { class: "aiwb-groups__compose" }, box,
        el("button", { type: "button", class: "btn primary", disabled: busy || current.running, onclick: () => box.value.trim() && send(box.value.trim()) }, "Send")),
      hint("Ctrl+Enter sends."));
  }

  function render() {
    if (disposed) return;
    page.replaceChildren(...[
      el("header", {}, el("h1", {}, "Groups"), hint("Several agents in one conversation; a manager picks who speaks next.")),
      error ? message("danger", error) : null,
      el("div", { class: "aiwb-groups__layout" }, listSection(), editing ? editSection() : chatSection()),
    ].filter(Boolean));
  }

  render();
  void refresh();
  return {
    update(next) {
      const was = ctx.presented;
      ctx = next;
      if (ctx.presented && !was) void refresh();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      page.remove();
    },
  };
}

export default {
  id: PLUGIN_ID,
  activate(host) {
    const dispose = host.ui.registerPage({ id: PAGE_ID, label: "Groups", mount: mountGroupsPage });
    return () => dispose?.();
  },
};

export { mountGroupsPage };
