#!/usr/bin/env node

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildCkdSop } = require("./fill_sop_sheet.js");
const PHOTO_DIRECTORY = "photos";
const LEGACY_PHOTO_FILE = "instruction_photos.png";
const MAX_PHOTO_COUNT = 12;
const METADATA_FILES = ["metadata.txt", "metadata"];
const PHOTO_NAME_PATTERN = /^p(\d+)(?:-(.+))?\.(?:png|jpe?g)$/iu;
const ASSEMBLY_FILES = Object.freeze({
  material: "Bill_of_Materials.jsonl",
  tools: "Tools.jsonl",
  operation: "Operation_Instruction.txt",
  photos: "Operation_Photos",
  previousStationCheck: "Previous_Station_Check.txt",
  previousStationCheckPhoto: "previous_station_check_photo.png",
  selfCheck: "Self_Check.txt"
});

const PROCESS_FILES = [
  "material_details.jsonl",
  "tools_fixtures_equipment.jsonl",
  "technical_notes.txt",
  "operation_steps.txt"
];
const CONTENT_CATEGORIES = [
  { key: "operation", filename: "operation_steps.txt", label: "Operation 操作步骤", required: true },
  { key: "material", filename: "material_details.jsonl", label: "材料", required: false },
  { key: "photo", filename: PHOTO_DIRECTORY, label: "操作图片", required: false },
  { key: "technicalNotes", filename: "technical_notes.txt", label: "技术说明", required: false },
  { key: "tools", filename: "tools_fixtures_equipment.jsonl", label: "工具 / 治具 / 设备", required: false }
];
const ASSEMBLY_CONTENT_CATEGORIES = [
  { key: "operation", filename: ASSEMBLY_FILES.operation, label: "Operation Instruction", required: true },
  { key: "material", filename: ASSEMBLY_FILES.material, label: "Bill of Materials", required: false },
  { key: "photo", filename: ASSEMBLY_FILES.photos, label: "Operation Photos", required: false },
  { key: "previousStationCheck", filename: ASSEMBLY_FILES.previousStationCheck, label: "Previous Station Check", required: false },
  { key: "previousStationCheckPhoto", filename: ASSEMBLY_FILES.previousStationCheckPhoto, label: "Previous Station Check 图片", required: false },
  { key: "selfCheck", filename: ASSEMBLY_FILES.selfCheck, label: "Self Check", required: false },
  { key: "tools", filename: ASSEMBLY_FILES.tools, label: "Tools", required: false }
];
const SEMANTIC_DEDUCTIONS = {
  equivalent: 0,
  close: 10,
  partial: 20,
  different: 50
};
const PLACEHOLDER_WARNING = "目标项目及 common 均无可用资料，本页仅为 SOP 顺序占位。";

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

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function requiredText(value, name, maxLength = 10_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name} cannot exceed ${maxLength} characters.`);
  return normalized;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeIdentifier(value, fallback, maxLength = 120) {
  const sanitized = String(value || "").normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]+/gu, "_").replace(/_+/gu, "_")
    .replace(/^[_-]+|[_-]+$/gu, "").slice(0, maxLength).replace(/[_-]+$/gu, "");
  return sanitized || fallback;
}

function safeFilenamePart(value, fallback, maxLength = 96) {
  const sanitized = String(value || "").normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, maxLength)
    .replace(/[._-]+$/gu, "");
  return sanitized || fallback;
}

function formatLocalDate(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildOutputFileName(projectName, sopName, date = new Date()) {
  const projectPart = safeFilenamePart(projectName, "project");
  const sopPart = safeFilenamePart(sopName, "sop");
  return `${projectPart}_${sopPart}_${formatLocalDate(date)}.xlsx`;
}

function humanizeIdentifier(value) {
  return value.replace(/[_-]+/gu, " ").trim().split(/\s+/u).filter(Boolean)
    .map((part) => /^[A-Z0-9]+$/u.test(part) ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizedWarnings(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().slice(0, 1_000));
}

function conciseWarnings(values) {
  return normalizedWarnings(values)
    .map((warning) => warning.replace(/^\[[^\]]+\]\s*/u, "").slice(0, 200))
    .filter(Boolean).slice(0, 2);
}

function summaryText(value, fallback, maxLength = 500) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/\s+/gu, " ").slice(0, maxLength);
}

function markdownCell(value, fallback = "-") {
  return summaryText(value, fallback, 500).replace(/\|/gu, "&#124;").replace(/[\r\n]+/gu, " ");
}

function conciseOverview(value, processName) {
  const text = summaryText(value, "", 500);
  if (!text) return `该流程用于执行「${processName}」相关操作。`;
  const firstSentence = text.split(/(?<=[。！？!?])\s*/u)[0].slice(0, 80);
  return /[\u3400-\u9fff]/u.test(firstSentence) ? firstSentence : `该流程用于执行「${processName}」相关操作。`;
}

function validateSopProcessSelection(value, processList) {
  if (value == null) return undefined;
  if (!isRecord(value) || !["custom", "reference"].includes(value.mode)) {
    throw new Error('sopProcessSelection.mode must be exactly "custom" or "reference".');
  }
  if (!Array.isArray(value.processList) || value.processList.length !== processList.length) {
    throw new Error("sopProcessSelection.processList must match normalizedInputs.processList.");
  }
  value.processList.forEach((item, index) => {
    if (requiredText(item, `sopProcessSelection.processList[${index}]`, 120) !== processList[index]) {
      throw new Error("sopProcessSelection.processList order differs from normalizedInputs.processList.");
    }
  });
  const selection = { mode: value.mode, comment: summaryText(value.comment, "") };
  if (value.mode === "reference") {
    selection.referenceSopId = requiredText(value.referenceSopId, "sopProcessSelection.referenceSopId", 120);
    selection.referenceSopName = requiredText(value.referenceSopName, "sopProcessSelection.referenceSopName", 200);
    selection.referenceProjectId = requiredText(value.referenceProjectId, "sopProcessSelection.referenceProjectId", 120);
    selection.referenceProjectName = requiredText(value.referenceProjectName, "sopProcessSelection.referenceProjectName", 200);
    if (!Array.isArray(value.referenceProcessIds) || value.referenceProcessIds.length !== processList.length) {
      throw new Error("sopProcessSelection.referenceProcessIds must match the selected Process list.");
    }
    value.referenceProcessIds.forEach((item, index) => requiredText(item, `sopProcessSelection.referenceProcessIds[${index}]`, 120));
  }
  return selection;
}

function resolveWorkspaceFile(workspaceRoot, requestedPath) {
  const resolved = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(workspaceRoot, requestedPath);
  if (!isInside(workspaceRoot, resolved)) throw new Error(`Workspace file is outside the configured Workspace: ${requestedPath}`);
  return resolved;
}

function readAndValidateCatalog(inputs, paths) {
  const catalogPath = requiredText(inputs.catalogPath, "catalogPath", 1_000);
  const resolvedPath = resolveWorkspaceFile(paths.workspaceRoot, catalogPath);
  if (!isInside(paths.sessionWorkspace, resolvedPath)) throw new Error("catalogPath must belong to the current Session Workspace.");
  const catalog = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  if (!isRecord(catalog) || catalog.schemaVersion !== 3 || !Array.isArray(catalog.projects) || !Array.isArray(catalog.processes)) {
    throw new Error("CKD v3 Catalog has an unsupported structure.");
  }
  const { generatedAt: _generatedAt, catalogHash, ...hashContent } = catalog;
  const computedHash = sha256(JSON.stringify(hashContent));
  const expectedHash = requiredText(inputs.catalogHash, "catalogHash", 200);
  if (catalogHash !== computedHash || expectedHash !== computedHash) throw new Error("CKD Catalog Hash does not match the frozen snapshot.");
  const ckdLibraryRoot = catalog.source && catalog.source.ckdLibraryRoot;
  if (typeof ckdLibraryRoot !== "string") throw new Error("CKD v3 Catalog source path is missing.");
  const realLibraryRoot = fs.realpathSync(ckdLibraryRoot);
  const libraryRoots = Array.isArray(paths.libraryRoots) ? paths.libraryRoots : [];
  if (!libraryRoots.some((libraryRoot) => {
    try { return isInside(fs.realpathSync(libraryRoot), realLibraryRoot); } catch { return false; }
  })) throw new Error("CKD v3 Catalog source is outside configured read-only Libraries.");
  return { catalog, ckdLibraryRoot: realLibraryRoot };
}

function findProject(catalog, projectId) {
  return catalog.projects.find((project) => isRecord(project) && project.projectId === projectId);
}

function findProcess(catalog, processId) {
  return catalog.processes.find((process) => isRecord(process) && process.processId === processId);
}

function orderedPlans(processList, plans) {
  if (!Array.isArray(plans) || plans.length !== processList.length) {
    throw new Error("processPlans must contain exactly one plan for every confirmed Process.");
  }
  const remaining = [...plans];
  return processList.map((requestedProcess) => {
    const index = remaining.findIndex((plan) => isRecord(plan)
      && typeof plan.requestedProcess === "string"
      && plan.requestedProcess.trim().toLocaleLowerCase("en-US") === requestedProcess.trim().toLocaleLowerCase("en-US"));
    if (index < 0) throw new Error(`No processPlan was returned for: ${requestedProcess}`);
    return remaining.splice(index, 1)[0];
  });
}

function copyLayer(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".DS_Store") continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`CKD Process layers cannot contain symlinks: ${sourcePath}`);
    if (entry.isDirectory()) {
      fs.mkdirSync(targetPath, { recursive: true });
      copyLayer(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function regularFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function normalizedFileName(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function resolveCaseInsensitiveEntry(directory, canonicalName, expectedKind = "file") {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return null;
  const expected = normalizedFileName(canonicalName);
  const matches = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store" && normalizedFileName(entry.name) === expected);
  if (matches.length > 1) {
    throw new Error(`${directory} contains ambiguous case-insensitive matches for ${canonicalName}: ${matches.map((entry) => entry.name).join(", ")}`);
  }
  const entry = matches[0];
  if (!entry) return null;
  if (entry.isSymbolicLink()) throw new Error(`CKD Process layers cannot contain symlinks: ${path.join(directory, entry.name)}`);
  const valid = expectedKind === "directory" ? entry.isDirectory() : entry.isFile();
  if (!valid) throw new Error(`${path.join(directory, entry.name)} must be a ${expectedKind}.`);
  return { name: entry.name, path: path.join(directory, entry.name) };
}

function scanPhotoSet(folder, options = {}) {
  const directoryName = options.directoryName || PHOTO_DIRECTORY;
  const caseInsensitive = options.caseInsensitive === true;
  const directoryMatch = caseInsensitive
    ? resolveCaseInsensitiveEntry(folder, directoryName, "directory")
    : (fs.existsSync(path.join(folder, directoryName))
        ? { name: directoryName, path: path.join(folder, directoryName) }
        : null);
  const directory = directoryMatch?.path || path.join(folder, directoryName);
  if (directoryMatch) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`CKD photos path must be a plain directory: ${directory}`);
    }
    const photos = [];
    const indexes = new Map();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .filter((item) => item.name !== ".DS_Store")
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || entry.isDirectory()) {
        throw new Error(`CKD photos directory cannot contain symlinks or subdirectories: ${filePath}`);
      }
      if (!entry.isFile()) continue;
      const match = PHOTO_NAME_PATTERN.exec(entry.name);
      if (!match) continue;
      const index = Number.parseInt(match[1], 10);
      if (!Number.isSafeInteger(index) || index < 1) {
        throw new Error(`CKD instruction photo index must be from 1 to ${MAX_PHOTO_COUNT}: ${filePath}`);
      }
      if (index > MAX_PHOTO_COUNT) continue;
      if (indexes.has(index)) {
        throw new Error(`CKD instruction photo index p${index} is duplicated: ${indexes.get(index)} and ${filePath}`);
      }
      indexes.set(index, filePath);
      photos.push({ index, filePath });
    }
    photos.sort((left, right) => left.index - right.index || left.filePath.localeCompare(right.filePath));
    return { directoryPresent: true, format: "directory", photos };
  }
  const legacyFile = options.legacyFile === undefined ? LEGACY_PHOTO_FILE : options.legacyFile;
  const legacyMatch = legacyFile
    ? (caseInsensitive
        ? resolveCaseInsensitiveEntry(folder, legacyFile)
        : (regularFile(path.join(folder, legacyFile)) ? { path: path.join(folder, legacyFile) } : null))
    : null;
  return legacyMatch
    ? { directoryPresent: false, format: "legacy", photos: [{ index: 1, filePath: legacyMatch.path }] }
    : { directoryPresent: false, format: "missing", photos: [] };
}

function nonEmptyTextFile(filePath) {
  return regularFile(filePath) && Boolean(fs.readFileSync(filePath, "utf8").trim());
}

function nonEmptyJsonlFile(filePath) {
  return regularFile(filePath)
    && fs.readFileSync(filePath, "utf8").split(/\r?\n/u).some((line) => line.trim());
}

function resolvedAssemblyFile(folder, canonicalName, expectedKind = "file") {
  return resolveCaseInsensitiveEntry(folder, canonicalName, expectedKind)?.path || null;
}

function effectiveContentPresence(folder, sopType = "assembly_test") {
  if (sopType === "assemble") {
    const photoSet = scanPhotoSet(folder, {
      directoryName: ASSEMBLY_FILES.photos,
      legacyFile: null,
      caseInsensitive: true
    });
    const previousPhoto = resolvedAssemblyFile(folder, ASSEMBLY_FILES.previousStationCheckPhoto);
    return {
      operation: nonEmptyTextFile(resolvedAssemblyFile(folder, ASSEMBLY_FILES.operation) || ""),
      material: nonEmptyJsonlFile(resolvedAssemblyFile(folder, ASSEMBLY_FILES.material) || ""),
      photo: photoSet.photos.some((photo) => fs.statSync(photo.filePath).size > 0),
      previousStationCheck: nonEmptyTextFile(resolvedAssemblyFile(folder, ASSEMBLY_FILES.previousStationCheck) || ""),
      previousStationCheckPhoto: Boolean(previousPhoto && fs.statSync(previousPhoto).size > 0),
      selfCheck: nonEmptyTextFile(resolvedAssemblyFile(folder, ASSEMBLY_FILES.selfCheck) || ""),
      tools: nonEmptyJsonlFile(resolvedAssemblyFile(folder, ASSEMBLY_FILES.tools) || "")
    };
  }
  const photoSet = scanPhotoSet(folder);
  return {
    operation: nonEmptyTextFile(path.join(folder, "operation_steps.txt")),
    material: nonEmptyJsonlFile(path.join(folder, "material_details.jsonl")),
    photo: photoSet.photos.some((photo) => fs.statSync(photo.filePath).size > 0),
    technicalNotes: nonEmptyTextFile(path.join(folder, "technical_notes.txt")),
    tools: nonEmptyJsonlFile(path.join(folder, "tools_fixtures_equipment.jsonl"))
  };
}

function categoriesForSopType(sopType) {
  if (sopType === "assemble") return ASSEMBLY_CONTENT_CATEGORIES;
  return sopType === "factory_test"
    ? CONTENT_CATEGORIES.filter((category) => category.key !== "material")
    : CONTENT_CATEGORIES;
}

function layerContentPresence(layer, sopType = "assembly_test") {
  const categories = categoriesForSopType(sopType);
  if (!isRecord(layer)) return Object.fromEntries(categories.map((category) => [category.key, false]));
  const photoPaths = isRecord(layer.assets) && Array.isArray(layer.assets.instructionPhotos)
    ? layer.assets.instructionPhotos.map((photo) => isRecord(photo) ? photo.relativePath : "").filter(Boolean)
    : isRecord(layer.assets) && typeof layer.assets.instructionPhoto === "string"
      ? [layer.assets.instructionPhoto]
      : [];
  const photoFiles = Array.isArray(layer.files)
    ? photoPaths.map((photoPath) => layer.files.find((file) => isRecord(file) && file.relativePath === photoPath)).filter(Boolean)
    : [];
  const presence = {
    operation: typeof layer.operationSteps === "string" && Boolean(layer.operationSteps.trim()),
    material: Array.isArray(layer.materialDetails) && layer.materialDetails.length > 0,
    photo: photoFiles.some((photoFile) => isRecord(photoFile) && typeof photoFile.size === "number" && photoFile.size > 0),
    technicalNotes: typeof layer.technicalNotes === "string" && Boolean(layer.technicalNotes.trim()),
    tools: Array.isArray(layer.toolsFixturesEquipment) && layer.toolsFixturesEquipment.length > 0
  };
  if (sopType === "assemble") {
    const previousPhotoPath = isRecord(layer.assets) && typeof layer.assets.previousStationCheckPhoto === "string"
      ? layer.assets.previousStationCheckPhoto
      : "";
    const previousPhotoFile = Array.isArray(layer.files)
      ? layer.files.find((file) => isRecord(file) && file.relativePath === previousPhotoPath)
      : null;
    presence.previousStationCheck = typeof layer.previousStationCheck === "string" && Boolean(layer.previousStationCheck.trim());
    presence.previousStationCheckPhoto = Boolean(isRecord(previousPhotoFile)
      && typeof previousPhotoFile.size === "number" && previousPhotoFile.size > 0);
    presence.selfCheck = typeof layer.selfCheck === "string" && Boolean(layer.selfCheck.trim());
  }
  return presence;
}

function globalCategoryEvidence(processRecord, sopType = "assembly_test") {
  const categories = categoriesForSopType(sopType);
  const evidence = Object.fromEntries(categories.map((category) => [category.key, []]));
  const layers = [
    ...(isRecord(processRecord.commonLayer) ? [{ label: "common", layer: processRecord.commonLayer }] : []),
    ...(Array.isArray(processRecord.projectLayers) ? processRecord.projectLayers
      .filter(isRecord)
      .map((layer) => ({ label: `项目 ${summaryText(layer.projectId, "unknown")}`, layer })) : [])
  ];
  for (const { label, layer } of layers) {
    const presence = layerContentPresence(layer, sopType);
    for (const category of categories) {
      if (presence[category.key]) evidence[category.key].push(label);
    }
  }
  return evidence;
}

function labelsFor(keys, sopType = "assembly_test") {
  const categories = categoriesForSopType(sopType);
  return keys.map((key) => categories.find((category) => category.key === key)?.label || key).join("、");
}

function scoreProcess(plan, materialization, processRecord, selectionMode, sopType) {
  const categories = categoriesForSopType(sopType);
  const presence = effectiveContentPresence(materialization.folder, sopType);
  const evidence = sopType === "assemble"
    ? Object.fromEntries(categories.map((category) => [category.key, []]))
    : globalCategoryEvidence(processRecord, sopType);
  const missingOptional = categories.filter((category) => !category.required && !presence[category.key]);
  const crossLayerMissing = missingOptional.filter((category) => evidence[category.key].length > 0);
  const ordinaryMissing = missingOptional.filter((category) => evidence[category.key].length === 0);
  const operationMissing = !presence.operation;
  const maskedCommon = crossLayerMissing.filter((category) =>
    materialization.fileSources[category.filename] === "project" && evidence[category.key].includes("common"));

  const operationAssessment = {
    deduction: operationMissing ? 100 : 0,
    comment: operationMissing
      ? `${categories.find((category) => category.key === "operation")?.filename || "operation_steps.txt"} 缺失或为空；按硬性规则，本 Process 直接计 0 分。`
      : `${categories.find((category) => category.key === "operation")?.filename || "operation_steps.txt"} 存在且包含有效内容。`
  };
  const completenessDeduction = operationMissing ? 0 : ordinaryMissing.length > 0 ? 10 : 0;
  const completenessAssessment = {
    deduction: completenessDeduction,
    comment: operationMissing
      ? `Operation 已触发硬性归零；其余资料不再重复扣分。当前缺少：${labelsFor(missingOptional.map((item) => item.key), sopType) || "无"}。`
      : missingOptional.length === 0
        ? "本类型纳入评分的资料均存在，不扣分。"
        : ordinaryMissing.length > 0
          ? `资料不完整，缺少且没有其他层证据的类别：${labelsFor(ordinaryMissing.map((item) => item.key), sopType)}；基础完整度一次性扣 10 分。${crossLayerMissing.length ? `另有跨层缺口 ${labelsFor(crossLayerMissing.map((item) => item.key), sopType)}，在下一项单独计分。` : ""}`
          : `纳入当前 SOP Type 评分的资料并非全部齐全，但缺失类别均有跨层证据，将在下一项计分，本项不重复扣分。`
  };
  const rawCrossLayerDeduction = crossLayerMissing.length * 20;
  const crossLayerAssessment = {
    deduction: operationMissing ? 0 : rawCrossLayerDeduction,
    gapCount: crossLayerMissing.length,
    categories: crossLayerMissing.map((category) => category.key),
    comment: crossLayerMissing.length === 0
      ? (sopType === "assemble"
          ? "Assembly 仅使用目标项目特异性资料，不读取 common，也不计算跨层缺口。"
          : "未发现 common 或其他项目存在、但目标项目有效内容缺失的资料类别。")
      : `${crossLayerMissing.map((category) => {
        const masked = maskedCommon.some((item) => item.key === category.key);
        return `${category.label}（证据：${evidence[category.key].join("、")}；${masked ? "目标项目空文件覆盖了 common" : "目标有效内容缺失"}）`;
      }).join("；")}。${operationMissing ? "Operation 已硬性归零，本项记录缺口但不再重复扣分。" : `每类扣 20 分，共扣 ${rawCrossLayerDeduction} 分。`}`
  };

  let semanticAssessment;
  if (selectionMode !== "custom") {
    semanticAssessment = {
      level: "not_applicable",
      deduction: 0,
      comment: "参考 Library SOP 顺序，仅评价资料完整度与跨层缺口，本项不适用。"
    };
  } else {
    const level = typeof plan.semanticMatch === "string" ? plan.semanticMatch : "";
    if (!Object.hasOwn(SEMANTIC_DEDUCTIONS, level)) {
      throw new Error(`${summaryText(plan.requestedProcess, "Process")}.semanticMatch must be equivalent, close, partial, or different for manual input.`);
    }
    const reason = requiredText(plan.semanticReason, `${summaryText(plan.requestedProcess, "Process")}.semanticReason`, 300);
    semanticAssessment = {
      level,
      deduction: operationMissing ? 0 : SEMANTIC_DEDUCTIONS[level],
      comment: `${level}：${reason}${operationMissing ? " Operation 已硬性归零，本项不再重复扣分。" : ""}`
    };
  }

  const totalDeduction = operationMissing
    ? 100
    : Math.min(100, completenessAssessment.deduction + crossLayerAssessment.deduction + semanticAssessment.deduction);
  return {
    score: 100 - totalDeduction,
    totalDeduction,
    missingCategories: categories.filter((category) => !presence[category.key]).map((category) => category.key),
    operationAssessment,
    completenessAssessment,
    crossLayerAssessment,
    semanticAssessment
  };
}

function scanLayerFiles(directory, libraryRoot) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".DS_Store") continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`CKD Process layers cannot contain symlinks: ${absolutePath}`);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) {
        const content = fs.readFileSync(absolutePath);
        files.push({
          relativePath: path.relative(libraryRoot, absolutePath).split(path.sep).join("/"),
          size: content.byteLength,
          sha256: sha256(content)
        });
      }
    }
  }
  visit(directory);
  return files;
}

function scanLayerDirectories(directory, libraryRoot) {
  const directories = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".DS_Store") continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`CKD Process layers cannot contain symlinks: ${absolutePath}`);
      if (entry.isDirectory()) {
        directories.push(path.relative(libraryRoot, absolutePath).split(path.sep).join("/"));
        visit(absolutePath);
      }
    }
  }
  visit(directory);
  return directories.sort((left, right) => left.localeCompare(right));
}

function verifyLayerSnapshot(layer, directory, libraryRoot, expectedRelativePath) {
  if (!isRecord(layer) || layer.relativePath !== expectedRelativePath || !Array.isArray(layer.files)) {
    throw new Error(`Frozen CKD Catalog contains an invalid layer snapshot: ${expectedRelativePath}`);
  }
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Frozen CKD Process layer no longer exists: ${expectedRelativePath}`);
  }
  const expected = layer.files.map((file, index) => {
    if (!isRecord(file)
      || typeof file.relativePath !== "string"
      || typeof file.sha256 !== "string"
      || typeof file.size !== "number") {
      throw new Error(`Frozen CKD Catalog contains an invalid file snapshot: ${expectedRelativePath}[${index}]`);
    }
    return { relativePath: file.relativePath, size: file.size, sha256: file.sha256 };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const actual = scanLayerFiles(directory, libraryRoot)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`CKD Process layer differs from the frozen Catalog snapshot: ${expectedRelativePath}`);
  }
  if (Array.isArray(layer.directories)) {
    const expectedDirectories = [...layer.directories].sort((left, right) => left.localeCompare(right));
    const actualDirectories = scanLayerDirectories(directory, libraryRoot);
    if (JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectories)) {
      throw new Error(`CKD Process layer directories differ from the frozen Catalog snapshot: ${expectedRelativePath}`);
    }
  }
}

