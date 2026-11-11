# Changelog

All notable changes to the ai-workbench plugins. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release of this repository is a git tag
`vX.Y.Z`; each plugin also keeps its own version in its manifest (`package.json`, or
`.claude-plugin/plugin.json` for the judge), raised when that plugin changes.

## [Unreleased]

### Added

- `aiwb-memory` 0.2.0: knowledge base folders (`knowledge` config, for every agent and per agent): each agent is told
  its folders, to look things up there and that it may save notes there as Markdown; the folders themselves are
  searched by OpenClaw's memory search. The shared memory folder (`dir`) is now optional.
- `aiwb-memory`: every file write inside a knowledge folder (OpenClaw `write`, `edit`, `apply_patch` and the Claude
  CLI's Write and Edit) waits for an approval card naming the file and the change; allow once, allow always (for
  that chat until the Gateway restarts) or deny. Agents are told to announce changes in the chat before making them.

## [0.1.0] - 2026-11-11

First public release. Plugin versions: `aiwb-claude-bridge` 0.1.0, `aiwb-fork-settings` 0.4.0,
`aiwb-office` 0.1.0, `aiwb-memory` 0.1.0, `judge` 0.1.0.

### Added

- `aiwb-claude-bridge`: Claude Desktop and Claude Code chats by project folder in the Control UI, adoption
  by project agents, continuation in the same Claude CLI chat, live run status, moving chats between projects.
- `aiwb-memory`: shared memory of all agents, as in Claude Desktop, with Claude Code memory imported live.
- `aiwb-fork-settings`: which OpenClaw fork settings are active, the Proxy page and the Chat files page.
- `aiwb-office`: Office documents previewed in chat as PDF through LibreOffice.
- `judge`: a skill for evaluating answers with another model.
- `scheduled-tasks` MCP server: Claude Desktop's scheduled-tasks contract on top of OpenClaw automations.
- Continuous integration (the plugin tests on every push) and the MIT license.

[Unreleased]: https://github.com/SingularBunny/aiwb-plugins/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SingularBunny/aiwb-plugins/releases/tag/v0.1.0
