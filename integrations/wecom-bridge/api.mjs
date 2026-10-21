export const AGENT_UNAVAILABLE_MESSAGE = '服务正在升级中，请稍后尝试。';
export class AgentUnavailableError extends Error {
  constructor(cause) { super(AGENT_UNAVAILABLE_MESSAGE, { cause }); this.name = 'AgentUnavailableError'; }
}

export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** Keep requests on loopback; a credential cannot be redirected to another host. */
export class AgentApi {
  constructor(baseUrl, token, timeoutMs = 15 * 60000) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('WECOM_AGENT_URL 必须是本机 HTTP 根地址。');
    if (!token || token.length < 32) throw new Error('请配置至少 32 字符的 WECOM_API_TOKEN。');
    this.base = url.origin; this.token = token; this.timeoutMs = timeoutMs;
  }
  async request(route, init = {}, signal) {
    let response;
    try {
      response = await fetch(`${this.base}/api/wecom${route}`, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]), headers: { Authorization: `Bearer ${this.token}`, ...init.headers } });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AgentUnavailableError(error);
    }
    if ([502, 503, 504].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new AgentUnavailableError(new Error(`Agent HTTP ${response.status}`));
    }
    if (!response.ok) {
      let message; try { message = (await response.json()).error; } catch {}
      throw new ApiError(response.status, message || `Agent HTTP ${response.status}`);
    }
    return response;
  }
  async json(route, method = 'GET', body, signal) {
    return (await this.request(route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }, signal)).json();
  }
  async upload(sessionId, filename, data, signal) {
    return (await (await this.request(`/sessions/${sessionId}/files?name=${encodeURIComponent(filename)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data }, signal)).json()).file;
  }
  async download(sessionId, file, signal) {
    const response = await this.request(`/sessions/${sessionId}/files/${file.id}`, {}, signal);
    return readBounded(response, Math.min(file.bytes ?? 30 * 1024 * 1024, 30 * 1024 * 1024));
  }
  async run(sessionId, text, attachmentIds, onEvent, signal, wecomSender) {
    const response = await this.request(`/sessions/${sessionId}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, attachmentIds, ...(wecomSender ? { wecomSender } : {}) }) }, signal);
    let done;
    for await (const frame of sse(response.body)) { await onEvent(frame.event, frame.data); if (frame.event === 'done') done = frame.data; }
    if (!done) throw new Error('Agent 连接中断，未收到运行结束事件；不会自动重复执行。');
    return done;
  }
}
export async function readBounded(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('文件超过大小限制。'); }
  const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('文件超过大小限制。'); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
export async function* sse(body) {
  const decoder = new TextDecoder(); let buffer = '';
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    buffer = buffer.replaceAll('\r\n', '\n');
    if (buffer.length > 16 * 1024 * 1024) throw new Error('Agent 事件过大。');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      const event = frame.match(/^event:\s*(.+)$/m)?.[1];
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}
