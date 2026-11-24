import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { inside } from "../file-tools/store.js";
import { publishedSearchTools } from "../knowledge-sync/read-tools.js";
import { ATTACHMENT_PREFIX, grepWindowsAttachment, type WindowsAttachment } from "./attachments.js";

const LINE_BYTES = 2400;
const READ_BYTES = 18000;

async function resolveCorpusPath(root: string, input: string) {
  const requested = path.resolve(root, input);
  const relative = path.relative(root, requested);
  if (!inside(root, requested) || relative.split(path.sep).some(part => part.startsWith("."))) {
    throw new Error("Specify a visible path within the Windows Tools workspace.");
  }
  const real = await fs.realpath(requested);
  if (real !== requested) throw new Error("Linked paths are unavailable in the Windows Tools workspace.");
  const stat = await fs.stat(real);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error("Select a regular file or directory.");
  return { relative: relative || ".", real, stat };
}

/** Page individual lines without buffering large IL or disassembly exports. */
async function readLines(handle: FileHandle, offset: number, limit: number, signal?: AbortSignal) {
  let lineNumber = 1;
  let bytes = 0;
  let output = "";
  let length = 0;
  const line = Buffer.alloc(LINE_BYTES);
  const append = () => {
    if (lineNumber >= offset) {
      const text = line.subarray(0, Math.min(length, LINE_BYTES)).toString("utf8").replace(/\r$/, "");
      const rendered = `${lineNumber}: ${text}${length > LINE_BYTES ? " [line truncated]" : ""}\n`;
      const size = Buffer.byteLength(rendered);
      if (bytes + size > READ_BYTES) return false;
      output += rendered;
      bytes += size;
    }
    lineNumber++;
    return lineNumber < offset + limit;
  };
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Select a regular file.");
    const stream = handle.createReadStream({signal});
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      if (buffer.includes(0)) throw new Error("Only text exports are readable.");
      let start = 0;
      while (start < buffer.length) {
        const newline = buffer.indexOf(10, start);
        const end = newline < 0 ? buffer.length : newline;
        if (lineNumber >= offset && length < LINE_BYTES) {
          buffer.copy(line, length, start, Math.min(end, start + LINE_BYTES - length));
        }
        length += end - start;
        if (newline < 0) break;
        if (!append()) return { output, next: lineNumber };
        length = 0;
        start = end + 1;
      }
    }
    if (length && !append() && lineNumber < offset + limit) return { output, next: lineNumber };
    return { output };
  } finally {
    await handle.close();
  }
}

export function windowsReadTools(
  root: string,
  signal: AbortSignal,
  charge: () => void,
  attachments: readonly WindowsAttachment[] = [],
): ToolDefinition<any, any>[] {
  const delegated = new Map(attachments.map(file => [file.path, file]));
  const openAttachment = (alias: string) => {
    const file = delegated.get(alias);
    if (!file) throw new Error("This attachment was not delegated for the current task.");
    return file.open();
  };
  const read = createReadToolDefinition(root);
  read.description = "Read a workspace text export or a delegated attachment by its attachment:<id> path. Specify offset (1-based) and limit for numbered lines.";
  read.execute = async (_id, args) => {
    charge();
    const offset = Math.max(1, Math.floor(args.offset ?? 1));
    const limit = Math.min(200, Math.max(1, Math.floor(args.limit ?? 80)));
    let sourcePath: string;
    let handle: FileHandle;
    if (args.path.startsWith(ATTACHMENT_PREFIX)) {
      sourcePath = args.path;
      handle = await openAttachment(sourcePath);
    } else {
      const { real, relative, stat } = await resolveCorpusPath(root, args.path);
      if (!stat.isFile()) throw new Error("Select a file to read.");
      sourcePath = relative;
      handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    const page = await readLines(handle, offset, limit, signal);
    return {
      content: [{type: "text", text: page.output
        ? `${sourcePath}\n${page.output}${page.next ? `\n[Continue with offset ${page.next}.]` : ""}`
        : "No text at that offset."}],
      details: {},
    };
  };
  const search = publishedSearchTools(root, { privateCorpus: true });
  for (const tool of search) {
    if (tool.name === "grep") tool.description += " Use a delegated attachment:<id> path to search one uploaded text file.";
    const execute = tool.execute;
    tool.execute = async (id, args, _signal, update, context) => {
      charge();
      const query = args as { path?: string; limit?: number };
      if (tool.name === "grep" && query.path?.startsWith(ATTACHMENT_PREFIX)) {
        const handle = await openAttachment(query.path);
        try {
          const output = await grepWindowsAttachment(handle, args as Parameters<typeof grepWindowsAttachment>[1], signal);
          return {content: [{type: "text", text: output ? `${query.path}\n${output}` : "No matches."}], details: {}};
        } finally { await handle.close(); }
      }
      const { relative } = await resolveCorpusPath(root, query.path ?? ".");
      return execute(id, { ...query, path: relative, limit: Math.min(100, Math.max(1, query.limit ?? 50)) }, signal, update, context);
    };
  }
  return [read, ...search];
}
