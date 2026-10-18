// Adapted from patrick-agent/src/tools/excelReadCache.ts; only requested dependency closure.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import type { ExcelPackageReport } from "./excelOoxml.js";
import { assertOoxmlIntegrity, inspectExcelPackage } from "./excelOoxml.js";
import { OoxmlWorkbookReader } from "./excelOoxmlReader.js";
import { inferSheetNamesFromMarkdown, readExcelMarkdown } from "./excelMarkitdownReader.js";
import { createExcelImageReadContext, type ExcelImageReadContext } from "./excelImageReader.js";
import { serializeWorksheetRows, type ExcelReadBounds, type SerializedWorksheetRow, worksheetContentBounds } from "./excelReadSerialization.js";
import { findWorksheetByName } from "./excelWorksheetNames.js";
import { resolveReadablePath, workerScope, type WorkspaceResolvedPath } from "../workspace.js";


const MAX_SHEETS = 50;

const MAX_CACHE_ENTRIES = 1;

const MAX_CACHE_WEIGHT_BYTES = 16 * 1024 * 1024;

const CACHE_IDLE_TTL_MS = 30 * 60 * 1000;

const SOURCE_WEIGHT_MULTIPLIER = 4;

export type ExcelReadEngine = "exceljs" | "ooxml" | "markitdown";

export interface ExcelReadContext {
  engine: ExcelReadEngine;
  workbook?: ExcelJS.Workbook;
  sheetNames: string[];
}

interface ExcelFileIdentity {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export interface ExcelWorksheetSnapshot {
  name: string;
  state: ExcelJS.WorksheetState;
  bounds: ExcelReadBounds;
  usedRange: string;
  actualRows: number;
  actualColumns: number;
  merges: string[];
  headerFooter: Partial<ExcelJS.HeaderFooter>;
  rows: SerializedWorksheetRow[];
}

export interface ExcelReadCacheEntry {
  resolved: WorkspaceResolvedPath;
  identity: ExcelFileIdentity;
  size: number;
  bytes: Buffer;
  revision: string;
  packageReport: ExcelPackageReport;
  readEngine?: ExcelReadEngine;
  ooxmlReader?: OoxmlWorkbookReader;
  ooxmlSheetNames?: string[];
  markdown?: string;
  imageReader?: ExcelImageReadContext;
  imageReaderPromise?: Promise<ExcelImageReadContext>;
  workbook?: ExcelJS.Workbook;
  workbookPromise?: Promise<ExcelJS.Workbook>;
  readContextPromise?: Promise<ExcelReadContext>;
  worksheetSnapshots: Map<string, ExcelWorksheetSnapshot>;
  imageAnalysisCache: Map<string, Promise<Record<string, unknown>>>;
  drawingTexts?: Array<{ sheet: string; part: string; text: string }>;
  weightBytes: number;
  lastAccessedAt: number;
  cacheable: boolean;
}

export interface ExcelReadCacheLookup {
  entry: ExcelReadCacheEntry;
  cacheHit: boolean;
}

export interface ExcelReadCacheMetrics {
  source: "memory" | "file";
  worksheetSnapshotsReused: number;
  worksheetSnapshotsBuilt: number;
  imageAnalysesReused: number;
  imageAnalysesCreated: number;
}

const cache = new Map<string, ExcelReadCacheEntry>();

const inFlightSources = new Map<string, Promise<ExcelReadCacheEntry>>();

let cacheWeightBytes = 0;

let forceExcelJsFailureForTests = false;

let forceOoxmlFailureForTests = false;

export function createExcelReadCacheMetrics(cacheHit: boolean): ExcelReadCacheMetrics {
  return {
    source: cacheHit ? "memory" : "file",
    worksheetSnapshotsReused: 0,
    worksheetSnapshotsBuilt: 0,
    imageAnalysesReused: 0,
    imageAnalysesCreated: 0
  };
}

export async function getExcelReadCacheEntry(requestedPath: string): Promise<ExcelReadCacheLookup> {
  const resolved = await resolveReadablePath(requestedPath, { mustExist: true });
  if (path.extname(resolved.absolutePath).toLowerCase() !== ".xlsx") {
    throw new Error("Excel read cache only supports .xlsx files.");
  }
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) throw new Error("Excel path must be a regular file.");
  if (stat.size === 0 || stat.size > workerScope().config.maxFileBytes) {
    throw new Error("Excel file must be non-empty and within the configured file size limit.");
  }

