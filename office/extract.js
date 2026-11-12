// Text of Office attachments for the model: an OpenClaw document extractor (api.registerDocumentExtractor),
// so a .docx/.xlsx/.pptx in chat reaches the model as text instead of an "unsupported format" marker.
// Everything runs locally; the file never leaves the machine.
//
//   Writer (docx, doc, odt, rtf)      soffice --convert-to "txt:Text (encoded):UTF8"
//   Calc (xlsx, xls, ods)             soffice CSV export of every sheet → "## Sheet <name>" + CSV
//   Impress (pptx, odp)               slide XML read here (LibreOffice has no text export for Impress)
//   Impress (ppt)                     soffice --convert-to pptx, then as pptx → "## Slide N"
//
// LibreOffice runs in the converter's single-slot queue (never next to a preview conversion) with its
// profile and timeout. Results are cached by content next to the PDFs (<sha256>.txt).
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { ConvertError } from "./convert.js";
import { CSV_ALL_SHEETS, readSheets, stripBom } from "./sheets.js";

const WRITER = "writer";
const CALC = "calc";
const IMPRESS = "impress";
const OLE = "ole";

/** MIME type → document family and the file extension LibreOffice should see. */
export const OFFICE_MIME_TYPES = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [WRITER, ".docx"],
  "application/msword": [WRITER, ".doc"],
  "application/vnd.oasis.opendocument.text": [WRITER, ".odt"],
  "application/rtf": [WRITER, ".rtf"],
  "text/rtf": [WRITER, ".rtf"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [CALC, ".xlsx"],
  "application/vnd.ms-excel": [CALC, ".xls"],
  "application/vnd.oasis.opendocument.spreadsheet": [CALC, ".ods"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [IMPRESS, ".pptx"],
  "application/vnd.ms-powerpoint": [IMPRESS, ".ppt"],
  "application/vnd.oasis.opendocument.presentation": [IMPRESS, ".odp"],
  // Legacy .doc/.xls/.ppt sniffed by content only: the family comes from the OLE stream names.
  "application/x-cfb": [OLE, ""],
};

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * Legacy OLE container: which application wrote it, by its main stream. Directory entries are 128-byte
 * records (UTF-16LE name, its byte length at +64, type 2 = stream at +66) on 128-byte boundaries.
 */
export function oleFamily(buffer) {
  const streams = new Set();
  for (let at = 512; at + 128 <= buffer.length; at += 128) {
    const size = buffer.readUInt16LE(at + 64);
    if (buffer[at + 66] !== 2 || size < 4 || size > 64 || size % 2) continue;
    streams.add(buffer.toString("utf16le", at, at + size - 2));
  }
  if (streams.has("WordDocument")) return [WRITER, ".doc"];
  if (streams.has("PowerPoint Document")) return [IMPRESS, ".ppt"];
  if (streams.has("Workbook") || streams.has("Book")) return [CALC, ".xls"];
  return null;
}

/** Family and extension for a MIME type (and the bytes, for OLE); null when it is not an Office document. */
export function officeFormat(mimeType, buffer) {
  const format = OFFICE_MIME_TYPES[String(mimeType ?? "").toLowerCase()];
  if (!format) return null;
  return format[0] === OLE ? oleFamily(buffer) : format;
}

/** ZIP entries by name (stored and deflated; no ZIP64), read through the central directory. */
export function readZip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("not a ZIP file");
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("broken ZIP central directory");
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    entries.set(name, () => {
      if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`broken ZIP entry ${name}`);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      throw new Error(`unsupported ZIP compression ${method} in ${name}`);
    });
  }
  return { names: [...entries.keys()], read: (name) => entries.get(name)?.().toString("utf8") };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const decodeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const lines = (paragraphs) => paragraphs.map((p) => p.trimEnd()).filter(Boolean).join("\n");

/** DrawingML text (<a:p> paragraphs of <a:t> runs); field values such as slide numbers are left out. */
function drawingText(xml) {
  return lines(xml.replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, "").split(/<\/a:p>/).map((p) =>
    p.replace(/<a:br\s*\/>/g, "<a:t>\n</a:t>").match(/<a:t(?:\s[^>]*)?>[^<]*<\/a:t>/g)?.map((t) =>
      decodeXml(t.replace(/<[^>]+>/g, ""))).join("") ?? ""));
}

/** Relationship id → target path inside the package, for the part at partPath. */
function relations(zip, partPath) {
  const dir = path.posix.dirname(partPath);
  const xml = zip.read(path.posix.join(dir, "_rels", `${path.posix.basename(partPath)}.rels`)) ?? "";
  const out = new Map();
  for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const target = attr(tag, "Target");
    if (target) out.set(attr(tag, "Id"), { type: attr(tag, "Type") ?? "", path: path.posix.normalize(path.posix.join(dir, decodeXml(target))) });
  }
  return out;
}

