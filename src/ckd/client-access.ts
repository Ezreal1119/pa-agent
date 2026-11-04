import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicJson } from './store.js';

export class ClientAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
/** Temporary single-account authentication; sessions deliberately do not survive restart. */
export class ClientAccess {
  private readonly sessions = new Map<string, { account: string; expiresAt: number }>();
  private readonly root: string;
  constructor(dataDir: string, private readonly now = Date.now) {
    this.root = path.join(dataDir, 'ckd/client-runs');
  }
  login(input: Record<string, unknown>) {
    if (input.account !== '111' || input.password !== '222') throw new ClientAccessError(401, '账号或密码错误。');
    for (const [token, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(token);
    const token = randomBytes(32).toString('hex'), expiresAt = this.now() + 12 * 60 * 60 * 1000;
    this.sessions.set(token, { account: '111', expiresAt });
    return { token, account: '111', expiresAt: new Date(expiresAt).toISOString() };
  }
  authenticate(header: string | undefined) {
    const token = /^Bearer ([a-f0-9]{64})$/u.exec(header ?? '')?.[1];
    const session = token ? this.sessions.get(token) : undefined;
    if (!session || session.expiresAt <= this.now()) {
      if (token) this.sessions.delete(token);
      throw new ClientAccessError(401, '登录已失效，请重新登录。');
    }
    return session.account;
  }
  logout(header: string | undefined) { this.authenticate(header); this.sessions.delete(header!.slice(7)); }
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
