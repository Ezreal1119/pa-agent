#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-v3-catalog-overview-"));
  try {
    const libraryRoot = path.join(root, "library");
    const ckdRoot = path.join(libraryRoot, "ckd-library-v2");
    const workspaceRoot = path.join(root, "workspace");
    const sessionWorkspace = path.join(workspaceRoot, "session");

    for (const projectId of ["project_a", "project_b"]) {
      writeFile(path.join(ckdRoot, "product_lib", projectId, "project.json"), JSON.stringify({
        version: 1,
        projectId,
        displayName: projectId === "project_a" ? "项目A" : "项目B",
        aliases: [projectId]
      }));
    }
    writeFile(path.join(ckdRoot, "product_lib", "project_a", "assembly_test", "sops.json"), JSON.stringify({
      version: 1,
      sops: [{
        sopId: "software_setup",
        displayName: "软件环境安装",
        processSequence: ["software_env_setup"]
      }]
    }));
    writeFile(path.join(ckdRoot, "product_lib", "project_b", "assembly_test", "sops.json"), JSON.stringify({ version: 1, sops: [] }));
    writeFile(path.join(ckdRoot, "processes_lib", "assembly_test", "software_env_setup", "metadata"), "软件环境安装");
    writeFile(path.join(ckdRoot, "processes_lib", "assembly_test", "software_env_setup", "overview.json"), JSON.stringify({
      overview: "通用软件环境安装流程。"
    }));
    writeFile(path.join(ckdRoot, "processes_lib", "assembly_test", "software_env_setup", "operation_steps.txt"), "common step");
    writeFile(path.join(ckdRoot, "product_lib", "project_b", "assembly_test", "derived", "software_env_setup", "overview.json"), JSON.stringify({
      schemaVersion: 2,
      scope: "project-effective",
      processId: "software_env_setup",
      projectId: "project_b",
      effectiveContentHash: "a".repeat(64),
      overview: "项目 B 使用 GMUKey 工具。"
    }));
    writeFile(path.join(ckdRoot, "product_lib", "project_b", "assembly_test", "derived", "software_env_setup", "summary.json"), JSON.stringify({
      schemaVersion: 2,
      scope: "project-effective",
      processId: "software_env_setup",
      projectId: "project_b",
      effectiveContentHash: "a".repeat(64),
      fileSources: { "operation_steps.txt": "project" }
    }));
    writeFile(path.join(ckdRoot, "product_lib", "project_b", "assembly_test", "processes", "software_env_setup", "operation_steps.txt"), "project step");

    fs.mkdirSync(sessionWorkspace, { recursive: true });
    const inputPath = path.join(root, "input.json");
    const outputPath = path.join(root, "output.json");
    writeFile(inputPath, JSON.stringify({
      inputs: { sopType: "assembly_test" },
      paths: { libraryRoots: [libraryRoot], workspaceRoot, sessionWorkspace }
    }));
    execFileSync(process.execPath, [
      path.join(__dirname, "..", "index.cjs"),
      "--input", inputPath,
      "--output", outputPath
    ], { encoding: "utf8" });

    const output = JSON.parse(fs.readFileSync(outputPath, "utf8")).output;
    assert.equal(output.projectCount, 2);
    assert.equal(output.sopType, "assembly_test");
    assert.equal(output.processCount, 1);
    assert.equal(output.processLayerCount, 2);
    assert.equal(output.sopCount, 1);
    assert.equal(output.catalogDetails.processes[0].commonLayer.overview, "通用软件环境安装流程。");
    assert.equal(output.catalogDetails.processes[0].projectLayers[0].projectId, "project_b");
    assert.equal(output.catalogDetails.processes[0].projectLayers[0].overview, "");
    assert.equal(output.catalogDetails.processes[0].projectDerived[0].overview, "项目 B 使用 GMUKey 工具。");
    assert.equal(output.catalogDetails.processes[0].projectDerived[0].fileSources["operation_steps.txt"], "project");
    assert.deepEqual(output.catalogSummary.processes[0].projectOverviews, {
      project_b: "项目 B 使用 GMUKey 工具。"
    });
    assert.deepEqual(output.sopCatalogSummary.sops[0].processSequence, [{
      processId: "software_env_setup",
      displayName: "软件环境安装",
      overview: "通用软件环境安装流程。"
    }]);
    console.log("v3 overview catalog tests passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
