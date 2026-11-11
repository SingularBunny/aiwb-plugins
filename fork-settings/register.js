// Gateway side of aiwb-fork-settings: methods and the Proxy page descriptor. Separate from index.js
// so tests can register it against a fake api without the OpenClaw SDK.
//
//   openclaw gateway call aiwb-fork-settings.effective --json
//   openclaw gateway call aiwb-fork-settings.set --params '{"name":"OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS","value":90000}' --json
//   openclaw gateway call aiwb-fork-settings.unset --params '{"name":"OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS"}' --json
//   openclaw gateway call aiwb-fork-settings.proxy --json
//   openclaw gateway call aiwb-fork-settings.proxyCheck --params '{"hosts":["example.com"]}' --json
//   openclaw gateway call aiwb-fork-settings.chatFiles --json
//   openclaw gateway call aiwb-fork-settings.checkFolder --params '{"path":"~/Downloads"}' --json
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  KIND_OF, ROUTES, baseValue, checkHosts, checkList, composeRules, createTransport, editableRules,
  installerProxyKeys, loadUndici, managedProxy, proxyOverview, revisionOf, routeFor, routesState,
} from "./proxy.js";
import { CHAT_FILES, INSTALLER_CHAT_FILES_KEY, chatFilesOverview, checkFolder, folderProblems } from "./chat-files.js";
import { changeSetting, effectiveSettings, summaryLine } from "./settings.js";

export const PLUGIN_ID = "aiwb-fork-settings";
export const TAB_ID = "proxy";
export const CHAT_FILES_TAB_ID = "chat-files";
export const METHODS = {
  effective: `${PLUGIN_ID}.effective`,
  set: `${PLUGIN_ID}.set`,
  unset: `${PLUGIN_ID}.unset`,
  proxy: `${PLUGIN_ID}.proxy`,
  proxyCheck: `${PLUGIN_ID}.proxyCheck`,
  chatFiles: `${PLUGIN_ID}.chatFiles`,
  checkFolder: `${PLUGIN_ID}.checkFolder`,
};

