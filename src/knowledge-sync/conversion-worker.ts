/** Internal worker: fixed converters only, no model-directed commands. */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { preflightPackage } from "../file-tools/preflight.js";
import type { FileToolConfig } from "../file-tools/config.js";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { decodeOfficeXml } from "../file-tools/office-xml.js";
import {
  omitEmbeddedWorkbooks,
  hasSpreadsheetVisuals,
} from "./office-embeddings.js";
import { tileOffsets } from "./visual-tiles.js";
const request = JSON.parse(
  await new Promise<string>((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => resolve(s));
  }),
);
const { input, dir, config, soffice } = request as {
  input: string;
  dir: string;
  config: FileToolConfig;
  soffice: string;
};
function command(bin: string, args: string[]) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      bin,
      args,
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          LANG: "C.UTF-8",
          TMPDIR: dir,
        },
        timeout: config.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      },
      (e, out, err) =>
        e
          ? reject(
              new Error(
                `Converter ${path.basename(bin)} failed or timed out: ${String(err || e.message).slice(-1600)}`,
              ),
            )
          : resolve(out),
    ),
  );
}
const coverage: string[] = [];
const images: { file: string; label: string }[] = [];
let markdown = "";
const ext = path.extname(input).toLowerCase();
try {
  if ([".docx", ".pptx", ".xlsx"].includes(ext)) {
    await preflightPackage(input, ext, config);
    await normalizeOfficeEncoding();
    const snapshot = await JSZip.loadAsync(await fs.readFile(input));
    const skipped = await omitEmbeddedWorkbooks(snapshot);
    if (skipped.length) {
      for (const name of skipped)
        coverage.push(
          `Skipped embedded XLSX by administrator policy (not read): ${name}`,
        );
      await fs.writeFile(
        input,
        await snapshot.generateAsync({
          type: "nodebuffer",
          compression: "DEFLATE",
        }),
      );
    }
    await inspectOffice();
  }
  if ([".txt", ".md"].includes(ext)) {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(
      await fs.readFile(input),
    );
    if (markdown.includes("\0")) throw new Error("NUL bytes in text.");
    coverage.push("Complete UTF-8 source");
  } else if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    const { loadImage } = await import("@napi-rs/canvas");
    const image = await loadImage(input);
    if (image.width * image.height > config.maxPixels)
      throw new Error(
        `Image ${image.width}×${image.height} exceeds pixel limit ${config.maxPixels}.`,
      );
    await tiles(image, image.width, image.height, "Image");
    coverage.push("Image pixels scheduled for recognition");
  } else {
    let pdf: string | undefined;
    if (ext === ".xlsx") {
      const ExcelJS = (await import("exceljs")).default;
      const book = new ExcelJS.Workbook();
      await book.xlsx.readFile(input);
      let cells = 0;
      if (book.worksheets.length > config.maxSheets)
        throw new Error(
          `Workbook has ${book.worksheets.length} worksheets; limit ${config.maxSheets}.`,
        );
      const sections: string[] = [];
      for (const sheet of book.worksheets) {
        sections.push(
          `## Worksheet: ${sheet.name}\nState: ${sheet.state}\nMerged ranges: ${JSON.stringify(sheet.model.merges ?? [])}`,
        );
        sheet.eachRow((row) =>
          row.eachCell((cell) => {
            if (++cells > config.maxCells)
              throw new Error(
                `Workbook has ${cells} populated cells; limit ${config.maxCells}; worksheet ${sheet.name}.`,
              );
            sections.push(
              `${cell.address}: ${JSON.stringify(cell.value)}${cell.note ? `\nNote: ${JSON.stringify(cell.note)}` : ""}`,
            );
          }),
        );
        coverage.push(
          `Worksheet ${sheet.name}: ${sheet.actualRowCount} populated rows; values/formulas/notes/merges extracted`,
        );
      }
      markdown = sections.join("\n\n");
      const zip = await JSZip.loadAsync(await fs.readFile(input));
      const visuals: string[] = [];
      for (const name of Object.keys(zip.files)) {
        if (
          /^xl\/charts\/[^/]+\.xml$/.test(name) ||
          (/^xl\/drawings\/[^/]+\.xml$/.test(name) &&
            hasSpreadsheetVisuals(await zip.file(name)!.async("string")))
        )
          visuals.push(name);
      }
      if (visuals.length) {
        for (const name of visuals.filter((p) => p.startsWith("xl/charts/")))
          markdown += `\n\n### Chart source ${name}\n\n\`\`\`xml\n${await zip.file(name)!.async("string")}\n\`\`\``;
        // Rendering must not silently omit hidden sheets or a restricted print area.
        const workbook = await zip.file("xl/workbook.xml")!.async("string");
        if (
          /state=["'](?:hidden|veryHidden)["']/.test(workbook) ||
          /_xlnm.Print_Area/.test(workbook)
        )
          throw new Error(
            "Workbook has visual objects with hidden sheets or restricted print areas; review/export an unrestricted copy.",
          );
        for (const name of Object.keys(zip.files).filter((p) =>
          /^xl\/worksheets\/sheet\d+\.xml$/.test(p),
        ))
          if (/hidden=["']1["']/.test(await zip.file(name)!.async("string")))
            throw new Error(
              "Workbook visual coverage cannot be verified with hidden rows/columns.",
            );
        pdf = await office();
        coverage.push(
          `${visuals.length} drawing/chart XML parts; rendered workbook for visual inspection`,
        );
      }
    } else {
      markdown = await command(config.markitdown, [input]);
      if (ext === ".pdf") pdf = input;
      else pdf = await office();
      if (ext === ".pptx") {
        const zip = await JSZip.loadAsync(await fs.readFile(input));
        const slides = Object.keys(zip.files).filter((p) =>
          /^ppt\/slides\/slide\d+\.xml$/.test(p),
        ).length;
        (request as any).expectedPages = slides;
        coverage.push(`${slides} slides, text/tables/speaker notes extracted`);
      }
    }
    if ([".docx", ".pptx"].includes(ext)) markdown += await supplementaryText();
    if (pdf) {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = pdfjs.getDocument({
        data: new Uint8Array(await fs.readFile(pdf)),
        useSystemFonts: true,
        stopAtErrors: true,
      });
      const doc = await task.promise;
      try {
        if (doc.numPages > config.maxPages)
          throw new Error(
            `Document has ${doc.numPages} pages; page limit ${config.maxPages}.`,
          );
        if (request.expectedPages && doc.numPages !== request.expectedPages)
          throw new Error(
            `Rendered slide count ${doc.numPages} differs from source ${request.expectedPages}.`,
          );
        for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
          const page = await doc.getPage(pageNo);
          const viewport = page.getViewport({ scale: 2 });
          if (viewport.width * viewport.height > config.maxPixels)
            throw new Error(
              `Page ${pageNo}: ${Math.ceil(viewport.width)}×${Math.ceil(viewport.height)} exceeds render pixel limit ${config.maxPixels}.`,
            );
          const canvas = createCanvas(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
          await page.render({
            canvasContext: canvas.getContext("2d") as any,
            viewport,
            canvas: canvas as any,
          }).promise;
          await tiles(canvas, canvas.width, canvas.height, `Page ${pageNo}`);
          coverage.push(`Page ${pageNo}/${doc.numPages}: rendered`);
          page.cleanup();
        }
      } finally {
        await task.destroy();
      }
    }
  }
  const skippedNotes = coverage.filter((line) =>
    line.startsWith("Skipped embedded XLSX"),
  );
  if (skippedNotes.length)
    markdown += `\n\n## Conversion scope\n\n${skippedNotes.map((line) => `- ${line}`).join("\n")}\n`;
  if (Buffer.byteLength(markdown) > 32 * 1024 * 1024)
    throw new Error("Extracted Markdown exceeds 32 MiB.");
  await fs.writeFile(path.join(dir, "extracted.md"), markdown, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({ coverage, images, text: "extracted.md" }),
  );
} catch (e) {
  await fs
    .writeFile(path.join(dir, "coverage.json"), JSON.stringify(coverage), {
      mode: 0o600,
    })
    .catch(() => {});
  process.stderr.write(e instanceof Error ? e.message : "Conversion failed");
  process.exitCode = 1;
}
async function office() {
  const profile = path.join(dir, "office-profile");
  await fs.mkdir(path.join(profile, "user"), { recursive: true });
  await fs.writeFile(
    path.join(profile, "user/registrymodifications.xcu"),
    `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateMode" oor:op="fuse"><value>0</value></prop></item></oor:items>`,
  );
  const out = path.join(dir, "rendered");
  await fs.mkdir(out, { recursive: true });
  await command(soffice, [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    "--headless",
    "--nologo",
    "--nodefault",
    "--nofirststartwizard",
    "--convert-to",
    "pdf",
    "--outdir",
    out,
    input,
  ]);
  const file = path.join(out, `${path.basename(input, ext)}.pdf`);
  await fs.access(file);
  return file;
}
async function tiles(
  source: any,
  width: number,
  height: number,
  label: string,
) {
  // Bounded overlapping tiles keep dense source text legible without downsampling.
  const size = 1800;
  for (const y of tileOffsets(height))
    for (const x of tileOffsets(width)) {
      const w = Math.min(size, width - x),
        h = Math.min(size, height - y);
      const canvas = createCanvas(w, h);
      canvas.getContext("2d").drawImage(source, x, y, w, h, 0, 0, w, h);
      const file = `image-${images.length}.png`;
      await fs.writeFile(path.join(dir, file), canvas.toBuffer("image/png"), {
        mode: 0o600,
      });
      images.push({
        file,
        label: `${label}, region x=${x} y=${y} width=${w} height=${h}`,
      });
    }
}

/** Reject active/external package features before LibreOffice can interpret them. */
async function inspectOffice() {
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const fonts = new Set<string>();
  for (const [name, part] of Object.entries(zip.files)) {
    if (
      /(?:vbaProject|activeX|externalLinks)/i.test(name) ||
      (!part.dir && /(?:^|\/)embeddings\//i.test(name))
    )
      throw new Error(
        "Active/embedded/external Office content requires a safe exported copy.",
      );
    if (!/\.(?:xml|rels)$/.test(name)) continue;
    const xml = await part.async("string");
    if (/\b(?:DDEAUTO|DDE|INCLUDEPICTURE|INCLUDETEXT)\b/i.test(xml))
      throw new Error("External Office field detected.");
    if (name.endsWith(".rels")) {
      const parsed = new XMLParser({
        ignoreAttributes: false,
        removeNSPrefix: true,
      }).parse(xml);
      const rels = parsed.Relationships?.Relationship ?? [];
      for (const rel of Array.isArray(rels) ? rels : [rels])
        if (
          rel["@_TargetMode"] === "External" &&
          !String(rel["@_Type"]).endsWith("/hyperlink")
        )
          throw new Error(
            "Externally loaded Office content requires a self-contained copy.",
          );
    }
    // Theme fonts are templates, not necessarily used. Check explicit content fonts.
    if (/(?:document|styles|sheet\d+|slide\d+|notesSlide\d+)\.xml$/.test(name))
      for (const m of xml.matchAll(
        /(?:typeface|w:ascii|w:hAnsi|w:eastAsia)=["']([^"']+)["']/g,
      ))
        if (m[1] && !m[1].startsWith("+")) fonts.add(m[1]);
  }
  for (const font of fonts) {
    if (/^(?:serif|sans-serif|monospace)$/i.test(font)) continue;
    const actual = (
      await command("fc-match", ["--format", "%{family}", font])
    ).trim();
    if (
      !actual
        .toLowerCase()
        .split(",")
        .some((f) => f.trim() === font.toLowerCase())
    )
      throw new Error(
        `Missing source font: ${font}. Install it or provide a verified PDF export.`,
      );
    coverage.push(`Font available: ${font}`);
  }
}
async function supplementaryText() {
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const sections: string[] = [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
  });
  for (const [name, part] of Object.entries(zip.files)) {
    if (
      !/^(?:word|ppt)\/.+\.xml$/.test(name) ||
      /(?:theme|styles|settings|fontTable)/.test(name)
    )
      continue;
    const tokens: string[] = [];
    function visit(value: any, key = "") {
      if (Array.isArray(value)) {
        for (const v of value) visit(v, key);
      } else if (value && typeof value === "object") {
        if (
          ["t", "instrText", "delText"].includes(key) &&
          value["#text"] !== undefined
        )
          tokens.push(String(value["#text"]));
        for (const [k, v] of Object.entries(value)) {
          if (["@_descr", "@_title"].includes(k) && v)
            tokens.push(`Alternative text: ${v}`);
          else visit(v, k);
        }
      } else if (
        ["t", "instrText", "delText"].includes(key) &&
        value !== undefined
      )
        tokens.push(String(value));
    }
    visit(parser.parse(await part.async("string")));
    if (tokens.length) {
      sections.push(`### Structural text: ${name}\n\n${tokens.join("\n\n")}`);
      coverage.push(`${name}: text/notes/alternative text extracted`);
    }
  }
  return sections.length
    ? "\n\n## Supplementary structural text (source order)\n\n" +
        sections.join("\n\n")
    : "";
}

/** Normalize only the private snapshot, preserving support for UTF-16 Office XML. */
async function normalizeOfficeEncoding() {
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  let changed = false;
  for (const [name, part] of Object.entries(zip.files))
    if (/\.(?:xml|rels)$/i.test(name)) {
      const bytes = await part.async("nodebuffer");
      const text = decodeOfficeXml(bytes).replace(
        /(<\?xml\b[^>]*\bencoding\s*=\s*)["'][^"']+["']/i,
        '$1"UTF-8"',
      );
      if (bytes.toString("utf8") !== text) {
        zip.file(name, text);
        changed = true;
      }
    }
  if (changed) {
    await fs.writeFile(
      input,
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
    coverage.push("Office XML encoding normalized in private snapshot");
  }
}
