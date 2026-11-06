/**
 * 为现有普通账号预建各自的资料库。
 *
 * 服务本身会在账号首次登录/录入/建任务时自动建库；这个脚本用于部署后一次性建好，
 * 方便管理员核对。只创建 <data-dir>/ckd/library/product_lib_<账号>/ckd-library-v2 和
 * processes_lib 联接，不移动、不改写任何项目。
 *
 * 用法：
 *   npx tsx tools/ensure-user-libraries.ts [--data-dir DIR] [--library DIR] [--dry-run]
 * 默认取 CKD_DATA_DIR / CKD_LIBRARY，否则 .data 与 <data-dir>/ckd/library/ckd-library-v2。
 */
import fs from 'node:fs';
import path from 'node:path';
import { UserStore } from '../src/ckd/users.js';
import { accountLibraryPath, ensureAccountLibrary } from '../src/ckd/library-registry.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dryRun = process.argv.includes('--dry-run');
const dataDir = path.resolve(option('--data-dir') ?? process.env.CKD_DATA_DIR ?? '.data');
const library = path.resolve(option('--library') ?? process.env.CKD_LIBRARY ?? path.join(dataDir, 'ckd/library/ckd-library-v2'));

if (!fs.existsSync(path.join(library, 'product_lib'))) {
  console.error(`主库不像一个 ckd-library-v2：${library}`);
  process.exit(1);
}
const users = new UserStore(dataDir).list();
if (!users.length) {
  console.log('没有普通账号，无需建库。');
  process.exit(0);
}
console.log(`主库：${library}`);
for (const user of users) {
  const target = accountLibraryPath(dataDir, user.account);
  const exists = fs.existsSync(path.join(target, 'product_lib'));
  if (!dryRun) ensureAccountLibrary(library, dataDir, user.account);
  console.log(`${user.account}\t${exists ? '已存在' : dryRun ? '将创建' : '已创建'}\t${target}`);
}
console.log(dryRun ? `共 ${users.length} 个账号（dry-run，未写入）。` : `共 ${users.length} 个账号。`);
