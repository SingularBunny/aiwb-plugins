// OCR with OCRmyPDF and Tesseract, shared by the knowledge base text copies (bin/knowledge-text.mjs) and the
// searchable PDF copy of a scan (skills/searchable-pdf/searchable-pdf.mjs). Recognition languages: the installed
// Tesseract languages (osd and equ aside: orientation and equations, not languages of text), or the asked ones that
// are installed.
import path from "node:path";

/** The last line of a failed command's output: what to show for a tool that does not run. */
export function lastLine(error) {
  const lines = String(error?.stderr || error?.message || error).trim().split("\n").filter(Boolean);
  return lines.at(-1) ?? "unknown error";
}

/**
 * OCR languages as Tesseract's "eng+rus", or a problem. run(file, argv) resolves with stdout or rejects.
 * Returns { langs } or { problem }: problem is null when the tools are simply not installed, and names the error
 * when an installed tool does not run (a broken Python library, say), so OCR is not silently off.
 */
export async function ocrLanguages(run, setting) {
  for (const [tool, args] of [["ocrmypdf", ["--version"]], ["tesseract", ["--version"]]]) {
    try { await run(tool, args); } catch (error) {
      return { problem: error?.code === "ENOENT" ? null : `${tool} is installed but does not run: ${lastLine(error)}` };
    }
  }
  const listed = String(await run("tesseract", ["--list-langs"]).catch(() => "")).split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  const langs = setting ? setting.split("+").filter((l) => listed.includes(l)) : listed.filter((l) => !["osd", "equ"].includes(l));
  return langs.length ? { langs: langs.join("+") } : { problem: `no Tesseract language data${setting ? ` for ${setting}` : ""}` };
}

/** Where the searchable copy of a scan goes by default: next to it, "<name>.ocr.pdf". */
export const searchableOutPath = (input) => path.join(path.dirname(input), `${path.basename(input, path.extname(input))}.ocr.pdf`);

/** OCRmyPDF arguments for a searchable copy: pages that have any text stay as they are (--skip-text). */
export const searchableArgs = (input, output, langs) => ["--skip-text", "-l", langs, "--quiet", input, output];
