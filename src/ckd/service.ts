import fs from "node:fs";
import { acquireLibraryLock } from "./library-lock.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCkdSopV3GraphWorkflow as workflow } from "./workflow.js";
import type { CreateCkdSopGraphInput } from "./contract.js";
import type { GraphNodeExecutionContext, GraphWorkflowNodeDefinition } from "./definition.js";
import type { CkdAgent, CkdEvent, CkdRun, GraphWorkflowNodeRun, JsonValue, WorkflowStepSubmission } from "./types.js";
import { CkdStore, isInside, atomicJson } from "./store.js";
import { assetHashes, defaultResources, executeScript, verifyAssets } from "./scripts.js";
import { PiCkdAgent } from "./agent.js";
import { clarification, validate, validateDecision } from "./validation.js";
import { reviewSopImages } from "./image-quality.js";
import { ImageAssessmentChecker } from "./image-assessment.js";
import { createImageScorer, scoringContext, type ImageScorer, type ImageScorerMode } from './image-scorer.js';
import { cleanupReview, createImageReview, cropOverrides, cropReviewImage, effectiveHashes, reviewImageBytes, verifyReviewSources,repairFailedPreviews } from "./image-review-stage.js";
import type { LibraryModel } from "./library-model.js";

export interface CkdOptions { dataDir?: string; libraryPath?: string; resourcesDir?: string; legacyResourcesDir?: string; agent?: CkdAgent; onEvent?: (event: CkdEvent) => void; agentTimeoutMs?: number; scriptTimeoutMs?: number; imageQualityModel?: LibraryModel; imageQualityTimeoutMs?: number; imageScorer?:ImageScorerMode; imageScorerPython?:string }
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const terminal = new Set(["completed", "terminated", "cancelled"]);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function downloadableResult(run:CkdRun):WorkflowStepSubmission|undefined {
  return run.finalResult ?? ((!run.imageReviewMode || run.imageReview?.approved) ? run.generatedResult : undefined);
}
export class CkdWorkflow {
  readonly store: CkdStore;
  readonly dataDir: string;
  readonly libraryPath: string;
  readonly resourcesDir: string;
  readonly legacyResourcesDir: string | null;
  readonly imageQuality: ImageScorer;
  private readonly agent: CkdAgent;
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly options: CkdOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? process.env.CKD_DATA_DIR ?? path.join(packageRoot, ".data"));
    this.store = new CkdStore(this.dataDir);
    this.libraryPath = path.resolve(options.libraryPath ?? process.env.CKD_LIBRARY ?? path.join(this.dataDir, "ckd/library/ckd-library-v2"));
    this.resourcesDir = path.resolve(options.resourcesDir ?? defaultResources);
    const legacyResourcesDir = options.legacyResourcesDir ?? process.env.CKD_LEGACY_RESOURCES_DIR;
    this.legacyResourcesDir = legacyResourcesDir ? path.resolve(legacyResourcesDir) : null;
    this.agent = options.agent ?? new PiCkdAgent(this.dataDir);
    this.imageQuality = createImageScorer(this.dataDir, { model: options.imageQualityModel, timeoutMs: options.imageQualityTimeoutMs, imageScorer:options.imageScorer, pythonPath:options.imageScorerPython });
  }
  get(id: string): CkdRun { return this.store.get(id); }
  list(): CkdRun[] { return this.store.list(); }
  deleted():CkdRun[]{return this.store.deleted();}
  async trash(id:string){if(this.active.has(id))throw new Error('任务正在运行，暂时不能删除。');await this.store.locked(id,async()=>this.store.trash(id));}
  async restore(id:string){await this.store.locked(id,async()=>this.store.restore(id));return this.get(id);}
  /** Persist the initial task before a local UI starts execution in the background. */
  create(input: CreateCkdSopGraphInput, reviewImages = false): CkdRun {
    validate(workflow.inputSchema, input);
    const inputs = workflow.validateInputs(input);
    const libraryPath = fs.realpathSync(this.libraryPath);
    if (path.basename(libraryPath) !== "ckd-library-v2") throw new Error("Library must be a ckd-library-v2 directory.");
    if (isInside(libraryPath, this.store.root) || isInside(this.store.root, libraryPath)) throw new Error("Library and task directories must be separate.");
    const id = randomUUID(); const now = new Date().toISOString();
    const run: CkdRun = { schemaVersion: 1, id, workflowName: workflow.name, status: "running", currentNodeId: workflow.nodes[0]!.id, inputs, sharedState: {}, nodeOutputs: {}, nodes: [], workspaceRoot: this.store.root, workspaceRelative: id, libraryPath, scriptHashes: assetHashes(this.resourcesDir), createdAt: now, updatedAt: now };
    if (reviewImages) run.imageReviewMode = 1;
    const imageContext=scoringContext(this.imageQuality);
    this.store.save(run);
    atomicJson(path.join(run.workspaceRoot,run.workspaceRelative,'outputs/image-quality-context.json'),{...imageContext,ruleVersion:imageContext.analysisVersion});
    return run;
  }
  async start(input: CreateCkdSopGraphInput): Promise<CkdRun> {
    return this.resume(this.create(input).id);
  }
  async resume(id: string): Promise<CkdRun> {
    return this.store.locked(id, async () => {
      const run = this.get(id);
      if (terminal.has(run.status)) { if (run.imageReview) cleanupReview(run); return run; }
      if (this.store.cancelled(id)) { run.status = "cancelled"; cleanupReview(run); delete run.pendingQuestion; this.store.save(run); return run; }
      if(run.status==='awaiting_image_review'){if(await repairFailedPreviews(run))this.store.save(run);return run;}
      if (run.pendingQuestion) return run;
      run.status = "running"; delete run.error;
      const releaseLibrary = acquireLibraryLock(run.libraryPath);
      try { return await this.drive(run); } finally { releaseLibrary(); }
    });
  }
  async answer(id: string, questionId: string, text: string): Promise<CkdRun> {
    return this.store.locked(id, async () => {
      const run = this.get(id); const question = run.pendingQuestion;
      if (!question || question.id !== questionId || run.status !== "awaiting_clarification") throw new Error("This question is no longer awaiting an answer (duplicate or stale answer).");
      if (this.store.cancelled(id)) throw new Error("Cancellation has been requested for this task.");
      const releaseLibrary = acquireLibraryLock(run.libraryPath);
      try {
        text = text.trim();
        if (text.length > 12000 || (question.answerRequired && !text) || (!question.allowFreeText && !question.options.includes(text))) throw new Error("Answer must be nonempty and use one of the offered options when free text is disabled.");
        const node = this.node(run); const nodeRun = this.nodeRun(run, question.nodeRunId);
        if (question.kind === "agent") {
          const checkpoint = run.agentCheckpoint;
          if (!checkpoint || checkpoint.nodeRunId !== nodeRun.id || checkpoint.action?.kind !== "clarify") throw new Error("The saved Pi question has no matching session checkpoint.");
          checkpoint.answer = { questionId, question: question.question, text }; delete checkpoint.action;
        } else {
          if (!node.resolveClarification) throw new Error("Node does not accept deterministic answers.");
          const resolution = node.resolveClarification(text, { run, nodeRun, toolCallId: questionId });
          this.complete(run, nodeRun, resolution.result);
          run.stageCommitted = !resolution.repeatNode;
        }
        const savedQuestion = nodeRun.questions?.find(item => item.id === questionId);
        if (savedQuestion) savedQuestion.answer = text;
        delete run.pendingQuestion; run.status = "running"; nodeRun.status = question.kind === "agent" ? "running" : "completed";
        this.store.save(run);
        return await this.drive(run);
      } finally { releaseLibrary(); }
    });
  }
  image(id: string, imageId: string, original = false): Buffer { return reviewImageBytes(this.get(id), imageId, original); }
  async crop(id: string, input: Record<string, unknown>): Promise<CkdRun> {
    return this.store.locked(id, async () => {
      const run = this.get(id); this.checkImageRevision(run, input);
      if (typeof input.imageId !== "string") throw new Error("图片编号无效。");
      await cropReviewImage(run, input.imageId, input.rect);
      if (this.store.cancelled(id)) { cleanupReview(run); throw new Error("任务已取消。"); }
      this.store.save(run); return run;
    });
  }
  async generate(id: string, input: Record<string, unknown>): Promise<CkdRun> {
    return this.store.locked(id, async () => {
      const run = this.get(id); this.checkImageRevision(run, input);
      const releaseLibrary = acquireLibraryLock(run.libraryPath);
      try {
        this.resourcesFor(run); verifyReviewSources(run); cropOverrides(run);
        run.imageReview!.approved = true; run.status = "running"; delete run.error; this.store.save(run);
        return await this.drive(run);
      } finally { releaseLibrary(); }
    });
  }
  private checkImageRevision(run: CkdRun, input: Record<string, unknown>) {
    if (this.store.cancelled(run.id) || run.status !== "awaiting_image_review" || !run.imageReview || run.imageReview.approved || input.reviewId !== run.imageReview.id || input.revision !== run.imageReview.revision) throw new Error("图片确认已改变或任务已结束，请刷新后重试。");
  }
  async cancel(id: string): Promise<CkdRun> {
    const before = this.get(id);
    if (terminal.has(before.status)) return before;
    this.store.requestCancel(id); this.active.get(id)?.abort(new Error("CKD execution cancelled."));
    try { return await this.store.locked(id, async () => { const run = this.get(id); run.status = "cancelled"; cleanupReview(run); delete run.pendingQuestion; this.store.save(run); return run; }); }
    catch (error) { if (/task is busy/u.test(message(error))) return this.get(id); throw error; }
  }
  private node(run: CkdRun): GraphWorkflowNodeDefinition {
    const node = workflow.nodes.find(item => item.id === run.currentNodeId);
    if (!node) throw new Error("Unknown CKD workflow stage."); return node;
  }
  private nodeRun(run: CkdRun, id: string): GraphWorkflowNodeRun {
    const node = run.nodes.find(item => item.id === id); if (!node) throw new Error("Unknown CKD stage invocation."); return node;
  }
  private complete(run: CkdRun, nodeRun: GraphWorkflowNodeRun, result: WorkflowStepSubmission, final = false): CkdRun {
    nodeRun.status = "completed"; nodeRun.result = result; delete nodeRun.error;
    run.nodeOutputs[nodeRun.nodeId] = result; Object.assign(run.sharedState, result.statePatch ?? {});
    run.stageCommitted = true;
    if (final) { run.status = "completed"; run.finalResult = result; delete run.generatedResult; delete run.currentNodeId; }
    return run;
  }
  private async runAgent(run: CkdRun, signal: AbortSignal): Promise<boolean> {
    const checkpoint = run.agentCheckpoint!;
    if (!checkpoint.action) {
      const controller = new AbortController();
      const forward = () => controller.abort(signal.reason); signal.addEventListener("abort", forward, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error("CKD model node timed out.")), this.options.agentTimeoutMs ?? 300000);
      try {
        signal.throwIfAborted();
        // A rejecting race also bounds injected adapters; native Pi additionally aborts the provider.
        await Promise.race([
          this.agent.execute({ run, checkpoint, signal: controller.signal, persist: () => {
            controller.signal.throwIfAborted();
            if (checkpoint.sessionFile) this.nodeRun(run, checkpoint.nodeRunId).sessionFile = checkpoint.sessionFile;
            this.store.save(run);
          }, onEvent: this.options.onEvent }),
          new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
        ]);
      } finally { clearTimeout(timeout); signal.removeEventListener("abort", forward); }
    }
    signal.throwIfAborted();
    const node = this.node(run); const nodeRun = this.nodeRun(run, checkpoint.nodeRunId); const action = checkpoint.action;
    if (!action) throw new Error("No structured protocol action was saved.");
    if (action.kind === "clarify") {
      const question = clarification(action.question);
      run.pendingQuestion = { ...question, id: randomUUID(), nodeRunId: nodeRun.id, kind: "agent" };
      (nodeRun.questions ??= []).push(run.pendingQuestion);
      run.status = nodeRun.status = "awaiting_clarification"; this.store.save(run); this.emit(run, "question", question.question); return false;
    }
    if (action.kind === "terminate") {
      run.status = nodeRun.status = "terminated"; run.error = action.reason; delete run.agentCheckpoint; this.store.save(run); return false;
    }
    validate(checkpoint.request.outputSchema, action.output); validateDecision(run, node.id, action.output);
    if (!node.structuredResult) throw new Error("Node does not accept structured results.");
    this.complete(run, nodeRun, node.structuredResult(action.output, { run, nodeRun }));
    delete run.agentCheckpoint; this.store.save(run); return true;
  }
  private resourcesFor(run: CkdRun): string {
    try { verifyAssets(run, this.resourcesDir); return this.resourcesDir; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "Workflow assets changed since this task started. Start a new task." || !this.legacyResourcesDir) throw error;
      verifyAssets(run, this.legacyResourcesDir);
      return this.legacyResourcesDir;
    }
  }
  private context(run: CkdRun, signal: AbortSignal, resources: string): GraphNodeExecutionContext {
    const persist = () => this.store.save(run);
    const createNodeRun = (input: Record<string, JsonValue>): GraphWorkflowNodeRun => {
      const item: GraphWorkflowNodeRun = { id: randomUUID(), nodeId: run.currentNodeId!, input, status: "running" }; run.nodes.push(item); persist(); return item;
    };
    const script = (request: Parameters<typeof executeScript>[1]) => executeScript(run, request, { resources, signal, timeoutMs: this.options.scriptTimeoutMs });
    return {
      run, createNodeRun, executeScript: script,
      executeScriptNode: async request => {
        const nodeRun = createNodeRun(request.values);
        if (request.final && run.imageReviewMode === 1) {
          if (!run.imageReview) {
            const prepared = await script({ ...request, id: nodeRun.nodeId + ":prepare-images", final: false,
              values: { ...request.values, prepareImagesOnly: true }, outputSchema: { type: "object", required: ["processReviews", "generation"] } });
            const hashes = effectiveHashes(run);
            const reviewed = await this.reviewImages(run, prepared, resources, signal);
            run.imageReview = await createImageReview(run, reviewed, request.values, hashes, signal);
            verifyReviewSources(run); run.status = nodeRun.status = "awaiting_image_review"; persist(); return false;
          }
          if (!run.imageReview.approved) { run.status = "awaiting_image_review"; persist(); return false; }
          verifyReviewSources(run);
          const prepared = run.imageReview.prepared.output as Record<string, JsonValue>;
          const result = await script({ ...request, id: nodeRun.nodeId + ":confirmed-images", values: { ...run.imageReview.values,
            preparedGeneration: prepared, imageOverrides: cropOverrides(run), imageReviewRevision: run.imageReview.revision } });
          signal.throwIfAborted(); this.complete(run, nodeRun, result, true); persist(); cleanupReview(run); return true;
        }
        let result = await script({ ...request, id: nodeRun.nodeId });
        if (request.final) {
          // The generator receipt and workbook exist before the independent report.
          run.generatedResult = result; persist();
          result = await this.reviewImages(run, result, resources, signal);
        }
        this.complete(run, nodeRun, result, request.final); persist(); return true;
      },
      runStructured: async (nodeRunId, request) => {
        run.agentCheckpoint = { nodeRunId, request: { task: request.task, outputSchema: request.outputSchema, outputDescription: request.outputDescription } }; persist(); return this.runAgent(run, signal);
      },
      requestClarification: (nodeRunId, request) => {
        const question = clarification(request);
        run.pendingQuestion = { ...question, id: randomUUID(), nodeRunId, kind: "deterministic" };
        (this.nodeRun(run, nodeRunId).questions ??= []).push(run.pendingQuestion);
        run.status = this.nodeRun(run, nodeRunId).status = "awaiting_clarification"; persist(); this.emit(run, "question", question.question); return false;
      },
      completeNode: (nodeRunId, result, final) => { this.complete(run, this.nodeRun(run, nodeRunId), result, final); persist(); return run; },
      patchSharedState: patch => { Object.assign(run.sharedState, patch); persist(); return run; },
      failNode: (nodeRunId, error) => { const item = this.nodeRun(run, nodeRunId); item.status = run.status = "failed"; item.error = run.error = message(error); persist(); return run; },
    };
  }
  private emit(run: CkdRun, type: CkdEvent["type"], text: string) { this.options.onEvent?.({ runId: run.id, type, message: text }); }
  private reviewImages(run:CkdRun,result:WorkflowStepSubmission,resources:string,signal:AbortSignal) {
    const startedAt=new Date().toISOString();
    return reviewSopImages(run,result,this.imageQuality,resources,signal,text=>this.emit(run,'stage',text),progress=>{
      run.imageCheck={...progress,status:'running',startedAt,updatedAt:new Date().toISOString()};this.store.save(run);
    }).then(reviewed=>{
      if(run.imageCheck){run.imageCheck.status='completed';run.imageCheck.updatedAt=new Date().toISOString();this.store.save(run);}
      return reviewed;
    });
  }
  private async drive(run: CkdRun): Promise<CkdRun> {
    const controller = new AbortController(); this.active.set(run.id, controller);
    const cancelled = () => { if (this.store.cancelled(run.id)) controller.abort(new Error("CKD execution cancelled.")); };
    const poll = setInterval(cancelled, 100); cancelled();
    try {
      const resources = this.resourcesFor(run);
      while (!terminal.has(run.status) && !run.pendingQuestion) {
        controller.signal.throwIfAborted();
        if (run.stageCommitted) {
          run.currentNodeId = workflow.nextNode(run, run.currentNodeId!); delete run.stageCommitted;
          if (!run.currentNodeId) { run.status = "completed"; this.store.save(run); break; }
          this.store.save(run);
        }
        const node = this.node(run); this.emit(run, "stage", node.title);
        const advanced = run.agentCheckpoint ? await this.runAgent(run, controller.signal) : await node.execute(this.context(run, controller.signal, resources));
        controller.signal.throwIfAborted();
        if (!advanced || run.status === "failed") break;
      }
    } catch (error) {
      run.status = this.store.cancelled(run.id) ? "cancelled" : "failed"; run.error = message(error);
      if(run.imageCheck?.status==='running'){run.imageCheck.status=run.status==='cancelled'?'cancelled':'failed';run.imageCheck.error=run.error;run.imageCheck.updatedAt=new Date().toISOString();}
      const latest = run.nodes.at(-1); if (latest?.status === "running") { latest.status = run.status; latest.error = run.error; }
      this.store.save(run);
      if (run.status === "cancelled") cleanupReview(run);
    } finally { clearInterval(poll); this.active.delete(run.id); }
    this.emit(run, "status", run.status); return run;
  }
}
