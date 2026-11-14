#!/usr/bin/env node
// A searchable copy of a scanned PDF: OCRmyPDF adds a text layer to the pages without text (--skip-text), so the
// copy's text can be selected, copied and searched in any PDF viewer. The original is not changed; the copy goes
// next to it as "<name>.ocr.pdf" unless --out says otherwise, and an existing file is not overwritten.
// Languages: the installed Tesseract languages (osd and equ aside) or --ocr-langs. Local only: nothing is uploaded.
//
//   node skills/searchable-pdf/searchable-pdf.mjs <file.pdf> [--out <copy.pdf>] [--ocr-langs eng+rus]
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { lastLine, ocrLanguages, searchableArgs, searchableOutPath } from "../../ocr.js";

const args = process.argv.slice(2);
let input;
let output;
let langsSetting;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--out") output = args[++i];
  else if (args[i] === "--ocr-langs") langsSetting = args[++i];
  else if (!input && !args[i].startsWith("--")) input = args[i];
  else { console.error(`unknown argument ${args[i]}`); process.exit(2); }
}
if (!input) { console.error("usage: searchable-pdf.mjs <file.pdf> [--out <copy.pdf>] [--ocr-langs eng+rus]"); process.exit(2); }
input = path.resolve(input);
output = path.resolve(output || searchableOutPath(input));
if (!existsSync(input)) { console.error(`no such file: ${input}`); process.exit(2); }
if (path.extname(input).toLowerCase() !== ".pdf") { console.error(`not a PDF: ${input}`); process.exit(2); }
if (output === input) { console.error("the copy must not replace the original: choose another --out"); process.exit(2); }
if (existsSync(output)) { console.error(`already exists, not overwritten: ${output}`); process.exit(3); }

const run = (file, argv, opts = {}) => new Promise((resolve, reject) =>
  execFile(file, argv, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000, ...opts }, (error, stdout) => (error ? reject(error) : resolve(stdout))));

const { langs, problem } = await ocrLanguages(run, langsSetting);
if (!langs) {
  console.error(problem ? `OCR does not work: ${problem}` : "OCRmyPDF and Tesseract are not installed");
  process.exit(4);
}
try {
  // OCR of a long scan takes minutes; 30 minutes per file is our own limit, there is no standard one.
  await run("ocrmypdf", searchableArgs(input, output, langs), { timeout: 30 * 60_000 });
} catch (error) {
  console.error(`OCRmyPDF failed: ${lastLine(error)}`);
  process.exit(1);
}
console.log(`searchable copy: ${output} (languages ${langs})`);
