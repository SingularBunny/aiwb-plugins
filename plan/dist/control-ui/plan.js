// Plan mode button in the Control UI composer (native plugin view, hand-written, no build step). The same switch as
// `/plan` and `/plan off`, read and flipped through this plugin's Gateway methods (aiwb-plan.status, aiwb-plan.set),
// for any model. The label shows the state; it is re-read after every finished turn, since a typed `/plan` or an
// approved plan changes it.

const METHODS = { status: "aiwb-plan.status", set: "aiwb-plan.set" };

const STRINGS = {
  en: { on: "Plan: on", off: "Plan: off" },
  ru: { on: "План: вкл", off: "План: выкл" },
};

/** Plan state per chat: undefined until read, then {on}; `pending` while a read or switch is in flight. */
export function createPlanState(request, invalidate) {
  const states = new Map();
  const pending = new Set();
  const keyOf = (target) => JSON.stringify([target.sessionKey, target.agentId ?? null]);
  async function read(target) {
    const key = keyOf(target);
    if (pending.has(key)) return;
    pending.add(key);
    try {
      const result = await request(METHODS.status, target);
      states.set(key, { on: result?.on === true });
    } catch {
      // Keep the last known state; the next finished turn reads again.
    } finally {
      pending.delete(key);
      invalidate();
    }
  }
  async function toggle(target) {
    const key = keyOf(target);
    if (pending.has(key)) return;
    pending.add(key);
    invalidate();
    try {
      const result = await request(METHODS.set, { ...target, on: !(states.get(key)?.on === true) });
      states.set(key, { on: result?.on === true });
    } finally {
      pending.delete(key);
      invalidate();
    }
  }
  return {
    get: (target) => states.get(keyOf(target)),
    busy: (target) => pending.has(keyOf(target)),
    read,
    toggle,
    forget: (sessionKey) => {
      for (const key of [...states.keys()]) if (JSON.parse(key)[0] === sessionKey) states.delete(key);
    },
  };
}

const targetOf = (context) => ({
  sessionKey: context.sessionKey,
  ...(context.agentId ? { agentId: context.agentId } : {}),
});

export default {
  id: "aiwb-plan",
  activate(host) {
    const s = String(host.locale || "").toLowerCase().startsWith("ru") ? STRINGS.ru : STRINGS.en;
    const plan = createPlanState(host.request, () => host.ui.invalidate());
    // A finished turn may have switched plan mode (`/plan`, an approved plan): read that chat again.
    host.onEvent?.("chat", (payload) => {
      const state = payload?.state;
      if (payload?.sessionKey && (state === "final" || state === "error" || state === "aborted")) {
        plan.forget(payload.sessionKey);
        host.ui.invalidate();
      }
    });
    host.ui.registerAction({
      id: "plan-mode",
      label: s.off,
      placement: "composer",
      resolve: (context) => {
        if (!context.sessionKey) return { hidden: true };
        const target = targetOf(context);
        const state = plan.get(target);
        if (!state && !plan.busy(target)) void plan.read(target);
        const canWrite = Boolean(host.connection?.connected && host.connection?.canWrite);
        return { label: state?.on ? s.on : s.off, disabled: !state || !canWrite || plan.busy(target) };
      },
      run: (context) => plan.toggle(targetOf(context)),
    });
  },
};
