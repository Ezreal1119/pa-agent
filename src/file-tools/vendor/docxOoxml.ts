// Adapted from patrick-agent/src/tools/docxOoxml.ts; only requested dependency closure.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "word/document.xml"];

const MAX_PACKAGE_ENTRIES = 10_000;

const MAX_XML_BYTES = 5 * 1024 * 1024;

const MAX_REPORTED_ISSUES = 100;

export type AdvancedDocxFeature =
  | "macros"
  | "trackedChanges"
  | "comments"
  | "contentControls"
  | "fields"
  | "textBoxes"
  | "legacyDrawings"
  | "charts"
  | "smartArt"
  | "embeddedObjects"
  | "activeX"
  | "footnotes"
  | "endnotes"
  | "equations"
  | "altChunks"
  | "customXml"
  | "signatures";

export interface DocxFeatureDetail {
  type: AdvancedDocxFeature;
  count: number;
  parts: string[];
  digest: string;
}

export interface DocxMediaItem {
  index: number;
  part: string;
  name: string;
  mimeType: string;
  bytes: number;
}

export interface DocxIntegrityReport {
  valid: boolean;
  entryCount: number;
  missingRequiredParts: string[];
  brokenRelationships: Array<{ relationshipPart: string; target: string }>;
  missingContentTypeParts: string[];
  xmlErrors: Array<{ part: string; error: string }>;
}

export interface DocxPackageReport {
  integrity: DocxIntegrityReport;
  hasAdvancedContent: boolean;
  advancedFeatures: DocxFeatureDetail[];
  media: DocxMediaItem[];
  metadata: Record<string, string>;
}

const PART_FEATURES: Array<{ type: AdvancedDocxFeature; matches(name: string): boolean }> = [
  { type: "macros", matches: (name) => name === "word/vbaproject.bin" || name.startsWith("word/vba") },
  { type: "comments", matches: (name) => name.startsWith("word/comments") },
  { type: "charts", matches: (name) => name.startsWith("word/charts/") },
  { type: "smartArt", matches: (name) => name.startsWith("word/diagrams/") },
  { type: "embeddedObjects", matches: (name) => name.startsWith("word/embeddings/") },
  { type: "activeX", matches: (name) => name.startsWith("word/activex/") },
  { type: "footnotes", matches: (name) => name === "word/footnotes.xml" },
  { type: "endnotes", matches: (name) => name === "word/endnotes.xml" },
  { type: "altChunks", matches: (name) => name.startsWith("word/afchunk") },
  { type: "signatures", matches: (name) => name.startsWith("_xmlsignatures/") }
];

const XML_FEATURES: Array<{ type: AdvancedDocxFeature; pattern: RegExp }> = [
  { type: "trackedChanges", pattern: /<(?:\w+:)?(?:ins|del|moveFrom|moveTo)(?:\s|>)/i },
  { type: "contentControls", pattern: /<(?:\w+:)?sdt(?:\s|>)/i },
  { type: "fields", pattern: /<(?:\w+:)?(?:fldSimple|instrText)(?:\s|>)/i },
  { type: "textBoxes", pattern: /<(?:\w+:)?(?:txbxContent|textbox)(?:\s|>)/i },
  { type: "legacyDrawings", pattern: /<(?:w:pict|v:(?:shape|group|imagedata))(?:\s|>)/i },
  { type: "equations", pattern: /<(?:\w+:)?oMath(?:Para)?(?:\s|>)/i }
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true, processEntities: false
});

