// Adapted from patrick-agent/src/tools/pptxTools.ts; only requested dependency closure.
import fs from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "../bridge.js";
import { markItDownCommand, markItDownInstallCommand, runExternalProcess } from "../external.js";
import { assertPptxIntegrity, inspectPptxPackage } from "./pptxOoxml.js";
import type { RuntimeTool } from "../bridge.js";
import { isRecord, readOptionalNumber, readOptionalString, readString, resolveReadablePath } from "../workspace.js";

const MAX_PPTX_BYTES = 50 * 1024 * 1024;

const MAX_PPTX_SLIDES = 500;

const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;

const MAX_RETURN_CHARACTERS = 120_000;

const DEFAULT_RETURN_CHARACTERS = 40_000;

const MAX_SEARCH_RESULTS = 50;

const MAX_SELECTED_SLIDES = 50;

const MARKITDOWN_TIMEOUT_MS = 120_000;

const MARKDOWN_CACHE_ENTRIES = 10;

const MARKDOWN_CACHE_BYTES = 30 * 1024 * 1024;

interface MarkdownCacheEntry {
  key: string;
  markdown: string;
  bytes: number;
}

interface SlideSection {
  number: number;
  title: string | null;
  start: number;
  end: number;
  markdown: string;
}

type MarkItDownRunner = (command: string, absolutePath: string) => Promise<string>;

const markdownCache = new Map<string, MarkdownCacheEntry>();

let markdownCacheBytes = 0;

let markItDownRunner: MarkItDownRunner = runMarkItDown;

export const readPptxTool: RuntimeTool = {
  name: "pptx_read",
  definition: {
    type: "function",
    function: {
      name: "pptx_read",
      description: "Read an allowed .pptx presentation as slide-aware bounded Markdown with Microsoft MarkItDown. Supports exact slide selection, full-presentation search, speaker notes, tables, and best-effort chart data extraction.",
      parameters: objectSchema(["path"], {
        path: { type: "string", description: "Existing .pptx path under an allowed workspace root." },
        slideNumbers: { type: "array", maxItems: MAX_SELECTED_SLIDES, items: { type: "integer", minimum: 1 }, description: "Optional exact 1-based slide numbers to read or search. At most 50." },
        query: { type: "string", description: "Optional literal search across the complete converted presentation or selected slides." },
        caseSensitive: { type: "boolean", description: "Whether query matching is case-sensitive. Defaults to false." },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, description: "Maximum search matches. Defaults to 20." },
        offset: { type: "integer", minimum: 0, description: "Character offset for reading a later Markdown segment. Defaults to 0." },
        maxCharacters: { type: "integer", minimum: 1_000, maximum: MAX_RETURN_CHARACTERS, description: "Maximum Markdown characters to return. Defaults to 40000." },
        forceRefresh: { type: "boolean", description: "Ignore the in-process Markdown cache and rerun MarkItDown. Defaults to false." }
      })
    }
  },
  async execute(input) {
    const loaded = await loadPptx(readString(input, "path"));
    const packageReport = await inspectPptxPackage(loaded.resolved.absolutePath);
    assertPptxIntegrity(packageReport);
    if (packageReport.slideCount === 0) throw new Error("PowerPoint presentation contains no slides.");
    if (packageReport.slideCount > MAX_PPTX_SLIDES) {
      throw new Error(`PowerPoint presentation exceeds the ${MAX_PPTX_SLIDES}-slide limit.`);
    }

    const converted = await readMarkdown(loaded, readBoolean(input, "forceRefresh", false));
    const slides = parseSlideSections(converted.markdown);
    if (slides.length !== packageReport.slideCount) {
      throw new Error(
        `MarkItDown returned ${slides.length} slide boundaries for a ${packageReport.slideCount}-slide presentation. `
        + `Verify or upgrade the PPTX dependency with: ${markItDownInstallCommand("pptx")}.`
      );
    }
    const selectedSlideNumbers = readSlideNumbers(input, packageReport.slideCount);
    const scopedSlides = selectedSlideNumbers.length > 0
      ? selectedSlideNumbers.map((number) => slides.find((slide) => slide.number === number) as SlideSection)
      : slides;
    const scopedMarkdown = selectedSlideNumbers.length > 0
      ? `${scopedSlides.map((slide) => slide.markdown.trim()).join("\n\n")}\n`
      : converted.markdown;
    const normalizedScopedSlides = selectedSlideNumbers.length > 0 ? parseSlideSections(scopedMarkdown) : slides;
    const rawQuery = readOptionalString(input, "query");
    const query = rawQuery?.trim();
    if (rawQuery !== undefined && !query) throw new Error("pptx_read.query must not be empty.");
    if (query && query.length > 500) throw new Error("pptx_read.query must contain at most 500 characters.");

    const common = {
      ok: true,
      path: loaded.resolved.displayPath,
      size: loaded.size,
      engine: "markitdown",
      cacheHit: converted.cacheHit,
      slideCount: packageReport.slideCount,
      markdownCharacters: converted.markdown.length,
      markdownBytes: Buffer.byteLength(converted.markdown, "utf8"),
      metadata: packageReport.metadata,
      outline: slides.map((slide) => ({ slideNumber: slide.number, title: slide.title })),
      selectedSlideNumbers: selectedSlideNumbers.length > 0 ? selectedSlideNumbers : null,
      notesSlideCount: packageReport.notesSlideCount,
      embeddedMediaCount: packageReport.embeddedMediaCount,
      embeddedObjectCount: packageReport.embeddedObjectCount,
      externalRelationshipCount: packageReport.externalRelationshipCount,
      hasMacros: packageReport.hasMacros,
      visualContent: {
        status: "not_analyzed",
        images: "alt_text_only",
        layout: "not_preserved",
        animations: "not_supported"
      }
    };

    if (query) {
      const limit = readBoundedInteger(input, "maxResults", 20, 1, MAX_SEARCH_RESULTS);
      const matches = searchSlides(
        normalizedScopedSlides,
        query,
        readBoolean(input, "caseSensitive", false),
        limit
      );
      return {
        ...common,
        mode: "search",
        query,
        searchScope: selectedSlideNumbers.length > 0 ? "selected_slides" : "presentation",
        matches: matches.items,
        truncated: matches.truncated
      };
    }

    const offset = readBoundedInteger(input, "offset", 0, 0, scopedMarkdown.length);
    const maxCharacters = readBoundedInteger(input, "maxCharacters", DEFAULT_RETURN_CHARACTERS, 1_000, MAX_RETURN_CHARACTERS);
    const end = Math.min(offset + maxCharacters, scopedMarkdown.length);
    return {
      ...common,
      mode: "markdown",
      markdown: scopedMarkdown.slice(offset, end),
      range: { start: offset, end },
      returnedSlideNumbers: normalizedScopedSlides
        .filter((slide) => slide.end > offset && slide.start < end)
        .map((slide) => slide.number),
      returnedCharacters: end - offset,
      truncated: end < scopedMarkdown.length,
      nextOffset: end < scopedMarkdown.length ? end : null
    };
  }
};

