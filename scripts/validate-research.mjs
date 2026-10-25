// Explicit opt-in real-model validation. Isolated library; reads production knowledge only.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { ResearchService } from "../dist/research/service.js";
import { createResearchEngine } from "../dist/research/agent.js";
import { webToolConfig } from "../dist/web-tools/config.js";
import { budgetTotals } from "../dist/research/budget.js";
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
  aggregateBudget: {file:path.join(dataDir,"research/validation-budget-adaptive-v1.json"),limitCny:9},
  engine: () =>
    createResearchEngine({
      dataDir,
      resourcesDir,
      model: () => model,
      web: () => ({ apiKey: web.apiKey }),
      pricing:env.RESEARCH_PRICING_JSON ? JSON.parse(env.RESEARCH_PRICING_JSON) : undefined,
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
        phase:state.active.phase,
        budget:state.active.budget,
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
const passes = Number(
  process.argv.find((v) => v.startsWith("--passes="))?.split("=")[1] ?? 2,
);
if (![1, 2, 3].includes(passes)) throw new Error("--passes must be 1, 2 or 3");
const budget = Number(process.argv.find(v=>v.startsWith("--budget="))?.split("=")[1] ?? settings.budgetCny ?? 3);
const seedPath = process.argv.find(v=>v.startsWith("--seed-library="))?.slice("--seed-library=".length);
const baseline = seedPath ? (await fs.readdir(seedPath)).filter(f=>f.endsWith(".json")).sort() : [];
const stages = baseline.length && passes === 3 ? ["empty", "partial", "full"] : Array.from({length:passes},(_,i)=>i ? "incremental" : "empty");
try {
  for (let n = 1; n <= passes; n++) {
    const stage = stages[n-1];
    if (stage === "partial" || stage === "full") {
      const selected = stage === "full" ? baseline : baseline.slice(0,Math.ceil(baseline.length/2));
      for (const file of selected) {
        const target = path.join(service.store.root,"library/items",file);
        // Validation-only seeding from previously reviewed local corpus. Never publishes to the live library.
        try { await fs.copyFile(path.join(seedPath,file),target,constants.COPYFILE_EXCL); } catch(e) { if(e.code!=="EEXIST") throw e; }
      }
      await service.store.index();
    }
    await service.start(process.env.RESEARCH_VALIDATE_END ?? today(),budget);
    await service.wait();
    const runs = await service.store.runs();
    const run = runs[0];
    const items = await service.store.items();
    await fs.writeFile(
      path.join(output, `report-pass-${n}.md`),
      await service.export(run.endDate),
    );
    console.log(
      JSON.stringify({
        pass: n,
        stage,
        budget:run.budget ? budgetTotals(run.budget) : undefined,
        state: run.state,
        reason: run.stopReason,
        metrics: run.metrics,
        candidates: run.candidates.map((c) => ({
          title: c.article.title,
          outcome: c.outcome,
        })),
        libraryItems: items.length,
        leads: {
          total: run.leads?.length ?? 0,
          unread: run.leads?.filter((l) => l.state === "unread").length ?? 0,
        },
        report: path.join(output, `report-pass-${n}.md`),
        elapsedMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt),
        errors: run.errors,
      }),
    );
    if (run.state === "failed" || run.state === "interrupted") break;
  }
} finally {
  clearInterval(interval);
  await service.close();
  console.log(JSON.stringify({ done: true, validationDirectory: output }));
}
