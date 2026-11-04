#!/usr/bin/env node

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const PHOTO_DIRECTORY = "photos";
const LEGACY_PHOTO_FILE = "instruction_photos.png";
const MAX_PHOTO_COUNT = 12;
const METADATA_FILES = ["metadata.txt", "metadata"];
const PHOTO_NAME_PATTERN = /^p(\d+)(?:-(.+))?\.(?:png|jpe?g)$/iu;
const SOP_TYPES = new Set(["assemble", "assembly_test", "pcba_test", "aging_test", "factory_test"]);
const TEMPLATE_LANGUAGES = new Set(["English", "中文"]);
const CHINESE_PROCESS_DIRECTORY = "CN_process";
const CHINESE_DERIVED_DIRECTORY = "CN_derived";
const ASSEMBLY_FILES = Object.freeze({
  material: "Bill_of_Materials.jsonl",
  tools: "Tools.jsonl",
  operation: "Operation_Instruction.txt",
  photos: "Operation_Photos",
  previousStationCheck: "Previous_Station_Check.txt",
  previousStationCheckPhoto: "previous_station_check_photo.png",
  selfCheck: "Self_Check.txt"
});
const ASSEMBLY_TABLE_ROW_LIMIT = 5;
const LEGACY_PREVIOUS_STATION_PHOTO_DIRECTORY = "Previous_Station_Check_Photos";

function normalizeSopType(value) {
  const type = typeof value === "string" && value.trim() ? value.trim() : "assembly_test";
  if (!SOP_TYPES.has(type)) throw new Error(`Unsupported CKD SOP type: ${type}`);
  return type;
}

function normalizeTemplateLanguage(value) {
  const language = typeof value === "string" && value.trim() ? value.trim() : "English";
  if (!TEMPLATE_LANGUAGES.has(language)) throw new Error(`Unsupported CKD template language: ${language}`);
  return language;
}

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

function requiredText(value, name, maxLength = 1_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name} cannot exceed ${maxLength} characters.`);
  return normalized;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function sortedEntries(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store")
    .sort((left, right) => left.name.localeCompare(right.name));
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
  if (entry.isSymbolicLink()) throw new Error(`CKD Library cannot contain symlinks: ${path.join(directory, entry.name)}`);
  const valid = expectedKind === "directory" ? entry.isDirectory() : entry.isFile();
  if (!valid) throw new Error(`${path.join(directory, entry.name)} must be a ${expectedKind}.`);
  return { name: entry.name, path: path.join(directory, entry.name), entry };
}

function humanizeIdentifier(value) {
  return value.replace(/[_-]+/gu, " ").trim().split(/\s+/u).filter(Boolean)
    .map((part) => /^[A-Z0-9]+$/u.test(part) ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function derivedProjectAliases(projectId) {
  return [...new Set([
    projectId,
    projectId.replace(/[_-]+/gu, " "),
    ...projectId.split(/[_-]+/u)
  ].map((value) => value.trim()).filter(Boolean))];
}

function normalizeAliases(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings.`);
  return [...new Set(value.map((entry, index) => requiredText(entry, `${label}[${index}]`, 200)))];
}

function readJson(filePath, label) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(value)) throw new Error("root must be an object");
    return value;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function readOptionalText(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? fs.readFileSync(filePath, "utf8").trim()
    : "";
}

function readPreferredMetadata(layerPath, caseInsensitive = false) {
  for (const fileName of METADATA_FILES) {
    const match = caseInsensitive
      ? resolveCaseInsensitiveEntry(layerPath, fileName)
      : (fs.existsSync(path.join(layerPath, fileName)) && fs.statSync(path.join(layerPath, fileName)).isFile()
          ? { name: fileName, path: path.join(layerPath, fileName) }
          : null);
    if (match) {
      return { value: fs.readFileSync(match.path, "utf8").trim(), fileName: match.name };
    }
  }
  return { value: "", fileName: null };
}

function readOverview(filePath) {
  if (!fs.existsSync(filePath)) return "";
  const value = readJson(filePath, filePath);
  if (typeof value.overview !== "string") throw new Error(`${filePath} must contain a string field named overview.`);
  return value.overview.trim();
}

