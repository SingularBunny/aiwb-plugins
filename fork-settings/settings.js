// OpenClaw fork variables: the fork reads them at use time; the env.vars setting sets them,
// without them behavior is as in OpenClaw. Defaults and parsing rules match the fork code
// (FORK.md and docs/help/environment.md in the fork list them; the readers are named in `where`).
//
// kind:
//   int    — the fork takes a safe integer above zero, otherwise the default; min/max are the range
//            `set` accepts (a sane range, not a fork limit), unit is what the number counts.
//   flag   — default off: the fork takes 1/true/yes (any case) as on, anything else as off.
//            default on (onUnless): the fork turns it off only on the listed values.
//   grants — `<plugin id>=<method>,<method>;<plugin id>=<method>`; wildcards grant nothing.
//   wait   — milliseconds or `unlimited` (any case); unset means upstream (default null). The fork takes
//            a safe integer above `above` (upstream's own bound) or `unlimited`, anything else as unset;
//            `set` accepts above+1..max or `unlimited`.
//   routes — `<host suffix>,<host suffix>=<proxy|direct|URL>;*=<proxy|direct|URL>`: which hosts use the
//            managed proxy (proxy.proxyUrl). A URL target must equal proxy.proxyUrl in the fork.
//   backends — `<CLI backend id>=<proxy|direct|URL>;…`: proxy env of CLI agent backend children.
//            routes and backends may hold proxy URLs with credentials: every value shown or logged
//            has URL targets replaced by `<proxy URL>`.
//   folders — `*=<folders>;<agent id>=<folders>`: folders for every agent (`*`) and per agent; a
//            rule without `=` is a `*` rule. Folders are absolute or `~` paths separated by `:`
//            (PATH style). The fork drops relative, missing and non-directory entries and unknown
//            scopes and refuses `/` and the home folder (or a folder containing it); `set` refuses
//            bad text here, the Gateway method checks the folders on disk (chat-files.js).
const MiB = 1024 * 1024;

export const FORK_SETTINGS = [
  { name: "OPENCLAW_WORKER_PENDING_TASKS", kind: "int", default: 128, min: 1, max: 1_000_000, unit: "tasks",
    about: "pending tasks per worker queue", where: "packages/worker-runtime/src/worker-task-capacity.ts" },
  { name: "OPENCLAW_WORKER_PENDING_BYTES", kind: "int", default: 256 * MiB, min: MiB, max: 16 * 1024 * MiB, unit: "bytes",
    about: "pending bytes per worker queue, including the SQLite worker broker", where: "packages/worker-runtime/src/worker-task-capacity.ts" },
  { name: "OPENCLAW_WORKER_HEAP_MB", kind: "int", default: 512, min: 64, max: 65_536, unit: "MB",
    about: "old-generation heap of state, transcript and SQLite workers", where: "packages/worker-runtime/src/worker-task-capacity.ts" },
  { name: "OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS", kind: "int", default: 200, min: 1, max: 50_000, unit: "items",
    about: "how many entries catalog \"continue\" carries over", where: "src/plugins/session-catalog-history-import.ts" },
  { name: "OPENCLAW_CATALOG_CONTINUATION_MAX_BYTES", kind: "int", default: 512 * 1024, min: 1024, max: 64 * MiB, unit: "bytes",
    about: "size that catalog \"continue\" carries over", where: "src/plugins/session-catalog-history-import.ts" },
  { name: "OPENCLAW_CATALOG_IMPORT_OWNER", kind: "flag", default: false,
    about: "catalog messages count as owner messages", where: "src/plugins/session-catalog-history-import.ts" },
  { name: "OPENCLAW_MEMORY_INDEX_ON_START", kind: "flag", default: false,
    about: "memory indexes open at Gateway start", where: "extensions/memory-core/index.ts" },
  { name: "OPENCLAW_CLAUDE_CHROME", kind: "flag", default: false,
    about: "Claude CLI agent turns get Claude in Chrome (--chrome)", where: "extensions/anthropic/cli-shared.ts" },
  { name: "OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS", kind: "flag", default: true, onUnless: ["0", "false"],
    about: "Claude CLI runs emit next-prompt suggestions (composer ghost text)", where: "extensions/anthropic/cli-shared.ts" },
  { name: "OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS", kind: "int", default: 12_000, min: 1000, max: 3_600_000, unit: "ms",
    about: "minimum gap between live progress digests of a run (utility model calls)", where: "src/gateway/session-utility-cadence.ts" },
  { name: "OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS", kind: "int", default: 90_000, min: 1000, max: 86_400_000, unit: "ms",
    about: "minimum gap between Activity recaps while a run goes on (utility model calls)", where: "src/gateway/session-utility-cadence.ts" },
  { name: "OPENCLAW_RESTART_AGENT_RUN_WAIT_MS", kind: "wait", default: null, above: 300_000, min: 300_001, max: 7 * 86_400_000, unit: "ms",
    about: "how long a restart required by a config change waits for running agent turns (upstream: 5 min, then aborts them)",
    where: "src/gateway/restart-agent-run-wait.ts" },
  { name: "OPENCLAW_PROXY_ROUTES", kind: "routes", default: "",
    about: "which hosts use the managed proxy and which connect directly (unset: all through the proxy)",
    where: "src/infra/net/proxy/proxy-routes.ts" },
  { name: "OPENCLAW_CLI_BACKEND_PROXY", kind: "backends", default: "",
    about: "proxy env of CLI agent backend children (unset: the route of the backend's API host)",
    where: "src/infra/net/proxy/proxy-routes.ts" },
  { name: "OPENCLAW_ASSISTANT_MEDIA_ROOTS", kind: "folders", default: "",
    about: "extra folders (for all agents and per agent) whose files the chat previews and downloads, any type, in Full Access sessions (unset: only the session's folders; images anywhere)",
    where: "src/gateway/assistant-media-extra-roots.ts" },
  { name: "OPENCLAW_PLUGIN_GATEWAY_METHODS", kind: "grants", default: "",
    about: "Gateway methods other plugins may call through api.runtime.gateway.request", where: "src/gateway/server-plugin-gateway-grants.ts" },
];

