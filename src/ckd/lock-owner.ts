import fs from "node:fs";

export type LockOwner = { pid: number; token: string; bootId?: string; startTicks?: string };

function readBootId(): string | undefined {
  try { return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined; }
  catch { return undefined; }
}

function readStartTicks(pid: number | "self"): string | undefined {
  try {
    // The command name is parenthesized and may contain spaces; field 22 follows it.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/u);
    const ticks = fields[19];
    return ticks && /^\d+$/u.test(ticks) ? ticks : undefined;
  } catch { return undefined; }
}

function readBootTimeMs(): number | undefined {
  try {
    const line = fs.readFileSync("/proc/stat", "utf8").split("\n").find(item => item.startsWith("btime "));
    const seconds = Number(line?.split(/\s+/u)[1]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  } catch { return undefined; }
}

export function currentLockIdentity(): Pick<LockOwner, "bootId" | "startTicks"> {
  if (process.platform !== "linux") return {};
  return { bootId: readBootId(), startTicks: readStartTicks("self") };
}

export function isLockOwnerAlive(owner: LockOwner, lockMtimeMs: number): boolean {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid lock owner.");
  try { process.kill(owner.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; }
  if (process.platform !== "linux") return true;

  const bootId = readBootId();
  if (owner.bootId && bootId && owner.bootId !== bootId) return false;
  // Old locks contain only a PID. A lock from a previous boot cannot be live.
  if (!owner.bootId) {
    const bootTimeMs = readBootTimeMs();
    if (bootTimeMs && lockMtimeMs < bootTimeMs) return false;
  }
  const startTicks = owner.startTicks && readStartTicks(owner.pid);
  if (startTicks && owner.startTicks !== startTicks) return false;
  return true;
}
