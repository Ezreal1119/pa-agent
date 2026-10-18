// Checks worksheet edits independently before a patched workbook can be published.
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { TemplateCellValue } from "./excelTemplateOoxml.js";

export interface WorksheetElement {
  index: number;
  end: number;
  bodyIndex: number;
  openingTag: string;
  body: string;
  xml: string;
  selfClosing: boolean;
}

/** Read an opening tag first. A self-closing element never searches for a closing tag. */
export function worksheetElements(xml: string, name: "c" | "row" | "sheetData" | "dimension"): WorksheetElement[] {
  const pattern = new RegExp(`<${name}(?=[\\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>`, "gu");
  const result: WorksheetElement[] = [];
  for (let match; (match = pattern.exec(xml));) {
    const openingTag = match[0];
    const bodyIndex = pattern.lastIndex;
    const selfClosing = openingTag.endsWith("/>");
    const close = selfClosing ? bodyIndex : xml.indexOf(`</${name}>`, bodyIndex);
    if (close < 0) throw new Error(`Unsafe worksheet XML: missing </${name}>.`);
    const end = selfClosing ? bodyIndex : close + name.length + 3;
    const body = selfClosing ? "" : xml.slice(bodyIndex, close);
    if (new RegExp(`<${name}(?=[\\s/>])`, "u").test(body)) throw new Error(`Unsafe worksheet XML: nested ${name}.`);
    result.push({ index: match.index, end, bodyIndex, openingTag, body, selfClosing, xml: xml.slice(match.index, end) });
    pattern.lastIndex = end;
  }
  return result;
}

