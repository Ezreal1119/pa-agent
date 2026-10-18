// Adapted from patrick-agent/src/tools/excelTemplateOoxml.ts; only requested dependency closure.
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { assertOoxmlIntegrity, inspectExcelPackage } from "./excelOoxml.js";
import { assertWorksheetPatchIntegrity, worksheetAttributes, worksheetElements } from "./excelTemplateValidation.js";

const MAX_TEMPLATE_PATCH_CELLS = 50_000;

const CELL_ADDRESS_PATTERN = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/u;

const WORKSHEET_RELATIONSHIP_TYPE = /\/worksheet$/u;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true, processEntities: false
});

export type TemplateCellValue =
  | null
  | boolean
  | number
  | string
  | { formula: string; result?: null | boolean | number | string };

export interface TemplatePatchOperation {
  type: "setCell" | "setRange" | "clearCell" | "clearRange";
  sheet: string;
  cell?: string;
  startCell?: string;
  range?: string;
  value?: TemplateCellValue;
  values?: TemplateCellValue[][];
  allowReplaceFormula?: boolean;
}

export interface TemplatePatchResult {
  buffer: Buffer;
  operationsApplied: number;
  cellsChanged: number;
  changedCells: Array<{ sheet: string; cell: string; action: "set" | "clear" }>;
  changedParts: string[];
  unchangedPartsVerified: number;
  formulasRecalculateWhenOpened: boolean;
}

interface WorkbookSheetPart {
  name: string;
  path: string;
}

interface CellCoordinate {
  address: string;
  column: number;
  row: number;
}

interface PartDigest {
  bytes: number;
  sha256: string;
}

export async function patchWorkbookTemplateOoxml(
  source: Buffer,
  operations: readonly TemplatePatchOperation[]
): Promise<TemplatePatchResult> {
  if (operations.length === 0) throw new Error("At least one template patch operation is required.");
  const sourceReport = await inspectExcelPackage(source);
  assertOoxmlIntegrity(sourceReport);
  const zip = await JSZip.loadAsync(source, { checkCRC32: true });
  const sourceDigests = await digestZipParts(zip);
  const originalSheets = new Map<string, string>();
  const sheets = await loadWorkbookSheetParts(zip);
  const sheetByName = new Map(sheets.map((sheet) => [sheet.name, sheet]));
  const xmlBySheetPath = new Map<string, string>();
  const changedCells: TemplatePatchResult["changedCells"] = [];
  const expectedBySheet = new Map<string, Map<string, TemplateCellValue>>();
  let requestedCells = 0;

  for (const operation of operations) {
    const sheetName = operation.sheet;
    // Trailing whitespace can be part of an actual worksheet name. Prefer the
    // exact name and retain the old trim fallback for callers adding whitespace.
    const sheet = sheetByName.get(sheetName) ?? sheetByName.get(sheetName.trim());
    if (!sheet) {
      throw new Error(`Worksheet not found: ${sheetName || "(empty)"}.`);
    }
    const originalXml = xmlBySheetPath.get(sheet.path)
      ?? await requiredZipText(zip, sheet.path);
    if (!originalSheets.has(sheet.path)) originalSheets.set(sheet.path, originalXml);
    if (/<(?:\w+:)?sheetProtection\b/u.test(originalXml)) {
      throw new Error(`Worksheet "${sheet.name}" is protected and cannot be patched safely.`);
    }

    const edits = expandOperation(operation);
    requestedCells += edits.length;
    if (requestedCells > MAX_TEMPLATE_PATCH_CELLS) {
      throw new Error(`Template patch exceeds the ${MAX_TEMPLATE_PATCH_CELLS}-cell limit.`);
    }
    let sheetXml = originalXml;
    const expected = expectedBySheet.get(sheet.path) ?? new Map<string, TemplateCellValue>();
    expectedBySheet.set(sheet.path, expected);
    for (const edit of edits) {
      expected.set(edit.coordinate.address, edit.value);
      const existing = findCellXml(sheetXml, edit.coordinate.address);
      if (existing && containsFormula(existing.xml) && !operation.allowReplaceFormula) {
        throw new Error(
          `Cell ${sheet.name}!${edit.coordinate.address} contains a formula. `
          + "Set allowReplaceFormula to true to replace or clear it."
        );
      }
      const patched = patchWorksheetCell(sheetXml, edit.coordinate, edit.value);
      sheetXml = patched.xml;
      if (patched.changed) {
        changedCells.push({
          sheet: sheet.name,
          cell: edit.coordinate.address,
          action: edit.value === null ? "clear" : "set"
        });
      }
    }
    xmlBySheetPath.set(sheet.path, sheetXml);
  }

  const allowedChangedParts = new Set<string>();
  for (const [sheetPath, xml] of xmlBySheetPath) {
    const before = await requiredZipText(zip, sheetPath);
    assertWorksheetPatchIntegrity(before, xml, expectedBySheet.get(sheetPath)!);
    if (xml !== before) {
      zip.file(sheetPath, xml);
      allowedChangedParts.add(sheetPath);
    }
  }
  if (changedCells.length > 0) {
    await updateWorkbookCalculationProperties(zip, allowedChangedParts);
    await removeCalculationChain(zip, allowedChangedParts);
  }

  const output = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
  const outputReport = await inspectExcelPackage(output);
  assertOoxmlIntegrity(outputReport);
  const outputZip = await JSZip.loadAsync(output, { checkCRC32: true });
  for (const [sheetPath, expected] of expectedBySheet) {
    assertWorksheetPatchIntegrity(originalSheets.get(sheetPath)!, await requiredZipText(outputZip, sheetPath), expected);
  }
  const outputDigests = await digestZipParts(outputZip);
  const changedParts = comparePartDigests(sourceDigests, outputDigests);
  const unexpected = changedParts.filter((part) => !allowedChangedParts.has(part));
  if (unexpected.length > 0) {
    throw new Error(`Template patch changed unexpected OOXML parts: ${unexpected.join(", ")}.`);
  }
  const unchangedPartsVerified = [...sourceDigests.keys()]
    .filter((part) => !changedParts.includes(part))
    .filter((part) => sameDigest(sourceDigests.get(part), outputDigests.get(part)))
    .length;

  return {
    buffer: output,
    operationsApplied: operations.length,
    cellsChanged: changedCells.length,
    changedCells,
    changedParts,
    unchangedPartsVerified,
    formulasRecalculateWhenOpened: changedCells.length > 0
  };
}

