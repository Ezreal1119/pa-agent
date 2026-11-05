import "dotenv/config";
import fs from "node:fs";
import { LibraryMaintenance, type LibraryMaintenanceOptions } from "./library-maintenance.js";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { CkdWorkflow, downloadableResult, type CkdOptions } from "./service.js";
import { isInside } from "./store.js";
import { validateCkdLibrary, type LibraryValidationOptions } from "./library-validation.js";
import type { CkdRun } from "./types.js";
import type { CreateCkdSopGraphInput } from "./contract.js";
import { publicImageReview } from "./image-review-stage.js";
import { sha256 } from "./scripts.js";
import { ImageInputError, inspectImage, MAX_IMAGE_BYTES } from "./image-input.js";
import { AssessmentCalibrationJobs } from "./image-assessment-calibration.js";
import { readImagePolicy, saveImagePolicy, DEFAULT_POLICY } from "./image-assessment.js";
import { PixelImageChecker, PIXEL_POLICY, PIXEL_CONFIG_HASH } from './image-pixel.js';
import { scoringContext, scoreWithContext, checkOperationFocus } from './image-scorer.js';
import { createProject, deleteProcess, listProcesses, listProjects, readPhoto, readProcess, reorderProcesses, saveProcess, EDITOR_SOP_TYPE } from "./editor-library.js";
import { EditorInputError, EDITOR_LANGUAGES, type EditorProcessInput } from "./editor-types.js";
import { ClientAccess, ClientAccessError } from "./client-access.js";
import { AdminAccess, AdminAccessError } from "./admin-access.js";

const uiRoot = fileURLToPath(new URL("../../resources/ckd-ui/", import.meta.url));
const assets = new Map([["/", ["index.html", "text/html; charset=utf-8"]], ["/app.js", ["app.js", "text/javascript; charset=utf-8"]], ["/style.css", ["style.css", "text/css; charset=utf-8"]], ["/login", ["login.html", "text/html; charset=utf-8"]], ["/login.js", ["login.js", "text/javascript; charset=utf-8"]], ["/editor", ["editor.html", "text/html; charset=utf-8"]], ["/editor.js", ["editor.js", "text/javascript; charset=utf-8"]], ["/editor.css", ["editor.css", "text/css; charset=utf-8"]]]);
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function view(run: CkdRun, busy: boolean, operationError?: string) {
  const result=downloadableResult(run);
  return { id: run.id, status: run.status, busy, currentNodeId: run.currentNodeId, inputs: run.inputs, imagePhase: run.imageReviewMode ? run.imageReview?.approved ? "generating" : "reviewing" : undefined, imageReview: publicImageReview(run), pendingQuestion: run.pendingQuestion, error: operationError ?? run.error, createdAt: run.createdAt, updatedAt: run.updatedAt,
    imageCheck:run.imageCheck,
    result: result ? { provisional:!run.finalResult, output: result.output, artifacts: result.artifacts.map((file, index) => ({ name: path.basename(file), url: `/api/runs/${run.id}/artifacts/${index}` })) } : undefined };
}
async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) throw new HttpError(415, "请使用 JSON 请求。");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 65536) throw new HttpError(413, "输入内容过长。"); chunks.push(bytes); }
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new HttpError(400, "输入必须是 JSON 对象。"); }
}
/**
 * 逐工序录入专用：一次提交带 4 张裁剪图，base64 后远超普通接口的 64KB。
 * 上限放在 48 MB，仍远低于 Node 默认堆；超过时提示用户先压图而不是静默失败。
 */
