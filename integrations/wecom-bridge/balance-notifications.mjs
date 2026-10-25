export const BALANCE_HOURS = Object.freeze([10, 11, 12, 15, 16, 17, 18, 20, 22]);

/** Fixed Beijing-time slots; never infer the host timezone or catch up past minutes. */
export function balanceSlot(at) {
  const date = new Date(at + 8 * 60 * 60000);
  if (!Number.isFinite(date.getTime()) || date.getUTCMinutes() !== 0 || !BALANCE_HOURS.includes(date.getUTCHours())) return;
  return date.toISOString().slice(0, 13);
}
const validSlot = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:10|11|12|15|16|17|18|20|22)$/.test(value) &&
  new Date(`${value}:00:00.000Z`).toISOString().slice(0, 13) === value;

/** A single private recipient, independent of chat jobs, observer overrides and model slots. */
export class BalanceNotifier {
  constructor({ store, api, clients, botId, recipient, isConnected, log = console, now = Date.now }) {
    Object.assign(this, { store, api, clients, botId, recipient, isConnected, log, now });
    this.closed = false;
  }
  start() {
    // Never load a destination from disk, previous messages or another bot's override.
    if (typeof this.recipient !== 'string' || !this.recipient || this.recipient.length > 256 || /[\s\u0000-\u001f\u007f]/.test(this.recipient) || !this.clients.has(this.botId)) return this;
    const state = this.store.data.balanceSchedule;
    try {
      if (state !== undefined && (!state || !validSlot(state.lastSlot) || !['claimed', 'sent', 'failed', 'skipped'].includes(state.status))) throw new Error('Invalid balance schedule state.');
    } catch {
      this.log.warn('WeCom balance schedule disabled: invalid checkpoint; existing chat state was preserved.');
      return this;
    }
    this.enabled = true;
    this.timer = setInterval(() => this.pump(), 15000); this.timer.unref?.();
    this.pump(); return this;
  }
  pump() {
    if (!this.enabled || this.closed || this.active || !this.isConnected(this.botId)) return;
    const slot = balanceSlot(this.now());
    if (!slot || slot <= (this.store.data.balanceSchedule?.lastSlot ?? '')) return;
    this.active = this.dispatch(slot).catch(() => {
      // No API body, balance, key or destination is written to the log.
      this.log.warn('WeCom balance schedule failed; no automatic retry for this slot.');
    }).finally(() => { this.active = undefined; });
    return this.active;
  }
  async dispatch(slot) {
    const state = { lastSlot: slot, status: 'claimed' };
    this.store.data.balanceSchedule = state;
    // Persist the claim before any external query/send; ambiguous delivery is not replayed.
    await this.store.save();
    if (this.closed || !this.isConnected(this.botId) || balanceSlot(this.now()) !== slot) {
      state.status = 'skipped'; await this.store.save(); return;
    }
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]);
    let text;
    try {
      const response = await this.api.json('/balance', 'GET', undefined, signal);
      if (typeof response?.text !== 'string' || !response.text.trim() || Buffer.byteLength(response.text) > 12000) throw new Error('Invalid balance response.');
      text = response.text;
    } catch {
      if (this.closed) return;
      this.log.warn('WeCom scheduled balance query failed.');
      text = '本次余额查询未完成，请用 /patrick_balance 手动查询。';
    } finally { this.controller = undefined; }
    if (this.closed || !this.isConnected(this.botId)) {
      state.status = 'skipped'; await this.store.save(); return;
    }
    try {
      await this.clients.get(this.botId).sendMessage(this.recipient, {
        msgtype: 'markdown', markdown: { content: `余额定时报送（北京时间 ${slot.replace('T', ' ')}:00）\n\n${text}` },
      });
      state.status = 'sent';
    } catch {
      state.status = 'failed';
      this.log.warn('WeCom scheduled balance delivery failed; no automatic resend.');
    }
    await this.store.save();
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.controller?.abort(); await this.active;
  }
}
