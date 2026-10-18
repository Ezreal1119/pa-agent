// Adapted from patrick-agent/src/tools/excelTools.ts; only requested dependency closure.
import path from "node:path";
import ExcelJS from "exceljs";
import { RuntimeTool } from "../bridge.js";
import { ToolExecutionError } from "./toolErrors.js";
import { findWorksheetByName } from "./excelWorksheetNames.js";
import { readWorksheetImages } from "./excelImageReader.js";
import { parseExcelRange } from "./excelReadSerialization.js";
import { addExcelReadCacheWeight, createExcelReadCacheMetrics, ensureExcelImageReader, ensureExcelWorksheetSnapshotByName, filterWorksheetSnapshotRows, getExcelReadCacheEntry, requireExcelWorksheetName, resolveExcelReadContext } from "./excelReadCache.js";
import { readOptionalString, readString } from "../workspace.js";

const MAX_READ_ROWS = 200;

const MAX_READ_COLUMNS = 50;

const DEFAULT_TOOL_OUTPUT_LIMIT = 150_000;

interface CellBounds {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export const readWorksheetTool: RuntimeTool = {
  name: "excel_read_sheet",
  definition: {
    type: "function",
    function: {
      name: "excel_read_sheet",
      description: "Read one required worksheet from an allowed .xlsx workbook, including formulas, cached results, notes, merged-cell-safe content, and vision-model analysis of embedded images. Omit range to read all worksheet images, or provide an A1 range to include only images intersecting the returned range.",
      parameters: objectSchema(["path", "sheet"], {
        path: { type: "string", description: "Existing .xlsx path under an allowed workspace root." },
        sheet: { type: "string", description: "Exact worksheet name." },
        range: { type: "string", description: "Optional Excel range such as A1, A1:F50, A:A, A:C, or 1:1. Defaults to the actual content range, capped at 200 rows by 50 columns." }
      })
    }
  },
  async execute(input, context) {
    const lookup = await getExcelReadCacheEntry(readString(input, "path"));
    const cacheMetrics = createExcelReadCacheMetrics(lookup.cacheHit);
    const readContext = await resolveExcelReadContext(lookup.entry);
    const requestedSheet = readString(input, "sheet");

    if (readContext.engine === "markitdown") {
      const markdown = lookup.entry.markdown ?? "";
      return {
        ok: true,
        status: "complete",
        engine: "markitdown",
        mode: "markdown",
        fallbackFrom: "exceljs+ooxml",
        readEngineNote: "Structured cell, range, formula, note, and image semantics are unavailable in MarkItDown read mode. Use the returned markdown to answer the request.",
        path: lookup.entry.resolved.displayPath,
        revision: lookup.entry.revision,
        cacheHit: lookup.cacheHit,
        cache: cacheMetrics,
        requestedSheet,
        markdown,
        retryHint: "MarkItDown mode returns the full workbook markdown. Range filtering is not available."
      };
    }

    const worksheet = readContext.engine === "exceljs" && readContext.workbook
      ? requireWorksheet(readContext.workbook, requestedSheet)
      : undefined;
    const sheetName = worksheet?.name
      ?? requireExcelWorksheetName(readContext.sheetNames, requestedSheet);
    const snapshot = await ensureExcelWorksheetSnapshotByName(
      lookup.entry,
      sheetName,
      cacheMetrics
    );
    const requestedRange = readOptionalString(input, "range")?.trim();
    const sourceBounds = requestedRange
      ? parseRange(requestedRange)
      : snapshot.bounds;
    const returnedBounds = clampBounds(sourceBounds, MAX_READ_ROWS, MAX_READ_COLUMNS);
    const imageResult = await readWorksheetImages({
      reader: await ensureExcelImageReader(lookup.entry),
      sheetName,
      ...(worksheet ? { worksheet } : {}),
      ...(requestedRange ? { bounds: returnedBounds } : {}),
      context,
      revision: lookup.entry.revision,
      analysisCache: lookup.entry.imageAnalysisCache,
      onAnalysisCacheStored(bytes) {
        addExcelReadCacheWeight(lookup.entry, bytes);
      }
    });
    cacheMetrics.imageAnalysesReused += imageResult.imageSummary.analysisCacheHits;
    cacheMetrics.imageAnalysesCreated += imageResult.imageSummary.analysisCacheMisses;
    const result: Record<string, unknown> = {
      ok: true,
      status: "complete",
      path: lookup.entry.resolved.displayPath,
      revision: lookup.entry.revision,
      cacheHit: lookup.cacheHit,
      cache: cacheMetrics,
      sheet: sheetName,
      requestedRange: requestedRange || boundsToRange(sourceBounds),
      returnedRange: boundsToRange(returnedBounds),
      truncated: !sameBounds(sourceBounds, returnedBounds),
      merges: snapshot.merges,
      rows: filterWorksheetSnapshotRows(snapshot, returnedBounds),
      imageSummary: imageResult.imageSummary,
      imageBatches: imageResult.imageBatches
    };
    const maximumCharacters = Math.max(
      1_000,
      context.toolOutputMaxChars ?? DEFAULT_TOOL_OUTPUT_LIMIT
    );
    let outputCharacters = JSON.stringify({ ...result, outputCharacters: 0 }).length;
    outputCharacters = JSON.stringify({ ...result, outputCharacters }).length;
    if (outputCharacters > maximumCharacters) {
      return {
        ok: false,
        status: "too_large",
        error: "The complete worksheet result exceeds the active Tool output limit. No partial worksheet content was returned.",
        path: lookup.entry.resolved.displayPath,
        revision: lookup.entry.revision,
        cacheHit: lookup.cacheHit,
        cache: cacheMetrics,
        sheet: sheetName,
        requestedRange: requestedRange || boundsToRange(sourceBounds),
        returnedRange: boundsToRange(returnedBounds),
        outputCharacters,
        maximumCharacters,
        imageSummary: imageResult.imageSummary,
        retryHint: "Retry excel_read with scope=worksheet, the same sheet, and a smaller A1 range."
      };
    }
    return { ...result, outputCharacters };
  }
};

function parseRange(input: string): CellBounds {
  return parseExcelRange(input);
}

function clampBounds(bounds: CellBounds, maxRows: number, maxColumns: number): CellBounds {
  return {
    ...bounds,
    endRow: Math.min(bounds.endRow, bounds.startRow + maxRows - 1),
    endColumn: Math.min(bounds.endColumn, bounds.startColumn + maxColumns - 1)
  };
}

function requireWorksheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const lookup = findWorksheetByName(workbook, name);
  if (!lookup.worksheet) {
    const availableSheets = workbook.worksheets.map((item) => item.name);
    throw new ToolExecutionError(`Worksheet not found: ${name || "missing name"}`, {
      availableSheets,
      ambiguousSheets: lookup.ambiguousSheets,
      retryHint: availableSheets.length > 0
        ? "Retry with one exact worksheet name from availableSheets."
        : "The workbook has no worksheets to read."
    });
  }
  return lookup.worksheet;
}

function objectSchema(required: string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", required, properties, additionalProperties: false };
}

function boundsToRange(bounds: CellBounds): string {
  return `${formatCellAddress(bounds.startRow, bounds.startColumn)}:${formatCellAddress(bounds.endRow, bounds.endColumn)}`;
}

function sameBounds(left: CellBounds, right: CellBounds): boolean {
  return left.startRow === right.startRow && left.endRow === right.endRow && left.startColumn === right.startColumn && left.endColumn === right.endColumn;
}

function formatCellAddress(row: number, column: number): string {
  return `${numberToColumnLetters(column)}${row}`;
}

function numberToColumnLetters(input: number): string {
  let value = input;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}
