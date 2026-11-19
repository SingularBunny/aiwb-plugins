import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJson, writeFileAtomic, writeJson } from "../claude-bridge/state-file.js";

test("state files are written whole, through a temporary file that does not stay behind", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-state-"));
  const file = path.join(dir, "nested", "state.json");
  assert.deepEqual(readJson(file), {});
  assert.deepEqual(readJson(file, []), []);
  writeJson(file, { a: 1 });
  assert.equal(readFileSync(file, "utf8"), '{\n  "a": 1\n}\n');
  writeJson(file, { b: [2] }, { compact: true });
  assert.equal(readFileSync(file, "utf8"), '{"b":[2]}');
  assert.deepEqual(readJson(file), { b: [2] });
  assert.deepEqual(readdirSync(path.dirname(file)), ["state.json"]);
});

test("a failed write leaves the old file and no temporary file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-state-"));
  const file = path.join(dir, "state.json");
  writeJson(file, { kept: true });
  assert.throws(() => writeFileAtomic(path.join(file, "below-a-file.json"), "x"));
  assert.deepEqual(readJson(file), { kept: true });
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});
