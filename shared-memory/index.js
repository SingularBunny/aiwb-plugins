// Shared memory for all agents, as in Claude Desktop. In OpenClaw each agent has its own memory: only it
// reads its MEMORY.md and USER.md, and "remember" in a project chat writes only there. On every turn of
// any agent the plugin puts the shared USER.md (about the user) and the shared memory index MEMORY.md
// into the context, along with where to add to this memory. The facts themselves (memory/*.md) are found
// by memory search: the folder is listed in memory.search.extraPaths.
//
// Config: plugins.entries.aiwb-memory.config = { dir: "<shared memory folder>" }; requires
// plugins.entries.aiwb-memory.hooks.allowPromptInjection = true.
// The folder is not an agent workspace: OpenClaw stops putting an agent's root MEMORY.md and USER.md
// into the context if anyone other than the agent edited them (OpenClaw docs concepts/memory-provenance.md).
import path from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { sharedMemoryContext } from "./context.js";

export default definePluginEntry({
  id: "aiwb-memory",
  name: "Shared memory",
  description: "Shared memory for all agents, as in Claude Desktop",
  register(api) {
    const dir = api.pluginConfig?.dir;
    if (!dir || !path.isAbsolute(dir)) {
      api.logger?.warn?.("aiwb-memory: dir (absolute path) is not set; shared memory is not enabled");
      return;
    }
    // Files are read on every turn: shared memory edits take effect immediately, without reloading the plugin.
    api.on("before_prompt_build", () => ({ appendSystemContext: sharedMemoryContext(dir) }));
  },
});
