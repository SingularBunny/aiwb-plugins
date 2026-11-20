// Automation chat for the OpenClaw Control UI (native plugin view, hand-written, no build step). In the chat of an
// automation (`agent:<agent>:cron:<job>`):
// - Run now / Run again in the chat header starts a job that delivers into the chat, like Automations → Run, after a
//   confirmation; with several jobs the button is "Run…" and asks which one.
// - The Runs side panel lists the latest runs of those jobs: the automation that owns the chat, jobs that target it
//   by session and jobs set up from it. A run opens in place in the host's run viewer (`cron.history`).
// - Runs opens by itself the first time a page shows an automation chat.
// The jobs that deliver into a chat follow the same rule as the OpenClaw fork's own code did (run-history-chat.ts).
// Needs the fork's plugin points: `host.components.mountCronRun` and panels with `available`; without them the plugin
// adds nothing, so an older build keeps its own controls.

const PLUGIN_ID = "aiwb-automation-chat";
const PANEL_ID = "runs";
const RUNS_PER_JOB = 20;

const STRINGS = {
  en: {
    runs: "Runs",
    runNow: "Run now",
    runAgain: "Run again",
    runMenu: "Run…",
    pickJob: "Which automation should run now?",
    runConfirm: (name) => `Run ${name} now?`,
    runConfirmDetails: "It runs exactly as on schedule and may send messages to people (for example in Slack or Telegram).",
    run: "Run",
    cancel: "Cancel",
    started: (name) => `${name}: started.`,
    notStarted: (name, reason) => `${name}: not started (${reason}).`,
    running: "Running…",
    empty: "No runs yet.",
    loading: "Loading…",
    refresh: "Refresh",
    openInAutomations: "Open in Automations",
    status: { ok: "OK", error: "Error", skipped: "Skipped", running: "Running" },
  },
  ru: {
    runs: "Запуски",
    runNow: "Запустить сейчас",
    runAgain: "Запустить снова",
    runMenu: "Запустить…",
    pickJob: "Какую автоматизацию запустить сейчас?",
    runConfirm: (name) => `Запустить ${name} сейчас?`,
    runConfirmDetails: "Запуск пройдёт так же, как по расписанию, и может отправить сообщения людям (например, в Slack или Telegram).",
    run: "Запустить",
    cancel: "Отмена",
    started: (name) => `${name}: запущено.`,
    notStarted: (name, reason) => `${name}: не запущено (${reason}).`,
    running: "Идёт…",
    empty: "Запусков пока нет.",
    loading: "Загрузка…",
    refresh: "Обновить",
    openInAutomations: "Открыть в «Автоматизациях»",
    status: { ok: "Успешно", error: "Ошибка", skipped: "Пропущен", running: "Идёт" },
  },
};

const AUTOMATION_CHAT_KEY = /^agent:[^:]+:cron:([^:]+)(?::run:[^:]+)?$/i;

/** The job that owns an automation chat, or null for any other chat. */
export function automationChatJobId(sessionKey) {
  return AUTOMATION_CHAT_KEY.exec(String(sessionKey ?? "").trim())?.[1] ?? null;
}

const chatKey = (sessionKey) => String(sessionKey ?? "").trim().replace(/:run:[^:]+$/i, "").toLowerCase();

/** Jobs whose runs land in this chat: its owner, jobs targeting it by session, jobs set up from it. Owner first. */
export function jobsDeliveringToChat(sessionKey, jobs) {
  const key = chatKey(sessionKey);
  const owner = automationChatJobId(key)?.toLowerCase();
  const target = `session:${key}`;
  const delivering = jobs.filter((job) =>
    String(job.id).toLowerCase() === owner ||
    (typeof job.sessionTarget === "string" && job.sessionTarget.toLowerCase() === target) ||
    (job.sessionTarget === "current" && typeof job.sessionKey === "string" && chatKey(job.sessionKey) === key));
  return delivering.toSorted((a, b) =>
    Number(String(b.id).toLowerCase() === owner) - Number(String(a.id).toLowerCase() === owner) ||
    jobName(a).localeCompare(jobName(b)));
}

export const jobName = (job) => String(job?.name ?? "").trim() || String(job?.id ?? "");
const lastRunFailed = (job) => (job?.state?.lastRunStatus ?? job?.state?.lastStatus) === "error";
const isRunning = (job) => typeof job?.state?.runningAtMs === "number";

