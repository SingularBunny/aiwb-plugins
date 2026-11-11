# aiwb-plugins

[![check](https://github.com/SingularBunny/aiwb-plugins/actions/workflows/check.yml/badge.svg)](https://github.com/SingularBunny/aiwb-plugins/actions/workflows/check.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Plugins and an MCP server of [ai-workbench](https://github.com/SingularBunny/ai-workbench) for
[OpenClaw](https://github.com/openclaw/openclaw). The ai-workbench installer sets them up: it clones this
repository next to its own plugins (`--plugins-root` or `WORKBENCH_PLUGINS_ROOT`, `~/.local/share/ai-workbench/plugins` by default) and links
each plugin with `openclaw plugins install --link`.

| Folder | Plugin | What it does |
|---|---|---|
| `judge/` | `judge` | judge: a model from another family evaluates the answer (`judge` skill) |
| `claude-bridge/` | `aiwb-claude-bridge` | Claude Desktop & Code bridge: the "Projects" chat tree by project folder, old chats continued in agents, live run status, drag-and-drop order, live import of Claude Code memory ([README](claude-bridge/README.md)) |
| `shared-memory/` | `aiwb-memory` | shared memory for all agents, as in Claude Desktop, and each agent's knowledge base folders |
| `fork-settings/` | `aiwb-fork-settings` | fork settings: which OpenClaw fork settings are in effect in the Gateway, and setting them; a Proxy page in the Control UI (routes editor, reachability check) and a Chat files page (folders whose files the chat serves, for all agents and per agent) ([README](fork-settings/README.md)) |
| `office/` | `aiwb-office` | Office documents in chat: local LibreOffice → PDF preview, and their text for the model (document extractor); text copies of knowledge base PDF and Office files for memory search |
| `mcp/scheduled-tasks/` | MCP `scheduled-tasks` | scheduled tasks with Claude Desktop tools on top of `openclaw automations` |

Documentation lives in ai-workbench, `docs/` (features: judge, projects, shared memory, document preview,
scheduled tasks; OpenClaw from the fork: `aiwb-fork-settings`).

Until November 2026 the folders and ids were `ai-workbench/` (`ai-workbench`), `projects/` (`aiwb-projects`),
`memory/` and `settings/` (`aiwb-settings`). The ai-workbench installer moves an existing install to the new
names: config and hooks of the old `plugins.entries` entries, load paths and `plugins.allow`.

## Checks

```bash
node --test 'test/*.test.mjs' 'mcp/scheduled-tasks/test/*.test.mjs'
uv run --no-project --with pytest python -m pytest tests     # judge
```
