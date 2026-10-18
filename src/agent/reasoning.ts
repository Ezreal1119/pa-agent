/** DeepSeek's Chat Completions controls; other providers keep their own defaults. */
export const REASONING_MODES = [
  { id: "off", label: "快速", description: "关闭思考，适合明确的单点问题" },
  { id: "low", label: "标准", description: "低强度思考，适合日常产品问答" },
  { id: "high", label: "深入", description: "高强度思考，适合复杂比较和选型" },
  { id: "max", label: "深度研究", description: "最高强度思考，适合全面分析" },
] as const;
export type ReasoningMode = typeof REASONING_MODES[number]["id"];

export function isReasoningMode(value: unknown): value is ReasoningMode {
  return REASONING_MODES.some(mode => mode.id === value);
}

export function isDeepSeekModel(model: { modelId: string; baseUrl: string }): boolean {
  if (/^(?:[^/]+\/)?deepseek(?:-|$)/i.test(model.modelId)) return true;
  try { return new URL(model.baseUrl).hostname.toLowerCase() === "api.deepseek.com"; }
  catch { return false; }
}

export function applyDeepSeekReasoning(payload: unknown, mode: ReasoningMode): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid model request payload.");
  return {
    ...payload,
    thinking: { type: mode === "off" ? "disabled" : "enabled" },
    reasoning_effort: mode === "off" ? "none" : mode,
  };
}
