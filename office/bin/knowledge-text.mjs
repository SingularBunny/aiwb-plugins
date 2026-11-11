#!/usr/bin/env node
// Text copies of knowledge base PDF and Office files (office/knowledge-text.js), run by the ai-workbench installer's
// timer. PDF: pdftotext (poppler); Office: local LibreOffice through the aiwb-office extractor. A missing tool skips
// its formats with one line, the rest still runs.
//
//   knowledge-text.mjs --scope <root>=<folder>[:<folder>…] [--scope …] [--soffice <path>]
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createConverter } from "../convert.js";
import { createOfficeTextExtractor, OFFICE_MIME_TYPES } from "../extract.js";
import { findSoffice } from "../host.js";
import { syncKnowledgeText } from "../knowledge-text.js";

const args = process.argv.slice(2);
const scopes = [];
let sofficeSetting;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--scope") {
    const [root, list] = String(args[++i] ?? "").split(/=(.*)/s);
    if (!root || !list || !path.isAbsolute(root)) { console.error(`bad --scope ${args[i]}: <root>=<folder>[:<folder>…]`); process.exit(2); }
    scopes.push({ root, sources: list.split(":").filter(Boolean) });
  } else if (args[i] === "--soffice") sofficeSetting = args[++i];
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

async function extract(file, ext, signal) {
  if (ext === ".pdf") {
    if (!pdftotext) { missing.add("pdftotext"); throw new Error("pdftotext (poppler) is not installed"); }
    try {
      return await run("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { signal });
    } catch (error) {
      if (error?.code === "ENOENT") { pdftotext = false; missing.add("pdftotext"); }
      throw error;
    }
  }
  if (!office) { missing.add("LibreOffice (soffice)"); throw new Error("LibreOffice (soffice) is not installed"); }
  const result = await office.extract({ buffer: readFileSync(file), mimeType: extByMime[ext], signal });
  if (!result) throw new Error(`not an Office document: ${ext}`);
  return result.text;
}

try {
  const t = await syncKnowledgeText({ scopes, extract });
  console.log(`knowledge text: updated ${t.updated}, unchanged ${t.unchanged}, removed ${t.removed}, too large ${t.skipped}, failed ${t.failed.length}`);
  if (missing.size) console.log(`  not installed: ${[...missing].join(", ")} — those files have no text copy`);
  for (const f of t.failed.slice(0, 20)) console.log(`  ✗ ${f.file}: ${f.error}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