function layerContainsFile(layer, libraryRoot, filePath) {
  if (!isRecord(layer) || !Array.isArray(layer.files)) return false;
  const relativePath = path.relative(libraryRoot, filePath).split(path.sep).join("/");
  return layer.files.some((file) => isRecord(file) && file.relativePath === relativePath);
}

function preferredLayerMetadata(layer, directory, libraryRoot, caseInsensitive = false) {
  if (!directory) return null;
  if (caseInsensitive && typeof layer?.metadataFile === "string") {
    const filePath = path.join(directory, layer.metadataFile);
    if (layerContainsFile(layer, libraryRoot, filePath)) return { fileName: layer.metadataFile, filePath };
  }
  for (const fileName of METADATA_FILES) {
    const filePath = path.join(directory, fileName);
    if (layerContainsFile(layer, libraryRoot, filePath)) return { fileName, filePath };
  }
  return null;
}

function layerHasPhotoSet(layer) {
  if (!isRecord(layer) || !isRecord(layer.assets)) return false;
  return layer.assets.photosDirectoryPresent === true
    || layer.assets.photoSetFormat === "legacy"
    || (Array.isArray(layer.assets.instructionPhotos) && layer.assets.instructionPhotos.length > 0)
    || typeof layer.assets.instructionPhoto === "string";
}