/** Owner and other jobs' runs in one list, newest first. */
export function mergeRuns(pages) {
  const at = (entry) => entry.runAtMs ?? entry.ts ?? 0;
  return pages.flat().toSorted((a, b) => at(b) - at(a));
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** One dialog at a time, under <body>; resolves what `finish` is called with. */
function openDialog(host, label, build) {
  return new Promise((resolve) => {
    const container = el("div", { class: "aiwb-automation-chat__host" });
    document.body.append(container);
    let handle = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      handle?.dispose?.();
      container.remove();
      resolve(value);
    };
    const content = el("div", { class: "aiwb-automation-chat__dialog" });
    build(content, finish);
    handle = host.components.mountDialog(container, { label, content, onCancel: () => { finish(null); return true; } });
    content.querySelector("button.primary, button.danger")?.focus?.();
  });
}

/** The automation jobs of the Gateway, read once per chat state; `invalidate` re-renders the header after a read. */
function createJobs(host) {
  let jobs = null;
  let loading = null;
  async function load() {
    const rows = [];
    for (let page = 0, offset = 0; page < 5; page += 1) {
      const result = await host.request("cron.list", { includeDisabled: true, limit: 200, offset, sortBy: "name", sortDir: "asc" });
      rows.push(...(Array.isArray(result?.jobs) ? result.jobs : []));
      if (!result?.hasMore || result.nextOffset === null || result.nextOffset === undefined) break;
      offset = result.nextOffset;
    }
    return rows;
  }
  return {
    forChat(sessionKey) {
      if (jobs === null && !loading) {
        loading = load().then((rows) => { jobs = rows; }, () => { jobs = []; }).finally(() => { loading = null; host.ui.invalidate(); });
      }
      return jobs ? jobsDeliveringToChat(sessionKey, jobs) : null;
    },
    async reload() {
      jobs = await load().catch(() => jobs ?? []);
      host.ui.invalidate();
      return jobs;
    },
    forget() { jobs = null; },
  };
}

async function runJob(host, s, jobs, job) {
  const name = jobName(job);
  const ok = await openDialog(host, s.runConfirm(name), (content, finish) => {
    content.append(
      el("p", { class: "aiwb-automation-chat__hint" }, s.runConfirmDetails),
      el("div", { class: "aiwb-automation-chat__actions" },
        el("button", { type: "button", class: "btn", onclick: () => finish(false) }, s.cancel),
        el("button", { type: "button", class: "btn primary", onclick: () => finish(true) }, s.run)));
  });
  if (!ok) return;
  try {
    const result = await host.request("cron.run", { id: job.id, mode: "force" });
    if (result && result.ran === false && result.reason) throw new Error(String(result.reason));
  } finally {
    await jobs.reload();
  }
}

function pickJob(host, s, list) {
  return openDialog(host, s.pickJob, (content, finish) => {
    content.append(
      el("div", { class: "aiwb-automation-chat__jobs" },
        list.map((job) => el("button", {
          type: "button",
          class: "btn aiwb-automation-chat__job",
          disabled: isRunning(job),
          onclick: () => finish(job),
        }, `${lastRunFailed(job) ? s.runAgain : s.runNow}: ${jobName(job)}${isRunning(job) ? ` (${s.running})` : ""}`))),
      el("div", { class: "aiwb-automation-chat__actions" },
        el("button", { type: "button", class: "btn", onclick: () => finish(null) }, s.cancel)));
  });
}

function statusText(s, entry) {
  if (entry.status === "ok") return entry.completionStatus === "failed" ? s.status.error : s.status.ok;
  return s.status[entry.status] ?? String(entry.status ?? "");
}

