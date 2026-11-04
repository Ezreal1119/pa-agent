import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import ExcelJS from "exceljs";
import { CkdWorkflow } from "../src/ckd/service.js";
import { ckdExtension, CKD_TOOL_NAMES } from "../src/ckd/agent.js";
import { AgentRuntime } from "../src/agent/runtime.js";
import { CkdStore } from "../src/ckd/store.js";
import { executeScript, defaultResources } from "../src/ckd/scripts.js";
import { validateDecision } from "../src/ckd/validation.js";
import type { AgentExecution, CkdAgent, CkdRun, JsonValue } from "../src/ckd/types.js";

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ckd-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, "library/ckd-library-v2");
  for (const id of ["TARGET", "SOURCE"]) write(path.join(library, "product_lib", id, "project.json"), JSON.stringify({ version: 1, projectId: id, displayName: `${id} Project`, aliases: [id] }));
  for (const type of ["assemble", "assembly_test", "pcba_test", "aging_test", "factory_test"]) {
    for (const id of ["TARGET", "SOURCE"]) write(path.join(library, "product_lib", id, type, "sops.json"), JSON.stringify({ version: 1, sops: [{ sopId: `${id}_sop`, displayName: `${id} SOP`, aliases: [], description: "Checks", processSequence: ["first", "second"] }] }));
    for (const chinese of [false, true]) for (const [id, label] of [["first", "First"], ["second", "Second"]]) {
      const location = type === "assemble" ? path.join(library, "product_lib/TARGET", type, chinese ? "CN_process" : "processes", id!) : path.join(library, "processes_lib", type, ...(chinese ? ["CN_process"] : []), id!);
      write(path.join(location, "metadata.txt"), `${label} Check\n`);
      write(path.join(location, type === "assemble" ? "Operation_Instruction.txt" : "operation_steps.txt"), `${chinese ? "中文操作" : "ENGLISH OPERATION"} ${label}\n`);
      write(path.join(location, "overview.txt"), `${label} check overview\n`);
    }
  }
  fs.mkdirSync(path.join(library, "processes_lib/assemble"), { recursive: true });
  return { root, library, dataDir: path.join(root, "data") };
}
const base = { projectName: "TARGET", documentNumber: "TEST-001", sopName: "Checks", author: "Patrick Xu" };
function project(run: CkdRun): JsonValue { return { requestedProjectName: String(run.inputs.projectName), matchedProjectId: "TARGET", matchedProjectName: "TARGET Project", status: "user_selected", confidence: 1, comment: "用户确认" }; }
function selection(run: CkdRun, id = "TARGET"): JsonValue {
  const catalog = run.nodeOutputs["prepare-catalog"]!.output as any;
  const sop = catalog.sopCatalogSummary.sops.find((item: any) => item.projectId === id);
  return { mode: "reference", requestedSopName: String(run.inputs.sopName), referenceSopId: sop.sopId, referenceSopName: sop.displayName, referenceProjectId: id, referenceProjectName: `${id} Project`, processList: sop.processSequence.map((item: any) => item.displayName), referenceProcessIds: sop.processSequence.map((item: any) => item.processId), comment: "用户确认" };
}
function processes(run: CkdRun): JsonValue {
  const normalized = run.sharedState.normalizedInputs as any;
  return { processes: normalized.processList.map((name: string, index: number) => ({ requestedProcess: name, resolvedProcessId: index === 0 ? "first" : "second", resolvedProcessName: index === 0 ? "First Check" : "Second Check", overview: "检查", status: "direct", sourceProjectId: "TARGET", sourceProjectName: "TARGET Project", confidence: 1, comment: "已确认", semanticMatch: "equivalent", semanticReason: "动作和对象相同", warnings: [] })) };
}
const deterministicAgent: CkdAgent = { async execute({ run, checkpoint, persist }) { checkpoint.action = { kind: "submit", output: run.currentNodeId === "resolve-project" ? project(run) : run.currentNodeId === "select-sop-source" ? selection(run) : processes(run) }; persist(); } };
async function answerFirst(service: CkdWorkflow, run: CkdRun) { return service.answer(run.id, run.pendingQuestion!.id, run.pendingQuestion!.options[0]!); }

