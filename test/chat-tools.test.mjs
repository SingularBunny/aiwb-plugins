import { test } from "node:test";
import assert from "node:assert/strict";

import plugin from "../chat-tools/dist/control-ui/chat-tools.js";

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
