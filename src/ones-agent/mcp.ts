import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import type { OnesConfig } from "./config.js";

export class OnesError extends Error {
  constructor(readonly kind: "auth" | "permission" | "unavailable" | "invalid" | "too_large", message: string) { super(message); }
}
export const abortable = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  let stop = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason ?? new Error("ONES 查询已取消。"));
      signal.addEventListener("abort", stop, {once: true});
      if (signal.aborted) stop();
    })]);
  } finally { signal.removeEventListener("abort", stop); }
};
const pause = async (signal: AbortSignal) => {
  let timer: NodeJS.Timeout | undefined;
  try { await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }), signal); }
  finally { clearTimeout(timer); }
};

/** One transport per executing task: no shared session/cancellation state between parents. */
export class OnesMcp {
  private client?: Client;
  private lastFailure?: OnesError;
  private tools: Tool[] = [];
  private closed = false;
  constructor(private config: OnesConfig, private signal: AbortSignal) {}
  private async retry<T>(operation: () => Promise<T>, reconnect = false): Promise<T> {
    for (let attempt = 0;; attempt++) {
      this.signal.throwIfAborted();
      try { return await operation(); }
      catch (error) {
        this.signal.throwIfAborted();
        const failure = error instanceof OnesError ? error : this.lastFailure ?? new OnesError("invalid", "ONES MCP 请求失败；请检查查询参数或服务连接。");
        if (attempt || failure.kind !== "unavailable") throw failure;
        await pause(this.signal);
        if (reconnect) { await this.client?.close().catch(() => {}); await this.connect(); }
      }
    }
  }
  private async connect() {
    this.signal.throwIfAborted();
    if (this.closed) throw new Error("ONES MCP connection is closed.");
    await this.client?.close().catch(() => {});
    this.lastFailure = undefined;
    const client = this.client = new Client({name: "product-expert-ones-agent", version: "1.0.0"});
    // Refuse redirects and cap network bodies before the SDK parses them. The GET
    // listening stream is unbounded in time, but each response has a byte ceiling.
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: {headers: {"X-ONES-MCP-Token": this.config.token}, redirect: "error"},
      fetch: async (url, init) => {
        this.lastFailure = undefined;
        try {
          const response = await fetch(url, {...init, redirect: "error", signal: AbortSignal.any([this.signal, ...(init?.signal ? [init.signal] : [])])});
          if (!response.ok && response.status !== 405) {
            await response.body?.cancel();
            throw response.status === 401 ? new OnesError("auth", "ONES 认证失败，请检查 ONES_MCP_TOKEN。")
              : response.status === 403 ? new OnesError("permission", "当前 ONES 账号或 Token 没有此次操作的权限。")
              : response.status === 429 || response.status >= 500 || response.status === 404 ? new OnesError("unavailable", "ONES 服务暂时不可用，请稍后重试。")
              : new OnesError("invalid", `ONES MCP 请求失败（HTTP ${response.status}）。`);
          }
          if (!response.body) return response;
          if (Number(response.headers.get("content-length")) > this.config.maxResultBytes) { await response.body.cancel(); throw new OnesError("too_large", "ONES 返回结果过大，请缩小查询范围或分页查询。"); }
          let bytes = 0;
          const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({transform: (chunk, controller) => {
            bytes += chunk.byteLength;
            if (bytes > this.config.maxResultBytes) {
              this.lastFailure = new OnesError("too_large", "ONES 返回结果过大，请缩小查询范围或分页查询。");
              controller.error(this.lastFailure);
            } else controller.enqueue(chunk);
          }}));
          return new Response(stream, {status: response.status, statusText: response.statusText, headers: response.headers});
        } catch (error) {
          if (this.signal.aborted) throw error;
          this.lastFailure = error instanceof OnesError ? error : new OnesError("unavailable", "无法连接 ONES MCP 服务，请稍后重试。");
          throw this.lastFailure;
        }
      },
    });
    const stop = () => { void transport.close().catch(() => {}); };
    this.signal.addEventListener("abort", stop, {once: true});
    try { await abortable(client.connect(transport), this.signal); }
    catch (error) { await client.close().catch(() => {}); throw error; }
    finally { this.signal.removeEventListener("abort", stop); }
  }
  async open() {
    await this.retry(() => this.connect());
    await this.retry(async () => {
      const tools: Tool[] = []; const seen = new Set<string>(); let cursor: string | undefined;
      do {
        const page = await this.client!.listTools(cursor ? {cursor} : {}, {signal: this.signal, timeout: 30000});
        tools.push(...page.tools); cursor = page.nextCursor;
        if (tools.length > 256 || cursor && seen.has(cursor)) throw new OnesError("invalid", "ONES 工具列表无效或过大。");
        if (cursor) seen.add(cursor);
      } while (cursor);
      this.tools = tools.filter(t => this.config.tools.includes(t.name));
      if (!this.tools.length) throw new OnesError("permission", "当前 ONES Token 没有可用的已配置查询工具。");
    }, true);
    return this.tools;
  }
  async call(name: string, args: Record<string, unknown>) {
    if (this.closed || !this.config.tools.includes(name) || !this.tools.some(t => t.name === name)) throw new OnesError("permission", "此 ONES 工具未获授权或当前不可用。");
    const result = await this.retry(async () => {
      this.lastFailure = undefined;
      return await this.client!.callTool({name, arguments: args}, {signal: this.signal, timeout: 30000});
    }, true);
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > this.config.maxResultBytes) throw new OnesError("too_large", "ONES 返回结果过大，请缩小查询范围或分页查询。");
    return JSON.parse(serialized.split(this.config.token).join("[REDACTED]")) as typeof result;
  }
  async close() { this.closed = true; await this.client?.close().catch(() => {}); }
}