function readJsonl(filePath, label) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    try {
      const value = JSON.parse(line);
      if (!isRecord(value)) throw new Error("record must be an object");
      return value;
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is invalid JSONL: ${error.message}`);
    }
  });
}

function scanPhotoSet(layerPath, relativePath, options = {}) {
  const directoryName = options.directoryName || PHOTO_DIRECTORY;
  const caseInsensitive = options.caseInsensitive === true;
  const directoryMatch = caseInsensitive
    ? resolveCaseInsensitiveEntry(layerPath, directoryName, "directory")
    : (fs.existsSync(path.join(layerPath, directoryName))
        ? { name: directoryName, path: path.join(layerPath, directoryName) }
        : null);
  const directory = directoryMatch?.path || path.join(layerPath, directoryName);
  const legacyFile = options.legacyFile === undefined ? LEGACY_PHOTO_FILE : options.legacyFile;
  const legacyMatch = legacyFile
    ? (caseInsensitive
        ? resolveCaseInsensitiveEntry(layerPath, legacyFile)
        : (fs.existsSync(path.join(layerPath, legacyFile))
            ? { name: legacyFile, path: path.join(layerPath, legacyFile) }
            : null))
    : null;
  const legacyPath = legacyMatch?.path || (legacyFile ? path.join(layerPath, legacyFile) : null);
  const warnings = [];
  if (!directoryMatch) {
    if (!legacyMatch) {
      return { directoryPresent: false, format: "missing", photos: [], warnings };
    }
    if (!fs.statSync(legacyPath).isFile()) throw new Error(`${relativePath}/${LEGACY_PHOTO_FILE} must be a file.`);
    warnings.push(`${relativePath}/${legacyMatch.name} uses the legacy single-photo layout.`);
    return {
      directoryPresent: false,
      format: "legacy",
      photos: [{ index: 1, fileName: legacyMatch.name, relativePath: `${relativePath}/${legacyMatch.name}` }],
      warnings
    };
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${relativePath}/${PHOTO_DIRECTORY} must be a plain directory.`);
  }
  const photos = [];
  const indexes = new Map();
  for (const entry of sortedEntries(directory)) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      throw new Error(`${relativePath}/${PHOTO_DIRECTORY} cannot contain symlinks or subdirectories: ${entry.name}`);
    }
    if (!entry.isFile()) continue;
    const match = PHOTO_NAME_PATTERN.exec(entry.name);
    if (!match) {
      warnings.push(`${relativePath}/${directoryMatch.name}/${entry.name} does not match p<number>[-<name>].png/.jpg/.jpeg and will be ignored.`);
      continue;
    }
    const index = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new Error(`${relativePath}/${directoryMatch.name}/${entry.name} uses an index outside 1-${MAX_PHOTO_COUNT}.`);
    }
    if (index > MAX_PHOTO_COUNT) {
      warnings.push(`${relativePath}/${directoryMatch.name}/${entry.name} exceeds the supported p${MAX_PHOTO_COUNT} limit and will be ignored.`);
      continue;
    }
    if (indexes.has(index)) {
      throw new Error(`${relativePath}/${directoryMatch.name} contains duplicate p${index} indexes: ${indexes.get(index)} and ${entry.name}`);
    }
    indexes.set(index, entry.name);
    photos.push({
      index,
      fileName: entry.name,
      relativePath: `${relativePath}/${directoryMatch.name}/${entry.name}`
    });
  }
  photos.sort((left, right) => left.index - right.index || left.fileName.localeCompare(right.fileName));
  if (photos.length > MAX_PHOTO_COUNT) {
    throw new Error(`${relativePath}/${directoryMatch.name} cannot contain more than ${MAX_PHOTO_COUNT} valid photos.`);
  }
  if (photos.length > 1) {
    const missing = [];
    for (let index = photos[0].index; index <= photos.at(-1).index; index += 1) {
      if (!indexes.has(index)) missing.push(`p${index}`);
    }
    if (missing.length) warnings.push(`${relativePath}/${directoryMatch.name} has non-contiguous indexes; missing ${missing.join(", ")}.`);
  }
  if (legacyMatch) {
    warnings.push(`${relativePath}/${legacyMatch.name} is ignored because ${directoryMatch.name}/ exists.`);
  }
  return { directoryPresent: true, directoryName: directoryMatch.name, format: "directory", photos, warnings };
}

function scanDirectories(directory, root) {
  const directories = [];
  function visit(current) {
    for (const entry of sortedEntries(current)) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`CKD Library cannot contain symlinks: ${absolutePath}`);
      if (entry.isDirectory()) {
        directories.push(path.relative(root, absolutePath).split(path.sep).join("/"));
        visit(absolutePath);
      }
    }
  }
  visit(directory);
  return directories.sort((left, right) => left.localeCompare(right));
}

