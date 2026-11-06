/**
 * 逐工序录入 → ckd-library-v2 的写入器。
 *
 * 页面只负责收集「一道工序该有什么」，这里负责把它落成 Library 认识的结构：
 *
 *   product_lib/<项目>/assemble/processes/process_01/     英文
 *   product_lib/<项目>/assemble/CN_process/process_01/    中文
 *     ├── metadata.txt                第一行 = Excel 里显示的工序名
 *     ├── Bill_of_Materials.jsonl     {"index","partno","spec","qty"}
 *     ├── Tools.jsonl                 {"index","name","specs","qty"}
 *     ├── Operation_Instruction.txt   每张图一段，空行分隔（段落数必须等于图片数）
 *     ├── Operation_Photos/p1.png …
 *     ├── Self_Check.txt
 *     ├── Previous_Station_Check.txt
 *     ├── standard_time.txt           本项目扩展：标准工时（秒）
 *     └── manpower.txt                本项目扩展：标准人力
 *
 * 设计约束：
 *  - 只写当前语言目录，另一种语言交给 Library 既有的翻译同步任务，不在此处双写。
 *  - 目录名固定 process_NN（两位补零），因为 catalog 按文件夹名字典序排工序，
 *    不补零会让 process_10 排到 process_2 前面。
 *  - 同时维护 assemble/sops.json 的 processSequence：catalog 只认 sequence 里的工序，
 *    新建的目录不写进 sequence 就等于不存在。
 *  - 写入走「临时目录 + rename」，并持 Library 排他锁，避免同步任务读到半成品。
 *  - 不主动改写 Library 的同步基线：新工序应当作为「新增内容」被既有同步任务识别。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isInside } from "./store.js";
import { acquireLibraryLock } from "./library-lock.js";
import { ImageInputError, inspectImage } from "./image-input.js";
import {
  EditorInputError,
  EDITOR_LANGUAGES,
  type EditorBomRowInput,
  type EditorBomRowRecord,
  type EditorLanguage,
  type EditorPhotoInput,
  type EditorPhotoRecord,
  type EditorProcessInput,
  type EditorProcessRecord,
  type EditorProjectSummary,
  type EditorSaveResult,
  type EditorToolRowInput,
  type EditorToolRowRecord
} from "./editor-types.js";

export const EDITOR_SOP_TYPE = "assemble";
const ASSEMBLY_DIRECTORY = "assemble";
const LANGUAGE_DIRECTORY: Record<EditorLanguage, string> = { English: "processes", "中文": "CN_process" };
const FOLDER_PATTERN = /^process_(\d{2,3})$/u;
/** 与对方 build-ckd-catalog-v3 / create-ckd-sop-v3 的两条上限保持一致。 */
const MAX_BOM_ROWS = 7;
const MAX_TOOL_ROWS = 5;
const MAX_PHOTO_COUNT = 12;
const MAX_METADATA_LENGTH = 200;
const MAX_PARAGRAPH_LENGTH = 4000;
const MAX_ORDER = 999;
/** 与 build-ckd-catalog-v3 的 processSequence 上限一致。 */
const MAX_SEQUENCE_LENGTH = 30;
const SOPS_FILE = "sops.json";
/** 草稿标记：存在这个文件时，该工序不参与出表，直到在录入页点「保存到 Library」。 */
const DRAFT_FILE = "draft.json";
const RESERVED_DIRECTORIES = new Set(["CN_process", "derived", "CN_derived"]);

/* -------------------------------------------------------------- 命名与校验 */

/** 工序文件夹名：两位补零，保证字典序等于工序顺序。 */
export function processFolderName(order: number): string {
  return `process_${String(order).padStart(2, "0")}`;
}

function validateLanguage(value: unknown): EditorLanguage {
  if (typeof value !== "string" || !EDITOR_LANGUAGES.includes(value as EditorLanguage)) {
    throw new EditorInputError("语言只能是 English 或 中文。");
  }
  return value as EditorLanguage;
}

function validateOrder(value: unknown): number {
  const order = typeof value === "string" ? Number(value) : value;
  if (typeof order !== "number" || !Number.isInteger(order) || order < 1 || order > MAX_ORDER) {
    throw new EditorInputError(`工序顺序必须是 1–${MAX_ORDER} 的整数。`);
  }
  return order;
}

function validateProjectId(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new EditorInputError("项目不能为空。");
  if (text.length > 64) throw new EditorInputError("项目名不能超过 64 个字符。");
  if (text === "." || text === "..") throw new EditorInputError("项目名不合法。");
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(text)) throw new EditorInputError("项目名不能包含 / \\ : * ? \" < > | 等字符。");
  if (RESERVED_DIRECTORIES.has(text)) throw new EditorInputError(`项目名不能使用保留名称 ${text}。`);
  return text;
}

