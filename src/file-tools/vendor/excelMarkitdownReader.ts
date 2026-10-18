// Adapted from patrick-agent/src/tools/excelMarkitdownReader.ts; only requested dependency closure.
import { redactSecrets } from "../bridge.js";
import { markItDownCommand, markItDownInstallCommand, runExternalProcess } from "../external.js";
import type { ExcelReadCacheEntry } from "./excelReadCache.js";

const EXTERNAL_TIMEOUT_MS = 120_000;

const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;

export type ExcelMarkItDownRunner = (command: string, absolutePath: string) => Promise<string>;

let markItDownRunner: ExcelMarkItDownRunner = runMarkItDown;

export async function readExcelMarkdown(entry: ExcelReadCacheEntry): Promise<string> {
  const command = markItDownCommand();
  const markdown = await markItDownRunner(command, entry.resolved.absolutePath);
  entry.markdown = markdown;
  return markdown;
}

export function inferSheetNamesFromMarkdown(markdown: string): string[] {
  const names = new Set<string>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)) {
    const name = match[1]?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

async function runMarkItDown(command: string, absolutePath: string): Promise<string> {
  try {
    const { stdout } = await runExternalProcess({
      command,
      args: [absolutePath],
      timeoutMs: EXTERNAL_TIMEOUT_MS,
      maxOutputBytes: MAX_MARKDOWN_BYTES + 1024,
      missingExecutableMessage: `MarkItDown is not installed. Install it manually with: ${markItDownInstallCommand("xlsx")}. The app does not install dependencies automatically.`
    });
    const markdown = stdout.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
    if (!markdown) throw new Error("MarkItDown returned empty Markdown for this XLSX.");
    if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
      throw new Error("MarkItDown output exceeds the 10 MiB limit.");
    }
    return `${markdown}\n`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/MarkItDown is not installed/.test(message) || /output exceeds|timeout/.test(message)) {
      throw error;
    }
    throw new Error(
      `MarkItDown could not convert this XLSX: ${redactSecrets(message)}. Verify the XLSX dependency with: ${markItDownInstallCommand("xlsx")}.`
    );
  }
}
