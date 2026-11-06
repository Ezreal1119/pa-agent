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
    ['BOM Hierarchy', 'UROVO PN', 'GERTECPN', '物料名称', 'Material Name', 'Material Specification', 'Material Property', 'Type', 'Total Usage for GPOS710 (EE)', 'Usage for GPOS710 (EE)', 'Position Sign for GPOS710', 'Part Number'],
    ['0', '', '', '', 'Virtual Components', 'GPOS710', 'Virtual', 'Order QTY.--->', '', '5000', '', ''],
    ['2', '3.01.01.10209', 'URV05250', 'PCB', 'PCB', 'T3366F 8-Layer', 'Outsourcing', 'Standard Part', '5000', '1', '', 'VENDOR-001'],
    ['2', '3.01.15.10583', 'URV05260', '贴片电容', 'Capacitor', 'Cap/0201', 'Outsourcing', 'Standard Part', '5000', '1', 'R5005', 'VENDOR-002'],
    ['2', '3.01.15.10585', 'URV05270', '贴片电容', 'Capacitor', 'Cap/0201', 'Outsourcing', 'Standard Part', '15000', '3', 'M5018,C3320', 'VENDOR-003'],
    ['2', '', '', '', '', '', '', '', '', '5000', '', ''],
    ['2', '3.01.15.10746', 'URV05270', '贴片电容', 'Capacitor', 'Cap/C0603', 'Outsourcing', 'Alternative Part', '15000', '3', 'M5018', 'VENDOR-004'],
  ]);
  const info = await saveBom(library, { projectId: 'P1', fileName: '测试BOM.xlsx', data });
  assert.equal(info.rows.length, 4, '虚拟行和空料号行应跳过');
  assert.deepEqual(info.rows[0], { partno: '3.01.01.10209', name: 'PCB', qty: 1 }, '取 UROVO PN，不能取 Part Number');
  assert.deepEqual(info.rows[1], { partno: '3.01.15.10583', name: '贴片电容', qty: 1 });
  assert.equal(info.rows[2]!.qty, 3, '取单机用量列，不能取 Total Usage');
  assert.equal(info.rows[3]!.partno, '3.01.15.10746');

  const stored = readBom(library, 'P1');
  assert.equal(stored?.fileName, '测试BOM.xlsx');
  assert.equal(stored?.rows.length, 4);
  assert.ok(fs.existsSync(path.join(library, 'product_lib', 'P1', 'assemble', 'bom.json')));
  assert.ok(fs.existsSync(path.join(library, 'product_lib', 'P1', 'assemble', 'bom.import.xlsx')));

  deleteBom(library, 'P1');
  assert.equal(readBom(library, 'P1'), null);
});

test('BOM import accepts Chinese headers and numeric part numbers', async t => {
  const { library } = fixture(t);
  const data = await workbookBytes([
    ['物料料号', '物料名称', '用量'],
    [3010110209, 'PCB', 1],
    [3010115105, '贴片电容', 2],
  ]);
  const info = await saveBom(library, { projectId: 'P1', fileName: '中文表头.xlsx', data });
  assert.equal(info.rows.length, 2);
  assert.deepEqual(info.rows[0], { partno: '3010110209', name: 'PCB', qty: 1 }, '数字料号按显示文本保留');
  assert.deepEqual(info.rows[1], { partno: '3010115105', name: '贴片电容', qty: 2 });

  // 「厂商料号」不能被当成我方料号。
  const vendorOnly = await workbookBytes([['厂商料号', '名称', '用量'], ['V-001', 'PCB', 1]]);
  await assert.rejects(saveBom(library, { projectId: 'P1', fileName: '厂商.xlsx', data: vendorOnly }), /没找到料号列/u);
});

test('BOM import rejects unknown formats and missing part-number columns', async t => {
  const { library } = fixture(t);
  await assert.rejects(saveBom(library, { projectId: 'P1', fileName: 'bom.xls', data: Buffer.from('x') }), /只支持/u);
  const noHeader = await workbookBytes([['名称', '用量'], ['外壳', 1]]);
  await assert.rejects(saveBom(library, { projectId: 'P1', fileName: 'bom.xlsx', data: noHeader }), /没找到料号列/u);
  await assert.rejects(saveBom(library, { projectId: 'NOPE', fileName: 'bom.xlsx', data: noHeader }), /不存在/u);
});
