import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { EditorInputError } from './editor-types.js';

/**
 * 项目级 BOM 导入：文件存到 product_lib/<项目>/assemble/，解析结果存 bom.json。
 * catalog 只读 sops.json 和工序目录，这两个文件不影响出表。
 */

const BOM_JSON = 'bom.json';
const MAX_BOM_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 20000;

export interface BomRow { partno: string; name: string; qty: number | null }
export interface BomInfo { fileName: string; importedAt: string; rows: BomRow[] }

function normalizeHeader(value: string): string {
  return value.replace(/[\s_()（）:：/\\-]/gu, '').toLowerCase();
}

// 客户 BOM 里同时有 UROVO PN（我方料号）、GERTECPN、Part Number（厂商料号），
// 录入页用的是 UROVO PN，必须排在 Part Number 前面。
const PARTNO_HEADERS = ['urovopn', '料号', '物料编码', '物料编号', '物料号', '编码', '料号编码', 'partno', 'partnumber', 'pn', 'item', 'itemno'];
const NAME_HEADERS = ['名称', '物料名称', '品名', '物料描述', '描述', 'materialname', 'description', 'name'];
const QTY_HEADERS = ['用量', '数量', '单机用量', '使用数量', 'qty', 'quantity'];

function findColumns(cells: string[]): { partno: number; name: number; qty: number } | null {
  const normalized = cells.map(normalizeHeader);
  const pick = (candidates: string[]) => {
    for (const candidate of candidates) {
      const index = normalized.findIndex(cell => cell === candidate);
      if (index >= 0) return index;
    }
    return -1;
  };
  // 先按完整表头匹配；表头写成「UROVO料号」「物料料号」「料号（我司）」这类时再按中文关键词兜底。
  const contains = (words: string[], excludes: string[] = []) => normalized.findIndex(cell =>
    words.some(word => cell.includes(word)) && !excludes.some(word => cell.includes(word))
  );
  const partno = pick(PARTNO_HEADERS) >= 0
    ? pick(PARTNO_HEADERS)
    : contains(['料号', '编码'], ['厂商', '供应商', '客户', '替代', 'gertec']);
  if (partno < 0) return null;
  const name = pick(NAME_HEADERS) >= 0 ? pick(NAME_HEADERS) : contains(['名称', '品名', '描述']);
  // 客户的 BOM 用 "Usage for <项目> (EE)" 表示单机用量，旁边还有 "Total Usage for ..." 是整单总量，
  // 必须排除掉 Total，否则会把 5000 当单机用量。
  const exactQty = pick(QTY_HEADERS);
  const usageQty = normalized.findIndex(cell => cell.includes('usagefor') && !cell.includes('total'));
  const qty = exactQty >= 0 ? exactQty : usageQty >= 0 ? usageQty : contains(['用量', '数量']);
  return { partno, name, qty };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const record = value as { text?: unknown; result?: unknown; richText?: Array<{ text?: string }> };
    if (typeof record.text === 'string') return record.text.trim();
    if (Array.isArray(record.richText)) return record.richText.map(part => part.text ?? '').join('').trim();
    if (record.result !== undefined) return cellText(record.result);
  }
  return String(value).trim();
}

function gridCellText(cell: ExcelJS.Cell): string {
  // 合并单元格的 master 值为 null 时，ExcelJS 的 cell.text 会抛错，退回按 value 解析。
  try {
    const text = cell.text;
    if (typeof text === 'string') return text;
  } catch {
    // fall through
  }
  return cellText(cell.value);
}

function rowsFromGrid(grid: unknown[][]): { rows: BomRow[]; headers: { partno: number; name: number; qty: number } } | null {
  for (let index = 0; index < Math.min(grid.length, 15); index++) {
    const cells = (grid[index] ?? []).map(cellText);
    const columns = findColumns(cells);
    if (!columns) continue;
    const rows: BomRow[] = [];
    for (let rowIndex = index + 1; rowIndex < grid.length && rows.length < MAX_ROWS; rowIndex++) {
      const line = grid[rowIndex] ?? [];
      const partno = cellText(line[columns.partno]);
      if (!partno) continue;
      const qtyValue = columns.qty >= 0 ? cellText(line[columns.qty]) : '';
      const qty = qtyValue === '' ? null : Number(qtyValue.replace(/[^\d.-]/gu, ''));
      rows.push({
        partno,
        name: columns.name >= 0 ? cellText(line[columns.name]) : '',
        qty: qty !== null && Number.isFinite(qty) ? qty : null
      });
    }
    return { rows, headers: columns };
  }
  return null;
}

