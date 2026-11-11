// Plugin environment: where LibreOffice is and how to keep the PDF and text cache within its limit.
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const CANDIDATES = ["/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice", "C:\\Program Files\\LibreOffice\\program\\soffice.exe"];

/** Path to soffice: from the setting, from PATH or from the usual install locations; null if none. */
export function findSoffice(configured, envPath = process.env.PATH ?? "") {
  if (configured) return existsSync(configured) ? configured : null;
  const names = process.platform === "win32" ? ["soffice.exe", "soffice.com"] : ["soffice", "libreoffice"];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const name of names) if (existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** When the cache (PDFs and extracted text) exceeds the limit, the oldest files by modification time are removed. */
export async function pruneCache(cacheDir, maxBytes) {
  const files = [];
  for (const name of await readdir(cacheDir)) {
    if (!name.endsWith(".pdf") && !name.endsWith(".txt")) continue;
    const s = await stat(path.join(cacheDir, name)).catch(() => null);
    if (s?.isFile()) files.push({ name, size: s.size, mtime: s.mtimeMs });
  }
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    await rm(path.join(cacheDir, f.name), { force: true });
    total -= f.size;
  }
}