/** Slides of a .pptx in presentation order: [{ text, notes }]. */
export function pptxSlides(buffer) {
  const zip = readZip(buffer);
  const rels = relations(zip, "ppt/presentation.xml");
  let parts = (zip.read("ppt/presentation.xml") ?? "").match(/<p:sldId\b[^>]*>/g)
    ?.map((tag) => rels.get(attr(tag, "r:id"))?.path).filter((p) => p && zip.names.includes(p)) ?? [];
  if (parts.length === 0) {
    const num = (p) => Number(p.match(/(\d+)\.xml$/)?.[1] ?? 0);
    parts = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  }
  return parts.map((part) => {
    const notesPart = [...relations(zip, part).values()].find((r) => r.type.endsWith("/notesSlide"))?.path;
    const notesXml = notesPart ? zip.read(notesPart) ?? "" : "";
    // Notes text lives in the body placeholder; the slide image and number placeholders carry none.
    return { text: drawingText(zip.read(part) ?? ""), notes: drawingText(notesXml) };
  });
}

/** ODF paragraph text: spaces, tabs and line breaks as in the document, markup removed. */
function odfText(xml) {
  return lines([...xml.matchAll(/<text:(p|h)\b[^>]*>([\s\S]*?)<\/text:\1>/g)].map(([, , inner]) => decodeXml(inner
    .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, c) => " ".repeat(Number(c ?? 1)))
    .replace(/<text:tab\s*\/>/g, "\t")
    .replace(/<text:line-break\s*\/>/g, "\n")
    .replace(/<[^>]+>/g, ""))));
}

/** Slides of an .odp (or .fodp content) in order: [{ text, notes }]. */
export function odpSlides(buffer) {
  const xml = readZip(buffer).read("content.xml") ?? "";
  return (xml.match(/<draw:page\b[\s\S]*?<\/draw:page>/g) ?? []).map((page) => {
    const notes = page.match(/<presentation:notes\b[\s\S]*?<\/presentation:notes>/)?.[0] ?? "";
    return { text: odfText(page.replace(notes, "")), notes: odfText(notes) };
  });
}

export const formatSlides = (slides) => slides.map(({ text, notes }, i) =>
  [`## Slide ${i + 1}`, text, notes && `Notes:\n${notes}`].filter(Boolean).join("\n\n")).join("\n\n");

export const formatSheets = (sheets) => sheets.map(({ name, csv }) => `## Sheet ${name}\n\n${csv.trimEnd()}`).join("\n\n");

/**
 * Document extractor over a converter from convert.js. onCached is called after a new text lands in
 * the cache (for pruning).
 */
export function createOfficeTextExtractor({ converter, onCached }) {
  const { cacheDir } = converter;

  async function extractNow(buffer, [family, ext], signal) {
    const work = await mkdtemp(path.join(cacheDir, "text-"));
    try {
      const input = path.join(work, `source${ext}`);
      await writeFile(input, buffer, { mode: 0o600 });
      if (family === WRITER) {
        await converter.runSoffice(["--convert-to", "txt:Text (encoded):UTF8", "--outdir", work, input], signal);
        return stripBom(await readFile(path.join(work, "source.txt"), "utf8").catch(() => {
          throw new ConvertError("convert-failed", "LibreOffice did not produce text");
        }));
      }
      if (family === CALC) {
        const stdout = await converter.runSoffice(["--convert-to", CSV_ALL_SHEETS, "--outdir", work, input], signal);
        const sheets = await readSheets(work, stdout);
        if (sheets.length === 0) throw new ConvertError("convert-failed", "LibreOffice did not produce CSV");
        return formatSheets(sheets);
      }
      // Impress: .ppt is first turned into .pptx; .pptx and .odp are read directly.
      let source = buffer;
      if (ext === ".ppt") {
        await converter.runSoffice(["--convert-to", "pptx", "--outdir", work, input], signal);
        source = await readFile(path.join(work, "source.pptx")).catch(() => {
          throw new ConvertError("convert-failed", "LibreOffice did not produce a presentation");
        });
      }
      return formatSlides(ext === ".odp" ? odpSlides(source) : pptxSlides(source));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  return {
    id: "aiwb-office",
    label: "Office documents (LibreOffice)",
    mimeTypes: Object.keys(OFFICE_MIME_TYPES),
    async extract({ buffer, mimeType, signal }) {
      signal?.throwIfAborted();
      const format = officeFormat(mimeType, buffer);
      if (!format) return null;
      const hash = createHash("sha256").update(buffer).digest("hex");
      const cached = path.join(cacheDir, `${hash}.txt`);
      const result = (text) => ({ text, images: [], metadata: { textTruncated: false, imagesTruncated: false } });
      const readCached = () => readFile(cached, "utf8").catch(() => null);
      const hit = await readCached();
      if (hit !== null) return result(hit);
      // One document at a time, also for pptx/odp: a large deck is parsed in this process.
      const text = await converter.exclusive(async () => {
        signal?.throwIfAborted();
        const done = await readCached();
        if (done !== null) return done;
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        const fresh = await extractNow(buffer, format, signal);
        const tmp = `${cached}.${process.pid}.tmp`;
        await writeFile(tmp, fresh, { mode: 0o600 });
        await rename(tmp, cached);
        onCached?.();
        return fresh;
      });
      return result(text);
    },
  };
}

