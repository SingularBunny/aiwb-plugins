import { test } from "node:test";
import assert from "node:assert/strict";

import plugin, { forgetFindView } from "../chat-tools/dist/control-ui/chat-tools.js";

function makeHost(connection = { connected: true, canWrite: true, canAdmin: true }) {
  const actions = new Map();
  const requests = [];
  const host = {
    locale: "en",
    connection,
    ui: { registerAction: (action) => actions.set(action.id, action) },
    sessions: { create: async () => "agent:main:new", open: (target) => requests.push(["open", target]) },
    request: async (method, params) => {
      requests.push([method, params]);
      return {};
    },
  };
  plugin.activate(host);
  return { host, actions, requests };
}

test("chat tools: four items in the chat menu, gated by the scope the command needs", () => {
  const { actions } = makeHost({ connected: true, canWrite: true, canAdmin: false });
  assert.deepEqual([...actions.keys()], ["new-chat", "learn", "forget-topic", "reset"]);
  for (const action of actions.values()) assert.equal(action.placement, "session");
  assert.equal(actions.get("learn").resolve({}).disabled, undefined);
  assert.equal(actions.get("reset").resolve({}).disabled, true);
  const offline = makeHost({ connected: false, canWrite: true, canAdmin: true }).actions;
  assert.equal(offline.get("forget-topic").resolve({}).disabled, true);
});

test("chat tools: Learn sends /learn to the chat the menu belongs to; New chat opens the new session", async () => {
  const { actions, requests } = makeHost();
  await actions.get("learn").run({ sessionKey: "agent:main:chat", agentId: "main" });
  const [method, params] = requests[0];
  assert.equal(method, "chat.send");
  assert.equal(params.sessionKey, "agent:main:chat");
  assert.equal(params.agentId, "main");
  assert.equal(params.message, "/learn");
  assert.match(params.idempotencyKey, /^aiwb-chat-tools:/);
  await actions.get("new-chat").run({ sessionKey: "agent:main:chat", agentId: "main" });
  assert.deepEqual(requests[1], ["open", { sessionKey: "agent:main:new", agentId: "main" }]);
});

test("chat tools: Russian labels follow the Control UI locale", () => {
  const actions = new Map();
  plugin.activate({ locale: "ru-RU", connection: { connected: true }, ui: { registerAction: (a) => actions.set(a.id, a) } });
  assert.equal(actions.get("forget-topic").label, "Забыть тему…");
  assert.equal(actions.get("reset").label, "Сбросить чат…");
});

test("chat tools: the dialog card fills the host dialog and draws its own background", async () => {
  const { readFile } = await import("node:fs/promises");
  // The host dialog is a bare frame of --openclaw-modal-width; a card wider than it pushes the
  // buttons out of view, and without a background the text sits on the backdrop (both seen live).
  for (const [file, selector] of [
    ["chat-tools/dist/control-ui/chat-tools.css", ".aiwb-chat-tools {"],
    ["automation-chat/dist/control-ui/automation-chat.css", ".aiwb-automation-chat__dialog {"],
  ]) {
    const css = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const block = css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
    assert.match(block, /width: 100%;/, file);
    assert.doesNotMatch(block, /width: min\(/, file);
    assert.match(block, /background: var\(--card/, file);
  }
  const js = await readFile(new URL("../chat-tools/dist/control-ui/chat-tools.js", import.meta.url), "utf8");
  assert.match(js, /style: "--openclaw-modal-width: \d+px"/);
});

test("chat tools: a failed commit search is shown, not silently dropped", () => {
  // Live 23.11.2026: the commit search failed in the Gateway and the dialog simply had no git section.
  const failed = { candidates: [], memory: [], git: { repositories: [], commits: [], error: "embeddings failed" } };
  assert.equal(forgetFindView(failed, true).gitError, "embeddings failed");
  // Without admin scope the git section is not offered at all, so its error is not shown either.
  assert.equal(forgetFindView(failed, false), null);
  const found = forgetFindView({
    candidates: [{ id: "t1" }],
    git: { commits: [{ repo: "/r", hash: "abc", subject: "Taxes" }], reviews: [] },
  }, true);
  assert.deepEqual(found.commits.map((c) => [c.id, c.preview]), [["git:/r:abc", "Taxes"]]);
  assert.equal(found.gitError, "");
  assert.equal(forgetFindView({ candidates: [], memory: [] }, true), null);
  // Local models that can rewrite commit and PR texts: offered to an admin connection only.
  const withModels = { candidates: [{ id: "t1" }], rewriteModels: ["llama-cpp/gemma-4-e4b-it-q4_k_m"] };
  assert.deepEqual(forgetFindView(withModels, true).rewriteModels, ["llama-cpp/gemma-4-e4b-it-q4_k_m"]);
  assert.deepEqual(forgetFindView(withModels, false).rewriteModels, []);
});
