// Chat tools for the OpenClaw Control UI (native plugin view, hand-written, no build step). Items in a chat's menu
// (placement "session": the chat ⋯ menu and the session menu in the sidebar), for any model:
// - Forget a topic…: the Gateway ranks the chat's turns and the agent's memory paragraphs against a topic with the
//   embedding model memory search is configured with (chat.forget.find, OpenClaw fork); the user ticks what to forget and chat.forget.apply
//   leaves those turns out of every model context and removes the ticked memory paragraphs.
// - New chat, Learn a skill from this chat (/learn), Reset chat… (/reset, after a confirm).

const PLUGIN_ID = "aiwb-chat-tools";

const STRINGS = {
  en: {
    forgetMenu: "Forget a topic…",
    forgetTitle: "Forget a topic",
    topicLabel: "What should the chat forget? It is found with the embedding model memory search uses; no chat model sees this.",
    find: "Find",
    finding: "Searching…",
    nothingFound: "Nothing in this chat to forget.",
    pickTitle: (topic) => `Forget “${topic}”`,
    pickHint: "Ticked chat turns stay visible here, but no model will see them again; ticked memory paragraphs are removed from their files. Similarity is not proof: check the list.",
    mentions: "mentions it",
    inChat: "In this chat",
    inMemory: "In memory files",
    inGit: "In commit messages of the chat's repositories",
    gitFailed: (error) => `Commit messages were not searched: ${error}`,
    rewriteWith: "Rewrite commit and pull request texts with",
    rewritePlaceholder: "no model: replace with [removed]",
    rewriteHint: "Only models running on this computer are offered: the topic does not leave it. A paragraph the model cannot clean becomes [removed].",
    gitHint: "Ticked commit messages are rewritten without the topic (git filter-repo; a bundle of each repository is kept in ~/.openclaw/forget-backups). Commit hashes change from the first rewritten commit on.",
    pushed: "pushed",
    pushTitle: "Force-push the rewritten branches?",
    pushMessage: "These branches hold the old messages on their servers. A force-push replaces them; anyone with a copy must re-clone or rebase, forks and old clones keep the old text, and GitHub/GitLab may still show it in pull request views. Each push only goes through if the server branch has not moved since.",
    pushConfirm: "Force-push",
    pushLater: "Not now",
    pushFailed: "Not pushed:",
    summaryNote: "Some of these were summarized earlier: that summary is dropped too, and the model loses the rest of what it summarized.",
    apply: (count) => `Forget ${count}`,
    done: (count) => `Forgotten: ${count}.`,
    cancel: "Cancel",
    newChat: "New chat",
    learn: "Learn a skill from this chat",
    reset: "Reset chat…",
    resetTitle: "Reset this chat?",
    resetMessage: "The agent starts a fresh session in this chat and no longer sees the earlier conversation. This is the same as /reset.",
    resetConfirm: "Reset chat",
  },
  ru: {
    forgetMenu: "Забыть тему…",
    forgetTitle: "Забыть тему",
    topicLabel: "Что чат должен забыть? Поиск идёт моделью эмбеддингов поиска по памяти, чат-модель этого не видит.",
    find: "Найти",
    finding: "Ищу…",
    nothingFound: "В этом чате нечего забывать.",
    pickTitle: (topic) => `Забыть «${topic}»`,
    pickHint: "Отмеченные ходы останутся видны в чате, но ни одна модель их больше не увидит; отмеченные абзацы памяти удаляются из файлов. Проверьте список: близость по смыслу не гарантирует точности.",
    mentions: "упоминает",
    inChat: "В этом чате",
    inMemory: "В файлах памяти",
    inGit: "В сообщениях коммитов репозиториев чата",
    gitFailed: (error) => `Сообщения коммитов не просмотрены: ${error}`,
    rewriteWith: "Переписать тексты коммитов и pull request моделью",
    rewritePlaceholder: "без модели: заменить на [removed]",
    rewriteHint: "Предлагаются только модели, работающие на этом компьютере: тема его не покидает. Абзац, который модель не смогла очистить, становится [removed].",
    gitHint: "Отмеченные сообщения коммитов переписываются без темы (git filter-repo; копия каждого репозитория — bundle в ~/.openclaw/forget-backups). Хеши меняются начиная с первого переписанного коммита.",
    pushed: "отправлен",
    pushTitle: "Отправить переписанные ветки с force-push?",
    pushMessage: "На серверах этих веток лежат старые сообщения. Force-push их заменит; у кого есть копия, должны заново клонировать или сделать rebase, форки и старые клоны сохранят прежний текст, а GitHub/GitLab могут ещё показывать его в pull request. Каждый push пройдёт, только если ветка на сервере с тех пор не сдвинулась.",
    pushConfirm: "Force-push",
    pushLater: "Не сейчас",
    pushFailed: "Не отправлено:",
    summaryNote: "Часть этого уже вошла в сводку: сводка тоже будет выброшена, и модель потеряет всё остальное, что в ней было.",
    apply: (count) => `Забыть (${count})`,
    done: (count) => `Забыто: ${count}.`,
    cancel: "Отмена",
    newChat: "Новый чат",
    learn: "Сохранить навык из этого чата",
    reset: "Сбросить чат…",
    resetTitle: "Сбросить этот чат?",
    resetMessage: "Агент начнёт в этом чате новую сессию и больше не увидит прежний разговор. Это то же самое, что /reset.",
    resetConfirm: "Сбросить чат",
  },
};

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