function scanFiles(directory, root) {
  const files = [];
  function visit(current) {
    for (const entry of sortedEntries(current)) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`CKD Library cannot contain symlinks: ${absolutePath}`);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) {
        const content = fs.readFileSync(absolutePath);
        files.push({
          relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
          size: content.byteLength,
          sha256: sha256(content)
        });
      }
    }
  }
  visit(directory);
  return files;
}

function assemblyEntry(layerPath, canonicalName, expectedKind = "file") {
  return resolveCaseInsensitiveEntry(layerPath, canonicalName, expectedKind);
}

function scanLegacyPreviousStationPhoto(layerPath, relativePath) {
  const directory = resolveCaseInsensitiveEntry(layerPath, LEGACY_PREVIOUS_STATION_PHOTO_DIRECTORY, "directory");
  if (!directory) return { selected: null, warnings: [] };
  const warnings = [];
  const valid = [];
  for (const entry of sortedEntries(directory.path)) {
    const filePath = path.join(directory.path, entry.name);
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      throw new Error(`${relativePath}/${directory.name} cannot contain symlinks or subdirectories: ${entry.name}`);
    }
    if (!entry.isFile() || !/\.png$/iu.test(entry.name) || fs.statSync(filePath).size === 0) continue;
    valid.push({ fileName: entry.name, filePath });
  }
  let selected = null;
  if (valid.length === 1) selected = valid[0];
  else if (valid.length > 1) selected = valid.find((item) => normalizedFileName(item.fileName) === "p1.png")
    || valid.find((item) => normalizedFileName(item.fileName).startsWith("p1"))
    || null;
  if (valid.length > 1) {
    warnings.push(selected
      ? `${relativePath}/${directory.name} contains ${valid.length} valid images; ${selected.fileName} was selected and the others were ignored.`
      : `${relativePath}/${directory.name} contains multiple valid images but no p1-prefixed PNG; all were ignored.`);
  }
  if (valid.length === 0) warnings.push(`${relativePath}/${directory.name} contains no non-empty PNG image.`);
  return {
    selected: selected ? { directoryName: directory.name, fileName: selected.fileName, filePath: selected.filePath } : null,
    warnings
  };
}

function normalizeFiniteQty(value) {
  const normalized = typeof value === "string" && value.trim() ? Number(value.trim()) : value;
  return typeof normalized === "number" && Number.isFinite(normalized) ? normalized : null;
}

function validateAssemblyBillOfMaterials(records, label) {
  records.forEach((record, index) => {
    for (const key of ["index", "partno", "spec"]) {
      if (typeof record[key] !== "string") {
        throw new Error(`${label} line ${index + 1} field ${key} must be a string.`);
      }
    }
    const qty = normalizeFiniteQty(record.qty);
    if (qty === null) throw new Error(`${label} line ${index + 1} field qty must be a finite number or numeric string.`);
    record.qty = qty;
  });
}

