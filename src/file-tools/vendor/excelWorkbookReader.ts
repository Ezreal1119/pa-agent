// Adapted from patrick-agent/src/tools/excelWorkbookReader.ts; only requested dependency closure.
import type { RuntimeTool } from "../bridge.js";
import { readWorksheetImages } from "./excelImageReader.js";
import { countSerializedWorksheetCells } from "./excelReadSerialization.js";
import { readOoxmlDrawingTexts } from "./excelOoxmlXml.js";
import { addExcelReadCacheWeight, createExcelReadCacheMetrics, ensureExcelImageReader, ensureExcelWorksheetSnapshotByName, getExcelReadCacheEntry, resolveExcelReadContext } from "./excelReadCache.js";
import { readString } from "../workspace.js";

const DEFAULT_TOOL_OUTPUT_LIMIT = 150_000;

const MARKITDOWN_READ_NOTE = "Structured cell, range, formula, note, and image semantics are unavailable in MarkItDown read mode. Use the returned markdown to answer the request.";

interface ReadScope {
  sheets: string[];
  includeHidden: boolean;
  analyzeImages: boolean;
}

export const readWorkbookTool: RuntimeTool = {
  name: "excel_read_workbook",
  definition: {
    type: "function",
    function: {
      name: "excel_read_workbook",
      description: "Internal workbook-scope implementation for excel_read. Reads every visible or hidden worksheet, non-empty master cell, formula, note, DrawingML text, and embedded image semantic. If the complete result cannot fit within the active Tool output limit, returns status=too_large without partial workbook content.",
      parameters: {
        type: "object",
        required: ["path"],
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Existing .xlsx path under an allowed workspace root."
          }
        }
      }
    }
  },
  async execute(input, context) {
    const requestedPath = readString(input, "path");
    const lookup = await getExcelReadCacheEntry(requestedPath);
    const cacheMetrics = createExcelReadCacheMetrics(lookup.cacheHit);
    const readContext = await resolveExcelReadContext(lookup.entry);

    if (readContext.engine === "markitdown") {
      const markdown = lookup.entry.markdown ?? "";
      return {
        ok: true,
        status: "complete",
        engine: "markitdown",
        mode: "markdown",
        fallbackFrom: "exceljs+ooxml",
        readEngineNote: MARKITDOWN_READ_NOTE,
        path: lookup.entry.resolved.displayPath,
        revision: lookup.entry.revision,
        cacheHit: lookup.cacheHit,
        cache: cacheMetrics,
        scope: {
          allWorksheets: true,
          worksheets: readContext.sheetNames,
          includeHidden: true,
          analyzeImages: false
        },
        summary: {
          worksheets: readContext.sheetNames.length,
          cells: 0,
          drawingTexts: 0,
          images: 0,
          imageSemantics: 0
        },
        markdown,
        retryHint: "MarkItDown mode returns the full workbook markdown. Use excel_read with scope=worksheet only after converting or repairing the workbook for structured reads."
      };
    }

    const scope: ReadScope = {
      sheets: readContext.sheetNames,
      includeHidden: true,
      analyzeImages: Boolean(context.visualEnabled)
    };

    const imageReader = await ensureExcelImageReader(lookup.entry);
    const zip = imageReader.zip;
    const drawingTexts = lookup.entry.drawingTexts
      ?? await readOoxmlDrawingTexts(zip, scope.sheets);
    if (!lookup.entry.drawingTexts) {
      lookup.entry.drawingTexts = drawingTexts;
      addExcelReadCacheWeight(
        lookup.entry,
        Buffer.byteLength(JSON.stringify(drawingTexts), "utf8")
      );
    }
    const worksheets = [];
    let cellCount = 0;
    let imageCount = 0;
    let semanticCount = 0;
    for (const sheetName of scope.sheets) {
      const snapshot = await ensureExcelWorksheetSnapshotByName(
        lookup.entry,
        sheetName,
        cacheMetrics
      );
      const sheetDrawingTexts = drawingTexts
        .filter((item) => item.sheet === sheetName)
        .map(({ part, text }) => ({ part, text }));
      const imageResult = await readWorksheetImages({
        reader: imageReader,
        sheetName,
        context,
        revision: lookup.entry.revision,
        analysisCache: lookup.entry.imageAnalysisCache,
        onAnalysisCacheStored(bytes) {
          addExcelReadCacheWeight(lookup.entry, bytes);
        }
      });
      cacheMetrics.imageAnalysesReused += imageResult.imageSummary.analysisCacheHits;
      cacheMetrics.imageAnalysesCreated += imageResult.imageSummary.analysisCacheMisses;
      cellCount += countSerializedWorksheetCells(snapshot.rows);
      imageCount += imageResult.imageSummary.discovered;
      semanticCount += imageResult.imageSummary.analyzed;
      worksheets.push({
        name: snapshot.name,
        state: snapshot.state,
        usedRange: snapshot.usedRange,
        actualRows: snapshot.actualRows,
        actualColumns: snapshot.actualColumns,
        merges: snapshot.merges,
        headerFooter: snapshot.headerFooter,
        rows: snapshot.rows,
        drawingTexts: sheetDrawingTexts,
        imageSummary: imageResult.imageSummary,
        imageBatches: imageResult.imageBatches
      });
    }
    const result: Record<string, unknown> = {
      ok: true,
      status: "complete",
      path: lookup.entry.resolved.displayPath,
      revision: lookup.entry.revision,
      cacheHit: lookup.cacheHit,
      cache: cacheMetrics,
      scope: {
        allWorksheets: true,
        worksheets: scope.sheets,
        includeHidden: true,
        analyzeImages: Boolean(context.visualEnabled)
      },
      summary: {
        worksheets: worksheets.length,
        cells: cellCount,
        drawingTexts: drawingTexts.length,
        images: imageCount,
        imageSemantics: semanticCount
      },
      worksheets
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
        error: "The complete workbook result exceeds the active Tool output limit. No partial workbook content was returned.",
        path: lookup.entry.resolved.displayPath,
        revision: lookup.entry.revision,
        cacheHit: lookup.cacheHit,
        cache: cacheMetrics,
        outputCharacters,
        maximumCharacters,
        worksheetList: worksheets.map((worksheet) => ({
          name: worksheet.name,
          state: worksheet.state,
          rows: worksheet.actualRows,
          columns: worksheet.actualColumns
        })),
        suggestedTool: "excel_read",
        suggestedScope: "worksheet",
        retryHint: "Call excel_read with scope=worksheet once for each relevant sheet. Omit range to read a sheet's used range, or provide an A1 range for a smaller selection."
      };
    }
    return {
      ...result,
      outputCharacters
    };
  }
};
