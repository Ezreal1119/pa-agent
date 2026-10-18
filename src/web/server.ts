import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parse as parseEnv } from "dotenv";
import { AgentRuntime } from "../agent/runtime.js";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SKILLS, ON_DEMAND_SKILLS, loadRunKnowledge } from "../agent/knowledge.js";
import { REASONING_MODES, isReasoningMode, isDeepSeekModel, applyDeepSeekReasoning, type ReasoningMode } from "../agent/reasoning.js";
import { getRunMetrics, saveRunMetric, type RunMetric } from "./run-metrics.js";
import { getToolRuns, publicRunMetrics } from "./tool-calls.js";
import type { AgentConfigOptions } from "../config.js";
import { AgentSettingsStore, validateAgentSettings } from "./agent-settings.js";
import { WebAuth } from "./auth.js";
import { ExtraMemoryStore, EXTRA_MEMORY_SECTION } from "../agent/extra-memory.js";
import { fileToolConfig, FILE_TOOL_NAMES, type FileToolOptions } from "../file-tools/config.js";
import { generatedFiles } from "../file-tools/outputs.js";
import { FileStore } from "../file-tools/store.js";
import { captureMessageAttachments, messageAttachments } from "../agent/message-attachments.js";
import { SessionRetention } from "../agent/retention.js";
import { queueState } from "../file-tools/runner.js";
import { pipeline } from "node:stream/promises";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MONTH = 30 * 86400000;
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
type ModelSettings = { apiKey: string; baseUrl: string; modelId: string; contextWindow: number; maxTokens: number };
type RecordState = { id: string; persistedFile?: string; session?: AgentSession; running: boolean; title: string; updated: string; context?: unknown; opening?: Promise<AgentSession>; cancelled?: boolean; activeRunId?: string; mutating?: boolean };
export interface WebOptions { cwd?: string; dataDir?: string; resourcesDir?: string; model?: Partial<ModelSettings>; admin?: { account: string; password: string }; fileTools?: FileToolOptions; }

