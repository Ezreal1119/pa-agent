import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import JSZip from "jszip";
import { fixtures } from "./file-fixtures.mjs";
import { createConverter } from "../dist/knowledge-sync/converter.js";
import { fileToolConfig } from "../dist/file-tools/config.js";
import { emptyUsage } from "../dist/knowledge-sync/core.js";

const markitdown =
  process.env.FILE_TEST_MARKITDOWN ||
  path.resolve(".data/file-runtime/bin/markitdown");
const available = await fs.access(markitdown).then(
  () => true,
  () => false,
);
test(
  "native PDF/DOCX/PPTX/image conversion renders all pages; vision coverage, token accounting, cache and failure gates",
  { skip: !available, timeout: 120000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-conversion-"));
    let vision;
    let mode = "complete";
    let calls = 0;
    const sentImages = [],
      sentTexts = [];
    t.after(async () => {
      vision?.closeAllConnections();
      if (vision) await new Promise((r) => vision.close(r));
      await fs.rm(root, { recursive: true, force: true });
    });
    await fixtures(root);
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const picture = await loadImage(path.join(root, "image.png"));
    const canvas = createCanvas(picture.width, picture.height);
    canvas.getContext("2d").drawImage(picture, 0, 0);
    await fs.writeFile(
      path.join(root, "image.jpg"),
      canvas.toBuffer("image/jpeg"),
    );
    await fs.writeFile(
      path.join(root, "image.webp"),
      canvas.toBuffer("image/webp"),
    );
    vision = createServer(async (req, res) => {
      let input = "";
      for await (const c of req) input += c;
      const body = JSON.parse(input);
      assert.match(
        body.messages[1].content[1].image_url.url,
        /^data:image\/png;base64,/,
      );
      const sentImage = await loadImage(
        Buffer.from(
          body.messages[1].content[1].image_url.url.split(",")[1],
          "base64",
        ),
      );
      sentImages.push({ width: sentImage.width, height: sentImage.height });
      sentTexts.push(body.messages[1].content[0].text);
      calls++;
      if (mode === "http-error") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "invalid_image",
              message: "Image rejected; key=fixture",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          usage: { prompt_tokens: 100, completion_tokens: 20 },
          choices: [
            {
              finish_reason: mode === "truncated" ? "length" : "stop",
              message: {
                content: JSON.stringify({
                  complete: mode !== "incomplete",
                  text: "Visual transcription TEST 42",
                  issues: mode === "incomplete" ? ["unreadable region"] : [],
                }),
              },
            },
          ],
        }),
      );
    });
    vision.listen(0, "127.0.0.1");
    await once(vision, "listening");
    const cfg = fileToolConfig(
      path.join(root, ".data"),
      {
        markitdown,
        timeoutMs: 45000,
        vision: {
          baseUrl: `http://127.0.0.1:${vision.address().port}/v1`,
          apiKey: "fixture",
          model: "fixture",
        },
      },
      {},
    );
    const convert = createConverter(
      cfg,
      process.env.SYNC_SOFFICE_COMMAND || "soffice",
      128,
      async () => () => {},
    );
    // Exercise the real worker/canvas and request payloads, not just offset math.
    for (const [width, height, expected] of [
      [1191, 1684, [{ width: 1191, height: 1684 }]],
      [1800, 1800, [{ width: 1800, height: 1800 }]],
      [
        1801,
        1801,
        Array.from({ length: 4 }, () => ({ width: 1800, height: 1800 })),
      ],
      [
        3481,
        1191,
        Array.from({ length: 3 }, () => ({ width: 1800, height: 1191 })),
      ],
    ]) {
      const name = `boundary-${width}-${height}.png`;
      await fs.writeFile(
        path.join(root, name),
        createCanvas(width, height).toBuffer("image/png"),
      );
      const before = sentImages.length;
      await convert(
        path.join(root, name),
        path.join(root, `out-${name}`),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      );
      assert.deepEqual(sentImages.slice(before), expected);
    }
    for (const name of [
      "sample.pdf",
      "sample.docx",
      "sample.pptx",
      "image.png",
      "image.jpg",
      "image.webp",
    ]) {
      const usage = emptyUsage();
      const result = await convert(
        path.join(root, name),
        path.join(root, `out-${name}`),
        new AbortController().signal,
        usage,
        async () => {},
      );
      assert.match(result.markdown, /TEST 42/);
      assert.ok(result.coverage.some((c) => c.endsWith("inspected")));
      assert.ok(usage.input >= 100);
      assert.ok(usage.output >= 20);
      assert.equal(usage.recorded, usage.requests);
      const before = calls;
      await convert(
        path.join(root, name),
        path.join(root, `out-${name}`),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      );
      assert.equal(calls, before);
    }
    const doczip = await JSZip.loadAsync(
      await fs.readFile(path.join(root, "sample.docx")),
    );
    doczip.file(
      "word/comments.xml",
      '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Fixture"><w:p><w:r><w:t xml:space="preserve">COMMENT SENTINEL 123</w:t></w:r></w:p></w:comment></w:comments>',
    );
    const docxml = await doczip.file("word/document.xml").async("string");
    doczip.file(
      "word/document.xml",
      Buffer.from(
        '\ufeff<?xml version="1.0" encoding="UTF-16"?>' + docxml,
        "utf16le",
      ),
    );
    await fs.writeFile(
      path.join(root, "utf16.docx"),
      await doczip.generateAsync({ type: "nodebuffer" }),
    );
    const utf16 = await convert(
      path.join(root, "utf16.docx"),
      path.join(root, "utf16"),
      new AbortController().signal,
      emptyUsage(),
      async () => {},
    );
    assert.match(utf16.markdown, /COMMENT SENTINEL 123/);
    assert.ok(utf16.coverage.some((c) => c.includes("encoding normalized")));
    // Exercise the actual DOCX -> LibreOffice PDF -> vision chain with an
    // unavailable font confined to an unused style, not just the collector.
    const styled = await JSZip.loadAsync(await fs.readFile(path.join(root, "sample.docx")));
    const styleXml = '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:rFonts w:ascii="serif"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="UnusedMissing"><w:rPr><w:rFonts w:ascii="DefinitelyMissingFont987654"/></w:rPr></w:style></w:styles>';
    styled.file("word/styles.xml", styleXml);
    styled.file("[Content_Types].xml", (await styled.file("[Content_Types].xml").async("string")).replace('</Types>', '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'));
    styled.file("word/_rels/document.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    const originalText = await styled.file("word/document.xml").async("string");
    const styledPath = path.join(root, "unused-style.docx");
    await fs.writeFile(styledPath, await styled.generateAsync({ type: "nodebuffer" }));
    const originalBytes = await fs.readFile(styledPath);
    const noUnusedFontFailure = await convert(styledPath, path.join(root, "out-unused-style"), new AbortController().signal, emptyUsage(), async () => {});
    assert.match(noUnusedFontFailure.markdown, /DOCX FILE TOOL TEST 42/);
    assert(noUnusedFontFailure.coverage.some(c => /1 proven-unused styles excluded/.test(c)));
    assert(noUnusedFontFailure.coverage.some(c => c.endsWith("inspected")));
    assert(await fs.stat(path.join(root, "out-unused-style/rendered/source.pdf")));
    assert.deepEqual(await fs.readFile(styledPath), originalBytes, "Uploaded DOCX bytes must never change");

    // The same unavailable font, once referenced through a style, must fail
    // before either rendering or a paid/mock vision request is started.
    styled.file("word/styles.xml", styleXml.replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="Inherited"><w:basedOn w:val="UnusedMissing"/></w:style></w:styles>'));
    styled.file("word/document.xml", originalText.replace('<w:p>', '<w:p><w:pPr><w:pStyle w:val="Inherited"/></w:pPr>'));
    const usedPath = path.join(root, "used-style.docx");
    await fs.writeFile(usedPath, await styled.generateAsync({ type: "nodebuffer" }));
    const beforeFontFailure = calls;
    await assert.rejects(convert(usedPath, path.join(root, "out-used-style"), new AbortController().signal, emptyUsage(), async () => {}), /Missing source font: DefinitelyMissingFont987654/);
    assert.equal(calls, beforeFontFailure);
    assert.equal(await fs.stat(path.join(root, "out-used-style/rendered/source.pdf")).catch(() => null), null);
    doczip.file(
      "word/document.xml",
      docxml.replace(
        "<w:r>",
        '<w:r><w:rPr><w:rFonts w:ascii="DefinitelyMissingFont987654"/></w:rPr>',
      ),
    );
    await fs.writeFile(
      path.join(root, "font.docx"),
      await doczip.generateAsync({ type: "nodebuffer" }),
    );
    await assert.rejects(
      convert(
        path.join(root, "font.docx"),
        path.join(root, "font"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      /Missing source font/,
    );
    const { PDFDocument } = await import("pdf-lib");
    const boundaryPdf = await PDFDocument.create();
    boundaryPdf.addPage([595.5, 842]);
    await fs.writeFile(
      path.join(root, "boundary.pdf"),
      await boundaryPdf.save(),
    );
    const beforeBoundary = sentImages.length;
    await convert(
      path.join(root, "boundary.pdf"),
      path.join(root, "out-boundary-pdf"),
      new AbortController().signal,
      emptyUsage(),
      async () => {},
    );
    assert.deepEqual(sentImages.slice(beforeBoundary), [
      { width: 1191, height: 1684 },
    ]);
    const posterPdf = await PDFDocument.create();
    posterPdf.addPage([4032, 2896]);
    posterPdf.addPage([6000, 4000]);
    const poster = await PDFDocument.create();
    poster.addPage([4032, 2896]);
    await fs.writeFile(path.join(root, "poster.pdf"), await poster.save());
    const beforePoster = sentImages.length;
    const posterResult = await convert(
      path.join(root, "poster.pdf"),
      path.join(root, "out-poster"),
      new AbortController().signal,
      emptyUsage(),
      async () => {},
    );
    assert.ok(
      posterResult.coverage.some((c) => /rendered at 1\.31×/.test(c)),
      posterResult.coverage.join("\n"),
    );
    const posterTiles = sentImages.slice(beforePoster);
    assert.equal(posterTiles.length, 12);
    const [firstTile] = sentTexts.slice(beforePoster);
    assert.match(firstTile, /Full page 1 is 5277×3791 px/);
    assert.match(firstTile, /right, bottom edge\(s\) overlap neighbouring regions/);
    assert.match(firstTile, /left, top edge\(s\) are the real page boundary/);
    assert.match(sentTexts[beforeBoundary], /entire source/);
    assert.ok(posterTiles.every((s) => s.width <= 1800 && s.height <= 1800));
    await fs.writeFile(path.join(root, "huge.pdf"), await posterPdf.save());
    await assert.rejects(
      convert(
        path.join(root, "huge.pdf"),
        path.join(root, "out-huge"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      /Page 2: 6000×4000 pt exceeds render pixel limit 20000000 even at 72 dpi/,
    );
    const scan = await PDFDocument.create();
    const image = await scan.embedPng(
      await fs.readFile(path.join(root, "image.png")),
    );
    scan
      .addPage([300, 200])
      .drawImage(image, { x: 20, y: 20, width: 160, height: 100 });
    await fs.writeFile(path.join(root, "scan.pdf"), await scan.save());
    const scanned = await convert(
      path.join(root, "scan.pdf"),
      path.join(root, "scan"),
      new AbortController().signal,
      emptyUsage(),
      async () => {},
    );
    assert.match(scanned.markdown, /Visual transcription/);
    mode = "http-error";
    await assert.rejects(
      convert(
        path.join(root, "image.png"),
        path.join(root, "http-error"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      (error) => {
        assert.match(error.message, /Vision HTTP 400 at Image, region/);
        assert.match(error.message, /invalid_image; Image rejected/);
        assert.ok(!error.message.includes("fixture"));
        return true;
      },
    );
    assert.ok(await fs.stat(path.join(root, "image.png")));
    await assert.rejects(
      fs.access(path.join(root, "http-error", "conversion.json")),
    );
    mode = "incomplete";
    await assert.rejects(
      convert(
        path.join(root, "image.png"),
        path.join(root, "incomplete"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      /Unresolved visual/,
    );
    mode = "truncated";
    await assert.rejects(
      convert(
        path.join(root, "image.png"),
        path.join(root, "truncated"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      /truncated/,
    );
    const noVision = createConverter(
      { ...cfg, vision: { ...cfg.vision, apiKey: "" } },
      "soffice",
      128,
      async () => () => {},
    );
    await assert.rejects(
      noVision(
        path.join(root, "sample.pdf"),
        path.join(root, "novision"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      /Vision model is required/,
    );
    await assert.rejects(
      convert(
        path.join(root, "sample.xlsx"),
        path.join(root, "hidden"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      /hidden sheets|print areas/,
    );
    const zip = await JSZip.loadAsync(
      await fs.readFile(path.join(root, "sample.docx")),
    );
    zip.file("word/vbaProject.bin", "unsafe");
    const active = path.join(root, "active.docx");
    await fs.writeFile(active, await zip.generateAsync({ type: "nodebuffer" }));
    await assert.rejects(
      convert(
        active,
        path.join(root, "active"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      /Active\/embedded/,
    );
  },
);

test(
  "maintenance converts up to 200 sheets independently of chat and explicitly omits embedded XLSX without opening it",
  { timeout: 30000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worksheets-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const ExcelJS = (await import("exceljs")).default;
    const book = new ExcelJS.Workbook();
    for (let i = 1; i <= 200; i++)
      book.addWorksheet(`Sheet${i}`).getCell("A1").value = `Sentinel ${i}`;
    const source = path.join(root, "many.xlsx");
    await book.xlsx.writeFile(source);
    const zip = await JSZip.loadAsync(await fs.readFile(source));
    // Intentionally unreadable embedded bytes: the policy must not parse them.
    zip.file(
      "xl/embeddings/Workbook1.xlsx",
      Buffer.from("not an Office package"),
    );
    zip.file(
      "xl/worksheets/_rels/sheet1.xml.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdEmbedded" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Workbook1.xlsx"/></Relationships>',
    );
    zip.file(
      "xl/worksheets/sheet1.xml",
      (await zip.file("xl/worksheets/sheet1.xml").async("string")).replace(
        "</worksheet>",
        '<oleObjects><oleObject r:id="rIdEmbedded" progId="Excel.Sheet.12"/></oleObjects></worksheet>',
      ),
    );
    await fs.writeFile(source, await zip.generateAsync({ type: "nodebuffer" }));
    const original = await fs.readFile(source);
    const config = fileToolConfig(
      root,
      { maxSheets: 20, timeoutMs: 15000 },
      {},
    );
    const { preflightPackage } = await import(
      "../dist/file-tools/preflight.js"
    );
    await assert.rejects(
      preflightPackage(source, ".xlsx", config),
      /21 worksheets \(limit 20\)/,
    );
    const convert = createConverter(
      config,
      "unused-soffice",
      128,
      async () => () => {},
    );
    const result = await convert(
      source,
      path.join(root, "work"),
      new AbortController().signal,
      emptyUsage(),
      async () => {},
    );
    assert.match(result.markdown, /Sentinel 200/);
    assert.equal(
      result.coverage.filter((c) => c.startsWith("Worksheet ")).length,
      200,
    );
    assert.match(result.markdown, /Skipped embedded XLSX.*not read/);
    assert.ok(result.coverage.some((c) => c.includes("Workbook1.xlsx")));
    assert.deepEqual(
      await fs.readFile(source),
      original,
      "never modifies original",
    );
    const sanitized = await JSZip.loadAsync(
      await fs.readFile(path.join(root, "work/source.xlsx")),
    );
    assert.equal(sanitized.file("xl/embeddings/Workbook1.xlsx"), null);
    assert.doesNotMatch(
      await sanitized
        .file("xl/worksheets/_rels/sheet1.xml.rels")
        .async("string"),
      /rIdEmbedded/,
    );
    assert.doesNotMatch(
      await sanitized.file("xl/worksheets/sheet1.xml").async("string"),
      /rIdEmbedded/,
    );
    book.addWorksheet("Sheet201").getCell("A1").value = "excess";
    await book.xlsx.writeFile(source);
    await assert.rejects(
      convert(
        source,
        path.join(root, "over"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      /201 worksheets \(limit 200\)/,
    );
    const hostile = await JSZip.loadAsync(original);
    hostile.file("xl/embeddings/unknown.bin", Buffer.from("untrusted"));
    await fs.writeFile(
      source,
      await hostile.generateAsync({ type: "nodebuffer" }),
    );
    await assert.rejects(
      convert(
        source,
        path.join(root, "unsafe"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      /Active\/embedded/,
    );
    const limited = createConverter(
      { ...config, maxCells: 10 },
      "unused",
      128,
      async () => () => {},
    );
    await assert.rejects(
      limited(
        source,
        path.join(root, "cells"),
        new AbortController().signal,
        emptyUsage(),
        async () => {},
      ),
      /XML cells \(limit 10\)/,
    );
  },
);

test("omitting embedded XLSX removes only its exact preview shape and leaves unrelated drawings intact", async () => {
  const { omitEmbeddedWorkbooks, hasSpreadsheetVisuals } = await import(
    "../dist/knowledge-sync/office-embeddings.js"
  );
  const zip = new JSZip();
  zip.file("xl/embeddings/Workbook1.xlsx", "deliberately not parsed");
  zip.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet xmlns:r="http://example/r"><oleObjects><oleObject shapeId="42" r:id="rEmbed"/></oleObjects></worksheet>',
  );
  zip.file(
    "xl/worksheets/_rels/sheet1.xml.rels",
    '<Relationships><Relationship Id="rEmbed" Target="../embeddings/Workbook1.xlsx" Type="http://example/package"/><Relationship Id="rDraw" Target="../drawings/drawing1.xml" Type="http://example/drawing"/></Relationships>',
  );
  zip.file(
    "xl/drawings/drawing1.xml",
    '<xdr:wsDr xmlns:xdr="http://example/drawing"><xdr:sp><xdr:cNvPr id="42" name="embedded icon"/></xdr:sp><xdr:pic><xdr:cNvPr id="43" name="real chart image"/></xdr:pic></xdr:wsDr>',
  );
  zip.file(
    "xl/drawings/drawing2.xml",
    '<xdr:wsDr xmlns:xdr="http://example/drawing"><xdr:sp><xdr:cNvPr id="42" name="other worksheet shape"/></xdr:sp></xdr:wsDr>',
  );
  zip.file(
    "[Content_Types].xml",
    '<Types><Override PartName="/xl/embeddings/Workbook1.xlsx" ContentType="example"/><Override PartName="/xl/workbook.xml" ContentType="example"/></Types>',
  );
  assert.deepEqual(await omitEmbeddedWorkbooks(zip), [
    "xl/embeddings/Workbook1.xlsx",
  ]);
  const drawing = await zip.file("xl/drawings/drawing1.xml").async("string");
  assert.doesNotMatch(drawing, /embedded icon/);
  assert.match(drawing, /real chart image/);
  assert.match(
    await zip.file("xl/drawings/drawing2.xml").async("string"),
    /other worksheet shape/,
  );
  assert.equal(hasSpreadsheetVisuals(drawing), true);
  assert.equal(
    hasSpreadsheetVisuals(
      "<xdr:wsDr><mc:Choice><xdr:twoCellAnchor/></mc:Choice></xdr:wsDr>",
    ),
    false,
  );
  assert.doesNotMatch(
    await zip.file("[Content_Types].xml").async("string"),
    /Workbook1/,
  );
});
