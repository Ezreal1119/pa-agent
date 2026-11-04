import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import ExcelJS from 'exceljs';

const require = createRequire(import.meta.url);
const assets = path.resolve('resources/workflows/create-ckd-sop/create-ckd-sop-v3');
const { buildCkdSop } = require(path.join(assets, 'fill_sop_sheet.js'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=', 'base64');
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ckd-assembly-rows-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(file: string, value: string | Buffer) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function source(root: string, id: string, bomCount: number, toolsCount: number, longCheck = false) {
  const folder = path.join(root, 'processes', id);
  put(path.join(folder, 'metadata.txt'), id);
  put(path.join(folder, 'Operation_Instruction.txt'), 'Install and verify. 安装并检查。');
  put(path.join(folder, 'Previous_Station_Check.txt'), longCheck ? 'Inspect incoming parts. 检查来料。\n'.repeat(100) : 'Inspect incoming parts. 检查来料。');
  put(path.join(folder, 'Self_Check.txt'), longCheck ? 'Verify assembled parts. 检查完成品。\n'.repeat(100) : 'Verify assembled parts. 检查完成品。');
  put(path.join(folder, 'Bill_of_Materials.jsonl'), Array.from({ length: bomCount }, (_, i) => JSON.stringify({ index: `${i + 1}`, partno: `PN-${i + 1}`, qty: i + 1, spec: `Spec-${i + 1}` })).join('\n'));
  put(path.join(folder, 'Tools.jsonl'), Array.from({ length: toolsCount }, (_, i) => JSON.stringify({ index: `${i + 1}`, name: `Tool-${i + 1}`, qty: i + 2, specs: `TS-${i + 1}` })).join('\n'));
  put(path.join(folder, 'Operation_Photos/p1.png'), png);
  put(path.join(folder, 'Operation_Photos/p2.png'), png);
  put(path.join(folder, 'Previous_Station_Check_Photo.png'), png);
  return folder;
}
async function generate(root: string, ids: string[], language = 'English') {
  const output = path.join(root, `${language}-${ids.join('-')}.xlsx`);
  const result = await buildCkdSop({ output, projectDir: path.join(root, 'processes'), projectName: 'P', documentNo: 'D', sopName: 'S', author: 'Author', processList: ids, sopType: 'assemble', templateLanguage: language });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(output);
  return { result, workbook };
}
const height = (sheet: ExcelJS.Worksheet, first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => sheet.getRow(first + i).height || 30).reduce((a, b) => a + b, 0);

test('Assembly original page expands either or both tables in both languages without changing page height, check content or header images', async t => {
  const root = fixture(t);
  const templates = ['urovo-sop-template-zh.xlsx', 'urovo-sop-template.xlsx'];
  const before = templates.map(name => fs.readFileSync(path.join(assets, name)));
  for (const language of ['English', '中文']) {
    let headerImages: unknown;
    for (const [bom, tools] of [[0, 0], [5, 5], [6, 5], [5, 6], [6, 6], [8, 8]]) {
      const id = `step-${bom}-${tools}`; const folder = source(root, id, bom!, tools!);
      const { result, workbook } = await generate(root, [id], language);
      assert.equal(result.sheetCount, 3); assert.deepEqual(result.warnings, []);
      const sheet = workbook.worksheets[2]!;
      const bomExtra = Math.max(0, bom! - 5), toolsExtra = Math.max(0, tools! - 5), extra = bomExtra + toolsExtra;
      assert.equal(sheet.pageSetup.printArea, `A1:U${38 + extra}`);
      assert.ok(Math.abs(height(sheet, 1, 38 + extra) - 1140) < .001, 'Physical page height remains unchanged');
      assert.equal(sheet.getCell(`A${21 + extra}`).value, fs.readFileSync(path.join(folder, 'Previous_Station_Check.txt'), 'utf8'));
      assert.equal(sheet.getCell(`A${32 + extra}`).value, fs.readFileSync(path.join(folder, 'Self_Check.txt'), 'utf8'));
      assert.equal(sheet.getCell(`A${38 + extra}`).value, language === '中文' ? '编制人：Author' : 'Author: Author');
      assert.match((sheet.getCell(`A${37 + extra}`).value as ExcelJS.CellFormulaValue).result as string, /1\/1/u);
      assert.equal(height(sheet, 27 + extra, 30 + extra), 120, 'Previous check photo keeps its original space');
      assert.ok(height(sheet, 16 + bomExtra, 30 + extra) >= 360 - .001, 'Operation photos keep at least 80% of their original space');
      for (let i = 0; i < bom!; i++) {
        const row = 8 + i;
        assert.equal(sheet.getCell(row, 2).value, `PN-${i + 1}`); assert.equal(sheet.getCell(row, 4).value, i + 1);
        assert.equal(sheet.getCell(row, 3).master.address, `B${row}`); assert.equal(sheet.getCell(row, 6).master.address, `E${row}`);
        assert.equal(sheet.getCell(row, 2).font.size, 11); assert.ok(sheet.getCell(row, 2).border.bottom);
      }
      for (let i = 0; i < tools!; i++) { const row = 15 + bomExtra + i; assert.equal(sheet.getCell(row, 2).value, `Tool-${i + 1}`); assert.equal(sheet.getCell(row, 4).value, i + 2); }
      const images = sheet.getImages(); assert.equal(images.length, 5);
      const headers = images.slice(0, 2).map(image => [image.range.tl, image.range.br].map(anchor => [anchor.nativeRow, anchor.nativeRowOff, anchor.nativeCol, anchor.nativeColOff]));
      if (!headerImages) headerImages = headers; else assert.deepEqual(headers, headerImages);
      for (const image of images.slice(2, 4)) {
        assert.ok(image.range.tl.nativeRow >= 15 + bomExtra);
        assert.ok(image.range.br.nativeRow <= 30 + extra);
      }
      assert.ok(images[4]!.range.tl.nativeRow >= 26 + extra); assert.ok(images[4]!.range.br.nativeRow <= 30 + extra);
    }
  }
  templates.forEach((name, i) => assert.deepEqual(fs.readFileSync(path.join(assets, name)), before[i]));
});

test('Assembly preserves long check text and retains all excess material and tool entries in continuation pages', async t => {
  const root = fixture(t), folder = source(root, 'long', 46, 46, true);
  const { result, workbook } = await generate(root, ['long']);
  const sheet = workbook.worksheets[2]!;
  assert.equal(sheet.pageSetup.printArea, 'A1:U38');
  assert.equal(sheet.getCell('A21').value, fs.readFileSync(path.join(folder, 'Previous_Station_Check.txt'), 'utf8').trim());
  assert.equal(sheet.getCell('A32').value, fs.readFileSync(path.join(folder, 'Self_Check.txt'), 'utf8').trim());
  assert.equal(height(sheet, 21, 30), 300); assert.equal(height(sheet, 32, 36), 150);
  assert.equal(result.warnings.length, 2); assert.equal(workbook.worksheets[0]!.getCell('D4').value, 7);
  for (const [kind, prefix] of [['BOM', 'PN'], ['Tools', 'Tool']]) {
    const entries = [1, 2, 3, 4, 5].map(i => `${prefix}-${i}`);
    for (const appendix of workbook.worksheets.slice(3).filter(s => s.name.startsWith(kind!))) for (let row = 5; row < appendix.rowCount; row++) entries.push(String(appendix.getCell(row, 2).value));
    assert.deepEqual(entries, Array.from({ length: 46 }, (_, i) => `${prefix}-${i + 1}`));
  }
});

test('Assembly expansion is per process and never mutates the template used for the next page', async t => {
  const root = fixture(t); source(root, 'expanded', 8, 8); source(root, 'standard', 5, 5);
  const { workbook } = await generate(root, ['expanded', 'standard']);
  const first = workbook.worksheets[2]!, second = workbook.worksheets[3]!;
  assert.equal(first.pageSetup.printArea, 'A1:U44'); assert.equal(second.pageSetup.printArea, 'A1:U38');
  assert.equal(second.getCell('B12').value, 'PN-5'); assert.equal(second.getCell('B19').value, 'Tool-5');
  assert.equal((first.getCell('A43').value as ExcelJS.CellFormulaValue).result, 'Page: 1/2');
  assert.equal((second.getCell('A37').value as ExcelJS.CellFormulaValue).result, 'Page: 2/2');
});
