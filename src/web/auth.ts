import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE = "pe_admin_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest();

/** One configured administrator; opaque, bounded, in-memory browser login sessions. */
export class WebAuth {
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  readonly configured: boolean;
  constructor(private readonly account: string, private readonly password: string, private readonly now = Date.now) {
    this.configured = Boolean(account.trim() && password);
  }
  private cookie(req: IncomingMessage): string | undefined {
    return req.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  }
  private sweep() {
    for (const [token, expires] of this.sessions) if (expires <= this.now()) this.sessions.delete(token);
    for (const [address, failure] of this.failures) if (failure.until <= this.now()) this.failures.delete(address);
  }
  authenticated(req: IncomingMessage): boolean {
    this.sweep();
    const value = this.cookie(req);
    return this.configured && Boolean(value && this.sessions.has(digest(value).toString("hex")));
  }
  retryAfter(req: IncomingMessage): number {
    this.sweep();
    const failure = this.failures.get(req.socket.remoteAddress ?? "local");
    return failure && failure.count >= 10 ? Math.max(1, Math.ceil((failure.until - this.now()) / 1000)) : 0;
  }
  login(req: IncomingMessage, res: ServerResponse, account: unknown, password: unknown): boolean {
    // Hash to equal-length buffers and compare both fields without early account rejection.
    const sameAccount = timingSafeEqual(digest(typeof account === "string" ? account : ""), digest(this.account));
    const samePassword = timingSafeEqual(digest(typeof password === "string" ? password : ""), digest(this.password));
    const address = req.socket.remoteAddress ?? "local";
    if (!this.configured || !sameAccount || !samePassword) {
      const previous = this.failures.get(address);
      if (this.failures.size >= 128 && !previous) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(address, { count: (previous?.count ?? 0) + 1, until: previous?.until ?? this.now() + FAILURE_WINDOW_MS });
      return false;
    }
    this.sweep(); this.failures.delete(address);
    const old = this.cookie(req);
    if (old) this.sessions.delete(digest(old).toString("hex"));
    while (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(digest(token).toString("hex"), this.now() + SESSION_MS);
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
    return true;
  }
  logout(req: IncomingMessage, res: ServerResponse) {
    const token = this.cookie(req);
    if (token) this.sessions.delete(digest(token).toString("hex"));
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }
  dispose() { this.sessions.clear(); this.failures.clear(); }
}