async function loadPptx(requestedPath: string) {
  const resolved = await resolveReadablePath(requestedPath, { mustExist: true });
  if (path.extname(resolved.absolutePath).toLowerCase() !== ".pptx") {
    throw new Error("PowerPoint tools currently support .pptx files only.");
  }
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) throw new Error("PPTX path must be a regular file.");
  if (stat.size === 0) throw new Error("PPTX file is empty.");
  if (stat.size > MAX_PPTX_BYTES) throw new Error("PPTX exceeds the 50 MiB file limit.");
  return { resolved, size: stat.size, modifiedAtMs: stat.mtimeMs };
}

async function readMarkdown(
  loaded: Awaited<ReturnType<typeof loadPptx>>,
  forceRefresh: boolean
): Promise<{ markdown: string; cacheHit: boolean }> {
  const command = markItDownCommand();
  const key = `${command}\u0000${loaded.resolved.absolutePath}\u0000${loaded.size}\u0000${loaded.modifiedAtMs}`;
  if (!forceRefresh) {
    const cached = markdownCache.get(key);
    if (cached) {
      markdownCache.delete(key);
      markdownCache.set(key, cached);
      return { markdown: cached.markdown, cacheHit: true };
    }
  }
  const markdown = await markItDownRunner(command, loaded.resolved.absolutePath);
  putMarkdownCache({ key, markdown, bytes: Buffer.byteLength(markdown, "utf8") });
  return { markdown, cacheHit: false };
}

