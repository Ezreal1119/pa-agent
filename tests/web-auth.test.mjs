import test from 'node:test';
import assert from 'node:assert/strict';
import { WebAuth } from '../dist/web/auth.js';

test('login lasts seven days with matching cookie expiry and rate limiting recovers after its window', () => {
  let now = 0;
  const auth = new WebAuth('fixture-admin', 'fixture-password', () => now);
  const req = { headers: {}, socket: { remoteAddress: 'fixture' } };
  let cookie;
  const res = { setHeader(name, value) { if (name === 'Set-Cookie') { assert.match(value, /Max-Age=604800(?:;|$)/); cookie = value.split(';')[0]; } } };
  assert.equal(auth.login(req, res, 'fixture-admin', 'fixture-password'), true);
  req.headers.cookie = cookie; assert.equal(auth.authenticated(req), true);
  now = 12 * 60 * 60 * 1000; assert.equal(auth.authenticated(req), true);
  now = 7 * 24 * 60 * 60 * 1000 - 1; assert.equal(auth.authenticated(req), true);
  now += 1; assert.equal(auth.authenticated(req), false);
  for (let n = 0; n < 10; n++) auth.login(req, res, 'wrong', 'wrong');
  assert.equal(auth.retryAfter(req), 60);
  now += 60000; assert.equal(auth.retryAfter(req), 0);
  assert.equal(auth.login(req, res, 'fixture-admin', 'fixture-password'), true);
  req.headers.cookie = cookie; assert.equal(auth.authenticated(req), true);
  auth.dispose(); assert.equal(auth.authenticated(req), false);
});
