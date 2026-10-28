export const FIRMWARE_MAINTENANCE = "固件功能维护中，请稍后再试。";
export interface FirmwareConfig { baseUrl: string; token: string; publicBase: string; }
export interface Candidate { id: string; filename: string; path: string; size: number; modified: string | null; score: number; exact: boolean; differences: string[]; }
export interface LocalJob { id: string; state: string; stage: string; bytes: number; total_bytes: number; speed_bytes_per_second?: number; error?: string; candidate: Candidate; result?: { uploaded: boolean; filename: string; size: number; download_url: string | null }; }
export interface FirmwareClient {
  ready(signal?: AbortSignal): Promise<boolean>;
  search(filename: string, signal?: AbortSignal): Promise<Candidate[]>;
  submit(candidateId: string, requestId: string, signal?: AbortSignal): Promise<LocalJob>;
  lookup(requestId: string, signal?: AbortSignal): Promise<LocalJob | undefined>;
  job(id: string, signal?: AbortSignal): Promise<LocalJob>;
  cancel(id: string, signal?: AbortSignal): Promise<LocalJob>;
}
export function firmwareConfig(env: NodeJS.ProcessEnv): FirmwareConfig {
  const baseUrl = (env.FIRMWARE_SERVICE_URL ?? "").replace(/\/$/, "");
  const token = env.FIRMWARE_SERVICE_TOKEN ?? "";
  const publicBase = env.FIRMWARE_PUBLIC_URL_BASE ?? "https://temp.patrick-shenzhen.org/firmware/";
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("FIRMWARE_SERVICE_URL must be HTTPS or loopback HTTP, without credentials/query/fragment.");
  }
  const publicUrl = new URL(publicBase);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) throw new Error("FIRMWARE_PUBLIC_URL_BASE must be an HTTPS directory URL.");
  if (token && (token.length < 32 || /[\r\n]/.test(token))) throw new Error("FIRMWARE_SERVICE_TOKEN must contain at least 32 characters.");
  return { baseUrl, token, publicBase: publicBase.replace(/\/$/, "") + "/" };
}
export function validFilename(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9_.()+ -]*\.zip$/i.test(value) && !/UFS|_SE_OTA|定制/i.test(value);
}
export function validateCandidate(value: unknown): Candidate {
  const c = value as Candidate;
  if (!c || !/^[a-f0-9]{32}$/.test(c.id) || !validFilename(c.filename) || typeof c.path !== "string" || !c.path.startsWith("/FTP7/OS/") || c.path.split("/").includes("..") || /[\r\n\\]/.test(c.path) || c.path.split("/").at(-1) !== c.filename || !Number.isSafeInteger(c.size) || c.size < 0 || c.modified !== null && typeof c.modified !== "string" || !Array.isArray(c.differences) || c.differences.some(d => typeof d !== "string") || typeof c.exact !== "boolean" || !Number.isFinite(c.score)) throw new Error("固件服务返回的候选格式不正确。");
  return { id: c.id, filename: c.filename, path: c.path, size: c.size, modified: c.modified, score: c.score, exact: c.exact, differences: c.differences.slice(0, 10).map(d => d.slice(0, 300)) };
}
export class LocalFirmwareClient implements FirmwareClient {
  constructor(readonly config: FirmwareConfig, private readonly request: typeof fetch = fetch) {}
  private async json(route: string, body?: unknown, signal?: AbortSignal, timeout = 15000): Promise<any> {
    if (!this.config.baseUrl || !this.config.token) throw new Error(FIRMWARE_MAINTENANCE);
    const response = await this.request(this.config.baseUrl + route, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]), headers: { Authorization: `Bearer ${this.config.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`固件服务 HTTP ${response.status}`), { status: response.status }); }
    if (Number(response.headers.get("content-length")) > 256 * 1024) { await response.body?.cancel(); throw new Error("固件服务响应超过限制。"); }
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 256 * 1024) throw new Error("固件服务响应超过限制。"); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async ready(signal?: AbortSignal) { try { return (await this.json("/health", undefined, signal, 12000)).ok === true; } catch { return false; } }
  async search(filename: string, signal?: AbortSignal): Promise<Candidate[]> {
    const value = await this.json("/search", { filename, limit: 12 }, signal, 60000);
    if (!Array.isArray(value.candidates) || value.candidates.length > 12) throw new Error("固件候选列表格式不正确。");
    return value.candidates.map(validateCandidate);
  }
  async submit(candidateId: string, requestId: string, signal?: AbortSignal) { return this.validateJob(await this.json("/jobs", { candidate_id: candidateId, confirmed: true, upload: true, request_id: requestId }, signal)); }
  async lookup(requestId: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw new Error("Invalid firmware request ID.");
    try { return this.validateJob(await this.json(`/requests/${requestId}`, undefined, signal)); }
    catch (error) { if ((error as {status?: number}).status === 404) return undefined; throw error; }
  }
  async job(id: string, signal?: AbortSignal) { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid firmware job ID."); return this.validateJob(await this.json(`/jobs/${id}`, undefined, signal)); }
  async cancel(id: string, signal?: AbortSignal) { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid firmware job ID."); return this.validateJob(await this.json(`/jobs/${id}/cancel`, {}, signal)); }
  private validateJob(value: LocalJob) {
    if (!value || !/^[a-f0-9]{32}$/.test(value.id) || !["queued", "running", "cancelling", "cancelled", "succeeded", "failed"].includes(value.state) || typeof value.stage !== "string" || !Number.isFinite(value.bytes) || !Number.isFinite(value.total_bytes)) throw new Error("固件任务格式不正确。");
    validateCandidate(value.candidate);
    return value;
  }
}
