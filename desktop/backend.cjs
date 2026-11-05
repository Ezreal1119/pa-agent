const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class ClientError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function runId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) throw new ClientError(400, '任务编号无效。');
  return id;
}
class BackendClient {
  #token;
  #downloads = new Set();
  constructor(baseUrl, options = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid backend URL');
    this.baseUrl = url.origin;
    // Internal/test options only; never exposed to the renderer or user settings.
    this.timeouts = { request: 60000, idle: 60000, total: 30 * 60000, ...options.timeouts };
    for (const value of Object.values(this.timeouts)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid timeout');
  }
  /** 只读令牌：录入窗口需要它把自己的请求认证成「已登录的客户端账号」。 */
  get token() { return this.#token; }
  async request(route, data, timeout = this.timeouts.request, binary = false, options = {}) {
    if (route !== '/login' && !this.#token) throw new ClientError(401, '请先登录。');
    let response;
    try {
      response = await fetch(this.baseUrl + '/api/client' + route, {
        method: options.method ?? (data === undefined ? 'GET' : 'POST'), redirect: 'error', signal: options.signal ?? AbortSignal.timeout(timeout),
        headers: { 'X-CKD-Partial-Results': '1', ...(this.#token ? { Authorization: 'Bearer ' + this.#token } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
        body: data === undefined ? undefined : JSON.stringify(data)
      });
      if (response.status === 401) this.#token = undefined;
      if (response.ok && binary) return response;
      if (options.method === 'HEAD') throw new ClientError(response.status, response.status === 401 ? '登录已失效，请重新登录。' : response.status === 405 ? '服务端尚未支持新版下载，请先更新服务器。' : '文件信息读取失败，请重试。');
      if (!response.headers.get('content-type')?.includes('application/json')) throw new ClientError(response.ok ? 502 : response.status, '服务返回了无效响应，请稍后重试。');
      const value = await response.json();
      if (!response.ok) throw new ClientError(response.status, value.error || '操作失败，请重试。');
      return value;
    } catch (error) {
      if (error instanceof ClientError) throw error;
      if (options.signal?.aborted && options.signal.reason instanceof ClientError) throw options.signal.reason;
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new ClientError('timeout', '请求超时，请重试；服务器不一定离线。');
      if (error instanceof SyntaxError) throw new ClientError('response', '服务响应不完整或格式无效，请重试。');
      throw new ClientError('offline', '无法连接服务，请检查网络后重试。');
    }
  }
  async login(input) {
    this.cancelDownloads();
    this.#token = undefined;
    const value = await this.request('/login', input);
    if (typeof value.token !== 'string') throw new ClientError('offline', '服务返回无效登录结果。');
    this.#token = value.token;
    return { account: value.account, expiresAt: value.expiresAt };
  }
  cancelDownloads() { for (const controller of this.#downloads) controller.abort(new ClientError('download_cancelled', '下载已取消，请重新保存。')); }
  async logout() { this.cancelDownloads(); try { if (this.#token) await this.request('/logout', {}); } finally { this.#token = undefined; } return { ok: true }; }
  status() { return this.request('/status'); }
  list() { return this.request('/runs'); }
  deleted() { return this.request('/trash'); }
  trash(id) { return this.request('/runs/'+runId(id)+'/trash',{}); }
  restore(id) { return this.request('/runs/'+runId(id)+'/restore',{}); }
  get(id) { return this.request('/runs/' + runId(id)); }
  start(input) { return this.request('/runs', input, this.timeouts.request, false, { headers: { 'X-CKD-Image-Review': '1' } }); }
  answer(id, questionId, text) { return this.request('/runs/' + runId(id) + '/answer', { questionId, text }); }
  generate(id, reviewId, revision) { return this.request('/runs/' + runId(id) + '/generate', { reviewId, revision }); }
  crop(id, imageId, reviewId, revision, rect) {
    if (typeof imageId !== 'string' || !/^[0-9a-f-]{36}$/u.test(imageId)) throw new ClientError(400, '图片编号无效。');
    return this.request('/runs/' + runId(id) + '/images/' + imageId, { reviewId, revision, rect });
  }
  async image(id, imageId, original = false) {
    if (typeof imageId !== 'string' || !/^[0-9a-f-]{36}$/u.test(imageId) || typeof original !== 'boolean') throw new ClientError(400, '图片请求无效。');
    const response = await this.request('/runs/' + runId(id) + '/images/' + imageId + (original ? '?original=true' : ''), undefined, this.timeouts.request, true);
    if (response.headers.get('content-type') !== 'image/png' || Number(response.headers.get('content-length')) > 10 * 1024 * 1024) throw new ClientError(400, '图片响应无效。');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new ClientError(400, '图片过大。'); chunks.push(Buffer.from(chunk)); }
    return { dataUrl: 'data:image/png;base64,' + Buffer.concat(chunks).toString('base64') };
  }
  resume(id) { return this.request('/runs/' + runId(id) + '/resume', {}); }
  cancel(id) { return this.request('/runs/' + runId(id) + '/cancel', {}); }
  async artifact(id, index) {
    runId(id);
    if (!Number.isSafeInteger(index) || index < 0) throw new ClientError(400, '文件编号无效。');
    const route = '/runs/' + id + '/artifacts/' + index;
    const response = await this.request(route, undefined, this.timeouts.request, true, { method: 'HEAD' });
    const disposition = response.headers.get('content-disposition') ?? '';
    let name;
    try {
      const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition);
      name = encoded ? decodeURIComponent(encoded[1]) : /filename="([^"]+)"/u.exec(disposition)?.[1];
    } catch { /* Invalid header is rejected below. */ }
    if (!name || !/\.(xlsx|json)$/iu.test(name)) throw new ClientError(502, '服务返回了无效文件信息。');
    return { name: path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_'), route };
  }
  async saveArtifact(id, index, destination, options = {}) {
    const expectedRoute = '/runs/' + runId(id) + '/artifacts/' + index;
    if (!Number.isSafeInteger(index) || index < 0) throw new ClientError(400, '文件编号无效。');
    const file = options.file ?? await this.artifact(id, index);
    if (file.route !== expectedRoute || !/\.(xlsx|json)$/iu.test(file.name)) throw new ClientError(400, '文件信息无效。');
    if (!this.#token) throw new ClientError(401, '请先登录。');
    const controller = new AbortController(); this.#downloads.add(controller);
    const abort = (code, message) => controller.abort(new ClientError(code, message));
    let idleTimer;
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => abort('download_timeout', '下载连续 60 秒没有收到数据，请检查网络后重试。'), this.timeouts.idle); };
    const totalTimer = setTimeout(() => abort('download_timeout', '下载超过最长等待时间（30 分钟），请重试。'), this.timeouts.total);
    const temporary = destination + '.' + randomUUID() + '.partial';
    let received = 0, total = null, lastProgress = 0;
    const progress = (state, force = false) => {
      if (!options.onProgress || (!force && Date.now() - lastProgress < 250)) return;
      lastProgress = Date.now();
      // A closed UI or a failing observer must not corrupt a completed download.
      try { options.onProgress({ received, total, state }); } catch {}
    };
    resetIdle();
    try {
      progress('downloading', true);
      const response = await this.request(file.route, undefined, this.timeouts.total, true, { signal: controller.signal });
      resetIdle();
      const contentType = response.headers.get('content-type')?.split(';')[0];
      const isJson = /\.json$/iu.test(file.name);
      if (contentType !== (isJson ? 'application/json' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
        throw new ClientError('download_invalid', '服务返回了无效文件。');
      }
      const expected = response.headers.get('content-length');
      if (expected !== null && (!/^\d+$/u.test(expected) || !Number.isSafeInteger(Number(expected)))) throw new ClientError('download_invalid', '文件大小信息无效。');
      total = expected === null ? null : Number(expected);
      progress('downloading', true);
      if (!response.body) throw new ClientError('download_incomplete', '下载文件为空，请重试。');
      const meter = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; resetIdle(); progress('downloading'); callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temporary, { flags: 'wx' }), { signal: controller.signal });
      clearTimeout(idleTimer);
      progress('validating', true);
      const stat = await fsp.stat(temporary);
      if (!stat.size || (total !== null && total !== stat.size)) throw new ClientError('download_incomplete', '文件未下载完整，请重试。');
      if (isJson) {
        try { JSON.parse(await fsp.readFile(temporary, 'utf8')); }
        catch { throw new ClientError('download_invalid', '下载的报告格式无效，请重试。'); }
      } else {
        const descriptor = await fsp.open(temporary, 'r');
        try { const signature = Buffer.alloc(4); await descriptor.read(signature, 0, 4, 0); if (!signature.equals(Buffer.from([0x50,0x4b,3,4]))) throw new ClientError('download_invalid', '下载的 Excel 格式无效，请重试。'); }
        finally { await descriptor.close(); }
      }
      controller.signal.throwIfAborted();
      await fsp.rename(temporary, destination);
      progress('completed', true);
      return { name: file.name, path: destination };
    } catch (error) {
      await fsp.rm(temporary, { force: true });
      if (controller.signal.aborted && controller.signal.reason instanceof ClientError) throw controller.signal.reason;
      if (error instanceof ClientError) throw error;
      if (['EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EISDIR'].includes(error.code)) throw new ClientError('download_save', error.code === 'ENOSPC' ? '保存失败：磁盘空间不足。' : '无法保存文件，请选择有写入权限的有效位置。');
      throw new ClientError('download_interrupted', '文件传输中断，未保存不完整文件，请重新下载。');
    } finally {
      clearTimeout(idleTimer); clearTimeout(totalTimer); this.#downloads.delete(controller);
      controller.abort();
    }
  }
}
module.exports = { BackendClient, ClientError, runId };
