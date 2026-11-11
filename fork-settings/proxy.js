// Proxy page data: the managed proxy (proxy.proxyUrl, shown as scheme://host:port only), the fork's
// OPENCLAW_PROXY_ROUTES and OPENCLAW_CLI_BACKEND_PROXY as editable per-host / per-backend lists, and a
// reachability check of hosts directly and through the managed proxy.
//
// Proxy URLs may hold credentials. Nothing here returns one: the address is scheme://host:port, URL
// targets of rules are referred to as `url:<n>` (the n-th distinct URL of the stored value) and the
// server puts the original URL back when the edited list is saved. A list is saved only against
// the revision it was read at (an HMAC of the stored value with a per-process key, not a plain hash).
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { parseProxyRules, redactProxyRules } from "./settings.js";

export const ROUTES = "OPENCLAW_PROXY_ROUTES";
export const BACKENDS = "OPENCLAW_CLI_BACKEND_PROXY";
export const KIND_OF = { [ROUTES]: "routes", [BACKENDS]: "backends" };

/** API hosts of the fork's built-in CLI backends (src/infra/net/proxy/proxy-routes.ts). */
export const CLI_BACKEND_API_HOSTS = {
  "claude-cli": "api.anthropic.com",
  "google-gemini-cli": "generativelanguage.googleapis.com",
  "codex-cli": "api.openai.com",
  codex: "api.openai.com",
};

/** Hosts the check always tries, besides the hosts named in the routes. */
export const DEFAULT_CHECK_HOSTS = [
  "openrouter.ai", "api.anthropic.com", "api.openai.com", "clawhub.ai", "api.telegram.org",
  "api.github.com", "registry.npmjs.org", "generativelanguage.googleapis.com",
];
export const CHECK_TIMEOUT_MS = 8000;
export const CHECK_CONCURRENCY = 6;
export const CHECK_MAX_HOSTS = 40;

/** Claude Code's proxy keys in the env block of its settings.json (installer key WORKBENCH_CLAUDE_CODE_PROXY). */
export const CLAUDE_PROXY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
/** Installer keys of <state>/.env that rewrite the proxy settings on each install. */
export const INSTALLER_PROXY_KEYS = ["WORKBENCH_PROXY_URL", "WORKBENCH_PROXY_HOSTS", "WORKBENCH_PROXY_ROUTES", "WORKBENCH_CLAUDE_CODE_PROXY"];

const HOST_SUFFIX = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const BACKEND_ID = /^[a-z0-9][a-z0-9._-]*$/;
const isUrlTarget = (t) => t !== "proxy" && t !== "direct";