function validateMetadata(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\r\n?/gu, "\n").trim() : "";
  if (!text) throw new EditorInputError("工序名不能为空，它会写入 metadata.txt 并显示在 Excel 里。");
  if (text.length > MAX_METADATA_LENGTH) throw new EditorInputError(`工序名不能超过 ${MAX_METADATA_LENGTH} 个字符。`);
  // metadata.txt 只取第一行作为显示名，出现换行会被截断，直接拒绝更安全。
  if (text.includes("\n")) throw new EditorInputError("工序名不能包含换行。");
  return text;
}

function finiteNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(number) ? number : null;
}

function text(value: unknown, maxLength: number, label: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length > maxLength) throw new EditorInputError(`${label}不能超过 ${maxLength} 个字符。`);
  return result;
}

/** 只保留非空行，并按 Library 既有字段名输出。 */
function normalizeBom(rows: EditorBomRowInput[] | undefined): EditorBomRowRecord[] {
  if (rows !== undefined && !Array.isArray(rows)) throw new EditorInputError("物料清单格式不正确。");
  const result: EditorBomRowRecord[] = [];
  for (const [index, row] of (rows ?? []).entries()) {
    const partno = text(row?.partno, 200, `物料第 ${index + 1} 行的料号`);
    const spec = text(row?.spec, 200, `物料第 ${index + 1} 行的规格`);
    const qty = finiteNumber(row?.qty);
    // 整行为空视为未填写，直接跳过；只填一半则报错，避免生成半截行。
    if (!partno && !spec && qty === null) continue;
    if (!partno) throw new EditorInputError(`物料第 ${index + 1} 行缺料号。`);
    if (qty === null) {
      // 数量留空和填了非数字是两种错，分开提示；带上料号，避免用户对不上是哪一行。
      const raw = row?.qty;
      const blank = raw === undefined || raw === null || (typeof raw === "string" && !raw.trim());
      throw new EditorInputError(blank
        ? `物料第 ${index + 1} 行（料号 ${partno}）没填数量。`
        : `物料第 ${index + 1} 行（料号 ${partno}）的数量「${String(raw)}」不是数字。`);
    }
    result.push({ index: String(result.length + 1), partno, spec, qty });
  }
  return result;
}

function normalizeTools(rows: EditorToolRowInput[] | undefined): EditorToolRowRecord[] {
  if (rows !== undefined && !Array.isArray(rows)) throw new EditorInputError("工具清单格式不正确。");
  const result: EditorToolRowRecord[] = [];
  for (const [index, row] of (rows ?? []).entries()) {
    const name = text(row?.name, 200, `工具第 ${index + 1} 行的名称`);
    const specs = text(row?.specs, 200, `工具第 ${index + 1} 行的规格`);
    const qty = finiteNumber(row?.qty);
    if (!name && !specs && qty === null) continue;
    if (!name) throw new EditorInputError(`工具第 ${index + 1} 行缺少名称。`);
    result.push({ index: String(result.length + 1), name, specs, qty });
  }
  return result;
}

function normalizeParagraphs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new EditorInputError("操作步骤格式不正确。");
  return value.map((item, index) => {
    if (typeof item !== "string") throw new EditorInputError(`第 ${index + 1} 段操作步骤必须是文本。`);
    const paragraph = item
      .replace(/\r\n?/gu, "\n")
      .trim()
      // 写入用「空行」分隔各段（对方 instructionParagraphs() 的规则），所以段内不能再有空行，
      // 否则读回时被切段，段数与图片数对不上。这里把段内连续空行压成一个换行。
      .replace(/\n(?:[ \t]*\n)+/gu, "\n");
    if (paragraph.length > MAX_PARAGRAPH_LENGTH) throw new EditorInputError(`第 ${index + 1} 段操作步骤不能超过 ${MAX_PARAGRAPH_LENGTH} 个字符。`);
    return paragraph;
  });
}

type ResolvedPhoto =
  | { kind: "new"; bytes: Buffer; extension: "png" | "jpg" }
  | { kind: "keep"; fileName: string; extension: "png" | "jpg" };

/**
 * 一张图要么是新上传的 dataUrl，要么是「沿用上次保存的那张」（只给文件名）。
 * 沿用很重要：改一段文字不应该让用户重新上传几十 MB 的图。
 */