/** One dialog at a time, in a container of its own under <body>; resolves what `finish` is called with. */
function openDialog(host, label, build) {
  return new Promise((resolve) => {
    const container = el("div", { class: "aiwb-chat-tools__host" });
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
    const content = el("div", { class: "aiwb-chat-tools" });
    build(content, finish);
    handle = host.components.mountDialog(container, {
      label,
      className: "aiwb-chat-tools__dialog",
      // The host dialog is 540px wide by default; the lists of Forget a topic need more room.
      style: "--openclaw-modal-width: 680px",
      content,
      onCancel: () => {
        finish(null);
        return true;
      },
    });
    content.querySelector("input, button.primary, button.danger")?.focus?.();
  });
}

function confirmDialog(host, s, title, message, confirmLabel) {
  return openDialog(host, title, (content, finish) => {
    content.append(
      el("p", { class: "aiwb-chat-tools__hint" }, message),
      el("div", { class: "aiwb-chat-tools__actions" },
        el("button", { type: "button", class: "btn", onclick: () => finish(false) }, s.cancel),
        el("button", { type: "button", class: "btn danger", onclick: () => finish(true) }, confirmLabel)),
    );
  });
}

/** Step 1: the topic; the search runs from the dialog, so "nothing found" is shown in place. */
function askTopic(host, s, find) {
  return openDialog(host, s.forgetTitle, (content, finish) => {
    const input = el("input", { type: "text", class: "aiwb-chat-tools__input", "aria-label": s.topicLabel });
    const status = el("p", { class: "aiwb-chat-tools__status", role: "status" });
    const submit = el("button", { type: "submit", class: "btn primary" }, s.find);
    const form = el("form", {
      onsubmit: async (event) => {
        event.preventDefault();
        const topic = input.value.trim();
        if (!topic) return;
        submit.disabled = true;
        status.textContent = s.finding;
        try {
          const result = await find(topic);
          if (result) finish({ topic, ...result });
          else status.textContent = s.nothingFound;
        } catch (error) {
          status.textContent = String(error?.message || error);
        } finally {
          submit.disabled = false;
        }
      },
    },
    el("label", { class: "aiwb-chat-tools__label" }, s.topicLabel, input),
    status,
    el("div", { class: "aiwb-chat-tools__actions" },
      el("button", { type: "button", class: "btn", onclick: () => finish(null) }, s.cancel), submit));
    content.append(form);
  });
}

