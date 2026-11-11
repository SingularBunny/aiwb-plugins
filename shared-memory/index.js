// Shared memory for all agents, as in Claude Desktop. In OpenClaw each agent has its own memory: only it
// reads its MEMORY.md and USER.md, and "remember" in a project chat writes only there. On every turn of
// any agent the plugin puts the shared USER.md (about the user) and the shared memory index MEMORY.md
// into the context, along with where to add to this memory. The facts themselves (memory/*.md) are found
// by memory search: the folder is listed in memory.search.extraPaths.
//
// It also names each agent's knowledge base folders (notes it searches and may write to), for all agents and per agent.
//
// Config: plugins.entries.aiwb-memory.config = { dir: "<shared memory folder>", knowledge: { "*": [folders],
// "<agent id>": [folders] } }, either key optional; requires
// plugins.entries.aiwb-memory.hooks.allowPromptInjection = true.
// The folder is not an agent workspace: OpenClaw stops putting an agent's root MEMORY.md and USER.md
// into the context if anyone other than the agent edited them (OpenClaw docs concepts/memory-provenance.md).
import path from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { knowledgeContext, sharedMemoryContext } from "./context.js";
import { knowledgeApproval } from "./knowledge-guard.js";

export default definePluginEntry({
  id: "aiwb-memory",
  name: "Shared memory",
  description: "Shared memory for all agents, as in Claude Desktop",
  register(api) {
    const dir = api.pluginConfig?.dir;
    const knowledge = api.pluginConfig?.knowledge;
    const shared = Boolean(dir && path.isAbsolute(dir));
    if (dir && !shared) api.logger?.warn?.("aiwb-memory: dir is not an absolute path; shared memory is not enabled");
    if (!shared && !knowledge) {
      api.logger?.warn?.("aiwb-memory: neither dir nor knowledge is set; nothing to add");
      return;
    }
    // Files are read on every turn: shared memory edits take effect immediately, without reloading the plugin.
    api.on("before_prompt_build", (_event, ctx) => {
      const text = [shared ? sharedMemoryContext(dir) : null, knowledgeContext(knowledge, ctx?.agentId)].filter(Boolean).join("\n\n");
      return text ? { appendSystemContext: text } : undefined;
    });
    if (!knowledge) return;
    // Every file write inside the agent's knowledge folders waits for the user's approval in the chat; "allow always"
    // stops asking for that chat until the Gateway restarts.
    const allowedSessions = new Set();
    api.on("before_tool_call", (event, ctx) => knowledgeApproval({
      toolName: event.toolName, params: event.params, derivedPaths: event.derivedPaths, agentId: ctx?.agentId,
      base: ctx?.cwd ?? ctx?.workspaceDir, knowledge, allowedSessions, sessionKey: ctx?.sessionKey,
    }), { matcher: ["write", "edit", "apply_patch"] });
  },
});
