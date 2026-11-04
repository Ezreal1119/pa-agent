# 2026-10-08 CKD V3 迁入 Pi

## 起点与范围

`create-ckd-sop` 原本与 `urovo-product-agent` 同指向 `5b141d8`，没有独立提交。工作区检查后从 `main` 的 `170fa45` 重设该分支，原产品分支保留。旧产品分支留下的未跟踪 skill checkout 保留在本机，放入本仓库 `.git/info/exclude`；CKD 显式传空 skills 列表，不读取它。

仅在 pi-patrick 实施。patrick-agent 是只读来源，没有运行其生成器、迁移、构建或测试。来源是旧项目当前工作树，包含其实施前已存在的本地修改，不以旧 HEAD 代替磁盘内容。

## 实现

- 独立五阶段 TypeScript 状态机，保留五种 SOP、中英文目录隔离、项目/来源确认、手动重复项处理、三条解析路径、评分、Excel 模板和图片规则。
- 五个 CommonJS 脚本包、模板和图片迁入 `resources/workflows/create-ckd-sop/`。生成器 package 显式设置 `type: commonjs`，适配新项目 ESM 根目录。
- `createSession` 增加兼容的第二个配置参数；CKD Pi extension 只启用三个协议工具。节点 Schema 同时用于工具参数和 Ajv 校验，Catalog 校验后由可信业务层冻结 ID/顺序。独立节点会话、持久化问题、已回答问题历史和会话路径。
- 任务状态原子写入、每任务跨进程锁、取消标记、阶段提交边界和 Pi transcript leaf 重放。脚本执行凭据验证已生成产物，保护未提交或被修改的 Excel。
- 增加 start/get/list/answer/resume/cancel API、CLI、JSON 输出、TTY 提问与非交互退出。资源 Hash、来源快照校验、超时、取消与路径保护留在新项目。
- Library 业务数据复制到 `.data/ckd/library/ckd-library-v2`，1,832 个文件，405,604,333 bytes。原约 840 MB 包含约 447 MB Git 历史；新副本排除 Git 元数据、`.DS_Store` 以及旧 summary/图片维护脚本，保留现成 summary/overview、业务资料和归档。不自动引用旧仓库。
- 新运行依赖 ExcelJS、TypeBox、Ajv；tsx 为 CLI/测试开发工具。没有迁移旧 Agent Core、Web、公共数据库、权限系统或 LangGraph。

## 文档与来源

README 增加 CLI、配置、任务目录及 API；`examples/ckd/` 提供参考 SOP 和 Factory Test 输入；`docs/ckd-design.md` 说明架构、三个工具、恢复及平台边界。新项目没有旧的可视化生成器，因此未创建或执行旧项目 `docs:agent`。

`resources/workflows/create-ckd-sop/source-manifest.json` 记录脚本、模板、图片和业务模块的原始/迁入 SHA256；`library-manifest.json` 记录全部复制数据的原路径、大小和 SHA256。实施前基线与最终核查报告只保存在本机 `.data/ckd/migration/`。旧项目 4,055 个基线文件 Hash 与 Git 状态完全一致；Library 1,832 个业务文件亦一致，零变更。

## 验证

```bash
npm run typecheck
npm run build
npm test
node dist/ckd/cli.js help
npm run --silent ckd -- start --input examples/ckd/factory-test.json --json --non-interactive
git diff --check
```

37 项自动化测试通过，包括迁入业务 fixtures、五种类型、中文隔离、参考/手动、跨项目不泄露资料、评分、1–12 图片布局，以及原生 Pi 工具白名单、无效提交、澄清重启、重复回答、独立 CLI 进程、互斥、失效锁回收、取消/重启取消、超时、Library 变化和产物凭据保护。测试输出只写新项目或临时目录。

真实模型使用 pi-patrick 现有配置单独联调：

1. GPOS710 / Assembly Activate Device SOP：确定性来源选择 → 原生 Pi clarify → 新宿主重开同一 JSONL 回答 → 同项目参考解析 → Excel/评分，完成。工具参数换成原生节点 Schema 后再验证一次，任务 `832ef5af-645e-496f-b2cf-5db8a3a7e52b`。
2. `GPOS 710终端` / `Camera functional test`：语义项目匹配和语义工序匹配分别使用独立 Pi Session → Factory Test Excel/评分，完成。任务 `0340cc2c-c84c-45da-b186-982d17198a3f`。

联调记录和产物保存在本机 `.data/ckd/`，未提交会话或模型凭证。环境 macOS、Node 25.6.0；Windows 实机和 Electron 打包尚未验证。
