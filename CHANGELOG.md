# Changelog

All notable changes to the ai-workbench plugins. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release of this repository is a git tag
`vX.Y.Z`; each plugin also keeps its own version in its manifest (`package.json`, or
`.claude-plugin/plugin.json` for the judge), raised when that plugin changes.

## [Unreleased]

### Added

- `aiwb-groups` 0.2.0: group chats in ordinary chats, for the Control UI of the ai-workbench OpenClaw fork. **Add to
  group chat** (in the chat header and the **Hand off…** menu) adds an OpenClaw agent, an ACP agent (as in
  `acp.allowedAgents`, e.g. Junie) or any model to the chat as a separate participant; the chat's own model or bound
  agent keeps answering as before. A message that names a member (`@Junie …`, or the **Ask Junie** chip by the
  composer) is answered by that member with a full turn of its own: an OpenClaw agent in its own session for the chat,
  a model as the chat's agent on that model, an ACP agent in its own persistent ACP session. It gets who is in the chat
  and what was said since its last turn; its reply is written into the chat with its author (the agent's or model's
  name and avatar, Retry under a failed turn, the refusal hint), and the chat's own model reads it as shared history
  with a one-line note. Gateway methods `aiwb-groups.chat.get|add|remove|ask|stop`; members in
  `~/.openclaw/workbench/groups/chats/`. A model member runs as a model override, which OpenClaw allows for an
  operator with admin scope (the owner's Control UI) or with `plugins.entries.aiwb-groups.subagent.allowModelOverride`.
  ACP members need the fork's `agent_end` for ACP turns (`aiwb/group-chat`).
- `aiwb-claude-bridge` 0.3.0: a chat adopted by the default agent before its folder had an agent moves to that
  agent once it exists, if nobody has written in it since adoption (no turn traces in the session entry, the Claude
  CLI binding unchanged); a chat used in the meantime stays and gets **Move to project <folder>…** in its menu
  (Control UI, with a confirmation; the drag-and-drop move). Both keep the title, pin and read state; the old
  session is archived and adoption does not import the chat again. Method `aiwb-claude-bridge.rehome.offers`.
  Moves between folders now also carry the title, pin and read state, and are refused while the target folder's
  agent does not exist.
- `aiwb-plan` 0.2.0: gateway methods `aiwb-plan.status` and `aiwb-plan.set` — the same switch as `/plan` and
  `/plan off`, for the Plan toggle in the Control UI composer of the ai-workbench OpenClaw fork; a short session key
  (`main`, or one without the agent part) reaches the same chat as the command.
- `aiwb-fork-settings` 0.4.1: `OPENCLAW_MEDIA_MODEL_OVERRIDE` — whether the agent may name the model of the image and pdf tools.
- `judge` 0.3.0: a local verdict log (`~/.openclaw/judge/verdicts.jsonl`, `WORKBENCH_JUDGE_LOG`), `--stats` with
  the PASS rate per judge and its interval, human labels (`--to-label`, `--label`) and the share of good answers
  corrected for the judge's errors (Rogan–Gladen with the interval of Lee et al., ICML 2026; no fixed threshold).
- `aiwb-compare` 0.3.0: **Merge** ends with what stays unresolved (the disagreements and the key assumptions) and
  what would settle it (evidence that fits one view and not the other), as in Analysis of Competing Hypotheses
  (Heuer, Psychology of Intelligence Analysis, ch. 8); when the answers agree, the merge has no such sections.
- `aiwb-compare` 0.2.0: **Agreement matrix** — the judge checks every pair of answers both ways for entailment, as
  semantic entropy does (Farquhar et al., Nature 2024; the authors' prompt and reading of the reply): same,
  compatible, different or contradict, and the groups of answers that say the same; method `aiwb-compare.agreement`.
- `aiwb-office` 0.4.0: skill `searchable-pdf` — a copy of a scanned PDF with a text layer (`<name>.ocr.pdf` next to it),
  made locally by OCRmyPDF with `--skip-text` in the installed Tesseract languages; the original and existing files are
  not overwritten. The OCR language and tool checks moved to `office/ocr.js`, shared with the knowledge text copies.
- `aiwb-claude-bridge` 0.2.0: continue a chat in Claude Code in a terminal — "Continue in terminal" in the chat's menu
  copies `cd <folder> && claude --resume <id>`; `~/.openclaw/workbench/claude-chats.md` lists every chat's command
  and works without OpenClaw; OpenClaw does not run a chat's turns while a terminal has it open.
- `judge` 0.2.0: a panel of judges — `WORKBENCH_JUDGE_PANEL` adds up to two more judge models; majority per
  criterion (PoLL, Verga et al., 2024), the third judge only when the first two disagree or one fails, a tie is not
  evaluated.
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

- `aiwb-claude-bridge` 0.3.2: state files (adoption, moves, pending shares, folder order, running marks, memory
  sync) are written through a temporary file and renamed, so a crash or a second plugin instance never reads half a
  file (`state-file.js`, one helper instead of four copies). Secret redaction of imported memory no longer swallows
  the text after a pasted private key: a whole key block ends at its own END line, a clipped one takes only base64
  lines and PEM headers. Tests for both.
- `aiwb-groups` 0.2.1: a question sent to a group member is written as the owner's own message (provenance and sender
  identity like `chat.send`), so the chat shows it under the owner instead of a bare "Message" label.

- `aiwb-claude-bridge` 0.3.1: a chat moved to another project no longer stays a hidden draft next to its old copy.
  Sharing an imported session (`session.visibility.set`) right after the import is retried with backoff (0.5 to
  8 s) while the Gateway says the session storage is not ready; a session still a draft is kept in a pending list
  and shared on the next adoption pass. A move archives the old chat only once the new one is shared — otherwise
  it reports that and archives the old chat on the pass that shares the new one. Adoption shares the same way.
- `aiwb-claude-bridge` 0.2.1: "Continue in terminal", the terminal lock and the chats file also cover chats started in
  OpenClaw — they have no `spawnedCwd`, and the folder is read from the conversation file.
- `aiwb-compare` 0.1.3: each answer shows the tokens and price the provider reported (`free` for $0), next to its time.
- `aiwb-plan` 0.1.2: while a chat plans, `process`, `browser`, `message`, `cron`, `sessions_send`, `gateway` and `nodes`
  calls also wait for approval (before only `exec` and subagents); the plan names its riskiest assumption, a check per
  step, the steps that cannot be undone and the effort as a range.
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
