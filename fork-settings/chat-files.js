// Chat files page data: the fork's OPENCLAW_ASSISTANT_MEDIA_ROOTS (extra folders whose files the
// Control UI chat previews and downloads, any type, in Full Access sessions) as folder lists for
// all agents (`*`) and per agent (a session gets `*` plus its agent's), each folder checked on the Gateway's disk the way the fork checks it: an absolute or `~` path to an
// existing directory, never `/`, the home folder itself or a folder containing it (compared by
// real path, so a symlink to the home folder is refused too).
import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { baseValue, readInstallerKeys } from "./proxy.js";
import { ALL_AGENTS, PATH_LIST_SEPARATOR, parseFolderRules, pathEntryProblem } from "./settings.js";

export const CHAT_FILES = "OPENCLAW_ASSISTANT_MEDIA_ROOTS";
/** Installer key of <state>/.env that writes the setting on each install. */
export const INSTALLER_CHAT_FILES_KEY = "WORKBENCH_CHAT_FILE_FOLDERS";
/** Folders offered on the page when they exist and are not listed yet. */
export const SUGGESTED_FOLDERS = ["~/Desktop", "~/Downloads", "~/Documents"];

const STATUS_TEXT = {
  ok: "folder exists",
  relative: "not an absolute or ~ path",
  missing: "does not exist",
  "not-dir": "not a folder",
  root: "the filesystem root is not allowed",
  home: "the home folder (or a folder containing it) is not allowed",
  separator: "contains \":\" or \";\"",
};

const defaultFs = {
  realpath: (p) => realpathSync(p),
  isDirectory: (p) => statSync(p).isDirectory(),
};

function tryRealpath(fs, p) {
  try {
    return fs.realpath(p);
  } catch {
    return undefined;
  }
}

/** Home folders the fork refuses: HOME, OPENCLAW_HOME and the OS home, as given and as real paths. */
export function homeFolders({ env = process.env, home = os.homedir(), fs = defaultFs } = {}) {
  const out = new Set();
  for (const h of [env.HOME, env.OPENCLAW_HOME, home]) {
    const text = typeof h === "string" ? h.trim() : "";
    if (!text || !path.isAbsolute(text)) continue;
    const resolved = path.resolve(text);
    out.add(resolved);
    const real = tryRealpath(fs, resolved);
    if (real) out.add(real);
  }
  return [...out];
}

const homeOf = ({ env = process.env, home = os.homedir() } = {}) => env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || home;

/** `~` and `~/x` with the Gateway's home folder; other text as is. */
export function expandHome(entry, deps = {}) {
  const text = String(entry ?? "").trim();
  if (text === "~") return homeOf(deps);
  if (text.startsWith("~/")) return path.join(homeOf(deps), text.slice(2));
  return text;
}

const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * One folder as the fork would take it: { entry, path (expanded), status, ok, text, realPath? }.
 * status: ok, relative, missing, not-dir, root, home, separator.
 */
export function checkFolder(entry, deps = {}) {
  const fs = deps.fs ?? defaultFs;
  const text = String(entry ?? "").trim();
  const result = (status, extra = {}) => ({ entry: text, status, ok: status === "ok", text: STATUS_TEXT[status], ...extra });
  const problem = pathEntryProblem(text);
  if (problem && /[:;]/.test(text)) return result("separator");
  const expanded = expandHome(text, deps);
  if (!path.isAbsolute(expanded)) return result("relative");
  const resolved = path.resolve(expanded);
  const realPath = tryRealpath(fs, resolved);
  if (!realPath) return result("missing", { path: resolved });
  let directory = false;
  try {
    directory = fs.isDirectory(realPath);
  } catch {}
  if (!directory) return result("not-dir", { path: resolved, realPath });
  if (realPath === path.parse(realPath).root) return result("root", { path: resolved, realPath });
  if (homeFolders({ ...deps, fs }).some((h) => inside(realPath, h))) return result("home", { path: resolved, realPath });
  return result("ok", { path: resolved, realPath });
}

