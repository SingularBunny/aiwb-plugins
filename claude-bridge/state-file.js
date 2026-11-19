// State files of the bridge (adoption, moves, pending shares, order, running marks, memory sync).
// Several plugin instances of one Gateway read and write them, so a write goes to a temporary file
// next to the target and is renamed over it: a crash or a concurrent reader never sees half a file.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

let counter = 0;

/** Parsed JSON, or `fallback` when the file is missing or unreadable. */
export function readJson(file, fallback = {}) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Writes `text` to `file` atomically (same directory, then rename). */
export function writeFileAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++counter}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Pretty JSON with a trailing newline, written atomically; `compact` for hot files. */
export function writeJson(file, value, { compact = false } = {}) {
  writeFileAtomic(file, compact ? JSON.stringify(value) : JSON.stringify(value, null, 2) + "\n");
}