test("new tasks use current assets while pending tasks may resume only from their exact archived assets", t => {
  const f = fixture(t), current = path.join(f.root, "current-assets"), legacy = path.join(f.root, "legacy-assets");
  write(path.join(current, "script.txt"), "old"); write(path.join(legacy, "script.txt"), "old");
  const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, resourcesDir: current, legacyResourcesDir: legacy });
  const old = service.create(base);
  const resourcesFor = (service as unknown as { resourcesFor(run: CkdRun): string }).resourcesFor.bind(service);
  assert.equal(resourcesFor(old), current);
  write(path.join(current, "script.txt"), "new");
  assert.equal(resourcesFor(old), legacy);
  const fresh = service.create(base);
  assert.equal(resourcesFor(fresh), current);
  write(path.join(legacy, "script.txt"), "tampered");
  assert.throws(() => resourcesFor(old), /Workflow assets changed/u);
});

test("a pending SOP finishes with its archived scripts after current scripts change", async t => {
  const f = fixture(t), current = path.join(f.root, "current-workflow"), legacy = path.join(f.root, "legacy-workflow");
  fs.symlinkSync(path.resolve("node_modules"), path.join(f.root, "node_modules"), "dir");
  fs.cpSync(defaultResources, legacy, { recursive: true });
  fs.cpSync(legacy, current, { recursive: true });
  const before = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, resourcesDir: legacy, agent: deterministicAgent });
  let run = await before.start(base);
  assert.equal(run.status, "awaiting_clarification");
  write(path.join(current, "new-version-marker.txt"), "new");
  const after = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, resourcesDir: current, legacyResourcesDir: legacy, agent: deterministicAgent });
  run = await after.answer(run.id, run.pendingQuestion!.id, "参考 Library 中已有 SOP");
  assert.equal(run.status, "completed", run.error);
  assert.notDeepEqual(after.create(base).scriptHashes, run.scriptHashes);
});

test("independent service freezes exact project, persists questions, rejects duplicate answers and restores manual process order", async t => {
  const f = fixture(t); let service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: deterministicAgent });
  let run = await service.start(base); assert.equal(run.status, "awaiting_clarification"); assert.equal(run.nodes.filter(n => n.nodeId === "resolve-project").length, 1);
  const oldQuestion = run.pendingQuestion!.id;
  service = new CkdWorkflow({ dataDir: f.dataDir, agent: deterministicAgent }); // Library comes from persisted task, not constructor defaults.
  run = await service.answer(run.id, oldQuestion, "手动输入 SOP Processes");
  await assert.rejects(service.answer(run.id, oldQuestion, "手动输入 SOP Processes"), /duplicate or stale/u);
  run = await service.answer(run.id, run.pendingQuestion!.id, "First Check\nSecond Check");
  if (run.pendingQuestion) run = await answerFirst(service, run);
  assert.equal(run.status, "completed", run.error); assert.equal(run.sharedState.processResolutionRoute, "semantic-agent");
  assert.deepEqual((run.sharedState.normalizedInputs as any).processList, ["First Check", "Second Check"]);
  assert.equal(service.list().length, 1);
  const artifact = path.resolve(run.workspaceRoot, run.finalResult!.artifacts[0]!);
  assert(fs.existsSync(artifact)); const before = fs.readFileSync(artifact); await service.resume(run.id); assert.deepEqual(fs.readFileSync(artifact), before);
  assert.ok((run.finalResult!.output as any).reviewSummary); assert.equal((run.finalResult!.output as any).processReviews.length, 2);
});

