// Chat tools: menu items of a chat that need no Gateway code of their own. The page logic is in
// dist/control-ui/chat-tools.js; it calls Gateway methods that already exist (chat.forget.* of the OpenClaw fork,
// chat.send, sessions.create), so the backend part registers nothing.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "aiwb-chat-tools",
  name: "Chat tools",
  description: "Forget a topic, new chat, learn a skill, reset the chat",
  register() {},
});