/**
 * Unified anchor resolver for all four operations. `range` is the primary parameter (accepts either
 * a single cell "E22" or a rectangle "E22:F48"); `startCell` and `cell` are accepted aliases so
 * older callers keep working. Returns the top-left anchor plus, when a rectangle was given, its
 * explicit bounds so callers can cross-check against the values shape.
 */
function resolveOperationTarget(
  operation: TemplatePatchOperation,
  field: "range" | "startCell" | "cell"
): { anchor: CellCoordinate; bounds?: { start: CellCoordinate; end: CellCoordinate } } {
  const raw = operation.range ?? operation.startCell ?? operation.cell;
  const text = raw?.trim();
  if (!text) throw new Error(`${field} is required.`);
  if (text.includes(":")) {
    const bounds = parseRange(text);
    return { anchor: bounds.start, bounds };
  }
  return { anchor: parseCellAddress(text) };
}

function expandOperation(
  operation: TemplatePatchOperation
): Array<{ coordinate: CellCoordinate; value: TemplateCellValue }> {
  if (operation.type === "setCell") {
    return [{
      coordinate: resolveOperationTarget(operation, "cell").anchor,
      value: normalizeTemplateCellValue(operation.value, "value")
    }];
  }
  if (operation.type === "clearCell") {
    return [{ coordinate: resolveOperationTarget(operation, "cell").anchor, value: null }];
  }
  if (operation.type === "setRange") {
    const target = resolveOperationTarget(operation, "range");
    const start = target.anchor;
    if (!Array.isArray(operation.values) || operation.values.length === 0) {
      throw new Error("setRange.values must contain at least one row.");
    }
    if (operation.values.reduce((count, row) => count + (Array.isArray(row) ? row.length : 0), 0) > MAX_TEMPLATE_PATCH_CELLS) throw new Error("Template patch exceeds the cell limit.");
    // values is the authority for what is written and how far the block extends. When the caller
    // also supplied a rectangle (range "E22:F48"), cross-check its shape against values so a mistaken
    // extent surfaces as a clear error instead of silently writing a differently sized block.
    const rowCount = operation.values.length;
    const columnCount = operation.values[0]?.length ?? 0;
    if (target.bounds) {
      const rectRows = target.bounds.end.row - target.bounds.start.row + 1;
      const rectColumns = target.bounds.end.column - target.bounds.start.column + 1;
      if (rectRows !== rowCount || rectColumns !== columnCount) {
        throw new Error(
          `setRange range covers ${rectRows}x${rectColumns} cells but values is ${rowCount}x${columnCount}. `
          + "Make the range match the values shape, or pass only the top-left cell."
        );
      }
    }
    const edits: Array<{ coordinate: CellCoordinate; value: TemplateCellValue }> = [];
    operation.values.forEach((row, rowOffset) => {
      if (!Array.isArray(row) || row.length === 0) {
        throw new Error("setRange.values rows must contain at least one value.");
      }
      row.forEach((value, columnOffset) => {
        const coordinate = coordinateFromIndexes(start.row + rowOffset, start.column + columnOffset);
        edits.push({ coordinate, value: normalizeTemplateCellValue(value, "values") });
      });
    });
    return edits;
  }
  if (operation.type === "clearRange") {
    const target = resolveOperationTarget(operation, "range");
    const bounds = target.bounds ?? { start: target.anchor, end: target.anchor };
    if ((bounds.end.row - bounds.start.row + 1) * (bounds.end.column - bounds.start.column + 1) > MAX_TEMPLATE_PATCH_CELLS) throw new Error("Template patch exceeds the cell limit.");
    const edits: Array<{ coordinate: CellCoordinate; value: TemplateCellValue }> = [];
    for (let row = bounds.start.row; row <= bounds.end.row; row += 1) {
      for (let column = bounds.start.column; column <= bounds.end.column; column += 1) {
        edits.push({ coordinate: coordinateFromIndexes(row, column), value: null });
      }
    }
    return edits;
  }
  throw new Error(`Unsupported template patch operation: ${String(operation.type)}.`);
}