  pruneExpiredEntries();
  const identity = fileIdentity(stat);
  const cached = cache.get(resolved.absolutePath);
  if (cached && sameIdentity(cached.identity, identity)) {
    touchEntry(cached);
    return { entry: cached, cacheHit: true };
  }
  if (cached) removeEntry(resolved.absolutePath);

  const inFlightKey = `${resolved.absolutePath}\u0000${identityKey(identity)}`;
  const existingPromise = inFlightSources.get(inFlightKey);
  if (existingPromise) {
    const entry = await existingPromise;
    touchEntry(entry);
    return { entry, cacheHit: true };
  }

  const creation = createEntry(resolved, identity);
  inFlightSources.set(inFlightKey, creation);
  try {
    const entry = await creation;
    if (entry.cacheable) {
      cache.set(resolved.absolutePath, entry);
      cacheWeightBytes += entry.weightBytes;
      enforceCacheLimits();
    }
    return { entry, cacheHit: false };
  } finally {
    inFlightSources.delete(inFlightKey);
  }
}

export async function ensureExcelWorkbook(entry: ExcelReadCacheEntry): Promise<ExcelJS.Workbook> {
  touchEntry(entry);
  if (entry.workbook) return entry.workbook;
  if (entry.workbookPromise) return entry.workbookPromise;
  const loading = loadWorkbook(entry);
  entry.workbookPromise = loading;
  try {
    const workbook = await loading;
    entry.workbook = workbook;
    return workbook;
  } finally {
    entry.workbookPromise = undefined;
  }
}

export async function resolveExcelReadContext(entry: ExcelReadCacheEntry): Promise<ExcelReadContext> {
  touchEntry(entry);
  if (entry.readEngine) return buildReadContextFromEntry(entry);
  if (entry.readContextPromise) return entry.readContextPromise;
  const loading = resolveReadEngine(entry);
  entry.readContextPromise = loading;
  try {
    return await loading;
  } finally {
    entry.readContextPromise = undefined;
  }
}

export async function ensureExcelWorksheetSnapshotByName(
  entry: ExcelReadCacheEntry,
  sheetName: string,
  metrics: ExcelReadCacheMetrics
): Promise<ExcelWorksheetSnapshot> {
  touchEntry(entry);
  const cached = entry.worksheetSnapshots.get(sheetName);
  if (cached) {
    metrics.worksheetSnapshotsReused += 1;
    return cached;
  }

  const context = await resolveExcelReadContext(entry);
  if (context.engine === "markitdown") {
    throw new Error("Structured worksheet snapshots are unavailable in MarkItDown read mode.");
  }
  if (context.engine === "exceljs") {
    const workbook = context.workbook ?? await ensureExcelWorkbook(entry);
    const lookup = findWorksheetByName(workbook, sheetName);
    if (!lookup.worksheet) {
      const available = lookup.ambiguousSheets.length > 0
        ? lookup.ambiguousSheets.join(", ")
        : workbook.worksheets.map((worksheet) => worksheet.name).join(", ");
      throw new Error(`Worksheet not found: ${sheetName}. Available worksheets: ${available}.`);
    }
    return ensureExcelWorksheetSnapshot(entry, lookup.worksheet, metrics);
  }

  const reader = entry.ooxmlReader ?? await OoxmlWorkbookReader.open(entry.bytes);
  entry.ooxmlReader = reader;
  const snapshot = await reader.buildSnapshot(sheetName);
  entry.worksheetSnapshots.set(sheetName, snapshot);
  metrics.worksheetSnapshotsBuilt += 1;
  addEntryWeight(entry, jsonWeight(snapshot));
  return snapshot;
}

export function requireExcelWorksheetName(
  sheetNames: readonly string[],
  requestedName: string
): string {
  if (sheetNames.includes(requestedName)) return requestedName;
  throw new Error(
    `Worksheet not found: ${requestedName}. Available worksheets: ${sheetNames.join(", ")}.`
  );
}

