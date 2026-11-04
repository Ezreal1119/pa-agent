import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import sharp from 'sharp';

const require = createRequire(import.meta.url), assets = path.resolve('resources/workflows/create-ckd-sop/create-ckd-sop-v3');
const { buildCkdSop } = require(path.join(assets, 'fill_sop_sheet.js'));
const { instructionParagraphs } = require(path.join(assets, 'assembly-template.cjs'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=', 'base64');
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ckd-customer-assembly-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function put(file: string, bytes: string | Buffer) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function source(root: string, id: string, count: number, instructions?: string, bom = 0, tools = 0) {
  const dir = path.join(root, 'processes', id);
  put(path.join(dir, 'metadata.txt'), id);
  put(path.join(dir, 'Operation_Instruction.txt'), instructions ?? Array.from({ length: count }, (_, i) => `操作说明 ${i + 1}. Instruction ${i + 1}.`).join('\n\n'));
  for (let i = count; i >= 1; i--) put(path.join(dir, `Operation_Photos/p${i}-detail.png`), png);
  put(path.join(dir, 'Bill_of_Materials.jsonl'), Array.from({ length: bom }, (_, i) => JSON.stringify({ index: String(i + 1), partno: `PN-${i + 1}`, qty: i + 1, spec: `Spec-${i + 1}` })).join('\n'));
  put(path.join(dir, 'Tools.jsonl'), Array.from({ length: tools }, (_, i) => JSON.stringify({ index: String(i + 1), name: `Tool-${i + 1}`, qty: i + 2, specs: `TS-${i + 1}` })).join('\n'));
  put(path.join(dir, 'Previous_Station_Check.txt'), '检查来料。Inspect parts.');
  put(path.join(dir, 'Self_Check.txt'), '检查完成品。Check finished parts.');
  return dir;
}
async function generate(root: string, ids: string[], language = 'English') {
  const output = path.join(root, `${language}-${ids.join('-').slice(0, 60)}.xlsx`);
  const result = await buildCkdSop({ output, projectDir: path.join(root, 'processes'), projectName: 'P', documentNo: 'D-001', sopName: 'Assembly', author: 'Cover! "Author"', processList: ids, sopType: 'assemble', templateLanguage: language });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(output); return { result, workbook, output };
}
const height = (sheet: ExcelJS.Worksheet, last: number) => Array.from({ length: last }, (_, i) => sheet.getRow(i + 1).height || 30).reduce((a, b) => a + b, 0);
function validReferences(workbook: ExcelJS.Workbook) {
  for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
    const formula = (cell.value as ExcelJS.CellFormulaValue)?.formula;
    if (!formula) return;
    assert.ok(!/#REF!|\[\d+\]/u.test(formula), formula);
    for (const match of formula.replace(/"(?:[^"]|"")*"/gu, '').matchAll(/'((?:[^']|'')+)'!/gu)) assert.ok(workbook.getWorksheet(match[1]!.replace(/''/gu, "'")), formula);
  }));
}

