import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

test("shared memory: prompt has USER.md, the index and where to write", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { sharedMemoryContext } = await import("../shared-memory/context.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "mem-"));
  mkdirSync(path.join(dir, "memory"));
  writeFileSync(path.join(dir, "USER.md"), "U_MARK");
  writeFileSync(path.join(dir, "MEMORY.md"), "I_MARK");
  const t = sharedMemoryContext(dir);
  assert.ok(t.includes("U_MARK") && t.includes("I_MARK") && t.includes(path.join(dir, "memory")));
  assert.ok(t.includes("Exec completed") && t.includes("NO_REPLY"));
});

test("knowledge base: an agent gets the folders for everyone plus its own, and may write there", async () => {
  const { knowledgeContext } = await import("../shared-memory/context.js");
  const knowledge = { "*": ["/k/vault"], garden: ["/k/garden", "/k/vault"] };
  const garden = knowledgeContext(knowledge, "garden");
  assert.ok(garden.includes("Knowledge base folders: /k/vault, /k/garden."));
  assert.ok(garden.includes("memory_search") && garden.includes("save new notes") && garden.includes("wait") && garden.includes("never with shell commands"));
  assert.ok(knowledgeContext(knowledge, "orchard").includes("folders: /k/vault."));
  assert.equal(knowledgeContext({ garden: ["/k/garden"] }, "orchard"), null);
  assert.equal(knowledgeContext(undefined, "garden"), null);
});

test("knowledge base: a write inside the folders asks first, with once, always and deny; outside it does not", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const os = await import("node:os");
  const { knowledgeApproval } = await import("../shared-memory/knowledge-guard.js");
  const vault = mkdtempSync(path.join(os.tmpdir(), "vault-"));
  mkdirSync(path.join(vault, "garden"));
  writeFileSync(path.join(vault, "garden", "pruning.md"), "old");
  const knowledge = { "*": [vault] };
  const allowedSessions = new Set();
  const ask = (toolName, params, extra = {}) =>
    knowledgeApproval({ toolName, params, agentId: "garden", knowledge, allowedSessions, sessionKey: "s1", ...extra });

  const create = ask("write", { path: path.join(vault, "garden", "quince.md"), content: "Quince notes" });
  assert.equal(create.requireApproval.title, "Knowledge base: create quince.md");
  assert.ok(create.requireApproval.description.includes("Quince notes"));
  assert.deepEqual(create.requireApproval.allowedDecisions, ["allow-once", "allow-always", "deny"]);
  assert.equal(ask("write", { file_path: path.join(vault, "garden", "pruning.md"), content: "new" }).requireApproval.title,
    "Knowledge base: replace pruning.md");
  const edit = ask("edit", { path: "garden/pruning.md", old_string: "old", new_string: "new" }, { base: vault });
  assert.match(edit.requireApproval.description, /- old\n\+ new/);
  const patch = ask("apply_patch", { input: `*** Begin Patch\n*** Add File: ${vault}/a.md\n+x\n*** Delete File: ${vault}/b.md\n*** End Patch` });
  assert.equal(patch.requireApproval.title, "Knowledge base: change 2 notes");

  // Outside the folders, a path that only starts like the vault, and other agents' folders: no approval.
  assert.equal(ask("write", { path: "/tmp/elsewhere.md", content: "x" }), undefined);
  assert.equal(ask("write", { path: `${vault}-other/x.md`, content: "x" }), undefined);
  assert.equal(ask("write", { path: path.join(vault, "..", "x.md"), content: "x" }), undefined);
  assert.equal(knowledgeApproval({ toolName: "write", params: { path: "/k/orchard/x.md" }, agentId: "garden",
    knowledge: { orchard: ["/k/orchard"] }, allowedSessions, sessionKey: "s1" }), undefined);

  // Allow always: no more cards in that chat; other chats still ask.
  create.requireApproval.onResolution("allow-once");
  assert.ok(ask("write", { path: path.join(vault, "x.md"), content: "x" }));
  create.requireApproval.onResolution("allow-always");
  assert.equal(ask("write", { path: path.join(vault, "x.md"), content: "x" }), undefined);
  assert.ok(ask("write", { path: path.join(vault, "x.md"), content: "x" }, { sessionKey: "s2" }));
});

