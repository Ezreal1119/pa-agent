import { requestLibraryLinks } from "../tools/library-link.js";

// A direct command invokes the existing tool transport, without an Agent session
// or any history/memory enrichment. The model-facing tool remains unchanged.
export async function libraryCommand(prompt: string, signal: AbortSignal): Promise<string> {
  const data = await requestLibraryLinks(prompt, {}, signal);
  return formatLibraryResult(data);
}

const plain = (value: unknown, fallback = "") => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>\[\]()*_`]/g, " ").slice(0, 1000) : fallback;

export function formatLibraryResult(data: Record<string, unknown>): string {
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const links = matches.flatMap(match => {
    if (!match || typeof match !== "object" || typeof match.url !== "string") return [];
    try {
      const url = new URL(match.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || /[\s<>\u0000-\u001f\u007f]/.test(match.url)) return [];
      // Keep the returned link verbatim. Separate lines avoid Markdown URL escaping
      // changing a signed link; external metadata cannot introduce @all markup.
      return [`${plain(match.name, "文件")}\n${match.url}${match.comment ? `\n${plain(match.comment)}` : ""}`];
    } catch { return []; }
  });
  const heading = data.outcome === "no_match" ? "未找到精确匹配。以下如有链接，仅为相关候选："
    : data.outcome === "matched" ? "资料库返回的文件：" : "资料库返回的候选文件：";
  return links.length ? `${heading}\n\n${links.join("\n\n")}` : "资料库未返回可用的文件链接，请补充型号或文件名称后重新查询。";
}

interface BalanceOptions { request?: typeof fetch; timeoutMs?: number }
export async function balanceCommand(apiKey: string, signal: AbortSignal, options: BalanceOptions = {}): Promise<string> {
  if (!apiKey) throw new Error("未配置 DeepSeek 官方密钥。请管理员在 VPS 的 .env 设置 DEEPSEEK_API_KEY 并重启 product-expert。");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10000);
  const abort = AbortSignal.any([signal, timeout]);
  try {
    abort.throwIfAborted();
    const response = await (options.request ?? fetch)("https://api.deepseek.com/user/balance", {
      method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal: abort, redirect: "error",
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`DeepSeek 余额接口返回 HTTP ${response.status}，请检查官方密钥或稍后重试。`); }
    if (Number(response.headers.get("content-length")) > 16384) { await response.body?.cancel(); throw new Error("DeepSeek 余额响应超过大小限制。"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("DeepSeek 余额响应为空。");
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        abort.throwIfAborted();
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > 16384) throw new Error("DeepSeek 余额响应超过大小限制。");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("DeepSeek 余额响应格式不正确。"); }
    const amount = (value: unknown) => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) && value.length <= 40;
    if (typeof data?.is_available !== "boolean" || !Array.isArray(data.balance_infos) || !data.balance_infos.length || data.balance_infos.length > 10 || data.balance_infos.some((item: any) =>
      !item || !["CNY", "USD"].includes(item.currency) || !amount(item.total_balance) || !amount(item.granted_balance) || !amount(item.topped_up_balance))) throw new Error("DeepSeek 余额响应格式不正确。");
    return `DeepSeek 账户余额${data.is_available ? "" : "（当前不可用）"}\n\n${data.balance_infos.map((item: any) => `${item.currency}：${item.total_balance}\n赠送余额：${item.granted_balance}\n充值余额：${item.topped_up_balance}`).join("\n\n")}`;
  } catch (error) {
    if (signal.aborted) throw new Error("余额查询已取消。");
    if (timeout.aborted) throw new Error("余额查询超时，请稍后重试。");
    if (error instanceof TypeError) throw new Error("无法连接 DeepSeek 余额接口，请稍后重试。");
    throw error;
  }
}
