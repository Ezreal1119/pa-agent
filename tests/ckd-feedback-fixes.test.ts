import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { assessmentSeen } from './helpers/image-assessment.js';
import { compositionScore } from '../src/ckd/image-framing.js';
import { ImageAssessmentChecker, ASSESSMENT_VERSION, DEFAULT_POLICY, parseAssessment, assessScore, readAssessmentCalibration, ASSESSMENT_SCORE_VERSION, weightsHash } from '../src/ckd/image-assessment.js';
import { ImageAnalysisProtocolError } from '../src/ckd/image-analysis-failure.js';
import { sha256 } from '../src/ckd/scripts.js';
import { atomicJson } from '../src/ckd/store.js';
const require = createRequire(import.meta.url);
const generator = require(path.resolve('resources/workflows/create-ckd-sop/create-ckd-sop-v3/fill_sop_sheet.js'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=', 'base64');
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ckd-feedback-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function put(file: string, value: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }

test('multi-view primaries are valid without relaxing enum, box, subject count or single-view validation', () => {
  for (const layout of ['collage', 'scene'] as const) {
    const data = structuredClone(assessmentSeen); data.framing.layout = layout;
    data.framing.subjects[0]!.box = { left: .02, top: .1, right: .48, bottom: .9 };
    data.framing.subjects.push({ ...data.framing.subjects[0]!, name: '第二幅教学视图', box: { left: .52, top: .1, right: .98, bottom: .9 } });
    const before = JSON.stringify(data); assert.equal(parseAssessment(data).framing.subjects.length, 2); assert.equal(JSON.stringify(data), before);
    data.framing.layout = 'single'; assert.throws(() => parseAssessment(data), /primary/u);
    data.framing.layout = layout; data.framing.subjects[1]!.box.left = .99; assert.throws(() => parseAssessment(data), /box/u);
  }
  const noPrimary = structuredClone(assessmentSeen); noPrimary.framing.layout = 'collage'; noPrimary.framing.subjects[0]!.role = 'supporting'; assert.throws(() => parseAssessment(noPrimary), /primary/u);
  assert.throws(() => parseAssessment({ ...assessmentSeen, imageType: 'collage' }), /imageType/u);
});

test('composition uses estimated unrelated empty space, not centering or severity labels', () => {
  const data = structuredClone(assessmentSeen); data.framing.wastedSpaceSeverity = 0;
  data.framing.subjects[0]!.box = { left: .02, top: .1, right: .48, bottom: .9 };
  for (const layout of ['collage', 'scene'] as const) {
    data.framing.layout = layout;
    const score = compositionScore(data.framing, data.boundingBox, 30, .25);
    assert.equal(score.parts.find(p => p.key === 'space')!.score, 12);
    assert.equal(score.positionPenaltyApplied, false);
  }
  data.framing.layout = 'single'; const single = compositionScore(data.framing, data.boundingBox, 30, .25);
  assert.equal(single.parts.find(p => p.key === 'space')!.score, 12); assert.equal(single.score, 30);
  data.framing.layout = 'collage'; data.framing.wastedSpaceSeverity = 3;
  assert.equal(compositionScore(data.framing, data.boundingBox, 30, .6).parts.find(p => p.key === 'space')!.score, 6);
  data.unrelatedBackgroundRatio = .9; assert.ok(assessScore(data, 'fake', DEFAULT_POLICY).appliedCaps.some(c => c.key === 'excessiveWhitespace'));
});

test('primary layout union never expands to incidental supporting hands or cables', () => {
  const data = structuredClone(assessmentSeen); data.framing.layout = 'collage';
  data.framing.subjects.push({ name: '指示手', role: 'supporting', box: { left: 0, top: 0, right: 1, bottom: 1 }, details: '辅助指示' });
  assert.deepEqual(compositionScore(data.framing, data.boundingBox, 30, data.unrelatedBackgroundRatio).layoutBox, data.framing.subjects[0]!.box);
  data.framing.subjects.push({ name: '第二幅教学视图', role: 'primary', box: { left: .8, top: .2, right: .95, bottom: .9 }, details: '另一侧接口' });
  assert.deepEqual(compositionScore(data.framing, data.boundingBox, 30, data.unrelatedBackgroundRatio).layoutBox, { left: .25, top: .2, right: .95, bottom: .9 });
});

test('displayed evidence distinguishes the selected tier, conservative margin and actual cap; cached model observations stay byte-identical', async t => {
  const root = fixture(t); let calls = 0;
  const first = structuredClone(assessmentSeen), review = structuredClone(assessmentSeen);
  first.metrics.clarity.comment = '画面清晰度极高'; review.metrics.clarity.level = 3; review.metrics.clarity.comment = '整体清晰，局部细节尚需核对';
  const checker = new ImageAssessmentChecker(root, { model: { async complete() { return { text: JSON.stringify(++calls === 1 ? first : review), model: 'fake' }; } } });
  const result = await checker.check(png), clarity = result.components.find(c => c.key === 'clarity')!;
  assert.equal(clarity.score, 18.33); assert.match(clarity.comment, /评级 3\/4/u); assert.match(clarity.comment, /保守计分余量/u);
  assert.ok(!clarity.comment.includes('极高')); assert.match(clarity.modelComment, /极高/u);
  assert.match(result.reason, /程序总分/u); assert.match(result.reason, /清晰度评级 3\/4/u); assert.ok(!result.reason.includes('极高'));
  assert.ok(!result.appliedCaps.find(c => c.key === 'fineDetailUnverified')!.reason.includes('分辨率与瑕疵评级'));
  assert.equal(result.conservativeReview.first.metrics.clarity.comment, first.metrics.clarity.comment);
  const file = path.join(checker.root, sha256(png) + '.json'), before = fs.readFileSync(file);
  await checker.check(png); assert.equal(calls, 2); assert.deepEqual(fs.readFileSync(file), before);
});

test('old unique-primary failures get one bounded recovery; unrelated zero fallbacks remain cached across the numeric revision', async t => {
  const root = fixture(t); let calls = 0;
  const data = structuredClone(assessmentSeen); data.framing.layout = 'collage'; data.framing.subjects.push({ ...data.framing.subjects[0]!, name: '另一子图' });
  const checker = new ImageAssessmentChecker(root, { model: { async complete() { calls++; return { text: JSON.stringify(data), model: 'fake' }; } } });
  const failure = checker.recordFailure(png, new ImageAnalysisProtocolError('Exactly one primary subject is required. (after 3 format attempts)'));
  const file = path.join(root, 'ckd/image-quality-failures', ASSESSMENT_VERSION, failure.imageHash + '.json');
  delete failure.outputContractVersion; failure.scoreVersion = 'seven-numeric-v6'; atomicJson(file, failure);
  assert.ok((await checker.checkWithFallback(png)).result); assert.equal(calls, 2);
  assert.equal((await checker.checkWithFallback(png)).result!.cached, true); assert.equal(calls, 2);
  const other = Buffer.concat([png, Buffer.from('other')]); const unrelated = checker.recordFailure(other, new ImageAnalysisProtocolError('data must be object'));
  unrelated.scoreVersion = 'seven-numeric-v6'; delete unrelated.outputContractVersion;
  const otherFile = path.join(root, 'ckd/image-quality-failures', ASSESSMENT_VERSION, unrelated.imageHash + '.json'); atomicJson(otherFile, unrelated);
  const before = fs.readFileSync(otherFile); assert.equal((await checker.checkWithFallback(other)).fallback!.score, 0);
  assert.equal(calls, 2); assert.deepEqual(fs.readFileSync(otherFile), before);
  const stillInvalid = Buffer.concat([png, Buffer.from('single-view')]);
  const old = checker.recordFailure(stillInvalid, new ImageAnalysisProtocolError('Exactly one primary subject is required.'));
  old.scoreVersion = 'seven-numeric-v6'; delete old.outputContractVersion;
  atomicJson(path.join(root, 'ckd/image-quality-failures', ASSESSMENT_VERSION, old.imageHash + '.json'), old);
  let retries = 0; const bad = structuredClone(data); bad.framing.layout = 'single';
  const failing = new ImageAssessmentChecker(root, { model: { async complete() { retries++; return { text: JSON.stringify(bad), model: 'fake' }; } } });
  assert.equal((await failing.checkWithFallback(stillInvalid)).fallback!.score, 0); assert.equal(retries, 3);
  assert.equal((await failing.checkWithFallback(stillInvalid)).fallback!.cached, true); assert.equal(retries, 3);
});

test('numeric-rule change excludes stale calibration without deleting it', t => {
  const root = fixture(t), file = path.join(root, 'ckd/image-calibration/seven-dimensions/active.json');
  const calibration = { id: 'old', analysisVersion: ASSESSMENT_VERSION, scoreVersion: 'seven-numeric-v6', analysisModel: 'fake', createdAt: new Date().toISOString(), sampleCount: 1, mode: 'offset_only', weightsHash: weightsHash(DEFAULT_POLICY), parameters: { bias: -20 }, samples: [{ imageHash: 'hash', humanScore: 70, data: assessmentSeen }] };
  atomicJson(file, calibration); const before = fs.readFileSync(file);
  assert.equal(readAssessmentCalibration(root), undefined); assert.deepEqual(fs.readFileSync(file), before);
  calibration.scoreVersion = ASSESSMENT_SCORE_VERSION; atomicJson(file, calibration); assert.equal(readAssessmentCalibration(root)!.id, 'old');
});

test('Assembly expands the process table, retains overflow in continuation pages, and localizes cached formulas safely', async t => {
  const root = fixture(t), project = path.join(root, 'processes'), folder = path.join(project, 'step');
  put(path.join(folder, 'metadata.txt'), '封面'); put(path.join(folder, 'Operation_Instruction.txt'), '安装并检查。');
  const bom = Array.from({ length: 46 }, (_, i) => ({ index: String(i + 1), partno: `PN-${i + 1}`, qty: i + 1, spec: `Spec-${i + 1}` }));
  put(path.join(folder, 'Bill_of_Materials.jsonl'), bom.map(r => JSON.stringify(r)).join('\n'));
  put(path.join(folder, 'Tools.jsonl'), Array.from({ length: 6 }, (_, i) => JSON.stringify({ index: String(i + 1), name: `Tool-${i + 1}`, qty: 1, specs: `S-${i + 1}` })).join('\n'));
  const source = fs.readFileSync(path.join(folder, 'Bill_of_Materials.jsonl'));
  for (const language of ['中文', 'English']) {
    const output = path.join(root, language + '.xlsx');
    const generated = await generator.buildCkdSop({ output, projectDir: project, projectName: 'P', documentNo: 'D', sopName: 'S', author: 'Cover! "Workstation Layout Chart"', processList: ['step'], sopType: 'assemble', templateLanguage: language });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(output);
    assert.equal(generated.sheetCount, 5); assert.equal(generated.warnings.length, 1); assert.ok(!generated.warnings.join('').includes('only the first'));
    const cover = workbook.getWorksheet(language === '中文' ? '封面' : 'Cover')!, chart = workbook.getWorksheet(language === '中文' ? '工站安排表' : 'Workstation Layout Chart')!;
    assert.equal(cover.getCell('D4').value, 3); assert.equal((chart.getCell('F2').value as ExcelJS.CellFormulaValue).result, 3);
    // User strings in formulas stay unchanged, even if they resemble sheet references.
    assert.match((cover.getCell('C7').value as ExcelJS.CellFormulaValue).formula, /Cover! ""Workstation Layout Chart""/u);
    const process = workbook.worksheets[2]!; assert.equal(process.name, language === '中文' ? '封面 (2)' : '封面');
    assert.equal(process.getCell('B8').value, 'PN-1'); assert.equal(process.getCell('B12').value, 'PN-5');
    assert.equal(process.getCell('B18').value, 'PN-11'); assert.equal(process.getCell('B26').value, 'Tool-6');
    assert.equal(process.pageSetup.printArea, 'A1:U45'); assert.equal(process.getCell('G7').value, '安装并检查。');
    assert.equal((process.getCell('A44').value as ExcelJS.CellFormulaValue).result, language === '中文' ? '页数：1/3' : 'Page: 1/3');
    const appendices = workbook.worksheets.slice(3), materialRows = appendices.flatMap(s => Array.from({ length: s.rowCount - 5 }, (_, i) => [s.getCell(i + 5, 1).value, s.getCell(i + 5, 2).value, s.getCell(i + 5, 3).value, s.getCell(i + 5, 4).value]));
    assert.deepEqual(materialRows, bom.slice(11).map(r => [r.index, r.partno, r.qty, r.spec]));
    for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
      const formula = (cell.value as ExcelJS.CellFormulaValue)?.formula;
      if (formula && language === '中文') {
        const references = formula.replace(/"(?:[^"]|"")*"/gu, '');
        assert.ok(!references.includes('Cover!')); assert.ok(!references.includes("'Workstation Layout Chart'!"));
      }
    }));
  }
  assert.deepEqual(fs.readFileSync(path.join(folder, 'Bill_of_Materials.jsonl')), source);
});

