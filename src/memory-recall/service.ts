import path from "node:path";
import fs from "node:fs/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { applyDeepSeekReasoning, isDeepSeekModel } from "../agent/reasoning.js";
import type { AgentConfig } from "../config.js";
import { SubAgentTasks, type ParentBinding, type TaskReceipt } from "../sub-agents/tasks.js";
import { metered, usageScope } from "../usage/ledger.js";
import { visionTokens } from "../web/run-metrics.js";
import { fullMemory, retrieveMemory, type RecallQuery, type MemorySnapshot } from "./retrieve.js";

const submission = Type.Object({
  status: Type.Union([Type.Literal("matched"), Type.Literal("no_match")]),
  evidence: Type.Array(Type.Object({
    ref: Type.String(),
    quote: Type.String({minLength: 1, maxLength: 1800}),
    scope: Type.String({maxLength: 500}),
    relevance: Type.String({minLength: 1, maxLength: 500}),
  }, {additionalProperties: false}), {maxItems: 6}),
  notes: Type.String({maxLength: 1200, description: "Conflicts, missing conditions or why there is no applicable match."}),
}, {additionalProperties: false});

interface Evidence {
  id: string; source: "main" | "extra"; kind: string; updated: string; quote: string; scope: string; relevance: string;
}
export interface RecallResult extends TaskReceipt {
  status: "matched" | "no_match" | "failed" | "cancelled" | "interrupted";
  evidence: Evidence[];
  notes: string;
  candidateIds: string[];
}
export class MemoryRecallService {
  private tasks: SubAgentTasks;
  private prompt?: Promise<string>;
  constructor(private config: AgentConfig) {
    this.tasks = new SubAgentTasks(config.memoryRecall);
  }
  run(parentId: string, question: string, query: RecallQuery, snapshot: MemorySnapshot, binding: ParentBinding, signal?: AbortSignal, notice?: (text: string) => void) {
    return this.tasks.run(parentId, binding, signal, async task => {
      const result: RecallResult = {...task.receipt, status: "failed", evidence: [], notes: "", candidateIds: []};
      const abort = task.signal;
      try {
        await task.enter();
        notice?.("正在查找相关业务记忆…");
        const candidates = this.config.memoryRecall.inputMode === "full" ? fullMemory(snapshot) : retrieveMemory(snapshot, question, query);
        result.candidateIds = candidates.map(candidate => candidate.id);
        if (!candidates.length) {
          result.status = "no_match";
          result.notes = "当前线索未召回候选，可以补充型号、版本或功能名再查。";
          return result;
        }
        const {model, dataDir} = this.config;
        this.prompt ??= fs.readFile(path.join(this.config.resourcesDir, "agents/memory/system.md"), "utf8");
        const payload = {
          model: model.modelId,
          stream: false,
          max_tokens: Math.min(model.maxTokens, 4096),
          response_format: {type: "json_object"},
          messages: [
            {role: "system", content: await this.prompt},
            // Keep the memory prefix independent of the question and parent session for provider caching.
            {role: "user", content: JSON.stringify({memory: candidates})},
            {role: "user", content: JSON.stringify({question, query})},
          ],
        };
        const input = await usageScope({kind: "memory-recall", id: result.taskId}, () => metered(dataDir, "memory-recall", model, async record => {
          abort.throwIfAborted();
          result.usage.requests++;
          const response = await fetch(`${model.baseUrl.replace(/\/chat\/completions$/, "")}/chat/completions`, {
            method: "POST", redirect: "error", signal: abort,
            headers: {Authorization: `Bearer ${model.apiKey}`, "Content-Type": "application/json"},
            body: JSON.stringify(isDeepSeekModel(model) ? applyDeepSeekReasoning(payload, "low") : payload),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Memory recall model request failed.");
          }
          const body = await response.json() as {usage?: unknown; choices?: {finish_reason?: string; message?: {content?: unknown}}[]};
          const tokens = visionTokens(body.usage);
          if (tokens) Object.assign(result.usage, tokens, {reportedRequests: 1});
          await record(body.usage);
          const choice = body.choices?.[0];
          if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") throw new Error("Memory recall did not return complete JSON.");
          return JSON.parse(choice.message.content) as unknown;
        }));
        abort.throwIfAborted();
        if (!Check(submission, input) || (input.status === "matched") !== Boolean(input.evidence.length)) throw new Error("Invalid memory recall result.");
        const sources = new Map(candidates.map(candidate => [candidate.ref, candidate]));
        const evidence = input.evidence.map(({ref, quote, scope, relevance}) => {
          const entry = sources.get(ref);
          if (!entry || !quote.trim() || !entry.excerpt.includes(quote) || !relevance.trim()) throw new Error("Invalid memory citation.");
          const {id, source, kind, updated} = entry;
          return {id, source, kind, updated, quote, scope, relevance};
        });
        Object.assign(result, {status: input.status, notes: input.notes, evidence});
      } catch {
        result.status = task.closing() ? "interrupted" : abort.aborted ? "cancelled" : "failed";
        result.evidence = [];
        result.notes = abort.reason?.name === "TimeoutError" ? "记忆召回超时。" : abort.aborted ? "记忆召回已停止。" : "记忆召回未完成，不能判断是否存在相关记忆。";
      } finally {
        result.elapsedMs = task.elapsed();
      }
      return result;
    });
  }
  deleteParent(id: string) { return this.tasks.deleteParent(id); }
  dispose() { this.tasks.dispose(); }
  close() { return this.tasks.close(); }
}