test("fork settings: effective value, its source, and invalid falls back to default", async () => {
  const { effectiveSettings, summaryLine } = await import("../fork-settings/settings.js");
  const env = { OPENCLAW_WORKER_PENDING_TASKS: "4096", OPENCLAW_WORKER_HEAP_MB: "lots", OPENCLAW_CATALOG_IMPORT_OWNER: "1",
    OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS: "300" };
  const rows = Object.fromEntries(effectiveSettings({ env,
    configVars: { OPENCLAW_WORKER_PENDING_TASKS: "4096", OPENCLAW_CATALOG_IMPORT_OWNER: "1", OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS: "1000" } })
    .map((r) => [r.name, r]));
  assert.deepEqual([rows.OPENCLAW_WORKER_PENDING_TASKS.value, rows.OPENCLAW_WORKER_PENDING_TASKS.source], [4096, "env.vars"]);
  assert.deepEqual([rows.OPENCLAW_WORKER_PENDING_BYTES.value, rows.OPENCLAW_WORKER_PENDING_BYTES.source], [256 * 1024 * 1024, "default"]);
  assert.deepEqual([rows.OPENCLAW_WORKER_HEAP_MB.value, rows.OPENCLAW_WORKER_HEAP_MB.invalid], [512, true]);   // as in the fork
  assert.equal(rows.OPENCLAW_CATALOG_IMPORT_OWNER.value, true);
  // The process environment (.env) overrides the setting: it takes effect, the setting is shown separately.
  assert.deepEqual([rows.OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS.value, rows.OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS.source,
    rows.OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS.configured], [300, "environment", "1000"]);
  assert.match(summaryLine(Object.values(rows)), /WORKER_PENDING_TASKS=4096 \(env\.vars\).*WORKER_HEAP_MB=512 \(environment\) \[invalid/);
});

test("fork settings: every fork variable is listed with kind, default and range", async () => {
  const { FORK_SETTINGS, effectiveSettings } = await import("../fork-settings/settings.js");
  const names = FORK_SETTINGS.map((s) => s.name);
  for (const name of ["OPENCLAW_WORKER_PENDING_TASKS", "OPENCLAW_WORKER_PENDING_BYTES", "OPENCLAW_WORKER_HEAP_MB",
    "OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS", "OPENCLAW_CATALOG_CONTINUATION_MAX_BYTES", "OPENCLAW_CATALOG_IMPORT_OWNER",
    "OPENCLAW_MEMORY_INDEX_ON_START", "OPENCLAW_CLAUDE_CHROME", "OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS",
    "OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS", "OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS", "OPENCLAW_PLUGIN_GATEWAY_METHODS",
    "OPENCLAW_RESTART_AGENT_RUN_WAIT_MS", "OPENCLAW_PROXY_ROUTES", "OPENCLAW_CLI_BACKEND_PROXY", "OPENCLAW_ASSISTANT_MEDIA_ROOTS"]) {
    assert.ok(names.includes(name), name);
  }
  for (const s of FORK_SETTINGS) {
    assert.ok(["int", "flag", "grants", "wait", "routes", "backends", "folders"].includes(s.kind) && s.about && s.where, s.name);
    if (s.kind === "int") assert.ok(s.unit && s.min <= s.default && s.default <= s.max, s.name);
    if (s.kind === "wait") assert.ok(s.unit && s.default === null && s.min === s.above + 1 && s.min < s.max, s.name);
  }
  // Defaults as in the fork: prompt suggestions on, flags off, cadence 12 s / 90 s, no grants.
  const rows = Object.fromEntries(effectiveSettings({ env: {} }).map((r) => [r.name, r]));
  assert.equal(rows.OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS.value, true);
  assert.equal(rows.OPENCLAW_CLAUDE_CHROME.value, false);
  assert.equal(rows.OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS.value, 12_000);
  assert.equal(rows.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS.value, 90_000);
  assert.equal(rows.OPENCLAW_PLUGIN_GATEWAY_METHODS.value, "");
});

test("fork settings: read flags values the fork ignores or that are out of range", async () => {
  const { effectiveSettings, summaryLine } = await import("../fork-settings/settings.js");
  const rows = Object.fromEntries(effectiveSettings({ env: {
    OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS: "off", OPENCLAW_CLAUDE_CHROME: "TRUE", OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS: "5",
    OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS: "600000",
    OPENCLAW_PLUGIN_GATEWAY_METHODS: "aiwb-claude-bridge=sessions.catalog.list;aiwb-x=*" } }).map((r) => [r.name, r]));
  // "off" is not one of the fork's off values: the fork keeps suggestions on, so the value is flagged.
  assert.deepEqual([rows.OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS.value, rows.OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS.invalid], [true, true]);
  assert.deepEqual([rows.OPENCLAW_CLAUDE_CHROME.value, rows.OPENCLAW_CLAUDE_CHROME.invalid], [true, undefined]);
  // The fork uses 5 ms as given; it is outside the range set accepts.
  assert.deepEqual([rows.OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS.value, rows.OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS.outOfRange], [5, true]);
  assert.equal(rows.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS.value, 600_000);
  // Wildcards grant nothing, as in the fork.
  assert.equal(rows.OPENCLAW_PLUGIN_GATEWAY_METHODS.value, "aiwb-claude-bridge=sessions.catalog.list");
  assert.match(summaryLine(Object.values(rows)), /PLUGIN_GATEWAY_METHODS=aiwb-claude-bridge \(environment\)/);
  assert.match(summaryLine(Object.values(rows)), /SESSION_OBSERVER_MIN_INTERVAL_MS=5 \(environment\) \[out of range\]/);
});

test("fork settings: set validates, writes env.vars and unset removes it", async () => {
  const { changeSetting, validateSettingValue } = await import("../fork-settings/settings.js");
  assert.deepEqual(validateSettingValue("OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS", 90000), { ok: true, raw: "90000" });
  assert.deepEqual(validateSettingValue("OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS", "600000"), { ok: true, raw: "600000" });
  assert.equal(validateSettingValue("OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS", 10).ok, false);       // below 1000 ms
  assert.equal(validateSettingValue("OPENCLAW_WORKER_HEAP_MB", "1.5").ok, false);
  assert.equal(validateSettingValue("OPENCLAW_WORKER_HEAP_MB", -1).ok, false);
  assert.deepEqual(validateSettingValue("OPENCLAW_CLAUDE_CHROME", true), { ok: true, raw: "1" });
  assert.deepEqual(validateSettingValue("OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS", "false"), { ok: true, raw: "0" });
  assert.equal(validateSettingValue("OPENCLAW_CLAUDE_CHROME", "maybe").ok, false);
  assert.deepEqual(validateSettingValue("OPENCLAW_PLUGIN_GATEWAY_METHODS", " a=x.y, z ; b=w "), { ok: true, raw: "a=x.y,z;b=w" });
  assert.equal(validateSettingValue("OPENCLAW_PLUGIN_GATEWAY_METHODS", "a=*").ok, false);
  assert.equal(validateSettingValue("OPENCLAW_PLUGIN_GATEWAY_METHODS", "no-equals").ok, false);
  assert.equal(validateSettingValue("PATH", "x").ok, false);

  const config = { env: { vars: { OTHER: "1" } } };
  const writes = [];
  const mutateConfigFile = async (p) => { writes.push(p.afterWrite); await p.mutate(config); return {}; };
  const [ok, result] = await changeSetting({ name: "OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS", value: 90000 },
    { mutateConfigFile, env: {} });
  assert.equal(ok, true);
  assert.deepEqual(config.env.vars, { OTHER: "1", OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS: "90000" });
  assert.deepEqual([result.stored, result.path], ["90000", "env.vars.OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS"]);
  assert.deepEqual(writes, [{ mode: "auto" }]);
  // A value from the process environment is reported: it keeps winning over env.vars.
  const [, shadowed] = await changeSetting({ name: "OPENCLAW_CLAUDE_CHROME", value: "yes" },
    { mutateConfigFile, env: { OPENCLAW_CLAUDE_CHROME: "0" } });
  assert.equal(shadowed.overriddenByEnvironment, "0");
  // The previous env.vars value in the process is not an override.
  const [, own] = await changeSetting({ name: "OPENCLAW_CLAUDE_CHROME", value: "yes" },
    { mutateConfigFile, env: { OPENCLAW_CLAUDE_CHROME: "1" }, configVars: { OPENCLAW_CLAUDE_CHROME: "1" } });
  assert.equal(own.overriddenByEnvironment, undefined);
  const [unsetOk, unset] = await changeSetting({ name: "OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS" }, { mutateConfigFile, env: {} });
  assert.deepEqual([unsetOk, unset.unset], [true, true]);
  assert.deepEqual(config.env.vars, { OTHER: "1", OPENCLAW_CLAUDE_CHROME: "1" });
  // Refused without a write: unknown name, invalid value.
  const before = writes.length;
  assert.equal((await changeSetting({ name: "OPENCLAW_UNKNOWN", value: 1 }, { mutateConfigFile }))[0], false);
  const [bad, , error] = await changeSetting({ name: "OPENCLAW_WORKER_HEAP_MB", value: 10 }, { mutateConfigFile });
  assert.equal(bad, false);
  assert.match(error.message, /64\.\.65536 MB/);
  assert.equal(writes.length, before);
});

test("document preview: what converts, where LibreOffice is, cache within limit", async () => {
  const { isOfficeFile, createConverter } = await import("../office/convert.js");
  const { findSoffice, pruneCache } = await import("../office/host.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  assert.ok(isOfficeFile("Заметки.DOCX") && isOfficeFile("t.xlsx") && isOfficeFile("s.pptx") && isOfficeFile("x.odt"));
  assert.ok(!isOfficeFile("a.pdf") && !isOfficeFile("a.csv") && !isOfficeFile("docx"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-office-"));
  try {
    // soffice from PATH; a configured path that does not exist is not found.
    const bin = path.join(dir, "bin"); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, "soffice"), "");
    assert.equal(findSoffice(undefined, bin), path.join(bin, "soffice"));
    assert.equal(findSoffice(path.join(dir, "missing")), null);
    // Cache over the limit: old PDFs are removed, other files are left alone.
    const cache = path.join(dir, "cache"); fs.mkdirSync(cache);
    for (const [name, age] of [["old.pdf", 3], ["mid.pdf", 2], ["new.pdf", 1]]) {
      const f = path.join(cache, name); fs.writeFileSync(f, Buffer.alloc(100));
      const t = new Date(Date.now() - age * 60_000); fs.utimesSync(f, t, t);
    }
    fs.writeFileSync(path.join(cache, "in-x.docx"), Buffer.alloc(500));
    await pruneCache(cache, 250);
    assert.deepEqual(fs.readdirSync(cache).sort(), ["in-x.docx", "mid.pdf", "new.pdf"]);
    // Not an Office document: rejected before LibreOffice runs.
    const csv = path.join(dir, "t.csv"); fs.writeFileSync(csv, "a;b");
    const c = createConverter({ soffice: path.join(dir, "missing-soffice"), cacheDir: path.join(dir, "c2") });
    await assert.rejects(c.convert(csv), { code: "unsupported" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** ZIP with deflated entries (stored when store=true), as Office packages are. */
async function makeZip(files, { store = false } = {}) {
  const zlib = await import("node:zlib");
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name), raw = Buffer.from(content);
    const data = store ? raw : zlib.deflateRawSync(raw);
    const head = Buffer.alloc(30), dir = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(store ? 0 : 8, 8); head.writeUInt32LE(zlib.crc32(raw), 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBytes.length, 26);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(store ? 0 : 8, 10); dir.writeUInt32LE(zlib.crc32(raw), 16);
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, nameBytes, data); centrals.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = centrals.reduce((n, b) => n + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

test("office text: MIME types map to Writer, Calc and Impress; legacy OLE by its main stream", async () => {
  const { officeFormat, OFFICE_MIME_TYPES } = await import("../office/extract.js");
  const ooxml = "application/vnd.openxmlformats-officedocument.";
  assert.deepEqual(officeFormat(`${ooxml}wordprocessingml.document`), ["writer", ".docx"]);
  assert.deepEqual(officeFormat("application/msword"), ["writer", ".doc"]);
  assert.deepEqual(officeFormat("application/vnd.oasis.opendocument.text"), ["writer", ".odt"]);
  assert.deepEqual(officeFormat("text/rtf"), ["writer", ".rtf"]);
  assert.deepEqual(officeFormat(`${ooxml.toUpperCase()}SPREADSHEETML.SHEET`), ["calc", ".xlsx"]);
  assert.deepEqual(officeFormat("application/vnd.ms-excel"), ["calc", ".xls"]);
  assert.deepEqual(officeFormat("application/vnd.oasis.opendocument.spreadsheet"), ["calc", ".ods"]);
  assert.deepEqual(officeFormat(`${ooxml}presentationml.presentation`), ["impress", ".pptx"]);
  assert.deepEqual(officeFormat("application/vnd.ms-powerpoint"), ["impress", ".ppt"]);
  assert.deepEqual(officeFormat("application/vnd.oasis.opendocument.presentation"), ["impress", ".odp"]);
  assert.equal(officeFormat("application/pdf"), null);
  assert.equal(officeFormat(undefined), null);
  assert.ok(Object.keys(OFFICE_MIME_TYPES).includes("application/x-cfb"));
  // OLE directory entry: UTF-16LE name, its byte length at +64, type 2 (stream) at +66, 128-byte records.
  const ole = (...names) => {
    const buf = Buffer.alloc(512 + 128 * (names.length + 1));
    names.forEach((name, i) => {
      const at = 512 + 128 * (i + 1);
      buf.write(name, at, "utf16le"); buf.writeUInt16LE((name.length + 1) * 2, at + 64); buf[at + 66] = 2;
    });
    return buf;
  };
  assert.deepEqual(officeFormat("application/x-cfb", ole("\u0001CompObj", "WordDocument")), ["writer", ".doc"]);
  assert.deepEqual(officeFormat("application/x-cfb", ole("Workbook")), ["calc", ".xls"]);
  assert.deepEqual(officeFormat("application/x-cfb", ole("PowerPoint Document")), ["impress", ".ppt"]);
  // A stream name inside document text (not a directory record) does not count.
  const text = Buffer.concat([Buffer.alloc(700), Buffer.from("WordDocument", "utf16le"), Buffer.alloc(300)]);
  assert.equal(officeFormat("application/x-cfb", text), null);
});

test("office text: slides of pptx and odp in order, with notes; sheets as CSV sections", async () => {
  const { readZip, pptxSlides, odpSlides, formatSlides, formatSheets } = await import("../office/extract.js");
  const stored = readZip(await makeZip({ "a.txt": "plain", "b/c.xml": "<x/>" }, { store: true }));
  assert.deepEqual([stored.names, stored.read("a.txt"), stored.read("missing")], [["a.txt", "b/c.xml"], "plain", undefined]);
  assert.throws(() => readZip(Buffer.from("not a zip at all, definitely not")), /not a ZIP/);

  const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const sp = (...paras) => `<p:sp><p:txBody>${paras.map((p) => `<a:p>${p}</a:p>`).join("")}</p:txBody></p:sp>`;
  const run = (t) => `<a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r>`;
  // Slide files are numbered against presentation order: slide2.xml is shown first.
  const pptx = await makeZip({
    "ppt/presentation.xml": '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": `<Relationships>${rel("rId2", "slide", "slides/slide1.xml")}${rel("rId3", "slide", "slides/slide2.xml")}</Relationships>`,
    "ppt/slides/slide1.xml": `<p:sld>${sp(run("Budget &amp; risks"))}</p:sld>`,
    "ppt/slides/slide2.xml": `<p:sld>${sp(run("Roadmap ") + run("2026"), `${run("line one")}<a:br/>${run("line two")}`)}</p:sld>`,
    "ppt/slides/_rels/slide2.xml.rels": `<Relationships>${rel("rId1", "notesSlide", "../notesSlides/notesSlide7.xml")}</Relationships>`,
    "ppt/notesSlides/notesSlide7.xml": `<p:notes>${sp(run("Say hello &#x263A;"))}${sp(`<a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld>`)}</p:notes>`,
  });
  const slides = pptxSlides(pptx);
  assert.deepEqual(slides, [
    { text: "Roadmap 2026\nline one\nline two", notes: "Say hello ☺" },
    { text: "Budget & risks", notes: "" },
  ]);
  assert.equal(formatSlides(slides),
    "## Slide 1\n\nRoadmap 2026\nline one\nline two\n\nNotes:\nSay hello ☺\n\n## Slide 2\n\nBudget & risks");
  // Without presentation.xml the slide files go by number.
  const bare = await makeZip({ "ppt/slides/slide10.xml": `<p:sld>${sp(run("ten"))}</p:sld>`, "ppt/slides/slide9.xml": `<p:sld>${sp(run("nine"))}</p:sld>` });
  assert.deepEqual(pptxSlides(bare).map((s) => s.text), ["nine", "ten"]);

  const odp = await makeZip({
    "mimetype": "application/vnd.oasis.opendocument.presentation",
    "content.xml": '<office:document-content><office:body><office:presentation>' +
      '<draw:page draw:name="p1"><draw:frame><draw:text-box><text:h>Title</text:h><text:p>a<text:s text:c="2"/>b<text:tab/>c <text:span text:style-name="T1">span</text:span></text:p><text:p/></draw:text-box></draw:frame>' +
      '<presentation:notes><draw:frame><draw:text-box><text:p>Note &lt;1&gt;</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>' +
      '<draw:page draw:name="p2"><draw:frame><draw:text-box><text:p>one<text:line-break/>two</text:p></draw:text-box></draw:frame></draw:page>' +
      '</office:presentation></office:body></office:document-content>',
  });
  assert.deepEqual(odpSlides(odp), [{ text: "Title\na  b\tc span", notes: "Note <1>" }, { text: "one\ntwo", notes: "" }]);

  assert.equal(formatSheets([{ name: "Budget", csv: "a,b\n1,2\n" }, { name: "Team list", csv: "x\n" }]),
    "## Sheet Budget\n\na,b\n1,2\n\n## Sheet Team list\n\nx");
});

test("office text: real LibreOffice extracts docx, every sheet of xlsx, and is cached by content", async (t) => {
  const { findSoffice } = await import("../office/host.js");
  const soffice = findSoffice();
  if (!soffice) return t.skip("LibreOffice is not installed");
  const { createConverter } = await import("../office/convert.js");
  const { createOfficeTextExtractor } = await import("../office/extract.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-office-text-"));
  try {
    const make = (name, content, to) => {
      fs.writeFileSync(path.join(dir, name), content);
      execFileSync(soffice, [`-env:UserInstallation=${pathToFileURL(path.join(dir, "lo")).href}`, "--headless",
        "--convert-to", to, "--outdir", dir, path.join(dir, name)], { stdio: "ignore", timeout: 120_000 });
      return fs.readFileSync(path.join(dir, name.replace(/\.[^.]+$/, `.${to}`)));
    };
    const docx = make("memo.txt", "Lease agreement\n\nClause 1. Monthly rent is 1200.\n", "docx");
    const xlsx = make("book.csv", "Item,Cost\n\"Rent, office\",1200\n", "xlsx");
    let cachedCount = 0;
    const cacheDir = path.join(dir, "cache");
    const extractor = createOfficeTextExtractor({ converter: createConverter({ soffice, cacheDir }), onCached: () => cachedCount++ });
    const ooxml = "application/vnd.openxmlformats-officedocument.";
    const req = (buffer, kind) => ({ buffer, mimeType: `${ooxml}${kind}`, maxPages: 1, maxPixels: 1, minTextChars: 1 });
    const [a, b] = await Promise.all([extractor.extract(req(docx, "wordprocessingml.document")), extractor.extract(req(docx, "wordprocessingml.document"))]);
    assert.match(a.text, /Lease agreement\s+Clause 1\. Monthly rent is 1200\./);
    assert.deepEqual([b.text, a.images, a.metadata], [a.text, [], { textTruncated: false, imagesTruncated: false }]);
    const sheet = await extractor.extract(req(xlsx, "spreadsheetml.sheet"));
    assert.match(sheet.text, /^## Sheet \S+\n\nItem,Cost\n"Rent, office",1200$/);
    assert.equal(cachedCount, 2);
    assert.equal(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".txt")).length, 2);
    assert.equal(await extractor.extract(req(docx, "nothing")), null);
    await assert.rejects(extractor.extract({ ...req(docx, "wordprocessingml.document"), signal: AbortSignal.abort() }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("projects order: drag-and-drop order first, then config, then alphabetical; new activity on top", async () => {
  const { sortRows, applyReorder, readOrder, writeOrder } = await import("../claude-bridge/order.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const rows = [
    { threadId: "a1", customGroup: "Alpha", recencyAt: 1 },
    { threadId: "a2", customGroup: "Alpha", recencyAt: 3 },
    { threadId: "a3", customGroup: "Alpha", recencyAt: 2 },
    { threadId: "b1", customGroup: "Beta", recencyAt: 9 },
    { threadId: "g1", customGroup: "Gamma", recencyAt: 5 },
  ];
  const ids = (rs) => rs.map((r) => r.threadId);
  const empty = { folders: [], rows: {}, placedAt: {} };
  // Nothing persisted: configured folders first, the rest alphabetically; chats newest first.
  assert.deepEqual(ids(sortRows(rows, empty, ["Gamma"])), ["g1", "a2", "a3", "a1", "b1"]);
  // Folders dragged: Beta, Alpha; Gamma (configured) follows them.
  let order = applyReorder(empty, { kind: "groups", order: ["Beta", "Alpha"] });
  assert.deepEqual(ids(sortRows(rows, order, ["Gamma"])), ["b1", "a2", "a3", "a1", "g1"]);
  // Chats dragged in Alpha at time 10: a1, a2. a3 was not placed and is older, so it goes last:
  // placed chats must stay on the catalog's first page.
  order = applyReorder(order, { kind: "sessions", group: "Alpha", threadIds: ["a1", "a2"] }, 10);
  assert.deepEqual(ids(sortRows(rows, order, [])), ["b1", "a1", "a2", "a3", "g1"]);
  // A chat active after the arrangement goes on top; ISO timestamps work as well.
  const later = [...rows, { threadId: "a4", customGroup: "Alpha", recencyAt: new Date(20).toISOString() }];
  assert.deepEqual(ids(sortRows(later, order, [])), ["b1", "a4", "a1", "a2", "a3", "g1"]);
  // Threads the UI did not send keep their place after the sent ones.
  order = applyReorder(order, { kind: "sessions", group: "Alpha", threadIds: ["a2"] }, 30);
  assert.deepEqual(order.rows.Alpha, ["a2", "a1"]);
  assert.equal(order.placedAt.Alpha, 30);
  assert.throws(() => applyReorder(order, { kind: "other" }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-order-"));
  try {
    const file = path.join(dir, "x", "order.json");
    assert.deepEqual(readOrder(file), empty);
    writeOrder(file, order);
    assert.deepEqual(readOrder(file), order);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("memory sync: Claude Code memory goes one way into the agent of its project folder", async () => {
  const ms = await import("../claude-bridge/memory-sync.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-memsync-"));
  try {
    const claude = path.join(dir, "claude-projects"), root = path.join(dir, "desk");
    const wsA = path.join(dir, "ws", "alpha"), wsMain = path.join(dir, "ws", "main");
    // Claude Code project folders: the encoded name is ambiguous, the real folder is in the session file.
    const project = (name, cwd, files) => {
      const d = path.join(claude, name);
      fs.mkdirSync(path.join(d, "memory"), { recursive: true });
      if (cwd) fs.writeFileSync(path.join(d, "s1.jsonl"), `{"type":"user","cwd":${JSON.stringify(cwd)}}\n`);
      for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(d, "memory", n), t);
    };
    project("-desk-Alpha", path.join(root, "Alpha", "sub"), { "MEMORY.md": "- [Fact one](fact-one.md) — hook\n", "fact-one.md": "one\n", "kept.md": "kept\n", "notes.txt": "x" });
    project("-desk----", path.join(root, "Гамма"), { "MEMORY.md": "- [Shared](shared.md) — g\n", "shared.md": "same\n", "clash.md": "g\n" });
    project("-desk-Beta", path.join(root, "Beta"), { "MEMORY.md": "- [Shared](shared.md) — b\n", "shared.md": "same\n", "clash.md": "b\n" });
    project("-desk-NoSession", null, { "a.md": "a" });
    project("-tmp-x", "/nonexistent-tmp/x", { "a.md": "a" });
    project("-desk-Scratch", "/nonexistent-tmp/desk", { "a.md": "a" });
    project("-elsewhere", path.join(dir, "elsewhere"), { "a.md": "a" });
    // Folder → agent exactly as the tree: projects map, the rest to the default agent.
    const plugin = { projects: { Alpha: "alpha" }, memorySync: { root, claudeProjectsDir: claude } };
    const { agentOf } = ms.projectAgents(plugin);
    assert.deepEqual([agentOf("Alpha"), agentOf("Beta")], ["alpha", "main"]);
    assert.equal(ms.folderOf(path.join(root, "Alpha", "x", "y"), root), "Alpha");
    assert.equal(ms.folderOf(path.join(dir, "Alpha"), root), null);
    // The agent workspace already has a migrated fact that matches and one edited on the OpenClaw side.
    fs.mkdirSync(path.join(wsA, "memory"), { recursive: true });
    fs.writeFileSync(path.join(wsA, "MEMORY.md"), "# Memory index\n\n- [Kept](memory/kept.md) — k\n");
    fs.writeFileSync(path.join(wsA, "memory", "kept.md"), "kept\n");
    const config = { agents: { entries: { alpha: { workspace: wsA }, main: { workspace: wsMain } } },
      plugins: { entries: { "aiwb-claude-bridge": { config: plugin } } } };
    // Fixtures live in the temp folder, which the sync skips as temporary on a real machine.
    const settings = { ...ms.syncSettings(config, { stateDir: path.join(dir, "state") }), tempDirs: ["/nonexistent-tmp"] };
    assert.equal(settings.enabled, false);           // the live sync is off unless switched on

    const kinds = (r) => Object.fromEntries(r.actions.map((a) => [`${a.agentId}:${a.rel}`, a.kind]));
    // Dry run: reports, writes nothing, not even the state.
    let r = await ms.syncOnce(settings, { dryRun: true });
    assert.deepEqual(r.sources.map((s) => `${s.folder}>${s.agentId}`).sort(), ["Alpha>alpha", "Beta>main", "Гамма>main"]);
    assert.deepEqual(r.skipped.map((s) => s.reason).sort(),
      ["not in the Projects tree", "temporary folder", "temporary folder", "working folder unknown (no session file)"]);
    assert.deepEqual(kinds(r), {
      "alpha:memory/claude-code-index.md": "create", "alpha:memory/fact-one.md": "create", "alpha:memory/kept.md": "unchanged",
      "main:memory/claude-code-index.md": "create", "main:memory/clash.md": "conflict", "main:memory/shared.md": "create",
    });
    assert.ok(!fs.existsSync(path.join(wsMain)) && !fs.existsSync(settings.stateFile));

    // Real pass: copies, builds the index next to the facts, never touches the root MEMORY.md.
    r = await ms.syncOnce(settings);
    assert.equal(fs.readFileSync(path.join(wsA, "memory", "fact-one.md"), "utf8"), "one\n");
    assert.equal(fs.readFileSync(path.join(wsA, "MEMORY.md"), "utf8"), "# Memory index\n\n- [Kept](memory/kept.md) — k\n");
    const mainIndex = fs.readFileSync(path.join(wsMain, "memory", "claude-code-index.md"), "utf8");
    assert.match(mainIndex, /## Beta\n\n- \[Shared\]\(shared\.md\) — b\n\n## Гамма\n/);
    assert.ok(!fs.existsSync(path.join(wsMain, "memory", "clash.md")) && !fs.existsSync(path.join(wsA, "memory", "notes.txt")));
    // Prompt text: only lines the agent's own index does not link, with links from the workspace root.
    assert.equal(ms.indexForPrompt(fs.readFileSync(path.join(wsA, "memory", "claude-code-index.md"), "utf8"),
      fs.readFileSync(path.join(wsA, "MEMORY.md"), "utf8")), "## Alpha\n- [Fact one](memory/fact-one.md) — hook");
    assert.equal(ms.indexForPrompt("## X\n- [K](kept.md) — k\n", "- [K](memory/kept.md)"), "");

    // Source changes are carried over; a file edited on the OpenClaw side is a conflict and stays.
    const src = (n) => path.join(claude, "-desk-Alpha", "memory", n);
    fs.writeFileSync(src("fact-one.md"), "one v2\n");
    fs.writeFileSync(src("kept.md"), "kept v2\n");
    fs.writeFileSync(path.join(wsA, "memory", "kept.md"), "edited by the agent\n");
    r = await ms.syncOnce(settings);
    assert.equal(kinds(r)["alpha:memory/fact-one.md"], "update");
    assert.match(r.actions.find((a) => a.rel === "memory/kept.md").reason, /edited on the OpenClaw side/);
    assert.equal(fs.readFileSync(path.join(wsA, "memory", "fact-one.md"), "utf8"), "one v2\n");
    assert.equal(fs.readFileSync(path.join(wsA, "memory", "kept.md"), "utf8"), "edited by the agent\n");
    // A synced file edited later on the OpenClaw side, or deleted there, is left alone too.
    fs.writeFileSync(src("fact-one.md"), "one v3\n");
    fs.writeFileSync(path.join(wsA, "memory", "fact-one.md"), "agent v3\n");
    fs.rmSync(path.join(wsMain, "memory", "shared.md"));
    r = await ms.syncOnce(settings);
    assert.match(r.actions.find((a) => a.rel === "memory/fact-one.md").reason, /edited on the OpenClaw side/);
    assert.match(r.actions.find((a) => a.rel === "memory/shared.md").reason, /deleted on the OpenClaw side/);
    assert.ok(!fs.existsSync(path.join(wsMain, "memory", "shared.md")));
    // Deleting a source fact never deletes the copy.
    fs.rmSync(src("fact-one.md"));
    await ms.syncOnce(settings);
    assert.equal(fs.readFileSync(path.join(wsA, "memory", "fact-one.md"), "utf8"), "agent v3\n");
    assert.match(ms.formatReport(r), /alpha {6}create 0, update 0, unchanged \d+, conflict 2/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("memory sync plan: provenance records and unknown provenance block writes", async () => {
  const { planSync } = await import("../claude-bridge/memory-sync.js");
  const sources = [{ folder: "F", agentId: "a", files: { "x.md": Buffer.from("x"), "claude-code-index.md": Buffer.from("i") } }];
  const plan = (provenance) => planSync({ sources, workspaces: { a: "/w" }, state: {}, readTarget: () => null, provenance }).actions;
  assert.deepEqual(plan(() => false).map((a) => a.kind), ["conflict", "create"]);       // reserved name, then x.md
  assert.match(plan((ws, rel) => rel === "memory/x.md")[1].reason, /provenance record/);
  assert.match(plan(() => null)[1].reason, /unreadable/);
  // First run without state: an existing target that differs is a conflict, not a guess.
  const first = planSync({ sources, workspaces: { a: "/w" }, state: {}, readTarget: () => Buffer.from("other"), provenance: () => false }).actions;
  assert.match(first[1].reason, /differs and was never synced/);
  const { sha256 } = await import("../claude-bridge/memory-sync.js");
  const known = planSync({ sources, workspaces: { a: "/w" }, state: { targets: { [path.join("/w", "memory", "x.md")]: sha256("other") } },
    readTarget: () => Buffer.from("other"), provenance: () => false }).actions;
  assert.equal(known[1].kind, "update");
  const noWs = planSync({ sources, workspaces: {}, state: {}, readTarget: () => null, provenance: () => false }).actions;
  assert.match(noWs[0].reason, /no workspace/);
});

test("projects memory sync: secrets are replaced before copying", async () => {
  const { redactFiles } = await import("../claude-bridge/memory-sync.js");
  let n = 0;
  const files = redactFiles({
    "a.md": Buffer.from("Values are quoted: `SERVICE_PASS='abc123xyz'`, key sk-ant-AAAAAAAAAAAAAAAAAAAA.\n"),
    "b.md": Buffer.from("Nothing secret here: `SERVICE_PASS=<from .env>`, `OTHER_PASS='<from .env>'`.\n"),
    "d.md": Buffer.from("Odd first character: `BANK_PASS='}a:b1c2d3'`.\n"),
    "c.md": Buffer.from("Literal value from .env: plainvalue42\n"),
  }, ["plainvalue42"], (c) => { n += c; });
  assert.equal(files["a.md"].toString(), "Values are quoted: `SERVICE_PASS='‹secret›'`, key ‹secret›.\n");
  assert.equal(files["b.md"].toString(), "Nothing secret here: `SERVICE_PASS=<from .env>`, `OTHER_PASS='<from .env>'`.\n");
  assert.equal(files["d.md"].toString(), "Odd first character: `BANK_PASS='‹secret›'`.\n");
  assert.equal(files["c.md"].toString(), "Literal value from .env: ‹secret›\n");
  assert.equal(n, 4);
});

test("claude bridge rename: old state files move to the new name, never over a newer file", async () => {
  const { migrateStateFile, stateFile, legacyStateFile } = await import("../claude-bridge/legacy.js");
  const ms = await import("../claude-bridge/memory-sync.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-legacy-"));
  try {
    const wb = path.join(dir, "workbench");
    fs.mkdirSync(wb);
    assert.equal(path.basename(stateFile(wb, "order.json")), "aiwb-claude-bridge-order.json");
    // Old file only: moved.
    fs.writeFileSync(legacyStateFile(wb, "order.json"), '{"folders":["B","A"]}');
    assert.equal(migrateStateFile(wb, "order.json"), true);
    assert.equal(fs.readFileSync(stateFile(wb, "order.json"), "utf8"), '{"folders":["B","A"]}');
    assert.ok(!fs.existsSync(legacyStateFile(wb, "order.json")));
    // Both: the new one wins, the old one is left as is (no data deleted).
    fs.writeFileSync(legacyStateFile(wb, "running.json"), "old");
    fs.writeFileSync(stateFile(wb, "running.json"), "new");
    assert.equal(migrateStateFile(wb, "running.json"), false);
    assert.equal(fs.readFileSync(stateFile(wb, "running.json"), "utf8"), "new");
    assert.equal(fs.readFileSync(legacyStateFile(wb, "running.json"), "utf8"), "old");
    // Neither: nothing happens.
    assert.equal(migrateStateFile(wb, "adopted.json"), false);
    assert.ok(!fs.existsSync(stateFile(wb, "adopted.json")));

    // Memory sync: config still under the old id is read; a dry run reads the old state without moving it,
    // a real pass moves it first.
    const config = { plugins: { entries: { "aiwb-projects": { config: { defaultAgent: "solo", memorySync: { root: path.join(dir, "desk"), claudeProjectsDir: path.join(dir, "none") } } } } } };
    const settings = ms.syncSettings(config, { stateDir: dir });
    assert.equal(settings.defaultAgent, "solo");
    assert.equal(settings.stateFile, stateFile(wb, "memory-sync.json"));
    fs.writeFileSync(legacyStateFile(wb, "memory-sync.json"), JSON.stringify({ version: 1, targets: {} }));
    await ms.syncOnce(settings, { dryRun: true });
    assert.ok(fs.existsSync(legacyStateFile(wb, "memory-sync.json")) && !fs.existsSync(settings.stateFile));
    await ms.syncOnce(settings);
    assert.ok(!fs.existsSync(legacyStateFile(wb, "memory-sync.json")) && fs.existsSync(settings.stateFile));
    // The new id wins over the old one.
    config.plugins.entries["aiwb-claude-bridge"] = { config: { defaultAgent: "new" } };
    assert.equal(ms.syncSettings(config, { stateDir: dir }).defaultAgent, "new");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("claude bridge adoption: folder agent, registry, readopt, grants, one pass at a time", async () => {
  const { adoptOnce, missingGrants, serialRunner, ADOPTION_METHODS, GATEWAY_METHODS } = await import("../claude-bridge/adopt.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-adopt-"));
  try {
    const registryFile = path.join(dir, "workbench", "adopted.json");
    fs.mkdirSync(path.dirname(registryFile));
    // "old" was adopted and then deleted in OpenClaw: in the registry, so not a catalog row.
    fs.writeFileSync(registryFile, JSON.stringify({ old: { agentId: "main", sessionKey: "agent:main:catalog-import:old" } }));
    const tree = [{ cliSessionId: "c1", title: "Plan" }, { cliSessionId: "c2", title: "Notes" }, { cliSessionId: "old", title: "Old chat" }];
    const calls = [];
    const request = async (method, params) => {
      calls.push([method, params]);
      if (method === "sessions.catalog.list") {
        const reg = JSON.parse(fs.readFileSync(registryFile, "utf8"));
        const rows = [{ threadId: "s:agent:main:main", sessionKey: "agent:main:main", customGroup: "_no_space", name: "main" },
          { threadId: "c1", customGroup: "Alpha", name: "Plan", cwd: "/d/Alpha" },
          { threadId: "c2", customGroup: "Beta", name: "Notes", cwd: "/d/Beta" },
          ...(reg.old ? [] : [{ threadId: "old", customGroup: "Alpha", name: "Old chat", cwd: "/d/Alpha" }])];
        // Two pages, as the catalog pages them.
        return params.cursors ? { catalogs: [{ hosts: [{ sessions: rows.slice(2) }] }] } : { catalogs: [{ hosts: [{ sessions: rows.slice(0, 2), nextCursor: "2" }] }] };
      }
      if (method === "sessions.catalog.import") {
        if (params.threadId === "c2") throw new Error("source gone");
        return { sessionKey: `agent:${params.agentId}:catalog-import:${params.threadId}` };
      }
      return {};
    };
    const bound = [];
    const bind = async (p) => { bound.push(p); return { sessionKey: p.sessionKey, sessionId: `id-${p.threadId}`, archived: p.threadId === "old" }; };
    const base = { request, bind, adoptedChats: () => [{ threadId: "c9", agentId: "alpha", sessionKey: "agent:alpha:x" }], treeChats: () => tree,
      registryFile, projects: { Alpha: "alpha" }, defaultAgent: "main" };

    const pass = await adoptOnce(base);
    // Alpha → its project agent; Beta has no project → default agent; the failure is reported, not fatal.
    assert.deepEqual([pass.adopted, pass.failed], [1, 1]);
    assert.match(pass.errors[0], /Beta · Notes: source gone/);
    assert.deepEqual(calls.find(([m]) => m === "sessions.catalog.import")[1],
      { catalogId: "claude", hostId: "gateway:local", threadId: "c1", agentId: "alpha", displayName: "Plan" });
    assert.deepEqual(bound, [{ agentId: "alpha", sessionKey: "agent:alpha:catalog-import:c1", threadId: "c1", cwd: "/d/Alpha" }]);
    assert.deepEqual(calls.filter(([m]) => m === "session.visibility.set").map(([, p]) => p), [{ sessionKey: "agent:alpha:catalog-import:c1", visibility: "shared" }]);
    const reg = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    assert.deepEqual(Object.keys(reg).sort(), ["c1", "c9", "old"]);
    assert.ok(!calls.some(([m, p]) => m === "sessions.catalog.import" && p.threadId === "old"));   // deleted: not adopted again

    // Readopt by title: the mark goes, the chat is imported again and its archived session restored.
    calls.length = 0; bound.length = 0;
    const again = await adoptOnce({ ...base, readopt: ["Old chat", "nope"] });
    assert.deepEqual([again.readopt, again.unknown], [["old"], ["nope"]]);
    assert.deepEqual(calls.find(([m]) => m === "sessions.patch")[1], { key: "agent:alpha:catalog-import:old", expectedSessionId: "id-old", archived: false });
    assert.equal(JSON.parse(fs.readFileSync(registryFile, "utf8")).old.agentId, "alpha");

    // Grants: every method, for this plugin only.
    assert.deepEqual(missingGrants("p", {}), ADOPTION_METHODS);
    assert.deepEqual(missingGrants("p", { OPENCLAW_PLUGIN_GATEWAY_METHODS: `x=a;p=${ADOPTION_METHODS.slice(1).join(", ")}` }), ["sessions.catalog.list"]);
    assert.deepEqual(missingGrants("p", { OPENCLAW_PLUGIN_GATEWAY_METHODS: `p=${GATEWAY_METHODS.join(",")}` }), []);

    // Passes never overlap; requests while one waits are coalesced.
    const runner = serialRunner();
    let active = 0, max = 0, count = 0;
    const work = async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 10)); active--; return ++count; };
    const first = runner.request(work);
    await new Promise((r) => setTimeout(r, 1));   // the first pass runs; the next two wait as one
    const results = await Promise.all([first, runner.request(work), runner.request(work), runner.run(work)]);
    assert.equal(max, 1);
    assert.equal(count, 3);
    assert.deepEqual(results, [1, 2, 2, 3]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("claude bridge move: chat goes to the target agent with history, source archived, native chat copied to the target folder", async () => {
  const { moveChat, claudeProjectDir, copyConversation } = await import("../claude-bridge/move.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-move-"));
  try {
    const projectsDir = path.join(dir, "claude-projects"), root = path.join(dir, "desk");
    const alpha = path.join(root, "Alpha"), beta = path.join(root, "Бета");
    fs.mkdirSync(alpha, { recursive: true }); fs.mkdirSync(beta, { recursive: true });
    // As Claude Code names its project folders: ~/.claude/projects/-home-u-claude-desktop---- is "Сад".
    assert.equal(claudeProjectDir("/p", "/home/u/claude-desktop/Сад"), "/p/-home-u-claude-desktop----");
    assert.equal(claudeProjectDir("/p", "/home/u/claude-desktop/_no_space"), "/p/-home-u-claude-desktop--no-space");
    // The conversation the session continues (run by OpenClaw: sdk-cli) lives in Alpha's Claude folder.
    const src = path.join(claudeProjectDir(projectsDir, alpha), "fork-1.jsonl");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    const source = '{"type":"queue-operation","sessionId":"fork-1"}\n{"type":"user","entrypoint":"sdk-cli","sessionId":"fork-1","message":{"role":"user","content":"save fork-1 as a skill"}}\nnot json fork-1\n';
    fs.writeFileSync(src, source);
    const registryFile = path.join(dir, "workbench", "adopted.json");
    const calls = [], bound = [];
    const request = async (method, params) => {
      calls.push([method, params]);
      if (method === "sessions.catalog.import") {
        // The catalog reads the copy: it must exist when the import runs.
        assert.ok(fs.existsSync(path.join(claudeProjectDir(projectsDir, beta), `${params.threadId}.jsonl`)));
        if (params.threadId === "copy-bad") throw new Error("Claude session is unavailable");
        return { sessionKey: `agent:${params.agentId}:catalog-import:${params.threadId}` };
      }
      return {};
    };
    const base = {
      group: "Бета", request, projectsDir, registryFile, newId: () => "copy-1",
      bind: async (p) => { bound.push(p); return { sessionId: "new-id", archived: true }; },
      claudeChat: () => ({ claudeId: "fork-1", chatId: "chat-1", related: ["fork-1", "chat-1", "fork-0"] }),
      transcriptFile: (id) => (id === "fork-1" ? src : null),
      folderCwd: (g) => path.join(root, g), agentOf: (g) => ({ Alpha: "alpha", "Бета": "beta" })[g] || "main",
    };
    const session = { agentId: "alpha", sessionKey: "agent:alpha:catalog-import:chat-1", entry: { sessionId: "old-id" } };
    const row = { threadId: `s:${session.sessionKey}`, sessionKey: session.sessionKey, name: "Plan", customGroup: "Alpha" };

    const moved = await moveChat({ ...base, row, source: session });
    // The source session is named for the Gateway to archive: a plugin may patch only sessions it created.
    assert.deepEqual(moved, { threadId: "s:agent:beta:catalog-import:copy-1", sessionKey: "agent:beta:catalog-import:copy-1",
      archive: { key: session.sessionKey, expectedSessionId: "old-id" } });
    // A copy under a new id in the target folder's Claude Code project: the records carry the new id,
    // anything else is kept as is; the source file is unchanged.
    const copy = fs.readFileSync(path.join(claudeProjectDir(projectsDir, beta), "copy-1.jsonl"), "utf8").split("\n");
    assert.deepEqual(copy.slice(0, 2).map((l) => JSON.parse(l).sessionId), ["copy-1", "copy-1"]);
    assert.equal(JSON.parse(copy[1]).message.content, "save fork-1 as a skill");
    assert.equal(copy[2], "not json fork-1");
    assert.equal(fs.readFileSync(src, "utf8"), source);
    // History: the copy, into the target agent, with the chat's title; bound there, the tree chat as the mark.
    assert.deepEqual(calls[0], ["sessions.catalog.import",
      { catalogId: "claude", hostId: "gateway:local", threadId: "copy-1", agentId: "beta", displayName: "Plan" }]);
    assert.deepEqual(bound, [{ agentId: "beta", sessionKey: moved.sessionKey, threadId: "copy-1", sourceThreadId: "chat-1", cwd: beta }]);
    // A reused archived import is restored, made shared; the plugin patches no other session.
    const patches = calls.filter(([m]) => m === "sessions.patch").map(([, p]) => p);
    assert.deepEqual(patches, [{ key: moved.sessionKey, expectedSessionId: "new-id", archived: false }]);
    assert.ok(calls.some(([m, p]) => m === "session.visibility.set" && p.sessionKey === moved.sessionKey));
    assert.ok(!calls.some(([m]) => /delete/.test(m)));
    // Every chat of the source session stays adopted, now by the target agent.
    const reg = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    assert.deepEqual(Object.keys(reg).sort(), ["chat-1", "copy-1", "fork-0", "fork-1"]);
    assert.equal(reg["chat-1"].agentId, "beta");

    // A chat not adopted yet: copied and adopted straight into the target agent, nothing to archive.
    calls.length = 0; bound.length = 0;
    fs.writeFileSync(path.join(path.dirname(src), "chat-2.jsonl"), '{"sessionId":"chat-2"}\n');
    const plain = await moveChat({ ...base, newId: () => "copy-2", transcriptFile: (id) => path.join(path.dirname(src), `${id}.jsonl`),
      row: { threadId: "chat-2", name: "Notes", customGroup: "Alpha", cwd: alpha } });
    assert.equal(plain.sessionKey, "agent:beta:catalog-import:copy-2");
    assert.deepEqual(bound[0], { agentId: "beta", sessionKey: plain.sessionKey, threadId: "copy-2", sourceThreadId: "chat-2", cwd: beta });
    assert.equal(plain.archive, undefined);

    // A failed import leaves no copy behind and archives nothing.
    calls.length = 0;
    await assert.rejects(moveChat({ ...base, newId: () => "copy-bad", row, source: session }), /unavailable/);
    assert.ok(!fs.existsSync(path.join(claudeProjectDir(projectsDir, beta), "copy-bad.jsonl")));
    assert.ok(!calls.some(([m]) => m === "sessions.patch"));
    // A failed share is retried, then reported: the moved chat must not silently stay a draft (ghost).
    for (const failures of [2, 5]) {
      let shareCalls = 0;
      const warnings = [];
      const flaky = async (method, params) => {
        if (method === "session.visibility.set" && ++shareCalls <= failures) throw new Error("busy");
        return request(method, params);
      };
      const done = await moveChat({ ...base, request: flaky, newId: () => `copy-share-${failures}`, row, source: session,
        warn: (m) => warnings.push(m) });
      assert.equal(done.sessionKey, `agent:beta:catalog-import:copy-share-${failures}`);
      assert.equal(shareCalls, Math.min(failures + 1, 3));
      assert.equal(warnings.length, failures >= 3 ? 1 : 0);
      if (warnings.length) assert.match(warnings[0], /stays a draft.*failed 3 times: busy/);
    }
    // An existing file is never overwritten.
    assert.throws(() => copyConversation(src, path.join(claudeProjectDir(projectsDir, beta), "copy-1.jsonl"), "fork-1", "copy-1"));

    // Refusals: same folder, main chat, a turn in progress, no folder, no transcript; nothing imported.
    calls.length = 0;
    const refuse = (extra, re) => assert.rejects(moveChat({ ...base, row, source: session, ...extra }), re);
    await refuse({ group: "Alpha" }, /already in Alpha/);
    await refuse({ source: { ...session, sessionKey: "agent:alpha:main" } }, /main chat/);
    await refuse({ source: { ...session, sessionKey: "agent:alpha:cron:job-1" } }, /automation/);
    await refuse({ running: () => true }, /answering now/);
    await refuse({ folderCwd: () => path.join(root, "missing") }, /no working folder/);
    await refuse({ transcriptFile: () => null }, /no Claude Code transcript/);
    await refuse({ claudeChat: () => ({}) }, /no Claude Code conversation/);
    await assert.rejects(moveChat({ ...base, row: undefined }), /no such chat/);
    assert.equal(calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("claude bridge tree rows: automations sit in their agent's folder, subagents and per-run records do not", async () => {
  const { isCronKey, isMainKey, isTreeSessionKey } = await import("../claude-bridge/session-keys.js");
  for (const key of ["agent:alpha:main", "agent:alpha:dashboard:1", "agent:alpha:catalog-import:abc", "agent:alpha:cron:job-1"]) {
    assert.ok(isTreeSessionKey(key), key);
  }
  for (const key of ["agent:alpha:subagent:x", "agent:alpha:main:subagent:x", "agent:alpha:cron:job-1:run:r1", undefined]) {
    assert.ok(!isTreeSessionKey(key), String(key));
  }
  assert.ok(isCronKey("agent:alpha:cron:job-1"));
  assert.ok(!isCronKey("agent:alpha:cron:job-1:run:r1"));
  assert.ok(!isCronKey("agent:alpha:main"));
  assert.ok(isMainKey("agent:alpha:main"));
  assert.ok(!isMainKey("agent:alpha:cron:job-1"));
});

test("claude bridge running marks: the file changes only when the set of marked sessions does", async () => {
  const { markRun, readRuns, runSetTracker, MARK_PRUNE_MS } = await import("../claude-bridge/running.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-running-"));
  try {
    const file = path.join(dir, "workbench", "running.json");
    const changed = runSetTracker(file);
    assert.equal(changed(1000), true); // first look: the empty set
    assert.equal(changed(1000), false);
    // Turn start writes; further model calls of the same turn do not, even an hour later.
    assert.equal(markRun(file, "agent:a:x", true, 1000), true);
    assert.equal(changed(1000), true);
    const written = fs.statSync(file).mtimeMs;
    for (const t of [1100, 5000, 3_600_000]) assert.equal(markRun(file, "agent:a:x", true, t), false);
    assert.equal(fs.statSync(file).mtimeMs, written);
    assert.deepEqual(readRuns(file), { "agent:a:x": 1000 });
    // Another session starting is a change.
    assert.equal(markRun(file, "agent:b:y", true, 2000), true);
    assert.equal(changed(2000), true);
    // A long turn keeps its mark (no 30-minute expiry), so its end is still a change the sidebar hears.
    assert.equal(changed(1000 + 2 * 3_600_000), false);
    assert.equal(markRun(file, "agent:c:z", false, 3000), false);   // ending an unmarked session: no write
    assert.equal(markRun(file, "agent:a:x", false, 1000 + 2 * 3_600_000), true);
    assert.equal(changed(1000 + 2 * 3_600_000), true);
    // A mark whose end never came is dropped with the next write after a day.
    fs.writeFileSync(file, JSON.stringify({ old: 0, "agent:a:x": 10 }));
    assert.equal(markRun(file, "agent:a:x", true, MARK_PRUNE_MS + 5), true);
    assert.deepEqual(readRuns(file), { "agent:a:x": 10 });
    // A broken file reads as no marks.
    fs.writeFileSync(file, "{");
    assert.deepEqual(readRuns(file), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("claude bridge running state: the Gateway's live status decides, marks are a hint and the fallback", async () => {
  const { isRunning, liveRunningReader, RUN_HINT_MS, RUN_TTL_MS, LIVE_CACHE_MS, LIVE_RETRY_MS } = await import("../claude-bridge/running.js");
  const runs = { "agent:alpha:long": 0, "agent:alpha:fresh": 100_000 };
  // Live status: a turn running for 40 minutes keeps its spinner; a fresh mark shows it before the
  // Gateway lists the turn; an old mark of a finished turn does not.
  const live = new Set(["agent:alpha:long"]);
  const now = 40 * 60 * 1000;
  assert.equal(isRunning("agent:alpha:long", { runs, live, now }), true);
  assert.equal(isRunning("agent:alpha:fresh", { runs, live, now: 100_000 + RUN_HINT_MS - 1 }), true);
  assert.equal(isRunning("agent:alpha:fresh", { runs, live, now: 100_000 + RUN_HINT_MS }), false);
  assert.equal(isRunning("agent:alpha:gateway-only", { runs, live: new Set(["agent:alpha:gateway-only"]), now }), true);
  // Without live status: marks for at most 30 minutes, as before.
  assert.equal(isRunning("agent:alpha:long", { runs, live: null, now: RUN_TTL_MS - 1 }), true);
  assert.equal(isRunning("agent:alpha:long", { runs, live: null, now: RUN_TTL_MS }), false);

  // The reader asks each agent for its active sessions and keeps only running ones, cached briefly.
  let t = 0;
  const calls = [];
  const request = async (method, params) => {
    calls.push([method, params]);
    return { sessions: params.agentId === "alpha"
      ? [{ key: "agent:alpha:long", status: "running" }, { key: "agent:alpha:q", status: "queued" }]
      : [] };
  };
  const read = liveRunningReader({ request, agentIds: () => ["alpha", "main", "alpha"], now: () => t });
  assert.deepEqual([...(await read())], ["agent:alpha:long"]);
  assert.deepEqual(calls.map(([m, p]) => [m, p.agentId, p.activeOnly]), [["sessions.list", "alpha", true], ["sessions.list", "main", true]]);
  // Automation sessions are folder rows: their live status is asked too.
  assert.ok(calls.every(([, p]) => p.excludeCron !== true));
  await read();
  assert.equal(calls.length, 2);
  t = LIVE_CACHE_MS;
  await read();
  assert.equal(calls.length, 4);
  // Not granted: null (marks decide), and no retry storm.
  let failing = 0;
  const denied = liveRunningReader({ request: async () => { failing += 1; throw new Error("not granted"); }, agentIds: () => ["a"], now: () => t });
  assert.equal(await denied(), null);
  t += LIVE_CACHE_MS * 2;
  assert.equal(await denied(), null);
  assert.equal(failing, 1);
  t += LIVE_RETRY_MS;
  await denied();
  assert.equal(failing, 2);
});

test("claude bridge grants: adoption needs its methods, the live status adds sessions.list", async () => {
  const { ADOPTION_METHODS, GATEWAY_METHODS, STATUS_METHODS, missingGrants } = await import("../claude-bridge/adopt.js");
  assert.deepEqual(GATEWAY_METHODS, [...ADOPTION_METHODS, "sessions.list"]);
  assert.deepEqual(STATUS_METHODS, ["sessions.list"]);
  // An older grant without sessions.list still adopts.
  assert.deepEqual(missingGrants("p", { OPENCLAW_PLUGIN_GATEWAY_METHODS: `p=${ADOPTION_METHODS.join(",")}` }), []);
  assert.deepEqual(missingGrants("p", { OPENCLAW_PLUGIN_GATEWAY_METHODS: `p=${ADOPTION_METHODS.join(",")}` }, STATUS_METHODS), ["sessions.list"]);
});
test("fork settings: the restart wait takes milliseconds above upstream's 5 minutes or unlimited", async () => {
  const { effectiveSettings, summaryLine, validateSettingValue } = await import("../fork-settings/settings.js");
  const name = "OPENCLAW_RESTART_AGENT_RUN_WAIT_MS";
  const row = (raw) => effectiveSettings({ env: raw === undefined ? {} : { [name]: raw } }).find((r) => r.name === name);
  // Unset: upstream behaviour.
  assert.deepEqual([row(undefined).value, row(undefined).source, row(undefined).invalid], [null, "default", undefined]);
  assert.match(summaryLine([row(undefined)]), /RESTART_AGENT_RUN_WAIT_MS=upstream$/);
  // As the fork reads it: unlimited in any case, an integer above 300000; anything else is upstream.
  assert.deepEqual([row("Unlimited").value, row("Unlimited").invalid], ["unlimited", undefined]);
  assert.deepEqual([row("900000").value, row("900000").invalid], [900_000, undefined]);
  for (const raw of ["300000", "1000", "-5", "soon", "1.5"]) assert.deepEqual([row(raw).value, row(raw).invalid], [null, true], raw);
  assert.equal(row(String(30 * 86_400_000)).outOfRange, true);
  assert.deepEqual([row("900000").min, row("900000").max], [300_001, 7 * 86_400_000]);
  // set: unlimited is stored lower-case, milliseconds within range, the rest refused.
  assert.deepEqual(validateSettingValue(name, " UNLIMITED "), { ok: true, raw: "unlimited" });
  assert.deepEqual(validateSettingValue(name, 900000), { ok: true, raw: "900000" });
  assert.deepEqual(validateSettingValue(name, "3600000"), { ok: true, raw: "3600000" });
  for (const value of [300000, "300000", "forever", true, 7 * 86_400_000 + 1]) {
    const checked = validateSettingValue(name, value);
    assert.equal(checked.ok, false, String(value));
    assert.match(checked.error, /unlimited/);
  }
});

test("fork settings: proxy routes and CLI backend proxy validate, and proxy URLs never show", async () => {
  const { changeSetting, effectiveSettings, summaryLine, validateSettingValue } = await import("../fork-settings/settings.js");
  const secretUrl = "http://user:pa55@10.1.2.3:8080";
  // set normalizes hosts and keeps URLs in the stored text (the fork needs them).
  assert.deepEqual(validateSettingValue("OPENCLAW_PROXY_ROUTES", " Example.com, .example.net ,example.org=PROXY; *=direct "),
    { ok: true, raw: "example.com,example.net,example.org=proxy;*=direct" });
  assert.deepEqual(validateSettingValue("OPENCLAW_PROXY_ROUTES", `other.example.com=${secretUrl}`), { ok: true, raw: `other.example.com=${secretUrl}` });
  for (const bad of ["example.com", "example.com=socks5://h:1", "a.com/x=proxy", "*=proxy;*=direct", "", 5]) {
    const checked = validateSettingValue("OPENCLAW_PROXY_ROUTES", bad);
    assert.equal(checked.ok, false, String(bad));
  }
  assert.equal(validateSettingValue("OPENCLAW_PROXY_ROUTES", `bad host=${secretUrl}`).error.includes("pa55"), false);
  assert.deepEqual(validateSettingValue("OPENCLAW_CLI_BACKEND_PROXY", "Claude-CLI=proxy;google-gemini-cli=direct"),
    { ok: true, raw: "claude-cli=proxy;google-gemini-cli=direct" });
  assert.equal(validateSettingValue("OPENCLAW_CLI_BACKEND_PROXY", "a,b=proxy").ok, false);
  assert.equal(validateSettingValue("OPENCLAW_CLI_BACKEND_PROXY", "claude-cli=maybe").ok, false);

  // effective, the log line and set results redact URL targets.
  const env = { OPENCLAW_PROXY_ROUTES: `example.com=${secretUrl};*=direct`, OPENCLAW_CLI_BACKEND_PROXY: `claude-cli=${secretUrl}` };
  const rows = effectiveSettings({ env, configVars: { OPENCLAW_PROXY_ROUTES: "x.com=proxy" } });
  const routes = rows.find((r) => r.name === "OPENCLAW_PROXY_ROUTES");
  assert.equal(routes.value, "example.com=<proxy URL>;*=direct");
  assert.equal(routes.source, "environment");
  assert.equal(routes.configured, "x.com=proxy");
  assert.equal(JSON.stringify(rows).includes("pa55"), false);
  assert.equal(summaryLine(rows).includes("pa55"), false);
  assert.match(summaryLine(rows), /PROXY_ROUTES=example\.com=<proxy URL>;\*=direct \(environment\)/);
  // Unset is upstream; an invalid rule set is ignored by the fork as a whole.
  const unset = effectiveSettings({ env: {} }).find((r) => r.name === "OPENCLAW_PROXY_ROUTES");
  assert.match(summaryLine([unset]), /PROXY_ROUTES=upstream$/);
  const invalid = effectiveSettings({ env: { OPENCLAW_PROXY_ROUTES: `nonsense ${secretUrl}` } }).find((r) => r.name === "OPENCLAW_PROXY_ROUTES");
  assert.deepEqual([invalid.value, invalid.invalid, invalid.raw], ["", true, "<invalid>"]);

  const config = {};
  const mutateConfigFile = async (p) => { await p.mutate(config); return {}; };
  const [ok, result] = await changeSetting({ name: "OPENCLAW_PROXY_ROUTES", value: `example.net=${secretUrl};*=direct` },
    { mutateConfigFile, env: { OPENCLAW_PROXY_ROUTES: `old.com=${secretUrl}` } });
  assert.equal(ok, true);
  assert.equal(config.env.vars.OPENCLAW_PROXY_ROUTES, `example.net=${secretUrl};*=direct`);
  assert.equal(JSON.stringify(result).includes("pa55"), false);
  assert.equal(result.stored, "example.net=<proxy URL>;*=direct");
});

test("claude bridge tree host: published through onHost, so a refresh answered from the Gateway cache still gets it", async () => {
  const { publishHost } = await import("../claude-bridge/catalog-host.js");
  const host = { hostId: "gateway:local", sessions: [{ threadId: "s:agent:main:main", status: "running" }] };
  const published = [];
  assert.equal(publishHost({ onHost: (h) => published.push(h) }, host), host);
  assert.deepEqual(published, [host]);
  // No onHost (older Gateway, direct calls) or a retired list: the host is still returned.
  assert.equal(publishHost({}, host), host);
  assert.equal(publishHost(undefined, host), host);
  assert.equal(publishHost({ onHost: () => { throw new Error("retired"); } }, host), host);
});

test("memory sync: without a configured tree root the sync stays off and nothing maps to a folder", async () => {
  const ms = await import("../claude-bridge/memory-sync.js");
  const on = (memorySync) => ms.syncSettings({ plugins: { entries: { "aiwb-claude-bridge": { config: { memorySync } } } } },
    { stateDir: "/s", home: "/h" });
  assert.equal(on({ enabled: true }).enabled, false);
  assert.equal(on({ enabled: true }).root, null);
  assert.equal(on({ enabled: true, root: "~/projects" }).enabled, true);
  assert.equal(on({ enabled: true, root: "/p" }).root, "/p");
  assert.equal(ms.folderOf("/p/Garden/x", null), null);
});