function scanAssemblyLayer(libraryRoot, layerPath, sourceType, projectId) {
  const warnings = [];
  const relativePath = path.relative(libraryRoot, layerPath).split(path.sep).join("/");
  const preferredMetadata = readPreferredMetadata(layerPath, true);
  const metadata = preferredMetadata.value;
  if (!metadata) {
    throw new Error(`${relativePath} must contain a non-empty metadata.txt or metadata file.`);
  }
  const materialEntry = assemblyEntry(layerPath, ASSEMBLY_FILES.material);
  const materialDetails = materialEntry
    ? readJsonl(materialEntry.path, `${relativePath}/${materialEntry.name}`)
    : [];
  validateAssemblyBillOfMaterials(
    materialDetails,
    `${relativePath}/${materialEntry?.name || ASSEMBLY_FILES.material}`
  );
  const toolsEntry = assemblyEntry(layerPath, ASSEMBLY_FILES.tools);
  const toolsFixturesEquipment = toolsEntry
    ? readJsonl(toolsEntry.path, `${relativePath}/${toolsEntry.name}`)
    : [];
  if (materialDetails.length > ASSEMBLY_TABLE_ROW_LIMIT) {
    warnings.push(`${relativePath}/${materialEntry.name} contains ${materialDetails.length} rows; only the first ${ASSEMBLY_TABLE_ROW_LIMIT} fit AssemblyTemplate.`);
  }
  if (toolsFixturesEquipment.length > ASSEMBLY_TABLE_ROW_LIMIT) {
    warnings.push(`${relativePath}/${toolsEntry.name} contains ${toolsFixturesEquipment.length} rows; only the first ${ASSEMBLY_TABLE_ROW_LIMIT} fit AssemblyTemplate.`);
  }
  const operationEntry = assemblyEntry(layerPath, ASSEMBLY_FILES.operation);
  const previousStationEntry = assemblyEntry(layerPath, ASSEMBLY_FILES.previousStationCheck);
  const selfCheckEntry = assemblyEntry(layerPath, ASSEMBLY_FILES.selfCheck);
  const rawPreviousPhotoEntry = assemblyEntry(layerPath, ASSEMBLY_FILES.previousStationCheckPhoto);
  const previousPhotoEntry = rawPreviousPhotoEntry && fs.statSync(rawPreviousPhotoEntry.path).size > 0
    ? rawPreviousPhotoEntry
    : null;
  if (rawPreviousPhotoEntry && !previousPhotoEntry) {
    warnings.push(`${relativePath}/${rawPreviousPhotoEntry.name} is empty and was ignored.`);
  }
  const legacyPreviousPhoto = previousPhotoEntry
    ? { selected: null, warnings: [] }
    : scanLegacyPreviousStationPhoto(layerPath, relativePath);
  warnings.push(...legacyPreviousPhoto.warnings);
  const photoSet = scanPhotoSet(layerPath, relativePath, {
    directoryName: ASSEMBLY_FILES.photos,
    legacyFile: null,
    caseInsensitive: true
  });
  const operationSteps = operationEntry ? fs.readFileSync(operationEntry.path, "utf8").trim() : "";
  if (!operationSteps) {
    warnings.push(`${relativePath}/${operationEntry?.name || ASSEMBLY_FILES.operation} is missing or empty.`);
  }
  warnings.push(...photoSet.warnings);
  const record = {
    sourceType,
    projectId,
    relativePath,
    metadata,
    metadataFile: preferredMetadata.fileName,
    materialDetails,
    toolsFixturesEquipment,
    operationSteps,
    technicalNotes: "",
    previousStationCheck: previousStationEntry ? fs.readFileSync(previousStationEntry.path, "utf8").trim() : "",
    selfCheck: selfCheckEntry ? fs.readFileSync(selfCheckEntry.path, "utf8").trim() : "",
    overview: readOverview(path.join(layerPath, "overview.json")),
    assets: {
      photosDirectoryPresent: photoSet.directoryPresent,
      photoSetFormat: photoSet.format,
      instructionPhotos: photoSet.photos,
      instructionPhoto: photoSet.photos[0]?.relativePath ?? null,
      previousStationCheckPhoto: previousPhotoEntry
        ? `${relativePath}/${previousPhotoEntry.name}`
        : legacyPreviousPhoto.selected
          ? `${relativePath}/${legacyPreviousPhoto.selected.directoryName}/${legacyPreviousPhoto.selected.fileName}`
          : null
    },
    assemblyFiles: {
      material: materialEntry?.name ?? null,
      tools: toolsEntry?.name ?? null,
      operation: operationEntry?.name ?? null,
      photos: photoSet.directoryName ?? null,
      previousStationCheck: previousStationEntry?.name ?? null,
      previousStationCheckPhoto: previousPhotoEntry?.name ?? null,
      legacyPreviousStationCheckPhoto: legacyPreviousPhoto.selected
        ? { directoryName: legacyPreviousPhoto.selected.directoryName, fileName: legacyPreviousPhoto.selected.fileName }
        : null,
      selfCheck: selfCheckEntry?.name ?? null
    },
    directories: scanDirectories(layerPath, libraryRoot),
    files: scanFiles(layerPath, libraryRoot),
    warnings
  };
  return { ...record, contentHash: sha256(JSON.stringify(record)) };
}

