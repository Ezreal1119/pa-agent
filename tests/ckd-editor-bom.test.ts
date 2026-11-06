import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createProject } from '../src/ckd/editor-library.js';
import { readBom, saveBom, deleteBom } from '../src/ckd/editor-bom.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckd-bom-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'ckd-library-v2');
  fs.mkdirSync(path.join(library, 'product_lib'), { recursive: true });
  createProject(library, { projectId: 'P1', displayName: 'P1' });
  return { root, library };
}

async function workbookBytes(rows: unknown[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('BOM');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test('BOM import finds headers, keeps text part numbers and stores the original file', async t => {
  const { library } = fixture(t);
  const data = await workbookBytes([
    ['某某项目 BOM', '', ''],
    ['料号', '名称', '用量'],
    ['A-001', '外壳', 1],
    ['0002', '螺丝 M2', 5],
    ['', '', ''],
    ['B-003', '排线', ''],
  ]);
  const info = await saveBom(library, { projectId: 'P1', fileName: '测试BOM.xlsx', data });
  assert.equal(info.rows.length, 3);
  assert.deepEqual(info.rows[0], { partno: 'A-001', name: '外壳', qty: 1 });
  assert.deepEqual(info.rows[1], { partno: '0002', name: '螺丝 M2', qty: 5 }, '前导零按文本保留');
  assert.equal(info.rows[2]!.qty, null);

  const stored = readBom(library, 'P1');
  assert.equal(stored?.fileName, '测试BOM.xlsx');
  assert.equal(stored?.rows.length, 3);
  assert.ok(fs.existsSync(path.join(library, 'product_lib', 'P1', 'assemble', 'bom.json')));
  assert.ok(fs.existsSync(path.join(library, 'product_lib', 'P1', 'assemble', 'bom.import.xlsx')));

  deleteBom(library, 'P1');
  assert.equal(readBom(library, 'P1'), null);
});

test('BOM import rejects unknown formats and missing part-number columns', async t => {
  const { library } = fixture(t);
  await assert.rejects(saveBom(library, { projectId: 'P1', fileName: 'bom.xls', data: Buffer.from('x') }), /只支持/u);
  const noHeader = await workbookBytes([['名称', '用量'], ['外壳', 1]]);
  await assert.rejects(saveBom(library, { projectId: 'P1', fileName: 'bom.xlsx', data: noHeader }), /没找到料号列/u);
  await assert.rejects(saveBom(library, { projectId: 'NOPE', fileName: 'bom.xlsx', data: noHeader }), /不存在/u);
});
