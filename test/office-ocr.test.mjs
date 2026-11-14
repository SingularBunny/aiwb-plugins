import assert from "node:assert/strict";
import test from "node:test";

import { ocrLanguages, searchableArgs, searchableOutPath } from "../office/ocr.js";

const runner = (answers) => async (tool, argv) => {
  const a = answers[`${tool} ${argv.join(" ")}`];
  if (a instanceof Error) throw a;
  if (a === undefined) throw Object.assign(new Error(`spawn ${tool} ENOENT`), { code: "ENOENT" });
  return a;
};
const ok = { "ocrmypdf --version": "17.1", "tesseract --version": "5.5" };

test("ocr: all installed languages but osd and equ, or the asked ones that are installed", async () => {
  const run = runner({ ...ok, "tesseract --list-langs": "List of available languages (4):\neng\nequ\nosd\nrus\n" });
  assert.deepEqual(await ocrLanguages(run), { langs: "eng+rus" });
  assert.deepEqual(await ocrLanguages(run, "rus+deu"), { langs: "rus" });
  assert.deepEqual(await ocrLanguages(run, "deu"), { problem: "no Tesseract language data for deu" });
});

test("ocr: a missing tool is off quietly, an installed tool that does not run is named", async () => {
  assert.deepEqual(await ocrLanguages(runner({})), { problem: null });
  const broken = Object.assign(new Error("exit 1"), { code: 1, stderr: "Traceback\nImportError: libssl.so.4: cannot open shared object file\n" });
  assert.deepEqual(await ocrLanguages(runner({ "ocrmypdf --version": broken })),
    { problem: "ocrmypdf is installed but does not run: ImportError: libssl.so.4: cannot open shared object file" });
});

test("ocr: the searchable copy goes next to the scan and keeps pages that have text", () => {
  assert.equal(searchableOutPath("/w/Скан договора.PDF"), "/w/Скан договора.ocr.pdf");
  assert.deepEqual(searchableArgs("/w/a.pdf", "/w/a.ocr.pdf", "eng+rus"), ["--skip-text", "-l", "eng+rus", "--quiet", "/w/a.pdf", "/w/a.ocr.pdf"]);
});
