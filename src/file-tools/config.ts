import path from "node:path";

export interface FileToolConfig {
  enabled: boolean;
  tools: FileToolName[];
  dataDir: string;
  readRoots: string[];
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxCells: number;
  maxSheets: number;
  maxPages: number;
  maxPixels: number;
  maxOutputChars: number;
  sessionQuotaBytes: number;
  timeoutMs: number;
  queueLimit: number;
  markitdown: string;
  workerImage: string;
  vision: { baseUrl: string; apiKey: string; model: string; timeoutMs: number; maxCalls: number };
}
export type FileToolOptions = Partial<Omit<FileToolConfig, "dataDir" | "vision">> & { vision?: Partial<FileToolConfig["vision"]> };
export function fileToolConfig(dataDir: string, options: FileToolOptions = {}, env: NodeJS.ProcessEnv = process.env): FileToolConfig {
  const number = (name: string, fallback: number, value?: number) => {
    const parsed = value ?? (env[name] === undefined ? fallback : Number(env[name]));
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
    return parsed;
  };
  if (env.FILE_TOOLS_ENABLED !== undefined && !["true", "false", "1", "0"].includes(env.FILE_TOOLS_ENABLED)) throw new Error("FILE_TOOLS_ENABLED must be true or false.");
  return {
    enabled: options.enabled ?? ["true", "1"].includes(env.FILE_TOOLS_ENABLED ?? "false"), dataDir: path.resolve(dataDir),
    tools: options.tools ? [...new Set(options.tools)].filter(name => FILE_TOOL_NAMES.includes(name)) : [...DEFAULT_FILE_TOOL_NAMES],
    readRoots: options.readRoots ?? [path.join(dataDir, "ums-expert"), path.join(dataDir, "urovo-product-expert")],
    maxFileBytes: number("FILE_MAX_BYTES", 30 * 1024 * 1024, options.maxFileBytes),
    maxExpandedBytes: number("FILE_MAX_EXPANDED_BYTES", 64 * 1024 * 1024, options.maxExpandedBytes),
    maxCells: number("FILE_MAX_CELLS", 50_000, options.maxCells), maxSheets: number("FILE_MAX_SHEETS", 20, options.maxSheets),
    maxPages: number("FILE_MAX_PAGES", 100, options.maxPages), maxPixels: number("FILE_MAX_PIXELS", 20_000_000, options.maxPixels),
    maxOutputChars: number("FILE_OUTPUT_CHARS", 60_000, options.maxOutputChars),
    sessionQuotaBytes: number("FILE_SESSION_QUOTA_BYTES", 100 * 1024 * 1024, options.sessionQuotaBytes),
    timeoutMs: number("FILE_TIMEOUT_MS", 120_000, options.timeoutMs), queueLimit: number("FILE_QUEUE_LIMIT", 8, options.queueLimit),
    markitdown: options.markitdown ?? env.MARKITDOWN_COMMAND?.trim() ?? "markitdown",
    workerImage: options.workerImage ?? env.FILE_WORKER_IMAGE?.trim() ?? "",
    vision: {
      baseUrl: (options.vision?.baseUrl ?? env.VISION_LLM_BASE_URL ?? "").trim().replace(/\/+$/, ""),
      apiKey: (options.vision?.apiKey ?? env.VISION_LLM_API_KEY ?? "").trim(), model: (options.vision?.model ?? env.VISION_LLM_MODEL ?? "").trim(),
      timeoutMs: number("VISION_TIMEOUT_MS", 60_000, options.vision?.timeoutMs), maxCalls: number("VISION_MAX_CALLS", 8, options.vision?.maxCalls),
    },
  };
}
export const DEFAULT_FILE_TOOL_NAMES = ["pdf_read", "docx_read", "pptx_read", "excel_read", "excel_patch_template", "image_read"] as const;
export const CREATE_TOOL_NAMES = ["excel_create", "text_file_create"] as const;
export const FILE_TOOL_NAMES = [...DEFAULT_FILE_TOOL_NAMES, ...CREATE_TOOL_NAMES] as const;
export type FileToolName = typeof FILE_TOOL_NAMES[number];
export const TEXT_OUTPUT_EXTENSIONS = new Set([".txt", ".md", ".html", ".htm", ".java", ".json", ".csv", ".xml", ".yaml", ".yml", ".css", ".js", ".ts", ".py", ".sql", ".c", ".h", ".cpp", ".hpp", ".go", ".rs"]);
export const OUTPUT_EXTENSIONS = new Set([".xlsx", ...TEXT_OUTPUT_EXTENSIONS]);
export const TEXT_INPUT_EXTENSIONS = new Set([...TEXT_OUTPUT_EXTENSIONS, ".log", ".jsonl", ".tsv", ".markdown", ".jsx", ".tsx", ".mjs", ".cjs", ".ini", ".conf", ".cfg", ".properties"]);
export const BINARY_FILE_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".png", ".jpg", ".jpeg", ".webp"]);
export const FILE_EXTENSIONS = new Set([...BINARY_FILE_EXTENSIONS, ...TEXT_INPUT_EXTENSIONS]);
