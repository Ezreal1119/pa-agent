import test from "node:test";
import assert from "node:assert/strict";
import { docxFonts } from "../dist/knowledge-sync/docx-fonts.js";

const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const base = '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:rPr><w:rFonts w:ascii="serif"/></w:rPr></w:style>';
const style = (id, inner = "", attrs = 'w:type="paragraph"') => `<w:style ${attrs} w:styleId="${id}">${inner}</w:style>`;
const font = (name, slot = "ascii") => `<w:rPr><w:rFonts w:${slot}="${name}"/></w:rPr>`;
const run = '<w:r><w:t>English text</w:t></w:r>';
const inspect = (styles = "", body = run, extra = []) => docxFonts(new Map([
  ["word/document.xml", `<w:document ${ns}><w:body><w:p>${body}</w:p></w:body></w:document>`],
  ["word/styles.xml", `<w:styles ${ns}>${base}${styles}</w:styles>`],
  ...extra,
]));

test("unused DOCX gallery styles and next-style suggestions cannot block conversion", () => {
  const r = inspect(style("Unused", font("UnusedTemplateMissing")) +
    style("Active", '<w:next w:val="Unused"/><w:basedOn w:val="Normal"/>' + font("ActiveFont")),
    '<w:pPr><w:pStyle w:val="Active"/></w:pPr>' + run);
  assert.deepEqual([...r.fonts].sort(), ["ActiveFont", "serif"]);
  assert.equal(r.ignoredStyles, 1);
  assert.equal(r.conservativeFallback, false);
});

test("default and document-default fonts remain mandatory without an explicit style reference", () => {
  const r = inspect('<w:docDefaults><w:rPrDefault>' + font("DocumentDefaultMissing") + '</w:rPrDefault></w:docDefaults>' +
    style("DefaultCharacter", font("CharacterDefaultMissing"), 'w:type="character" w:default="on"') +
    style("Unused", font("UnusedMissing")));
  assert(r.fonts.has("DocumentDefaultMissing"));
  assert(r.fonts.has("CharacterDefaultMissing"));
  assert(r.fonts.has("serif"));
  assert(!r.fonts.has("UnusedMissing"));
});

test("paragraph/character/table inheritance, linked styles and cyclic graphs retain all referenced fonts", () => {
  const styles = style("Ancestor", font("AncestorMissing") + '<w:basedOn w:val="Active"/>') +
    style("Active", '<w:basedOn w:val="Ancestor"/><w:link w:val="Linked"/>') +
    style("Linked", font("LinkedMissing"), 'w:type="character"') +
    style("Char", font("CharacterMissing", "hAnsi"), 'w:type="character"') +
    style("Table", '<w:tblStylePr w:type="firstRow">' + font("ConditionalTableMissing") + '</w:tblStylePr>', 'w:type="table"');
  const body = '<w:pPr><w:pStyle w:val="Active"/></w:pPr><w:r><w:rPr><w:rStyle w:val="Char"/></w:rPr><w:t>test</w:t></w:r>' +
    '<w:tbl><w:tblPr><w:tblStyle w:val="Table"/></w:tblPr></w:tbl>';
  const r = inspect(styles, body);
  for (const f of ["AncestorMissing", "LinkedMissing", "CharacterMissing", "ConditionalTableMissing"]) assert(r.fonts.has(f), f);
});

test("header/footer/notes/comments and nested text boxes keep their direct and inherited font checks", () => {
  for (const part of ["header1", "footer1", "footnotes", "endnotes", "comments"]) {
    const r = inspect(style("Extra", font("InheritedMissing")), run, [
      [`word/${part}.xml`, `<w:root ${ns}><w:p><w:pPr><w:pStyle w:val="Extra"/></w:pPr><w:r>${font("DirectMissing")}<w:t>Side text</w:t></w:r></w:p></w:root>`],
    ]);
    assert(r.fonts.has("InheritedMissing"), part);
    assert(r.fonts.has("DirectMissing"), part);
  }
  assert(inspect("", `<w:r><w:drawing><w:txbxContent><w:p><w:r>${font("TextboxMissing")}<w:t>Box</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r>`).fonts.has("TextboxMissing"));
});

test("unknown references, duplicate styles and absent defaults retain complete conservative checks", () => {
  const unused = style("Unused", font("MustNotSkipMissing"));
  const unknown = inspect(unused, '<w:pPr><w:pStyle w:val="Unknown"/></w:pPr>' + run);
  const duplicate = inspect(unused + unused);
  const noDefault = docxFonts(new Map([["word/styles.xml", `<w:styles ${ns}>${unused}</w:styles>`]]));
  for (const r of [unknown, duplicate, noDefault]) {
    assert(r.conservativeFallback);
    assert.equal(r.ignoredStyles, 0);
    assert(r.fonts.has("MustNotSkipMissing"));
  }
});

test("alternate namespace prefixes and XML entities preserve exact active font names", () => {
  const r = docxFonts(new Map([
    ["word/document.xml", '<x:document xmlns:x="urn:fixture"><x:p><x:r><x:rPr><x:rFonts x:ascii="A&amp;B" x:eastAsia="黑体" x:cs="ComplexMissing"/></x:rPr><x:t>Text</x:t></x:r></x:p></x:document>'],
  ]));
  assert.deepEqual([...r.fonts].sort(), ["A&B", "黑体"].sort());
  assert(!r.fonts.has("ComplexMissing"), "Keep the existing explicit font-slot policy");
});

test("active numbering bullets and symbol glyphs are checked; unused numbering templates are excluded", () => {
  const extra = [["word/numbering.xml", `<w:numbering ${ns}><w:abstractNum>${font("BulletMissing")}</w:abstractNum></w:numbering>`]];
  assert(!inspect("", run, extra).fonts.has("BulletMissing"));
  assert(inspect("", '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>' + run, extra).fonts.has("BulletMissing"));
  assert(!inspect("", '<w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr>' + run, extra).fonts.has("BulletMissing"));
  assert(inspect("", '<w:r><w:sym w:font="SymbolMissing" w:char="F0B7"/></w:r>').fonts.has("SymbolMissing"));
});

test("malformed/unsafe style XML fails closed, and unused theme templates remain outside this change", () => {
  assert.throws(() => inspect("", run, [["word/header1.xml", '<!DOCTYPE x [<!ENTITY x "bad">]><x/>']]), /unsafe Office XML/);
  assert.throws(() => inspect("", run, [["word/styles.xml", '<w:styles>']]), /unsafe Office XML/);
  assert(!inspect("", run, [["word/theme/theme1.xml", '<a:theme xmlns:a="urn:a"><a:latin typeface="UnusedThemeMissing"/></a:theme>']]).fonts.has("UnusedThemeMissing"));
});
