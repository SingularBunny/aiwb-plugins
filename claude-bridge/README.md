# aiwb-claude-bridge — Claude Desktop & Code bridge

Brings Claude Desktop and Claude Code into OpenClaw: the "Projects" chat tree by project folder, as in
Claude Desktop (old Claude Desktop and Claude Code chats and the sessions of the project's agent in one
folder), old chats continued in the project agents, a live "thinking" status on rows, drag-and-drop order,
moving chats between projects, and live import of Claude Code memory. Config: `plugins.entries.aiwb-claude-bridge.config`:

```json5
{
  projects: { "<folder>": "<agent id>" },   // tree folder → agent
  defaultAgent: "main",                      // agent of folders without a project
  defaultFolder: "_no_space",                // folder for the default agent's new sessions
  order: ["<folder>", …],                    // folder order in the tree
  adoption: { enabled: true },               // adopt old chats in the Gateway (below)
  memorySync: { enabled: false, root: "~/claude-projects", claudeProjectsDir: "~/.claude/projects" },
}
```

A project agent's sessions are rows of its folder: the main chat, new chats, adopted chats and its
automations (scheduled jobs, `agent:<id>:cron:<job>`). Automation rows follow "Show automation sessions"
in the sidebar (hidden while it is off; OpenClaw fork); a job that runs in an existing chat
(`sessionTarget` of that chat) has no session of its own. Subagent runs and an automation's per-run
records are not rows. Sessions of agents without a folder stay in OpenClaw's own list.

## Old chats → project agents

Each tree chat without a session (a "Projects" row without `sessionKey`) is adopted by the agent of its
folder (`projects[<folder>]`, else `defaultAgent`): a Claude catalog import with the full history
(`sessions.catalog.import`; a catalog "continue" carries only the last 200 records), then binding to the
Claude Code chat itself, so it continues in the same Claude CLI chat (the first turn forks, the source
file is unchanged). An archived import session from an earlier adoption is restored, and the session is
made shared (the import creates a draft). Claude CLI is not launched.

**Where.** In the Gateway (`adopt.js`, service `aiwb-claude-bridge-adoption`): 30 seconds after start,
every 10 minutes, and 5 seconds after the tree metadata changes; passes never overlap. The plugin calls
the Gateway methods `sessions.catalog.list`, `sessions.catalog.import`, `sessions.patch` and
`session.visibility.set` in process (`api.runtime.gateway.request`). OpenClaw allows that only to its
bundled and trusted official plugins; the ai-workbench OpenClaw fork lets the operator grant exact
methods, with `operator.write` at most:

```bash
openclaw config set env.vars.OPENCLAW_PLUGIN_GATEWAY_METHODS \
  '"aiwb-claude-bridge=sessions.catalog.list,sessions.catalog.import,sessions.patch,session.visibility.set,sessions.list"' --strict-json
```

`sessions.list` is not needed for adoption: the tree reads with it which chats have a turn in progress
(the spinner on a row, see below).

The ai-workbench installer sets it with the fork. Without the grant (or with `adoption.enabled: false`)
the plugin does not adopt, and `migrate/claude-desktop/claude-code-catalog.mjs` in ai-workbench does the
same from its timer through `openclaw gateway call` and the `aiwb-claude-bridge.bind` method.

**Registry.** A chat is adopted once: `<OpenClaw state>/workbench/aiwb-claude-bridge-adopted.json` lists
adopted chats, plus every chat bound to a project agent session (archived ones included), so a chat
deleted or archived in OpenClaw does not come back by itself.

**Gateway methods.**

| Method | Scope | What it does |
|---|---|---|
| `aiwb-claude-bridge.adoption` | read | `{ inGateway }`: whether this Gateway adopts; otherwise `reason` |
| `aiwb-claude-bridge.readopt` | admin | `{ chats: ["<id, id prefix or title>", …] }`: clear the registry mark and adopt now; returns `adopted`, `failed`, `errors`, `readopt` (ids), `unknown` |
| `aiwb-claude-bridge.adopted` | read | chats bound to project agent sessions (for the script) |
| `aiwb-claude-bridge.bind` | admin | bind an import session to its Claude Code chat (for the script) |

Imports and errors are logged by the Gateway (`aiwb-claude-bridge adoption by agents: …`); a missing
grant is logged once.

## Order and moving chats (OpenClaw fork)

