import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { atomicJson } from './store.js';
import { currentLockIdentity, isLockOwnerAlive, type LockOwner } from './lock-owner.js';

export class UserError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type User = { id: string; account: string; enabled: boolean; mustChangePassword: boolean; credentialVersion: number; passwordHash: string; createdAt: string; updatedAt: string };
export const publicUser = ({ passwordHash: _secret, credentialVersion: _version, ...user }: User) => ({ ...user, role: 'user' as const });
let cryptoTail: Promise<unknown> = Promise.resolve(), queued = 0;
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (queued >= 16) throw new UserError(429, '登录请求繁忙，请稍后再试。');
  queued++;
  const result = cryptoTail.then(() => new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  }));
  cryptoTail = result.catch(() => {});
  try { return await result; } finally { queued--; }
}
export async function hashUserPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt:131072:8:1:${salt.toString('hex')}:${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyUserPassword(password: string, hash?: string) {
  const match = /^scrypt:131072:8:1:([a-f0-9]{32}):([a-f0-9]{128})$/u.exec(hash || '');
  const actual = await derive(password, match ? Buffer.from(match[1]!, 'hex') : Buffer.alloc(16));
  return !!match && timingSafeEqual(actual, Buffer.from(match[2]!, 'hex'));
}
export function validateNewPassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Array.from(value).length < 15 || Array.from(value).length > 128) throw new UserError(400, '新密码须为 15–128 个字符，可包含空格，不会自动去除首尾空格。');
}

/** One atomic registry; no plaintext credentials, immutable user IDs and accounts. */
export class UserStore {
  readonly root: string;
  constructor(dataDir: string, readonly adminAccount?: string) { this.root = path.join(dataDir, 'ckd/users'); }
  private read(): User[] {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.root, 'users.json'), 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.users)) throw new Error();
      const ids = new Set(), accounts = new Set();
      for (const user of value.users) {
        if (!user || !/^[a-f0-9-]{36}$/u.test(user.id) || typeof user.account !== 'string' || typeof user.enabled !== 'boolean' || typeof user.mustChangePassword !== 'boolean' || !Number.isSafeInteger(user.credentialVersion) || user.credentialVersion < 1 || !/^scrypt:131072:8:1:[a-f0-9]{32}:[a-f0-9]{128}$/u.test(user.passwordHash) || ids.has(user.id) || accounts.has(user.account.toLowerCase())) throw new Error();
        ids.add(user.id); accounts.add(user.account.toLowerCase());
      }
      return value.users;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new UserError(503, '用户资料读取失败，请联系管理员；原文件未被覆盖。');
    }
  }
  private update<T>(action: (users: User[]) => T): T {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = path.join(this.root, 'write.lock'), token = randomUUID();
    for (;;) {
      try { fs.mkdirSync(lock); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try { fs.mkdirSync(lock + '.reclaim'); } catch { throw new UserError(409, '用户资料正在更新，请重试。'); }
        try {
          let alive = true;
          try { alive = isLockOwnerAlive(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) as LockOwner, fs.statSync(lock).mtimeMs); }
          catch { alive = fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 5000; }
          if (alive) throw new UserError(409, '用户资料正在更新，请重试。');
          fs.rmSync(lock, { recursive: true, force: true });
        } finally { fs.rmdirSync(lock + '.reclaim'); }
      }
    }
    try {
      atomicJson(path.join(lock, 'owner.json'), { pid: process.pid, token, ...currentLockIdentity() });
      const users = this.read(), result = action(users);
      atomicJson(path.join(this.root, 'users.json'), { version: 1, users });
      return result;
    } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  }
  list() { return this.read().map(publicUser); }
  get(id: string) { return this.read().find(user => user.id === id); }
  find(account: string) { return this.read().find(user => user.account.toLowerCase() === account.toLowerCase()); }
  private reserved(account: string) { return account === '111' || account.toLowerCase() === this.adminAccount?.toLowerCase(); }
  async create(account: unknown) {
    if (typeof account !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(account) || this.reserved(account)) throw new UserError(400, '账号须为 3–64 位字母、数字、点、下划线或短横线；不能使用管理员或旧测试账号。');
    const initialPassword = randomBytes(15).toString('base64url'), passwordHash = await hashUserPassword(initialPassword);
    const user = this.update(users => {
      if (users.some(u => u.account.toLowerCase() === account.toLowerCase())) throw new UserError(409, '账号已存在（包含已禁用账号）。');
      const now = new Date().toISOString();
      const user: User = { id: randomUUID(), account, enabled: true, mustChangePassword: true, credentialVersion: 1, passwordHash, createdAt: now, updatedAt: now };
      users.push(user); return publicUser(user);
    });
    return { user, initialPassword };
  }
  private editable(users: User[], id: string) {
    const user = users.find(u => u.id === id);
    if (!user || this.reserved(user.account)) throw new UserError(404, '普通用户不存在。');
    return user;
  }
  setEnabled(id: string, enabled: unknown) {
    if (typeof enabled !== 'boolean') throw new UserError(400, '用户状态无效。');
    return this.update(users => { const user = this.editable(users, id); user.enabled = enabled; user.credentialVersion++; user.updatedAt = new Date().toISOString(); return publicUser(user); });
  }
  async reset(id: string) {
    const initialPassword = randomBytes(15).toString('base64url'), hash = await hashUserPassword(initialPassword);
    const user = this.update(users => { const user = this.editable(users, id); user.passwordHash = hash; user.mustChangePassword = true; user.credentialVersion++; user.updatedAt = new Date().toISOString(); return publicUser(user); });
    return { user, initialPassword };
  }
  async changePassword(id: string, version: number, currentPassword: unknown, newPassword: unknown) {
    validateNewPassword(newPassword);
    const before = this.get(id);
    if (typeof currentPassword !== 'string' || currentPassword.length > 512 || !before || !await verifyUserPassword(currentPassword, before.passwordHash)) throw new UserError(400, '原密码错误。');
    if (currentPassword === newPassword) throw new UserError(400, '新密码不能与原密码相同。');
    const hash = await hashUserPassword(newPassword);
    this.update(users => {
      const user = this.editable(users, id);
      if (!user.enabled || user.credentialVersion !== version) throw new UserError(401, '登录已失效，请重新登录。');
      user.passwordHash = hash; user.mustChangePassword = false; user.credentialVersion++; user.updatedAt = new Date().toISOString();
    });
  }
}