async function runMarkItDown(command: string, absolutePath: string): Promise<string> {
  try {
    const { stdout } = await runExternalProcess({
      command,
      args: [absolutePath],
      timeoutMs: MARKITDOWN_TIMEOUT_MS,
      maxOutputBytes: MAX_MARKDOWN_BYTES + 1024,
      missingExecutableMessage: `MarkItDown is not installed. Install it manually with: ${markItDownInstallCommand("pptx")}. The app does not install dependencies automatically.`
    });
    const markdown = stdout.replace(/\u0000/gu, "").replace(/\r\n?/gu, "\n").trim();
    if (!markdown) throw new Error("MarkItDown returned empty Markdown for this PPTX.");
    if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
      throw new Error("MarkItDown output exceeds the 10 MiB limit.");
    }
    return `${markdown}\n`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/MarkItDown is not installed/u.test(message) || /output exceeds|timeout/iu.test(message)) throw error;
    throw new Error(
      `MarkItDown could not convert this PPTX: ${redactSecrets(message)}. `
      + `Verify the PPTX dependency with: ${markItDownInstallCommand("pptx")}.`
    );
  }
}

function parseSlideSections(markdown: string): SlideSection[] {
  const markers = [...markdown.matchAll(/<!--\s*Slide number:\s*(\d+)\s*-->/giu)];
  const slides: SlideSection[] = [];
  const seen = new Set<number>();
  for (const [index, marker] of markers.entries()) {
    const number = Number(marker[1]);
    if (!Number.isInteger(number) || number < 1 || seen.has(number)) {
      throw new Error("MarkItDown returned invalid or duplicate PPTX slide boundaries.");
    }
    seen.add(number);
    const start = marker.index;
    const end = markers[index + 1]?.index ?? markdown.length;
    const slideMarkdown = markdown.slice(start, end);
    const heading = /^#\s+(.+?)\s*$/mu.exec(slideMarkdown);
    slides.push({ number, title: heading?.[1]?.slice(0, 500) ?? null, start, end, markdown: slideMarkdown });
  }
  slides.sort((left, right) => left.number - right.number);
  return slides;
}

function searchSlides(
  slides: SlideSection[],
  query: string,
  caseSensitive: boolean,
  limit: number
): { items: Array<Record<string, unknown>>; truncated: boolean } {
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const items: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (const slide of slides) {
    const haystack = caseSensitive ? slide.markdown : slide.markdown.toLocaleLowerCase();
    let offset = 0;
    while (true) {
      const localIndex = haystack.indexOf(needle, offset);
      if (localIndex < 0) break;
      if (items.length >= limit) {
        truncated = true;
        break;
      }
      const start = Math.max(0, localIndex - 120);
      const end = Math.min(slide.markdown.length, localIndex + query.length + 180);
      items.push({
        slideNumber: slide.number,
        title: slide.title,
        markdownOffset: slide.start + localIndex,
        snippet: `${start > 0 ? "..." : ""}${slide.markdown.slice(start, end).replace(/\s+/gu, " ")}${end < slide.markdown.length ? "..." : ""}`
      });
      offset = localIndex + Math.max(needle.length, 1);
    }
    if (truncated) break;
  }
  return { items, truncated };
}

function readSlideNumbers(input: unknown, slideCount: number): number[] {
  if (!isRecord(input) || input.slideNumbers === undefined) return [];
  if (!Array.isArray(input.slideNumbers)) throw new Error("slideNumbers must be an array of slide numbers.");
  if (input.slideNumbers.length > MAX_SELECTED_SLIDES) {
    throw new Error(`slideNumbers may contain at most ${MAX_SELECTED_SLIDES} values.`);
  }
  if (input.slideNumbers.some((value) => typeof value !== "number" || !Number.isInteger(value))) {
    throw new Error("slideNumbers must contain integers only.");
  }
  const numbers = [...new Set(input.slideNumbers as number[])].sort((left, right) => left - right);
  for (const number of numbers) {
    if (number < 1 || number > slideCount) {
      throw new Error(`Slide ${number} is outside the available range 1-${slideCount}.`);
    }
  }
  return numbers;
}

function putMarkdownCache(entry: MarkdownCacheEntry): void {
  const existing = markdownCache.get(entry.key);
  if (existing) markdownCacheBytes -= existing.bytes;
  markdownCache.delete(entry.key);
  markdownCache.set(entry.key, entry);
  markdownCacheBytes += entry.bytes;
  while (markdownCache.size > MARKDOWN_CACHE_ENTRIES || markdownCacheBytes > MARKDOWN_CACHE_BYTES) {
    const oldestKey = markdownCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = markdownCache.get(oldestKey);
    markdownCache.delete(oldestKey);
    markdownCacheBytes -= oldest?.bytes ?? 0;
  }
}

function readBoundedInteger(input: unknown, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = readOptionalNumber(input, key);
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function readBoolean(input: unknown, key: string, fallback: boolean): boolean {
  if (!isRecord(input) || input[key] === undefined) return fallback;
  if (typeof input[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
  return input[key] as boolean;
}

function objectSchema(required: string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", required, properties, additionalProperties: false };
}
