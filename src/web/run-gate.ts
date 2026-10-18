/** One shared limit for browser and machine-API runs, including waiting cancellation. */
export class RunGate {
  private active = 0;
  private waiting: { grant: () => void; cancel: () => void }[] = [];
  constructor(readonly limit: number, readonly queueLimit: number) {}
  snapshot() { return { active: this.active, waiting: this.waiting.length, limit: this.limit, queueLimit: this.queueLimit }; }
  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error("请求已取消。")); return; }
      const entry = {
        grant: () => {
          signal.removeEventListener("abort", entry.cancel);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return; released = true; this.active--;
            this.waiting.shift()?.grant();
          });
        },
        cancel: () => {
          this.waiting = this.waiting.filter(item => item !== entry);
          signal.removeEventListener("abort", entry.cancel);
          reject(new Error("等待中的请求已取消。"));
        }
      };
      if (this.active < this.limit) entry.grant();
      else if (this.waiting.length >= this.queueLimit) reject(new Error("运行队列已满，请稍后重试。"));
      else { this.waiting.push(entry); signal.addEventListener("abort", entry.cancel, { once: true }); }
    });
  }
}

export function boundedSetting(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be ${min}–${max}.`);
  return number;
}
