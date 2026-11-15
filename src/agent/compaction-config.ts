export interface ChatCompactionConfig { enabled: boolean; triggerTokens: number; keepRecentRounds: number; }

export function chatCompactionConfig(options: Partial<ChatCompactionConfig> = {}, env: Record<string, string | undefined> = process.env, model?: {contextWindow: number; maxTokens: number}): ChatCompactionConfig {
  const enabled = options.enabled ?? env.CHAT_COMPACTION_ENABLED ?? false;
  if (![true, false, "true", "false"].includes(enabled)) throw new Error("CHAT_COMPACTION_ENABLED must be true or false.");
  const value = {
    enabled: enabled === true || enabled === "true",
    triggerTokens: Number(options.triggerTokens ?? env.CHAT_COMPACTION_TRIGGER_TOKENS ?? 384000),
    keepRecentRounds: Number(options.keepRecentRounds ?? env.CHAT_COMPACTION_KEEP_RECENT_ROUNDS ?? 5),
  };
  for (const [name, n] of [["CHAT_COMPACTION_TRIGGER_TOKENS", value.triggerTokens], ["CHAT_COMPACTION_KEEP_RECENT_ROUNDS", value.keepRecentRounds]] as const) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive safe integer.`);
  }
  if (value.enabled && model && value.triggerTokens >= model.contextWindow - model.maxTokens - 16384) throw new Error("CHAT_COMPACTION_TRIGGER_TOKENS must be below CONTEXT_WINDOW - MAX_TOKENS - 16384.");
  return value;
}
