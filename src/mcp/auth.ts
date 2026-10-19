import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** One service credential; never substitutes for Web login or WeCom ownership. */
export class McpAccess {
  private readonly expected?: Buffer;
  constructor(key: string) { if (key) this.expected = digest(key); }
  get configured() { return Boolean(this.expected); }
  authenticated(header: string | undefined) {
    const token = header?.match(/^Bearer ([^\s]+)$/i)?.[1];
    return Boolean(this.expected && token && timingSafeEqual(this.expected, digest(token)));
  }
}