function forkPackage(env) {
  const mark = path.join(env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"), "workbench", "openclaw-package.sha256");
  return existsSync(mark) ? readFileSync(mark, "utf8").trim() : null;
}

const invalid = (message, code = "INVALID_REQUEST") => [false, undefined, { code, message }];

/**
 * opts (tests): env, home, read, exists (file access for the Claude Code and installer reads),
 * makeTransport({ proxyUrl, proxyCa }) for the check, now.
 */
export function registerForkSettings(api, opts = {}) {
  const env = opts.env ?? process.env;
  const files = { home: opts.home ?? os.homedir(), read: opts.read ?? readFileSync, exists: opts.exists ?? existsSync,
    ...(opts.fs ? { fs: opts.fs } : {}) };
  const config = () => api.runtime.config.current() || {};
  const configVars = () => config()?.env?.vars || {};
  const current = () => effectiveSettings({ env, configVars: configVars() });
  api.logger?.info?.(summaryLine(current()));

  api.registerGatewayMethod(METHODS.effective, async ({ respond }) => {
    respond(true, { fork: forkPackage(env), pid: process.pid, settings: current() }, undefined);
  }, { scope: "operator.read" });

  const deps = () => ({ mutateConfigFile: (p) => api.runtime.config.mutateConfigFile(p), env, configVars: configVars() });

  /** The installer rewrites some settings from <state>/.env on each install: say so in their answers. */
  const withInstallerNote = (answer, name) => {
    if (!answer[0]) return answer;
    if (name === ROUTES && installerProxyKeys({ env, ...files }).rewritesRoutes) {
      return [true, { ...answer[1], installerNote: "WORKBENCH_PROXY_* in ~/.openclaw/.env sets the routes again on the next install; update the .env key too to keep this change" }, undefined];
    }
    if (name === CHAT_FILES && chatFilesOverview({ env, configVars: configVars(), ...files }).installer.rewrites) {
      return [true, { ...answer[1], installerNote: `${INSTALLER_CHAT_FILES_KEY} in ~/.openclaw/.env sets the folders again on the next install; update the .env key too to keep this change` }, undefined];
    }
    return answer;
  };

  /** Chat file folders are checked on disk: `/` and the home folder are refused, others reported. */
  const checkChatFolders = (params) => {
    const problems = folderProblems(params?.value, { env, ...files });
    const refused = problems.find((p) => p.status === "root" || p.status === "home" || p.status === "relative" || p.status === "separator");
    if (refused) return { error: invalid(`${CHAT_FILES}: ${refused.entry}: ${refused.text}`) };
    return { problems };
  };

  async function set(params) {
    const name = typeof params?.name === "string" ? params.name.trim() : "";
    const dryRun = params?.dryRun === true;
    if (params?.rules !== undefined) {
      const kind = KIND_OF[name];
      if (!kind) return invalid(`rules apply only to ${Object.keys(KIND_OF).join(" and ")}`);
      const base = baseValue(name, { env, configVars: configVars() });
      if (params.revision !== revisionOf(base)) {
        return invalid(`${name} changed since it was read; reload and edit again`, "CONFLICT");
      }
      const { urls, error } = editableRules(kind, base);
      if (error && Array.isArray(params.rules?.entries) && params.rules.entries.some((e) => /^url:/i.test(String(e?.target)))) {
        return invalid(`${name}: the stored value is invalid, so it has no URL to keep`);
      }
      const composed = composeRules(kind, params.rules, urls);
      if (composed.error) return invalid(`${name}: ${composed.error}`);
      if (!composed.raw) return withInstallerNote(await changeSetting({ name }, deps(), { dryRun }), name);
      return withInstallerNote(await changeSetting({ name, value: composed.raw }, deps(), { dryRun }), name);
    }
    if (params?.value === undefined || params?.value === null) {
      return invalid("value is required; use aiwb-fork-settings.unset to return to the default");
    }
    if (name === CHAT_FILES) {
      const checked = checkChatFolders(params);
      if (checked.error) return checked.error;
      const answer = withInstallerNote(await changeSetting(params, deps(), { dryRun }), name);
      // The fork skips missing folders and files in their place; say which.
      return answer[0] && checked.problems.length ? [true, { ...answer[1], problems: checked.problems }, undefined] : answer;
    }
    return withInstallerNote(await changeSetting(params, deps(), { dryRun }), name);
  }

  api.registerGatewayMethod(METHODS.set, async ({ params, respond }) => {
    respond(...(await set(params)));
  }, { scope: "operator.admin" });
  api.registerGatewayMethod(METHODS.unset, async ({ params, respond }) => {
    respond(...withInstallerNote(await changeSetting({ name: params?.name }, deps(), { dryRun: params?.dryRun === true }), params?.name));
  }, { scope: "operator.admin" });

  api.registerGatewayMethod(METHODS.proxy, async ({ respond }) => {
    try {
      respond(true, { generatedAt: Date.now(), fork: Boolean(forkPackage(env)), ...proxyOverview({ config: config(), env, configVars: configVars(), ...files }) }, undefined);
    } catch (error) {
      respond(false, undefined, { code: "UNAVAILABLE", message: String(error?.message || error) });
    }
  }, { scope: "operator.read" });

  api.registerGatewayMethod(METHODS.chatFiles, async ({ respond }) => {
    try {
      respond(true, { generatedAt: Date.now(), fork: Boolean(forkPackage(env)), ...chatFilesOverview({ config: config(), env, configVars: configVars(), ...files }) }, undefined);
    } catch (error) {
      respond(false, undefined, { code: "UNAVAILABLE", message: String(error?.message || error) });
    }
  }, { scope: "operator.read" });

  // Whether a folder exists is a fact about the Gateway's disk: admin only, like saving the list.
  api.registerGatewayMethod(METHODS.checkFolder, async ({ params, respond }) => {
    if (typeof params?.path !== "string" || !params.path.trim() || params.path.length > 4096) {
      respond(...invalid("path is required"));
      return;
    }
    respond(true, checkFolder(params.path, { env, ...files }), undefined);
  }, { scope: "operator.admin" });

  const makeTransport = opts.makeTransport ?? (async ({ proxyUrl, proxyCa }) =>
    createTransport({ undici: await loadUndici(), proxyUrl, proxyCa }));

  async function check(params) {
    const managed = managedProxy(config(), env);
    const routes = routesState(env[ROUTES], managed.url);
    const base = editableRules("routes", baseValue(ROUTES, { env, configVars: configVars() }));
    const list = checkList({ routeHosts: [...base.entries.map((e) => e.key), ...(routes.rules || []).flatMap((r) => r.keys.filter((k) => k !== "*"))],
      extra: params?.hosts ?? [] });
    if (list.error) return invalid(list.error);
    let proxyCa;
    if (managed.caFile) {
      try {
        proxyCa = files.read(managed.caFile);
      } catch {}
    }
    const proxyUrl = managed.info.enabled ? managed.url : null;
    const transport = await makeTransport({ proxyUrl, proxyCa });
    const route = (host) => (!managed.info.active ? "direct" : routes.state === "active" ? routeFor(routes.rules, host) : "proxy");
    try {
      const results = await checkHosts({ hosts: list.hosts, transport, route, ...(opts.now ? { now: opts.now } : {}) });
      return [true, { checkedAt: Date.now(), proxy: managed.info, routesState: routes.state, ...(list.truncated ? { truncated: true } : {}), results }, undefined];
    } finally {
      await transport.close?.();
    }
  }

  // One check at a time: a second one waits for the first (bounded outbound load).
  let chain = Promise.resolve();
  api.registerGatewayMethod(METHODS.proxyCheck, async ({ params, respond }) => {
    const run = chain.then(() => check(params));
    chain = run.catch(() => {});
    try {
      respond(...(await run));
    } catch (error) {
      respond(false, undefined, { code: "UNAVAILABLE", message: `check failed: ${String(error?.message || error).slice(0, 300)}` });
    }
  }, { scope: "operator.admin" });

  const controls = api.session?.controls?.registerControlUiDescriptor ? api.session.controls : api;
  controls.registerControlUiDescriptor?.({
    surface: "tab",
    id: TAB_ID,
    slug: TAB_ID,
    label: "Proxy",
    description: "Managed proxy, fork proxy routes and CLI backend proxy, with a reachability check",
    icon: "globe",
    group: "control",
    requiredScopes: ["operator.read"],
  });
  controls.registerControlUiDescriptor?.({
    surface: "tab",
    id: CHAT_FILES_TAB_ID,
    slug: CHAT_FILES_TAB_ID,
    label: "Chat files",
    description: "Extra folders whose files the chat previews and downloads (any type) in Full Access sessions",
    icon: "folder",
    group: "control",
    requiredScopes: ["operator.read"],
  });
}
