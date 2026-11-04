import fs from "node:fs/promises";
import path from "node:path";
import type { ModelConfig } from "../config.js";
import { configureUsagePricing } from "../usage/ledger.js";
import { ReviewStore } from "./store.js";
import { executeReview } from "./engine.js";

const controller = new AbortController();
let stop: "cancelled" | "interrupted" | "partial" = "interrupted", started = false;
process.on("SIGTERM", () => controller.abort()); process.on("SIGINT", () => controller.abort());
process.on("disconnect", () => { controller.abort(); if (!started) process.exit(0); });
process.on("message", async (message: any) => {
  if (message?.operation === "cancel") { stop = "cancelled"; controller.abort(); return; }
  if (message?.operation === "timeout") { stop = "partial"; controller.abort(); return; }
  if (message?.operation !== "run" || started) return;
  started = true;
  const { dataDir, resourcesDir, runId, model, pricing } = message as { dataDir: string; resourcesDir: string; runId: string; model: ModelConfig; pricing?: string };
  const store = new ReviewStore(dataDir), run = await store.get(runId);
  const timer = setTimeout(() => { stop = "partial"; controller.abort(); }, run.settings.maxDurationMs);
  configureUsagePricing(dataDir, pricing);
  try {
    await executeReview({ dataDir, resourcesDir, run, model, signal: controller.signal });
  } catch {
    run.status = controller.signal.aborted ? stop : run.coverage.reviewed ? "partial" : "failed";
    run.reason = controller.signal.aborted ? stop === "partial" ? "评审达到时间上限，已保留完成批次。" : "评审已停止，已保留完成批次。" : "模型、用量限额或评审校验未完成；已保留完成批次，请检查配置或重试。";
    run.finishedAt = new Date().toISOString(); await store.save(run);
  } finally {
    clearTimeout(timer);
    // The ephemeral SDK directories never contain persisted conversation logs.
    await fs.rm(path.join(store.root, "runtime"), { recursive: true, force: true }).catch(() => {});
    process.send?.({ operation: "finished" }); process.disconnect?.();
  }
});