/** Agents of the config ({ id, name }), from agents.entries or agents.list; `main` when the config lists none. */
export function configuredAgents(config = {}) {
  const agents = config?.agents;
  const out = [];
  const add = (id, name) => {
    const key = typeof id === "string" ? id.trim().toLowerCase() : "";
    if (key && !out.some((a) => a.id === key)) out.push({ id: key, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) });
  };
  if (agents?.entries && typeof agents.entries === "object") {
    for (const [id, entry] of Object.entries(agents.entries)) add(id, entry?.name ?? entry?.identity?.name);
  } else if (Array.isArray(agents?.list)) {
    for (const entry of agents.list) add(entry?.id, entry?.name ?? entry?.identity?.name);
  }
  if (!out.length && !agents?.entries && !agents?.list) add("main");
  return out;
}

const checkedScopes = (raw, deps) => {
  const { scopes, problems } = parseFolderRules(raw);
  const checked = Object.fromEntries(Object.entries(scopes).map(([scope, list]) => [scope, list.map((e) => checkFolder(e, deps))]));
  for (const p of problems) {
    if (!p.entry) continue;
    (checked[p.scope] ??= []).push(checkFolder(p.entry, deps));
  }
  return { checked, badScopes: problems.filter((p) => !p.entry).map((p) => p.scope) };
};

/** Everything the Chat files page shows. deps: { config, env, configVars, home, read, exists, fs }. */
export function chatFilesOverview(deps = {}) {
  const env = deps.env ?? process.env;
  const configVars = deps.configVars ?? {};
  const stored = baseValue(CHAT_FILES, { env, configVars });
  const configured = configVars[CHAT_FILES];
  const processValue = env[CHAT_FILES];
  const { checked, badScopes } = checkedScopes(stored, deps);
  const agents = configuredAgents(deps.config);
  // What the fork uses now: the process value, checked the same way, per scope.
  const live = checkedScopes(processValue ?? "", deps).checked;
  const effective = Object.fromEntries(Object.entries(live)
    .map(([scope, list]) => [scope, [...new Set(list.filter((c) => c.ok).map((c) => c.realPath))]])
    .filter(([, list]) => list.length));
  const installer = readInstallerKeys([INSTALLER_CHAT_FILES_KEY], deps);
  const listed = new Set((checked[ALL_AGENTS] || []).map((e) => e.realPath).filter(Boolean));
  const suggestions = SUGGESTED_FOLDERS.map((e) => checkFolder(e, deps)).filter((c) => c.ok && !listed.has(c.realPath)).map((c) => c.entry);
  return {
    name: CHAT_FILES,
    separator: PATH_LIST_SEPARATOR,
    stored,
    scopes: { [ALL_AGENTS]: checked[ALL_AGENTS] || [], ...Object.fromEntries(Object.entries(checked).filter(([k]) => k !== ALL_AGENTS)) },
    ...(badScopes.length ? { badScopes } : {}),
    agents,
    effective,
    source: configured !== undefined && configured !== null ? "env.vars" : processValue?.trim() ? "environment" : "default",
    ...(processValue?.trim() && configured !== undefined && String(configured) !== processValue ? { overriddenByEnvironment: true } : {}),
    installer: { ...installer, rewrites: Boolean(installer.keys[INSTALLER_CHAT_FILES_KEY]) },
    suggestions,
  };
}

/** Disk problems of a value about to be stored: [{ scope, entry, status, text }] for folders that are not ok. */
export function folderProblems(value, deps = {}) {
  const scopes = typeof value === "string" ? parseFolderRules(value).scopes : value && typeof value === "object" ? value : {};
  return Object.entries(scopes).flatMap(([scope, list]) => (Array.isArray(list) ? list : [])
    .map((e) => checkFolder(e, deps)).filter((c) => !c.ok).map(({ entry, status, text }) => ({ scope, entry, status, text })));
}
