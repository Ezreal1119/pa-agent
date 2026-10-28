'use strict';
const $ = id => document.getElementById(id);
const state = { token: '', status: null, current: null, busy: false, rounds: 0, activities: [], toastTimer: null, cancelBeforeRun: false, effort: 'low', run: null, clock: null, clockStart: 0, files: [], pendingIds: [] };
const dialog = $('settings-dialog');
const sessionDialog = $('session-dialog');
let sessionAction = null;
let mcpEnabled = false; let mcpSaving = false;
const effortLabels = { off: 'Fast', low: 'Standard', high: 'Thorough', max: 'Deep research', 'provider-default': 'Provider default' };
const statusLabels = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
const countLabel = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;
const duration = ms => typeof ms === 'number' && Number.isFinite(ms) ? (ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${((ms % 60000) / 1000).toFixed(1)} s`) : 'Unknown';
function refreshEffort() {
  $('global-effort-display').textContent = state.status?.reasoning?.supported ? `Reasoning level · ${effortLabels[state.effort] || 'Standard'} ⚙` : 'Reasoning level · Provider default ⚙';
  $('global-effort-display').disabled = state.busy;
}
const fileToolOptions = [
  ['pdf_read', 'Read PDF', 'Read PDF text, tables, and selected pages'],
  ['docx_read', 'Read Word', 'Read DOCX text, tables, and embedded images'],
  ['pptx_read', 'Read PowerPoint', 'Read PPTX slides, speaker notes, and text'],
  ['excel_read', 'Read Excel', 'Read XLSX workbooks, cells, and formulas'],
  ['excel_patch_template', 'Fill Excel template', 'Update selected cells and save a new workbook'],
  ['excel_create', 'Create Excel', 'Create a new workbook from headers and data rows'],
  ['text_file_create', 'Create text file', 'Export HTML, Markdown, Java, and other text files without running them'],
  ['image_read', 'Read image', 'Read image content with the vision model'],
];
function stopClock(run) {
  clearInterval(state.clock); state.clock = null; state.run = run || null;
  $('run-clock').classList.remove('running');
  $('run-clock').textContent = run ? `${statusLabels[run.status] || run.status} · ${duration(run.elapsedMs)}` : 'Ready';
  $('run-duration').textContent = run ? duration(run.elapsedMs) : '—';
  $('first-text-time').textContent = run?.firstTextMs != null ? duration(run.firstTextMs) : '—';
  $('tool-count').textContent = countLabel(run?.toolCallCount ?? 0, 'call');
  if (run) $('applied-effort').textContent = effortLabels[run.effort] || run.effort;
}
function startClock(run) {
  clearInterval(state.clock); state.run = run || null;
  state.clockStart = performance.now() - (run ? Math.max(0, Date.now() - Date.parse(run.startedAt)) : 0);
  $('run-clock').classList.add('running');
  const tick = () => { const elapsed = duration(performance.now() - state.clockStart); $('run-clock').textContent = `Running · ${elapsed}`; $('run-duration').textContent = elapsed; };
  tick(); state.clock = setInterval(tick, 100);
}
function showRuns(runs = []) {
  $('run-history').replaceChildren();
  if (!runs.length) { const p = document.createElement('p'); p.textContent = 'Reasoning levels and run times are saved with the conversation.'; $('run-history').append(p); return; }
  for (const run of runs.slice(-5).reverse()) {
    const row = document.createElement('div'); row.className = `run-history-row ${run.status}`;
    const label = document.createElement('span'); label.textContent = `#${run.sequence} ${effortLabels[run.effort] || run.effort}`;
    const time = document.createElement('strong'); time.textContent = duration(run.elapsedMs);
    const status = document.createElement('small'); status.textContent = `${statusLabels[run.status] || run.status} · ${countLabel(run.toolCallCount ?? 0, 'tool call')} · ${new Date(run.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    row.append(label, time, status); $('run-history').append(row);
  }
}
const bytes = value => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => $('toast').hidden = true, 4200); }
function note(message = '', error = false) { $('run-note').textContent = message; $('run-note').hidden = !message; $('run-note').classList.toggle('error', error); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), 'X-Local-Token': state.token, ...options.headers } });
  const data = await response.json();
  if (response.status === 401) { window.location.replace('/login'); throw new Error('Your sign-in has expired. Please sign in again.'); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
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
  $('round-count').textContent = `Context ${kept} / 5 turns`;
  [...$('round-dots').children].forEach((dot, index) => dot.classList.toggle('filled', index < kept));
}
function resetContext() {
  $('request-count').textContent = '—'; $('payload-size').textContent = '—'; $('applied-effort').textContent = '—'; $('first-text-time').textContent = '—';
  $('tool-count').textContent = '0 calls';
  $('injection-status').classList.remove('verified');
  $('injection-status').querySelector('strong').textContent = 'Waiting for this run';
  $('injection-status').querySelector('small').textContent = 'Inspect injected copies in the actual request after a run';
  state.activities = []; renderActivity();
}
function showContext(context) {
  if (!context) return;
  const valid = context.skills?.length === 1 && context.skills.every(skill => skill.skillCopies === 1 && skill.memoryCopies === 1) && context.extraMemoryCopies === 1;
  $('injection-status').classList.toggle('verified', valid);
  $('injection-status').querySelector('strong').textContent = valid ? 'Injected for this run · One copy each' : 'Check resource injection for this run';
  $('injection-status').querySelector('small').textContent = valid ? 'One copy each of product skill, product memory, and extra memory; UMS loads on demand' : 'Skill or memory copies in this request differ from the expected counts';
  $('request-count').textContent = String(context.requests);
  $('payload-size').textContent = bytes(context.payloadBytes);
  $('applied-effort').textContent = context.thinking === 'disabled' ? 'Fast · Reasoning off' : context.effort ? `${effortLabels[context.effort] || context.effort} · ${context.effort}` : 'Provider default';
  updateRounds(state.rounds, context.userRounds);
}
function renderActivity() {
  $('activity').replaceChildren();
  if (!state.activities.length) { const p = document.createElement('p'); p.textContent = 'Tool activity appears when you ask a question.'; $('activity').append(p); return; }
  const labels = { read: 'Read files', grep: 'Search contents', find: 'Find files', ls: 'List directories', memory: 'Manage extra memory', memory_add: 'Legacy memory add', memory_edit: 'Legacy memory edit', memory_delete: 'Legacy memory delete', bash: 'Legacy command', edit: 'Legacy edit', write: 'Legacy write' };
  for (const item of state.activities.slice(-10)) {
    const row = document.createElement('div'); row.className = `activity-row ${item.state}`;
    row.append(document.createElement('span'));
    const text = document.createElement('div'); text.textContent = `${labels[item.name] || item.name} · ${{ running: 'Running', done: 'Completed', error: 'Failed' }[item.state] || item.state}`;
    row.append(text); $('activity').append(row);
  }
}
async function refreshStatus() {
  const status = await api('/api/status'); state.token = status.token; state.status = status;
  state.effort = status.reasoning?.default || 'low';
  $('attachment-area').hidden = !status.fileTools?.enabled || !status.fileTools.tools.length;
  if (status.fileTools?.acceptedExtensions) $('file-input').accept = status.fileTools.acceptedExtensions.join(',');
  $('file-support').textContent = status.fileTools?.enabled ? `PDF · Word · PPT · Excel · Images · Text / per file ≤ ${bytes(status.fileTools.maxFileBytes)}` : '';
  $('connection-text').textContent = status.configured ? 'Connected · Configured' : 'Connected · Setup required';
  $('connection-dot').classList.toggle('ready', status.configured); $('config-banner').hidden = status.configured;
  $('model-name').textContent = status.model.modelId || 'Not configured';
  $('model-detail').textContent = status.model.baseUrl || 'OpenAI-compatible API';
  $('extra-memory-ready').textContent = status.extraMemory?.ready ? (status.extraMemory.bytes ? bytes(status.extraMemory.bytes) : 'Empty · Ready to add') : 'Unavailable';
  $('skill-cards').replaceChildren();
  $('default-skill-count').textContent = String(status.skills.length).padStart(2, '0');
  $('ordinary-skill-status').textContent = (status.ordinarySkills || []).map(skill => `${skill.name} · ${skill.ready ? 'On demand; no dedicated memory' : 'Not installed (optional)'}`).join('; ');
  for (const [index, skill] of status.skills.entries()) {
    const card = document.createElement('div'); card.className = 'skill-card';
    const header = document.createElement('div'); header.className = 'skill-header';
    const dot = document.createElement('i'); dot.className = `tag-dot ${index ? 'blue' : 'teal'}`;
    const name = document.createElement('span'); name.textContent = skill.name;
    const label = document.createElement('b'); label.textContent = skill.files.every(f => f.ready) ? 'Ready' : 'Missing files';
    header.append(dot, name, label); card.append(header);
    for (const file of skill.files) {
      const row = document.createElement('div'); row.className = 'skill-file';
      const fileName = document.createElement('span'); fileName.textContent = file.file;
      const size = document.createElement('strong'); size.textContent = file.ready ? bytes(file.bytes) : 'Missing / Empty'; size.classList.toggle('missing', !file.ready);
      row.append(fileName, size); card.append(row);
    }
    $('skill-cards').append(card);
  }
  $('send').disabled = false; refreshEffort();
}
async function refreshSessions() {
  const { sessions } = await api('/api/sessions'); $('sessions').replaceChildren(); $('session-count').textContent = sessions.length;
  if (!sessions.length) { const p = document.createElement('p'); p.className = 'empty-sessions'; p.textContent = 'Your product conversations start here.'; $('sessions').append(p); }
  for (const session of sessions) {
    const displayTitle = session.displayTitle || session.title || 'New conversation';
    const row = document.createElement('div'); row.className = `session-row${session.id === state.current ? ' active' : ''}`;
    const button = document.createElement('button'); button.className = `session-button${session.id === state.current ? ' active' : ''}`; button.disabled = state.busy;
    const title = document.createElement('strong'); title.textContent = displayTitle;
    const time = document.createElement('small'); time.textContent = session.running ? 'Running' : new Date(session.updated).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    button.append(title, time); button.addEventListener('click', () => openSession(session.id).then(() => setSidebar(false)).catch(error => toast(error.message)));
    const menu = document.createElement('details'); menu.className = 'session-menu';
    const summary = document.createElement('summary'); summary.textContent = '⋯'; summary.setAttribute('aria-label', `Manage conversation: ${displayTitle}`);
    const actions = document.createElement('div'); actions.className = 'session-menu-actions';
    for (const [action, label] of [['rename', 'Rename'], ['delete', 'Delete']]) {
      const control = document.createElement('button'); control.className = `session-operation ${action}`; control.textContent = label;
      control.disabled = state.busy || session.running; control.dataset.running = String(session.running);
      if (session.running) control.title = 'Stop this conversation run or wait for it to finish';
      control.addEventListener('click', () => { menu.open = false; openSessionAction(action, session); }); actions.append(control);
    }
    menu.append(summary, actions); row.append(button, menu); $('sessions').append(row);
  }
}
function openSessionAction(action, session) {
  if (state.busy || session.running) return toast('Stop the conversation run or wait for it to finish.');
  sessionAction = { action, id: session.id }; $('session-dialog-error').hidden = true;
  const deleting = action === 'delete';
  $('session-dialog-title').textContent = deleting ? 'Delete conversation?' : 'Rename conversation';
  $('session-dialog-copy').textContent = deleting ? `Permanently delete all messages, tool calls, run history, uploads, and generated files (including cache and temporary files) for “${session.displayTitle || session.title || 'New conversation'}”. This cannot be undone.` : 'The name is saved with the conversation and survives refreshes and restarts.';
  $('session-title-field').hidden = deleting; $('session-title-input').required = !deleting;
  $('session-title-input').value = session.title || 'New conversation';
  $('session-dialog-save').textContent = deleting ? 'Delete conversation' : 'Save name';
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
    if (action.action === 'delete') { localStorage.removeItem(`product-expert-pending-${action.id}`); if (state.current === action.id) newChat(); toast('Conversation deleted'); }
    else { if (state.current === action.id) $('chat-title').textContent = data.title; toast('Conversation name saved'); }
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
function toolDuration(ms) { return ms == null ? 'Duration not recorded' : ms < 1000 ? `${ms} ms` : duration(ms); }
const toolStatusLabels = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted', 'not-executed': 'Not executed' };
function toolSection(parent, title, value) {
  const heading = document.createElement('h4'); heading.textContent = title;
  const pre = document.createElement('pre'); pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  parent.append(heading, pre);
}
function renderToolCalls(panel, data) {
  panel.replaceChildren();
  const heading = document.createElement('p'); heading.className = 'tool-list-heading'; heading.textContent = `${countLabel(data.count, 'tool call')} in this run · In request order`;
  panel.append(heading);
  if (!data.calls.length) { const empty = document.createElement('p'); empty.textContent = 'No tools were called in this run.'; panel.append(empty); return; }
  for (const call of data.calls) {
    const card = document.createElement('details'); card.className = `tool-call-card ${call.status}`;
    const summary = document.createElement('summary');
    const name = document.createElement('strong'); name.textContent = `#${call.sequence} ${call.name}`;
    const status = document.createElement('span'); status.className = 'tool-call-status'; status.textContent = toolStatusLabels[call.status] || call.status;
    const elapsed = document.createElement('span'); elapsed.className = 'tool-call-duration'; elapsed.textContent = toolDuration(call.elapsedMs);
    const preview = document.createElement('small');
    preview.textContent = JSON.stringify(call.arguments)?.replace(/\s+/g, ' ').slice(0, 150) || 'No arguments';
    summary.append(name, status, elapsed, preview); card.append(summary);
    const body = document.createElement('div'); body.className = 'tool-call-body';
    const info = document.createElement('p'); info.className = 'tool-call-meta';
    const date = value => value ? new Date(value).toLocaleString('en-US', { hour12: false }) : 'Not recorded';
    const metrics = call.result?.details?.metrics;
    info.textContent = `Call ID: ${call.id}\nStarted: ${date(call.startedAt)}\nFinished: ${date(call.finishedAt)}` + (metrics ? `\nQueue: ${toolDuration(metrics.queueMs)} · File processing: ${toolDuration(metrics.executionMs)} · Vision requests: ${metrics.visionCalls} · Peak ${metrics.workerPeakBytes ? 'container' : 'process'} memory: ${bytes(metrics.workerPeakBytes || metrics.peakRssKiB * 1024)}` : '');
    body.append(info); toolSection(body, 'Arguments', call.arguments);
    if (call.result === null) toolSection(body, 'Result', 'No tool result received.');
    else {
      for (const content of call.result.content || []) {
        toolSection(body, call.result.isError ? 'Error' : 'Result', content.type === 'text' ? content.text : content);
      }
      if (call.result.details != null) toolSection(body, 'Structured details', call.result.details);
    }
    card.append(body); panel.append(card);
  }
}
function addMessage(role, text, timestamp = Date.now(), pending = false, run, toolRunId, toolCallCount = 0, attachments = [], outputs = [], outputNotice = '') {
  const row = document.createElement('article'); row.className = `message ${role}`;
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = role === 'user' ? 'Y' : 'p';
  const label = document.createElement('span'); label.textContent = role === 'user' ? 'You' : 'Product Expert';
  const time = document.createElement('time'); time.textContent = new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
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
    const copy = document.createElement('button'); copy.className = 'copy-button'; copy.textContent = 'Copy answer'; copy.addEventListener('click', () => navigator.clipboard.writeText(text).then(() => toast('Answer copied')).catch(() => toast('Copy failed. Select and copy the text manually.')));
    actions.append(copy);
    if (toolRunId) {
      const count = document.createElement('span'); count.className = 'tool-count-label'; count.textContent = countLabel(toolCallCount, 'tool call');
      const toggle = document.createElement('button'); toggle.className = 'tools-button'; toggle.textContent = 'View tool calls'; toggle.setAttribute('aria-expanded', 'false');
      const panel = document.createElement('section'); panel.className = 'tool-calls-panel'; panel.hidden = true;
      panel.id = `tools-${crypto.randomUUID()}`; toggle.setAttribute('aria-controls', panel.id);
      const sessionId = state.current;
      toggle.addEventListener('click', async () => {
        panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); toggle.textContent = panel.hidden ? 'View tool calls' : 'Hide tool calls';
        if (panel.hidden || panel.dataset.loaded) return;
        toggle.disabled = true; panel.textContent = 'Loading tool calls…';
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
  if (!section) { section = document.createElement('section'); section.className = 'run-outputs'; section.setAttribute('aria-label', 'Generated files'); row.append(section); }
  section.replaceChildren();
  const heading = document.createElement('p'); heading.className = 'output-heading'; heading.textContent = 'Generated files'; section.append(heading);
  const list = document.createElement('div'); list.className = 'output-file-list';
  for (const file of files) {
    const card = fileCard(file);
    card.querySelector('small').textContent = `${file.name.split('.').at(-1).toUpperCase()} · ${bytes(file.bytes)} · Download`;
    card.querySelector('a').setAttribute('aria-label', `Download generated file ${file.name}`);
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
  if (!state.status?.configured) return note('Configure the model connection in .env, then restart the service.', true);
  const data = await api(`/api/sessions/${id}`);
  state.current = id; localStorage.setItem('product-expert-session', id); $('chat-title').textContent = data.title || 'New conversation';
  renderMessages(data.messages); updateRounds(data.rounds); resetContext(); showContext(data.context); showRuns(data.runs); note();
  restorePending(data); renderFiles(data.files || []);
  const latest = data.runs?.at(-1); if (data.running && latest?.status === 'running') startClock(latest); else stopClock(latest);
  $('tool-count').textContent = countLabel(latest?.toolCallCount ?? 0, 'call');
  if (data.running) note('This conversation is running in another window. Reopen it after the run finishes.');
  await refreshSessions(); scrollBottom();
}
function newChat() {
  if (state.busy) return;
  state.current = null; localStorage.removeItem('product-expert-session'); $('chat-title').textContent = 'New conversation';
  renderMessages([]); updateRounds(0); resetContext(); showRuns(); stopClock(); note(); void refreshSessions().catch(error => toast(error.message)); $('question').focus();
  state.pendingIds = []; renderFiles([]);
}
function renderMcpSettings(data) {
  mcpEnabled = data.enabled; $('mcp-enabled').checked = mcpEnabled;
  $('mcp-settings-error').hidden = true;
  for (const [id, key] of [['mcp-submitted', 'submitted'], ['mcp-input', 'inputTokens'], ['mcp-output', 'outputTokens'], ['mcp-total', 'totalTokens']]) $(id).textContent = Number(data.totals[key] || 0).toLocaleString('en-US');
}
$('mcp-enabled').addEventListener('change', async () => {
  if (mcpSaving) return;
  mcpSaving = true; $('mcp-enabled').disabled = true; $('settings-save').disabled = true; $('mcp-settings-error').hidden = true;
  try {
    renderMcpSettings(await api('/api/mcp/settings', { method: 'PUT', body: JSON.stringify({ enabled: $('mcp-enabled').checked }) }));
    toast(`MCP ${mcpEnabled ? 'enabled' : 'disabled'}.`);
  } catch (error) { $('mcp-enabled').checked = mcpEnabled; $('mcp-settings-error').textContent = error.message; $('mcp-settings-error').hidden = false; }
  finally { mcpSaving = false; $('mcp-enabled').disabled = false; $('settings-save').disabled = false; }
});
async function openSettings() {
  if (state.busy) return toast('Wait for the current run to finish or stop it first.');
  try {
    const [data, mcp] = await Promise.all([api('/api/agent-settings'), api('/api/mcp/settings')]);
    renderMcpSettings(mcp);
    $('global-effort').value = data.settings.effort; $('global-effort').disabled = !data.reasoningSupported;
    $('effort-support').textContent = data.reasoningSupported ? 'Fast, Standard, Thorough, and Deep research. Lower levels suit simple questions.' : 'This model uses the provider’s default reasoning settings. Tool switches remain available.';
    $('web-search-enabled').checked = data.settings.webTools.tools.search;
    $('web-fetch-enabled').checked = data.settings.webTools.tools.fetch;
    $('web-tools-help').textContent = data.webToolsConfigured ? 'DeepSeek key configured. Each tool setting applies to Web and WeCom.' : 'No DeepSeek key configured. Direct DeepSeek connections reuse API_KEY; otherwise set DEEPSEEK_API_KEY in .env.';
    $('library-links-enabled').checked = data.settings.libraryLinks.enabled;
    $('firmware-enabled').checked = data.settings.firmware?.enabled ?? false;
    $('firmware-help').textContent = data.firmwareConfigured ? 'Firmware service connection is configured. Offline services reply with a maintenance message.' : 'Set FIRMWARE_SERVICE_URL and FIRMWARE_SERVICE_TOKEN in the server .env before use.';
    $('file-tool-toggles').replaceChildren();
    for (const [name, label, description] of fileToolOptions) {
      const row = document.createElement('label'); row.className = 'file-tool-option';
      const copy = document.createElement('span'); const title = document.createElement('strong'); title.textContent = label;
      const code = document.createElement('code'); code.textContent = name; const small = document.createElement('small'); small.textContent = description;
      copy.append(title, code, small);
      const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.setAttribute('aria-label', name); input.dataset.fileTool = name; input.checked = data.settings.fileTools.tools[name];
      row.append(copy, input); $('file-tool-toggles').append(row);
    }
    $('settings-error').hidden = true; dialog.showModal();
  } catch (error) { toast(error.message); }
}
async function sendQuestion(event) {
  event.preventDefault(); if (state.busy) return;
  const text = $('question').value.trim(); if (!text && !state.pendingIds.length) return $('question').focus();
  if (!state.status?.configured) return note('Configure the model connection in .env, then restart the service.', true);
  state.cancelBeforeRun = false; setBusy(true); note('Preparing skills and memory for this run…'); resetContext(); startClock();
  const submittedIds = [...state.pendingIds];
  const submittedFiles = state.files.filter(file => submittedIds.includes(file.id));
  let accepted = false;
  let replyBody; let reply = ''; let failed = false; let completed = false;
  try {
    if (!state.current) { const data = await api('/api/sessions', { method: 'POST', body: '{}' }); state.current = data.id; localStorage.setItem('product-expert-session', data.id); }
    if (state.cancelBeforeRun) throw new Error('This run was stopped.');
    addMessage('user', text || 'Please analyze the files attached to this message.', Date.now(), false, undefined, undefined, 0, submittedFiles); replyBody = addMessage('assistant', '', Date.now(), true); $('question').value = ''; $('question').style.height = '';
    updateRounds(state.rounds + 1); scrollBottom();
    const response = await fetch(`/api/sessions/${state.current}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': state.token }, body: JSON.stringify({ text, attachmentIds: submittedIds }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Run failed.'); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    function handleFrame(frame) {
      if (!frame || frame.startsWith(':')) return;
      const name = frame.split('\n').find(line => line.startsWith('event: '))?.slice(7);
      const raw = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      if (!raw) return; const data = JSON.parse(raw);
      if (name === 'message') { accepted = true; state.pendingIds = state.pendingIds.filter(id => !submittedIds.includes(id)); savePending(); renderFiles(state.files); }
      if (name === 'start') { $('chat-title').textContent = data.title; startClock(data.run); note('The agent is retrieving information and preparing an answer…'); }
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
        renderOutputCards(row, existing, 'File ready; the run is still in progress.');
        renderFiles(state.files); if (nearBottom) scrollBottom();
      }
      if (name === 'tool') {
        const existing = state.activities.findLast(item => item.id === data.id && item.state === 'running');
        if (data.state !== 'running' && existing) existing.state = data.state; else state.activities.push(data);
        if (data.count != null) $('tool-count').textContent = countLabel(data.count, 'call');
        renderActivity();
      }
      if (name === 'notice') note(data.text);
      if (name === 'error') { failed = true; note(data.message, true); if (!reply) replyBody.textContent = data.message; }
      if (name === 'done') { completed = true; restorePending(data); if (!accepted && !data.messages.some(message => message.role === 'user' && message.attachments?.some(file => submittedIds.includes(file.id)))) $('question').value = text; stopClock(data.run); $('tool-count').textContent = countLabel(data.run?.toolCallCount ?? 0, 'call'); showRuns(data.runs); renderMessages(data.messages); renderFiles(data.files || []); updateRounds(data.rounds); showContext(data.context); if (!failed) note('Run complete. Skills and memories will be reloaded for your next question.'); scrollBottom(); }
    }
    while (true) {
      const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      let boundary; while ((boundary = buffer.indexOf('\n\n')) !== -1) { handleFrame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      if (done) break;
    }
    if (!completed && !failed) throw new Error('The connection closed before the run finished. Check the conversation before retrying.');
  } catch (error) {
    failed = true; note(error.message, true); if (replyBody && !reply) replyBody.textContent = error.message;
    if (!replyBody) toast(error.message);
  } finally {
    if (failed && state.current) {
      try { const saved = await api(`/api/sessions/${state.current}`); renderMessages(saved.messages); restorePending(saved); renderFiles(saved.files || []); updateRounds(saved.rounds); showRuns(saved.runs); const latest = saved.runs?.at(-1); if (latest) stopClock(latest); } catch {}
    }
    if (!accepted && failed) $('question').value = text;
    if (state.clock) { clearInterval(state.clock); state.clock = null; $('run-clock').classList.remove('running'); if (!completed) $('run-clock').textContent = 'Run incomplete · Check run history'; }
    setBusy(false); await refreshSessions().catch(() => {}); await refreshStatus().catch(() => {}); $('question').focus(); }
}
$('composer').addEventListener('submit', sendQuestion);
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } });
$('question').addEventListener('input', () => { $('question').style.height = 'auto'; $('question').style.height = `${Math.min($('question').scrollHeight, 200)}px`; });
$('new-chat').addEventListener('click', newChat);
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { $('question').value = button.dataset.prompt; $('question').focus(); });
for (const id of ['settings-open', 'settings-top', 'banner-settings', 'model-settings', 'global-effort-display']) $(id).addEventListener('click', openSettings);
for (const id of ['logout', 'logout-top']) $(id).addEventListener('click', async () => {
  if (state.busy) return toast('Stop the current run or wait for it to finish.');
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); localStorage.removeItem('product-expert-session'); window.location.replace('/login'); }
  catch (error) { toast(error.message); }
});
for (const id of ['settings-close', 'settings-cancel']) $(id).addEventListener('click', () => dialog.close());
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); if (mcpSaving) return; $('settings-save').disabled = true; $('mcp-enabled').disabled = true; $('settings-error').hidden = true;
  try {
    const tools = Object.fromEntries([...$('file-tool-toggles').querySelectorAll('input')].map(input => [input.dataset.fileTool, input.checked]));
    await api('/api/agent-settings', { method: 'PUT', body: JSON.stringify({ effort: $('global-effort').value, webTools: { tools: { search: $('web-search-enabled').checked, fetch: $('web-fetch-enabled').checked } }, libraryLinks: { enabled: $('library-links-enabled').checked }, firmware: { enabled: $('firmware-enabled').checked }, fileTools: { tools } }) });
    dialog.close(); await refreshStatus(); toast('Agent settings saved. Changes apply to subsequent requests.');
  } catch (error) { $('settings-error').textContent = error.message; $('settings-error').hidden = false; }
  finally { $('settings-save').disabled = false; $('mcp-enabled').disabled = false; }
});
$('stop').addEventListener('click', async () => { if (state.uploadAbort) { state.uploadAbort.abort(); return; } state.cancelBeforeRun = true; if (!state.current) return note('Cancelling this run…'); $('stop').disabled = true; try { await api(`/api/sessions/${state.current}/stop`, { method: 'POST', body: '{}' }); note('Stopping this run…'); } catch (error) { toast(error.message); } finally { $('stop').disabled = false; } });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!document.querySelector('dialog[open]')) newChat(); }
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { setInspector(false); setSidebar(false); }
});
(async () => {
  try {
    await refreshStatus(); await refreshSessions();
    const saved = localStorage.getItem('product-expert-session');
    if (saved && state.status.configured) await openSession(saved).catch(() => localStorage.removeItem('product-expert-session'));
    if (new URLSearchParams(location.search).get('settings') === 'mcp') await openSettings();
  } catch (error) { $('connection-text').textContent = 'Service connection failed'; note(error.message, true); }
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
  const description = document.createElement('small'); description.textContent = `${pending ? 'Pending' : file.direction === 'outputs' ? 'Generated file · Download' : 'Attachment · Download'} · ${bytes(file.bytes)}`;
  link.append(name, description); card.append(link);
  if (pending) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-attachment'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove pending attachment ${file.name}`); remove.disabled = state.busy;
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
  $('attachment-hint').textContent = `${pending.length} pending attachments will be sent with your next message.`;
}
$('upload-file').addEventListener('click', () => { if (!state.busy) $('file-input').click(); });
$('file-input').addEventListener('change', async () => {
  const files = [...$('file-input').files]; $('file-input').value = '';
  if (!files.length || state.busy || !state.status?.fileTools?.enabled) return;
  if (state.pendingIds.length + files.length > 20) return toast('Attach up to 20 files per message. Send additional files in another message.');
  if (!state.status.configured) return note('Configure the model connection in .env, then restart the service.', true);
  setBusy(true); state.uploadAbort = new AbortController();
  try {
    if (!state.current) { const data = await api('/api/sessions', { method: 'POST', body: '{}' }); state.current = data.id; localStorage.setItem('product-expert-session', data.id); }
    for (const file of files) {
      if (file.size > state.status.fileTools.maxFileBytes) throw new Error(`${file.name} exceeds the per-file size limit.`);
      note(`Uploading ${file.name}…`);
      const uploaded = await api(`/api/sessions/${state.current}/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: state.uploadAbort.signal });
      state.pendingIds.push(uploaded.file.id); savePending(); state.files.push(uploaded.file); renderFiles(state.files);
    }
    const data = await api(`/api/sessions/${state.current}/files`); renderFiles(data.files); await refreshSessions();
    note('Attachments are ready to send with your next message.');
  } catch (error) { note(error.name === 'AbortError' ? 'Upload cancelled.' : error.message, true); }
  finally { state.uploadAbort = null; setBusy(false); renderFiles(state.files); $('question').focus(); }
});
