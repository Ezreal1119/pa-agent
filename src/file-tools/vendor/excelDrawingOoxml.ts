// Adapted from patrick-agent/src/tools/excelDrawingOoxml.ts; only requested dependency closure.
import path from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { assertOoxmlIntegrity, inspectExcelPackage } from "./excelOoxml.js";

const EMU_PER_PIXEL = 9_525;

const DRAWING_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";

const IMAGE_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

const DRAWING_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.drawing+xml";

const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";

const SPREADSHEET_DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";

const DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main";

const OFFICE_RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true, processEntities: false
});

export interface WorkbookImageDescriptor {
  imageId: string;
  sheet: string;
  name: string;
  description?: string;
  mediaPath: string;
  format: "png" | "jpeg";
  sourceWidthPx: number;
  sourceHeightPx: number;
  anchorType: "oneCell" | "twoCell";
  from: DrawingCoordinate;
  to?: DrawingCoordinate;
  extent?: { widthPx: number; heightPx: number };
}

export interface DrawingCoordinate {
  row: number;
  column: number;
  rowOffsetPx: number;
  columnOffsetPx: number;
}

interface WorkbookSheetPart {
  name: string;
  path: string;
}

interface DrawingContext {
  sheet: WorkbookSheetPart;
  worksheetXml: string;
  worksheetRelationshipsPath: string;
  worksheetRelationshipsXml: string;
  drawingRelationshipId: string;
  drawingPath: string;
  drawingXml: string;
  drawingRelationshipsPath: string;
  drawingRelationshipsXml: string;
}

interface ParsedPicture {
  descriptor: WorkbookImageDescriptor;
  drawingPath: string;
  drawingRelationshipsPath: string;
  relationshipId: string;
  anchorXml: string;
  anchorIndex: number;
  pictureXml: string;
}

interface RelationshipRecord {
  id: string;
  type: string;
  target: string;
  targetMode?: string;
}

export async function inspectWorkbookImagesOoxml(source: Buffer): Promise<WorkbookImageDescriptor[]> {
  const report = await inspectExcelPackage(source);
  assertOoxmlIntegrity(report);
  const zip = await JSZip.loadAsync(source, { checkCRC32: true });
  const sheets = await loadWorkbookSheetParts(zip);
  const descriptors: WorkbookImageDescriptor[] = [];
  for (const sheet of sheets) {
    const context = await loadDrawingContext(zip, sheet, false);
    if (!context) continue;
    const pictures = await parsePictures(zip, context);
    descriptors.push(...pictures.map((picture) => picture.descriptor));
  }
  return descriptors;
}

async function loadDrawingContext(
  zip: JSZip,
  sheet: WorkbookSheetPart,
  create: boolean,
  changedParts: Set<string> = new Set()
): Promise<DrawingContext | undefined> {
  let worksheetXml = await requiredZipText(zip, sheet.path);
  const worksheetRelationshipsPath = relationshipPartPath(sheet.path);
  let worksheetRelationshipsXml = zip.file(worksheetRelationshipsPath)
    ? await requiredZipText(zip, worksheetRelationshipsPath)
    : emptyRelationshipsXml();
  const drawingRelationshipId = extractDrawingRelationshipId(worksheetXml);
  if (drawingRelationshipId) {
    const relationship = parseRelationships(worksheetRelationshipsXml)
      .find((candidate) => candidate.id === drawingRelationshipId && candidate.type === DRAWING_RELATIONSHIP_TYPE);
    if (!relationship) throw new Error(`Drawing relationship is missing for worksheet "${sheet.name}".`);
    const drawingPath = resolvePackageTarget(sheet.path, relationship.target);
    const drawingRelationshipsPath = relationshipPartPath(drawingPath);
    return {
      sheet,
      worksheetXml,
      worksheetRelationshipsPath,
      worksheetRelationshipsXml,
      drawingRelationshipId,
      drawingPath,
      drawingXml: await requiredZipText(zip, drawingPath),
      drawingRelationshipsPath,
      drawingRelationshipsXml: zip.file(drawingRelationshipsPath)
        ? await requiredZipText(zip, drawingRelationshipsPath)
        : emptyRelationshipsXml()
    };
  }
  if (!create) return undefined;

  const drawingPath = nextDrawingPath(zip);
  const newDrawingRelationshipId = nextRelationshipId(worksheetRelationshipsXml);
  worksheetRelationshipsXml = insertRelationship(worksheetRelationshipsXml, {
    id: newDrawingRelationshipId,
    type: DRAWING_RELATIONSHIP_TYPE,
    target: relativePackageTarget(sheet.path, drawingPath)
  });
  worksheetXml = ensureWorksheetRelationshipsNamespace(worksheetXml);
  worksheetXml = worksheetXml.replace(
    /<\/worksheet>/u,
    `<drawing r:id="${escapeXmlAttribute(newDrawingRelationshipId)}"/></worksheet>`
  );
  const drawingXml = emptyDrawingXml();
  const drawingRelationshipsPath = relationshipPartPath(drawingPath);
  const drawingRelationshipsXml = emptyRelationshipsXml();
  zip.file(sheet.path, worksheetXml);
  zip.file(worksheetRelationshipsPath, worksheetRelationshipsXml);
  zip.file(drawingPath, drawingXml);
  zip.file(drawingRelationshipsPath, drawingRelationshipsXml);
  changedParts.add(sheet.path);
  changedParts.add(worksheetRelationshipsPath);
  changedParts.add(drawingPath);
  changedParts.add(drawingRelationshipsPath);
  ensureDrawingContentType(zip, drawingPath, changedParts);
  return {
    sheet,
    worksheetXml,
    worksheetRelationshipsPath,
    worksheetRelationshipsXml,
    drawingRelationshipId: newDrawingRelationshipId,
    drawingPath,
    drawingXml,
    drawingRelationshipsPath,
    drawingRelationshipsXml
  };
}