export function worksheetAttributes(tag: string): Map<string, string> {
  return new Map([...tag.matchAll(/\s([\w:.-]+)\s*=\s*(["'])(.*?)\2/gsu)].map(m => [m[1]!, m[3]!]));
}

interface RowSnapshot { attributes: Map<string, string>; rest: string; }
interface SheetSnapshot {
  rows: Map<number, RowSnapshot>;
  cells: Map<string, WorksheetElement>;
  outside: string;
  sheetDataAttributes: Map<string, string>;
  dimension?: { first: { row: number; column: number }; last: { row: number; column: number } };
}

function coordinate(address: string) {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/u.exec(address);
  if (!match) throw new Error(`Unsafe worksheet XML: unsupported cell address ${address}.`);
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) throw new Error("Unsafe worksheet XML: address out of bounds.");
  return { row, column };
}

function withoutElements(xml: string, elements: WorksheetElement[]): string {
  let end = 0; const parts: string[] = [];
  for (const element of elements) { parts.push(xml.slice(end, element.index)); end = element.end; }
  parts.push(xml.slice(end));
  return parts.join("");
}

function snapshot(xml: string): SheetSnapshot {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Unsafe worksheet XML: invalid XML.");
  const data = worksheetElements(xml, "sheetData");
  if (data.length !== 1) throw new Error("Unsafe worksheet XML: expected one unprefixed sheetData element.");
  const sheetData = data[0]!;
  const rows = new Map<number, RowSnapshot>(); const cells = new Map<string, WorksheetElement>();
  const rowElements = worksheetElements(sheetData.body, "row");
  if (withoutElements(sheetData.body, rowElements).trim()) throw new Error("Unsafe worksheet XML: unsupported sheetData content.");
  let previousRow = 0;
  for (const row of rowElements) {
    const attributes = worksheetAttributes(row.openingTag); const raw = attributes.get("r") ?? "";
    const number = Number(raw);
    if (!/^[1-9][0-9]*$/u.test(raw) || number > 1048576 || number <= previousRow) throw new Error("Unsafe worksheet XML: missing, duplicate or unordered row number.");
    previousRow = number;
    const children = worksheetElements(row.body, "c"); let previousColumn = 0;
    for (const cell of children) {
      const address = worksheetAttributes(cell.openingTag).get("r") ?? ""; const position = coordinate(address);
      if (position.row !== number || position.column <= previousColumn || cells.has(address)) throw new Error("Unsafe worksheet XML: misplaced, duplicate or unordered cell.");
      previousColumn = position.column; cells.set(address, cell);
    }
    rows.set(number, { attributes, rest: withoutElements(row.body, children) });
  }
  const dimensions = worksheetElements(xml, "dimension");
  if (dimensions.length > 1) throw new Error("Unsafe worksheet XML: duplicate dimension.");
  let dimension: SheetSnapshot["dimension"];
  if (dimensions[0]) {
    const reference = worksheetAttributes(dimensions[0].openingTag).get("ref") ?? "";
    const [first, last, extra] = reference.split(":");
    if (!first || extra !== undefined) throw new Error("Unsafe worksheet XML: invalid dimension.");
    dimension = { first: coordinate(first), last: coordinate(last ?? first) };
  }
  // Every byte outside sheetData and the dimension must remain unchanged (merges, print, links, etc.).
  const outside = withoutElements(xml, [sheetData, ...dimensions].sort((a, b) => a.index - b.index));
  return { rows, cells, outside, dimension, sheetDataAttributes: worksheetAttributes(sheetData.openingTag) };
}

function sameAttributes(left: Map<string, string>, right: Map<string, string>, ignoreType = false): boolean {
  const entries = (value: Map<string, string>) => [...value].filter(([key]) => !ignoreType || key !== "t").sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

const valueParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, trimValues: false, processEntities: true });
function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return text((value as Record<string, unknown>)["#text"]);
  return String(value);
}
function valueMatches(cell: WorksheetElement | undefined, value: TemplateCellValue): boolean {
  if (!cell) return value === null;
  const node = valueParser.parse(cell.xml).c as Record<string, any>;
  if (value === null) return typeof node !== "object" || (node.f === undefined && node.v === undefined && node.is === undefined);
  if (!node || typeof node !== "object") return false;
  if (typeof value === "string") return node["@t"] === "inlineStr" && text(node.is?.t) === value;
  if (typeof value === "number") return node.f === undefined && node["@t"] === undefined && node.v !== undefined && Number(text(node.v)) === value;
  if (typeof value === "boolean") return node["@t"] === "b" && text(node.v) === (value ? "1" : "0");
  if (text(node.f) !== value.formula.trim().replace(/^=/u, "")) return false;
  return value.result == null ? node.v === undefined : text(node.v) === (typeof value.result === "boolean" ? (value.result ? "1" : "0") : String(value.result));
}

/** Independent checks: untouched cells/row metadata byte-for-byte; edited values and style attributes. */
export function assertWorksheetPatchIntegrity(beforeXml: string, afterXml: string, expected: ReadonlyMap<string, TemplateCellValue>): void {
  const before = snapshot(beforeXml); const after = snapshot(afterXml);
  const fail = (reason: string): never => { throw new Error(`Worksheet patch verification failed: ${reason}. No output was published.`); };
  if (before.outside !== after.outside || !sameAttributes(before.sheetDataAttributes, after.sheetDataAttributes)) fail("worksheet layout changed");
  for (const [number, row] of before.rows) {
    const next = after.rows.get(number);
    if (!next || !sameAttributes(row.attributes, next.attributes) || row.rest !== next.rest) fail(`row ${number} changed or disappeared`);
  }
  const editedRows = new Set([...expected.keys()].map(address => coordinate(address).row));
  for (const [number, row] of after.rows) if (!before.rows.has(number) && (!editedRows.has(number) || row.rest.trim() || row.attributes.size !== 1)) fail(`unexpected new row ${number}`);
  for (const [address, cell] of before.cells) {
    const next = after.cells.get(address);
    if (!next) fail(`cell ${address} disappeared`);
    if (!expected.has(address) && cell.xml !== next!.xml) fail(`untouched cell ${address} changed`);
    if (expected.has(address) && !sameAttributes(worksheetAttributes(cell.openingTag), worksheetAttributes(next!.openingTag), true)) fail(`cell ${address} style or metadata changed`);
  }
  for (const address of after.cells.keys()) if (!before.cells.has(address) && !expected.has(address)) fail(`unexpected new cell ${address}`);
  for (const [address, value] of expected) if (!valueMatches(after.cells.get(address), value)) fail(`cell ${address} has the wrong value`);
  if (before.dimension && !after.dimension) fail("dimension disappeared");
  if (after.dimension) {
    const { first, last } = after.dimension;
    const positions = [...after.cells.keys()].map(coordinate);
    if (before.dimension) positions.push(before.dimension.first, before.dimension.last);
    if (positions.some(p => p.row < first.row || p.row > last.row || p.column < first.column || p.column > last.column)) fail("dimension no longer covers cells");
  }
}
