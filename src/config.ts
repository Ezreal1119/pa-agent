import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface PatrickModelConfig {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}

export interface PatrickConfig {
  rootDir: string;
  cwd: string;
  dataDir: string;
  agentDir: string;
  sessionsDir: string;
  resourcesDir: string;
  model: PatrickModelConfig;
}

export interface PatrickConfigOptions {
  cwd?: string;
  dataDir?: string;
  agentDir?: string;
  resourcesDir?: string;
  model?: Partial<PatrickModelConfig>;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInteger(value: number | string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function resolvePatrickConfig(options: PatrickConfigOptions = {}): PatrickConfig {
  const cwd = path.resolve(options.cwd ?? process.env.PI_PATRICK_CWD ?? process.cwd());
  const dataDir = path.resolve(
    options.dataDir ?? process.env.PI_PATRICK_DATA_DIR ?? path.join(cwd, ".data"),
  );
  const baseUrl = required(options.model?.baseUrl ?? process.env.BASE_URL, "BASE_URL").replace(
    /\/+$/,
    "",
  );

  return {
    rootDir: packageRoot,
    cwd,
    dataDir,
    agentDir: path.resolve(options.agentDir ?? path.join(dataDir, "agent")),
    sessionsDir: path.join(dataDir, "sessions"),
    resourcesDir: path.resolve(options.resourcesDir ?? path.join(packageRoot, "resources")),
    model: {
      apiKey: required(options.model?.apiKey ?? process.env.API_KEY, "API_KEY"),
      baseUrl,
      modelId: required(options.model?.modelId ?? process.env.MODEL_ID, "MODEL_ID"),
      contextWindow: positiveInteger(
        options.model?.contextWindow ?? process.env.CONTEXT_WINDOW,
        128_000,
        "CONTEXT_WINDOW",
      ),
      maxTokens: positiveInteger(
        options.model?.maxTokens ?? process.env.MAX_TOKENS,
        16_384,
        "MAX_TOKENS",
      ),
    },
  };
}