function patchWorksheetCell(
  xml: string,
  coordinate: CellCoordinate,
  value: TemplateCellValue
): { xml: string; changed: boolean } {
  const existing = findCellXml(xml, coordinate.address);
  if (existing) {
    const replacement = buildCellXml(existing.openingTag, coordinate.address, value);
    if (replacement === existing.xml) return { xml, changed: false };
    return {
      xml: `${xml.slice(0, existing.index)}${replacement}${xml.slice(existing.index + existing.xml.length)}`,
      changed: true
    };
  }
  if (value === null) return { xml, changed: false };
  const cellXml = buildCellXml(`<c r="${coordinate.address}">`, coordinate.address, value);
  const inserted = insertCellIntoWorksheet(xml, coordinate, cellXml);
  return { xml: expandWorksheetDimension(inserted, coordinate), changed: true };
}

function findCellXml(
  xml: string,
  address: string
): { index: number; xml: string; openingTag: string } | undefined {
  const cell = worksheetElements(xml, "c").find(cell => worksheetAttributes(cell.openingTag).get("r") === address);
  if (!cell) return undefined;
  return { index: cell.index, xml: cell.xml, openingTag: cell.openingTag };
}

function buildCellXml(openingTagInput: string, address: string, value: TemplateCellValue): string {
  let openingTag = openingTagInput.replace(/\/>$/u, ">").replace(/<\/?c[^>]*>$/u, (match) => match);
  openingTag = setXmlAttribute(openingTag, "r", address);
  openingTag = removeXmlAttribute(openingTag, "t");
  if (value === null) {
    return `${openingTag.slice(0, -1)}/>`;
  }
  if (typeof value === "string") {
    openingTag = setXmlAttribute(openingTag, "t", "inlineStr");
    const preserve = /^\s|\s$/u.test(value) ? ' xml:space="preserve"' : "";
    return `${openingTag}<is><t${preserve}>${escapeXml(value)}</t></is></c>`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Excel numeric values must be finite.");
    return `${openingTag}<v>${String(value)}</v></c>`;
  }
  if (typeof value === "boolean") {
    openingTag = setXmlAttribute(openingTag, "t", "b");
    return `${openingTag}<v>${value ? "1" : "0"}</v></c>`;
  }
  const formula = value.formula.trim().replace(/^=/u, "");
  if (!formula) throw new Error("Formula content cannot be empty.");
  const result = formulaResultXml(value.result);
  return `${openingTag}<f>${escapeXml(formula)}</f>${result}</c>`;
}

