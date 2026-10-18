// Adapted from patrick-agent/src/tools/pptxOoxml.ts; only requested dependency closure.
import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";

const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"];

const MAX_PACKAGE_ENTRIES = 10_000;

const MAX_EXPANDED_BYTES = 250 * 1024 * 1024;

const MAX_XML_BYTES = 5 * 1024 * 1024;

const MAX_REPORTED_ISSUES = 100;

export interface PptxIntegrityReport {
  valid: boolean;
  entryCount: number;
  expandedBytes: number;
  missingRequiredParts: string[];
  unsafeEntries: string[];
  brokenRelationships: Array<{ relationshipPart: string; target: string }>;
  missingContentTypeParts: string[];
  xmlErrors: Array<{ part: string; error: string }>;
}

export interface PptxPackageReport {
  integrity: PptxIntegrityReport;
  slideCount: number;
  notesSlideCount: number;
  embeddedMediaCount: number;
  embeddedObjectCount: number;
  externalRelationshipCount: number;
  hasMacros: boolean;
  metadata: Record<string, string>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  processEntities: false
});

export async function inspectPptxPackage(source: string | Buffer): Promise<PptxPackageReport> {
  const buffer = typeof source === "string" ? await fs.readFile(source) : source;
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch (error) {
    return invalidPackageReport(`Invalid ZIP package: ${errorMessage(error)}`);
  }

  const entries = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
  if (entries.length > MAX_PACKAGE_ENTRIES) {
    return invalidPackageReport(`OOXML package exceeds ${MAX_PACKAGE_ENTRIES} entries.`, entries.length);
  }

  const unsafeEntries = entries
    .filter((name) => isUnsafeArchiveEntry(zip.files[name]!, name))
    .slice(0, MAX_REPORTED_ISSUES);
  const expandedBytes = entries.reduce((total, name) => total + readUncompressedSize(zip.files[name]!), 0);
  if (expandedBytes > MAX_EXPANDED_BYTES) {
    return invalidPackageReport(
      `OOXML package expands beyond the ${Math.floor(MAX_EXPANDED_BYTES / 1024 / 1024)} MiB limit.`,
      entries.length,
      expandedBytes
    );
  }

  const normalizedEntries = new Map(entries.map((name) => [normalizePartName(name), name]));
  const entryNames = new Set(normalizedEntries.keys());
  const missingRequiredParts = REQUIRED_PARTS.filter((name) => !entryNames.has(normalizePartName(name)));
  const brokenRelationships: PptxIntegrityReport["brokenRelationships"] = [];
  const missingContentTypeParts: string[] = [];
  const xmlErrors: PptxIntegrityReport["xmlErrors"] = [];
  let externalRelationshipCount = 0;

  for (const relationshipPart of entries.filter((name) => normalizePartName(name).endsWith(".rels"))) {
    const relationships = await readXml(zip, relationshipPart, xmlErrors);
    if (!relationships) continue;
    for (const relationship of asArray(findNode(relationships, "Relationships")?.Relationship)) {
      if (!isRecord(relationship)) continue;
      if (String(relationship["@TargetMode"] ?? "").toLowerCase() === "external") {
        externalRelationshipCount += 1;
        continue;
      }
      const target = String(relationship["@Target"] ?? "").trim();
      if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
      const resolvedTarget = resolveRelationshipTarget(relationshipPart, target);
      if (!resolvedTarget || !entryNames.has(normalizePartName(resolvedTarget))) {
        pushBounded(brokenRelationships, { relationshipPart, target });
      }
    }
  }

  const contentTypesEntry = normalizedEntries.get("[content_types].xml");
  if (contentTypesEntry) {
    const contentTypes = await readXml(zip, contentTypesEntry, xmlErrors);
    for (const override of asArray(findNode(contentTypes, "Types")?.Override)) {
      if (!isRecord(override)) continue;
      const partName = String(override["@PartName"] ?? "").replace(/^\//u, "");
      if (partName && !entryNames.has(normalizePartName(partName))) pushBounded(missingContentTypeParts, partName);
    }
  }

  const presentationEntry = normalizedEntries.get("ppt/presentation.xml");
  if (presentationEntry) await readXml(zip, presentationEntry, xmlErrors);

  const slideEntries = entries
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/iu.test(normalizePartName(name)))
    .sort(naturalPartOrder);
  for (const slideEntry of slideEntries) await readXml(zip, slideEntry, xmlErrors);

  const notesSlideCount = entries.filter((name) => /^ppt\/notesslides\/notesslide\d+\.xml$/iu.test(normalizePartName(name))).length;
  const embeddedMediaCount = entries.filter((name) => normalizePartName(name).startsWith("ppt/media/")).length;
  const embeddedObjectCount = entries.filter((name) => normalizePartName(name).startsWith("ppt/embeddings/")).length;
  const hasMacros = entries.some((name) => normalizePartName(name) === "ppt/vbaproject.bin");
  const metadata = await readCoreMetadata(zip, normalizedEntries, xmlErrors);
  const integrity: PptxIntegrityReport = {
    valid: missingRequiredParts.length === 0
      && unsafeEntries.length === 0
      && brokenRelationships.length === 0
      && missingContentTypeParts.length === 0
      && xmlErrors.length === 0,
    entryCount: entries.length,
    expandedBytes,
    missingRequiredParts,
    unsafeEntries,
    brokenRelationships,
    missingContentTypeParts,
    xmlErrors
  };
  return {
    integrity,
    slideCount: slideEntries.length,
    notesSlideCount,
    embeddedMediaCount,
    embeddedObjectCount,
    externalRelationshipCount,
    hasMacros,
    metadata
  };
}

