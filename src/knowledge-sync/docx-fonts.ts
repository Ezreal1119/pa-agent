import { XMLParser, XMLValidator } from "fast-xml-parser";

type Node = Record<string, any>;
const local = (name: string) => name.replace(/^@_/, "").split(":").at(-1)!;
const attribute = (node: Node, name: string): string | undefined => {
  const pair = Object.entries(node[":@"] ?? {}).find(([key]) => local(key) === name);
  return pair ? String(pair[1]) : undefined;
};
function visit(nodes: Node[], fn: (node: Node, name: string) => void) {
  for (const node of nodes) {
    for (const [key, children] of Object.entries(node)) {
      if (key === ":@" || !Array.isArray(children)) continue;
      fn(node, local(key));
      visit(children, fn);
    }
  }
}
const references = new Set(["pStyle", "rStyle", "tblStyle", "defaultTableStyle", "styleLink", "numStyleLink"]);
// Only exclude styles proven unused. This is deliberately not a replacement
// for Word's layout/font-slot engine: all declarations in active styles remain
// checked, even if a later formatting layer may override one of them.
export function docxFonts(parts: Map<string, string>) {
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false });
  const trees = new Map<string, Node[]>();
  for (const [name, xml] of parts) {
    if (!/^word\/.+\.xml$/.test(name) || name.startsWith("word/theme/")) continue;
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
      throw new Error(`Invalid or unsafe Office XML: ${name}`);
    trees.set(name, parser.parse(xml));
  }
  const fonts = new Set<string>();
  const used = new Set<string>();
  const addReferences = (nodes: Node[]) => visit(nodes, (node, name) => {
    const value = attribute(node, "val");
    if (references.has(name) && value) used.add(value);
  });
  const addFonts = (nodes: Node[]) => visit(nodes, (node, name) => {
    const add = (value: string | undefined) => { if (value && !value.startsWith("+")) fonts.add(value); };
    if (name === "rFonts")
      // Preserve the existing explicit font-slot policy; do not add a new
      // requirement for an unused complex-script slot in an English document.
      for (const slot of ["ascii", "hAnsi", "eastAsia"]) add(attribute(node, slot));
    add(attribute(node, "typeface"));
    if (name === "sym") add(attribute(node, "font"));
  });
  for (const [name, nodes] of trees) {
    if (name === "word/styles.xml") continue;
    // References in numbering/settings are retained conservatively, including
    // defaults and styles selected through a numbering definition.
    addReferences(nodes);
    if (/^word\/(?:glossary\/)?(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(name))
      addFonts(nodes);
  }
  const styleTree = trees.get("word/styles.xml") ?? [];
  const definitions = new Map<string, Node[]>();
  let ambiguous = false;
  let hasDefault = false;
  const roots = styleTree.filter(node => Object.keys(node).some(key => local(key) === "styles"));
  if (styleTree.length && roots.length !== 1) ambiguous = true;
  const children: Node[] = roots.flatMap(node => Object.entries(node).flatMap(([key, value]) =>
    local(key) === "styles" && Array.isArray(value) ? value : []));
  for (const node of children) {
    if (!Object.keys(node).some(key => local(key) === "style")) {
      addFonts([node]); // docDefaults and unknown extensions are never excluded.
      addReferences([node]);
      continue;
    }
    const id = attribute(node, "styleId");
    if (!id || definitions.has(id)) ambiguous = true;
    if (id) definitions.set(id, [node]);
    if (/^(?:1|true|on)$/i.test(attribute(node, "default") ?? "") && id) {
      used.add(id);
      if (attribute(node, "type") === "paragraph") hasDefault = true;
    }
  }
  // With no declared paragraph default, application-specific implicit style
  // selection is uncertain. Retain the old complete style font check.
  if (definitions.size && !hasDefault) ambiguous = true;
  const queue = [...used];
  for (let i = 0; i < queue.length; i++) {
    const nodes = definitions.get(queue[i]!);
    if (!nodes) { if (styleTree.length) ambiguous = true; continue; }
    visit(nodes, (node, name) => {
      if (!["basedOn", "link", ...references].includes(name)) return;
      const id = attribute(node, "val");
      if (id && !used.has(id)) { used.add(id); queue.push(id); }
    });
  }
  if (ambiguous) addFonts(styleTree);
  else for (const id of used) addFonts(definitions.get(id) ?? []);
  // Numbering may use an independent bullet font. Once numbering is active,
  // keep its whole declaration set rather than guessing conditional levels.
  let numbered = false;
  const detectNumbering = (nodes: Node[]) => visit(nodes, (node, name) => {
    if (name === "numId" && attribute(node, "val") !== "0") numbered = true;
  });
  for (const [name, nodes] of trees)
    if (name !== "word/styles.xml" && name !== "word/numbering.xml") detectNumbering(nodes);
  if (ambiguous) detectNumbering(styleTree);
  else for (const id of used) detectNumbering(definitions.get(id) ?? []);
  if (numbered) addFonts(trees.get("word/numbering.xml") ?? []);
  return {
    fonts,
    ignoredStyles: ambiguous ? 0 : [...definitions.keys()].filter(id => !used.has(id)).length,
    conservativeFallback: ambiguous,
  };
}
