export type MemoryRecallInputMode = "candidates" | "full";

export interface MemoryRecallOptions {
  enabled?: boolean;
  inputMode?: MemoryRecallInputMode;
  concurrency?: number;
  queueLimit?: number;
  timeoutMs?: number;
  maxDelegations?: number;
}
export function memoryRecallConfig(options: MemoryRecallOptions = {}, env: NodeJS.ProcessEnv = process.env): Required<MemoryRecallOptions> {
  const enabled = options.enabled ?? env.MEMORY_RECALL_ENABLED ?? false;
  if (![true, false, "true", "false"].includes(enabled)) throw new Error("MEMORY_RECALL_ENABLED must be true or false.");
  const inputMode = options.inputMode ?? env.MEMORY_RECALL_INPUT_MODE ?? "full";
  if (inputMode !== "candidates" && inputMode !== "full") throw new Error("MEMORY_RECALL_INPUT_MODE must be candidates or full.");
  const limit = (name: keyof Omit<MemoryRecallOptions, "enabled" | "inputMode">, fallback: number, min: number, max: number) => {
    const value = options[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid memory recall ${name}.`);
    return value;
  };
  return {
    enabled: enabled === true || enabled === "true",
    inputMode,
    concurrency: limit("concurrency", 2, 1, 8),
    queueLimit: limit("queueLimit", 8, 0, 100),
    timeoutMs: limit("timeoutMs", 30000, 100, 180000),
    maxDelegations: limit("maxDelegations", 3, 1, 10),
  };
}