function row(item, detail, ticked, onChange, s) {
  const box = el("input", { type: "checkbox", "data-forget-item": item.id });
  box.checked = ticked.has(item.id);
  box.addEventListener("change", () => onChange(item.id, box.checked));
  return el("li", {},
    el("label", { class: "aiwb-chat-tools__item" },
      box,
      el("span", { class: "aiwb-chat-tools__preview" }, item.preview,
        detail ? el("span", { class: "aiwb-chat-tools__file" }, detail) : null),
      el("span", { class: "aiwb-chat-tools__score" },
        `${Math.round((item.score || 0) * 100)}%${item.literal ? ` · ${s.mentions}` : ""}`)));
}

/** Step 2: tick what to forget; resolves {entryIds, memory} or null. */
function pickItems(host, s, topic, candidates, memory, commits = [], reviews = [], gitError = "", rewriteModels = []) {
  return openDialog(host, s.pickTitle(topic), (content, finish) => {
    const ticked = new Set([...candidates, ...memory, ...commits, ...reviews].filter((item) => item.selected).map((item) => item.id));
    const repostBox = el("input", { type: "checkbox" });
    // A local model rewrites the paragraphs that name the topic; the first one is the default.
    const rewriteSelect = el("select", { class: "aiwb-chat-tools__select", "data-forget-rewrite": "" },
      ...rewriteModels.map((model) => el("option", { value: model }, model)),
      el("option", { value: "" }, s.rewritePlaceholder));
    const apply = el("button", { type: "submit", class: "btn danger" });
    const note = el("p", { class: "aiwb-chat-tools__note", hidden: true }, s.summaryNote);
    const refresh = () => {
      apply.textContent = s.apply(ticked.size);
      apply.disabled = ticked.size === 0;
      note.hidden = !candidates.some((item) => item.beforeSummary && ticked.has(item.id));
    };
    const toggle = (id, on) => {
      if (on) ticked.add(id);
      else ticked.delete(id);
      refresh();
    };
    const lists = [];
    if (candidates.length) {
      lists.push(el("div", { class: "aiwb-chat-tools__heading" }, s.inChat),
        el("ul", { class: "aiwb-chat-tools__list" }, candidates.map((item) => row(item, null, ticked, toggle, s))));
    }
    if (memory.length) {
      lists.push(el("div", { class: "aiwb-chat-tools__heading" }, s.inMemory),
        el("ul", { class: "aiwb-chat-tools__list" },
          memory.map((item) => row(item, item.file.split("/").slice(-2).join("/"), ticked, toggle, s))));
    }
    if (gitError) {
      lists.push(el("div", { class: "aiwb-chat-tools__heading" }, s.inGit),
        el("p", { class: "aiwb-chat-tools__note" }, s.gitFailed(gitError)));
    }
    if (commits.length) {
      lists.push(el("div", { class: "aiwb-chat-tools__heading" }, s.inGit),
        el("p", { class: "aiwb-chat-tools__hint" }, s.gitHint),
        el("ul", { class: "aiwb-chat-tools__list" },
          commits.map((item) => row(item,
            `${item.repo.split("/").pop()} · ${item.hash.slice(0, 8)}${item.pushed ? ` · ${s.pushed}` : ""}`,
            ticked, toggle, s))));
    }
    if (reviews.length) {
      lists.push(el("div", { class: "aiwb-chat-tools__heading" }, s.inReviews),
        el("p", { class: "aiwb-chat-tools__hint" }, s.reviewHint),
        el("ul", { class: "aiwb-chat-tools__list" },
          reviews.map((item) => row(item, `${item.repo}#${item.number} · ${s.kinds[item.kind] ?? item.kind} · @${item.author}`,
            ticked, toggle, s))),
        el("label", { class: "aiwb-chat-tools__item" }, repostBox, el("span", {}, s.repostOthers)));
    }
    if (commits.length || reviews.length) {
      lists.push(el("label", { class: "aiwb-chat-tools__label" }, s.rewriteWith, rewriteSelect),
        el("p", { class: "aiwb-chat-tools__hint" }, s.rewriteHint));
    }
    content.append(el("form", {
      onsubmit: (event) => {
        event.preventDefault();
        if (ticked.size === 0) return;
        finish({
          entryIds: candidates.filter((item) => ticked.has(item.id)).flatMap((item) => item.entryIds),
          memory: memory.filter((item) => ticked.has(item.id)).map(({ file, hash }) => ({ file, hash })),
          commits: commits.filter((item) => ticked.has(item.id)).map(({ repo, hash }) => ({ repo, hash })),
          reviews: reviews.filter((item) => ticked.has(item.id)).map(({ repo, number, kind, ghId }) => ({ repo, number, kind, id: ghId })),
          repostOthers: repostBox.checked,
          rewriteModel: rewriteSelect.value || undefined,
        });
      },
    },
    el("p", { class: "aiwb-chat-tools__hint" }, s.pickHint),
    ...lists,
    note,
    el("div", { class: "aiwb-chat-tools__actions" },
      el("button", { type: "button", class: "btn", onclick: () => finish(null) }, s.cancel), apply)));
    refresh();
  });
}

