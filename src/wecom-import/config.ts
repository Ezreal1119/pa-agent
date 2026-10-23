import path from "node:path";
import { SyncError } from "../knowledge-sync/core.js";
export const LIST_BYTES = 4 * 1048576;
export const MAX_SNAPSHOT_BYTES = 16 * 1048576;
export const FORMAT_VERSION = 1;
export interface WecomConfig {
  cliBin: string;
  authDir: string;
  docsFile: string;
  timeoutMs: number;
  documentTimeoutMs: number;
  attempts: number;
  reserveBytes: number;
  maxCells: number;
  maxSheets: number;
}
export type Source = { docid: string; description: string };
export function kind(docid: string) {
  if (/^e3_[A-Za-z0-9_-]+$/.test(docid)) return "sheet" as const;
  if (/^w3_[A-Za-z0-9_-]+$/.test(docid)) return "word" as const;
  throw new SyncError(
    "Only ordinary online sheets (e3_) and Word documents (w3_) are supported.",
  );
}
export function wecomConfig(
  cwd: string,
  dataDir: string,
  env: Record<string, string | undefined>,
): WecomConfig {
  const number = (key: string, value: number, min: number, max: number) => {
    const n = Number(env[key] || value);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw new SyncError(`Invalid ${key}.`);
    return n;
  };
  return {
    cliBin: env.WECOM_CLI_BIN?.trim() || "wecom-cli",
    authDir: path.resolve(
      cwd,
      env.WECOM_CLI_CONFIG_DIR || path.join(dataDir, "wecom-auth"),
    ),
    docsFile: path.resolve(
      cwd,
      env.WECOM_IMPORT_DOCS_FILE || path.join(dataDir, "wecom_sync_docs.jsonl"),
    ),
    timeoutMs: number("WECOM_IMPORT_REQUEST_TIMEOUT_MS", 45000, 100, 300000),
    documentTimeoutMs: number(
      "WECOM_IMPORT_DOCUMENT_TIMEOUT_MS",
      600000,
      1000,
      3600000,
    ),
    attempts: 3,
    reserveBytes: 256 * 1048576,
    maxCells: 500000,
    maxSheets: 200,
  };
}
export function checkDocs(text: unknown) {
  if (typeof text !== "string" || Buffer.byteLength(text) > LIST_BYTES)
    throw new SyncError("The JSONL editor accepts UTF-8 text up to 4 MiB.");
  const errors: { line: number; message: string }[] = [],
    sources: Source[] = [],
    seen = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  if (lines.length > 10000)
    errors.push({ line: 0, message: "The list exceeds 10000 lines." });
  else
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          throw new Error("Invalid JSON.");
        }
        if (
          !o ||
          typeof o !== "object" ||
          Array.isArray(o) ||
          Object.keys(o).length !== 2 ||
          !Object.hasOwn(o, "docid") ||
          !Object.hasOwn(o, "description")
        )
          throw new Error("Each line must contain only docid and description.");
        if (typeof o.docid !== "string" || o.docid.length > 500)
          throw new Error("Invalid docid.");
        kind(o.docid);
        if (
          typeof o.description !== "string" ||
          !o.description.trim() ||
          o.description.length > 500 ||
          /[\x00-\x1f\x7f]/.test(o.description)
        )
          throw new Error(
            "description must be nonempty text up to 500 characters without control characters.",
          );
        if (seen.has(o.docid))
          throw new Error(
            `Duplicate docid; first listed on line ${seen.get(o.docid)}.`,
          );
        seen.set(o.docid, i + 1);
        sources.push({ docid: o.docid, description: o.description.trim() });
      } catch (e) {
        errors.push({ line: i + 1, message: (e as Error).message });
      }
    }
  if (!sources.length && !errors.length)
    errors.push({ line: 0, message: "Add at least one document." });
  return { valid: !errors.length, count: sources.length, errors };
}
export function parseDocs(text: string): Source[] {
  const result = checkDocs(text);
  if (!result.valid)
    throw new SyncError(
      result.errors.map((e) => `Line ${e.line}: ${e.message}`).join("\n"),
    );
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const o = JSON.parse(l);
      return { docid: o.docid, description: o.description.trim() };
    });
}