function scanLayer(libraryRoot, layerPath, sourceType, projectId = null, sopType = "assembly_test") {
  if (sopType === "assemble") {
    return scanAssemblyLayer(libraryRoot, layerPath, sourceType, projectId);
  }
  const warnings = [];
  const relativePath = path.relative(libraryRoot, layerPath).split(path.sep).join("/");
  const photoSet = scanPhotoSet(layerPath, relativePath);
  const preferredMetadata = readPreferredMetadata(layerPath);
  const metadata = preferredMetadata.value;
  if (!metadata) warnings.push(`${relativePath}/metadata.txt and ${relativePath}/metadata are missing or empty.`);
  if (!fs.existsSync(path.join(layerPath, "operation_steps.txt"))) {
    warnings.push(`${relativePath}/operation_steps.txt is missing.`);
  }
  if (fs.existsSync(path.join(layerPath, "insturction_photos.png"))) {
    warnings.push(`${relativePath}/insturction_photos.png is misspelled and will not be used.`);
  }
  warnings.push(...photoSet.warnings);
  const record = {
    sourceType,
    projectId,
    relativePath,
    metadata,
    metadataFile: preferredMetadata.fileName,
    materialDetails: readJsonl(path.join(layerPath, "material_details.jsonl"), `${relativePath}/material_details.jsonl`),
    toolsFixturesEquipment: readJsonl(path.join(layerPath, "tools_fixtures_equipment.jsonl"), `${relativePath}/tools_fixtures_equipment.jsonl`),
    operationSteps: readOptionalText(path.join(layerPath, "operation_steps.txt")),
    technicalNotes: readOptionalText(path.join(layerPath, "technical_notes.txt")),
    overview: readOverview(path.join(layerPath, "overview.json")),
    assets: {
      photosDirectoryPresent: photoSet.directoryPresent,
      photoSetFormat: photoSet.format,
      instructionPhotos: photoSet.photos,
      instructionPhoto: photoSet.photos[0]?.relativePath ?? null
    },
    directories: scanDirectories(layerPath, libraryRoot),
    files: scanFiles(layerPath, libraryRoot),
    warnings
  };
  return { ...record, contentHash: sha256(JSON.stringify(record)) };
}

function scanDerivedAnalysis(libraryRoot, analysisPath, projectId) {
  if (!fs.existsSync(analysisPath) || !fs.statSync(analysisPath).isDirectory()) return null;
  const relativePath = path.relative(libraryRoot, analysisPath).split(path.sep).join("/");
  const overviewPath = path.join(analysisPath, "overview.json");
  const summaryPath = path.join(analysisPath, "summary.json");
  const overviewValue = fs.existsSync(overviewPath) ? readJson(overviewPath, overviewPath) : null;
  const summaryValue = fs.existsSync(summaryPath) ? readJson(summaryPath, summaryPath) : null;
  const record = {
    sourceType: "project-effective",
    projectId,
    relativePath,
    overview: typeof overviewValue?.overview === "string" ? overviewValue.overview.trim() : "",
    effectiveContentHash: typeof summaryValue?.effectiveContentHash === "string"
      ? summaryValue.effectiveContentHash
      : typeof overviewValue?.effectiveContentHash === "string" ? overviewValue.effectiveContentHash : "",
    fileSources: isRecord(summaryValue?.fileSources) ? summaryValue.fileSources : {},
    files: scanFiles(analysisPath, libraryRoot)
  };
  return { ...record, contentHash: sha256(JSON.stringify(record)) };
}

function readProject(productsRoot, projectEntry) {
  if (projectEntry.isSymbolicLink()) throw new Error(`CKD Library cannot contain symlinks: ${projectEntry.name}`);
  if (!projectEntry.isDirectory()) return null;
  const projectId = projectEntry.name;
  const projectPath = path.join(productsRoot, projectId);
  const projectJsonPath = path.join(projectPath, "project.json");
  const warnings = [];
  let displayName = projectId.replace(/[_-]+/gu, " / ");
  let aliases = derivedProjectAliases(projectId);
  if (fs.existsSync(projectJsonPath)) {
    const value = readJson(projectJsonPath, `${projectId}/project.json`);
    if (value.projectId !== undefined && value.projectId !== projectId) {
      throw new Error(`${projectId}/project.json projectId must equal the folder name.`);
    }
    if (typeof value.displayName === "string" && value.displayName.trim()) displayName = value.displayName.trim();
    aliases = [...new Set([...aliases, ...normalizeAliases(value.aliases, `${projectId}/project.json.aliases`)])];
  } else {
    warnings.push(`${projectId}/project.json is missing; metadata was derived from the folder name.`);
  }
  return { projectId, displayName, aliases, relativePath: `product_lib/${projectId}`, warnings, projectPath };
}

