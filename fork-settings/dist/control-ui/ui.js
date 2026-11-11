// Small DOM helpers shared by the plugin's Control UI pages (hand-written, no build step).

export function el(tag, attrs, ...children) {
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

export const badge = (text, tone, title) => el("span", { class: `aiwb-proxy__badge tone-${tone}`, title }, text);
export const hint = (...text) => el("p", { class: "aiwb-proxy__hint" }, ...text);
export const message = (tone, ...text) => el("p", { class: `aiwb-proxy__message tone-${tone}`, role: tone === "danger" ? "alert" : "status" }, ...text);

/** A dialog in `overlay` (the host's dialog when it has one) and a Confirm/Cancel helper. */
export function createDialogs(host, overlay) {
  let dialog = null;
  function close() {
    dialog?.dispose?.();
    dialog = null;
    overlay.replaceChildren();
  }
  function open(label, content, onCancel) {
    close();
    if (host.components?.mountDialog) {
      dialog = host.components.mountDialog(overlay, { label, content, className: "aiwb-proxy__dialog",
        onCancel: () => { onCancel?.(); close(); return true; } });
    } else {
      overlay.replaceChildren(el("div", { class: "aiwb-proxy__dialog is-inline" }, el("h3", {}, label), content));
      dialog = { dispose: () => overlay.replaceChildren() };
    }
  }
  function confirm(title, body, danger) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        close();
        resolve(value);
      };
      const ok = el("button", { type: "button", class: danger ? "btn danger" : "btn primary", onclick: () => finish(true) }, "Confirm");
      open(title, el("div", { class: "aiwb-proxy__confirm" }, body,
        el("div", { class: "aiwb-proxy__actions" }, el("button", { type: "button", class: "btn", onclick: () => finish(false) }, "Cancel"), ok)),
      () => finish(false));
      ok.focus?.();
    });
  }
  return { open, close, confirm };
}
