// Explicit opt-in real-model validation. Isolated library; reads production knowledge only.
import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";
import { ResearchService } from "../dist/research/service.js";
import { createResearchEngine } from "../dist/research/agent.js";
import { webToolConfig } from "../dist/web-tools/config.js";
import { config, today } from "../dist/research/domain.js";
if (!process.argv.includes("--real"))
  throw new Error("Pass --real to authorize actual model and search calls.");
const cwd = process.cwd();
const env = {
  ...parse(await fs.readFile(path.join(cwd, ".env"), "utf8")),
  ...process.env,
};
const dataDir = path.resolve(env.AGENT_DATA_DIR ?? path.join(cwd, ".data"));
const model = {
  apiKey: env.API_KEY ?? "",
  baseUrl: env.BASE_URL ?? "",
  modelId: env.MODEL_ID ?? "",
  contextWindow: Number(env.CONTEXT_WINDOW ?? 128000),
  maxTokens: Number(env.MAX_TOKENS ?? 16384),
};
const web = webToolConfig({}, model, env);
const output = path.join(
  dataDir,
  "research",
  `validation-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const resourcesDir = path.join(cwd, "resources");
const settings = config(env);
const service = new ResearchService({
  dataDir: output,
  resourcesDir,
  settings,
  engine: () =>
    createResearchEngine({
      dataDir,
      resourcesDir,
      model: () => model,
      web: () => ({ apiKey: web.apiKey }),
    }),
  redact: (e) =>
    String(e instanceof Error ? e.message : e)
      .replaceAll(model.apiKey, "[REDACTED]")
      .replaceAll(web.apiKey, "[REDACTED]"),
});
await service.init();
console.log(
  JSON.stringify({
    validationDirectory: output,
    windowEnd: process.env.RESEARCH_VALIDATE_END ?? today(),
    maxMinutes: settings.maxMs / 60000,
  }),
);
const interval = setInterval(async () => {
  const state = await service.status();
  if (state.active)
    console.log(
      JSON.stringify({
        id: state.active.id,
        state: state.active.state,
        metrics: state.active.metrics,
        pending: state.active.pending,
        checkpoints: state.active.checkpoints.map((c) => ({
          points: c.points,
          continued: c.continued,
          error: c.error,
        })),
      }),
    );
}, 30000);
process.on("SIGINT", () => {
  void service.close();
});
process.on("SIGTERM", () => {
  void service.close();
});
try {
  for (let n = 1; n <= 2; n++) {
    await service.start(process.env.RESEARCH_VALIDATE_END ?? today());
    await service.wait();
    const runs = await service.store.runs();
    const run = runs[0];
    const items = await service.store.items();
    console.log(
      JSON.stringify({
        pass: n,
        state: run.state,
        reason: run.stopReason,
        metrics: run.metrics,
        candidates: run.candidates.map((c) => ({
          title: c.article.title,
          outcome: c.outcome,
        })),
        libraryItems: items.length,
        elapsedMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt),
        errors: run.errors,
      }),
    );
    if (run.state === "failed") break;
  }
} finally {
  clearInterval(interval);
  await service.close();
  console.log(JSON.stringify({ done: true, validationDirectory: output }));
}