export async function inspectDocxPackage(source: string | Buffer): Promise<DocxPackageReport> {
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
  const entryNames = new Set(entries.map(normalizePartName));
  const missingRequiredParts = REQUIRED_PARTS.filter((name) => !entryNames.has(normalizePartName(name)));
  const brokenRelationships: DocxIntegrityReport["brokenRelationships"] = [];
  const missingContentTypeParts: string[] = [];
  const xmlErrors: DocxIntegrityReport["xmlErrors"] = [];

  for (const relationshipPart of entries.filter((name) => normalizePartName(name).endsWith(".rels"))) {
    const relationships = await readXml(zip, relationshipPart, xmlErrors);
    if (!relationships) continue;
    for (const relationship of asArray(findNode(relationships, "Relationships")?.Relationship)) {
      if (!isRecord(relationship) || String(relationship["@TargetMode"] ?? "").toLowerCase() === "external") continue;
      const target = String(relationship["@Target"] ?? "").trim();
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolvedTarget = resolveRelationshipTarget(relationshipPart, target);
      if (!resolvedTarget || !entryNames.has(normalizePartName(resolvedTarget))) {
        pushBounded(brokenRelationships, { relationshipPart, target });
      }
    }
  }

  const contentTypesEntry = findEntry(entries, "[content_types].xml");
  if (contentTypesEntry) {
    const contentTypes = await readXml(zip, contentTypesEntry, xmlErrors);
    for (const override of asArray(findNode(contentTypes, "Types")?.Override)) {
      if (!isRecord(override)) continue;
      const partName = String(override["@PartName"] ?? "").replace(/^\//, "");
      if (partName && !entryNames.has(normalizePartName(partName))) pushBounded(missingContentTypeParts, partName);
    }
  }

  const documentEntry = findEntry(entries, "word/document.xml");
  if (documentEntry) await readXml(zip, documentEntry, xmlErrors);
  const featureParts = new Map<AdvancedDocxFeature, Set<string>>();
  for (const matcher of PART_FEATURES) {
    for (const entry of entries.filter((name) => matcher.matches(normalizePartName(name)))) {
      addFeaturePart(featureParts, matcher.type, entry);
    }
  }
  const customXmlParts = entries.filter((name) => normalizePartName(name).startsWith("customxml/"));
  if (customXmlParts.length > 0 && !await isStandardBibliographyCustomXml(zip, customXmlParts)) {
    for (const part of customXmlParts) addFeaturePart(featureParts, "customXml", part);
  }
  for (const entry of entries.filter((name) => isWordXmlPart(normalizePartName(name)))) {
    const xml = await readBoundedText(zip, entry, xmlErrors);
    if (xml === undefined) continue;
    for (const matcher of XML_FEATURES) {
      if (matcher.pattern.test(xml)) addFeaturePart(featureParts, matcher.type, entry);
    }
  }

  const advancedFeatures: DocxFeatureDetail[] = [];
  for (const [type, partSet] of featureParts) {
    const parts = [...partSet].sort();
    const hash = createHash("sha256");
    for (const part of parts) {
      hash.update(part);
      const entry = zip.file(part);
      if (entry) hash.update(await entry.async("nodebuffer"));
    }
    advancedFeatures.push({ type, count: parts.length, parts: parts.slice(0, 20), digest: hash.digest("hex") });
  }
  advancedFeatures.sort((left, right) => left.type.localeCompare(right.type));

  const mediaParts = entries.filter((name) => normalizePartName(name).startsWith("word/media/")).sort();
  const media: DocxMediaItem[] = [];
  for (const [mediaIndex, part] of mediaParts.entries()) {
    const entry = zip.file(part);
    if (!entry) continue;
    const bytes = (await entry.async("nodebuffer")).byteLength;
    media.push({
      index: mediaIndex + 1,
      part,
      name: path.posix.basename(part),
      mimeType: mediaMimeType(part),
      bytes
    });
  }

  const metadata = await readCoreMetadata(zip, entries, xmlErrors);
  const integrity = {
    valid: missingRequiredParts.length === 0
      && brokenRelationships.length === 0
      && missingContentTypeParts.length === 0
      && xmlErrors.length === 0,
    entryCount: entries.length,
    missingRequiredParts,
    brokenRelationships,
    missingContentTypeParts,
    xmlErrors
  };
  return {
    integrity,
    hasAdvancedContent: advancedFeatures.length > 0,
    advancedFeatures,
    media,
    metadata
  };
}

export async function readDocxMedia(source: string, selectedIndexes: number[]): Promise<Array<DocxMediaItem & { buffer: Buffer }>> {
  const zip = await JSZip.loadAsync(await fs.readFile(source), { checkCRC32: true });
  const entries = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
  const mediaParts = entries.filter((name) => normalizePartName(name).startsWith("word/media/")).sort();
  const output: Array<DocxMediaItem & { buffer: Buffer }> = [];
  for (const index of selectedIndexes) {
    const part = mediaParts[index - 1];
    const entry = part ? zip.file(part) : undefined;
    if (!part || !entry) throw new Error(`Embedded image ${index} does not exist.`);
    const buffer = await entry.async("nodebuffer");
    output.push({ index, part, name: path.posix.basename(part), mimeType: mediaMimeType(part), bytes: buffer.byteLength, buffer });
  }
  return output;
}

export function assertDocxIntegrity(report: DocxPackageReport): void {
  if (report.integrity.valid) return;
  const details = [
    ...report.integrity.missingRequiredParts.map((part) => `missing ${part}`),
    ...report.integrity.brokenRelationships.map((item) => `broken relationship ${item.relationshipPart} -> ${item.target}`),
    ...report.integrity.missingContentTypeParts.map((part) => `missing content-type part ${part}`),
    ...report.integrity.xmlErrors.map((item) => `invalid XML ${item.part}`)
  ];
  throw new Error(`Word OOXML package is incomplete: ${details.slice(0, 5).join("; ") || "unknown package error"}.`);
}

function invalidPackageReport(error: string, entryCount = 0): DocxPackageReport {
  return {
    integrity: {
      valid: false,
      entryCount,
      missingRequiredParts: [],
      brokenRelationships: [],
      missingContentTypeParts: [],
      xmlErrors: [{ part: "package", error }]
    },
    hasAdvancedContent: false,
    advancedFeatures: [],
    media: [],
    metadata: {}
  };
}

async function readXml(zip: JSZip, part: string, errors: DocxIntegrityReport["xmlErrors"]): Promise<Record<string, unknown> | undefined> {
  const text = await readBoundedText(zip, part, errors);
  if (text === undefined) return undefined;
  try {
    const parsed = parser.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error("XML root is not an object.");
    return parsed;
  } catch (error) {
    pushBounded(errors, { part, error: errorMessage(error) });
    return undefined;
  }
}

async function readBoundedText(zip: JSZip, part: string, errors: DocxIntegrityReport["xmlErrors"]): Promise<string | undefined> {
  const entry = zip.file(part);
  if (!entry) return undefined;
  try {
    const buffer = await entry.async("nodebuffer");
    if (buffer.byteLength > MAX_XML_BYTES) throw new Error(`XML part exceeds ${MAX_XML_BYTES} bytes.`);
    return buffer.toString("utf8");
  } catch (error) {
    pushBounded(errors, { part, error: errorMessage(error) });
    return undefined;
  }
}

async function readCoreMetadata(zip: JSZip, entries: string[], errors: DocxIntegrityReport["xmlErrors"]): Promise<Record<string, string>> {
  const corePart = findEntry(entries, "docprops/core.xml");
  if (!corePart) return {};
  const core = await readXml(zip, corePart, errors);
  const root = findNode(core, "coreProperties");
  if (!root) return {};
  const fields = ["title", "subject", "creator", "keywords", "description", "lastModifiedBy", "created", "modified"];
  return Object.fromEntries(fields.flatMap((field) => {
    const value = scalarNode(root[field]);
    return value ? [[field, value.slice(0, 2_000)]] : [];
  }));
}

async function isStandardBibliographyCustomXml(zip: JSZip, parts: string[]): Promise<boolean> {
  const dataParts = parts.filter((part) => /customxml\/item\d+\.xml$/i.test(normalizePartName(part)));
  if (dataParts.length === 0) return false;
  for (const part of dataParts) {
    const text = await zip.file(part)?.async("string");
    if (!text?.includes("schemas.openxmlformats.org/officeDocument/2006/bibliography")) return false;
  }
  return true;
}

function scalarNode(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value) && typeof value["#text"] === "string") return value["#text"];
  return undefined;
}

