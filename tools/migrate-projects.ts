/**
 * 把主库里的项目复制到某个账号的资料库（默认 copy，主库不动）。
 *
 * 用途：一人一库上线前已经录在主库的项目，需要让员工在自己的库里继续编辑/出表。
 * 复制后主库保留原件，旧任务（libraryPath 冻结在主库）仍可恢复；用户库里的是一份
 * 独立副本，后续各自演进。
 *
 * 用法：
 *   npx tsx tools/migrate-projects.ts --list
 *   npx tsx tools/migrate-projects.ts --project SQ69BXP --to alice --dry-run
 *   npx tsx tools/migrate-projects.ts --project SQ69BXP --to alice
 *   npx tsx tools/migrate-projects.ts --map mapping.json [--move] [--overwrite] [--dry-run]
 *
 * mapping.json 形如：{ "SQ69BXP": "alice", "GPOS710": "bob" }
 * 默认主库取 CKD_LIBRARY，否则 <data-dir>/ckd/library/ckd-library-v2。
 * 目标已存在时默认拒绝；--overwrite 先备份到 <data-dir>/ckd/project-backups 再替换。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UserStore } from '../src/ckd/users.js';
import { accountLibraryPath, ensureAccountLibrary } from '../src/ckd/library-registry.js';
import { acquireLibraryLock } from '../src/ckd/library-lock.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dryRun = process.argv.includes('--dry-run');
const overwrite = process.argv.includes('--overwrite');
const move = process.argv.includes('--move');
const dataDir = path.resolve(option('--data-dir') ?? process.env.CKD_DATA_DIR ?? '.data');
const library = path.resolve(option('--from') ?? process.env.CKD_LIBRARY ?? path.join(dataDir, 'ckd/library/ckd-library-v2'));
const productRoot = path.join(library, 'product_lib');

if (!fs.existsSync(productRoot)) {
  console.error(`主库不像一个 ckd-library-v2（缺少 product_lib）：${library}`);
  process.exit(1);
}

function projects(): string[] {
  return fs.readdirSync(productRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.isSymbolicLink())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function measure(target: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else { files++; bytes += fs.statSync(full).size; }
    }
  };
  walk(target);
  return { files, bytes };
}

if (process.argv.includes('--list')) {
  const all = projects();
  console.log(`主库：${library}`);
  if (!all.length) console.log('（没有项目）');
  for (const project of all) {
    const size = measure(path.join(productRoot, project));
    console.log(`${project}\t${size.files} 个文件\t${(size.bytes / 1024 / 1024).toFixed(1)} MB`);
  }
  process.exit(0);
}

const users = new UserStore(dataDir).list();
const findUser = (account: string) => users.find(user => user.account.toLowerCase() === account.toLowerCase());
const assignments = new Map<string, string>();

const mappingFile = option('--map');
if (mappingFile) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(mappingFile), 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.error('mapping.json 必须是 { "项目": "账号" } 形式。');
    process.exit(1);
  }
  for (const [project, account] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof account !== 'string') { console.error(`项目 ${project} 的账号必须是字符串。`); process.exit(1); }
    assignments.set(project, account);
  }
} else {
  const project = option('--project'), account = option('--to');
  if (!project || !account) {
    console.error('用法：--project <项目> --to <账号>，或 --map <mapping.json>；先用 --list 查看主库项目。');
    process.exit(1);
  }
  assignments.set(project, account);
}

// 先整体校验，任何一项不合法都不开始复制。
for (const [project, account] of assignments) {
  if (!projects().includes(project)) { console.error(`主库里没有项目 ${project}。`); process.exit(1); }
  const user = findUser(account);
  if (!user) { console.error(`没有账号 ${account}（大小写不敏感）。`); process.exit(1); }
  const target = path.join(accountLibraryPath(dataDir, user.account), 'product_lib', project);
  if (fs.existsSync(target) && !overwrite) {
    console.error(`目标已存在：${target}\n确认要替换时加 --overwrite（会先备份）。`);
    process.exit(1);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
let copied = 0;
for (const [project, account] of assignments) {
  const user = findUser(account)!;
  const targetLibrary = accountLibraryPath(dataDir, user.account);
  const target = path.join(targetLibrary, 'product_lib', project);
  const source = path.join(productRoot, project);
  if (dryRun) {
    console.log(`将复制 ${project} → ${user.account}：${target}`);
    continue;
  }
  ensureAccountLibrary(library, dataDir, user.account);
  const releaseMaster = acquireLibraryLock(library);
  let releaseTarget: (() => void) | undefined;
  try {
    releaseTarget = acquireLibraryLock(targetLibrary);
    if (fs.existsSync(target)) {
      const backup = path.join(dataDir, 'ckd/project-backups', user.account.toLowerCase(), `${project}-${stamp}`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(target, backup);
      console.log(`已备份原目标：${backup}`);
    }
    const staging = path.join(targetLibrary, 'product_lib', `.${project}.${randomUUID()}.tmp`);
    fs.cpSync(source, staging, { recursive: true, errorOnExist: true });
    fs.renameSync(staging, target);
  } finally {
    releaseTarget?.();
    releaseMaster();
  }
  if (move) fs.rmSync(source, { recursive: true, force: true });
  const size = measure(target);
  console.log(`${move ? '已移动' : '已复制'} ${project} → ${user.account}：${size.files} 个文件，${(size.bytes / 1024 / 1024).toFixed(1)} MB`);
  copied++;
}
console.log(dryRun ? `共 ${assignments.size} 项（dry-run，未写入）。` : `完成 ${copied} 项。${move ? '' : '主库原件保留。'}`);
