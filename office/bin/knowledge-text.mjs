#!/usr/bin/env node
// Text copies of knowledge base PDF and Office files (office/knowledge-text.js), run by the ai-workbench installer's
// timer. PDF: pdftotext (poppler); Office: local LibreOffice through the aiwb-office extractor; scans: OCRmyPDF for
// PDF pages without text and Tesseract for images, in the installed Tesseract languages (osd and equ aside) or
// --ocr-langs. A missing tool skips its formats with one line, the rest still runs.
//
//   knowledge-text.mjs --scope <root>=<folder>[:<folder>…] [--scope …] [--soffice <path>] [--ocr-langs eng+deu]
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createConverter } from "../convert.js";
import { createOfficeTextExtractor, OFFICE_MIME_TYPES } from "../extract.js";
import { findSoffice } from "../host.js";
import { IMAGE_EXTENSIONS, mergeOcrPages, pageHasText, syncKnowledgeText, TEXT_EXTENSIONS } from "../knowledge-text.js";

const args = process.argv.slice(2);
const scopes = [];
let sofficeSetting;
let ocrLangsSetting;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--scope") {
    const [root, list] = String(args[++i] ?? "").split(/=(.*)/s);
    if (!root || !list || !path.isAbsolute(root)) { console.error(`bad --scope ${args[i]}: <root>=<folder>[:<folder>…]`); process.exit(2); }
    scopes.push({ root, sources: list.split(":").filter(Boolean) });
  } else if (args[i] === "--soffice") sofficeSetting = args[++i];
  else if (args[i] === "--ocr-langs") ocrLangsSetting = args[++i];
  else { console.error(`unknown argument ${args[i]}`); process.exit(2); }
}
if (!scopes.length) { console.error("nothing to do: no --scope"); process.exit(2); }

const run = (file, argv, opts = {}) => new Promise((resolve, reject) =>
  execFile(file, argv, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000, ...opts }, (error, stdout) => (error ? reject(error) : resolve(stdout))));

const extByMime = {};
for (const [mime, [, ext]] of Object.entries(OFFICE_MIME_TYPES)) if (ext && !extByMime[ext]) extByMime[ext] = mime;

const soffice = findSoffice(sofficeSetting);
const work = mkdtempSync(path.join(os.tmpdir(), "aiwb-knowledge-text-"));
const office = soffice ? createOfficeTextExtractor({ converter: createConverter({ soffice, cacheDir: work }) }) : null;
let pdftotext = true;
const missing = new Set();

// OCR: both tools, and at least one recognition language.
const OCR_TIMEOUT_MS = 10 * 60_000;
async function ocrLanguages() {
  try {
    await run("ocrmypdf", ["--version"]);
    const listed = String(await run("tesseract", ["--list-langs"])).split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
    const langs = ocrLangsSetting ? ocrLangsSetting.split("+").filter((l) => listed.includes(l)) : listed.filter((l) => !["osd", "equ"].includes(l));
    return langs.length ? langs.join("+") : null;
  } catch {
    return null;
  }
}
const ocrLangs = await ocrLanguages();

async function pdfText(file, signal) {
  const text = await run("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { signal });
  if (String(text).split("\f").slice(0, -1).every(pageHasText)) return text;
  if (!ocrLangs) { missing.add("OCRmyPDF and Tesseract (scanned PDF pages, images)"); return { text, ocrPending: true }; }
  const sidecar = path.join(work, "sidecar.txt");
  await run("ocrmypdf", ["--skip-text", "--output-type", "none", "--sidecar", sidecar, "-l", ocrLangs, "--quiet", file, "-"],
    { signal, timeout: OCR_TIMEOUT_MS });
  try { return mergeOcrPages(text, readFileSync(sidecar, "utf8")); } finally { rmSync(sidecar, { force: true }); }
}

async function extract(file, ext, signal) {
  if (ext === ".pdf") {
    if (!pdftotext) { missing.add("pdftotext"); throw new Error("pdftotext (poppler) is not installed"); }
    try {
      return await pdfText(file, signal);
    } catch (error) {
      if (error?.code === "ENOENT") { pdftotext = false; missing.add("pdftotext"); }
      throw error;
    }
  }
  if (IMAGE_EXTENSIONS.includes(ext)) return run("tesseract", [file, "-", "-l", ocrLangs], { signal, timeout: OCR_TIMEOUT_MS });
  if (!office) { missing.add("LibreOffice (soffice)"); throw new Error("LibreOffice (soffice) is not installed"); }
  const result = await office.extract({ buffer: readFileSync(file), mimeType: extByMime[ext], signal });
  if (!result) throw new Error(`not an Office document: ${ext}`);
  return result.text;
}

try {
  // Images only with OCR: without it they have no text to copy.
  const extensions = ocrLangs ? [...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS] : TEXT_EXTENSIONS;
  const t = await syncKnowledgeText({ scopes, extract, extensions, ocr: Boolean(ocrLangs) });
  if (ocrLangs) console.log(`  OCR languages: ${ocrLangs}`);
  console.log(`knowledge text: updated ${t.updated}, unchanged ${t.unchanged}, removed ${t.removed}, too large ${t.skipped}, failed ${t.failed.length}`);
  if (missing.size) console.log(`  not installed: ${[...missing].join(", ")} — files that need them have no text copy, or only part of it`);
  for (const f of t.failed.slice(0, 20)) console.log(`  ✗ ${f.file}: ${f.error}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
