// Multi-model: ask several models the same question, see the answers side by side, pick the most consistent one
// (Universal Self-Consistency, chosen twice in two orders) or merge them, with a page for the roles: which models
// answer (by default the top free models of different families by their Arena rating), the judge, the merger.
// Works with any model OpenClaw can call. Gateway methods and the tab: register.js; ranking: arena.js and
// candidates.js; the choice: consensus.js; the page: dist/control-ui/compare.js (hand-written, no build step).
import os from "node:os";
import path from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { PLUGIN_ID, registerCompare } from "./register.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Multi-model",
  description: "Ask several models at once, pick the most consistent answer or merge them",
  register(api) {
    registerCompare(api, { stateDir: process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw") });
  },
});
