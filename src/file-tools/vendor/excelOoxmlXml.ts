// Adapted from patrick-agent/src/tools/excelOoxmlXml.ts; only requested dependency closure.
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type JSZip from "jszip";
import { isRecord } from "../workspace.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true, processEntities: false
});

export function parseOoxmlXml(xml: string): Record<string, unknown> {
  const value = xmlParser.parse(xml) as unknown;
  return isRecord(value) ? value : {};
}

export function findOoxmlNode(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value[key])) return value[key] as Record<string, unknown>;
  for (const child of Object.values(value)) {
    const found = findOoxmlNode(child, key);
    if (found) return found;
  }
  return undefined;
}

export function collectOoxmlNodeValues(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectOoxmlNodeValues(item, key));
  if (!isRecord(value)) return [];
  const output: unknown[] = [];
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) {
      output.push(...asOoxmlArray(entryValue).map((item) =>
        isRecord(item) && "#text" in item ? item["#text"] : item
      ));
    }
    output.push(...collectOoxmlNodeValues(entryValue, key));
  }
  return output;
}

export function asOoxmlArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function relationshipPartPath(part: string): string {
  return path.posix.join(path.posix.dirname(part), "_rels", `${path.posix.basename(part)}.rels`);
}

export function resolvePartTarget(sourcePart: string, target: string): string | undefined {
  const normalized = target.replaceAll("\\", "/");
  const resolved = normalized.startsWith("/")
    ? path.posix.normalize(normalized.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), normalized));
  return resolved.startsWith("../") || resolved === ".." ? undefined : resolved;
}

export async function readZipText(zip: JSZip, part: string): Promise<string | undefined> {
  return zip.file(part)?.async("string");
}

export async function readOoxmlRelationships(
  zip: JSZip,
  part: string
): Promise<Array<{ id: string; type: string; target: string }>> {
  const xml = await readZipText(zip, part);
  if (!xml) return [];
  const parsed = parseOoxmlXml(xml);
  const node = findOoxmlNode(parsed, "Relationships");
  return asOoxmlArray(node?.Relationship).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = String(raw["@Id"] ?? "");
    const type = String(raw["@Type"] ?? "");
    const target = String(raw["@Target"] ?? "");
    const targetMode = String(raw["@TargetMode"] ?? "").toLowerCase();
    return id && type && target && targetMode !== "external"
      ? [{ id, type, target }]
      : [];
  });
}

export interface OoxmlSheetPart {
  name: string;
  part: string;
  state: "visible" | "hidden" | "veryHidden";
}

export async function loadOoxmlSheetParts(zip: JSZip): Promise<OoxmlSheetPart[]> {
  const workbookXml = await readZipText(zip, "xl/workbook.xml");
  const relationships = await readOoxmlRelationships(zip, "xl/_rels/workbook.xml.rels");
  if (!workbookXml) return [];
  const parsed = parseOoxmlXml(workbookXml);
  const sheetsNode = findOoxmlNode(parsed, "sheets");
  const relations = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  return asOoxmlArray(sheetsNode?.sheet).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const name = String(raw["@name"] ?? "");
    const relationship = relations.get(String(raw["@id"] ?? raw["@r:id"] ?? ""));
    const part = relationship
      ? resolvePartTarget("xl/workbook.xml", relationship.target)
      : undefined;
    const state = parseSheetState(String(raw["@state"] ?? ""));
    return name && part ? [{ name, part, state }] : [];
  });
}

function parseSheetState(value: string): OoxmlSheetPart["state"] {
  if (value === "hidden") return "hidden";
  if (value === "veryHidden") return "veryHidden";
  return "visible";
}

export async function readOoxmlDrawingTexts(
  zip: JSZip,
  selectedSheets: readonly string[]
): Promise<Array<{ sheet: string; part: string; text: string }>> {
  const sheetParts = await loadOoxmlSheetParts(zip);
  const output: Array<{ sheet: string; part: string; text: string }> = [];
  for (const sheet of sheetParts.filter((item) => selectedSheets.includes(item.name))) {
    const relationships = await readOoxmlRelationships(zip, relationshipPartPath(sheet.part));
    for (const relationship of relationships.filter((item) => item.type.endsWith("/drawing"))) {
      const drawingPart = resolvePartTarget(sheet.part, relationship.target);
      if (!drawingPart) continue;
      const xml = await readZipText(zip, drawingPart);
      if (!xml) continue;
      const parsed = parseOoxmlXml(xml);
      const values = collectOoxmlNodeValues(parsed, "t")
        .map((value) => String(value).trim())
        .filter(Boolean);
      if (values.length > 0) {
        output.push({ sheet: sheet.name, part: drawingPart, text: values.join("\n") });
      }
    }
  }
  return output;
}
