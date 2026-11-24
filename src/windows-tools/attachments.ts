import { spawn } from "node:child_process";
import { once } from "node:events";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { TEXT_INPUT_EXTENSIONS } from "../file-tools/config.js";
import type { FileStore } from "../file-tools/store.js";

export const ATTACHMENT_PREFIX = "attachment:";

export interface WindowsAttachment {
  path: string;
  name: string;
  bytes: number;
  open: () => Promise<FileHandle>;
}

export async function windowsAttachments(store: FileStore | undefined, sessionId: string, boundIds: ReadonlySet<string>, ids: string[]): Promise<WindowsAttachment[]> {
  if (!ids.length) return [];
  if (!store) throw new Error("Text attachments are unavailable in this conversation.");
  const files = await store.list(sessionId);
  return ids.map(id => {
    const file = files.find(file => file.id === id && file.direction === "inputs" && boundIds.has(file.id));
    if (!file || !TEXT_INPUT_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
      throw new Error("Select an uploaded text attachment attached to a message in this conversation.");
    }
    return {
      path: ATTACHMENT_PREFIX + id,
      name: file.name,
      bytes: file.bytes,
      async open() {
        try { return (await store.open(sessionId, id)).handle; }
        catch { throw new Error("The delegated attachment is no longer readable."); }
      },
    };
  });
}

export async function grepWindowsAttachment(handle: FileHandle, query: {
  pattern: string; literal?: boolean; ignoreCase?: boolean; context?: number; limit?: number;
}, signal: AbortSignal) {
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 50)));
  const context = Math.min(10, Math.max(0, Math.floor(query.context ?? 0)));
  const args = ["--no-config", "--line-number", "--color", "never", "--max-columns", "1600", "--max-columns-preview",
    "--max-count", String(limit), "--context", String(context)];
  if (query.ignoreCase) args.push("-i");
  if (query.literal) args.push("-F");
  args.push("--", query.pattern, "-");

  // Search the same checked file descriptor, without reopening by path or copying bytes.
  const child = spawn("rg", args, {
    stdio: [handle.fd, "pipe", "ignore"], signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  let output = "";
  const maxChars = 18_000;
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    if (output.length <= maxChars) output += chunk.slice(0, maxChars + 1 - output.length);
  });
  const [code] = await once(child, "close").catch(() => []);
  if (code !== 0 && code !== 1) throw new Error("Attachment search failed. Narrow the search or check the pattern.");
  return output.length > maxChars ? `${output.slice(0, maxChars)}\n[Truncated; narrow the search.]` : output;
}
