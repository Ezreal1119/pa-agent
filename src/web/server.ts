import { WecomRoles, roleScope, senderScope } from "./wecom-roles.js";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parse as parseEnv } from "dotenv";
import { AgentRuntime } from "../agent/runtime.js";
import { resolveConfig } from "../config.js";
import { PromptInstructionsStore } from "../prompts/instructions.js";
import { previewPrompt } from "../prompts/composition.js";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SKILLS, ON_DEMAND_SKILLS, loadRunKnowledge } from "../agent/knowledge.js";
import { REASONING_MODES, isReasoningMode, isDeepSeekModel, applyDeepSeekReasoning, type ReasoningMode } from "../agent/reasoning.js";
import { getRunMetrics, readRunMetrics, RUN_METRICS_TYPE, saveRunMetric, sdkTokens, visionTokens, type RunMetric } from "./run-metrics.js";
import { getToolRuns, publicRunMetrics } from "./tool-calls.js";
import type { AgentConfigOptions } from "../config.js";
import { AgentSettingsStore, validateAgentSettings } from "./agent-settings.js";
import { WebAuth } from "./auth.js";
import { WecomContacts, observation } from "./wecom-contacts.js";
import { WebOriginPolicy, RequestOriginError } from "./origin.js";
import { BridgeAccess } from "./bridge-access.js";
import { RunGate, boundedSetting } from "./run-gate.js";
import { ExtraMemoryStore, EXTRA_MEMORY_SECTION } from "../agent/extra-memory.js";
import { mainMemoryFile } from "../agent/memory-paths.js";
import { fileToolConfig, FILE_TOOL_NAMES, FILE_EXTENSIONS, type FileToolOptions } from "../file-tools/config.js";
import { generatedFiles } from "../file-tools/outputs.js";
import { FileStore } from "../file-tools/store.js";
import { captureMessageAttachments, messageAttachments } from "../agent/message-attachments.js";
import { SessionRetention } from "../agent/retention.js";
import { queueState } from "../file-tools/runner.js";
import { pipeline } from "node:stream/promises";

import { webToolConfig, WEB_TOOL_NAMES, type WebToolOptions } from "../web-tools/config.js";

import { mcpConfig, type McpOptions } from "../mcp/config.js";
import { McpAccess } from "../mcp/auth.js";
import { McpStore } from "../mcp/store.js";
import { McpService } from "../mcp/service.js";
import { handleMcp } from "../mcp/http.js";
import { runMcpAgent } from "../mcp/runner.js";

import { WecomImportService } from "../wecom-import/service.js";
import { wecomConfig } from "../wecom-import/config.js";
import type { Reader as WecomReader } from "../wecom-import/client.js";
import { LibraryImportService } from "../library-import/service.js";
import { libraryConfig } from "../library-import/config.js";
import { createClassifier } from "../library-import/classifier.js";
import { SftpSyncService } from "../sftp-sync/service.js";
import { sftpConfig } from "../sftp-sync/config.js";
import { MAX_PATHS_BYTES } from "../sftp-sync/paths-editor.js";
import { ScheduleError, SftpScheduleClient, validateSchedule } from "../sftp-sync/schedule.js";
import { ResearchService } from "../research/service.js";
import { createResearchEngine, type ResearchEngine } from "../research/agent.js";
import { researchRoute } from "../research/routes.js";
import { ResearchError, config as researchConfig, type ResearchConfig } from "../research/domain.js";
import { SyncService } from "../knowledge-sync/service.js";
import { AutoSync } from "../knowledge-sync/auto-sync.js";
import { AutoSyncSocket, autoSyncSocketPath } from "../knowledge-sync/auto-sync-socket.js";
import { KnowledgeLibrary, LIBRARY_MAX_EDIT_BYTES } from "../knowledge-sync/library.js";
import { SYNC_MAX_FILE_BYTES } from "../knowledge-sync/config.js";
import { createPlanner, type Planner } from "../knowledge-sync/agent.js";
import { createConverter, type Converter } from "../knowledge-sync/converter.js";
import { SyncError, knowledgeLock } from "../knowledge-sync/core.js";
import { MemoryAttachments } from "../memory-injection/attachments.js";
import { MemoryInjectionService } from "../memory-injection/service.js";
import { createMemoryPlanner, type MemoryPlanner } from "../memory-injection/planner.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MONTH = 30 * 86400000;
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
type ModelSettings = { apiKey: string; baseUrl: string; modelId: string; contextWindow: number; maxTokens: number };
type RecordState = { userRoleStyle?: string; channel?: "mcp"; id: string; persistedFile?: string; session?: AgentSession; running: boolean; title: string; updated: string; context?: unknown; opening?: Promise<AgentSession>; cancelled?: boolean; activeRunId?: string; mutating?: boolean; cancelQueued?: () => void };
export interface WebOptions { research?: { engine?: () => ResearchEngine; settings?: ResearchConfig }; wecomImport?: { reader: WecomReader; disk?: (bytes: number) => Promise<void> }; autoSyncSchedule?: Pick<SftpScheduleClient, "status" | "save">; wecomSchedule?: Pick<SftpScheduleClient, "status" | "save">; librarySchedule?: Pick<SftpScheduleClient, "status" | "save">; sftpSchedule?: Pick<SftpScheduleClient, "status" | "save">; memoryInjection?: { planner: () => MemoryPlanner }; sync?: { planner?: () => Planner; converter?: () => Converter; timeoutMs?: number }; cwd?: string; dataDir?: string; resourcesDir?: string; model?: Partial<ModelSettings>; admin?: { account: string; password: string }; fileTools?: FileToolOptions; webTools?: WebToolOptions; mcp?: McpOptions; bridgeToken?: string; publicUrl?: string; maxConcurrentRuns?: number; runQueueLimit?: number; }

