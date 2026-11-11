// Converts Office documents to PDF with local LibreOffice (soffice --headless); the PDF is shown by
// the built-in Control UI viewer. The file never leaves the machine.
//
// The cache is keyed by content (file sha256): reopening the same document does not convert it again.
// Conversions run one at a time: LibreOffice has one profile, and parallel runs with the same profile
// fail. The profile is our own (not the user's), so an open LibreOffice of the owner does not interfere.
// Text extraction for the model (extract.js) goes through the same queue and profile.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** What gets converted: Word, Excel, PowerPoint and their OpenDocument counterparts. */
export const OFFICE_EXTENSIONS = [".docx", ".doc", ".odt", ".rtf", ".xlsx", ".xls", ".ods", ".pptx", ".ppt", ".odp"];
/** The Control UI viewer does not open anything larger (OpenClaw docs web/control-ui/chat.md). */
export const MAX_PDF_BYTES = 16 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export const isOfficeFile = (name) => OFFICE_EXTENSIONS.includes(path.extname(String(name)).toLowerCase());

export class ConvertError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const run = (file, args, timeoutMs, signal) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, signal }, (error, stdout, stderr) =>
    error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(String(stdout)));
});

/**
 * Converter with a single-slot queue. soffice is the LibreOffice path; cacheDir holds the PDFs and the
 * LibreOffice profile. convert() returns { pdfPath, bytes, cached }; exclusive() runs another task in the
 * same queue, and runSoffice() runs LibreOffice with the plugin's profile (call it inside exclusive()).
 */
export function createConverter({ soffice = "soffice", cacheDir, timeoutMs = 120_000 }) {
  let queue = Promise.resolve();
  const profile = pathToFileURL(path.join(cacheDir, "lo-profile")).href;
  const exclusive = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };
  const runSoffice = (args, signal) => run(soffice, [`-env:UserInstallation=${profile}`, "--headless", "--norestore",
    "--nolockcheck", ...args], timeoutMs, signal).catch((e) => {
    if (signal?.aborted) throw signal.reason ?? e;
    throw new ConvertError(e.killed ? "timeout" : "convert-failed", e.killed ? `LibreOffice did not finish within ${timeoutMs / 1000} s` : `LibreOffice: ${(e.stderr || e.message).trim().slice(0, 300)}`);
  });
  async function convertNow(source) {
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) throw new ConvertError("not-found", "file not found");
    if (info.size > MAX_SOURCE_BYTES) throw new ConvertError("too-large", `file is larger than ${MAX_SOURCE_BYTES >> 20} MB`);
    const ext = path.extname(source).toLowerCase();
    if (!OFFICE_EXTENSIONS.includes(ext)) throw new ConvertError("unsupported", `not an Office document: ${ext || "no extension"}`);
    const hash = createHash("sha256").update(await readFile(source)).digest("hex");
    const pdfPath = path.join(cacheDir, `${hash}.pdf`);
    const done = await stat(pdfPath).catch(() => null);
    if (done) return { pdfPath, bytes: done.size, cached: true };
    await mkdir(cacheDir, { recursive: true });
    // Safe source name: LibreOffice derives the PDF name from it, and the owner's path can be anything.
    const work = await mkdtemp(path.join(cacheDir, "work-"));
    try {
      const input = path.join(work, `source${ext}`);
      await copyFile(source, input);
      await runSoffice(["--convert-to", "pdf", "--outdir", work, input]);
      const out = path.join(work, "source.pdf");
      const made = await stat(out).catch(() => null);
      if (!made) throw new ConvertError("convert-failed", "LibreOffice did not produce a PDF");
      if (made.size > MAX_PDF_BYTES) throw new ConvertError("too-large", `PDF is larger than ${MAX_PDF_BYTES >> 20} MB; the viewer will not open it`);
      await rename(out, pdfPath);
      return { pdfPath, bytes: made.size, cached: false };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  return {
    cacheDir,
    convert: (source) => exclusive(() => convertNow(source)),
    exclusive,
    runSoffice,
  };
}
