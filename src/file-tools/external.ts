import { spawn } from "node:child_process";
import { workerScope } from "./workspace.js";
import fs from "node:fs/promises";
import path from "node:path";
let cacheHit = false;
export const conversionCacheHit = () => cacheHit;
export function markItDownCommand(): string { return workerScope().config.markitdown; }
export function markItDownInstallCommand(extra: string): string { return `Install the pinned conversion environment: python3 -m pip install 'markitdown[${extra}]==0.1.8'`; }
export async function runExternalProcess(options: { command: string; args: string[]; timeoutMs: number; maxOutputBytes: number; missingExecutableMessage: string; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw new Error("File conversion cancelled.");
  const cachedPath = path.join(path.dirname(workerScope().input), "converted.md");
  try { const stat = await fs.lstat(cachedPath); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= options.maxOutputBytes) { cacheHit = true; return { stdout: await fs.readFile(cachedPath, "utf8"), stderr: "" }; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "VIRTUAL_ENV"].includes(key)));
    Object.assign(env, { OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" });
    const child = spawn(options.command, options.args, { shell: false, env, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0; let reason: string | undefined; const out: Buffer[] = []; const err: Buffer[] = [];
    const stop = (message: string) => { reason = message; child.kill("SIGKILL"); };
    const abort = () => stop("File conversion cancelled.");
    const timer = setTimeout(() => stop("File conversion timed out."), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    const append = (target: Buffer[], chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxOutputBytes) stop("Conversion output exceeds limit."); else target.push(chunk); };
    child.stdout.on("data", chunk => append(out, chunk)); child.stderr.on("data", chunk => append(err, chunk));
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.on("error", error => { cleanup(); reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? options.missingExecutableMessage : "Conversion process could not start.")); });
      child.on("close", code => { cleanup(); if (reason || code !== 0) reject(new Error(reason ?? (Buffer.concat(err).toString("utf8").slice(-1200) || "File conversion failed."))); else { const stdout = Buffer.concat(out).toString("utf8"); void fs.writeFile(cachedPath, stdout, { mode: 0o600, flag: "wx" }).then(() => resolve({ stdout, stderr: Buffer.concat(err).toString("utf8") }), reject); } });
  });
}
