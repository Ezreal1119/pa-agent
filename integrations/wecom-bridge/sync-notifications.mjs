import { randomUUID, createHash } from 'node:crypto';
import { splitUtf8 } from './protocol.mjs';

async function abortable(operation, signal) {
  let abort;
  try { return await Promise.race([operation, new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** One configured private account, using the same first bot as balance notices. */
export class SyncNotifier {
  constructor({ store, api, clients, botId, recipient, isConnected, log = console }) {
    Object.assign(this, { store, api, clients, botId, recipient, isConnected, log }); this.consumer = randomUUID();
  }
  start() {
    if (typeof this.recipient !== 'string' || !this.recipient || this.recipient.length > 256 || /[\s\u0000-\u001f\u007f]/.test(this.recipient) || !this.clients.has(this.botId)) return this;
    this.destination = createHash('sha256').update(JSON.stringify([this.botId, this.recipient])).digest('hex');
    const data = this.store.data.syncDeliveries;
    if (data !== undefined && (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(v => !v || !Number.isSafeInteger(v.parts) || v.parts < 0 || typeof v.destination !== 'string'))) {
      this.log.warn('Sync notifications paused: invalid delivery checkpoint.'); return this;
    }
    this.store.data.syncDeliveries ??= {};
    this.enabled = true; this.timer = setInterval(() => this.pump(), 5000); this.timer.unref?.(); this.pump(); return this;
  }
  pump() {
    if (!this.enabled || this.closed || this.active || !this.isConnected(this.botId)) return;
    this.active = this.dispatch().catch(() => { if (!this.closed) this.log.warn('Sync notice deferred; retained for later delivery.'); }).finally(() => { this.active = undefined; });
    return this.active;
  }
  async dispatch() {
    this.controller = new AbortController(); const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(45000)]);
    try {
      const { notice } = await this.api.json('/sync-notifications/claim', 'POST', { botId: this.botId, recipient: this.recipient, consumer: this.consumer }, signal);
      if (!notice) return;
      if (!/^[a-f0-9-]{36}$/.test(notice.id) || !/^[a-f0-9-]{36}$/.test(notice.claim) || notice.destination !== this.destination || typeof notice.text !== 'string' || !notice.text.trim() || Buffer.byteLength(notice.text) > 32768) throw new Error('Invalid Sync notification.');
      const records = this.store.data.syncDeliveries;
      const checkpoint = records[notice.id] ??= { parts: 0, destination: this.destination };
      if (checkpoint.destination !== this.destination) throw new Error('Sync destination changed.');
      const parts = splitUtf8(notice.text);
      for (let i = checkpoint.parts; i < parts.length; i++) {
        signal.throwIfAborted(); if (this.closed || !this.isConnected(this.botId)) throw new Error('Bot disconnected.');
        await abortable(this.clients.get(this.botId).sendMessage(this.recipient, { msgtype: 'markdown', markdown: { content: parts[i] } }), signal);
        checkpoint.parts = i + 1; await this.store.save();
      }
      const result = await this.api.json('/sync-notifications/ack', 'POST', { id: notice.id, claim: notice.claim }, signal);
      if (!result.ok) throw new Error('Sync notice lease changed.');
      checkpoint.done = true; await this.store.save();
    } finally { this.controller = undefined; }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(); await this.active; }
}
