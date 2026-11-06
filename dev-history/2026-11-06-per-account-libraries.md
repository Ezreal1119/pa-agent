# 一人一库：每个账号一个 product_lib

- 日期：2026-11-06
- 分支：`create-ckd-sop`
- 关联：[Core 变更记录](../docs/core-changelog.md)、[README 账号与资料库](../README.md)

## 背景

账号隔离最初按「共用库 + 项目负责人」实现，后改为用户明确要求的「每个账号对应自己的 `product_lib`，管理员可管理所有库」。实现期间上游推送了正式的用户管理（`src/ckd/users.ts`、`/admin/users`、桌面 0.1.10），两边改在同一批文件上。

## 与上游合并

- 上游 3 个提交：`0568403`（用户管理）、`fb2566d`（合并录入器与用户管理）、`7fa10e6`（收尾，桌面 0.1.10）。
- 本地改动先提交到 `wip/per-user-libraries`（`12285b8`），`create-ckd-sop` 快进到 `7fa10e6`，再把一人一库重放到上游代码上。
- 账号体系直接采用上游：users.json 注册表、UUID、首次改密、credentialVersion、登录限流、按 userId 隔离任务。没有保留本地那版 `accounts.json` + 角色的实现。
- 只为一人一库补：账号 → 库目录映射、按库缓存 service、管理员选库、创建用户时建库、用户页/工作台/录入页的库入口，以及相应测试。

## 关键约束（实现前确认）

1. catalog 只认「父目录下的 `ckd-library-v2`」，一次运行要求唯一的 `libraryRoots` 候选；出表脚本取 `dirname(run.libraryPath)`（`src/ckd/scripts.ts:63`）。所以每个库必须是完整 `ckd-library-v2`，脚本不用改。
2. `CkdWorkflow.resume/answer/cancel` 使用任务里保存的 `run.libraryPath`，只有 `create` 用实例绑定的库。可以按库缓存实例，任务恢复与当前登录无关。
3. 公共资料 `processes_lib` 实测 52 MB / 277 文件；复制成 N 份会让翻译、摘要、图片描述维护各跑 N 次（缓存按库路径做 key）。因此共享一份。
4. Windows `fs.symlinkSync(target, link, 'junction')` 不需要管理员权限；`lstat` 把它当目录，catalog 的符号链接检查不会拒绝；`fs.rmSync` 删父目录不会穿透删除联接目标（本机实测）。

## 结构

```
主库 CKD_LIBRARY/ckd-library-v2          ← 系统管理员自己的库，存量项目都在这里
  ├─ product_lib/
  └─ processes_lib/                      ← 唯一真源，维护只在这里跑
              ▲
              │ junction / symlink
<dataDir>/ckd/library/product_lib_<账号>/ckd-library-v2
  ├─ product_lib/                        ← 该账号私有
  └─ processes_lib → 主库/processes_lib
```

## 实现

### 新增 `src/ckd/library-registry.ts`

- `accountLibraryPath(dataDir, account)`：`<dataDir>/ckd/library/product_lib_<账号>/ckd-library-v2`。
- `accountDirectory()`：账号 3–64 位、字母/数字开头（与 `users.ts` 一致），保留账号原样大小写，拒绝 `/` 等路径字符。
- `ensureAccountLibrary(master, dataDir, account)`：幂等建 `product_lib`，把 `processes_lib` 联接到主库；主库没有 `processes_lib` 时先建空目录；已存在但为空的可重建联接，非空独立副本保持原样。
- `listLibraries()`：主库 + 各账号库，带 `exists`。

### `src/ckd/ui-server.ts`

- 单 `service` 改为 `libraryService(path)` 缓存（同一 `dataDir`，共享任务存储与图片/校准缓存）。
- `editor` 路径捕获 `editorUserId`（上游 `authenticate()` 返回 userId），用 `clientAccess.users.get(id).account` 解析到库；管理员走 Cookie，按 `?library=<账号>` 选库，默认主库。
- 创建任务：普通用户落自己的库，管理员可用 JSON `library` 字段；未配置管理员的本机模式仍落主库。
- `GET /api/libraries`（管理员）返回主库 + 各用户库 + 项目数；`POST /api/users` 创建用户后立即建库。
- `tools/ensure-user-libraries.ts`（`npm run ckd:libraries:ensure`）：部署后为现有账号一次性建库，支持 `--dry-run`，只建目录和联接，不移动项目。
- `tools/migrate-projects.ts`（`npm run ckd:projects:migrate`）：把主库项目复制到指定账号的库（默认 copy，`--move` 可选）；目标已存在默认拒绝，`--overwrite` 先备份到 `<dataDir>/ckd/project-backups/`。复制不动主库，旧任务（libraryPath 冻结在主库）仍可恢复。
- `GET /api/editor` 返回 `library` 与仅管理员可见的 `libraries`；项目创建/工序保存/排序/删除/图片都使用解析后的库。

### 前端

- `users.html/js`：用户表新增「资料库」列（项目数 + 打开录入页）。
- `index.html/app.js`：工作台表单新增「资料库」下拉（管理员可见），随创建任务提交 `library`。
- `editor.html/js/css`：顶栏管理员库选择器与「资料库：…」提示；所有接口和图片 URL 带 `library`；去掉旧的负责人只读逻辑。

## 测试调整

- `tests/ckd-client.test.ts`：`client-test` 用户的 TARGET 项目种到该用户自己的库；主库保留一份给管理员任务断言。
- `tests/ckd-users.test.ts`：录入落盘断言改到 `accountLibraryPath(dataDir, 'Alice')`；Windows 跳过 POSIX 0600 权限位断言（Windows 不保留该模式）。
- 新增 `tests/ckd-libraries.test.ts`：建库与联接幂等、用户隔离、管理员切库、任务落库。

## 验证

```
npm run typecheck                              → 0 错误
npx tsx --test tests/ckd-libraries.test.ts     → 3/3
npx tsx --test tests/ckd-users.test.ts         → 5/5
npx tsx --test tests/ckd-client.test.ts        → 4/5
npx tsx --test tests/ckd-ui.test.ts            → 3/4
```

失败项均为 Windows 无符号链接权限的 `EPERM`（原本就需要符号链接的用例），与本次改动无关。本机 Windows + Node 24.20.0，未做 Mac/Linux 实机复跑。

## 已知边界

- 同一库同时只能跑一个出表任务（Library 锁）；不同账号可并行。
- 主库维护与员工出表可能并发：共享 `processes_lib` 被改写时，出表任务会因源文件 Hash 校验失败而终止，需重跑；不会写出混合版本。
- 跨库引用不存在：普通用户看不到别人的项目，catalog 只看当前库。
- 禁用/重置账号不影响库内容；清理需运维归档目录（不要用会跟随联接的工具递归删除）。
- 未做：并发保存 409 版本冲突检测、跨库移动项目、员工库备份策略、Mac/Linux 实机验证、VPS 部署。

## 回滚

- 代码：还原 `ui-server.ts`、`library-registry.ts`、`editor.*`、`users.*`、`index.html`、`app.js` 的本轮改动；上游用户管理可单独保留。
- 数据：只移走 `<dataDir>/ckd/library/product_lib_*`（不要动同目录下的 `ckd-library-v2` 主库）；`processes_lib` 是联接，移动/删除库目录不会动到主库资料。
- 本地 WIP 快照在 `wip/per-user-libraries`（`12285b8`），可用于对比或取回旧实现。
