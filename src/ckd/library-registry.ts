import fs from 'node:fs';
import path from 'node:path';

/**
 * 账号资料库：每人一个独立的 ckd-library-v2。
 *
 * - product_lib 是私有的，只有本人（或管理员）能改；
 * - processes_lib 用目录联接指回主库，翻译/摘要/图片描述只维护一份；
 * - 主本身就是管理员自己的库，存量项目都放在这里。
 */

/** 与 users.ts 的账号规则一致：3–64 位，字母或数字开头；目录统一转小写。 */
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/u;

export interface AccountLibraryInfo {
  /** 账号；主库为空字符串。 */
  account: string;
  /** 展示用姓名。 */
  name: string;
  /** 指向 ckd-library-v2 本身。 */
  path: string;
  master: boolean;
  exists: boolean;
}

export function librariesRoot(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'ckd', 'libraries');
}

/** 账号 → 目录名。统一小写：Windows 文件系统大小写不敏感，避免同一人出现两个库。 */
export function accountDirectory(account: string): string {
  const lowered = account.trim().toLowerCase();
  if (!ACCOUNT_PATTERN.test(lowered)) throw new Error(`账号 ${account} 不能作为资料库目录名。`);
  return lowered;
}

export function accountLibraryPath(dataDir: string, account: string): string {
  return path.join(librariesRoot(dataDir), accountDirectory(account), 'ckd-library-v2');
}

function sameTarget(link: string, target: string): boolean {
  try { return fs.realpathSync(link) === fs.realpathSync(target); } catch { return false; }
}

function exists(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch { return false; }
}

function emptyDirectory(target: string): boolean {
  try { return fs.lstatSync(target).isDirectory() && fs.readdirSync(target).length === 0; } catch { return false; }
}

function linkProcesses(master: string, link: string): void {
  fs.symlinkSync(master, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * 建库（幂等）：product_lib 建成本地目录，processes_lib 联接到主库。
 * Windows 用 junction（不需要管理员权限，catalog 也不会把它当符号链接拒绝）。
 */
export function ensureAccountLibrary(masterLibrary: string, dataDir: string, account: string): string {
  const library = accountLibraryPath(dataDir, account);
  fs.mkdirSync(path.join(library, 'product_lib'), { recursive: true });
  const master = path.join(path.resolve(masterLibrary), 'processes_lib');
  if (!exists(master)) fs.mkdirSync(master, { recursive: true });
  const link = path.join(library, 'processes_lib');
  if (!exists(link)) { linkProcesses(master, link); return library; }
  if (sameTarget(link, master)) return library;
  // 上次中断留下的空目录可以换成联接；非空的独立副本保持原样，不覆盖别人的数据。
  if (emptyDirectory(link)) {
    fs.rmdirSync(link);
    linkProcesses(master, link);
  }
  return library;
}

/** 主库 + 每个账号一个库；exists 表示库目录已经建好（账号可能还没登录过）。 */
export function listLibraries(
  masterLibrary: string,
  dataDir: string,
  accounts: Array<{ account: string; name: string }>
): AccountLibraryInfo[] {
  const master = path.resolve(masterLibrary);
  const result: AccountLibraryInfo[] = [{
    account: '', name: '主库（管理员）', path: master, master: true,
    exists: fs.existsSync(path.join(master, 'product_lib')),
  }];
  for (const item of accounts) {
    let library: string;
    try { library = accountLibraryPath(dataDir, item.account); } catch { continue; }
    result.push({
      account: item.account, name: item.name, path: library, master: false,
      exists: fs.existsSync(path.join(library, 'product_lib')),
    });
  }
  return result;
}
