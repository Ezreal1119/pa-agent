const $ = id => document.getElementById(id);
const prefix = location.pathname.startsWith('/admin/') ? '/admin' : '';
let busy = false;
function notice(text = '') { $('users-notice').textContent = text; $('users-notice').hidden = !text; }
async function api(route, data) {
  const response = await fetch(prefix + '/api/users' + route, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CKD-UI': '1' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (response.status === 401) { location.assign(prefix + '/login'); throw new Error('请重新登录管理员。'); }
  if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
  return result;
}
function cell(text) { const c = document.createElement('td'); c.textContent = text; return c; }
function credentials(result) {
  $('credentials-account').textContent = '账号：' + result.user.account;
  $('initial-password').value = result.initialPassword; $('copy-result').textContent = '';
  $('credentials-dialog').showModal();
}
async function perform(action) {
  if (busy) return;
  busy = true; notice();
  for (const button of document.querySelectorAll('.users-main button')) button.disabled = true;
  try { await action(); } catch (error) { notice(error.message); }
  finally { busy = false; for (const button of document.querySelectorAll('.users-main button')) button.disabled = false; }
}
async function loadLibraries() {
  try {
    const response = await fetch(prefix + '/api/libraries', { headers: { 'X-CKD-UI': '1' } });
    if (!response.ok) return [];
    return (await response.json()).libraries || [];
  } catch { return []; }
}
async function refresh() {
  const [{ users }, libraries] = await Promise.all([api(''), loadLibraries()]);
  const byAccount = new Map(libraries.map(library => [library.account.toLowerCase(), library]));
  $('users-list').replaceChildren();
  for (const user of users) {
    const row = document.createElement('tr'), actions = cell('');
    const library = user.role === 'admin' ? libraries.find(item => item.master) : byAccount.get(user.account.toLowerCase());
    const libraryCell = document.createElement('td');
    if (library) {
      const open = document.createElement('a');
      open.href = prefix + '/editor' + (library.master ? '' : '?library=' + encodeURIComponent(library.account));
      open.textContent = '打开';
      libraryCell.append(document.createTextNode(`${library.projects ?? 0} 个项目 `), open);
    } else libraryCell.textContent = '—';
    row.append(cell(user.account), cell(user.role === 'admin' ? '系统管理员' : '普通用户'), cell(user.enabled ? '正常' : '已禁用'), cell(user.role === 'admin' ? '由服务器配置维护' : user.mustChangePassword ? '首次登录需改密' : '已设置'), libraryCell, actions);
    if (user.immutable) actions.textContent = '系统账号，不可修改';
    else {
      const status = document.createElement('button'); status.type = 'button'; status.textContent = user.enabled ? '禁用' : '启用';
      status.addEventListener('click', () => perform(async () => { if (!confirm(`确认${user.enabled ? '禁用' : '启用'}账号 ${user.account}？`)) return; await api('/' + user.id + '/status', { enabled: !user.enabled }); await refresh(); }));
      const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = '重置密码';
      reset.addEventListener('click', () => perform(async () => { if (!confirm(`重置 ${user.account} 的密码并退出其所有登录？`)) return; credentials(await api('/' + user.id + '/reset-password', {})); await refresh(); }));
      actions.append(status, reset);
    }
    $('users-list').append(row);
  }
}
$('create-user-form').addEventListener('submit', event => { event.preventDefault(); void perform(async () => { credentials(await api('', { account: event.currentTarget.elements.account.value.trim() })); $('create-user-form').reset(); await refresh(); }); });
$('close-credentials').addEventListener('click', () => $('credentials-dialog').close());
$('credentials-dialog').addEventListener('close', () => { $('initial-password').value = ''; $('credentials-account').textContent = ''; $('copy-result').textContent = ''; });
$('copy-password').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('initial-password').value); $('copy-result').textContent = '已复制。'; } catch { $('initial-password').focus(); $('initial-password').select(); $('copy-result').textContent = '请按 Ctrl+C 或 Command+C 复制。'; } });
$('users-logout').addEventListener('click', () => perform(async () => { const response = await fetch(prefix + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CKD-UI': '1' }, body: '{}' }); if (!response.ok) throw new Error('退出失败，请重试。'); location.assign(prefix + '/login'); }));
void refresh().catch(error => notice(error.message));