function formulaResultXml(result: TemplateCellValue extends never ? never : unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "number") {
    if (!Number.isFinite(result)) throw new Error("Formula numeric results must be finite.");
    return `<v>${String(result)}</v>`;
  }
  if (typeof result === "boolean") return `<v>${result ? "1" : "0"}</v>`;
  if (typeof result === "string") return `<v>${escapeXml(result)}</v>`;
  throw new Error("Formula results must be strings, numbers, booleans, or null.");
}

function insertCellIntoWorksheet(xml: string, coordinate: CellCoordinate, cellXml: string): string {
  const row = worksheetElements(xml, "row").find(row => worksheetAttributes(row.openingTag).get("r") === String(coordinate.row));
  if (row) {
    if (row.selfClosing) {
      const expanded = `${row.openingTag.replace(/\/>$/u, ">")}${cellXml}</row>`;
      return `${xml.slice(0, row.index)}${expanded}${xml.slice(row.end)}`;
    }
    const laterCell = worksheetElements(row.body, "c").find(cell => parseCellAddress(worksheetAttributes(cell.openingTag).get("r") ?? "").column > coordinate.column);
    const insertAt = row.bodyIndex + (laterCell?.index ?? row.body.length);
    return `${xml.slice(0, insertAt)}${cellXml}${xml.slice(insertAt)}`;
  }
  const sheetData = worksheetElements(xml, "sheetData")[0];
  if (!sheetData) throw new Error("Worksheet XML does not contain sheetData.");
  const newRow = `<row r="${coordinate.row}">${cellXml}</row>`;
  if (sheetData.selfClosing) {
    const expanded = `${sheetData.openingTag.replace(/\/>$/u, ">")}${newRow}</sheetData>`;
    return `${xml.slice(0, sheetData.index)}${expanded}${xml.slice(sheetData.end)}`;
  }
  const laterRow = worksheetElements(sheetData.body, "row").find(row => Number(worksheetAttributes(row.openingTag).get("r")) > coordinate.row);
  const insertAt = sheetData.bodyIndex + (laterRow?.index ?? sheetData.body.length);
  return `${xml.slice(0, insertAt)}${newRow}${xml.slice(insertAt)}`;
}

function expandWorksheetDimension(xml: string, coordinate: CellCoordinate): string {
  return xml.replace(/<dimension\b([^>]*\bref=")([^"]+)("[^>]*)\/?>/u, (match, prefix, reference, suffix) => {
    const normalized = String(reference).replace(/\$/gu, "");
    const parts = normalized.split(":");
    const start = parseCellAddress(parts[0]!);
    const end = parseCellAddress(parts[1] ?? parts[0]!);
    const expandedStart = coordinateFromIndexes(
      Math.min(start.row, coordinate.row),
      Math.min(start.column, coordinate.column)
    );
    const expandedEnd = coordinateFromIndexes(
      Math.max(end.row, coordinate.row),
      Math.max(end.column, coordinate.column)
    );
    const selfClosing = match.endsWith("/>") ? "/>" : ">";
    const cleanSuffix = String(suffix).replace(/\/$/u, "");
    return `<dimension${prefix}${expandedStart.address}:${expandedEnd.address}${cleanSuffix}${selfClosing}`;
  });
}

