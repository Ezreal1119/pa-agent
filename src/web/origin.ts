import type { IncomingMessage } from "node:http";

export class RequestOriginError extends Error {}

/** One explicitly configured HTTPS origin; forwarded headers never grant trust. */
export class WebOriginPolicy {
  readonly publicUrl?: URL;
  constructor(value = "") {
    if (!value.trim()) return;
    let url: URL;
    try { url = new URL(value.trim()); }
    catch { throw new Error("WEB_PUBLIC_URL 必须是完整 HTTPS 地址，不能包含路径或账号密码。"); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.hostname.includes("*")) {
      throw new Error("WEB_PUBLIC_URL 必须是 HTTPS 来源地址，例如 https://urovo-agent.patrick-shenzhen.cn，不含 /login、通配符或账号密码。");
    }
    this.publicUrl = url;
  }
  /** Return whether login/logout should set Secure cookies for this request. */
  check(req: IncomingMessage, port: number, machine = false): boolean {
    const host = req.headers.host?.toLowerCase();
    const local = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    const publicHost = Boolean(this.publicUrl && host === this.publicUrl.host);
    if (!host || (!local && (machine || !publicHost))) throw new RequestOriginError("访问地址未获允许；域名反代请在 .env 配置 WEB_PUBLIC_URL。");
    const origins = new Set<string>();
    if (local) origins.add(`http://${host}`);
    // A reverse proxy can preserve the public Host or rewrite it to the local upstream.
    if (!machine && this.publicUrl) origins.add(this.publicUrl.origin);
    if (req.headers.origin && !origins.has(req.headers.origin)) throw new RequestOriginError("不允许跨站请求。");
    if (req.headers["sec-fetch-site"] === "cross-site") throw new RequestOriginError("不允许跨站请求。");
    return Boolean(!machine && this.publicUrl && (publicHost || req.headers.origin === this.publicUrl.origin));
  }
}
