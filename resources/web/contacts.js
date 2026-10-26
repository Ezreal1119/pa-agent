'use strict';
const $ = id => document.getElementById(id);
let contacts = [], token = '', toastTimer;
const number = value => Number(value || 0).toLocaleString('en-US');
const date = value => new Date(value).toLocaleString('en-US');
async function api(route, method = 'GET', body) {
  const response = await fetch(route, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status === 401) { location.assign('/login'); throw new Error('Your sign-in has expired. Please sign in again.'); }
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed. Please try again.'); return value;
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
  $('contacts-summary').replaceChildren(stat('Contacts', number(contacts.length)), stat('Recorded questions', number(questions)), stat('Recorded tokens', reported ? number(total) : 'Not recorded'));
  $('contacts-status').textContent = contacts.length ? `Contacts: ${contacts.length}${query ? `; matching: ${visible.length}` : ''}. Names appear as the sender in future notifications; no User ID is shown when named. Save an empty name to clear it.` : 'No contacts yet. Incoming WeCom messages register contacts automatically; identities from existing conversations are also imported.';
  for (const contact of visible) {
    const form = document.createElement('form'); form.className = 'contact-row';
    const detail = document.createElement('div'); detail.className = 'contact-detail';
    const title = document.createElement('strong'); title.textContent = contact.name || 'Unnamed';
    const userId = document.createElement('code'); userId.textContent = contact.userId;
    const meta = document.createElement('small'); meta.textContent = `${contact.types.map(type => type === 'group' ? 'Group' : 'Direct message').join(' / ')} · Last seen ${date(contact.lastSeen)}`;
    const bot = document.createElement('small'); bot.textContent = `Bot: ${contact.botId}`; detail.append(title, userId, meta, bot);
    const metrics = document.createElement('div'); metrics.className = 'contact-stats'; const s = contact.stats;
    metrics.append(stat('Recorded questions', s ? number(s.questions) : 'Not recorded'), stat('Total tokens', s?.reportedRequests ? number(s.inputTokens + s.outputTokens) : 'Not recorded'), stat('Input tokens', s?.reportedRequests ? number(s.inputTokens) : 'Not recorded'), stat('Output tokens', s?.reportedRequests ? number(s.outputTokens) : 'Not recorded'));
    const coverage = document.createElement('div'); coverage.className = 'contact-coverage';
    const since = document.createElement('p'); since.textContent = s ? `Tracking since ${date(s.since)}; ${number(s.finishedRuns)} finished runs${s.questions > s.finishedRuns ? `, ${number(s.questions - s.finishedRuns)} running or interrupted` : ''}.` : 'No questions recorded since the upgrade; older data is not backfilled.';
    const completeness = document.createElement('p'); completeness.textContent = s ? `Usage received for ${number(s.reportedRequests)} / ${number(s.requests)} model requests${s.reportedRequests < s.requests ? '; token totals are incomplete (including pending requests)' : ''}.` : 'Token usage not recorded.';
    coverage.append(since, completeness); metrics.append(coverage);
    const edit = document.createElement('div'); edit.className = 'contact-edit';
    const label = document.createElement('label'); label.htmlFor = `contact-${contact.id}`; label.textContent = 'Display name';
    const input = document.createElement('input'); input.id = label.htmlFor; input.maxLength = 80; input.value = contact.name; input.placeholder = 'Enter a name or note'; input.autocomplete = 'off';
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'primary-button'; save.textContent = 'Save';
    const error = document.createElement('p'); error.className = 'form-error'; error.hidden = true; error.setAttribute('role', 'alert'); edit.append(label, input, save, error); form.append(detail, metrics, edit);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true; input.disabled = true; error.hidden = true;
      try { const result = await api(`/api/wecom-contacts/${contact.id}`, 'PATCH', { name: input.value }); Object.assign(contact, result.contact); input.value = contact.name; title.textContent = contact.name || 'Unnamed'; toast('Name saved. Notifications and Recent conversations will use it.'); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
      finally { save.disabled = false; input.disabled = false; }
    });
    $('contacts-list').append(form);
  }
}
async function refresh() {
  $('contacts-refresh').disabled = true; $('contacts-status').textContent = 'Loading WeCom contacts…';
  try { contacts = (await api('/api/wecom-contacts')).contacts; render(); } catch (error) { $('contacts-status').textContent = error.message; }
  finally { $('contacts-refresh').disabled = false; }
}
$('contacts-search').addEventListener('input', render); $('contacts-refresh').addEventListener('click', refresh);
void api('/api/auth/status').then(status => { if (!status.authenticated) { location.assign('/login'); return; } token = status.token; return refresh(); }).catch(error => { $('contacts-status').textContent = error.message; });
