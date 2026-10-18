// Adapted from patrick-agent/src/tools/excelTemplateTools.ts; only requested dependency closure.
import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeTool } from "../bridge.js";
import { patchWorkbookTemplateOoxml, type TemplatePatchOperation } from "./excelTemplateOoxml.js";
import { invalidateExcelReadCache } from "./excelReadCache.js";
import { isRecord, readString, resolveWorkspaceDestinationPath, resolveReadablePath, safePathParameterDescription, workerScope } from "../workspace.js";


const MAX_TEMPLATE_OPERATIONS = 100;

export const patchWorkbookTemplateTool: RuntimeTool = {
  name: "excel_patch_template",
  definition: {
    type: "function",
    function: {
      name: "excel_patch_template",
      description: "Copy an existing .xlsx workbook to a new path and surgically set or clear cells while preserving its layout, Cell styles, merges, drawings, images, shapes, print settings, and external links. Use this Tool for translation, localization, terminology replacement, redaction, and other format-preserving Cell-content changes.",
      parameters: {
        type: "object",
        required: ["sourcePath", "outputPath", "operations"],
        additionalProperties: false,
        properties: {
          sourcePath: {
            type: "string",
            description: "Existing .xlsx template path under an allowed workspace root."
          },
          outputPath: {
            type: "string",
            description: safePathParameterDescription("New .xlsx output path under an allowed workspace root. Existing files are never overwritten.")
          },
          operations: {
            type: "array",
            minItems: 1,
            maxItems: MAX_TEMPLATE_OPERATIONS,
            description: "Bounded operations: setCell, setRange, clearCell, or clearRange. Use 'range' to say where each operation applies: a single cell like \"E22\" for setCell/clearCell, and for setRange/clearRange either a single top-left cell like \"E22\" or a full rectangle like \"E22:F48\". For setRange, 'values' determines what is written and how far the block extends; if you also give a rectangle it must match the values shape. Existing formulas require allowReplaceFormula=true before they can be replaced.",
            items: {
              type: "object",
              required: ["type", "sheet"],
              additionalProperties: false,
              properties: {
                type: {
                  type: "string",
                  enum: ["setCell", "setRange", "clearCell", "clearRange"]
                },
                sheet: { type: "string" },
                range: {
                  type: "string",
                  description: "Where the operation applies. Single cell (\"E22\") for setCell/clearCell; single top-left cell or full rectangle (\"E22\" or \"E22:F48\") for setRange/clearRange. setRange extent is driven by values."
                },
                cell: { type: "string", description: "Deprecated alias for range (single cell). Prefer range." },
                startCell: { type: "string", description: "Deprecated alias for range (setRange top-left cell). Prefer range." },
                value: {},
                values: { type: "array", items: { type: "array", items: {} } },
                allowReplaceFormula: {
                  type: "boolean",
                  description: "Explicitly permit replacing or clearing formula cells. Defaults to false."
                }
              }
            }
          }
        }
      }
    }
  },
  async execute(input) {
    const source = await requireWorkbookSource(readString(input, "sourcePath"));
    const destination = await requireNewWorkbookDestination(readString(input, "outputPath"));
    const operations = readOperations(input);
    const result = await patchWorkbookTemplateOoxml(await fs.readFile(source.absolutePath), operations);
    if (result.buffer.byteLength > workerScope().config.maxFileBytes) {
      throw new Error("Generated Excel file exceeds the configured file size limit.");
    }
    await fs.writeFile(destination.absolutePath, result.buffer, { flag: "wx" });
    invalidateExcelReadCache(destination.absolutePath);
    return {
      ok: true,
      sourcePath: source.displayPath,
      outputPath: destination.displayPath,
      operationsApplied: result.operationsApplied,
      cellsChanged: result.cellsChanged,
      changedCells: result.changedCells,
      changedParts: result.changedParts,
      unchangedPartsVerified: result.unchangedPartsVerified,
      formulasRecalculateWhenOpened: result.formulasRecalculateWhenOpened,
      sourcePreserved: true
    };
  }
};

async function requireWorkbookSource(requestedPath: string) {
  const resolved = await resolveReadablePath(requestedPath, { mustExist: true });
  assertXlsxPath(resolved.absolutePath);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) throw new Error("Excel template path must be a file.");
  if (stat.size > workerScope().config.maxFileBytes) throw new Error("Excel template exceeds the configured file size limit.");
  return resolved;
}

async function requireNewWorkbookDestination(requestedPath: string) {
  const destination = await resolveWorkspaceDestinationPath(requestedPath);
  assertXlsxPath(destination.absolutePath);
  const existing = await fs.lstat(destination.absolutePath).catch(() => undefined);
  if (existing) throw new Error("Destination already exists; overwriting is not allowed.");
  const parent = await fs.stat(path.dirname(destination.absolutePath)).catch(() => undefined);
  if (!parent?.isDirectory()) throw new Error("Destination parent directory does not exist.");
  return destination;
}

function readOperations(input: unknown): TemplatePatchOperation[] {
  if (!isRecord(input) || !Array.isArray(input.operations)) {
    throw new Error("operations must be an array.");
  }
  if (input.operations.length === 0 || input.operations.length > MAX_TEMPLATE_OPERATIONS) {
    throw new Error(`operations must contain 1-${MAX_TEMPLATE_OPERATIONS} entries.`);
  }
  return input.operations.map((value, index) => {
    if (!isRecord(value)) throw new Error(`operations[${index}] must be an object.`);
    const type = value.type;
    const sheet = value.sheet;
    if (type !== "setCell" && type !== "setRange" && type !== "clearCell" && type !== "clearRange") {
      throw new Error(`operations[${index}].type is unsupported.`);
    }
    if (typeof sheet !== "string" || !sheet.trim()) {
      throw new Error(`operations[${index}].sheet is required.`);
    }
    return {
      type,
      sheet,
      ...(typeof value.cell === "string" ? { cell: value.cell } : {}),
      ...(typeof value.startCell === "string" ? { startCell: value.startCell } : {}),
      ...(typeof value.range === "string" ? { range: value.range } : {}),
      ...("value" in value ? { value: value.value as TemplatePatchOperation["value"] } : {}),
      ...(Array.isArray(value.values) ? { values: value.values as TemplatePatchOperation["values"] } : {}),
      ...(value.allowReplaceFormula === true ? { allowReplaceFormula: true } : {})
    };
  });
}

function assertXlsxPath(filePath: string): void {
  if (path.extname(filePath).toLowerCase() !== ".xlsx") {
    throw new Error("Excel template tools currently support .xlsx files only.");
  }
}
