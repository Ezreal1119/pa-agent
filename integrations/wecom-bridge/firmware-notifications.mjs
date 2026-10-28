import { randomUUID } from 'node:crypto';
import { splitUtf8 } from './protocol.mjs';

async function abortable(operation, signal) {
  let abort;
  try { return await Promise.race([operation, new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Durable delivery checkpoints are independent of chat/model jobs and tool switches. */
export class FirmwareNotifier {
  constructor({ store, api, clients, isConnected, scope, log = console }) {
    Object.assign(this, { store, api, clients, isConnected, scope, log }); this.consumer = randomUUID();
  }
  start() {
    const state = this.store.data.firmwareDeliveries;
    if (state !== undefined && (!state || typeof state !== 'object' || Array.isArray(state) || Object.values(state).some(x => !x || !Number.isSafeInteger(x.parts) || x.parts < 0 || !Number.isFinite(x.at)))) {
      this.log.warn('Firmware notifications paused: invalid delivery checkpoint.'); return this;
    }
    this.store.data.firmwareDeliveries ??= {};
    this.enabled = true; this.timer = setInterval(() => this.pump(), 5000); this.timer.unref?.(); this.pump(); return this;
  }
  pump() {
    if (!this.enabled || this.closed || this.active) return;
    const botIds = [...this.clients.keys()].filter(id => this.isConnected(id)); if (!botIds.length) return;
    this.active = this.dispatch(botIds).catch(() => { if (!this.closed) this.log.warn('Firmware notice deferred; retained for later delivery.'); }).finally(() => { this.active = undefined; });
    return this.active;
  }
  async dispatch(botIds) {
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(45000)]);
    try {
      const { notice } = await this.api.json('/firmware/notifications/claim', 'POST', { botIds, consumer: this.consumer }, signal);
      if (!notice) return;
      if (!botIds.includes(notice.botId) || !['single', 'group'].includes(notice.chatType) || [notice.target, notice.userId].some(x => typeof x !== 'string' || !x || x.length > 256 || /[\s\u0000-\u001f]/u.test(x)) || notice.chatType === 'single' && notice.target !== notice.userId || typeof notice.text !== 'string' || !notice.text.trim() || Buffer.byteLength(notice.text) > 32768 || !/^[a-f0-9-]{36}$/.test(notice.id) || !/^[a-f0-9-]{36}$/.test(notice.claim)) throw new Error('Invalid firmware notice.');
      const records = this.store.data.firmwareDeliveries;
      const checkpoint = records[notice.id] ??= { parts: 0, at: Date.now() };
      const chunks = splitUtf8(notice.text);
      for (let i = checkpoint.parts; i < chunks.length; i++) {
        if (this.closed || !this.isConnected(notice.botId)) throw new Error('Bot disconnected.');
        signal.throwIfAborted();
        await abortable(this.clients.get(notice.botId).sendMessage(notice.target, { msgtype: 'markdown', markdown: { content: chunks[i] } }), signal);
        checkpoint.parts = i + 1; await this.store.save();
      }
      {
        const scope = this.scope(JSON.stringify([notice.botId, notice.chatType, notice.target]));
        if (scope.firmwareUser === notice.userId && scope.firmwareFlow === notice.flowId) {
          if (notice.prompt && notice.expiresAt > Date.now()) scope.firmwareUntil = notice.expiresAt;
          else if (!notice.prompt) { delete scope.firmwareUser; delete scope.firmwareFlow; delete scope.firmwareUntil; }
        }
        await this.store.save();
      }
      const result = await this.api.json('/firmware/notifications/ack', 'POST', { id: notice.id, claim: notice.claim }, signal);
      if (!result.ok) throw new Error('Notice lease changed.');
      checkpoint.done = true;
      for (const [id, entry] of Object.entries(records)) if (entry.done && entry.at < Date.now() - 86400000) delete records[id];
      await this.store.save();
    } finally { this.controller = undefined; }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(); await this.active; }
}