async function parsePictures(zip: JSZip, context: DrawingContext): Promise<ParsedPicture[]> {
  const relationships = parseRelationships(context.drawingRelationshipsXml);
  const relationshipById = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  const anchorPattern = /<(?:\w+:)?(oneCellAnchor|twoCellAnchor)\b[^>]*>[\s\S]*?<\/(?:\w+:)?\1>/gu;
  const pictures: ParsedPicture[] = [];
  for (const match of context.drawingXml.matchAll(anchorPattern)) {
    if (match.index === undefined || !/<(?:\w+:)?pic(?:\s|>)/u.test(match[0])) continue;
    const pictureXml = match[0].match(/<(?:\w+:)?pic\b[^>]*>[\s\S]*?<\/(?:\w+:)?pic>/u)?.[0];
    if (!pictureXml) continue;
    const nonVisual = pictureXml.match(/<(?:\w+:)?cNvPr\b[^>]*>/u)?.[0];
    const objectId = nonVisual ? xmlAttribute(nonVisual, "id") : undefined;
    const name = nonVisual ? xmlAttribute(nonVisual, "name") : undefined;
    const description = nonVisual ? xmlAttribute(nonVisual, "descr") : undefined;
    const blip = pictureXml.match(/<(?:\w+:)?blip\b[^>]*>/u)?.[0];
    const relationshipId = blip ? xmlAttribute(blip, "embed") : undefined;
    if (!objectId || !relationshipId) continue;
    const relationship = relationshipById.get(relationshipId);
    if (!relationship || relationship.type !== IMAGE_RELATIONSHIP_TYPE) continue;
    const mediaPath = resolvePackageTarget(context.drawingPath, relationship.target);
    const media = zip.file(mediaPath);
    if (!media) throw new Error(`Embedded image part is missing: ${mediaPath}.`);
    const bytes = await media.async("nodebuffer");
    const dimensions = await readImageDimensions(bytes);
    const format = imageFormatFromPath(mediaPath);
    const from = parseDrawingCoordinate(requiredAnchorChild(match[0], "from"));
    const anchorType = match[1] === "oneCellAnchor" ? "oneCell" : "twoCell";
    const to = anchorType === "twoCell"
      ? parseDrawingCoordinate(requiredAnchorChild(match[0], "to"))
      : undefined;
    const ext = anchorType === "oneCell"
      ? parseExtent(requiredAnchorChild(match[0], "ext"))
      : undefined;
    pictures.push({
      descriptor: {
        imageId: `${context.drawingPath}#${objectId}`,
        sheet: context.sheet.name,
        name: name ?? `Picture ${objectId}`,
        ...(description ? { description } : {}),
        mediaPath,
        format,
        sourceWidthPx: dimensions.width,
        sourceHeightPx: dimensions.height,
        anchorType,
        from,
        ...(to ? { to } : {}),
        ...(ext ? { extent: ext } : {})
      },
      drawingPath: context.drawingPath,
      drawingRelationshipsPath: context.drawingRelationshipsPath,
      relationshipId,
      anchorXml: match[0],
      anchorIndex: match.index,
      pictureXml
    });
  }
  return pictures;
}