export const findSetting = (name) => FORK_SETTINGS.find((s) => s.name === name);

const FLAG_ON = /^(1|true|yes)$/i;
const FLAG_KNOWN = /^(1|true|yes|0|false|no)$/i;
const UNLIMITED = /^unlimited$/i;

/** Plugin id → methods, as the fork parses OPENCLAW_PLUGIN_GATEWAY_METHODS. */
export function parseGrants(raw) {
  const grants = {};
  for (const entry of (raw ?? "").split(";")) {
    const sep = entry.indexOf("=");
    const id = entry.slice(0, Math.max(sep, 0)).trim();
    if (!id) continue;
    const methods = entry.slice(sep + 1).split(",").map((m) => m.trim()).filter((m) => m && !m.includes("*"));
    if (methods.length) grants[id] = [...new Set([...(grants[id] ?? []), ...methods])];
  }
  return grants;
}

/** Separator of folders inside a rule (the fork splits on `:`, like PATH). */
export const PATH_LIST_SEPARATOR = ":";
/** Scope of the folders every agent gets. */
export const ALL_AGENTS = "*";
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** The folders of one list: trimmed, empty ones dropped, duplicates kept once. */
export function splitPathList(raw) {
  const list = Array.isArray(raw) ? raw.map((e) => String(e ?? "")) : String(raw ?? "").split(PATH_LIST_SEPARATOR);
  return [...new Set(list.map((e) => e.trim()).filter(Boolean))];
}