function formatTime(ms, locale) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale || undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The Runs panel of one chat. */
function mountRunsPanel(host, s, jobs, container, params) {
  let sessionKey = params.sessionKey;
  const root = el("div", { class: "aiwb-automation-chat" });
  container.replaceChildren(root);
  let disposed = false;
  let viewer = null;
  let generation = 0;
  const closeViewer = () => { viewer?.dispose?.(); viewer = null; };

  async function load() {
    const current = ++generation;
    closeViewer();
    root.replaceChildren(el("p", { class: "aiwb-automation-chat__note", role: "status" }, s.loading));
    const list = jobsDeliveringToChat(sessionKey, (await jobs.reload()) ?? []);
    const pages = await Promise.all(list.map((job) =>
      host.request("cron.runs", { view: "summary", scope: "job", id: job.id, limit: RUNS_PER_JOB, sortDir: "desc" })
        .then((page) => page?.entries ?? [], () => [])));
    if (disposed || current !== generation) return;
    render(list, mergeRuns(pages));
  }

  function openRun(entry) {
    closeViewer();
    const view = el("div", { class: "aiwb-automation-chat__viewer" });
    root.replaceChildren(view);
    viewer = host.components.mountCronRun(view, {
      run: { jobId: entry.jobId, ...(entry.runId ? { runId: entry.runId } : {}), ...(typeof entry.runAtMs === "number" ? { runAtMs: entry.runAtMs } : {}) },
      onClose: () => void load(),
    });
  }

  function render(list, runs) {
    const names = new Map(list.map((job) => [job.id, jobName(job)]));
    const several = list.length > 1;
    const owner = list[0];
    const href = owner ? `${host.basePath || ""}/automations?${new URLSearchParams({ job: owner.id })}` : null;
    root.replaceChildren(
      el("header", { class: "aiwb-automation-chat__header" },
        el("span", { class: "aiwb-automation-chat__title" }, owner ? jobName(owner) : s.runs),
        href ? el("a", { class: "aiwb-automation-chat__open", href }, s.openInAutomations) : null,
        el("button", { type: "button", class: "btn btn--sm", onclick: () => void load() }, s.refresh)),
      runs.length === 0
        ? el("p", { class: "aiwb-automation-chat__note", role: "status" }, s.empty)
        : el("ol", { class: "aiwb-automation-chat__runs" },
          runs.map((entry) => el("li", {},
            el("button", {
              type: "button",
              class: "aiwb-automation-chat__run",
              "data-run-status": entry.status === "ok" && entry.completionStatus !== "failed" ? "ok" : (entry.status ?? "unknown"),
              disabled: !(entry.jobId && (entry.runId || typeof entry.runAtMs === "number")),
              onclick: () => openRun(entry),
            },
            several ? el("span", { class: "aiwb-automation-chat__job-name" }, names.get(entry.jobId) ?? entry.jobName ?? entry.jobId) : null,
            el("span", { class: "aiwb-automation-chat__line" },
              el("span", { class: "aiwb-automation-chat__time" }, formatTime(entry.runAtMs ?? entry.ts, host.locale)),
              el("span", { class: "aiwb-automation-chat__status" }, statusText(s, entry)),
              el("span", { class: "aiwb-automation-chat__duration" }, formatDuration(entry.durationMs))),
            entry.summary ? el("span", { class: "aiwb-automation-chat__summary" }, String(entry.summary).slice(0, 300)) : null)))));
  }

  // A finished run of any job refreshes the list (Gateway "cron" events).
  const stop = host.onEvent?.("cron", (payload) => {
    if (!viewer && (payload?.action === "finished" || payload?.status)) void load();
  });
  void load();
  return {
    // The same panel may follow another chat: list that chat's runs.
    update(next) {
      const key = next?.props?.sessionKey;
      if (key && key !== sessionKey) { sessionKey = key; void load(); }
    },
    dispose() { disposed = true; stop?.(); closeViewer(); container.replaceChildren(); },
  };
}

export default {
  id: PLUGIN_ID,
  activate(host) {
    // Only on a build with the plugin points this needs; an older fork keeps its own Run and Runs controls.
    if (typeof host.components?.mountCronRun !== "function") return;
    const s = String(host.locale || "").toLowerCase().startsWith("ru") ? STRINGS.ru : STRINGS.en;
    const jobs = createJobs(host);
    host.onEvent?.("cron", () => { jobs.forget(); host.ui.invalidate(); });

    host.ui.registerAction({
      id: "run-now",
      label: s.runNow,
      placement: "header",
      resolve: (context) => {
        if (!automationChatJobId(context.sessionKey) || !host.connection?.canAdmin) return { hidden: true };
        const list = jobs.forChat(context.sessionKey);
        if (!list || list.length === 0) return { hidden: true };
        if (list.length > 1) return { label: s.runMenu };
        const job = list[0];
        return isRunning(job) ? { label: s.running, disabled: true } : { label: lastRunFailed(job) ? s.runAgain : s.runNow };
      },
      run: async (context) => {
        const list = jobs.forChat(context.sessionKey) ?? [];
        const job = list.length > 1 ? await pickJob(host, s, list) : list[0];
        if (job) await runJob(host, s, jobs, job);
      },
    });

    host.ui.registerPanel({
      id: PANEL_ID,
      label: s.runs,
      icon: "calendarClock",
      available: (session) => Boolean(automationChatJobId(session.sessionKey)) && Boolean(host.connection?.canRead ?? true),
      mount: (container, view) => mountRunsPanel(host, s, jobs, container, view.props),
    });

    // Runs opens by itself the first time this page shows an automation chat; closing it is respected until reload.
    const opened = new Set();
    const openOnce = () => {
      const key = host.sessions.selectedKey;
      if (!automationChatJobId(key) || opened.has(key)) return;
      opened.add(key);
      queueMicrotask(() => host.ui.openPanel(PANEL_ID, { sessionKey: key }));
    };
    host.subscribe?.(openOnce);
    openOnce();
  },
};