function readSops(project, sopType, processById, templateLanguage) {
  const filePath = path.join(project.projectPath, sopType, "sops.json");
  const relativePath = `product_lib/${project.projectId}/${sopType}/sops.json`;
  if (!fs.existsSync(filePath)) {
    project.warnings.push(`${relativePath} is missing; no ${sopType} reference SOPs are available.`);
    return [];
  }
  const value = readJson(filePath, relativePath);
  if (value.version !== 1 || !Array.isArray(value.sops)) {
    throw new Error(`${relativePath} must use version 1 and contain a sops array.`);
  }
  const seen = new Set();
  return value.sops.map((candidate, index) => {
    const label = `${relativePath} sops[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${label} must be an object.`);
    const sopId = requiredText(candidate.sopId, `${label}.sopId`, 120);
    const key = sopId.toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new Error(`${relativePath} contains duplicate sopId: ${sopId}`);
    seen.add(key);
    const originalDisplayName = requiredText(candidate.displayName, `${label}.displayName`, 200);
    let displayNameCN = "";
    if (candidate.displayNameCN !== undefined && candidate.displayNameCN !== null) {
      if (typeof candidate.displayNameCN !== "string") throw new Error(`${label}.displayNameCN must be a string when provided.`);
      displayNameCN = candidate.displayNameCN.trim();
      if (displayNameCN.length > 200) throw new Error(`${label}.displayNameCN cannot exceed 200 characters.`);
    }
    const displayName = templateLanguage === "中文" && displayNameCN ? displayNameCN : originalDisplayName;
    const processSequence = Array.isArray(candidate.processSequence)
      ? candidate.processSequence.map((entry, processIndex) => requiredText(entry, `${label}.processSequence[${processIndex}]`, 120))
      : [];
    if (processSequence.length < 1 || processSequence.length > 30) {
      throw new Error(`${label}.processSequence must contain 1 to 30 Process IDs.`);
    }
    if (new Set(processSequence.map((item) => item.toLocaleLowerCase("en-US"))).size !== processSequence.length) {
      throw new Error(`${label}.processSequence contains a duplicate Process ID.`);
    }
    const unknownProcessIds = processSequence.filter((processId) => !processById.has(processId));
    if (unknownProcessIds.length) {
      const sourceDirectory = templateLanguage === "中文" ? "CN_process" : "processes";
      project.warnings.push(`${label} is unavailable in ${templateLanguage} because these Process IDs have no ${sourceDirectory} content: ${unknownProcessIds.join(", ")}.`);
      return null;
    }
    const record = {
      sopId,
      displayName,
      displayNameCN: displayNameCN || null,
      aliases: [...new Set([sopId, sopId.replace(/[_-]+/gu, " "), displayName, originalDisplayName,
        ...normalizeAliases(candidate.aliases, `${label}.aliases`)].filter(Boolean))],
      description: typeof candidate.description === "string" ? candidate.description.trim() : "",
      processSequence
    };
    return { ...record, contentHash: sha256(JSON.stringify(record)) };
  }).filter(Boolean);
}

function layerDisplayName(process, projectId) {
  const projectLayer = process.projectLayers.find((layer) => layer.projectId === projectId);
  return projectLayer?.metadata || process.commonLayer?.metadata || process.displayName;
}

function layerOverview(process, projectId) {
  const projectAnalysis = process.projectDerived.find((analysis) => analysis.projectId === projectId);
  return projectAnalysis?.overview || process.commonLayer?.overview || process.overview || "";
}

function locateLibraryRoot(paths) {
  const roots = Array.isArray(paths.libraryRoots) ? paths.libraryRoots.filter((item) => typeof item === "string" && item.trim()) : [];
  const matches = [];
  for (const libraryRoot of roots) {
    const realRoot = fs.realpathSync(libraryRoot);
    const candidate = path.join(realRoot, "ckd-library-v2");
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) continue;
    const realCandidate = fs.realpathSync(candidate);
    if (!isInside(realRoot, realCandidate)) throw new Error(`CKD Library v2 escapes configured Library: ${candidate}`);
    matches.push({ libraryRoot: realRoot, ckdLibraryRoot: realCandidate });
  }
  if (matches.length === 0) throw new Error("No configured Library contains a ckd-library-v2 directory.");
  if (matches.length > 1) throw new Error(`More than one configured Library contains ckd-library-v2: ${matches.map((item) => item.ckdLibraryRoot).join(", ")}`);
  return matches[0];
}