test("semantic clarification survives process restart and resumes the matching saved checkpoint", async t => {
  const f = fixture(t); let calls = 0;
  const asking: CkdAgent = { async execute(input) {
    calls++;
    if (!input.checkpoint.answer) { input.checkpoint.sessionFile = path.join(f.root, "fake-session.jsonl"); input.checkpoint.action = { kind: "clarify", question: { question: "请选择目标项目。", options: ["TARGET Project (TARGET)"], allowFreeText: false, answerRequired: true } }; }
    else { assert.equal(input.checkpoint.sessionFile, path.join(f.root, "fake-session.jsonl")); assert.equal(input.checkpoint.answer.text, "TARGET Project (TARGET)"); input.checkpoint.action = { kind: "submit", output: project(input.run) }; }
    input.persist();
  } };
  let service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: asking });
  let run = await service.start({ ...base, projectName: "ambiguous target" }); assert.equal(run.pendingQuestion!.kind, "agent");
  service = new CkdWorkflow({ dataDir: f.dataDir, agent: asking });
  assert.equal((await service.resume(run.id)).pendingQuestion!.id, run.pendingQuestion!.id); assert.equal(calls, 1);
  run = await answerFirst(service, run); assert.equal(calls, 2); assert.equal(run.pendingQuestion!.kind, "deterministic");
  assert.equal(run.nodes.find(node => node.nodeId === "resolve-project")!.sessionFile, path.join(f.root, "fake-session.jsonl"));
  assert.equal(run.nodes.find(node => node.nodeId === "resolve-project")!.questions![0]!.answer, "TARGET Project (TARGET)");
  assert.equal(run.sharedState.projectMatchResult && (run.sharedState.projectMatchResult as any).matchedProjectId, "TARGET");
});

for (const source of ["TARGET", "SOURCE"]) test(`${source} reference route freezes Catalog order and produces workbook`, async t => {
  const f = fixture(t); const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: { async execute(input) { input.checkpoint.action = { kind: "submit", output: selection(input.run, source) }; input.persist(); } } });
  let run = await service.start(base); run = await service.answer(run.id, run.pendingQuestion!.id, "参考 Library 中已有 SOP");
  assert.equal(run.status, "completed", run.error); assert.equal(run.sharedState.processResolutionRoute, source === "TARGET" ? "same-project-reference" : "cross-project-reference");
  assert.deepEqual((run.sharedState.normalizedInputs as any).processList, ["First Check", "Second Check"]);
});

for (const sopType of ["assemble", "assembly_test", "pcba_test", "aging_test", "factory_test"] as const) test(`standalone ${sopType} generation and Chinese isolation`, async t => {
  const f = fixture(t); let modelCalls = 0;
  const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: { async execute(input) { modelCalls++; await deterministicAgent.execute(input); } } });
  let run = await service.start({ ...base, sopType, templateLanguage: "中文", ...(sopType === "factory_test" ? { factoryTestProcesses: ["Second Check", "First Check"] } : {}) });
  assert.notEqual(run.status, "failed", run.error);
  if (sopType !== "factory_test") run = await service.answer(run.id, run.pendingQuestion!.id, "参考 Library 中已有 SOP");
  assert.equal(run.status, "completed", run.error);
  if (sopType === "factory_test") { assert.equal(modelCalls, 0); assert.deepEqual((run.sharedState.normalizedInputs as any).processList, ["Second Check", "First Check"]); }
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path.resolve(run.workspaceRoot, run.finalResult!.artifacts[0]!));
  const contents = JSON.stringify(workbook.model); assert.match(contents, /中文操作/u); assert.doesNotMatch(contents, /ENGLISH OPERATION/u);
});

