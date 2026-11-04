import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = "ckd_admin_session";

export function hashAdminPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export class AdminAccess {
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly salt: Buffer;
  private readonly expected: Buffer;
  constructor(readonly account: string, passwordHash: string, private readonly now: () => number = Date.now) {
    const parts = /^scrypt:([0-9a-f]{32}):([0-9a-f]{128})$/u.exec(passwordHash);
    if (!account || !parts) throw new Error("CKD 管理员账号或密码哈希配置无效。");
    this.salt = Buffer.from(parts[1]!, "hex");
    this.expected = Buffer.from(parts[2]!, "hex");
  }
  login(input: Record<string, unknown>, peer: string): string {
    const time = this.now();
    const rate = this.failures.get(peer);
    if (rate && rate.until > time && rate.count >= 10) throw new AdminAccessError(429, "尝试次数过多，请稍后再试。");
    const password = typeof input.password === "string" ? input.password : "";
    const actual = scryptSync(password, this.salt, this.expected.length);
    if (input.account !== this.account || !timingSafeEqual(actual, this.expected)) {
      const count = rate && rate.until > time ? rate.count + 1 : 1;
      this.failures.set(peer, { count, until: time + 5 * 60 * 1000 });
      throw new AdminAccessError(401, "账号或密码错误。");
    }
    this.failures.delete(peer);
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, time + SESSION_MS);
    return token;
  }
  token(cookie: string | undefined): string | undefined {
    return cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  }
  authenticate(cookie: string | undefined): boolean {
    const token = this.token(cookie);
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires) return false;
    if (expires <= this.now()) { this.sessions.delete(token); return false; }
    return true;
  }
  logout(cookie: string | undefined): void {
    const token = this.token(cookie);
    if (token) this.sessions.delete(token);
  }
  cookie(token: string, prefix: string, secure: boolean): string {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${prefix || "/"}; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}`;
  }
  clearCookie(prefix: string, secure: boolean): string {
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=${prefix || "/"}; Max-Age=0${secure ? "; Secure" : ""}`;
  }
}

export class AdminAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
