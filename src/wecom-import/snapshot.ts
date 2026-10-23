import fs from "node:fs/promises";
import path from "node:path";
import {
  kind,
  MAX_SNAPSHOT_BYTES,
  FORMAT_VERSION,
  type WecomConfig,
} from "./config.js";
import { containedText, WecomError, type Reader } from "./client.js";
import { hash } from "../knowledge-sync/core.js";
export type Cell = {
  at: string;
  value?: string | number | boolean;
  formula?: string;
  links?: { url: string; text?: string }[];
};
export type Section = {
  key: string;
  title: string;
  hidden?: boolean;
  cells?: Cell[];
  merges?: string[];
  body?: string;
};
export type Snapshot = {
  schema: number;
  docid: string;
  kind: "sheet" | "word";
  title: string;
  version?: string;
  sections: Section[];
  coverage: string[];
};
export const text = (s: string) => s.replace(/\r\n?/g, "\n");
export function version(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return value;
  throw new WecomError(
    "Missing or invalid workbook version; refusing an unverified snapshot.",
  );
}
export function coordinate(at: string) {
  const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(at);
  if (!m) throw new WecomError("Invalid A1 coordinate.");
  let c = 0;
  for (const l of m[1]!) c = c * 26 + l.charCodeAt(0) - 64;
  const r = Number(m[2]);
  if (c > 16384 || r > 1048576)
    throw new WecomError("A1 coordinate exceeds worksheet bounds.");
  return { r, c };
}
export function address(r: number, c: number) {
  let s = "";
  while (c) {
    const n = (c - 1) % 26;
    s = String.fromCharCode(65 + n) + s;
    c = Math.floor((c - 1) / 26);
  }
  return `${s}${r}`;
}
export function region(value: string) {
  if (typeof value !== "string") throw new WecomError("Invalid A1 range.");
  const parts = value.split(":");
  if (parts.length > 2) throw new WecomError("Invalid A1 range.");
  const a = coordinate(parts[0]!),
    b = coordinate(parts[1] ?? parts[0]!);
  if (b.r < a.r || b.c < a.c) throw new WecomError("Reversed A1 range.");
  return { a, b, rows: b.r - a.r + 1, cols: b.c - a.c + 1 };
}
function title(value: unknown, fallback: string) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > 1000)
    throw new WecomError("Invalid document title.");
  return text(value);
}
function cell(raw: any, at: string): Cell | null {
  if (raw === null || raw === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof raw))
    raw = { value: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new WecomError(`Invalid cell at ${at}.`);
  const result: Cell = { at },
    links: { url: string; text?: string }[] = [];
  if (raw.value !== undefined && raw.value !== null && raw.value !== "") {
    if (
      !["string", "number", "boolean"].includes(typeof raw.value) ||
      (typeof raw.value === "number" && !Number.isFinite(raw.value))
    )
      throw new WecomError(`Invalid cell value at ${at}.`);
    result.value = typeof raw.value === "string" ? text(raw.value) : raw.value;
  }
  if (raw.formula !== undefined && raw.formula !== "") {
    if (typeof raw.formula !== "string")
      throw new WecomError("Invalid formula.");
    result.formula = text(raw.formula);
  }
  if (raw.rich_string !== undefined) {
    if (!Array.isArray(raw.rich_string))
      throw new WecomError("Invalid rich text.");
    const parts: string[] = [];
    for (const part of raw.rich_string) {
      if (!part || typeof part !== "object")
        throw new WecomError("Invalid rich text segment.");
      if (part.value !== undefined && part.value !== null)
        parts.push(String(part.value));
      else if (typeof part.link_text === "string") parts.push(part.link_text);
      if (typeof part.link === "string")
        links.push({
          url: part.link,
          ...(typeof part.link_text === "string"
            ? { text: part.link_text }
            : {}),
        });
    }
    if (result.value === undefined && parts.length)
      result.value = text(parts.join(""));
  }
  if (typeof raw.link === "string" && raw.link)
    links.push({
      url: raw.link,
      ...(typeof raw.link_text === "string" ? { text: raw.link_text } : {}),
    });
  if (links.length) result.links = links;
  return result.value !== undefined || result.formula || result.links
    ? result
    : null;
}
export class Collector {
  constructor(
    private reader: Reader,
    private config: WecomConfig,
  ) {}
  async getVersion(docid: string, signal: AbortSignal) {
    return version(
      (await this.reader.run("sheet.version.get", { docid }, signal)).version,
    );
  }
  async collect(
    docid: string,
    signal: AbortSignal,
    work: string,
    knownVersion?: string,
    update?: (stage: string) => Promise<void>,
  ): Promise<Snapshot> {
    return kind(docid) === "word"
      ? this.word(docid, signal, work)
      : this.sheet(docid, signal, knownVersion, update);
  }
  private async sheet(
    docid: string,
    signal: AbortSignal,
    knownVersion?: string,
    update?: (stage: string) => Promise<void>,
  ): Promise<Snapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before =
        attempt === 0 && knownVersion !== undefined
          ? knownVersion
          : await this.getVersion(docid, signal);
      const book = await this.reader.run(
          "sheet.workbook.get",
          { docid },
          signal,
        ),
        meta = await this.reader.run("sheet.get", { docid }, signal);
      if (
        book.truncated ||
        book.has_more ||
        meta.truncated ||
        meta.has_more ||
        !Array.isArray(book.sheets) ||
        !Array.isArray(meta.sheets) ||
        book.sheets.length > this.config.maxSheets ||
        !book.sheets.length
      )
        throw new WecomError("Invalid, empty or oversized worksheet list.");
      const ids = new Set<string>();
      const sections: Section[] = [],
        coverage: string[] = [];
      let total = 0,
        textBytes = 0;
      for (const sheet of book.sheets) {
        signal.throwIfAborted();
        if (
          typeof sheet.sheet_id !== "string" ||
          !sheet.sheet_id ||
          sheet.sheet_id.length > 500 ||
          ids.has(sheet.sheet_id) ||
          (sheet.type && sheet.type !== "sheet")
        )
          throw new WecomError("Unsupported or duplicate worksheet identity.");
        ids.add(sheet.sheet_id);
        const info = meta.sheets.find(
          (s: any) => s.sheet_id === sheet.sheet_id,
        );
        if (!info)
          throw new WecomError(
            "Worksheet lists disagree; no snapshot delivered.",
          );
        const range = region(sheet.range),
          size = range.rows * range.cols;
        total += size;
        if (total > this.config.maxCells)
          throw new WecomError(
            `Workbook exceeds ${this.config.maxCells} cells.`,
          );
        const cells: Cell[] = [];
        for (let r = range.a.r; r <= range.b.r; ) {
          const rowCount = Math.max(
              1,
              Math.min(80, Math.floor(4000 / Math.min(range.cols, 1000))),
            ),
            endR = Math.min(range.b.r, r + rowCount - 1);
          for (
            let c = range.a.c;
            c <= range.b.c;
            c += Math.min(range.cols, 1000)
          ) {
            const endC = Math.min(
                range.b.c,
                c + Math.min(range.cols, 1000) - 1,
              ),
              requested = `${address(r, c)}:${address(endR, endC)}`;
            const data = await this.reader.run(
              "sheet.cells.get",
              {
                docid,
                sheet: sheet.sheet_id,
                range: requested,
                include: ["formula"],
              },
              signal,
            );
            const normalized = (s: string) =>
              s.includes(":") ? s : `${s}:${s}`;
            if (
              data.truncated ||
              (data.not_viewable_cells !== undefined &&
                (!Array.isArray(data.not_viewable_cells) ||
                  data.not_viewable_cells.length)) ||
              typeof data.actual_range !== "string" ||
              normalized(data.actual_range) !== requested ||
              !Array.isArray(data.cells) ||
              data.cells.length !== endR - r + 1 ||
              data.cells.some(
                (row: any) =>
                  !Array.isArray(row) || row.length !== endC - c + 1,
              )
            )
              throw new WecomError(
                `Incomplete or inaccessible range in ${title(sheet.name, sheet.sheet_id)}: ${requested}.`,
              );
            for (let y = 0; y < data.cells.length; y++)
              for (let x = 0; x < data.cells[y].length; x++) {
                const value = cell(data.cells[y][x], address(r + y, c + x));
                if (value) {
                  textBytes += Buffer.byteLength(JSON.stringify(value));
                  if (textBytes > MAX_SNAPSHOT_BYTES)
                    throw new WecomError("Text snapshot exceeds 16 MiB.");
                  cells.push(value);
                }
              }
          }
          r = endR + 1;
        }
        const merged = await this.reader.run(
          "sheet.merge.get",
          { docid, sheet: sheet.sheet_id, range: sheet.range },
          signal,
        );
        // Official CLI omits the optional repeated field when the successful result has no merges.
        if (merged.merges === undefined && merged.errcode === 0)
          merged.merges = [];
        if (
          merged.truncated ||
          merged.has_more ||
          !Array.isArray(merged.merges) ||
          merged.merges.some((m: any) => typeof m !== "string")
        )
          throw new WecomError("Missing merge ranges.");
        const merges = [...new Set<string>(merged.merges)].sort();
        let mergeArea = 0;
        const occupied = new Set<string>();
        for (const merge of merges) {
          const m = region(merge);
          mergeArea += m.rows * m.cols;
          if (mergeArea > this.config.maxCells)
            throw new WecomError("Merge regions exceed the cell budget.");
          if (
            m.a.r < range.a.r ||
            m.a.c < range.a.c ||
            m.a.r > range.b.r ||
            m.a.c > range.b.c
          )
            throw new WecomError("Merge anchor lies outside the read range.");
          for (let r = m.a.r; r <= m.b.r; r++)
            for (let c = m.a.c; c <= m.b.c; c++) {
              const at = address(r, c);
              if (occupied.has(at))
                throw new WecomError("Overlapping merge ranges.");
              occupied.add(at);
            }
        }
        cells.sort((a, b) => {
          const x = coordinate(a.at),
            y = coordinate(b.at);
          return x.r - y.r || x.c - y.c;
        });
        sections.push({
          key: sheet.sheet_id,
          title: title(sheet.name, info.title || sheet.sheet_id),
          hidden: info.is_hidden === true,
          cells,
          merges,
        });
        coverage.push(
          `${title(sheet.name, sheet.sheet_id)}: ${sheet.range}; ${cells.length} nonempty cells; ${merges.length} merges; complete`,
        );
        await update?.(
          `Read ${sections.length}/${book.sheets.length} worksheets`,
        );
        if (Buffer.byteLength(JSON.stringify(sections)) > MAX_SNAPSHOT_BYTES)
          throw new WecomError("Text snapshot exceeds 16 MiB.");
      }
      if (ids.size !== meta.sheets.length)
        throw new WecomError("Worksheet lists disagree.");
      const after = await this.getVersion(docid, signal);
      if (before !== after) {
        if (attempt === 0) {
          await update?.("Workbook changed; retrying one complete snapshot");
          continue;
        }
        throw new WecomError(
          "Workbook kept changing during collection. Retry when editing pauses.",
        );
      }
      return {
        schema: FORMAT_VERSION,
        docid,
        kind: "sheet",
        title: title(meta.name, docid),
        version: after,
        sections,
        coverage,
      };
    }
    throw new WecomError("Snapshot could not be verified.");
  }
  private async word(
    docid: string,
    signal: AbortSignal,
    work: string,
  ): Promise<Snapshot> {
    const dir = await fs.mkdtemp(path.join(work, "word-"));
    try {
      let data = await this.reader.run(
        "doc.contents.get",
        { docid, content_type: "markdown" },
        signal,
        dir,
      );
      for (let depth = 0; data.file_path && depth < 3; depth++) {
        const body = await containedText(
          dir,
          data.file_path,
          MAX_SNAPSHOT_BYTES,
        );
        let wrapped: any;
        try {
          wrapped = JSON.parse(body);
        } catch {}
        const { file_path: _file, ...metadata } = data;
        if (
          wrapped &&
          typeof wrapped === "object" &&
          !Array.isArray(wrapped) &&
          ["content", "markdown_content", "file_path", "error", "errcode"].some(
            (k) => Object.hasOwn(wrapped, k),
          )
        ) {
          if (wrapped.error || wrapped.errcode)
            throw new WecomError("Word response file reports a failed read.");
          data = { ...metadata, ...wrapped };
        } else data = { ...metadata, content: body };
      }
      if (data.file_path)
        throw new WecomError("Too many nested Word response files.");
      const content =
        typeof data.content === "string"
          ? data.content
          : typeof data.content?.markdown_content === "string"
            ? data.content.markdown_content
            : typeof data.markdown_content === "string"
              ? data.markdown_content
              : undefined;
      if (
        content === undefined ||
        data.truncated ||
        data.has_more ||
        data.not_viewable_cells?.length
      )
        throw new WecomError("Incomplete or unsupported Word response.");
      if (
        Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES ||
        content.includes("\0")
      )
        throw new WecomError("Word text is invalid or exceeds 16 MiB.");
      const body = text(content)
        .replace(/!\[[^\]]*\]\([^\n]*?\)(?:[^\S\n]*\n)?/g, "")
        .replace(/<img\b[^>]*>(?:[^\S\n]*\n)?/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return {
        schema: FORMAT_VERSION,
        docid,
        kind: "word",
        title: title(data.name, docid),
        ...(data.version !== undefined
          ? { version: version(data.version) }
          : {}),
        sections: [{ key: "document", title: title(data.name, docid), body }],
        coverage: ["Complete Word text; images excluded"],
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
export function sectionHash(snapshot: Snapshot, section: Section) {
  return hash(
    JSON.stringify([FORMAT_VERSION, snapshot.kind, snapshot.title, section]),
  );
}
const escape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/\n/g, "<br>");
function cellText(cell: Cell) {
  let s = cell.value === undefined ? "" : String(cell.value);
  if (typeof cell.value === "number") s += " (number)";
  if (typeof cell.value === "boolean") s += " (boolean)";
  if (cell.formula) s += `${s ? " · " : ""}Formula: ${cell.formula}`;
  for (const link of cell.links ?? [])
    s += ` · Link${link.text ? ` (${link.text})` : ""}: ${link.url}`;
  return escape(s);
}
export function markdown(snapshot: Snapshot, section: Section) {
  const url = `https://doc.weixin.qq.com/${snapshot.kind === "sheet" ? "sheet" : "doc"}/${snapshot.docid}`;
  let out = `# ${escape(snapshot.title)}${snapshot.kind === "sheet" ? ` — ${escape(section.title)}` : ""}\n\nSource: ${url}\n${snapshot.kind === "sheet" ? `Worksheet: ${escape(section.title)}${section.hidden ? " (hidden)" : ""}\n` : ""}\nImages are intentionally excluded. This is a text snapshot, not a native Office export.\n\n`;
  if (section.body !== undefined) {
    out += section.body + "\n";
    if (Buffer.byteLength(out) > MAX_SNAPSHOT_BYTES)
      throw new WecomError("Generated Markdown exceeds 16 MiB.");
    return out;
  }
  const cells = new Map((section.cells ?? []).map((c) => [c.at, c])),
    render = new Map<string, string>();
  for (const c of cells.values()) render.set(c.at, cellText(c));
  const relevantMerges: string[] = [];
  for (const merge of section.merges ?? []) {
    const m = region(merge),
      anchor = address(m.a.r, m.a.c),
      value = cells.get(anchor);
    if (!value) continue;
    relevantMerges.push(merge);
    for (let r = m.a.r; r <= m.b.r; r++)
      for (let c = m.a.c; c <= m.b.c; c++) {
        const at = address(r, c);
        if (at !== anchor && cells.has(at))
          throw new WecomError("A merged child unexpectedly contains text.");
        render.set(
          at,
          `${cellText(value)}${at !== anchor ? ` (merged from ${anchor})` : ""}`,
        );
      }
  }
  if (!render.size) return out + "No text cells.\n";
  const coords = [...render.keys()].map(coordinate);
  const columns = [...new Set(coords.map((p) => p.c))].sort((a, b) => a - b);
  const columnGroup = new Map(columns.map((c, i) => [c, Math.floor(i / 20)]));
  const groupRows = new Map<number, Set<number>>();
  for (const p of coords) {
    const g = columnGroup.get(p.c)!;
    if (!groupRows.has(g)) groupRows.set(g, new Set());
    groupRows.get(g)!.add(p.r);
  }
  // A long vertical merge and a wide horizontal merge must not produce their
  // cartesian product of empty cells. Each column group renders only its rows.
  for (let at = 0; at < columns.length; at += 20) {
    const group = columns.slice(at, at + 20);
    out += `| Source row | ${group.map((c) => address(1, c).replace(/1$/, "")).join(" | ")} |\n| --- | ${group.map(() => "---").join(" | ")} |\n`;
    for (const r of [...groupRows.get(at / 20)!].sort((a, b) => a - b)) {
      out += `| ${r} | ${group.map((c) => render.get(address(r, c)) ?? "").join(" | ")} |\n`;
      if (out.length > MAX_SNAPSHOT_BYTES)
        throw new WecomError("Generated Markdown exceeds 16 MiB.");
    }
    out += "\n";
  }
  if (relevantMerges.length)
    out += `Merged ranges: ${relevantMerges.join(", ")}\n`;
  if (Buffer.byteLength(out) > MAX_SNAPSHOT_BYTES)
    throw new WecomError("Generated Markdown exceeds 16 MiB.");
  return out;
}