test("invalid model outputs fail schema and Catalog validation before advancing", async t => {
  const f = fixture(t);
  for (const output of [{}, { ...project({ inputs: { projectName: "?" } } as any) as object, matchedProjectId: "invented" }]) {
    const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: { async execute(input) { input.checkpoint.action = { kind: "submit", output }; } } });
    const run = await service.start({ ...base, projectName: "?" }); assert.equal(run.status, "failed"); assert.match(run.error!, /structured|Catalog/u); assert.equal(run.currentNodeId, "resolve-project");
  }
});

test("process submission rejects duplicate Catalog IDs and reordering", async t => {
  const f = fixture(t); let captured!: CkdRun;
  const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: { async execute(input) { captured = input.run; input.checkpoint.action = { kind: "terminate", reason: "test" }; } } });
  let run = await service.start(base); run = await answerFirst(service, run); await service.answer(run.id, run.pendingQuestion!.id, "First Check\nSecond Check");
  const valid = processes(captured); assert.doesNotThrow(() => validateDecision(captured, "resolve-processes", valid));
  const duplicate = structuredClone(valid) as any; duplicate.processes[1].resolvedProcessId = "first";
  assert.throws(() => validateDecision(captured, "resolve-processes", duplicate), /IDs\/order/u);
  const reversed = structuredClone(valid) as any; reversed.processes.reverse(); assert.throws(() => validateDecision(captured, "resolve-processes", reversed), /IDs\/order/u);
});

test("Library changes after frozen Catalog fail generation instead of overwriting or reading stale content", async t => {
  const f = fixture(t); const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: deterministicAgent });
  let run = await service.start(base);
  write(path.join(f.library, "processes_lib/assembly_test/first/operation_steps.txt"), "CHANGED AFTER CATALOG\n");
  run = await service.answer(run.id, run.pendingQuestion!.id, "参考 Library 中已有 SOP");
  assert.equal(run.status, "failed"); assert.match(run.error!, /changed|Hash|snapshot/iu); assert.equal(run.currentNodeId, "generate-sop");
});

test("timeout, cancellation and mutually exclusive resume preserve durable stage", async t => {
  const f = fixture(t); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting: CkdAgent = { async execute({ signal }) { entered(); await new Promise<void>((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); } };
  const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: waiting, agentTimeoutMs: 10000 });
  const running = service.start({ ...base, projectName: "?" }); await started;
  const id = service.list()[0]!.id; await assert.rejects(service.resume(id), /busy/u);
  await service.cancel(id); assert.equal((await running).status, "cancelled"); assert.equal((await service.resume(id)).status, "cancelled");
  const timed = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: waiting, agentTimeoutMs: 20 });
  const run = await timed.start({ ...base, projectName: "?" }); assert.equal(run.status, "failed"); assert.match(run.error!, /timed out/u);
});

test("cancel waiting clarification, reject answer and do not invoke another model", async t => {
  const f = fixture(t); const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: deterministicAgent });
  const run = await service.start(base); await service.cancel(run.id);
  assert.equal(service.get(run.id).status, "cancelled"); await assert.rejects(service.answer(run.id, run.pendingQuestion!.id, "x"), /no longer/u);
});

test("script timeout kills the child and asset changes are rejected", async t => {
  const f = fixture(t); const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: deterministicAgent });
  const run = await service.start(base);
  await assert.rejects(executeScript(run, { id: "timeout-test", script: "build-ckd-catalog-v3", values: { sopType: "assembly_test" }, outputSchema: {}, timeoutSeconds: 120 }, { resources: defaultResources, signal: new AbortController().signal, timeoutMs: 1 }), /timed out/u);
  await assert.rejects(executeScript(run, { id: "bad-script", script: "bash", values: {}, outputSchema: {} }, { resources: defaultResources, signal: new AbortController().signal }), /allowlist/u);
  const modified = structuredClone(run); modified.scriptHashes["fake"] = "bad"; service.store.save(modified);
  const failed = await service.answer(run.id, run.pendingQuestion!.id, "参考 Library 中已有 SOP"); assert.equal(failed.status, "failed"); assert.match(failed.error!, /assets changed/u);
});

