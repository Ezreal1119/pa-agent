import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateCkdLibrary } from "../src/ckd/library-validation.js";
import { jsonErrorLocation } from "../src/ckd/json-syntax.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ckd-validation-"));
  const library = path.join(root, "library"); fs.mkdirSync(library);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative: string, value: string | Buffer) => { const file = path.join(library, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
  return { root, library, write };
}

test("syntax scan reports every malformed JSONL row and later JSON files without changing data", async t => {
  const { library, write } = fixture(t);
  const malformed = '  {"qty":}\r\n\r\n{"qty":}\r\n{"qty":}\r\n';
  const source = write("product_lib/GPOS710/pcba_test/processes/MCU/tools.jsonl", malformed);
  write("z.json", '{\n  "qty":\n}');
  write("valid.jsonl", '\n{"qty":null}\n{"qty":""}\n{"qty":"1"}\n');
  write("ignored.txt", "not JSON"); write(".hidden/broken.json", "{");
  const report = await validateCkdLibrary(library);
  assert.equal(report.valid, false); assert.equal(report.scannedFiles, 3);
  assert.equal(report.checkedEntries, 7); assert.equal(report.invalidFiles, 2); assert.equal(report.errorCount, 4);
  const rows = report.errors.filter(error => error.code === "invalid_jsonl");
  assert.deepEqual(rows.map(error => [error.line, error.column]), [[1, 10], [3, 8], [4, 8]]);
  assert.deepEqual([report.errors.at(-1)!.line, report.errors.at(-1)!.column], [3, 1]);
  assert.equal(fs.readFileSync(source, "utf8"), malformed);
  assert.deepEqual(fs.readdirSync(library).sort(), [".hidden", "ignored.txt", "product_lib", "valid.jsonl", "z.json"]);
});

test("type and language filters isolate process data, retain shared metadata and include archives only in a full scan", async t => {
  const { library, write } = fixture(t);
  for (const file of ["product_lib/P/project.json", "product_lib/P/pcba_test/sops.json", "product_lib/P/pcba_test/processes/A/tools.jsonl", "product_lib/P/pcba_test/CN_process/A/tools.jsonl", "processes_lib/pcba_test/common/A/tools.jsonl", "processes_lib/pcba_test/CN_process/A/tools.jsonl", "product_lib/P/assembly_test/processes/A/tools.jsonl", "archive/broken.json"]) write(file, "{");
  const english = await validateCkdLibrary(library, { sopType: "pcba_test", templateLanguage: "English" });
  assert.equal(english.errorCount, 4); assert.ok(english.errors.every(error => !/CN_process|assembly_test|archive/u.test(error.file)));
  const chinese = await validateCkdLibrary(library, { sopType: "pcba_test", templateLanguage: "中文" });
  assert.equal(chinese.errorCount, 4); assert.ok(chinese.errors.some(error => error.file.includes("CN_process")));
  assert.equal((await validateCkdLibrary(library)).errorCount, 8);
});

test("invalid UTF-8 and symlinks are reported and never followed; blank JSONL and BOM behavior match parsing", async t => {
  const { root, library, write } = fixture(t);
  write("bad.json", Buffer.from([0xff])); write("bom.json", '\uFEFF{}'); write("bom.jsonl", '\uFEFF{}\r\n  \r\n');
  const external = path.join(root, "outside.json"); fs.writeFileSync(external, "secret outside");
  fs.symlinkSync(external, path.join(library, "linked.json")); fs.symlinkSync(root, path.join(library, "linked-dir"));
  const report = await validateCkdLibrary(library);
  assert.equal(report.scannedFiles, 3); assert.equal(report.checkedEntries, 2);
  assert.deepEqual(report.errors.map(error => error.code).sort(), ["invalid_json", "invalid_utf8", "symlink", "symlink"]);
  assert.equal(fs.readFileSync(external, "utf8"), "secret outside");
});

test("invalid options and unavailable roots fail explicitly; fallback positions cover errors lacking native offsets", async t => {
  const { library } = fixture(t);
  await assert.rejects(validateCkdLibrary(library, { sopType: "bad" as "all" }));
  await assert.rejects(validateCkdLibrary(path.join(library, "missing")), { code: "ENOENT" });
  for (const [text, line, column] of [['{"qty":}', 1, 8], ['{\n"a": [1,\n]}', 3, 1], ['{"a": 1', 1, 8], ['{"a":"\\q"}', 1, 8], ['{} extra', 1, 4]] as const) {
    assert.throws(() => JSON.parse(text)); assert.deepEqual(jsonErrorLocation(text, new Error("no position")), { line, column });
  }
});
