import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CHAT_FILES, chatFilesOverview, checkFolder, configuredAgents, folderProblems } from "../fork-settings/chat-files.js";
import { CHAT_FILES_TAB_ID, METHODS, TAB_ID, registerForkSettings } from "../fork-settings/register.js";
import { effectiveSettings, parseFolderRules, validateSettingValue } from "../fork-settings/settings.js";
import { draftFromOverview, normalizeFolder, previewFolders } from "../fork-settings/dist/control-ui/chat-files.js";

/** A temporary home with Desktop, Downloads, a file and a folder outside it. */
function sandbox(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "chat-files-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home", "u");
  mkdirSync(path.join(home, "Desktop"), { recursive: true });
  mkdirSync(path.join(home, "Downloads"));
  writeFileSync(path.join(home, "notes.txt"), "x");
  const shared = path.join(root, "srv", "shared");
  mkdirSync(shared, { recursive: true });
  const env = { HOME: home, OPENCLAW_STATE_DIR: path.join(root, "state") };
  mkdirSync(env.OPENCLAW_STATE_DIR);
  return { root, home, shared, env, deps: { env, home } };
}

function fakeApi({ config = {}, env = {} } = {}) {
  const methods = {};
  const descriptors = [];
  const state = { config: structuredClone(config) };
  const api = {
    runtime: { config: {
      current: () => state.config,
      mutateConfigFile: async ({ mutate }) => {
        const draft = structuredClone(state.config);
        mutate(draft);
        state.config = draft;
      },
    } },
    registerGatewayMethod: (name, handler, opts) => { methods[name] = { handler, scope: opts?.scope }; },
    session: { controls: { registerControlUiDescriptor: (d) => { descriptors.push(d); } } },
  };
  registerForkSettings(api, { env, home: env.HOME });
  const call = (name, params = {}) => new Promise((resolve) => {
    methods[name].handler({ params, respond: (ok, payload, error) => resolve({ ok, payload, error }) });
  });
  return { methods, descriptors, call, state };
}

test("chat files setting: rules for all agents and per agent, validated by text", () => {
  assert.deepEqual(parseFolderRules("~/Desktop; Work=~/Downloads:/srv/x ;*=/srv/y;bad id=/a;notes=rel"), {
    scopes: { "*": ["~/Desktop", "/srv/y"], work: ["~/Downloads", "/srv/x"], notes: [] },
    problems: [{ scope: "bad id", problem: "not * or an agent id" }, { scope: "notes", entry: "rel", problem: "not an absolute or ~ path" }],
  });
  // set: a rules string or an object; normalized, `*` first, trailing slashes dropped, empty lists dropped.
  assert.deepEqual(validateSettingValue(CHAT_FILES, "work=/srv/x/;~/Desktop:~/Desktop"), { ok: true, raw: "*=~/Desktop;work=/srv/x" });
  assert.deepEqual(validateSettingValue(CHAT_FILES, { work: ["/srv/x"], "*": ["~/Downloads", "/srv/y/"], other: [] }),
    { ok: true, raw: "*=~/Downloads:/srv/y;work=/srv/x" });
  for (const bad of ["/", "~", "~/", "Desktop", "a b=/srv", { "*": ["/srv:x"] }, { "*": "/srv" }, { "bad id": ["/srv"] }, "", 5, ["/srv"]]) {
    assert.equal(validateSettingValue(CHAT_FILES, bad).ok, false, JSON.stringify(bad));
  }
  const row = effectiveSettings({ env: { [CHAT_FILES]: "/srv/a;work=rel" } }).find((r) => r.name === CHAT_FILES);
  assert.deepEqual([row.kind, row.value, row.invalid], ["folders", "*=/srv/a", true]);
});

test("chat files folders: checked on disk like the fork (exists, folder, not / or the home folder)", (t) => {
  const { root, home, shared, deps } = sandbox(t);
  assert.deepEqual(checkFolder("~/Downloads/", deps), { entry: "~/Downloads/", status: "ok", ok: true, text: "folder exists",
    path: path.join(home, "Downloads"), realPath: path.join(home, "Downloads") });
  assert.equal(checkFolder(shared, deps).status, "ok");
  assert.equal(checkFolder("~/missing", deps).status, "missing");
  assert.equal(checkFolder("~/notes.txt", deps).status, "not-dir");
  assert.equal(checkFolder("Desktop", deps).status, "relative");
  assert.equal(checkFolder("/", deps).status, "root");
  assert.equal(checkFolder("/a:/b", deps).status, "separator");
  // The home folder itself, any folder containing it and a symlink to it are refused.
  const alias = path.join(root, "alias");
  symlinkSync(home, alias);
  for (const entry of ["~", home, path.dirname(home), alias]) assert.equal(checkFolder(entry, deps).status, "home", entry);
  // A symlinked folder is fine and reports its real path.
  const link = path.join(root, "dl");
  symlinkSync(path.join(home, "Downloads"), link);
  assert.equal(checkFolder(link, deps).realPath, path.join(home, "Downloads"));
  assert.deepEqual(folderProblems({ "*": ["~/Desktop", "~/missing"], work: ["/"] }, deps).map((p) => [p.scope, p.entry, p.status]),
    [["*", "~/missing", "missing"], ["work", "/", "root"]]);
});