test("stale process lock is reclaimed and live lock excludes other OS processes", async t => {
  const f = fixture(t); const store = new CkdStore(f.dataDir); const id = randomUUID(); const lock = path.join(store.directory(id), "run.lock");
  write(path.join(lock, "owner.json"), JSON.stringify({ pid: 2147483647, token: "dead" }));
  await store.locked(id, async () => { assert(fs.existsSync(lock)); await assert.rejects(store.locked(id, async () => undefined), /busy/u); });
  assert.equal(fs.existsSync(lock), false);
  await store.locked(id, async () => {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'import { CkdStore } from "./src/ckd/store.ts"; try { await new CkdStore(process.argv[1]).locked(process.argv[2], async () => {}); process.stdout.write("acquired"); } catch(e) { process.stdout.write(e.message); }', f.dataDir, id], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }); let text = ""; child.stdout.on("data", x => { text += x; }); child.on("error", reject); child.on("close", () => resolve(text));
    }); assert.match(result, /busy/u);
  });
});

test("extension validates before commit and accepts only one valid protocol action", async t => {
  const f = fixture(t); const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: deterministicAgent });
  const run = await service.start(base); run.currentNodeId = "resolve-project";
  const tools: any[] = []; let saves = 0;
  const input: AgentExecution = { run, checkpoint: { nodeRunId: "node", request: { task: "match", outputSchema: { type: "object", required: ["matchedProjectId"] } } }, signal: new AbortController().signal, persist: () => { saves++; } };
  await ckdExtension(input)({ registerTool: (tool: any) => tools.push(tool) } as never);
  assert.deepEqual(tools.map(tool => tool.name), [...CKD_TOOL_NAMES]);
  const submit = tools.find(tool => tool.name === "submitStructuredResult");
  await assert.rejects(submit.execute("bad", { output: {} }), /structured/u); assert.equal(saves, 0);
  await assert.rejects(submit.execute("bad-id", { output: { matchedProjectId: "fake" } }), /Catalog/u); assert.equal(saves, 0);
  const first = await submit.execute("good", { output: project(run) }); assert.equal(first.terminate, true); assert.equal(saves, 1);
  await tools[0].execute("second", { question: "再问一次？" }); assert.equal(saves, 1); assert.equal(input.checkpoint.action!.kind, "submit");
});

test("native Pi session remains compatible and semantic session exposes only protocol tools", async t => {
  const f = fixture(t); const runtime = await AgentRuntime.create({ dataDir: f.dataDir, resourcesDir: path.resolve("resources"), model: { apiKey: "offline-test", baseUrl: "http://127.0.0.1:1/v1", modelId: "offline" } });
  const normal = await runtime.createSession(undefined, { skillPaths: [] });
  assert.deepEqual(normal.getActiveToolNames().sort(), ["bash", "edit", "read", "write"]); normal.dispose();
  const run = { currentNodeId: "resolve-project" } as CkdRun;
  const restricted = await runtime.createSession(undefined, { tools: [...CKD_TOOL_NAMES], cwd: f.root, systemPrompt: "CKD test", skillPaths: [], extensions: [{ name: "ckd-test", factory: ckdExtension({ run, checkpoint: { nodeRunId: "node", request: { task: "test", outputSchema: {} } }, signal: new AbortController().signal, persist() {} }) }] });
  assert.deepEqual(restricted.getActiveToolNames().sort(), [...CKD_TOOL_NAMES].sort()); restricted.dispose();
});