function removeCaseInsensitiveEntry(directory, canonicalName) {
  if (!directory || !fs.existsSync(directory)) return;
  const expected = normalizedFileName(canonicalName);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (normalizedFileName(entry.name) !== expected) continue;
    fs.rmSync(path.join(directory, entry.name), { recursive: entry.isDirectory(), force: true });
  }
}

function materializeProcess({ ckdLibraryRoot, effectiveRoot, targetProjectId, processRecord, processName, sopType, templateLanguage = "English" }) {
  const processId = processRecord.processId;
  const assembly = sopType === "assemble";
  const allowCommon = !assembly || templateLanguage === "中文";
  const commonLayer = allowCommon && isRecord(processRecord.commonLayer) ? processRecord.commonLayer : null;
  const projectLayer = Array.isArray(processRecord.projectLayers)
    ? processRecord.projectLayers.find((layer) => isRecord(layer) && layer.projectId === targetProjectId) ?? null
    : null;
  const common = commonLayer ? path.resolve(ckdLibraryRoot, commonLayer.relativePath) : null;
  const project = projectLayer ? path.resolve(ckdLibraryRoot, projectLayer.relativePath) : null;
  const commonExists = Boolean(commonLayer);
  const projectExists = Boolean(projectLayer);
  if (commonLayer) verifyLayerSnapshot(commonLayer, common, ckdLibraryRoot, commonLayer.relativePath);
  if (projectLayer) {
    verifyLayerSnapshot(projectLayer, project, ckdLibraryRoot, projectLayer.relativePath);
  }
  const target = path.join(effectiveRoot, processId);
  if (!isInside(effectiveRoot, target)) throw new Error(`Effective Process path escapes the Session Workspace: ${processId}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  if (commonExists) copyLayer(common, target);
  if (projectExists) {
    if (layerHasPhotoSet(projectLayer)) {
      fs.rmSync(path.join(target, PHOTO_DIRECTORY), { recursive: true, force: true });
      fs.rmSync(path.join(target, LEGACY_PHOTO_FILE), { force: true });
    }
    if (assembly) {
      for (const [key, canonicalName] of Object.entries(ASSEMBLY_FILES)) {
        if (typeof projectLayer?.assemblyFiles?.[key] === "string" || key === "previousStationCheckPhoto" && projectLayer?.assets?.previousStationCheckPhoto) {
          removeCaseInsensitiveEntry(target, canonicalName);
        }
      }
    }
    copyLayer(project, target);
  }

  const fileSources = {};
  if (assembly) {
    for (const [key, canonicalName] of Object.entries(ASSEMBLY_FILES)) {
      if (key === "previousStationCheckPhoto") continue;
      const projectHas = typeof projectLayer?.assemblyFiles?.[key] === "string";
      const commonHas = typeof commonLayer?.assemblyFiles?.[key] === "string";
      fileSources[canonicalName] = projectHas ? "project" : commonHas ? "common" : "missing";
    }
    const selectedPreviousPhotoLayer = typeof projectLayer?.assemblyFiles?.previousStationCheckPhoto === "string" ? projectLayer
      : typeof commonLayer?.assemblyFiles?.previousStationCheckPhoto === "string" ? commonLayer
        : typeof projectLayer?.assets?.previousStationCheckPhoto === "string" ? projectLayer
          : typeof commonLayer?.assets?.previousStationCheckPhoto === "string" ? commonLayer
            : null;
    fileSources[ASSEMBLY_FILES.previousStationCheckPhoto] = selectedPreviousPhotoLayer === projectLayer
      ? "project"
      : selectedPreviousPhotoLayer === commonLayer ? "common" : "missing";
  } else {
    for (const filename of PROCESS_FILES) {
      if (layerContainsFile(projectLayer, ckdLibraryRoot, project && path.join(project, filename))) fileSources[filename] = "project";
      else if (layerContainsFile(commonLayer, ckdLibraryRoot, common && path.join(common, filename))) fileSources[filename] = "common";
      else fileSources[filename] = "missing";
    }
    if (layerHasPhotoSet(projectLayer)) fileSources[PHOTO_DIRECTORY] = "project";
    else if (layerHasPhotoSet(commonLayer)) fileSources[PHOTO_DIRECTORY] = "common";
    else fileSources[PHOTO_DIRECTORY] = "missing";
  }
  const projectMetadata = preferredLayerMetadata(projectLayer, project, ckdLibraryRoot, assembly);
  const commonMetadata = preferredLayerMetadata(commonLayer, common, ckdLibraryRoot);
  const selectedMetadata = projectMetadata || commonMetadata;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isFile() && METADATA_FILES.some((fileName) => normalizedFileName(entry.name) === normalizedFileName(fileName))) {
      fs.rmSync(path.join(target, entry.name), { force: true });
    }
  }
  const metadataPath = path.join(target, "metadata.txt");
  if (selectedMetadata) {
    fs.copyFileSync(selectedMetadata.filePath, metadataPath);
    fileSources.metadata = projectMetadata ? "project" : "common";
  }
  if (!regularFile(metadataPath) || !fs.readFileSync(metadataPath, "utf8").trim()) {
    fs.writeFileSync(metadataPath, `${processName || humanizeIdentifier(processId)}\n`, "utf8");
    fileSources.metadata = "generated";
  }
  if (assembly) {
    const selectedPhotoLayer = typeof projectLayer?.assemblyFiles?.previousStationCheckPhoto === "string" ? projectLayer
      : typeof commonLayer?.assemblyFiles?.previousStationCheckPhoto === "string" ? commonLayer
        : projectLayer?.assets?.previousStationCheckPhoto ? projectLayer
          : commonLayer?.assets?.previousStationCheckPhoto ? commonLayer
            : null;
    const selectedPhotoDirectory = selectedPhotoLayer === projectLayer ? project : selectedPhotoLayer === commonLayer ? common : null;
    if (selectedPhotoLayer && selectedPhotoDirectory) {
      const relativePhotoPath = path.posix.relative(selectedPhotoLayer.relativePath, selectedPhotoLayer.assets.previousStationCheckPhoto);
      const selectedPhotoPath = path.resolve(selectedPhotoDirectory, ...relativePhotoPath.split("/"));
      if (!isInside(selectedPhotoDirectory, selectedPhotoPath)) throw new Error(`Previous Station Check photo escapes its Process layer: ${selectedPhotoLayer.assets.previousStationCheckPhoto}`);
      if (regularFile(selectedPhotoPath)) {
        removeCaseInsensitiveEntry(target, ASSEMBLY_FILES.previousStationCheckPhoto);
        fs.copyFileSync(selectedPhotoPath, path.join(target, ASSEMBLY_FILES.previousStationCheckPhoto));
      }
    }
  }
  return {
    processId,
    processName: fs.readFileSync(metadataPath, "utf8").trim(),
    folder: target,
    contentStatus: (commonExists || projectExists) ? "resolved" : "content_missing",
    fileSources
  };
}

function buildProcessReviews(plans, materializations, targetProjectName, processRecords, selectionMode, sopType) {
  return plans.map((plan, index) => {
    const materialization = materializations[index];
    const scoring = scoreProcess(plan, materialization, processRecords[index], selectionMode, sopType);
    const processId = summaryText(plan.resolvedProcessId, "unknown");
    const processName = summaryText(materialization.processName, plan.resolvedProcessName || plan.requestedProcess || humanizeIdentifier(processId));
    const missing = materialization.contentStatus === "content_missing";
    const planWarnings = conciseWarnings(plan.warnings);
    const placeholderWarning = sopType === "assemble"
      ? "目标项目无可用 Assembly 资料，本页仅为 SOP 顺序占位。"
      : PLACEHOLDER_WARNING;
    const warnings = missing ? [placeholderWarning] : planWarnings;
    return {
      processId,
      processName,
      overview: conciseOverview(plan.overview, processName),
      sourceType: missing ? "placeholder" : "direct",
      contentStatus: materialization.contentStatus,
      contentProjectName: targetProjectName,
      fileSources: materialization.fileSources,
      score: scoring.score,
      totalDeduction: scoring.totalDeduction,
      missingCategories: scoring.missingCategories,
      operationAssessment: scoring.operationAssessment,
      completenessAssessment: scoring.completenessAssessment,
      crossLayerAssessment: scoring.crossLayerAssessment,
      semanticAssessment: scoring.semanticAssessment,
      reason: missing
        ? (sopType === "assemble"
            ? "目标项目无 Assembly 资料，仅保留 SOP 工序身份和顺序。"
            : "目标项目与 common 均无资料，仅保留 SOP 工序身份和顺序。")
        : scoring.score === 100
          ? "资料与匹配检查均未触发扣分。"
          : `已按确定性规则扣 ${scoring.totalDeduction} 分。`,
      warnings
    };
  });
}

function aggregateReview(reviews) {
  return {
    overallScore: reviews.length ? Math.round(reviews.reduce((sum, review) => sum + review.score, 0) / reviews.length) : 0,
    processCount: reviews.length,
    placeholderCount: reviews.filter((review) => review.contentStatus === "content_missing").length,
    zeroScoreCount: reviews.filter((review) => review.score === 0).length,
    crossLayerGapProcessCount: reviews.filter((review) => review.crossLayerAssessment.gapCount > 0).length
  };
}

function buildFinalSummary(input) {
  const project = input.projectMatchResult;
  const selection = input.sopProcessSelection;
  const matchedProjectId = summaryText(project.matchedProjectId, "Unknown Project");
  const matchedProjectName = summaryText(project.matchedProjectName, matchedProjectId);
  const requestedProjectName = summaryText(project.requestedProjectName, matchedProjectName);
  const lines = [
    "CKD SOP Excel 已成功生成。", "",
    `- **文件：** \`${input.documentPath}\``,
    `- **类型：** ${summaryText(input.sopType, "assembly_test")}`,
    `- **项目：** ${requestedProjectName} → ${matchedProjectName}（\`${matchedProjectId}\`）`,
    `- **Process 工作表：** ${input.processReviews.length}`
  ];
  if (selection?.mode === "reference") {
    lines.push(`- **Process 顺序来源：** Library SOP「${summaryText(selection.referenceSopName, selection.referenceSopId)}」，项目 ${summaryText(selection.referenceProjectName, selection.referenceProjectId)}`);
  } else if (input.sopType === "factory_test") {
    lines.push("- **Process 顺序来源：** Factory Test Process Builder");
  } else {
    lines.push("- **Process 顺序来源：** 用户手动输入");
  }
  lines.push(
    `- **空内容占位：** ${input.reviewSummary.placeholderCount}`,
    "", `## Process 逐项审查`, ""
  );
  input.processReviews.forEach((review, index) => {
    const source = review.contentStatus === "content_missing"
      ? "空内容占位"
      : input.sopType === "assemble" ? "目标项目" : "目标项目 / common";
    lines.push(
      `### ${index + 1}. ${markdownCell(review.processName)}（\`${markdownCell(review.processId)}\`）`, "",
      `流程概述：${markdownCell(review.overview)}  `,
      `内容来源：${source}`, "",
      "| 评分项 | 实际扣分值 | 评论 |",
      "|---|---:|---|",
      `| Operation 可执行性 | ${review.operationAssessment.deduction ? `-${review.operationAssessment.deduction}` : "0"} | ${markdownCell(review.operationAssessment.comment)} |`,
      `| 基础完整度 | ${review.completenessAssessment.deduction ? `-${review.completenessAssessment.deduction}` : "0"} | ${markdownCell(review.completenessAssessment.comment)} |`,
      `| 跨层资料缺口 | ${review.crossLayerAssessment.deduction ? `-${review.crossLayerAssessment.deduction}` : "0"} | ${markdownCell(review.crossLayerAssessment.comment)} |`,
      `| 语义匹配度 | ${review.semanticAssessment.deduction ? `-${review.semanticAssessment.deduction}` : "0"} | ${markdownCell(review.semanticAssessment.comment)} |`,
      `| **总扣分** | **-${review.totalDeduction}** | ${markdownCell([review.reason, ...review.warnings].join("；"))} |`,
      `| **最终得分** | **${review.score}/100** | 分数最低为 0。 |`, ""
    );
  });
  lines.push(
    "## SOP 总体汇总", "",
    "| 指标 | 结果 |",
    "|---|---:|",
    `| Process 数量 | ${input.reviewSummary.processCount} |`,
    `| 平均得分 | **${input.reviewSummary.overallScore}/100** |`,
    `| 0 分 Process | ${input.reviewSummary.zeroScoreCount} |`,
    `| 存在跨层资料缺口的 Process | ${input.reviewSummary.crossLayerGapProcessCount} |`
  );
  return lines.join("\n");
}