export async function ensureExcelImageReader(
  entry: ExcelReadCacheEntry
): Promise<ExcelImageReadContext> {
  touchEntry(entry);
  if (entry.imageReader) return entry.imageReader;
  if (entry.imageReaderPromise) return entry.imageReaderPromise;
  const loading = createExcelImageReadContext(entry.bytes);
  entry.imageReaderPromise = loading;
  try {
    const reader = await loading;
    entry.imageReader = reader;
    return reader;
  } finally {
    entry.imageReaderPromise = undefined;
  }
}

export function ensureExcelWorksheetSnapshot(
  entry: ExcelReadCacheEntry,
  worksheet: ExcelJS.Worksheet,
  metrics: ExcelReadCacheMetrics
): ExcelWorksheetSnapshot {
  touchEntry(entry);
  const cached = entry.worksheetSnapshots.get(worksheet.name);
  if (cached) {
    metrics.worksheetSnapshotsReused += 1;
    return cached;
  }

  const bounds = worksheetContentBounds(worksheet);
  const snapshot: ExcelWorksheetSnapshot = {
    name: worksheet.name,
    state: worksheet.state,
    bounds,
    usedRange: boundsToRange(bounds),
    actualRows: worksheet.actualRowCount,
    actualColumns: worksheet.actualColumnCount,
    merges: [
      ...(((worksheet.model as unknown as { merges?: string[] }).merges) ?? [])
    ],
    headerFooter: worksheet.headerFooter,
    rows: serializeWorksheetRows(worksheet, bounds)
  };
  entry.worksheetSnapshots.set(worksheet.name, snapshot);
  metrics.worksheetSnapshotsBuilt += 1;
  addEntryWeight(entry, jsonWeight(snapshot));
  return snapshot;
}

export function filterWorksheetSnapshotRows(
  snapshot: ExcelWorksheetSnapshot,
  bounds: ExcelReadBounds
): SerializedWorksheetRow[] {
  return snapshot.rows.flatMap((row) => {
    if (row.row < bounds.startRow || row.row > bounds.endRow) return [];
    const cells = row.cells.filter((cell) => {
      const coordinates = cellCoordinates(cell.address);
      return coordinates.column >= bounds.startColumn
        && coordinates.column <= bounds.endColumn;
    });
    return cells.length > 0 ? [{ row: row.row, cells }] : [];
  });
}

export function addExcelReadCacheWeight(entry: ExcelReadCacheEntry, bytes: number): void {
  addEntryWeight(entry, bytes);
}

export function invalidateExcelReadCache(absolutePath: string): void {
  removeEntry(path.resolve(absolutePath));
}

async function createEntry(
  resolved: WorkspaceResolvedPath,
  identity: ExcelFileIdentity
): Promise<ExcelReadCacheEntry> {
  const bytes = await fs.readFile(resolved.absolutePath);
  const revision = createHash("sha256").update(bytes).digest("hex");
  const packageReport = await inspectExcelPackage(bytes);
  assertOoxmlIntegrity(packageReport);
  const weightBytes = bytes.byteLength * SOURCE_WEIGHT_MULTIPLIER;
  return {
    resolved,
    identity,
    size: identity.size,
    bytes,
    revision,
    packageReport,
    worksheetSnapshots: new Map(),
    imageAnalysisCache: new Map(),
    weightBytes,
    lastAccessedAt: Date.now(),
    cacheable: weightBytes <= MAX_CACHE_WEIGHT_BYTES
  };
}

export async function tryLoadExcelJsWorkbook(bytes: Buffer): Promise<ExcelJS.Workbook | null> {
  if (forceExcelJsFailureForTests) return null;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  } catch {
    return null;
  }
  if (workbook.worksheets.length > MAX_SHEETS) {
    throw new Error(`Workbook exceeds the ${MAX_SHEETS} worksheet limit.`);
  }
  return workbook;
}

async function loadWorkbook(entry: ExcelReadCacheEntry): Promise<ExcelJS.Workbook> {
  const workbook = await tryLoadExcelJsWorkbook(entry.bytes);
  if (workbook) return workbook;
  throw new Error(forceExcelJsFailureForTests
    ? "ExcelJS forced failure for tests."
    : "ExcelJS could not parse this workbook.");
}

