// Claude Desktop & Code bridge views for the OpenClaw Control UI (hand-written, no build step).
// In a chat's menu (sidebar row and chat header):
// - "Continue in terminal": the command that opens the chat's Claude Code conversation in a terminal, copied
//   to the clipboard and shown with the chats file;
// - "Move to project <folder>…": only on a chat the default agent adopted before its folder had an agent and
//   that was used there since (rehome.js; untouched ones move by themselves). After a confirmation the chat
//   moves to the folder's agent with its history, as drag-and-drop does (sessions.catalog.move).

const PLUGIN_ID = "aiwb-claude-bridge";
const TERMINAL = `${PLUGIN_ID}.terminal`;
const OFFERS = `${PLUGIN_ID}.rehome.offers`;
const REFRESH_MS = 2 * 60 * 1000;

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function showCommand(host, info, copied) {
  const container = el("div");
  document.body.append(container);
  let handle;
  const close = () => { handle?.dispose?.(); container.remove(); };
  const content = el("div", { class: "aiwb-bridge-terminal" },
    el("p", {}, copied ? "Copied. Run it in a terminal to continue this chat in Claude Code:" : "Run it in a terminal to continue this chat in Claude Code:"),
    el("pre", { class: "aiwb-bridge-terminal__command" }, info.command),
    info.busy ? el("p", {}, "Claude Code already has this chat open in a terminal.") : null,
    el("p", {}, "While Claude Code has the chat open, OpenClaw does not continue it. When you leave Claude Code, the turns made there show here. ",
      "Every chat's command is also in ", el("code", {}, info.chatsFile), ", which works without OpenClaw."),
    el("button", { type: "button", class: "btn", onclick: close }, "Close"));
  handle = host.components?.mountDialog?.(container, { label: "Continue in terminal", content, onCancel: close });
  if (!handle) { close(); throw new Error(info.command); }
}

const russian = (locale) => /^ru(\b|[-_])/i.test(locale || "");

/** The menu item of a chat offered to move to its folder's agent. */
export const moveLabel = (locale, folder) => (russian(locale) ? `Перенести в проект ${folder}…` : `Move to project ${folder}…`);

/** Asks before a move; resolves true to move. */
function confirmMove(host, { title, folder, agentId }) {
  const ru = russian(host.locale);
  return new Promise((resolve) => {
    const container = el("div");
    document.body.append(container);
    let handle, done = false;
    const close = (answer) => { if (done) return; done = true; handle?.dispose?.(); container.remove(); resolve(answer); };
    const message = ru
      ? `Перенести чат «${title}» в проект ${folder}? Он продолжится у агента ${agentId} со всей историей; прежний чат уйдёт в архив.`
      : `Move the chat "${title}" to the project ${folder}? It continues with the agent ${agentId}, with its whole history; the old chat goes to the archive.`;
    const content = el("div", { class: "aiwb-bridge-terminal" },
      el("p", {}, message),
      el("div", { class: "aiwb-bridge-actions" },
        el("button", { type: "button", class: "btn", onclick: () => close(false) }, ru ? "Отмена" : "Cancel"),
        el("button", { type: "button", class: "btn primary", onclick: () => close(true) }, ru ? "Перенести" : "Move")));
    handle = host.components?.mountDialog?.(container, { label: moveLabel(host.locale, folder).replace(/…$/, ""), content, onCancel: () => close(false) });
    if (!handle) close(window.confirm(message));
  });
}

/**
 * The "Move to project" action. Offers come from the Gateway (aiwb-claude-bridge.rehome.offers) and are kept
 * here, since a menu item is resolved synchronously; they are fetched again when sessions or the tree change.
 */
export function rehomeAction(host, { confirm = confirmMove } = {}) {
  let offers = new Map(), timer;
  const key = (sessionKey) => { try { return host.sessions?.normalizeKey?.(sessionKey) ?? sessionKey; } catch { return sessionKey; } };
  const refresh = async () => {
    try {
      const r = await host.request(OFFERS, {});
      offers = new Map((r?.offers || []).map((o) => [key(o.sessionKey), o]));
    } catch { offers = new Map(); }
    host.ui?.invalidate?.();
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(refresh, 1000); };
  const interval = setInterval(refresh, REFRESH_MS);
  const stops = [host.onEvent?.("sessions.changed", soon), host.onEvent?.(`plugin.${PLUGIN_ID}.session-catalog-changed`, soon)];
  return {
    refresh,
    action: {
      id: "move-to-project", label: russian(host.locale) ? "Перенести в проект…" : "Move to project…", placement: "session",
      resolve({ sessionKey }) {
        const offer = sessionKey && offers.get(key(sessionKey));
        return offer ? { label: moveLabel(host.locale, offer.folder) } : { hidden: true };
      },
      async run({ sessionKey, session, host: h }) {
        const api = h || host;
        const offer = offers.get(key(sessionKey));
        if (!offer) throw new Error(russian(host.locale) ? "Этот чат уже не предлагается перенести." : "This chat is no longer offered for a move.");
        const title = session?.displayName || session?.label || session?.derivedTitle || sessionKey;
        if (!(await confirm(api, { title, folder: offer.folder, agentId: offer.agentId }))) return;
        const moved = await api.request("sessions.catalog.move",
          { catalogId: "projects", hostId: "gateway:local", threadId: `s:${sessionKey}`, group: offer.folder });
        offers.delete(key(sessionKey));
        host.ui?.invalidate?.();
        if (moved?.sessionKey) api.sessions?.open?.({ sessionKey: moved.sessionKey, agentId: offer.agentId });
        // The move stands; the old chat was not archived (shown as the action's message).
        if (moved?.warning) throw new Error(moved.warning);
      },
    },
    dispose() { clearTimeout(timer); clearInterval(interval); for (const stop of stops) stop?.(); },
  };
}

export default {
  id: PLUGIN_ID,
  activate(host) {
    const rehome = rehomeAction(host);
    void rehome.refresh();
    const disposers = [
      host.ui.registerAction?.(rehome.action),
      rehome.dispose,
      host.ui.registerAction?.({
        id: "continue-in-terminal", label: "Continue in terminal", placement: "session",
        async run({ sessionKey, host: h }) {
          const api = h || host;
          const info = await api.request(TERMINAL, { sessionKey });
          showCommand(api, info, await copy(info.command));
        },
      }),
    ];
    return () => disposers.forEach((d) => d?.());
  },
};
