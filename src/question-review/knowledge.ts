import fs from "node:fs/promises";
import path from "node:path";
import { safe } from "./store.js";
import { ReviewError } from "./types.js";
import { scrub } from "./privacy.js";

export class ReviewKnowledge {
  private files?: { root: string; file: string }[];
  readonly roots: Record<string, string>;
  constructor(dataDir: string) { this.roots = { products: path.join(dataDir, "urovo-product-expert"), memory: path.join(dataDir, "memory"), ums: path.join(dataDir, "ums-expert") }; }
  async catalog() {
    if (this.files) return this.files;
    const result: { root: string; file: string }[] = [];
    for (const [root, base] of Object.entries(this.roots)) {
      const walk = async (dir: string) => {
        await safe(dir);
        for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === "ENOENT") return []; throw e; })) {
          if (item.isSymbolicLink() || item.name.startsWith(".") || item.name === "newly_added") continue;
          const file = path.join(dir, item.name);
          if (item.isDirectory()) await walk(file);
          else if (item.isFile() && item.name.endsWith(".md")) result.push({ root, file: path.relative(base, file) });
          if (result.length > 20000) throw new ReviewError(413, "Knowledge catalog exceeds review limit");
        }
      }; await walk(base);
    }
    this.files = result.sort((a, b) => a.file.localeCompare(b.file)); return this.files;
  }
  async publicProducts() {
    const products = new Set<string>();
    for (const item of await this.catalog()) {
      if (item.root !== "products") continue;
      const parts = item.file.split(path.sep);
      if (parts[0] === "product-knowledge-vault" && parts[1] === "products") products.add(path.basename(item.file, ".md").toLowerCase());
      else if (parts.length > 1 && !parts[0]!.startsWith("_") && parts[0] !== "product-knowledge-vault") products.add(parts[0]!.toLowerCase());
    }
    return products;
  }
  async read(root: string, file: string, offset = 0) {
    const base = this.roots[root];
    if (!base || path.isAbsolute(file) || file.split(/[\\/]/).some(p => !p || p === ".." || p.startsWith(".")) || !file.endsWith(".md") || file.split(/[\\/]/).includes("newly_added")) throw new ReviewError(400, "Invalid knowledge reference");
    const target = path.join(base, file); await safe(target);
    const stat = await fs.stat(target); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new ReviewError(413, "Knowledge source unavailable or too large");
    const body = await fs.readFile(target, "utf8");
    return { root, file, text: body.slice(offset, offset + 10000), nextOffset: offset + 10000 < body.length ? offset + 10000 : null, basis: "current_knowledge_not_historical_snapshot" };
  }
  async search(query: string, offset = 0) {
    if (!query.trim() || query.length > 120) throw new ReviewError(400, "Invalid knowledge query");
    const catalog = await this.catalog(), matches: unknown[] = [];
    const named = catalog.filter(item => item.file.toLowerCase().includes(query.toLowerCase()));
    const pool = named.length ? named : catalog;
    for (const item of pool.slice(offset, offset + 100)) {
      try {
        const page = await this.read(item.root, item.file), at = page.text.toLowerCase().indexOf(query.toLowerCase());
        if (at >= 0 || item.file.toLowerCase().includes(query.toLowerCase())) matches.push({ ...item, excerpt: at >= 0 ? scrub(page.text.slice(Math.max(0, at - 150), at + 650)) : "Filename match; read the source" });
      } catch { /* Unreadable sources never become evidence of absence. */ }
    }
    return { matches: matches.slice(0, 12), nextOffset: offset + 100 < pool.length ? offset + 100 : null, totalFiles: catalog.length, searchedPool: pool.length, exhaustive: false };
  }
}