const EDITOR_BODY_LIMIT = 48 * 1024 * 1024;
async function editorBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) throw new HttpError(415, "请使用 JSON 请求。");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > EDITOR_BODY_LIMIT) throw new HttpError(413, "本次提交超过 48 MB，请减少图片数量或压缩后再试。");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > EDITOR_BODY_LIMIT) throw new HttpError(413, "本次提交超过 48 MB，请减少图片数量或压缩后再试。");
    chunks.push(bytes);
  }
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new HttpError(400, "输入必须是 JSON 对象。"); }
}
export function createCkdUiServer(options: CkdOptions & { maintenanceModel?: LibraryMaintenanceOptions["model"]; maintenanceModelTimeoutMs?: number; adminAuth?: AdminAccess | false } = {}) {
  const adminAccess = options.adminAuth === false ? undefined : options.adminAuth ?? (process.env.CKD_ADMIN_USER && process.env.CKD_ADMIN_PASSWORD_HASH ? new AdminAccess(process.env.CKD_ADMIN_USER, process.env.CKD_ADMIN_PASSWORD_HASH) : undefined);
  if (process.env.NODE_ENV === "production" && !adminAccess) throw new Error("生产环境必须配置 CKD_ADMIN_USER 和 CKD_ADMIN_PASSWORD_HASH。");
  const publicOrigin = process.env.CKD_ADMIN_ORIGIN;
  if (adminAccess && publicOrigin && !/^https?:\/\/[^/]+$/u.test(publicOrigin)) throw new Error("CKD_ADMIN_ORIGIN 必须是完整的 HTTP(S) Origin。");
  if (process.env.NODE_ENV === "production" && !publicOrigin) throw new Error("生产环境必须配置 CKD_ADMIN_ORIGIN。");
  const service = new CkdWorkflow(options);
  const clientAccess = new ClientAccess(service.dataDir);
  /**
   * 待审核区：<库根>/public，内部结构与库根一致（public/product_lib/<项目>/assemble/...）。
   * catalog 只扫 <库根>/product_lib，所以这里的草稿不会被生成流程读到；
   * 管理员确认后把整个项目目录挪进 product_lib 即可，sops.json 跟着走。
   */
  const publicEditorRoot = () => { const root = path.join(service.libraryPath, "public"); fs.mkdirSync(root, { recursive: true }); return root; };
  const fixedPixel=service.imageQuality instanceof PixelImageChecker;
  const imageCalibration = new AssessmentCalibrationJobs(service.dataDir, service.imageQuality instanceof PixelImageChecker?service.imageQuality.legacy():service.imageQuality);
  const calibrationJobs = new Map<string, Promise<unknown>>();
  async function launchCalibration(id: string) {
    if (calibrationJobs.has(id)) throw new HttpError(409, "Calibration job is busy.");
    const promise = imageCalibration.resume(id); calibrationJobs.set(id, promise);
    let earlyError: unknown;
    void promise.catch(error => { earlyError = error; }).finally(() => calibrationJobs.delete(id));
    await new Promise<void>(resolve => setImmediate(resolve));
    if (earlyError) throw earlyError;
    return imageCalibration.get(id);
  }
  const maintenance = new LibraryMaintenance({ dataDir: service.dataDir, libraryPath: service.libraryPath, model: options.maintenanceModel, modelTimeoutMs: options.maintenanceModelTimeoutMs, imageChecker:service.imageQuality, onEvent: message => options.onEvent?.({runId:"library",type:"status",message}) });
  const maintenanceJobs = new Map<string, Promise<unknown>>();
  async function launchMaintenance(id: string) {
    if (maintenanceJobs.has(id)) throw new HttpError(409,"Library job is busy.");
    const promise = maintenance.resume(id); maintenanceJobs.set(id,promise);
    let earlyError: unknown;
    void promise.catch(error => { earlyError=error; }).finally(()=>maintenanceJobs.delete(id));
    await new Promise<void>(resolve=>setImmediate(resolve));
    if (earlyError) throw earlyError;
    return maintenance.get(id);
  }
  const jobs = new Map<string, Promise<CkdRun>>(); const errors = new Map<string, string>();
  const snapshot = (id: string) => view(service.get(id), jobs.has(id), errors.get(id));
  async function launch(id: string, action: () => Promise<CkdRun>) {
    if (jobs.has(id)) throw new HttpError(409, "任务正在运行，请等待当前步骤完成。");
    errors.delete(id);
    const promise = action(); jobs.set(id, promise);
    let earlyError: unknown;
    void promise.catch(error => { earlyError = error; errors.set(id, errorText(error)); }).finally(() => { if (jobs.get(id) === promise) jobs.delete(id); });
    // Validation and lock errors settle before this tick; model/script work stays in the background.
    await new Promise<void>(resolve => setImmediate(resolve));
    if (earlyError) throw earlyError;
    return snapshot(id);
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const clientRequest = (request.url ?? '').startsWith('/api/client/');
    const json = (status: number, value: unknown) => {
      if(value&&typeof value==='object'&&'run' in value){
        const run=value.run as ReturnType<typeof view>;
        // Older clients cannot label an unfinished report, so keep their old
        // all-at-once delivery behavior until they explicitly opt in.
        if(run.result?.provisional&&request.headers['x-ckd-partial-results']!=='1')value={...value,run:{...run,result:undefined}};
      }
      if (clientRequest && value && typeof value === 'object' && 'run' in value) {
        const run = value.run as ReturnType<typeof view>;
        value = { ...value, run: { ...run, result: run.result ? { ...run.result, artifacts: run.result.artifacts.map(file => ({ ...file, url: file.url.replace('/api/runs/', '/api/client/runs/') })) } : undefined } };
      }
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value));
    };
    try {
      const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
      const host = request.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "仅允许本机访问。");
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/admin") { response.writeHead(302, { Location: "/admin/" }); response.end(); return; }
      const prefixedAdmin = url.pathname === "/admin" || url.pathname.startsWith("/admin/");
      if (prefixedAdmin) url.pathname = url.pathname.slice(6) || "/";
      const adminPrefix = prefixedAdmin ? "/admin" : "";
      const expectedOrigin = prefixedAdmin ? publicOrigin : `http://${host}`;
      const validPostOrigin = !request.headers.origin || (request.headers.origin === expectedOrigin && request.headers["x-ckd-ui"] === "1");
      // 逐工序录入：桌面客户端用 Bearer 访问，落盘被限制在 <库根>/public（待审核区），碰不到 product_lib。
      // 管理员仍走 cookie；带 scope=public 时可以切到待审核区查看员工提交的工序。
      const editorSurface = url.pathname === "/editor" || url.pathname === "/editor.js" || url.pathname === "/editor.css"
        || url.pathname === "/api/editor" || url.pathname.startsWith("/api/editor/");
      let editorClient = false;
      if (!clientRequest && editorSurface && request.headers.authorization) {
        try { clientAccess.authenticate(request.headers.authorization); editorClient = true; }
        catch { /* 不是有效的客户端令牌：回落到管理员 cookie 校验 */ }
      }
      if (!clientRequest && adminAccess) {
        if (prefixedAdmin && url.pathname.startsWith("/api/client/")) throw new HttpError(404, "接口不存在。");
        if (request.method === "POST" && !validPostOrigin) throw new HttpError(403, "请求来源无效。");
        const publicAsset = url.pathname === "/login" || url.pathname === "/login.js" || url.pathname === "/style.css";
        if (request.method === "POST" && url.pathname === "/api/auth/login") {
          const token = adminAccess.login(await body(request), request.socket.remoteAddress ?? "unknown");
          response.setHeader("Set-Cookie", adminAccess.cookie(token, adminPrefix, expectedOrigin?.startsWith("https://") ?? false));
          json(200, { account: adminAccess.account }); return;
        }
        if (!publicAsset && !editorClient && !adminAccess.authenticate(request.headers.cookie)) {
          if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app.js")) {
            response.writeHead(302, { Location: `${adminPrefix}/login` }); response.end(); return;
          }
          throw new AdminAccessError(401, "管理员登录已失效，请重新登录。");
        }
        if (request.method === "POST" && url.pathname === "/api/auth/logout") {
          adminAccess.logout(request.headers.cookie);
          response.setHeader("Set-Cookie", adminAccess.clearCookie(adminPrefix, expectedOrigin?.startsWith("https://") ?? false));
          json(200, { ok: true }); return;
        }
        if (request.method === "GET" && url.pathname === "/api/auth/session") { json(200, { account: adminAccess.account }); return; }
      }
      let clientAccount: string | undefined;
      if (clientRequest) {
        // Electron main-process requests have no browser Origin. Keep browser/admin rules unchanged.
        if (request.headers.origin) throw new HttpError(403, '请从桌面客户端操作。');
        if (url.pathname === '/api/client/login' && request.method === 'POST') { json(200, clientAccess.login(await body(request))); return; }
        clientAccount = clientAccess.authenticate(request.headers.authorization);
        if (url.pathname === '/api/client/logout' && request.method === 'POST') { await body(request); clientAccess.logout(request.headers.authorization); json(200, { ok: true }); return; }
        if (!/^\/api\/client\/(?:status|trash|runs(?:\/[0-9a-f-]{36}(?:\/(?:answer|resume|cancel|generate|trash|restore|artifacts\/\d+|images\/[0-9a-f-]{36}))?)?)$/u.test(url.pathname)) throw new HttpError(404, '接口不存在。');
        url.pathname = url.pathname.replace('/api/client/', '/api/');
      }
      if (!clientRequest && request.method === "POST" && !((/^\/api\/(?:images\/(?:quality|policy|calibrate|calibration\/jobs\/[0-9a-f-]{36}\/(?:resume|cancel))|library\/(?:validate|translate|summaries|sync|jobs\/[0-9a-f-]{36}\/(?:resume|cancel)))$/u.test(url.pathname)) && !request.headers.origin) && (request.headers.origin !== expectedOrigin || request.headers["x-ckd-ui"] !== "1")) throw new HttpError(403, "请求来源无效，请从 CKD 页面操作。");
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname)!; response.writeHead(200, { "Content-Type": type! }); response.end(fs.readFileSync(path.join(uiRoot, name!))); return;
      }
      /* -------------------------------------------------------- 逐工序录入 */
      // 页面把一道工序（文本 + 裁剪图）直接写进 Library；出表仍走原来的工作流。
      if (url.pathname === "/api/editor" || url.pathname.startsWith("/api/editor/")) {
        // DELETE 不在上面的 POST 来源校验覆盖范围内，单独补一次，避免跨站删除工序。
        if (request.method === "DELETE" && !validPostOrigin) throw new HttpError(403, "请求来源无效，请从 CKD 页面操作。");
        // 桌面客户端只认待审核区；管理员默认正式库，显式带 scope=public 时才看待审核区。
        const wantsPublic = editorClient || url.searchParams.get("scope") === "public";
        const editorLibrary = wantsPublic ? publicEditorRoot() : service.libraryPath;
        try {
          if (url.pathname === "/api/editor" && request.method === "GET") {
            json(200, { sopType: EDITOR_SOP_TYPE, languages: EDITOR_LANGUAGES, projects: listProjects(editorLibrary), scope: wantsPublic ? "public" : "library", canSwitch: !editorClient });
            return;
          }
          if (url.pathname === "/api/editor/projects" && request.method === "POST") {
            const input = await editorBody(request);
            json(200, { project: createProject(editorLibrary, { projectId: input.projectId, displayName: input.displayName }) });
            return;
          }
          if (url.pathname === "/api/editor/process" && request.method === "GET") {
            const projectId = url.searchParams.get("project") ?? "";
            const language = url.searchParams.get("language") ?? "中文";
            const order = url.searchParams.get("order");
            if (order === null) {
              json(200, { processes: listProcesses(editorLibrary, { projectId, language }) });
              return;
            }
            json(200, { process: readProcess(editorLibrary, { projectId, language, order }, { includePhotos: url.searchParams.get("photos") !== "0" }) });
            return;
          }
          if (url.pathname === "/api/editor/process" && request.method === "POST") {
            const input = await editorBody(request);
            json(200, { result: saveProcess(editorLibrary, input as unknown as EditorProcessInput) });
            return;
          }
          if (url.pathname === "/api/editor/reorder" && request.method === "POST") {
            const input = await editorBody(request);
            json(200, { result: reorderProcesses(editorLibrary, { projectId: input.projectId, language: input.language, folders: input.folders }) });
            return;
          }
          if (url.pathname === "/api/editor/process" && request.method === "DELETE") {
            const projectId = url.searchParams.get("project") ?? "";
            const language = url.searchParams.get("language") ?? "中文";
            const removed = deleteProcess(editorLibrary, { projectId, language, order: url.searchParams.get("order") ?? "" });
            // 删掉中间一道后把编号补齐，避免留下 process_01、process_03 这种空号。
            const remaining = listProcesses(editorLibrary, { projectId, language }).map(process => process.folder);
            if (remaining.length) reorderProcesses(editorLibrary, { projectId, language, folders: remaining });
            json(200, { result: removed });
            return;
          }
          if (url.pathname === "/api/editor/photo" && request.method === "GET") {
            const photo = readPhoto(editorLibrary, { projectId: url.searchParams.get("project") ?? "", language: url.searchParams.get("language") ?? "中文", order: url.searchParams.get("order") ?? "", name: url.searchParams.get("name") ?? "" });
            response.writeHead(200, { "Content-Type": photo.mimeType, "Content-Length": photo.bytes.length }); response.end(photo.bytes); return;
          }
          throw new HttpError(404, "接口不存在。");
        } catch (error) {
          if (error instanceof EditorInputError) { json(error.status, { error: error.message }); return; }
          throw error;
        }
      }
      const referenceImage = /^\/api\/images\/references\/([a-f0-9]{64})$/u.exec(url.pathname);
      if (request.method === "GET" && referenceImage) {
        const sample = imageCalibration.current().calibration?.samples.find(item=>item.imageHash===referenceImage[1]);
        if (!sample?.file) throw new HttpError(404, "基准图片不存在。");
        const file = path.resolve(imageCalibration.samplesDir,sample.file);
        if (!isInside(imageCalibration.samplesDir,file) || fs.lstatSync(file).isSymbolicLink() || !isInside(imageCalibration.samplesDir,fs.realpathSync(file))) throw new HttpError(403,"基准图片不在样本目录内。");
        if (fs.statSync(file).size > MAX_IMAGE_BYTES) throw new HttpError(413,"基准图片过大。");
        const bytes = fs.readFileSync(file);
        if (sha256(bytes) !== referenceImage[1]) throw new HttpError(409,"基准图片已修改，请重新校准。");
        response.writeHead(200,{"Content-Type":inspectImage(bytes).mimeType});response.end(bytes);return;
      }
      if (request.method === "GET" && url.pathname === "/api/images/policy") { json(200, fixedPixel?{policy:service.imageQuality.policy(),defaults:PIXEL_POLICY,readOnly:true,engine:'pixel-v1.23.0',configHash:PIXEL_CONFIG_HASH}:{ policy: readImagePolicy(service.dataDir), defaults: DEFAULT_POLICY }); return; }
      if (request.method === "POST" && url.pathname === "/api/images/policy") { const input=await body(request);if(fixedPixel)throw new HttpError(409,'V1.23.0 使用客户固定配置，本次不开放手动调参。');json(200, { policy: saveImagePolicy(service.dataDir, input) }); return; }
      if (request.method === "GET" && url.pathname === "/api/images/calibration") { json(200, fixedPixel?{mode:'fixed',version:'1.23.0',samplesDir:'',calibration:service.imageQuality.calibration(),readOnly:true}:imageCalibration.current()); return; }
      if (request.method === "POST" && url.pathname === "/api/images/calibrate") {
        if (Object.keys(await body(request)).length) throw new HttpError(400, "Calibration takes an empty JSON object; use the configured samples directory.");
        if(fixedPixel)throw new HttpError(409,'V1.23.0 使用客户已校准曲线，本次不运行旧版offset拟合或自动学习。');
        const job = imageCalibration.create(); json(202, { job: await launchCalibration(job.id) }); return;
      }
      const calibrationJob = /^\/api\/images\/calibration\/jobs\/([0-9a-f-]{36})(?:\/(resume|cancel))?$/u.exec(url.pathname);
      if (calibrationJob) {
        const id = calibrationJob[1]!, action = calibrationJob[2];
        if (request.method === "GET" && !action) { json(200, { job: imageCalibration.get(id) }); return; }
        if (request.method === "POST" && action) {
          if (Object.keys(await body(request)).length) throw new HttpError(400, "This action takes an empty JSON object.");
          if(fixedPixel&&action==='resume')throw new HttpError(409,'固定像素评分模式不启动旧版校准任务。');
          json(action === "resume" ? 202 : 200, { job: action === "resume" ? await launchCalibration(id) : await imageCalibration.cancel(id) }); return;
        }
        throw new HttpError(405, "Unsupported calibration action.");
      }
      if (request.method === "POST" && url.pathname === "/api/images/quality") {
        const retry=url.searchParams.get('retry');if(retry!==null&&!['true','false'].includes(retry))throw new HttpError(400,'retry 仅接受 true 或 false。');
        const operationContext=url.searchParams.get('context');
        if(operationContext!==null&&(!operationContext.trim()||operationContext.length>4000))throw new HttpError(400,"操作说明需要1–4000个字符。");
        const mimeType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
        if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new HttpError(415, "请以 image/png 或 image/jpeg 发送图片原始二进制内容（不是 multipart 或 JSON）。");
        const chunks: Buffer[] = []; let size = 0;
        if (Number(request.headers["content-length"]) > MAX_IMAGE_BYTES) throw new HttpError(413, "图片不能超过 10 MiB。");
        for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > MAX_IMAGE_BYTES) throw new HttpError(413, "图片不能超过 10 MiB。"); chunks.push(bytes); }
        const bytes = Buffer.concat(chunks);
        if (inspectImage(bytes).mimeType !== mimeType) throw new HttpError(400, "图片格式与 Content-Type 不一致。");
        const controller = new AbortController();
        const close = () => { if (!response.writableEnded) controller.abort(new Error("Image quality request disconnected.")); };
        response.on("close", close);
        try {
          const outcome=await scoreWithContext(service.imageQuality,bytes,controller.signal,scoringContext(service.imageQuality),retry==='true');
          if(outcome.fallback){json(200,{result:null,fallback:outcome.fallback,error:outcome.error});return;}
          const result=outcome.result!;
          const context=url.searchParams.get('context');
          if(context!==null){
            try {const operationFocus=await checkOperationFocus(service.imageQuality,result,bytes,context,controller.signal,scoringContext(service.imageQuality).operationFocusVersion);json(200,{result:{...result,operationFocus}});}
            catch(error){controller.signal.throwIfAborted();json(200,{result:{...result,focusError:errorText(error)}});}
          }else json(200, { result });
        } catch (error) {
          if (/busy|Vision model requires|Timeout|timed out/iu.test(errorText(error)) || controller.signal.aborted) throw error;
          throw new HttpError(502, errorText(error));
        } finally { response.off("close", close); }
        return;
      }
      if (request.method === "POST" && ["/api/library/translate", "/api/library/summaries", "/api/library/sync"].includes(url.pathname)) {
        const input = await body(request);
        const job = maintenance.create(url.pathname.endsWith("translate") ? "translate" : url.pathname.endsWith("sync")?"sync":"summaries", input);
        json(202, {job: await launchMaintenance(job.id)}); return;
      }
      if (request.method === "GET" && url.pathname === "/api/library/jobs") { json(200,{jobs:maintenance.list().map(job=>job.kind==="sync"&&job.sync?{...job,sync:{...job.sync,images:undefined,imageContext:undefined}}:job)}); return; }
      if (request.method === "GET" && url.pathname === "/api/library/jobs/progress") { json(200,{jobs:maintenance.listProgress()}); return; }
      const libraryJob = /^\/api\/library\/jobs\/([0-9a-f-]{36})(?:\/(resume|cancel|progress))?$/u.exec(url.pathname);
      if (libraryJob) {
        const id=libraryJob[1]!, action=libraryJob[2];
        if (request.method === "GET" && !action) {json(200,{job:maintenance.get(id)});return;}
        if (request.method === "GET" && action === "progress") {json(200,{job:maintenance.getProgress(id)});return;}
        if (request.method === "POST" && action) {
          const input=await body(request);if(Object.keys(input).length)throw new HttpError(400,"This action takes an empty JSON object.");
          json(action === "resume" ? 202 : 200, {job: action === "resume" ? await launchMaintenance(id) : await maintenance.cancel(id)});return;
        }
        throw new HttpError(405,"不支持此操作。");
      }
      if (request.method === "POST" && url.pathname === "/api/library/validate") {
        const input = await body(request);
        json(200, await validateCkdLibrary(service.libraryPath, input as LibraryValidationOptions,true)); return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") { json(200, { libraryReady: fs.existsSync(path.join(service.libraryPath, "product_lib")),imageScorer:fixedPixel?'pixel-v1.23.0':'legacy' }); return; }
      if (request.method === "GET" && url.pathname === "/api/runs") {
        json(200, { runs: service.list().filter(run => !clientAccount || clientAccess.owns(run.id, clientAccount)).map(run => ({ id: run.id, status: run.status, busy: jobs.has(run.id), inputs: run.inputs, createdAt: run.createdAt })) }); return;
      }
      if(request.method==='GET'&&url.pathname==='/api/trash'){json(200,{runs:service.deleted().filter(run=>!clientAccount||clientAccess.owns(run.id,clientAccount)).map(run=>({id:run.id,status:run.status,busy:false,inputs:run.inputs,createdAt:run.createdAt}))});return;}
      if (request.method === "POST" && url.pathname === "/api/runs") {
        const input = await body(request); const run = service.create(input as unknown as CreateCkdSopGraphInput, Boolean(clientAccount) && request.headers["x-ckd-image-review"] === "1");
        if (clientAccount) clientAccess.claim(run.id, clientAccount);
        json(202, { run: await launch(run.id, () => service.resume(run.id)) }); return;
      }
      const match = /^\/api\/runs\/([0-9a-f-]{36})(?:\/(answer|resume|cancel|generate|trash|restore|artifacts|images)(?:\/([0-9a-f-]+))?)?$/u.exec(url.pathname);
      if (!match) throw new HttpError(404, "页面或任务不存在。");
      const id = match[1]!; const action = match[2]; const artifactIndex = match[3];
      if (clientAccount) clientAccess.requireOwner(id, clientAccount);
      if (request.method === "GET" && !action) { json(200, { run: snapshot(id) }); return; }
      if (action === "images" && artifactIndex && /^[0-9a-f-]{36}$/u.test(artifactIndex)) {
        if (request.method === "GET") {
          const original = url.searchParams.get("original");
          if (original !== null && original !== "true") throw new HttpError(400, "original 仅支持 true。");
          const bytes = service.image(id, artifactIndex, original === "true");
          response.writeHead(200, { "Content-Type": "image/png", "Content-Length": bytes.length }); response.end(bytes); return;
        }
        if (request.method === "POST") {
          if (jobs.has(id)) throw new HttpError(409, "任务正在运行。");
          const input = await body(request);
          json(200, { run: view(await service.crop(id, { ...input, imageId: artifactIndex }), false) }); return;
        }
        throw new HttpError(405, "不支持此图片操作。");
      }
      if ((request.method === "GET" || request.method === "HEAD") && action === "artifacts" && artifactIndex !== undefined && /^\d+$/u.test(artifactIndex)) {
        const run = service.get(id); const artifact = downloadableResult(run)?.artifacts[Number(artifactIndex)];
        if (!artifact) throw new HttpError(404, "产物不存在。");
        const file = path.resolve(run.workspaceRoot, artifact); const workspace = path.resolve(run.workspaceRoot, run.workspaceRelative);
        if (!isInside(workspace, file) || !isInside(workspace, fs.realpathSync(file)) || !fs.statSync(file).isFile()) throw new HttpError(403, "产物不在任务目录内。");
        const report = path.extname(file) === ".json";
        response.writeHead(200, { "Content-Type": report ? "application/json; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Length": fs.statSync(file).size, "Content-Disposition": `attachment; filename="${report ? "image-quality.json" : "ckd-sop.xlsx"}"; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
        if (request.method === "HEAD") { response.end(); return; }
        const stream = fs.createReadStream(file);
        const close = () => stream.destroy();
        response.once("close", close);
        stream.once("close", () => response.off("close", close));
        stream.on("error", () => response.destroy()); stream.pipe(response); return;
      }
      if (request.method !== "POST" || artifactIndex !== undefined) throw new HttpError(405, "不支持此操作。");
      const input = await body(request);
      if(action==='trash'||action==='restore'){if(Object.keys(input).length)throw new HttpError(400,'此操作不接受参数。');if(jobs.has(id))throw new HttpError(409,'任务正在运行，暂时不能删除或恢复。');if(action==='trash'){await service.trash(id);json(200,{ok:true});}else json(200,{run:view(await service.restore(id),false)});return;}
      if (action === "cancel") { errors.delete(id); json(200, { run: view(await service.cancel(id), jobs.has(id)) }); return; }
      if (action === "generate") { json(202, { run: await launch(id, () => service.generate(id, input)) }); return; }
      if (action === "resume") { json(202, { run: await launch(id, () => service.resume(id)) }); return; }
      if (action === "answer") {
        if (typeof input.questionId !== "string" || typeof input.text !== "string") throw new HttpError(400, "请选择选项或填写回答。");
        const questionId = input.questionId; const text = input.text;
        json(202, { run: await launch(id, () => service.answer(id, questionId, text)) }); return;
      }
      throw new HttpError(404, "操作不存在。");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const status = error instanceof HttpError || error instanceof ImageInputError || error instanceof ClientAccessError || error instanceof AdminAccessError ? error.status : code === "ENOENT" ? 404 : /busy|图片确认已改变/u.test(errorText(error)) ? 409 : /Vision model requires/u.test(errorText(error)) ? 503 : /Timeout|timed out/iu.test(errorText(error)) ? 504 : 400;
      if (!response.headersSent) json(status, { error: errorText(error) }); else response.destroy();
    }
  });
  return { server, service, maintenance, imageCalibration };
}
