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
import { ResearchLedger } from "./ledger.js";
import { ResearchBudget, type AggregateBudget } from "./budget.js";
import { pendingLeads } from "./leads.js";
import type { ResearchEngine, Worker, AgentContext } from "./agent.js";
export interface ServiceOptions {
  dataDir: string;
  resourcesDir: string;
  engine: () => ResearchEngine;
  settings?: ResearchConfig;
  redact?: (e: unknown) => string;
  now?: () => number;
  aggregateBudget?: AggregateBudget;
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
  readonly ledger: ResearchLedger;
  private active?: ActiveState;
  private starting = false;
  private closed = false;
  private now: () => number;
  constructor(private options: ServiceOptions) {
    this.store = new ResearchStore(options.dataDir);
    this.ledger = new ResearchLedger(this.store);
    this.now = options.now ?? Date.now;
  }
  async init() {
    await this.store.init();
    await this.ledger.init();
  }
  private clean(e: unknown) {
    return (
      this.options.redact?.(e) ?? (e instanceof Error ? e.message : String(e))
    );
  }
  async start(endDate = today(), budgetCny = this.options.settings?.budgetCny ?? defaults.budgetCny ?? 3) {
    if (this.closed || this.active || this.starting)
      throw new ResearchError(409, "已有研究运行中或服务正在关闭");
    this.starting = true;
    try {
      if (!Number.isFinite(budgetCny) || budgetCny < .05 || budgetCny > 100) throw new ResearchError(400, "预算须在0.05至100元之间");
      const days = windowDays(endDate);
      if (endDate > today())
        throw new ResearchError(400, "截止日期不能晚于今天");
      const engine = this.options.engine();
      engine.ready();
      const pricing = engine.pricing?.();
      const resourceNames = ["system.md", "SKILL.md", "rubric.md", "reviewer.md", "discovery.md", "selector.md"];
      const rules = await Promise.all(resourceNames.map(f => fs.readFile(path.join(this.options.resourcesDir, "research", f), "utf8")));
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
        rulesHash: hash(JSON.stringify([background, rules, this.options.settings ?? defaults])),
        instructions: Object.fromEntries(resourceNames.map((name,i)=>[name,rules[i]!])),
        ...(pricing ? { budget: { limitCny: budgetCny, pricing, charges: [] } } : {}),
        ...(engine.discover ? { phase: "discovery" as const, batch: 0 } : {}),
        candidates: [],
        coverage: [],
        leads: [],
        checkpoints: [],
        metrics: {
          modelCalls: 0,
          search: 0,
          fetch: 0,
          fetchCalls: 0,
          readableBodies: 0,
          unreadablePages: 0,
          fetchFailures: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
        potentialUsed: false,
        errors: [],
      };
      this.ledger.hydrate(run, run.rulesHash!, this.now());
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
    const adaptive = !!engine.discover;
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
      ledger: this.ledger,
      boundary: () => state.wrapping || (!adaptive && this.now() >= next),
      wrapping: () => state.wrapping,
      save: async () => {
        guard();
        await this.store.saveRun(r);
        await this.ledger.sync(r, r.rulesHash ?? "legacy-unknown");
      },
    };
    if (r.budget) ctx.budget = new ResearchBudget(r.budget, () => this.store.saveRun(r), this.options.aggregateBudget);
    const review = async (final: boolean) => {
      guard();
      r.state = "reviewing";
      if (adaptive) r.phase = "review";
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
              if (!report.incomplete && !adaptive) c.outcome = "审核缺少判定";
              continue;
            }
            try {
              const dateSource = evidence.get(c.article.dateEvidence.evidenceId);
              const dispute = dateSource && this.ledger.unresolvedDate(dateSource,r.rulesHash ?? "legacy-unknown");
              if (dispute && verdict.approve) {
                verdict.approve = false; verdict.checks.dateVerified = false;
                verdict.unresolvedIssues.push("此前披露日期存在未解决疑点；同一版本正文不能在后续运行中直接重新放行，需新的日期依据或规则修订。");
                verdict.reason = "跨次日期疑点未解决：" + dispute.reason;
              }
              if (!verdict.checks.dateVerified) for (const ref of citations(c.article)) {
                const source = evidence.get(ref.evidenceId);
                if (source?.kind === "web") await this.ledger.disputeDate(source,r.rulesHash ?? "legacy-unknown",verdict.reason);
              }
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
              if (!changed && verdict.scores.relevance < 3 && adaptive) {
                const refs = new Set(citations(c.article).map(ref => ref.evidenceId));
                for (const lead of r.leads ?? []) if (lead.evidenceId && refs.has(lead.evidenceId)) {
                  lead.classification = "irrelevant"; lead.reason = verdict.reason;
                }
              }
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
          if (!adaptive && report.potential && !r.potentialUsed) {
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
          if (!adaptive) for (const c of candidates)
            if (!c.outcome) c.outcome = "审核失败，未入库";
        } finally {
          clearTimeout(reviewTimer);
        }
      }
      cp.decisions = candidates.map((c) => {
        const v = cp.review?.verdicts.find((v) => v.candidateId === c.id);
        const score = v ? total(v.scores, cfg.weights) : undefined;
        return {
          candidateId: c.id,
          title: c.article.title,
          status:
            c.outcome === "已入库"
              ? "saved"
              : !c.outcome
                ? "pending"
                : v?.approve &&
                    !v.unresolvedIssues.length &&
                    Object.values(v.checks).every(Boolean) &&
                    score! < cfg.threshold
                  ? "below_threshold"
                  : "rejected",
          score,
          reason: c.outcome ?? "未完成审核，后续继续",
        };
      });
      cp.resultSummary = `Saved ${cp.decisions.filter((d) => d.status === "saved").length}; below score threshold ${cp.decisions.filter((d) => d.status === "below_threshold").length}; rejected ${cp.decisions.filter((d) => d.status === "rejected").length}; pending ${cp.decisions.filter((d) => d.status === "pending").length}.`;
      r.checkpoints.push(cp);
      await this.store.saveRun(r);
      if (!adaptive && !final && !cp.continued)
        this.wrap(
          state,
          cp.error ? "审核失败，保留已审核内容" : "新增有效成果不足，结束研究",
        );
      else if (!final) r.state = "running";
      await this.ledger.sync(r, r.rulesHash ?? "legacy-unknown");
      return cp;
    };
    try {
      if (adaptive) {
        await this.adaptive(state, engine, ctx, guard, review, deadline);
        r.state = "completed";
        return;
      }
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
            actualDecisions: cp.decisions,
            outstandingLeads: pendingLeads(r, 16),
            guidance:
              "优先比较待追查线索与刚投入时间的方向。已有可读正文但尚未提交、同类竞品新品、明确作业部署不要遗漏。不要在单一弱线索上反复补证。",
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
      if (adaptive) r.phase = "done";
      await this.ledger.sync(r, r.rulesHash ?? "legacy-unknown");
      await this.store.saveRun(r);
      if (this.active === state) this.active = undefined;
    }
  }
  private async adaptive(
    state: ActiveState, engine: ResearchEngine, ctx: AgentContext, guard: () => void,
    review: (final: boolean) => Promise<Checkpoint>, deadline: number,
  ) {
    const r = state.run;
    let current = (await this.store.summaries()).filter(i => r.days.includes(i.date) && !i.archived);
    const control = () => ({ remainingMs: Math.max(0, deadline - this.now()), budgetRemainingCny: ctx.budget?.available(r.phase === "discovery" ? "discovery" : "research"), existingItems: current.slice(0,50), existingTotal: current.length });
    r.phase = "discovery";
    let discoveryBudgetHit = false;
    await ctx.save();
    try {
      await engine.discover!(ctx, JSON.stringify({
        task: "轻量检索十四天的新增事件与重要补充，优先覆盖缺口并分类线索。无最低时长，及时finish_phase。旧资料只是参考，不能作为新事实证据。",
        days: r.days, ...control(), coverage: r.reuse?.priorCoverage,
        fullSweepDue: r.reuse?.fullSweepDue, dueScenes: r.reuse?.dueScenes, uncoveredDaysByScene:r.reuse?.gaps,
        priorLeads: (r.leads ?? []).slice(0,60).map(l => ({...l, summary:l.summary.slice(0,250)})),
      }));
    } catch (e) {
      guard();
      if (!/预算|额度/.test(this.clean(e))) throw e;
      discoveryBudgetHit = true;
      r.errors.push(this.clean(e));
    }
    await ctx.save();
    let emptyBatches = 0;
    const attempted = new Set<string>();
    while (!state.wrapping) {
      guard();
      const eligible = pendingLeads(r, 240).filter(l => !attempted.has(l.id));
      let leads = eligible.slice(0,3);
      if (engine.select && eligible.length > 3 && !state.wrapping && (!ctx.budget || ctx.budget.available("discovery") > .03)) {
        r.phase = "discovery";
        try {
          const ids = await engine.select(ctx,eligible.map(l=>l.id));
          guard();
          leads = ids.map(id=>eligible.find(l=>l.id===id)!).filter(Boolean);
          if (!leads.length) { this.wrap(state,"现有线索经业务筛选暂无值得继续核实的方向，保留未处理线索"); break; }
        } catch(e) { guard(); r.errors.push(this.clean(e)); }
      }
      const pending = r.candidates.filter(c => !c.outcome);
      if (!leads.length && !pending.length) {
        this.wrap(state, discoveryBudgetHit ? "发现额度不足以继续调用，仍有方向未检索；不代表没有相关新闻" : "轻量发现完成，无明确新增待追查方向；未充分检索的方向仍保留覆盖缺口");
        break;
      }
      if (ctx.budget && ctx.budget.available("research") < .02) {
        this.wrap(state, "研究预算达到审核预留边界，仍有待研究线索");
        break;
      }
      r.phase = "research"; r.state = "running"; r.batch = (r.batch ?? 0) + 1;
      ctx.batchLeadIds = leads.map(l => l.id);
      const before = r.candidates.length;
      let problem: string | undefined;
      if (leads.length) {
        const worker = await engine.worker(ctx);
        try {
          await worker.step(JSON.stringify({
            task: "只深入本批最多三条线索：核实正文与日期，区分新增/补充/重复，按需读取产品依据，提交完整候选后finish_phase。弱线索不要反复追查，不必用完时间。",
            days:r.days, leads, ...control(), batch:r.batch,
            feedback:r.checkpoints.at(-1)?.decisions,
            unresolvedCandidates: pending.map(c => ({ id:c.id, title:c.article.title })),
          }));
        } catch (e) { guard(); problem = this.clean(e); r.errors.push(problem); }
        finally { await worker.close(); }
      }
      guard();
      if (problem?.includes("候选提交连续两次无效")) problem = undefined;
      for (const l of leads) {
        attempted.add(l.id); l.attemptedAt = new Date(this.now()).toISOString();
        if (l.state !== "submitted") { l.state = "deferred"; l.classification ??= "pending"; l.reason ??= "本批未完成核实，后续运行继续"; }
      }
      let cp = await review(false);
      const changes = [...cp.changes];
      // A factual, relevant story must not be lost just because its prose contains a fixable unsupported flourish.
      const repairIds = cp.review?.verdicts.filter(v => !r.candidates.find(c=>c.id===v.candidateId)?.repairOf &&
        v.checks.readableBody && v.checks.dateVerified && v.checks.businessLink && v.scores.evidence >= 3 &&
        (!v.checks.consistent || !v.checks.productSupported || !v.checks.factsSupported || v.unresolvedIssues.length > 0) && v.scores.relevance >= 3 && total(v.scores,r.config.weights) >= r.config.threshold &&
        !cp.error && !state.wrapping).map(v=>v.candidateId) ?? [];
      if (repairIds.length && (!ctx.budget || ctx.budget.available("research") >= .05)) {
        r.phase = "research"; ctx.repairCandidateIds = repairIds;
        const repairer = await engine.worker(ctx);
        try {
          await repairer.step(JSON.stringify({
            task:"仅修正审核指出的问题，不扩展研究、不联网、不新增事件。删除无证据的事实/修辞、兼容或领先判断，修正引用归因并统一简详版。保留已有证据支持的事实并用原始eventKey重新提交完整候选。每条仅一次修正机会，然后finish_phase。",
            candidates:r.candidates.filter(c=>repairIds.includes(c.id)),
            verdicts:cp.review?.verdicts.filter(v=>repairIds.includes(v.candidateId)),
          }));
        } catch(e) { guard(); r.errors.push(this.clean(e)); }
        finally { ctx.repairCandidateIds = undefined; await repairer.close(); }
        guard();
        if (r.candidates.some(c=>!c.outcome)) { cp = await review(false); changes.push(...cp.changes); }
      }
      current = (await this.store.summaries()).filter(i => r.days.includes(i.date) && !i.archived);
      const progress = changes.filter(c => c.kind === "new" || c.kind === "update").length;
      emptyBatches = progress ? 0 : emptyBatches + 1;
      // A long transcript can be too expensive to reserve even though a fresh short batch still fits.
      if (problem?.includes("剩余额度不足以安全发起模型请求") && progress > 0 && ctx.budget && ctx.budget.available("research") >= .15) problem = undefined;
      cp.continued = !state.wrapping && emptyBatches < 2 && !problem && !cp.error && (pendingLeads(r,240).some(l => !attempted.has(l.id)) || r.candidates.some(c => !c.outcome));
      if (cp.error) this.wrap(state, "审核未完成，保留待审核候选与线索");
      else if (problem && /预算|额度/.test(problem)) this.wrap(state, "预算边界已到，仍有待研究线索");
      else if (problem) this.wrap(state, "本批调用失败，保留待处理线索");
      else if (emptyBatches >= 2) this.wrap(state, "连续两批无合格新增或重要补充，保留其余线索供后续研究");
      // New candidates are limited to three per batch by the tool; no long-lived worker transcript.
      if (r.candidates.length === before && !leads.length) break;
      await ctx.save();
    }
    guard();
    r.phase = "review";
    if (r.candidates.some(c => !c.outcome)) await review(true);
    r.stopReason ??= "本轮研究完成";
    if (r.candidates.some(c => !c.outcome)) r.stopReason += "；仍有待审核候选，未进入正式库";
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
          updatedAfterCutoff: i.version > 1 && localDay(i.updatedAt) > endDate,
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