async function loadWorkbookSheetParts(zip: JSZip): Promise<WorkbookSheetPart[]> {
  const workbook = parseRecord(parser.parse(await requiredZipText(zip, "xl/workbook.xml")));
  const relationships = parseRelationships(await requiredZipText(zip, "xl/_rels/workbook.xml.rels"));
  const workbookNode = parseRecord(workbook.workbook);
  const sheetsNode = parseRecord(workbookNode.sheets);
  const rawSheets = asArray(sheetsNode.sheet);
  return rawSheets.map((raw) => {
    const sheet = parseRecord(raw);
    const name = requiredAttribute(sheet, "name");
    const relationshipId = requiredAttribute(sheet, "id");
    const relationship = relationships.get(relationshipId);
    if (!relationship || !WORKSHEET_RELATIONSHIP_TYPE.test(relationship.type)) {
      throw new Error(`Worksheet relationship is missing for "${name}".`);
    }
    return {
      name,
      path: resolvePackageTarget("xl/workbook.xml", relationship.target)
    };
  });
}

async function updateWorkbookCalculationProperties(zip: JSZip, changedParts: Set<string>): Promise<void> {
  const part = zip.file("xl/workbook.xml");
  if (!part) throw new Error("Workbook XML is missing.");
  changedParts.add("xl/workbook.xml");
  // Resolve the current workbook XML to a concrete string BEFORE writing it back. Passing the
  // pending `part.async(...)` promise straight into zip.file() makes JSZip lazily re-read the very
  // entry it is replacing at generate time, which mis-decodes multibyte bytes (WPS-authored sheet
  // names turn to garbage). Awaiting first fully decouples the read from the overwrite.
  const xml = await part.async("string");
  const updated = /<calcPr\b/u.test(xml)
    ? xml.replace(/<calcPr\b[^>]*\/?>/u, (tag) => {
        let next = setXmlAttribute(tag, "calcMode", "auto");
        next = setXmlAttribute(next, "fullCalcOnLoad", "1");
        return setXmlAttribute(next, "forceFullCalc", "1");
      })
    : xml.replace(/<\/workbook>/u, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
  zip.file("xl/workbook.xml", updated);
}

async function removeCalculationChain(zip: JSZip, changedParts: Set<string>): Promise<void> {
  if (zip.file("xl/calcChain.xml")) {
    zip.remove("xl/calcChain.xml");
    changedParts.add("xl/calcChain.xml");
  }
  const relationshipsPath = "xl/_rels/workbook.xml.rels";
  const relationships = await requiredZipText(zip, relationshipsPath);
  const cleanedRelationships = relationships.replace(
    /<Relationship\b(?=[^>]*\bType="[^"]*\/calcChain")[^>]*\/>/gu,
    ""
  );
  if (cleanedRelationships !== relationships) {
    zip.file(relationshipsPath, cleanedRelationships);
    changedParts.add(relationshipsPath);
  }
  const contentTypesPath = "[Content_Types].xml";
  const contentTypes = await requiredZipText(zip, contentTypesPath);
  const cleanedContentTypes = contentTypes.replace(
    /<Override\b(?=[^>]*\bPartName="\/xl\/calcChain\.xml")[^>]*\/>/gu,
    ""
  );
  if (cleanedContentTypes !== contentTypes) {
    zip.file(contentTypesPath, cleanedContentTypes);
    changedParts.add(contentTypesPath);
  }
}

async function digestZipParts(zip: JSZip): Promise<Map<string, PartDigest>> {
  const entries = Object.entries(zip.files)
    .filter(([, entry]) => !entry.dir)
    .sort(([left], [right]) => left.localeCompare(right));
  const result = new Map<string, PartDigest>();
  for (const [name, entry] of entries) {
    const bytes = await entry.async("nodebuffer");
    result.set(name, {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  return result;
}

function comparePartDigests(before: Map<string, PartDigest>, after: Map<string, PartDigest>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names]
    .filter((name) => !sameDigest(before.get(name), after.get(name)))
    .sort();
}

function sameDigest(left: PartDigest | undefined, right: PartDigest | undefined): boolean {
  return Boolean(left && right && left.bytes === right.bytes && left.sha256 === right.sha256);
}

function parseRelationships(xml: string): Map<string, { type: string; target: string }> {
  const parsed = parseRecord(parser.parse(xml));
  const root = parseRecord(parsed.Relationships);
  const result = new Map<string, { type: string; target: string }>();
  for (const raw of asArray(root.Relationship)) {
    const relationship = parseRecord(raw);
    result.set(requiredAttribute(relationship, "Id"), {
      type: requiredAttribute(relationship, "Type"),
      target: requiredAttribute(relationship, "Target")
    });
  }
  return result;
}

function resolvePackageTarget(sourcePart: string, target: string): string {
  if (target.startsWith("/")) return normalizePartPath(target.slice(1));
  const sourceDirectory = sourcePart.slice(0, Math.max(0, sourcePart.lastIndexOf("/")));
  const segments = `${sourceDirectory}/${target}`.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) throw new Error(`Invalid package target: ${target}.`);
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return normalizePartPath(resolved.join("/"));
}

function normalizePartPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/u, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error(`Invalid OOXML part path: ${value}.`);
  }
  return normalized;
}

