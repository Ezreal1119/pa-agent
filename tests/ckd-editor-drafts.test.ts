import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createProject, listProcesses, pendingDrafts, publishDrafts, readProcess, saveProcess } from '../src/ckd/editor-library.js';
import { CkdWorkflow } from '../src/ckd/service.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckd-drafts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'ckd-library-v2');
  fs.mkdirSync(path.join(library, 'processes_lib', 'assemble'), { recursive: true });
  return { root, library };
}

function buildCatalog(root: string, libraryRoot: string): { processes: unknown[]; warnings: string[] } {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const input = path.join(root, 'catalog-input.json'), output = path.join(root, 'catalog-output.json');
  write(input, JSON.stringify({ inputs: { sopType: 'assemble', templateLanguage: '中文' }, paths: { libraryRoots: [libraryRoot], sessionWorkspace: workspace, workspaceRoot: workspace } }));
  const script = path.resolve('resources/workflows/create-ckd-sop/build-ckd-catalog-v3/index.cjs');
  const run = spawnSync(process.execPath, [script, '--input', input, '--output', output], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(path.join(workspace, result.output.catalogPath), 'utf8'));
  return { processes: catalog.processes ?? [], warnings: result.output.warnings ?? [] };
}

test('drafts are excluded from the catalog and must pass validation before publishing', t => {
  const { root, library } = fixture(t);
  createProject(library, { projectId: 'P1', displayName: 'P1' });

  // 空草稿：允许保存，但不进 catalog，出表前会被拦。
  saveProcess(library, { projectId: 'P1', language: '中文', order: 1, metadata: '', paragraphs: ['还没配图的步骤'], photos: [] }, { draft: true });
  const listed = listProcesses(library, { projectId: 'P1', language: '中文' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.draft, true);
  assert.equal(readProcess(library, { projectId: 'P1', language: '中文', order: 1 }).draft, true);
  assert.equal(pendingDrafts(library).length, 1);
  assert.equal(buildCatalog(root, path.dirname(library)).processes.length, 0, '草稿不能进入 catalog');
  const service = new CkdWorkflow({ libraryPath: library, dataDir: path.join(root, 'data') });
  assert.throws(() => service.create({ projectName: 'P1', documentNumber: 'D-1', sopName: 'S', author: 'A', sopType: 'assemble', templateLanguage: '中文' }), /草稿/u, '有草稿时不允许出表');

  // 缺工序名：发布失败，草稿保留。
  let result = publishDrafts(library, { projectId: 'P1', language: '中文' });
  assert.equal(result.published.length, 0);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0]!.message, /工序名为空/u);
  assert.equal(listProcesses(library, { projectId: 'P1', language: '中文' })[0]!.draft, true);

  // 补齐后发布成功，草稿标记消失，catalog 能看到。
  // 先验证「坑位只有文字、没有图」会被拦。
  saveProcess(library, { projectId: 'P1', language: '中文', order: 1, metadata: '上料', paragraphs: ['第一段', '第二段'], photos: [null, { dataUrl: PNG }] }, { draft: true });
  result = publishDrafts(library, { projectId: 'P1', language: '中文' });
  assert.equal(result.published.length, 0);
  assert.match(result.issues[0]!.message, /还没有配图/u);

  // 两个坑位都配图后发布成功。
  saveProcess(library, { projectId: 'P1', language: '中文', order: 1, metadata: '上料', paragraphs: ['取料', '放入治具'], photos: [{ dataUrl: PNG }, { dataUrl: PNG }] }, { draft: true });
  result = publishDrafts(library, { projectId: 'P1', language: '中文' });
  assert.deepEqual(result.issues, []);
  assert.equal(result.published.length, 1);
  assert.equal(listProcesses(library, { projectId: 'P1', language: '中文' })[0]!.draft, false);
  assert.equal(pendingDrafts(library).length, 0);
  const catalog = buildCatalog(root, path.dirname(library));
  assert.equal(catalog.processes.length, 1);
});
