// Adapted from patrick-agent/src/tools/excelWorksheetNames.ts; only requested dependency closure.
import type ExcelJS from "exceljs";

export interface WorksheetLookupResult {
  worksheet?: ExcelJS.Worksheet;
  ambiguousSheets: string[];
}

export function findWorksheetByName(workbook: ExcelJS.Workbook, requestedName: string): WorksheetLookupResult {
  const exact = workbook.worksheets.find((worksheet) => worksheet.name === requestedName);
  if (exact) return { worksheet: exact, ambiguousSheets: [] };

  const caseInsensitive = workbook.worksheets.filter(
    (worksheet) => worksheet.name.toLocaleLowerCase("en-US") === requestedName.toLocaleLowerCase("en-US")
  );
  if (caseInsensitive.length === 1) return { worksheet: caseInsensitive[0], ambiguousSheets: [] };

  const normalizedName = normalizeWorksheetLookupName(requestedName);
  const normalizedMatches = workbook.worksheets.filter(
    (worksheet) => normalizeWorksheetLookupName(worksheet.name) === normalizedName
  );
  return normalizedMatches.length === 1
    ? { worksheet: normalizedMatches[0], ambiguousSheets: [] }
    : { ambiguousSheets: normalizedMatches.map((worksheet) => worksheet.name) };
}

export function normalizeWorksheetLookupName(input: string): string {
  let value = input.normalize("NFKC").trim();
  value = unwrapQuotedString(value).normalize("NFKC").trim();
  return value.toLocaleLowerCase("en-US");
}

function unwrapQuotedString(input: string): string {
  if (input.length < 2) return input;
  if (input.startsWith('"') && input.endsWith('"')) {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      return input.slice(1, -1);
    }
  }
  if (input.startsWith("'") && input.endsWith("'")) return input.slice(1, -1);
  return input;
}
