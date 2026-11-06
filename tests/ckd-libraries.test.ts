import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { AdminAccess, hashAdminPassword } from '../src/ckd/admin-access.js';
import { createCkdUiServer } from '../src/ckd/ui-server.js';
import { accountLibraryPath, ensureAccountLibrary, listLibraries } from '../src/ckd/library-registry.js';

/**
 * 一人一库：每个普通用户一个 ckd-library-v2，product_lib 私有，processes_lib 联接到主库共享；
 * 普通用户只能进自己的库，管理员可以用 ?library=<账号> 打开任何人的库。
 *
 * 账号来自上游的用户系统（users.json + 首次改密），这里通过管理员接口建用户并完成改密，
 * 不直接依赖内部实现。
 */

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function masterLibrary(root: string): string {
  const library = path.join(root, 'master', 'ckd-library-v2');
  write(path.join(library, 'processes_lib', 'assemble', 'camera', 'metadata.txt'), 'Camera');
  fs.mkdirSync(path.join(library, 'product_lib'), { recursive: true });
  return library;
}

test('registry: one library per account with a shared processes_lib junction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckd-libraries-'));
  try {
    const master = masterLibrary(root), dataDir = path.join(root, 'data');
    const alice = ensureAccountLibrary(master, dataDir, 'Alice');
    assert.equal(alice, accountLibraryPath(dataDir, 'Alice'), '目录名保留账号原样');
    assert.ok(fs.existsSync(path.join(alice, 'product_lib')));
    assert.equal(fs.realpathSync(path.join(alice, 'processes_lib')), fs.realpathSync(path.join(master, 'processes_lib')));
    assert.equal(fs.readFileSync(path.join(alice, 'processes_lib', 'assemble', 'camera', 'metadata.txt'), 'utf8'), 'Camera');

    ensureAccountLibrary(master, dataDir, 'Alice');
    assert.equal(fs.readFileSync(path.join(alice, 'processes_lib', 'assemble', 'camera', 'metadata.txt'), 'utf8'), 'Camera', '重复建库应幂等');

    // 已经是独立副本（非空目录）时不覆盖别人的数据。
    const bob = ensureAccountLibrary(master, dataDir, 'bob');
    fs.rmSync(path.join(bob, 'processes_lib'), { recursive: true, force: true });
    write(path.join(bob, 'processes_lib', 'custom.txt'), 'kept');
    ensureAccountLibrary(master, dataDir, 'bob');
    assert.equal(fs.readFileSync(path.join(bob, 'processes_lib', 'custom.txt'), 'utf8'), 'kept');

    const listed = listLibraries(master, dataDir, [{ account: 'Alice', name: 'Alice' }, { account: 'bob', name: 'bob' }]);
    assert.equal(listed.length, 3);
    assert.equal(listed[0]!.master, true);
    assert.equal(listed[1]!.exists, true);
    assert.equal(listed[1]!.path, alice);

    assert.throws(() => ensureAccountLibrary(master, dataDir, '..'), /不能作为资料库目录名/u);
    assert.throws(() => ensureAccountLibrary(master, dataDir, 'a/b'), /不能作为资料库目录名/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(t: { after(fn: () => Promise<void> | void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckd-per-user-'));
  const libraryPath = masterLibrary(root);
  const dataDir = path.join(root, 'data');
  const savedOrigin = process.env.CKD_ADMIN_ORIGIN;
  delete process.env.CKD_ADMIN_ORIGIN;
  const app = createCkdUiServer({ libraryPath, dataDir, adminAuth: new AdminAccess('boss', hashAdminPassword('boss-pass')) });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    if (savedOrigin === undefined) delete process.env.CKD_ADMIN_ORIGIN;
    else process.env.CKD_ADMIN_ORIGIN = savedOrigin;
  });

  const call = (route: string, init: { method?: string; token?: string; cookie?: string; body?: unknown; origin?: boolean; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.cookie) headers.Cookie = init.cookie;
    if (init.origin) { headers.Origin = base; headers['X-CKD-UI'] = '1'; }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(base + route, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };

  const adminLogin = async () => {
    const response = await call('/api/auth/login', { body: { account: 'boss', password: 'boss-pass' } });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };

  /** 建用户 → 首次登录（带改密能力头）→ 改密 → 重新登录拿正式令牌。 */
  const createUser = async (cookie: string, account: string) => {
    const created = await call('/api/users', { cookie, origin: true, body: { account } });
    assert.equal(created.status, 201);
    const { initialPassword } = await created.json() as { initialPassword: string };
    const password = `${account}-long-password`;
    const first = await call('/api/client/login', { body: { account, password: initialPassword }, headers: { 'X-CKD-Password-Change': '1' } });
    assert.equal(first.status, 200);
    const firstLogin = await first.json() as { token: string; mustChangePassword: boolean };
    assert.equal(firstLogin.mustChangePassword, true);
    const changed = await call('/api/client/me/password', { token: firstLogin.token, body: { currentPassword: initialPassword, newPassword: password } });
    assert.equal(changed.status, 200);
    const login = await call('/api/client/login', { body: { account, password } });
    assert.equal(login.status, 200);
    return (await login.json()) as { token: string; account: string; userId: string };
  };

  return { root, base, app, libraryPath, dataDir, call, adminLogin, createUser };
}

test('editor: users only reach their own library, the admin can open every library', async t => {
  const f = await fixture(t);
  const cookie = await f.adminLogin();
  const alice = await f.createUser(cookie, 'alice');
  const bob = await f.createUser(cookie, 'bob');
  const aliceLib = accountLibraryPath(f.dataDir, 'alice');
  assert.ok(fs.existsSync(path.join(aliceLib, 'product_lib')), '建用户时应把库建好');
  assert.equal(fs.realpathSync(path.join(aliceLib, 'processes_lib')), fs.realpathSync(path.join(f.libraryPath, 'processes_lib')), '公共资料应共享主库');

  const project = await f.call('/api/editor/projects', { token: alice.token, origin: true, body: { projectId: 'A1', displayName: '小艾的项目' } });
  assert.equal(project.status, 200);
  assert.ok(fs.existsSync(path.join(aliceLib, 'product_lib', 'A1', 'project.json')));
  assert.equal(fs.existsSync(path.join(f.libraryPath, 'product_lib', 'A1')), false);

  const aliceList = await (await f.call('/api/editor', { token: alice.token })).json() as { projects: Array<{ projectId: string }>; library: { id: string; master: boolean }; libraries?: unknown };
  assert.deepEqual(aliceList.projects.map(item => item.projectId), ['A1']);
  assert.equal(aliceList.library.master, false);
  assert.equal(aliceList.libraries, undefined, '普通用户拿不到别人的库列表');

  const bobList = await (await f.call('/api/editor', { token: bob.token })).json() as { projects: unknown[] };
  assert.deepEqual(bobList.projects, [], '用户之间互相看不到');

  // 普通用户即使带 library 参数也只能落在自己的库。
  assert.equal((await f.call('/api/editor/projects?library=bob', { token: alice.token, origin: true, body: { projectId: 'A2', displayName: '还是小艾的' } })).status, 200);
  assert.ok(fs.existsSync(path.join(aliceLib, 'product_lib', 'A2')));
  assert.equal(fs.existsSync(path.join(accountLibraryPath(f.dataDir, 'bob'), 'product_lib', 'A2')), false);

  const save = (token: string, projectId: string, order = 1) => f.call('/api/editor/process', { token, origin: true, body: { projectId, language: '中文', order, metadata: '工序一' } });
  assert.equal((await save(alice.token, 'A1')).status, 200);
  assert.ok(fs.existsSync(path.join(aliceLib, 'product_lib', 'A1', 'assemble', 'CN_process', 'process_01', 'metadata.txt')));

  // 管理员：默认主库，?library=alice 打开小艾的库。
  const adminMaster = await (await f.call('/api/editor', { cookie })).json() as { projects: unknown[]; libraries: Array<{ account: string; projects: number }> };
  assert.deepEqual(adminMaster.projects, []);
  assert.equal(adminMaster.libraries.length, 3);
  assert.equal(adminMaster.libraries.find(item => item.account === 'alice')?.projects, 2);

  const adminAlice = await (await f.call('/api/editor?library=alice', { cookie })).json() as { projects: Array<{ projectId: string }>; library: { name: string; master: boolean }; libraries: unknown[] };
  assert.deepEqual(adminAlice.projects.map(item => item.projectId).sort(), ['A1', 'A2']);
  assert.equal(adminAlice.library.name, 'alice');
  assert.equal(adminAlice.library.master, false);
  assert.equal(adminAlice.libraries.length, 3, '管理员能看到所有库');

  assert.equal((await f.call('/api/editor/process?library=alice', { cookie, origin: true, body: { projectId: 'A1', language: '中文', order: 2, metadata: '管理员补一道' } })).status, 200);
  assert.ok(fs.existsSync(path.join(aliceLib, 'product_lib', 'A1', 'assemble', 'CN_process', 'process_02', 'metadata.txt')));

  assert.equal((await f.call('/api/users', { token: alice.token })).status, 401, '普通用户不能访问用户管理');
  const libraries = await (await f.call('/api/libraries', { cookie })).json() as { libraries: Array<{ master: boolean; projects: number }> };
  assert.equal(libraries.libraries.length, 3);
});

test('runs: new tasks land in the caller library; the admin can target a user library', async t => {
  const f = await fixture(t);
  const cookie = await f.adminLogin();
  const alice = await f.createUser(cookie, 'alice');
  const aliceLib = accountLibraryPath(f.dataDir, 'alice');
  const input = { projectName: 'A1', documentNumber: 'CKD-001', sopName: 'A1 SOP', author: 'alice', sopType: 'assembly_test', templateLanguage: 'English' };
  /** 等后台任务结束再建下一个，否则同一个库的锁会冲突（409）。 */
  const settle = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const run = f.app.service.get(id);
      if (run.status !== 'running') return run;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`任务 ${id} 没有在预期时间内结束`);
  };

  const client = await f.call('/api/client/runs', { token: alice.token, body: { ...input, library: 'master' } });
  assert.equal(client.status, 202);
  const clientRun = await settle((await client.json()).run.id);
  assert.equal(clientRun.libraryPath, fs.realpathSync(aliceLib), '普通用户任务必须落在自己的库');

  const adminRun = await f.call('/api/runs', { cookie, origin: true, body: { ...input, library: 'alice' } });
  assert.equal(adminRun.status, 202);
  assert.equal((await settle((await adminRun.json()).run.id)).libraryPath, fs.realpathSync(aliceLib), '管理员可指定用户的库');

  const masterRun = await f.call('/api/runs', { cookie, origin: true, body: input });
  assert.equal(masterRun.status, 202);
  assert.equal((await settle((await masterRun.json()).run.id)).libraryPath, fs.realpathSync(f.libraryPath), '不指定库时用主库');
});