function parseCellAddress(input: string): CellCoordinate {
  const address = input.trim().replace(/\$/gu, "").toUpperCase();
  const match = address.match(CELL_ADDRESS_PATTERN);
  if (!match) throw new Error(`Invalid Excel cell address: ${input}.`);
  const column = columnNameToNumber(match[1]!);
  const row = Number(match[2]);
  if (column < 1 || column > 16_384 || row < 1 || row > 1_048_576) {
    throw new Error(`Excel cell address is outside worksheet limits: ${input}.`);
  }
  return { address: `${match[1]}${row}`, column, row };
}

function parseRange(input: string): { start: CellCoordinate; end: CellCoordinate } {
  const [startInput, endInput, extra] = input.split(":");
  if (!startInput || !endInput || extra !== undefined) {
    throw new Error(`Invalid Excel range: ${input}.`);
  }
  const start = parseCellAddress(startInput);
  const end = parseCellAddress(endInput);
  if (start.row > end.row || start.column > end.column) {
    throw new Error(`Excel range is reversed: ${input}.`);
  }
  return { start, end };
}

function coordinateFromIndexes(row: number, column: number): CellCoordinate {
  if (row < 1 || row > 1_048_576 || column < 1 || column > 16_384) {
    throw new Error("Template patch exceeds Excel worksheet limits.");
  }
  return { row, column, address: `${columnNumberToName(column)}${row}` };
}

function columnNameToNumber(value: string): number {
  let result = 0;
  for (const character of value) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function columnNumberToName(value: number): string {
  let current = value;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function normalizeTemplateCellValue(value: unknown, field: string): TemplateCellValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} numeric values must be finite.`);
    return value;
  }
  if (isRecord(value) && typeof value.formula === "string") {
    const result = value.result;
    if (result !== undefined && result !== null
      && typeof result !== "string" && typeof result !== "number" && typeof result !== "boolean") {
      throw new Error(`${field} formula results must be strings, numbers, booleans, or null.`);
    }
    return { formula: value.formula, ...(result === undefined ? {} : { result }) };
  }
  throw new Error(`${field} values must be strings, numbers, booleans, null, or formula objects.`);
}

function isFormulaValue(value: TemplateCellValue): value is Extract<TemplateCellValue, { formula: string }> {
  return isRecord(value) && typeof value.formula === "string";
}

function containsFormula(cellXml: string): boolean {
  return /<(?:\w+:)?f(?:\s|>)/u.test(cellXml);
}

function setXmlAttribute(tag: string, name: string, value: string): string {
  const pattern = new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*(["'])[\\s\\S]*?\\1`, "u");
  if (pattern.test(tag)) return tag.replace(pattern, ` ${name}="${escapeXmlAttribute(value)}"`);
  return tag.replace(/\/?>$/u, (ending) => ` ${name}="${escapeXmlAttribute(value)}"${ending}`);
}

function removeXmlAttribute(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*(["'])[\\s\\S]*?\\1`, "gu"), "");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXml(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function requiredAttribute(record: Record<string, unknown>, name: string): string {
  const value = record[`@${name}`];
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`OOXML attribute ${name} is missing.`);
  }
  return String(value);
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("OOXML structure is invalid.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

async function requiredZipText(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (!file) throw new Error(`Required OOXML part is missing: ${name}.`);
  return file.async("string");
}
