import { metered } from "../usage/ledger.js";
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { FileToolConfig, FileToolName } from "./config.js";
import type { WorkerScope } from "./workspace.js";
import type { VisionRequest, VisionResult } from "./vision-bridge.js";

type Waiting = { start(): void; reject(reason: Error): void; signal?: AbortSignal; abort(): void; };
const waiting: Waiting[] = []; let active = false;
export function queueState() { return { active: Number(active), waiting: waiting.length }; }
export async function fileQueue<T>(limit: number, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new Error("File task cancelled.");
  if (active) {
    if (waiting.length >= limit) throw new Error("File task queue is full. Try again later.");
    await new Promise<void>((resolve, reject) => {
      const entry: Waiting = { start: resolve, reject, signal, abort: () => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(new Error("Queued file task cancelled.")); } };
      waiting.push(entry); signal?.addEventListener("abort", entry.abort, { once: true });
    });
  } else active = true;
  try { if (signal?.aborted) throw new Error("File task cancelled."); return await work(); }
  finally { const next = waiting.shift(); if (next) { next.signal?.removeEventListener("abort", next.abort); next.start(); } else active = false; }
}
export interface FileExecution { result: unknown; metrics: { backend: "docker" | "process"; queueMs: number; executionMs: number; peakRssKiB: number; workerPeakBytes?: number; visionCalls: number; visionCacheHits: number; vision: Array<{ model: string; elapsedMs: number; usage?: unknown; cached?: boolean }> }; }
export async function runFileWorker(scope: WorkerScope, name: FileToolName, input: Record<string, unknown>, signal?: AbortSignal, visionHandler?: (request: VisionRequest, signal: AbortSignal) => Promise<VisionResult>, alreadyQueued = false): Promise<FileExecution> {
  const queued = performance.now();
  const schedule = <T>(work: () => Promise<T>) => alreadyQueued ? work() : fileQueue(scope.config.queueLimit, signal, work);
  return schedule(async () => {
    const queueMs = Math.round(performance.now() - queued); const started = performance.now();
    const config = scope.config; const publicConfig = { ...config, dataDir: "", readRoots: [], vision: { ...config.vision, apiKey: "", baseUrl: "" } };
    const workerFile = fileURLToPath(new URL("./worker.js", import.meta.url));
    const container = config.workerImage; const containerName = `expert-file-${randomUUID()}`;
    // An image opts into the container backend; otherwise use a native worker,
    // including on production Linux. Native deployments enforce aggregate
    // resource limits and read-only knowledge mounts through the systemd unit.
    const mappedScope = container ? { ...scope, input: `/job/${path.basename(scope.input)}`, output: `/job/result${path.extname(scope.output)}`, config: { ...publicConfig, markitdown: "markitdown" } } : { ...scope, config: publicConfig };
    const mappedInput = { ...input, ...(name === "excel_patch_template" ? { sourcePath: mappedScope.input, outputPath: mappedScope.output } : { path: mappedScope.input }) };
    const args = container
      ? ["run", "--rm", "--pull", "never", "--interactive", "--name", containerName, "--network", "none", "--memory", "768m", "--memory-swap", "768m", "--cpus", "1", "--pids-limit", "64", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--mount", `type=bind,src=${path.dirname(scope.input)},dst=/job`, container]
      : ["--max-old-space-size=384", workerFile];
    const child = spawn(container ? "docker" : process.execPath, args, { cwd: path.dirname(scope.input), detached: process.platform !== "win32", env: { PATH: process.env.PATH, HOME: path.dirname(scope.input), LANG: "C.UTF-8", TMPDIR: process.env.TMPDIR }, stdio: ["pipe", "pipe", "pipe"] });
    const controller = new AbortController(); const observations: FileExecution["metrics"]["vision"] = []; let visionCalls = 0;
    return new Promise<FileExecution>((resolve, reject) => {
      let settled = false; let stderrBytes = 0; let stdoutBytes = 0; let result: unknown; let peakRssKiB = 0; let workerPeakBytes: number | undefined; let failure: Error | undefined;
      const send = (value: unknown) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + "\n"); };
      child.stdin.on("error", () => {});
      const terminate = () => {
        controller.abort();
        if (container) { const killer = spawn("docker", ["kill", containerName], { stdio: "ignore" }); killer.on("error", () => {}); killer.unref(); }
        try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
      };
      const fail = (message: string) => { failure = new Error(message); terminate(); };
      const abort = () => fail("File task cancelled."); const timer = setTimeout(() => fail("File task timed out."), config.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); };
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) fail("File processor exceeded diagnostic output limit."); });
      child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > 32 * 1024 * 1024) fail("File processor output exceeded limit."); });
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", line => {
        try {
          const message = JSON.parse(line); if (message.protocol !== "file-tools/v1") throw new Error();
          if (message.type === "result") { result = message.result; peakRssKiB = message.peakRssKiB; workerPeakBytes = message.workerPeakBytes; }
          else if (message.type === "error") failure = new Error(String(message.error).slice(0, 1500));
          else if (message.type === "vision") {
            if (++visionCalls > config.vision.maxCalls) { send({ type: "vision-result", id: message.id, error: "Vision call budget exceeded." }); return; }
            void (visionHandler ? visionHandler(message.request, controller.signal) : recognize(config, message.request, controller.signal)).then(value => { observations.push({ model: value.model, elapsedMs: value.elapsedMs, usage: value.usage, cached: value.cached }); send({ type: "vision-result", id: message.id, result: value }); })
              .catch(error => send({ type: "vision-result", id: message.id, error: String(error.message).slice(0, 1000) }));
          } else throw new Error();
        } catch { fail("Invalid file processor response."); }
      });
      child.on("error", () => { cleanup(); if (!settled) { settled = true; reject(new Error("File processor could not start. Build the project and check worker dependencies.")); } });
      child.on("close", code => { cleanup(); if (settled) return; settled = true; if (failure || code !== 0 || result === undefined) reject(failure ?? new Error("File processor exited without a result (possibly a memory limit).")); else resolve({ result, metrics: { backend: container ? "docker" : "process", queueMs, executionMs: Math.round(performance.now() - started), peakRssKiB, workerPeakBytes, visionCalls: observations.filter(value => !value.cached).length, visionCacheHits: observations.filter(value => value.cached).length, vision: observations } }); });
      send({ type: "job", scope: mappedScope, name, input: mappedInput }); if (signal?.aborted) abort();
    });
  });
}
export async function recognize(config: FileToolConfig, request: VisionRequest, signal: AbortSignal): Promise<VisionResult> {
  const vision = config.vision;
  if (!vision.baseUrl || !vision.apiKey || !vision.model) throw new Error("Configure VISION_LLM_BASE_URL, VISION_LLM_API_KEY and VISION_LLM_MODEL for image recognition.");
  const url = new URL(vision.baseUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid vision API root URL.");
  if (!request || typeof request.prompt !== "string" || request.prompt.length > 10_000 || typeof request.systemPrompt !== "string" || request.systemPrompt.length > 10_000 || !Array.isArray(request.images) || request.images.length < 1 || request.images.length > 4 || JSON.stringify(request.images).length > 20 * 1024 * 1024 || request.images.some(image => typeof image.label !== "string" || !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(image.dataUrl))) throw new Error("Invalid vision request.");
  const started = performance.now(); const deadline = AbortSignal.any([signal, AbortSignal.timeout(vision.timeoutMs)]);
  try {
    return await metered(config.dataDir, "vision", {modelId: vision.model, baseUrl: vision.baseUrl}, async record => {
    const response = await fetch(`${vision.baseUrl}/chat/completions`, { method: "POST", redirect: "error", signal: deadline, headers: { Authorization: `Bearer ${vision.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: vision.model, stream: false, max_tokens: 4096, messages: [{ role: "system", content: request.systemPrompt }, { role: "user", content: [{ type: "text", text: request.prompt }, ...request.images.flatMap(image => [{ type: "text", text: image.label }, { type: "image_url", image_url: { url: image.dataUrl } }])] }] }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Vision provider returned HTTP ${response.status}.`); }
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new Error("Vision provider returned no response.");
    for await (const chunk of response.body) { size += chunk.length; if (size > 256 * 1024) throw new Error("Vision response exceeded limit."); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); await record(body.usage); const description = body.choices?.[0]?.message?.content;
    if (typeof description !== "string" || !description.trim()) throw new Error("Vision provider returned no readable description.");
    return { description: description.slice(0, 30_000), model: vision.model, modelRoute: "dedicated", elapsedMs: Math.round(performance.now() - started), usage: body.usage };
    });
  } catch (error) { if (signal.aborted) throw new Error("Image recognition cancelled."); if (deadline.aborted) throw new Error("Image recognition timed out."); const message = error instanceof Error ? error.message : "Image recognition failed."; throw new Error(message.replaceAll(vision.apiKey, "[REDACTED]").slice(0, 1000)); }
}
