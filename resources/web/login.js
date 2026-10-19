'use strict';
const loginField = id => document.getElementById(id);
let loginToken = '';
async function loadLoginStatus() {
  const response = await fetch('/api/auth/status');
  if (!response.ok) throw new Error('Cannot connect to the sign-in service. Refresh and try again.');
  const status = await response.json(); loginToken = status.token;
  if (status.authenticated) { window.location.replace('/'); return; }
  loginField('login-submit').disabled = !status.configured;
  loginField('login-account').disabled = !status.configured; loginField('login-password').disabled = !status.configured;
  loginField('login-status').textContent = status.configured ? 'Sign in with the administrator credentials configured in .env.' : 'Sign-in is not configured. Set ADMIN_ACCOUNT and ADMIN_PASSWORD in .env, then restart the service.';
  if (status.configured) loginField('login-account').focus();
}
loginField('login-form').addEventListener('submit', async event => {
  event.preventDefault(); loginField('login-submit').disabled = true; loginField('login-error').hidden = true;
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': loginToken }, body: JSON.stringify({ account: loginField('login-account').value, password: loginField('login-password').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Sign-in failed. Please try again.');
    loginField('login-password').value = ''; window.location.replace('/');
  } catch (error) {
    loginField('login-password').value = ''; loginField('login-error').textContent = error.message; loginField('login-error').hidden = false;
    loginField('login-submit').disabled = false;
    // A server restart changes the local request token; refresh it for the next attempt.
    void loadLoginStatus().catch(() => {});
  }
});
void loadLoginStatus().catch(error => { loginField('login-status').textContent = error.message; });