export function assertPptxIntegrity(report: PptxPackageReport): void {
  if (report.integrity.valid) return;
  const details = [
    ...report.integrity.missingRequiredParts.map((part) => `missing ${part}`),
    ...report.integrity.unsafeEntries.map((part) => `unsafe archive entry ${part}`),
    ...report.integrity.brokenRelationships.map((item) => `broken relationship ${item.relationshipPart} -> ${item.target}`),
    ...report.integrity.missingContentTypeParts.map((part) => `missing content-type part ${part}`),
    ...report.integrity.xmlErrors.map((item) => `invalid XML ${item.part}: ${item.error}`)
  ];
  throw new Error(`PowerPoint OOXML package is incomplete or unsafe: ${details.slice(0, 5).join("; ") || "unknown package error"}.`);
}

async function readCoreMetadata(
  zip: JSZip,
  normalizedEntries: Map<string, string>,
  xmlErrors: PptxIntegrityReport["xmlErrors"]
): Promise<Record<string, string>> {
  const entryName = normalizedEntries.get("docprops/core.xml");
  if (!entryName) return {};
  const core = await readXml(zip, entryName, xmlErrors);
  const properties = findNode(core, "coreProperties");
  if (!properties) return {};
  const keys = ["title", "subject", "creator", "lastModifiedBy", "created", "modified"];
  return Object.fromEntries(keys.flatMap((key) => {
    const value = properties[key];
    return typeof value === "string" && value.trim() ? [[key, value.trim()]] : [];
  }));
}

async function readXml(
  zip: JSZip,
  entryName: string,
  errors: PptxIntegrityReport["xmlErrors"]
): Promise<Record<string, unknown> | undefined> {
  const entry = zip.file(entryName);
  if (!entry) return undefined;
  try {
    const buffer = await entry.async("nodebuffer");
    if (buffer.byteLength > MAX_XML_BYTES) throw new Error(`XML exceeds ${Math.floor(MAX_XML_BYTES / 1024 / 1024)} MiB`);
    const xml = buffer.toString("utf8");
    const validation = XMLValidator.validate(xml);
    if (validation !== true) throw new Error(validation.err.msg);
    const parsed = parser.parse(xml) as unknown;
    if (!isRecord(parsed)) throw new Error("XML root is invalid");
    return parsed;
  } catch (error) {
    pushBounded(errors, { part: entryName, error: errorMessage(error) });
    return undefined;
  }
}

function resolveRelationshipTarget(relationshipPart: string, target: string): string | undefined {
  const normalizedPart = normalizePartName(relationshipPart);
  const relationshipDirectory = path.posix.dirname(normalizedPart);
  const ownerDirectory = relationshipDirectory === "_rels"
    ? ""
    : relationshipDirectory.endsWith("/_rels")
      ? relationshipDirectory.slice(0, -"/_rels".length)
      : relationshipDirectory;
  const resolved = path.posix.normalize(path.posix.join("/", ownerDirectory, target)).replace(/^\//u, "");
  return resolved.startsWith("../") || resolved === ".." ? undefined : resolved;
}

function isUnsafeArchiveEntry(entry: JSZip.JSZipObject, name: string): boolean {
  const unsafeOriginalName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
  const candidate = (unsafeOriginalName ?? name).replace(/\\/gu, "/");
  return candidate.startsWith("/") || /^[a-z]:\//iu.test(candidate) || candidate.split("/").includes("..");
}

function readUncompressedSize(entry: JSZip.JSZipObject): number {
  const data = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === "number" && Number.isFinite(data.uncompressedSize)
    ? Math.max(0, data.uncompressedSize)
    : 0;
}

function naturalPartOrder(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function normalizePartName(name: string): string {
  return name.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").toLowerCase();
}

function findNode(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value[key];
  if (isRecord(direct)) return direct;
  for (const child of Object.values(value)) {
    const found = findNode(child, key);
    if (found) return found;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushBounded<T>(target: T[], value: T): void {
  if (target.length < MAX_REPORTED_ISSUES) target.push(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidPackageReport(error: string, entryCount = 0, expandedBytes = 0): PptxPackageReport {
  return {
    integrity: {
      valid: false,
      entryCount,
      expandedBytes,
      missingRequiredParts: [],
      unsafeEntries: [],
      brokenRelationships: [],
      missingContentTypeParts: [],
      xmlErrors: [{ part: "package", error }]
    },
    slideCount: 0,
    notesSlideCount: 0,
    embeddedMediaCount: 0,
    embeddedObjectCount: 0,
    externalRelationshipCount: 0,
    hasMacros: false,
    metadata: {}
  };
}