function resolvePhoto(photo: EditorPhotoInput | undefined, index: number): ResolvedPhoto {
  const label = photo?.label ? `第 ${index + 1} 张图（${photo.label}）` : `第 ${index + 1} 张图`;
  const dataUrl = typeof photo?.dataUrl === "string" ? photo.dataUrl.trim() : "";
  if (dataUrl) {
    const match = /^data:image\/(png|jpeg|jpg);base64,([\s\S]+)$/u.exec(dataUrl);
    if (!match?.[2]) throw new EditorInputError(`${label}格式不正确，只支持 PNG / JPEG。`);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(match[2], "base64");
    } catch {
      throw new EditorInputError(`${label}解码失败。`);
    }
    if (!bytes.length) throw new EditorInputError(`${label}内容为空。`);
    try {
      inspectImage(bytes);
    } catch (error) {
      const detail = error instanceof ImageInputError ? error.message : String(error);
      throw new EditorInputError(`${label}不是有效的 PNG / JPEG，或超过 10 MiB（${detail}）。`);
    }
    return { kind: "new", bytes, extension: match[1] === "png" ? "png" : "jpg" };
  }
  const name = typeof photo?.name === "string" ? photo.name.trim() : "";
  if (/^p\d+\.(?:png|jpe?g)$/iu.test(name)) {
    return { kind: "keep", fileName: name, extension: name.toLowerCase().endsWith(".png") ? "png" : "jpg" };
  }
  throw new EditorInputError(`${label}既没有上传内容，也不是已保存的图片名。`);
}

function libraryRoot(library: string): string {
  const root = path.resolve(library);
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) throw new EditorInputError("Library 目录不存在。");
  return root;
}

function assemblyRoot(root: string, projectId: string, language: EditorLanguage): string {
  return path.join(root, "product_lib", projectId, ASSEMBLY_DIRECTORY, LANGUAGE_DIRECTORY[language]);
}

/* ------------------------------------------------------------------ 项目 */

export function listProjects(library: string, language: EditorLanguage = "English"): EditorProjectSummary[] {
  const root = libraryRoot(library);
  const base = path.join(root, "product_lib");
  if (!fs.existsSync(base)) return [];
  const result: EditorProjectSummary[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (RESERVED_DIRECTORIES.has(entry.name)) continue;
    let displayName = entry.name;
    try {
      const definition: unknown = JSON.parse(fs.readFileSync(path.join(base, entry.name, "project.json"), "utf8"));
      if (definition && typeof definition === "object" && typeof (definition as { displayName?: unknown }).displayName === "string") {
        const configured = (definition as { displayName: string }).displayName.trim();
        if (configured) displayName = configured;
      }
    } catch {
      // project.json 缺失或损坏时退回目录名，不影响列表展示。
    }
    // 两种语言目录可能不同步（另一种语言靠翻译任务生成），展示时取较多的那个，
    // 否则只录了中文的项目会显示成 0 道工序。
    const processCount = Math.max(
      listProcessFolders(root, entry.name, "English").length,
      listProcessFolders(root, entry.name, "中文").length
    );
    result.push({ projectId: entry.name, displayName, processCount });
  }
  return result.sort((left, right) => left.projectId.localeCompare(right.projectId));
}

/** 新建项目。已存在时报错，避免覆盖别人的 project.json。 */
export function createProject(library: string, input: { projectId: unknown; displayName?: unknown }): EditorProjectSummary {
  const projectId = validateProjectId(input.projectId);
  const displayName = text(input.displayName, 200, "项目显示名") || projectId;
  const root = libraryRoot(library);
  const target = path.join(root, "product_lib", projectId);
  if (!isInside(path.join(root, "product_lib"), target)) throw new EditorInputError("项目路径越界。");
  if (fs.existsSync(target)) throw new EditorInputError(`项目 ${projectId} 已存在。`);
  // Linux 区分大小写，但 ABC 与 abc 在工作台里没法区分，按小写比对一遍，重名一律拒绝。
  const productRoot = path.join(root, "product_lib");
  if (fs.existsSync(productRoot)) {
    const lowered = projectId.toLowerCase();
    for (const entry of fs.readdirSync(productRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.toLowerCase() === lowered) {
        throw new EditorInputError(`项目 ${projectId} 已存在（与 ${entry.name} 重名）。`);
      }
    }
  }
  const release = acquireLibraryLock(root);
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "project.json"), `${JSON.stringify({ projectId, displayName, aliases: [] }, null, 2)}\n`, "utf8");
  } finally {
    release();
  }
  return { projectId, displayName, processCount: 0 };
}

/* -------------------------------------------------------- sops.json 维护 */

/**
 * catalog 的工序顺序来自 product_lib/<项目>/assemble/sops.json 的 processSequence，
 * 目录存在但没写进 sequence 的工序不会被扫到。这里只做「追加 / 重排 / 删除」三件事，
 * 不碰 SOS 条目上的其他字段（aliases、description、displayNameCN…）。
 */

interface SopsEntry {
  sopId?: unknown;
  displayName?: unknown;
  processSequence?: unknown;
  [key: string]: unknown;
}

interface SopsDocument {
  version?: unknown;
  sops?: unknown;
  [key: string]: unknown;
}

function sopsFilePath(root: string, projectId: string): string {
  return path.join(root, "product_lib", projectId, ASSEMBLY_DIRECTORY, SOPS_FILE);
}

