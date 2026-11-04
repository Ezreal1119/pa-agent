const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PHOTO_DIRECTORY = "photos";
const LEGACY_PHOTO_FILE = "instruction_photos.png";
const MAX_PHOTO_COUNT = 12;
const METADATA_FILES = ["metadata.txt", "metadata"];

const SOURCE_ORDER = [
  { key: "metadata", file: "metadata", candidates: METADATA_FILES, kind: "text" },
  { key: "materialDetails", file: "material_details.jsonl", kind: "jsonl" },
  { key: "toolsFixturesEquipment", file: "tools_fixtures_equipment.jsonl", kind: "jsonl" },
  { key: "operationSteps", file: "operation_steps.txt", kind: "text" },
  { key: "instructionPhotos", file: PHOTO_DIRECTORY, kind: "imageSet", legacyFile: LEGACY_PHOTO_FILE },
  { key: "technicalNotes", file: "technical_notes.txt", kind: "text" }
];

const ASSEMBLY_SOURCE_ORDER = [
  { key: "metadata", file: "metadata", candidates: METADATA_FILES, kind: "text", caseInsensitive: true },
  { key: "materialDetails", file: "Bill_of_Materials.jsonl", kind: "jsonl", caseInsensitive: true },
  { key: "toolsFixturesEquipment", file: "Tools.jsonl", kind: "jsonl", caseInsensitive: true },
  { key: "operationSteps", file: "Operation_Instruction.txt", kind: "text", caseInsensitive: true },
  { key: "instructionPhotos", file: "Operation_Photos", kind: "imageSet", legacyFile: null, caseInsensitive: true },
  { key: "previousStationCheck", file: "Previous_Station_Check.txt", kind: "text", caseInsensitive: true },
  { key: "previousStationCheckPhoto", file: "previous_station_check_photo.png", kind: "image", caseInsensitive: true, legacyDirectory: "Previous_Station_Check_Photos" },
  { key: "selfCheck", file: "Self_Check.txt", kind: "text", caseInsensitive: true }
];

const PHOTO_NAME_PATTERN = /^p(\d+)(?:-(.+))?\.png$/iu;

function sourceOrderForSopType(sopType = "assembly_test") {
  return sopType === "assemble" ? ASSEMBLY_SOURCE_ORDER : SOURCE_ORDER;
}

function normalizedName(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function resolveEntry(directory, canonicalName, expectedKind = "file", caseInsensitive = false) {
  if (!directory || !fs.existsSync(directory)) return null;
  if (!caseInsensitive) {
    const filePath = path.join(directory, canonicalName);
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error(`CKD Library source files cannot be symlinks: ${filePath}`);
    const valid = expectedKind === "directory" ? stat.isDirectory() : stat.isFile();
    if (!valid) throw new Error(`${filePath} must be a ${expectedKind}.`);
    return { name: canonicalName, path: filePath };
  }
  const matches = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store" && normalizedName(entry.name) === normalizedName(canonicalName));
  if (matches.length > 1) {
    throw new Error(`${directory} contains ambiguous case-insensitive matches for ${canonicalName}: ${matches.map((entry) => entry.name).join(", ")}`);
  }
  const entry = matches[0];
  if (!entry) return null;
  if (entry.isSymbolicLink()) throw new Error(`CKD Library source files cannot be symlinks: ${path.join(directory, entry.name)}`);
  const valid = expectedKind === "directory" ? entry.isDirectory() : entry.isFile();
  if (!valid) throw new Error(`${path.join(directory, entry.name)} must be a ${expectedKind}.`);
  return { name: entry.name, path: path.join(directory, entry.name) };
}

function scanPhotoDirectory(directory, label = directory) {
  const photos = [];
  const warnings = [];
  const indexes = new Map();
  if (!directory || !fs.existsSync(directory)) return { directoryPresent: false, photos, warnings };
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`CKD photos path must be a plain directory: ${label}`);
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".DS_Store") continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      throw new Error(`CKD photos directory cannot contain symlinks or subdirectories: ${label}/${entry.name}`);
    }
    if (!entry.isFile()) continue;
    const match = PHOTO_NAME_PATTERN.exec(entry.name);
    if (!match) {
      warnings.push(`${label}/${entry.name} does not match p<number>.png or p<number>-<name>.png and will be ignored.`);
      continue;
    }
    const index = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new Error(`CKD instruction photo index must be from 1 to ${MAX_PHOTO_COUNT}: ${label}/${entry.name}`);
    }
    if (index > MAX_PHOTO_COUNT) {
      warnings.push(`${label}/${entry.name} exceeds the supported p${MAX_PHOTO_COUNT} limit and will be ignored.`);
      continue;
    }
    if (indexes.has(index)) {
      throw new Error(`CKD instruction photo index p${index} is duplicated: ${label}/${indexes.get(index)} and ${label}/${entry.name}`);
    }
    indexes.set(index, entry.name);
    photos.push({ index, fileName: entry.name, filePath });
  }
  photos.sort((a, b) => a.index - b.index || a.fileName.localeCompare(b.fileName));
  if (photos.length > 1) {
    const missing = [];
    for (let index = photos[0].index; index <= photos.at(-1).index; index += 1) {
      if (!indexes.has(index)) missing.push(`p${index}`);
    }
    if (missing.length) warnings.push(`${label} has non-contiguous photo indexes; missing ${missing.join(", ")}.`);
  }
  return { directoryPresent: true, photos, warnings };
}