async function resolveReadEngine(entry: ExcelReadCacheEntry): Promise<ExcelReadContext> {
  const failures: string[] = [];
  try {
    const workbook = await loadWorkbook(entry);
    entry.readEngine = "exceljs";
    entry.workbook = workbook;
    return {
      engine: "exceljs",
      workbook,
      sheetNames: workbook.worksheets.map((worksheet) => worksheet.name)
    };
  } catch (error) {
    failures.push(formatReadFailure("ExcelJS", error));
  }

  try {
    if (forceOoxmlFailureForTests) {
      throw new Error("OOXML forced failure for tests.");
    }
    const reader = await OoxmlWorkbookReader.open(entry.bytes);
    entry.readEngine = "ooxml";
    entry.ooxmlReader = reader;
    entry.ooxmlSheetNames = reader.getSheetNames();
    return {
      engine: "ooxml",
      sheetNames: entry.ooxmlSheetNames
    };
  } catch (error) {
    failures.push(formatReadFailure("OOXML", error));
  }

  try {
    const markdown = await readExcelMarkdown(entry);
    entry.readEngine = "markitdown";
    return {
      engine: "markitdown",
      sheetNames: inferSheetNamesFromMarkdown(markdown)
    };
  } catch (error) {
    failures.push(formatReadFailure("MarkItDown", error));
    throw new Error(`Excel workbook could not be read. ${failures.join(" ")}`);
  }
}

function buildReadContextFromEntry(entry: ExcelReadCacheEntry): ExcelReadContext {
  if (entry.readEngine === "exceljs") {
    if (!entry.workbook) {
      throw new Error("ExcelJS workbook cache is unavailable for this entry.");
    }
    return {
      engine: "exceljs",
      workbook: entry.workbook,
      sheetNames: entry.workbook.worksheets.map((worksheet) => worksheet.name)
    };
  }
  if (entry.readEngine === "ooxml") {
    return {
      engine: "ooxml",
      sheetNames: entry.ooxmlSheetNames ?? entry.ooxmlReader?.getSheetNames() ?? []
    };
  }
  return {
    engine: "markitdown",
    sheetNames: entry.markdown ? inferSheetNamesFromMarkdown(entry.markdown) : []
  };
}

function formatReadFailure(engine: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${engine}: ${message}`;
}

function addEntryWeight(entry: ExcelReadCacheEntry, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const wasCached = cache.get(entry.resolved.absolutePath) === entry;
  entry.weightBytes += Math.ceil(bytes);
  if (wasCached) cacheWeightBytes += Math.ceil(bytes);
  if (entry.weightBytes > MAX_CACHE_WEIGHT_BYTES) {
    entry.cacheable = false;
    if (wasCached) removeEntry(entry.resolved.absolutePath);
    return;
  }
  if (wasCached) enforceCacheLimits();
}

function touchEntry(entry: ExcelReadCacheEntry): void {
  entry.lastAccessedAt = Date.now();
  const key = entry.resolved.absolutePath;
  if (cache.get(key) !== entry) return;
  cache.delete(key);
  cache.set(key, entry);
}

function pruneExpiredEntries(now = Date.now()): void {
  for (const [key, entry] of cache) {
    if (now - entry.lastAccessedAt > CACHE_IDLE_TTL_MS) removeEntry(key);
  }
}

function enforceCacheLimits(): void {
  while (cache.size > MAX_CACHE_ENTRIES || cacheWeightBytes > MAX_CACHE_WEIGHT_BYTES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    removeEntry(oldestKey);
  }
}

function removeEntry(absolutePath: string): void {
  const entry = cache.get(absolutePath);
  if (!entry) return;
  cache.delete(absolutePath);
  cacheWeightBytes = Math.max(0, cacheWeightBytes - entry.weightBytes);
}

function fileIdentity(stat: Awaited<ReturnType<typeof fs.stat>>): ExcelFileIdentity {
  return {
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    ino: Number(stat.ino)
  };
}

function identityKey(identity: ExcelFileIdentity): string {
  return `${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}:${identity.ino}`;
}

function sameIdentity(left: ExcelFileIdentity, right: ExcelFileIdentity): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.ino === right.ino;
}

function jsonWeight(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function cellCoordinates(address: string): { row: number; column: number } {
  const match = /^([A-Z]+)([1-9][0-9]*)$/u.exec(address);
  if (!match) throw new Error(`Invalid cached Excel cell address: ${address}.`);
  let column = 0;
  for (const character of match[1]!) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { row: Number(match[2]), column };
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
