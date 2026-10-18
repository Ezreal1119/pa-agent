// Stdio protocol also runs unchanged inside the network-disabled Linux worker image.
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { setWorkerScope, type WorkerScope } from "./workspace.js";
import { setVisionBridge, type VisionResult } from "./vision-bridge.js";
import { preflightPackage } from "./preflight.js";
import type { RuntimeTool, ToolContext } from "./bridge.js";
import type { FileToolName } from "./config.js";
import path from "node:path";
import { conversionCacheHit } from "./external.js";
import fs from "node:fs/promises";

const send = (message: unknown) => process.stdout.write(JSON.stringify({ protocol: "file-tools/v1", ...message as object }) + "\n");
for (const key of ["log", "info", "warn"] as const) console[key] = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ").slice(0, 1000) + "\n");
const pending = new Map<string, { resolve(value: VisionResult): void; reject(reason: Error): void }>();
setVisionBridge(request => new Promise((resolve, reject) => { const id = randomUUID(); pending.set(id, { resolve, reject }); send({ type: "vision", id, request }); }));
let started = false;
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.length > 25 * 1024 * 1024) process.exit(2);
  let message: any; try { message = JSON.parse(line); } catch { process.exit(2); }
  if (message.type === "vision-result") {
    const waiting = pending.get(message.id); if (!waiting) continue; pending.delete(message.id);
    if (message.error) waiting.reject(new Error(String(message.error))); else waiting.resolve(message.result);
    continue;
  }
  if (started || message.type !== "job") process.exit(2);
  started = true;
  void execute(message).then(async result => {
    const workerPeakBytes = message.scope.config.workerImage ? await fs.readFile("/sys/fs/cgroup/memory.peak", "utf8").then(value => Number(value.trim())).catch(() => undefined) : undefined;
    process.stdout.write(JSON.stringify({ protocol: "file-tools/v1", type: "result", result, peakRssKiB: process.resourceUsage().maxRSS, workerPeakBytes }) + "\n", () => process.exit(0));
  })
    .catch(error => process.stdout.write(JSON.stringify({ protocol: "file-tools/v1", type: "error", error: error instanceof Error ? error.message : "File processing failed." }) + "\n", () => process.exit(0)));
}
async function execute(message: { scope: WorkerScope; name: FileToolName; input: Record<string, unknown> }) {
  const { scope, name, input } = message; if (name === "image_read" && input.region) scope.region = input.region as WorkerScope["region"]; scope.visualRequested = input.visualAnalysis !== undefined && input.visualAnalysis !== "off" && input.visualAnalysis !== false; setWorkerScope(scope);
  const extension = path.extname(scope.input);
  if ([".docx", ".pptx", ".xlsx"].includes(extension)) await preflightPackage(scope.input, extension, scope.config);
  const context: ToolContext = {
    runId: "isolated-file-job", toolOutputMaxChars: scope.config.maxOutputChars, visualEnabled: input.visualAnalysis === true,
    settings: { model: { baseUrl: "", modelName: "" }, visionModel: { mode: "dedicated", baseUrl: "", modelName: "configured-vision" }, execution: { forceFullPdfVisualAnalysis: false, fullPdfVisionBatchPages: 1, fullPdfVisionMaxConcurrentBatches: 1 } },
  };
  let tool: RuntimeTool;
  switch (name) {
    case "pdf_read": tool = (await import("./vendor/pdfTools.js")).readPdfTool; break;
    case "docx_read": tool = (await import("./vendor/docxTools.js")).readDocxTool; break;
    case "pptx_read": tool = (await import("./vendor/pptxTools.js")).readPptxTool; break;
    case "image_read": tool = (await import("./vendor/imageTools.js")).readImageTool; break;
    case "excel_read": tool = (await import("./vendor/excelReadTools.js")).excelReadTool; break;
    case "excel_patch_template": tool = (await import("./vendor/excelTemplateTools.js")).patchWorkbookTemplateTool; break;
    default: throw new Error("Unknown file tool.");
  }
  const result = await tool.execute(input, context);
  if (JSON.stringify(result).length > scope.config.maxOutputChars + 6000) return { ok: false, status: "too_large", error: "File result exceeds the output limit. Use search, offset, slide selection or a smaller worksheet range." };
  return { ...result as object, conversionCacheHit: conversionCacheHit() };
}