function resolvePhotoSet(layers, source) {
  for (const layer of layers) {
    if (!layer.directory) continue;
    const directory = resolveEntry(layer.directory, source.file, "directory", source.caseInsensitive);
    if (directory) {
      const scanned = scanPhotoDirectory(directory.path, directory.path);
      return { ...source, source: layer.source, selectedFile: directory.name, directoryPath: directory.path,
        directoryPresent: true, legacy: false, photos: scanned.photos, warnings: scanned.warnings };
    }
    if (source.legacyFile) {
      const legacy = resolveEntry(layer.directory, source.legacyFile, "file", source.caseInsensitive);
      if (legacy) {
        return { ...source, source: layer.source, selectedFile: legacy.name, directoryPath: null,
          directoryPresent: false, legacy: true,
          photos: [{ index: 1, fileName: legacy.name, filePath: legacy.path }],
          warnings: [`${legacy.path} uses the legacy single-photo layout.`] };
      }
    }
  }
  return { ...source, source: "missing", selectedFile: null, directoryPath: null,
    directoryPresent: false, legacy: false, photos: [], warnings: [] };
}

function resolveSingleImage(layers, source) {
  const accumulatedWarnings = [];
  for (const layer of layers) {
    if (!layer.directory) continue;
    const direct = resolveEntry(layer.directory, source.file, "file", source.caseInsensitive);
    if (direct && fs.statSync(direct.path).size > 0) {
      return { ...source, source: layer.source, selectedFile: direct.name, filePath: direct.path, warnings: accumulatedWarnings };
    }
    if (direct) accumulatedWarnings.push(`${direct.path} is empty and was ignored.`);
  }
  if (source.legacyDirectory) {
    for (const layer of layers) {
      if (!layer.directory) continue;
      const directory = resolveEntry(layer.directory, source.legacyDirectory, "directory", source.caseInsensitive);
      if (!directory) continue;
      const valid = fs.readdirSync(directory.path, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /\.png$/iu.test(entry.name))
        .map((entry) => ({ entry, filePath: path.join(directory.path, entry.name) }))
        .filter((item) => fs.statSync(item.filePath).size > 0)
        .sort((left, right) => left.entry.name.localeCompare(right.entry.name, "en", { numeric: true }));
      const selected = valid.length === 1 ? valid[0]
        : valid.find((item) => normalizedName(item.entry.name) === "p1.png")
          || valid.find((item) => normalizedName(item.entry.name).startsWith("p1"));
      const warnings = [...accumulatedWarnings, ...(valid.length > 1
        ? [selected
            ? `${directory.path} contains ${valid.length} valid images; ${selected.entry.name} was selected and the others were ignored.`
            : `${directory.path} contains multiple valid images but no p1-prefixed PNG; all were ignored.`]
        : valid.length === 0 ? [`${directory.path} contains no non-empty PNG image.`] : [])];
      if (selected) return {
        ...source,
        source: layer.source,
        selectedFile: `${directory.name}/${selected.entry.name}`,
        filePath: selected.filePath,
        warnings
      };
      accumulatedWarnings.push(...warnings.filter((warning) => !accumulatedWarnings.includes(warning)));
    }
  }
  return { ...source, source: "missing", selectedFile: null, filePath: null, warnings: accumulatedWarnings };
}

