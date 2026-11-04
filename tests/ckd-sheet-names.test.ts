import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';

const require = createRequire(import.meta.url);
const { buildCkdSop } = require(path.resolve('resources/workflows/create-ckd-sop/create-ckd-sop-v3/fill_sop_sheet.js'));

test('long translated process names keep their trailing step numbers in distinct Excel tabs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ckd-sheet-names-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'processes');
  const titles = ['Heating platform usage instructions 1', 'Heating platform usage instructions 2'];
  for (const [index, title] of titles.entries()) {
    const folder = path.join(projectDir, `step-${index + 1}`);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'metadata.txt'), `${title}\n`);
    await fs.writeFile(path.join(folder, 'operation_steps.txt'), `Instruction ${index + 1}\n`);
  }
  const output = path.join(root, 'english.xlsx');
  await buildCkdSop({ output, projectDir, projectName: 'SQ610', documentNo: '1', sopName: 'S', author: 'A', processList: ['step-1', 'step-2'], sopType: 'assembly_test', templateLanguage: 'English' });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  const sheets = workbook.worksheets.slice(2);
  assert.deepEqual(sheets.map(sheet => sheet.name), ['Heating platform usage instru 1', 'Heating platform usage instru 2']);
  assert.ok(sheets.every(sheet => sheet.name.length <= 31));
  assert.deepEqual(sheets.map(sheet => (sheet.getCell('E3').value as ExcelJS.CellFormulaValue).result), titles);
  assert.deepEqual(titles.map((_, index) => workbook.getWorksheet('Production Arrange Chart')!.getCell(`C${index + 8}`).value), titles);

  await fs.writeFile(path.join(projectDir, 'step-2', 'metadata.txt'), `${titles[0]}\n`);
  await assert.rejects(
    buildCkdSop({ output: path.join(root, 'duplicate.xlsx'), projectDir, projectName: 'SQ610', documentNo: '1', sopName: 'S', author: 'A', processList: ['step-1', 'step-2'], sopType: 'assembly_test', templateLanguage: 'English' }),
    /Duplicate sheet name/u
  );
});