function addFeaturePart(features: Map<AdvancedDocxFeature, Set<string>>, type: AdvancedDocxFeature, part: string): void {
  const existing = features.get(type) ?? new Set<string>();
  existing.add(part);
  features.set(type, existing);
}

function isWordXmlPart(name: string): boolean {
  return name.startsWith("word/") && name.endsWith(".xml") && !name.startsWith("word/theme/");
}

function mediaMimeType(part: string): string {
  const extension = path.posix.extname(part).toLowerCase();
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".svg": "image/svg+xml",
    ".emf": "image/emf",
    ".wmf": "image/wmf"
  };
  return types[extension] ?? "application/octet-stream";
}

function findNode(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value[key])) return value[key] as Record<string, unknown>;
  for (const child of Object.values(value)) {
    const found = findNode(child, key);
    if (found) return found;
  }
  return undefined;
}

function resolveRelationshipTarget(relationshipPart: string, targetInput: string): string | undefined {
  const target = targetInput.split("#", 1)[0]!.replaceAll("\\", "/");
  if (!target) return undefined;
  if (target.startsWith("/")) return path.posix.normalize(target.slice(1));
  const normalizedRelationship = relationshipPart.replaceAll("\\", "/");
  const marker = "/_rels/";
  const markerIndex = normalizedRelationship.lastIndexOf(marker);
  const sourceDirectory = markerIndex >= 0 ? normalizedRelationship.slice(0, markerIndex) : "";
  const resolved = path.posix.normalize(path.posix.join(sourceDirectory, decodeURIComponentSafely(target)));
  return resolved.startsWith("../") ? undefined : resolved;
}

function normalizePartName(name: string): string {
  return name.replace(/^\//, "").replaceAll("\\", "/").toLowerCase();
}

function findEntry(entries: string[], normalizedName: string): string | undefined {
  return entries.find((entry) => normalizePartName(entry) === normalizedName);
}

function decodeURIComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushBounded<T>(items: T[], value: T): void {
  if (items.length < MAX_REPORTED_ISSUES) items.push(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
