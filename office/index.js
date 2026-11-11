// Office documents in OpenClaw chat: preview and text for the model.
//
// Preview: the fork's Control UI opens a .docx/.xlsx/.pptx (and OpenDocument)
// attachment or project file in its PDF viewer: it sends the document bytes here, and the plugin
// responds with its PDF made by local LibreOffice. The file never leaves the machine.
//
//   POST /api/office-preview/convert?name=<file name>   body: document bytes → application/pdf
//
// Auth is the Gateway's (Control UI Bearer). Errors: 400 not an Office document, 413 over the limit,
// 503 no LibreOffice, 502 LibreOffice failed; the UI then offers to download the file.
//
// The plugin also registers a document extractor (extract.js): the text of an Office attachment reaches
// the model directly, like a PDF. It needs the fork's api.registerDocumentExtractor and LibreOffice.
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { ConvertError, MAX_SOURCE_BYTES, OFFICE_EXTENSIONS, createConverter } from "./convert.js";
import { createOfficeTextExtractor } from "./extract.js";
import { findSoffice, pruneCache } from "./host.js";

const ROUTE = "/api/office-preview/convert";
const STATUS = { "unsupported": 400, "too-large": 413, "not-found": 400, "timeout": 504, "convert-failed": 502 };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new ConvertError("too-large", `file is larger than ${limit >> 20} MB`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function fail(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: message }));
  return true;
}

export default definePluginEntry({
  id: "aiwb-office",
  name: "Document preview",
  description: "Office documents in chat as PDF and as text for the model, converted by local LibreOffice",
  register(api) {
    const state = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
    const cacheDir = path.join(state, "workbench", "office-preview");
    const cacheBytes = (Number(api.pluginConfig?.cacheMb) > 0 ? Number(api.pluginConfig.cacheMb) : 512) * 1024 * 1024;
    const soffice = findSoffice(api.pluginConfig?.soffice);
    if (!soffice) api.logger?.warn?.("aiwb-office: LibreOffice (soffice) not found; Office document preview and text extraction are unavailable");
    const converter = soffice ? createConverter({ soffice, cacheDir }) : null;
    const prune = () => void pruneCache(cacheDir, cacheBytes).catch(() => {});
    if (converter && typeof api.registerDocumentExtractor === "function") {
      api.registerDocumentExtractor(createOfficeTextExtractor({ converter, onCached: prune }));
    }

    api.registerHttpRoute({
      path: ROUTE,
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          return fail(res, 405, "POST required");
        }
        if (!converter) return fail(res, 503, "LibreOffice not found");
        const name = new URL(req.url ?? "", "http://local").searchParams.get("name") ?? "";
        const ext = path.extname(name).toLowerCase();
        if (!OFFICE_EXTENSIONS.includes(ext)) return fail(res, 400, `not an Office document: ${ext || "no extension"}`);
        const input = path.join(cacheDir, `in-${randomBytes(8).toString("hex")}${ext}`);
        try {
          const body = await readBody(req, MAX_SOURCE_BYTES);
          await mkdir(cacheDir, { recursive: true, mode: 0o700 });
          await writeFile(input, body, { mode: 0o600 });
          const { pdfPath, bytes, cached } = await converter.convert(input);
          if (!cached) prune();
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Length", String(bytes));
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Content-Type-Options", "nosniff");
          await new Promise((resolve, reject) => {
            createReadStream(pdfPath).on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
          });
          return true;
        } catch (e) {
          if (res.headersSent) { res.destroy(); return true; }
          const status = e instanceof ConvertError ? STATUS[e.code] ?? 500 : 500;
          if (status === 500) api.logger?.warn?.(`aiwb-office: ${e?.message ?? e}`);
          return fail(res, status, e?.message ?? "error");
        } finally {
          await rm(input, { force: true });
        }
      },
    });
  },
});