test('customer Assembly uses bilingual 1/2/4-cell sheets, ordered captions, logos and working metadata without changing assets', async t => {
  const root = fixture(t), names = ['assemble-sop-template.xlsx', 'urovo-sop-template.xlsx', 'urovo-sop-template-zh.xlsx'];
  const before = names.map(name => hash(fs.readFileSync(path.join(assets, name))));
  for (const language of ['中文', 'English']) for (const count of [1, 2, 3, 4]) {
    const id = `step-${count}`, dir = source(root, id, count); put(path.join(dir, 'Previous_Station_Check_Photo.png'), png);
    // Formats and filenames stay compatible with task-level cropping/review.
    if (count === 2) { fs.rmSync(path.join(dir, 'Operation_Photos/p2-detail.png')); put(path.join(dir, 'Operation_Photos/P2-detail.JPG'), await sharp({ create: { width: 120, height: 80, channels: 3, background: '#aabbcc' } }).jpeg().toBuffer()); }
    const { result, workbook, output } = await generate(root, [id], language), sheet = workbook.worksheets[2]!;
    assert.equal(result.sheetCount, 3); assert.deepEqual(result.warnings, []);
    assert.deepEqual(workbook.worksheets.slice(0, 2).map(s => s.name), language === '中文' ? ['封面', '排位图'] : ['Cover', 'Workstation Layout Chart']);
    assert.equal(sheet.pageSetup.printArea, 'A1:V36'); assert.equal(sheet.pageSetup.fitToHeight, 1);
    const captions = count === 1 ? ['G30'] : count === 2 ? ['G30', 'O30'] : ['G19', 'O19', 'G34', 'O34'];
    for (const [i, cell] of captions.entries()) assert.equal(sheet.getCell(cell).value, i < count ? `操作说明 ${i + 1}. Instruction ${i + 1}.` : null);
    assert.equal(sheet.getCell('G7').value, null, 'Old shared instruction anchor is empty');
    assert.equal(sheet.getCell('A23').value, '检查来料。Inspect parts.'); assert.equal(sheet.getCell('A31').value, '检查完成品。Check finished parts.');
    const images = sheet.getImages(); assert.equal(images.length, count + 3);
    assert.equal(images.filter(image => image.range.ext && !image.range.br).length, 2, 'Both one-cell header images survive cloning');
    for (let i = 0; i < count; i++) {
      const anchor = images[2 + i]!.range.tl;
      assert.ok(anchor.nativeCol >= (i % 2 === 1 && count > 1 ? 14 : 6));
      assert.ok(anchor.nativeRow >= (count > 2 && i >= 2 ? 20 : 5));
    }
    const cover = workbook.worksheets[0]!, chart = workbook.worksheets[1]!;
    assert.equal(cover.getCell('D4').value, 1); assert.equal((chart.getCell('F2').value as ExcelJS.CellFormulaValue).result, 1);
    assert.equal(chart.getCell('C2').value, 'P'); assert.equal(chart.getCell('D7').value, id); assert.equal(chart.getCell('A8').value, null);
    assert.equal(cover.getCell(language === '中文' ? 'A22' : 'A26').value, `${language === '中文' ? '编制人：' : 'Author: '}Cover! "Author"`);
    assert.equal((sheet.getCell('U36').value as ExcelJS.CellFormulaValue).result, language === '中文' ? '页数：1/1' : 'Page: 1/1');
    assert.equal((sheet.getCell('S3').value as ExcelJS.CellFormulaValue).result, language === '中文' ? '标准工时：30 秒' : 'Std. Time: 30 s');
    validReferences(workbook);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    assert.ok(!Object.keys(zip.files).some(name => name.startsWith('xl/externalLinks/')));
  }
  assert.deepEqual(names.map(name => hash(fs.readFileSync(path.join(assets, name)))), before);
});

test('Assembly paragraphs keep numbered step continuations, blank-line blocks, CRLF and plain line ordering', () => {
  assert.deepEqual(instructionParagraphs('\uFEFF1. Install.\r\nKeep this detail.\r\n2. Verify.'), ['1. Install.\nKeep this detail.', '2. Verify.']);
  assert.deepEqual(instructionParagraphs('安装\n细节\n\n检查\n细节'), ['安装\n细节', '检查\n细节']);
  assert.deepEqual(instructionParagraphs('安装\n检查'), ['安装', '检查']);
  assert.deepEqual(instructionParagraphs('1. Install the connector.\nKeep the locking tab facing up.'), ['1. Install the connector.\nKeep the locking tab facing up.']);
});

test('Assembly count mismatches and missing photos retain text without putting unrelated instructions under another image', async t => {
  const root = fixture(t);
  source(root, 'extra-text', 1, '第一段\n\n第二段\n\n第三段');
  source(root, 'extra-photos', 4, '第一段\n\n第二段'); source(root, 'no-photos', 0, '只有说明，没有图片。');
  const { result, workbook } = await generate(root, ['extra-text', 'extra-photos', 'no-photos'], '中文');
  assert.equal(workbook.getWorksheet('extra-text')!.getCell('G30').value, '第一段');
  const missing = workbook.getWorksheet('extra-photos')!;
  assert.equal(missing.getCell('G19').value, '第一段'); assert.equal(missing.getCell('O19').value, '第二段');
  assert.equal(missing.getCell('G34').value, null); assert.equal(missing.getCell('O34').value, null);
  assert.equal(workbook.getWorksheet('no-photos')!.getCell('G30').value, '只有说明，没有图片。');
  const unmatched = workbook.worksheets.find(sheet => sheet.getCell('A2').value === '未配图操作说明')!;
  assert.ok(unmatched); assert.equal(unmatched.getCell('A5').value, '第二段\n\n第三段');
  assert.equal(result.warnings.length, 3); assert.equal(workbook.worksheets[0]!.getCell('D4').value, 4);
  validReferences(workbook);
});

