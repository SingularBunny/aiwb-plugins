// GPU views for the OpenClaw Control UI (native plugin views, hand-written, no build step).
// In the chat header: "GPU 35% · 5.1/8 GB" per GPU, refreshed every 5 s while shown, hidden when there is no NVIDIA
// GPU; a click opens the side panel. The panel: each GPU's load and memory, and who holds the memory (Ollama with
// its models, llama.cpp, LM Studio, the Gateway's embeddings, other processes), refreshed every 2 s while shown.

const PLUGIN_ID = "aiwb-gpu";
const PANEL_ID = "gpu";
const STATUS = `${PLUGIN_ID}.status`;

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

/** 5120 → "5.0 GB", 900 → "900 MB"; null → "?". */
export function formatMb(mb) {
  if (mb === null || mb === undefined) return "?";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** The header line of one GPU: "GPU 35% · 5.1/8.0 GB". */
export function headerText(gpu) {
  const load = gpu.utilization === null ? "" : ` ${gpu.utilization}%`;
  const total = gpu.memoryTotalMb === null ? "?" : (gpu.memoryTotalMb / 1024).toFixed(1);
  const used = gpu.memoryUsedMb === null ? "?" : (gpu.memoryUsedMb / 1024).toFixed(1);
  return `GPU${load} · ${used}/${total} GB`;
}

/** Calls fn now and every periodMs while the view is presented; returns { update(context), dispose() }. */
function poll(context, periodMs, fn) {
  let presented = context.presented, timer = null, disposed = false;
  const tick = async () => {
    timer = null;
    if (disposed || !presented) return;
    try { await fn(); } finally { if (!disposed && presented) timer = setTimeout(tick, periodMs); }
  };
  void tick();
  return {
    update(next) {
      const was = presented;
      presented = next.presented;
      if (presented && !was && !timer) void tick();
    },
    dispose() { disposed = true; clearTimeout(timer); },
  };
}

function mountHeader(container, context) {
  const button = el("button", { type: "button", class: "aiwb-gpu-chip", hidden: true, title: "GPU use: open the panel",
    onclick: () => context.host.ui.openPanel(PANEL_ID, { sessionKey: context.props.sessionKey, agentId: context.props.agentId }) });
  container.append(button);
  const loop = poll(context, 5000, async () => {
    const status = await context.host.request(STATUS, {}).catch(() => null);
    const gpus = status?.available ? status.gpus : [];
    button.hidden = !gpus.length;
    button.textContent = gpus.map(headerText).join("  ·  ");
  });
  return { update: loop.update, dispose() { loop.dispose(); button.remove(); } };
}

function bar(part, whole) {
  const share = part !== null && whole ? Math.min(100, Math.round((part / whole) * 100)) : 0;
  return el("div", { class: "aiwb-gpu__bar", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(share) },
    el("div", { class: "aiwb-gpu__fill", style: `width:${share}%` }));
}

function gpuCard(gpu) {
  const rows = gpu.consumers.flatMap((c) => [
    el("tr", {}, el("td", {}, c.label, c.kind === "other" ? el("span", { class: "aiwb-gpu__muted" }, ` pid ${c.pids.join(", ")}`) : null),
      el("td", { class: "aiwb-gpu__num" }, formatMb(c.memoryMb))),
    ...(c.models ?? []).map((m) => el("tr", { class: "aiwb-gpu__model" },
      el("td", {}, m.name, el("span", { class: "aiwb-gpu__muted" },
        m.sizeMb ? ` ${Math.round((m.vramMb / m.sizeMb) * 100)}% on GPU` : "")),
      el("td", { class: "aiwb-gpu__num" }, formatMb(m.vramMb)))),
  ]);
  return el("section", { class: "aiwb-gpu__card" },
    el("h3", {}, gpu.name),
    el("div", { class: "aiwb-gpu__line" }, el("span", {}, "Load"), bar(gpu.utilization, 100),
      el("span", { class: "aiwb-gpu__num" }, gpu.utilization === null ? "?" : `${gpu.utilization}%`)),
    el("div", { class: "aiwb-gpu__line" }, el("span", {}, "Memory"), bar(gpu.memoryUsedMb, gpu.memoryTotalMb),
      el("span", { class: "aiwb-gpu__num" }, `${formatMb(gpu.memoryUsedMb)} / ${formatMb(gpu.memoryTotalMb)}`)),
    rows.length
      ? el("table", { class: "aiwb-gpu__table" }, el("thead", {}, el("tr", {}, el("th", {}, "Holds GPU memory"), el("th", { class: "aiwb-gpu__num" }, "Memory"))),
        el("tbody", {}, rows))
      : el("p", { class: "aiwb-gpu__muted" }, "No process holds GPU memory."));
}

function mountPanel(container, context) {
  const view = el("div", { class: "aiwb-gpu" }, el("p", { class: "aiwb-gpu__muted" }, "Reading GPU use…"));
  container.append(view);
  const loop = poll(context, 2000, async () => {
    let status;
    try { status = await context.host.request(STATUS, {}); } catch (error) {
      view.replaceChildren(el("p", { class: "aiwb-gpu__muted", role: "alert" }, `GPU use is unavailable: ${error?.message || error}`));
      return;
    }
    if (!status.available) { view.replaceChildren(el("p", { class: "aiwb-gpu__muted" }, status.reason)); return; }
    view.replaceChildren(...status.gpus.map(gpuCard),
      el("p", { class: "aiwb-gpu__muted" }, `Updated ${new Date(status.at).toLocaleTimeString()}. Load is for the whole GPU; nvidia-smi gives memory per process.`));
  });
  return { update: loop.update, dispose() { loop.dispose(); view.remove(); } };
}

export default {
  id: PLUGIN_ID,
  activate(host) {
    const disposers = [
      host.ui.registerPanel?.({ id: PANEL_ID, label: "GPU", mount: mountPanel }),
      host.ui.registerAccessory?.({ id: "gpu-header", placement: "session-header", mount: mountHeader }),
    ];
    return () => disposers.forEach((d) => d?.());
  },
};
