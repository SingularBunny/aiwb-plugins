// Plan mode for any model, as Claude Code's plan mode: `/plan` in a chat makes the agent research and present a plan
// before changing anything. While it plans, file edits are refused, exec commands and subagent starts wait for the
// user's approval, and the exit_plan_mode tool shows the plan for approval; approving it ends plan mode.
// Claude CLI sessions have Claude Code's own plan mode (composer picker); this one covers OpenClaw's tools only.
// Requires plugins.entries.aiwb-plan.hooks.allowConversationAccess = true (the plan-mode note in the prompt).
import os from "node:os";
import path from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { ASK_TOOLS, EDIT_TOOLS, EXIT_TOOL, PLAN_CONTEXT, PlanSessions, planCommand, planToolDecision } from "./plan-mode.js";

export default definePluginEntry({
  id: "aiwb-plan",
  name: "Plan mode",
  description: "Plan mode for any model: research and an approved plan before any change",
  register(api) {
    const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
    const sessions = new PlanSessions(path.join(stateDir, "workbench", "plan-mode.json"));

    api.registerCommand({
      name: "plan",
      description: "Plan mode for this chat: research and an approved plan before any change (on, off, status)",
      acceptsArgs: true,
      handler: (ctx) => ({ text: planCommand(sessions, ctx.sessionKey, ctx.args) }),
    });

    api.on("before_prompt_build", (_event, ctx) => (sessions.has(ctx?.sessionKey) ? { prependContext: PLAN_CONTEXT } : undefined));

    api.on("before_tool_call", (event, ctx) => planToolDecision(sessions, {
      toolName: event.toolName, params: event.params, sessionKey: ctx?.sessionKey,
    }), { matcher: [...EDIT_TOOLS, ...ASK_TOOLS, EXIT_TOOL] });

    // Offered only while the chat plans; the approval itself is the before_tool_call card above.
    api.registerTool((ctx) => (sessions.has(ctx?.sessionKey) ? {
      name: EXIT_TOOL,
      label: "Present plan",
      description: "Present the finished plan for the user's approval. Approval ends plan mode, and then you carry it out.",
      parameters: { type: "object", properties: { plan: { type: "string", description: "The whole plan in Markdown" } }, required: ["plan"], additionalProperties: false },
      async execute() {
        return { content: [{ type: "text", text: "The user approved the plan. Plan mode is off: carry out the plan now." }], details: {} };
      },
    } : null));
  },
});
