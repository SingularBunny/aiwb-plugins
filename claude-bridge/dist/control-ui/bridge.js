// Claude Desktop & Code bridge views for the OpenClaw Control UI (hand-written, no build step).
// "Continue in terminal" in a chat's menu (sidebar row and chat header): the command that opens the chat's
// Claude Code conversation in a terminal, copied to the clipboard and shown with the chats file.

const PLUGIN_ID = "aiwb-claude-bridge";
const TERMINAL = `${PLUGIN_ID}.terminal`;

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

export default {
  id: PLUGIN_ID,
  activate(host) {
    const disposers = [
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
