// Adapted from patrick-agent/src/tools/excelReadSerialization.ts; only requested dependency closure.
import ExcelJS from "exceljs";

export type ExcelReadJsonValue =
  | null
  | boolean
  | number
  | string
  | ExcelReadJsonValue[]
  | { [key: string]: ExcelReadJsonValue };

export interface ExcelReadBounds {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

const MAX_EXCEL_ROW = 1_048_576;

const MAX_EXCEL_COLUMN = 16_384;

const CELL_RANGE_PATTERN = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/u;

const COLUMN_RANGE_PATTERN = /^([A-Z]{1,3}):([A-Z]{1,3})$/u;

const ROW_RANGE_PATTERN = /^([1-9]\d*):([1-9]\d*)$/u;

const CELL_PATTERN = /^([A-Z]{1,3})([1-9]\d*)$/u;

export function parseExcelRange(input: string): ExcelReadBounds {
  const normalized = input.trim().replace(/\$/gu, "").toUpperCase();
  const cellRangeMatch = CELL_RANGE_PATTERN.exec(normalized);
  if (cellRangeMatch) {
    return assertExcelBounds({
      startRow: Number(cellRangeMatch[2]),
      endRow: Number(cellRangeMatch[4]),
      startColumn: columnLettersToNumber(cellRangeMatch[1]!),
      endColumn: columnLettersToNumber(cellRangeMatch[3]!)
    });
  }
  const columnRangeMatch = COLUMN_RANGE_PATTERN.exec(normalized);
  if (columnRangeMatch) {
    return assertExcelBounds({
      startRow: 1,
      endRow: MAX_EXCEL_ROW,
      startColumn: columnLettersToNumber(columnRangeMatch[1]!),
      endColumn: columnLettersToNumber(columnRangeMatch[2]!)
    });
  }
  const rowRangeMatch = ROW_RANGE_PATTERN.exec(normalized);
  if (rowRangeMatch) {
    return assertExcelBounds({
      startRow: Number(rowRangeMatch[1]),
      endRow: Number(rowRangeMatch[2]),
      startColumn: 1,
      endColumn: MAX_EXCEL_COLUMN
    });
  }
  const cellMatch = CELL_PATTERN.exec(normalized);
  if (cellMatch) {
    const row = Number(cellMatch[2]);
    const column = columnLettersToNumber(cellMatch[1]!);
    return { startRow: row, endRow: row, startColumn: column, endColumn: column };
  }
  throw new Error("Excel range must use A1 notation, for example A1:F50, A:A, or 1:1.");
}

export function columnLettersToNumber(letters: string): number {
  return letters.toUpperCase().split("").reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

function assertExcelBounds(bounds: ExcelReadBounds): ExcelReadBounds {
  if (bounds.startRow > bounds.endRow || bounds.startColumn > bounds.endColumn
    || bounds.endRow > MAX_EXCEL_ROW || bounds.endColumn > MAX_EXCEL_COLUMN) {
    throw new Error("Excel range is reversed or outside worksheet limits.");
  }
  return bounds;
}

export interface SerializedWorksheetRow {
  row: number;
  cells: Array<{
    address: string;
    value: ExcelReadJsonValue;
    note?: ExcelReadJsonValue;
  }>;
}

export function worksheetContentBounds(worksheet: ExcelJS.Worksheet): ExcelReadBounds {
  let startRow = Number.POSITIVE_INFINITY;
  let endRow = 0;
  let startColumn = Number.POSITIVE_INFINITY;
  let endColumn = 0;

  for (const row of storedWorksheetRows(worksheet)) {
    row.eachCell({ includeEmpty: true }, (cell) => {
      if (!isReadableContentCell(cell)) return;
      const cellRow = Number(cell.row);
      const cellColumn = Number(cell.col);
      startRow = Math.min(startRow, cellRow);
      endRow = Math.max(endRow, cellRow);
      startColumn = Math.min(startColumn, cellColumn);
      endColumn = Math.max(endColumn, cellColumn);
    });
  }

  return endRow === 0
    ? { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }
    : { startRow, endRow, startColumn, endColumn };
}

export function serializeWorksheetRows(
  worksheet: ExcelJS.Worksheet,
  bounds: ExcelReadBounds
): SerializedWorksheetRow[] {
  const rows: SerializedWorksheetRow[] = [];
  for (const row of storedWorksheetRows(worksheet)) {
    if (row.number < bounds.startRow || row.number > bounds.endRow) continue;
    const cells: SerializedWorksheetRow["cells"] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const cellColumn = Number(cell.col);
      if (cellColumn < bounds.startColumn || cellColumn > bounds.endColumn) return;
      if (!isReadableContentCell(cell)) return;
      cells.push({
        address: cell.address,
        value: serializeExcelCellValue(cell.value),
        ...(cell.note === undefined ? {} : { note: normalizeExcelReadValue(cell.note) })
      });
    });
    if (cells.length > 0) rows.push({ row: row.number, cells });
  }
  return rows;
}

export function countSerializedWorksheetCells(rows: readonly SerializedWorksheetRow[]): number {
  return rows.reduce((total, row) => total + row.cells.length, 0);
}

export function serializeExcelCellValue(value: ExcelJS.CellValue): ExcelReadJsonValue {
  if (value === null || value === undefined || typeof value === "string"
    || typeof value === "number" || typeof value === "boolean") {
    return value ?? null;
  }
  if (value instanceof Date) return value.toISOString();
  if ("formula" in value || "sharedFormula" in value) {
    const formula = "sharedFormula" in value
      ? value.formula ?? value.sharedFormula
      : value.formula;
    return {
      formula,
      result: serializeExcelCellValue(value.result)
    };
  }
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("hyperlink" in value) return { text: value.text, hyperlink: value.hyperlink };
  if ("error" in value) return { error: value.error };
  return String(value);
}

function isReadableContentCell(cell: ExcelJS.Cell): boolean {
  if (cell.isMerged && cell.master.address !== cell.address) return false;
  return cell.value !== null || cell.note !== undefined;
}

function storedWorksheetRows(worksheet: ExcelJS.Worksheet): ExcelJS.Row[] {
  const modelRows = (
    worksheet.model as unknown as { rows?: Array<{ number: number }> }
  ).rows ?? [];
  return modelRows.map((row) => worksheet.getRow(row.number));
}

function normalizeExcelReadValue(value: unknown): ExcelReadJsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeExcelReadValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, normalizeExcelReadValue(item)])
    );
  }
  return String(value);
}
