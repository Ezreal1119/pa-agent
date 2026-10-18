import fs from "node:fs/promises";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";
import type { FileToolConfig } from "./config.js";
import { inspectImageHeader } from "./vendor/imageTools.js";
import { parseExcelRange } from "./vendor/excelReadSerialization.js";

/** Check ZIP central directory before a library is allowed to inflate its entries. */
export async function preflightPackage(file: string, extension: string, config: FileToolConfig): Promise<void> {
  const bytes = await fs.readFile(file);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  if (end < 0) throw new Error("Not a valid unencrypted Office ZIP package.");
  const count = bytes.readUInt16LE(end + 10); const directoryBytes = bytes.readUInt32LE(end + 12); let offset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count > 2000 || offset + directoryBytes !== end) throw new Error("Unsupported or excessive ZIP structure.");
  const seen = new Set<string>(); let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central directory.");
    const flags = bytes.readUInt16LE(offset + 8); const size = bytes.readUInt32LE(offset + 24);
    const nameBytes = bytes.readUInt16LE(offset + 28); const extraBytes = bytes.readUInt16LE(offset + 30); const commentBytes = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameBytes).toString("utf8");
    if (flags & 1 || /(?:^|\/)\.\.(?:\/|$)|\\|^\/|:|\0/.test(name) || seen.has(name)) throw new Error("Unsafe, duplicate or encrypted ZIP entry.");
    seen.add(name); expanded += size;
    if (expanded > config.maxExpandedBytes || size > config.maxExpandedBytes) throw new Error("Office package exceeds expanded size limit.");
    offset += 46 + nameBytes + extraBytes + commentBytes;
    if (offset > end) throw new Error("Invalid ZIP entry length.");
  }
  if (offset !== end) throw new Error("Invalid ZIP entry count.");
  const zip = await JSZip.loadAsync(bytes);
  let actualBytes = 0; let cells = 0; let sheets = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const data = await entry.async("nodebuffer"); actualBytes += data.length;
    if (actualBytes > config.maxExpandedBytes) throw new Error("Office package exceeds expanded size limit.");
    if (/\/(?:media)\//i.test(entry.name) && /\.(png|jpe?g|webp)$/i.test(entry.name)) {
      const image = inspectImageHeader(data);
      if (!image || image.width < 1 || image.height < 1 || image.width * image.height > config.maxPixels) throw new Error("Embedded image exceeds pixel limit or has invalid content.");
    }
    if (!/\.(xml|rels)$/i.test(entry.name)) continue;
    if (data.length > 8 * 1024 * 1024) throw new Error("Office XML part exceeds size limit.");
    const xml = data.toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid or unsafe Office XML.");
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name)) {
      sheets++; cells += [...xml.matchAll(/<(?:\w+:)?c(?:\s|>)/g)].length;
      if (sheets > config.maxSheets || cells > config.maxCells) throw new Error("Workbook exceeds sheet or cell limit.");
      let mergedArea = 0;
      for (const match of xml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref=["']([^"']+)["']/g)) { const range = parseExcelRange(match[1]!); mergedArea += (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1); if (mergedArea > config.maxCells) throw new Error("Workbook merged-cell area exceeds limit."); }
    }
  }
  if (extension === ".pptx" && [...seen].filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).length > config.maxPages) throw new Error("Presentation exceeds slide limit.");
}
