// Adapted from patrick-agent/src/tools/excelReadTools.ts; only requested dependency closure.
import type { RuntimeTool } from "../bridge.js";
import { readWorksheetTool } from "./excelTools.js";
import { readWorkbookTool } from "./excelWorkbookReader.js";
import { isRecord, readString } from "../workspace.js";

type ExcelReadScope = "workbook" | "worksheet";

export const excelReadTool: RuntimeTool = {
  name: "excel_read",
  definition: {
    type: "function",
    function: {
      name: "excel_read",
      description: "Read an allowed .xlsx workbook directly. Use scope=workbook to read every visible and hidden worksheet, or scope=worksheet with sheet and an optional A1 range to read one worksheet. Both scopes include formulas, notes, merged-cell-safe content, and vision-model analysis of embedded images. Complete results that exceed the Tool output limit return status=too_large instead of partial content.",
      parameters: {
        type: "object",
        required: ["path", "scope"],
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Existing .xlsx path under an allowed workspace root."
          },
          scope: {
            type: "string",
            enum: ["workbook", "worksheet"],
            description: "workbook reads every worksheet; worksheet reads one required sheet."
          },
          sheet: {
            type: "string",
            description: "Exact worksheet name. Required only when scope=worksheet."
          },
          range: {
            type: "string",
            description: "Optional Excel range such as A1, A1:F50, A:A, A:C, or 1:1. Allowed only when scope=worksheet; defaults to the actual content range."
          }
        }
      }
    }
  },
  async execute(input, context, details) {
    if (!isRecord(input)) throw new Error("excel_read input must be an object.");
    context.visualEnabled = input.visualAnalysis === true;
    const path = readString(input, "path");
    const scope = resolveReadScope(input);
    if (scope === "workbook") {
      if ("sheet" in input || "range" in input) {
        throw new Error("excel_read scope=workbook does not accept sheet or range. Use scope=worksheet for a targeted read.");
      }
      return readWorkbookTool.execute({ path }, context, details);
    }

    const sheet = readString(input, "sheet");
    const range = typeof input.range === "string" && input.range.trim()
      ? input.range.trim()
      : undefined;
    return readWorksheetTool.execute({ path, sheet, ...(range ? { range } : {}) }, context, details);
  }
};

function resolveReadScope(input: Record<string, unknown>): ExcelReadScope {
  if (input.scope === "workbook" || input.scope === "worksheet") return input.scope;
  if (input.scope !== undefined) {
    throw new Error("excel_read.scope must be workbook or worksheet.");
  }
  // Persisted calls created before excel_read was introduced do not contain
  // scope. Their old shapes are unambiguous and remain resumable.
  return typeof input.sheet === "string" && input.sheet.trim() ? "worksheet" : "workbook";
}