async function loadWorkbookSheetParts(zip: JSZip): Promise<WorkbookSheetPart[]> {
  const workbook = asRecord(parser.parse(await requiredZipText(zip, "xl/workbook.xml")));
  const workbookNode = asRecord(workbook.workbook);
  const sheetsNode = asRecord(workbookNode.sheets);
  const relationships = parseRelationships(await requiredZipText(zip, "xl/_rels/workbook.xml.rels"));
  const byId = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  return asArray(sheetsNode.sheet).map((raw) => {
    const sheet = asRecord(raw);
    const name = requiredAttribute(sheet, "name");
    const relationshipId = requiredAttribute(sheet, "id");
    const relationship = byId.get(relationshipId);
    if (!relationship || !relationship.type.endsWith("/worksheet")) {
      throw new Error(`Worksheet relationship is missing for "${name}".`);
    }
    return { name, path: resolvePackageTarget("xl/workbook.xml", relationship.target) };
  });
}

function parseRelationships(xml: string): RelationshipRecord[] {
  const parsed = asRecord(parser.parse(xml));
  const root = asRecord(parsed.Relationships);
  return asArray(root.Relationship).map((raw) => {
    const relationship = asRecord(raw);
    return {
      id: requiredAttribute(relationship, "Id"),
      type: requiredAttribute(relationship, "Type"),
      target: requiredAttribute(relationship, "Target"),
      ...(typeof relationship["@TargetMode"] === "string"
        ? { targetMode: relationship["@TargetMode"] as string }
        : {})
    };
  });
}

function insertRelationship(xml: string, relationship: RelationshipRecord): string {
  const targetMode = relationship.targetMode
    ? ` TargetMode="${escapeXmlAttribute(relationship.targetMode)}"`
    : "";
  const item = `<Relationship Id="${escapeXmlAttribute(relationship.id)}" Type="${escapeXmlAttribute(relationship.type)}" Target="${escapeXmlAttribute(relationship.target)}"${targetMode}/>`;
  if (!/<\/Relationships>/u.test(xml)) throw new Error("OOXML relationships part is invalid.");
  return xml.replace(/<\/Relationships>/u, `${item}</Relationships>`);
}

function ensureDrawingContentType(zip: JSZip, drawingPath: string, changedParts: Set<string>): void {
  const contentTypesPath = "[Content_Types].xml";
  const entry = zip.file(contentTypesPath);
  if (!entry) throw new Error("OOXML content types are missing.");
  zip.file(contentTypesPath, entry.async("string").then((xml) => {
    if (new RegExp(`\\bPartName="/${escapeRegExp(drawingPath)}"`, "u").test(xml)) return xml;
    changedParts.add(contentTypesPath);
    return xml.replace(
      /<\/Types>/u,
      `<Override PartName="/${escapeXmlAttribute(drawingPath)}" ContentType="${DRAWING_CONTENT_TYPE}"/></Types>`
    );
  }));
}

function ensureWorksheetRelationshipsNamespace(xml: string): string {
  const opening = xml.match(/<worksheet\b[^>]*>/u)?.[0];
  if (!opening) throw new Error("Worksheet XML root is invalid.");
  if (/\bxmlns:r="/u.test(opening)) return xml;
  return xml.replace(
    opening,
    opening.replace(/>$/u, ` xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}">`)
  );
}

function emptyRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS_NAMESPACE}"></Relationships>`;
}

function emptyDrawingXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="${SPREADSHEET_DRAWING_NAMESPACE}" xmlns:a="${DRAWING_NAMESPACE}" xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}"></xdr:wsDr>`;
}

function extractDrawingRelationshipId(worksheetXml: string): string | undefined {
  const tag = worksheetXml.match(/<(?:\w+:)?drawing\b[^>]*>/u)?.[0];
  return tag ? xmlAttribute(tag, "id") : undefined;
}

