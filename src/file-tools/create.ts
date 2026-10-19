import fs from "node:fs/promises";
import type { WorkerScope } from "./workspace.js";

type Value = string | number | boolean | null;
interface Sheet { name: string; headers: string[]; rows: Value[][]; widths?: number[]; formats?: string[]; freezeHeader?: boolean; autoFilter?: boolean; }
const formats: Record<string, string> = { general: "General", text: "@", integer: "0", decimal: "0.00", percent: "0.00%" };
const validText = (text: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text) && Buffer.from(text, "utf8").toString("utf8") === text;

/** Only structured values reach ExcelJS. No model code, formulas, external links or paths. */
export async function createOutput(name: "excel_create" | "text_file_create", input: Record<string, unknown>, scope: WorkerScope) {
  if (name === "text_file_create") {
    const content = input.content;
    if (typeof content !== "string" || content.includes("\0") || Buffer.from(content, "utf8").toString("utf8") !== content) throw new Error("Provide valid UTF-8 text without NUL bytes.");
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > Math.min(1024 * 1024, scope.config.maxFileBytes)) throw new Error("Text output exceeds the 1 MiB or configured file limit.");
    await fs.writeFile(scope.output, bytes, { flag: "wx", mode: 0o600 });
    if (!(await fs.readFile(scope.output)).equals(bytes)) throw new Error("Text output verification failed.");
    return { ok: true, verified: true, encoding: "UTF-8", bytes: bytes.length };
  }
  const [{ default: ExcelJS }, { preflightPackage }] = await Promise.all([import("exceljs"), import("./preflight.js")]);
  const sheets = input.sheets as Sheet[];
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > scope.config.maxSheets) throw new Error("Workbook exceeds the sheet limit.");
  const names = new Set<string>(); let cells = 0;
  for (const sheet of sheets) {
    if (!sheet.name.trim() || sheet.name.length > 31 || /[\[\]*?:/\\]/.test(sheet.name) || sheet.name.startsWith("'") || sheet.name.endsWith("'") || !validText(sheet.name) || names.has(sheet.name.toLowerCase())) throw new Error("Worksheet names must be valid, non-empty and unique.");
    names.add(sheet.name.toLowerCase());
    if (!sheet.headers.length || sheet.rows.some(row => row.length !== sheet.headers.length) || sheet.widths && sheet.widths.length !== sheet.headers.length || sheet.formats && (sheet.formats.length !== sheet.headers.length || sheet.formats.some(format => !formats[format]))) throw new Error("Each row, widths and formats must match the header column count.");
    cells += (sheet.rows.length + 1) * sheet.headers.length;
    if (cells > scope.config.maxCells) throw new Error("Workbook exceeds the cell limit.");
    for (const row of [sheet.headers, ...sheet.rows]) for (const value of row) {
      if (typeof value === "string" && (!validText(value) || value.length > 32000) || typeof value === "number" && !Number.isFinite(value) || value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("Cells must be literal text, finite numbers, booleans or null; formulas and executable objects are not accepted.");
    }
  }
  const workbook = new ExcelJS.Workbook(); workbook.creator = "Product Expert";
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name);
    ws.addRow(sheet.headers); ws.addRows(sheet.rows);
    ws.properties.defaultRowHeight = 22;
    ws.eachRow(row => { row.eachCell(cell => { cell.font = { name: "Arial", size: 11 }; cell.alignment = { vertical: "top", wrapText: true }; }); });
    ws.getRow(1).eachCell(cell => { cell.font = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF35553D" } }; });
    for (let col = 0; col < sheet.headers.length; col++) {
      const column = ws.getColumn(col + 1);
      const length = Math.max(...[sheet.headers, ...sheet.rows].map(row => String(row[col] ?? "").split(/\r?\n/).reduce((n, line) => Math.max(n, [...line].reduce((sum, char) => sum + (char.codePointAt(0)! > 255 ? 2 : 1), 0)), 0)));
      column.width = sheet.widths?.[col] ?? Math.max(12, Math.min(48, length + 2));
      column.numFmt = formats[sheet.formats?.[col] ?? "general"]!;
    }
    if (sheet.freezeHeader !== false) ws.views = [{ state: "frozen", ySplit: 1 }];
    if (sheet.autoFilter !== false) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rows.length + 1, column: sheet.headers.length } };
    ws.pageSetup = { orientation: sheet.headers.length > 4 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    ws.pageSetup.printTitlesRow = "1:1";
  }
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  if (bytes.length > scope.config.maxFileBytes) throw new Error("Workbook exceeds the file size limit.");
  await fs.writeFile(scope.output, bytes, { flag: "wx", mode: 0o600 });
  await preflightPackage(scope.output, ".xlsx", scope.config);
  const verified = new ExcelJS.Workbook(); await verified.xlsx.readFile(scope.output);
  if (verified.worksheets.length !== sheets.length) throw new Error("Workbook verification failed: sheet count.");
  for (const sheet of sheets) {
    const ws = verified.getWorksheet(sheet.name); if (!ws) throw new Error("Workbook verification failed: missing sheet.");
    for (const [r, row] of [sheet.headers, ...sheet.rows].entries()) for (const [c, value] of row.entries()) {
      if (ws.getCell(r + 1, c + 1).value !== value) throw new Error(`Workbook verification failed at ${sheet.name}:${r + 1},${c + 1}.`);
    }
  }
  return { ok: true, verified: true, cells, sheets: sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows.length + 1, columns: sheet.headers.length })) };
}
