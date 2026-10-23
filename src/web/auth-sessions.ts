import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { atomic, safePath } from "../knowledge-sync/core.js";

/** Fixed, signed login store. Tokens and configured credentials are never written. */
export class AuthSessions {
  private salt = randomBytes(32).toString("hex");
  private key?: Buffer;
  readonly file: string;
  constructor(
    dataDir: string,
    private readonly account: string,
    private readonly password: string,
  ) {
    this.file = path.join(path.resolve(dataDir), "web-auth", "sessions.json");
  }
  private derive() {
    return scryptSync(this.account + "\0" + this.password, this.salt, 32);
  }
  private signature(payload: unknown) {
    return createHmac("sha256", this.key!)
      .update(JSON.stringify(payload))
      .digest("hex");
  }
  async load(now: number): Promise<Map<string, number>> {
    await safePath(path.dirname(this.file), path.basename(this.file));
    const handle = await fs
      .open(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      .catch((e) => {
        if (e.code === "ENOENT") return;
        throw e;
      });
    if (!handle) {
      this.key = this.derive();
      return new Map();
    }
    let value: any;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768)
        throw new Error("Invalid saved login file.");
      const text = await handle.readFile("utf8");
      if (Buffer.byteLength(text) > 32768)
        throw new Error("Invalid saved login file.");
      value = JSON.parse(text);
    } finally {
      await handle.close();
    }
    if (
      !value ||
      value.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(value.salt) ||
      !/^[a-f0-9]{64}$/.test(value.mac) ||
      !Array.isArray(value.sessions) ||
      value.sessions.length > 128 ||
      Object.keys(value).some(
        (k) => !["version", "salt", "sessions", "mac"].includes(k),
      ) ||
      value.sessions.some(
        (r: any) =>
          !Array.isArray(r) ||
          r.length !== 2 ||
          !/^[a-f0-9]{64}$/.test(r[0]) ||
          !Number.isSafeInteger(r[1]),
      ) ||
      new Set(value.sessions.map((r: any) => r[0])).size !==
        value.sessions.length
    )
      throw new Error("Invalid saved login structure.");
    this.salt = value.salt;
    this.key = this.derive();
    const payload = { version: 1, salt: this.salt, sessions: value.sessions };
    // Password/account rotation or tampering invalidates all saved sessions.
    if (
      !timingSafeEqual(
        Buffer.from(value.mac, "hex"),
        Buffer.from(this.signature(payload), "hex"),
      )
    )
      return new Map();
    return new Map(
      value.sessions.filter(
        (r: [string, number]) => r[1] > now && r[1] <= now + 7 * 86400000,
      ),
    );
  }
  async save(sessions: Map<string, number>) {
    this.key ??= this.derive();
    const payload = { version: 1, salt: this.salt, sessions: [...sessions] };
    await atomic(
      this.file,
      JSON.stringify({ ...payload, mac: this.signature(payload) }),
    );
  }
}
