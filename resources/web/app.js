'use strict';
const $ = id => document.getElementById(id);
const state = { token: '', status: null, current: null, busy: false, rounds: 0, activities: [], toastTimer: null, cancelBeforeRun: false, effort: 'low', run: null, clock: null, clockStart: 0, files: [], pendingIds: [] };
const dialog = $('settings-dialog');
const sessionDialog = $('session-dialog');
let sessionAction = null;
const effortLabels = { off: '快速', low: '标准', high: '深入', max: '深度研究', 'provider-default': '模型默认' };
const statusLabels = { running: '执行中', completed: '完成', failed: '失败', stopped: '已停止', interrupted: '已中断' };
const duration = ms => typeof ms === 'number' && Number.isFinite(ms) ? (ms < 60000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60000)} 分 ${((ms % 60000) / 1000).toFixed(1)} 秒`) : '未知';
function refreshEffort() {
  $('global-effort-display').textContent = state.status?.reasoning?.supported ? `全局思考强度 · ${effortLabels[state.effort] || '标准'} ⚙` : '思考强度 · 模型默认 ⚙';
  $('global-effort-display').disabled = state.busy;
}
const fileToolOptions = [
  ['pdf_read', 'PDF 阅读', '读取 PDF 文字、表格及指定页面'],
  ['docx_read', 'Word 阅读', '读取 DOCX 正文、表格及内嵌图片'],
  ['pptx_read', 'PPT 阅读', '读取 PPTX 幻灯片、备注及文本'],
  ['excel_read', 'Excel 阅读', '读取 XLSX 工作簿、单元格和公式'],
  ['excel_patch_template', 'Excel 模板修改', '修改指定单元格并另存新文件'],
  ['image_read', '图片阅读', '通过视觉模型识别图片内容'],
];
function updateToolToggles() {
  for (const input of $('file-tool-toggles').querySelectorAll('input')) input.disabled = !$('file-tools-enabled').checked;
  $('file-tool-toggles').classList.toggle('inactive', !$('file-tools-enabled').checked);
}
function stopClock(run) {
  clearInterval(state.clock); state.clock = null; state.run = run || null;
  $('run-clock').classList.remove('running');
  $('run-clock').textContent = run ? `${statusLabels[run.status] || run.status} · ${duration(run.elapsedMs)}` : '等待运行';
  $('run-duration').textContent = run ? duration(run.elapsedMs) : '—';
  $('first-text-time').textContent = run?.firstTextMs != null ? duration(run.firstTextMs) : '—';
  $('tool-count').textContent = `${run?.toolCallCount ?? 0} 次`;
  if (run) $('applied-effort').textContent = effortLabels[run.effort] || run.effort;
}
function startClock(run) {
  clearInterval(state.clock); state.run = run || null;
  state.clockStart = performance.now() - (run ? Math.max(0, Date.now() - Date.parse(run.startedAt)) : 0);
  $('run-clock').classList.add('running');
  const tick = () => { const elapsed = duration(performance.now() - state.clockStart); $('run-clock').textContent = `执行中 · ${elapsed}`; $('run-duration').textContent = elapsed; };
  tick(); state.clock = setInterval(tick, 100);
}
function showRuns(runs = []) {
  $('run-history').replaceChildren();
  if (!runs.length) { const p = document.createElement('p'); p.textContent = '每轮强度与耗时将随会话保存。'; $('run-history').append(p); return; }
  for (const run of runs.slice(-5).reverse()) {
    const row = document.createElement('div'); row.className = `run-history-row ${run.status}`;
    const label = document.createElement('span'); label.textContent = `#${run.sequence} ${effortLabels[run.effort] || run.effort}`;
    const time = document.createElement('strong'); time.textContent = duration(run.elapsedMs);
    const status = document.createElement('small'); status.textContent = `${statusLabels[run.status] || run.status} · 工具 ${run.toolCallCount ?? 0} 次 · ${new Date(run.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    row.append(label, time, status); $('run-history').append(row);
  }
}
const bytes = value => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => $('toast').hidden = true, 4200); }
function note(message = '', error = false) { $('run-note').textContent = message; $('run-note').hidden = !message; $('run-note').classList.toggle('error', error); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), 'X-Local-Token': state.token, ...options.headers } });
  const data = await response.json();
  if (response.status === 401) { window.location.replace('/login'); throw new Error('登录已失效，请重新登录。'); }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
function setBusy(busy) {
  state.busy = busy; $('send').hidden = busy; $('stop').hidden = !busy; $('send').disabled = !state.status;
  $('question').disabled = busy; $('new-chat').disabled = busy;
  $('logout').disabled = busy; $('logout-top').disabled = busy;
  document.querySelectorAll('.session-button').forEach(button => button.disabled = busy); refreshEffort();
  document.querySelectorAll('.session-operation').forEach(button => button.disabled = busy || button.dataset.running === 'true');
  $('upload-file').disabled = busy;
  document.querySelectorAll('.remove-attachment').forEach(button => button.disabled = busy);
}
function updateRounds(rounds, actual) {
  state.rounds = rounds; const kept = actual ?? Math.min(rounds, 5);
  $('round-count').textContent = `上下文 ${kept} / 5 轮`;
  [...$('round-dots').children].forEach((dot, index) => dot.classList.toggle('filled', index < kept));
}
function resetContext() {
  $('request-count').textContent = '—'; $('payload-size').textContent = '—'; $('applied-effort').textContent = '—'; $('first-text-time').textContent = '—';
  $('tool-count').textContent = '0 次';
  $('injection-status').classList.remove('verified');
  $('injection-status').querySelector('strong').textContent = '等待本轮执行';
  $('injection-status').querySelector('small').textContent = '执行后检查实际请求中的注入份数';
  state.activities = []; renderActivity();
}
function showContext(context) {
  if (!context) return;
  const valid = context.skills?.length === 1 && context.skills.every(skill => skill.skillCopies === 1 && skill.memoryCopies === 1) && context.extraMemoryCopies === 1;
  $('injection-status').classList.toggle('verified', valid);
  $('injection-status').querySelector('strong').textContent = valid ? '本轮已注入 · 各一份' : '请检查本轮资源注入';
  $('injection-status').querySelector('small').textContent = valid ? '产品技能、产品记忆及额外记忆各一份；UMS 按需读取' : '当前请求中的技能或记忆份数不符合预期';
  $('request-count').textContent = `${context.requests} 次`;
  $('payload-size').textContent = bytes(context.payloadBytes);
  $('applied-effort').textContent = context.thinking === 'disabled' ? '快速 · 思考关闭' : context.effort ? `${effortLabels[context.effort] || context.effort} · ${context.effort}` : '模型默认';
  updateRounds(state.rounds, context.userRounds);
}
function renderActivity() {
  $('activity').replaceChildren();
  if (!state.activities.length) { const p = document.createElement('p'); p.textContent = '开始提问后，查看工具执行状态。'; $('activity').append(p); return; }
  const labels = { read: '读取资料', grep: '搜索内容', find: '查找文件', ls: '浏览目录', memory: '管理额外记忆', memory_add: '历史记忆新增', memory_edit: '历史记忆修改', memory_delete: '历史记忆删除', bash: '历史命令调用', edit: '历史编辑调用', write: '历史写入调用' };
  for (const item of state.activities.slice(-10)) {
    const row = document.createElement('div'); row.className = `activity-row ${item.state}`;
    row.append(document.createElement('span'));
    const text = document.createElement('div'); text.textContent = `${labels[item.name] || item.name} · ${{ running: '进行中', done: '完成', error: '失败' }[item.state] || item.state}`;
    row.append(text); $('activity').append(row);
  }
}
async function refreshStatus() {
  const status = await api('/api/status'); state.token = status.token; state.status = status;
  state.effort = status.reasoning?.default || 'low';
  $('attachment-area').hidden = !status.fileTools?.enabled || !status.fileTools.tools.length;
  $('file-support').textContent = status.fileTools?.enabled ? `PDF · Word · PPT · Excel · 图片 / 单文件 ≤ ${bytes(status.fileTools.maxFileBytes)}` : '';
  $('connection-text').textContent = status.configured ? '本地 · 已配置' : '本地 · 待配置';
  $('connection-dot').classList.toggle('ready', status.configured); $('config-banner').hidden = status.configured;
  $('model-name').textContent = status.model.modelId || '尚未配置';
  $('model-detail').textContent = status.model.baseUrl || '支持 OpenAI 兼容接口';
  $('extra-memory-ready').textContent = status.extraMemory?.ready ? (status.extraMemory.bytes ? bytes(status.extraMemory.bytes) : '空 · 可添加') : '无法读取';
  $('skill-cards').replaceChildren();
  $('default-skill-count').textContent = String(status.skills.length).padStart(2, '0');
  $('ordinary-skill-status').textContent = (status.ordinarySkills || []).map(skill => `${skill.name} · ${skill.ready ? '按需读取，无专属记忆' : '未部署（可选）'}`).join('；');
  for (const [index, skill] of status.skills.entries()) {
    const card = document.createElement('div'); card.className = 'skill-card';
    const header = document.createElement('div'); header.className = 'skill-header';
    const dot = document.createElement('i'); dot.className = `tag-dot ${index ? 'blue' : 'teal'}`;
    const name = document.createElement('span'); name.textContent = skill.name;
    const label = document.createElement('b'); label.textContent = skill.files.every(f => f.ready) ? '可读取' : '缺少文件';
    header.append(dot, name, label); card.append(header);
    for (const file of skill.files) {
      const row = document.createElement('div'); row.className = 'skill-file';
      const fileName = document.createElement('span'); fileName.textContent = file.file;
      const size = document.createElement('strong'); size.textContent = file.ready ? bytes(file.bytes) : '缺失 / 为空'; size.classList.toggle('missing', !file.ready);
      row.append(fileName, size); card.append(row);
    }
    $('skill-cards').append(card);
  }
  $('send').disabled = false; refreshEffort();
}
async function refreshSessions() {
  const { sessions } = await api('/api/sessions'); $('sessions').replaceChildren(); $('session-count').textContent = sessions.length;
  if (!sessions.length) { const p = document.createElement('p'); p.className = 'empty-sessions'; p.textContent = '你的产品探索，从这里开始。'; $('sessions').append(p); }
  for (const session of sessions) {
    const row = document.createElement('div'); row.className = `session-row${session.id === state.current ? ' active' : ''}`;
    const button = document.createElement('button'); button.className = `session-button${session.id === state.current ? ' active' : ''}`; button.disabled = state.busy;
    const title = document.createElement('strong'); title.textContent = session.title || '新对话';
    const time = document.createElement('small'); time.textContent = session.running ? '正在执行' : new Date(session.updated).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    button.append(title, time); button.addEventListener('click', () => openSession(session.id).then(() => setSidebar(false)).catch(error => toast(error.message)));
    const menu = document.createElement('details'); menu.className = 'session-menu';
    const summary = document.createElement('summary'); summary.textContent = '⋯'; summary.setAttribute('aria-label', `管理会话：${session.title || '新对话'}`);
    const actions = document.createElement('div'); actions.className = 'session-menu-actions';
    for (const [action, label] of [['rename', '重命名'], ['delete', '删除']]) {
      const control = document.createElement('button'); control.className = `session-operation ${action}`; control.textContent = label;
      control.disabled = state.busy || session.running; control.dataset.running = String(session.running);
      if (session.running) control.title = '请先停止或等待该会话执行结束';
      control.addEventListener('click', () => { menu.open = false; openSessionAction(action, session); }); actions.append(control);
    }
    menu.append(summary, actions); row.append(button, menu); $('sessions').append(row);
  }
}
function openSessionAction(action, session) {
  if (state.busy || session.running) return toast('请先停止或等待会话执行结束。');
  sessionAction = { action, id: session.id }; $('session-dialog-error').hidden = true;
  const deleting = action === 'delete';
  $('session-dialog-title').textContent = deleting ? '删除会话？' : '重命名会话';
  $('session-dialog-copy').textContent = deleting ? `将永久删除“${session.title || '新对话'}”的全部消息、工具调用、运行记录、上传附件和生成文件（含缓存与临时文件），无法恢复。` : '名称会随会话保存，刷新或重启后保留。';
  $('session-title-field').hidden = deleting; $('session-title-input').required = !deleting;
  $('session-title-input').value = session.title || '新对话';
  $('session-dialog-save').textContent = deleting ? '确认删除' : '保存名称';
  $('session-dialog-save').classList.toggle('danger-button', deleting);
  sessionDialog.showModal();
  if (!deleting) { $('session-title-input').focus(); $('session-title-input').select(); }
  else $('session-dialog-cancel').focus();
}
$('session-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!sessionAction) return;
  const action = sessionAction; $('session-dialog-save').disabled = true; $('session-dialog-error').hidden = true;
  $('session-dialog-close').disabled = true; $('session-dialog-cancel').disabled = true;
  try {
    const data = await api(`/api/sessions/${action.id}`, { method: action.action === 'delete' ? 'DELETE' : 'PATCH', ...(action.action === 'rename' ? { body: JSON.stringify({ title: $('session-title-input').value }) } : {}) });
    if (action.action === 'delete') { localStorage.removeItem(`product-expert-pending-${action.id}`); if (state.current === action.id) newChat(); toast('会话已删除'); }
    else { if (state.current === action.id) $('chat-title').textContent = data.title; toast('会话名称已保存'); }
    sessionDialog.close(); await refreshSessions();
  } catch (error) { $('session-dialog-error').textContent = error.message; $('session-dialog-error').hidden = false; }
  finally { $('session-dialog-save').disabled = false; $('session-dialog-close').disabled = false; $('session-dialog-cancel').disabled = false; }
});
for (const id of ['session-dialog-close', 'session-dialog-cancel']) $(id).addEventListener('click', () => sessionDialog.close());
sessionDialog.addEventListener('close', () => { sessionAction = null; });
sessionDialog.addEventListener('cancel', event => { if ($('session-dialog-save').disabled) event.preventDefault(); });
function markdown(element, text) {
  element.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), { FORBID_TAGS: ['img', 'iframe', 'style', 'form', 'input', 'button'] });
  for (const a of element.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
}
function toolDuration(ms) { return ms == null ? '耗时未记录' : ms < 1000 ? `${ms} 毫秒` : duration(ms); }
const toolStatusLabels = { running: '执行中', completed: '完成', failed: '失败', stopped: '已停止', interrupted: '已中断', 'not-executed': '未执行' };
function toolSection(parent, title, value) {
  const heading = document.createElement('h4'); heading.textContent = title;
  const pre = document.createElement('pre'); pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  parent.append(heading, pre);
}
function renderToolCalls(panel, data) {
  panel.replaceChildren();
  const heading = document.createElement('p'); heading.className = 'tool-list-heading'; heading.textContent = `本轮共 ${data.count} 次工具调用 · 按模型发起顺序排列`;
  panel.append(heading);
  if (!data.calls.length) { const empty = document.createElement('p'); empty.textContent = '本轮没有调用工具。'; panel.append(empty); return; }
  for (const call of data.calls) {
    const card = document.createElement('details'); card.className = `tool-call-card ${call.status}`;
    const summary = document.createElement('summary');
    const name = document.createElement('strong'); name.textContent = `#${call.sequence} ${call.name}`;
    const status = document.createElement('span'); status.className = 'tool-call-status'; status.textContent = toolStatusLabels[call.status] || call.status;
    const elapsed = document.createElement('span'); elapsed.className = 'tool-call-duration'; elapsed.textContent = toolDuration(call.elapsedMs);
    const preview = document.createElement('small');
    preview.textContent = JSON.stringify(call.arguments)?.replace(/\s+/g, ' ').slice(0, 150) || '无参数';
    summary.append(name, status, elapsed, preview); card.append(summary);
    const body = document.createElement('div'); body.className = 'tool-call-body';
    const info = document.createElement('p'); info.className = 'tool-call-meta';
    const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';
    const metrics = call.result?.details?.metrics;
    info.textContent = `调用 ID：${call.id}\n开始：${date(call.startedAt)}\n结束：${date(call.finishedAt)}` + (metrics ? `\n排队：${toolDuration(metrics.queueMs)} · 文件处理：${toolDuration(metrics.executionMs)} · 视觉请求：${metrics.visionCalls} 次 · ${metrics.workerPeakBytes ? '容器' : '进程'}峰值：${bytes(metrics.workerPeakBytes || metrics.peakRssKiB * 1024)}` : '');
    body.append(info); toolSection(body, '调用参数', call.arguments);
    if (call.result === null) toolSection(body, '返回结果', '未收到工具返回结果。');
    else {
      for (const content of call.result.content || []) {
        toolSection(body, call.result.isError ? '错误信息' : '返回结果', content.type === 'text' ? content.text : content);
      }
      if (call.result.details != null) toolSection(body, '结构化详情', call.result.details);
    }
    card.append(body); panel.append(card);
  }
}
function addMessage(role, text, timestamp = Date.now(), pending = false, run, toolRunId, toolCallCount = 0, attachments = [], outputs = [], outputNotice = '') {
  const row = document.createElement('article'); row.className = `message ${role}`;
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = role === 'user' ? '你' : 'p';
  const label = document.createElement('span'); label.textContent = role === 'user' ? '你' : 'Product Expert';
  const time = document.createElement('time'); time.textContent = new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  meta.append(avatar, label);
  if (run) { const badge = document.createElement('span'); badge.className = 'run-badge'; badge.textContent = `${effortLabels[run.effort] || run.effort} · ${statusLabels[run.status] || run.status} · ${duration(run.elapsedMs)}`; meta.append(badge); }
  meta.append(time);
  const body = document.createElement('div'); body.className = 'message-body';
  if (role === 'user') body.textContent = text;
  else if (pending) { const typing = document.createElement('div'); typing.className = 'typing'; typing.innerHTML = '<i></i><i></i><i></i>'; body.append(typing); }
  else markdown(body, text);
  row.append(meta, body);
  if (role === 'user' && attachments.length) {
    const list = document.createElement('div'); list.className = 'message-attachments';
    for (const file of attachments) list.append(fileCard(file));
    row.append(list);
  }
  if (role === 'assistant' && !pending) {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    const copy = document.createElement('button'); copy.className = 'copy-button'; copy.textContent = '复制回答'; copy.addEventListener('click', () => navigator.clipboard.writeText(text).then(() => toast('回答已复制')).catch(() => toast('无法复制，请手动选择文本。')));
    actions.append(copy);
    if (toolRunId) {
      const count = document.createElement('span'); count.className = 'tool-count-label'; count.textContent = `工具调用 ${toolCallCount} 次`;
      const toggle = document.createElement('button'); toggle.className = 'tools-button'; toggle.textContent = '查看工具调用'; toggle.setAttribute('aria-expanded', 'false');
      const panel = document.createElement('section'); panel.className = 'tool-calls-panel'; panel.hidden = true;
      panel.id = `tools-${crypto.randomUUID()}`; toggle.setAttribute('aria-controls', panel.id);
      const sessionId = state.current;
      toggle.addEventListener('click', async () => {
        panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); toggle.textContent = panel.hidden ? '查看工具调用' : '收起工具调用';
        if (panel.hidden || panel.dataset.loaded) return;
        toggle.disabled = true; panel.textContent = '正在读取本轮工具调用…';
        try {
          const data = await api(`/api/sessions/${sessionId}/runs/${toolRunId}/tools`);
          renderToolCalls(panel, data); panel.dataset.loaded = 'true';
        } catch (error) { panel.textContent = error.message; }
        finally { toggle.disabled = false; }
      });
      actions.append(count, toggle); row.append(actions, panel);
    } else row.append(actions);
  }
  if (role === 'assistant' && outputs.length) renderOutputCards(row, outputs, outputNotice);
  $('messages').append(row); $('welcome').hidden = true;
  return body;
}
function renderOutputCards(row, files, notice = '') {
  let section = row.querySelector('.run-outputs');
  if (!section) { section = document.createElement('section'); section.className = 'run-outputs'; section.setAttribute('aria-label', '本轮生成文件'); row.append(section); }
  section.replaceChildren();
  const heading = document.createElement('p'); heading.className = 'output-heading'; heading.textContent = '本轮生成文件'; section.append(heading);
  const list = document.createElement('div'); list.className = 'output-file-list';
  for (const file of files) {
    const card = fileCard(file);
    card.querySelector('small').textContent = `${file.name.split('.').at(-1).toUpperCase()} · ${bytes(file.bytes)} · 点击下载`;
    card.querySelector('a').setAttribute('aria-label', `下载生成文件 ${file.name}`);
    list.append(card);
  }
  section.append(list);
  if (notice) { const status = document.createElement('p'); status.className = 'output-notice'; status.textContent = notice; section.append(status); }
}
function renderMessages(messages) {
  $('messages').replaceChildren(); $('welcome').hidden = messages.length > 0;
  for (const message of messages) addMessage(message.role, message.text, message.timestamp, false, message.run, message.toolRunId, message.toolCallCount, message.attachments || [], message.outputs || [], message.outputNotice || '');
}
function scrollBottom() { const node = $('chat-scroll'); node.scrollTop = node.scrollHeight; }
async function openSession(id) {
  if (state.busy) return;
  if (!state.status?.configured) return note('请在 .env 配置模型连接参数，并重启服务。', true);
  const data = await api(`/api/sessions/${id}`);
  state.current = id; localStorage.setItem('product-expert-session', id); $('chat-title').textContent = data.title || '新对话';
  renderMessages(data.messages); updateRounds(data.rounds); resetContext(); showContext(data.context); showRuns(data.runs); note();
  restorePending(data); renderFiles(data.files || []);
  const latest = data.runs?.at(-1); if (data.running && latest?.status === 'running') startClock(latest); else stopClock(latest);
  $('tool-count').textContent = `${latest?.toolCallCount ?? 0} 次`;
  if (data.running) note('该会话正在另一个页面执行，请等待完成后重新打开。');
  await refreshSessions(); scrollBottom();
}
function newChat() {
  if (state.busy) return;
  state.current = null; localStorage.removeItem('product-expert-session'); $('chat-title').textContent = '新对话';
  renderMessages([]); updateRounds(0); resetContext(); showRuns(); stopClock(); note(); void refreshSessions().catch(error => toast(error.message)); $('question').focus();
  state.pendingIds = []; renderFiles([]);
}
async function openSettings() {
  if (state.busy) return toast('请先等待执行结束或停止当前任务。');
  try {
    const data = await api('/api/agent-settings');
    $('global-effort').value = data.settings.effort; $('global-effort').disabled = !data.reasoningSupported;
    $('effort-support').textContent = data.reasoningSupported ? '快速、标准、深入、深度研究。较低强度适合简单问题。' : '当前模型沿用供应商默认思考设置，文件工具开关仍可调整。';
    $('file-tools-enabled').checked = data.settings.fileTools.enabled;
    $('file-tool-toggles').replaceChildren();
    for (const [name, label, description] of fileToolOptions) {
      const row = document.createElement('label'); row.className = 'file-tool-option';
      const copy = document.createElement('span'); const title = document.createElement('strong'); title.textContent = label;
      const code = document.createElement('code'); code.textContent = name; const small = document.createElement('small'); small.textContent = description;
      copy.append(title, code, small);
      const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.setAttribute('aria-label', name); input.dataset.fileTool = name; input.checked = data.settings.fileTools.tools[name];
      row.append(copy, input); $('file-tool-toggles').append(row);
    }
    updateToolToggles(); $('settings-error').hidden = true; dialog.showModal();
  } catch (error) { toast(error.message); }
}
async function sendQuestion(event) {
  event.preventDefault(); if (state.busy) return;
  const text = $('question').value.trim(); if (!text && !state.pendingIds.length) return $('question').focus();
  if (!state.status?.configured) return note('请在 .env 配置模型连接参数，并重启服务。', true);
  state.cancelBeforeRun = false; setBusy(true); note('正在准备本轮技能与记忆…'); resetContext(); startClock();
  const submittedIds = [...state.pendingIds];
  const submittedFiles = state.files.filter(file => submittedIds.includes(file.id));
  let accepted = false;
  let replyBody; let reply = ''; let failed = false; let completed = false;
  try {
    if (!state.current) { const data = await api('/api/sessions', { method: 'POST', body: '{}' }); state.current = data.id; localStorage.setItem('product-expert-session', data.id); }
    if (state.cancelBeforeRun) throw new Error('本次执行已停止。');
    addMessage('user', text || '请分析本条消息附带的文件。', Date.now(), false, undefined, undefined, 0, submittedFiles); replyBody = addMessage('assistant', '', Date.now(), true); $('question').value = ''; $('question').style.height = '';
    updateRounds(state.rounds + 1); scrollBottom();
    const response = await fetch(`/api/sessions/${state.current}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': state.token }, body: JSON.stringify({ text, attachmentIds: submittedIds }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || '执行失败。'); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    function handleFrame(frame) {
      if (!frame || frame.startsWith(':')) return;
      const name = frame.split('\n').find(line => line.startsWith('event: '))?.slice(7);
      const raw = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      if (!raw) return; const data = JSON.parse(raw);
      if (name === 'message') { accepted = true; state.pendingIds = state.pendingIds.filter(id => !submittedIds.includes(id)); savePending(); renderFiles(state.files); }
      if (name === 'start') { $('chat-title').textContent = data.title; startClock(data.run); note('Agent 正在检索资料并生成回答…'); }
      if (name === 'context') showContext(data);
      if (name === 'text') { reply += data.delta; const nearBottom = $('chat-scroll').scrollHeight - $('chat-scroll').scrollTop - $('chat-scroll').clientHeight < 150; markdown(replyBody, reply); if (nearBottom) scrollBottom(); }
      if (name === 'output') {
        const nearBottom = $('chat-scroll').scrollHeight - $('chat-scroll').scrollTop - $('chat-scroll').clientHeight < 150;
        const file = data.file;
        if (!state.files.some(existing => existing.id === file.id)) state.files.push(file);
        const row = replyBody.closest('.message');
        const existing = row._outputFiles || [];
        if (!existing.some(item => item.id === file.id)) existing.push(file);
        row._outputFiles = existing;
        renderOutputCards(row, existing, '文件已生成，本轮仍在继续。');
        renderFiles(state.files); if (nearBottom) scrollBottom();
      }
      if (name === 'tool') {
        const existing = state.activities.findLast(item => item.id === data.id && item.state === 'running');
        if (data.state !== 'running' && existing) existing.state = data.state; else state.activities.push(data);
        if (data.count != null) $('tool-count').textContent = `${data.count} 次`;
        renderActivity();
      }
      if (name === 'notice') note(data.text);
      if (name === 'error') { failed = true; note(data.message, true); if (!reply) replyBody.textContent = data.message; }
      if (name === 'done') { completed = true; restorePending(data); if (!accepted && !data.messages.some(message => message.role === 'user' && message.attachments?.some(file => submittedIds.includes(file.id)))) $('question').value = text; stopClock(data.run); $('tool-count').textContent = `${data.run?.toolCallCount ?? 0} 次`; showRuns(data.runs); renderMessages(data.messages); renderFiles(data.files || []); updateRounds(data.rounds); showContext(data.context); if (!failed) note('本轮完成 · 技能与记忆会在下次提问时重新读取。'); scrollBottom(); }
    }
    while (true) {
      const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      let boundary; while ((boundary = buffer.indexOf('\n\n')) !== -1) { handleFrame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      if (done) break;
    }
    if (!completed && !failed) throw new Error('连接已结束，但尚未收到完成结果。请查看会话后重试。');
  } catch (error) {
    failed = true; note(error.message, true); if (replyBody && !reply) replyBody.textContent = error.message;
    if (!replyBody) toast(error.message);
  } finally {
    if (failed && state.current) {
      try { const saved = await api(`/api/sessions/${state.current}`); renderMessages(saved.messages); restorePending(saved); renderFiles(saved.files || []); updateRounds(saved.rounds); showRuns(saved.runs); const latest = saved.runs?.at(-1); if (latest) stopClock(latest); } catch {}
    }
    if (!accepted && failed) $('question').value = text;
    if (state.clock) { clearInterval(state.clock); state.clock = null; $('run-clock').classList.remove('running'); if (!completed) $('run-clock').textContent = '本轮未完成 · 请查看运行记录'; }
    setBusy(false); await refreshSessions().catch(() => {}); await refreshStatus().catch(() => {}); $('question').focus(); }
}
$('composer').addEventListener('submit', sendQuestion);
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } });
$('question').addEventListener('input', () => { $('question').style.height = 'auto'; $('question').style.height = `${Math.min($('question').scrollHeight, 200)}px`; });
$('new-chat').addEventListener('click', newChat);
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { $('question').value = button.dataset.prompt; $('question').focus(); });
for (const id of ['settings-open', 'settings-top', 'banner-settings', 'model-settings', 'global-effort-display']) $(id).addEventListener('click', openSettings);
for (const id of ['logout', 'logout-top']) $(id).addEventListener('click', async () => {
  if (state.busy) return toast('请先停止或等待当前运行结束。');
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); localStorage.removeItem('product-expert-session'); window.location.replace('/login'); }
  catch (error) { toast(error.message); }
});
for (const id of ['settings-close', 'settings-cancel']) $(id).addEventListener('click', () => dialog.close());
$('file-tools-enabled').addEventListener('change', updateToolToggles);
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); $('settings-save').disabled = true; $('settings-error').hidden = true;
  try {
    const tools = Object.fromEntries([...$('file-tool-toggles').querySelectorAll('input')].map(input => [input.dataset.fileTool, input.checked]));
    await api('/api/agent-settings', { method: 'PUT', body: JSON.stringify({ effort: $('global-effort').value, fileTools: { enabled: $('file-tools-enabled').checked, tools } }) });
    dialog.close(); await refreshStatus(); toast('Agent 设置已保存，后续请求立即生效。');
  } catch (error) { $('settings-error').textContent = error.message; $('settings-error').hidden = false; }
  finally { $('settings-save').disabled = false; }
});
$('stop').addEventListener('click', async () => { if (state.uploadAbort) { state.uploadAbort.abort(); return; } state.cancelBeforeRun = true; if (!state.current) return note('正在取消本次执行…'); $('stop').disabled = true; try { await api(`/api/sessions/${state.current}/stop`, { method: 'POST', body: '{}' }); note('正在停止本次执行…'); } catch (error) { toast(error.message); } finally { $('stop').disabled = false; } });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!dialog.open && !sessionDialog.open) newChat(); }
  if (event.key === 'Escape' && !dialog.open && !sessionDialog.open) { setInspector(false); setSidebar(false); }
});
(async () => {
  try {
    await refreshStatus(); await refreshSessions();
    const saved = localStorage.getItem('product-expert-session');
    if (saved && state.status.configured) await openSession(saved).catch(() => localStorage.removeItem('product-expert-session'));
  } catch (error) { $('connection-text').textContent = '本地服务连接失败'; note(error.message, true); }
})();

function setInspector(open) {
  document.body.classList.toggle('inspector-open', open); $('context-inspector').hidden = !open;
  $('inspector-toggle').setAttribute('aria-expanded', String(open));
  if (open) setSidebar(false);
}
function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open); $('sessions-toggle').setAttribute('aria-expanded', String(open)); $('sessions-backdrop').hidden = !open;
  if (open) setInspector(false);
}
$('inspector-toggle').addEventListener('click', () => setInspector($('context-inspector').hidden));
$('inspector-close').addEventListener('click', () => { setInspector(false); $('inspector-toggle').focus(); });
$('sessions-toggle').addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));
for (const id of ['sessions-close', 'sessions-backdrop']) $(id).addEventListener('click', () => setSidebar(false));
window.matchMedia('(max-width:600px)').addEventListener('change', event => { if (!event.matches) setSidebar(false); });

refreshEffort();

function pendingKey() { return `product-expert-pending-${state.current}`; }
function savePending() { if (state.current) localStorage.setItem(pendingKey(), JSON.stringify(state.pendingIds)); }
function restorePending(data) {
  let ids = []; try { ids = JSON.parse(localStorage.getItem(pendingKey()) || '[]'); } catch {}
  const used = new Set((data.messages || []).flatMap(message => (message.attachments || []).map(file => file.id)));
  state.pendingIds = Array.isArray(ids) ? ids.filter(id => !used.has(id) && (data.files || []).some(file => file.id === id && file.direction === 'inputs')) : [];
  savePending();
}
function fileCard(file, pending = false) {
  const card = document.createElement('div'); card.className = `attachment-card ${file.direction}`;
  const link = document.createElement('a'); link.href = `/api/sessions/${encodeURIComponent(state.current)}/files/${file.id}`; link.download = file.name;
  const name = document.createElement('strong'); name.textContent = file.name;
  const description = document.createElement('small'); description.textContent = `${pending ? '待发送' : file.direction === 'outputs' ? '生成文件 · 下载' : '附件 · 下载'} · ${bytes(file.bytes)}`;
  link.append(name, description); card.append(link);
  if (pending) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-attachment'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除待发送附件 ${file.name}`); remove.disabled = state.busy;
    remove.addEventListener('click', () => { state.pendingIds = state.pendingIds.filter(id => id !== file.id); savePending(); renderFiles(state.files); }); card.append(remove);
  }
  return card;
}
function renderFiles(files) {
  state.files = files;
  $('attachment-list').replaceChildren(); $('session-file-list').replaceChildren();
  const pending = files.filter(file => state.pendingIds.includes(file.id));
  for (const file of pending) $('attachment-list').append(fileCard(file, true));
  for (const file of files.filter(file => !state.pendingIds.includes(file.id))) $('session-file-list').append(fileCard(file));
  $('session-files').hidden = files.length === pending.length;
  $('attachment-hint').hidden = !pending.length;
  $('attachment-hint').textContent = `${pending.length} 个待发送附件，将与下一条消息一起发送。`;
}
$('upload-file').addEventListener('click', () => { if (!state.busy) $('file-input').click(); });
$('file-input').addEventListener('change', async () => {
  const files = [...$('file-input').files]; $('file-input').value = '';
  if (!files.length || state.busy || !state.status?.fileTools?.enabled) return;
  if (state.pendingIds.length + files.length > 20) return toast('每条消息最多携带 20 个附件，请分批发送。');
  if (!state.status.configured) return note('请在 .env 配置模型连接参数，并重启服务。', true);
  setBusy(true); state.uploadAbort = new AbortController();
  try {
    if (!state.current) { const data = await api('/api/sessions', { method: 'POST', body: '{}' }); state.current = data.id; localStorage.setItem('product-expert-session', data.id); }
    for (const file of files) {
      if (file.size > state.status.fileTools.maxFileBytes) throw new Error(`${file.name} 超过单文件大小限制。`);
      note(`正在上传 ${file.name}…`);
      const uploaded = await api(`/api/sessions/${state.current}/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: state.uploadAbort.signal });
      state.pendingIds.push(uploaded.file.id); savePending(); state.files.push(uploaded.file); renderFiles(state.files);
    }
    const data = await api(`/api/sessions/${state.current}/files`); renderFiles(data.files); await refreshSessions();
    note('附件已准备好，将随下一条消息发送。');
  } catch (error) { note(error.name === 'AbortError' ? '上传已取消。' : error.message, true); }
  finally { state.uploadAbort = null; setBusy(false); renderFiles(state.files); $('question').focus(); }
});