/**
 * What the pick dialog lists from a chat.forget.find answer; null when there is nothing to show.
 * Commits and pull requests only for an admin connection; a failed commit search is shown as such.
 */
export function forgetFindView(result, gitAllowed) {
  const candidates = result?.candidates ?? [];
  const memory = result?.memory ?? [];
  const commits = gitAllowed
    ? (result?.git?.commits ?? []).map((commit) => ({ ...commit, id: `git:${commit.repo}:${commit.hash}`, preview: commit.subject }))
    : [];
  const reviews = gitAllowed
    ? (result?.git?.reviews ?? []).map((item) => ({ ...item, id: `pr:${item.repo}:${item.kind}:${item.id}`, ghId: item.id }))
    : [];
  const gitError = gitAllowed ? result?.git?.error ?? "" : "";
  const rewriteModels = gitAllowed ? result?.rewriteModels ?? [] : [];
  return candidates.length + memory.length + commits.length + reviews.length > 0 || gitError
    ? { candidates, memory, commits, reviews, gitError, rewriteModels }
    : null;
}

async function forgetTopic(host, s, target) {
  // Rewriting and force-pushing repositories is an admin action (chat.forget.git.*, OpenClaw fork).
  const gitAllowed = Boolean(host.connection?.connected && host.connection?.canAdmin);
  const found = await askTopic(host, s, async (topic) => {
    const result = await host.request("chat.forget.find", { ...target, topic });
    return forgetFindView(result, gitAllowed);
  });
  if (!found) return;
  const picks = await pickItems(host, s, found.topic, found.candidates, found.memory, found.commits, found.reviews, found.gitError, found.rewriteModels);
  if (!picks) return;
  if (picks.entryIds.length + picks.memory.length > 0) {
    const applied = await host.request("chat.forget.apply", { ...target, topic: found.topic, entryIds: picks.entryIds, memory: picks.memory });
    const done = applied?.forgotten?.length ?? picks.entryIds.length;
    if (done < picks.entryIds.length) {
      await openDialog(host, s.forgetTitle, (content, finish) => {
        content.append(
          el("p", { class: "aiwb-chat-tools__note" }, s.partial(done, picks.entryIds.length)),
          el("div", { class: "aiwb-chat-tools__actions" },
            el("button", { type: "button", class: "btn primary", onclick: () => finish(true) }, "OK")),
        );
      });
    }
  }
  if (picks.reviews.length) {
    const cleaned = await host.request("chat.forget.review.apply", {
      ...target, topic: found.topic, items: picks.reviews, repostOthers: picks.repostOthers,
      ...(picks.rewriteModel ? { rewriteModel: picks.rewriteModel } : {}),
    });
    const failed = cleaned?.failed ?? [];
    if (failed.length) {
      await openDialog(host, s.forgetTitle, (content, finish) => {
        content.append(
          el("p", { class: "aiwb-chat-tools__hint" }, s.reviewFailed),
          el("ul", { class: "aiwb-chat-tools__list" },
            failed.map((item) => el("li", {}, `${item.repo}#${item.number}: ${item.error}`))),
          el("div", { class: "aiwb-chat-tools__actions" },
            el("button", { type: "button", class: "btn primary", onclick: () => finish(true) }, "OK")),
        );
      });
    }
  }
  if (!picks.commits.length) return;
  const rewritten = await host.request("chat.forget.git.apply", {
    ...target, topic: found.topic, commits: picks.commits,
    ...(picks.rewriteModel ? { rewriteModel: picks.rewriteModel } : {}),
  });
  const pushes = (rewritten?.repositories ?? []).flatMap((repository) => repository.push ?? []);
  if (!pushes.length) return;
  const list = pushes.map((plan) => `${plan.repo.split("/").pop()}: ${plan.branch} → ${plan.remote}/${plan.remoteBranch}`);
  const confirmed = await openDialog(host, s.pushTitle, (content, finish) => {
    content.append(
      el("p", { class: "aiwb-chat-tools__hint" }, s.pushMessage),
      el("ul", { class: "aiwb-chat-tools__list" }, list.map((line) => el("li", {}, line))),
      el("div", { class: "aiwb-chat-tools__actions" },
        el("button", { type: "button", class: "btn", onclick: () => finish(false) }, s.pushLater),
        el("button", { type: "button", class: "btn danger", onclick: () => finish(true) }, s.pushConfirm)),
    );
  });
  if (!confirmed) return;
  const pushed = await host.request("chat.forget.git.push", {
    ...target,
    pushes: pushes.map(({ repo, branch, remote, remoteBranch, expected }) => ({ repo, branch, remote, remoteBranch, expected })),
  });
  const failed = pushed?.failed ?? [];
  if (failed.length) {
    await openDialog(host, s.pushTitle, (content, finish) => {
      content.append(
        el("p", { class: "aiwb-chat-tools__hint" }, s.pushFailed),
        el("ul", { class: "aiwb-chat-tools__list" },
          failed.map((item) => el("li", {}, `${item.repo.split("/").pop()}: ${item.branch} — ${item.error}`))),
        el("div", { class: "aiwb-chat-tools__actions" },
          el("button", { type: "button", class: "btn primary", onclick: () => finish(true) }, "OK")),
      );
    });
  }
}

