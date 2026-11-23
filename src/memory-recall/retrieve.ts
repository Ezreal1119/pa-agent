import fs from "node:fs/promises";
import { ExtraMemoryStore, parseMemoryEntries } from "../agent/extra-memory.js";
import { mainMemoryFile } from "../agent/memory-paths.js";
import { safePath } from "../knowledge-sync/core.js";

export async function memorySnapshot(dataDir: string) {
  const file = await safePath(mainMemoryFile(dataDir));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Main memory is not a bounded regular file.");
  const [main, extra] = await Promise.all([fs.readFile(file, "utf8"), new ExtraMemoryStore(dataDir).editorSnapshot()]);
  if (!main.trim()) throw new Error("Main memory is empty.");
  return {main, extra};
}
export type MemorySnapshot = Awaited<ReturnType<typeof memorySnapshot>>;
export interface RecallQuery { query: string; background?: string; identifiers?: string[] }
export type MemorySource = "main" | "extra";
interface MemoryExcerpt {
  ref: string;
  id: string;
  source: MemorySource;
  kind: string;
  updated: string;
  excerpt: string;
}

export function memoryEntries(snapshot: MemorySnapshot, source: MemorySource): ReturnType<typeof parseMemoryEntries> {
  const text = source === "main" ? snapshot.main : snapshot.extra.text;
  return parseMemoryEntries(text, source === "main" ? "Main memory" : "Extra memory");
}

export function fullMemory(snapshot: MemorySnapshot): MemoryExcerpt[] {
  return (["main", "extra"] as const).flatMap(source => memoryEntries(snapshot, source).map(entry => ({
    ref: `${source}:${entry.id}`, id: entry.id, source, kind: entry.kind, updated: entry.updated, excerpt: entry.content,
  })));
}
const normalized = (s: string) => s.normalize("NFKC").toLowerCase();
function terms(input: string) {
  const text = normalized(input);
  const result = new Set(text.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? []);
  for (const block of text.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...block];
    if (chars.length === 1) result.add(block);
    for (let i = 1; i < chars.length; i++) result.add(chars[i - 1]! + chars[i]!);
  }
  return result;
}

export function retrieveMemory(snapshot: MemorySnapshot, question: string, query: RecallQuery, limit = 16) {
  const primary = terms(query.query);
  const context = terms([question, query.background ?? ""].join("\n"));
  const identifiers = [...new Set((query.identifiers ?? []).map(normalized).map(s => s.trim()).filter(Boolean))];
  const ranked: {candidate: MemoryExcerpt; score: number}[] = [];
  for (const entry of fullMemory(snapshot)) {
    const body = normalized(entry.excerpt);
    const exactId = primary.has(normalized(entry.id));
    const entryTerms = terms(entry.excerpt);
    const anchor = identifiers.filter(id => /[a-z0-9]/.test(id) ? entryTerms.has(id) : body.includes(id)).length;
    const parts: string[] = [];
    for (let start = 0; start < entry.excerpt.length;) {
      const end = Math.min(start + 2000, entry.excerpt.length);
      const paragraph = end < entry.excerpt.length ? entry.excerpt.lastIndexOf("\n", end) : end;
      const cut = paragraph > start + 1500 ? paragraph : end;
      parts.push(entry.excerpt.slice(start, cut));
      if (cut === entry.excerpt.length) break;
      start = cut - 200;
    }
    const chunks = parts.map((excerpt, index) => {
      const words = terms(excerpt);
      const matches = (queryTerms: Set<string>) => [...queryTerms].reduce((n, t) => n + (words.has(t) ? 1 : 0), 0);
      const score = (exactId ? 180 : 0) + anchor * 20 + matches(primary) * 5 + matches(context);
      return {candidate: {...entry, ref: `${entry.ref}:${index + 1}`, excerpt}, score};
    }).sort((a, b) => b.score - a.score);
    ranked.push(...chunks.slice(0, exactId ? 3 : 2).filter(item => item.score > 1));
  }
  return ranked.sort((a, b) => b.score - a.score || a.candidate.ref.localeCompare(b.candidate.ref)).slice(0, limit).map(item => item.candidate);
}
