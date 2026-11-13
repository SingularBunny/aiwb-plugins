// Text copies of the PDF and Office files in knowledge base folders, for OpenClaw's memory search, which indexes
// Markdown only. Each source folder is mirrored into its own folder under a scope root (one root for every agent,
// one per project agent), so memory.search.extraPaths names only the root and does not change when folders do.
//
//   <root>/<folder name>-<hash of its path>/<relative path>.<ext>.md
//
// A copy starts with the original's path; agents read and cite the original. Only files whose size or mtime
// changed are extracted again; copies of files that are gone are removed. Hidden folders (.obsidian, .trash,
// .git) and symbolic links are skipped, as memory search skips them.
//
// Scans: PDF pages without a text layer and images are recognized with OCR when OCRmyPDF and Tesseract are installed,
// by OCRmyPDF's own rule (--skip-text: a page with any text is not recognized again). Without them a PDF copy keeps
// the text pages and is redone once OCR appears; images get no copy.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TEXT_EXTENSIONS = [".pdf", ".docx", ".doc", ".odt", ".rtf", ".xlsx", ".xls", ".ods", ".pptx", ".ppt", ".odp"];
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".tif", ".tiff"];
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const STATE = ".knowledge-text.json";
const NO_OCR = ":no-ocr";

/** The mirror folder of one source folder inside a scope root: readable name plus a hash of the full path. */
export function mirrorDir(root, source) {
  const name = path.basename(source).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 40) || "folder";
  return path.join(root, `${name}-${createHash("sha256").update(source).digest("hex").slice(0, 8)}`);
}

/** Files to copy under dir: relative paths of files with these extensions, hidden folders and symbolic links skipped. */
export function listSources(dir, extensions = TEXT_EXTENSIONS) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const child = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && extensions.includes(path.extname(e.name).toLowerCase()) && !e.name.startsWith("~$")) out.push(child);
    }
  };
  walk("");
  return out.sort();
}

/** The Markdown copy: a heading, where the original is, then the text (capped). */
export function copyText(source, text, now = new Date()) {
  const body = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n…[the rest of the text is cut]` : text;
  return [`# ${path.basename(source)}`, "",
    `Text copy of \`${source}\`, made ${now.toISOString().slice(0, 16).replace("T", " ")} for memory search. ` +
    "Read and cite the original file; this copy is replaced when the original changes and is not for editing.", "",
    body.trim(), ""].join("\n");
}

/** pdftotext pages (form-feed separated): does a page have any text, as OCRmyPDF's --skip-text decides. */
export const pageHasText = (page) => /[\p{L}\p{N}]/u.test(page);

/** The pdftotext pages, with each page that has no text taken from the OCR sidecar (also form-feed separated). */
export function mergeOcrPages(pdfText, sidecar) {
  const ocr = String(sidecar ?? "").split("\f");
  return String(pdfText ?? "").split("\f").map((page, i) => (pageHasText(page) ? page : (ocr[i] ?? page))).join("\f");
}

function readState(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Bring the copies of one scope up to date. scopes: [{ root, sources: [folders] }]; extract(file, ext, signal) →
 * text or { text, ocrPending } (pages left for OCR, which is not installed), or throws. ocr: OCR is installed now, so
 * copies made without it are redone. Returns counts and the failures ({ file, error }). Mirror folders of sources no
 * longer listed are removed from the root.
 */
export async function syncKnowledgeText({ scopes, extract, extensions = TEXT_EXTENSIONS, ocr = false, now = () => new Date(), signal, log = () => {} }) {
  const totals = { updated: 0, unchanged: 0, removed: 0, skipped: 0, failed: [] };
  for (const { root, sources } of scopes) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const wanted = new Set();
    for (const source of sources) {
      const dest = mirrorDir(root, source);
      wanted.add(path.basename(dest));
      const stateFile = path.join(dest, STATE);
      const state = readState(stateFile);
      const next = {};
      for (const rel of listSources(source, extensions)) {
        signal?.throwIfAborted();
        const file = path.join(source, rel);
        const copy = path.join(dest, `${rel}.md`);
        let st;
        try { st = statSync(file); } catch { continue; }
        const key = `${st.size}:${Math.trunc(st.mtimeMs)}`;
        if (st.size > MAX_SOURCE_BYTES) { totals.skipped += 1; continue; }
        const done = state[rel] === key || (!ocr && state[rel] === `${key}${NO_OCR}`);
        if (done && lstatSafe(copy)) { next[rel] = state[rel]; totals.unchanged += 1; continue; }
        try {
          const result = await extract(file, path.extname(rel).toLowerCase(), signal);
          const text = typeof result === "object" && result !== null ? result.text : result;
          writeAtomic(copy, copyText(file, String(text ?? ""), now()));
          next[rel] = result?.ocrPending ? `${key}${NO_OCR}` : key;
          totals.updated += 1;
          log(`copied ${file}`);
        } catch (error) {
          // Keep the previous copy, if any: a failed extraction is retried on the next run.
          if (state[rel]) next[rel] = "retry";
          totals.failed.push({ file, error: String(error?.message || error).slice(0, 300) });
        }
      }
      // Copies whose original is gone.
      for (const rel of Object.keys(state)) {
        if (rel in next) continue;
        rmSync(path.join(dest, `${rel}.md`), { force: true });
        totals.removed += 1;
      }
      writeAtomic(stateFile, `${JSON.stringify(next, null, 1)}\n`);
    }
    for (const e of readdirSafe(root)) {
      if (e.isDirectory() && !wanted.has(e.name)) {
        rmSync(path.join(root, e.name), { recursive: true, force: true });
        totals.removed += 1;
      }
    }
  }
  return totals;
}

const lstatSafe = (p) => { try { return lstatSync(p); } catch { return null; } };
const readdirSafe = (d) => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } };
