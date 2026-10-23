import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebAuth } from "../dist/web/auth.js";
import { createWebServer } from "../dist/web/server.js";
const admin = { account: "fixture-admin", password: "fixture-password" };
const request = (cookie) => ({
  headers: cookie ? { cookie } : {},
  socket: { remoteAddress: "fixture" },
});
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-persistence-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function login(auth, cookie) {
  let saved;
  assert.equal(
    await auth.signIn(
      request(cookie),
      { setHeader: (_, value) => (saved = value) },
      admin.account,
      admin.password,
    ),
    true,
  );
  return saved.split(";")[0];
}
test("hashed signed sessions survive restart without extending expiry; logout survives restart; no secrets on disk", async (t) => {
  const dir = await setup(t);
  let now = 1000;
  let auth = new WebAuth(admin.account, admin.password, () => now);
  await auth.initialize(dir);
  const cookie = await login(auth);
  const file = path.join(dir, "web-auth/sessions.json");
  const raw = await fs.readFile(file, "utf8");
  assert(!raw.includes(cookie.split("=")[1]));
  assert(!raw.includes(admin.password));
  assert(!raw.includes(admin.account));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await auth.close();
  now += 86400000;
  auth = new WebAuth(admin.account, admin.password, () => now);
  await auth.initialize(dir);
  assert(auth.authenticated(request(cookie)));
  await auth.signOut(request(cookie), { setHeader() {} });
  await auth.close();
  auth = new WebAuth(admin.account, admin.password, () => now);
  await auth.initialize(dir);
  assert(!auth.authenticated(request(cookie)));
  const next = await login(auth);
  await auth.close();
  now += 7 * 86400000;
  auth = new WebAuth(admin.account, admin.password, () => now);
  await auth.initialize(dir);
  assert(!auth.authenticated(request(next)));
  await auth.close();
});
test("credential rotation and signed-store tampering invalidate saved cookies", async (t) => {
  const dir = await setup(t);
  let auth = new WebAuth(admin.account, admin.password);
  await auth.initialize(dir);
  const cookie = await login(auth);
  await auth.close();
  for (const [account, password] of [
    ["other", admin.password],
    [admin.account, "other"],
  ]) {
    const rotated = new WebAuth(account, password);
    await rotated.initialize(dir);
    assert(!rotated.authenticated(request(cookie)));
    await rotated.close();
  }
  const file = path.join(dir, "web-auth/sessions.json");
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  value.sessions[0][1] += 1000;
  await fs.writeFile(file, JSON.stringify(value));
  auth = new WebAuth(admin.account, admin.password);
  await auth.initialize(dir);
  assert(!auth.authenticated(request(cookie)));
  await auth.close();
});
test("failed durable login issues no cookie; previous sessions remain usable; unsafe storage is rejected", async (t) => {
  const dir = await setup(t);
  const auth = new WebAuth(admin.account, admin.password);
  await auth.initialize(dir);
  const cookie = await login(auth);
  const folder = path.join(dir, "web-auth");
  await fs.rename(folder, folder + "-backup");
  await fs.writeFile(folder, "blocked");
  let issued = false;
  await assert.rejects(
    auth.signIn(
      request(cookie),
      {
        setHeader() {
          issued = true;
        },
      },
      admin.account,
      admin.password,
    ),
  );
  assert.equal(issued, false);
  assert(auth.authenticated(request(cookie)));
  await auth.close();
  await fs.rm(folder);
  await fs.rename(folder + "-backup", folder);
  const file = path.join(folder, "sessions.json");
  const original = await fs.readFile(file);
  for (const content of [
    "bad JSON",
    "x".repeat(32769),
    JSON.stringify({ version: 1 }),
  ]) {
    await fs.writeFile(file, content);
    await assert.rejects(
      new WebAuth(admin.account, admin.password).initialize(dir),
    );
  }
  await fs.writeFile(file, original);
  await fs.rename(file, file + ".original");
  await fs.symlink(file + ".original", file);
  await assert.rejects(
    new WebAuth(admin.account, admin.password).initialize(dir),
  );
  await fs.rm(file);
  await fs.link(file + ".original", file);
  await assert.rejects(
    new WebAuth(admin.account, admin.password).initialize(dir),
  );
});
test("concurrent logins remain bounded on disk and restore together", async (t) => {
  const dir = await setup(t);
  const auth = new WebAuth(admin.account, admin.password);
  await auth.initialize(dir);
  const cookies = await Promise.all(
    Array.from({ length: 130 }, () => login(auth)),
  );
  await auth.close();
  const restored = new WebAuth(admin.account, admin.password);
  await restored.initialize(dir);
  assert.equal(
    cookies.filter((c) => restored.authenticated(request(c))).length,
    128,
  );
  await restored.close();
});
test("HTTP restart retains login, keeps CSRF/Origin checks, and persists logout", async (t) => {
  const dir = await setup(t);
  const options = {
    cwd: dir,
    dataDir: dir,
    resourcesDir: path.resolve("resources"),
    admin,
    model: { apiKey: "", modelId: "mock", baseUrl: "https://unused.invalid" },
    fileTools: { enabled: false },
  };
  let app, base;
  async function start() {
    app = await createWebServer(options);
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  t.after(() => app.close());
  await start();
  const token = (await (await fetch(base + "/api/auth/status")).json()).token;
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-token": token },
    body: JSON.stringify(admin),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await app.close();
  await start();
  const status = await fetch(base + "/api/status", {
    headers: { Cookie: cookie },
  });
  assert.equal(status.status, 200);
  const next = (await status.json()).token;
  assert.notEqual(token, next);
  const logout = (csrf, origin) =>
    fetch(base + "/api/auth/logout", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "x-local-token": csrf,
        "content-type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body: "{}",
    });
  assert.equal((await logout(token)).status, 403);
  assert.equal((await logout(next, "https://evil.invalid")).status, 403);
  assert.equal(
    (await fetch(base + "/api/status", { headers: { Cookie: cookie } })).status,
    200,
  );
  assert.equal((await logout(next)).status, 200);
  await app.close();
  await start();
  assert.equal(
    (await fetch(base + "/api/status", { headers: { Cookie: cookie } })).status,
    401,
  );
});
