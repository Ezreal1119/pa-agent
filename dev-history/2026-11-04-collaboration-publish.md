# 2026-11-04：CKD 协作分支发布准备

## 目的与边界

将当前 CKD 代码提供给其他开发者，通过 GitHub 分支和 PR 协作。只发布代码、开发文档、测试及运行必需资源；不部署 VPS，不启动生产任务或 Library 同步。

## 本机保护与发布历史

- 在忽略的 `.data/git-publish-backups/` 保存原 Git bundle、工作树归档、原始差异和逐文件 SHA-256；原 HEAD 另有本地备份分支。备份及备份分支均不推送。
- 从固定 main 基线 `170fa45c2bf00a00c3a9f904b6ebfc49b65754af` 建立独立工作树，复制当前代码，保留既有运行行为。
- 原未发布 CKD 提交包含 1832 项真实 Library 文件名、大小及 Hash 的迁移清单。发布树排除 `resources/workflows/create-ckd-sop/library-manifest.json`，发布提交不以旧 CKD 提交为父节点，避免清单进入远程历史。原件继续留在本机并增加忽略规则。
- 保留源码/模板来源说明 `source-manifest.json`，更新注释，明确不分发业务文件清单。

## 开发入口与资源

- 新增 `CONTRIBUTING.md`：仓库获取、Node/Python 安装、模拟测试、本地独立资料与模型配置、桌面开发、PR 目标分支和数据边界。
- README 增加协作入口，并纠正旧的“暂不打包 Electron”描述。
- 增加本地凭据、虚拟环境、日志和业务清单的 Git 忽略规则；配置示例、Excel 空模板/Logo、V1.23.0 固定评分配置及参考程序继续纳入 Git。
- `.gitattributes` 禁止对 V1.23.0 交接评分资源进行 Git 换行转换，保留原始字节和 Hash；原始 CRLF 曲线 JSON 按 CRLF 检查，不改写客户参考文件。
- 管理员密码/API 密钥保留在各环境自己的 `.env`；新增忽略规则不替代提交前检查。

## 验证

- 独立工作树不含 `.env`、生产 Library、任务、缓存或安装包；`npm ci --no-audit --no-fund` 成功。Node 为 25.6.0，本次未重做 Windows 实机验证。
- 按协作指南新建 Python 3.11 虚拟环境并安装 NumPy 2.4.4 / Pillow 12.0.0，成功。
- `npm run typecheck`、`npm run build`、`git diff --cached --check` 均通过。
- `CKD_SCORER_PYTHON=本地独立虚拟环境的python npm test`：224 条，222 通过、0 失败、2 条 Linux boot/PID 测试在 macOS 按条件跳过；未调用真实模型或生产服务。
- 逐文件对比发布树与备份：除忽略规则、协作说明、README、变更记录和来源清单注释之外，原有代码/模板/评分资源字节完全一致。
- 文件路径与密钥特征扫描未发现 `.data`、Library、运行 `.env`、安装包、真实私钥或实际 API 密钥进入发布树。仅保留配置示例与测试用凭据。
- 发布仅显式推送 `create-ckd-sop`，不使用 `--all`、`--mirror`、`--force` 或推送本机备份 refs；GitHub 分支 SHA 与本地发布 SHA 在推送后核对。

## 同日后续修正：VPS 对齐

发布后在 VPS 对齐检查中发现 `source-manifest.json` 属于工作流资源 Hash 的组成部分。为避免说明文字变化影响旧任务恢复，后续提交恢复其发布前原始字节，不改原 Hash；本文“更新注释”的条目记录的是首个发布提交，之后以此修正为准。业务清单依旧不进入远程 Git，服务器保留原始忽略文件。详见 `2026-11-04-vps-git-pull.md`。
