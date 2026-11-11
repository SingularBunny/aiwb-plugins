// Order of folders and chats in the "Projects" tree. The user's drag-and-drop order (persisted by
// the plugin) comes first, then the configured folder order (config.order), then the rest: folders
// alphabetically, chats newest first. In a folder the user has arranged, chats active since then go on
// top, the arranged ones follow, and older chats the user never placed come last.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** Persisted order: { folders: string[], rows: { [folder]: threadId[] }, placedAt: { [folder]: ms } }. */
export function readOrder(file) {
  try {
    const o = JSON.parse(readFileSync(file, "utf8"));
    return { folders: Array.isArray(o.folders) ? o.folders : [], rows: asObject(o.rows), placedAt: asObject(o.placedAt) };
  } catch { return { folders: [], rows: {}, placedAt: {} }; }
}

const timeOf = (r) => {
  const v = r.recencyAt ?? r.updatedAt;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

export function writeOrder(file, order) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(order, null, 2) + "\n");
}

/** Comparator of folder names: persisted order, then configured order, then alphabetical. */
export function folderComparator(persisted, configured) {
  const rank = (f) => {
    const p = persisted.indexOf(f);
    if (p >= 0) return p;
    const c = configured.indexOf(f);
    return persisted.length + (c >= 0 ? c : configured.length);
  };
  const last = persisted.length + configured.length;
  return (x, y) => rank(x) - rank(y) || (rank(x) === last ? String(x).localeCompare(String(y), "ru") : 0);
}

/** Rows sorted for the tree: by folder, then new chats, the user's order, older unplaced chats. */
export function sortRows(rows, order, configured) {
  const byFolder = folderComparator(order.folders, configured);
  const placedAt = order.placedAt || {};
  // Band 0: active since the folder was arranged (or folder never arranged); 1: placed; 2: older unplaced.
  const band = (r) => {
    const placed = order.rows[r.customGroup];
    if (!placed) return 0;
    if (placed.includes(r.threadId)) return 1;
    return timeOf(r) > (placedAt[r.customGroup] || 0) ? 0 : 2;
  };
  return [...rows].sort((a, b) => {
    const f = byFolder(a.customGroup, b.customGroup);
    if (f) return f;
    const ba = band(a), bb = band(b);
    if (ba !== bb) return ba - bb;
    if (ba === 1) {
      const placed = order.rows[a.customGroup];
      return placed.indexOf(a.threadId) - placed.indexOf(b.threadId);
    }
    return timeOf(b) - timeOf(a);
  });
}

/** Applies a reorder request (sessions.catalog.reorder target) to the persisted order. */
export function applyReorder(order, target, now = Date.now()) {
  if (target?.kind === "groups") return { ...order, folders: [...target.order] };
  if (target?.kind === "sessions") {
    // The UI sends the rows it has loaded; threads it did not send keep their place after them.
    const kept = (order.rows[target.group] || []).filter((t) => !target.threadIds.includes(t));
    return {
      ...order,
      rows: { ...order.rows, [target.group]: [...target.threadIds, ...kept] },
      placedAt: { ...order.placedAt, [target.group]: now },
    };
  }
  throw new Error(`unknown reorder target: ${target?.kind}`);
}
