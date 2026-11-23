import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {ApkNotifier, ApkNoticeApi} from '../integrations/wecom-bridge/apk-notifications.mjs';

const destination = createHash('sha256').update(JSON.stringify(['sync-bot', 'sync-owner'])).digest('hex');

function fixture() {
  const sent = [], calls = [], logs = [];
  const notice = {id: randomUUID(), claim: randomUUID(), destination, text: 'APK 签名完成\n\n[下载 APK](https://example.test/Test.apk)'};
  const state = {connected: false, ackFails: false, acked: false};
  const store = {data: {syncDeliveries: {untouched: {parts: 1}}}, async save() {}};
  const api = {async json(operation, body) {
    calls.push({operation, body});
    if (operation === 'claim') return {notice: state.acked ? null : structuredClone(notice)};
    if (state.ackFails) throw new Error('lost ACK');
    state.acked = true; return {ok: true};
  }};
  const clients = new Map([['sync-bot', {async sendMessage(recipient, message) {sent.push({recipient, message});}}]]);
  const options = {store, api, clients, botId: 'sync-bot', recipient: 'sync-owner', isConnected: () => state.connected,
    log: {warn(text) {logs.push(text);}}};
  return {state, store, notice, options, sent, calls, logs};
}

test('uses the Sync recipient; waits while offline and does not touch Sync delivery records', async () => {
  const f = fixture(); const notifier = new ApkNotifier(f.options).start();
  assert.equal(notifier.pump(), undefined); assert.equal(f.calls.length, 0);
  f.state.connected = true; await notifier.pump();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].recipient, 'sync-owner');
  assert.equal(f.sent[0].message.msgtype, 'markdown');
  assert.equal(f.calls[0].body.destination, destination);
  assert.deepEqual(f.store.data.syncDeliveries, {untouched: {parts: 1}});
  await notifier.pump(); assert.equal(f.sent.length, 1);
  await notifier.close();
});

test('lost ACK and restart do not resend already checkpointed message; target mismatch never sends', async () => {
  const f = fixture(); f.state.ackFails = true;
  const first = new ApkNotifier(f.options).start(); f.state.connected = true; await first.pump();
  assert.equal(f.sent.length, 1); assert.equal(f.state.acked, false); await first.close();
  f.state.connected = false; f.state.ackFails = false; f.notice.claim = randomUUID();
  const restarted = new ApkNotifier(f.options).start(); f.state.connected = true; await restarted.pump();
  assert.equal(f.sent.length, 1); assert.equal(f.state.acked, true); await restarted.close();
  f.state.connected = false; f.state.acked = false;
  const other = new ApkNotifier({...f.options, recipient: 'another-owner'}).start();
  f.state.connected = true; await other.pump(); assert.equal(f.sent.length, 1); await other.close();
});

test('credentials stay on loopback and invalid checkpoint pauses only APK delivery', async () => {
  for (const url of ['https://127.0.0.1:8767', 'http://evil.test', 'http://127.0.0.1:8767/path', 'http://user:pass@127.0.0.1']) {
    assert.throws(() => new ApkNoticeApi(url, 'x'.repeat(40)));
  }
  assert.throws(() => new ApkNoticeApi('http://127.0.0.1:8767', 'short'));
  const f = fixture(); f.store.data.apkDeliveries = {bad: {parts: -1}};
  const notifier = new ApkNotifier(f.options).start(); assert(!notifier.enabled);
  assert.deepEqual(f.store.data.syncDeliveries, {untouched: {parts: 1}}); await notifier.close();
});
