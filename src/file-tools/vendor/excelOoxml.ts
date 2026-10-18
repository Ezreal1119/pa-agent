// Adapted from patrick-agent/src/tools/excelOoxml.ts; only requested dependency closure.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

const REQUIRED_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels"
];

const MAX_PACKAGE_ENTRIES = 10_000;

const MAX_XML_BYTES = 5 * 1024 * 1024;

const MAX_REPORTED_ISSUES = 100;

export type AdvancedExcelFeature =
  | "macros"
  | "charts"
  | "drawings"
  | "pivotTables"
  | "externalConnections"
  | "queryTables"
  | "slicers"
  | "timelines"
  | "embeddedObjects"
  | "activeX"
  | "dataModel"
  | "signatures"
  | "webextensions";

export interface AdvancedFeatureDetail {
  type: AdvancedExcelFeature;
  count: number;
  parts: string[];
  digest: string;
}

export interface OoxmlIntegrityReport {
  valid: boolean;
  entryCount: number;
  missingRequiredParts: string[];
  brokenRelationships: Array<{ relationshipPart: string; target: string }>;
  missingContentTypeParts: string[];
  xmlErrors: Array<{ part: string; error: string }>;
}

export interface ExcelPackageReport {
  integrity: OoxmlIntegrityReport;
  hasAdvancedContent: boolean;
  advancedFeatures: AdvancedFeatureDetail[];
}

const FEATURE_MATCHERS: Array<{ type: AdvancedExcelFeature; matches(name: string): boolean }> = [
  { type: "macros", matches: (name) => name === "xl/vbaproject.bin" || name.startsWith("xl/vba") },
  { type: "charts", matches: (name) => name.startsWith("xl/charts/") },
  { type: "drawings", matches: (name) => name.startsWith("xl/drawings/") },
  { type: "pivotTables", matches: (name) => name.startsWith("xl/pivottables/") || name.startsWith("xl/pivotcache/") },
  { type: "externalConnections", matches: (name) => name === "xl/connections.xml" || name.startsWith("xl/externallinks/") },
  { type: "queryTables", matches: (name) => name.startsWith("xl/querytables/") },
  { type: "slicers", matches: (name) => name.startsWith("xl/slicers/") || name.startsWith("xl/slicercaches/") },
  { type: "timelines", matches: (name) => name.startsWith("xl/timelines/") || name.startsWith("xl/timelinecaches/") },
  { type: "embeddedObjects", matches: (name) => name.startsWith("xl/embeddings/") },
  { type: "activeX", matches: (name) => name.startsWith("xl/activex/") || name.startsWith("xl/ctrlprops/") },
  { type: "dataModel", matches: (name) => name.startsWith("xl/model/") },
  { type: "signatures", matches: (name) => name.startsWith("_xmlsignatures/") },
  { type: "webextensions", matches: (name) => name.startsWith("xl/webextensions/") }
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true, processEntities: false
});

export async function inspectExcelPackage(source: string | Buffer): Promise<ExcelPackageReport> {
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
  const brokenRelationships: OoxmlIntegrityReport["brokenRelationships"] = [];
  const missingContentTypeParts: string[] = [];
  const xmlErrors: OoxmlIntegrityReport["xmlErrors"] = [];

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

  if (entryNames.has("[content_types].xml")) {
    const contentTypes = await readXml(zip, findEntry(entries, "[content_types].xml")!, xmlErrors);
    for (const override of asArray(findNode(contentTypes, "Types")?.Override)) {
      if (!isRecord(override)) continue;
      const partName = String(override["@PartName"] ?? "").replace(/^\//, "");
      if (partName && !entryNames.has(normalizePartName(partName))) pushBounded(missingContentTypeParts, partName);
    }
  }

  const advancedFeatures: AdvancedFeatureDetail[] = [];
  for (const matcher of FEATURE_MATCHERS) {
    const matchingParts = entries.filter((name) => matcher.matches(normalizePartName(name))).sort();
    if (matchingParts.length === 0) continue;
    const hash = createHash("sha256");
    for (const part of matchingParts) {
      hash.update(part);
      hash.update(await zip.file(part)!.async("nodebuffer"));
    }
    advancedFeatures.push({
      type: matcher.type,
      count: matchingParts.length,
      parts: matchingParts.slice(0, 20),
      digest: hash.digest("hex")
    });
  }

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
  return { integrity, hasAdvancedContent: advancedFeatures.length > 0, advancedFeatures };
}

export function assertOoxmlIntegrity(report: ExcelPackageReport): void {
  if (report.integrity.valid) return;
  const details = [
    ...report.integrity.missingRequiredParts.map((part) => `missing ${part}`),
    ...report.integrity.brokenRelationships.map((item) => `broken relationship ${item.relationshipPart} -> ${item.target}`),
    ...report.integrity.missingContentTypeParts.map((part) => `missing content-type part ${part}`),
    ...report.integrity.xmlErrors.map((item) => `invalid XML ${item.part}`)
  ];
  throw new Error(`Workbook OOXML package is incomplete: ${details.slice(0, 5).join("; ") || "unknown package error"}.`);
}

function invalidPackageReport(error: string, entryCount = 0): ExcelPackageReport {
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
    advancedFeatures: []
  };
}

async function readXml(
  zip: JSZip,
  part: string,
  errors: OoxmlIntegrityReport["xmlErrors"]
): Promise<Record<string, unknown> | undefined> {
  const entry = zip.file(part);
  if (!entry) return undefined;
  try {
    const buffer = await entry.async("nodebuffer");
    if (buffer.byteLength > MAX_XML_BYTES) throw new Error(`XML part exceeds ${MAX_XML_BYTES} bytes.`);
    const parsed = parser.parse(buffer.toString("utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("XML root is not an object.");
    return parsed;
  } catch (error) {
    pushBounded(errors, { part, error: errorMessage(error) });
    return undefined;
  }
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
