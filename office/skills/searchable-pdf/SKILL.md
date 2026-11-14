---
name: searchable-pdf
description: Use when the user wants a scanned PDF made searchable — text that can be selected, copied or found in a PDF viewer — or asks to OCR a PDF into a PDF. Not for reading a scan's text yourself.
metadata: { "openclaw": { "requires": { "bins": ["ocrmypdf", "tesseract", "node"] } } }
---

# Searchable PDF

Make a copy of a scanned PDF with a text layer, locally (nothing is uploaded):

```bash
node {baseDir}/searchable-pdf.mjs "<file.pdf>"
```

- The copy goes next to the original as `<name>.ocr.pdf`; the original is not changed. `--out <path>` puts it
  elsewhere. An existing file is never overwritten (exit code 3): ask before choosing another name.
- Pages that already have text stay as they are; only the pages without text are recognized.
- Languages: all installed Tesseract languages. If the user names the document's languages, pass them, for example
  `--ocr-langs eng+rus` (Tesseract codes).
- A long scan takes minutes. Tell the user it is running, then give the path the command prints.
- Exit code 4 means OCR does not work on this machine; show the user the message as it is.

To read a scan's text for an answer, do not make a copy: open the PDF as usual.
