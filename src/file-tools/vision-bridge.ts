import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { ResolvedAgentSettings } from "./bridge.js";
import { workerScope } from "./workspace.js";
import { inspectImageHeader, validateImageStructure } from "./vendor/imageTools.js";

export interface VisionRequest { systemPrompt: string; prompt: string; images: readonly { label: string; dataUrl: string }[]; }
export interface VisionResult { description: string; model: string; modelRoute: "dedicated"; usage?: unknown; elapsedMs: number; cached?: boolean; }
let invoke: ((request: VisionRequest) => Promise<VisionResult>) | undefined;
export function setVisionBridge(handler: (request: VisionRequest) => Promise<VisionResult>) { invoke = handler; }
export async function analyzeVisualContent(input: VisionRequest & { settings: ResolvedAgentSettings; signal?: AbortSignal; maxRetries?: number; timeoutMs?: number }) {
  if (!invoke) throw new Error("Vision service is unavailable.");
  const { config, region } = workerScope(); let total = 0;
  const processedImages: Array<Record<string, unknown>> = [];
  const images: Array<{ label: string; dataUrl: string }> = [];
  for (const image of input.images) {
    const match = /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/=]+)$/i.exec(image.dataUrl);
    if (!match || match[2]!.length > Math.ceil(config.maxFileBytes / 3) * 4 + 8) throw new Error("Unsupported or oversized image payload.");
    const bytes = Buffer.from(match[2]!, "base64"); total += bytes.length;
    if (total > config.maxFileBytes) throw new Error("Combined image payload exceeds file limit.");
    const metadata = inspectImageHeader(bytes);
    if (!metadata || metadata.width * metadata.height > config.maxPixels || metadata.width < 1 || metadata.height < 1) throw new Error("Image dimensions exceed limits.");
    validateImageStructure(bytes, metadata.format);
    const decoded = await loadImage(bytes);
    if (decoded.width !== metadata.width || decoded.height !== metadata.height) throw new Error("Image dimensions are inconsistent.");
    if (region && (region.left + region.width > decoded.width || region.top + region.height > decoded.height)) throw new Error("Image region is outside the original image.");
    const sourceWidth = region?.width ?? decoded.width; const sourceHeight = region?.height ?? decoded.height;
    const scale = Math.min(1, 2048 / Math.max(sourceWidth, sourceHeight), Math.sqrt(4_000_000 / (sourceWidth * sourceHeight)));
    const width = Math.max(1, Math.round(sourceWidth * scale)); const height = Math.max(1, Math.round(sourceHeight * scale));
    let dataUrl = image.dataUrl;
    if (scale < 1 || region) { const canvas = createCanvas(width, height); const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, width, height); ctx.drawImage(decoded, region?.left ?? 0, region?.top ?? 0, sourceWidth, sourceHeight, 0, 0, width, height); dataUrl = `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`; }
    processedImages.push({ label: image.label, originalWidth: decoded.width, originalHeight: decoded.height, width, height, resized: scale < 1, ...(region ? { region } : {}) });
    images.push({ label: image.label, dataUrl });
  }
  const result = await invoke({ systemPrompt: input.systemPrompt, prompt: input.prompt, images });
  return { ...result, processedImages };
}
