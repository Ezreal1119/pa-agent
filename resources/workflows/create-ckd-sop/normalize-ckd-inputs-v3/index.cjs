#!/usr/bin/env node

const fs = require("node:fs");

function parseCli(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if ((key !== "--input" && key !== "--output") || !value) {
      throw new Error("Usage: node index.cjs --input <input.json> --output <output.json>");
    }
    result[key.slice(2)] = value;
  }
  if (!result.input || !result.output) throw new Error("Both --input and --output are required.");
  return result;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name} cannot exceed ${maxLength} characters.`);
  return normalized;
}

function safeIdentifier(value, fallback, maxLength) {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^[_-]+|[_-]+$/gu, "")
    .slice(0, maxLength)
    .replace(/[_-]+$/gu, "");
  return sanitized || fallback;
}

function normalizeProcessList(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("processList must contain at least one process.");
  }
  if (value.length > 30) throw new Error("processList cannot contain more than 30 processes.");
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const processName = requiredText(item, "Each processList item", 120);
    const key = processName.toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new Error(`processList contains a duplicate process: ${processName}`);
    seen.add(key);
    result.push(processName);
  }
  return result;
}

function main() {
  const cli = parseCli(process.argv);
  const envelope = JSON.parse(fs.readFileSync(cli.input, "utf8"));
  if (!isRecord(envelope) || !isRecord(envelope.inputs)) {
    throw new Error("Workflow input.json must contain inputs.");
  }
  const inputs = envelope.inputs;
  const sopType = typeof inputs.sopType === "string" && inputs.sopType.trim() ? inputs.sopType.trim() : "assembly_test";
  if (!["assemble", "assembly_test", "pcba_test", "aging_test", "factory_test"].includes(sopType)) throw new Error(`Unsupported CKD SOP type: ${sopType}`);
  const templateLanguage = typeof inputs.templateLanguage === "string" && inputs.templateLanguage.trim()
    ? inputs.templateLanguage.trim()
    : "English";
  if (!["English", "中文"].includes(templateLanguage)) throw new Error(`Unsupported template language: ${templateLanguage}`);
  const originalProjectName = requiredText(inputs.projectName, "projectName", 120);
  const documentNumber = requiredText(inputs.documentNumber, "documentNumber", 80);
  const sopName = requiredText(inputs.sopName, "sopName", 200);
  // New Runs require Author at Workflow validation. Empty remains accepted here
  // only so a pre-Author Run that was already started can still resume safely.
  const rawAuthor = typeof inputs.author === "string" ? inputs.author.trim() : "";
  const author = rawAuthor
    ? requiredText(rawAuthor.replace(/^Author\s*:\s*/iu, ""), "author", 200)
    : "";
  const processList = normalizeProcessList(inputs.processList);
  const projectMatchResult = isRecord(inputs.projectMatchResult)
    ? inputs.projectMatchResult
    : {};
  const matchedProjectId = typeof projectMatchResult.matchedProjectId === "string"
    ? projectMatchResult.matchedProjectId.trim()
    : "";
  const sopProcessSelection = isRecord(inputs.sopProcessSelection)
    ? inputs.sopProcessSelection
    : {};
  const projectName = matchedProjectId || safeIdentifier(originalProjectName, "project", 120);
  const safeDocumentNumber = safeIdentifier(documentNumber, "ckd-sop", 120);
  const referenceProcessIds = Array.isArray(sopProcessSelection.referenceProcessIds)
    ? sopProcessSelection.referenceProcessIds
    : [];
  const referenceProcessIdsValid = referenceProcessIds.length === processList.length
    && referenceProcessIds.every((processId) => typeof processId === "string" && Boolean(processId.trim()));
  const referenceSopId = typeof sopProcessSelection.referenceSopId === "string"
    ? sopProcessSelection.referenceSopId.trim()
    : "";
  const referenceProjectId = typeof sopProcessSelection.referenceProjectId === "string"
    ? sopProcessSelection.referenceProjectId.trim()
    : "";
  const referenceFastPathEligible = sopProcessSelection.mode === "reference"
    && Boolean(referenceSopId)
    && Boolean(referenceProjectId)
    && referenceProjectId === matchedProjectId
    && referenceProcessIdsValid;
  const referenceTransplantEligible = sopProcessSelection.mode === "reference"
    && Boolean(referenceSopId)
    && Boolean(referenceProjectId)
    && Boolean(matchedProjectId)
    && referenceProjectId !== matchedProjectId
    && referenceProcessIdsValid;
  const semanticProcessResolutionRequired = !(referenceFastPathEligible || referenceTransplantEligible);
  const warnings = [];
  if (!matchedProjectId) {
    warnings.push("No Library project matched; a safe fallback project identifier was derived from the confirmed Project Name.");
  }
  const normalizedInputs = {
    sopType,
    templateLanguage,
    projectName,
    documentNumber,
    safeDocumentNumber,
    sopName,
    author,
    ...(sopType === "assemble" ? Object.fromEntries([["revisionReason", 1000], ["revisionContent", 4000]].map(([key, max]) => {
      const value = inputs[key];
      if (value !== undefined && typeof value !== "string") throw new Error(`${key} must be text.`);
      const text = (value || "").trim();
      if (text.length > max) throw new Error(`${key} must not exceed ${max} characters.`);
      return [key, text];
    })) : {}),
    processList,
    referenceFastPathEligible,
    referenceTransplantEligible,
    semanticProcessResolutionRequired
  };
  fs.writeFileSync(cli.output, JSON.stringify({
    summary: `CKD inputs normalized for project ${projectName}.`,
    output: {
      ...normalizedInputs,
      warnings
    },
    artifacts: [],
    statePatch: { normalizedInputs }
  }));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