// Render only an already-reviewed task snapshot. Never modify its effective sources.
async function generatePrepared(input) {
  const paths = input.paths, prepared = input.inputs.preparedGeneration;
  paths.workspaceRoot = fs.realpathSync(paths.workspaceRoot);
  paths.sessionWorkspace = fs.realpathSync(paths.sessionWorkspace);
  if (!isInside(paths.workspaceRoot, paths.sessionWorkspace)) throw new Error("Session Workspace escapes root.");
  const { catalog, ckdLibraryRoot } = readAndValidateCatalog(input.inputs, paths);
  const targetProjectId = input.inputs.projectMatchResult.matchedProjectId;
  const config = prepared.generation;
  for (const id of config.processList) {
    const record = findProcess(catalog, id);
    const layers = [config.sopType !== "assemble" || config.templateLanguage === "中文" ? record.commonLayer : null,
      record.projectLayers?.find(layer => layer.projectId === targetProjectId)].filter(Boolean);
    for (const layer of layers) verifyLayerSnapshot(layer, path.resolve(ckdLibraryRoot, layer.relativePath), ckdLibraryRoot, layer.relativePath);
  }
  const effective = path.resolve(paths.sessionWorkspace, config.projectDir);
  if (!isInside(paths.sessionWorkspace, effective) || !isInside(paths.sessionWorkspace, fs.realpathSync(effective))) throw new Error("Prepared sources escape task.");
  const staging = path.join(paths.sessionWorkspace, "render-processes");
  if (fs.existsSync(staging) && fs.lstatSync(staging).isSymbolicLink()) throw new Error("Invalid render directory.");
  fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging);
  const output = path.join(paths.sessionWorkspace, "outputs", buildOutputFileName(config.projectName, config.sopName));
  const temporary = output + ".tmp.xlsx";
  try {
    copyLayer(effective, staging);
    for (const override of input.inputs.imageOverrides || []) {
      const file = path.resolve(paths.sessionWorkspace, override.file), target = path.resolve(staging, override.target);
      if (!isInside(paths.sessionWorkspace, file) || !isInside(paths.sessionWorkspace, fs.realpathSync(file)) || fs.lstatSync(file).isSymbolicLink() || !isInside(staging, target) || !fs.statSync(target).isFile()) throw new Error("Invalid image override.");
      const bytes = fs.readFileSync(file);
      if (sha256(bytes) !== override.hash) throw new Error("Cropped image changed.");
      fs.writeFileSync(target, bytes);
    }
    if (fs.existsSync(output)) throw new Error("Workbook already exists; refusing to overwrite.");
    const generated = await buildCkdSop({ ...config, assetsDir: __dirname, projectDir: staging, output: temporary });
    fs.renameSync(temporary, output);
    const documentPath = path.relative(paths.workspaceRoot, output).split(path.sep).join("/");
    const summary = buildFinalSummary({ documentPath, sopType: config.sopType, projectMatchResult: input.inputs.projectMatchResult,
      sopProcessSelection: input.inputs.sopProcessSelection, processReviews: prepared.processReviews, reviewSummary: prepared.reviewSummary });
    return { summary, output: { sopType: config.sopType, templateLanguage: config.templateLanguage, documentPath,
      sheetCount: generated.sheetCount, processCount: config.processList.length, catalogHash: input.inputs.catalogHash,
      warnings: [...new Set([...prepared.warnings, ...generated.warnings])], processReviews: prepared.processReviews,
      reviewSummary: prepared.reviewSummary, resultSummary: summary, imagesConfirmed: true,
      croppedImageCount: (input.inputs.imageOverrides || []).length }, artifacts: [documentPath] };
  } finally { fs.rmSync(temporary, { force: true }); fs.rmSync(staging, { recursive: true, force: true }); }
}

