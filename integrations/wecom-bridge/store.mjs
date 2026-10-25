import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function processMarker(pid) {
  try {
    const [stat, boot] = await Promise.all([fs.readFile(`/proc/${pid}/stat`, 'utf8'), fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
    return `${boot.trim()}:${stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]}`;
  } catch { return undefined; }
}

export class BridgeStore {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'bridge-state.json'); this.tail = Promise.resolve(); this.data = { version: 1, conversations: {}, jobs: [] }; }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('WeCom 数据目录不能是符号链接。');
    this.lock = path.join(this.directory, 'bridge.lock');
    this.nonce = randomUUID();
    const marker = await processMarker(process.pid);
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await fs.writeFile(this.lock, JSON.stringify({ pid: process.pid, nonce: this.nonce, marker }), { flag: 'wx', mode: 0o600 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST' || attempt) throw error;
        const previous = JSON.parse(await fs.readFile(this.lock, 'utf8'));
        if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('WeCom 锁文件无效，请检查后恢复。');
        let alive = true;
        try { process.kill(previous.pid, 0); }
        catch (check) { if (check.code !== 'ESRCH') throw check; alive = false; }
        if (alive) {
          const current = await processMarker(previous.pid);
          if (!previous.marker || !current || previous.marker === current) throw new Error('另一个 WeCom Bridge 已运行，请勿重复连接同一机器人。');
          // Linux boot ID + process start time distinguish a stale, reused PID after reboot.
        }
        await fs.unlink(this.lock);
      }
    }
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.jobs) || !value.conversations || typeof value.conversations !== 'object') throw new Error('WeCom 状态文件格式错误，拒绝重置已有映射。');
      if (value.scopes !== undefined && (!value.scopes || typeof value.scopes !== 'object' || Array.isArray(value.scopes) || Object.entries(value.scopes).some(([key, scope]) => {
        let parts; try { parts = JSON.parse(key); } catch { return true; }
        return !Array.isArray(parts) || parts.length !== 3 || !['single', 'group'].includes(parts[1]) || !scope || !Number.isSafeInteger(scope.generation) || scope.generation < 0 || scope.awaitingUser !== undefined && (typeof scope.awaitingUser !== 'string' || !scope.awaitingUser || scope.awaitingUser.length > 256) || scope.awaitingMode !== undefined && !['role', 'files'].includes(scope.awaitingMode);
      }))) throw new Error('WeCom command scope state is invalid; existing preferences were not reset.');
      this.data = value;
    } catch (error) { if (error.code !== 'ENOENT') { await this.close(); throw error; } }
    return this;
  }
  save() {
    // Snapshot when the serialized write begins, so later writes cannot lose newer state.
    const work = this.tail.then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(this.data)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.file);
      } finally { await fs.rm(temporary, { force: true }); }
    });
    this.tail = work.catch(() => {}); return work;
  }
  jobDirectory(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid bridge job ID.'); return path.join(this.directory, 'inbox', id); }
  async close() {
    await this.tail;
    if (!this.lock) return;
    const current = await fs.readFile(this.lock, 'utf8').then(JSON.parse).catch(() => undefined);
    if (current?.nonce === this.nonce) await fs.unlink(this.lock);
  }
}
