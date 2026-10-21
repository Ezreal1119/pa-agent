import path from "node:path";
import JSZip from "jszip";
import { decodeOfficeXml } from "../file-tools/office-xml.js";
import { XMLParser, XMLBuilder, XMLValidator } from "fast-xml-parser";

/** Strip embedded XLSX payloads only from the private snapshot. Never open them.
 * Other embedded formats, macros and external content remain subject to rejection.
 */
export async function omitEmbeddedWorkbooks(zip: JSZip): Promise<string[]> {
  const skipped = Object.keys(zip.files).filter(
    (name) =>
      /^(?:xl|word|ppt)\/embeddings\/[^/]+\.xlsx$/i.test(name) &&
      !zip.files[name]!.dir,
  );
  if (!skipped.length) return [];
  const omitted = new Set(skipped);
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
  });
  const builder = new XMLBuilder({
    preserveOrder: true,
    ignoreAttributes: false,
  });
  async function parsePart(part: JSZip.JSZipObject) {
    const xml = decodeOfficeXml(await part.async("nodebuffer"));
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
      throw new Error(`Invalid or unsafe Office XML: ${part.name}`);
    return parser.parse(xml);
  }
  const idsBySource = new Map<string, Set<string>>();
  const shapeIdsBySource = new Map<string, Set<string>>();
  const resolveTarget = (source: string, target: string) =>
    path.posix.normalize(
      target.startsWith("/")
        ? target.slice(1)
        : path.posix.join(path.posix.dirname(source), target),
    );
  function visit(nodes: any[], fn: (node: any) => void) {
    for (const node of nodes) {
      fn(node);
      for (const [key, value] of Object.entries(node))
        if (key !== ":@" && Array.isArray(value)) visit(value, fn);
    }
  }
  function prune(nodes: any[], reject: (node: any) => boolean): any[] {
    return nodes
      .filter((n) => !reject(n))
      .map((n) => {
        for (const [k, v] of Object.entries(n))
          if (k !== ":@" && Array.isArray(v)) n[k] = prune(v, reject);
        return n;
      });
  }
  for (const [name, part] of Object.entries(zip.files)) {
    if (part.dir || !name.endsWith(".rels")) continue;
    const source =
      name === "_rels/.rels"
        ? ""
        : name.replace(/(^|\/)\_rels\/([^/]+)\.rels$/, "$1$2");
    const ids = new Set<string>();
    const tree = prune(await parsePart(part), (node) => {
      if (!Object.keys(node).some((k) => /(?:^|:)Relationship$/.test(k)))
        return false;
      const a = node[":@"] ?? {};
      const target = String(a["@_Target"] ?? "");
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {}
      const resolved = resolveTarget(source, decoded);
      if (a["@_TargetMode"] !== "External" && omitted.has(resolved)) {
        ids.add(String(a["@_Id"]));
        return true;
      }
      return false;
    });
    if (ids.size) {
      zip.file(name, builder.build(tree));
      if (source) idsBySource.set(source, ids);
    }
  }
  for (const [source, ids] of idsBySource) {
    const part = zip.file(source);
    if (!part)
      throw new Error(`Embedded XLSX relationship source missing: ${source}`);
    const shapes = new Set<string>();
    const tree = prune(await parsePart(part), (node) => {
      const removed = Object.entries(node[":@"] ?? {}).some(
        ([k, v]) => /@_(?:\w+:)?(?:id|embed)$/.test(k) && ids.has(String(v)),
      );
      if (removed) {
        const shapeId = node[":@"]?.["@_shapeId"];
        if (shapeId) shapes.add(String(shapeId));
      }
      return removed;
    });
    if (shapes.size) shapeIdsBySource.set(source, shapes);
    zip.file(source, builder.build(tree));
  }
  // Excel embeds also have an icon/shape in a related drawing. Remove only
  // shapes tied by the deleted object's exact shapeId, never unrelated visuals.
  for (const [source, shapes] of shapeIdsBySource) {
    const relName = path.posix.join(
      path.posix.dirname(source),
      "_rels",
      `${path.posix.basename(source)}.rels`,
    );
    const relPart = zip.file(relName);
    if (!relPart) continue;
    const drawings = new Set<string>();
    visit(await parsePart(relPart), (node) => {
      const a = node[":@"] ?? {};
      if (
        /(?:\/drawing|\/vmlDrawing)$/.test(String(a["@_Type"])) &&
        a["@_TargetMode"] !== "External"
      )
        drawings.add(resolveTarget(source, String(a["@_Target"])));
    });
    for (const drawing of drawings) {
      const part = zip.file(drawing);
      if (!part) continue;
      const tree = prune(await parsePart(part), (node) => {
        if (!Object.keys(node).some((k) => /(?:^|:)(?:sp|pic|shape)$/.test(k)))
          return false;
        let matching = false;
        visit([node], (child) => {
          const a = child[":@"] ?? {};
          if (
            Object.keys(child).some((k) => /(?:^|:)cNvPr$/.test(k)) &&
            shapes.has(String(a["@_id"]))
          )
            matching = true;
          if (shapes.has(String(a["@_id"]).replace(/^_x0000_s/, "")))
            matching = true;
        });
        return matching;
      });
      zip.file(drawing, builder.build(tree));
    }
  }
  const types = zip.file("[Content_Types].xml");
  if (types)
    zip.file(
      "[Content_Types].xml",
      builder.build(
        prune(await parsePart(types), (node) =>
          omitted.has(
            String(node[":@"]?.["@_PartName"] ?? "").replace(/^\//, ""),
          ),
        ),
      ),
    );
  for (const name of skipped) zip.remove(name);
  return skipped;
}

/** Empty drawing wrappers left after omitting an embedded icon are not visuals. */
export function hasSpreadsheetVisuals(xml: string): boolean {
  return /<(?:[\w]+:)?(?:sp|pic|graphicFrame|cxnSp|grpSp)(?:\s|>|\/)/.test(xml);
}
