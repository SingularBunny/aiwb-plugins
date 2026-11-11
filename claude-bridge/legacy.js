// Until November 2026 this plugin was called aiwb-projects. Its state files in <OpenClaw state>/workbench/
// carried that prefix; they move to the new name the first time the plugin or the memory sync runs.
import { existsSync, linkSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";

export const PLUGIN_ID = "aiwb-claude-bridge";
export const LEGACY_ID = "aiwb-projects";

/** State file `<dir>/aiwb-claude-bridge-<name>`, and where the old plugin kept it. */
export const stateFile = (dir, name) => path.join(dir, `${PLUGIN_ID}-${name}`);
export const legacyStateFile = (dir, name) => path.join(dir, `${LEGACY_ID}-${name}`);

/**
 * Moves the old state file to the new name if the new one does not exist yet. Never overwrites: the
 * hard link fails if the new file appeared meanwhile (another plugin instance, a write), and then the
 * old file is left as it is. Returns true if the file was moved.
 */
export function migrateStateFile(dir, name) {
  const from = legacyStateFile(dir, name), to = stateFile(dir, name);
  if (existsSync(to) || !existsSync(from)) return false;
  try {
    linkSync(from, to);
  } catch (e) {
    if (e?.code === "EEXIST" || e?.code === "ENOENT") return false;
    // No hard links on this file system: a plain rename, still only while the new file is absent.
    try { if (existsSync(to)) return false; renameSync(from, to); return true; } catch { return false; }
  }
  try { unlinkSync(from); } catch { /* already removed by another instance */ }
  return true;
}