function buildCatalog(input) {
  if (!isRecord(input.paths)) throw new Error("input.paths is required.");
  const source = locateLibraryRoot(input.paths);
  const sopType = normalizeSopType(input.inputs?.sopType);
  const templateLanguage = normalizeTemplateLanguage(input.inputs?.templateLanguage);
  const productsRoot = path.join(source.ckdLibraryRoot, "product_lib");
  const allProcessesRoot = path.join(source.ckdLibraryRoot, "processes_lib");
  const typeProcessesRoot = path.join(allProcessesRoot, sopType);
  const commonProcessesRoot = templateLanguage === "中文"
    ? path.join(typeProcessesRoot, CHINESE_PROCESS_DIRECTORY)
    : typeProcessesRoot;
  const allowCommon = sopType !== "assemble" || templateLanguage === "中文";
  if (!fs.existsSync(productsRoot) || !fs.existsSync(typeProcessesRoot)) {
    throw new Error(`ckd-library-v2 must contain product_lib/ and processes_lib/${sopType}/ directories.`);
  }
  const projects = sortedEntries(productsRoot).map((entry) => readProject(productsRoot, entry)).filter(Boolean);
  const knownProjectIds = new Set(projects.map((project) => project.projectId));
  const processIds = new Set(!allowCommon
    ? []
    : (fs.existsSync(commonProcessesRoot) ? sortedEntries(commonProcessesRoot) : [])
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .filter((entry) => templateLanguage === "中文" || entry.name !== CHINESE_PROCESS_DIRECTORY)
      .map((entry) => entry.name));
  for (const project of projects) {
    const projectProcessesRoot = path.join(
      project.projectPath,
      sopType,
      templateLanguage === "中文" ? CHINESE_PROCESS_DIRECTORY : "processes"
    );
    for (const processId of fs.existsSync(projectProcessesRoot) ? sortedEntries(projectProcessesRoot) : []) {
      if (processId.isSymbolicLink()) throw new Error(`CKD Library cannot contain symlinks: ${processId.name}`);
      if (processId.isDirectory()) processIds.add(processId.name);
    }
  }
  const processes = [];
  for (const processId of [...processIds].sort((left, right) => left.localeCompare(right))) {
    const processRoot = path.join(commonProcessesRoot, processId);
    const commonLayer = allowCommon && fs.existsSync(processRoot) && fs.statSync(processRoot).isDirectory()
      ? scanLayer(source.ckdLibraryRoot, processRoot, "common", null, sopType)
      : null;
    const projectLayers = [];
    const projectDerived = [];
    for (const project of projects) {
      if (!knownProjectIds.has(project.projectId)) continue;
      const layerPath = path.join(project.projectPath, sopType, templateLanguage === "中文" ? CHINESE_PROCESS_DIRECTORY : "processes", processId);
      if (fs.existsSync(layerPath) && fs.statSync(layerPath).isDirectory()) {
        projectLayers.push(scanLayer(source.ckdLibraryRoot, layerPath, "project", project.projectId, sopType));
      }
      const derivedPath = path.join(project.projectPath, sopType, templateLanguage === "中文" ? CHINESE_DERIVED_DIRECTORY : "derived", processId);
      if (fs.existsSync(derivedPath) && fs.statSync(derivedPath).isDirectory()) {
        const analysis = scanDerivedAnalysis(
          source.ckdLibraryRoot,
          derivedPath,
          project.projectId
        );
        if (analysis) projectDerived.push(analysis);
      }
    }
    if (!commonLayer && projectLayers.length === 0) {
      throw new Error(sopType === "assemble" && templateLanguage === "English"
        ? `Assembly Process has no project-specific content: ${processId}`
        : `Process has neither common nor project content: ${processId}`);
    }
    const metadataNames = [commonLayer?.metadata, ...projectLayers.map((layer) => layer.metadata)].filter(Boolean);
    const displayName = commonLayer?.metadata || metadataNames[0] || humanizeIdentifier(processId);
    const overview = commonLayer?.overview || projectDerived.find((analysis) => analysis.overview)?.overview || "";
    const record = {
      sopType,
      processId,
      displayName,
      aliases: [...new Set([processId, humanizeIdentifier(processId), ...metadataNames].filter(Boolean))],
      overview,
      commonLayer,
      projectLayers,
      projectDerived,
      availability: { common: Boolean(commonLayer), projectIds: projectLayers.map((layer) => layer.projectId) },
      warnings: [commonLayer, ...projectLayers].filter(Boolean).flatMap((layer) => layer.warnings)
    };
    processes.push({ ...record, contentHash: sha256(JSON.stringify(record)) });
  }
  const processById = new Map(processes.map((process) => [process.processId, process]));
  for (const project of projects) project.sops = readSops(project, sopType, processById, templateLanguage);
  const sopIndex = projects.flatMap((project) => project.sops.map((sop) => ({
    sopType,
    projectId: project.projectId,
    projectName: project.displayName,
    ...sop
  })));
  const warnings = [...projects.flatMap((project) => project.warnings), ...processes.flatMap((process) => process.warnings)];
  const catalogContent = {
    schemaVersion: 3,
    sopType,
    templateLanguage,
    source: { libraryRoot: source.libraryRoot, ckdLibraryRoot: source.ckdLibraryRoot, productsRoot, processesRoot: commonProcessesRoot },
    projects: projects.map(({ projectPath: _projectPath, ...project }) => project),
    processes,
    processIndex: Object.fromEntries(processes.map((process) => [process.processId, {
      sopType,
      processId: process.processId,
      displayName: process.displayName,
      availability: process.availability
    }])),
    sopIndex,
    stats: {
      projectCount: projects.length,
      processCount: processes.length,
      processLayerCount: processes.reduce((total, process) => total + (process.commonLayer ? 1 : 0) + process.projectLayers.length, 0),
      sopCount: sopIndex.length,
      warningCount: warnings.length
    },
    warnings
  };
  const catalog = { ...catalogContent, generatedAt: new Date().toISOString(), catalogHash: sha256(JSON.stringify(catalogContent)) };
  return {
    catalog,
    sopType,
    templateLanguage,
    catalogProjects: { projects: projects.map((project) => ({ projectId: project.projectId, displayName: project.displayName, aliases: project.aliases })) },
    catalogSummary: {
      projects: projects.map((project) => ({ projectId: project.projectId, displayName: project.displayName, aliases: project.aliases })),
      processes: processes.map((process) => ({
        sopType,
        processId: process.processId,
        displayName: process.displayName,
        aliases: process.aliases,
        overview: process.overview,
        projectOverviews: Object.fromEntries(process.projectDerived
          .filter((analysis) => analysis.overview)
          .map((analysis) => [analysis.projectId, analysis.overview])),
        availability: process.availability
      }))
    },
    catalogDetails: {
      processes: processes.map((process) => ({
        sopType,
        processId: process.processId,
        displayName: process.displayName,
        overview: process.overview,
        commonLayer: process.commonLayer,
        projectLayers: process.projectLayers,
        projectDerived: process.projectDerived
      }))
    },
    sopCatalogSummary: {
      sops: sopIndex.map((sop) => ({
        sopType,
        projectId: sop.projectId,
        projectName: sop.projectName,
        sopId: sop.sopId,
        displayName: sop.displayName,
        aliases: sop.aliases,
        description: sop.description,
        processSequence: sop.processSequence.map((processId) => {
          const process = processById.get(processId);
          return { processId, displayName: layerDisplayName(process, sop.projectId), overview: layerOverview(process, sop.projectId) };
        })
      }))
    }
  };
}