function requiredAnchorChild(anchorXml: string, localName: string): string {
  const selfClosing = new RegExp(`<(?:\\w+:)?${localName}\\b[^>]*?\\/>`, "u");
  const paired = new RegExp(
    `<(?:\\w+:)?${localName}\\b[^>]*>[\\s\\S]*?<\\/(?:\\w+:)?${localName}>`,
    "u"
  );
  const match = anchorXml.match(selfClosing)?.[0] ?? anchorXml.match(paired)?.[0];
  if (!match) throw new Error(`Drawing anchor is missing ${localName}.`);
  return match;
}

function parseDrawingCoordinate(xml: string): DrawingCoordinate {
  return {
    column: coordinateValue(xml, "col"),
    columnOffsetPx: emuToPixels(coordinateValue(xml, "colOff")),
    row: coordinateValue(xml, "row"),
    rowOffsetPx: emuToPixels(coordinateValue(xml, "rowOff"))
  };
}

function coordinateValue(xml: string, localName: string): number {
  const pattern = new RegExp(`<(?:\\w+:)?${localName}>\\s*(-?[0-9]+)\\s*<\\/(?:\\w+:)?${localName}>`, "u");
  const value = Number(xml.match(pattern)?.[1]);
  if (!Number.isFinite(value)) throw new Error(`Drawing coordinate ${localName} is invalid.`);
  return value;
}

function parseExtent(xml: string): { widthPx: number; heightPx: number } {
  const width = xmlAttribute(xml, "cx");
  const height = xmlAttribute(xml, "cy");
  if (!width || !height) throw new Error("Drawing extent is invalid.");
  return { widthPx: emuToPixels(Number(width)), heightPx: emuToPixels(Number(height)) };
}

function nextDrawingPath(zip: JSZip): string {
  const used = new Set(Object.keys(zip.files)
    .map((name) => name.match(/^xl\/drawings\/drawing([0-9]+)\.xml$/u)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number));
  for (let index = 1; index <= 100_000; index += 1) {
    if (!used.has(index)) return `xl/drawings/drawing${index}.xml`;
  }
  throw new Error("Unable to allocate a drawing part.");
}

function nextRelationshipId(xml: string): string {
  const used = new Set([...xml.matchAll(/\bId="rId([0-9]+)"/gu)].map((match) => Number(match[1])));
  for (let index = 1; index <= 1_000_000; index += 1) {
    if (!used.has(index)) return `rId${index}`;
  }
  throw new Error("Unable to allocate an OOXML relationship id.");
}

function relationshipPartPath(sourcePart: string): string {
  return path.posix.join(
    path.posix.dirname(sourcePart),
    "_rels",
    `${path.posix.basename(sourcePart)}.rels`
  );
}

function relativePackageTarget(sourcePart: string, targetPart: string): string {
  return path.posix.relative(path.posix.dirname(sourcePart), targetPart);
}

function resolvePackageTarget(sourcePart: string, target: string): string {
  if (target.startsWith("/")) return normalizePartPath(target.slice(1));
  return normalizePartPath(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), target)));
}

function normalizePartPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/u, "");
  if (!normalized || normalized.startsWith("../") || normalized.split("/").includes("..")) {
    throw new Error(`Invalid OOXML part path: ${value}.`);
  }
  return normalized;
}

function imageFormatFromPath(mediaPath: string): "png" | "jpeg" {
  const extension = path.posix.extname(mediaPath).toLowerCase();
  if (extension === ".png") return "png";
  if (extension === ".jpg" || extension === ".jpeg") return "jpeg";
  throw new Error(`Unsupported embedded Excel image format: ${extension || "(none)"}.`);
}

async function readImageDimensions(bytes: Buffer): Promise<{ width: number; height: number }> {
  try {
    const image = await loadImage(bytes);
    return { width: image.width, height: image.height };
  } catch {
    throw new Error("Embedded Excel image cannot be decoded.");
  }
}

function xmlAttribute(tag: string, localName: string): string | undefined {
  const escaped = escapeRegExp(localName);
  return tag.match(new RegExp(`\\b(?:\\w+:)?${escaped}="([^"]*)"`, "u"))?.[1];
}

function requiredAttribute(record: Record<string, unknown>, name: string): string {
  const value = record[`@${name}`];
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`OOXML attribute ${name} is missing.`);
  }
  return String(value);
}

function emuToPixels(value: number): number {
  return Math.round((value / EMU_PER_PIXEL) * 100) / 100;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OOXML structure is invalid.");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

async function requiredZipText(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) throw new Error(`Required OOXML part is missing: ${name}.`);
  return entry.async("string");
}
