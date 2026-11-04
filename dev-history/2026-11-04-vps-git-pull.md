# 2026-11-04：VPS 手动 Git 更新

## 目标

开发者在任意电脑 push `create-ckd-sop`，管理员登录 VPS 手动 pull、安装依赖、构建并启动服务。无需 Actions、Webhook 或发布分支。

## 核对结果与保护

- VPS 已有 Git 与 `origin`，可无交互读取 GitHub；旧 HEAD 为 `9cb3d53`，尚未设置跟踪分支，工作树包含历史 rsync 同步的未提交代码。
- 逐文件对比确认后端源码、Node 锁文件、评分程序/配置与已发布版本一致。差异主要是协作文档、忽略规则和桌面说明。
- 任务状态中有一条旧的 running 记录，但无任务/Library 实际执行锁；不把旧状态当成当前活动任务，也不修改它。
- `assetHashes()` 会枚举工作流目录所有文件。恢复协作发布中改过注释的 `source-manifest.json` 原始字节，并保留 VPS 原始忽略清单及历史资源；本次整理不更改现有工作流目录字节。
- 先保留原 Git 及未提交代码的恢复备份；`.env`、`.data`、独立评分虚拟环境不迁移、不覆盖。仅服务器 `.git/info/exclude` 忽略历史资源目录，不把历史业务清单提交到远程。

## 运维说明

更新 [VPS 部署说明](../docs/vps-deployment.md)，把 Git 拉取作为日常方式，rsync 留作历史记录。更新窗口先停服务，`git pull --ff-only`、`npm ci --include=dev`、`npm run build` 成功才启动；失败不继续执行。普通更新不自动触发 Library 同步，不改变 Nginx。

## 验证

- VPS 切换前备份：`/opt/pi-patrick-backups/git-pull-20261104T190550`。保存 Git bundle/原 `.git`、215 个代码文件、差异及仅 root 可读的环境配置副本；本机备份分支为 `codex/backup-before-git-pull-20261104T190550`，不推送。
- 对业务数据、环境配置、现有工作流资源、历史资源和独立评分环境的 25,433 个文件建立切换前 Hash。执行后再次核对，并检查服务 PID、HTTP 状态和 `git pull --ff-only`；最终实际结果在后续条目记录。
- 本次仅恢复来源说明的原始字节并调整开发/运维文档，`git diff --check` 通过；源码、Node 锁文件及评分配置未更改，不重跑模型或生产整库同步。

### 执行结果

- VPS 对齐提交 `1db5fb8`，当前分支 `create-ckd-sop`，上游 `origin/create-ckd-sop`，本机仓库设置 `pull.ff=only`；Git 状态干净，实际 `git pull --ff-only` 成功返回 `Already up to date.`。
- 对齐时 97 个后端源码/资源及 Node 依赖定义文件与线上原件逐字节一致，只补齐/更新协作文档和忽略规则。服务器历史资源及原始 Library 迁移清单保留为忽略文件。
- 25,433 个受保护文件复核：0 修改、0 缺失，涵盖 `.data`、`.env`、工作流资源、历史资源和独立 Python 环境。
- `ckd-sop` 持续 active，PID `222530` 前后相同；没有安装依赖、重新构建或重启线上服务。后端管理登录页 HTTP 200、未登录管理状态接口 401；按实际 `Host: 8.133.254.83` 检查 Nginx 入口同为 200/401。
- 本次仅整理 Git 管理和文档，未发起业务任务或真实模型请求。后续代码变更按手动更新步骤安装/构建/启动，不能把本次无需重启推及实际代码更新。
