'use strict';
const $ = id => document.getElementById(id);
let contacts = [], token = '', toastTimer;
const number = value => Number(value || 0).toLocaleString('zh-CN');
const date = value => new Date(value).toLocaleString('zh-CN');
async function api(route, method = 'GET', body) {
  const response = await fetch(route, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status === 401) { location.assign('/login'); throw new Error('登录已失效，请重新登录。'); }
  const value = await response.json(); if (!response.ok) throw new Error(value.error || '请求失败，请重试。'); return value;
}
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500); }
function stat(label, value, className = 'contact-stat') {
  const block = document.createElement('div'); block.className = className;
  const title = document.createElement('span'); title.textContent = label;
  const text = document.createElement('strong'); text.textContent = value; block.append(title, text); return block;
}
function render() {
  const query = $('contacts-search').value.trim().toLowerCase();
  const visible = contacts.filter(contact => [contact.name, contact.userId, contact.botId].some(value => value.toLowerCase().includes(query)));
  $('contacts-list').replaceChildren();
  const questions = contacts.reduce((n, c) => n + (c.stats?.questions || 0), 0);
  const reported = contacts.reduce((n, c) => n + (c.stats?.reportedRequests || 0), 0);
  const total = contacts.reduce((n, c) => n + (c.stats?.inputTokens || 0) + (c.stats?.outputTokens || 0), 0);
  $('contacts-summary').replaceChildren(stat('联系人', number(contacts.length)), stat('已记录提问', `${number(questions)} 次`), stat('已记录 Token', reported ? number(total) : '未记录'));
  $('contacts-status').textContent = contacts.length ? `共 ${contacts.length} 位联系人${query ? `，匹配 ${visible.length} 位` : ''}。留空保存可清除备注。` : '暂无联系人。企微收到消息后会自动登记；已有对话中的身份也会导入。';
  for (const contact of visible) {
    const form = document.createElement('form'); form.className = 'contact-row';
    const detail = document.createElement('div'); detail.className = 'contact-detail';
    const title = document.createElement('strong'); title.textContent = contact.name || '未备注';
    const userId = document.createElement('code'); userId.textContent = contact.userId;
    const meta = document.createElement('small'); meta.textContent = `${contact.types.map(type => type === 'group' ? '群聊' : '私聊').join(' / ')} · 最近出现 ${date(contact.lastSeen)}`;
    const bot = document.createElement('small'); bot.textContent = `机器人：${contact.botId}`; detail.append(title, userId, meta, bot);
    const metrics = document.createElement('div'); metrics.className = 'contact-stats'; const s = contact.stats;
    metrics.append(stat('已记录提问', s ? `${number(s.questions)} 次` : '未记录'), stat('总 Token', s?.reportedRequests ? number(s.inputTokens + s.outputTokens) : '未记录'), stat('输入 Token', s?.reportedRequests ? number(s.inputTokens) : '未记录'), stat('输出 Token', s?.reportedRequests ? number(s.outputTokens) : '未记录'));
    const coverage = document.createElement('div'); coverage.className = 'contact-coverage';
    const since = document.createElement('p'); since.textContent = s ? `统计起于 ${date(s.since)}；已结束 ${number(s.finishedRuns)} 轮${s.questions > s.finishedRuns ? `，运行中或中断 ${number(s.questions - s.finishedRuns)} 轮` : ''}。` : '尚无升级后的提问记录；旧数据未回填。';
    const completeness = document.createElement('p'); completeness.textContent = s ? `收到 usage ${number(s.reportedRequests)} / ${number(s.requests)} 次模型请求${s.reportedRequests < s.requests ? '，Token 统计不完整（含尚未返回的请求）' : ''}。` : 'Token 未记录。';
    coverage.append(since, completeness); metrics.append(coverage);
    const edit = document.createElement('div'); edit.className = 'contact-edit';
    const label = document.createElement('label'); label.htmlFor = `contact-${contact.id}`; label.textContent = '备注名称';
    const input = document.createElement('input'); input.id = label.htmlFor; input.maxLength = 80; input.value = contact.name; input.placeholder = '输入姓名或备注'; input.autocomplete = 'off';
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'primary-button'; save.textContent = '保存';
    const error = document.createElement('p'); error.className = 'form-error'; error.hidden = true; error.setAttribute('role', 'alert'); edit.append(label, input, save, error); form.append(detail, metrics, edit);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true; input.disabled = true; error.hidden = true;
      try { const result = await api(`/api/wecom-contacts/${contact.id}`, 'PATCH', { name: input.value }); Object.assign(contact, result.contact); input.value = contact.name; title.textContent = contact.name || '未备注'; toast('备注已保存，后续通知使用新名称。'); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
      finally { save.disabled = false; input.disabled = false; }
    });
    $('contacts-list').append(form);
  }
}
async function refresh() {
  $('contacts-refresh').disabled = true; $('contacts-status').textContent = '正在读取企微联系人…';
  try { contacts = (await api('/api/wecom-contacts')).contacts; render(); } catch (error) { $('contacts-status').textContent = error.message; }
  finally { $('contacts-refresh').disabled = false; }
}
$('contacts-search').addEventListener('input', render); $('contacts-refresh').addEventListener('click', refresh);
void api('/api/auth/status').then(status => { if (!status.authenticated) { location.assign('/login'); return; } token = status.token; return refresh(); }).catch(error => { $('contacts-status').textContent = error.message; });
