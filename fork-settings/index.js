// OpenClaw fork settings: which are in effect in the Gateway, and setting them; plus the Proxy page.
// The fork reads worker limits, catalog "continue" limits, switches, utility-model cadence and proxy
// routes from environment variables at use time; they are set by the env.vars setting, which OpenClaw
// puts into the process environment. This is not visible from outside: /proc/<pid>/environ lacks them
// (it holds the environment at startup), and config get masks env.vars values. The plugin lives in the
// Gateway process and reads the same environment as the fork code.
//
// set/unset write env.vars.<NAME> in the config file through api.runtime.config.mutateConfigFile
// (the same write the Gateway's own config methods use; no Gateway method grant is needed), so
// they are operator.admin like config.patch. The Gateway hot-reloads env.vars; the fork reads the
// value on its next use. A value from the process environment or ~/.openclaw/.env still wins.
//
// Gateway methods and the tab descriptors: register.js; proxy data and the check: proxy.js; chat
// file folders: chat-files.js; the pages: dist/control-ui/proxy.js (entry) and chat-files.js
// (hand-written, no build step).
//
// In OpenClaw not built from the fork the variables change nothing; the fork field shows this
// (installer mark <state>/workbench/openclaw-package.sha256).
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { PLUGIN_ID, registerForkSettings } from "./register.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Fork settings",
  description: "Which OpenClaw fork limits and switches are in effect in the Gateway, setting them, and the Proxy and Chat files pages",
  register(api) {
    registerForkSettings(api);
  },
});
