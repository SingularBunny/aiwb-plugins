# aiwb-plugins

[![check](https://github.com/SingularBunny/aiwb-plugins/actions/workflows/check.yml/badge.svg)](https://github.com/SingularBunny/aiwb-plugins/actions/workflows/check.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Plugins and an MCP server of [ai-workbench](https://github.com/SingularBunny/ai-workbench) for
[OpenClaw](https://github.com/openclaw/openclaw). The ai-workbench installer sets them up: it clones this
repository next to its own plugins (`--plugins-root` or `WORKBENCH_PLUGINS_ROOT`, `~/.local/share/ai-workbench/plugins` by default) and links
each plugin with `openclaw plugins install --link`.

| Folder | Plugin | What it does |
|---|---|---|
| `judge/` | `judge` | A model from another family evaluates the answer; panel of judges, verdict log and stats (`judge` skill) |
| `claude-bridge/` | `aiwb-claude-bridge` | Claude Desktop & Code bridge: the "Projects" chat tree by project folder, old chats continued in agents, live run status, drag-and-drop order, live import of Claude Code memory, continue a chat in a terminal, move a chat to its project ([README](claude-bridge/README.md)) |
| `shared-memory/` | `aiwb-memory` | shared memory for all agents, as in Claude Desktop, and each agent's knowledge base folders |
| `fork-settings/` | `aiwb-fork-settings` | fork settings: which OpenClaw fork settings are in effect in the Gateway, and setting them; a Proxy page in the Control UI (routes editor, reachability check) and a Chat files page (folders whose files the chat serves, for all agents and per agent) ([README](fork-settings/README.md)) |
| `office/` | `aiwb-office` | Office documents in chat: local LibreOffice → PDF preview, and their text for the model (document extractor); text copies of knowledge base PDF and Office files for memory search; skill `searchable-pdf`: a scan's copy with a text layer |
| `compare/` | `aiwb-compare` | Multi-model: several models answer, a judge picks the most consistent answer or one merges them, with an agreement matrix; a Control UI page for the roles |
| `groups/` | `aiwb-groups` | Groups: several agents in one conversation, a manager picks who speaks next; group chats in ordinary chats (agents, ACP agents and models as participants, asked by @name) |
| `plan/` | `aiwb-plan` | Plan mode for any model: `/plan` or the Plan toggle in the Control UI composer, then research and an approved plan before any change |
| `automation-chat/` | `aiwb-automation-chat` | In an automation's chat: Run now in the header and a Runs side panel with the latest runs (needs the fork's run viewer for plugins) |
| `chat-tools/` | `aiwb-chat-tools` | Items in a chat's ⋯ menu: Forget a topic (with the fork's `chat.forget` methods; for admins also commit messages of the chat's repositories and its GitHub pull request texts, force-push only on confirmation), New chat, Learn a skill, Reset chat |
| `gpu/` | `aiwb-gpu` | GPU load and memory: a line in the chat header and a side panel with the models and processes that hold GPU memory (NVIDIA, `nvidia-smi`) |
| `mcp/scheduled-tasks/` | MCP `scheduled-tasks` | scheduled tasks with Claude Desktop tools on top of `openclaw automations` |

System programs from the package manager, all optional (a missing one turns its feature off): `python3` for the
judge; LibreOffice (`soffice`) for `aiwb-office`; `pdftotext` (poppler), OCRmyPDF and Tesseract for knowledge base
text copies and searchable PDF copies. The ai-workbench install plan lists the missing ones with an install command (ai-workbench
`docs/install/system-programs.md`).

Documentation lives in ai-workbench, `docs/features/` (judge, chats and projects, shared memory and knowledge,
document preview, multi-model, groups, plan mode, GPU use, chat files, scheduled tasks; OpenClaw from the fork:
`aiwb-fork-settings`).

Until November 2026 the folders and ids were `ai-workbench/` (`ai-workbench`), `projects/` (`aiwb-projects`),
`memory/` and `settings/` (`aiwb-settings`). The ai-workbench installer moves an existing install to the new
names: config and hooks of the old `plugins.entries` entries, load paths and `plugins.allow`.

## Checks

```bash
node --test 'test/*.test.mjs' 'mcp/scheduled-tasks/test/*.test.mjs'
uv run --no-project --with pytest python -m pytest tests     # judge
```

## Before a new plugin

Search ClawHub (`openclaw plugins search`, `openclaw skills search`) and OpenClaw's bundled
`extensions/` first. A full clone or a better plugin there replaces ours (the ai-workbench installer
installs it); with a partial overlap the better one becomes the base and gets what the other does
better; only with nothing close is a new plugin built. See ai-workbench `CONTRIBUTING.md`.
