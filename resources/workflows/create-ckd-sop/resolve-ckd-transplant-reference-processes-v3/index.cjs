#!/usr/bin/env node

const fs = require("node:fs");

function parseCli(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if ((key !== "--input" && key !== "--output") || !value) throw new Error("Usage: node index.cjs --input <input.json> --output <output.json>");
    result[key.slice(2)] = value;
  }
  if (!result.input || !result.output) throw new Error("Both --input and --output are required.");
  return result;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function requiredList(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw new Error(`${name} must contain 1 to 30 entries.`);
  return value.map((entry, index) => requiredText(entry, `${name}[${index}]`));
}

function conciseOverview(value, processName) {
  const overview = typeof value === "string" ? value.trim() : "";
  const sentence = overview.split(/(?<=[。！？!?])\s*/u)[0].slice(0, 80);
  return /[\u3400-\u9fff]/u.test(sentence) ? sentence : `该流程用于执行「${processName}」相关操作。`.slice(0, 80);
}

function main() {
  const cli = parseCli(process.argv);
  const envelope = JSON.parse(fs.readFileSync(cli.input, "utf8"));
  if (!isRecord(envelope) || !isRecord(envelope.inputs)) throw new Error("Workflow input.json must contain inputs.");
  const inputs = envelope.inputs;
  const project = isRecord(inputs.projectMatchResult) ? inputs.projectMatchResult : {};
  const selection = isRecord(inputs.sopProcessSelection) ? inputs.sopProcessSelection : {};
  const summary = isRecord(inputs.catalogSummary) ? inputs.catalogSummary : {};
  const sopSummary = isRecord(inputs.sopCatalogSummary) ? inputs.sopCatalogSummary : {};
  const targetProjectId = requiredText(project.matchedProjectId, "matchedProjectId");
  const targetProjectName = requiredText(project.matchedProjectName, "matchedProjectName");
  const processList = requiredList(inputs.processList, "processList");
  if (selection.mode !== "reference") throw new Error("The cross-project resolver requires a Library SOP reference.");
  const referenceProjectId = requiredText(selection.referenceProjectId, "referenceProjectId");
  const referenceProjectName = requiredText(selection.referenceProjectName, "referenceProjectName");
  const referenceSopId = requiredText(selection.referenceSopId, "referenceSopId");
  if (referenceProjectId === targetProjectId) throw new Error("The referenced SOP belongs to the target Project and requires the same-project resolver.");
  const referenceProcessIds = requiredList(selection.referenceProcessIds, "referenceProcessIds");
  if (referenceProcessIds.length !== processList.length) throw new Error("The referenced Process ID count does not match the confirmed Process list.");
  const selectedSop = (Array.isArray(sopSummary.sops) ? sopSummary.sops : []).find((sop) => isRecord(sop)
    && sop.projectId === referenceProjectId && sop.sopId === referenceSopId);
  if (!selectedSop || !Array.isArray(selectedSop.processSequence) || selectedSop.processSequence.length !== processList.length) {
    throw new Error("The selected Library SOP could not be verified in the frozen SOP Catalog.");
  }
  const globalProcesses = Array.isArray(summary.processes) ? summary.processes : [];
  const seen = new Set();
  const processes = processList.map((requestedProcess, index) => {
    const sopProcess = selectedSop.processSequence[index];
    if (!isRecord(sopProcess) || sopProcess.processId !== referenceProcessIds[index] || sopProcess.displayName !== requestedProcess) {
      throw new Error(`Referenced Process ${index + 1} does not match the frozen Library SOP sequence.`);
    }
    const process = globalProcesses.find((candidate) => isRecord(candidate) && candidate.processId === referenceProcessIds[index]);
    if (!process) throw new Error(`Referenced Process ID was not found in the global Process Catalog: ${referenceProcessIds[index]}`);
    if (seen.has(referenceProcessIds[index])) throw new Error(`Referenced Process ID is duplicated: ${referenceProcessIds[index]}`);
    seen.add(referenceProcessIds[index]);
    const resolvedProcessName = requiredText(sopProcess.displayName || process.displayName, "resolvedProcessName");
    return {
      requestedProcess,
      resolvedProcessId: referenceProcessIds[index],
      resolvedProcessName,
      overview: conciseOverview(sopProcess.overview || process.overview, resolvedProcessName),
      status: "transplanted",
      sourceProjectId: referenceProjectId,
      sourceProjectName: referenceProjectName,
      confidence: 1,
      comment: `只借用 ${referenceProjectName} SOP 的 Process 顺序；内容将在生成阶段仅按目标项目 ${targetProjectName} 专属文件优先、common 回退解析。`,
      semanticMatch: "not_applicable",
      semanticReason: "跨项目仅借用 Library SOP 顺序，不进行用户手动描述的语义匹配评分。",
      warnings: []
    };
  });
  fs.writeFileSync(cli.output, JSON.stringify({
    summary: `已从跨 Project SOP 精确确认 ${processes.length} 个 Process ID；未移植来源项目内容。`,
    output: { processes },
    artifacts: [],
    statePatch: { processesMatchResult: processes }
  }));
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
