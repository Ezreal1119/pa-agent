import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const workflowRoot = path.resolve('resources/workflows/create-ckd-sop');
const generatorRoot = path.join(workflowRoot, 'create-ckd-sop-v3');
const { buildCkdSop, resolveInstructionPhotos } = require(path.join(generatorRoot, 'fill_sop_sheet.js'));
const { materializeProcess } = require(path.join(generatorRoot, 'index.cjs'));

async function put(file: string, bytes: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

test('catalog, materialization and Excel retain mixed JPEG and PNG process photos', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ckd-jpeg-photos-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const ckdRoot = path.join(libraryRoot, 'ckd-library-v2');
  const processFolder = path.join(ckdRoot, 'product_lib/TARGET/assembly_test/processes/step');
  const workspaceRoot = path.join(root, 'workspace');
  const sessionWorkspace = path.join(workspaceRoot, 'session');
  await put(path.join(ckdRoot, 'product_lib/TARGET/project.json'), JSON.stringify({ version: 1, projectId: 'TARGET', displayName: 'Target', aliases: ['TARGET'] }));
  await put(path.join(ckdRoot, 'product_lib/TARGET/assembly_test/sops.json'), JSON.stringify({ version: 1, sops: [] }));
  await fs.mkdir(path.join(ckdRoot, 'processes_lib/assembly_test'), { recursive: true });
  await put(path.join(processFolder, 'metadata.txt'), 'Mixed photos\n');
  await put(path.join(processFolder, 'operation_steps.txt'), 'Inspect both photos.\n');
  const jpg = await sharp({ create: { width: 3024, height: 4032, channels: 3, background: '#abcdef' } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#123456' } }).png().toBuffer();
  await put(path.join(processFolder, 'photos/p1.jpg'), jpg);
  await put(path.join(processFolder, 'photos/p2.png'), png);
  await fs.mkdir(sessionWorkspace, { recursive: true });

  const input = path.join(root, 'catalog-input.json'), output = path.join(root, 'catalog-output.json');
  await put(input, JSON.stringify({ inputs: { sopType: 'assembly_test' }, paths: { libraryRoots: [libraryRoot], workspaceRoot, sessionWorkspace } }));
  const catalog = spawnSync(process.execPath, [path.join(workflowRoot, 'build-ckd-catalog-v3/index.cjs'), '--input', input, '--output', output], { encoding: 'utf8' });
  assert.equal(catalog.status, 0, catalog.stderr);
  const record = JSON.parse(await fs.readFile(output, 'utf8')).output.catalogDetails.processes[0];
  assert.deepEqual(record.projectLayers[0].assets.instructionPhotos.map((photo: { fileName: string }) => photo.fileName), ['p1.jpg', 'p2.png']);

  const effectiveRoot = path.join(sessionWorkspace, 'effective');
  await fs.mkdir(effectiveRoot, { recursive: true });
  const materialized = materializeProcess({ ckdLibraryRoot: ckdRoot, effectiveRoot, targetProjectId: 'TARGET', processRecord: record, processName: 'Mixed photos' });
  assert.deepEqual(resolveInstructionPhotos(materialized.folder).map((photo: { fileName: string }) => photo.fileName), ['p1.jpg', 'p2.png']);
  const xlsx = path.join(root, 'mixed.xlsx');
  await buildCkdSop({ output: xlsx, projectDir: effectiveRoot, projectName: 'Target', documentNo: 'D', sopName: 'S', author: 'A', processList: ['step'], sopType: 'assembly_test', templateLanguage: 'English' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsx);
  const images = workbook.getWorksheet('Mixed photos')!.getImages().filter(image => image.range.tl.nativeCol >= 6 && image.range.tl.nativeRow >= 16);
  assert.equal(images.length, 2);
  const zip = await JSZip.loadAsync(await fs.readFile(xlsx));
  const media = Object.keys(zip.files).filter(name => /^xl\/media\/image\d+\.(?:jpeg|png)$/u.test(name));
  assert.ok(media.some(name => name.endsWith('.jpeg')));
  assert.ok(media.some(name => name.endsWith('.png')));

  await put(path.join(materialized.folder, 'photos/p1.png'), png);
  assert.throws(() => resolveInstructionPhotos(materialized.folder), /duplicated/u);
});
