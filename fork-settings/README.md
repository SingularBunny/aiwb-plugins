# aiwb-fork-settings

Shows which OpenClaw fork settings are in effect in the Gateway and sets them. The fork reads its
limits, switches, utility-model cadence, restart wait and proxy routes from `OPENCLAW_*` environment variables when it uses
them; the `env.vars` config setting puts them into the Gateway process. Without the fork they change
nothing (`fork` in the answer is the sha256 of the installed fork package, or `null`).

The plugin also adds two Control UI pages: **Proxy** (see [Proxy page](#proxy-page)) and **Chat files**
(see [Chat files page](#chat-files-page)).

## Methods

| Method | Scope | Params | Does |
|---|---|---|---|
| `aiwb-fork-settings.effective` | `operator.read` | — | every setting: `kind`, `value`, `default`, `unit`/`min`/`max` for integers, `source` (`env.vars`, `environment`, `default`), `raw`, `invalid`, `outOfRange`, `configured` |
| `aiwb-fork-settings.set` | `operator.admin` | `{name, value}` or `{name, rules, revision}`; `dryRun` | checks the value and writes `env.vars.<name>` |
| `aiwb-fork-settings.unset` | `operator.admin` | `{name}`; `dryRun` | removes `env.vars.<name>`; the default applies again |
| `aiwb-fork-settings.proxy` | `operator.read` | — | Proxy page data: managed proxy, routes and CLI backend proxy as editable lists, Claude Code and installer proxy keys (booleans) |
| `aiwb-fork-settings.proxyCheck` | `operator.admin` | `{hosts?}` | HTTPS HEAD to each host directly and through the managed proxy |
| `aiwb-fork-settings.chatFiles` | `operator.read` | — | Chat files page data: folders per scope with their check on disk, agents, what is in effect, installer key (boolean) |
| `aiwb-fork-settings.checkFolder` | `operator.admin` | `{path}` | checks one folder on the Gateway's disk: `ok`, `missing`, `not-dir`, `relative`, `root`, `home`, `separator` |

`dryRun: true` checks and answers as the write would (`stored`, `overriddenByEnvironment`) without
writing.

```bash
openclaw gateway call aiwb-fork-settings.effective --json
openclaw gateway call aiwb-fork-settings.set --params '{"name":"OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS","value":600000}' --json
openclaw gateway call aiwb-fork-settings.unset --params '{"name":"OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS"}' --json
```

- `invalid` — the fork ignores the text and uses the default (an integer that is not above zero, a
  flag word it does not know, a grant list with nothing valid).
- `outOfRange` — the fork uses the integer, but `set` would refuse it.
- `configured` — `env.vars` holds a different value than the process: the process environment or
  `~/.openclaw/.env` wins over `env.vars`. `set` reports the same case as `overriddenByEnvironment`.

`set` and `unset` write the config file through `api.runtime.config.mutateConfigFile` with
`afterWrite: auto`; the Gateway reloads `env.vars` and the fork reads the value on its next use.
No `OPENCLAW_PLUGIN_GATEWAY_METHODS` grant is needed: the plugin does not call `config.patch`, which
is `operator.admin` and beyond what a grant can reach.

## Settings

| Name | Kind | Default | Accepted by `set` |
|---|---|---|---|
| `OPENCLAW_WORKER_PENDING_TASKS` | int, tasks | 128 | 1..1000000 |
| `OPENCLAW_WORKER_PENDING_BYTES` | int, bytes | 268435456 | 1 MiB..16 GiB |
| `OPENCLAW_WORKER_HEAP_MB` | int, MB | 512 | 64..65536 |
| `OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS` | int, items | 200 | 1..50000 |
| `OPENCLAW_CATALOG_CONTINUATION_MAX_BYTES` | int, bytes | 524288 | 1 KiB..64 MiB |
| `OPENCLAW_CATALOG_IMPORT_OWNER` | flag | off | true/false |
| `OPENCLAW_MEMORY_INDEX_ON_START` | flag | off | true/false |
| `OPENCLAW_CLAUDE_CHROME` | flag | off | true/false |
| `OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS` | flag | on (off only on `0`/`false`) | true/false |
| `OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS` | int, ms | 12000 | 1000..3600000 |
| `OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS` | int, ms | 90000 | 1000..86400000 |
| `OPENCLAW_PLUGIN_GATEWAY_METHODS` | grants | none | `<plugin id>=<method>,…;…`, exact names |
| `OPENCLAW_RESTART_AGENT_RUN_WAIT_MS` | wait, ms | upstream | 300001..604800000 or `unlimited` |
| `OPENCLAW_PROXY_ROUTES` | routes | upstream (all through the proxy) | `<host>,<host>=<proxy\|direct\|URL>;*=<proxy\|direct\|URL>` |
| `OPENCLAW_CLI_BACKEND_PROXY` | backends | route of the backend's API host | `<backend id>=<proxy\|direct\|URL>;…` |
| `OPENCLAW_ASSISTANT_MEDIA_ROOTS` | folders | none (upstream) | `*=<folder>:<folder>;<agent id>=<folder>` or `{"*": [...], "<agent id>": [...]}`; not `/` or the home folder |

`OPENCLAW_RESTART_AGENT_RUN_WAIT_MS` decides how long a Gateway restart required by a config change
waits for running agent turns. Unset (`value: null`, `upstream` in the log line) keeps upstream: after
5 minutes the restart is forced and the turns are aborted. Milliseconds above 300000 are the longest
total wait while turns run; `unlimited` waits until no turn runs. The fork ignores any other text
(`invalid`) and keeps upstream.

`OPENCLAW_PROXY_ROUTES` decides which destination hosts use the managed proxy (`proxy.proxyUrl`).
A host suffix matches the host and its subdomains, case-insensitively and on any port; `*` covers
every other host; the most specific suffix wins. A URL target must equal `proxy.proxyUrl` in the
fork (one proxy in process), so `proxy` is the usual target. Example:
`api.example.com,example.org=proxy;*=direct`. `OPENCLAW_CLI_BACKEND_PROXY` sets the proxy env
of CLI agent backend children per backend id (`claude-cli`, `google-gemini-cli`, …); a URL there may
be any proxy. The fork ignores a rule set it cannot parse as a whole (`invalid`) and routes upstream.
Both may hold proxy URLs with credentials: `set` stores them as given, while `effective`, the log
line and `set`/`unset` answers show every URL target as `<proxy URL>` (unparseable text as
`<invalid>`).

Flags are stored as `1`/`0`. The list, parsing and ranges live in `settings.js`; the fork's own
readers are named in each entry's `where`.

## Proxy page

A Control UI page (tab **Proxy**, `dist/control-ui/proxy.js`, hand-written, no build step). It needs
Custom plugin UI (`gateway.controlUi.experimental.customPlugins: true`; the ai-workbench installer turns
it on). Viewing needs `operator.read`; saving and the check need `operator.admin`.

- **Managed proxy** — address as `scheme://host:port` (never credentials, path or query), whether it is
  configured (`proxy.proxyUrl` or `OPENCLAW_PROXY_URL`), enabled (`proxy.enabled` is not `false`) and
  active in this Gateway process (`OPENCLAW_PROXY_ACTIVE`), and the state of the fork routes: `active`,
  `invalid` with the reason (the fork then sends everything through the proxy) or `unset` (upstream:
  everything through the proxy).
- **Proxy routes** — `OPENCLAW_PROXY_ROUTES` as a list of host suffixes with a target (`proxy` or
  `direct`) and the rule for everything else (`*`). Hosts are added, retargeted and removed on the page;
  **Save…** shows the resulting value and writes it through `set` after confirmation. An empty list
  removes the setting.
- **CLI backend proxy** — which proxy each CLI backend child gets now (explicit entry, the route of its
  API host — `claude-cli` follows `api.anthropic.com` — or the Gateway proxy env) and
  `OPENCLAW_CLI_BACKEND_PROXY` as an editable list of backend ids.
- **Check** — `proxyCheck` for the route hosts, hosts typed on the page and common provider hosts
  (`openrouter.ai`, `api.anthropic.com`, `api.openai.com`, `clawhub.ai`, `api.telegram.org`,
  `api.github.com`, `registry.npmjs.org`, `generativelanguage.googleapis.com`).
- **Claude Code** — whether `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` are set in the `env` block of
  `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when set). Only booleans; the file is not
  edited here (the installer key `WORKBENCH_CLAUDE_CODE_PROXY` writes it).
- **Installer notice** — when `~/.openclaw/.env` sets `WORKBENCH_PROXY_URL` or `WORKBENCH_PROXY_ROUTES`,
  each install writes the routes again (from `WORKBENCH_PROXY_HOSTS` / `WORKBENCH_PROXY_ROUTES`), so page
  edits last only until then unless the `.env` key is updated too. `set`/`unset` of
  `OPENCLAW_PROXY_ROUTES` report this as `installerNote`. The plugin reads key presence only and never
  writes the file.

### Editing without proxy URLs

`proxy` returns each list as `entries: [{key, target}]` (plus `fallback` for routes) and an opaque
`revision`. A URL target is returned as `url:<n>` (the n-th distinct URL of the stored value), never as
the URL. `set` with `{name, rules: {entries, fallback}, revision}` builds the value: hosts sharing a
target share a rule, `*` comes last, `url:<n>` is replaced by the stored URL on the Gateway. A
`revision` that no longer matches the stored value (`env.vars`, else the process environment) is
refused with `CONFLICT`. The revision is an HMAC with a per-process random key, so it reveals nothing
about the value.

```bash
openclaw gateway call aiwb-fork-settings.proxy --json
openclaw gateway call aiwb-fork-settings.set --json --params \
  '{"name":"OPENCLAW_PROXY_ROUTES","rules":{"entries":[{"key":"api.example.com","target":"proxy"},{"key":"example.org","target":"proxy"}],"fallback":"direct"},"revision":"<from proxy>","dryRun":true}'
```

### Check

For each host, `https://<host>/` gets an HTTPS `HEAD` directly and through the managed proxy, with an
8 s timeout, up to 6 hosts at a time and at most 40 hosts. One check runs at a time.

- Direct requests use an undici `Agent` of their own: no proxy, `HTTP(S)_PROXY` ignored, and an explicit
  dispatcher is not replaced by the Gateway's process-wide proxy routing.
- Proxied requests use an undici `ProxyAgent` to `proxy.proxyUrl`, read on the Gateway (the CA of
  `proxy.tls.caFile` is trusted for the proxy). Without a proxy URL only the direct path runs.
- undici comes from OpenClaw itself: a plugin linked from its folder has no `node_modules`.

Each path answers with the HTTP status (any status means reachable; `403`/`451` may be a region block)
or an error class: `timeout`, `refused`, `dns`, `reset`, `unreachable`, `tls`, `proxy` (the proxy
refused the tunnel, with its status), `error`; and the latency. The hint compares both with the
current route: `add-to-proxy` (blocked directly, works via proxy, routed direct), `proxy-needed` (the
same, already routed through the proxy), `route-direct` (works directly, fails via proxy, routed
through the proxy), `direct-only`, `unreachable`. **Add to list** on the page puts the host into the
routes list; it applies once saved.

## Chat files page

A Control UI page (tab **Chat files**, `dist/control-ui/chat-files.js`, registered by the same entry)
for the fork's `OPENCLAW_ASSISTANT_MEDIA_ROOTS`: folders whose files the chat previews and downloads,
any file type, in Full Access sessions. Outside them (and the session's own folders) the chat shows
only images; workspace-only, remote and cloud sessions are not affected, and agent tools keep their
own file access. Viewing needs `operator.read`; adding folders and saving need `operator.admin`.

- **All agents** — the `*` list, used by every agent's chats. Common folders (`~/Desktop`,
  `~/Downloads`, `~/Documents`) are offered when they exist.
- **Per agent** — pick an agent (from the config's agents) and edit its own list. A chat uses the
  `*` folders plus its agent's; another agent's folders stay closed to it.
- **Add** — the typed folder (absolute or `~/…`) is checked on the Gateway's disk with `checkFolder`
  first: it must exist, be a folder, and be neither `/` nor the home folder nor a folder containing
  it (by real path, so a symlink to the home folder is refused too).
- **Save…** — shows the resulting value and writes it through `set` after confirmation; empty lists
  remove the setting. `set` refuses `/`, the home folder and relative paths, and reports folders that
  do not exist (yet) as `problems` (OpenClaw skips them).
- **In effect now** — the real paths OpenClaw uses from the process value, per scope.
- **Installer notice** — when `~/.openclaw/.env` sets `WORKBENCH_CHAT_FILE_FOLDERS`, each install writes
  the setting again (from that key and the per-project `chatFileFolders` of the ai-workbench profile), so
  page edits last only until then unless those are updated too. `set`/`unset` report this as
  `installerNote`.

```bash
openclaw gateway call aiwb-fork-settings.chatFiles --json
openclaw gateway call aiwb-fork-settings.set --json --params \
  '{"name":"OPENCLAW_ASSISTANT_MEDIA_ROOTS","value":{"*":["~/Desktop","~/Downloads"],"reports":["/srv/shared"]},"dryRun":true}'
```