async function run(input) {
  if (!isRecord(input) || !isRecord(input.inputs) || !isRecord(input.paths)) throw new Error("Workflow input.json must contain inputs and paths.");
  if (input.inputs.preparedGeneration) return generatePrepared(input);
  const paths = input.paths;
  for (const name of ["workspaceRoot", "sessionWorkspace"]) {
    if (typeof paths[name] !== "string") throw new Error(`Workflow Runtime did not provide paths.${name}.`);
    paths[name] = fs.realpathSync(paths[name]);
  }
  if (!isInside(paths.workspaceRoot, paths.sessionWorkspace)) throw new Error("Session Workspace is outside the configured Workspace.");
  const normalized = input.inputs.normalizedInputs;
  if (!isRecord(normalized)) throw new Error("normalizedInputs must be an object.");
  const projectName = requiredText(normalized.projectName, "normalizedInputs.projectName", 120);
  const documentNumber = requiredText(normalized.documentNumber, "normalizedInputs.documentNumber", 80);
  // Preserve the field requirement so Runs normalized by earlier nodes can resume,
  // while new output names are derived from Project + SOP + local calendar date.
  requiredText(normalized.safeDocumentNumber, "normalizedInputs.safeDocumentNumber", 120);
  const sopName = requiredText(normalized.sopName, "normalizedInputs.sopName", 200);
  // Existing Runs may have completed normalization before Author became an input.
  const author = typeof normalized.author === "string" && normalized.author.trim()
    ? requiredText(normalized.author, "normalizedInputs.author", 200)
    : "";
  const sopType = requiredText(normalized.sopType || "assembly_test", "normalizedInputs.sopType", 40);
  const revision = sopType === "assemble" ? Object.fromEntries([["revisionReason", 1000], ["revisionContent", 4000]].map(([key, max]) => {
    const value = normalized[key];
    if (value !== undefined && typeof value !== "string") throw new Error(`normalizedInputs.${key} must be text.`);
    const text = (value || "").trim();
    if (text.length > max) throw new Error(`normalizedInputs.${key} must not exceed ${max} characters.`);
    return [key, text];
  })) : {};
  const templateLanguage = requiredText(
    normalized.templateLanguage || "English",
    "normalizedInputs.templateLanguage",
    20
  );
  if (!["English", "中文"].includes(templateLanguage)) {
    throw new Error("normalizedInputs.templateLanguage must be English or 中文.");
  }
  if (!Array.isArray(normalized.processList) || normalized.processList.length < 1 || normalized.processList.length > 30) {
    throw new Error("normalizedInputs.processList must contain 1 to 30 items.");
  }
  const processList = normalized.processList.map((value, index) => requiredText(value, `normalizedInputs.processList[${index}]`, 120));
  const selection = validateSopProcessSelection(input.inputs.sopProcessSelection, processList);
  const projectMatchResult = isRecord(input.inputs.projectMatchResult) ? input.inputs.projectMatchResult : {};
  const matchedProjectId = requiredText(projectMatchResult.matchedProjectId, "projectMatchResult.matchedProjectId", 120);
  const { catalog, ckdLibraryRoot } = readAndValidateCatalog(input.inputs, paths);
  if (catalog.sopType !== sopType) throw new Error(`Frozen CKD Catalog type ${String(catalog.sopType)} does not match ${sopType}.`);
  if ((catalog.templateLanguage || "English") !== templateLanguage) {
    throw new Error(`Frozen CKD Catalog language ${String(catalog.templateLanguage || "English")} does not match ${templateLanguage}.`);
  }
  if (!findProject(catalog, matchedProjectId)) throw new Error(`Matched project does not exist in the frozen CKD Catalog: ${matchedProjectId}`);
  const plans = orderedPlans(processList, input.inputs.processPlans);
  const effectiveRoot = path.join(paths.sessionWorkspace, "effective-processes", requiredText(input.workflow?.runId, "workflow.runId", 128));
  fs.mkdirSync(effectiveRoot, { recursive: true });
  const resolvedProcessIds = [];
  const seen = new Set();
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    if (!["direct", "transplanted"].includes(plan.status)) throw new Error(`${processList[index]} has unsupported status: ${String(plan.status)}`);
    if (typeof plan.confidence !== "number" || plan.confidence < 0 || plan.confidence > 1) throw new Error(`${processList[index]}.confidence must be from 0 to 1.`);
    const processId = requiredText(plan.resolvedProcessId, `${processList[index]}.resolvedProcessId`, 120);
    if (!findProcess(catalog, processId)) throw new Error(`Resolved Process is not in the frozen global Catalog: ${processId}`);
    const key = processId.toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new Error(`Two requested Processes resolve to the same Process ID: ${processId}`);
    seen.add(key);
    resolvedProcessIds.push(processId);
  }
  const materializations = plans.map((plan, index) => materializeProcess({
    ckdLibraryRoot,
    effectiveRoot,
    targetProjectId: matchedProjectId,
    processRecord: findProcess(catalog, resolvedProcessIds[index]),
    processName: summaryText(plan.resolvedProcessName, humanizeIdentifier(resolvedProcessIds[index])),
    sopType,
    templateLanguage
  }));
  if (input.inputs.prepareImagesOnly === true) {
    const targetProjectName = summaryText(projectMatchResult.matchedProjectName, matchedProjectId);
    const processRecords = resolvedProcessIds.map(id => findProcess(catalog, id));
    const processReviews = buildProcessReviews(plans, materializations, targetProjectName, processRecords, selection?.mode, sopType);
    return { summary: "资料已准备，等待图片确认后生成 Excel。", output: {
      sopType, templateLanguage, processReviews, reviewSummary: aggregateReview(processReviews),
      effectiveFiles: scanLayerFiles(effectiveRoot, paths.workspaceRoot),
      warnings: [...normalizedWarnings(input.inputs.normalizationWarnings), ...plans.flatMap(plan => normalizedWarnings(plan.warnings))],
      generation: { projectDir: path.relative(paths.sessionWorkspace, effectiveRoot), projectName, documentNo: documentNumber,
        sopName, author, ...revision, processList: resolvedProcessIds, sopType, templateLanguage }
    }, artifacts: [] };
  }
  const outputDirectory = path.join(paths.sessionWorkspace, "outputs");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputFileName = buildOutputFileName(projectName, sopName);
  const finalOutputPath = path.join(outputDirectory, outputFileName);
  const outputStem = outputFileName.slice(0, -".xlsx".length);
  const temporaryOutputPath = path.join(outputDirectory, `.${outputStem}.${process.pid}.tmp.xlsx`);
  try {
    const generated = await buildCkdSop({
      assetsDir: __dirname,
      projectDir: effectiveRoot,
      projectName,
      documentNo: documentNumber,
      sopName,
      author,
      ...revision,
      processList: resolvedProcessIds,
      sopType,
      templateLanguage,
      output: temporaryOutputPath
    });
    fs.renameSync(temporaryOutputPath, finalOutputPath);
    const relativeOutputPath = path.relative(paths.workspaceRoot, finalOutputPath).split(path.sep).join("/");
    const targetProjectName = summaryText(projectMatchResult.matchedProjectName, matchedProjectId);
    const processRecords = resolvedProcessIds.map((processId) => findProcess(catalog, processId));
    const processReviews = buildProcessReviews(plans, materializations, targetProjectName, processRecords, selection?.mode, sopType);
    const reviewSummary = aggregateReview(processReviews);
    const resultSummary = buildFinalSummary({
      documentPath: relativeOutputPath,
      sopType,
      projectMatchResult,
      sopProcessSelection: selection,
      processReviews,
      reviewSummary
    });
    const warnings = [...new Set([
      ...normalizedWarnings(input.inputs.normalizationWarnings),
      ...normalizedWarnings(generated.warnings),
      ...plans.flatMap((plan) => normalizedWarnings(plan.warnings)),
      ...processReviews.filter((review) => review.contentStatus === "content_missing").map((review) =>
        `${review.processName}: ${sopType === "assemble" ? "目标项目无可用 Assembly 资料，本页仅为 SOP 顺序占位。" : PLACEHOLDER_WARNING}`)
    ])];
    return {
      summary: resultSummary,
      output: {
        sopType,
        templateLanguage,
        documentPath: relativeOutputPath,
        sheetCount: generated.sheetCount,
        processCount: resolvedProcessIds.length,
        catalogHash: input.inputs.catalogHash,
        warnings,
        processReviews,
        reviewSummary,
        resultSummary
      },
      artifacts: [relativeOutputPath]
    };
  } finally {
    fs.rmSync(temporaryOutputPath, { force: true });
  }
}

async function main() {
  const cli = parseCli(process.argv);
  const input = JSON.parse(fs.readFileSync(cli.input, "utf8"));
  const result = await run(input);
  fs.writeFileSync(cli.output, JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}

module.exports = {
  aggregateReview,
  buildFinalSummary,
  buildOutputFileName,
  buildProcessReviews,
  formatLocalDate,
  materializeProcess,
  scoreProcess,
  run
};
