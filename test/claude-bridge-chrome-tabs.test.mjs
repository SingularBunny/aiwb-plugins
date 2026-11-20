import { test } from "node:test";
import assert from "node:assert/strict";

import { CHROME_TABS_CONTEXT, chromeTabsContext } from "../claude-bridge/chrome-tabs.js";

test("claude-bridge: automation runs with Chrome tools are asked to close their tabs; chats are not", () => {
  const on = { OPENCLAW_CLAUDE_CHROME: "1" };
  assert.equal(chromeTabsContext("agent:ops:cron:job-1", on), CHROME_TABS_CONTEXT);
  assert.ok(CHROME_TABS_CONTEXT.includes("tabs_close_mcp"));
  assert.equal(chromeTabsContext("agent:ops:main", on), undefined);
  assert.equal(chromeTabsContext("agent:ops:cron:job-1", {}), undefined);
  assert.equal(chromeTabsContext(undefined, on), undefined);
});
