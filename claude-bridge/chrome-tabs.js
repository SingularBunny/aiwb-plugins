// Claude in Chrome tab groups of scheduled runs. A Claude Code process with Chrome tools opens its own tab group in
// the owner's browser; a chat keeps one process (and one group) for hours, but every run of an automation is a new
// process, so a job that uses the browser left a new group behind on each run. The run is asked to close the tabs it
// opened before it finishes: the extension removes a group with its last tab. Only for automation runs and only when
// the fork gives Claude CLI turns the Chrome tools (OPENCLAW_CLAUDE_CHROME).

export const CHROME_TABS_CONTEXT = [
  "# Browser tabs in a scheduled run",
  "This is an automation run. If you used the Claude in Chrome browser tools, close every tab you opened",
  "(mcp__claude-in-chrome__tabs_close_mcp) before your final answer, so the run leaves no tab group in the owner's",
  "browser. Do not close tabs you did not open.",
].join("\n");

const chromeEnabled = (env) => /^(1|true|yes)$/i.test(String(env.OPENCLAW_CLAUDE_CHROME ?? "").trim());

/** The context for a prompt of this session, or undefined. */
export function chromeTabsContext(sessionKey, env = process.env) {
  return chromeEnabled(env) && /:cron:/.test(sessionKey || "") ? CHROME_TABS_CONTEXT : undefined;
}