test('Chinese generated workbooks for every SOP type have localized front sheets with valid links; English stays unchanged', async t => {
  const root = fixture(t), project = path.join(root, 'processes'), folder = path.join(project, 'step');
  put(path.join(folder, 'metadata.txt'), '检查'); put(path.join(folder, 'Operation_Instruction.txt'), '检查零件。'); put(path.join(folder, 'operation_steps.txt'), '检查零件。');
  for (const sopType of ['assemble', 'assembly_test', 'pcba_test', 'aging_test', 'factory_test']) {
    const output = path.join(root, sopType + '.xlsx');
    await generator.buildCkdSop({ output, projectDir: project, projectName: 'P', documentNo: 'D', sopName: 'S', author: 'A', processList: ['step'], sopType, templateLanguage: '中文' });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(output);
    assert.equal(workbook.worksheets[0]!.name, '封面'); assert.equal(workbook.worksheets[1]!.name, sopType === 'assemble' ? '工站安排表' : '生产安排表');
    assert.equal(workbook.getWorksheet('Cover'), undefined);
    for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
      const formula = (cell.value as ExcelJS.CellFormulaValue)?.formula;
      if (formula) for (const match of formula.matchAll(/'([^']+)'!/gu)) assert.ok(workbook.getWorksheet(match[1]!), `Missing sheet in ${formula}`);
    }));
  }
});