**Order.** The fork's `sessions.catalog.reorder` (Control UI: drag a folder by its header, a chat within its
folder) is stored in `<OpenClaw state>/workbench/aiwb-claude-bridge-order.json`: `folders` (the dragged
folder order, before `order` from the config), `rows` (per folder, the chats in the order the UI sent) and
`placedAt` (when the folder was arranged). In an arranged folder, chats not placed by the user that have
activity after `placedAt` (new chats among them) go on top, the placed ones follow in their order, older
unplaced chats come last (`order.js`).

**Moving a chat** to another project folder (`sessions.catalog.move`; Control UI: drop the chat on a chat or
on the header of another folder) hands it to that folder's agent, keeping its history (`move.js`). OpenClaw
cannot reassign a session to another agent, and a Claude CLI chat resumes only from the Claude Code project
folder of its working folder, so a move is an adoption into the target agent:

1. the Claude Code conversation the chat continues now (its session's `claude-cli` binding; for a chat not
   adopted yet, the tree chat itself) is copied into the Claude Code project of the target working folder
   (`~/.claude/projects/<encoded folder>/<new id>.jsonl`) as a new conversation: a new id, its records'
   `sessionId` rewritten, the source file unchanged. A new id, because conversations run by OpenClaw
   (entrypoint `sdk-cli`: every chat started in OpenClaw, and an adopted chat after its first turn) are
   hidden from the Claude catalog (`claude-code-catalog.mjs` marks them archived in the tree metadata),
   and the catalog does not import a hidden conversation;
2. the copy is imported into the target agent with full history (`sessions.catalog.import`, catalog
   `claude`); if the import fails, the copy is removed;
3. the import session is bound to the copy in the target folder (`<memorySync.root>/<folder>`, or the agent's
   `cwd` when that is the folder) and keeps the tree chat as its source mark; the next turn continues the
   copy itself (no fork, unlike adoption: the copy belongs to this session alone);
4. the session in the source agent is archived (not deleted) by the Gateway, as the operator who moved the
   chat (the move result names it; a plugin may patch only sessions it created); if that fails, the move
   stands and the sidebar shows a warning to archive it by hand. The chat and every
   chat bound to that session are recorded in the adoption registry under the new session, so neither
   the tree nor adoption brings them back to the old folder.

A chat dropped at a position keeps it in the target folder's order. Refused: the folder it is in, a
project's main chat (`agent:<id>:main`), an automation (it runs in its job's agent), a chat with a turn in progress, a folder without a working folder,
a chat without a Claude Code transcript. Moves run between adoption passes and need the same Gateway grant
(`sessions.catalog.import`, `sessions.patch`, `session.visibility.set`); without it the move is refused
with the reason. Claude Desktop's own files are not changed: Claude Desktop keeps showing the chat in its
old project.

**Archive and delete.** A session row (an agent session, new or adopted) is managed as in OpenClaw's own
list: in a folder of the agent that is open, the row has the regular session menu (archive with Undo,
delete with confirmation). In other folders, "Delete session" in the row menu archives it (the plugin's
catalog `archive` hook names the session and the Gateway archives it as the operator; "Restore" brings it
back). A project's main chat (`agent:<id>:main`) is protected by OpenClaw: no archive or delete (start
over in it with `/new` or `/reset`). Old chats not adopted yet are not sessions and cannot be archived here.

## Claude Code memory → agent memory (one way)

Claude Code keeps memory per working folder in `~/.claude/projects/<encoded folder>/memory/`: a `MEMORY.md`
index and one `*.md` fact per file. The plugin copies it, live, into the memory of the agent that owns the
same project folder in the tree.

**What maps where.** The real working folder is read from a session file of that Claude Code folder (the
encoded name is ambiguous: non-ASCII letters and `/` both become `-`). A folder under `memorySync.root`
belongs to the tree folder `<root>/<Folder>`, exactly as `claude-code-catalog.mjs` puts its chats there,
and the tree folder belongs to `projects[<Folder>]` or `defaultAgent`. Skipped: temporary folders
(`-tmp-*`, a working folder under the temp dir), folders whose working folder is unknown (no session
file), and folders outside the root (their chats are not in the tree either).

**What is written.** Facts go to `<agent workspace>/memory/<name>.md` (the workspace is
`agents.entries.<id>.workspace`). The Claude Code index goes to `<workspace>/memory/claude-code-index.md`,
a file owned by the sync, one section per tree folder when several folders feed one agent (for example
`AI-Platform` and `_no_space` both feed `main`). Its links are the source links as is: they resolve next
to the facts. The agent's root `MEMORY.md` is never written. Other files and subfolders are not copied.