test("CLI JSON is clean across separate processes; noninteractive question persists and cancel/list/get work", async t => {
  const f = fixture(t); const inputFile = path.join(f.root, "input.json"); write(inputFile, JSON.stringify(base));
  const invoke = async (args: string[]) => new Promise<{ code: number | null; output: any; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/ckd/cli.ts", ...args, "--data-dir", f.dataDir, "--json", "--non-interactive"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; child.stdout.on("data", x => { stdout += x; }); child.stderr.on("data", x => { stderr += x; }); child.on("error", reject); child.on("close", code => { try { resolve({ code, output: JSON.parse(stdout), stderr }); } catch (error) { reject(new Error(`${error}: ${stderr}`)); } });
  });
  const started = await invoke(["start", "--input", inputFile, "--library", f.library]); assert.equal(started.code, 0); assert.equal(started.output.status, "awaiting_clarification"); assert.match(started.stderr, /Select SOP Source/u);
  const run = started.output as CkdRun;
  const answered = await invoke(["answer", run.id, "--question", run.pendingQuestion!.id, "--text", "手动输入 SOP Processes"]);
  assert.equal(answered.output.pendingQuestion.kind, "deterministic"); assert.notEqual(answered.output.pendingQuestion.id, run.pendingQuestion!.id);
  const got = await invoke(["get", run.id]); assert.equal(got.output.pendingQuestion.id, answered.output.pendingQuestion.id);
  const resumed = await invoke(["resume", run.id]); assert.equal(resumed.output.pendingQuestion.id, answered.output.pendingQuestion.id);
  const listed = await invoke(["list"]); assert.equal(listed.output.length, 1);
  const cancelled = await invoke(["cancel", run.id]); assert.equal(cancelled.output.status, "cancelled");
});

test("recovery after saved stage and script receipt never reruns a completed generator or overwrites changed artifacts", async t => {
  const f = fixture(t); const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: deterministicAgent });
  let run = await service.start({ ...base, sopType: "factory_test", factoryTestProcesses: ["First Check"] }); assert.equal(run.status, "completed", run.error);
  const generator = run.nodes.find(node => node.nodeId === "generate-sop")!;
  const contextInput = JSON.parse(fs.readFileSync(path.join(service.store.directory(run.id), "scripts", fs.readdirSync(path.join(service.store.directory(run.id), "scripts")).find(key => JSON.parse(fs.readFileSync(path.join(service.store.directory(run.id), "scripts", key, "input.json"), "utf8")).workflow.stepId === "generate-sop")!, "input.json"), "utf8"));
  const request = { id: "generate-sop", script: "create-ckd-sop-v3", values: contextInput.inputs, outputSchema: {}, final: true };
  const replayed = await executeScript(run, request, { resources: defaultResources, signal: new AbortController().signal });
  assert.equal(replayed.artifacts[0], generator.result!.artifacts[0]);
  assert.deepEqual((replayed.output as any).processReviews, (generator.result!.output as any).processReviews);
  assert.deepEqual(await executeScript(run, request, { resources: defaultResources, signal: new AbortController().signal }), replayed);
  assert.ok((generator.result!.output as any).imageQuality); // Host review is separate from the generator's receipt.
  run.status = "running"; run.currentNodeId = "generate-sop"; run.stageCommitted = true; service.store.save(run);
  run = await new CkdWorkflow({ dataDir: f.dataDir, agent: deterministicAgent }).resume(run.id); assert.equal(run.status, "completed");
  const artifact = path.resolve(run.workspaceRoot, run.finalResult!.artifacts[0]!); fs.appendFileSync(artifact, "changed");
  await assert.rejects(executeScript(run, request, { resources: defaultResources, signal: new AbortController().signal }), /artifacts changed/u);
});

test("a saved cancellation request is honored on restart even while awaiting an answer", async t => {
  const f = fixture(t); const service = new CkdWorkflow({ dataDir: f.dataDir, libraryPath: f.library, agent: deterministicAgent });
  const run = await service.start(base); service.store.requestCancel(run.id);
  const restored = await new CkdWorkflow({ dataDir: f.dataDir, agent: deterministicAgent }).resume(run.id);
  assert.equal(restored.status, "cancelled"); assert.equal(restored.pendingQuestion, undefined);
});
