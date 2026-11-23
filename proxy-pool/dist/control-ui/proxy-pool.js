// Proxy pool page for the OpenClaw Control UI (native plugin view, hand-written, no build step).
// Reads aiwb-proxy-pool.status; Refresh calls aiwb-proxy-pool.refresh (operator.admin). Settings are the
// plugin's own config (plugins.entries.aiwb-proxy-pool.config), edited in the plugin's settings.
const PLUGIN_ID = "aiwb-proxy-pool";
const PAGE_ID = "proxy-pool";

const STRINGS = {
  en: {
    title: "Proxy pool",
    intro: (port) => `A local proxy on 127.0.0.1:${port} for programs that a country block or a blocked exit keeps out. Only programs pointed at it use it (Junie: bin/junie-via-pool); the Gateway's own traffic does not. Free proxies see host names, not HTTPS content.`,
    refresh: "Refresh pool",
    refreshing: "Refreshing…",
    listening: (port) => `Listening on 127.0.0.1:${port}`,
    notListening: (port) => `Not listening on 127.0.0.1:${port}`,
    size: (n) => `${n} checked proxies`,
    refreshedAt: (at) => `checked ${at}`,
    never: "never checked",
    check: (url) => `Check: ${url}, without 451`,
    empty: "The pool is empty.",
    columns: ["Proxy", "Country", "Answer", "Time", "Failures"],
    adminOnly: "Refreshing needs an admin connection.",
    offline: "Not connected to the Gateway.",
    done: (good, all) => `${good} of ${all} candidates passed the check.`,
  },
  ru: {
    title: "Пул прокси",
    intro: (port) => `Локальный прокси 127.0.0.1:${port} для программ, которых не пускает блокировка по стране или заблокированный выход. Им пользуются только программы, направленные в него (Junie — через bin/junie-via-pool); трафик самого шлюза идёт мимо. Бесплатные прокси видят имена хостов, но не содержимое HTTPS.`,
    refresh: "Обновить пул",
    refreshing: "Обновляю…",
    listening: (port) => `Слушает 127.0.0.1:${port}`,
    notListening: (port) => `Не слушает 127.0.0.1:${port}`,
    size: (n) => `Проверенных прокси: ${n}`,
    refreshedAt: (at) => `проверено ${at}`,
    never: "ещё не проверялся",
    check: (url) => `Проверка: ${url}, без 451`,
    empty: "Пул пуст.",
    columns: ["Прокси", "Страна", "Ответ", "Время", "Отказы"],
    adminOnly: "Обновлять пул можно только с правами администратора.",
    offline: "Нет связи со шлюзом.",
    done: (good, all) => `Проверку прошли ${good} из ${all}.`,
  },
};

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

/** The rows the table shows for a status answer. */
export function poolRows(status) {
  return (status?.proxies ?? []).map((proxy) => [
    `${proxy.host}:${proxy.port}`,
    proxy.country || "—",
    proxy.status ? String(proxy.status) : "—",
    Number.isFinite(proxy.ms) ? `${(proxy.ms / 1000).toFixed(1)} s` : "—",
    String(proxy.failures ?? 0),
  ]);
}

function mountPage(container, context) {
  const host = context.host;
  const s = String(host.locale || "").startsWith("ru") ? STRINGS.ru : STRINGS.en;
  const page = el("section", { class: "aiwb-proxy-pool" });
  container.append(page);
  let status = null;
  let error = "";
  let notice = "";
  let busy = false;
  let disposed = false;
  const time = new Intl.DateTimeFormat(host.locale || undefined, { dateStyle: "short", timeStyle: "short" });

  async function load() {
    if (!host.connection?.connected) { error = s.offline; render(); return; }
    try { status = await host.request(`${PLUGIN_ID}.status`, {}); error = ""; }
    catch (e) { error = String(e?.message || e); }
    render();
  }
  async function refresh() {
    busy = true; notice = ""; render();
    try {
      const result = await host.request(`${PLUGIN_ID}.refresh`, {});
      notice = s.done(result?.good ?? 0, result?.candidates ?? 0);
    } catch (e) { error = String(e?.message || e); }
    busy = false;
    await load();
  }
  function render() {
    if (disposed) return;
    const canAdmin = Boolean(host.connection?.connected && host.connection?.canAdmin);
    const port = status?.port ?? 18795;
    const refreshing = busy || status?.refreshing;
    page.replaceChildren(
      el("div", { class: "aiwb-proxy-pool__header" },
        el("h1", {}, s.title),
        el("button", { class: "btn primary", type: "button", disabled: !canAdmin || refreshing, title: canAdmin ? undefined : s.adminOnly, onclick: refresh },
          refreshing ? s.refreshing : s.refresh)),
      el("p", { class: "aiwb-proxy-pool__hint" }, s.intro(port)),
      error ? el("p", { class: "aiwb-proxy-pool__error" }, error) : null,
      status ? el("p", { class: "aiwb-proxy-pool__meta" },
        `${status.listening ? s.listening(port) : s.notListening(port)} · ${s.size(status.proxies?.length ?? 0)} · ${status.refreshedAt ? s.refreshedAt(time.format(new Date(status.refreshedAt))) : s.never}`,
        el("br"), s.check(status.settings?.checkUrl ?? "")) : null,
      status?.lastError ? el("p", { class: "aiwb-proxy-pool__error" }, status.lastError) : null,
      notice ? el("p", { class: "aiwb-proxy-pool__notice" }, notice) : null,
      status && !status.proxies?.length ? el("p", {}, s.empty) : null,
      status?.proxies?.length ? el("table", { class: "aiwb-proxy-pool__table" },
        el("thead", {}, el("tr", {}, s.columns.map((name) => el("th", {}, name)))),
        el("tbody", {}, poolRows(status).map((row) => el("tr", {}, row.map((cell) => el("td", {}, cell)))))) : null,
    );
  }
  void load();
  const poll = setInterval(() => { if (status?.refreshing || busy) void load(); }, 5000);
  return () => { disposed = true; clearInterval(poll); };
}

export default {
  id: PLUGIN_ID,
  activate(host) {
    const dispose = host.ui.registerPage({ id: PAGE_ID, label: "Proxy pool", mount: mountPage });
    return () => dispose?.();
  },
};
