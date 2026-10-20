import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
/** Filter before searching, not after returning snippets containing unpublished material. */
export function publishedSearchTools(cwd: string): ToolDefinition<any, any>[] {
  const run = (args: string[], signal?: AbortSignal) =>
    new Promise<string>((resolve, reject) =>
      execFile(
        "rg",
        args,
        {
          cwd,
          shell: false,
          signal,
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024,
        },
        (e, out) => {
          if (e && (e as any).code !== 1)
            reject(
              new Error(
                "Search failed or exceeded its bounded output. Narrow the search.",
              ),
            );
          else resolve(out);
        },
      ),
    );
  const exclusions = [
    "--glob",
    "!**/.git/**",
    "--glob",
    "!**/newly_added/**",
    "--glob",
    "!**/knowledge-sync/**",
  ];
  const grep = createGrepToolDefinition(cwd),
    find = createFindToolDefinition(cwd),
    ls = createLsToolDefinition(cwd);
  grep.execute = async (_id, a, signal) => {
    const args = [
      "--no-heading",
      "--line-number",
      "--color",
      "never",
      "--hidden",
    ];
    if (a.ignoreCase) args.push("-i");
    if (a.literal) args.push("-F");
    if (a.glob) args.push("--glob", a.glob);
    if (a.context)
      args.push("-C", String(Math.min(10, Math.max(0, Math.floor(a.context)))));
    args.push(...exclusions, "--", a.pattern, path.resolve(cwd, a.path ?? "."));
    const lines = (await run(args, signal)).split("\n");
    const n = Math.min(500, Math.max(1, a.limit ?? 100));
    return {
      content: [
        {
          type: "text",
          text:
            lines.slice(0, n).join("\n").slice(0, 50000) +
            (lines.length > n ? "\n[Truncated; narrow the search.]" : ""),
        },
      ],
      details: {},
    };
  };
  find.execute = async (_id, a, signal) => {
    const text = await run(
      [
        "--files",
        "--hidden",
        "--glob",
        a.pattern,
        ...exclusions,
        "--",
        path.resolve(cwd, a.path ?? "."),
      ],
      signal,
    );
    return {
      content: [
        {
          type: "text",
          text: text
            .split("\n")
            .slice(0, Math.min(1000, a.limit ?? 100))
            .join("\n")
            .slice(0, 50000),
        },
      ],
      details: {},
    };
  };
  ls.execute = async (_id, a) => {
    const entries = await fs.readdir(path.resolve(cwd, a.path ?? "."), {
      withFileTypes: true,
    });
    const visible = entries.filter(
      (e) =>
        !e.name.startsWith(".") &&
        !["newly_added", "knowledge-sync"].includes(e.name) &&
        !e.isSymbolicLink(),
    );
    return {
      content: [
        {
          type: "text",
          text: visible
            .slice(0, a.limit ?? 500)
            .map((e) => e.name + (e.isDirectory() ? "/" : ""))
            .join("\n"),
        },
      ],
      details: {},
    };
  };
  return [grep, find, ls];
}