function httpUrl(text) {
  try {
    const url = new URL(String(text).trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** scheme://host:port of a proxy URL, without credentials, path or query; null if it is not an http(s) URL. */
export function proxyAddress(raw) {
  const url = httpUrl(raw ?? "");
  if (!url) return null;
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

const sameUrl = (a, b) => Boolean(a && b && httpUrl(a) && httpUrl(b) && httpUrl(a).href === httpUrl(b).href);

/** Normalizes a host suffix as the fork does; undefined when it is not a host name. */
export function normalizeHost(raw) {
  const value = String(raw ?? "").trim().toLowerCase().replace(/^\*?\./, "").replace(/\.$/, "");
  return HOST_SUFFIX.test(value) ? value : undefined;
}

/**
 * The managed proxy as configured (url: internal only, never returned) and as shown (info).
 * The fork starts it when proxy.enabled is not false and proxy.proxyUrl (or OPENCLAW_PROXY_URL) is set.
 */
export function managedProxy(config = {}, env = process.env) {
  const fromConfig = typeof config?.proxy?.proxyUrl === "string" ? config.proxy.proxyUrl.trim() : "";
  const fromEnv = env.OPENCLAW_PROXY_URL?.trim() || "";
  const url = fromConfig || fromEnv;
  const caFile = config?.proxy?.tls?.caFile || env.OPENCLAW_PROXY_CA_FILE || null;
  return {
    url: url && httpUrl(url) ? url : null,
    caFile,
    info: {
      configured: Boolean(url),
      enabled: Boolean(url) && config?.proxy?.enabled !== false,
      active: env.OPENCLAW_PROXY_ACTIVE === "1",
      address: url ? proxyAddress(url) ?? "<invalid URL>" : null,
      source: fromConfig ? "proxy.proxyUrl" : fromEnv ? "OPENCLAW_PROXY_URL" : null,
      loopbackMode: config?.proxy?.loopbackMode || "gateway-only",
      customCa: Boolean(caFile),
    },
  };
}

/**
 * How the fork reads OPENCLAW_PROXY_ROUTES against the managed proxy URL:
 * unset (upstream: everything through the proxy), invalid (reason; upstream too) or active.
 */
export function routesState(raw, proxyUrl) {
  const text = raw?.trim() ?? "";
  if (!text) return { state: "unset" };
  const parsed = parseProxyRules("routes", text);
  if (parsed.error) return { state: "invalid", reason: parsed.error };
  if (parsed.rules.some((r) => isUrlTarget(r.target) && !sameUrl(r.target, proxyUrl))) {
    return { state: "invalid", reason: "a rule names a proxy URL other than proxy.proxyUrl; in-process routing supports one proxy URL" };
  }
  return { state: "active", rules: parsed.rules };
}

/** "proxy" or "direct" for a host under parsed routes (no rules: upstream, the proxy). */
export function routeFor(rules, hostname) {
  const host = String(hostname).toLowerCase().replace(/\.+$/, "");
  let best;
  let fallback;
  for (const rule of rules || []) {
    for (const key of rule.keys) {
      if (key === "*") {
        fallback ??= rule.target;
        continue;
      }
      if ((host === key || host.endsWith(`.${key}`)) && (!best || key.length > best.length)) best = { length: key.length, target: rule.target };
    }
  }
  const target = best?.target ?? fallback;
  return target === "direct" ? "direct" : "proxy";
}

/**
 * The stored value as an editable list: entries [{ key, target }] with URL targets as `url:<n>`,
 * fallback (`*` target, routes only; null = none) and the distinct URLs (server side only).
 * A key named twice keeps its first rule (the fork's match takes the first of equal length).
 */
export function editableRules(kind, raw) {
  const parsed = parseProxyRules(kind, raw ?? "");
  if (parsed.error) return { error: parsed.error, entries: [], fallback: null, urls: [] };
  const urls = [];
  const ref = (target) => {
    if (!isUrlTarget(target)) return target;
    let i = urls.indexOf(target);
    if (i < 0) i = urls.push(target) - 1;
    return `url:${i}`;
  };
  const entries = [];
  let fallback = null;
  for (const rule of parsed.rules) {
    for (const key of rule.keys) {
      if (key === "*") fallback ??= ref(rule.target);
      else if (!entries.some((e) => e.key === key)) entries.push({ key, target: ref(rule.target) });
    }
  }
  return { entries, fallback, urls };
}

/**
 * Builds the value from an edited list. entries: [{ key, target: proxy|direct|url:<n> }]; fallback:
 * null|proxy|direct|url:<n> (routes only). urls: the distinct URLs of the stored value. Returns
 * { raw } ("" when nothing is left: unset) or { error }. Hosts sharing a target share a rule; `*` is last.
 */
export function composeRules(kind, edit, urls = []) {
  const list = Array.isArray(edit?.entries) ? edit.entries : null;
  if (!list) return { error: "entries must be a list" };
  if (list.length > 500) return { error: "too many entries" };
  const target = (t, what) => {
    const text = typeof t === "string" ? t.trim().toLowerCase() : "";
    if (text === "proxy" || text === "direct") return { value: text };
    const m = /^url:(\d+)$/.exec(text);
    if (m && Number(m[1]) < urls.length) return { value: urls[Number(m[1])] };
    return { error: `${what}: the target must be proxy or direct${urls.length ? " (or a URL kept from the stored value)" : ""}` };
  };
  const groups = new Map();
  const seen = new Set();
  for (const [i, entry] of list.entries()) {
    const key = kind === "routes" ? normalizeHost(entry?.key) : String(entry?.key ?? "").trim().toLowerCase();
    if (!key || (kind === "backends" && !BACKEND_ID.test(key))) {
      return { error: `entry ${i + 1}: ${kind === "routes" ? "not a host name (e.g. anthropic.com)" : "not a backend id (e.g. claude-cli)"}` };
    }
    if (seen.has(key)) return { error: `${key} is listed twice` };
    seen.add(key);
    const t = target(entry?.target, key);
    if (t.error) return { error: t.error };
    if (!groups.has(t.value)) groups.set(t.value, []);
    groups.get(t.value).push(key);
  }
  const rules = kind === "routes"
    ? [...groups].map(([t, keys]) => `${keys.join(",")}=${t}`)
    : [...groups].flatMap(([t, keys]) => keys.map((k) => `${k}=${t}`));
  if (kind === "routes" && edit.fallback !== null && edit.fallback !== undefined && edit.fallback !== "") {
    const t = target(edit.fallback, "*");
    if (t.error) return { error: t.error };
    rules.push(`*=${t.value}`);
  } else if (kind !== "routes" && edit.fallback) {
    return { error: "backends have no * rule" };
  }
  return { raw: rules.join(";") };
}

const revisionKey = randomBytes(32);
/** Opaque revision of a stored value (HMAC with a per-process key; reveals nothing of the value). */
export const revisionOf = (raw) => createHmac("sha256", revisionKey).update(String(raw ?? "")).digest("hex").slice(0, 24);

/** The value the page edits: env.vars first (what `set` writes), else the process environment. */
export function baseValue(name, { env = process.env, configVars = {} } = {}) {
  const configured = configVars[name];
  return configured !== undefined && configured !== null ? String(configured) : env[name] ?? "";
}

function editorView(name, deps) {
  const kind = KIND_OF[name];
  const base = baseValue(name, deps);
  const { entries, fallback, error } = editableRules(kind, base);
  const processValue = deps.env[name];
  const configured = deps.configVars[name];
  const overridden = processValue !== undefined && processValue.trim() !== "" && configured !== undefined && String(configured) !== processValue;
  return {
    name,
    raw: redactProxyRules(kind, base) || "",
    entries,
    ...(kind === "routes" ? { fallback } : {}),
    ...(error ? { error } : {}),
    revision: revisionOf(base),
    source: configured !== undefined && configured !== null ? "env.vars" : processValue?.trim() ? "environment" : "default",
    ...(overridden ? { overriddenByEnvironment: true } : {}),
  };
}

/** Booleans per key: is it set (non-empty) in the env block of Claude Code's settings.json. Never values. */
export function claudeCodeProxy({ env = process.env, home = os.homedir(), read = readFileSync, exists = existsSync } = {}) {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  const file = dir ? path.join(dir, "settings.json") : path.join(home, ".claude", "settings.json");
  const label = dir ? "$CLAUDE_CONFIG_DIR/settings.json" : "~/.claude/settings.json";
  const keys = Object.fromEntries(CLAUDE_PROXY_KEYS.map((k) => [k, false]));
  if (!exists(file)) return { file: label, found: false, keys };
  try {
    const block = JSON.parse(read(file, "utf8"))?.env;
    for (const k of CLAUDE_PROXY_KEYS) keys[k] = typeof block?.[k] === "string" && block[k].trim() !== "";
    return { file: label, found: true, keys };
  } catch {
    return { file: label, found: true, keys, error: "not readable JSON" };
  }
}

/** Booleans per installer key in <state>/.env (set and non-empty). Never values. */
export function readInstallerKeys(names, { env = process.env, home = os.homedir(), read = readFileSync, exists = existsSync } = {}) {
  const file = path.join(env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw"), ".env");
  const keys = Object.fromEntries(names.map((k) => [k, false]));
  if (!exists(file)) return { found: false, keys };
  try {
    for (const line of read(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && m[1] in keys) keys[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2").trim() !== "";
    }
  } catch {
    return { found: true, keys, error: "not readable" };
  }
  return { found: true, keys };
}

/** Booleans per installer proxy key in <state>/.env (set and non-empty). Never values. */
export function installerProxyKeys(deps = {}) {
  const read = readInstallerKeys(INSTALLER_PROXY_KEYS, deps);
  // The installer writes env.vars.OPENCLAW_PROXY_ROUTES whenever a proxy URL or full routes are given.
  return { ...read, rewritesRoutes: Boolean(!read.error && (read.keys.WORKBENCH_PROXY_URL || read.keys.WORKBENCH_PROXY_ROUTES)) };
}

/** Everything the Proxy page shows. deps: { config, env, configVars, home, read, exists }. */
export function proxyOverview(deps) {
  const env = deps.env ?? process.env;
  const configVars = deps.configVars ?? {};
  const managed = managedProxy(deps.config ?? {}, env);
  const routes = routesState(env[ROUTES], managed.url);
  const backendsRaw = env[BACKENDS]?.trim() ?? "";
  const backendsParsed = backendsRaw ? parseProxyRules("backends", backendsRaw) : { rules: [] };
  const explicit = new Map((backendsParsed.rules || []).map((r) => [r.keys[0], r.target]));
  const routeActive = managed.info.active && routes.state === "active";
  const backendIds = [...new Set([...Object.keys(CLI_BACKEND_API_HOSTS), ...explicit.keys()])];
  const backendDefaults = backendIds.map((id) => {
    const target = explicit.get(id);
    if (target) return { id, effective: isUrlTarget(target) ? "url" : target === "proxy" ? "proxy" : "direct", by: "explicit" };
    const host = CLI_BACKEND_API_HOSTS[id];
    if (!host) return { id, effective: "inherit", by: "default" };
    const decision = routeActive ? routeFor(routes.rules, host) : "proxy";
    return { id, host, effective: decision === "direct" ? "direct" : "inherit", by: routeActive ? "route" : "default" };
  });
  const view = { env, configVars };
  return {
    proxy: managed.info,
    routes: {
      state: routes.state, ...(routes.reason ? { reason: routes.reason } : {}),
      effect: !managed.info.active ? "proxy-inactive" : routes.state === "active" ? "routes" : "all-through-proxy",
      editor: editorView(ROUTES, view),
    },
    backends: {
      state: !backendsRaw ? "unset" : backendsParsed.error ? "invalid" : "active",
      ...(backendsParsed.error ? { reason: backendsParsed.error } : {}),
      effective: backendDefaults,
      editor: editorView(BACKENDS, view),
    },
    claudeCode: claudeCodeProxy(deps),
    installer: installerProxyKeys(deps),
    checkDefaults: DEFAULT_CHECK_HOSTS,
  };
}

// ---- reachability check -------------------------------------------------------------------------

/** Error class of a failed request: timeout, refused, dns, reset, tls, proxy or error. code is a safe error code. */
export function classifyError(error) {
  const chain = [];
  for (let e = error, i = 0; e && i < 5; e = e.cause, i += 1) chain.push(e);
  const codes = chain.map((e) => (typeof e?.code === "string" ? e.code : "")).filter(Boolean);
  const names = chain.map((e) => e?.name || "");
  const messages = chain.map((e) => String(e?.message || ""));
  const code = codes.find((c) => /^[A-Z0-9_]{2,64}$/.test(c));
  const has = (re) => codes.some((c) => re.test(c));
  const proxyStatus = messages.map((m) => /Proxy response \((\d{3})\)/.exec(m)?.[1]).find(Boolean);
  let kind = "error";
  if (proxyStatus || has(/^UND_ERR_PRX_CONN$/)) kind = "proxy";
  else if (names.some((n) => n === "TimeoutError" || n === "AbortError") || has(/TIMEOUT|ETIMEDOUT/)) kind = "timeout";
  else if (has(/^ECONNREFUSED$/)) kind = "refused";
  else if (has(/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/)) kind = "dns";
  else if (has(/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH)$/)) kind = has(/UNREACH/) ? "unreachable" : "reset";
  if (kind === "error" && (has(/^ERR_TLS|^ERR_SSL|CERT|^UNABLE_TO_|^DEPTH_ZERO|^SELF_SIGNED|^UND_ERR_PRX_TLS$/) ||
    messages.some((m) => /\b(TLS|SSL|certificate)\b/i.test(m)))) kind = "tls";
  return { error: kind, ...(code ? { code } : {}), ...(proxyStatus ? { proxyStatus: Number(proxyStatus) } : {}) };
}

/** Loads undici: a plugin linked from its own folder has no node_modules, so fall back to OpenClaw's own copy. */
export async function loadUndici({ argv = process.argv } = {}) {
  try {
    return await import("undici");
  } catch {}
  for (const base of [argv[1], path.join(process.cwd(), "noop.js")].filter(Boolean)) {
    try {
      return createRequire(path.resolve(base))("undici");
    } catch {}
  }
  throw new Error("undici is not available (it ships with OpenClaw)");
}

/**
 * Transport of the check: direct requests through an undici Agent of their own (no proxy, HTTP(S)_PROXY
 * ignored, and an explicit dispatcher is not replaced by the process-wide proxy), proxied ones through an
 * undici ProxyAgent to the managed proxy URL. undici: the module (injected in tests).
 */
export function createTransport({ undici, proxyUrl, proxyCa, timeoutMs = CHECK_TIMEOUT_MS }) {
  const direct = new undici.Agent({ connect: { timeout: timeoutMs } });
  const proxied = proxyUrl
    ? new undici.ProxyAgent({ uri: proxyUrl, connectTimeout: timeoutMs, ...(proxyCa ? { proxyTls: { ca: proxyCa } } : {}) })
    : null;
  return {
    hasProxy: Boolean(proxied),
    async request(url, via) {
      const dispatcher = via === "proxy" ? proxied : direct;
      const res = await undici.request(url, {
        method: "HEAD", dispatcher, signal: AbortSignal.timeout(timeoutMs),
        headersTimeout: timeoutMs, bodyTimeout: timeoutMs, headers: { "user-agent": "aiwb-fork-settings-proxy-check" },
      });
      try {
        await (res.body?.dump ? res.body.dump() : res.body?.text?.());
      } catch {}
      return { status: res.statusCode };
    },
    async close() {
      await Promise.allSettled([direct.close?.(), proxied?.close?.()]);
    },
  };
}

async function probe(transport, host, via, now) {
  const start = now();
  try {
    const { status } = await transport.request(`https://${host}/`, via);
    return { status, ms: Math.round(now() - start) };
  } catch (error) {
    return { ...classifyError(error), ms: Math.round(now() - start) };
  }
}

const BLOCK_STATUSES = new Set([403, 451]);
const reached = (r) => Number.isInteger(r?.status);
const open = (r) => reached(r) && !BLOCK_STATUSES.has(r.status);

/** What a direct / proxied result pair suggests for a host under its current route. */
export function hintFor(direct, proxied, route) {
  if (!proxied || proxied.skipped) {
    return open(direct) ? null : { code: "no-proxy", text: "fails directly; no managed proxy to compare" };
  }
  if (!open(direct) && open(proxied)) {
    const how = reached(direct) ? `HTTP ${direct.status}` : direct.error;
    return route === "direct"
      ? { code: "add-to-proxy", text: `blocked directly (${how}), works via proxy → add to proxy list` }
      : { code: "proxy-needed", text: `blocked directly (${how}), works via proxy; routed through the proxy` };
  }
  if (open(direct) && !open(proxied)) {
    return route === "proxy"
      ? { code: "route-direct", text: "works directly, fails via proxy → route direct" }
      : { code: "direct-only", text: "works directly, fails via proxy; routed direct" };
  }
  if (!open(direct) && !open(proxied)) return { code: "unreachable", text: "fails both ways" };
  return null;
}

async function pool(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Hosts to check: the route hosts, the defaults and extra hosts (validated, deduplicated, at most
 * CHECK_MAX_HOSTS). Returns { hosts: [{ host, from }] } or { error }.
 */
export function checkList({ routeHosts = [], extra = [] } = {}) {
  if (!Array.isArray(extra)) return { error: "hosts must be a list of host names" };
  const hosts = [];
  const add = (raw, from) => {
    const host = normalizeHost(raw);
    if (!host) return `not a host name: ${String(raw).slice(0, 80)}`;
    if (!hosts.some((h) => h.host === host)) hosts.push({ host, from });
    return null;
  };
  for (const h of extra) {
    const error = add(h, "extra");
    if (error) return { error };
  }
  for (const h of routeHosts) add(h, "routes");
  for (const h of DEFAULT_CHECK_HOSTS) add(h, "default");
  return { hosts: hosts.slice(0, CHECK_MAX_HOSTS), truncated: hosts.length > CHECK_MAX_HOSTS };
}

/**
 * Checks each host with an HTTPS HEAD to https://<host>/ directly and through the managed proxy.
 * transport: createTransport() or a fake; route: (host) => proxy|direct under the current routes.
 */
export async function checkHosts({ hosts, transport, route = () => "proxy", concurrency = CHECK_CONCURRENCY, now = () => performance.now() }) {
  const results = await pool(hosts, concurrency, async ({ host, from }) => {
    const [direct, proxied] = await Promise.all([
      probe(transport, host, "direct", now),
      transport.hasProxy ? probe(transport, host, "proxy", now) : Promise.resolve({ skipped: "no managed proxy URL" }),
    ]);
    const r = route(host);
    return { host, from, route: r, direct, proxy: proxied, hint: hintFor(direct, proxied, r) };
  });
  return results;
}
