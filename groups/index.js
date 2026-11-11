// Groups: several agents in one conversation, as in LobeHub's group chat. A manager agent picks who speaks next; an
// @mention of an agent wins; at most a set number of agent turns follow one user message. Each agent answers with a
// full turn of its own (instructions, memory, tools, model) in its own session for the group. Works with any model.
// Gateway methods and the tab: register.js; the turn logic: orchestrate.js; the page: dist/control-ui/groups.js.
import os from "node:os";
import path from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";

import { PLUGIN_ID, registerGroups } from "./register.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Groups",
  description: "Several agents in one conversation; a manager picks who speaks next",
  register(api) {
    registerGroups(api, { stateDir: process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"),
      // A round outlives the send request: keep it admitted (see register.js).
      detach: runDetachedWebhookWork });
  },
});
