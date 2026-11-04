// Migrated from patrick-agent CKD V3 tests; all generated data lives in temporary directories.
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const workflowRoot = path.resolve("resources/workflows/create-ckd-sop");
const generatorRoot = path.join(workflowRoot, "create-ckd-sop-v3");
function runScript(scriptPath: string, inputPath: string, outputPath: string): Record<string, any> {
  const result = spawnSync(process.execPath, [scriptPath, "--input", inputPath, "--output", outputPath], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(fsSync.readFileSync(outputPath, "utf8"));
}

async function write(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

test("v3 output filename uses Project name, SOP name, and local date", () => {
  const { buildOutputFileName } = require(path.join(generatorRoot, "index.cjs"));
  assert.equal(
    buildOutputFileName("GPOS 710 / Pilot", "设备激活 SOP: V3", new Date(2026, 8, 3)),
    "GPOS_710_Pilot_设备激活_SOP_V3_2026-09-03.xlsx"
  );
});

test("Assembly uses only Project-specific mixed-case sources and renders AssemblyTemplate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "patrick-ckd-assembly-"));
  try {
    const libraryRoot = path.join(root, "library");
    const ckdRoot = path.join(libraryRoot, "ckd-library-v2");
    const projectRoot = path.join(ckdRoot, "product_lib/TARGET/assemble");
    const actualProcessRoot = path.join(projectRoot, "processes", "assembly_process");
    const workspaceRoot = path.join(root, "workspace");
    const sessionWorkspace = path.join(workspaceRoot, "session");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZpGAAAAAASUVORK5CYII=",
      "base64"
    );
    await write(path.join(ckdRoot, "product_lib/TARGET/project.json"), JSON.stringify({
      version: 1, projectId: "TARGET", displayName: "Target Project", aliases: ["TARGET"]
    }));
    await write(path.join(projectRoot, "sops.json"), JSON.stringify({
      version: 1,
      sops: [{
        sopId: "assembly_sop",
        displayName: "Assembly SOP",
        aliases: [],
        description: "Assembly test fixture",
        processSequence: ["assembly_process"]
      }]
    }));
    await write(path.join(ckdRoot, "processes_lib/assemble/ignored_common/metadata.txt"), "Ignored Common\n");
    await write(path.join(ckdRoot, "processes_lib/assemble/ignored_common/Operation_Instruction.txt"), "MUST NOT APPEAR\n");
    const assemblyProcessName = "Close Bottom Housing & Fasten Bottom Housing Screws";
    await write(path.join(actualProcessRoot, "MeTaDaTa.TxT"), `${assemblyProcessName}\n`);
    await write(path.join(actualProcessRoot, "bill_of_materials.JSONL"), Array.from({ length: 6 }, (_, index) => JSON.stringify({
      index: String(index + 1), partno: `PN-${index + 1}`, qty: index + 1, spec: `Spec ${index + 1}`
    })).join("\n") + "\n");
    await write(path.join(actualProcessRoot, "TOOLS.jsonl"), Array.from({ length: 6 }, (_, index) => JSON.stringify({
      index: String(index + 1), name: `Tool ${index + 1}`, qty: 1, specs: `T-${index + 1}`
    })).join("\n") + "\n");
    await write(path.join(actualProcessRoot, "operation_instruction.TXT"), "Install and verify the assembly.\n");
    await write(path.join(actualProcessRoot, "PREVIOUS_STATION_CHECK.txt"), "Inspect incoming parts.\n");
    await write(path.join(actualProcessRoot, "SELF_CHECK.TXT"), "Verify the finished assembly.\n");
    await write(path.join(actualProcessRoot, "Operation_Photos/P1.png"), png);
    await write(path.join(actualProcessRoot, "Operation_Photos/p2-detail.png"), png);
    await write(path.join(actualProcessRoot, "Previous_Station_Check_Photo.PNG"), png);
    await fs.mkdir(sessionWorkspace, { recursive: true });

    const catalogInput = path.join(root, "catalog-input.json");
    const catalogOutput = path.join(root, "catalog-output.json");
    await write(catalogInput, JSON.stringify({
      inputs: { sopType: "assemble" },
      paths: { libraryRoots: [libraryRoot], workspaceRoot, sessionWorkspace }
    }));
    const catalogResult = runScript(path.join(workflowRoot, "build-ckd-catalog-v3/index.cjs"), catalogInput, catalogOutput).output;
    assert.equal(catalogResult.processCount, 1);
    assert.equal(catalogResult.catalogDetails.processes[0].processId, "assembly_process");
    assert.equal(catalogResult.catalogDetails.processes[0].commonLayer, null);
    assert.equal(catalogResult.catalogDetails.processes[0].projectLayers[0].metadata, assemblyProcessName);
    assert.deepEqual(catalogResult.catalogDetails.processes[0].projectLayers[0].assets.instructionPhotos.map((photo: any) => photo.index), [1, 2]);

    const outputPath = path.join(root, "assembly.xlsx");
    const { buildCkdSop } = require(path.join(generatorRoot, "fill_sop_sheet.js"));
    const generated = await buildCkdSop({
      template: path.join(generatorRoot, "urovo-sop-template-zh.xlsx"),
      output: outputPath,
      projectDir: path.join(projectRoot, "processes"),
      projectName: "Target Project",
      documentNo: "ASM-001",
      sopName: "Assembly SOP",
      author: "Patrick Xu",
      processList: ["assembly_process"],
      sopType: "assemble",
      templateLanguage: "中文"
    });
    assert.equal(generated.sheetCount, 3);
    assert.equal(generated.warnings.length, 0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
      "封面", "工站安排表", "Close Bottom Housing & Fasten B"
    ]);
    const cover = workbook.getWorksheet("封面");
    assert(cover);
    assert.equal(cover.getCell("A17").value, "编制人：Patrick Xu");
    assert.equal(cover.getCell("D4").value, 1);
    assert.equal(cover.pageSetup.printArea, "A1:I17");
    assert.equal(cover.pageSetup.fitToWidth, 1);
    assert.equal(cover.pageSetup.fitToHeight, 1);
    assert.equal(workbook.getWorksheet("Production Arrange Chart"), undefined);
    const workstation = workbook.getWorksheet("工站安排表");
    assert(workstation);
    assert.equal(workstation.getCell("D2").value, "Target Project");
    assert.deepEqual(workstation.getCell("D4").value, {
      formula: "IF('封面'!G4=\"\",\"\",'封面'!G4)",
      result: "ASM-001"
    });
    assert.deepEqual(workstation.getCell("F2").value, {
      formula: "IF('封面'!D4=\"\",\"\",'封面'!D4)",
      result: 1
    });
    assert.deepEqual(workstation.getCell("F3").value, {
      formula: "SUM(F7:F7)",
      result: 30
    });
    assert.deepEqual(workstation.getCell("F4").value, {
      formula: 'IF(MAX(F7:F7)<=0,"",3600/MAX(F7:F7))',
      result: 120
    });
    assert.deepEqual(workstation.getCell("F5").value, {
      formula: "COUNTA(B7:B7)",
      result: 1
    });
    assert.equal(workstation.getCell("A7").value, "OP001");
    assert.equal(workstation.getCell("B7").value, 1);
    assert.equal(workstation.getCell("C7").value, null);
    assert.equal(workstation.getCell("D7").value, assemblyProcessName);
    assert.deepEqual(workstation.getCell("D7").alignment, {
      horizontal: "left",
      vertical: "middle"
    });
    assert.match(String(workstation.getCell("E7").value), /1\. Tool 1 \(T-1\) x1/u);
    assert.equal(workstation.getCell("F7").value, 30);
    assert.equal(workstation.getCell("A8").value, null);
    assert.equal(workstation.getRow(8).hidden, true);
    assert.equal(workstation.pageSetup.printArea, "A1:F7");
    assert.equal(workstation.pageSetup.fitToWidth, 1);
    assert.equal(workstation.pageSetup.fitToHeight, 0);
    const sheet = workbook.getWorksheet("Close Bottom Housing & Fasten B");
    assert(sheet);
    assert.equal(sheet.getCell("E1").value, "标准作业指导书");
    assert.deepEqual(sheet.getCell("E3").value, {
      formula: "'工站安排表'!D7",
      result: assemblyProcessName
    });
    assert.deepEqual(sheet.getCell("R3").value, {
      formula: '"标准工时："&\'工站安排表\'!F7&" 秒"',
      result: "标准工时：30 秒"
    });
    assert.deepEqual(sheet.getCell("A5").value, {
      formula: '"产品名："&\'工站安排表\'!D2',
      result: "产品名：Target Project"
    });
    assert.equal(sheet.getCell("A40").value, "编制人：Patrick Xu");
    assert.equal(sheet.getCell("A8").value, "1");
    assert.equal(sheet.getCell("B8").value, "PN-1");
    assert.equal(sheet.getCell("D8").value, 1);
    assert.equal(sheet.getCell("E8").value, "Spec 1");
    assert.equal(sheet.getCell("B13").value, "PN-6");
    assert.equal(sheet.getCell("D13").value, 6);
    assert.equal(sheet.getCell("B21").value, "Tool 6");
    assert.equal(sheet.getCell("A16").value, "1");
    assert.equal(sheet.getCell("B16").value, "Tool 1");
    assert.equal(sheet.getCell("G7").value, "Install and verify the assembly.");
    assert.equal(sheet.getCell("A23").value, "Inspect incoming parts.");
    assert.equal(sheet.getCell("A34").value, "Verify the finished assembly.");
    assert.equal(sheet.getImages().length, 5);
    assert.equal(sheet.pageSetup.orientation, "landscape");
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    assert.equal(sheet.pageSetup.fitToHeight, 1);
    assert.equal(sheet.pageSetup.printArea, "A1:U40");

  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Assembly scoring deducts optional completeness once and missing Operation scores zero", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "patrick-ckd-assembly-score-"));
  try {
    await write(path.join(root, "metadata.txt"), "Assembly Score\n");
    await write(path.join(root, "Operation_Instruction.txt"), "Perform assembly.\n");
    const { scoreProcess } = require(path.join(generatorRoot, "index.cjs"));
    const plan = { requestedProcess: "Assembly Score" };
    const materialization = { folder: root, fileSources: {} };
    const processRecord = { commonLayer: null, projectLayers: [] };
    const incomplete = scoreProcess(plan, materialization, processRecord, "reference", "assemble");
    assert.equal(incomplete.score, 90);
    assert.equal(incomplete.completenessAssessment.deduction, 10);
    assert.equal(incomplete.crossLayerAssessment.deduction, 0);
    assert.equal(incomplete.crossLayerAssessment.gapCount, 0);

    await write(path.join(root, "Operation_Instruction.txt"), "");
    const missingOperation = scoreProcess(plan, materialization, processRecord, "reference", "assemble");
    assert.equal(missingOperation.score, 0);
    assert.equal(missingOperation.operationAssessment.deduction, 100);
    assert.equal(missingOperation.completenessAssessment.deduction, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("v3 materialization replaces the complete common photo set with the target Project photo directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "patrick-ckd-photo-overlay-"));
  try {
    const libraryRoot = path.join(root, "library");
    const ckdRoot = path.join(libraryRoot, "ckd-library-v2");
    const workspaceRoot = path.join(root, "workspace");
    const sessionWorkspace = path.join(workspaceRoot, "session");
    await write(path.join(ckdRoot, "product_lib/TARGET/project.json"), JSON.stringify({
      version: 1, projectId: "TARGET", displayName: "Target", aliases: ["TARGET"]
    }));
    await write(path.join(ckdRoot, "product_lib/TARGET/assembly_test/sops.json"), JSON.stringify({ version: 1, sops: [] }));
    await write(path.join(ckdRoot, "processes_lib/assembly_test/photo_overlay/metadata"), "Common Legacy Name\n");
    await write(path.join(ckdRoot, "processes_lib/assembly_test/photo_overlay/metadata.txt"), "Photo Overlay\n");
    await write(path.join(ckdRoot, "processes_lib/assembly_test/photo_overlay/photos/p1-common.png"), Buffer.from([1]));
    await write(path.join(ckdRoot, "processes_lib/assembly_test/photo_overlay/photos/p2-common.png"), Buffer.from([2]));
    await write(path.join(ckdRoot, "product_lib/TARGET/assembly_test/processes/photo_overlay/photos/p1.png"), Buffer.from([3]));
    await write(path.join(ckdRoot, "product_lib/TARGET/assembly_test/processes/photo_overlay/metadata"), "Project Legacy Name\n");
    await write(path.join(ckdRoot, "product_lib/TARGET/assembly_test/processes/photo_overlay/metadata.txt"), "Project Preferred Name\n");
    await fs.mkdir(sessionWorkspace, { recursive: true });
    const inputPath = path.join(root, "catalog-input.json");
    const outputPath = path.join(root, "catalog-output.json");
    await write(inputPath, JSON.stringify({ inputs: { sopType: "assembly_test" }, paths: { libraryRoots: [libraryRoot], workspaceRoot, sessionWorkspace } }));
    const catalogResult = runScript(path.join(workflowRoot, "build-ckd-catalog-v3/index.cjs"), inputPath, outputPath);
    const processRecord = catalogResult.output.catalogDetails.processes[0];
    const { materializeProcess } = require(path.join(generatorRoot, "index.cjs"));
    const effectiveRoot = path.join(sessionWorkspace, "effective");
    await fs.mkdir(effectiveRoot, { recursive: true });
    const materialized = materializeProcess({
      ckdLibraryRoot: ckdRoot,
      effectiveRoot,
      targetProjectId: "TARGET",
      processRecord,
      processName: "Photo Overlay"
    });
    assert.deepEqual(await fs.readdir(path.join(materialized.folder, "photos")), ["p1.png"]);
    assert.equal(materialized.fileSources.photos, "project");
    assert.equal(materialized.processName, "Project Preferred Name");
    assert.deepEqual((await fs.readdir(materialized.folder)).filter((name) => name.startsWith("metadata")), ["metadata.txt"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("v3 Chinese Catalog isolates CN_process and applies project-over-common content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "patrick-ckd-cn-catalog-"));
  try {
    const libraryRoot = path.join(root, "library");
    const ckdRoot = path.join(libraryRoot, "ckd-library-v2");
    const projectTypeRoot = path.join(ckdRoot, "product_lib/TARGET/assemble");
    const commonProcess = path.join(ckdRoot, "processes_lib/assemble/CN_process/shared_process");
    const projectProcess = path.join(projectTypeRoot, "CN_process/shared_process");
    const workspaceRoot = path.join(root, "workspace");
    const sessionWorkspace = path.join(workspaceRoot, "session");
    await write(path.join(ckdRoot, "product_lib/TARGET/project.json"), JSON.stringify({
      version: 1, projectId: "TARGET", displayName: "Target", aliases: []
    }));
    await write(path.join(projectTypeRoot, "sops.json"), JSON.stringify({
      version: 1,
      sops: [{
        sopId: "shared_sop",
        displayName: "Shared SOP",
        displayNameCN: "中文共享 SOP",
        aliases: [],
        processSequence: ["shared_process"]
      }]
    }));
    await write(path.join(commonProcess, "metadata.txt"), "公共名称\n");
    await write(path.join(commonProcess, "Operation_Instruction.txt"), "公共操作\n");
    await write(path.join(commonProcess, "Self_Check.txt"), "公共自检\n");
    await write(path.join(projectProcess, "METADATA.TXT"), "项目名称\n");
    await write(path.join(projectProcess, "Operation_Instruction.txt"), "项目操作\n");
    await write(path.join(projectTypeRoot, "processes/shared_process/metadata.txt"), "English Name\n");
    await write(path.join(projectTypeRoot, "processes/shared_process/Operation_Instruction.txt"), "English operation\n");
    await fs.mkdir(sessionWorkspace, { recursive: true });

    const inputPath = path.join(root, "input.json");
    const outputPath = path.join(root, "output.json");
    await write(inputPath, JSON.stringify({
      inputs: { sopType: "assemble", templateLanguage: "中文" },
      paths: { libraryRoots: [libraryRoot], workspaceRoot, sessionWorkspace }
    }));
    const output = runScript(path.join(workflowRoot, "build-ckd-catalog-v3/index.cjs"), inputPath, outputPath).output;
    assert.equal(output.templateLanguage, "中文");
    assert.equal(output.processCount, 1);
    assert.equal(output.catalogDetails.processes[0].commonLayer.metadata, "公共名称");
    assert.equal(output.catalogDetails.processes[0].projectLayers[0].metadata, "项目名称");
    assert.equal(output.sopCatalogSummary.sops[0].displayName, "中文共享 SOP");
    assert.equal(output.sopCatalogSummary.sops[0].aliases.includes("Shared SOP"), true);

    const { materializeProcess } = require(path.join(generatorRoot, "index.cjs"));
    const materialized = materializeProcess({
      ckdLibraryRoot: ckdRoot,
      effectiveRoot: path.join(sessionWorkspace, "effective"),
      targetProjectId: "TARGET",
      processRecord: output.catalogDetails.processes[0],
      processName: "项目名称",
      sopType: "assemble",
      templateLanguage: "中文"
    });
    assert.equal(await fs.readFile(path.join(materialized.folder, "Operation_Instruction.txt"), "utf8"), "项目操作\n");
    assert.equal(await fs.readFile(path.join(materialized.folder, "Self_Check.txt"), "utf8"), "公共自检\n");
    assert.equal(materialized.fileSources["Operation_Instruction.txt"], "project");
    assert.equal(materialized.fileSources["Self_Check.txt"], "common");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("v3 Factory Test freezes the Builder order without entering the source clarification path", async () => {
  const { createCkdSopV3GraphWorkflow } = await import("../src/ckd/workflow.js");
  const node = createCkdSopV3GraphWorkflow.nodes.find((candidate) => candidate.id === "select-sop-source");
  assert(node);
  let completed: Record<string, any> | undefined;
  let clarificationCalls = 0;
  let structuredCalls = 0;
  await node.execute({
    run: {
      inputs: {
        sopType: "factory_test",
        sopName: "Factory Test",
        factoryTestProcesses: ["Display Test", "Key Test"]
      },
      sharedState: { projectMatchResult: { matchedProjectId: "TARGET" } },
      nodeOutputs: { "prepare-catalog": { output: { sopCatalogSummary: { sops: [] } } } }
    },
    createNodeRun(values: Record<string, any>) {
      assert.equal(values.sourceMode, "factory-test-builder");
      return { id: "factory-source", input: values };
    },
    completeNode(_id: string, submission: Record<string, any>) {
      completed = submission;
      return {};
    },
    requestClarification() { clarificationCalls += 1; return false; },
    async runStructured() { structuredCalls += 1; return false; }
  } as never);
  assert.equal(clarificationCalls, 0);
  assert.equal(structuredCalls, 0);
  assert.deepEqual(completed?.output.processList, ["Display Test", "Key Test"]);
  assert.equal(completed?.output.mode, "custom");
});

test("v3 Factory Test resolves exact Catalog selections without an LLM Process matching turn", async () => {
  const { createCkdSopV3GraphWorkflow } = await import("../src/ckd/workflow.js");
  const node = createCkdSopV3GraphWorkflow.nodes.find((candidate) => candidate.id === "resolve-processes");
  assert(node);
  let completed: Record<string, any> | undefined;
  let structuredCalls = 0;
  const run = {
    inputs: {
      sopType: "factory_test",
      projectName: "TARGET",
      documentNumber: "FT-1",
      sopName: "Factory Test",
      author: "Patrick Xu",
      factoryTestProcesses: ["Camera Test"]
    },
    sharedState: {
      projectMatchResult: {
        requestedProjectName: "TARGET",
        matchedProjectId: "TARGET",
        matchedProjectName: "Target Project",
        status: "semantic_match",
        confidence: 1,
        comment: "exact"
      },
      sopProcessSelection: {
        mode: "custom",
        requestedSopName: "Factory Test",
        processList: ["Camera Test"],
        comment: "builder"
      }
    },
    nodeOutputs: {
      "prepare-catalog": {
        output: {
          catalogSummary: {
            processes: [{
              processId: "camera_test",
              displayName: "Camera Test",
              aliases: ["camera_test", "Camera Test"],
              overview: "Common camera check.",
              projectOverviews: {},
              availability: { common: true, projectIds: [] }
            }]
          },
          catalogDetails: { processes: [] },
          sopCatalogSummary: { sops: [] }
        }
      }
    }
  };
  await node.execute({
    run,
    createNodeRun(values: Record<string, any>) {
      return { id: "factory-resolve", input: values };
    },
    async executeScript() {
      return {
        summary: "normalized",
        output: {
          processList: ["Camera Test"],
          semanticProcessResolutionRequired: true
        },
        artifacts: []
      };
    },
    patchSharedState(patch: Record<string, any>) {
      Object.assign(run.sharedState, patch);
      return run;
    },
    completeNode(_id: string, submission: Record<string, any>) {
      completed = submission;
      return run;
    },
    async runStructured() { structuredCalls += 1; return false; },
    failNode(_id: string, error: unknown) { throw error; }
  } as never);
  assert.equal(structuredCalls, 0);
  assert.equal(completed?.output.processes[0].resolvedProcessId, "camera_test");
  assert.equal(completed?.output.processes[0].semanticMatch, "equivalent");
  assert.equal(completed?.output.processes[0].confidence, 1);
});

test("v3 Production Arrange Chart expands its single prototype row to the actual 1-30 Process count", async () => {
  const { fillProductionArrangeChart } = require(path.join(generatorRoot, "fill_sop_sheet.js"));
  for (const count of [1, 3, 8, 30]) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(generatorRoot, "urovo-sop-template.xlsx"));
    const sheet = workbook.getWorksheet("Production Arrange Chart");
    assert(sheet);
    const entries = Array.from({ length: count }, (_, index) => [
      `Station ${index + 1}`,
      `Tool ${index + 1} x1`
    ]);
    if (count === 3) {
      entries[0][1] = "1. PSAM Card x1\n2. TF Card x1\n3. SAM Card x2\n4. SIM Card x2";
      entries[1][1] = "A deliberately long fixture description that wraps inside the actual Tools column width x1";
    }
    fillProductionArrangeChart(sheet, "PROJECT", entries);
    const endRow = 7 + count;

    assert.equal(sheet.pageSetup.printArea, `A1:H${endRow}`);
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    assert.equal(sheet.pageSetup.fitToHeight, 0);
    assert.deepEqual(sheet.getCell("H2").value, {
      formula: 'IF(Cover!D4="","",Cover!D4)',
      result: count
    });
    assert.deepEqual(sheet.getCell("H4").value, {
      formula: `SUM(G8:G${endRow})&" s"`,
      result: `${count * 40} s`
    });
    for (let offset = 0; offset < count; offset += 1) {
      const row = 8 + offset;
      assert.deepEqual(sheet.getCell(row, 1).value, {
        formula: `IF(C${row}="","",COUNTA($C$8:C${row}))`,
        result: offset + 1
      });
      assert.equal(sheet.getCell(row, 2).master.address, `A${row}`);
      assert.equal(sheet.getCell(row, 3).value, `Station ${offset + 1}`);
      assert.equal(sheet.getCell(row, 4).value, entries[offset][1]);
      assert.equal(sheet.getCell(row, 6).master.address, `E${row}`);
      assert.equal(sheet.getCell(row, 7).value, 40);
      if (count === 3 && offset < 2) assert(sheet.getRow(row).height > 40);
      else assert.equal(sheet.getRow(row).height, 40);
    }
    if (count === 1) {
      assert.equal(sheet.getCell("H8").isMerged, false);
    } else {
      assert.equal(sheet.getCell(endRow, 8).master.address, "H8");
      assert.equal(sheet.model.merges.includes(`H8:H${endRow}`), true);
    }
  }
});

test("v3 Workstation Layout Chart expands Assembly rows with ordered workstations", async () => {
  const { fillWorkstationLayoutChart } = require(path.join(generatorRoot, "fill_sop_sheet.js"));
  for (const count of [1, 3, 12, 30]) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(generatorRoot, "urovo-sop-template.xlsx"));
    const cover = workbook.getWorksheet("Cover");
    const sheet = workbook.getWorksheet("Workstation Layout Chart");
    assert(cover && sheet);
    cover.getCell("D4").value = count;
    cover.getCell("G4").value = "ASM-001";
    const entries = Array.from({ length: count }, (_, index) => [
      `Assembly Sheet ${index + 1}`,
      `1. Tool ${index + 1} x1`
    ]);
    fillWorkstationLayoutChart(sheet, cover, "PROJECT", "ASM-001", entries);
    const endRow = 6 + count;

    assert.equal(sheet.pageSetup.printArea, `A1:F${endRow}`);
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    assert.equal(sheet.pageSetup.fitToHeight, 0);
    assert.deepEqual(sheet.getCell("F2").value, {
      formula: 'IF(Cover!D4="","",Cover!D4)',
      result: count
    });
    assert.deepEqual(sheet.getCell("F3").value, {
      formula: `SUM(F7:F${endRow})`,
      result: count * 30
    });
    assert.deepEqual(sheet.getCell("F4").value, {
      formula: `IF(MAX(F7:F${endRow})<=0,"",3600/MAX(F7:F${endRow}))`,
      result: 120
    });
    assert.deepEqual(sheet.getCell("F5").value, {
      formula: `COUNTA(B7:B${endRow})`,
      result: count
    });
    for (let offset = 0; offset < count; offset += 1) {
      const row = 7 + offset;
      assert.equal(sheet.getCell(row, 1).value, `OP${String(offset + 1).padStart(3, "0")}`);
      assert.equal(sheet.getCell(row, 2).value, offset + 1);
      assert.equal(sheet.getCell(row, 3).value, null);
      assert.equal(sheet.getCell(row, 4).value, entries[offset][0]);
      assert.equal(sheet.getCell(row, 4).alignment.horizontal, "left");
      assert.equal(sheet.getCell(row, 4).alignment.vertical, "middle");
      assert.equal(sheet.getCell(row, 5).value, entries[offset][1]);
      assert.equal(sheet.getCell(row, 6).value, 30);
    }
    assert.equal(sheet.getCell(endRow, 1).border.bottom?.style, "thin");
    if (count < 10) {
      assert.equal(sheet.getCell(endRow + 1, 1).value, null);
      assert.equal(sheet.getRow(endRow + 1).hidden, true);
    }
  }
});

test("v3 Factory Test Excel packs two Processes per STEP sheet and preserves ordered content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "patrick-ckd-factory-test-xlsx-"));
  try {
    const projectDir = path.join(root, "project");
    const outputPath = path.join(root, "factory-test.xlsx");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZpGAAAAAASUVORK5CYII=",
      "base64"
    );
    for (const [folder, title, note, toolCount, photoCount] of [
      ["first", "First Process", "FIRST NOTE", 6, 2],
      ["second", "Second Process", "SECOND NOTE", 5, 1],
      ["third", "Third Process", "THIRD NOTE", 1, 1]
    ] as const) {
      await write(path.join(projectDir, folder, "metadata"), `${title}\n`);
      await write(path.join(projectDir, folder, "operation_steps.txt"), `${title} OPERATION\n`);
      await write(path.join(projectDir, folder, "technical_notes.txt"), `${note}\n`);
      await write(
        path.join(projectDir, folder, "tools_fixtures_equipment.jsonl"),
        Array.from({ length: toolCount }, (_, index) => JSON.stringify({
          name: `${title} Tool ${index + 1}`,
          qty: 1,
          specs: "NA"
        })).join("\n") + "\n"
      );
      for (let index = 1; index <= photoCount; index += 1) {
        await write(path.join(projectDir, folder, "photos", `p${index}-photo.png`), png);
      }
    }

    const { buildCkdSop } = require(path.join(generatorRoot, "fill_sop_sheet.js"));
    const result = await buildCkdSop({
      template: path.join(generatorRoot, "urovo-sop-template.xlsx"),
      output: outputPath,
      projectDir,
      projectName: "FACTORY_PROJECT",
      documentNo: "FT-001",
      sopName: "Factory Test",
      author: "Patrick Xu",
      processList: ["first", "second", "third"],
      sopType: "factory_test"
    });
    assert.equal(result.sheetCount, 4);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings.join("\n"), /只显示一张图片/u);
    assert.match(result.warnings.join("\n"), /超过 9 项/u);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
      "Cover", "Production Arrange Chart", "STEP_1", "STEP_2"
    ]);
    assert.equal(workbook.getWorksheet("Cover")?.getCell("D4").value, 2);
    const chart = workbook.getWorksheet("Production Arrange Chart");
    assert(chart);
    assert.equal(chart.getCell("C8").value, "First Process");
    assert.equal(chart.getCell("C9").value, "Second Process");
    assert.equal(chart.getCell("C10").value, "Third Process");
    assert.equal(chart.getCell("G10").value, 40);
    assert.deepEqual(chart.getCell("H2").value, {
      formula: 'IF(Cover!D4="","",Cover!D4)',
      result: 2
    });

    const firstStep = workbook.getWorksheet("STEP_1");
    const secondStep = workbook.getWorksheet("STEP_2");
    assert(firstStep && secondStep);
    assert.equal(firstStep.getCell("E3").value, "STEP_1");
    assert.equal(firstStep.getCell("R3").value, "Std. Time: 80 s");
    assert.equal(firstStep.getCell("G7").value, "First Process OPERATION");
    assert.equal(firstStep.getCell("G22").value, "Second Process OPERATION");
    assert.equal(firstStep.getCell("A18").value, "FIRST NOTE");
    assert.equal(firstStep.getCell("B8").value, "First Process Tool 1");
    assert.equal(firstStep.getCell("B16").value, "Second Process Tool 3");
    assert.equal(firstStep.getCell("A38").value, "Author: Patrick Xu");
    assert.equal(secondStep.getCell("E3").value, "STEP_2");
    assert.equal(secondStep.getCell("R3").value, "Std. Time: 40 s");
    assert.equal(secondStep.getCell("G7").value, "Third Process OPERATION");
    assert.equal(secondStep.getCell("G22").value, null);
    assert.equal(secondStep.getCell("A18").value, "THIRD NOTE");
    assert.equal(firstStep.getImages().length, 4);
    assert.equal(secondStep.getImages().length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("v3 resolves one exact Project locally and preselects SOP Source without another model turn", async () => {
  const { deterministicExactProjectMatchV3 } = await import(
    "../src/ckd/workflow.js"
  );
  const catalog = {
    projects: [
      { projectId: "SQ69PC", displayName: "SQ69PC", aliases: ["SQ 69 PC"] },
      { projectId: "SQ68MB", displayName: "SQ68 Mainboard", aliases: [] }
    ]
  };
  assert.deepEqual(deterministicExactProjectMatchV3(" sq69pc ", catalog), {
    requestedProjectName: "sq69pc",
    matchedProjectId: "SQ69PC",
    matchedProjectName: "SQ69PC",
    status: "semantic_match",
    confidence: 1,
    comment: "项目 ID、名称或别名与 Library 中的唯一项目精确匹配。"
  });
  assert.equal(deterministicExactProjectMatchV3("SQ69", catalog), undefined);
  assert.equal(deterministicExactProjectMatchV3("shared", {
    projects: [
      { projectId: "A", displayName: "A", aliases: ["shared"] },
      { projectId: "B", displayName: "B", aliases: ["shared"] }
    ]
  }), undefined);

  const { sopSelectionPrompt } = await import("../src/ckd/prompts.js");
  const referencePrompt = sopSelectionPrompt({ inputs: { sopName: "S", sopType: "assembly_test" } } as never, {}, {}, "reference");
  assert.match(referencePrompt, /不要再次询问来源，直接执行参考模式/u);
  assert.doesNotMatch(referencePrompt, /第一步必须 clarify/u);
});

test("v3 manual SOP source collects Processes deterministically and confirms every single-line batch", async () => {
  const {
    createCkdSopV3GraphWorkflow,
    customProcessClarificationV3,
    resolveCustomProcessClarificationV3
  } = await import("../src/ckd/workflow.js");
  const run = {
    id: "manual-process-test",
    inputs: { sopName: "Download UFS", sopType: "assembly_test" },
    sharedState: {
      sopSourceMode: "custom",
      projectMatchResult: { matchedProjectId: "SQ69PC" },
      customProcessCollection: { stage: "collect", processList: [] }
    },
    nodeOutputs: {
      "prepare-catalog": { output: { sopCatalogSummary: { sops: [] } } }
    }
  } as never;
  const selectNode = createCkdSopV3GraphWorkflow.nodes.find((node) => node.id === "select-sop-source");
  assert(selectNode);
  let requested: Record<string, any> | undefined;
  let structuredCalls = 0;
  await selectNode.execute({
    run,
    createNodeRun(values: Record<string, any>) {
      return { id: "manual-node-run", input: values };
    },
    requestClarification(_nodeRunId: string, request: Record<string, any>) {
      requested = request;
      return false;
    },
    async runStructured() {
      structuredCalls += 1;
      return false;
    }
  } as never);
  assert.equal(structuredCalls, 0);
  assert.match(requested?.question ?? "", /每一行只写一个 Process 名称/u);
  assert.match(requested?.question ?? "", /可以一次输入多行，也可以每次只输入一行/u);
  assert.match(requested?.question ?? "", /示例：\n安装 MTK FLASH 驱动\n下载软件\n写入 SN/u);
  assert.deepEqual(requested?.options, []);
  assert.deepEqual(requested?.inputUi, {
    widget: "ordered-string-list-dialog",
    title: "Build SOP Process Sequence",
    description: "Add one Process per row, then drag them into the exact SOP execution order. Confirming submits the same ordered text list to the existing matching workflow.",
    itemLabel: "Process",
    placeholder: "Enter a Process name",
    addLabel: "Add Process",
    minItems: 1,
    maxItems: 30,
    maxLength: 120
  });

  const initialInput = {
    graphClarificationKind: "custom-process-list",
    customProcessCollection: { stage: "collect", processList: [] }
  } as any;
  const one = resolveCustomProcessClarificationV3("安装 MTK FLASH 驱动", run, initialInput) as any;
  assert.equal(one.repeatNode, true);
  assert.deepEqual(one.result.statePatch.customProcessCollection, {
    stage: "confirm-single",
    processList: ["安装 MTK FLASH 驱动"]
  });
  const singleConfirmation = customProcessClarificationV3(
    run,
    one.result.statePatch.customProcessCollection
  );
  assert.equal(singleConfirmation.kind, "custom-process-single-confirmation");
  assert.equal(singleConfirmation.request.inputUi, undefined);
  assert.deepEqual(singleConfirmation.request.options, [
    "已完成，流程列表共 1 个：安装 MTK FLASH 驱动",
    "继续输入，我将在自由文本中补充下一个 Process"
  ]);

  const continueResolution = resolveCustomProcessClarificationV3(
    "继续输入，我将在自由文本中补充下一个 Process",
    run,
    {
      graphClarificationKind: singleConfirmation.kind,
      customProcessCollection: one.result.statePatch.customProcessCollection
    } as any
  ) as any;
  assert.deepEqual(continueResolution.result.statePatch.customProcessCollection, {
    stage: "collect",
    processList: ["安装 MTK FLASH 驱动"]
  });
  const secondSingle = resolveCustomProcessClarificationV3(
    "下载软件",
    run,
    {
      graphClarificationKind: "custom-process-list",
      customProcessCollection: continueResolution.result.statePatch.customProcessCollection
    } as any
  ) as any;
  assert.equal(secondSingle.result.statePatch.customProcessCollection.stage, "confirm-single");
  assert.deepEqual(secondSingle.result.statePatch.customProcessCollection.processList, [
    "安装 MTK FLASH 驱动",
    "下载软件"
  ]);
  const secondConfirmation = customProcessClarificationV3(
    run,
    secondSingle.result.statePatch.customProcessCollection
  );
  const completed = resolveCustomProcessClarificationV3(
    "已完成，流程列表共 2 个",
    run,
    {
      graphClarificationKind: secondConfirmation.kind,
      customProcessCollection: secondSingle.result.statePatch.customProcessCollection
    } as any
  ) as any;
  assert.deepEqual(completed.result.output, {
    mode: "custom",
    requestedSopName: "Download UFS",
    processList: ["安装 MTK FLASH 驱动", "下载软件"],
    comment: "手动模式：用户手动输入 Process 清单，共 2 个非空名称，按输入顺序保留（无重复）。"
  });
  assert.equal(completed.repeatNode, undefined);

  const batch = resolveCustomProcessClarificationV3(
    "安装驱动\n下载软件\n写入 SN",
    run,
    initialInput
  ) as any;
  assert.deepEqual(batch.result.output.processList, ["安装驱动", "下载软件", "写入 SN"]);
  assert.equal(batch.repeatNode, undefined);

  const duplicate = resolveCustomProcessClarificationV3(
    "安装驱动\n安装驱动",
    run,
    initialInput
  ) as any;
  assert.equal(duplicate.result.statePatch.customProcessCollection.stage, "confirm-duplicates");
  const duplicateConfirmation = customProcessClarificationV3(
    run,
    duplicate.result.statePatch.customProcessCollection
  );
  assert.equal(duplicateConfirmation.kind, "custom-process-duplicate-confirmation");
  const deduplicated = resolveCustomProcessClarificationV3(
    "移除重复项，并按首次出现的顺序完成",
    run,
    {
      graphClarificationKind: duplicateConfirmation.kind,
      customProcessCollection: duplicate.result.statePatch.customProcessCollection
    } as any
  ) as any;
  assert.deepEqual(deduplicated.result.output.processList, ["安装驱动"]);
});

test("v3 overlays target files on common and creates a zero-score placeholder without leaking source content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "patrick-ckd-v3-"));
  try {
    const libraryRoot = path.join(root, "library");
    const ckdRoot = path.join(libraryRoot, "ckd-library-v2");
    const workspaceRoot = path.join(root, "workspace");
    const sessionWorkspace = path.join(workspaceRoot, "session");
    await fs.mkdir(sessionWorkspace, { recursive: true });
    for (const projectId of ["SOURCE", "TARGET"]) {
      await write(path.join(ckdRoot, "product_lib", projectId, "project.json"), JSON.stringify({
        version: 1,
        projectId,
        displayName: `${projectId} Project`,
        aliases: [projectId]
      }));
    }
    await write(path.join(ckdRoot, "product_lib/SOURCE/assembly_test/sops.json"), JSON.stringify({
      version: 1,
      sops: [{
        sopId: "cross_project_sop",
        displayName: "Cross Project SOP",
        description: "Overlay then placeholder",
        processSequence: ["overlay_process", "missing_for_target"]
      }]
    }));
    await write(path.join(ckdRoot, "product_lib/TARGET/assembly_test/sops.json"), JSON.stringify({
      version: 1,
      sops: [{
        sopId: "same_project_sop",
        displayName: "Same Project SOP",
        description: "Same target Project and same overlay rules",
        processSequence: ["overlay_process"]
      }]
    }));
    await write(path.join(ckdRoot, "processes_lib/assembly_test/overlay_process/metadata"), "Overlay Process\n");
    await write(path.join(ckdRoot, "processes_lib/assembly_test/overlay_process/operation_steps.txt"), "COMMON OPERATION STEP\n");
    await write(path.join(ckdRoot, "processes_lib/assembly_test/overlay_process/material_details.jsonl"), '{"name":"COMMON MATERIAL","qty":1,"specs":"COMMON"}\n');
    await write(path.join(ckdRoot, "processes_lib/assembly_test/overlay_process/tools_fixtures_equipment.jsonl"), '{"name":"COMMON TOOL","qty":1,"specs":"NA"}\n');
    await write(path.join(ckdRoot, "processes_lib/assembly_test/overlay_process/technical_notes.txt"), "COMMON NOTE\n");
    await fs.mkdir(path.join(ckdRoot, "processes_lib/assembly_test/overlay_process/photos"), { recursive: true });
    await fs.copyFile(
      path.join(generatorRoot, "RoHS-pic.png"),
      path.join(ckdRoot, "processes_lib/assembly_test/overlay_process/photos/p1-instruction_photos.png")
    );
    await write(path.join(ckdRoot, "product_lib/TARGET/assembly_test/processes/overlay_process/material_details.jsonl"), "");
    await write(path.join(ckdRoot, "product_lib/TARGET/assembly_test/processes/overlay_process/metadata"), "Target Overlay Display\n");
    await write(path.join(ckdRoot, "product_lib/TARGET/assembly_test/processes/overlay_process/technical_notes.txt"), "TARGET NOTE\n");
    await write(path.join(ckdRoot, "product_lib/SOURCE/assembly_test/processes/missing_for_target/metadata"), "Missing For Target\n");
    await write(path.join(ckdRoot, "product_lib/SOURCE/assembly_test/processes/missing_for_target/operation_steps.txt"), "SOURCE SENTINEL MUST NOT LEAK\n");

    const catalogInput = path.join(root, "catalog-input.json");
    const catalogOutput = path.join(root, "catalog-output.json");
    await write(catalogInput, JSON.stringify({
      inputs: { sopType: "assembly_test" },
      paths: { libraryRoots: [libraryRoot], workspaceRoot, sessionWorkspace }
    }));
    const catalogResult = runScript(path.join(workflowRoot, "build-ckd-catalog-v3/index.cjs"), catalogInput, catalogOutput);
    assert.equal(catalogResult.output.projectCount, 2);
    assert.equal(catalogResult.output.processCount, 2);
    assert.equal(catalogResult.output.processLayerCount, 3);
    const selectedSop = catalogResult.output.sopCatalogSummary.sops[0];
    const processList = selectedSop.processSequence.map((process: Record<string, string>) => process.displayName);
    const processIds = selectedSop.processSequence.map((process: Record<string, string>) => process.processId);
    const selection = {
      mode: "reference",
      requestedSopName: "Cross Project SOP",
      referenceSopId: selectedSop.sopId,
      referenceSopName: selectedSop.displayName,
      referenceProjectId: "SOURCE",
      referenceProjectName: "SOURCE Project",
      processList,
      referenceProcessIds: processIds,
      comment: "selected"
    };
    const resolverInput = path.join(root, "resolver-input.json");
    const resolverOutput = path.join(root, "resolver-output.json");
    await write(resolverInput, JSON.stringify({
      inputs: {
        projectMatchResult: {
          requestedProjectName: "TARGET",
          matchedProjectId: "TARGET",
          matchedProjectName: "TARGET Project"
        },
        sopProcessSelection: selection,
        processList,
        catalogSummary: catalogResult.output.catalogSummary,
        catalogDetails: catalogResult.output.catalogDetails,
        sopCatalogSummary: catalogResult.output.sopCatalogSummary
      }
    }));
    const resolverResult = runScript(
      path.join(workflowRoot, "resolve-ckd-transplant-reference-processes-v3/index.cjs"),
      resolverInput,
      resolverOutput
    );
    assert.deepEqual(resolverResult.output.processes.map((process: Record<string, unknown>) => process.status), [
      "transplanted",
      "transplanted"
    ]);
    assert.ok(resolverResult.output.processes.every((process: Record<string, unknown>) =>
      process.semanticMatch === "not_applicable"));
    assert.ok(resolverResult.output.processes.every((process: Record<string, unknown>) =>
      Array.isArray(process.warnings) && process.warnings.length === 0));

    const sameSop = catalogResult.output.sopCatalogSummary.sops.find(
      (sop: Record<string, string>) => sop.projectId === "TARGET"
    );
    const sameSelection = {
      mode: "reference",
      requestedSopName: sameSop.displayName,
      referenceSopId: sameSop.sopId,
      referenceSopName: sameSop.displayName,
      referenceProjectId: "TARGET",
      referenceProjectName: "TARGET Project",
      processList: sameSop.processSequence.map((process: Record<string, string>) => process.displayName),
      referenceProcessIds: sameSop.processSequence.map((process: Record<string, string>) => process.processId),
      comment: "same project"
    };
    const sameResolverInput = path.join(root, "same-resolver-input.json");
    const sameResolverOutput = path.join(root, "same-resolver-output.json");
    await write(sameResolverInput, JSON.stringify({ inputs: {
      projectMatchResult: {
        requestedProjectName: "TARGET",
        matchedProjectId: "TARGET",
        matchedProjectName: "TARGET Project"
      },
      sopProcessSelection: sameSelection,
      processList: sameSelection.processList,
      catalogSummary: catalogResult.output.catalogSummary,
      sopCatalogSummary: catalogResult.output.sopCatalogSummary
    } }));
    const sameResolverResult = runScript(
      path.join(workflowRoot, "resolve-ckd-reference-processes-v3/index.cjs"),
      sameResolverInput,
      sameResolverOutput
    );
    assert.deepEqual(sameResolverResult.output.processes.map((process: Record<string, unknown>) => process.status), ["direct"]);
    assert.equal(sameResolverResult.output.processes[0].semanticMatch, "not_applicable");

    const customNormalizeInput = path.join(root, "custom-normalize-input.json");
    const customNormalizeOutput = path.join(root, "custom-normalize-output.json");
    await write(customNormalizeInput, JSON.stringify({ inputs: {
      sopType: "assembly_test",
      templateLanguage: "中文",
      projectName: "TARGET",
      documentNumber: "V3-001",
      sopName: "Custom SOP",
      author: "Author: Patrick Xu",
      processList: ["Overlay Process"],
      projectMatchResult: {
        matchedProjectId: "TARGET",
        matchedProjectName: "TARGET Project"
      },
      sopProcessSelection: {
        mode: "custom",
        processList: ["Overlay Process"]
      }
    } }));
    const customNormalized = runScript(
      path.join(workflowRoot, "normalize-ckd-inputs-v3/index.cjs"),
      customNormalizeInput,
      customNormalizeOutput
    );
    assert.equal(customNormalized.output.referenceFastPathEligible, false);
    assert.equal(customNormalized.output.referenceTransplantEligible, false);
    assert.equal(customNormalized.output.semanticProcessResolutionRequired, true);
    assert.equal(customNormalized.output.sopType, "assembly_test");
    assert.equal(customNormalized.output.templateLanguage, "中文");
    assert.equal(customNormalized.output.author, "Patrick Xu");

    const { run } = require(path.join(generatorRoot, "index.cjs"));
    const envelope = {
      inputs: {
        normalizedInputs: {
          sopType: "assembly_test",
          projectName: "TARGET",
          documentNumber: "V3-001",
          safeDocumentNumber: "V3-001",
          sopName: "Cross Project SOP",
          author: "Patrick Xu",
          processList,
          warnings: []
        },
        projectMatchResult: {
          requestedProjectName: "TARGET",
          matchedProjectId: "TARGET",
          matchedProjectName: "TARGET Project"
        },
        processPlans: resolverResult.output.processes,
        catalogPath: catalogResult.output.catalogPath,
        catalogHash: catalogResult.output.catalogHash,
        normalizationWarnings: [],
        sopProcessSelection: selection
      },
      paths: { libraryRoots: [libraryRoot], workspaceRoot, sessionWorkspace },
      workflow: { runId: "v3-overlay-test" }
    };
    const generated = await run(structuredClone(envelope));
    const repeated = await run(structuredClone(envelope));
    assert.equal(repeated.output.documentPath, generated.output.documentPath);
    assert.match(path.basename(generated.output.documentPath), /^TARGET_Cross_Project_SOP_\d{4}-\d{2}-\d{2}\.xlsx$/u);
    assert.deepEqual(generated.output.processReviews.map((review: Record<string, unknown>) => ({
      status: review.contentStatus,
      score: review.score
    })), [
      { status: "resolved", score: 80 },
      { status: "content_missing", score: 0 }
    ]);
    assert.equal(generated.output.reviewSummary.overallScore, 40);
    assert.equal(generated.output.reviewSummary.placeholderCount, 1);
    assert.equal(generated.output.reviewSummary.zeroScoreCount, 1);
    assert.equal(generated.output.reviewSummary.crossLayerGapProcessCount, 1);
    assert.equal(generated.output.processReviews[0].completenessAssessment.deduction, 0);
    assert.equal(generated.output.processReviews[0].crossLayerAssessment.deduction, 20);
    assert.deepEqual(generated.output.processReviews[0].crossLayerAssessment.categories, ["material"]);
    assert.equal(generated.output.processReviews[0].semanticAssessment.level, "not_applicable");
    assert.match(generated.output.resultSummary, /\| 评分项 \| 实际扣分值 \| 评论 \|/u);
    assert.match(generated.output.resultSummary, /目标项目空文件覆盖了 common/u);
    assert.match(generated.output.resultSummary, /SOP 总体汇总/u);
    assert.deepEqual(generated.output.processReviews[0].fileSources, {
      metadata: "project",
      "material_details.jsonl": "project",
      "tools_fixtures_equipment.jsonl": "common",
      "technical_notes.txt": "project",
      "operation_steps.txt": "common",
      photos: "common"
    });
    assert.equal(generated.output.processReviews[0].processName, "Target Overlay Display");
    assert.equal(generated.output.processReviews[1].fileSources.metadata, "generated");

    const customEnvelope = structuredClone(envelope);
    customEnvelope.inputs.normalizedInputs = {
      ...customEnvelope.inputs.normalizedInputs,
      safeDocumentNumber: "V3-SEMANTIC",
      sopName: "Manual SOP",
      processList: [processList[0]]
    };
    customEnvelope.inputs.sopProcessSelection = {
      mode: "custom",
      processList: [processList[0]],
      comment: "manual"
    };
    customEnvelope.inputs.processPlans = [{
      ...resolverResult.output.processes[0],
      status: "direct",
      sourceProjectId: "TARGET",
      sourceProjectName: "TARGET Project",
      semanticMatch: "partial",
      semanticReason: "用户描述只覆盖了所选流程的一部分关键动作。"
    }];
    customEnvelope.workflow.runId = "v3-semantic-score-test";
    const customGenerated = await run(customEnvelope);
    assert.equal(customGenerated.output.processReviews[0].score, 60);
    assert.equal(customGenerated.output.processReviews[0].semanticAssessment.deduction, 20);
    assert.match(customGenerated.output.resultSummary, /partial：用户描述只覆盖了所选流程的一部分关键动作/u);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(workspaceRoot, generated.output.documentPath));
    const overlaySheet = workbook.getWorksheet("Target Overlay Display");
    const placeholderSheet = workbook.getWorksheet("Missing For Target");
    const coverSheet = workbook.getWorksheet("Cover");
    const arrangementSheet = workbook.getWorksheet("Production Arrange Chart");
    assert(overlaySheet);
    assert(placeholderSheet);
    assert(coverSheet);
    assert(arrangementSheet);
    assert.equal(coverSheet.getCell("A4").value, "TARGET Cross Project SOP");
    assert.equal(coverSheet.getCell("G4").value, "V3-001");
    assert.equal(coverSheet.getCell("D4").value, 2);
    assert.equal(coverSheet.getCell("A17").value, "Author: Patrick Xu");
    assert.equal(coverSheet.getCell("B17").master.address, "A17");
    assert.deepEqual(coverSheet.getCell("C7").value, {
      formula: 'IF(A7="","","Patrick Xu")'
    });
    assert.deepEqual(coverSheet.getCell("C16").value, {
      formula: 'IF(A16="","","Patrick Xu")'
    });
    assert.equal(coverSheet.getCell("C17").value, "Audit:");
    assert.equal(coverSheet.getCell("H17").master.address, "C17");
    assert.equal(arrangementSheet.getCell("F2").value, "TARGET");
    assert.deepEqual(arrangementSheet.getCell("H2").value, {
      formula: 'IF(Cover!D4="","",Cover!D4)',
      result: 2
    });
    assert.deepEqual(arrangementSheet.getCell("H4").value, {
      formula: 'SUM(G8:G9)&" s"',
      result: "80 s"
    });
    assert.equal(arrangementSheet.pageSetup.printArea, "A1:H9");
    assert.equal(arrangementSheet.getCell("C8").value, "Target Overlay Display");
    assert.equal(arrangementSheet.getCell("D8").value, "COMMON TOOL x1");
    assert.equal(arrangementSheet.getCell("G8").value, 40);
    assert.equal(arrangementSheet.getCell("C9").value, "Missing For Target");
    assert.equal(arrangementSheet.getCell("G9").value, 40);
    assert.equal(arrangementSheet.getCell("H9").master.address, "H8");
    assert.deepEqual(arrangementSheet.getCell("A8").value, {
      formula: 'IF(C8="","",COUNTA($C$8:C8))',
      result: 1
    });
    assert.deepEqual(overlaySheet.getCell("E3").value, {
      formula: "'Production Arrange Chart'!C8",
      result: "Target Overlay Display"
    });
    assert.deepEqual(overlaySheet.getCell("R3").value, {
      formula: '"Std. Time: "&\'Production Arrange Chart\'!G8&" s"',
      result: "Std. Time: 40 s"
    });
    assert.deepEqual(overlaySheet.getCell("A37").value, {
      formula: '"Page: "&1&"/"&Cover!D4',
      result: "Page: 1/2"
    });
    assert.equal(overlaySheet.getCell("A38").value, "Author: Patrick Xu");
    assert.equal(overlaySheet.getCell("C38").master.address, "A38");
    assert.equal(placeholderSheet.getCell("A38").value, "Author: Patrick Xu");
    assert.equal(overlaySheet.getCell("G7").value, "COMMON OPERATION STEP");
    assert.equal(overlaySheet.getCell("A29").value, "TARGET NOTE");
    assert.equal(overlaySheet.getCell("B8").value, null);
    assert.equal(overlaySheet.getImages().length, 3);
    assert.equal(placeholderSheet.getCell("G7").value, null);
    assert.equal(placeholderSheet.getCell("A29").value, null);
    assert.equal(placeholderSheet.getImages().length, 2);
    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow((row) => row.eachCell((cell) => {
        assert.doesNotMatch(String(cell.value ?? ""), /SOURCE SENTINEL MUST NOT LEAK/u);
      }));
    }
    const placeholderDirectory = path.join(sessionWorkspace, "effective-processes/v3-overlay-test/missing_for_target");
    assert.deepEqual((await fs.readdir(placeholderDirectory)).sort(), ["metadata.txt"]);

    const frozenStepPath = path.join(ckdRoot, "processes_lib/assembly_test/overlay_process/operation_steps.txt");
    await fs.writeFile(frozenStepPath, "CHANGED AFTER CATALOG\n");
    await assert.rejects(
      () => run(structuredClone(envelope)),
      /differs from the frozen Catalog snapshot/u
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("v3 scoring uses fixed semantic bands, operation hard zero, and per-category cross-layer deductions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "patrick-ckd-v3-score-"));
  try {
    const folder = path.join(root, "effective");
    await write(path.join(folder, "operation_steps.txt"), "Do the operation\n");
    await write(path.join(folder, "material_details.jsonl"), '{"name":"Part"}\n');
    await write(path.join(folder, "tools_fixtures_equipment.jsonl"), '{"name":"Tool"}\n');
    await write(path.join(folder, "technical_notes.txt"), "Note\n");
    await write(path.join(folder, "photos/p1-instruction.png"), Buffer.from([1, 2, 3]));

    const { scoreProcess } = require(path.join(generatorRoot, "index.cjs"));
    const materialization = {
      folder,
      fileSources: {
        "operation_steps.txt": "common",
        "material_details.jsonl": "common",
        "tools_fixtures_equipment.jsonl": "common",
        "technical_notes.txt": "common",
        photos: "common"
      }
    };
    const completeLayer = {
      operationSteps: "Do the operation",
      materialDetails: [{ name: "Part" }],
      toolsFixturesEquipment: [{ name: "Tool" }],
      technicalNotes: "Note",
      assets: {
        photosDirectoryPresent: true,
        photoSetFormat: "directory",
        instructionPhotos: [{
          index: 1,
          fileName: "p1-instruction.png",
          relativePath: "processes/test/common/photos/p1-instruction.png"
        }],
        instructionPhoto: "processes/test/common/photos/p1-instruction.png"
      },
      files: [{ relativePath: "processes/test/common/photos/p1-instruction.png", size: 3 }]
    };
    const processRecord = { commonLayer: completeLayer, projectLayers: [] };
    const expectedScores: Record<string, number> = {
      equivalent: 100,
      close: 90,
      partial: 80,
      different: 50
    };
    for (const [semanticMatch, expectedScore] of Object.entries(expectedScores)) {
      const scored = scoreProcess({
        requestedProcess: "Requested",
        semanticMatch,
        semanticReason: "固定分档测试。"
      }, materialization, processRecord, "custom");
      assert.equal(scored.score, expectedScore);
    }

    await fs.rm(path.join(folder, "material_details.jsonl"));
    const factoryWithoutMaterial = scoreProcess({
      requestedProcess: "Factory Process",
      semanticMatch: "equivalent",
      semanticReason: "Factory Test 不评分 Material。"
    }, materialization, processRecord, "custom", "factory_test");
    assert.equal(factoryWithoutMaterial.score, 100);
    assert.equal(factoryWithoutMaterial.missingCategories.includes("material"), false);
    await write(path.join(folder, "material_details.jsonl"), '{"name":"Part"}\n');

    await fs.rm(path.join(folder, "operation_steps.txt"));
    const hardZero = scoreProcess({
      requestedProcess: "Requested",
      semanticMatch: "equivalent",
      semanticReason: "语义一致。"
    }, materialization, processRecord, "custom");
    assert.equal(hardZero.score, 0);
    assert.equal(hardZero.operationAssessment.deduction, 100);
    assert.equal(hardZero.semanticAssessment.deduction, 0);

    await write(path.join(folder, "operation_steps.txt"), "Do the operation\n");
    await fs.rm(path.join(folder, "photos"), { recursive: true });
    materialization.fileSources.photos = "missing";
    const otherPhotoPath = "processes/test/projects/OTHER/photos/p1-instruction.png";
    const crossLayer = scoreProcess({ requestedProcess: "Reference" }, materialization, {
      commonLayer: {
        ...completeLayer,
        assets: { photosDirectoryPresent: false, photoSetFormat: "missing", instructionPhotos: [], instructionPhoto: null },
        files: []
      },
      projectLayers: [{
        projectId: "OTHER",
        operationSteps: "",
        materialDetails: [],
        toolsFixturesEquipment: [],
        technicalNotes: "",
        assets: {
          photosDirectoryPresent: true,
          photoSetFormat: "directory",
          instructionPhotos: [{ index: 1, fileName: "p1-instruction.png", relativePath: otherPhotoPath }],
          instructionPhoto: otherPhotoPath
        },
        files: [{ relativePath: otherPhotoPath, size: 3 }]
      }]
    }, "reference");
    assert.equal(crossLayer.score, 80);
    assert.equal(crossLayer.completenessAssessment.deduction, 0);
    assert.equal(crossLayer.crossLayerAssessment.deduction, 20);
    assert.deepEqual(crossLayer.crossLayerAssessment.categories, ["photo"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("v3 Excel generator lays out 1 to 12 ordered photos inside G17:U36 without removing header images", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "patrick-ckd-photo-layout-"));
  try {
    const sourcePhoto = path.join(generatorRoot, "RoHS-pic.png");
    const { buildCkdSop, photoGrid, resolveInstructionPhotos } = require(path.join(generatorRoot, "fill_sop_sheet.js"));
    assert.deepEqual(Array.from({ length: 12 }, (_, index) => index + 1).map((count) => [count, photoGrid(count)]), [
      [1, { rows: 1, cols: 1, rowCounts: [1] }],
      [2, { rows: 1, cols: 2, rowCounts: [2] }],
      [3, { rows: 2, cols: 2, rowCounts: [2, 1] }],
      [4, { rows: 2, cols: 2, rowCounts: [2, 2] }],
      [5, { rows: 2, cols: 3, rowCounts: [3, 2] }],
      [6, { rows: 2, cols: 3, rowCounts: [3, 3] }],
      [7, { rows: 2, cols: 4, rowCounts: [4, 3] }],
      [8, { rows: 2, cols: 4, rowCounts: [4, 4] }],
      [9, { rows: 3, cols: 3, rowCounts: [3, 3, 3] }],
      [10, { rows: 3, cols: 4, rowCounts: [4, 3, 3] }],
      [11, { rows: 3, cols: 4, rowCounts: [4, 4, 3] }],
      [12, { rows: 3, cols: 4, rowCounts: [4, 4, 4] }]
    ]);
    for (const count of Array.from({ length: 12 }, (_, index) => index + 1)) {
      const dataDir = path.join(root, `data-${count}`);
      const photosDir = path.join(dataDir, "photos");
      await fs.mkdir(photosDir, { recursive: true });
      for (let index = count; index >= 1; index -= 1) {
        await fs.copyFile(sourcePhoto, path.join(photosDir, `p${index}-photo.png`));
      }
      const output = path.join(root, `layout-${count}.xlsx`);
      await buildCkdSop({
        template: path.join(generatorRoot, "urovo-sop-template.xlsx"),
        dataDir,
        output
      });
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(output);
      const sheet = workbook.getWorksheet("TestTemplate");
      assert(sheet);
      const images = sheet.getImages();
      assert.equal(images.length, count + 2);
      const operationImages = images.filter((image) => {
        const topLeft = image.range?.tl;
        return topLeft && topLeft.nativeRow >= 16 && topLeft.nativeCol >= 6;
      });
      assert.equal(operationImages.length, count);
      for (const image of operationImages) {
        assert.ok(image.range.tl.nativeRow >= 16);
        assert.ok(image.range.tl.nativeCol >= 6);
        assert.ok(image.range.br.nativeRow <= 36);
        assert.ok(image.range.br.nativeCol <= 21);
        assert.equal(Number.isInteger(image.range.tl.nativeColOff), true);
        assert.equal(Number.isInteger(image.range.tl.nativeRowOff), true);
        assert.equal(Number.isInteger(image.range.br.nativeColOff), true);
        assert.equal(Number.isInteger(image.range.br.nativeRowOff), true);
      }
      const imagesPerRow = [...operationImages.reduce((groups, image) => {
        const row = image.range.tl.nativeRow;
        groups.set(row, (groups.get(row) ?? 0) + 1);
        return groups;
      }, new Map<number, number>()).entries()]
        .sort(([left], [right]) => left - right)
        .map(([, imageCount]) => imageCount);
      assert.deepEqual(imagesPerRow, photoGrid(count).rowCounts);
      if (count === 5) {
        const zip = await JSZip.loadAsync(await fs.readFile(output));
        const drawingNames = Object.keys(zip.files).filter((name) => /^xl\/drawings\/drawing\d+\.xml$/u.test(name));
        for (const drawingName of drawingNames) {
          const drawingXml = await zip.file(drawingName)?.async("text");
          assert.ok(drawingXml);
          assert.doesNotMatch(drawingXml, /<xdr:(?:colOff|rowOff)>-?\d+\.\d+<\/xdr:(?:colOff|rowOff)>/u);
        }
      }
    }
    const cappedDataDir = path.join(root, "data-13");
    await fs.mkdir(path.join(cappedDataDir, "photos"), { recursive: true });
    for (let index = 1; index <= 13; index += 1) {
      await fs.copyFile(sourcePhoto, path.join(cappedDataDir, "photos", `p${index}-photo.png`));
    }
    assert.deepEqual(
      resolveInstructionPhotos(cappedDataDir).map((photo: Record<string, unknown>) => photo.index),
      Array.from({ length: 12 }, (_, index) => index + 1)
    );
    const plainNamesDir = path.join(root, "plain-names");
    await fs.mkdir(path.join(plainNamesDir, "photos"), { recursive: true });
    await fs.copyFile(sourcePhoto, path.join(plainNamesDir, "photos", "p1.png"));
    assert.deepEqual(resolveInstructionPhotos(plainNamesDir).map((photo: Record<string, unknown>) => photo.fileName), ["p1.png"]);
    assert.throws(() => photoGrid(13), /1 to 12/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