test("chat files overview: lists per scope, agents, what is in effect, suggestions and the installer key", (t) => {
  const { home, shared, env } = sandbox(t);
  const value = `*=~/Desktop;work=${shared}:~/missing`;
  const config = { agents: { entries: { main: {}, work: { name: "Work" } } } };
  const o = chatFilesOverview({ config, env: { ...env, [CHAT_FILES]: value }, configVars: { [CHAT_FILES]: value }, home });
  assert.equal(o.source, "env.vars");
  assert.deepEqual(Object.keys(o.scopes), ["*", "work"]);
  assert.deepEqual(o.scopes.work.map((e) => [e.entry, e.status]), [[shared, "ok"], ["~/missing", "missing"]]);
  assert.deepEqual(o.effective, { "*": [path.join(home, "Desktop")], work: [shared] });
  assert.deepEqual(o.agents, [{ id: "main" }, { id: "work", name: "Work" }]);
  assert.deepEqual(o.suggestions, ["~/Downloads"]);
  assert.equal(o.installer.rewrites, false);
  writeFileSync(path.join(env.OPENCLAW_STATE_DIR, ".env"), "WORKBENCH_CHAT_FILE_FOLDERS=~/Desktop\n");
  assert.equal(chatFilesOverview({ env, home }).installer.rewrites, true);
  // With no agents in the config the default agent is offered; agents.list works too.
  assert.deepEqual(configuredAgents({}), [{ id: "main" }]);
  assert.deepEqual(configuredAgents({ agents: { list: [{ id: "A1", name: "One" }, { id: "b" }] } }), [{ id: "a1", name: "One" }, { id: "b" }]);
});

test("chat files methods: overview, folder check (admin), set refuses / and home, reports missing, installer note", async (t) => {
  const { home, shared, env } = sandbox(t);
  const { methods, descriptors, call, state } = fakeApi({ env });
  assert.equal(methods[METHODS.chatFiles].scope, "operator.read");
  assert.equal(methods[METHODS.checkFolder].scope, "operator.admin");
  assert.deepEqual(descriptors.map((d) => [d.id, d.slug, d.label]), [[TAB_ID, TAB_ID, "Proxy"], [CHAT_FILES_TAB_ID, CHAT_FILES_TAB_ID, "Chat files"]]);

  assert.equal((await call(METHODS.checkFolder, { path: "~/Desktop" })).payload.status, "ok");
  assert.equal((await call(METHODS.checkFolder, { path: "~" })).payload.status, "home");
  assert.equal((await call(METHODS.checkFolder, {})).ok, false);

  for (const value of [{ "*": [home] }, { work: [path.dirname(home)] }, "*=/"]) {
    const refused = await call(METHODS.set, { name: CHAT_FILES, value });
    assert.equal(refused.ok, false, JSON.stringify(value));
  }
  assert.equal(state.config.env, undefined);

  const dry = await call(METHODS.set, { name: CHAT_FILES, value: { "*": ["~/Desktop"], work: [shared, "~/missing"] }, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.payload.stored, `*=~/Desktop;work=${shared}:~/missing`);
  assert.deepEqual(dry.payload.problems.map((p) => p.entry), ["~/missing"]);
  assert.equal(state.config.env, undefined);

  writeFileSync(path.join(env.OPENCLAW_STATE_DIR, ".env"), "WORKBENCH_CHAT_FILE_FOLDERS=\"~/Desktop\"\n");
  const saved = await call(METHODS.set, { name: CHAT_FILES, value: { "*": ["~/Desktop"] } });
  assert.equal(state.config.env.vars[CHAT_FILES], "*=~/Desktop");
  assert.match(saved.payload.installerNote, /WORKBENCH_CHAT_FILE_FOLDERS/);
  const overview = await call(METHODS.chatFiles);
  assert.deepEqual(Object.keys(overview.payload.scopes), ["*"]);
  assert.equal((await call(METHODS.unset, { name: CHAT_FILES })).payload.unset, true);
  assert.equal(state.config.env.vars[CHAT_FILES], undefined);
});

test("chat files page helpers: folder text, the value to save and the draft", () => {
  assert.equal(normalizeFolder(" ~/Downloads/ "), "~/Downloads");
  assert.equal(normalizeFolder("/srv/shared"), "/srv/shared");
  for (const bad of ["", "/", "~", "~/", "Downloads", "/a:b", "/a;b"]) assert.equal(normalizeFolder(bad), null, bad);
  assert.equal(previewFolders({ work: ["/srv/x"], "*": ["~/Desktop", "/srv/y"], empty: [] }), "*=~/Desktop:/srv/y;work=/srv/x");
  assert.equal(previewFolders({ "*": [] }), "");
  assert.deepEqual(draftFromOverview({ scopes: { "*": [{ entry: "~/Desktop" }], work: [{ entry: "/srv/x" }] } }),
    { "*": ["~/Desktop"], work: ["/srv/x"] });
  assert.deepEqual(draftFromOverview(null), { "*": [] });
});