function resolveSources(commonDirectory, projectDirectory, sopType = "assembly_test", templateLanguage = "English") {
  const order = sourceOrderForSopType(sopType);
  const layers = sopType === "assemble" && templateLanguage !== "中文"
    ? [{ source: "project", directory: projectDirectory }]
    : [{ source: "project", directory: projectDirectory }, { source: "common", directory: commonDirectory }];
  const resolved = {};
  for (const source of order) {
    if (source.kind === "imageSet") {
      resolved[source.file] = resolvePhotoSet(layers, source);
      continue;
    }
    if (source.kind === "image") {
      resolved[source.file] = resolveSingleImage(layers, source);
      continue;
    }
    const candidates = source.candidates ?? [source.file];
    let selected = null;
    for (const layer of layers) {
      if (!layer.directory) continue;
      for (const candidate of candidates) {
        const match = resolveEntry(layer.directory, candidate, "file", source.caseInsensitive);
        if (match) {
          selected = { source: layer.source, fileName: match.name, filePath: match.path };
          break;
        }
      }
      if (selected) break;
    }
    resolved[source.file] = selected
      ? { ...source, source: selected.source, selectedFile: selected.fileName, filePath: selected.filePath }
      : { ...source, source: "missing", selectedFile: null, filePath: null };
  }
  Object.defineProperty(resolved, "__sourceOrder", { value: order, enumerable: false });
  return resolved;
}

function updatePhotoSetHash(hash, item, canonical) {
  hash.update(canonical ? item.file : (item.legacyFile || item.file));
  hash.update("\0");
  hash.update(item.source);
  hash.update("\0");
  if (canonical) {
    hash.update(item.directoryPresent ? "directory" : item.legacy ? "legacy" : "missing");
    hash.update("\0");
  }
  for (const photo of item.photos) {
    if (canonical) {
      hash.update(String(photo.index));
      hash.update("\0");
      hash.update(photo.fileName);
      hash.update("\0");
    }
    hash.update(fs.readFileSync(photo.filePath));
    hash.update("\0");
  }
  if (item.photos.length === 0) hash.update("\0");
}

function fingerprints(resolved) {
  const order = resolved.__sourceOrder || SOURCE_ORDER;
  const effective = createHash("sha256");
  const previousEffective = createHash("sha256");
  const legacy = createHash("sha256");
  for (const source of order) {
    const item = resolved[source.file];
    if (source.kind === "imageSet") {
      updatePhotoSetHash(effective, item, true);
      updatePhotoSetHash(previousEffective, item, false);
      legacy.update(source.legacyFile || source.file);
      legacy.update("\0");
      for (const photo of item.photos) legacy.update(fs.readFileSync(photo.filePath));
      legacy.update("\0");
      continue;
    }
    const content = item.filePath ? fs.readFileSync(item.filePath) : Buffer.alloc(0);
    for (const hash of [effective, previousEffective]) {
      hash.update(source.file);
      hash.update("\0");
      hash.update(item.source);
      hash.update("\0");
      hash.update(content);
      hash.update("\0");
    }
    legacy.update(source.file);
    legacy.update("\0");
    legacy.update(content);
    legacy.update("\0");
  }
  return {
    effectiveContentHash: effective.digest("hex"),
    previousEffectiveContentHash: previousEffective.digest("hex"),
    legacyFingerprint: legacy.digest("hex")
  };
}

function fileSources(resolved) {
  const order = resolved.__sourceOrder || SOURCE_ORDER;
  return Object.fromEntries(order.map((source) => [source.file, resolved[source.file].source]));
}

module.exports = { sourceOrderForSopType, resolveSources, fingerprints, fileSources };
