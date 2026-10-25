import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ResearchStore, hash, manifest, digest, runSummary } from "./store.js";
import {
  defaults,
  total,
  today,
  windowDays,
  terminal,
  scenes,
  citations,
  localDay,
  ResearchError,
  type ResearchConfig,
  type Run,
  type Evidence,
  type Checkpoint,
} from "./domain.js";
import type { ResearchEngine, Worker, AgentContext } from "./agent.js";
export interface ServiceOptions {
  dataDir: string;
  resourcesDir: string;
  engine: () => ResearchEngine;
  settings?: ResearchConfig;
  redact?: (e: unknown) => string;
  now?: () => number;
}
interface ActiveState {
  run: Run;
  controller: AbortController;
  wrapping: boolean;
  wrapDeadline?: number;
  task?: Promise<void>;
}
export class ResearchService {
  readonly store: ResearchStore;
  private active?: ActiveState;
  private starting = false;
  private closed = false;
  private now: () => number;
  constructor(private options: ServiceOptions) {
    this.store = new ResearchStore(options.dataDir);
    this.now = options.now ?? Date.now;
  }
  async init() {
    await this.store.init();
  }
  private clean(e: unknown) {
    return (
      this.options.redact?.(e) ?? (e instanceof Error ? e.message : String(e))
    );
  }
  async start(endDate = today()) {
    if (this.closed || this.active || this.starting)
      throw new ResearchError(409, "已有研究运行中或服务正在关闭");
    this.starting = true;
    try {
      const days = windowDays(endDate);
      if (endDate > today())
        throw new ResearchError(400, "截止日期不能晚于今天");
      const engine = this.options.engine();
      engine.ready();
      const custom = path.join(this.store.root, "urovo-business-context.md");
      const background = await fs.readFile(custom, "utf8").catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return fs.readFile(
          path.join(this.options.resourcesDir, "research/business-context.md"),
          "utf8",
        );
      });
      if (!background.trim() || background.length > 60000)
        throw new ResearchError(400, "业务背景为空或超过60000字");
      const now = new Date(this.now()).toISOString();
      const run: Run = {
        id: randomUUID(),
        endDate,
        days,
        state: "running",
        startedAt: now,
        updatedAt: now,
        config: structuredClone(this.options.settings ?? defaults),
        background,
        backgroundHash: hash(background),
        candidates: [],
        coverage: [],
        checkpoints: [],
        metrics: {
          modelCalls: 0,
          search: 0,
          fetch: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
        potentialUsed: false,
        errors: [],
      };
      await this.store.saveRun(run);
      const state = {
        run,
        controller: new AbortController(),
        wrapping: false,
      } as ActiveState;
      this.active = state;
      state.task = this.execute(state, engine);
      return this.summary(run);
    } finally {
      this.starting = false;
    }
  }
  summary(r: Run) {
    return runSummary(r);
  }
  async status(id?: string) {
    if (id) {
      const r =
        this.active?.run.id === id ? this.active.run : await this.store.run(id);
      if (!r) throw new ResearchError(404, "研究任务不存在");
      return this.summary(r);
    }
    return {
      active: this.active ? this.summary(this.active.run) : null,
      runs: this.store.runSummaries().slice(0, 50),
      scenes,
      defaults: this.options.settings ?? defaults,
    };
  }
  async stop(id: string) {
    if (!this.active || this.active.run.id !== id)
      throw new ResearchError(409, "该任务已结束");
    this.wrap(this.active, "用户要求提前收尾");
    await this.store.saveRun(this.active.run);
    return this.summary(this.active.run);
  }
  private wrap(state: ActiveState, reason: string) {
    if (state.wrapping) return;
    state.wrapping = true;
    state.wrapDeadline = Math.min(
      Date.parse(state.run.startedAt) + state.run.config.maxMs,
      this.now() + state.run.config.wrapMs,
    );
    state.run.state = "wrapping";
    state.run.stopReason = reason;
  }
  private async execute(state: ActiveState, engine: ResearchEngine) {
    const r = state.run;
    const cfg = r.config;
    const start = Date.parse(r.startedAt);
    const deadline = start + cfg.maxMs;
    let next = start + cfg.initialMs;
    let worker: Worker | undefined;
    const guard = () => {
      state.controller.signal.throwIfAborted();
      if (
        this.now() >= deadline ||
        (state.wrapDeadline !== undefined &&
          this.now() >= state.wrapDeadline) ||
        this.closed ||
        this.active !== state
      )
        throw new Error("研究已截止");
    };
    const timer = setInterval(
      () => {
        if (
          this.now() >= deadline ||
          (state.wrapDeadline !== undefined && this.now() >= state.wrapDeadline)
        ) {
          r.stopReason = r.stopReason ?? "达到总时间上限";
          state.controller.abort();
        } else if (this.now() >= deadline - cfg.wrapMs)
          this.wrap(state, "已到收尾时间");
      },
      Math.min(250, cfg.maxMs),
    );
    timer.unref();
    const evidence = new Map<string, Evidence>();
    const ctx: AgentContext = {
      run: r,
      store: this.store,
      evidence,
      signal: state.controller.signal,
      boundary: () => state.wrapping || this.now() >= next,
      wrapping: () => state.wrapping,
      save: async () => {
        guard();
        await this.store.saveRun(r);
      },
    };
    const review = async (final: boolean) => {
      guard();
      r.state = "reviewing";
      await this.store.saveRun(r);
      const candidates = r.candidates.filter((c) => !c.outcome);
      const cp: Checkpoint = {
        at: new Date(this.now()).toISOString(),
        elapsedMs: this.now() - start,
        final,
        points: 0,
        continued: false,
        changes: [],
      };
      if (candidates.length) {
        const controller = new AbortController();
        const reviewTimer = setTimeout(
          () => controller.abort(),
          Math.min(cfg.reviewMs, Math.max(1, deadline - this.now())),
        );
        const signal = AbortSignal.any([
          state.controller.signal,
          controller.signal,
        ]);
        try {
          const report = await engine.review(
            ctx,
            candidates.map((c) => c.id),
            signal,
          );
          if (!report.incomplete) signal.throwIfAborted();
          guard();
          cp.review = report;
          if (report.incomplete)
            cp.error = "审核未全部完成，保留已完成判定，剩余候选待审核";
          const credited = new Set(
            r.checkpoints.flatMap((p) =>
              p.changes.map((c) => c.progressKey ?? c.id),
            ),
          );
          for (const c of candidates) {
            guard();
            const verdict = report.verdicts.find((v) => v.candidateId === c.id);
            if (!verdict) {
              if (!report.incomplete) c.outcome = "审核缺少判定";
              continue;
            }
            try {
              const changed = await this.store.commit(
                r,
                c,
                verdict,
                [...evidence.values()],
                guard,
              );
              c.outcome = changed
                ? "已入库"
                : `未入库（${total(verdict.scores, r.config.weights)} 分，门槛 ${r.config.threshold} 分${verdict.unresolvedIssues?.length ? "，仍有待修正项" : ""}）：${verdict.reason}`;
              if (changed) {
                cp.changes.push(changed);
                if (!credited.has(changed.progressKey ?? changed.id)) {
                  cp.points +=
                    changed.kind === "new"
                      ? changed.score >= 85
                        ? 3
                        : 2
                      : changed.kind === "update"
                        ? 1
                        : 0;
                  credited.add(changed.progressKey ?? changed.id);
                }
              }
            } catch (e) {
              c.outcome = "未入库：" + this.clean(e);
            }
          }
          if (report.potential && !r.potentialUsed) {
            const candidate = candidates.find(
              (c) => c.id === report.potential!.candidateId,
            );
            const verdict = report.verdicts.find(
              (v) => v.candidateId === candidate?.id,
            );
            if (
              candidate &&
              verdict &&
              !verdict.approve &&
              verdict.checks.readableBody &&
              verdict.checks.dateVerified &&
              verdict.checks.businessLink &&
              citations(candidate.article).every((ref) =>
                evidence.has(ref.evidenceId),
              )
            ) {
              cp.points += 2;
              r.potentialUsed = true;
            }
          }
          cp.continued =
            !final &&
            cp.points >= 2 &&
            report.nextDirections.length > 0 &&
            !state.wrapping;
        } catch (e) {
          cp.error = this.clean(e);
          for (const c of candidates)
            if (!c.outcome) c.outcome = "审核失败，未入库";
        } finally {
          clearTimeout(reviewTimer);
        }
      }
      r.checkpoints.push(cp);
      await this.store.saveRun(r);
      if (!final && !cp.continued)
        this.wrap(
          state,
          cp.error ? "审核失败，保留已审核内容" : "新增有效成果不足，结束研究",
        );
      else if (!final) r.state = "running";
      return cp;
    };
    try {
      worker = await engine.worker(ctx);
      const current = (await this.store.summaries()).filter(
        (i) => r.days.includes(i.date) && !i.archived,
      );
      let prompt = JSON.stringify({
        task: "研究十四天 UROVO 业务相关资讯。自由选择检索路径，持续提交候选；每个阶段由后台决定是否继续。先读取产品目录与业务更正。",
        days: r.days,
        existingItems: current.slice(0, 50),
        existingTotal: current.length,
        more:
          current.length > 50
            ? "Use find_library with from/to and offset to read remaining records"
            : null,
        checkpointMs: cfg.initialMs,
        remainingMs: deadline - this.now(),
      });
      while (!state.wrapping) {
        guard();
        await worker.step(prompt);
        guard();
        await this.store.saveRun(r);
        if (state.wrapping) break;
        if (this.now() >= next) {
          const cp = await review(false);
          while (next <= this.now()) next += cfg.checkpointMs;
          prompt = JSON.stringify({
            instruction: "继续研究到下一检查点；补齐缺口并核实重要线索。",
            feedback: cp.review,
            unsearchedScenes: Object.keys(scenes).filter(
              (scene) => !r.coverage.some((c) => c.scene === scene),
            ),
            nextCheckpointMs: Math.max(0, next - this.now()),
            remainingMs: deadline - this.now(),
          });
        } else
          prompt =
            "研究阶段尚未结束。检查已有覆盖与待核实线索，换用合理的新查询或来源，继续提交有证据的候选；不得编造或重复提交已审核事件。";
      }
      guard();
      r.state = "wrapping";
      await this.store.saveRun(r);
      const submissionBudget = Math.max(
        0,
        Math.min(deadline, state.wrapDeadline ?? deadline) -
          this.now() -
          cfg.reviewMs,
      );
      if (submissionBudget > 0)
        await worker.step(
          "现在进入最终收尾：禁止新联网分支，使用已取得证据提交剩余候选和修正，然后 finish_phase。提交阶段最多 " +
            Math.floor(submissionBudget / 1000) +
            " 秒，之后必须进行独立审核。不要生成未审核的最终报告。",
          submissionBudget,
        );
      guard();
      await review(true);
      r.state = "completed";
    } catch (e) {
      r.state = this.closed
        ? "interrupted"
        : state.controller.signal.aborted
          ? "completed"
          : "failed";
      r.errors.push(this.clean(e));
      r.stopReason ??= state.controller.signal.aborted
        ? "已停止，未审核内容不入库"
        : "运行失败";
    } finally {
      clearInterval(timer);
      state.controller.abort();
      await worker?.close().catch(() => {});
      r.finishedAt = new Date(this.now()).toISOString();
      for (const c of r.candidates)
        if (!c.outcome) c.outcome = "未完成审核，未入库";
      await this.store.saveRun(r);
      if (this.active === state) this.active = undefined;
    }
  }
  async browse(endDate: string, count = 14, scene = "", tag = "") {
    const days = windowDays(endDate, count);
    const all = (await this.store.summaries()).filter(
      (i) => days.includes(i.date) && !i.archived,
    );
    const items = all.filter(
      (i) => (!scene || i.scene === scene) && (!tag || i.tags.includes(tag)),
    );
    const runs = this.store.runSummaries();
    const coverage = days.map((date) => ({
      date,
      scenes: Object.keys(scenes).map((scene) => {
        const searched = runs.some((r) =>
          r.coverage.some(
            (c) => c.scene === scene && date >= c.from && date <= c.to,
          ),
        );
        const found = all.filter(
          (i) => i.date === date && i.scene === scene && i.status === "active",
        ).length;
        return {
          scene,
          status: found
            ? "found"
            : searched
              ? "searched_no_qualified"
              : "not_searched",
          count: found,
        };
      }),
    }));
    return {
      days,
      items: items
        .sort((a, b) => b.date.localeCompare(a.date) || b.score - a.score)
        .map((i) => ({
          ...i,
          brief: i.brief,
          tags: i.tags,
          status: i.status,
          updatedAfterCutoff: localDay(i.updatedAt) > endDate,
        })),
      coverage,
    };
  }
  async export(endDate: string, count = 14) {
    const days = windowDays(endDate, count);
    const rows = (await this.store.summaries()).filter(
      (i) => days.includes(i.date) && !i.archived,
    );
    const items = [];
    for (const row of rows) {
      const item = await this.store.item(row.id);
      if (item) items.push(item);
    }
    return digest(items, days);
  }
  async close() {
    this.closed = true;
    const active = this.active;
    if (active) {
      active.controller.abort();
      await active.task;
    }
  }
  async wait() {
    await this.active?.task;
  }
}