function sendCommand(host, target, message) {
  return host.request("chat.send", {
    sessionKey: target.sessionKey,
    ...(target.agentId ? { agentId: target.agentId } : {}),
    message,
    idempotencyKey: `${PLUGIN_ID}:${crypto.randomUUID()}`,
  });
}

const targetOf = (context) => ({
  sessionKey: context.sessionKey,
  ...(context.agentId ? { agentId: context.agentId } : {}),
});

export default {
  id: PLUGIN_ID,
  activate(host) {
    const s = String(host.locale || "").toLowerCase().startsWith("ru") ? STRINGS.ru : STRINGS.en;
    // As typed in the composer: /learn and the forget methods need operator.write, /reset operator.admin.
    const allowed = (need) => Boolean(host.connection?.connected && host.connection?.[need]);
    const resolve = (label, need = "canWrite") => () => (allowed(need) ? { label } : { label, disabled: true });
    host.ui.registerAction({
      id: "new-chat",
      label: s.newChat,
      placement: "session",
      resolve: resolve(s.newChat),
      run: async ({ agentId }) => {
        const key = await host.sessions.create(agentId ? { agentId } : {});
        if (key) host.sessions.open({ sessionKey: key, ...(agentId ? { agentId } : {}) });
      },
    });
    host.ui.registerAction({
      id: "learn",
      label: s.learn,
      placement: "session",
      resolve: resolve(s.learn),
      run: (context) => sendCommand(host, targetOf(context), "/learn"),
    });
    host.ui.registerAction({
      id: "forget-topic",
      label: s.forgetMenu,
      placement: "session",
      resolve: resolve(s.forgetMenu),
      run: (context) => forgetTopic(host, s, targetOf(context)),
    });
    host.ui.registerAction({
      id: "reset",
      label: s.reset,
      placement: "session",
      resolve: resolve(s.reset, "canAdmin"),
      run: async (context) => {
        const target = targetOf(context);
        if (await confirmDialog(host, s, s.resetTitle, s.resetMessage, s.resetConfirm)) {
          await sendCommand(host, target, "/reset");
        }
      },
    });
  },
};
