// Spreadsheets as CSV (every sheet) and a short table preview of them. The text for the model (extract.js)
// uses the CSV; the preview (convert.js) uses the table when the full PDF of a large sheet is over the viewer limit.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** LibreOffice CSV export of every sheet: comma, double quotes, UTF-8, formatted values (sheet -1 = all). */
export const CSV_ALL_SHEETS = "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1";

/** Rows per sheet in the short preview: own limit, no standard; 1000 rows of a 7-column sheet are about 40 A4 pages. */
export const PREVIEW_ROWS = 1000;

export const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Sheet CSV files written by LibreOffice, in workbook order ("Writing sheet <name> -> <path>" on stdout). */
export async function readSheets(work, stdout) {
  const written = [...stdout.matchAll(/^Writing sheet (.+?) -> (.+)$/gm)].map(([, name, file]) => ({ name, file: path.basename(file.trim()) }));
  const files = (await readdir(work)).filter((f) => f.startsWith("source-") && f.endsWith(".csv"));
  const ordered = written.filter((w) => files.includes(w.file));
  for (const file of files.sort()) {
    if (!ordered.some((w) => w.file === file)) ordered.push({ name: file.slice("source-".length, -".csv".length), file });
  }
  return Promise.all(ordered.map(async ({ name, file }) => ({ name, csv: stripBom(await readFile(path.join(work, file), "utf8")) })));
}

/** RFC 4180 CSV (comma, double quotes, CRLF or LF) into rows of cells. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** HTML of every sheet's first maxRows rows, each under its name with a note when rows were left out. */
export function sheetsPreviewHtml(sheets, maxRows = PREVIEW_ROWS) {
  const parts = sheets.map(({ name, csv }) => {
    const rows = parseCsv(csv);
    while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
    const shown = rows.slice(0, maxRows);
    const note = rows.length > shown.length
      ? `<p><i>Preview: the first ${shown.length} of ${rows.length} rows. Open the file itself for all of them.</i></p>` : "";
    const body = shown.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("\n");
    return `<h2>${escapeHtml(name)}</h2>\n${note}\n<table border="1" cellspacing="0" cellpadding="2">\n${body}\n</table>`;
  });
  return `<!doctype html>\n<html><head><meta charset="utf-8"><style>body{font-family:sans-serif;font-size:8pt}td{font-size:8pt}</style></head><body>\n${parts.join("\n")}\n</body></html>\n`;
}
