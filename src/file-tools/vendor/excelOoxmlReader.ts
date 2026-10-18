// Adapted from patrick-agent/src/tools/excelOoxmlReader.ts; only requested dependency closure.
import JSZip from "jszip";
import type { ExcelReadBounds, ExcelReadJsonValue, SerializedWorksheetRow } from "./excelReadSerialization.js";
import type { ExcelWorksheetSnapshot } from "./excelReadCache.js";
import { asOoxmlArray, findOoxmlNode, loadOoxmlSheetParts, parseOoxmlXml, readZipText, type OoxmlSheetPart } from "./excelOoxmlXml.js";
import { isRecord } from "../workspace.js";

const MAX_SHEETS = 50;

export class OoxmlWorkbookReader {
  private readonly sheetParts: OoxmlSheetPart[];
  private readonly sharedStrings: string[];

  private constructor(
    readonly zip: JSZip,
    sheetParts: OoxmlSheetPart[],
    sharedStrings: string[]
  ) {
    this.sheetParts = sheetParts;
    this.sharedStrings = sharedStrings;
  }

  static async open(bytes: Buffer): Promise<OoxmlWorkbookReader> {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const sheetParts = await loadOoxmlSheetParts(zip);
    if (sheetParts.length === 0) {
      throw new Error("OOXML workbook does not contain any worksheets.");
    }
    if (sheetParts.length > MAX_SHEETS) {
      throw new Error(`Workbook exceeds the ${MAX_SHEETS} worksheet limit.`);
    }
    const sharedStrings = await loadSharedStrings(zip);
    return new OoxmlWorkbookReader(zip, sheetParts, sharedStrings);
  }

  getSheetNames(): string[] {
    return this.sheetParts.map((sheet) => sheet.name);
  }

  findSheet(name: string): OoxmlSheetPart | undefined {
    return this.sheetParts.find((sheet) => sheet.name === name);
  }

  async buildSnapshot(sheetName: string): Promise<ExcelWorksheetSnapshot> {
    const sheet = this.findSheet(sheetName);
    if (!sheet) {
      throw new Error(`Worksheet not found: ${sheetName}.`);
    }
    const xml = await readZipText(this.zip, sheet.part);
    if (!xml) throw new Error(`Worksheet part is missing: ${sheet.part}.`);
    const parsed = parseOoxmlXml(xml);
    const merges = parseMergeCells(parsed);
    const nonMasterCells = buildNonMasterCellSet(merges);
    const rows = parseSheetRows(parsed, this.sharedStrings, nonMasterCells);
    const bounds = boundsFromRows(rows);
    const usedRange = boundsToRange(bounds);
    const actualRows = rows.length > 0 ? rows[rows.length - 1]!.row : 0;
    const actualColumns = rows.reduce(
      (maximum, row) => Math.max(maximum, row.cells.length),
      0
    );
    return {
      name: sheet.name,
      state: sheet.state,
      bounds,
      usedRange,
      actualRows,
      actualColumns,
      merges,
      headerFooter: {},
      rows
    };
  }
}

async function loadSharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await readZipText(zip, "xl/sharedStrings.xml");
  if (!xml) return [];
  const parsed = parseOoxmlXml(xml);
  const node = findOoxmlNode(parsed, "sst");
  return asOoxmlArray(node?.si).map((item) => sharedStringValue(item));
}

function sharedStringValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!isRecord(value)) return "";
  if ("t" in value) return String(value.t ?? "");
  const richText = asOoxmlArray(value.r)
    .map((part) => (isRecord(part) ? String(part.t ?? "") : String(part)))
    .join("");
  return richText;
}

function parseMergeCells(parsed: Record<string, unknown>): string[] {
  const mergeCellsNode = findOoxmlNode(parsed, "mergeCells");
  return asOoxmlArray(mergeCellsNode?.mergeCell).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const ref = String(raw["@ref"] ?? "").trim();
    return ref ? [ref] : [];
  });
}

function buildNonMasterCellSet(merges: readonly string[]): Set<string> {
  const nonMasters = new Set<string>();
  for (const merge of merges) {
    const bounds = parseA1Range(merge);
    if (!bounds) continue;
    for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
      for (let column = bounds.startColumn; column <= bounds.endColumn; column += 1) {
        const address = `${columnLetters(column)}${row}`;
        if (row === bounds.startRow && column === bounds.startColumn) continue;
        nonMasters.add(address);
      }
    }
  }
  return nonMasters;
}