**Direction and conflicts.** Claude Code → OpenClaw only. Nothing is ever deleted on the OpenClaw side
(a fact removed in Claude Code stays in the agent's memory). The state file
`<OpenClaw state>/workbench/aiwb-claude-bridge-memory-sync.json` keeps the hash last written to each target.
A target is written only if it does not exist yet, or its current hash equals that hash. Everything else
is a conflict: reported and skipped, never guessed. In particular:

- an existing target that differs and was never synced (the first run has no state);
- a target edited, or deleted, on the OpenClaw side since the last sync;
- two Claude Code folders of one agent with different files of the same name;
- a target that has an OpenClaw memory provenance record (see below), or when that record store
  cannot be read.

A target equal to its source is recorded as synced, so later source changes reach it. To resolve a
conflict, make the two files equal; the next pass records them as synced. A target that was never
synced can also be deleted to have it copied; one deleted after a sync stays deleted.

**Memory provenance.** OpenClaw puts the root `MEMORY.md` and `USER.md` into the context only while
their provenance is trusted (docs `concepts/memory.md`: "Files recorded as untrusted and remote files
without a valid read-source identity remain excluded"; `concepts/user-model.md`: "memory without trusted
provenance is filtered out"). The record is written when the agent writes a memory file through
OpenClaw, and the next write stays trusted only if the file still has the hash recorded at the previous
one: once someone else changes the file, the agent's next write marks it untrusted for good. So the sync:

- never writes the root `MEMORY.md`: the index lives in `memory/claude-code-index.md`, and the plugin
  adds its lines that the agent's own `MEMORY.md` does not link yet to the prompt (`before_prompt_build`,
  requires `plugins.entries.aiwb-claude-bridge.hooks.allowPromptInjection: true`; not in scheduled runs and
  subagents, which do not get root memory either). Facts in `memory/` are found by memory search;
- never writes a `memory/*.md` file that has a provenance record (read-only from the OpenClaw state
  database), since that file was written by the agent.

**Dry run.** Reads the real OpenClaw config (`~/.openclaw/openclaw.json`, or `--config`,
`OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`) and writes nothing:

```bash
node claude-bridge/memory-sync.js --dry-run     # per agent: create / update / unchanged / conflict, then the lists
node claude-bridge/memory-sync.js --apply       # one pass now, regardless of the switch
```

**Switch.** `memorySync.enabled` (default `false`) runs the live sync in the Gateway: service
`aiwb-claude-bridge-memory-sync` watches the memory folders and the Claude Code projects folder (2 s debounce),
plus a pass every 10 minutes for memory folders that appear later. It is off by default because the
first pass writes into every agent's memory: run the dry run, resolve or accept the conflicts, then
enable it and restart the Gateway. Changes and conflicts are logged by the Gateway; set
`AIWB_CLAUDE_BRIDGE_DEBUG=1` to log every pass.

## Renamed from aiwb-projects

Until November 2026 the plugin was `aiwb-projects` in the `projects/` folder. The ai-workbench installer
moves `plugins.entries.aiwb-projects` (config, hooks) to `aiwb-claude-bridge` and the load path to
`claude-bridge/`. The plugin moves its state files `<OpenClaw state>/workbench/aiwb-projects-*.json`
(adopted chats, running turns, order, memory sync) to `aiwb-claude-bridge-*.json` when it starts, unless the
new file already exists. The session catalog keeps its id `projects` and the label "Projects", and sessions
adopted before the rename keep their source chat mark under the old id.

## Turn in progress

A row shows the spinner while its session has a turn running. The plugin asks the Gateway
(`sessions.list` with `activeOnly`, one call per project agent, cached for 2 seconds), so a turn keeps the
spinner however long it lasts. Turn start and end hooks (`before_model_resolve`, `agent_end`; needs
`hooks.allowConversationAccess`) keep marks in `<OpenClaw state>/workbench/aiwb-claude-bridge-running.json`:
a fresh mark shows the spinner before the Gateway lists the turn, and a change of the marked set tells
connected Control UIs to re-read the tree (once at once, once more 3 seconds later, when the Gateway has
settled the turn end). The file is written only when that set changes. Without the `sessions.list` grant
the marks decide alone, and a mark older than 30 minutes no longer shows the spinner. Automation sessions
(folder rows since they sit in their agent's folder) take their spinner from the same live status.

The tree reaches the sidebar through the host event as well as the list response (`catalog-host.js`): on a
connection that already has a page, the Gateway answers a refresh from its cache without waiting for the
plugin and marks the tree pending, and the sidebar keeps its rows for a pending tree. Without the event the
rows, their spinners and the order changed since the previous refresh stayed off screen until a later
refresh happened to finish at once.
