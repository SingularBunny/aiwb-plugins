// Automation chat: Run now and the Runs panel of an automation's chat. All of it is Control UI
// (dist/control-ui/automation-chat.js) over Gateway methods that already exist (cron.list, cron.runs, cron.run,
// cron.history), so the backend part registers nothing.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "aiwb-automation-chat",
  name: "Automation chat",
  description: "Run now and the Runs panel in an automation's chat",
  register() {},
});