function readSopsDocument(root: string, projectId: string): SopsDocument | null {
  const file = sopsFilePath(root, projectId);
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new EditorInputError(`${ASSEMBLY_DIRECTORY}/${SOPS_FILE} 不是合法 JSON，请先修复或删除它。`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EditorInputError(`${ASSEMBLY_DIRECTORY}/${SOPS_FILE} 必须是一个对象。`);
  }
  const document = parsed as SopsDocument;
  if (document.version !== 1 || !Array.isArray(document.sops)) {
    throw new EditorInputError(`${ASSEMBLY_DIRECTORY}/${SOPS_FILE} 必须是 version 1 且包含 sops 数组。`);
  }
  return document;
}

function sopsEntries(document: SopsDocument): SopsEntry[] {
  const entries = document.sops as unknown[];
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new EditorInputError(`${ASSEMBLY_DIRECTORY}/${SOPS_FILE} 的 sops[${index}] 不是对象。`);
    }
    return entry as SopsEntry;
  });
}

function sequenceOf(entry: SopsEntry): string[] {
  if (entry.processSequence === undefined) return [];
  if (!Array.isArray(entry.processSequence)) {
    throw new EditorInputError(`${ASSEMBLY_DIRECTORY}/${SOPS_FILE} 的 processSequence 必须是数组。`);
  }
  return entry.processSequence.map(value => {
    if (typeof value !== "string" || !value.trim()) throw new EditorInputError(`${ASSEMBLY_DIRECTORY}/${SOPS_FILE} 的 processSequence 含非法条目。`);
    return value.trim();
  });
}

/** 找本项目对应的 SOP 条目：优先 sopId 同名，其次「整个项目只有一条 SOP」的存量结构。 */
function findSopsEntry(document: SopsDocument, projectId: string): SopsEntry | null {
  const entries = sopsEntries(document);
  const matched = entries.find(entry => typeof entry.sopId === "string" && entry.sopId.trim().toLowerCase() === projectId.toLowerCase());
  if (matched) return matched;
  return entries.length === 1 ? entries[0]! : null;
}

