// Plan mode for any model: the pure decisions, kept apart from the plugin wiring in index.js.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const EXIT_TOOL = "exit_plan_mode";
/** Tools that change files: refused while the chat plans. */
export const EDIT_TOOLS = ["write", "edit", "apply_patch"];
/** Tools that may change anything or reach outside: each call waits for the user's approval while the chat plans. */
export const ASK_TOOLS = ["exec", "process", "sessions_spawn", "sessions_send", "browser", "message", "cron", "gateway", "nodes"];

const ASK_TITLES = { exec: "Plan mode: run this command?", sessions_spawn: "Plan mode: start this subagent?" };

export const EDIT_REFUSAL =
  "Plan mode is on: files cannot be changed yet. Keep researching, then present the plan with the exit_plan_mode tool.";

export const PLAN_CONTEXT = [
  "Plan mode is on in this chat. Research and think, but do not change anything yet:",
  "- write, edit and apply_patch are refused;",
  "- every command, subagent, browser action, message and scheduled task waits for the user's approval, so use them only to read;",
  "- when the plan is ready, call exit_plan_mode with the whole plan in Markdown. The user approves it",
  "  (plan mode ends and you carry it out) or declines it (revise the plan and present it again).",
  "A plan names: the goal and how you will know it is done; the riskiest assumption and how you checked it; the steps,",
  "each with its own check; the steps that cannot be undone (deleting, sending, publishing, paying), marked as such;",
  "and the effort as a range, not a single number.",
].join("\n");

/** Sessions in plan mode, kept in one JSON file so a Gateway restart keeps them. */
export class PlanSessions {
  constructor(file) {
    this.file = file;
    this.sessions = new Map();
    try {
      for (const [key, value] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) this.sessions.set(key, value);
    } catch {
      // No file yet, or unreadable: no chat is planning.
    }
  }

  has(sessionKey) {
    return Boolean(sessionKey) && this.sessions.has(sessionKey);
  }

  set(sessionKey, on, now = Date.now()) {
    if (!sessionKey || on === this.has(sessionKey)) return;
    if (on) this.sessions.set(sessionKey, { since: now });
    else this.sessions.delete(sessionKey);
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.sessions), null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** `/plan [on|off|status]`: the reply text; toggles the chat's plan mode. */
export function planCommand(sessions, sessionKey, args) {
  if (!sessionKey) return "Plan mode works in a chat session only.";
  const action = (args ?? "").trim().toLowerCase() || "on";
  if (action === "status") return sessions.has(sessionKey) ? "Plan mode is on." : "Plan mode is off.";
  if (action === "off") {
    sessions.set(sessionKey, false);
    return "Plan mode is off: the agent may change files again.";
  }
  if (action !== "on") return "Usage: /plan [on|off|status]";
  sessions.set(sessionKey, true);
  return "Plan mode is on: the agent researches and presents a plan; files stay unchanged until you approve it.";
}

/** The before_tool_call decision for a chat in plan mode; undefined lets the call through. */
export function planToolDecision(sessions, { toolName, params, sessionKey }) {
  if (!sessions.has(sessionKey)) return undefined;
  if (EDIT_TOOLS.includes(toolName)) return { block: true, blockReason: EDIT_REFUSAL };
  if (toolName === EXIT_TOOL) {
    const plan = typeof params?.plan === "string" ? params.plan.trim() : "";
    if (!plan) return { block: true, blockReason: "exit_plan_mode needs the plan in the plan parameter." };
    return {
      requireApproval: {
        title: "Approve the plan?",
        description: plan,
        severity: "info",
        allowedDecisions: ["allow-once", "deny"],
        onResolution: (decision) => {
          if (decision === "allow-once") sessions.set(sessionKey, false);
        },
      },
    };
  }
  if (ASK_TOOLS.includes(toolName)) {
    const what = toolName === "exec" ? String(params?.command ?? "")
      : toolName === "sessions_spawn" ? String(params?.task ?? params?.label ?? "")
      : JSON.stringify(params ?? {}).slice(0, 500);
    return {
      requireApproval: {
        title: ASK_TITLES[toolName] ?? `Plan mode: allow ${toolName}?`,
        description: what || toolName,
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
      },
    };
  }
  return undefined;
}
