export interface ResolvedAgentSettings {
  model: { baseUrl: string; modelName: string };
  visionModel: { mode: "primary" | "dedicated"; baseUrl: string; modelName: string };
  execution: { forceFullPdfVisualAnalysis: boolean; fullPdfVisionBatchPages: number; fullPdfVisionMaxConcurrentBatches: number };
}
export interface ToolContext { runId: string; abortSignal?: AbortSignal; settings: ResolvedAgentSettings; toolOutputMaxChars: number; visualEnabled?: boolean; }
export interface RuntimeTool {
  name: string;
  definition: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
  execute(input: unknown, context: ToolContext, details?: { toolCallId: string }): Promise<unknown>;
}
export function redactSecrets(value: string): string {
  return value.replace(/data:image\/[^;]+;base64,[a-z0-9+/=]+/gi, "[IMAGE]").replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 2000);
}