test('Assembly expands readable tables inside their original physical height and retains every overflow record', async t => {
  const root = fixture(t), original = new ExcelJS.Workbook(); await original.xlsx.readFile(path.join(assets, 'assemble-sop-template.xlsx'));
  for (const language of ['中文', 'English']) for (const [count, bomCount, toolCount] of [[1, 8, 6], [2, 9, 7], [4, 8, 6], [4, 46, 46]]) {
    const id = `tables-${count}-${bomCount}-${toolCount}`, dir = source(root, id, count!, undefined, bomCount!, toolCount!);
    put(path.join(dir, 'Previous_Station_Check_Photo.png'), png);
    const { workbook } = await generate(root, [id], language), sheet = workbook.worksheets[2]!;
    const merges = sheet.model.merges as string[], previousMerge = merges.find(merge => /^A\d+:F\d+$/u.test(merge) && sheet.getCell(merge.split(':')[0]!).value === '检查来料。Inspect parts.')!;
    const previousRow = Number(previousMerge.match(/\d+/u)![0]);
    const toolHeader = Array.from({ length: sheet.rowCount }, (_, i) => i + 1).find(row => sheet.getCell(row, 2).value === (language === '中文' ? '描述' : 'Name'))!;
    const footer = Number(sheet.pageSetup.printArea!.match(/V(\d+)$/u)![1]);
    assert.ok(Math.abs(height(sheet, footer) - height(original.getWorksheet(language === '中文' ? `${count === 1 ? 1 : count === 2 ? 2 : 4}格模版` : `${count === 1 ? 1 : count === 2 ? 2 : 4} compartments Template${count === 4 ? '' : ' '}`)!, 36)) < .001);
    for (const [prefix, first, last, kind] of [['PN', 8, toolHeader - 2, language === '中文' ? '物料续表' : 'BOM Continuation'], ['Tool', toolHeader + 1, previousRow - 2, language === '中文' ? '工具续表' : 'Tools Continuation']] as const) {
      const entries: [unknown, unknown][] = [];
      for (let row = first; row <= last; row++) if (sheet.getCell(row, 2).value) entries.push([sheet.getCell(row, 2).value, sheet.getCell(row, 4).value]);
      for (const appendix of workbook.worksheets.filter(s => s.name.startsWith(kind))) for (let row = 5; row < appendix.rowCount; row++) entries.push([appendix.getCell(row, 2).value, appendix.getCell(row, 3).value]);
      assert.deepEqual(entries, Array.from({ length: prefix === 'PN' ? bomCount! : toolCount! }, (_, i) => [`${prefix}-${i + 1}`, i + (prefix === 'PN' ? 1 : 2)]));
    }
    assert.equal(sheet.getImages().length, count! + 3); validReferences(workbook);
  }
});

test('Assembly long operation/check text remains complete on bounded continuation pages with consistent page counts', async t => {
  const root = fixture(t), long = '检查连接器和固定位置，确保方向正确。Repeat this operation carefully. '.repeat(300);
  const dir = source(root, 'long-text', 4, [long, '第二段', '第三段', '第四段'].join('\n\n'));
  put(path.join(dir, 'Previous_Station_Check_Photo.png'), png); put(path.join(dir, 'Previous_Station_Check.txt'), long); put(path.join(dir, 'Self_Check.txt'), long);
  const { result, workbook } = await generate(root, ['long-text'], '中文');
  for (const label of ['操作说明 1', '前站检查', '自检']) {
    const chunks = workbook.worksheets.filter(sheet => sheet.getCell('A2').value === label);
    assert.ok(chunks.length > 1); assert.equal(chunks.map(sheet => sheet.getCell('A5').value).join(''), long.trim());
    assert.ok(chunks.every(sheet => sheet.getRow(5).height === 660 && sheet.pageSetup.fitToHeight === 1));
  }
  assert.equal(result.warnings.length, 3);
  const pageCount = workbook.worksheets.length - 2; assert.equal(workbook.worksheets[0]!.getCell('D4').value, pageCount);
  for (const [index, sheet] of workbook.worksheets.slice(2).entries()) assert.equal((sheet.getCell(index ? 'A6' : 'U36').value as ExcelJS.CellFormulaValue).result, `页数：${index + 1}/${pageCount}`);
  validReferences(workbook);
});