function writeSopsDocument(root: string, projectId: string, document: SopsDocument): void {
  const directory = path.join(root, "product_lib", projectId, ASSEMBLY_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const target = sopsFilePath(root, projectId);
  const temporary = path.join(directory, `.${SOPS_FILE}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

/**
 * 保存工序前先算好 sops.json 的新内容：校验失败要在动目录之前抛，
 * 目录写成功后调用返回的 commit() 落盘。
 */
function planSopsAppend(root: string, projectId: string, folder: string): () => void {
  const existing = readSopsDocument(root, projectId);
  const document: SopsDocument = existing ?? { version: 1, sops: [] };
  const entries = sopsEntries(document);
  let entry = findSopsEntry(document, projectId);
  if (!entry) {
    entry = { sopId: projectId, displayName: `${projectId} Assemble`, aliases: [projectId], description: "", processSequence: [] };
    entries.push(entry);
    document.sops = entries;
  }
  const sequence = sequenceOf(entry);
  if (sequence.includes(folder)) return () => undefined;
  if (sequence.length >= MAX_SEQUENCE_LENGTH) {
    throw new EditorInputError(`该 SOP 已有 ${MAX_SEQUENCE_LENGTH} 道工序，达到 catalog 上限，无法再追加。`);
  }
  entry.processSequence = [...sequence, folder];
  return () => writeSopsDocument(root, projectId, document);
}

/** 重排后把新的 process_NN 顺序写回 sequence；存量里非 process_NN 的条目原样保留。 */
function planSopsReorder(root: string, projectId: string, folders: string[]): () => void {
  const document = readSopsDocument(root, projectId);
  if (!document) return () => undefined;
  const entry = findSopsEntry(document, projectId);
  if (!entry) return () => undefined;
  const current = sequenceOf(entry);
  const renamed = folders.map((_, index) => processFolderName(index + 1));
  const firstProcess = current.findIndex(value => FOLDER_PATTERN.test(value));
  const next = firstProcess < 0
    ? [...current, ...renamed]
    : [...current.slice(0, firstProcess), ...renamed, ...current.slice(firstProcess).filter(value => !FOLDER_PATTERN.test(value))];
  if (next.length > MAX_SEQUENCE_LENGTH) throw new EditorInputError(`SOP 的工序数量超过 ${MAX_SEQUENCE_LENGTH} 道。`);
  if (next.join("\n") === current.join("\n")) return () => undefined;
  entry.processSequence = next;
  return () => writeSopsDocument(root, projectId, document);
}

/** 删除工序后同步摘掉 sequence 条目；条目空了就把 SOP 从 sops 数组里移除，避免 catalog 报空 sequence。 */
function planSopsDelete(root: string, projectId: string, folder: string): () => void {
  const document = readSopsDocument(root, projectId);
  if (!document) return () => undefined;
  const entry = findSopsEntry(document, projectId);
  if (!entry) return () => undefined;
  const current = sequenceOf(entry);
  if (!current.includes(folder)) return () => undefined;
  const next = current.filter(value => value !== folder);
  if (!next.length) {
    const entries = sopsEntries(document);
    document.sops = entries.filter(candidate => candidate !== entry);
  } else {
    entry.processSequence = next;
  }
  return () => writeSopsDocument(root, projectId, document);
}

/* ------------------------------------------------------------------ 写入 */

export function saveProcess(library: string, input: EditorProcessInput, options: { draft?: boolean } = {}): EditorSaveResult {
  const root = libraryRoot(library);
  const projectId = validateProjectId(input?.projectId);
  const language = validateLanguage(input?.language);
  const order = validateOrder(input?.order);
  // 草稿允许空工序名：写入前把换行压成空格，正式保存仍走严格校验。
  const metadata = options.draft
    ? text(input?.metadata, MAX_METADATA_LENGTH, "工序名").replace(/\r?\n/gu, " ")
    : validateMetadata(input?.metadata);

  const projectRoot = path.join(root, "product_lib", projectId);
  if (!fs.existsSync(path.join(projectRoot, "project.json"))) {
    throw new EditorInputError(`项目 ${projectId} 不存在，请先新建项目。`);
  }

  // 先把内容全部准备好：任何校验失败都不应该进入 Library，更不应该占锁。
  const bom = normalizeBom(input.bom);
  const tools = normalizeTools(input.tools);
  const paragraphs = normalizeParagraphs(input.paragraphs);
  if (!Array.isArray(input.photos ?? [])) throw new EditorInputError("图片列表格式不正确。");
  const rawPhotos = input.photos ?? [];
  if (rawPhotos.length > MAX_PHOTO_COUNT) throw new EditorInputError(`单道工序最多 ${MAX_PHOTO_COUNT} 张图片。`);
  const photos = rawPhotos.map(resolvePhoto);

  const warnings: string[] = [];
  if (bom.length === 0) warnings.push("物料清单为空，Excel 的物料表会是空的。");
  if (tools.length === 0) warnings.push("工具清单为空，Excel 的工具表会是空的。");
  if (bom.length > MAX_BOM_ROWS) warnings.push(`物料 ${bom.length} 行，超过模板标准 ${MAX_BOM_ROWS} 行，超出的部分会排到续页。`);
  if (tools.length > MAX_TOOL_ROWS) warnings.push(`工具 ${tools.length} 行，超过模板标准 ${MAX_TOOL_ROWS} 行，超出的部分会排到续页。`);
  if (!options.draft && photos.length && paragraphs.length !== photos.length) {
    // 对方按「第 N 段配第 N 张图」对齐，数量不一致会串位，必须在这里拦住。
    throw new EditorInputError(`图片 ${photos.length} 张、操作步骤 ${paragraphs.length} 段，数量不一致会配错文字。请每张图各写一段。`);
  }
  if (!photos.length && !paragraphs.length) warnings.push("这道工序既没有图片也没有步骤，Excel 会生成一页空白。");

  const hours = finiteNumber(input.hours);
  const manpower = finiteNumber(input.manpower);
  if (hours !== null && hours < 0) throw new EditorInputError("标准工时不能是负数。");
  if (manpower !== null && manpower < 0) throw new EditorInputError("标准人力不能是负数。");

  const selfCheck = text(input.selfCheck, 4000, "自检内容");
  const previousStationCheck = text(input.previousStationCheck, 4000, "上工序检查内容");

  const folder = processFolderName(order);
  const parent = assemblyRoot(root, projectId, language);
  const target = path.join(parent, folder);
  if (!isInside(root, target)) throw new EditorInputError("工序路径越界。");
  // sops.json 先算后写：格式错误或条数超限都要在动目录之前拦住。
  const commitSops = planSopsAppend(root, projectId, folder);

  const release = acquireLibraryLock(root);
  try {
    fs.mkdirSync(parent, { recursive: true });
    const temporary = path.join(parent, `.${folder}.${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(temporary, { recursive: true });
      fs.writeFileSync(path.join(temporary, "metadata.txt"), `${metadata}\n`, "utf8");
      if (bom.length) fs.writeFileSync(path.join(temporary, "Bill_of_Materials.jsonl"), jsonl(bom), "utf8");
      if (tools.length) fs.writeFileSync(path.join(temporary, "Tools.jsonl"), jsonl(tools), "utf8");
      if (paragraphs.some(Boolean)) {
        // 空行分段是对方 instructionParagraphs() 的第一条规则，用它表达「一图一段」最稳。
        fs.writeFileSync(path.join(temporary, "Operation_Instruction.txt"), `${paragraphs.join("\n\n")}\n`, "utf8");
      }
      if (selfCheck) fs.writeFileSync(path.join(temporary, "Self_Check.txt"), `${selfCheck}\n`, "utf8");
      if (previousStationCheck) fs.writeFileSync(path.join(temporary, "Previous_Station_Check.txt"), `${previousStationCheck}\n`, "utf8");
      if (hours !== null) fs.writeFileSync(path.join(temporary, "standard_time.txt"), `${hours}\n`, "utf8");
      if (manpower !== null) fs.writeFileSync(path.join(temporary, "manpower.txt"), `${manpower}\n`, "utf8");
      if (options.draft) {
        // 草稿标记：catalog 会跳过它，出表前也会被拦截。steps 单独保存，便于以后支持无图步骤。
        fs.writeFileSync(path.join(temporary, DRAFT_FILE), `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), steps: paragraphs }, null, 2)}\n`, "utf8");
      }
      if (photos.length) {
        const photoDirectory = path.join(temporary, "Operation_Photos");
        fs.mkdirSync(photoDirectory, { recursive: true });
        photos.forEach((photo, index) => {
          const fileName = `p${index + 1}.${photo.extension}`;
          if (photo.kind === "new") {
            fs.writeFileSync(path.join(photoDirectory, fileName), photo.bytes);
            return;
          }
          // 沿用旧图：此时 target 还没被移走，直接从旧目录复制，按新顺序重命名。
          const source = path.join(target, "Operation_Photos", photo.fileName);
          if (!fs.existsSync(source)) throw new EditorInputError(`找不到要沿用的图片 ${photo.fileName}，请重新上传。`);
          fs.copyFileSync(source, path.join(photoDirectory, fileName));
        });
      }
      if (fs.existsSync(target)) {
        // 先挪到 trash 再 rename，两个操作都是原子的，扫描侧几乎看不到空窗。
        const trash = path.join(parent, `.${folder}.${randomUUID()}.trash`);
        fs.renameSync(target, trash);
        fs.renameSync(temporary, target);
        fs.rmSync(trash, { recursive: true, force: true });
      } else {
        fs.renameSync(temporary, target);
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    commitSops();
  } finally {
    release();
  }

  return {
    projectId,
    language,
    order,
    folder,
    relativePath: path.posix.relative(root.split(path.sep).join(path.posix.sep), target.split(path.sep).join(path.posix.sep)),
    warnings
  };
}

function jsonl(rows: unknown[]): string {
  return `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
}

/* ------------------------------------------------------------------ 读取 */

function listProcessFolders(root: string, projectId: string, language: EditorLanguage): string[] {
  const directory = assemblyRoot(root, projectId, language);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && FOLDER_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function listProcesses(library: string, input: { projectId: unknown; language: unknown }): { folder: string; order: number; metadata: string; photoCount: number; draft: boolean }[] {
  const root = libraryRoot(library);
  const projectId = validateProjectId(input.projectId);
  const language = validateLanguage(input.language);
  return listProcessFolders(root, projectId, language).map(folder => {
    const directory = path.join(assemblyRoot(root, projectId, language), folder);
    let metadata = "";
    try {
      metadata = fs.readFileSync(path.join(directory, "metadata.txt"), "utf8").split(/\r?\n/u)[0]?.trim() ?? "";
    } catch {
      metadata = "";
    }
    return { folder, order: Number(FOLDER_PATTERN.exec(folder)?.[1] ?? 0), metadata, photoCount: countPhotos(directory), draft: fs.existsSync(path.join(directory, DRAFT_FILE)) };
  });
}

function countPhotos(directory: string): number {
  const photoDirectory = path.join(directory, "Operation_Photos");
  if (!fs.existsSync(photoDirectory)) return 0;
  return fs.readdirSync(photoDirectory).filter(name => /^p\d+\.(?:png|jpe?g)$/iu.test(name)).length;
}

function readDraftFile(directory: string): { steps?: unknown } | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, DRAFT_FILE), "utf8"));
    return value && typeof value === "object" ? (value as { steps?: unknown }) : null;
  } catch {
    return null;
  }
}

function readJsonl(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        const value: unknown = JSON.parse(line);
        return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").replace(/\r\n?/gu, "\n").trim();
  } catch {
    return "";
  }
}

export function readProcess(
  library: string,
  input: { projectId: unknown; language: unknown; order: unknown },
  options: { includePhotos?: boolean } = {}
): EditorProcessRecord {
  const root = libraryRoot(library);
  const projectId = validateProjectId(input.projectId);
  const language = validateLanguage(input.language);
  const order = validateOrder(input.order);
  const folder = processFolderName(order);
  const directory = path.join(assemblyRoot(root, projectId, language), folder);
  if (!fs.existsSync(directory)) throw new EditorInputError(`工序 ${folder} 还不存在。`);

  const bom: EditorBomRowRecord[] = readJsonl(path.join(directory, "Bill_of_Materials.jsonl")).map((row, index) => ({
    index: typeof row.index === "string" ? row.index : String(index + 1),
    partno: typeof row.partno === "string" ? row.partno : "",
    spec: typeof row.spec === "string" ? row.spec : "",
    qty: finiteNumber(row.qty) ?? 0
  }));

  const tools: EditorToolRowRecord[] = readJsonl(path.join(directory, "Tools.jsonl")).map((row, index) => ({
    index: typeof row.index === "string" ? row.index : String(index + 1),
    name: typeof row.name === "string" ? row.name : "",
    specs: typeof row.specs === "string" ? row.specs : "",
    qty: finiteNumber(row.qty)
  }));

  // 草稿把每一步的原文存在 draft.json 里（包括暂时没有配图的步骤），优先用它。
  const draftRecord = readDraftFile(directory);
  const operation = readText(path.join(directory, "Operation_Instruction.txt"));
  const paragraphs = Array.isArray(draftRecord?.steps)
    ? (draftRecord!.steps as unknown[]).map(item => typeof item === "string" ? item : "")
    : operation ? operation.split(/\n[\t ]*\n+/u).map(part => part.trim()).filter(Boolean) : [];

  const photos: EditorPhotoRecord[] = [];
  const photoDirectory = path.join(directory, "Operation_Photos");
  if (fs.existsSync(photoDirectory)) {
    const entries = fs
      .readdirSync(photoDirectory)
      .map(name => ({ name, match: /^p(\d+)\.(png|jpe?g)$/iu.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => Boolean(entry.match))
      .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
    for (const entry of entries) {
      // 列表场景只要文件名，避免把几十 MB 的 base64 塞进 JSON；预览走 readPhoto。
      if (options.includePhotos === false) {
        photos.push({ name: entry.name, dataUrl: "" });
        continue;
      }
      const mime = entry.match[2]?.toLowerCase() === "png" ? "image/png" : "image/jpeg";
      photos.push({ name: entry.name, dataUrl: `data:${mime};base64,${fs.readFileSync(path.join(photoDirectory, entry.name)).toString("base64")}` });
    }
  }

  return {
    projectId,
    language,
    order,
    folder,
    draft: Boolean(draftRecord),
    metadata: readText(path.join(directory, "metadata.txt")).split("\n")[0] ?? "",
    bom,
    tools,
    paragraphs,
    photos,
    selfCheck: readText(path.join(directory, "Self_Check.txt")),
    previousStationCheck: readText(path.join(directory, "Previous_Station_Check.txt")),
    hours: finiteNumber(readText(path.join(directory, "standard_time.txt"))),
    manpower: finiteNumber(readText(path.join(directory, "manpower.txt")))
  };
}

/** 单张工序图片的原始字节，供页面预览（避免整页加载时把几十 MB base64 塞进 JSON）。 */
export function readPhoto(library: string, input: { projectId: unknown; language: unknown; order: unknown; name: unknown }): { bytes: Buffer; mimeType: string } {
  const root = libraryRoot(library);
  const projectId = validateProjectId(input.projectId);
  const language = validateLanguage(input.language);
  const order = validateOrder(input.order);
  const name = typeof input.name === "string" ? input.name : "";
  if (!/^p\d+\.(?:png|jpe?g)$/iu.test(name)) throw new EditorInputError("图片名不合法。");
  const file = path.join(assemblyRoot(root, projectId, language), processFolderName(order), "Operation_Photos", name);
  if (!isInside(root, file) || !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw new EditorInputError("图片不存在。");
  return { bytes: fs.readFileSync(file), mimeType: name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg" };
}

/* ------------------------------------------------------------------ 排序 */

/**
 * 按页面拖拽后的顺序重命名文件夹。
 * 必须走两段式：先全部改成临时名再改成最终名，否则 A→B、B→A 这类互换会互相覆盖。
 */
export function reorderProcesses(library: string, input: { projectId: unknown; language: unknown; folders: unknown }): { mapping: { from: string; to: string }[] } {
  const root = libraryRoot(library);
  const projectId = validateProjectId(input.projectId);
  const language = validateLanguage(input.language);
  if (!Array.isArray(input.folders) || !input.folders.length) throw new EditorInputError("工序顺序不能为空。");
  const parent = assemblyRoot(root, projectId, language);
  const existing = listProcessFolders(root, projectId, language);
  const requested = input.folders.map(value => (typeof value === "string" ? value.trim() : ""));
  if (requested.some(folder => !FOLDER_PATTERN.test(folder))) throw new EditorInputError("工序文件夹名不合法。");
  if (new Set(requested).size !== requested.length) throw new EditorInputError("工序顺序里有重复项。");
  for (const folder of requested) if (!existing.includes(folder)) throw new EditorInputError(`工序 ${folder} 不存在。`);
  if (requested.length !== existing.length) throw new EditorInputError("排序必须包含该语言下的全部工序。");
  const commitSops = planSopsReorder(root, projectId, requested);

  const release = acquireLibraryLock(root);
  try {
    const staged = requested.map((folder, index) => {
      const temporary = path.join(parent, `.reorder-${randomUUID()}-${index}`);
      fs.renameSync(path.join(parent, folder), temporary);
      return temporary;
    });
    const mapping: { from: string; to: string }[] = [];
    staged.forEach((temporary, index) => {
      const to = processFolderName(index + 1);
      fs.renameSync(temporary, path.join(parent, to));
      mapping.push({ from: requested[index]!, to });
    });
    commitSops();
    return { mapping };
  } finally {
    release();
  }
}

/* ------------------------------------------------------------------ 删除 */

export function deleteProcess(library: string, input: { projectId: unknown; language: unknown; order: unknown }): { folder: string; relativePath: string } {
  const root = libraryRoot(library);
  const projectId = validateProjectId(input.projectId);
  const language = validateLanguage(input.language);
  const order = validateOrder(input.order);
  const folder = processFolderName(order);
  const directory = path.join(assemblyRoot(root, projectId, language), folder);
  if (!isInside(root, directory)) throw new EditorInputError("工序路径越界。");
  if (!fs.existsSync(directory)) throw new EditorInputError(`工序 ${folder} 不存在。`);
  const commitSops = planSopsDelete(root, projectId, folder);
  const release = acquireLibraryLock(root);
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    commitSops();
  } finally {
    release();
  }
  return { folder, relativePath: path.posix.join(`product_lib/${projectId}/${ASSEMBLY_DIRECTORY}/${LANGUAGE_DIRECTORY[language]}`, folder) };
}

/* ------------------------------------------------------------------ 草稿发布 */

export interface DraftIssue { folder: string; metadata: string; message: string }

/**
 * 把当前项目+语言下的所有草稿逐条按正式规则校验：
 * 通过的去掉草稿标记、成为正式工序；不通过的保留草稿并回报原因。
 */
export function publishDrafts(library: string, input: { projectId: unknown; language: unknown }): { published: { folder: string; metadata: string }[]; issues: DraftIssue[] } {
  const root = libraryRoot(library);
  const projectId = validateProjectId(input.projectId);
  const language = validateLanguage(input.language);
  const parent = assemblyRoot(root, projectId, language);
  const drafts = listProcessFolders(root, projectId, language).filter(folder => fs.existsSync(path.join(parent, folder, DRAFT_FILE)));
  const published: { folder: string; metadata: string }[] = [], issues: DraftIssue[] = [];
  for (const folder of drafts) {
    const order = Number(FOLDER_PATTERN.exec(folder)?.[1] ?? 0);
    let metadata = "";
    try {
      const record = readProcess(library, { projectId, language, order }, { includePhotos: true });
      metadata = record.metadata;
      if (!record.metadata.trim()) throw new EditorInputError("工序名为空。");
      if (record.photos.length && record.photos.length !== record.paragraphs.length) {
        throw new EditorInputError(`图片 ${record.photos.length} 张、操作步骤 ${record.paragraphs.length} 段，数量不一致，请每张图各写一段。`);
      }
      if (record.photos.length && ![1, 2, 4].includes(record.photos.length)) {
        throw new EditorInputError(`图片 ${record.photos.length} 张，模板只支持 1 / 2 / 4 张。`);
      }
      saveProcess(library, {
        projectId, language, order, metadata: record.metadata,
        bom: record.bom,
        tools: record.tools.map(tool => ({ name: tool.name, specs: tool.specs, qty: tool.qty ?? undefined })),
        paragraphs: record.paragraphs,
        photos: record.photos.map(photo => ({ dataUrl: photo.dataUrl })),
        selfCheck: record.selfCheck, previousStationCheck: record.previousStationCheck,
        hours: record.hours ?? undefined, manpower: record.manpower ?? undefined
      });
      published.push({ folder, metadata: record.metadata });
    } catch (error) {
      issues.push({ folder, metadata, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { published, issues };
}

/** 出表前检查：资料库里是否还有草稿（任何项目/语言）。 */
export function pendingDrafts(library: string): { projectId: string; language: EditorLanguage; folder: string }[] {
  let root: string;
  try { root = libraryRoot(library); } catch { return []; }
  const base = path.join(root, "product_lib");
  if (!fs.existsSync(base)) return [];
  const result: { projectId: string; language: EditorLanguage; folder: string }[] = [];
  for (const project of fs.readdirSync(base, { withFileTypes: true })) {
    if (!project.isDirectory() || project.name.startsWith(".")) continue;
    for (const language of ["English", "中文"] as const) {
      const parent = path.join(base, project.name, ASSEMBLY_DIRECTORY, LANGUAGE_DIRECTORY[language]);
      if (!fs.existsSync(parent)) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && FOLDER_PATTERN.test(entry.name) && fs.existsSync(path.join(parent, entry.name, DRAFT_FILE))) {
          result.push({ projectId: project.name, language, folder: entry.name });
        }
      }
    }
  }
  return result;
}
