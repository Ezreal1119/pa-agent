import { SyncNotifier } from './sync-notifications.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { identity, inbound, splitUtf8, resultFromDone, DAY } from './protocol.mjs';
import { AgentUnavailableError, AGENT_UNAVAILABLE_MESSAGE } from './api.mjs';
import { downloadMedia } from './media.mjs';
import { MessageObserver, notificationInput } from './notifications.mjs';
import { commandInput, processControl } from './commands.mjs';
import { BalanceNotifier } from './balance-notifications.mjs';
import { FirmwareNotifier } from './firmware-notifications.mjs';

const live = job => !['done', 'interrupted'].includes(job.state);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Transport and Agent API are injectable: tests never connect real bots or models. */
export class WecomBridge {
  constructor({ config, store, api, clients, download = downloadMedia, log = console, balanceNow = Date.now }) {
    Object.assign(this, { config, store, api, clients, download, log, balanceNow });
    this.active = new Map(); this.controlActive = new Map(); this.jobControllers = new Map(); this.progress = new Map(); this.connected = new Set(); this.mediaTail = Promise.resolve(); this.controllers = new Set(); this.receiving = new Set(); this.closing = false;
  }
  scope(key) { this.store.data.scopes ??= {}; return this.store.data.scopes[key] ??= { generation: 0 }; }
  isCurrent(job) { return live(job) && (job.generation ?? 0) === this.scope(job.key).generation; }
  assertCurrent(job) { if (!this.isCurrent(job)) throw new Error('WeCom conversation was reset.'); }
  trackProgress(job, task) {
    if (!task) return;
    const pending = this.progress.get(job.id) ?? new Set(); pending.add(task); this.progress.set(job.id, pending);
    void task.finally(() => pending.delete(task));
  }
  async start() {
    try {
      this.observer = await new MessageObserver({ directory: this.store.directory, api: this.api, clients: this.clients,
        isConnected: botId => this.connected.has(botId), recipientFor: botId => this.config.bots.find(bot => bot.botId === botId)?.notifyUserId ?? this.config.notifyUserId,
        log: { warn: (...values) => this.log.warn(...values.map(value => this.safeError(value))) } }).open();
    } catch (error) { this.log.warn('WeCom observer unavailable; chat remains enabled:', this.safeError(error)); }

    for (const job of this.store.data.jobs) {
      if (job.state === 'receiving') { job.state = 'delivering'; job.result = { text: '上次接收附件时服务中断，请重新发送文件。', files: [] }; }
      else if (job.state === 'running') job.state = 'recovering';
    }
    await this.maintenance();
    this.timer = setInterval(() => { void this.maintenance().catch(error => this.log.error('WeCom maintenance:', error.message)); }, 60 * 60000);
    this.timer.unref?.();
    if (this.config.balanceNotifications) {
      this.balanceNotifier = new BalanceNotifier({ store: this.store, api: this.api, clients: this.clients,
        botId: this.config.bots[0]?.botId, recipient: this.config.notifyUserId,
        isConnected: botId => this.connected.has(botId), now: this.balanceNow, log: this.log }).start();
    }
    this.retryTimer = setInterval(() => this.pump(), 1000); this.retryTimer.unref?.();
    await this.enableFirmwareNotifications();
    this.firmwareCapabilityTimer = setInterval(() => { void this.enableFirmwareNotifications(); }, 15000); this.firmwareCapabilityTimer.unref?.();
  }
  async enableFirmwareNotifications() {
    if (this.closing || (this.firmwareNotifier && (this.syncNotifier || !this.config.notifyUserId)) || this.firmwareChecking) return;
    this.firmwareChecking = true;
    try {
      const status = await this.api.json('/status', 'GET', undefined, AbortSignal.timeout(3000));
      if (!this.closing && status.syncNotificationsSupported && !this.syncNotifier) this.syncNotifier = new SyncNotifier({ store: this.store, api: this.api, clients: this.clients,
        botId: this.config.bots[0]?.botId, recipient: this.config.notifyUserId, isConnected: id => this.connected.has(id), log: this.log }).start();
      if (!this.closing && status.firmwareSupported && !this.firmwareNotifier) this.firmwareNotifier = new FirmwareNotifier({ store: this.store, api: this.api, clients: this.clients, isConnected: id => this.connected.has(id), scope: key => this.scope(key), log: this.log }).start();
    } catch { /* Backend upgrades must not disable chat or lose queued firmware notices. */ }
    finally { this.firmwareChecking = false; }
  }
  authenticated(botId) { this.connected.add(botId); this.pump(); this.observer?.pump(); this.balanceNotifier?.pump(); this.firmwareNotifier?.pump(); this.syncNotifier?.pump(); }
  disconnected(botId) { this.connected.delete(botId); }
  client(botId) { const client = this.clients.get(botId); if (!client) throw new Error('机器人配置不存在。'); return client; }
  async send(job, text) {
    for (const content of splitUtf8(text)) await this.client(job.botId).sendMessage(job.target, { msgtype: 'markdown', markdown: { content } });
  }
  async receive(botId, frame) {
    const operation = this.accept(botId, frame);
    this.receiving.add(operation);
    try { await operation; } finally { this.receiving.delete(operation); }
  }
  async accept(botId, frame) {
    if (this.closing) return;
    const who = identity(botId, frame.body);
    const previous = this.store.data.jobs.find(job => job.botId === botId && job.msgid === who.msgid);
    if (previous) return; // Persist before processing, including same-process duplicate callbacks.
    const notice = notificationInput(frame.body);
    void this.observer?.enqueue(who, notice).catch(error => this.log.warn('WeCom observer:', this.safeError(error)));
    const scope = this.scope(who.key);
    const control = commandInput(frame.body, scope, who.userId, this.config.bots.find(bot => bot.botId === botId)?.name);
    if (control) {
      const job = { ...who, id: randomUUID(), created: Date.now(), frame: { headers: frame.headers }, streamId: randomUUID(), state: 'command', control, generation: scope.generation, sentParts: 0, sentFiles: [] };
      if (control.kind === 'firmware' && (!scope.firmwareUser || scope.firmwareUser === who.userId || scope.firmwareUntil <= Date.now())) {
        scope.firmwareUser = who.userId; scope.firmwareUntil = Date.now() + 5 * 60000;
        if (scope.awaitingUser === who.userId) { delete scope.awaitingUser; delete scope.awaitingMode; }
      } else if (['reset', 'open', 'openFiles'].includes(control.kind) && scope.firmwareUser === who.userId) {
        delete scope.firmwareUser; delete scope.firmwareFlow; delete scope.firmwareUntil;
      }
      if (control.kind === 'reset') {
        job.oldSessionIds = [...new Set([this.store.data.conversations[who.key]?.sessionId, ...this.store.data.jobs.filter(old => old.key === who.key && live(old)).flatMap(old => [old.sessionId, ...(old.oldSessionIds ?? []), old.newSessionId])].filter(Boolean))];
        job.cancelledJobIds = this.store.data.jobs.filter(old => old.key === who.key && live(old)).map(old => old.id);
        scope.generation++; job.generation = scope.generation;
        delete scope.awaitingUser; delete scope.awaitingMode; delete this.store.data.conversations[who.key];
        for (const old of this.store.data.jobs) if (old.key === who.key && live(old)) {
          old.state = 'done'; old.finished = Date.now();
          this.jobControllers.get(old.id)?.abort();
        }
      } else if (!['notice', 'welcome', 'balance', 'firmware'].includes(control.kind)) {
        if (['open', 'openFiles'].includes(control.kind)) {
          scope.awaitingUser = who.userId;
          scope.awaitingMode = control.kind === 'openFiles' ? 'files' : 'role';
        } else { delete scope.awaitingUser; delete scope.awaitingMode; }
        // Input completion, cancellation and mode switches supersede stale previews.
        for (const old of this.store.data.jobs) if (old.key === who.key && live(old) && ['open', 'openFiles', 'notice'].includes(old.control?.kind)) {
          old.state = 'done'; old.finished = Date.now(); this.jobControllers.get(old.id)?.abort();
        }
      }
      this.store.data.jobs.push(job); await this.store.save(); this.pump(); return;
    }
    let input;
    try { input = inbound(frame.body); } catch (error) { await this.send(who, error.message); return; }
    if (this.store.data.jobs.filter(live).length >= this.config.queueLimit + this.config.concurrency) { await this.send(who, '当前排队人数较多，请稍后再发送。'); return; }
    const job = { ...who, id: randomUUID(), created: Date.now(), frame: { headers: frame.headers }, streamId: randomUUID(), state: 'receiving', generation: scope.generation, text: input.text, staged: [], attachmentIds: [], sentParts: 0, sentFiles: [] };
    this.store.data.jobs.push(job); await this.store.save();
    const client = this.client(botId);
    // This acknowledgement is best-effort; durable result delivery below is retried.
    if (this.isCurrent(job)) this.trackProgress(job, client.replyStream(job.frame, job.streamId, 'AI Thinking...', false).catch(() => {}));
    try {
      if (input.media.length) {
        const stage = async () => {
          this.assertCurrent(job); if (this.closing) throw new Error('服务正在停止，请重新发送附件。');
          const controller = new AbortController(); this.controllers.add(controller); this.jobControllers.set(job.id, controller);
          try {
            const status = await this.api.json('/status', 'GET', undefined, controller.signal);
            if (!status.fileTools.enabled || !status.fileTools.tools.length) throw new Error('文件工具已关闭，请管理员在 Web 的 Agent 设置中启用。');
            const maxBytes = Math.min(this.config.maxFileBytes, status.fileTools.maxFileBytes);
            const directory = this.store.jobDirectory(job.id); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            let total = 0;
            for (const [index, media] of input.media.entries()) {
              this.assertCurrent(job); if (this.closing) throw new Error('服务正在停止，请重新发送附件。');
              if (Date.now() - job.created > 4 * 60000) throw new Error('附件接收排队过久，下载链接可能已过期，请重新上传。');
              const { buffer, name } = await this.download(media, maxBytes, index + 1, controller.signal);
              this.assertCurrent(job);
              total += buffer.length;
              if (buffer.length > maxBytes || total > 60 * 1024 * 1024) throw new Error('单文件超过限制，或本条消息附件总量超过 60 MiB。');
              await fs.writeFile(path.join(directory, `${index}`), buffer, { mode: 0o600, flag: 'wx' });
              job.staged.push({ name, index, bytes: buffer.length });
            }
          } finally { this.controllers.delete(controller); this.jobControllers.delete(job.id); }
        };
        const pending = this.mediaTail.then(stage); this.mediaTail = pending.catch(() => {}); await pending;
      }
      this.assertCurrent(job); job.state = 'queued'; await this.store.save();
    } catch (error) {
      if (!this.isCurrent(job)) { await fs.rm(this.store.jobDirectory(job.id), { recursive: true, force: true }); return; }
      job.result = { text: this.safeError(error), files: [] }; job.state = 'delivering'; await this.store.save();
    }
    const names = input.media.map((media, index) => job.staged[index]?.name ?? (media.kind === 'image' ? '图片' : '文件'));
    if (names.length) void this.observer?.attachments(botId, who.msgid, names).catch(error => this.log.warn('WeCom attachment notice:', this.safeError(error)));
    this.pump();
  }
  pump() {
    if (this.closing) return;
    const controls = new Map();
    for (const job of this.store.data.jobs) if (job.control && live(job) && !controls.has(job.key)) controls.set(job.key, job);
    for (const job of controls.values()) {
      if (this.controlActive.size >= 8) break;
      if (this.controlActive.has(job.key) || !this.connected.has(job.botId) || (job.retryAt ?? 0) > Date.now()) continue;
      const task = processControl(this, job).catch(error => this.log.error('WeCom command:', this.safeError(error))).finally(() => { this.controlActive.delete(job.key); this.pump(); });
      this.controlActive.set(job.key, task);
    }
    const heads = new Map();
    for (const job of this.store.data.jobs) if (live(job) && !job.control && !controls.has(job.key) && !heads.has(job.key)) heads.set(job.key, job);
    for (const job of heads.values()) {
      if (this.active.size >= this.config.concurrency) break;
      if (this.active.has(job.key) || job.state === 'receiving' || !this.connected.has(job.botId) || (job.retryAt ?? 0) > Date.now()) continue;
      const task = this.process(job).catch(error => { job.retryAt = Date.now() + 15000; this.log.error('WeCom job:', this.safeError(error)); }).finally(() => { this.active.delete(job.key); this.pump(); });
      this.active.set(job.key, task);
    }
  }
  async conversation(job, signal) {
    this.assertCurrent(job);
    let conversation = this.store.data.conversations[job.key];
    if (conversation) {
      try { await this.api.json(`/sessions/${conversation.sessionId}`, 'GET', undefined, signal); }
      catch (error) { this.assertCurrent(job); if (error.status !== 404) throw error; delete this.store.data.conversations[job.key]; conversation = undefined; }
    }
    if (!conversation) {
      const { id } = await this.api.json('/sessions', 'POST', {}, signal);
      await this.api.json(`/sessions/${id}`, 'PATCH', { title: `企微 · ${job.key.includes('"group"') ? `群 ${job.target}` : job.userId}`.slice(0,80) }, signal);
      this.assertCurrent(job);
      conversation = this.store.data.conversations[job.key] = { sessionId: id, updated: Date.now(), pending: {} };
    }
    this.assertCurrent(job);
    conversation.updated = Date.now(); job.sessionId = conversation.sessionId; await this.store.save(); return conversation;
  }
  async process(job) {
    const controller = new AbortController(); this.controllers.add(controller); this.jobControllers.set(job.id, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    try {
      this.assertCurrent(job);
      if (job.state === 'delivering') { await this.deliver(job, signal); return; }
      if (job.state === 'recovering') { await this.recover(job, signal); return; }
      const conversation = await this.conversation(job, signal);
      this.assertCurrent(job);
      const id = conversation.sessionId;
      // A file-only message waits for its sender's instruction, including in shared groups.
      // This prevents another group member's next question from consuming pending uploads.
      for (const staged of job.staged ?? []) {
        if (staged.fileId) continue;
        const buffer = await fs.readFile(path.join(this.store.jobDirectory(job.id), String(staged.index)));
        const file = await this.api.upload(id, staged.name, buffer, signal);
        this.assertCurrent(job);
        staged.fileId = file.id; job.attachmentIds.push(file.id); await this.store.save();
      }
      if (!job.text) {
        const prior = conversation.pending[job.userId];
        const pending = prior?.expires > Date.now() ? prior.files : [];
        const files = [...pending, ...job.staged.map(file => ({ id: file.fileId, name: file.name }))];
        if (files.length > 20) throw new Error('待处理附件超过 20 个，请先发送处理要求，或新建对话后重传。');
        conversation.pending[job.userId] = { expires: Date.now() + 30 * 60000, files };
        job.result = { text: `已收到：${job.staged.map(file => file.name).join('、')}。\n请在 30 分钟内继续发送处理要求，例如“按 i9200 资料填写刚才的标书”。`, files: [] };
      } else {
        const pending = conversation.pending[job.userId];
        if (pending?.expires > Date.now()) {
          if (job.attachmentIds.length && pending.files.length) throw new Error('还有此前未处理的附件，请先说明其处理要求，或发送“新建对话”后重新上传本次文件。');
          const named = pending.files.filter(file => job.text.includes(file.name));
          const chosen = named.length ? named : pending.files;
          if (chosen.length > 1 && !named.length && !/全部附件|所有附件/.test(job.text)) throw new Error(`有多份待处理附件：${chosen.map(file => file.name).join('、')}。请明确文件名，或说明“处理全部附件”。`);
          const selected = /全部附件|所有附件/.test(job.text) ? pending.files : chosen;
          job.attachmentIds.push(...selected.map(file => file.id));
          pending.files = pending.files.filter(file => !selected.some(item => item.id === file.id));
          if (!pending.files.length) delete conversation.pending[job.userId];
        }
        this.assertCurrent(job); job.state = 'running'; await this.store.save();
        let lastProgress = 0; let partial = ''; const outputs = [];
        const done = await this.api.run(id, job.text, [...new Set(job.attachmentIds)], async (event, value) => {
          this.assertCurrent(job);
          if (event === 'start') { job.runId = value.run.id; await this.store.save(); }
          if (event === 'output') { outputs.push(value.file); job.outputs = outputs; await this.store.save(); }
          if (event === 'error') job.runError = value.message;
          if (event === 'text') partial += value.delta;
          if (event === 'text' && Date.now() - lastProgress > 2500) {
            lastProgress = Date.now();
            const preview = splitUtf8(partial)[0] || 'AI Thinking...';
            // Non-blocking SDK path avoids a slow WeCom connection holding Agent SSE open.
            const progress = this.client(job.botId).replyStreamNonBlocking?.(job.frame, job.streamId, preview, false).catch(() => {});
            this.trackProgress(job, progress);
          }
        }, signal, { botId: job.botId, userId: job.userId, chatType: JSON.parse(job.key)[1], ...(JSON.parse(job.key)[1] === 'group' ? { chatId: job.target } : {}), at: job.created });
        this.assertCurrent(job);
        job.result = resultFromDone(done, job.runId, outputs);
        if (done.failed && job.runError) job.result.text += `\n\n本轮未完整完成：${job.runError}`;
      }
      this.assertCurrent(job); job.state = 'delivering'; await this.store.save(); await this.deliver(job, signal);
    } catch (error) {
      if (!this.isCurrent(job) || this.closing) return; // Keep the durable running state; never replay unknown side effects.
      if (job.state === 'delivering') { job.retryAt = Date.now() + 15000; await this.store.save(); this.log.warn('WeCom delivery deferred:', this.safeError(error)); }
      else if (job.state === 'running' && !job.runId && [409, 429, 503].includes(error.status)) { job.state = 'queued'; job.retryAt = Date.now() + 3000; await this.store.save(); }
      else if (job.state === 'running' || job.state === 'recovering') {
        // Preserve unknown run outcomes; never replay a possibly accepted run.
        // Notify once while the backend is down, then retain normal recovery.
        if (error instanceof AgentUnavailableError && !job.upgradeNotified) {
          try { await this.client(job.botId).replyStream(job.frame, job.streamId, AGENT_UNAVAILABLE_MESSAGE, false); }
          catch { await this.send(job, AGENT_UNAVAILABLE_MESSAGE); }
          job.upgradeNotified = true;
        }
        job.state = 'recovering'; job.retryAt = Date.now() + 5000; await this.store.save();
      } else if ([409, 429, 503].includes(error.status)) { job.retryAt = Date.now() + 3000; await this.store.save(); }
      else { job.result = { text: this.safeError(error), files: [] }; job.state = 'delivering'; await this.store.save(); }
    } finally {
      await Promise.allSettled([...(this.progress.get(job.id) ?? [])]); this.progress.delete(job.id);
      this.controllers.delete(controller); this.jobControllers.delete(job.id);
    }
  }
  async recover(job, signal) {
    if (!job.sessionId) { job.result = { text: '服务中断，未能确认上次执行结果，请重新发送问题。', files: [] }; job.state = 'delivering'; await this.store.save(); await this.deliver(job, signal); return; }
    let snapshot;
    try { snapshot = await this.api.json(`/sessions/${job.sessionId}`, 'GET', undefined, signal); }
    catch (error) { if (error.status !== 404) throw error; snapshot = { running: false, messages: [] }; }
    this.assertCurrent(job);
    if (snapshot.running) { job.retryAt = Date.now() + 5000; await this.store.save(); return; }
    const run = (snapshot.runs ?? []).find(item => item.id === job.runId);
    job.result = run ? resultFromDone({ ...snapshot, failed: run.status !== 'completed' }, job.runId, job.outputs ?? []) : { text: '上次运行连接中断，无法确认执行结果。为避免重复写记忆或重复填表，没有自动重跑；请查看 Web 记录后重新提问。', files: job.outputs ?? [] };
    if (run && run.status !== 'completed') job.result.text += '\n\n上次运行未完整完成，已生成的文件仍会尝试发送。';
    job.state = 'delivering'; await this.store.save(); await this.deliver(job, signal);
  }
  async deliver(job, signal) {
    this.assertCurrent(job); signal.throwIfAborted();
    const chunks = splitUtf8(job.result.text);
    for (let index = job.sentParts ?? 0; index < chunks.length; index++) {
      this.assertCurrent(job); signal.throwIfAborted();
      if (!index) {
        try { await this.client(job.botId).replyStream(job.frame, job.streamId, chunks[index], true); }
        catch { this.assertCurrent(job); signal.throwIfAborted(); await this.send(job, chunks[index]); }
      } else await this.send(job, chunks[index]);
      job.sentParts = index + 1; await this.store.save();
    }
    for (const file of job.result.files) {
      if (job.sentFiles.includes(file.id)) continue;
      let buffer;
      try { buffer = await this.api.download(job.sessionId, file, signal); }
      catch (error) {
        if (error.status !== 404) throw error;
        await this.send(job, `文件“${file.name}”已随会话删除或过期，无法发送。`); job.sentFiles.push(file.id); await this.store.save(); continue;
      }
      this.assertCurrent(job); signal.throwIfAborted();
      const type = /\.(png|jpe?g|webp)$/i.test(file.name) ? 'image' : 'file';
      const uploaded = await this.client(job.botId).uploadMedia(buffer, { type, filename: file.name });
      this.assertCurrent(job); signal.throwIfAborted();
      if (!uploaded.media_id) throw new Error('企微未返回文件 media_id。');
      try { await this.client(job.botId).replyMedia(job.frame, type, uploaded.media_id); }
      catch { this.assertCurrent(job); signal.throwIfAborted(); await this.client(job.botId).sendMediaMessage(job.target, type, uploaded.media_id); }
      job.sentFiles.push(file.id); await this.store.save();
    }
    job.state = 'done'; job.finished = Date.now();
    for (const key of ['text', 'staged', 'attachmentIds', 'result', 'outputs', 'runError', 'upgradeNotified', 'control']) delete job[key];
    await this.store.save(); await fs.rm(this.store.jobDirectory(job.id), { recursive: true, force: true });
  }
  safeError(error) {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [this.config.token, ...this.config.bots.map(bot => bot.secret)]) if (secret) message = message.split(secret).join('[REDACTED]');
    return message.slice(0, 1500);
  }
  async maintenance() {
    const now = Date.now();
    for (const [key, conversation] of Object.entries(this.store.data.conversations)) {
      for (const [user, pending] of Object.entries(conversation.pending ?? {})) if (pending.expires <= now) delete conversation.pending[user];
      if (conversation.updated < now - 30 * DAY && !this.store.data.jobs.some(job => job.key === key && live(job))) delete this.store.data.conversations[key];
    }
    for (const job of this.store.data.jobs) {
      if (live(job) && job.created < now - 30 * DAY && !this.active.has(job.key)) { job.state = 'done'; delete job.result; delete job.text; delete job.outputs; }
      if (job.state === 'done' && !this.receiving.size) await fs.rm(this.store.jobDirectory(job.id), { recursive: true, force: true });
    }
    const completed = new Set(this.store.data.jobs.filter(job => !live(job) && (job.finished ?? job.created) >= now - 7 * DAY).slice(-10000).map(job => job.id));
    this.store.data.jobs = this.store.data.jobs.filter(job => live(job) || completed.has(job.id));
    await this.store.save();
  }
  async idle(timeout = 10000) {
    const until = Date.now() + timeout;
    while (this.active.size || this.controlActive.size || this.receiving.size || this.store.data.jobs.some(job => live(job) && !job.retryAt && (job.control || !this.store.data.jobs.some(control => control.control && live(control) && control.key === job.key)))) { if (Date.now() > until) throw new Error('Bridge idle timeout'); await pause(10); }
  }
  close() {
    return this.closePromise ??= this.shutdown();
  }
  async shutdown() {
    this.closing = true; clearInterval(this.timer); clearInterval(this.retryTimer); clearInterval(this.firmwareCapabilityTimer);
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.active.values(), ...this.controlActive.values(), ...this.receiving, this.balanceNotifier?.close(), this.firmwareNotifier?.close(), this.syncNotifier?.close()]);
    for (const client of this.clients.values()) client.disconnect();
    await this.observer?.close();
    await this.store.save(); await this.store.close();
  }
}
