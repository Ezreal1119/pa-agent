import {createHash, randomUUID} from 'node:crypto';
import {splitUtf8} from './protocol.mjs';

async function abortable(operation, signal) {
  let abort;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

/** Dedicated loopback API; never forwards credentials through redirects. */
export class ApkNoticeApi {
  constructor(base, token) {
    const url = new URL(base);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/'
        || url.username || url.password || url.search || url.hash || typeof token !== 'string'
        || token.length < 32 || token.length > 256 || !/^[\x21-\x7e]+$/.test(token)) {
      throw new Error('Invalid APK notification connection.');
    }
    this.base = url.origin; this.token = token;
  }
  async json(operation, body, signal) {
    if (!['claim', 'ack'].includes(operation)) throw new Error('Invalid APK notification operation.');
    const response = await fetch(`${this.base}/internal/apk-notifications/${operation}`, {
      method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${this.token}`},
      body: JSON.stringify(body), signal,
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('APK notification service unavailable.'); }
    return response.json();
  }
}

/** Uses the exact first-bot/private-recipient pair used by Sync reports. */
export class ApkNotifier {
  constructor({store, api, clients, botId, recipient, isConnected, log = console}) {
    Object.assign(this, {store, api, clients, botId, recipient, isConnected, log});
    this.consumer = randomUUID();
  }
  start() {
    if (!this.clients.has(this.botId) || typeof this.recipient !== 'string' || !this.recipient
        || this.recipient.length > 256 || /[\s\u0000-\u001f\u007f]/.test(this.recipient)) return this;
    this.destination = createHash('sha256').update(JSON.stringify([this.botId, this.recipient])).digest('hex');
    const records = this.store.data.apkDeliveries;
    if (records !== undefined && (!records || typeof records !== 'object' || Array.isArray(records)
        || Object.values(records).some(row => !row || !Number.isSafeInteger(row.parts) || row.parts < 0
            || !/^[a-f0-9]{64}$/.test(row.destination)))) {
      this.log.warn('APK notifications paused: invalid delivery checkpoint.'); return this;
    }
    this.store.data.apkDeliveries ??= {};
    this.enabled = true;
    this.timer = setInterval(() => this.pump(), 5000); this.timer.unref?.(); this.pump();
    return this;
  }
  pump() {
    if (!this.enabled || this.closed || this.active || !this.isConnected(this.botId)) return;
    this.active = this.dispatch().catch(() => {
      if (!this.closed) this.log.warn('APK notification deferred; completion retained for retry.');
    }).finally(() => { this.active = undefined; });
    return this.active;
  }
  async dispatch() {
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(45000)]);
    try {
      const {notice} = await this.api.json('claim', {destination: this.destination, consumer: this.consumer}, signal);
      if (!notice) return;
      const canonical = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
      if (!canonical.test(notice.id) || !canonical.test(notice.claim) || notice.destination !== this.destination
          || typeof notice.text !== 'string' || !notice.text.trim() || Buffer.byteLength(notice.text) > 8192) {
        throw new Error('Invalid APK notification.');
      }
      const key = `${this.destination}:${notice.id}`;
      const checkpoint = this.store.data.apkDeliveries[key] ??= {parts: 0, destination: this.destination};
      if (checkpoint.destination !== this.destination) throw new Error('APK notification destination changed.');
      const parts = splitUtf8(notice.text);
      if (checkpoint.parts > parts.length) throw new Error('Invalid APK delivery progress.');
      for (let i = checkpoint.parts; i < parts.length; i++) {
        signal.throwIfAborted();
        if (this.closed || !this.isConnected(this.botId)) throw new Error('Bot unavailable.');
        await abortable(this.clients.get(this.botId).sendMessage(this.recipient,
          {msgtype: 'markdown', markdown: {content: parts[i]}}), signal);
        checkpoint.parts = i+1;
        await this.store.save();
      }
      const result = await this.api.json('ack', {id: notice.id, claim: notice.claim, destination: this.destination}, signal);
      if (!result.ok) throw new Error('APK notification lease changed.');
      checkpoint.done = true; await this.store.save();
    } finally { this.controller = undefined; }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(); await this.active; }
}
