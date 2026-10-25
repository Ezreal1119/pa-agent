import fs from "node:fs/promises";
import path from "node:path";
import { ResearchError } from "./domain.js";
// Explicit read-only roots; no shell, .env, conversations or arbitrary filesystem reads.
export class ResearchKnowledge {
  readonly roots: Record<string, string>;
  constructor(dataDir: string) {
    this.roots = {
      products: path.join(dataDir, "urovo-product-expert"),
      memory: path.join(dataDir, "memory"),
      ums: path.join(dataDir, "ums-expert"),
    };
  }
  async list(root: string, query = "", offset = 0) {
    const base = this.roots[root];
    if (!base) throw new ResearchError(400, "Unknown knowledge root");
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await fs
        .readdir(dir, { withFileTypes: true })
        .catch((err) => {
          if (err.code === "ENOENT") return [];
          throw err;
        })) {
        if (e.isSymbolicLink() || e.name.startsWith(".")) continue;
        const f = path.join(dir, e.name);
        if (e.isDirectory()) await walk(f);
        else if (
          e.name.endsWith(".md") &&
          path.relative(base, f).toLowerCase().includes(query.toLowerCase())
        )
          files.push(path.relative(base, f));
      }
    };
    await walk(base);
    files.sort();
    return {
      files: files.slice(offset, offset + 100),
      total: files.length,
      nextOffset: offset + 100 < files.length ? offset + 100 : null,
    };
  }
  async search(root: string, query: string, offset = 0) {
    const listed = await this.list(root, "", offset);
    const matches = [];
    for (const file of listed.files) {
      const body = await this.read(root, file);
      const index = body.toLowerCase().indexOf(query.toLowerCase());
      if (index >= 0)
        matches.push({
          file,
          offset: Math.max(0, index - 250),
          excerpt: body.slice(Math.max(0, index - 250), index + 1000),
        });
    }
    return {
      matches,
      nextOffset: listed.nextOffset,
      note: "Search excerpts are navigation only; read source to capture citable evidence.",
    };
  }
  async read(root: string, file: string) {
    const base = this.roots[root];
    if (
      !base ||
      path.isAbsolute(file) ||
      !file.endsWith(".md") ||
      file.split(/[\\/]/).some((s) => s === ".." || s.startsWith("."))
    )
      throw new ResearchError(400, "仅允许读取知识根内 Markdown");
    const realBase = await fs.realpath(base);
    const target = await fs.realpath(path.join(base, file));
    if (!target.startsWith(realBase + path.sep))
      throw new ResearchError(403, "知识路径越界");
    const stat = await fs.stat(target);
    if (stat.size > 4 * 1024 * 1024)
      throw new ResearchError(400, "知识文件过大，请选择具体产品页");
    return fs.readFile(target, "utf8");
  }
}