function parseSheetRows(
  parsed: Record<string, unknown>,
  sharedStrings: readonly string[],
  nonMasterCells: ReadonlySet<string>
): SerializedWorksheetRow[] {
  const sheetData = findOoxmlNode(parsed, "sheetData");
  const output: SerializedWorksheetRow[] = [];
  for (const rawRow of asOoxmlArray(sheetData?.row)) {
    if (!isRecord(rawRow)) continue;
    const rowNumber = Number(rawRow["@r"] ?? 0);
    if (!Number.isFinite(rowNumber) || rowNumber <= 0) continue;
    const cells: SerializedWorksheetRow["cells"] = [];
    for (const rawCell of asOoxmlArray(rawRow.c)) {
      if (!isRecord(rawCell)) continue;
      const address = String(rawCell["@r"] ?? "");
      if (!address || nonMasterCells.has(address)) continue;
      const value = parseCellValue(rawCell, sharedStrings);
      if (value === null && rawCell.f === undefined) continue;
      cells.push({ address, value });
    }
    if (cells.length > 0) output.push({ row: rowNumber, cells });
  }
  return output;
}

function parseCellValue(
  cell: Record<string, unknown>,
  sharedStrings: readonly string[]
): ExcelReadJsonValue {
  const type = String(cell["@t"] ?? "");
  if (cell.f !== undefined) {
    const formula = String(cell.f ?? "");
    const result = parseCellScalarValue(cell, sharedStrings, type, true);
    return { formula, result };
  }
  return parseCellScalarValue(cell, sharedStrings, type, false);
}

function parseCellScalarValue(
  cell: Record<string, unknown>,
  sharedStrings: readonly string[],
  type: string,
  isFormulaResult: boolean
): ExcelReadJsonValue {
  if (type === "inlineStr") {
    const inline = cell.is;
    if (isRecord(inline)) return sharedStringValue(inline);
    return String(cell.v ?? "");
  }
  if (type === "s") {
    const index = Number(cell.v ?? -1);
    return Number.isInteger(index) && index >= 0 && index < sharedStrings.length
      ? sharedStrings[index]!
      : null;
  }
  if (type === "b") return String(cell.v ?? "") === "1";
  if (type === "str" || (isFormulaResult && type === "")) return String(cell.v ?? "");
  const numeric = Number(cell.v);
  if (cell.v !== undefined && Number.isFinite(numeric)) return numeric;
  if (cell.v === undefined || cell.v === null) return null;
  return String(cell.v);
}

function boundsFromRows(rows: readonly SerializedWorksheetRow[]): ExcelReadBounds {
  let startRow = Number.POSITIVE_INFINITY;
  let endRow = 0;
  let startColumn = Number.POSITIVE_INFINITY;
  let endColumn = 0;
  for (const row of rows) {
    startRow = Math.min(startRow, row.row);
    endRow = Math.max(endRow, row.row);
    for (const cell of row.cells) {
      const coordinates = cellCoordinates(cell.address);
      startColumn = Math.min(startColumn, coordinates.column);
      endColumn = Math.max(endColumn, coordinates.column);
    }
  }
  return endRow === 0
    ? { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }
    : { startRow, endRow, startColumn, endColumn };
}

function parseA1Range(range: string): ExcelReadBounds | undefined {
  const match = /^([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)$/u.exec(range.trim());
  if (!match) return undefined;
  return {
    startColumn: columnNumber(match[1]!),
    startRow: Number(match[2]),
    endColumn: columnNumber(match[3]!),
    endRow: Number(match[4])
  };
}

function cellCoordinates(address: string): { row: number; column: number } {
  const match = /^([A-Z]+)([1-9][0-9]*)$/u.exec(address);
  if (!match) throw new Error(`Invalid Excel cell address: ${address}.`);
  return { row: Number(match[2]), column: columnNumber(match[1]!) };
}

function columnNumber(letters: string): number {
  let column = 0;
  for (const character of letters) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return column;
}

function columnLetters(columnNumber: number): string {
  let value = columnNumber;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output || "A";
}

function boundsToRange(bounds: ExcelReadBounds): string {
  return `${columnLetters(bounds.startColumn)}${bounds.startRow}:${columnLetters(bounds.endColumn)}${bounds.endRow}`;
}
