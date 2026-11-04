import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CkdRun } from "./types.js";
import { currentLockIdentity, isLockOwnerAlive, type LockOwner } from "./lock-owner.js";

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export class CkdStore {
  readonly root: string;
  constructor(dataDir: string) {
    const root = path.resolve(dataDir, "ckd", "runs");
    fs.mkdirSync(root, { recursive: true });
    this.root = fs.realpathSync(root);
  }
  directory(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) throw new Error("Invalid CKD run ID.");
    return path.join(this.root, id);
  }
  private trashFile(id:string) { this.directory(id);return path.resolve(this.root,'../task-trash',id+'.json'); }
  get(id: string, includeDeleted=false): CkdRun {
    if(!includeDeleted&&fs.existsSync(this.trashFile(id)))throw Object.assign(new Error('任务已移入回收站。'),{code:'ENOENT'});
    const run = JSON.parse(fs.readFileSync(path.join(this.directory(id), "state.json"), "utf8")) as CkdRun;
    if (run.schemaVersion !== 1 || run.id !== id) throw new Error("Unsupported or invalid CKD task state.");
    if (path.resolve(run.workspaceRoot, run.workspaceRelative) !== this.directory(id)) throw new Error("Task workspace differs from its storage directory.");
    return run;
  }
  save(run: CkdRun): void { run.updatedAt = new Date().toISOString(); atomicJson(path.join(this.directory(run.id), "state.json"), run); }
  list(): CkdRun[] {
    return fs.readdirSync(this.root).filter(name => /^[0-9a-f-]{36}$/u.test(name) && fs.existsSync(path.join(this.root, name, "state.json"))&&!fs.existsSync(this.trashFile(name))).map(id => this.get(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  deleted():CkdRun[]{const folder=path.resolve(this.root,'../task-trash');if(!fs.existsSync(folder))return [];return fs.readdirSync(folder).filter(n=>/^[0-9a-f-]{36}\.json$/u.test(n)&&fs.existsSync(path.join(this.root,n.slice(0,-5),'state.json'))).map(n=>this.get(n.slice(0,-5),true)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  trash(id:string){this.get(id);atomicJson(this.trashFile(id),{id,deletedAt:new Date().toISOString()});}
  restore(id:string){this.get(id,true);const file=this.trashFile(id);if(fs.existsSync(file))fs.unlinkSync(file);}
  cancelled(id: string): boolean { return fs.existsSync(path.join(this.directory(id), "cancel.request")); }
  requestCancel(id: string): void { this.get(id); fs.writeFileSync(path.join(this.directory(id), "cancel.request"), "cancel\n", { mode: 0o600 }); }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const directory = this.directory(id); fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, "run.lock");
    const token = randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        if (fs.existsSync(`${lock}.reclaim`)) throw new Error("CKD task is busy in another process.");
        fs.mkdirSync(lock); break;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Serialize stale-owner recovery; contenders re-read the owner under this guard.
        const guard = `${lock}.reclaim`;
        try { fs.mkdirSync(guard); } catch { throw new Error("CKD task is busy in another process."); }
        try {
          let alive = true;
          try {
            const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as LockOwner;
            alive = isLockOwnerAlive(owner, fs.statSync(lock).mtimeMs);
          } catch { alive = fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 5_000; }
          if (alive || attempt > 2) throw new Error("CKD task is busy in another process.");
          fs.rmSync(lock, { recursive: true, force: true });
        } finally { fs.rmSync(guard, { recursive: true, force: true }); }
      }
    }
    atomicJson(path.join(lock, "owner.json"), { pid: process.pid, token, ...currentLockIdentity() });
    try { return await action(); }
    finally {
      const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as { token: string };
      if (owner.token === token) fs.rmSync(lock, { recursive: true });
    }
  }
}
