'use strict';
const loginField = id => document.getElementById(id);
let loginToken = '';
async function loadLoginStatus() {
  const response = await fetch('/api/auth/status');
  if (!response.ok) throw new Error('无法连接登录服务，请刷新重试。');
  const status = await response.json(); loginToken = status.token;
  if (status.authenticated) { window.location.replace('/'); return; }
  loginField('login-submit').disabled = !status.configured;
  loginField('login-account').disabled = !status.configured; loginField('login-password').disabled = !status.configured;
  loginField('login-status').textContent = status.configured ? '使用 .env 中配置的管理员账号登录。' : '尚未配置登录。请在 .env 填写 ADMIN_ACCOUNT 和 ADMIN_PASSWORD，然后重启服务。';
  if (status.configured) loginField('login-account').focus();
}
loginField('login-form').addEventListener('submit', async event => {
  event.preventDefault(); loginField('login-submit').disabled = true; loginField('login-error').hidden = true;
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': loginToken }, body: JSON.stringify({ account: loginField('login-account').value, password: loginField('login-password').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '登录失败，请重试。');
    loginField('login-password').value = ''; window.location.replace('/');
  } catch (error) {
    loginField('login-password').value = ''; loginField('login-error').textContent = error.message; loginField('login-error').hidden = false;
    loginField('login-submit').disabled = false;
    // A server restart changes the local request token; refresh it for the next attempt.
    void loadLoginStatus().catch(() => {});
  }
});
void loadLoginStatus().catch(error => { loginField('login-status').textContent = error.message; });