test('Assembly borrows bounded photo height for normal four-cell captions while preserving tables and the page height', async t => {
  const root = fixture(t), text = 'Install the connector in the indicated position. Check orientation and secure the cable. 按图安装连接器，确认方向并固定线材。';
  source(root, 'caption-fit', 4, Array.from({ length: 4 }, (_, i) => `${i + 1}. ${text}`).join('\n\n'), 8, 6);
  const { result, workbook } = await generate(root, ['caption-fit'], '中文'), sheet = workbook.worksheets[2]!;
  assert.deepEqual(result.warnings, []); assert.equal(result.sheetCount, 3);
  const template = new ExcelJS.Workbook(); await template.xlsx.readFile(path.join(assets, 'assemble-sop-template.xlsx'));
  const original = template.getWorksheet('4格模版')!;
  const map = (row: number) => row + (row >= 15 ? 1 : 0) + (row >= 22 ? 1 : 0);
  assert.ok(Math.abs(height(sheet, map(36)) - height(original, 36)) < .001);
  for (const [first, last, caption] of [[6, 18, 19], [21, 33, 34]]) {
    const span = (s: ExcelJS.Worksheet, a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => s.getRow(a + i).height || 30).reduce((a, b) => a + b, 0);
    assert.ok(span(sheet, map(first!), map(last!)) >= span(original, first!, last!) * .8 - .001);
    assert.ok(sheet.getRow(map(caption!)).height! > original.getRow(caption!).height!);
  }
  for (const [i, cell] of ['G20', 'O20', 'G36', 'O36'].entries()) assert.equal(sheet.getCell(cell).value, `${i + 1}. ${text}`);
  assert.equal(sheet.getCell('B15').value, 'PN-8'); assert.equal(sheet.getCell('B23').value, 'Tool-6');
});

test('Assembly workflow materializes the effective source and selects the new default template in both generation stages', async t => {
  const root = fixture(t), sourceDir = source(root, 'step', 2), library = path.join(root, 'library'), ckd = path.join(library, 'ckd-library-v2');
  const workspaceRoot = path.join(root, 'workspace'), sessionWorkspace = path.join(workspaceRoot, 'session'); fs.mkdirSync(sessionWorkspace, { recursive: true });
  put(path.join(ckd, 'product_lib/P/project.json'), JSON.stringify({ version: 1, projectId: 'P', displayName: 'P', aliases: [] }));
  put(path.join(ckd, 'product_lib/P/assemble/sops.json'), JSON.stringify({ version: 1, sops: [] }));
  fs.mkdirSync(path.join(ckd, 'processes_lib/assemble'), { recursive: true });
  fs.cpSync(sourceDir, path.join(ckd, 'product_lib/P/assemble/processes/step'), { recursive: true });
  const paths = { libraryRoots: [library], workspaceRoot, sessionWorkspace };
  const catalogInput = path.join(root, 'catalog-input.json'), catalogOutput = path.join(root, 'catalog-output.json');
  put(catalogInput, JSON.stringify({ inputs: { sopType: 'assemble' }, paths }));
  const catalogRun = spawnSync(process.execPath, [path.join(assets, '../build-ckd-catalog-v3/index.cjs'), '--input', catalogInput, '--output', catalogOutput], { encoding: 'utf8' });
  assert.equal(catalogRun.status, 0, catalogRun.stderr);
  const catalog = JSON.parse(fs.readFileSync(catalogOutput, 'utf8')).output;
  const { run } = require(path.join(assets, 'index.cjs'));
  const envelope = { paths, workflow: { runId: 'customer-assembly' }, inputs: {
    normalizedInputs: { sopType: 'assemble', projectName: 'P', documentNumber: 'D', safeDocumentNumber: 'D', sopName: 'Assembly', author: 'A', processList: ['step'], templateLanguage: 'English' },
    projectMatchResult: { matchedProjectId: 'P', matchedProjectName: 'P' },
    processPlans: [{ requestedProcess: 'step', resolvedProcessId: 'step', resolvedProcessName: 'step', status: 'direct', confidence: 1 }],
    catalogPath: catalog.catalogPath, catalogHash: catalog.catalogHash,
  } };
  const direct = await run(structuredClone(envelope)), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(workspaceRoot, direct.output.documentPath));
  assert.equal(workbook.worksheets[2]!.getCell('G30').value, '操作说明 1. Instruction 1.');
  fs.rmSync(path.join(workspaceRoot, direct.output.documentPath));
  const prepared = await run({ ...structuredClone(envelope), workflow: { runId: 'prepared-assembly' }, inputs: { ...structuredClone(envelope.inputs), prepareImagesOnly: true } });
  const crop = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#224466' } }).png().toBuffer();
  put(path.join(sessionWorkspace, 'crop.png'), crop);
  const final = await run({ paths, workflow: { runId: 'prepared-assembly' }, inputs: { ...structuredClone(envelope.inputs), preparedGeneration: prepared.output, imageOverrides: [{ file: 'crop.png', target: 'step/Operation_Photos/p2-detail.png', hash: hash(crop) }] } });
  const after = new ExcelJS.Workbook(); await after.xlsx.readFile(path.join(workspaceRoot, final.output.documentPath));
  assert.equal(after.worksheets[2]!.getCell('O30').value, '操作说明 2. Instruction 2.');
  const imageId = after.worksheets[2]!.getImages()[3]!.imageId;
  assert.equal(hash(after.getImage(Number(imageId)).buffer as Buffer), hash(crop));
  assert.equal(hash(fs.readFileSync(path.join(sourceDir, 'Operation_Photos/p2-detail.png'))), hash(png));
  validReferences(after);
});

