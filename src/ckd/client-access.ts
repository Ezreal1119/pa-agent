import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicJson } from './store.js';
import { UserStore, UserError, publicUser, verifyUserPassword } from './users.js';

export class ClientAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
/** Persistent ordinary users; bearer sessions deliberately do not survive restart. */
export class ClientAccess {
  private readonly sessions = new Map<string, { userId: string; version: number; expiresAt: number }>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly root: string;
  readonly users: UserStore;
  constructor(dataDir: string, private readonly now = Date.now, adminAccount?: string) {
    this.root = path.join(dataDir, 'ckd/client-runs');
    this.users = new UserStore(dataDir, adminAccount);
  }
  private async limited<T>(key: string, action: () => Promise<T>) {
    const time = this.now();
    for (const [id, entry] of this.failures) if (entry.until <= time) this.failures.delete(id);
    const failure = this.failures.get(key);
    if (failure && failure.count >= 10) throw new ClientAccessError(429, '尝试次数过多，请稍后再试。');
    if (!failure && this.failures.size >= 10000) throw new ClientAccessError(429, '登录请求繁忙，请稍后再试。');
    try { const value = await action(); this.failures.delete(key); return value; }
    catch (error) {
      if (error instanceof ClientAccessError && error.status === 401 || error instanceof UserError && error.status === 400) {
        const latest = this.failures.get(key); this.failures.set(key, { count: (latest?.count || 0) + 1, until: latest?.until || time + 5 * 60000 });
      }
      throw error;
    }
  }
  async login(input: Record<string, unknown>, passwordChangeCapable = false) {
    const account = typeof input.account === 'string' ? input.account : '';
    return this.limited('login:' + account.toLowerCase().slice(0, 64), async () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(account) || typeof input.password !== 'string' || input.password.length > 512) throw new ClientAccessError(401, '账号或密码错误。');
    const user = this.users.find(account);
    const matches = await verifyUserPassword(input.password, user?.passwordHash);
    if (!user || !user.enabled || user.account === '111' || user.account.toLowerCase() === this.users.adminAccount?.toLowerCase() || !matches) throw new ClientAccessError(401, '账号或密码错误。');
    if (user.mustChangePassword && !passwordChangeCapable) throw new ClientAccessError(426, '此账号需要修改初始密码，请升级到 0.1.9 或更新的桌面客户端。');
    // Re-read after the asynchronous KDF: a concurrent reset/disable must win.
    const current = this.users.get(user.id);
    if (!current?.enabled || current.credentialVersion !== user.credentialVersion) throw new ClientAccessError(401, '账号或密码错误。');
    for (const [token, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(token);
    const token = randomBytes(32).toString('hex'), expiresAt = this.now() + 12 * 60 * 60 * 1000;
    this.sessions.set(token, { userId: user.id, version: user.credentialVersion, expiresAt });
    return { token, account: user.account, userId: user.id, mustChangePassword: user.mustChangePassword, expiresAt: new Date(expiresAt).toISOString() };
    });
  }
  private session(header: string | undefined) {
    const token = /^Bearer ([a-f0-9]{64})$/u.exec(header ?? '')?.[1];
    const session = token ? this.sessions.get(token) : undefined;
    const user = session ? this.users.get(session.userId) : undefined;
    if (!session || session.expiresAt <= this.now() || !user?.enabled || user.credentialVersion !== session.version || user.account === '111' || user.account.toLowerCase() === this.users.adminAccount?.toLowerCase()) {
      if (token) this.sessions.delete(token);
      throw new ClientAccessError(401, '登录已失效，请重新登录。');
    }
    return { session, user };
  }
  authenticate(header: string | undefined) {
    const { user } = this.session(header);
    if (user.mustChangePassword) throw new ClientAccessError(403, '请先修改初始密码后再使用工作台。');
    return user.id;
  }
  me(header: string | undefined) { return publicUser(this.session(header).user); }
  async changePassword(header: string | undefined, input: Record<string, unknown>) {
    const { user, session } = this.session(header);
    if (Object.keys(input).some(key => !['currentPassword', 'newPassword'].includes(key))) throw new ClientAccessError(400, '修改密码只能提交原密码和新密码。');
    await this.limited('password:' + user.id, () => this.users.changePassword(user.id, session.version, input.currentPassword, input.newPassword));
    for (const [token, value] of this.sessions) if (value.userId === user.id) this.sessions.delete(token);
  }
  logout(header: string | undefined) { this.session(header); this.sessions.delete(header!.slice(7)); }
  private file(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) throw new ClientAccessError(404, '任务不存在。');
    return path.join(this.root, id + '.json');
  }
  claim(id: string, account: string) { atomicJson(this.file(id), { account, runId: id }); }
  owns(id: string, account: string) {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')).account === account; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  requireOwner(id: string, account: string) { if (!this.owns(id, account)) throw new ClientAccessError(404, '任务不存在。'); }
}