function main() {
  const cli = parseCli(process.argv);
  const input = JSON.parse(fs.readFileSync(cli.input, "utf8"));
  if (!isRecord(input)) throw new Error("Workflow input.json must contain an object.");
  const sessionWorkspace = input.paths && input.paths.sessionWorkspace;
  const workspaceRoot = input.paths && input.paths.workspaceRoot;
  if (typeof sessionWorkspace !== "string" || typeof workspaceRoot !== "string") {
    throw new Error("Workflow Runtime did not provide paths.sessionWorkspace and paths.workspaceRoot.");
  }
  const resolvedWorkspace = fs.realpathSync(sessionWorkspace);
  const resolvedWorkspaceRoot = fs.realpathSync(workspaceRoot);
  if (!isInside(resolvedWorkspaceRoot, resolvedWorkspace)) throw new Error("Session Workspace is outside the configured Workspace root.");
  const result = buildCatalog(input);
  const catalogPath = path.join(resolvedWorkspace, "ckd-catalog-v3.json");
  const temporaryPath = `${catalogPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(result.catalog, null, 2), "utf8");
  fs.renameSync(temporaryPath, catalogPath);
  const catalogRelativePath = path.relative(resolvedWorkspaceRoot, catalogPath).split(path.sep).join("/");
  fs.writeFileSync(cli.output, JSON.stringify({
    summary: `CKD v3 ${result.sopType} Catalog created with ${result.catalog.stats.projectCount} project(s), ${result.catalog.stats.processCount} process(es), and ${result.catalog.stats.sopCount} SOP definition(s).`,
    output: {
      sopType: result.sopType,
      templateLanguage: result.templateLanguage,
      catalogPath: catalogRelativePath,
      catalogHash: result.catalog.catalogHash,
      projectCount: result.catalog.stats.projectCount,
      processCount: result.catalog.stats.processCount,
      processLayerCount: result.catalog.stats.processLayerCount,
      sopCount: result.catalog.stats.sopCount,
      catalogProjects: result.catalogProjects,
      catalogSummary: result.catalogSummary,
      catalogDetails: result.catalogDetails,
      sopCatalogSummary: result.sopCatalogSummary,
      warnings: result.catalog.warnings
    },
    artifacts: []
  }));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