function isVirtual(row: BomRow): boolean {
  return row.name.includes('虚拟组件');
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function bomDirectory(library: string, projectId: string): string {
  const root = path.resolve(library);
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(projectId) || /^\.+$/u.test(projectId)) throw new EditorInputError('项目名不合法。');
  const directory = path.join(root, 'product_lib', projectId, 'assemble');
  if (!directory.startsWith(path.join(root, 'product_lib') + path.sep)) throw new EditorInputError('项目路径越界。');
  if (!fs.existsSync(path.join(root, 'product_lib', projectId, 'project.json'))) throw new EditorInputError(`项目 ${projectId} 不存在。`);
  return directory;
}

function readBomFile(directory: string): BomInfo | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, BOM_JSON), 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const record = value as { fileName?: unknown; importedAt?: unknown; rows?: unknown };
    if (!Array.isArray(record.rows)) return null;
    const rows = record.rows.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const row = item as { partno?: unknown; name?: unknown; qty?: unknown };
      if (typeof row.partno !== 'string' || !row.partno) return [];
      return [{ partno: row.partno, name: typeof row.name === 'string' ? row.name : '', qty: typeof row.qty === 'number' ? row.qty : null }];
    });
    return { fileName: typeof record.fileName === 'string' ? record.fileName : 'BOM', importedAt: typeof record.importedAt === 'string' ? record.importedAt : '', rows };
  } catch {
    return null;
  }
}

export function readBom(library: string, projectId: string): BomInfo | null {
  return readBomFile(bomDirectory(library, projectId));
}

export async function saveBom(library: string, input: { projectId: string; fileName: string; data: Buffer }): Promise<BomInfo> {
  const directory = bomDirectory(library, input.projectId);
  if (!input.data.length) throw new EditorInputError('BOM 文件是空的。');
  if (input.data.length > MAX_BOM_BYTES) throw new EditorInputError('BOM 文件不能超过 20 MB。');
  const extension = path.extname(input.fileName).toLowerCase();
  if (!['.xlsx', '.csv'].includes(extension)) throw new EditorInputError('只支持 .xlsx 或 .csv 的 BOM，.xls 请先另存为 .xlsx。');

  let grids: unknown[][][];
  if (extension === '.csv') {
    grids = [parseCsv(input.data.toString('utf8').replace(/^\uFEFF/u, ''))];
  } else {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(input.data as unknown as ArrayBuffer);
    } catch {
      throw new EditorInputError('这个文件不是有效的 xlsx，请确认没有加密或损坏。');
    }
    if (!workbook.worksheets.length) throw new EditorInputError('Excel 里没有工作表。');
    grids = workbook.worksheets
      // 封面和「删除记录」不是物料清单，跳过。
      .filter(sheet => !/删除|封面/u.test(sheet.name))
      .map(sheet => {
        const grid: unknown[][] = [];
        sheet.eachRow({ includeEmpty: false }, row => {
          const values: unknown[] = [];
          // 用单元格的显示文本，避免数字料号被转成科学计数法、丢掉显示格式。
          for (let column = 1; column <= sheet.columnCount; column++) values.push(gridCellText(row.getCell(column)));
          grid.push(values);
        });
        return grid;
      });
  }

  // 一个工作簿里可能有「组装 BOM」「包装 BOM」多个清单：合并，跳过虚拟组件和重复料号。
  const rows: BomRow[] = [];
  const seen = new Set<string>();
  for (const grid of grids) {
    const parsed = rowsFromGrid(grid);
    if (!parsed) continue;
    for (const row of parsed.rows) {
      if (rows.length >= MAX_ROWS) break;
      if (isVirtual(row)) continue;
      const key = row.partno.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  if (!rows.length) throw new EditorInputError('没找到可用的 BOM 数据：请确认工作表里有「料号 / 物料编码 / 物料名称 / 用量」这类表头。');
  const info: BomInfo = { fileName: path.basename(input.fileName), importedAt: new Date().toISOString(), rows };
  fs.mkdirSync(directory, { recursive: true });
  // 保留原始文件，方便以后核对；固定名便于覆盖。
  fs.writeFileSync(path.join(directory, `bom.import${extension}`), input.data);
  fs.writeFileSync(path.join(directory, BOM_JSON), `${JSON.stringify({ version: 1, ...info }, null, 2)}\n`, 'utf8');
  return info;
}

export function deleteBom(library: string, projectId: string): void {
  const directory = bomDirectory(library, projectId);
  fs.rmSync(path.join(directory, BOM_JSON), { force: true });
  fs.rmSync(path.join(directory, 'bom.import.xlsx'), { force: true });
  fs.rmSync(path.join(directory, 'bom.import.csv'), { force: true });
}