test('Assembly chart supports 30 ordered processes, reserved sheet names and no stale template rows', async t => {
  const root = fixture(t), ids = ['封面', '排位图', ...Array.from({ length: 28 }, (_, i) => `工序${i + 3}`)];
  for (const id of ids) source(root, id, 1);
  const { workbook } = await generate(root, ids, '中文'), chart = workbook.worksheets[1]!;
  assert.equal(workbook.worksheets.length, 32); assert.equal(chart.getCell('A36').value, 'OP030'); assert.equal(chart.getCell('D36').value, ids[29]);
  assert.equal(chart.getCell('A37').value, '编制人：Cover! "Author"'); assert.equal(chart.pageSetup.printArea, 'A1:F37');
  assert.equal(workbook.worksheets[2]!.name, '封面 (2)'); assert.equal(workbook.worksheets[3]!.name, '排位图 (2)');
  assert.equal((workbook.worksheets[31]!.getCell('E3').value as ExcelJS.CellFormulaValue).formula, "'排位图'!D36");
  validReferences(workbook);
});

test('Assembly preserves accidental extra photos on additional pages rather than truncating them', async t => {
  const root = fixture(t); source(root, 'five', 5);
  const { result, workbook } = await generate(root, ['five']);
  assert.equal(workbook.worksheets.length, 4); assert.equal(result.warnings.length, 1);
  assert.equal(workbook.worksheets[2]!.getImages().length, 6); assert.equal(workbook.worksheets[3]!.getImages().length, 3);
  assert.equal(workbook.worksheets[3]!.getCell('G30').value, '操作说明 5. Instruction 5.');
  assert.equal(workbook.worksheets[1]!.getCell('A8').value, null, 'A photo continuation is not a second workstation');
  assert.equal(workbook.worksheets[0]!.getCell('D4').value, 2); validReferences(workbook);
});

test('Assembly generator CLI selects the customer workbook without --template', async t => {
  const root = fixture(t); source(root, 'cli', 1); const output = path.join(root, 'cli.xlsx');
  const cli = spawnSync(process.execPath, [path.join(assets, 'fill_sop_sheet.js'), '--output', output, '--project-dir', path.join(root, 'processes'), '--project-name', 'P', '--document-no', 'D', '--sop-name', 'S', '--author', 'Author: A', '--process-list', '["cli"]', '--sop-type', 'assemble', '--template-language', '中文'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(output);
  assert.equal(workbook.worksheets[1]!.name, '排位图'); assert.equal(workbook.worksheets[2]!.getCell('G30').value, '操作说明 1. Instruction 1.');
  assert.equal(workbook.worksheets[0]!.getCell('A22').value, '编制人：A');
  assert.equal(workbook.worksheets[2]!.getCell('A36').value, '编制人：A');
});