/** Why a folder entry is refused by its text alone (null: fine). Disk checks are in chat-files.js. */
export function pathEntryProblem(entry) {
  const text = String(entry ?? "").trim();
  if (!text) return "empty";
  if (/[:;]/.test(text)) return "contains \":\" or \";\"";
  if (!(text.startsWith("/") || text === "~" || text.startsWith("~/"))) return "not an absolute or ~ path";
  if (/^\/+$/.test(text)) return "the filesystem root is not allowed";
  if (/^~\/*$/.test(text)) return "the home folder itself is not allowed";
  return null;
}

/** `*` or a valid agent id (lower case), else null. */
export function folderScope(raw) {
  const text = String(raw ?? "").trim();
  if (text === ALL_AGENTS) return ALL_AGENTS;
  return AGENT_ID.test(text) ? text.toLowerCase() : null;
}

/**
 * Parses folder rules as the fork does: { scopes: { "*": [...], <agent id>: [...] } } with the
 * text of each folder, plus problems [{ scope, entry?, problem }] for what the fork would skip.
 */
export function parseFolderRules(raw) {
  const scopes = {};
  const problems = [];
  for (const rule of String(raw ?? "").split(";").map((r) => r.trim()).filter(Boolean)) {
    const sep = rule.indexOf("=");
    const scope = folderScope(sep < 0 ? ALL_AGENTS : rule.slice(0, sep));
    if (!scope) {
      problems.push({ scope: rule.slice(0, sep).trim(), problem: "not * or an agent id" });
      continue;
    }
    const list = (scopes[scope] ??= []);
    for (const entry of splitPathList(rule.slice(sep + 1))) {
      const problem = pathEntryProblem(entry);
      if (problem) problems.push({ scope, entry, problem });
      else if (!list.includes(entry)) list.push(entry);
    }
  }
  return { scopes, problems };
}

/** Folder rules as stored: `*` first, then agents in the given order; empty scopes dropped. */
export function formatFolderRules(scopes) {
  const order = [ALL_AGENTS, ...Object.keys(scopes).filter((k) => k !== ALL_AGENTS)];
  return order.filter((k) => scopes[k]?.length).map((k) => `${k}=${scopes[k].join(PATH_LIST_SEPARATOR)}`).join(";");
}

const formatGrants = (grants) => Object.entries(grants).map(([id, methods]) => `${id}=${methods.join(",")}`).join(";");

const HOST_SUFFIX = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const BACKEND_ID = /^[a-z0-9][a-z0-9._-]*$/;
const REDACTED_URL = "<proxy URL>";

function parseTarget(raw) {
  const text = raw.trim();
  if (/^(proxy|direct)$/i.test(text)) return text.toLowerCase();
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") return text;
  } catch {}
  return undefined;
}

/**
 * Parses routes (OPENCLAW_PROXY_ROUTES) or backends (OPENCLAW_CLI_BACKEND_PROXY) as the fork does.
 * Returns { rules: [{ keys, target }] } or { error } (errors never quote a target).
 */
export function parseProxyRules(kind, raw) {
  const rules = [];
  let star = false;
  const entries = (raw ?? "").split(";").map((e) => e.trim()).filter(Boolean);
  for (const [i, entry] of entries.entries()) {
    const sep = entry.indexOf("=");
    const target = sep > 0 ? parseTarget(entry.slice(sep + 1)) : undefined;
    if (!target) return { error: `rule ${i + 1} is not <${kind === "routes" ? "hosts" : "backend id"}>=<proxy|direct|http(s) proxy URL>` };
    const keys = [];
    for (const key of entry.slice(0, sep).split(",").map((k) => k.trim()).filter(Boolean)) {
      if (kind === "routes" && key === "*") {
        if (star) return { error: "more than one * rule" };
        star = true;
        keys.push("*");
        continue;
      }
      const norm = kind === "routes" ? key.toLowerCase().replace(/^\*?\./, "").replace(/\.$/, "") : key.toLowerCase();
      if (!(kind === "routes" ? HOST_SUFFIX : BACKEND_ID).test(norm)) return { error: `rule ${i + 1} has an invalid ${kind === "routes" ? "host" : "backend id"}` };
      keys.push(norm);
    }
    if (!keys.length || (kind === "backends" && keys.length !== 1)) return { error: `rule ${i + 1} needs ${kind === "routes" ? "hosts" : "one backend id"}` };
    rules.push({ keys, target });
  }
  return { rules };
}

const isUrlTarget = (target) => target !== "proxy" && target !== "direct";
const formatRules = (rules, redact) =>
  rules.map((r) => `${r.keys.join(",")}=${redact && isUrlTarget(r.target) ? REDACTED_URL : r.target}`).join(";");

/** Replaces proxy URL targets in a routes/backends value by `<proxy URL>`; other text is returned as is. */
export function redactProxyRules(kind, raw) {
  if (raw === undefined || raw === null) return raw;
  const parsed = parseProxyRules(kind, String(raw));
  // Unparseable text may still hold a URL: show nothing of it.
  return parsed.error ? (String(raw).trim() ? "<invalid>" : "") : formatRules(parsed.rules, true);
}

const isSecretKind = (kind) => kind === "routes" || kind === "backends";

/**
 * How the fork reads a value. invalid: the fork ignores the text (falls back to the default);
 * outOfRange: the fork uses it, but it is outside the range `set` accepts.
 */
export function parseSetting(setting, raw) {
  const text = raw?.trim() ?? "";
  if (setting.kind === "flag") {
    const value = setting.onUnless
      ? !setting.onUnless.includes(text.toLowerCase())
      : FLAG_ON.test(text);
    return { value, valid: !text || FLAG_KNOWN.test(text) };
  }
  if (setting.kind === "grants") {
    const value = formatGrants(parseGrants(text));
    return { value, valid: !text || value.length > 0 };
  }
  if (setting.kind === "folders") {
    const { scopes, problems } = parseFolderRules(text);
    return { value: formatFolderRules(scopes), valid: problems.length === 0 };
  }
  if (isSecretKind(setting.kind)) {
    if (!text) return { value: "", valid: true };
    const parsed = parseProxyRules(setting.kind, text);
    // The fork ignores an invalid rule set as a whole (upstream routing).
    return parsed.error ? { value: "", valid: false } : { value: formatRules(parsed.rules, true), valid: true };
  }
  if (!text) return { value: setting.default, valid: true };
  if (setting.kind === "wait") {
    if (UNLIMITED.test(text)) return { value: "unlimited", valid: true };
    const ms = Number(text);
    if (!(Number.isSafeInteger(ms) && ms > setting.above)) return { value: setting.default, valid: false };
    return { value: ms, valid: true, ...(ms > setting.max ? { outOfRange: true } : {}) };
  }
  const n = Number(text);
  if (!(Number.isSafeInteger(n) && n > 0)) return { value: setting.default, valid: false };
  return { value: n, valid: true, ...(n < setting.min || n > setting.max ? { outOfRange: true } : {}) };
}

/**
 * Checks a value for `set` and returns the text to store in env.vars, or an error.
 * int: an integer (number or digits) within min..max; flag: true/false (or 1/0, yes/no);
 * grants: `<plugin id>=<method>,…;…` with exact method names; wait: an integer within min..max or
 * `unlimited`.
 */
export function validateSettingValue(name, value) {
  const setting = findSetting(name);
  if (!setting) return { ok: false, error: `unknown fork setting: ${name}` };
  if (setting.kind === "wait" && typeof value === "string" && UNLIMITED.test(value.trim())) {
    return { ok: true, raw: "unlimited" };
  }
  if (setting.kind === "int" || setting.kind === "wait") {
    const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
    const more = setting.kind === "wait" ? " or \"unlimited\"" : "";
    if (!Number.isSafeInteger(n)) return { ok: false, error: `${name} takes an integer (${setting.unit})${more}` };
    if (n < setting.min || n > setting.max) {
      return { ok: false, error: `${name} must be within ${setting.min}..${setting.max} ${setting.unit}${more}` };
    }
    return { ok: true, raw: String(n) };
  }
  if (setting.kind === "flag") {
    const text = typeof value === "boolean" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (!FLAG_KNOWN.test(text)) return { ok: false, error: `${name} takes true or false` };
    return { ok: true, raw: FLAG_ON.test(text) ? "1" : "0" };
  }
  if (setting.kind === "folders") {
    const shape = `"*=<folder>:<folder>;<agent id>=<folder>" or {"*": [folders], "<agent id>": [folders]} (absolute or ~ paths)`;
    let scopes;
    if (typeof value === "string") {
      const parsed = parseFolderRules(value);
      const bad = parsed.problems[0];
      if (bad) return { ok: false, error: `${name}: ${bad.entry ?? bad.scope}: ${bad.problem}` };
      scopes = parsed.scopes;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      scopes = {};
      for (const [key, list] of Object.entries(value)) {
        const scope = folderScope(key);
        if (!scope) return { ok: false, error: `${name}: ${key}: not * or an agent id` };
        if (!Array.isArray(list)) return { ok: false, error: `${name}: ${key}: takes a list of folders` };
        for (const entry of splitPathList(list)) {
          const problem = pathEntryProblem(entry);
          if (problem) return { ok: false, error: `${name}: ${entry}: ${problem}` };
          const folders = (scopes[scope] ??= []);
          if (!folders.includes(entry)) folders.push(entry);
        }
      }
    } else {
      return { ok: false, error: `${name} takes ${shape}` };
    }
    for (const key of Object.keys(scopes)) {
      scopes[key] = [...new Set(scopes[key].map((e) => (e.length > 1 ? e.replace(/\/+$/, "") : e)))];
    }
    const raw = formatFolderRules(scopes);
    if (!raw) return { ok: false, error: `${name} takes ${shape}; use unset to remove it` };
    return { ok: true, raw };
  }
  if (isSecretKind(setting.kind)) {
    const shape = setting.kind === "routes"
      ? "\"<host>,<host>=<proxy|direct|URL>;*=<proxy|direct|URL>\""
      : "\"<backend id>=<proxy|direct|URL>;…\"";
    if (typeof value !== "string" || !value.trim()) return { ok: false, error: `${name} takes ${shape}` };
    const parsed = parseProxyRules(setting.kind, value);
    if (parsed.error) return { ok: false, error: `${name}: ${parsed.error}; takes ${shape}` };
    return { ok: true, raw: formatRules(parsed.rules, false) };
  }
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${name} takes "<plugin id>=<method>,<method>;<plugin id>=<method>"` };
  }
  const entries = value.split(";").map((e) => e.trim()).filter(Boolean);
  for (const entry of entries) {
    const sep = entry.indexOf("=");
    const methods = sep > 0 ? entry.slice(sep + 1).split(",").map((m) => m.trim()) : [];
    if (sep <= 0 || !methods.length || methods.some((m) => !/^[A-Za-z0-9_.:-]+$/.test(m))) {
      return { ok: false, error: `${name}: "${entry}" is not "<plugin id>=<exact method>,…" (no wildcards)` };
    }
  }
  return { ok: true, raw: formatGrants(parseGrants(value)) };
}

/** Writes (raw) or removes (raw undefined) env.vars.<name> in a config draft. */
export function applySettingToConfig(draft, name, raw) {
  if (raw === undefined) {
    if (draft.env?.vars && name in draft.env.vars) delete draft.env.vars[name];
    return;
  }
  draft.env ??= {};
  draft.env.vars ??= {};
  draft.env.vars[name] = raw;
}

/**
 * Effective values in this process. source: env.vars means from the setting (OpenClaw puts it into the process
 * environment), environment means from the environment or ~/.openclaw/.env (overrides the setting), default means unset.
 */
export function effectiveSettings({ env = process.env, configVars = {} } = {}) {
  return FORK_SETTINGS.map((s) => {
    const raw = env[s.name];
    const configured = configVars[s.name];
    const set = raw !== undefined && raw.trim() !== "";
    const source = !set ? "default" : configured !== undefined && String(configured) === raw ? "env.vars" : "environment";
    const { value, valid, outOfRange } = parseSetting(s, raw);
    const shown = (text) => (isSecretKind(s.kind) ? redactProxyRules(s.kind, text) : text);
    return { name: s.name, kind: s.kind, about: s.about, value, default: s.default,
      ...(s.unit ? { unit: s.unit } : {}), ...(s.kind === "int" || s.kind === "wait" ? { min: s.min, max: s.max } : {}), source,
      ...(set ? { raw: shown(raw) } : {}), ...(valid ? {} : { invalid: true }), ...(outOfRange ? { outOfRange: true } : {}),
      ...(configured !== undefined && String(configured) !== raw ? { configured: shown(String(configured)) } : {}) };
  });
}

/** A single line for the Gateway log. Grant lists are shown as plugin ids only. */
export const summaryLine = (rows) => "aiwb-fork-settings: " + rows.map((r) => {
  const value = r.kind === "grants" ? Object.keys(parseGrants(r.value)).join("+") || "none"
    : isSecretKind(r.kind) || r.kind === "folders" ? r.value || "upstream"
    : r.value === null ? "upstream" : r.value;
  return `${r.name.replace(/^OPENCLAW_/, "")}=${value}${r.source === "default" ? "" : ` (${r.source})`}` +
    `${r.invalid ? " [invalid — default]" : ""}${r.outOfRange ? " [out of range]" : ""}`;
}).join(", ");

/**
 * set (value given) or unset (value undefined/null) one setting; returns the Gateway respond() arguments.
 * deps.mutateConfigFile is api.runtime.config.mutateConfigFile; deps.env the process environment;
 * deps.configVars the env.vars of the current config. dryRun: check and answer as set/unset would, write nothing.
 */
export async function changeSetting(params, { mutateConfigFile, env = process.env, configVars = {} }, { dryRun = false } = {}) {
  const name = typeof params?.name === "string" ? params.name.trim() : "";
  if (!findSetting(name)) {
    return [false, undefined, { code: "INVALID_REQUEST", message: `unknown fork setting: ${name || "(none)"}` }];
  }
  let raw;
  if (params.value !== undefined && params.value !== null) {
    const checked = validateSettingValue(name, params.value);
    if (!checked.ok) return [false, undefined, { code: "INVALID_REQUEST", message: checked.error }];
    raw = checked.raw;
  }
  if (!dryRun) await mutateConfigFile({ afterWrite: { mode: "auto" }, mutate: (draft) => applySettingToConfig(draft, name, raw) });
  const before = env[name];
  // A process value that did not come from env.vars (the environment or ~/.openclaw/.env) keeps winning.
  const external = before !== undefined && before.trim() !== "" && String(configVars[name] ?? "") !== before;
  return [true, {
    name,
    ...(raw === undefined ? { unset: true } : { stored: isSecretKind(findSetting(name).kind) ? redactProxyRules(findSetting(name).kind, raw) : raw }),
    path: `env.vars.${name}`,
    ...(dryRun ? { dryRun: true } : {}),
    note: "The Gateway reloads env.vars and the fork reads the value on its next use; check with aiwb-fork-settings.effective.",
    ...(external ? { overriddenByEnvironment: isSecretKind(findSetting(name).kind) ? redactProxyRules(findSetting(name).kind, before) : before } : {}),
  }, undefined];
}
