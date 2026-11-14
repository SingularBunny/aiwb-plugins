# Changelog

All notable changes to the ai-workbench plugins. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release of this repository is a git tag
`vX.Y.Z`; each plugin also keeps its own version in its manifest (`package.json`, or
`.claude-plugin/plugin.json` for the judge), raised when that plugin changes.

## [Unreleased]

### Added

- `aiwb-gpu` 0.1.0: GPU use in the Control UI — `GPU 35% · 5.1/8.0 GB` in the chat header and a GPU side panel with
  load, memory and who holds it (Ollama with its models from `/api/ps`, the Gateway's llama.cpp embeddings, llama.cpp,
  LM Studio, other processes); NVIDIA GPUs through `nvidia-smi`.
- `aiwb-plan` 0.1.0: plan mode for any model, as in Claude Code — `/plan` in a chat; while it plans, file edits
  are refused, exec commands and subagent starts wait for approval, and the `exit_plan_mode` tool shows the plan for
  approval; approving it ends plan mode.
- `aiwb-groups` 0.1.0: Groups — several agents in one conversation, a manager agent picks who speaks next, @mentions
  first, a turn limit per message; each agent answers with a full turn in its own session for the group.
- `aiwb-compare` 0.1.0: Multi-model — ask several models at once, pick the most consistent answer (Universal
  Self-Consistency, judged twice in two orders) or merge them; a Control UI page for the roles, ranked by Arena.
- `aiwb-memory` 0.2.0: knowledge base folders (`knowledge` config, for every agent and per agent): each agent is told
  its folders, to look things up there and that it may save notes there as Markdown; the folders themselves are
  searched by OpenClaw's memory search. The shared memory folder (`dir`) is now optional.
- `aiwb-memory`: every file write inside a knowledge folder (OpenClaw `write`, `edit`, `apply_patch` and the Claude
  CLI's Write and Edit) waits for an approval card naming the file and the change; allow once, allow always (for
  that chat until the Gateway restarts) or deny. Agents are told to announce changes in the chat before making them.
- `aiwb-office` 0.2.0: `bin/knowledge-text.mjs` keeps Markdown text copies of the PDF (pdftotext) and Office
  (LibreOffice) files in knowledge folders, re-reading only changed files and removing copies of deleted ones;
  `aiwb-memory` tells agents where the copies are and to read the originals.
- `aiwb-office` 0.3.0: knowledge text copies recognize scans — PDF pages without a text layer through OCRmyPDF
  (`--skip-text`), images through Tesseract, in the installed Tesseract languages (`--ocr-langs` to choose); a PDF
  copied before OCR was installed is redone once it is.

### Fixed

- `aiwb-memory` 0.2.1: the shared USER.md and MEMORY.md go into the system prompt fenced and marked as saved notes —
  preferences in them are followed, but they grant no permissions and override no instructions.
- judge 0.1.1: requests carry their own User-Agent; Groq's Cloudflare refused Python-urllib's default with 403
  (error code 1010), so a Groq judge gave no verdict.
- `aiwb-office` 0.3.1: knowledge text copies name an OCR tool that is installed but does not run, with its error
  (for example a broken Python library), instead of treating OCR as not installed.
- `aiwb-compare` 0.1.2: the manifest declares the panel and the message action it registers (`uiCapabilities`);
  the Control UI warned that they were missing.
- `aiwb-plan` 0.1.1: `exit_plan_mode` is declared in the manifest's `contracts.tools`; without it the Gateway refused
  to register the tool, and plan mode could not be left by approving a plan.
- `aiwb-office` 0.2.1: a long spreadsheet whose PDF is over the viewer's 16 MB opens as a preview of the first 1000
  rows of each sheet, with a note, instead of failing.

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
