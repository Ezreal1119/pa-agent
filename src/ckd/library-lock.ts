import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson } from "./store.js";
import { currentLockIdentity, isLockOwnerAlive, type LockOwner } from "./lock-owner.js";
export function acquireDirectoryLock(lock: string): () => void {
    const guard = `${lock}.reclaim`;
    // Library 直接放在盘根时（如 D:\CKD-agent），锁的父目录就是 D:\；
    // Windows 上 mkdirSync("D:\\", { recursive: true }) 会抛 EPERM，所以先判断再建。
    const parent = path.dirname(lock);
    if (!fs.existsSync(parent))
        fs.mkdirSync(parent, { recursive: true });
    for (let attempt = 0;; attempt++) {
        try {
            if (fs.existsSync(guard))
                throw new Error("Library/task is busy in another process.");
            fs.mkdirSync(lock);
            break;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                throw error;
            try {
                fs.mkdirSync(guard);
            }
            catch {
                throw new Error("Library/task is busy in another process.");
            }
            try {
                let alive = true;
                try {
                    const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as LockOwner;
                    alive = isLockOwnerAlive(owner, fs.statSync(lock).mtimeMs);
                }
                catch {
                    alive = fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 5000;
                }
                if (alive || attempt >= 2)
                    throw new Error("Library/task is busy in another process.");
                fs.rmSync(lock, { recursive: true, force: true });
            }
            finally {
                fs.rmSync(guard, { recursive: true, force: true });
            }
        }
    }
    const token = randomUUID();
    try {
        atomicJson(path.join(lock, "owner.json"), { pid: process.pid, token, ...currentLockIdentity() });
    }
    catch (error) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
    }
    return () => {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
        if (owner.token === token)
            fs.rmSync(lock, { recursive: true });
    };
}
export function libraryPendingMarker(library: string): string {
    const real = fs.realpathSync(library);
    return path.join(path.dirname(real), `.${path.basename(real)}.pi-pending.json`);
}
export function acquireLibraryLock(library: string, allowPending = false): () => void {
    const real = fs.realpathSync(library);
    // A sibling lock is shared by CLI, HTTP and different data-dir configurations.
    const release = acquireDirectoryLock(path.join(path.dirname(real), `.${path.basename(real)}.pi-operation.lock`));
    if (!allowPending && fs.existsSync(libraryPendingMarker(real))) {
        release();
        throw new Error("Library is busy: resume its interrupted maintenance job first.");
    }
    return release;
}
