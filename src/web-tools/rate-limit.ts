interface Waiting {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}

/** Shared across sessions and runtime replacement; conservative process-wide limit. */
export class WebRequestLimiter {
  private timestamps: number[] = [];
  private waiting: Waiting[] = [];
  private timer?: NodeJS.Timeout;
  constructor(private readonly limit = 5, private readonly windowMs = 1000, private readonly queueLimit = 32) {}
  acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.waiting.length >= this.queueLimit) return Promise.reject(new Error("联网请求队列已满，请稍后再试。"));
    return new Promise((resolve, reject) => {
      const item: Waiting = { resolve, reject, signal, abort: () => {
        this.waiting = this.waiting.filter(entry => entry !== item);
        signal.removeEventListener("abort", item.abort);
        reject(signal.reason); this.drain();
      } };
      signal.addEventListener("abort", item.abort, { once: true });
      this.waiting.push(item); this.drain();
    });
  }
  private drain(): void {
    clearTimeout(this.timer); this.timer = undefined;
    const now = Date.now();
    this.timestamps = this.timestamps.filter(time => time > now - this.windowMs);
    while (this.waiting.length && this.timestamps.length < this.limit) {
      const item = this.waiting.shift()!;
      item.signal.removeEventListener("abort", item.abort);
      if (item.signal.aborted) { item.reject(item.signal.reason); continue; }
      this.timestamps.push(Date.now()); item.resolve();
    }
    if (this.waiting.length) this.timer = setTimeout(() => this.drain(), Math.max(1, this.timestamps[0]! + this.windowMs - Date.now()));
  }
}