export async function createWebServer(options: WebOptions = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dataDir = path.resolve(options.dataDir ?? process.env.AGENT_DATA_DIR ?? path.join(cwd, ".data"));
  const resourcesDir = path.resolve(options.resourcesDir ?? path.join(projectRoot, "resources"));
  const sessionsDir = path.join(dataDir, "sessions");
  const diskEnv = await fs.readFile(path.join(cwd, ".env"), "utf8").then(parseEnv).catch(error => {
    if (error.code === "ENOENT") return {} as Record<string, string>;
    throw error;
  });
  const libraryOptions = libraryConfig({ ...diskEnv, ...process.env });
  const sftpOptions = sftpConfig(cwd, dataDir, { ...diskEnv, ...process.env });
  const mcpOptions = mcpConfig(options.mcp, { ...diskEnv, ...process.env });
  const mcpAccess = new McpAccess(mcpOptions.apiKey);
  const originPolicy = new WebOriginPolicy(options.publicUrl ?? process.env.WEB_PUBLIC_URL ?? diskEnv.WEB_PUBLIC_URL ?? "");
  const fileConfig = fileToolConfig(dataDir, options.fileTools, { ...diskEnv, ...process.env });
  const agentSettingsStore = new AgentSettingsStore(dataDir);
  let agentSettings = await agentSettingsStore.load({ effort: "low", libraryLinks: { enabled: true }, webTools: { tools: Object.fromEntries(WEB_TOOL_NAMES.map(name => [name, Boolean(options.webTools?.enabled && (options.webTools.tools?.includes(name) ?? true))])) as Record<typeof WEB_TOOL_NAMES[number], boolean> }, fileTools: { tools: Object.fromEntries(FILE_TOOL_NAMES.map(name => [name, fileConfig.enabled && fileConfig.tools.includes(name)])) as Record<typeof FILE_TOOL_NAMES[number], boolean> } });
  const fileStore = new FileStore(fileConfig);
  const settings: ModelSettings = {
    apiKey: options.model?.apiKey ?? process.env.API_KEY ?? diskEnv.API_KEY ?? "",
    baseUrl: options.model?.baseUrl ?? process.env.BASE_URL ?? diskEnv.BASE_URL ?? "",
    modelId: options.model?.modelId ?? process.env.MODEL_ID ?? diskEnv.MODEL_ID ?? "",
    contextWindow: options.model?.contextWindow ?? Number(process.env.CONTEXT_WINDOW ?? diskEnv.CONTEXT_WINDOW ?? 128000),
    maxTokens: options.model?.maxTokens ?? Number(process.env.MAX_TOKENS ?? diskEnv.MAX_TOKENS ?? 16384),
  };
  const csrf = randomBytes(24).toString("hex");
  const webConfig = webToolConfig(options.webTools, settings, { ...diskEnv, ...process.env });
  const applyAgentSettings = () => {
    fileConfig.tools = FILE_TOOL_NAMES.filter(name => agentSettings.fileTools.tools[name]); fileConfig.enabled = fileConfig.tools.length > 0;
    webConfig.tools = WEB_TOOL_NAMES.filter(name => agentSettings.webTools.tools[name]); webConfig.enabled = webConfig.tools.length > 0;
  };
  applyAgentSettings();
  mcpOptions.enabled = agentSettings.mcp?.enabled ?? mcpOptions.enabled;
  const adminAccount = (options.admin?.account ?? process.env.ADMIN_ACCOUNT ?? diskEnv.ADMIN_ACCOUNT ?? "").trim();
  const adminPassword = options.admin?.password ?? process.env.ADMIN_PASSWORD ?? diskEnv.ADMIN_PASSWORD ?? "";
  const auth = new WebAuth(adminAccount, adminPassword);
  await auth.initialize(dataDir);
  const wecomContacts = new WecomContacts(dataDir);
  const wecomRoles = new WecomRoles(dataDir);
  const bridgeToken = options.bridgeToken ?? process.env.WECOM_API_TOKEN ?? diskEnv.WECOM_API_TOKEN ?? "";
  const bridge = new BridgeAccess(dataDir, bridgeToken);
  await bridge.load();
  const runGate = new RunGate(
    boundedSetting(options.maxConcurrentRuns ?? process.env.AGENT_MAX_CONCURRENT_RUNS ?? diskEnv.AGENT_MAX_CONCURRENT_RUNS, 2, 1, 8, "AGENT_MAX_CONCURRENT_RUNS"),
    boundedSetting(options.runQueueLimit ?? process.env.AGENT_RUN_QUEUE_LIMIT ?? diskEnv.AGENT_RUN_QUEUE_LIMIT, 8, 0, 100, "AGENT_RUN_QUEUE_LIMIT")
  );
  const promptStore = new PromptInstructionsStore(dataDir);
  const records = new Map<string, RecordState>();
  const deletedIds = new Set<string>();
  let runtime: AgentRuntime | undefined;
  let initializing: Promise<AgentRuntime> | undefined;
  let configuring = false;
  let openingSessions = 0;
  let mcp: McpService | undefined;
  const configured = () => Boolean(settings.apiKey && settings.baseUrl && settings.modelId);
  const redact = (error: unknown) => {
    let message = error instanceof Error ? error.message : String(error);
    if (mcpOptions.apiKey) message = message.split(mcpOptions.apiKey).join("[REDACTED]");
    if (bridgeToken) message = message.split(bridgeToken).join("[REDACTED]");
    if (settings.apiKey) message = message.split(settings.apiKey).join("[REDACTED]");
    if (webConfig.apiKey) message = message.split(webConfig.apiKey).join("[REDACTED]");
    if (libraryOptions.password) message = message.split(libraryOptions.password).join("[REDACTED]");
    if (sftpOptions.password) message = message.split(sftpOptions.password).join("[REDACTED]");
    if (adminPassword) message = message.split(adminPassword).join("[REDACTED]");
    if (fileConfig.vision.apiKey) message = message.split(fileConfig.vision.apiKey).join("[REDACTED]");
    return message.slice(0, 2000);
  };
  const syncEnv = { ...diskEnv, ...process.env };
  const syncTimeout = boundedSetting(options.sync?.timeoutMs ?? syncEnv.SYNC_FILE_TIMEOUT_MS, 1800000, 1000, 7200000, "SYNC_FILE_TIMEOUT_MS");
  const syncCalls = boundedSetting(syncEnv.SYNC_MAX_MODEL_REQUESTS, 64, 1, 512, "SYNC_MAX_MODEL_REQUESTS");
  const syncVision = boundedSetting(syncEnv.SYNC_MAX_VISION_REQUESTS, 128, 1, 1024, "SYNC_MAX_VISION_REQUESTS");
  const synchronize = new SyncService({ dataDir, maxBytes: SYNC_MAX_FILE_BYTES, maxBatchMarkdownBytes: boundedSetting(syncEnv.SYNC_MAX_BATCH_MARKDOWN_BYTES, 16777216, 1048576, 134217728, "SYNC_MAX_BATCH_MARKDOWN_BYTES"), timeoutMs: syncTimeout, modelId: () => settings.modelId, redact,
    planner: options.sync?.planner ?? (() => createPlanner({ model: { ...settings }, effort: agentSettings.effort, resourcesDir, workDir: path.join(dataDir, "knowledge-sync", "agent"), maxCalls: syncCalls, acquire: signal => runGate.acquire(signal) })),
    converter: options.sync?.converter ?? (() => createConverter({ ...structuredClone(fileConfig), maxFileBytes: SYNC_MAX_FILE_BYTES,
      // Dense maintenance pages need more time than interactive chat images.
      vision: { ...fileConfig.vision, timeoutMs: Math.max(fileConfig.vision.timeoutMs, 180_000) },
    }, syncEnv.SYNC_SOFFICE_COMMAND || "soffice", syncVision, signal => runGate.acquire(signal))) });
  await synchronize.init();
  const autoSync = new AutoSync(synchronize, () => configured() && auth.configured, redact);
  await autoSync.init();
  const autoSyncSocket = new AutoSyncSocket(autoSyncSocketPath(dataDir), () => autoSync.trigger());
  const autoSyncSchedule = options.autoSyncSchedule ?? new SftpScheduleClient(undefined, "sync");
  const library = new KnowledgeLibrary(synchronize.root, dataDir, () => synchronize.busy);
  const sftpSync = new SftpSyncService({dataDir, config:sftpOptions});
  await sftpSync.init();
  const sftpSchedule = options.sftpSchedule ?? new SftpScheduleClient();
  const librarySchedule = options.librarySchedule ?? new SftpScheduleClient(undefined, "library");
  const libraryImports = new LibraryImportService({dataDir, config:libraryOptions, modelConfigured:configured, modelId:()=>settings.modelId, redact,
    classifier:() => createClassifier({...settings}, agentSettings.effort, signal => runGate.acquire(signal))});
  await libraryImports.init();
  const wecomImports = new WecomImportService({ dataDir, config: wecomConfig(cwd, dataDir, syncEnv), ...options.wecomImport });
  await wecomImports.init();
  const wecomSchedule = options.wecomSchedule ?? new SftpScheduleClient(undefined, "wecom");
  const memoryInjection = new MemoryInjectionService({dataDir, attachments: new MemoryAttachments(dataDir, () => fileConfig), modelId: () => settings.modelId, redact,
    planner: options.memoryInjection?.planner ?? (() => createMemoryPlanner({model: {...settings}, effort: agentSettings.effort, workDir: path.join(dataDir, "memory-injection", "agent"), acquire: signal => runGate.acquire(signal)}))});
  await memoryInjection.init();
  const research = new ResearchService({dataDir, resourcesDir, settings: options.research?.settings ?? researchConfig(syncEnv), redact,
    engine: options.research?.engine ?? (() => {
      const model = {...settings}; const web = {apiKey: webConfig.apiKey};
      return createResearchEngine({dataDir, resourcesDir, model: () => model, web: () => web});
    })});
  await research.init();
  const getRuntime = async () => {
    if (!configured()) throw new HttpError(409, "Set BASE_URL, MODEL_ID, and API_KEY in .env, then restart the service.");
    if (!initializing) {
      const config: AgentConfigOptions = { cwd, dataDir, resourcesDir, model: settings, fileTools: fileConfig, libraryLinksEnabled: agentSettings.libraryLinks.enabled, webTools: webConfig };
      initializing = AgentRuntime.create(config).then(value => runtime = value).catch(error => { initializing = undefined; throw error; });
    }
    return initializing;
  };
  async function resources() {
    return Promise.all(DEFAULT_SKILLS.map(async name => ({ name, files: await Promise.all(["SKILL.md", "MEMORY.md"].map(async file => {
      try {
        const text = await fs.readFile(file === "MEMORY.md" ? mainMemoryFile(dataDir, name) : path.join(dataDir, name, file), "utf8");
        return { file, ready: Boolean(text.trim()), bytes: Buffer.byteLength(text) };
      } catch { return { file, ready: false, bytes: 0 }; }
    })) })));
  }
  async function ordinarySkills() {
    return Promise.all(ON_DEMAND_SKILLS.map(async name => {
      const file = path.join(dataDir, name, "SKILL.md");
      const text = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      return { name, ready: Boolean(text.trim()), bytes: Buffer.byteLength(text), loading: "on-demand" };
    }));
  }
  // Retention also runs before a model/runtime is initialized and with file tools off.
  const retention = new SessionRetention(sessionsDir, console.error, async id => {
    const item = records.get(id);
    if (item?.running || item?.opening || item?.mutating) throw new Error("Session is busy; retry expiration later.");
    await fileStore.remove(id);
    await bridge.remove(id);
    await mcp?.removeSession(id);
    item?.session?.dispose(); records.delete(id);
  });
  const mcpStore = new McpStore(dataDir, mcpOptions.retainedTaskLimit);
  mcp = new McpService(mcpStore, mcpOptions, {
    redact,
    recover: async (task, needsAnswer) => {
      const files = await recoveryFiles(); const file = files.get(task.sessionId);
      if (!file) return {};
      let metrics = recoveryMetrics.get(task.sessionId);
      let manager: SessionManager | undefined;
      if (!metrics) {
        manager = SessionManager.open(file, sessionsDir, cwd);
        metrics = new Map(readRunMetrics(manager).map(run => [run.id, run]));
        // Startup groups tasks by session; retain only compact metrics, never every SDK conversation.
        recoveryMetrics.clear(); recoveryMetrics.set(task.sessionId, metrics);
      }
      const metric = metrics.get(task.id);
      if (!metric || metric.mcpTaskId !== task.id) return {};
      if (!needsAnswer) return { metric };
      manager ??= SessionManager.open(file, sessionsDir, cwd);
      let round = 0; let answer = "";
      for (const entry of manager.getBranch()) {
        if (entry.type !== "message") continue;
        const message = entry.message;
        if (message.role === "user") round++;
        if (round === metric.round && message.role === "assistant") answer = message.content.filter(part => part.type === "text").map(part => part.text).join("");
      }
      return { metric, answer: { answer: answer.slice(0, 256000), ...(answer.length > 256000 ? { truncated: true } : {}), ...(metric.status !== "completed" ? { error: "This task did not finish successfully before the service restarted. Recorded usage is preserved." } : {}) } };
    },
    run: async (task, question, signal, update) => {
      if (configuring) throw new Error("Agent settings are being updated. Please retry later.");
      const item: RecordState = records.get(task.sessionId) ?? { channel: "mcp", id: task.sessionId, running: false, title: question.slice(0, 36), updated: new Date().toISOString() };
      if (item.running || item.mutating || item.opening) throw new Error("This MCP conversation is busy.");
      records.set(item.id, item); item.channel = "mcp"; item.running = true; item.cancelled = false;
      const local = new AbortController(); const abort = AbortSignal.any([signal, local.signal]);
      item.cancelQueued = () => local.abort(new Error("This run was stopped."));
      let release: (() => void) | undefined;
      try {
        release = await runGate.acquire(abort); abort.throwIfAborted();
        const session = await getSession(item); abort.throwIfAborted(); item.activeRunId = task.id;
        return await runMcpAgent(session, task, question, abort, { modelId: settings.modelId, effort: isDeepSeekModel(settings) ? agentSettings.effort : "provider-default", update, redact });
      } catch (error) {
        if (abort.aborted) return { answer: "", error: redact(abort.reason ?? error), status: "cancelled" };
        throw error;
      } finally {
        item.persistedFile = item.session?.sessionFile ?? item.persistedFile; item.session?.dispose(); item.session = undefined; item.activeRunId = undefined; item.cancelQueued = undefined; item.running = false; item.updated = new Date().toISOString(); release?.();
      }
    },
  });
  let recoveryIndex: Map<string, string> | undefined;
  const recoveryMetrics = new Map<string, Map<string, RunMetric>>();
  async function recoveryFiles() { return recoveryIndex ??= new Map((await savedSessions()).map(session => [session.id, session.path])); }
  await mcp.start(); recoveryMetrics.clear(); recoveryIndex = undefined;
  await retention.cleanup(); retention.start();
  async function savedSessions() {
    if (!await fs.stat(sessionsDir).catch(() => undefined)) return [];
    const sessions = await SessionManager.list(cwd, sessionsDir);
    return sessions.filter(s => s.modified.getTime() >= Date.now() - MONTH);
  }
  async function findRecord(id: string) {
    if (deletedIds.has(id) || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new HttpError(404, "Conversation not found.");
    const cached = records.get(id);
    if (cached) {
      const file = cached.persistedFile;
      const stat = file ? await fs.stat(file).catch(() => undefined) : undefined;
      if (!cached.running && !cached.mutating && file && (!stat || stat.mtimeMs < Date.now() - MONTH)) {
        await retention.cleanup();
        if (!stat) { await fileStore.remove(id); cached.session?.dispose(); records.delete(id); }
        throw new HttpError(404, "This conversation has expired. Start a new conversation.");
      }
      return cached;
    }
    const saved = (await savedSessions()).find(s => s.id === id);
    if (!saved || deletedIds.has(id)) throw new HttpError(404, "This conversation was not found or has expired. Start a new conversation.");
    const current = records.get(id);
    if (current) return current;
    const item: RecordState = { id, persistedFile: saved.path, running: false, title: saved.name ?? saved.firstMessage.slice(0, 36), updated: saved.modified.toISOString() };
    records.set(id, item);
    return item;
  }
  async function getSession(item: RecordState): Promise<AgentSession> {
    if (deletedIds.has(item.id)) throw new HttpError(404, "This conversation was deleted.");
    if (item.mutating) throw new HttpError(409, "This conversation is being updated. Please wait.");
    if (item.session) return item.session;
    if (item.opening) return item.opening;
    if (configuring) throw new HttpError(409, "Agent settings are being updated. Please wait.");
    openingSessions++;
    item.opening = (async () => {
      try {
        const engine = await getRuntime();
        const saved = (await savedSessions()).find(s => s.id === item.id);
        const manager = saved ? SessionManager.open(saved.path, sessionsDir, cwd) : SessionManager.create(cwd, sessionsDir, { id: item.id });
        const textOnly = item.channel === "mcp" || mcpStore.hasSession(item.id) || manager.getEntries().some(entry => entry.type === "custom" && entry.customType === RUN_METRICS_TYPE && Boolean((entry.data as Partial<RunMetric>)?.mcpTaskId));
        const session = await engine.createSession(manager, { textOnly, userRoleStyle: () => item.userRoleStyle });
        // Replay persisted snapshots after a restart; cursors make this idempotent.
        await wecomContacts.recoverSession(item.id, getRunMetrics(session));
        return item.session = session;
      } finally { openingSessions--; item.opening = undefined; }
    })();
    return item.opening;
  }

  /** Browser IDs resolve to SDK-managed files; never accept a path from the client. */
  async function managedFile(item: RecordState) {
    const file = item.session?.sessionFile ?? (await savedSessions()).find(s => s.id === item.id)?.path;
    if (!file) return undefined;
    const relative = path.relative(sessionsDir, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !file.endsWith(".jsonl")) throw new HttpError(400, "Invalid conversation file path.");
    const info = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(400, "Conversation history must be stored in a regular file.");
      const actual = await fs.realpath(file);
      const root = await fs.realpath(sessionsDir);
      const actualRelative = path.relative(root, actual);
      if (actualRelative === ".." || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) throw new HttpError(400, "The conversation file is outside its storage directory.");
    }
    return { file, exists: Boolean(info) };
  }

  async function publicMessages(session: AgentSession, activeId?: string) {
    const runs = publicRunMetrics(session, activeId);
    const tools = getToolRuns(session, activeId);
    const attached = messageAttachments(session);
    const knownFiles = new Map((await fileStore.list(session.sessionId)).filter(file => file.direction === "outputs").map(file => [file.id, file]));
    const outputs = new Map<number, Map<string, import("../file-tools/store.js").ManagedFile>>();
    const addOutput = (round: number, id: string) => {
      const file = knownFiles.get(id); if (!file) return;
      if (!outputs.has(round)) outputs.set(round, new Map());
      outputs.get(round)!.set(id, file);
    };
    const userEntries = session.sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user");
    for (const record of generatedFiles(session)) {
      const index = userEntries.findIndex(entry => entry.id === record.userMessageId);
      if (index >= 0) addOutput(index + 1, record.file.id);
    }
    // Legacy results already contain backend-generated metadata: recover their
    // association without asking the model or parsing its answer/path text.
    for (const run of tools.values()) for (const call of run.calls) {
      const result = call.result as { details?: { ok?: boolean; file?: { id?: string } } } | null;
      if (["excel_patch_template", "excel_create", "text_file_create"].includes(call.name) && call.status === "completed" && result?.details?.ok === true && result.details.file?.id) addOutput(run.round, result.details.file.id);
    }
    const view = (role: string, text: string, timestamp: number, round: number) => {
      const toolRun = tools.get(round);
      return { role, text, timestamp, outputs: [] as import("../file-tools/store.js").ManagedFile[], outputNotice: "",
        ...(role === "user" ? { attachments: attached.find(record => record.round === round && record.timestamp === timestamp)?.files ?? [] } : {}),
        run: runs.findLast(run => run.id === toolRun?.id),
        ...(role === "assistant" ? { toolRunId: toolRun?.id, toolCallCount: toolRun?.calls.length ?? 0 } : {}),
      };
    };
    const output: ReturnType<typeof view>[] = [];
    const lastAnswer = new Map<number, ReturnType<typeof view>>();
    let round = 0; let hasAnswer = false;
    const flush = () => {
      const toolRun = tools.get(round);
      if (!hasAnswer && (toolRun?.calls.length || outputs.has(round))) {
        const placeholder = view("assistant", outputs.has(round) ? "Files are ready to download below." : "No text answer yet. You can inspect the tool calls.", toolRun?.calls.at(-1)?.requestedAt ?? Date.now(), round);
        output.push(placeholder); lastAnswer.set(round, placeholder);
      }
    };
    for (const message of session.messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (message.role === "user") { flush(); round++; hasAnswer = false; }
      const text = typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("");
      if (!text) continue;
      if (message.role === "assistant") hasAnswer = true;
      const item = view(message.role, text, message.timestamp, round);
      output.push(item); if (message.role === "assistant") lastAnswer.set(round, item);
    }
    flush();
    for (const [round, files] of outputs) {
      const answer = lastAnswer.get(round); if (!answer) continue;
      answer.outputs = [...files.values()];
      if (answer.run && answer.run.status !== "completed") answer.outputNotice = answer.run?.status === "running" ? "File ready; the run is still in progress." : "Files are ready to download, although the run did not finish successfully.";
    }
    return output;
  }
  async function listSessions() {
    await retention.cleanup();
    const list = new Map((await savedSessions()).filter(s => !deletedIds.has(s.id)).map(s => [s.id, { id: s.id, title: s.name ?? s.firstMessage.slice(0, 36) ?? "New conversation", updated: s.modified.toISOString(), running: false }]));
    for (const r of records.values()) list.set(r.id, { id: r.id, title: r.title, updated: r.updated, running: r.running });
    return [...list.values()].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 100);
  }
  async function readBody(req: IncomingMessage, maxBytes = 65536) {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Send the request as JSON.");
    const parts: Buffer[] = []; let size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > maxBytes) throw new HttpError(413, "The request is too large. Shorten your question.");
      parts.push(part);
    }
    try {
      const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    }
    catch { throw new HttpError(400, "Invalid request format."); }
  }
  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }
  function validRequest(req: IncomingMessage, machine = false) {
    const port = (server.address() as import("node:net").AddressInfo).port;
    let secureCookies: boolean;
    try { secureCookies = originPolicy.check(req, port, machine); }
    catch (error) { if (error instanceof RequestOriginError) throw new HttpError(403, error.message); throw error; }
    if (!machine && !["GET", "HEAD"].includes(req.method ?? "") && req.headers["x-local-token"] !== csrf) throw new HttpError(403, "This page has expired. Refresh and try again.");
    return secureCookies;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method;
      if (url.pathname === "/mcp") {
        if (!mcpOptions.enabled) throw new HttpError(404, "MCP is disabled. Enable it in Agent settings.");
        // MCP uses its own Bearer key, independent of browser login/CSRF and WeCom credentials.
        try { originPolicy.check(req, (server.address() as import("node:net").AddressInfo).port); }
        catch (error) { if (error instanceof RequestOriginError) throw new HttpError(403, error.message); throw error; }
        if (!mcpAccess.authenticated(req.headers.authorization)) {
          res.setHeader("WWW-Authenticate", 'Bearer realm="product-expert-mcp"');
          throw new HttpError(401, "MCP API key is invalid or not configured.");
        }
        await handleMcp(req, res, mcp!); return;
      }
      const machine = url.pathname.startsWith("/api/wecom/");
      const secureCookies = validRequest(req, machine);
      if (machine) {
        if (!bridge.authenticated(req.headers.authorization)) throw new HttpError(401, "WeCom API credentials are invalid or not configured.");
        const route = url.pathname.slice("/api/wecom".length);
        if (route === "/role" && ["GET", "PUT", "DELETE"].includes(method ?? "")) {
          let scope;
          try { scope = roleScope(JSON.parse(url.searchParams.get("scope") ?? "null")); }
          catch { throw new HttpError(400, "Invalid WeCom conversation scope."); }
          if (method !== "GET") {
            const input = await readBody(req);
            if (Object.keys(input).some(key => key !== "text") || method === "PUT" && (typeof input.text !== "string" || !input.text.trim() || input.text.length > 12000 || input.text.includes("\0")) || method === "DELETE" && Object.keys(input).length) throw new HttpError(400, "Invalid role request.");
            await wecomRoles.set(scope, method === "DELETE" ? undefined : input.text);
          }
          return json(res, 200, { text: await wecomRoles.get(scope) ?? null });
        }
        const owned = route.match(/^\/sessions\/([\w-]+)(?:\/(run|stop|files)(?:\/([a-f0-9-]{36}))?)?$/);
        const allowed = route === "/contacts" && method === "POST" || route === "/status" && method === "GET" || route === "/sessions" && method === "POST" || owned && (
          !owned[2] && ["GET", "PATCH", "DELETE"].includes(method ?? "") ||
          ["run", "stop"].includes(owned[2] ?? "") && method === "POST" && !owned[3] ||
          owned[2] === "files" && (method === "GET" || method === "POST" && !owned[3])
        );
        if (!allowed) throw new HttpError(403, "This operation is not supported by the WeCom API.");
        if (owned && !bridge.owns(owned[1]!)) throw new HttpError(404, "WeCom conversation not found.");
        if (route === "/contacts") {
          try { return json(res, 200, { contact: await wecomContacts.record(await readBody(req)) }); }
          catch (error) { throw new HttpError(400, redact(error)); }
        }
        url.pathname = `/api${route}`;
        if (route === "/status") return json(res, 200, { configured: configured(), queue: runGate.snapshot(), retentionDays: 30, fileTools: { enabled: fileConfig.enabled, tools: fileConfig.enabled ? fileConfig.tools : [], maxFileBytes: fileConfig.maxFileBytes } });
      }
      const authenticated = machine || auth.authenticated(req);
      if (method === "GET" && url.pathname === "/api/auth/status") return json(res, 200, { token: csrf, configured: auth.configured, authenticated });
      if (method === "POST" && url.pathname === "/api/auth/login") {
        if (!auth.configured) throw new HttpError(503, "Set ADMIN_ACCOUNT and ADMIN_PASSWORD in .env, then restart the service to sign in.");
        const retryAfter = auth.retryAfter(req);
        if (retryAfter) { res.setHeader("Retry-After", retryAfter); throw new HttpError(429, "Too many sign-in attempts. Try again in one minute."); }
        const body = await readBody(req);
        if (typeof body.account !== "string" || typeof body.password !== "string" || body.account.length > 256 || body.password.length > 4096) throw new HttpError(400, "Enter a valid account and password.");
        if (!await auth.signIn(req, res, body.account.trim(), body.password, secureCookies)) throw new HttpError(401, "Incorrect account or password.");
        return json(res, 200, { ok: true });
      }
      const publicAsset = ["/login", "/login.js", "/style.css", "/favicon.png", "/favicon.ico"].includes(url.pathname) && (method === "GET" || method === "HEAD");
      if (!authenticated && !publicAsset) {
        if (["/", "/wecom-contacts", "/mcp-usage", "/synchronize", "/research"].includes(url.pathname) && (method === "GET" || method === "HEAD")) { res.writeHead(302, { Location: "/login" }); res.end(); return; }
        throw new HttpError(401, "Please sign in first.");
      }
      if (url.pathname === "/login" && authenticated) { res.writeHead(302, { Location: "/" }); res.end(); return; }
      if (method === "POST" && url.pathname === "/api/auth/logout") {
        await auth.signOut(req, res, secureCookies); return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith("/api/research/")) {
        if (machine) throw new HttpError(403, "Research requires administrator login.");
        return await researchRoute(req, res, url, research, readBody);
      }
      if (url.pathname === "/api/prompt" || url.pathname === "/api/prompt/preview") {
        if (machine) throw new HttpError(403, "Prompt management requires administrator login.");
        if (url.search) throw new HttpError(400, "Prompt management does not accept query parameters.");
        if (url.pathname === "/api/prompt" && method === "GET") return json(res, 200, await promptStore.load());
        if (url.pathname === "/api/prompt" && method === "PUT") {
          const body = await readBody(req, 262144);
          if (Object.keys(body).some(k => !["instructions", "revision"].includes(k))) throw new HttpError(400, "Only instructions and revision are accepted.");
          return json(res, 200, await promptStore.save(body.instructions, body.revision));
        }
        if (url.pathname === "/api/prompt/preview" && method === "POST") {
          const body = await readBody(req, 262144);
          if (Object.keys(body).some(k => !["instructions", "mode"].includes(k)) || !["standard", "mcp"].includes(body.mode)) throw new HttpError(400, "Provide instructions and standard or mcp mode.");
          const config = resolveConfig({cwd,dataDir,resourcesDir,model:{...settings,apiKey:settings.apiKey || "preview-only",baseUrl:settings.baseUrl || "https://preview.invalid",modelId:settings.modelId || "not-configured"},fileTools:fileConfig,webTools:webConfig,libraryLinksEnabled:agentSettings.libraryLinks.enabled});
          const release = await knowledgeLock(path.join(dataDir,"urovo-product-expert")).read();
          try { return json(res, 200, {...await previewPrompt(config,body.mode === "mcp",body.instructions), reasoning: isDeepSeekModel(settings) ? agentSettings.effort : "provider-default"}); }
          finally { release(); }
        }
        throw new HttpError(405, "Unsupported prompt operation.");
      }
      if (url.pathname.startsWith("/api/memory-injection/")) {
        if (machine) throw new HttpError(403, "Main memory requires administrator login.");
        if (url.pathname === "/api/memory-injection/download" && method === "GET") {
          if (url.search) throw new HttpError(400, "Memory download does not accept path or query parameters.");
          const bytes = await memoryInjection.download();
          res.writeHead(200, {"Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="MEMORY.md"', "Content-Length": bytes.length});
          res.end(bytes); return;
        }
        if (url.pathname === "/api/memory-injection/download-extra" && method === "GET") {
          if (url.search) throw new HttpError(400, "Memory download does not accept query parameters.");
          const bytes = await new ExtraMemoryStore(dataDir).download();
          res.writeHead(200, {"Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="MEMORY_EXTRA.md"', "Content-Length": bytes.length, "Cache-Control": "no-store"});
          res.end(bytes); return;
        }
        const memoryFile = url.pathname.match(/^\/api\/memory-injection\/files\/(main|extra)$/);
        if (memoryFile) {
          if (url.search) throw new HttpError(400, "The memory editor does not accept query parameters or paths.");
          res.setHeader("Cache-Control", "no-store");
          const extra = new ExtraMemoryStore(dataDir);
          if (method === "GET") return json(res, 200, await (memoryFile[1] === "main" ? memoryInjection.editorSnapshot() : extra.editorSnapshot()));
          if (method !== "PUT") throw new HttpError(405, "Use GET or PUT for the memory editor.");
          const body = await readBody(req, 16 * 1024 * 1024);
          if (Object.keys(body).some(k => !["text", "revision"].includes(k))) throw new HttpError(400, "Only text and revision are accepted.");
          if (memoryFile[1] === "main") return json(res, 200, await memoryInjection.edit(body.text, body.revision));
          try { return json(res, 200, await extra.replace(body.text, body.revision)); }
          catch (error) { throw new HttpError(String((error as Error).message).startsWith("MEMORY_CONFLICT:") ? 409 : 400, (error as Error).message); }
        }
        if (url.pathname === "/api/memory-injection/attachments" && method === "POST") {
          if ([...url.searchParams.keys()].some(key => key !== "name")) throw new HttpError(400, "Only a filename is accepted.");
          return json(res, 201, await memoryInjection.uploadAttachment(url.searchParams.get("name") ?? "", req));
        }
        const attachmentMatch = url.pathname.match(/^\/api\/memory-injection\/attachments\/([a-f0-9-]{36})$/);
        if (attachmentMatch && method === "DELETE") {
          if (url.search) throw new HttpError(400, "Only the attachment ID is accepted.");
          return json(res, 200, await memoryInjection.removeAttachment(attachmentMatch[1]));
        }
        if (url.pathname === "/api/memory-injection/previews" && method === "POST") {
          const body = await readBody(req);
          if (!("prompt" in body) || Object.keys(body).some(key => !["prompt", "attachmentId"].includes(key))) throw new HttpError(400, "Only a prompt and one optional attachmentId are accepted.");
          return json(res, 202, await memoryInjection.preview(body.prompt, body.attachmentId));
        }
        const match = url.pathname.match(/^\/api\/memory-injection\/previews\/([a-f0-9-]{36})(\/confirm)?$/);
        if (match && method === "GET" && !match[2]) return json(res, 200, await memoryInjection.get(match[1]!));
        if (match && method === "POST" && match[2]) {
          const body = await readBody(req);
          if (Object.keys(body).length) throw new HttpError(400, "Confirmation accepts only the saved preview ID.");
          return json(res, 202, await memoryInjection.confirm(match[1]!));
        }
        throw new HttpError(404, "Memory operation not found.");
      }
      if (url.pathname.startsWith("/api/library-import/")) {
        if (machine) throw new HttpError(403, "Imports require administrator login.");
        const route = url.pathname.slice("/api/library-import/".length);
        if (route === "status" && method === "GET") return json(res, 200, await libraryImports.status());
        if (route === "settings/schedule" && method === "GET") return json(res, 200, await librarySchedule.status());
        if (route === "settings/schedule" && method === "PUT") {
          const body = await readBody(req);
          if (Object.keys(body).length !== 2 || !Object.hasOwn(body, "schedule") || !Object.hasOwn(body, "revision")) throw new HttpError(400, "Save accepts only schedule and its opened revision.");
          return json(res, 200, await librarySchedule.save(body.schedule, body.revision));
        }
        if (route === "runs" && method === "POST") {
          if (Object.keys(await readBody(req)).length) throw new HttpError(400, "Library import uses the latest upstream report; request parameters are not accepted.");
          return json(res, 202, await libraryImports.start());
        }
        const match = route.match(/^runs\/([a-f0-9-]{36})(\/stop)?$/);
        if (match && !match[2] && method === "GET") return json(res, 200, await libraryImports.get(match[1]!));
        if (match && match[2] && method === "POST") {
          if (Object.keys(await readBody(req)).length) throw new HttpError(400, "Stop accepts only the saved run ID.");
          return json(res, 200, await libraryImports.stop(match[1]!));
        }
        throw new HttpError(404, "Import operation not found.");
      }
      if (url.pathname.startsWith("/api/wecom-import/")) {
        if (machine) throw new HttpError(403, "Imports require administrator login.");
        const route = url.pathname.slice("/api/wecom-import/".length);
        if (route === "status" && method === "GET") return json(res, 200, await wecomImports.status());
        if (route === "settings/docs" && method === "GET") return json(res, 200, await wecomImports.readDocs());
        if (route === "settings/docs/check" && method === "POST") {
          const body = await readBody(req, MAX_PATHS_BYTES * 6 + 1024);
          if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "text")) throw new HttpError(400, "Check accepts only JSONL text.");
          return json(res, 200, wecomImports.checkDocs(body.text));
        }
        if (route === "settings/docs" && method === "PUT") {
          const body = await readBody(req, MAX_PATHS_BYTES * 6 + 1024);
          if (Object.keys(body).length !== 2 || !Object.hasOwn(body, "text") || !Object.hasOwn(body, "revision")) throw new HttpError(400, "Save accepts only text and its opened revision.");
          return json(res, 200, await wecomImports.saveDocs(body.text, body.revision));
        }
        if (route === "settings/schedule" && method === "GET") return json(res, 200, await wecomSchedule.status());
        if (route === "settings/schedule" && method === "PUT") {
          const body = await readBody(req);
          if (Object.keys(body).length !== 2 || !Object.hasOwn(body, "schedule") || !Object.hasOwn(body, "revision")) throw new HttpError(400, "Save accepts only schedule and its opened revision.");
          return json(res, 200, await wecomSchedule.save(body.schedule, body.revision));
        }
        if (route === "runs" && method === "POST") {
          if (Object.keys(await readBody(req)).length) throw new HttpError(400, "Import uses the configured JSONL list; request parameters are not accepted.");
          return json(res, 202, await wecomImports.start());
        }
        const match = route.match(/^runs\/([a-f0-9-]{36})(\/stop)?$/);
        if (match && !match[2] && method === "GET") return json(res, 200, await wecomImports.get(match[1]!));
        if (match && match[2] && method === "POST") {
          if (Object.keys(await readBody(req)).length) throw new HttpError(400, "Stop accepts only the saved run ID.");
          return json(res, 200, await wecomImports.stop(match[1]!));
        }
        throw new HttpError(404, "Import operation not found.");
      }
      if (url.pathname.startsWith("/api/sftp-sync/")) {
        if (machine) throw new HttpError(403, "Imports require administrator login.");
        const route = url.pathname.slice("/api/sftp-sync/".length);
        if (route === "status" && method === "GET") return json(res, 200, await sftpSync.status());
        if (route === "settings/paths" && method === "GET") return json(res, 200, await sftpSync.readPaths());
        if (route === "settings/paths/check" && method === "POST") {
          const body = await readBody(req, MAX_PATHS_BYTES * 6 + 1024);
          if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "text")) throw new HttpError(400, "Check accepts only JSONL text.");
          return json(res, 200, sftpSync.checkPaths(body.text));
        }
        if (route === "settings/paths" && method === "PUT") {
          const body = await readBody(req, MAX_PATHS_BYTES * 6 + 1024);
          if (Object.keys(body).length !== 2 || !Object.hasOwn(body, "text") || !Object.hasOwn(body, "revision")) throw new HttpError(400, "Save accepts only text and its opened revision.");
          return json(res, 200, await sftpSync.savePaths(body.text, body.revision));
        }
        if (route === "settings/schedule" && method === "GET") return json(res, 200, await sftpSchedule.status());
        if (route === "settings/schedule" && method === "PUT") {
          const body = await readBody(req);
          if (Object.keys(body).length !== 2 || !Object.hasOwn(body, "schedule") || !Object.hasOwn(body, "revision")) throw new HttpError(400, "Save accepts only schedule and its opened revision.");
          return json(res, 200, await sftpSchedule.save(body.schedule, body.revision));
        }
        if (route === "runs" && method === "POST") {
          if (Object.keys(await readBody(req)).length) throw new HttpError(400, "Import uses the configured JSONL list; request parameters are not accepted.");
          return json(res, 202, await sftpSync.start());
        }
        const match = route.match(/^runs\/([a-f0-9-]{36})(\/stop)?$/);
        if (match && !match[2] && method === "GET") return json(res, 200, await sftpSync.get(match[1]!));
        if (match && match[2] && method === "POST") {
          if (Object.keys(await readBody(req)).length) throw new HttpError(400, "Stop accepts only the saved run ID.");
          return json(res, 200, await sftpSync.stop(match[1]!));
        }
        throw new HttpError(404, "Import operation not found.");
      }
      if (url.pathname.startsWith("/api/sync/")) {
        if (machine) throw new HttpError(403, "Maintenance requires administrator login.");
        const route = url.pathname.slice("/api/sync/".length);
        if (route === "settings/schedule" && method === "GET") return json(res, 200, {
          ...await autoSyncSchedule.status(), ...autoSync.status(), trigger: autoSyncSocket.status(),
        });
        if (route === "settings/schedule" && method === "PUT") {
          const body = await readBody(req);
          if (Object.keys(body).length !== 2 || !Object.hasOwn(body, "schedule") || !Object.hasOwn(body, "revision")) throw new HttpError(400, "Save accepts only schedule and its opened revision.");
          const schedule = validateSchedule(body.schedule);
          if (schedule.frequency !== "daily") throw new HttpError(400, "Auto-sync uses a daily Beijing-time schedule.");
          if (schedule.enabled && (!configured() || !autoSyncSocket.status().available)) throw new HttpError(409, "Configure the model and make the private Auto-sync trigger available before enabling it.");
          return json(res, 200, { ...await autoSyncSchedule.save(schedule, body.revision), ...autoSync.status(), trigger: autoSyncSocket.status() });
        }
        if (route === "library" && method === "GET") return json(res, 200, { files: await library.tree(), maxEditBytes: LIBRARY_MAX_EDIT_BYTES });
        if (route === "library/file" && method === "GET") return json(res, 200, await library.read(url.searchParams.get("path") ?? ""));
        if (route === "library/file" && method === "PUT") {
          const body = await readBody(req, 4 * LIBRARY_MAX_EDIT_BYTES);
          return json(res, 200, await library.save(body.path, body.text, body.expectedHash));
        }
        if (route === "incoming" && method === "GET") return json(res, 200, { files: await synchronize.incoming(), maxFileBytes: SYNC_MAX_FILE_BYTES });
        if (route === "incoming" && method === "DELETE") return json(res, 200, await synchronize.removeIncoming(url.searchParams.get("id")));
        if (route === "incoming" && method === "POST") { const file=await synchronize.upload(url.searchParams.get("name") ?? "", req);return json(res,"ignored" in file?200:201,file); }
        if (route === "jobs" && method === "GET") return json(res, 200, { jobs: synchronize.list() });
        const wantsSummary = url.searchParams.get("view") === "summary";
        const respondJob = (job: Awaited<ReturnType<typeof synchronize.get>>, status: number) =>
          json(res, status, wantsSummary ? synchronize.summary(job.id) : job);
        if (route === "jobs" && method === "POST") return respondJob(await synchronize.start((await readBody(req)).ids), 202);
        if (route === "delete-preview" && method === "POST") return respondJob(await synchronize.preview((await readBody(req)).prompt), 202);
        const detail = route.match(/^jobs\/([a-f0-9-]{36})\/items\/([a-f0-9-]{36})\/(coverage|changes\/(\d+))$/);
        if (detail && method === "GET") {
          const coverage = detail[3] === "coverage";
          if ([...url.searchParams.keys()].some(k => coverage || k !== "revision")) throw new HttpError(400, "Invalid report detail query.");
          return json(res, 200, await synchronize.detail(detail[1]!, detail[2]!, coverage ? "coverage" : "change", Number(detail[4] ?? 0), url.searchParams.get("revision") ?? undefined));
        }
        const match = route.match(/^jobs\/([a-f0-9-]{36})(?:\/(stop|resync|cleanup|confirm))?$/);
        if (match && method === "GET" && !match[2]) {
          if ([...url.searchParams].some(([k,v]) => k !== "view" || v !== "summary")) throw new HttpError(400, "Invalid report view.");
          return json(res, 200, wantsSummary ? synchronize.summary(match[1]!) : await synchronize.get(match[1]!));
        }
        if (match && method === "POST") {
          const body = await readBody(req);
          if (match[2] === "stop") return respondJob(await synchronize.stop(match[1]!), 200);
          if (match[2] === "confirm") return respondJob(await synchronize.confirm(match[1]!, body.itemId), 202);
          if (match[2] === "resync") return respondJob(await synchronize.resync(match[1]!, body.itemId, body.feedback ?? "", body.forceConvert === true), 202);
          if (match[2] === "cleanup") return respondJob(await synchronize.cleanup(match[1]!, body.itemId), 200);
        }
        throw new HttpError(404, "Sync operation not found.");
      }
      if (method === "GET" && url.pathname === "/api/status") {
        const extraMemory = await new ExtraMemoryStore(dataDir).snapshot().then(value => ({ ready: true, bytes: Buffer.byteLength(value.text) })).catch(() => ({ ready: false, bytes: 0 }));
        return json(res, 200, { token: csrf, configured: configured(), model: { modelId: settings.modelId, baseUrl: settings.baseUrl, hasKey: Boolean(settings.apiKey), contextWindow: settings.contextWindow, maxTokens: settings.maxTokens }, skills: await resources(), ordinarySkills: await ordinarySkills(), extraMemory, historyRounds: 5, retentionDays: 30, reasoning: { supported: isDeepSeekModel(settings), default: agentSettings.effort, modes: REASONING_MODES }, fileTools: { enabled: fileConfig.enabled, tools: fileConfig.enabled ? fileConfig.tools : [], maxFileBytes: fileConfig.maxFileBytes, acceptedExtensions: [...FILE_EXTENSIONS], visionConfigured: Boolean(fileConfig.vision.baseUrl && fileConfig.vision.apiKey && fileConfig.vision.model), queue: queueState() } });
      }
      const contactMatch = url.pathname.match(/^\/api\/wecom-contacts(?:\/([a-f0-9]{64}))?$/);
      if (contactMatch) {
        if (!contactMatch[1] && method === "GET") return json(res, 200, { contacts: await wecomContacts.list() });
        if (contactMatch[1] && method === "PATCH") {
          let contact;
          try { contact = await wecomContacts.rename(contactMatch[1], await readBody(req)); }
          catch (error) { throw new HttpError(400, redact(error)); }
          if (!contact) throw new HttpError(404, "WeCom contact not found.");
          return json(res, 200, { contact });
        }
        throw new HttpError(405, "WeCom contacts only support listing contacts and updating display names.");
      }
      if (url.pathname === "/mcp-usage" && (method === "GET" || method === "HEAD")) { res.writeHead(302, { Location: "/?settings=mcp" }); res.end(); return; }
      if (url.pathname === "/api/mcp/settings") {
        if (method !== "GET" && method !== "PUT") throw new HttpError(405, "MCP settings support GET and PUT only.");
        if (method === "PUT") {
          if (configuring) throw new HttpError(409, "Agent settings are being updated. Please wait.");
          configuring = true;
          try {
            const body = await readBody(req);
            if (!body || Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") throw new HttpError(400, "Provide the MCP enabled switch only.");
            if (body.enabled && !mcpAccess.configured) throw new HttpError(400, "Set MCP_API_KEY in .env and restart the service before enabling MCP.");
            const next = { ...agentSettings, mcp: { enabled: body.enabled } };
            await agentSettingsStore.save(next); agentSettings = next; mcpOptions.enabled = body.enabled;
          } finally { configuring = false; }
        }
        return json(res, 200, { enabled: mcpOptions.enabled, keyConfigured: mcpAccess.configured, totals: await mcpStore.usageTotals() });
      }
      if (method === "GET" && url.pathname === "/api/mcp/usage") return json(res, 200, { enabled: mcpOptions.enabled, authentication: "bearer", keyConfigured: mcpAccess.configured, ...await mcpStore.summary() });
      if (url.pathname === "/api/config") throw new HttpError(410, "Model connections are configured in .env. Restart the service after making changes.");
      if (url.pathname === "/api/agent-settings") {
        if (method === "GET") return json(res, 200, { settings: agentSettings, reasoningSupported: isDeepSeekModel(settings), webToolsConfigured: Boolean(webConfig.apiKey) });
        if (method !== "PUT") throw new HttpError(405, "Agent settings support GET and PUT only.");
        if (configuring || initializing && !runtime || openingSessions > 0 || [...records.values()].some(item => item.running || item.opening || item.mutating)) throw new HttpError(409, "Wait for the current run to finish before changing agent settings.");
        configuring = true;
        try {
          let next;
          try { next = validateAgentSettings(await readBody(req)); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, redact(error)); }
          next.mcp ??= agentSettings.mcp;
          if (next.mcp?.enabled && !mcpAccess.configured) throw new HttpError(400, "Set MCP_API_KEY in .env and restart the service before enabling MCP.");
          if (!isDeepSeekModel(settings) && next.effort !== agentSettings.effort) throw new HttpError(400, "This model does not support reasoning-level changes. Tool switches remain available.");
          if (WEB_TOOL_NAMES.some(name => next.webTools.tools[name]) && !webConfig.apiKey) throw new HttpError(400, "Online tools require a DeepSeek key. Direct DeepSeek connections reuse API_KEY; otherwise set DEEPSEEK_API_KEY in .env and restart the service.");
          await agentSettingsStore.save(next);
          for (const item of records.values()) { item.session?.dispose(); item.session = undefined; }
          runtime?.dispose(); runtime = undefined; initializing = undefined;
          agentSettings = next; applyAgentSettings(); mcpOptions.enabled = next.mcp?.enabled ?? mcpOptions.enabled;
          return json(res, 200, { settings: agentSettings, reasoningSupported: isDeepSeekModel(settings), webToolsConfigured: Boolean(webConfig.apiKey) });
        } finally { configuring = false; }
      }
      if (method === "GET" && url.pathname === "/api/sessions") return json(res, 200, { sessions: await listSessions() });
      if (method === "POST" && url.pathname === "/api/sessions") {
        if (configuring) throw new HttpError(409, "Agent settings are being updated. Please wait.");
        openingSessions++;
        try {
          let item: RecordState;
          const session = await (await getRuntime()).createSession(undefined, { userRoleStyle: () => item?.userRoleStyle });
          item = { id: session.sessionId, session, running: false, title: "New conversation", updated: new Date().toISOString() };
          records.set(item.id, item);
          if (machine) await bridge.register(item.id);
          return json(res, 201, { id: item.id });
        } finally { openingSessions--; }
      }
      const attachmentMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/files(?:\/([a-f0-9-]{36}))?$/);
      if (attachmentMatch) {
        const item = await findRecord(attachmentMatch[1]!);
        if (method === "GET" && !attachmentMatch[2]) return json(res, 200, { files: await fileStore.list(item.id) });
        if (method === "GET" && attachmentMatch[2]) {
          let opened; try { opened = await fileStore.open(item.id, attachmentMatch[2]); } catch { throw new HttpError(404, "The attachment was not found or does not belong to this conversation."); }
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": opened.file.bytes, "Content-Disposition": `attachment; filename="download${path.extname(opened.file.name)}"; filename*=UTF-8''${encodeURIComponent(opened.file.name).replaceAll("'", "%27")}`, "ETag": `"${opened.file.sha256}"` });
          await pipeline(opened.handle.createReadStream(), res); return;
        }
        if (method === "POST" && !attachmentMatch[2]) {
          if (!fileConfig.enabled || !fileConfig.tools.length) throw new HttpError(409, "Enable at least one file tool in Agent settings before uploading.");
          if (item.running || item.mutating || configuring) throw new HttpError(409, "Wait for the current run to finish before uploading.");
          if (!(req.headers["content-type"] ?? "").startsWith("application/octet-stream")) throw new HttpError(415, "Send the file as binary data.");
          if (Number(req.headers["content-length"] ?? 0) > fileConfig.maxFileBytes) throw new HttpError(413, "The attachment exceeds the size limit.");
          const session = await getSession(item); if (item.running || item.mutating) throw new HttpError(409, "This conversation is running.");
          item.mutating = true;
          try {
            const target = await managedFile(item);
            if (target && !target.exists) { await fs.writeFile(target.file, [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 }); session.dispose(); item.session = undefined; }
            const controller = new AbortController(); req.once("aborted", () => controller.abort());
            let file;
            try { file = await fileStore.upload(item.id, url.searchParams.get("name") ?? "", req, controller.signal); }
            catch (error) { throw new HttpError(400, redact(error)); }
            const targetFile = await managedFile(item); if (targetFile?.exists) item.persistedFile = targetFile.file; if (targetFile?.exists) await fs.utimes(targetFile.file, new Date(), new Date());
            return json(res, 201, { file });
          } finally { item.mutating = false; }
        }
        throw new HttpError(405, "The attachment API does not support this operation.");
      }
      const toolsMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/runs\/([\w-]+)\/tools$/);
      if (method === "GET" && toolsMatch) {
        const item = await findRecord(toolsMatch[1]!);
        const session = await getSession(item);
        const run = [...getToolRuns(session, item.activeRunId).values()].find(r => r.id === toolsMatch[2]);
        if (!run) throw new HttpError(404, "Tool calls for this run were not found.");
        return json(res, 200, { runId: run.id, round: run.round, count: run.calls.length, calls: run.calls });
      }
      const match = url.pathname.match(/^\/api\/sessions\/([\w-]+)(?:\/(run|stop))?$/);
      if (match) {
        const item = await findRecord(match[1]!);
        if (item.mutating) throw new HttpError(409, "This conversation is being updated. Please wait.");
        if (!match[2] && (method === "PATCH" || method === "DELETE")) {
          if (item.running || item.opening || configuring) throw new HttpError(409, "Wait for this conversation run to finish or stop it before renaming or deleting.");
          item.mutating = true;
          try {
            if (method === "PATCH") {
              const body = await readBody(req);
              if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(body.title)) throw new HttpError(400, "Conversation names must be 1–80 characters without line breaks or control characters.");
              const target = await managedFile(item);
              if (!target) throw new HttpError(404, "Conversation not found.");
              const manager = item.session?.sessionManager ?? SessionManager.open(target.file, sessionsDir, cwd);
              if (!target.exists && manager.getEntries().some(e => e.type === "message" && e.message.role === "assistant")) throw new HttpError(404, "The conversation file no longer exists. Refresh the list.");
              manager.appendSessionInfo(body.title.trim());
              if (!target.exists) {
                // SDK defers empty-session writes until an assistant message. Persist the
                // metadata now, then reopen on next access to reset its flush state.
                await fs.writeFile(target.file, [manager.getHeader(), ...manager.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
                item.session?.dispose(); item.session = undefined;
              }
              item.persistedFile = target.file;
              item.title = body.title.trim(); item.updated = new Date().toISOString();
              return json(res, 200, { id: item.id, title: item.title });
            }
            const target = await managedFile(item);
            await mcp?.removeSession(item.id);
            await fileStore.remove(item.id);
            if (target?.exists) await fs.unlink(target.file);
            item.session?.dispose(); item.session = undefined;
            deletedIds.add(item.id); records.delete(item.id);
            await bridge.remove(item.id);
            return json(res, 200, { ok: true, id: item.id });
          } finally { item.mutating = false; }
        }
        if (method === "GET" && !match[2]) {
          const session = await getSession(item);
          const rounds = session.messages.filter(m => m.role === "user").length;
          return json(res, 200, { id: item.id, title: item.title, messages: await publicMessages(session, item.activeRunId), rounds, contextRounds: Math.min(rounds, 5), running: item.running, context: item.context, runs: publicRunMetrics(session, item.activeRunId), files: await fileStore.list(item.id) });
        }
        if (method === "POST" && match[2] === "stop") {
          if (item.running) { item.cancelled = true; item.cancelQueued?.(); await item.session?.abort(); }
          return json(res, 200, { ok: true });
        }
        if (method === "POST" && match[2] === "run") {
          if (item.running || configuring) throw new HttpError(409, "This conversation is running. Please wait or stop it.");
          item.running = true; item.cancelled = false; item.context = undefined;
          let session: AgentSession;
          let releaseRun: (() => void) | undefined;
          const queuedAbort = new AbortController();
          const cancelWaiting = () => queuedAbort.abort();
          item.cancelQueued = cancelWaiting;
          res.once("close", cancelWaiting);
          try {
            const body = await readBody(req);
            if (body.userRoleStyle !== undefined || body.role !== undefined) throw new HttpError(403, "Roles are configured only through the WeCom role API.");
            if (typeof body.text !== "string" || body.text.length > 12000) throw new HttpError(400, "Enter a question with at most 12000 characters.");
            let sender;
            if (body.wecomSender !== undefined) {
              if (!machine) throw new HttpError(403, "Only the WeCom bridge can specify the sender.");
              try { sender = observation(body.wecomSender); } catch { throw new HttpError(400, "Invalid WeCom sender format."); }
            }
            const ids = body.attachmentIds ?? [];
            if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) || new Set(ids).size !== ids.length) throw new HttpError(400, "Attachment IDs must be valid, unique, and no more than 20 per message.");
            if (ids.length && (!fileConfig.enabled || !fileConfig.tools.length)) throw new HttpError(409, "File tools are disabled. Enable a file tool before sending new attachments.");
            const allFiles = await fileStore.list(item.id);
            const attachments = ids.map(id => allFiles.find(file => file.id === id));
            if (attachments.some(file => !file)) throw new HttpError(400, "The attachment was not found or does not belong to this conversation.");
            for (const file of attachments) { const opened = await fileStore.open(item.id, file!.id); await opened.handle.close(); }
            if (!body.text.trim() && !ids.length) throw new HttpError(400, "Enter a question or attach a file.");
            const text = body.text.trim() || "Please analyze the files attached to this message.";
            const supportsEffort = isDeepSeekModel(settings);
            let effort: ReasoningMode | "provider-default" = "provider-default";
            if (body.effort !== undefined && !isReasoningMode(body.effort)) throw new HttpError(400, "Reasoning level must be off, low, high, or max.");
            if (!supportsEffort && body.effort !== undefined) throw new HttpError(400, "Reasoning controls currently support DeepSeek only. Other models use their provider defaults.");
            if (supportsEffort) effort = body.effort ?? agentSettings.effort;
            try { releaseRun = await runGate.acquire(queuedAbort.signal); }
            catch (error) { throw new HttpError(queuedAbort.signal.aborted ? 499 : 429, (error as Error).message); }
            res.off("close", cancelWaiting);
            item.cancelQueued = undefined;
            item.userRoleStyle = machine && sender ? await wecomRoles.get(senderScope(sender)) : undefined;
            const acceptedAt = performance.now();
            const acceptedAtIso = new Date().toISOString();
            session = await getSession(item);
            await loadRunKnowledge(dataDir);
            if (res.destroyed) throw new HttpError(499, "The page connection was closed.");
            if (item.cancelled) throw new HttpError(409, "This run was stopped.");
            if (item.title === "New conversation" && !session.sessionName) item.title = text.slice(0, 36);
            item.updated = new Date().toISOString();
            let finished = false; let calls = 0;
            const started = acceptedAt;
            const initialRounds = session.messages.filter(m => m.role === "user").length;
            const metric: RunMetric = {
              id: randomUUID(), sequence: getRunMetrics(session).length + 1, round: null,
              modelId: settings.modelId, effort, startedAt: acceptedAtIso,
              finishedAt: null, elapsedMs: null, firstTextMs: null, status: "running", toolCalls: [], usage: { input: 0, output: 0, requests: 0, reportedRequests: 0 }, ...(sender ? { wecom: sender } : {}),
            };
            let statistics = Promise.resolve();
            const persistStatistics = () => {
              saveRunMetric(session, metric);
              if (metric.wecom) {
                const snapshot = structuredClone(metric);
                statistics = statistics.then(() => wecomContacts.recordRun(snapshot.wecom!, item.id, snapshot));
                // Do not fail an already running question because of a statistics disk error.
                statistics = statistics.catch(() => { console.warn("Could not save WeCom statistics. Check contact data and disk space."); });
              }
            };
            if (sender) await wecomContacts.recordRun(sender, item.id, metric);
            res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
            res.flushHeaders();
            item.activeRunId = metric.id;
            saveRunMetric(session, metric);
            if (effort !== "provider-default") session.setThinkingLevel(effort);
            const send = (event: string, data: unknown) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
            const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 10000);
            const disconnect = () => { if (!finished) void session.abort(); };
            res.on("close", disconnect);
            const priorPayload = session.agent.onPayload;
            session.agent.onPayload = async (payload, model) => {
              metric.usage!.requests++; persistStatistics();
              const replacement = await priorPayload?.(payload, model);
              const finalPayload = effort === "provider-default"
                ? replacement ?? payload
                : applyDeepSeekReasoning(replacement ?? payload, effort);
              const request = finalPayload as { thinking?: { type: string }; reasoning_effort?: string; messages?: { role: string; content: unknown }[] };
              const messages = request.messages ?? [];
              const system = messages.filter(m => m.role === "system" || m.role === "developer").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
              const context = { effort: request.reasoning_effort ?? null, thinking: request.thinking?.type ?? null, requests: ++calls, userRounds: messages.filter(m => m.role === "user").length, payloadBytes: Buffer.byteLength(JSON.stringify(finalPayload)), extraMemoryCopies: system.split(`${EXTRA_MEMORY_SECTION}\nSource:`).length - 1, skills: DEFAULT_SKILLS.map(name => ({ name, skillCopies: system.split(`## Skill: ${name}\nRoot:`).length - 1, memoryCopies: system.split(`## Business memory: ${name}\nSource:`).length - 1 })) };
              item.context = context;
              send("context", context);
              return finalPayload;
            };
            const publishedIds = new Set<string>();
            const toolStarts = new Map<string, number>();
            const releaseAttachments = captureMessageAttachments(session, metric.id, attachments as import("../file-tools/store.js").ManagedFile[]);
            const unsubscribe = session.subscribe(event => {
              if (event.type === "message_end" && event.message.role === "assistant") {
                const tokens = sdkTokens(event.message.usage);
                if (tokens) { metric.usage!.input += tokens.input; metric.usage!.output += tokens.output; metric.usage!.reportedRequests++; }
                persistStatistics();
              }
              if (event.type === "message_start" && event.message.role === "user") send("message", { attachmentIds: ids });
              if (event.type === "message_end" && event.message.role === "user" && metric.round === null) {
                metric.round = initialRounds + 1;
                saveRunMetric(session, metric);
              }
              if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
                metric.firstTextMs ??= Math.round(performance.now() - started);
                send("text", { delta: event.assistantMessageEvent.delta });
              }
              if (event.type === "tool_execution_start") {
                toolStarts.set(event.toolCallId, performance.now());
                metric.toolCalls!.push({ id: event.toolCallId, startedAt: new Date().toISOString(), finishedAt: null, elapsedMs: null });
                saveRunMetric(session, metric);
                send("tool", { id: event.toolCallId, name: event.toolName, state: "running", count: getToolRuns(session, metric.id).get(initialRounds + 1)?.calls.length ?? metric.toolCalls!.length });
              }
              if (event.type === "tool_execution_end") {
                const result = event.result as { details?: { metrics?: { vision?: { cached?: boolean; usage?: unknown }[] } } };
                for (const vision of result?.details?.metrics?.vision ?? []) {
                  if (vision.cached) continue;
                  metric.usage!.requests++;
                  const tokens = visionTokens(vision.usage);
                  if (tokens) { metric.usage!.input += tokens.input; metric.usage!.output += tokens.output; metric.usage!.reportedRequests++; }
                }
                persistStatistics();
                for (const record of generatedFiles(session)) {
                  if (record.runId !== metric.id || record.toolCallId !== event.toolCallId || publishedIds.has(record.file.id)) continue;
                  publishedIds.add(record.file.id);
                  send("output", { runId: metric.id, file: record.file });
                }
                const timing = metric.toolCalls!.findLast(t => t.id === event.toolCallId);
                const start = toolStarts.get(event.toolCallId);
                if (timing && start !== undefined) { timing.finishedAt = new Date().toISOString(); timing.elapsedMs = Math.round(performance.now() - start); }
                saveRunMetric(session, metric);
                send("tool", { id: event.toolCallId, name: event.toolName, state: event.isError ? "error" : "done", elapsedMs: timing?.elapsedMs });
              }
              if (event.type === "auto_retry_start") send("notice", { text: "The model request failed temporarily. Retrying…" });
            });
            send("start", { id: item.id, title: item.title, run: metric });
            try {
              if (item.cancelled) throw new Error("This run was stopped.");
              await session.prompt(body.text.trim() ? body.text : text);
              const last = session.messages.findLast(m => m.role === "assistant");
              if (item.cancelled || (last?.role === "assistant" && last.stopReason === "aborted")) {
                metric.status = "stopped";
                send("error", { message: "This run was stopped." });
              } else if (last?.role === "assistant" && last.stopReason === "error") {
                metric.status = "failed";
                send("error", { message: redact(last.errorMessage ?? "The model run failed.") });
              } else metric.status = "completed";
            } catch (error) {
              metric.status = item.cancelled ? "stopped" : "failed";
              send("error", { message: redact(error) });
            } finally {
              metric.elapsedMs = Math.round(performance.now() - started);
              metric.finishedAt = new Date().toISOString();
              if (session.messages.filter(m => m.role === "user").length > initialRounds) metric.round = initialRounds + 1;
              try {
                releaseAttachments();
                if (session.sessionFile && await fs.stat(session.sessionFile).catch(() => undefined)) item.persistedFile = session.sessionFile;
                persistStatistics();
                await statistics;
                const runs = publicRunMetrics(session);
                send("done", { messages: await publicMessages(session), rounds: session.messages.filter(m => m.role === "user").length, context: item.context, failed: metric.status !== "completed", run: runs.find(r => r.id === metric.id), runs, files: await fileStore.list(item.id) });
              } finally {
                finished = true; item.activeRunId = undefined; clearInterval(heartbeat); res.off("close", disconnect); unsubscribe(); session.agent.onPayload = priorPayload;
                if (!res.destroyed) res.end();
              }
            }
            return;
          } finally { res.off("close", cancelWaiting); item.cancelQueued = undefined; delete item.userRoleStyle; releaseRun?.(); item.running = false; item.updated = new Date().toISOString(); }
        }
      }
      const assets: Record<string, [string, string]> = {
        "/research": [path.join(resourcesDir, "web/research.html"), "text/html; charset=utf-8"],
        "/research.js": [path.join(resourcesDir, "web/research.js"), "text/javascript; charset=utf-8"],
        "/research.css": [path.join(resourcesDir, "web/research.css"), "text/css; charset=utf-8"],
        "/favicon.png": [path.join(resourcesDir, "web/favicon.png"), "image/png"],
        "/favicon.ico": [path.join(resourcesDir, "web/favicon.png"), "image/png"],
        "/": [path.join(resourcesDir, "web/index.html"), "text/html; charset=utf-8"],
        "/wecom-contacts": [path.join(resourcesDir, "web/contacts.html"), "text/html; charset=utf-8"],
        "/synchronize": [path.join(resourcesDir, "web/synchronize.html"), "text/html; charset=utf-8"],
        "/synchronize.js": [path.join(resourcesDir, "web/synchronize.js"), "text/javascript; charset=utf-8"],
        "/synchronize-source-tabs.js": [path.join(resourcesDir, "web/synchronize-source-tabs.js"), "text/javascript; charset=utf-8"],
        "/synchronize-library.js": [path.join(resourcesDir, "web/synchronize-library.js"), "text/javascript; charset=utf-8"],
        "/synchronize-wecom-imports.js": [path.join(resourcesDir, "web/synchronize-wecom-imports.js"), "text/javascript; charset=utf-8"],
        "/synchronize-wecom-settings.js": [path.join(resourcesDir, "web/synchronize-wecom-settings.js"), "text/javascript; charset=utf-8"],
        "/synchronize-library-settings.js": [path.join(resourcesDir, "web/synchronize-library-settings.js"), "text/javascript; charset=utf-8"],
        "/synchronize-auto-settings.js": [path.join(resourcesDir, "web/synchronize-auto-settings.js"), "text/javascript; charset=utf-8"],
        "/synchronize-sftp-settings.js": [path.join(resourcesDir, "web/synchronize-sftp-settings.js"), "text/javascript; charset=utf-8"],
        "/synchronize.css": [path.join(resourcesDir, "web/synchronize.css"), "text/css; charset=utf-8"],
        "/contacts.js": [path.join(resourcesDir, "web/contacts.js"), "text/javascript; charset=utf-8"],
        "/login": [path.join(resourcesDir, "web/login.html"), "text/html; charset=utf-8"],
        "/login.js": [path.join(resourcesDir, "web/login.js"), "text/javascript; charset=utf-8"],
        "/prompt.js": [path.join(resourcesDir, "web/prompt.js"), "text/javascript; charset=utf-8"],
        "/prompt.css": [path.join(resourcesDir, "web/prompt.css"), "text/css; charset=utf-8"],
        "/memory-editor.js": [path.join(resourcesDir, "web/memory-editor.js"), "text/javascript; charset=utf-8"],
        "/memory-injection.js": [path.join(resourcesDir, "web/memory-injection.js"), "text/javascript; charset=utf-8"],
        "/memory-injection.css": [path.join(resourcesDir, "web/memory-injection.css"), "text/css; charset=utf-8"],
        "/app.js": [path.join(resourcesDir, "web/app.js"), "text/javascript; charset=utf-8"],
        "/style.css": [path.join(resourcesDir, "web/style.css"), "text/css; charset=utf-8"],
        "/vendor/marked.js": [path.join(projectRoot, "node_modules/marked/lib/marked.umd.js"), "text/javascript; charset=utf-8"],
        "/vendor/purify.js": [path.join(projectRoot, "node_modules/dompurify/dist/purify.min.js"), "text/javascript; charset=utf-8"],
      };
      const asset = assets[url.pathname];
      if ((method === "GET" || method === "HEAD") && asset) {
        if (url.pathname === "/favicon.png" || url.pathname === "/favicon.ico") res.setHeader("Cache-Control", "public, max-age=86400");
        const data = await fs.readFile(asset[0]); res.writeHead(200, { "Content-Type": asset[1] }); res.end(method === "HEAD" ? undefined : data); return;
      }
      throw new HttpError(404, "Page or endpoint not found.");
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.end(); return; }
      json(res, error instanceof HttpError || error instanceof ResearchError || error instanceof SyncError || error instanceof ScheduleError ? error.status : 500, { error: redact(error) });
    }
  });
  server.requestTimeout = 60000;
  async function close() {
    await autoSync.close();
    await autoSyncSocket.close();
    await research.close();
    const wecomClosing = wecomImports.close();
    const libraryClosing = libraryImports.close();
    const sftpClosing = sftpSync.close();
    const syncClosing = synchronize.close();
    const memoryClosing = memoryInjection.close();
    await mcp?.close();
    await Promise.allSettled([...records.values()].filter(r => r.running).map(r => { r.cancelQueued?.(); return r.session?.abort(); }));
    await wecomClosing;
    await libraryClosing;
    await sftpClosing;
    await syncClosing;
    await autoSync.wait();
    await memoryClosing;
    for (const r of records.values()) r.session?.dispose();
    runtime?.dispose();
    await auth.close(); retention.dispose();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await autoSyncSocket.listen();
  return { server, close };
}
