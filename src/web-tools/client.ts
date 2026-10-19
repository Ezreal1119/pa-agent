import { WebRequestLimiter } from "./rate-limit.js";
import type { WebToolName } from "./config.js";

const gates = { search: new WebRequestLimiter(), fetch: new WebRequestLimiter() };
const RESPONSE_BYTES = 1024 * 1024;
export interface WebClientOptions { apiKey: string; request?: typeof fetch; timeoutMs?: number; }

export async function requestWebTool(name: WebToolName, body: object, options: WebClientOptions, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!options.apiKey.trim()) throw new Error("联网工具需要 DeepSeek API Key：直连 DeepSeek 时复用 API_KEY，否则请配置 DEEPSEEK_API_KEY 并重启服务。");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60000);
  const abort = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
  try {
    await gates[name].acquire(abort); abort.throwIfAborted();
    // Only DeepSeek receives the credential. URLs to be read are JSON data, never request destinations.
    const response = await (options.request ?? fetch)(`https://api.deepseek.com/v1/tools/${name}`, {
      method: "POST", headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: abort,
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 401 ? "请检查 DeepSeek 密钥。" : response.status === 402 ? "DeepSeek 账户余额不足。" : response.status === 429 ? "请求受限，请稍后再试。" : response.status === 404 ? "未取得可用内容，可能不支持该页面或文件格式。" : "请稍后重试或调整请求。";
      throw new Error(`联网 ${name} 返回 HTTP ${response.status}；${hint}`);
    }
    if (Number(response.headers.get("content-length")) > RESPONSE_BYTES) { await response.body?.cancel(); throw new Error("联网返回内容超过 1MiB 上限，请缩小检索范围或换用更短页面。"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("联网接口返回了空响应。");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        abort.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > RESPONSE_BYTES) throw new Error("联网返回内容超过 1MiB 上限，请缩小检索范围或换用更短页面。");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8").replaceAll(options.apiKey, "[REDACTED]")); }
    catch { throw new Error("联网接口未返回有效 JSON。"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("联网接口返回格式不正确。");
    return data;
  } catch (error) {
    if (signal?.aborted) throw new Error("联网请求已取消。");
    if (timeout.aborted) throw new Error("联网请求超时，请稍后再试。");
    if (error instanceof TypeError) throw new Error("无法连接 DeepSeek 联网接口，请稍后再试。");
    throw error;
  }
}