export async function createWebServer(options: WebOptions = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dataDir = path.resolve(options.dataDir ?? process.env.AGENT_DATA_DIR ?? path.join(cwd, ".data"));
  const resourcesDir = path.resolve(options.resourcesDir ?? path.join(projectRoot, "resources"));
  const sessionsDir = path.join(dataDir, "sessions");
  const diskEnv = await fs.readFile(path.join(cwd, ".env"), "utf8").then(parseEnv).catch(error => {
    if (error.code === "ENOENT") return {} as Record<string, string>;
    throw error;
  });
  const fileConfig = fileToolConfig(dataDir, options.fileTools, { ...diskEnv, ...process.env });
  const agentSettingsStore = new AgentSettingsStore(dataDir);
  let agentSettings = await agentSettingsStore.load({ effort: "low", fileTools: { enabled: fileConfig.enabled, tools: Object.fromEntries(FILE_TOOL_NAMES.map(name => [name, fileConfig.tools.includes(name)])) as Record<typeof FILE_TOOL_NAMES[number], boolean> } });
  const applyAgentSettings = () => { fileConfig.enabled = agentSettings.fileTools.enabled; fileConfig.tools = FILE_TOOL_NAMES.filter(name => agentSettings.fileTools.tools[name]); };
  applyAgentSettings();
  const fileStore = new FileStore(fileConfig);
  const settings: ModelSettings = {
    apiKey: options.model?.apiKey ?? process.env.API_KEY ?? diskEnv.API_KEY ?? "",
    baseUrl: options.model?.baseUrl ?? process.env.BASE_URL ?? diskEnv.BASE_URL ?? "",
    modelId: options.model?.modelId ?? process.env.MODEL_ID ?? diskEnv.MODEL_ID ?? "",
    contextWindow: options.model?.contextWindow ?? Number(process.env.CONTEXT_WINDOW ?? diskEnv.CONTEXT_WINDOW ?? 128000),
    maxTokens: options.model?.maxTokens ?? Number(process.env.MAX_TOKENS ?? diskEnv.MAX_TOKENS ?? 16384),
  };
  const csrf = randomBytes(24).toString("hex");
  const adminAccount = (options.admin?.account ?? process.env.ADMIN_ACCOUNT ?? diskEnv.ADMIN_ACCOUNT ?? "").trim();
  const adminPassword = options.admin?.password ?? process.env.ADMIN_PASSWORD ?? diskEnv.ADMIN_PASSWORD ?? "";
  const auth = new WebAuth(adminAccount, adminPassword);
  const records = new Map<string, RecordState>();
  const deletedIds = new Set<string>();
  let runtime: AgentRuntime | undefined;
  let initializing: Promise<AgentRuntime> | undefined;
  let configuring = false;
  let openingSessions = 0;
  const configured = () => Boolean(settings.apiKey && settings.baseUrl && settings.modelId);
  const redact = (error: unknown) => {
    let message = error instanceof Error ? error.message : String(error);
    if (settings.apiKey) message = message.split(settings.apiKey).join("[REDACTED]");
    if (adminPassword) message = message.split(adminPassword).join("[REDACTED]");
    if (fileConfig.vision.apiKey) message = message.split(fileConfig.vision.apiKey).join("[REDACTED]");
    return message.slice(0, 2000);
  };
  const getRuntime = async () => {
    if (!configured()) throw new HttpError(409, "请在 .env 配置 BASE_URL、MODEL_ID 和 API_KEY，并重启服务。");
    if (!initializing) {
      const config: AgentConfigOptions = { cwd, dataDir, resourcesDir, model: settings, fileTools: fileConfig };
      initializing = AgentRuntime.create(config).then(value => runtime = value).catch(error => { initializing = undefined; throw error; });
    }
    return initializing;
  };
  async function resources() {
    return Promise.all(DEFAULT_SKILLS.map(async name => ({ name, files: await Promise.all(["SKILL.md", "MEMORY.md"].map(async file => {
      try {
        const text = await fs.readFile(path.join(dataDir, name, file), "utf8");
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
    item?.session?.dispose(); records.delete(id);
  });
  await retention.cleanup(); retention.start();
  async function savedSessions() {
    if (!await fs.stat(sessionsDir).catch(() => undefined)) return [];
    const sessions = await SessionManager.list(cwd, sessionsDir);
    return sessions.filter(s => s.modified.getTime() >= Date.now() - MONTH);
  }
  async function findRecord(id: string) {
    if (deletedIds.has(id) || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new HttpError(404, "会话不存在。");
    const cached = records.get(id);
    if (cached) {
      const file = cached.persistedFile;
      const stat = file ? await fs.stat(file).catch(() => undefined) : undefined;
      if (!cached.running && !cached.mutating && file && (!stat || stat.mtimeMs < Date.now() - MONTH)) {
        await retention.cleanup();
        if (!stat) { await fileStore.remove(id); cached.session?.dispose(); records.delete(id); }
        throw new HttpError(404, "会话已过期，请新建会话。");
      }
      return cached;
    }
    const saved = (await savedSessions()).find(s => s.id === id);
    if (!saved || deletedIds.has(id)) throw new HttpError(404, "会话不存在或已过期，请新建会话。");
    const current = records.get(id);
    if (current) return current;
    const item: RecordState = { id, persistedFile: saved.path, running: false, title: saved.name ?? saved.firstMessage.slice(0, 36), updated: saved.modified.toISOString() };
    records.set(id, item);
    return item;
  }
  async function getSession(item: RecordState): Promise<AgentSession> {
    if (deletedIds.has(item.id)) throw new HttpError(404, "会话已删除。");
    if (item.mutating) throw new HttpError(409, "会话信息正在更新，请稍后。");
    if (item.session) return item.session;
    if (item.opening) return item.opening;
    if (configuring) throw new HttpError(409, "正在更新 Agent 设置，请稍后。");
    openingSessions++;
    item.opening = (async () => {
      try {
        const engine = await getRuntime();
        const saved = (await savedSessions()).find(s => s.id === item.id);
        const manager = saved ? SessionManager.open(saved.path, sessionsDir, cwd) : SessionManager.create(cwd, sessionsDir, { id: item.id });
        return item.session = await engine.createSession(manager);
      } finally { openingSessions--; item.opening = undefined; }
    })();
    return item.opening;
  }

  /** Browser IDs resolve to SDK-managed files; never accept a path from the client. */
  async function managedFile(item: RecordState) {
    const file = item.session?.sessionFile ?? (await savedSessions()).find(s => s.id === item.id)?.path;
    if (!file) return undefined;
    const relative = path.relative(sessionsDir, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !file.endsWith(".jsonl")) throw new HttpError(400, "会话文件路径不正确。");
    const info = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(400, "会话文件必须为普通文件。");
      const actual = await fs.realpath(file);
      const root = await fs.realpath(sessionsDir);
      const actualRelative = path.relative(root, actual);
      if (actualRelative === ".." || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) throw new HttpError(400, "会话文件超出存储目录。");
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
      if (call.name === "excel_patch_template" && call.status === "completed" && result?.details?.ok === true && result.details.file?.id) addOutput(run.round, result.details.file.id);
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
        const placeholder = view("assistant", outputs.has(round) ? "本轮已生成文件，可在下方下载。" : "本轮尚无文字回答，可查看工具调用记录。", toolRun?.calls.at(-1)?.requestedAt ?? Date.now(), round);
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
      if (answer.run && answer.run.status !== "completed") answer.outputNotice = answer.run?.status === "running" ? "文件已生成，本轮仍在继续。" : "文件已生成；本轮回答未完整完成，仍可下载。";
    }
    return output;
  }
  async function listSessions() {
    await retention.cleanup();
    const list = new Map((await savedSessions()).filter(s => !deletedIds.has(s.id)).map(s => [s.id, { id: s.id, title: s.name ?? s.firstMessage.slice(0, 36) ?? "新对话", updated: s.modified.toISOString(), running: false }]));
    for (const r of records.values()) list.set(r.id, { id: r.id, title: r.title, updated: r.updated, running: r.running });
    return [...list.values()].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 100);
  }
  async function readBody(req: IncomingMessage) {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "请使用 JSON 请求。");
    const parts: Buffer[] = []; let size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > 65536) throw new HttpError(413, "请求过长，请缩短问题。");
      parts.push(part);
    }
    try {
      const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    }
    catch { throw new HttpError(400, "请求格式不正确。"); }
  }
  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }
  function validRequest(req: IncomingMessage) {
    const port = (server.address() as import("node:net").AddressInfo).port;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const host = req.headers.host;
    if (!host || !allowed.has(host)) throw new HttpError(403, "只允许通过本机地址访问。");
    if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new HttpError(403, "不允许跨站请求。");
    if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "不允许跨站请求。");
    if (!["GET", "HEAD"].includes(req.method ?? "") && req.headers["x-local-token"] !== csrf) throw new HttpError(403, "页面已过期，请刷新后重试。");
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      validRequest(req);
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method;
      const authenticated = auth.authenticated(req);
      if (method === "GET" && url.pathname === "/api/auth/status") return json(res, 200, { token: csrf, configured: auth.configured, authenticated });
      if (method === "POST" && url.pathname === "/api/auth/login") {
        if (!auth.configured) throw new HttpError(503, "请在 .env 配置 ADMIN_ACCOUNT 和 ADMIN_PASSWORD，重启服务后登录。");
        const retryAfter = auth.retryAfter(req);
        if (retryAfter) { res.setHeader("Retry-After", retryAfter); throw new HttpError(429, "登录尝试过于频繁，请一分钟后再试。"); }
        const body = await readBody(req);
        if (typeof body.account !== "string" || typeof body.password !== "string" || body.account.length > 256 || body.password.length > 4096) throw new HttpError(400, "请输入有效的账号和密码。");
        if (!auth.login(req, res, body.account.trim(), body.password)) throw new HttpError(401, "账号或密码不正确。");
        return json(res, 200, { ok: true });
      }
      const publicAsset = ["/login", "/login.js", "/style.css"].includes(url.pathname) && (method === "GET" || method === "HEAD");
      if (!authenticated && !publicAsset) {
        if (url.pathname === "/" && (method === "GET" || method === "HEAD")) { res.writeHead(302, { Location: "/login" }); res.end(); return; }
        throw new HttpError(401, "请先登录。");
      }
      if (url.pathname === "/login" && authenticated) { res.writeHead(302, { Location: "/" }); res.end(); return; }
      if (method === "POST" && url.pathname === "/api/auth/logout") {
        auth.logout(req, res); return json(res, 200, { ok: true });
      }
      if (method === "GET" && url.pathname === "/api/status") {
        const extraMemory = await new ExtraMemoryStore(dataDir).snapshot().then(value => ({ ready: true, bytes: Buffer.byteLength(value.text) })).catch(() => ({ ready: false, bytes: 0 }));
        return json(res, 200, { token: csrf, configured: configured(), model: { modelId: settings.modelId, baseUrl: settings.baseUrl, hasKey: Boolean(settings.apiKey), contextWindow: settings.contextWindow, maxTokens: settings.maxTokens }, skills: await resources(), ordinarySkills: await ordinarySkills(), extraMemory, historyRounds: 5, retentionDays: 30, reasoning: { supported: isDeepSeekModel(settings), default: agentSettings.effort, modes: REASONING_MODES }, fileTools: { enabled: fileConfig.enabled, tools: fileConfig.enabled ? fileConfig.tools : [], maxFileBytes: fileConfig.maxFileBytes, visionConfigured: Boolean(fileConfig.vision.baseUrl && fileConfig.vision.apiKey && fileConfig.vision.model), queue: queueState() } });
      }
      if (url.pathname === "/api/config") throw new HttpError(410, "模型连接参数仅通过 .env 管理，修改后请重启服务。");
      if (url.pathname === "/api/agent-settings") {
        if (method === "GET") return json(res, 200, { settings: agentSettings, reasoningSupported: isDeepSeekModel(settings) });
        if (method !== "PUT") throw new HttpError(405, "Agent 设置接口支持 GET/PUT。");
        if (configuring || initializing && !runtime || openingSessions > 0 || [...records.values()].some(item => item.running || item.opening || item.mutating)) throw new HttpError(409, "请等待当前任务结束，再修改 Agent 设置。");
        configuring = true;
        try {
          let next;
          try { next = validateAgentSettings(await readBody(req)); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, redact(error)); }
          if (!isDeepSeekModel(settings) && next.effort !== agentSettings.effort) throw new HttpError(400, "当前模型不支持思考强度调整，工具开关仍可设置。");
          await agentSettingsStore.save(next);
          for (const item of records.values()) { item.session?.dispose(); item.session = undefined; }
          runtime?.dispose(); runtime = undefined; initializing = undefined;
          agentSettings = next; applyAgentSettings();
          return json(res, 200, { settings: agentSettings, reasoningSupported: isDeepSeekModel(settings) });
        } finally { configuring = false; }
      }
      if (method === "GET" && url.pathname === "/api/sessions") return json(res, 200, { sessions: await listSessions() });
      if (method === "POST" && url.pathname === "/api/sessions") {
        if (configuring) throw new HttpError(409, "正在更新 Agent 设置，请稍后。");
        openingSessions++;
        try {
          const session = await (await getRuntime()).createSession();
          const item: RecordState = { id: session.sessionId, session, running: false, title: "新对话", updated: new Date().toISOString() };
          records.set(item.id, item);
          return json(res, 201, { id: item.id });
        } finally { openingSessions--; }
      }
      const attachmentMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/files(?:\/([a-f0-9-]{36}))?$/);
      if (attachmentMatch) {
        const item = await findRecord(attachmentMatch[1]!);
        if (method === "GET" && !attachmentMatch[2]) return json(res, 200, { files: await fileStore.list(item.id) });
        if (method === "GET" && attachmentMatch[2]) {
          let opened; try { opened = await fileStore.open(item.id, attachmentMatch[2]); } catch { throw new HttpError(404, "附件不存在或不属于当前会话。"); }
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": opened.file.bytes, "Content-Disposition": `attachment; filename="download${path.extname(opened.file.name)}"; filename*=UTF-8''${encodeURIComponent(opened.file.name).replaceAll("'", "%27")}`, "ETag": `"${opened.file.sha256}"` });
          await pipeline(opened.handle.createReadStream(), res); return;
        }
        if (method === "POST" && !attachmentMatch[2]) {
          if (!fileConfig.enabled || !fileConfig.tools.length) throw new HttpError(409, "文件工具已关闭，请在 Agent 设置中启用。");
          if (item.running || item.mutating || configuring) throw new HttpError(409, "请等待当前运行结束后上传。");
          if (!(req.headers["content-type"] ?? "").startsWith("application/octet-stream")) throw new HttpError(415, "请发送文件二进制数据。");
          if (Number(req.headers["content-length"] ?? 0) > fileConfig.maxFileBytes) throw new HttpError(413, "附件超过大小限制。");
          const session = await getSession(item); if (item.running || item.mutating) throw new HttpError(409, "会话正在执行。");
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
        throw new HttpError(405, "附件接口不支持此操作。");
      }
      const toolsMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/runs\/([\w-]+)\/tools$/);
      if (method === "GET" && toolsMatch) {
        const item = await findRecord(toolsMatch[1]!);
        const session = await getSession(item);
        const run = [...getToolRuns(session, item.activeRunId).values()].find(r => r.id === toolsMatch[2]);
        if (!run) throw new HttpError(404, "本轮工具调用记录不存在。");
        return json(res, 200, { runId: run.id, round: run.round, count: run.calls.length, calls: run.calls });
      }
      const match = url.pathname.match(/^\/api\/sessions\/([\w-]+)(?:\/(run|stop))?$/);
      if (match) {
        const item = await findRecord(match[1]!);
        if (item.mutating) throw new HttpError(409, "会话信息正在更新，请稍后。");
        if (!match[2] && (method === "PATCH" || method === "DELETE")) {
          if (item.running || item.opening || configuring) throw new HttpError(409, "请先等待该会话执行结束或停止，再修改或删除。");
          item.mutating = true;
          try {
            if (method === "PATCH") {
              const body = await readBody(req);
              if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(body.title)) throw new HttpError(400, "会话名称需为 1–80 个字符，不能包含换行或控制字符。");
              const target = await managedFile(item);
              if (!target) throw new HttpError(404, "会话不存在。");
              const manager = item.session?.sessionManager ?? SessionManager.open(target.file, sessionsDir, cwd);
              if (!target.exists && manager.getEntries().some(e => e.type === "message" && e.message.role === "assistant")) throw new HttpError(404, "会话文件已不存在，请刷新列表。");
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
            await fileStore.remove(item.id);
            if (target?.exists) await fs.unlink(target.file);
            item.session?.dispose(); item.session = undefined;
            deletedIds.add(item.id); records.delete(item.id);
            return json(res, 200, { ok: true, id: item.id });
          } finally { item.mutating = false; }
        }
        if (method === "GET" && !match[2]) {
          const session = await getSession(item);
          const rounds = session.messages.filter(m => m.role === "user").length;
          return json(res, 200, { id: item.id, title: item.title, messages: await publicMessages(session, item.activeRunId), rounds, contextRounds: Math.min(rounds, 5), running: item.running, context: item.context, runs: publicRunMetrics(session, item.activeRunId), files: await fileStore.list(item.id) });
        }
        if (method === "POST" && match[2] === "stop") {
          if (item.running) { item.cancelled = true; await item.session?.abort(); }
          return json(res, 200, { ok: true });
        }
        if (method === "POST" && match[2] === "run") {
          if (item.running || configuring) throw new HttpError(409, "当前对话正在执行，请稍后或点击停止。");
          item.running = true; item.cancelled = false; item.context = undefined;
          let session: AgentSession;
          try {
            const body = await readBody(req);
            if (typeof body.text !== "string" || body.text.length > 12000) throw new HttpError(400, "请输入问题，最多 12000 个字符。");
            const ids = body.attachmentIds ?? [];
            if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) || new Set(ids).size !== ids.length) throw new HttpError(400, "附件 ID 格式错误、重复或数量超过 20 个。");
            if (ids.length && (!fileConfig.enabled || !fileConfig.tools.length)) throw new HttpError(409, "文件工具已关闭，不能发送新附件。");
            const allFiles = await fileStore.list(item.id);
            const attachments = ids.map(id => allFiles.find(file => file.id === id));
            if (attachments.some(file => !file)) throw new HttpError(400, "附件不存在或不属于当前会话。");
            for (const file of attachments) { const opened = await fileStore.open(item.id, file!.id); await opened.handle.close(); }
            if (!body.text.trim() && !ids.length) throw new HttpError(400, "请输入问题或添加附件。");
            const text = body.text.trim() || "请分析本条消息附带的文件。";
            const supportsEffort = isDeepSeekModel(settings);
            let effort: ReasoningMode | "provider-default" = "provider-default";
            if (body.effort !== undefined && !isReasoningMode(body.effort)) throw new HttpError(400, "思考强度必须为 off、low、high 或 max。");
            if (!supportsEffort && body.effort !== undefined) throw new HttpError(400, "当前强度按钮仅适配 DeepSeek 模型，其他模型沿用供应商默认设置。");
            if (supportsEffort) effort = body.effort ?? agentSettings.effort;
            const acceptedAt = performance.now();
            const acceptedAtIso = new Date().toISOString();
            session = await getSession(item);
            await loadRunKnowledge(dataDir);
            if (res.destroyed) throw new HttpError(499, "页面连接已关闭。");
            if (item.cancelled) throw new HttpError(409, "本次执行已停止。");
            if (item.title === "新对话" && !session.sessionName) item.title = text.slice(0, 36);
            item.updated = new Date().toISOString();
            res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
            res.flushHeaders();
            let finished = false; let calls = 0;
            const started = acceptedAt;
            const initialRounds = session.messages.filter(m => m.role === "user").length;
            const metric: RunMetric = {
              id: randomUUID(), sequence: getRunMetrics(session).length + 1, round: null,
              modelId: settings.modelId, effort, startedAt: acceptedAtIso,
              finishedAt: null, elapsedMs: null, firstTextMs: null, status: "running", toolCalls: [],
            };
            item.activeRunId = metric.id;
            saveRunMetric(session, metric);
            if (effort !== "provider-default") session.setThinkingLevel(effort);
            const send = (event: string, data: unknown) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
            const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 10000);
            const disconnect = () => { if (!finished) void session.abort(); };
            res.on("close", disconnect);
            const priorPayload = session.agent.onPayload;
            session.agent.onPayload = async (payload, model) => {
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
              if (event.type === "auto_retry_start") send("notice", { text: "模型请求暂时失败，正在重试…" });
            });
            send("start", { id: item.id, title: item.title, run: metric });
            try {
              if (item.cancelled) throw new Error("本次执行已停止。");
              await session.prompt(text);
              const last = session.messages.findLast(m => m.role === "assistant");
              if (item.cancelled || (last?.role === "assistant" && last.stopReason === "aborted")) {
                metric.status = "stopped";
                send("error", { message: "本次执行已停止。" });
              } else if (last?.role === "assistant" && last.stopReason === "error") {
                metric.status = "failed";
                send("error", { message: redact(last.errorMessage ?? "模型执行失败。") });
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
                saveRunMetric(session, metric);
                const runs = publicRunMetrics(session);
                send("done", { messages: await publicMessages(session), rounds: session.messages.filter(m => m.role === "user").length, context: item.context, failed: metric.status !== "completed", run: runs.find(r => r.id === metric.id), runs, files: await fileStore.list(item.id) });
              } finally {
                finished = true; item.activeRunId = undefined; clearInterval(heartbeat); res.off("close", disconnect); unsubscribe(); session.agent.onPayload = priorPayload;
                if (!res.destroyed) res.end();
              }
            }
            return;
          } finally { item.running = false; item.updated = new Date().toISOString(); }
        }
      }
      const assets: Record<string, [string, string]> = {
        "/": [path.join(resourcesDir, "web/index.html"), "text/html; charset=utf-8"],
        "/login": [path.join(resourcesDir, "web/login.html"), "text/html; charset=utf-8"],
        "/login.js": [path.join(resourcesDir, "web/login.js"), "text/javascript; charset=utf-8"],
        "/app.js": [path.join(resourcesDir, "web/app.js"), "text/javascript; charset=utf-8"],
        "/style.css": [path.join(resourcesDir, "web/style.css"), "text/css; charset=utf-8"],
        "/vendor/marked.js": [path.join(projectRoot, "node_modules/marked/lib/marked.umd.js"), "text/javascript; charset=utf-8"],
        "/vendor/purify.js": [path.join(projectRoot, "node_modules/dompurify/dist/purify.min.js"), "text/javascript; charset=utf-8"],
      };
      const asset = assets[url.pathname];
      if ((method === "GET" || method === "HEAD") && asset) {
        const data = await fs.readFile(asset[0]); res.writeHead(200, { "Content-Type": asset[1] }); res.end(method === "HEAD" ? undefined : data); return;
      }
      throw new HttpError(404, "页面或接口不存在。");
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.end(); return; }
      json(res, error instanceof HttpError ? error.status : 500, { error: redact(error) });
    }
  });
  server.requestTimeout = 60000;
  async function close() {
    await Promise.allSettled([...records.values()].filter(r => r.running).map(r => r.session?.abort()));
    for (const r of records.values()) r.session?.dispose();
    runtime?.dispose();
    auth.dispose(); retention.dispose();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  return { server, close };
}
